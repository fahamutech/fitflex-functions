// Voiding a statement and automatic clawbacks (settlement Phase 6, DR-20)
// against the CI database. Every test runs inside a transaction that is
// rolled back; the services are built on that transaction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { createSettlementConfigService } from '../src/services/settlement-config-service.mjs';
import { createSettlementService, periodForMonth } from '../src/services/settlement-service.mjs';
import { createSettlementWorkflowService } from '../src/services/settlement-workflow-service.mjs';
import { createSettlementClawbackService } from '../src/services/settlement-clawback-service.mjs';

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
  const clawback = createSettlementClawbackService({ db: trx, configService, workflow, now: () => new Date(at), logger: { warn() {} } });
  return { configService, settlement, workflow, clawback };
}

/** A mid-tier gym C and a premium gym D with approved rate cards. */
async function world(trx) {
  await trx('Subscription').update({ status: 'payment_cancelled' });
  await trx('B2BBenefitConsumption').whereIn('status', ['approved', 'pending']).update({ status: 'cancelled' });
  const { configService } = services(trx);
  const gym = async (tier, retail) => {
    const id = uid(`gym${tier[0]}`);
    await trx('Gym').insert({ id, name: `Clawback ${tier}`, tier, location: 'Dar es Salaam', updatedAt: new Date() });
    const card = (await configService.createRateCard({ gymId: id, ...retail, actorId: 'maker' }, { trx })).rateCard;
    assert.ok((await configService.activate({ kind: 'rate_card', id: card.id, effectiveFrom: '2026-10-01', actorId: 'checker' }, { trx })).rateCard);
    return id;
  };
  return {
    gymC: await gym('midtier', { retailDailyTzs: 10000, retailWeeklyTzs: 35000, retailMonthlyTzs: 120000 }),
    gymD: await gym('premium', { retailDailyTzs: 20000, retailWeeklyTzs: 70000, retailMonthlyTzs: 250000 }),
  };
}

/** A member with one 30-day Premium pass cycle from `month` (1–12 of 2026), paid 250,000. */
async function memberCycle(trx, { month = 10 } = {}) {
  const memberId = uid('usr');
  const subscriptionId = uid('sub');
  const start = new Date(Date.UTC(2026, month - 1, 1, 7));
  const end = new Date(Date.UTC(2026, month - 1, 31, 7));
  await trx('User').insert({ id: memberId, userType: 'member', displayName: 'Clawback Member', updatedAt: new Date() });
  await trx('Subscription').insert({ id: subscriptionId, memberId, type: 'platform_pass', tier: 'premium', status: 'expired', startedAt: start, cycleStartedAt: start, renewsAt: end, expiresAt: end });
  await trx('PaymentRequest').insert({ id: uid('pay'), memberId, subscriptionId, tier: 'premium', amountTzs: 250000, status: 'approved', provider: 'admin_approved', requestedAt: start });
  return { memberId, subscriptionId, month };
}

/** One valid, consumed check-in a day at 15:00 EAT from `firstDay` of the member's month. */
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

const voidCheckin = (trx, id, by = 'voider') => trx('Checkin').where({ id })
  .update({ status: 'voided', statusReason: 'Not a real visit', voidedAt: new Date('2026-12-02T08:00:00Z'), voidedBy: by, voidReason: 'Not a real visit' });
const statementOf = (trx, gymId, period) => trx('GymSettlement').where({ gymId, mode: 'live', periodStartDate: period.periodStartDate }).first();
const adjustmentsOn = (trx, id) => trx('SettlementAdjustment').where({ gymSettlementId: id }).orderBy('createdAt');

/** Submit, approve, clear and pay a draft statement. */
async function pay(workflow, id) {
  for (const [stepName, actorId, extra] of [['submit', 'maker'], ['approve', 'checker'], ['markPayable', 'payer'], ['pay', 'payer', { paymentReference: 'REF-1' }]]) {
    const out = await workflow[stepName]({ id, actorId, ...(extra || {}) });
    assert.equal(out.error, undefined, `${stepName}: ${out.error}`);
  }
}

// ── voiding a statement ──────────────────────────────────────────────────────

test('void: an unpaid statement is cancelled for good, with a reason, and is audited', () => inRollback(async (trx) => {
  const w = await world(trx);
  const m = await memberCycle(trx);
  await visits(trx, m, w.gymD, 15);
  const { settlement, workflow } = services(trx);
  await settlement.run({ ...NOVEMBER, mode: 'live', actorId: 'admin-1' });
  const s = await statementOf(trx, w.gymD, NOVEMBER);

  assert.deepEqual(await workflow.voidStatement({ id: s.id, reason: ' ', actorId: 'checker' }), { error: 'reason_required', status: 400 });
  assert.equal((await workflow.voidStatement({ id: s.id, reason: 'x' })).error, 'actor_required');
  const out = await workflow.voidStatement({ id: s.id, reason: ' Gym left the network ', actorId: 'checker' });
  assert.deepEqual([out.statement.status, out.statement.voidReason, out.statement.voidedBy, out.cancelledAdjustments], ['voided', 'Gym left the network', 'checker', 0]);
  assert.ok(out.statement.voidedAt);

  // Final: no step works on it, and it can't be voided twice.
  for (const stepName of ['submit', 'approve', 'markPayable', 'voidStatement']) {
    assert.equal((await workflow[stepName]({ id: s.id, reason: 'again', actorId: 'other' })).error, 'invalid_status', stepName);
  }
  // Its visits stay settled: a later run does not pay them again.
  const again = await services(trx, '2027-01-02T09:00:00.000Z').settlement.run({ ...DECEMBER, mode: 'live', actorId: 'admin-1' });
  assert.equal(again.stats.settledCycles, 0);
  const audit = await trx('AuditLog').where({ target: s.id, action: 'settlement_voided' }).first();
  assert.equal(audit.actor, 'checker');
}));

test('void: allowed from draft, submitted and approved; a payable statement must be held first; a paid one is final', () => inRollback(async (trx) => {
  const w = await world(trx);
  const m = await memberCycle(trx);
  await visits(trx, m, w.gymD, 4);
  await visits(trx, m, w.gymC, 4, { firstDay: 10 });
  const { settlement, workflow } = services(trx);
  await settlement.run({ ...NOVEMBER, mode: 'live', actorId: 'admin-1' });
  const d = await statementOf(trx, w.gymD, NOVEMBER);
  const c = await statementOf(trx, w.gymC, NOVEMBER);

  await workflow.submit({ id: d.id, actorId: 'maker' });
  await workflow.approve({ id: d.id, actorId: 'checker' });
  await workflow.markPayable({ id: d.id, actorId: 'payer' });
  assert.deepEqual(await workflow.voidStatement({ id: d.id, reason: 'Stop', actorId: 'checker' }), { error: 'invalid_status', status: 409, currentStatus: 'payable', expected: 'draft|submitted|approved' });
  await workflow.hold({ id: d.id, reason: 'Stop payment', actorId: 'maker' });   // payable → approved
  assert.equal((await workflow.voidStatement({ id: d.id, reason: 'Stop', actorId: 'checker' })).statement.status, 'voided');

  await pay(workflow, c.id);
  assert.equal((await workflow.voidStatement({ id: c.id, reason: 'Too late', actorId: 'checker' })).error, 'invalid_status');
  // A shadow statement is never part of the workflow.
  const shadow = await settlement.run({ ...DECEMBER, mode: 'shadow', actorId: 'admin-1' });
  assert.equal(shadow.error, undefined);
}));

test('void: a carried-forward shortfall on the voided statement is carried again by the next one', () => inRollback(async (trx) => {
  const w = await world(trx);
  const { settlement, workflow } = services(trx);
  const oct = await memberCycle(trx, { month: 10 });
  await visits(trx, oct, w.gymC, 1);                       // November statement: one daily rate, 7,500
  await settlement.run({ ...NOVEMBER, mode: 'live', actorId: 'admin-1' });
  const nov = await statementOf(trx, w.gymC, NOVEMBER);
  const a = (await workflow.proposeAdjustment({ statementId: nov.id, amountTzs: -20000, type: 'clawback', reason: 'Older visits voided', actorId: 'maker' })).adjustment;
  await workflow.decideAdjustment({ id: a.id, decision: 'apply', actorId: 'checker' });
  const novSubmitted = (await workflow.submit({ id: nov.id, actorId: 'maker' })).statement;
  const owed = novSubmitted.carryForwardTzs;
  assert.ok(owed < 0);

  const later = services(trx, '2027-01-02T09:00:00.000Z');
  const nv = await memberCycle(trx, { month: 11 });
  await visits(trx, nv, w.gymC, 5);
  await later.settlement.run({ ...DECEMBER, mode: 'live', actorId: 'admin-1' });
  const dec = await statementOf(trx, w.gymC, DECEMBER);
  await later.workflow.submit({ id: dec.id, actorId: 'maker' });
  assert.equal((await adjustmentsOn(trx, dec.id)).filter((x) => x.type === 'carry_forward' && x.status === 'applied').length, 1);

  // December is voided: its carry-forward is cancelled with it …
  const voided = await later.workflow.voidStatement({ id: dec.id, reason: 'Recalculate', actorId: 'checker' });
  assert.equal(voided.cancelledAdjustments, 1);
  assert.deepEqual((await adjustmentsOn(trx, dec.id)).map((x) => x.status), ['voided']);

  // … so January takes November's shortfall instead.
  const jan = services(trx, '2027-02-02T09:00:00.000Z');
  const dc = await memberCycle(trx, { month: 12 });
  await visits(trx, dc, w.gymC, 5);
  await jan.settlement.run({ ...periodForMonth('2027-01'), mode: 'live', actorId: 'admin-1' });
  const january = await statementOf(trx, w.gymC, periodForMonth('2027-01'));
  const submitted = (await jan.workflow.submit({ id: january.id, actorId: 'maker' })).statement;
  assert.equal(submitted.adjustmentsTzs, owed);
}));

// ── clawback after a voided check-in ─────────────────────────────────────────

/** Example 7 settled and paid for November: gym D × 15 (monthly), gym C × 5 (weekly), cap applied. */
async function paidExample7(trx) {
  const w = await world(trx);
  const m = await memberCycle(trx);
  const atD = await visits(trx, m, w.gymD, 15);
  const atC = await visits(trx, m, w.gymC, 5, { firstDay: 16 });
  const s = services(trx);
  await s.settlement.run({ ...NOVEMBER, mode: 'live', actorId: 'admin-1' });
  const d = await statementOf(trx, w.gymD, NOVEMBER);
  const c = await statementOf(trx, w.gymC, NOVEMBER);
  assert.deepEqual([d.finalNetTzs, c.finalNetTzs], [161638, 25862]);
  return { w, m, atD, atC, d, c, ...s };
}

/** December statements for both gyms (another member, 5 visits each). */
async function december(trx, w) {
  const s = services(trx, '2027-01-02T09:00:00.000Z');
  const m = await memberCycle(trx, { month: 11 });
  await visits(trx, m, w.gymD, 5);
  await visits(trx, m, w.gymC, 5, { firstDay: 10 });
  await s.settlement.run({ ...DECEMBER, mode: 'live', actorId: 'admin-1' });
  return { ...s, d: await statementOf(trx, w.gymD, DECEMBER), c: await statementOf(trx, w.gymC, DECEMBER) };
}

test('clawback: a visit voided after payment re-prices the whole line, and the shared cap moves the other gym up', () => inRollback(async (trx) => {
  const x = await paidExample7(trx);
  await pay(x.workflow, x.d.id);
  await pay(x.workflow, x.c.id);
  const dec = await december(trx, x.w);

  // 15 visits (monthly, 175,000) become 14 (two weeks at the 50,000 ceiling,
  // 100,000). With gym C's 28,000 the member is under the 187,500 cap, so C
  // gets its full amount.
  await voidCheckin(trx, x.atD[14].id);
  const out = await dec.clawback.sweep({ checkinId: x.atD[14].id });
  assert.deepEqual(out.raised.map((r) => [r.gymId, r.type, r.amountTzs]).sort(), [[x.w.gymC, 'correction', 28000 - 25862], [x.w.gymD, 'clawback', 100000 - 161638]].sort());
  assert.deepEqual([out.pending, out.held, out.skipped], [[], [], []]);

  const [onD] = await adjustmentsOn(trx, dec.d.id);
  assert.deepEqual([onD.status, onD.type, onD.amountTzs, onD.createdBy, onD.sourceCheckinId, onD.sourceSettlementId, onD.reason],
    ['proposed', 'clawback', -61638, 'voider', x.atD[14].id, x.d.id, 'Visit on 2026-10-15 voided after settlement']);
  // Nothing has changed yet, and the statement can't be submitted past it.
  assert.equal((await trx('GymSettlement').where({ id: dec.d.id }).first()).adjustmentsTzs, 0);
  assert.equal((await dec.workflow.submit({ id: dec.d.id, actorId: 'maker' })).error, 'pending_adjustments');
  // The person who voided the visit can't apply their own clawback.
  assert.equal((await dec.workflow.decideAdjustment({ id: onD.id, decision: 'apply', actorId: 'voider' })).error, 'cannot_approve_own_adjustment');
  const applied = await dec.workflow.decideAdjustment({ id: onD.id, decision: 'apply', actorId: 'checker' });
  assert.equal(applied.statement.adjustmentsTzs, -61638);

  // Safe to repeat: nothing more is raised, applied or not.
  assert.deepEqual((await dec.clawback.sweep()).raised, []);
  assert.equal((await adjustmentsOn(trx, dec.c.id)).length, 1);
  assert.equal((await trx('AuditLog').where({ action: 'settlement_clawback_raised' }).whereIn('target', [onD.id])).length, 1);
}));

test('clawback: a second void raises only the further difference; a rejected clawback is not raised again', () => inRollback(async (trx) => {
  const x = await paidExample7(trx);
  await pay(x.workflow, x.d.id);
  await pay(x.workflow, x.c.id);
  const dec = await december(trx, x.w);

  await voidCheckin(trx, x.atD[14].id);
  await dec.clawback.sweep();
  const [first] = await adjustmentsOn(trx, dec.d.id);
  await dec.workflow.decideAdjustment({ id: first.id, decision: 'reject', reason: 'Gym showed proof of the visit', actorId: 'checker' });
  assert.deepEqual((await dec.clawback.sweep()).raised, []);

  // Seven more voided: 14 visits (two weeks, 100,000) become 7 (one week, 50,000).
  for (const c of x.atD.slice(7, 14)) await voidCheckin(trx, c.id);
  const out = await dec.clawback.sweep();
  assert.deepEqual(out.raised.map((r) => [r.gymId, r.amountTzs]), [[x.w.gymD, 50000 - 100000]]);
}));

test('clawback: with no draft statement the difference waits, and is raised when the gym gets one', () => inRollback(async (trx) => {
  const x = await paidExample7(trx);
  await pay(x.workflow, x.d.id);
  await pay(x.workflow, x.c.id);
  await voidCheckin(trx, x.atC[0].id);   // gym C: 5 visits (weekly 28,000) → 4 (still weekly): no change at C

  // C's line is unchanged, so D's share of the cap is unchanged too.
  assert.deepEqual(await x.clawback.sweep(), { raised: [], pending: [], held: [], skipped: [] });

  await voidCheckin(trx, x.atD[0].id);
  const waiting = await x.clawback.sweep({ dryRun: true });
  assert.deepEqual(waiting.pending.map((p) => [p.gymId, p.amountTzs]).sort(), [[x.w.gymC, 2138], [x.w.gymD, -61638]].sort());
  assert.deepEqual((await x.clawback.sweep()).raised, []);
  assert.equal((await trx('SettlementAdjustment').whereIn('gymSettlementId', [x.d.id, x.c.id])).length, 0);

  const dec = await december(trx, x.w);
  const out = await dec.clawback.sweep();
  assert.deepEqual(out.raised.map((r) => [r.gymSettlementId, r.amountTzs]).sort(), [[dec.c.id, 2138], [dec.d.id, -61638]].sort());
  assert.deepEqual(out.pending, []);
}));

test('clawback: a draft statement takes it directly; a submitted one is put on hold; a voided one is left alone', () => inRollback(async (trx) => {
  const x = await paidExample7(trx);
  // D is still a draft; C has been submitted.
  await x.workflow.submit({ id: x.c.id, actorId: 'maker' });
  await voidCheckin(trx, x.atC[0].id);
  await voidCheckin(trx, x.atC[1].id);   // gym C: 5 visits (weekly) → 3 (3 × daily 7,500 = 22,500)
  const out = await x.clawback.sweep({ actorId: 'admin-9' });

  // C's own statement is frozen: held, and the clawback waits for a draft.
  assert.deepEqual(out.held, [x.c.id]);
  const held = await trx('GymSettlement').where({ id: x.c.id }).first();
  assert.deepEqual([held.status, held.holdReason], ['submitted', 'A visit on this statement was voided after it was submitted']);
  assert.equal(out.pending.length, 1);
  assert.equal(out.pending[0].gymId, x.w.gymC);
  assert.ok(out.pending[0].amountTzs < 0);
  // D (a draft) gets its larger share of the cap on the same statement.
  assert.deepEqual(out.raised.map((r) => [r.gymSettlementId, r.type]), [[x.d.id, 'correction']]);

  // Sent back to draft, C's statement takes its own clawback.
  await x.workflow.reject({ id: x.c.id, reason: 'Visits voided', actorId: 'checker' });
  const after = await x.clawback.sweep();
  assert.deepEqual(after.raised.map((r) => [r.gymSettlementId, r.type]), [[x.c.id, 'clawback']]);
  assert.deepEqual(after.held, []);

  // A voided statement was never paid: nothing is clawed back from it.
  await inVoided(trx, x);
}));

async function inVoided(trx, x) {
  const d = await trx('GymSettlement').where({ id: x.d.id }).first();
  assert.equal(d.status, 'draft');
  const voided = await x.workflow.voidStatement({ id: x.d.id, reason: 'Gym left', actorId: 'checker' });
  assert.equal(voided.cancelledAdjustments, 1);
  await voidCheckin(trx, x.atD[0].id);
  const out = await x.clawback.sweep();
  assert.equal(out.raised.filter((r) => r.gymId === x.w.gymD).length + out.pending.filter((p) => p.gymId === x.w.gymD).length, 0);
}

test('clawback: a cycle with a disputed visit waits for a decision; amounts that no longer reproduce are never guessed', () => inRollback(async (trx) => {
  const x = await paidExample7(trx);
  await pay(x.workflow, x.d.id);
  await pay(x.workflow, x.c.id);
  await voidCheckin(trx, x.atD[14].id);
  await trx('Checkin').where({ id: x.atD[13].id }).update({ status: 'disputed', statusReason: 'Member denies it' });
  assert.deepEqual((await x.clawback.sweep()).skipped.map((s) => s.reason), ['held_visits']);

  await trx('Checkin').where({ id: x.atD[13].id }).update({ status: 'valid' });
  // The stored inputs no longer give the amount that was paid (a check-in was edited behind the engine's back).
  await trx('Checkin').where({ id: x.atD[0].id }).update({ visitConsumed: false });
  const out = await x.clawback.sweep();
  assert.deepEqual([out.raised, out.pending, out.skipped.map((s) => s.reason)], [[], [], ['cannot_reproduce']]);
}));

test('the database accepts a voided adjustment and remembers the member cycle', () => inRollback(async (trx) => {
  const x = await paidExample7(trx);
  const id = uid('adj');
  await trx('SettlementAdjustment').insert({ id, gymSettlementId: x.d.id, amountTzs: -100, type: 'clawback', reason: 'r', status: 'voided', createdBy: 'maker', sourceMemberCycleSettlementId: 'mcs_1' });
  assert.equal((await trx('SettlementAdjustment').where({ id }).first()).sourceMemberCycleSettlementId, 'mcs_1');
  await assert.rejects(trx.transaction((t) => t('SettlementAdjustment').insert({ id: uid('adj'), gymSettlementId: x.d.id, amountTzs: -100, type: 'clawback', reason: 'r', status: 'cancelled', createdBy: 'maker' })), (err) => err.code === '23514');
}));
