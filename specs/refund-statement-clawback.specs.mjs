// Refund-to-statement clawback (Phase 1 · Slice D) against the CI database. Every DB test runs inside a
// transaction that is rolled back; the services are built on that transaction.
//   - REFUND_STATEMENT_CLAWBACK off: a paid refund moves no settlement money and the response is unchanged;
//   - on: the refunded share of a settled gym line is proposed as a clawback, once per refund and statement;
//   - REFUND_END_ACCESS_DEFAULT: a full pass refund ends access unless endAccess is explicitly false.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { createSettlementConfigService } from '../src/services/settlement-config-service.mjs';
import { createSettlementService, periodForMonth } from '../src/services/settlement-service.mjs';
import { createSettlementWorkflowService } from '../src/services/settlement-workflow-service.mjs';
import { createSettlementClawbackService } from '../src/services/settlement-clawback-service.mjs';
import { createRefundClawbackService } from '../src/services/refund-clawback-service.mjs';
import { createRefundService } from '../src/services/refund-service.mjs';
import { refundStatementClawbackOn, refundEndAccessDefaultOn } from '../src/shared/feature-flags.mjs';

const require = (await import('node:module')).createRequire(import.meta.url);
const ROLLBACK = Symbol('rollback');
const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const NOVEMBER = periodForMonth('2026-11');
const DECEMBER = periodForMonth('2026-12');

async function inRollback(fn) {
  try {
    await db.transaction(async (trx) => { await fn(trx); throw ROLLBACK; });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
}

function services(trx, at = '2026-12-02T09:00:00.000Z') {
  const configService = createSettlementConfigService({ db: trx, now: () => new Date('2026-09-01T09:00:00.000Z') });
  const settlement = createSettlementService({ db: trx, configService, now: () => new Date(at), logger: { error() {} } });
  const workflow = createSettlementWorkflowService({
    db: trx, now: () => new Date(at),
    payoutEligibility: { forGym: async () => ({ ok: true, destination: { kind: 'verified_account', accountLast4: '5678' } }) },
  });
  const voidSweep = createSettlementClawbackService({ db: trx, configService, workflow, now: () => new Date(at), logger: { warn() {} } });
  const refundClawback = createRefundClawbackService({ db: trx, workflow, now: () => new Date(at), logger: { warn() {} } });
  return { configService, settlement, workflow, voidSweep, refundClawback };
}

async function world(trx) {
  await trx('Subscription').update({ status: 'payment_cancelled' });
  await trx('B2BBenefitConsumption').whereIn('status', ['approved', 'pending']).update({ status: 'cancelled' });
  const { configService } = services(trx);
  const gym = async (tier, retail) => {
    const id = uid(`gym${tier[0]}`);
    await trx('Gym').insert({ id, name: `Refund ${tier}`, tier, location: 'Dar es Salaam', updatedAt: new Date() });
    const card = (await configService.createRateCard({ gymId: id, ...retail, actorId: 'maker' }, { trx })).rateCard;
    assert.ok((await configService.activate({ kind: 'rate_card', id: card.id, effectiveFrom: '2026-10-01', actorId: 'checker' }, { trx })).rateCard);
    return id;
  };
  return {
    gymC: await gym('midtier', { retailDailyTzs: 10000, retailWeeklyTzs: 35000, retailMonthlyTzs: 120000 }),
    gymD: await gym('premium', { retailDailyTzs: 20000, retailWeeklyTzs: 70000, retailMonthlyTzs: 250000 }),
  };
}

async function memberCycle(trx, { month = 10 } = {}) {
  const memberId = uid('usr');
  const subscriptionId = uid('sub');
  const paymentRequestId = uid('pay');
  const start = new Date(Date.UTC(2026, month - 1, 1, 7));
  const end = new Date(Date.UTC(2026, month - 1, 31, 7));
  await trx('User').insert({ id: memberId, userType: 'member', displayName: 'Refund Member', updatedAt: new Date() });
  await trx('Subscription').insert({ id: subscriptionId, memberId, type: 'platform_pass', tier: 'premium', status: 'expired', startedAt: start, cycleStartedAt: start, renewsAt: end, expiresAt: end });
  await trx('PaymentRequest').insert({ id: paymentRequestId, memberId, subscriptionId, tier: 'premium', amountTzs: 250000, status: 'approved', provider: 'admin_approved', requestedAt: start });
  return { memberId, subscriptionId, paymentRequestId, month };
}

async function visits(trx, m, gymId, count, { firstDay = 1 } = {}) {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: uid('chk'), memberId: m.memberId, gymId, timestamp: new Date(Date.UTC(2026, m.month - 1, firstDay + i, 12)),
    method: 'gym_scanned', subscriptionType: 'platform_pass', passTier: 'premium', visitNumberInCycle: firstDay + i, gymTier: 'premium',
    creditsDeductedTzs: 0, visitConsumed: true, status: 'valid', subscriptionId: m.subscriptionId,
    businessDate: `2026-${String(m.month).padStart(2, '0')}-${String(firstDay + i).padStart(2, '0')}`, source: 'member_qr_by_staff',
  }));
  await trx('Checkin').insert(rows);
  return rows;
}

const statementOf = (trx, gymId, period) => trx('GymSettlement').where({ gymId, mode: 'live', periodStartDate: period.periodStartDate }).first();
const refundAdjustments = (trx, refundId) => trx('SettlementAdjustment').where({ refundId }).orderBy('amountTzs');

async function pay(workflow, id) {
  for (const [stepName, actorId, extra] of [['submit', 'maker'], ['approve', 'checker'], ['markPayable', 'payer'], ['pay', 'payer', { paymentReference: 'REF-1' }]]) {
    const out = await workflow[stepName]({ id, actorId, ...(extra || {}) });
    assert.equal(out.error, undefined, `${stepName}: ${out.error}`);
  }
}

/** November settled: gym D x 15 (final 161,638), gym C x 5 (final 25,862), member paid 250,000. */
async function settledPass(trx) {
  const w = await world(trx);
  const m = await memberCycle(trx);
  const atD = await visits(trx, m, w.gymD, 15);
  await visits(trx, m, w.gymC, 5, { firstDay: 16 });
  const s = services(trx);
  await s.settlement.run({ ...NOVEMBER, mode: 'live', actorId: 'admin-1' });
  const d = await statementOf(trx, w.gymD, NOVEMBER);
  const c = await statementOf(trx, w.gymC, NOVEMBER);
  assert.deepEqual([d.finalNetTzs, c.finalNetTzs], [161638, 25862]);
  return { w, m, atD, d, c, ...s };
}

/** December draft statements for both gyms (another member's visits). */
async function december(trx, w) {
  const s = services(trx, '2027-01-02T09:00:00.000Z');
  const m = await memberCycle(trx, { month: 11 });
  await visits(trx, m, w.gymD, 5);
  await visits(trx, m, w.gymC, 5, { firstDay: 10 });
  await s.settlement.run({ ...DECEMBER, mode: 'live', actorId: 'admin-1' });
  return { ...s, d: await statementOf(trx, w.gymD, DECEMBER), c: await statementOf(trx, w.gymC, DECEMBER) };
}

const paidRefund = (m, amountTzs, extra = {}) => ({
  id: uid('rfd'), memberId: m.memberId, kind: 'subscription', subscriptionId: m.subscriptionId, paymentRequestId: m.paymentRequestId,
  amountTzs, currency: 'TZS', reasonCode: 'payment_error', status: 'paid', requestedBy: 'maker', requestedRole: 'admin',
  decidedBy: 'checker', decidedAt: new Date(), paidBy: 'payer', paidAt: new Date(), paymentReference: 'REF', createdAt: new Date(), updatedAt: new Date(), ...extra,
});

// ── the clawback ─────────────────────────────────────────────────────────────

test('flags default off', () => {
  assert.equal(refundStatementClawbackOn(), false);
  assert.equal(refundEndAccessDefaultOn(), false);
});

test('clawback: a full refund claws back each gym line, once, linked to the refund; retries never double it; visits stand', () => inRollback(async (trx) => {
  const x = await settledPass(trx);
  await pay(x.workflow, x.d.id);
  await pay(x.workflow, x.c.id);
  const dec = await december(trx, x.w);
  const refund = paidRefund(x.m, 250000);

  const first = await dec.refundClawback.raiseForRefund({ refund, actorId: 'payer' });
  assert.equal(first.status, 'raised');
  assert.deepEqual(first.raised.map((r) => [r.gymId, r.amountTzs]).sort(), [[x.w.gymC, -25862], [x.w.gymD, -161638]].sort());
  const rows = await refundAdjustments(trx, refund.id);
  assert.deepEqual(rows.map((r) => [r.type, r.status, r.amountTzs, r.createdBy, r.sourceMemberCycleSettlementId]), [['clawback', 'proposed', -161638, 'payer', null], ['clawback', 'proposed', -25862, 'payer', null]]);
  assert.deepEqual(rows.map((r) => r.gymSettlementId).sort(), [dec.c.id, dec.d.id].sort());
  assert.deepEqual(rows.map((r) => r.sourceSettlementId).sort(), [x.c.id, x.d.id].sort());
  // Nothing changes until another person applies it; the proposer can't.
  assert.equal((await trx('GymSettlement').where({ id: dec.d.id }).first()).adjustmentsTzs, 0);
  assert.equal((await dec.workflow.decideAdjustment({ id: rows[0].id, decision: 'apply', actorId: 'payer' })).error, 'cannot_approve_own_adjustment');
  assert.equal((await dec.workflow.decideAdjustment({ id: rows[0].id, decision: 'apply', actorId: 'checker' })).statement.adjustmentsTzs, -161638);

  // Retry, twice, and through the sweep: still two adjustments, one audit row each.
  for (let i = 0; i < 2; i += 1) {
    const again = await dec.refundClawback.raiseForRefund({ refund, actorId: 'someone-else' });
    assert.equal(again.status, 'already_raised');
    assert.equal(again.raised.length, 0);
  }
  assert.equal((await refundAdjustments(trx, refund.id)).length, 2);
  assert.equal((await trx('AuditLog').where({ action: 'refund_clawback_raised' }).whereIn('target', rows.map((r) => r.id))).length, 2);
  const audit = JSON.parse(JSON.stringify((await trx('AuditLog').where({ action: 'refund_clawback_raised', target: rows[0].id }).first()).after));
  assert.equal(audit.refundId, refund.id);
  // The database refuses a second live clawback for the same refund and statement.
  await assert.rejects(trx.transaction((t) => t('SettlementAdjustment').insert({ ...rows[0], id: randomUUID() })), (err) => err.code === '23505');

  // The visits stand (decision 3) and the check-in void sweep sees nothing to correct.
  assert.equal((await trx('Checkin').where({ subscriptionId: x.m.subscriptionId, status: 'valid' }).count({ n: '*' }).first()).n, '20');
  assert.deepEqual((await dec.voidSweep.sweep()).raised, []);
}));

test('clawback: a partial refund takes back the same share of each line', () => inRollback(async (trx) => {
  const x = await settledPass(trx);
  await pay(x.workflow, x.d.id);
  await pay(x.workflow, x.c.id);
  const dec = await december(trx, x.w);
  const out = await dec.refundClawback.raiseForRefund({ refund: paidRefund(x.m, 125000), actorId: 'payer' });
  assert.deepEqual(out.raised.map((r) => [r.gymId, r.amountTzs]).sort(), [[x.w.gymC, -Math.round(25862 / 2)], [x.w.gymD, -Math.round(161638 / 2)]].sort());
}));

test('clawback: a pass that was never settled creates nothing', () => inRollback(async (trx) => {
  const w = await world(trx);
  const m = await memberCycle(trx, { month: 11 });
  await visits(trx, m, w.gymD, 5);
  const { refundClawback } = services(trx);
  const refund = paidRefund(m, 250000);
  const out = await refundClawback.raiseForRefund({ refund });
  assert.equal(out.status, 'unsettled');
  assert.equal((await refundAdjustments(trx, refund.id)).length, 0);
}));

test('clawback: only paid pass refunds are looked at', () => inRollback(async (trx) => {
  const x = await settledPass(trx);
  for (const refund of [paidRefund(x.m, 250000, { status: 'approved' }), paidRefund(x.m, 250000, { kind: 'shop_order', subscriptionId: null })]) {
    assert.equal((await x.refundClawback.raiseForRefund({ refund })).status, 'not_applicable');
  }
  assert.equal((await trx('SettlementAdjustment').whereNotNull('refundId').count({ n: '*' }).first()).n, '0');
}));

test('clawback: with no draft statement it waits, and the sweep raises it once when the gym gets one', () => inRollback(async (trx) => {
  const x = await settledPass(trx);
  await pay(x.workflow, x.d.id);
  await pay(x.workflow, x.c.id);
  const refund = paidRefund(x.m, 250000);
  await trx('Refund').insert(refund);
  const waiting = await x.refundClawback.raiseForRefund({ refund, actorId: 'payer' });
  assert.deepEqual([waiting.status, waiting.raised.length, waiting.pending.length], ['pending', 0, 2]);
  assert.equal((await refundAdjustments(trx, refund.id)).length, 0);

  const dec = await december(trx, x.w);
  const swept = await dec.refundClawback.sweepPending({ actorId: 'system' });
  assert.equal(swept.results.length, 1);
  assert.equal((await refundAdjustments(trx, refund.id)).length, 2);
  assert.deepEqual((await dec.refundClawback.sweepPending()).results, []);
  assert.equal((await refundAdjustments(trx, refund.id)).length, 2);
  assert.deepEqual((await dec.refundClawback.listForRefund(refund.id)).map((r) => r.amountTzs).sort((a, b) => a - b), [-161638, -25862]);
}));

test('clawback: a submitted (unpaid) source statement is put on hold; a voided one is never clawed back', () => inRollback(async (trx) => {
  const x = await settledPass(trx);
  await x.workflow.submit({ id: x.d.id, actorId: 'maker' });          // gym D: frozen, not paid
  assert.equal((await x.workflow.requestVoid({ id: x.c.id, reason: 'Gym left', actorId: 'maker' })).error, undefined);
  assert.equal((await x.workflow.voidStatement({ id: x.c.id, actorId: 'checker' })).error, undefined);   // gym C: voided, never paid
  const dec = await december(trx, x.w);
  const refund = paidRefund(x.m, 250000);
  const out = await dec.refundClawback.raiseForRefund({ refund, actorId: 'payer' });
  assert.deepEqual(out.raised.map((r) => [r.gymId, r.amountTzs]), [[x.w.gymD, -161638]]);
  assert.deepEqual(out.skipped.map((s) => [s.gymId, s.reason]), [[x.w.gymC, 'statement_voided']]);
  assert.deepEqual(out.held, [x.d.id]);
  assert.ok((await trx('GymSettlement').where({ id: x.d.id }).first()).holdReason);
}));

test('clawback: never takes back more than the line still holds', () => inRollback(async (trx) => {
  const x = await settledPass(trx);
  await pay(x.workflow, x.d.id);
  await pay(x.workflow, x.c.id);
  const dec = await december(trx, x.w);
  const cycle = await trx('MemberCycleSettlement').where({ subscriptionId: x.m.subscriptionId }).first();
  // A visit correction of -150,000 was already raised on this cycle at gym D.
  await trx('SettlementAdjustment').insert({ id: randomUUID(), gymSettlementId: dec.d.id, amountTzs: -150000, type: 'clawback', reason: 'earlier', status: 'proposed',
    sourceSettlementId: x.d.id, sourceMemberCycleSettlementId: cycle.id, createdBy: 'voider', createdAt: new Date(), updatedAt: new Date() });
  const out = await dec.refundClawback.raiseForRefund({ refund: paidRefund(x.m, 250000), actorId: 'payer' });
  assert.equal(out.raised.find((r) => r.gymId === x.w.gymD).amountTzs, -(161638 - 150000));
}));

test('dry run reports without writing', () => inRollback(async (trx) => {
  const x = await settledPass(trx);
  await pay(x.workflow, x.d.id);
  const dec = await december(trx, x.w);
  const refund = paidRefund(x.m, 250000);
  const out = await dec.refundClawback.raiseForRefund({ refund, dryRun: true });
  assert.ok(out.raised.length > 0);
  assert.equal((await refundAdjustments(trx, refund.id)).length, 0);
}));

// ── the refund service hook ──────────────────────────────────────────────────

function memStore(rows = []) {
  return {
    rows,
    async allAsync() { return rows; },
    async findByIdAsync(id) { return rows.find((r) => r.id === id) || null; },
    async filterByColumnAsync(col, value) { return rows.filter((r) => r[col] === value); },
    async filterByColumnInAsync(col, ids) { return rows.filter((r) => ids.includes(r[col])); },
    async insertAsync(row) { rows.push(row); return row; },
    async updateByIdAsync(id, patch) { const i = rows.findIndex((r) => r.id === id); if (i >= 0) rows[i] = { ...rows[i], ...patch }; return rows[i] || null; },
  };
}

function refundFixture({ clawbackOn, endAccess = false, clawback = null, amount = 250000 } = {}) {
  const payment = { id: 'pay1', memberId: 'm1', subscriptionId: 'sub1', amountTzs: 250000, status: 'approved' };
  const refunds = memStore([{ id: 'rfd1', memberId: 'm1', kind: 'subscription', subscriptionId: 'sub1', paymentRequestId: 'pay1', amountTzs: amount, status: 'approved', decidedBy: 'checker', requestedRole: 'member', createdAt: new Date().toISOString() }]);
  const subscriptions = memStore([{ id: 'sub1', memberId: 'm1', expiresAt: '2099-01-01T00:00:00.000Z', renewsAt: '2099-01-01T00:00:00.000Z' }]);
  const auditRows = memStore();
  const calls = [];
  const service = createRefundService({
    refunds, paymentRequests: memStore([payment]), subscriptions, users: memStore(), auditLog: auditRows,
    secondApprover: () => false, splitScopes: () => false,
    clawbackOn: () => clawbackOn, endAccessDefault: () => endAccess,
    clawback: clawback ?? (async (args) => { calls.push(args.refund.id); return { status: 'raised', raised: [], existing: [], pending: [], skipped: [], held: [] }; }),
  });
  return { service, refunds, subscriptions, auditRows, calls };
}

test('markPaid with REFUND_STATEMENT_CLAWBACK off: response and behaviour unchanged, clawback never called', async () => {
  const f = refundFixture({ clawbackOn: false });
  const out = await f.service.markPaid({ id: 'rfd1', body: { paymentReference: 'R1' }, actorId: 'payer' });
  assert.deepEqual(Object.keys(out), ['refund']);
  assert.equal(out.refund.status, 'paid');
  assert.deepEqual(f.calls, []);
});

test('markPaid with the flag on: clawback runs once and is reported; a second markPaid does not run it again', async () => {
  const f = refundFixture({ clawbackOn: true });
  const out = await f.service.markPaid({ id: 'rfd1', body: { paymentReference: 'R1' }, actorId: 'payer' });
  assert.equal(out.clawback.status, 'raised');
  assert.deepEqual(f.calls, ['rfd1']);
  assert.equal((await f.service.markPaid({ id: 'rfd1', body: { paymentReference: 'R1' }, actorId: 'payer' })).error, 'already_paid');
  assert.deepEqual(f.calls, ['rfd1']);
});

test('a clawback that fails never blocks the refund: it is audited and reported', async () => {
  const f = refundFixture({ clawbackOn: true, clawback: async () => { throw new Error('boom'); } });
  const log = console.error; console.error = () => {};
  let out;
  try { out = await f.service.markPaid({ id: 'rfd1', body: { paymentReference: 'R1' }, actorId: 'payer' }); } finally { console.error = log; }
  assert.equal(out.refund.status, 'paid');
  assert.equal(out.clawback.error, 'clawback_failed');
  assert.ok(f.auditRows.rows.some((r) => r.action === 'refund_clawback_failed'));
});

test('markPaid does not claw back a refund that is not a pass refund', async () => {
  const f = refundFixture({ clawbackOn: true });
  f.refunds.rows[0] = { ...f.refunds.rows[0], kind: 'shop_order', subscriptionId: null, orderId: 'o1' };
  const out = await f.service.markPaid({ id: 'rfd1', body: { paymentReference: 'R1' }, actorId: 'payer' });
  assert.deepEqual(Object.keys(out), ['refund']);
  assert.deepEqual(f.calls, []);
});

// ── end access by default ────────────────────────────────────────────────────

const endedOf = (f) => f.subscriptions.rows[0].expiresAt !== '2099-01-01T00:00:00.000Z';
const approveRequested = (f, body = {}) => {
  f.refunds.rows[0].status = 'requested';
  return f.service.decide({ id: 'rfd1', body: { decision: 'approve', ...body }, actorId: 'approver' });
};

test('end access: flag off keeps today\'s rule (only an explicit true ends it)', async () => {
  let f = refundFixture({ endAccess: false });
  await approveRequested(f);
  assert.equal(endedOf(f), false);
  f = refundFixture({ endAccess: false });
  await approveRequested(f, { endAccess: true });
  assert.equal(endedOf(f), true);
});

test('end access: flag on, a full pass refund ends access by default', async () => {
  const f = refundFixture({ endAccess: true });
  await approveRequested(f);
  assert.equal(endedOf(f), true);
});

test('end access: flag on, an explicit false keeps access; an explicit true on a partial refund still ends it', async () => {
  let f = refundFixture({ endAccess: true });
  await approveRequested(f, { endAccess: false });
  assert.equal(endedOf(f), false);
  f = refundFixture({ endAccess: true });
  await approveRequested(f, { endAccess: true, amountTzs: 100000 });
  assert.equal(endedOf(f), true);
});

test('end access: flag on, a partial refund (or one approved for less) keeps access by default', async () => {
  let f = refundFixture({ endAccess: true, amount: 100000 });
  await approveRequested(f);
  assert.equal(endedOf(f), false);
  f = refundFixture({ endAccess: true });
  await approveRequested(f, { amountTzs: 100000 });
  assert.equal(endedOf(f), false);
});

test('end access: flag on, an admin raise approved at once follows the same default', async () => {
  const mk = () => {
    const f = refundFixture({ endAccess: true });
    f.refunds.rows.length = 0;
    return f;
  };
  let f = mk();
  let out = await f.service.adminRaise({ body: { paymentRequestId: 'pay1' }, actorId: 'raiser' });
  assert.equal(out.refund.status, 'approved');
  assert.equal(endedOf(f), true);
  f = mk();
  out = await f.service.adminRaise({ body: { paymentRequestId: 'pay1', endAccess: false }, actorId: 'raiser' });
  assert.equal(endedOf(f), false);
  f = mk();
  out = await f.service.adminRaise({ body: { paymentRequestId: 'pay1', amountTzs: 100000 }, actorId: 'raiser' });
  assert.equal(endedOf(f), false);
});

test('end access: flag off, an admin raise never ends access (unchanged)', async () => {
  const f = refundFixture({ endAccess: false });
  f.refunds.rows.length = 0;
  await f.service.adminRaise({ body: { paymentRequestId: 'pay1', endAccess: true }, actorId: 'raiser' });
  assert.equal(endedOf(f), false);
});

// ── migration ────────────────────────────────────────────────────────────────

test('migration: refundId column and the once-per-refund index go away and come back cleanly', () => inRollback(async (trx) => {
  const migration = require('../db/migrations/20270210090000-settlement-adjustment-refund.cjs');
  assert.equal(await trx.schema.hasColumn('SettlementAdjustment', 'refundId'), true);
  await migration.down(trx);
  assert.equal(await trx.schema.hasColumn('SettlementAdjustment', 'refundId'), false);
  assert.equal((await trx.raw(`select 1 from pg_indexes where indexname = 'settlement_adjustment_refund_once_uq'`)).rows.length, 0);
  await migration.up(trx);
  await migration.up(trx);   // idempotent
  assert.equal(await trx.schema.hasColumn('SettlementAdjustment', 'refundId'), true);
  assert.equal((await trx.raw(`select 1 from pg_indexes where indexname = 'settlement_adjustment_refund_once_uq'`)).rows.length, 1);
}));
