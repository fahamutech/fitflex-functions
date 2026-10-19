// B2B Phase 7, slice 4 against the CI database: billing work that has waited
// too long, the provider-side checks, and alert emails to staff.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureInit } from '../functions/index.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { purgeB2BBilling } from './fixtures/ledger-cleanup.mjs';
import { b2bService, b2bProgramService, b2bAnalyticsService, signJwt as sign } from '../src/bootstrap/services.mjs';
import { createB2BWatchService, WATCH } from '../src/services/b2b-watch-service.mjs';
import { createOpsService } from '../src/services/ops-service.mjs';
import { registerB2BJobs } from '../src/services/b2b-jobs.mjs';
import { localDay, addDays } from '../src/shared/member-progress.mjs';
import { adminB2BOpsOverview } from '../functions/b2b.mjs';
import * as jobs from '../functions/jobs.mjs';

await ensureInit();

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], orgs: [] };
const TODAY = localDay(new Date());
const daysAgo = n => new Date(Date.now() - n * 86_400_000);

async function user(userType = 'member') {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `Watch ${id.slice(-4)}`, updatedAt: new Date() });
  made.users.push(id);
  return id;
}
const OPERATOR = await user('admin');
const access = organizationId => b2bService.resolveAccess({ organizationId, userType: 'admin', userId: OPERATOR });
async function sponsor(name) {
  const { organization } = await b2bService.createOrganization({ body: { organizationType: 'employer', legalName: `Watch ${name} ${uid('o')}`, tradingName: name }, actorId: OPERATOR });
  made.orgs.push(organization.id);
  await b2bService.setOrganizationStatus({ organizationId: organization.id, status: 'active', actorId: OPERATOR });
  return organization.id;
}
async function programme(orgId) {
  const a = await access(orgId);
  const { program } = await b2bProgramService.createProgram({ access: a, body: { name: 'Staff Wellness', startDate: addDays(TODAY, -60) }, actorId: OPERATOR });
  const { benefit } = await b2bProgramService.createBenefit({ access: a, programId: program.id, body: { name: 'Gym visits', benefitType: 'gym_access', fundingType: 'full', usagePeriod: 'unlimited' }, actorId: OPERATOR });
  assert.ok(benefit);
  return { programId: program.id, benefitId: benefit.id };
}
const invoice = (q, orgId, programId, over = {}) => {
  const row = { id: uid('inv'), number: uid('FF-T'), organizationId: orgId, programId, period: TODAY.slice(0, 7), kind: 'usage', status: 'draft', totalTzs: 100000, createdAt: new Date(), updatedAt: new Date(), ...over };
  return q('B2BSponsorInvoice').insert(row).then(() => row);
};
const issued = dueDate => ({ status: 'issued', issuedAt: daysAgo(60), issuedBy: 'staff_a', vatRateBps: 0, vatTzs: 0, dueDate });

/** The watch service with what it emailed kept. */
function watch({ q = db, to = ['ops@example.test'], email = true, accept = true, now } = {}) {
  const sent = [];
  const svc = createB2BWatchService({
    db: q, recipients: () => to, portalLink: () => null, ...(now ? { now } : {}),
    emailSender: () => (email ? { configured: true, send: async (address, m) => { sent.push({ to: address, ...m }); return { ok: accept }; } } : { configured: false }),
  });
  return { svc, sent };
}
const mine = (found, orgId) => found.filter(f => f.organizationId === orgId).map(f => f.kind).sort();

function res() { return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }
async function call(route, { claims }) {
  const req = { headers: { authorization: `Bearer ${sign(claims)}` }, params: {}, body: {}, query: {} };
  const out = res();
  for (const guard of [route.onGuard].flat().filter(Boolean)) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return out;
}

after(async () => {
  await db('OpsException').whereIn('organizationId', made.orgs).del();
  await db('OpsException').where('dedupeKey', 'like', 'watchtest:%').del();
  await db('JobRun').whereIn('triggeredBy', made.users).del();
  await db('B2BPaymentNotice').whereIn('organizationId', made.orgs).del();
  await db('B2BCommercialAgreement').whereIn('organizationId', made.orgs).del();
  await purgeB2BBilling(db, made.orgs);
  await db('B2BBillingAccount').whereIn('organizationId', made.orgs).del();
  const programIds = await db('B2BWellnessProgram').whereIn('organizationId', made.orgs).pluck('id');
  await db('AuditLog').whereIn('target', programIds).del();
  await db('B2BBenefit').whereIn('programId', programIds).del();
  await db('B2BWellnessProgram').whereIn('organizationId', made.orgs).del();
  await db('B2BBeneficiary').whereIn('organizationId', made.orgs).del();
  await db('B2BOrganization').whereIn('id', made.orgs).del();
  await db('AuditLog').whereIn('actor', made.users).del();
  await db('User').whereIn('id', made.users).del();
});

// ── Billing watch ────────────────────────────────────────────────────────────

test('billing watch: nothing for an organisation whose work is in hand', async () => {
  const org = await sponsor('In Hand');
  const { programId } = await programme(org);
  await invoice(db, org, programId, { createdAt: daysAgo(WATCH.draftInvoiceDays - 1) });                       // a recent draft
  await invoice(db, org, programId, { createdAt: daysAgo(40), totalTzs: 0, kind: 'prepaid' });                                // an empty draft
  await invoice(db, org, programId, issued(addDays(TODAY, -WATCH.overdueDays)));                               // overdue, not yet long overdue
  await db('B2BPaymentNotice').insert({ id: uid('pn'), organizationId: org, amountTzs: 5000, method: 'bank_transfer', reference: 'R1', paidOn: TODAY, submittedBy: OPERATOR, status: 'submitted', submittedAt: daysAgo(1) });
  assert.deepEqual(mine(await watch().svc.billingWatch(), org), []);
});

test('billing watch: each kind of waiting work is found once per organisation, with amounts', async () => {
  const org = await sponsor('Waiting');
  const { programId } = await programme(org);
  await invoice(db, org, programId, { createdAt: daysAgo(WATCH.draftInvoiceDays + 1), totalTzs: 70000 });
  await invoice(db, org, programId, { createdAt: daysAgo(20), totalTzs: 30000, kind: 'prepaid' });
  await invoice(db, org, programId, { ...issued(addDays(TODAY, -(WATCH.overdueDays + 1))), totalTzs: 200000, status: 'partially_paid', amountPaidTzs: 50000 });
  await db('B2BPaymentNotice').insert({ id: uid('pn'), organizationId: org, amountTzs: 150000, method: 'bank_transfer', reference: 'TRX-9', paidOn: TODAY, submittedBy: OPERATOR, status: 'submitted', submittedAt: daysAgo(WATCH.paymentNoticeDays + 1) });
  await db('B2BPayment').insert({ id: uid('pay'), number: uid('FF-RCT'), organizationId: org, amountTzs: 90000, allocatedTzs: 50000, method: 'bank_transfer', reference: 'B-1', receivedAt: daysAgo(WATCH.unappliedPaymentDays + 1), status: 'received' });
  await db('B2BCommercialAgreement').insert({ id: uid('agr'), organizationId: org, reference: 'AGR-W', status: 'active', effectiveFrom: addDays(TODAY, -300), effectiveTo: addDays(TODAY, 10), activatedAt: new Date(), activatedBy: OPERATOR });
  await db('B2BBillingAccount').insert({ id: uid('ba'), organizationId: org, onHold: true, holdReason: 'Unpaid', holdBy: OPERATOR, holdAt: daysAgo(WATCH.holdDays + 1) });

  const found = (await watch().svc.billingWatch()).filter(f => f.organizationId === org);
  assert.deepEqual(found.map(f => f.kind).sort(), ['agreement_ending', 'drafts_not_issued', 'long_on_hold', 'long_overdue', 'payment_not_applied', 'payment_notices_unchecked']);
  const by = Object.fromEntries(found.map(f => [f.kind, f]));
  assert.deepEqual([by.drafts_not_issued.detail.count, by.drafts_not_issued.detail.totalTzs, by.drafts_not_issued.severity], [2, 100000, 'medium']);
  assert.deepEqual([by.long_overdue.detail.outstandingTzs, by.long_overdue.detail.onHold, by.long_overdue.severity], [150000, true, 'high']);
  assert.match(by.long_overdue.title, /^Waiting: 1 invoice more than 30 days overdue \(TSh 150,000\), on hold$/);
  assert.equal(by.payment_not_applied.detail.unappliedTzs, 40000);
  assert.deepEqual([by.payment_notices_unchecked.detail.totalTzs, by.payment_notices_unchecked.severity], [150000, 'high']);
  assert.equal(by.agreement_ending.detail.reference, 'AGR-W');
  assert.equal(by.drafts_not_issued.key, `watch:drafts_not_issued:${org}`);

  // An agreement set to follow means nothing is ending.
  await db('B2BCommercialAgreement').insert({ id: uid('agr'), organizationId: org, reference: 'AGR-W2', status: 'active', effectiveFrom: addDays(TODAY, 11), activatedAt: new Date(), activatedBy: OPERATOR });
  assert.ok(!mine(await watch().svc.billingWatch(), org).includes('agreement_ending'));
});

test('billing watch job: raises one exception per finding, repeats do not duplicate, and it clears when the work is done', async () => {
  const org = await sponsor('Job');
  const { programId } = await programme(org);
  const draft = await invoice(db, org, programId, { createdAt: daysAgo(30) });
  const ops = createOpsService({ db });
  const { svc } = watch();
  // Only this organisation's findings, so other tests' rows are left alone.
  const scoped = { ...svc, billingWatch: async () => (await svc.billingWatch()).filter(f => f.organizationId === org) };
  ops.register({ name: 'watchtest-billing', title: 't', schedule: { type: 'daily', utc: '04:30' }, run: async (ctx) => {
    const found = await scoped.billingWatch();
    for (const f of found) await ctx.raise({ type: 'billing_watch', severity: f.severity, title: f.title, organizationId: f.organizationId, dedupeKey: f.key, detail: f.detail });
    const keys = new Set(found.map(f => f.key));
    for (const k of (await db('OpsException').where({ type: 'billing_watch', organizationId: org }).whereIn('status', ['open']).pluck('dedupeKey')).filter(k => !keys.has(k))) await ctx.clear(k, 'No longer waiting.');
    return { processed: found.length };
  } });
  await ops.runJob('watchtest-billing', { trigger: 'manual', actorId: OPERATOR });
  await ops.runJob('watchtest-billing', { trigger: 'manual', actorId: OPERATOR });
  let rows = await db('OpsException').where({ organizationId: org });
  assert.deepEqual(rows.map(r => [r.type, r.status, r.occurrences, r.dedupeKey]), [['billing_watch', 'open', 2, `watch:drafts_not_issued:${org}`]]);

  await db('B2BSponsorInvoice').where({ id: draft.id }).update({ status: 'void', voidedAt: new Date(), voidedBy: OPERATOR, voidReason: 'test' });
  await ops.runJob('watchtest-billing', { trigger: 'manual', actorId: OPERATOR });
  rows = await db('OpsException').where({ organizationId: org });
  assert.deepEqual(rows.map(r => [r.status, r.resolution]), [['resolved', 'No longer waiting.']]);
});

test('the registered jobs: billing watch, staff alerts and the daily summary are scheduled and on the operations page', async () => {
  assert.deepEqual([jobs.b2bBillingWatch.rule, jobs.opsAlerts.rule, jobs.opsDailySummary.rule], ['30 4 * * *', '*/10 * * * *', '30 5 * * *']);
  const overview = await call(adminB2BOpsOverview, { claims: { sub: OPERATOR, userType: 'admin' } });
  assert.equal(overview.statusCode, 200);
  const byName = Object.fromEntries(overview.body.jobs.items.map(j => [j.name, j]));
  assert.deepEqual([byName['b2b-billing-watch'].domain, byName['ops-alerts'].schedule, byName['ops-daily-summary'].schedule], ['finance', { type: 'every', minutes: 10 }, { type: 'daily', utc: '05:30' }]);
  assert.deepEqual(Object.keys(overview.body.alerts).sort(), ['active', 'emailConfigured', 'recipients']);
});

// ── Provider side ────────────────────────────────────────────────────────────

test('provider checks: sponsored usage a settled month missed, settled visits without valid usage, and sessions on no trainer statement', async () => {
  const org = await sponsor('Provider');
  const { programId, benefitId } = await programme(org);
  const member = await user();
  const { beneficiary } = await b2bService.enrollBeneficiary({ access: await access(org), body: { userId: member, status: 'active' }, actorId: OPERATOR });
  const trx = await db.transaction();
  try {
    const { svc } = watch({ q: trx });
    const before = Object.fromEntries((await svc.providerChecks()).map(c => [c.key, c.count]));
    assert.deepEqual(Object.keys(before).sort(), ['gym_usage_missing_from_settlement', 'settled_visit_without_usage', 'trainer_usage_missing_from_settlement']);

    // A settled (live, locked) month long ago, so nothing else is in it.
    const run = { id: uid('run'), mode: 'live', periodStartDate: '2019-03-01', periodEndDate: '2019-04-01', status: 'draft', engineVersion: 'settlement-engine/1', createdBy: 'system' };
    await trx('SettlementRun').insert(run);
    const cycle = uid('mcs');
    await trx('MemberCycleSettlement').insert({ id: cycle, runId: run.id, mode: 'live', memberId: member, subscriptionId: `b2b:${beneficiary.id}:2019-03`, cycleStart: new Date('2019-03-01'), cycleEnd: new Date('2019-04-01'), passTier: 'standard', visitAllowance: 0, collectedApprovedAmountTzs: 0, networkPayoutBps: 0, networkCapTzs: 0, totalPreliminaryTzs: 0, totalFinalTzs: 0, networkAdjustmentTzs: 0, capApplied: false, payableVisitCount: 0, heldVisitCount: 1, excludedVisitCount: 0, engineVersion: 'settlement-engine/1', fundingType: 'b2b_benefit' });
    const visit = (checkinId, over = {}) => trx('SettlementVisit').insert({ id: uid('sv'), runId: run.id, mode: 'live', memberCycleSettlementId: cycle, checkinId, gymId: 'gym_x', outcome: 'held', eligibility: 'disputed', businessDate: '2019-03-10', ...over });
    const usage = (sourceType, sourceId, over = {}) => {
      const row = { id: uid('use'), organizationId: org, programId, benefitId, beneficiaryId: beneficiary.id, beneficiarySource: 'beneficiary', userId: member, sourceType, sourceId, serviceType: sourceType === 'gym_checkin' ? 'gym_visit' : 'trainer_session', providerType: sourceType === 'gym_checkin' ? 'gym' : 'trainer', providerId: 'p_x', consumedAt: new Date('2019-03-10T09:00:00Z'), businessDate: '2019-03-10', unitValueTzs: 5000, grossTzs: 5000, sponsorTzs: 5000, beneficiaryTzs: 0, status: 'approved', verifiedAt: new Date(), ...over };
      return trx('B2BBenefitConsumption').insert(row).then(() => row);
    };

    // In the settlement: fine.
    const settled = uid('chk'); await usage('gym_checkin', settled); await visit(settled);
    // Approved in the settled month, in no settlement.
    const missed = await usage('gym_checkin', uid('chk'));
    // Approved in a month with no live run: nothing to compare against.
    await usage('gym_checkin', uid('chk'), { businessDate: '2019-05-10' });
    // A shadow run does not count as settled.
    const shadow = { ...run, id: uid('run'), mode: 'shadow', periodStartDate: '2019-06-01', periodEndDate: '2019-07-01' };
    await trx('SettlementRun').insert(shadow);
    await trx('SettlementRun').where({ id: shadow.id }).update({ status: 'locked', lockedAt: new Date(), lockedBy: 'system', inputsHash: 'sha256:test' });
    await usage('gym_checkin', uid('chk'), { businessDate: '2019-06-10' });
    // Settled as held, but the usage was reversed since.
    const gone = uid('chk');
    await usage('gym_checkin', gone, { status: 'reversed', reversedAt: new Date(), reversedBy: OPERATOR, reversalReason: 'test' });
    await visit(gone);
    // Excluded by the engine: no usage needed.
    await visit(uid('chk'), { outcome: 'excluded', eligibility: 'voided' });
    await trx('SettlementRun').where({ id: run.id }).update({ status: 'locked', lockedAt: new Date(), lockedBy: 'system', inputsHash: 'sha256:test' });

    // Trainer sessions: one on a statement, one voided line, one too recent.
    const trainer = uid('trn');
    const gymId = uid('gym');
    await trx('TrainerProfile').insert({ id: trainer, displayName: 'Watch Coach', updatedAt: new Date() });
    await trx('Gym').insert({ id: gymId, name: 'Watch Gym', tier: 'standard', location: 'Dar es Salaam', updatedAt: new Date() });
    const booking = async (date, status = 'completed') => { const id = uid('bk'); await trx('TrainerBooking').insert({ id, memberId: member, trainerId: trainer, gymId, date, slot: '09:00', amountTzs: 20000, status }); return id; };
    const st = uid('ts');
    await trx('TrainerSettlement').insert({ id: st, trainerId: trainer, periodStartDate: '2019-03-04', periodEndDate: '2019-03-11' });
    const line = (bookingId, voided = false) => trx('TrainerSettlementLine').insert({ id: uid('tl'), trainerSettlementId: st, bookingId, date: '2019-03-10', basis: 'completed', payoutTzs: 16000, voided });
    const onStatement = await booking('2019-03-10'); await usage('trainer_booking', onStatement); await line(onStatement);
    const voidedLine = await booking('2019-03-10'); const lost = await usage('trainer_booking', voidedLine); await line(voidedLine, true);
    const recent = await booking(addDays(TODAY, -2)); await usage('trainer_booking', recent, { businessDate: addDays(TODAY, -2) });
    const cancelled = await booking('2019-03-10', 'cancelled'); await usage('trainer_booking', cancelled);

    const checks = Object.fromEntries((await svc.providerChecks()).map(c => [c.key, c]));
    assert.equal(checks.gym_usage_missing_from_settlement.count - before.gym_usage_missing_from_settlement, 1);
    assert.ok(checks.gym_usage_missing_from_settlement.examples.includes(missed.id) || checks.gym_usage_missing_from_settlement.count > 5);
    assert.equal(checks.settled_visit_without_usage.count - before.settled_visit_without_usage, 1);
    assert.equal(checks.settled_visit_without_usage.severity, 'high');
    assert.equal(checks.trainer_usage_missing_from_settlement.count - before.trainer_usage_missing_from_settlement, 1);
    assert.ok(checks.trainer_usage_missing_from_settlement.examples.includes(lost.id) || checks.trainer_usage_missing_from_settlement.count > 5);
  } finally { await trx.rollback(); }
});

test('the integrity job includes the provider checks and raises what they find', async () => {
  const ops = createOpsService({ db });
  const fake = { providerChecks: async () => [{ key: 'watchtest_provider', severity: 'high', title: 'Provider test', count: 2, examples: ['a', 'b'] }] };
  registerB2BJobs({ ops, db, programs: null, b2bAnalyticsService: { dataQuality: async () => ({ checkedAt: 'now', checks: [] }) }, b2bWatchService: fake });
  await ops.runJob('b2b-integrity-check', { trigger: 'manual', actorId: OPERATOR });
  const row = await db('OpsException').where({ dedupeKey: 'dq:watchtest_provider' }).first();
  assert.deepEqual([row.type, row.severity, row.title, row.status], ['data_quality', 'high', 'Provider test: 2', 'open']);
  fake.providerChecks = async () => [{ key: 'watchtest_provider', severity: 'high', title: 'Provider test', count: 0, examples: [] }];
  await ops.runJob('b2b-integrity-check', { trigger: 'manual', actorId: OPERATOR });
  assert.equal((await db('OpsException').where({ dedupeKey: 'dq:watchtest_provider' }).first()).status, 'resolved');
  await db('OpsException').where({ dedupeKey: 'dq:watchtest_provider' }).del();
  // The real data-quality run still answers with the same shape.
  assert.ok(Array.isArray((await b2bAnalyticsService.dataQuality()).checks));
});

// ── Alerts ───────────────────────────────────────────────────────────────────

test('alerts: high severity and given-up exceptions are emailed once; others wait for the summary', async () => {
  const trx = await db.transaction();
  try {
    await trx('OpsException').whereNull('alertedAt').update({ alertedAt: new Date() });   // only this test's rows are due
    const ops = createOpsService({ db: trx });
    const high = (await ops.raise({ type: 'data_quality', severity: 'high', title: 'Invoices that do not add up: 3', dedupeKey: 'watchtest:high' })).exception;
    const low = (await ops.raise({ type: 'job_item_failed', severity: 'low', title: 'A notice was not sent', dedupeKey: 'watchtest:low' })).exception;
    const gaveUp = (await ops.raise({ type: 'job_failed', severity: 'medium', title: 'Payment reminders failed', dedupeKey: 'watchtest:gaveup' })).exception;
    await trx('OpsException').where({ id: gaveUp.id }).update({ status: 'permanently_failed' });

    // Nobody to tell: nothing is marked, so it goes out once someone is set.
    assert.deepEqual(await watch({ q: trx, to: [] }).svc.sendAlerts(), { due: 2, sent: 0, skipped: 'no_recipients' });
    assert.deepEqual(await watch({ q: trx, email: false }).svc.sendAlerts(), { due: 2, sent: 0, skipped: 'email_not_configured' });
    assert.deepEqual(await watch({ q: trx, accept: false }).svc.sendAlerts(), { due: 2, sent: 0, skipped: 'not_accepted' });
    assert.equal(await trx('OpsException').whereNotNull('alertedAt').whereIn('id', [high.id, gaveUp.id]).first(), undefined);

    const { svc, sent } = watch({ q: trx, to: ['a@example.test', 'b@example.test'] });
    assert.deepEqual(await svc.sendAlerts(), { due: 2, sent: 2, skipped: null });
    assert.deepEqual(sent.map(m => m.to), ['a@example.test', 'b@example.test']);
    assert.equal(sent[0].subject, 'FitFlex B2B: 2 things need attention');
    assert.match(sent[0].text, /\[high\] Invoices that do not add up: 3/);
    assert.match(sent[0].text, /\[medium\] Payment reminders failed \(retrying has been given up\)/);
    assert.doesNotMatch(sent[0].text, /A notice was not sent/);
    // Seen again: not announced again.
    await ops.raise({ type: 'data_quality', severity: 'high', title: 'Invoices that do not add up: 4', dedupeKey: 'watchtest:high' });
    assert.deepEqual(await svc.sendAlerts(), { due: 0, sent: 0, skipped: null });
    assert.equal(sent.length, 2);

    // The summary lists everything still waiting, most severe first.
    const digest = watch({ q: trx });
    const r = await digest.svc.sendDigest({ pending: { billing: { draftInvoices: 4, paymentNoticesToCheck: 1, overdueInvoices: 2 }, programmes: { renewalDraftsToReview: 1 } } });
    assert.equal(r.sent, 1);
    assert.match(digest.sent[0].subject, /^FitFlex B2B: \d+ waiting \(\d+ high\)$/);
    const lines = digest.sent[0].text.split('\n');
    assert.ok(lines.findIndex(l => l.includes('do not add up')) < lines.findIndex(l => l.includes(low.title)));
    assert.match(digest.sent[0].text, /Also waiting: 4 draft invoice\(s\), 1 payment notice\(s\), 2 overdue invoice\(s\), 1 renewal\(s\) to review\./);
    assert.match(digest.sent[0].text, /Open the FitFlex portal, B2B operations\./);

    // Nothing waiting: no summary.
    await trx('OpsException').whereIn('status', ['open', 'investigating', 'retrying', 'permanently_failed']).update({ status: 'resolved', resolvedAt: new Date(), resolvedBy: 'test', resolution: 'test' });
    const quiet = watch({ q: trx });
    assert.deepEqual(await quiet.svc.sendDigest(), { live: 0, sent: 0, skipped: 'nothing_waiting' });
    assert.equal(quiet.sent.length, 0);
  } finally { await trx.rollback(); }
});

test('alerts: with nothing configured the status says so and no address is assumed', () => {
  const before = process.env.OPS_ALERT_EMAILS;
  delete process.env.OPS_ALERT_EMAILS;
  try {
    const svc = createB2BWatchService({ db, emailSender: () => ({ configured: true, send: async () => ({ ok: true }) }) });
    assert.deepEqual(svc.alertStatus(), { recipients: 0, emailConfigured: true, active: false });
    process.env.OPS_ALERT_EMAILS = ' a@example.test, ,b@example.test ';
    assert.deepEqual(svc.alertStatus(), { recipients: 2, emailConfigured: true, active: true });
  } finally { if (before === undefined) delete process.env.OPS_ALERT_EMAILS; else process.env.OPS_ALERT_EMAILS = before; }
});
