// Watching for things that need a person (Phase 7, slice 4).
//
//   billing watch     work that has waited too long: draft invoices nobody
//                     has issued, payment notices nobody has checked,
//                     invoices long overdue, money received but not applied,
//                     an agreement about to run out
//   provider checks   the provider side of the chain, read only:
//                       usage → settlement visit → statement
//                     Sponsor-funded usage a settled month has missed, and
//                     settled visits whose usage is no longer valid. (A
//                     sponsored pass is not checked: a pass nobody used may
//                     rightly have nothing settled.)
//   alerts            an email to FitFlex staff when a high-severity
//                     exception appears or retrying is given up, and a daily
//                     summary while anything is waiting
//
// Nothing here changes a record, approves anything or decides a policy. The
// thresholds in WATCH say when something is worth a person's attention; they
// are not credit control. What to do about it stays with staff.
//
// The settlement tables belong to the settlement engines and are only read.
// With gym settlement in shadow mode there are no live runs, so the provider
// checks have nothing to compare against and report nothing.
import { formatTsh } from '../shared/money-display.mjs';
import { localDay, addDays } from '../shared/member-progress.mjs';
import { OPEN_STATUSES, outstandingTzs, daysOverdue } from '../shared/b2b-billing.mjs';
import { agreementInForce } from './b2b-finance-service.mjs';

/** When waiting work becomes an exception. */
export const WATCH = Object.freeze({
  draftInvoiceDays: 7,          // a draft invoice not issued
  paymentNoticeDays: 3,         // a payment notice not confirmed or rejected
  overdueDays: 30,              // an invoice past due
  unappliedPaymentDays: 3,      // money received, not applied, while invoices are open
  agreementEndsWithinDays: 30,  // the agreement in force ends and nothing follows it
  holdDays: 30,                 // an organisation left on hold
  trainerSettlementLagDays: 14, // a sponsored session not yet on a trainer statement
});
const tzs = formatTsh;
const n = v => Number(v) || 0;

export function createB2BWatchService({
  db,
  // { configured, send(to, { subject, text }) }
  emailSender = () => ({ configured: false }),
  // Who is told about exceptions: addresses, comma separated. Nobody by default.
  recipients = () => String(process.env.OPS_ALERT_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean),
  // A link to the operations page for the email. None is invented.
  portalLink = () => process.env.OPS_PORTAL_LINK || null,
  now = () => new Date(),
}) {
  const today = () => localDay(now());
  const stamp = () => new Date(now());
  const ago = days => new Date(+stamp() - days * 86_400_000);

  // ── Billing watch ─────────────────────────────────────────────────────────

  /**
   * What has waited too long, one entry per organisation and kind. Each entry
   * becomes an exception; an entry that is no longer returned has been dealt
   * with and its exception clears.
   */
  async function billingWatch() {
    const day = today();
    const out = [];
    const orgs = new Map((await db('B2BOrganization').select('id', 'legalName', 'tradingName', 'status')).map(o => [o.id, o]));
    const name = id => { const o = orgs.get(id); return o ? (o.tradingName || o.legalName) : id; };
    const add = (kind, organizationId, severity, title, detail) => out.push({
      key: `watch:${kind}:${organizationId}`, kind, severity, organizationId, entityType: 'organization', entityId: organizationId, title, detail,
    });
    const group = (rows, key = 'organizationId') => { const m = new Map(); for (const r of rows) { if (!m.has(r[key])) m.set(r[key], []); m.get(r[key]).push(r); } return m; };

    const drafts = await db('B2BSponsorInvoice').where({ status: 'draft' }).where('totalTzs', '<>', 0).where('createdAt', '<', ago(WATCH.draftInvoiceDays)).select('id', 'organizationId', 'period', 'kind', 'totalTzs', 'createdAt');
    for (const [orgId, rows] of group(drafts)) {
      add('drafts_not_issued', orgId, 'medium', `${name(orgId)}: ${rows.length} draft invoice${rows.length === 1 ? '' : 's'} not issued for over ${WATCH.draftInvoiceDays} days (${tzs(rows.reduce((t, r) => t + r.totalTzs, 0))})`,
        { count: rows.length, totalTzs: rows.reduce((t, r) => t + r.totalTzs, 0), invoices: rows.slice(0, 10).map(r => ({ id: r.id, kind: r.kind, period: r.period, totalTzs: r.totalTzs })) });
    }

    const notices = await db('B2BPaymentNotice').where({ status: 'submitted' }).where('submittedAt', '<', ago(WATCH.paymentNoticeDays)).select('id', 'organizationId', 'amountTzs', 'reference', 'submittedAt');
    for (const [orgId, rows] of group(notices)) {
      add('payment_notices_unchecked', orgId, 'high', `${name(orgId)}: ${rows.length} payment notice${rows.length === 1 ? '' : 's'} unchecked for over ${WATCH.paymentNoticeDays} days (${tzs(rows.reduce((t, r) => t + r.amountTzs, 0))})`,
        { count: rows.length, totalTzs: rows.reduce((t, r) => t + r.amountTzs, 0), notices: rows.slice(0, 10).map(r => ({ id: r.id, reference: r.reference, amountTzs: r.amountTzs })) });
    }

    const open = await db('B2BSponsorInvoice').whereIn('status', OPEN_STATUSES).where('totalTzs', '>', 0).whereNotNull('dueDate');
    const held = new Map((await db('B2BBillingAccount').where({ onHold: true }).select('organizationId', 'holdAt', 'holdReason')).map(h => [h.organizationId, h]));
    const late = open.filter(i => daysOverdue(i.dueDate, day) > WATCH.overdueDays);
    for (const [orgId, rows] of group(late)) {
      const owed = rows.reduce((t, r) => t + outstandingTzs(r), 0);
      add('long_overdue', orgId, 'high', `${name(orgId)}: ${rows.length} invoice${rows.length === 1 ? '' : 's'} more than ${WATCH.overdueDays} days overdue (${tzs(owed)})${held.has(orgId) ? ', on hold' : ''}`,
        { count: rows.length, outstandingTzs: owed, onHold: held.has(orgId), invoices: rows.slice(0, 10).map(r => ({ id: r.id, number: r.number, dueDate: r.dueDate, daysOverdue: daysOverdue(r.dueDate, day), outstandingTzs: outstandingTzs(r) })) });
    }

    const openOrgs = new Set(open.map(i => i.organizationId));
    const credit = await db('B2BPayment').where({ status: 'received' }).whereRaw('"amountTzs" > "allocatedTzs"').where('receivedAt', '<', ago(WATCH.unappliedPaymentDays)).select('id', 'organizationId', 'number', 'amountTzs', 'allocatedTzs');
    for (const [orgId, rows] of group(credit.filter(p => openOrgs.has(p.organizationId)))) {
      const left = rows.reduce((t, r) => t + (r.amountTzs - r.allocatedTzs), 0);
      add('payment_not_applied', orgId, 'medium', `${name(orgId)}: ${tzs(left)} received but not applied, while invoices are open`,
        { unappliedTzs: left, payments: rows.slice(0, 10).map(r => ({ id: r.id, number: r.number, unappliedTzs: r.amountTzs - r.allocatedTzs })) });
    }

    // The agreement in force runs out soon and nothing is set to follow it: FitFlex's standard terms would apply.
    const ending = await db('B2BCommercialAgreement').where({ status: 'active' }).whereNotNull('effectiveTo').where('effectiveTo', '>=', day).where('effectiveTo', '<=', addDays(day, WATCH.agreementEndsWithinDays));
    for (const a of ending) {
      if (orgs.get(a.organizationId)?.status !== 'active') continue;
      if (await agreementInForce(db, a.organizationId, addDays(a.effectiveTo, 1))) continue;
      add('agreement_ending', a.organizationId, 'medium', `${name(a.organizationId)}: agreement ${a.reference} ends on ${a.effectiveTo} with nothing to follow it`,
        { agreementId: a.id, reference: a.reference, effectiveTo: a.effectiveTo, then: 'FitFlex standard terms apply unless a new agreement is put in force.' });
    }

    for (const [orgId, h] of held) {
      if (h.holdAt && new Date(h.holdAt) < ago(WATCH.holdDays)) {
        add('long_on_hold', orgId, 'low', `${name(orgId)} has been on hold for over ${WATCH.holdDays} days`, { holdAt: h.holdAt, reason: h.holdReason });
      }
    }
    return out;
  }

  // ── Provider side ─────────────────────────────────────────────────────────

  /**
   * The provider side of sponsored usage, checked against the settlement
   * tables. Same shape as the data-quality checks: a count and a few examples.
   */
  async function providerChecks() {
    const sample = 5;
    const check = async (key, severity, title, query) => {
      const rows = await db.from(query.clone().as('t')).limit(sample).pluck('id');
      const [{ c }] = rows.length < sample ? [{ c: rows.length }] : await db.from(query.clone().as('t')).count({ c: '*' });
      return { key, severity, title, count: n(c), examples: rows, side: 'provider' };
    };
    const liveRun = 'EXISTS (SELECT 1 FROM "SettlementRun" r WHERE r."mode" = \'live\' AND r."status" = \'locked\' AND r."periodStartDate" <= ?? AND r."periodEndDate" > ??)';
    const lagDay = addDays(today(), -WATCH.trainerSettlementLagDays);
    return Promise.all([
      check('gym_usage_missing_from_settlement', 'medium', 'Sponsored gym visits in a settled month that are in no settlement',
        db('B2BBenefitConsumption as u').where({ 'u.status': 'approved', 'u.sourceType': 'gym_checkin' })
          .whereRaw(liveRun, ['u.businessDate', 'u.businessDate'])
          .whereNotExists(db('SettlementVisit as v').whereRaw('v."checkinId" = u."sourceId"').where({ 'v.mode': 'live', 'v.active': true }).select(db.raw('1')))
          .select('u.id')),
      check('settled_visit_without_usage', 'high', 'Sponsored visits settled as payable or held whose usage is no longer valid',
        db('SettlementVisit as v').join('MemberCycleSettlement as m', 'm.id', 'v.memberCycleSettlementId')
          .where({ 'v.mode': 'live', 'v.active': true, 'm.fundingType': 'b2b_benefit' }).whereIn('v.outcome', ['payable', 'held'])
          .whereNotExists(db('B2BBenefitConsumption as u').whereRaw('u."sourceId" = v."checkinId"').where({ 'u.sourceType': 'gym_checkin', 'u.status': 'approved' }).select(db.raw('1')))
          .select('v.id')),
      check('trainer_usage_missing_from_settlement', 'medium', `Sponsored trainer sessions completed over ${WATCH.trainerSettlementLagDays} days ago that are on no trainer statement`,
        db('B2BBenefitConsumption as u').join('TrainerBooking as b', 'b.id', 'u.sourceId')
          .where({ 'u.status': 'approved', 'u.sourceType': 'trainer_booking', 'b.status': 'completed' }).where('u.businessDate', '<', lagDay)
          .whereNotExists(db('TrainerSettlementLine as l').whereRaw('l."bookingId" = u."sourceId"').where({ 'l.voided': false }).select(db.raw('1')))
          .select('u.id')),
    ]);
  }

  // ── Alerts ────────────────────────────────────────────────────────────────

  const LIVE = ['open', 'investigating', 'retrying', 'permanently_failed'];
  const line = x => `- [${x.severity}] ${x.title}${x.status === 'permanently_failed' ? ' (retrying has been given up)' : ''}`;
  const footer = () => { const link = portalLink(); return link ? `\nOpen B2B operations: ${link}` : '\nOpen the FitFlex portal, B2B operations.'; };

  /** Whether anyone can be told, and why not if not. */
  function alertStatus() {
    const to = recipients();
    const configured = emailSender().configured === true;
    return { recipients: to.length, emailConfigured: configured, active: to.length > 0 && configured };
  }

  /**
   * Email staff about high-severity exceptions they have not been told about
   * (and, once, about one where retrying has been given up). Each exception
   * is announced once.
   */
  async function sendAlerts() {
    const stats = { due: 0, sent: 0, skipped: null };
    const due = await db('OpsException').whereIn('status', LIVE).whereNull('alertedAt').where(b => b.where({ severity: 'high' }).orWhere({ status: 'permanently_failed' })).orderBy('detectedAt').limit(50);
    stats.due = due.length;
    if (!due.length) return stats;
    const to = recipients();
    const sender = emailSender();
    if (!to.length) { stats.skipped = 'no_recipients'; return stats; }
    if (!sender.configured) { stats.skipped = 'email_not_configured'; return stats; }
    const subject = due.length === 1 ? `FitFlex B2B: ${due[0].title}`.slice(0, 150) : `FitFlex B2B: ${due.length} things need attention`;
    const text = [`${due.length === 1 ? 'This needs' : 'These need'} someone's attention:`, '', ...due.map(line), footer()].join('\n');
    let ok = 0;
    for (const address of to) {
      const r = await sender.send(address, { subject, text }).catch(() => ({ ok: false }));
      if (r?.ok) ok += 1;
    }
    // Told at least one person: not announced again. Told nobody: tried again next run.
    if (ok > 0) {
      await db('OpsException').whereIn('id', due.map(x => x.id)).update({ alertedAt: stamp() });
      stats.sent = due.length;
    } else stats.skipped = 'not_accepted';
    return stats;
  }

  /** A daily summary of everything still waiting, sent only when there is something. */
  async function sendDigest({ pending = null } = {}) {
    const live = await db('OpsException').whereIn('status', LIVE).orderByRaw(`CASE "severity" WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END`).orderBy('detectedAt');
    if (!live.length) return { live: 0, sent: 0, skipped: 'nothing_waiting' };
    const to = recipients();
    const sender = emailSender();
    if (!to.length) return { live: live.length, sent: 0, skipped: 'no_recipients' };
    if (!sender.configured) return { live: live.length, sent: 0, skipped: 'email_not_configured' };
    const high = live.filter(x => x.severity === 'high').length;
    const text = [
      `${live.length} exception${live.length === 1 ? '' : 's'} waiting${high ? `, ${high} of high severity` : ''}.`, '',
      ...live.slice(0, 30).map(line), live.length > 30 ? `…and ${live.length - 30} more.` : null,
      pending ? '' : null,
      pending ? `Also waiting: ${pending.billing.draftInvoices} draft invoice(s), ${pending.billing.paymentNoticesToCheck} payment notice(s), ${pending.billing.overdueInvoices} overdue invoice(s), ${pending.programmes?.renewalDraftsToReview ?? 0} renewal(s) to review.` : null,
      footer(),
    ].filter(l => l !== null).join('\n');
    let sent = 0;
    for (const address of to) {
      const r = await sender.send(address, { subject: `FitFlex B2B: ${live.length} waiting${high ? ` (${high} high)` : ''}`, text }).catch(() => ({ ok: false }));
      if (r?.ok) sent += 1;
    }
    return { live: live.length, sent, skipped: sent ? null : 'not_accepted' };
  }

  return { billingWatch, providerChecks, alertStatus, sendAlerts, sendDigest };
}
