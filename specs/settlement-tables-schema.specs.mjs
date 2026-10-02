// Settlement tables (settlement Phase 2, PR 3) against the CI database: the
// Phase 1 engine's output maps onto the tables without loss, and the database
// refuses what must never happen — a check-in paid twice, two live statements
// for one gym and period, rows of mixed modes or runs, amounts that don't add
// up, edits to a locked run or a frozen statement, a workflow step out of
// order, a payout against a shadow statement.
//
// Every database test runs in a transaction that is rolled back.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, collection } from '../src/infra/knex-store.mjs';
import { calculateMemberSettlement } from '../src/shared/settlement-engine.mjs';
import { resolveGymRateSnapshot } from '../src/shared/settlement-config.mjs';
import { settlementRowsFromResult, gymStatementTotals, statementNet } from '../src/shared/settlement-rows.mjs';
import { RATE_CARDS, cycleFor, dailyVisits } from './fixtures/settlement-dar.mjs';

const ROLLBACK = Symbol('rollback');
const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;

async function inRollback(fn) {
  try {
    await db.transaction(async (trx) => { await fn(trx); throw ROLLBACK; });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
}

async function rejects(trx, fn, code) {
  await assert.rejects(trx.transaction(fn), (err) => err.code === code, `expected Postgres error ${code}`);
}

const snap = (gymId) => resolveGymRateSnapshot({ rateCards: RATE_CARDS, gymId, date: '2026-10-01' }).snapshot;

/** Example 7 of the spec: Premium member, D × 15 + C × 5, cap binds. */
function example7(prefix = uid('m')) {
  const visits = [...dailyVisits('gym-D', 15, { prefix: `${prefix}-D` }), ...dailyVisits('gym-C', 5, { firstDay: 16, prefix: `${prefix}-C` })];
  return calculateMemberSettlement({ cycle: cycleFor('premium'), visits, gymRates: [snap('gym-C'), snap('gym-D')] });
}

async function makeRun(trx, { mode = 'live', start = '2026-11-01', end = '2026-12-01', status = 'draft' } = {}) {
  const run = { id: uid('run'), mode, periodStartDate: start, periodEndDate: end, status: 'draft', engineVersion: 'settlement-engine/1', createdBy: 'system' };
  await trx('SettlementRun').insert(run);
  if (status !== 'draft') await lock(trx, run, status);
  return run;
}

async function lock(trx, run, status = 'locked') {
  await trx('SettlementRun').where({ id: run.id }).update({ status, lockedAt: new Date(), lockedBy: 'system', inputsHash: 'sha256:test' });
  run.status = status;
}

async function makeStatement(trx, run, gymId, extra = {}) {
  const row = { id: uid('gs'), runId: run.id, mode: run.mode, gymId, periodStartDate: run.periodStartDate, periodEndDate: run.periodEndDate, ...extra };
  await trx('GymSettlement').insert(row);
  return row;
}

/** Store one member settlement: statements per gym, then the mapped rows. */
async function store(trx, run, result, statements = new Map()) {
  for (const g of result.gyms) {
    if (!statements.has(g.gymId)) statements.set(g.gymId, await makeStatement(trx, run, g.gymId));
  }
  const rows = settlementRowsFromResult(result, {
    runId: run.id, mode: run.mode, newId: () => uid('row'),
    gymSettlementIdFor: (gymId) => statements.get(gymId).id,
    terms: { passTierVersion: 1, catalogPriceTzs: 250000 },
  });
  const json = (o, fields) => ({ ...o, ...Object.fromEntries(fields.map((f) => [f, o[f] == null ? null : JSON.stringify(o[f])])) });
  await trx('MemberCycleSettlement').insert(json(rows.memberCycle, ['explanation']));
  await trx('GymSettlementLine').insert(rows.lines.map((l) => json(l, ['rateCardSnapshot', 'calculationBasis'])));
  await trx('SettlementVisit').insert(rows.visits);
  return { rows, statements };
}

// ── pure helpers ─────────────────────────────────────────────────────────────

describe('statement arithmetic (DR-20)', () => {
  test('the net is never negative; a shortfall is carried forward', () => {
    assert.deepEqual(statementNet({ preliminaryTzs: 40000, networkAdjustmentTzs: -5000, adjustmentsTzs: -10000 }), { finalNetTzs: 25000, carryForwardTzs: 0 });
    assert.deepEqual(statementNet({ preliminaryTzs: 12000, networkAdjustmentTzs: 0, adjustmentsTzs: -20000 }), { finalNetTzs: 0, carryForwardTzs: -8000 });
  });
  test('statement totals add up the lines', () => {
    const r = example7();
    const rows = settlementRowsFromResult(r, { runId: 'run', mode: 'shadow', newId: (() => { let i = 0; return () => `id${i++}`; })(), gymSettlementIdFor: (g) => `gs-${g}` });
    const d = gymStatementTotals(rows.lines.filter((l) => l.gymId === 'gym-D'));
    assert.deepEqual(d, { memberCycleCount: 1, qualifyingVisitCount: 15, heldVisitCount: 0, preliminaryTzs: 175000,
      networkAdjustmentTzs: -13362, adjustmentsTzs: 0, finalNetTzs: 161638, carryForwardTzs: 0 });
    assert.equal(rows.visits.length, 20);
    assert.ok(rows.visits.every((v) => v.lineId === rows.lines.find((l) => l.gymId === v.gymId).id));
  });
});

// ── mapping round-trip ───────────────────────────────────────────────────────

test('the engine\'s result round-trips through the tables without loss', () => inRollback(async (trx) => {
  const run = await makeRun(trx);
  const result = example7();
  const { rows } = await store(trx, run, result);

  const mcs = await trx('MemberCycleSettlement').where({ id: rows.memberCycle.id }).first();
  assert.deepEqual(
    [mcs.networkCapTzs, mcs.totalPreliminaryTzs, mcs.totalFinalTzs, mcs.networkAdjustmentTzs, mcs.capApplied, mcs.payableVisitCount],
    [187500, 203000, 187500, -15500, true, 20]);
  assert.equal(new Date(mcs.cycleStart).toISOString(), result.member.cycleStart);
  assert.equal(mcs.explanation.finalizableAt, result.member.finalizableAt);

  const lines = await trx('GymSettlementLine').where({ memberCycleSettlementId: mcs.id }).orderBy('gymId');
  assert.deepEqual(lines.map((l) => [l.gymId, l.bracket, l.preliminaryTzs, l.finalTzs, l.networkAdjustmentTzs]),
    [['gym-C', 'weekly', 28000, 25862, -2138], ['gym-D', 'monthly', 175000, 161638, -13362]]);
  for (const l of lines) {
    const g = result.gyms.find((x) => x.gymId === l.gymId);
    assert.deepEqual(l.rateCardSnapshot, JSON.parse(JSON.stringify(g.rateCardSnapshot)));
    assert.deepEqual(l.calculationBasis, g.calculationBasis);
  }
  const visits = await trx('SettlementVisit').where({ memberCycleSettlementId: mcs.id });
  assert.equal(visits.length, 20);
  assert.ok(visits.every((v) => v.outcome === 'payable' && v.lineId));
}));

test('the read-only collections see what the writer stored (store wiring)', async () => {
  const run = { id: uid('run'), mode: 'shadow', periodStartDate: '2026-11-01', periodEndDate: '2026-12-01', engineVersion: 'settlement-engine/1',
    configurationSnapshot: { rules: ['rule-global-1'] } };
  const runs = collection('settlement_runs');
  await runs.insertAsync(run);
  try {
    const back = await runs.findByIdAsync(run.id);
    assert.equal(back.periodStartDate, '2026-11-01');
    assert.deepEqual(back.configurationSnapshot, { rules: ['rule-global-1'] });
    assert.equal(back.status, 'draft');
  } finally {
    await db('SettlementRun').where({ id: run.id }).del();   // a draft run may be deleted
  }
});

// ── never paid twice ─────────────────────────────────────────────────────────

test('a check-in can be payable in only one live run; shadow runs never collide', () => inRollback(async (trx) => {
  const prefix = uid('m');
  const first = await makeRun(trx, { start: '2026-11-01', end: '2026-12-01' });
  const { rows } = await store(trx, first, example7(prefix));
  const checkinId = rows.visits[0].checkinId;

  const second = await makeRun(trx, { start: '2026-12-01', end: '2027-01-01' });
  const mcs2 = { ...rows.memberCycle, id: uid('mcs'), runId: second.id, subscriptionId: uid('sub'), explanation: null };
  await trx('MemberCycleSettlement').insert(mcs2);
  const gs2 = await makeStatement(trx, second, 'gym-D');
  const line2 = { ...rows.lines.find((l) => l.gymId === 'gym-D'), id: uid('line'), runId: second.id, gymSettlementId: gs2.id,
    memberCycleSettlementId: mcs2.id, rateCardSnapshot: null, calculationBasis: null };
  await trx('GymSettlementLine').insert(line2);
  const visit = { id: uid('v'), runId: second.id, mode: 'live', memberCycleSettlementId: mcs2.id, lineId: line2.id, checkinId,
    gymId: 'gym-D', outcome: 'payable', eligibility: 'eligible' };
  await rejects(trx, (t) => t('SettlementVisit').insert(visit), '23505');
  // Considering it again as excluded or held is fine; so is a shadow run.
  await trx('SettlementVisit').insert({ ...visit, id: uid('v'), outcome: 'excluded', eligibility: 'duplicate_same_day', lineId: null });
  const shadow = await makeRun(trx, { mode: 'shadow' });
  await store(trx, shadow, example7(prefix));
  // Released from the first run (its statement voided), it may be paid again.
  await trx('SettlementVisit').where({ runId: first.id, checkinId }).update({ active: false });
  const third = await makeRun(trx, { start: '2027-01-01', end: '2027-02-01' });
  const mcs3 = { ...mcs2, id: uid('mcs'), runId: third.id, subscriptionId: uid('sub') };
  await trx('MemberCycleSettlement').insert(mcs3);
  const gs3 = await makeStatement(trx, third, 'gym-D');
  const line3 = { ...line2, id: uid('line'), runId: third.id, gymSettlementId: gs3.id, memberCycleSettlementId: mcs3.id };
  await trx('GymSettlementLine').insert(line3);
  await trx('SettlementVisit').insert({ ...visit, id: uid('v'), runId: third.id, memberCycleSettlementId: mcs3.id, lineId: line3.id });
}));

test('one live run per period, one live statement per gym and period, one live settlement per member cycle', () => inRollback(async (trx) => {
  const run = await makeRun(trx, { start: '2027-03-01', end: '2027-04-01' });
  await rejects(trx, (t) => t('SettlementRun').insert({ id: uid('run'), mode: 'live', periodStartDate: '2027-03-01', periodEndDate: '2027-04-01', engineVersion: 'x' }), '23505');
  await trx('SettlementRun').insert({ id: uid('run'), mode: 'shadow', periodStartDate: '2027-03-01', periodEndDate: '2027-04-01', engineVersion: 'x' });

  const gs = await makeStatement(trx, run, 'gym-A');
  await rejects(trx, (t) => t('GymSettlement').insert({ id: uid('gs'), runId: run.id, mode: 'live', gymId: 'gym-A', periodStartDate: '2027-03-01', periodEndDate: '2027-04-01' }), '23505');
  await trx('GymSettlement').where({ id: gs.id }).update({ status: 'voided', voidedAt: new Date(), voidedBy: 'admin', voidReason: 'recalculated' });
  await makeStatement(trx, run, 'gym-A');   // a voided statement frees the period

  const { rows } = await store(trx, run, example7());
  await rejects(trx, (t) => t('MemberCycleSettlement').insert({ ...rows.memberCycle, id: uid('mcs'), explanation: null }), '23505');
}));

// ── consistency and arithmetic ───────────────────────────────────────────────

test('rows share their run\'s mode, and a line belongs to a statement and cycle of its own run', () => inRollback(async (trx) => {
  const live = await makeRun(trx);
  const other = await makeRun(trx, { start: '2027-05-01', end: '2027-06-01' });
  const { rows } = await store(trx, live, example7());
  await rejects(trx, (t) => t('GymSettlement').insert({ id: uid('gs'), runId: live.id, mode: 'shadow', gymId: 'gym-Q', periodStartDate: '2026-11-01', periodEndDate: '2026-12-01' }), '23503');
  const otherStatement = await makeStatement(trx, other, 'gym-D');
  const line = { ...rows.lines[0], id: uid('line'), gymId: 'gym-Z', gymSettlementId: otherStatement.id, rateCardSnapshot: null, calculationBasis: null };
  await rejects(trx, (t) => t('GymSettlementLine').insert(line), '23503');
}));

test('amounts must add up', () => inRollback(async (trx) => {
  const run = await makeRun(trx);
  const { rows } = await store(trx, run, example7());
  const mcs = rows.memberCycle;
  const bad = (patch) => ({ ...mcs, id: uid('mcs'), subscriptionId: uid('sub'), explanation: null, ...patch });
  await rejects(trx, (t) => t('MemberCycleSettlement').insert(bad({ totalFinalTzs: 190000, networkAdjustmentTzs: -13000 })), '23514'); // above the cap
  await rejects(trx, (t) => t('MemberCycleSettlement').insert(bad({ networkAdjustmentTzs: -1 })), '23514');                            // doesn't reconcile
  await rejects(trx, (t) => t('MemberCycleSettlement').insert(bad({ payableVisitCount: 21 })), '23514');                               // over the allowance
  await rejects(trx, (t) => t('MemberCycleSettlement').insert(bad({ collectedApprovedAmountTzs: 250000.5 })), '22P02');                // whole TZS

  const line = rows.lines[0];
  const badLine = (patch) => ({ ...line, id: uid('line'), gymId: uid('gym'), rateCardSnapshot: null, calculationBasis: null, ...patch });
  await rejects(trx, (t) => t('GymSettlementLine').insert(badLine({ finalTzs: line.preliminaryTzs + 1, networkAdjustmentTzs: 1 })), '23514');
  await rejects(trx, (t) => t('GymSettlementLine').insert(badLine({ monotonicGuardApplied: true })), '23514');
  await rejects(trx, (t) => t('GymSettlementLine').insert(badLine({ bracket: 'fortnightly' })), '23514');

  const visit = rows.visits[0];
  await rejects(trx, (t) => t('SettlementVisit').insert({ ...visit, id: uid('v'), checkinId: uid('c'), lineId: null }), '23514');           // payable needs a line
  await rejects(trx, (t) => t('SettlementVisit').insert({ ...visit, id: uid('v'), checkinId: uid('c'), eligibility: 'over_allowance' }), '23514'); // payable ⇔ eligible
  await rejects(trx, (t) => t('SettlementVisit').insert({ ...visit, id: uid('v'), checkinId: uid('c'), eligibility: 'made_up' }), '23514');

  // Statements: net never negative, shortfall carried forward.
  const s = (patch) => ({ id: uid('gs'), runId: run.id, mode: 'live', gymId: uid('gym'), periodStartDate: '2026-11-01', periodEndDate: '2026-12-01', ...patch });
  await rejects(trx, (t) => t('GymSettlement').insert(s({ preliminaryTzs: 12000, adjustmentsTzs: -20000, finalNetTzs: -8000, carryForwardTzs: 0 })), '23514');
  await trx('GymSettlement').insert(s({ preliminaryTzs: 12000, adjustmentsTzs: -20000, finalNetTzs: 0, carryForwardTzs: -8000 }));
  await rejects(trx, (t) => t('GymSettlement').insert(s({ preliminaryTzs: 10000, networkAdjustmentTzs: 1, finalNetTzs: 10001 })), '23514');
}));

// ── locking and the statement workflow ───────────────────────────────────────

test('a locked run is read-only; its visits can only be released', () => inRollback(async (trx) => {
  const run = await makeRun(trx);
  const { rows } = await store(trx, run, example7());
  await lock(trx, run);
  await rejects(trx, (t) => t('GymSettlementLine').where({ id: rows.lines[0].id }).update({ finalTzs: 1 }), 'P0001');
  await rejects(trx, (t) => t('MemberCycleSettlement').where({ id: rows.memberCycle.id }).update({ totalFinalTzs: 1 }), 'P0001');
  await rejects(trx, (t) => t('SettlementVisit').where({ id: rows.visits[0].id }).update({ outcome: 'held', eligibility: 'disputed' }), 'P0001');
  await rejects(trx, (t) => t('SettlementVisit').insert({ ...rows.visits[0], id: uid('v'), checkinId: uid('c') }), 'P0001');
  await rejects(trx, (t) => t('GymSettlement').insert({ id: uid('gs'), runId: run.id, mode: 'live', gymId: 'gym-Q', periodStartDate: '2026-11-01', periodEndDate: '2026-12-01' }), 'P0001');
  await rejects(trx, (t) => t('SettlementRun').where({ id: run.id }).update({ inputsHash: 'other' }), 'P0001');
  await rejects(trx, (t) => t('SettlementRun').where({ id: run.id }).del(), 'P0001');
  await trx('SettlementVisit').where({ id: rows.visits[0].id }).update({ active: false });
  await rejects(trx, (t) => t('SettlementVisit').where({ id: rows.visits[0].id }).update({ active: true }), 'P0001');
  // A locked run's draft statement keeps its amounts too.
  const gs = (await trx('GymSettlement').where({ runId: run.id }))[0];
  await rejects(trx, (t) => t('GymSettlement').where({ id: gs.id }).update({ preliminaryTzs: 1, finalNetTzs: 1 }), 'P0001');
}));

test('a statement moves only along the workflow, freezes once submitted, and a paid one is final', () => inRollback(async (trx) => {
  const run = await makeRun(trx);
  const gs = await makeStatement(trx, run, 'gym-A', { preliminaryTzs: 40000, finalNetTzs: 40000 });
  const move = (patch) => trx('GymSettlement').where({ id: gs.id }).update(patch);
  await rejects(trx, (t) => t('GymSettlement').insert({ id: uid('gs'), runId: run.id, mode: 'live', gymId: 'gym-B', periodStartDate: '2026-11-01', periodEndDate: '2026-12-01', status: 'approved' }), 'P0001');
  await rejects(trx, (t) => t('GymSettlement').where({ id: gs.id }).update({ status: 'paid', paidAt: new Date(), paidBy: 'p', paymentReference: 'r', approvedBy: 'a' }), 'P0001');
  await move({ status: 'submitted', submittedBy: 'maker', submittedAt: new Date() });
  await rejects(trx, (t) => t('GymSettlement').where({ id: gs.id }).update({ preliminaryTzs: 50000, finalNetTzs: 50000 }), 'P0001');
  await rejects(trx, (t) => t('GymSettlement').where({ id: gs.id }).update({ status: 'approved', approvedBy: 'maker', approvedAt: new Date() }), '23514');
  await move({ status: 'approved', approvedBy: 'checker', approvedAt: new Date() });
  await rejects(trx, (t) => t('GymSettlement').where({ id: gs.id }).update({ status: 'payable' }), '23514');   // needs the payout destination it was cleared for
  await move({ status: 'payable', destinationSnapshot: JSON.stringify({ kind: 'verified_account', accountLast4: '5678' }) });
  await rejects(trx, (t) => t('GymSettlement').where({ id: gs.id }).update({ status: 'paid', paidAt: new Date(), paidBy: 'payer' }), '23514'); // needs a reference
  await move({ status: 'paid', paidAt: new Date(), paidBy: 'payer', paymentReference: 'MPESA-123' });
  await rejects(trx, (t) => t('GymSettlement').where({ id: gs.id }).update({ receiptUrl: 'x' }), 'P0001');
  await rejects(trx, (t) => t('GymSettlement').where({ id: gs.id }).del(), 'P0001');
}));

// ── payouts and adjustments ──────────────────────────────────────────────────

test('a payout can only point at a live statement, once', () => inRollback(async (trx) => {
  const gymId = uid('gym');
  await trx('Gym').insert({ id: gymId, name: 'Payout Gym', tier: 'standard', location: 'Dar', updatedAt: new Date() });
  const live = await makeStatement(trx, await makeRun(trx), gymId);
  const shadow = await makeStatement(trx, await makeRun(trx, { mode: 'shadow' }), gymId);
  const payout = (gs, patch = {}) => ({ id: uid('po'), gymId, amount: 1000, status: 'paid', gymSettlementId: gs.id, gymSettlementMode: gs.mode, ...patch });
  await rejects(trx, (t) => t('GymPayout').insert(payout(shadow)), '23514');
  await rejects(trx, (t) => t('GymPayout').insert(payout(shadow, { gymSettlementMode: 'live' })), '23503');
  await trx('GymPayout').insert(payout(live));
  await rejects(trx, (t) => t('GymPayout').insert(payout(live)), '23505');
  await trx('GymPayout').insert(payout(live, { status: 'failed' }));   // a failed attempt doesn't block
  await trx('GymPayout').insert({ id: uid('po'), gymId, amount: 500, status: 'paid' });   // legacy invoice payouts unchanged
}));

test('adjustments are signed, never zero, clawbacks negative, approved by someone else', () => inRollback(async (trx) => {
  const gs = await makeStatement(trx, await makeRun(trx), 'gym-A');
  const adj = (patch) => ({ id: uid('adj'), gymSettlementId: gs.id, amountTzs: -3500, type: 'clawback', reason: 'Visit voided after payment', createdBy: 'maker', ...patch });
  await trx('SettlementAdjustment').insert(adj());
  await trx('SettlementAdjustment').insert(adj({ type: 'correction', amountTzs: 2000 }));
  await rejects(trx, (t) => t('SettlementAdjustment').insert(adj({ amountTzs: 0 })), '23514');
  await rejects(trx, (t) => t('SettlementAdjustment').insert(adj({ amountTzs: 3500 })), '23514');
  await rejects(trx, (t) => t('SettlementAdjustment').insert(adj({ status: 'approved', approvedBy: 'maker', approvedAt: new Date() })), '23514');
  await rejects(trx, (t) => t('SettlementAdjustment').insert(adj({ status: 'approved' })), '23514');
  await trx('SettlementAdjustment').insert(adj({ status: 'approved', approvedBy: 'checker', approvedAt: new Date() }));
}));
