// The recurring B2B jobs, as the operations service runs them (Phase 7).
//
// Each job calls the domain service that owns the work and reports what it
// handled. Nothing is decided here: what an invoice contains, when a pass
// starts, which reminder is due all stay where they were. What this adds is
// that an item a job could not handle becomes an exception instead of a line
// in the server log, and clears itself when the item later goes through.
//
// Times are UTC (the scheduler's clock); East Africa Time is UTC+3.
import { localDay } from '../shared/member-progress.mjs';
import { LIVE_STATUSES } from './ops-service.mjs';

const month = (y, m) => { const i = y * 12 + (m - 1); return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`; };

export function registerB2BJobs({
  ops, db, programs,
  b2bProgramService, b2bConsumptionService, b2bBillingService, b2bFinanceService, b2bSponsorRefundService, b2bCollectionsService, b2bAnalyticsService,
  b2bBeneficiaryImportService = null,
  now = () => new Date(),
}) {
  ops.register({
    name: 'b2b-program-expiry', title: 'Programme expiry', schedule: { type: 'daily', utc: '21:05' },
    description: 'Marks active or paused programmes whose end date has passed as expired.',
    run: async () => {
      const r = await b2bProgramService.expireDue();
      return { processed: r.expired ?? 0, expired: r.expired ?? 0 };
    },
  });

  ops.register({
    name: 'b2b-hold-reconciler', title: 'Benefit hold reconciler', schedule: { type: 'every', minutes: 5 }, quiet: true,
    description: 'Settles benefit holds a gym check-in left behind: approved when the visit exists, cancelled when it does not.',
    run: async (ctx) => {
      const r = await b2bConsumptionService.reconcileHolds();
      if (r.failed) await ctx.raise({ type: 'job_item_failed', severity: 'medium', title: `${r.failed} benefit hold(s) could not be settled`, entityType: 'job', entityId: ctx.job, dedupeKey: `item:${ctx.job}:holds`, detail: r });
      else if (r.found) await ctx.clear(`item:${ctx.job}:holds`, 'Holds settled.');
      return { processed: r.found, succeeded: r.approved + r.cancelled, failed: r.failed, ...r };
    },
  });

  ops.register({
    name: 'b2b-sponsor-billing', title: 'Sponsor billing drafts', schedule: { type: 'daily', utc: '21:20' }, domain: 'finance',
    description: 'Starts sponsored passes that can start, and keeps draft invoices current: flat fees for this month (and next, from the 25th), last month\'s per-use charges and platform fees. Drafts only; staff issue them.',
    run: async (ctx) => {
      const passes = await b2bBillingService.runDaily();
      const fees = await b2bFinanceService.prepareFeesDue({ actorId: ctx.actor });
      if (fees.failed) await ctx.raise({ type: 'job_item_failed', severity: 'high', title: `${fees.failed} platform fee draft(s) could not be prepared`, entityType: 'job', entityId: ctx.job, dedupeKey: `item:${ctx.job}:fees`, detail: fees });
      else await ctx.clear(`item:${ctx.job}:fees`, 'Platform fee drafts prepared.');
      const refunds = await b2bSponsorRefundService.repair();

      const today = localDay(now());
      const [y, m] = today.split('-').map(Number);
      const periods = [['prepaid', month(y, m)], ...(Number(today.slice(8)) >= 25 ? [['prepaid', month(y, m + 1)]] : []), ['usage', month(y, m - 1)]];
      const stats = { processed: 0, failed: 0, drafts: 0, refused: 0 };
      for (const p of await programs.filterByColumnAsync('status', 'active')) {
        for (const [kind, period] of periods) {
          stats.processed += 1;
          const item = { entityType: 'program', entityId: p.id, key: `${kind}:${period}` };
          try {
            const r = kind === 'prepaid'
              ? await b2bBillingService.preparePrepaid({ programId: p.id, period, actorId: ctx.actor })
              : await b2bBillingService.prepareUsage({ programId: p.id, period, actorId: ctx.actor });
            // A refusal (no pass benefit, on hold, already seat-billed) is an answer, not a failure.
            if (r.error) stats.refused += 1;
            else if (r.invoice && (r.added || r.credited)) stats.drafts += 1;
            await ctx.itemOk(item);
          } catch (err) {
            stats.failed += 1;
            await ctx.itemFailed({ ...item, organizationId: p.organizationId, error: err, title: `Could not prepare the ${kind === 'prepaid' ? 'pass' : 'usage'} invoice for ${period} (${p.name})`, detail: { kind, period, programName: p.name } });
          }
        }
      }
      return { ...stats, failed: stats.failed + (fees.failed ?? 0), passesStarted: passes.started, passesRepaired: passes.repaired, awaitingMember: passes.awaitingMember, awaitingLink: passes.awaitingLink, feeDrafts: fees.drafted ?? 0, refundsRaised: refunds.raised ?? 0 };
    },
  });

  ops.register({
    name: 'b2b-collections', title: 'Payment reminders', schedule: { type: 'daily', utc: '06:00' }, domain: 'finance',
    description: 'Sends payment reminders for issued invoices: 3 days before the due day, on it, and 7, 14 and 30 days after. Each once per invoice.',
    run: async (ctx) => {
      const r = await b2bCollectionsService.runReminders();
      if (r.failed) await ctx.raise({ type: 'job_item_failed', severity: 'medium', title: `${r.failed} payment reminder(s) could not be sent`, entityType: 'job', entityId: ctx.job, dedupeKey: `item:${ctx.job}:reminders`, detail: r });
      else await ctx.clear(`item:${ctx.job}:reminders`, 'Reminders sent.');
      return { processed: r.checked, succeeded: r.sent, failed: r.failed, sent: r.sent };
    },
  });

  ops.register({
    name: 'b2b-sponsor-visibility-notice', title: 'Sponsor visibility notice', schedule: { type: 'daily', utc: '07:00' },
    description: 'Tells each person an organisation covers, once, what the organisation can see of their activity.',
    run: async (ctx) => {
      const r = await b2bAnalyticsService.notifyVisibility();
      if (r.failed) await ctx.raise({ type: 'job_item_failed', severity: 'low', title: `${r.failed} visibility notice(s) could not be sent`, entityType: 'job', entityId: ctx.job, dedupeKey: `item:${ctx.job}:notices`, detail: r });
      else await ctx.clear(`item:${ctx.job}:notices`, 'Notices sent.');
      return { processed: r.sent + r.failed, succeeded: r.sent, failed: r.failed, covered: r.covered };
    },
  });

  ops.register({
    name: 'b2b-integrity-check', title: 'Financial integrity check', schedule: { type: 'daily', utc: '22:00' }, domain: 'finance',
    description: 'Runs the data-quality checks across usage, invoices, payments and passes. Each check that finds something raises one exception with the count and examples; it clears itself when the check comes back clean. Nothing is repaired.',
    run: async (ctx) => {
      const q = await b2bAnalyticsService.dataQuality();
      let issues = 0;
      for (const c of q.checks) {
        const key = `dq:${c.key}`;
        if (c.count > 0) {
          issues += 1;
          await ctx.raise({ type: 'data_quality', severity: c.severity, title: `${c.title}: ${c.count}`, entityType: 'check', entityId: c.key, dedupeKey: key, detail: { count: c.count, examples: c.examples, checkedAt: q.checkedAt } });
        } else {
          await ctx.clear(key, 'The check came back clean.');
        }
      }
      return { processed: q.checks.length, succeeded: q.checks.length, failed: 0, issues };
    },
  });

  if (b2bBeneficiaryImportService) {
    ops.register({
      name: 'b2b-beneficiary-invites', title: 'Beneficiary invites', schedule: { type: 'every', minutes: 10 }, quiet: true,
      description: 'Enrols invited people who have since joined FitFlex, and sends the invitation messages that are due: by email the invitation and reminders after 3 and 10 days, by SMS the invitation and one reminder after 3 days.',
      run: async (ctx) => {
        const matched = await b2bBeneficiaryImportService.matchInvites();
        const emails = await b2bBeneficiaryImportService.sendDue();
        if (matched.failed) await ctx.raise({ type: 'job_item_failed', severity: 'medium', title: `${matched.failed} invited ${matched.failed === 1 ? 'person' : 'people'} could not be enrolled after joining`, entityType: 'job', entityId: ctx.job, dedupeKey: `item:${ctx.job}:enrol`, detail: matched });
        else if (matched.matched) await ctx.clear(`item:${ctx.job}:enrol`, 'Enrolled.');
        const { email, sms } = emails;
        if (email.notConfigured) await ctx.raise({ type: 'job_item_failed', severity: 'low', title: `${email.due} invitation email(s) are waiting: the email sender is not set up`, entityType: 'job', entityId: ctx.job, dedupeKey: `item:${ctx.job}:email-setup`, detail: email });
        else if (email.due) await ctx.clear(`item:${ctx.job}:email-setup`, 'The email sender is set up.');
        if (email.failed) await ctx.raise({ type: 'job_item_failed', severity: 'low', title: `${email.failed} invitation email(s) were not accepted`, entityType: 'job', entityId: ctx.job, dedupeKey: `item:${ctx.job}:email`, detail: email });
        else if (email.sent) await ctx.clear(`item:${ctx.job}:email`, 'Emails sent.');
        // SMS that is switched off or not set up is not a fault: those invites simply get no SMS.
        if (sms.failed) await ctx.raise({ type: 'job_item_failed', severity: 'low', title: `${sms.failed} invitation SMS were not accepted`, entityType: 'job', entityId: ctx.job, dedupeKey: `item:${ctx.job}:sms`, detail: sms });
        else if (sms.sent) await ctx.clear(`item:${ctx.job}:sms`, 'SMS sent.');
        return { processed: matched.matched + emails.sent + emails.failed, succeeded: matched.enrolled + emails.sent, failed: matched.failed + emails.failed, enrolled: matched.enrolled, emailsSent: email.sent, smsSent: sms.sent, emailsWaiting: email.notConfigured ? email.due : 0, smsWaiting: sms.notConfigured ? sms.due : 0 };
      },
    });
  }

  /** Work waiting on a person, for the operations page. Counts only. */
  async function pendingWork() {
    const day = localDay(now());
    const count = async q => Number((await q.count({ c: '*' }))[0].c);
    const [drafts, toIssueOld, notices, overdue, onHold, staleHolds, awaitingMember, awaitingLink, pendingPeople, unlinkedStaff] = await Promise.all([
      count(db('B2BSponsorInvoice').where({ status: 'draft' }).where('totalTzs', '<>', 0)),
      count(db('B2BSponsorInvoice').where({ status: 'draft' }).where('totalTzs', '<>', 0).where('createdAt', '<', new Date(+now() - 7 * 86_400_000))),
      count(db('B2BPaymentNotice').where({ status: 'submitted' })),
      count(db('B2BSponsorInvoice').whereIn('status', ['issued', 'partially_paid']).where('totalTzs', '>', 0).whereNotNull('dueDate').where('dueDate', '<', day)),
      count(db('B2BBillingAccount').where({ onHold: true })),
      count(db('B2BBenefitConsumption').where({ status: 'pending' }).where('createdAt', '<', new Date(+now() - 60 * 60_000))),
      count(db('B2BPassEntitlement').where({ status: 'awaiting_member' })),
      count(db('B2BPassEntitlement').where({ status: 'awaiting_link' })),
      count(db('B2BBeneficiary').where({ status: 'pending' })),
      count(db('CorporateEmployee as e').join('B2BOrganization as o', 'o.legacyCorporateId', 'e.corporateId').whereIn('e.status', ['active', 'pending']).whereNull('e.userId')),
    ]);
    const unpaidCredit = await count(db('B2BPayment').where({ status: 'received' }).whereRaw('"amountTzs" > "allocatedTzs"'));
    const invites = b2bBeneficiaryImportService ? await b2bBeneficiaryImportService.pending() : { invitesWaiting: 0, invitesNotDelivered: 0, importsWithRejectedRowsLast7Days: 0 };
    return {
      billing: { draftInvoices: drafts, draftsOlderThan7Days: toIssueOld, paymentNoticesToCheck: notices, overdueInvoices: overdue, organizationsOnHold: onHold, paymentsNotFullyApplied: unpaidCredit },
      usage: { holdsOlderThan1Hour: staleHolds, passesAwaitingMemberPayment: awaitingMember, passesAwaitingAccountLink: awaitingLink },
      people: { beneficiariesPending: pendingPeople, employeesNotLinked: unlinkedStaff, ...invites },
    };
  }

  /** Everything the operations page shows at once. */
  async function overview() {
    const [jobs, exceptions, pending, recent] = await Promise.all([
      ops.jobStatus(), ops.exceptionCounts(), pendingWork(),
      db('OpsException').whereIn('status', LIVE_STATUSES).orderByRaw(`CASE "severity" WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END`).orderBy('detectedAt').limit(5).select('id', 'type', 'severity', 'status', 'title', 'detectedAt', 'occurrences'),
    ]);
    const by = state => jobs.filter(j => j.state === state).length;
    return {
      generatedAt: new Date(now()).toISOString(),
      jobs: { total: jobs.length, ok: by('ok'), running: by('running'), delayed: by('delayed'), retrying: by('retrying'), failed: by('failed'), paused: by('paused'), items: jobs },
      exceptions: { ...exceptions, mostUrgent: recent },
      pending,
    };
  }

  return { pendingWork, overview };
}
