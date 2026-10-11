// Settlement views (settlement Phase 5): what admins and gym owners see of a
// statement. An owner sees only their own gyms' live statements, and never
// the commercial rules or another member's or gym's figures.
// Database tests run in a transaction that is rolled back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { calculateMemberSettlement } from '../src/shared/settlement-engine.mjs';
import { resolveGymRateSnapshot } from '../src/shared/settlement-config.mjs';
import { settlementRowsFromResult, gymStatementTotals } from '../src/shared/settlement-rows.mjs';
import { createSettlementViewService } from '../src/services/settlement-view-service.mjs';
import { RATE_CARDS, cycleFor, dailyVisits } from './fixtures/settlement-dar.mjs';

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const ROLLBACK = Symbol('rollback');
async function inRollback(fn) {
  try {
    await db.transaction(async (trx) => { await fn(trx); throw ROLLBACK; });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
}

const snap = (gymId) => resolveGymRateSnapshot({ rateCards: RATE_CARDS, gymId, date: '2026-10-01' }).snapshot;

/**
 * The spec's Example 7 stored as a locked run: a Premium member, gym D × 15
 * and gym C × 5, cap binding. Returns the two statements and a view service.
 */
async function world(trx, { mode = 'live' } = {}) {
  const prefix = uid('m');
  const visits = [...dailyVisits('gym-D', 15, { prefix: `${prefix}-D` }), ...dailyVisits('gym-C', 5, { firstDay: 16, prefix: `${prefix}-C` })];
  const result = calculateMemberSettlement({ cycle: cycleFor('premium'), visits, gymRates: [snap('gym-C'), snap('gym-D')] });
  const run = { id: uid('run'), mode, periodStartDate: '2026-11-01', periodEndDate: '2026-12-01', status: 'draft', engineVersion: 'settlement-engine/1' };
  await trx('SettlementRun').insert(run);
  const ids = { 'gym-C': uid('gs'), 'gym-D': uid('gs') };
  for (const gymId of Object.keys(ids)) await trx('GymSettlement').insert({ id: ids[gymId], runId: run.id, mode, gymId, periodStartDate: run.periodStartDate, periodEndDate: run.periodEndDate });
  const rows = settlementRowsFromResult(result, { runId: run.id, mode, newId: () => uid('row'), gymSettlementIdFor: (g) => ids[g] });
  const json = (o, fields) => ({ ...o, ...Object.fromEntries(fields.map((f) => [f, o[f] == null ? null : JSON.stringify(o[f])])) });
  await trx('MemberCycleSettlement').insert(json(rows.memberCycle, ['explanation']));
  await trx('GymSettlementLine').insert(rows.lines.map((l) => json(l, ['rateCardSnapshot', 'calculationBasis'])));
  await trx('SettlementVisit').insert(rows.visits);
  for (const gymId of Object.keys(ids)) await trx('GymSettlement').where({ id: ids[gymId] }).update(gymStatementTotals(rows.lines.filter((l) => l.gymId === gymId)));
  await trx('SettlementRun').where({ id: run.id }).update({ status: 'locked', lockedAt: new Date(), lockedBy: 'system', inputsHash: 'sha256:test' });

  const views = createSettlementViewService({
    db: trx,
    gyms: { find: (f) => [{ id: 'gym-C', name: 'Coco Fitness' }, { id: 'gym-D', name: 'Delta Gym' }].find(f) },
    users: { filterByColumnInAsync: async (_c, memberIds) => memberIds.filter((m) => m === 'member-1').map((id) => ({ id, displayName: 'Amina Juma', userType: 'member' })) },
    publicUserId: async () => 'FM007',
  });
  return { run, ids, views };
}

const ownerOfD = { id: 'owner-d', userType: 'gym_operator', gymIds: ['gym-D'] };

test('an owner sees their gym\'s statement: visits, their own rates, what was earned, the network adjustment and the net', () => inRollback(async (trx) => {
  const { ids, views } = await world(trx);
  const list = await views.ownerStatements({ owner: ownerOfD });
  assert.deepEqual(list.map((s) => s.id), [ids['gym-D']]);
  assert.deepEqual(list[0], {
    id: ids['gym-D'], gymId: 'gym-D', gymName: 'Delta Gym', periodStartDate: '2026-11-01', periodEndDate: '2026-12-01',
    status: 'preparing', onHold: false, members: 1, visits: 15,
    earnedTzs: 175000, networkAdjustmentTzs: -13362, adjustmentsTzs: 0, carriedForwardTzs: 0, payableTzs: 161638,
    paidAt: null, paymentReference: null, receiptUrl: null, payoutAccountLast4: null,
  });

  const detail = await views.ownerStatement({ owner: ownerOfD, id: ids['gym-D'] });
  assert.equal(detail.lines.length, 1);
  const line = detail.lines[0];
  assert.deepEqual([line.memberCode, line.funding, line.visits, line.bracket, line.earnedTzs, line.networkAdjustmentTzs, line.finalTzs],
    ['FM007', 'pass', 15, 'monthly', 175000, -13362, 161638]);
  assert.deepEqual(line.rates, { dailyTzs: 12000, weeklyTzs: 50000, monthlyTzs: 175000 });
  assert.equal(line.visitDates.length, 15);
  assert.equal(line.visitDates[0], '2026-10-01');
}));

test('an owner never sees the commercial rules, the member\'s subscription, names, or who handled the statement', () => inRollback(async (trx) => {
  const { ids, views } = await world(trx);
  await trx('GymSettlement').where({ id: ids['gym-D'] }).update({ status: 'submitted', submittedBy: 'admin-maker', submittedAt: new Date(), holdReason: 'Suspected duplicate scans at this gym', heldBy: 'admin-maker', heldAt: new Date() });
  const text = JSON.stringify(await views.ownerStatement({ owner: ownerOfD, id: ids['gym-D'] })) + JSON.stringify(await views.ownerStatements({ owner: ownerOfD }));
  for (const hidden of ['DiscountBps', 'CeilingTzs', 'networkPayoutBps', 'ruleSources', 'retailDailyTzs', 'collectedApprovedAmountTzs', 'networkCapTzs',
    'Amina Juma', 'member-1', 'admin-maker', 'Suspected duplicate', 'submittedBy', 'approvedBy', 'runId', 'calculationBasis']) {
    assert.equal(text.includes(hidden), false, hidden);
  }
  const summary = (await views.ownerStatements({ owner: ownerOfD }))[0];
  assert.deepEqual([summary.status, summary.onHold], ['in_review', true]);   // they are told it is on hold, not the internal note
}));

test('an owner sees only their own gyms; shadow and voided statements don\'t exist for them', () => inRollback(async (trx) => {
  const { ids, views } = await world(trx);
  assert.deepEqual(await views.ownerStatement({ owner: ownerOfD, id: ids['gym-C'] }), { error: 'statement_not_found', status: 404 });
  assert.deepEqual(await views.ownerStatements({ owner: ownerOfD, gymId: 'gym-C' }), []);
  assert.deepEqual(await views.ownerStatements({ owner: { id: 'nobody', userType: 'gym_operator' } }), []);
  const staff = { id: 'staff-1', userType: 'gym_staff', gymId: 'gym-C' };
  assert.deepEqual((await views.ownerStatements({ owner: staff })).map((s) => s.gymId), ['gym-C']);

  await trx('GymSettlement').where({ id: ids['gym-D'] }).update({ status: 'voided', voidedAt: new Date(), voidedBy: 'admin', voidReason: 'recalculated', voidRequestedBy: 'maker', voidRequestedAt: new Date(), voidRequestReason: 'recalculated' });
  assert.deepEqual(await views.ownerStatements({ owner: ownerOfD }), []);
  assert.equal((await views.ownerStatement({ owner: ownerOfD, id: ids['gym-D'] })).error, 'statement_not_found');

  const shadow = await world(trx, { mode: 'shadow' });
  assert.equal((await shadow.views.ownerStatement({ owner: ownerOfD, id: shadow.ids['gym-D'] })).error, 'statement_not_found');
  assert.equal((await shadow.views.ownerStatements({ owner: ownerOfD })).length, 0);
}));

test('a paid statement shows the owner when and how it was paid, and applied adjustments with their reasons', () => inRollback(async (trx) => {
  const { ids, views } = await world(trx);
  const id = ids['gym-D'];
  await trx('SettlementAdjustment').insert([
    { id: uid('adj'), gymSettlementId: id, amountTzs: -3500, type: 'clawback', reason: 'Visit voided after last month was paid', status: 'applied', createdBy: 'maker', approvedBy: 'checker', approvedAt: new Date(), appliedAt: new Date('2026-12-03T09:00:00Z') },
    { id: uid('adj'), gymSettlementId: id, amountTzs: -9000, type: 'correction', reason: 'Still being checked', status: 'proposed', createdBy: 'maker' },
  ]);
  await trx('GymSettlement').where({ id }).update({ adjustmentsTzs: -3500, finalNetTzs: 158138 });
  const move = (patch) => trx('GymSettlement').where({ id }).update(patch);
  await move({ status: 'submitted', submittedBy: 'maker', submittedAt: new Date() });
  await move({ status: 'approved', approvedBy: 'checker', approvedAt: new Date() });
  await move({ status: 'payable', payableAt: new Date(), destinationSnapshot: JSON.stringify({ kind: 'verified_account', accountLast4: '5678', accountId: 'acc-1' }) });
  assert.deepEqual((({ status, payoutAccountLast4, paymentReference }) => ({ status, payoutAccountLast4, paymentReference }))((await views.ownerStatements({ owner: ownerOfD }))[0]),
    { status: 'payment_due', payoutAccountLast4: '5678', paymentReference: null });
  await move({ status: 'paid', paidBy: 'payer', paidAt: new Date('2026-12-05T09:00:00Z'), paymentReference: 'MPESA-QK7H2L9', receiptUrl: 'https://x/r.png' });

  const detail = await views.ownerStatement({ owner: ownerOfD, id });
  assert.deepEqual([detail.statement.status, detail.statement.payableTzs, detail.statement.adjustmentsTzs, detail.statement.paymentReference, detail.statement.payoutAccountLast4, detail.statement.receiptUrl],
    ['paid', 158138, -3500, 'MPESA-QK7H2L9', '5678', 'https://x/r.png']);
  assert.equal(new Date(detail.statement.paidAt).toISOString(), '2026-12-05T09:00:00.000Z');
  assert.deepEqual(detail.adjustments.map((a) => [a.amountTzs, a.type, a.reason]), [[-3500, 'clawback', 'Visit voided after last month was paid']]);   // not the proposed one
}));

test('admins get gym and member names with a run and a statement', () => inRollback(async (trx) => {
  const { run, ids, views } = await world(trx);
  const runView = await views.adminRun(run.id);
  assert.deepEqual(runView.statements.map((s) => [s.gymId, s.gymName]), [['gym-C', 'Coco Fitness'], ['gym-D', 'Delta Gym']]);
  assert.equal((await views.adminRun('nope')).error, 'run_not_found');

  const s = await views.adminStatement(ids['gym-D']);
  assert.equal(s.statement.gymName, 'Delta Gym');
  assert.deepEqual(s.lines[0].member, { publicId: 'FM007', displayName: 'Amina Juma' });
  assert.equal(s.lines[0].fundingType, 'platform_pass');
  assert.equal(s.lines[0].rateCardSnapshot.monthlyCeilingTzs, 175000);   // admins do see the rules
  assert.equal(s.visits.length, 15);
  assert.equal((await views.adminStatement('nope')).error, 'statement_not_found');
}));

// ── owner dashboard summary ──────────────────────────────────────────────────

test('the owner dashboard shows the rates FitFlex pays, the latest statement, what is unpaid and the last payment', () => inRollback(async (trx) => {
  const { createSettlementConfigService } = await import('../src/services/settlement-config-service.mjs');
  const { createOperatorService } = await import('../src/services/operator-service.mjs');
  const gymId = uid('gym');
  await trx('Gym').insert({ id: gymId, name: 'Dashboard Gym', tier: 'standard', location: 'Dar es Salaam', updatedAt: new Date() });
  const config = createSettlementConfigService({ db: trx, now: () => new Date('2026-09-01T09:00:00Z') });
  const card = (await config.createRateCard({ gymId, retailDailyTzs: 5000, retailWeeklyTzs: 15000, retailMonthlyTzs: 50000, actorId: 'maker' }, { trx })).rateCard;
  assert.ok((await config.activate({ kind: 'rate_card', id: card.id, effectiveFrom: '2026-06-01', actorId: 'checker' }, { trx })).rateCard);

  const statement = async (start, end, amount, patch) => {
    const run = { id: uid('run'), mode: 'live', periodStartDate: start, periodEndDate: end, status: 'draft', engineVersion: 'settlement-engine/1', createdBy: 'system' };
    await trx('SettlementRun').insert(run);
    const id = uid('gs');
    await trx('GymSettlement').insert({ id, runId: run.id, mode: 'live', gymId, periodStartDate: start, periodEndDate: end, preliminaryTzs: amount, finalNetTzs: amount });
    await trx('SettlementRun').where({ id: run.id }).update({ status: 'locked', lockedAt: new Date(), lockedBy: 'system', inputsHash: 'sha256:test' });
    for (const step of patch) await trx('GymSettlement').where({ id }).update(step);
    return id;
  };
  const destination = JSON.stringify({ kind: 'verified_account', accountLast4: '4821' });
  const approved = [{ status: 'submitted', submittedBy: 'maker', submittedAt: new Date() }, { status: 'approved', approvedBy: 'checker', approvedAt: new Date() }];
  await statement('2026-07-01', '2026-08-01', 30000, [...approved, { status: 'payable', destinationSnapshot: destination },
    { status: 'paid', paidBy: 'payer', paidAt: new Date('2026-08-06T09:00:00Z'), paymentReference: 'REF-JUL' }]);
  await statement('2026-08-01', '2026-09-01', 42000, approved);
  const latest = await statement('2026-09-01', '2026-10-01', 12000, []);

  const owner = { id: 'owner-x', userType: 'gym_operator', gymIds: [gymId] };
  const views = createSettlementViewService({ db: trx, gyms: { find: (f) => [{ id: gymId, name: 'Dashboard Gym' }].find(f) }, users: {}, publicUserId: async () => null, now: () => new Date('2026-10-11T09:00:00Z') });
  const summary = await views.ownerDashboard({ owner, gymId });
  // Retail less the discount, up to the standard ceiling: what the gym is actually paid.
  assert.deepEqual(summary.rates, { dailyTzs: 3500, weeklyTzs: 12000, monthlyTzs: 40000 });
  assert.deepEqual([summary.latest.id, summary.latest.status, summary.latest.payableTzs], [latest, 'preparing', 12000]);
  assert.equal(summary.awaitingPaymentTzs, 42000);
  assert.deepEqual([summary.lastPaid.periodStartDate, summary.lastPaid.payableTzs], ['2026-07-01', 30000]);
  // Not their gym: nothing.
  assert.equal(await views.ownerDashboard({ owner: { id: 'other', gymIds: ['gym-else'] }, gymId }), null);

  // The dashboard carries it only for someone allowed to see payments, and no longer has bands or commission.
  const operator = createOperatorService({
    users: {}, subscriptions: {}, checkInService: {}, publicUserId: async () => null, settingsService: {},
    gyms: { findByIdAsync: async (id) => (id === gymId ? { id: gymId, name: 'Dashboard Gym', tier: 'standard' } : null), find: () => null },
    checkins: { allAsync: async () => [] },
    memberManagement: { getMemberStats: async () => ({ totalMembers: 0, activeToday: 0, expiringSoon: 0 }) },
    settlementSummary: (args) => views.ownerDashboard(args),
  });
  const forOwner = await operator.dashboard({ operator: owner, query: {}, includeSettlement: true });
  assert.equal(forOwner.settlement.awaitingPaymentTzs, 42000);
  assert.equal('payout' in forOwner, false);
  const forStaff = await operator.dashboard({ operator: owner, query: {} });
  assert.equal(forStaff.settlement, null);
}));
