// Settlement service (settlement Phase 3) against the CI database: finished
// Platform Pass cycles become stored, locked settlements; nothing is settled
// twice, part-settled, or settled on a guess.
//
// Every database test runs inside a transaction that is rolled back (a locked
// run can't be deleted, by design). The services are built on that
// transaction, so they see only their own test's data plus the seeds.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { createSettlementConfigService } from '../src/services/settlement-config-service.mjs';
import { createSettlementService, periodForMonth, previousMonth, SETTLEMENT_LOCK_KEY } from '../src/services/settlement-service.mjs';
import { createFinanceService } from '../src/services/finance-service.mjs';

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

/** Services bound to the test's transaction, with a fixed clock. */
function services(trx, at = '2026-12-02T09:00:00.000Z') {
  const configService = createSettlementConfigService({ db: trx, now: () => new Date('2026-09-01T09:00:00.000Z') });
  const settlement = createSettlementService({ db: trx, configService, now: () => new Date(at), logger: { error() {} } });
  return { configService, settlement };
}

/**
 * The approved Dar configuration (active from 1 Oct 2026, by migration), plus
 * a mid-tier gym C and a premium gym D with approved rate cards (the spec's
 * illustrative rates).
 */
async function world(trx) {
  // Other specs leave subscriptions behind in the shared CI database; take
  // them out of play for this (rolled-back) transaction.
  await trx('Subscription').update({ status: 'payment_cancelled' });
  await trx('B2BBenefitConsumption').whereIn('status', ['approved', 'pending']).update({ status: 'cancelled' });
  const { configService } = services(trx);
  const activate = (kind, id) => configService.activate({ kind, id, effectiveFrom: '2026-10-01', actorId: 'checker' }, { trx });
  const gym = async (tier, retail) => {
    const id = uid(`gym${tier[0]}`);
    await trx('Gym').insert({ id, name: `Settlement ${tier}`, tier, location: 'Dar es Salaam', updatedAt: new Date() });
    const card = (await configService.createRateCard({ gymId: id, ...retail, actorId: 'maker' }, { trx })).rateCard;
    assert.ok((await activate('rate_card', card.id)).rateCard);
    return id;
  };
  return {
    gymC: await gym('midtier', { retailDailyTzs: 10000, retailWeeklyTzs: 35000, retailMonthlyTzs: 120000 }),
    gymD: await gym('premium', { retailDailyTzs: 20000, retailWeeklyTzs: 70000, retailMonthlyTzs: 250000 }),
  };
}

/** A member with one 30-day Platform Pass cycle from 1 Oct 2026 10:00 EAT. */
async function memberCycle(trx, { tier = 'premium', paid = 250000, paymentStatus = 'approved', type = 'platform_pass', status = 'expired' } = {}) {
  const memberId = uid('usr');
  const subscriptionId = uid('sub');
  await trx('User').insert({ id: memberId, userType: 'member', displayName: 'Settlement Member', updatedAt: new Date() });
  await trx('Subscription').insert({
    id: subscriptionId, memberId, type, tier, status,
    startedAt: new Date('2026-10-01T07:00:00Z'), cycleStartedAt: new Date('2026-10-01T07:00:00Z'),
    renewsAt: new Date('2026-10-31T07:00:00Z'), expiresAt: new Date('2026-10-31T07:00:00Z'),
  });
  if (paid != null) {
    await trx('PaymentRequest').insert({ id: uid('pay'), memberId, subscriptionId, tier, amountTzs: paid, status: paymentStatus, provider: 'admin_approved', requestedAt: new Date('2026-10-01T06:00:00Z') });
  }
  return { memberId, subscriptionId, type };
}

/** One valid, consumed check-in a day at 15:00 EAT from `firstDay` October. */
async function visits(trx, m, gymId, count, { firstDay = 1, ...extra } = {}) {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: uid('chk'), memberId: m.memberId, gymId, timestamp: new Date(Date.UTC(2026, 9, firstDay + i, 12)),
    method: 'gym_scanned', subscriptionType: m.type, passTier: 'premium', visitNumberInCycle: firstDay + i, gymTier: 'premium',
    creditsDeductedTzs: 0, visitConsumed: true, status: 'valid', subscriptionId: m.subscriptionId,
    businessDate: `2026-10-${String(firstDay + i).padStart(2, '0')}`, source: 'member_qr_by_staff', ...extra,
  }));
  await trx('Checkin').insert(rows);
  return rows;
}

/** The spec's Example 7: Premium member, gym D × 15 then gym C × 5. */
async function example7(trx, w) {
  const m = await memberCycle(trx);
  await visits(trx, m, w.gymD, 15);
  await visits(trx, m, w.gymC, 5, { firstDay: 16 });
  return m;
}

// ── periods ──────────────────────────────────────────────────────────────────

describe('periods are EAT months', () => {
  test('a month is [first day, first day of the next month)', () => {
    assert.deepEqual(periodForMonth('2026-11'), { periodStartDate: '2026-11-01', periodEndDate: '2026-12-01' });
    assert.deepEqual(periodForMonth('2026-12'), { periodStartDate: '2026-12-01', periodEndDate: '2027-01-01' });
    assert.equal(periodForMonth('2026-13'), null);
    assert.equal(periodForMonth('Nov 2026'), null);
  });
  test('the previous month is taken in EAT, not UTC', () => {
    assert.equal(previousMonth(new Date('2026-11-30T20:59:00Z')), '2026-10');   // 23:59 EAT 30 Nov
    assert.equal(previousMonth(new Date('2026-11-30T21:00:00Z')), '2026-11');   // 00:00 EAT 1 Dec
    assert.equal(previousMonth(new Date('2027-01-15T09:00:00Z')), '2026-12');
  });
});

// ── the run ──────────────────────────────────────────────────────────────────

test('a finished cycle becomes a locked settlement: member cycle, statements, lines and visits', () => inRollback(async (trx) => {
  const w = await world(trx);
  const m = await example7(trx, w);
  const { settlement } = services(trx);
  const out = await settlement.run({ ...NOVEMBER, mode: 'live', actorId: 'admin-1' });

  assert.equal(out.run.status, 'locked');
  assert.match(out.run.inputsHash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(out.stats, { candidateCycles: 1, settledCycles: 1, skippedCycles: 0, statements: 2, b2bCycles: 0, payableVisits: 20, totalPreliminaryTzs: 203000, totalFinalTzs: 187500 });
  assert.deepEqual(out.exceptions, []);

  const mcs = await trx('MemberCycleSettlement').where({ runId: out.run.id }).first();
  assert.deepEqual([mcs.subscriptionId, mcs.collectedApprovedAmountTzs, mcs.networkCapTzs, mcs.totalFinalTzs, mcs.visitAllowance, mcs.catalogPriceTzs, mcs.passTierVersion],
    [m.subscriptionId, 250000, 187500, 187500, 20, 250000, 1]);

  const statements = Object.fromEntries((await trx('GymSettlement').where({ runId: out.run.id })).map((s) => [s.gymId, s]));
  assert.deepEqual([statements[w.gymD].preliminaryTzs, statements[w.gymD].networkAdjustmentTzs, statements[w.gymD].finalNetTzs, statements[w.gymD].qualifyingVisitCount, statements[w.gymD].status],
    [175000, -13362, 161638, 15, 'draft']);
  assert.deepEqual([statements[w.gymC].preliminaryTzs, statements[w.gymC].finalNetTzs, statements[w.gymC].memberCycleCount], [28000, 25862, 1]);
  assert.equal(statements[w.gymD].periodStartDate, '2026-11-01');

  const line = await trx('GymSettlementLine').where({ gymSettlementId: statements[w.gymD].id }).first();
  assert.equal(line.bracket, 'monthly');
  assert.equal(line.rateCardSnapshot.wholesaleMonthlyTzs, 175000);
  assert.equal((await trx('SettlementVisit').where({ runId: out.run.id, outcome: 'payable' })).length, 20);

  const detail = await settlement.getStatement(statements[w.gymD].id);
  assert.equal(detail.lines.length, 1);
  assert.equal(detail.visits.length, 15);
  assert.equal((await settlement.getRun(out.run.id)).statements.length, 2);
  assert.equal((await settlement.getRun('nope')).error, 'run_not_found');
}));

test('a cycle is settled once: the same month again is a no-op, and later months don\'t take it again', () => inRollback(async (trx) => {
  const w = await world(trx);
  await example7(trx, w);
  const { settlement } = services(trx, '2027-01-05T09:00:00.000Z');
  const first = await settlement.run({ ...NOVEMBER, mode: 'live' });
  const again = await settlement.run({ ...NOVEMBER, mode: 'live' });
  assert.equal(again.alreadyRun, true);
  assert.equal(again.run.id, first.run.id);
  const next = await settlement.run({ ...DECEMBER, mode: 'live' });
  assert.equal(next.stats.candidateCycles, 0);
  assert.equal((await trx('MemberCycleSettlement').where({ mode: 'live' }).whereIn('runId', [first.run.id, next.run.id])).length, 1);
}));

test('a cycle waits for its dispute window: it isn\'t in the month it ends, only the month it becomes final', () => inRollback(async (trx) => {
  const w = await world(trx);
  await example7(trx, w);   // ends 31 Oct; final 8 Nov (end + 24 h + 7 days)
  const { settlement } = services(trx);
  const october = await settlement.run({ ...periodForMonth('2026-10'), mode: 'live' });
  assert.equal(october.stats.candidateCycles, 0);
  const november = await settlement.run({ ...NOVEMBER, mode: 'live' });
  assert.equal(november.stats.settledCycles, 1);
}));

test('shadow runs store the same numbers, never block a live run, and can repeat', () => inRollback(async (trx) => {
  const w = await world(trx);
  await example7(trx, w);
  const { settlement } = services(trx);
  const shadow = await settlement.run({ ...NOVEMBER, mode: 'shadow' });
  const shadow2 = await settlement.run({ ...NOVEMBER, mode: 'shadow' });
  const live = await settlement.run({ ...NOVEMBER, mode: 'live' });
  assert.equal(shadow.stats.totalFinalTzs, 187500);
  assert.notEqual(shadow2.run.id, shadow.run.id);
  assert.equal(shadow2.run.inputsHash, shadow.run.inputsHash);   // same inputs, same hash
  assert.equal(live.stats.totalFinalTzs, 187500);
  assert.equal(live.run.inputsHash, shadow.run.inputsHash);
  // After the live run the cycle is settled, so a new shadow run has nothing left to preview.
  assert.equal((await settlement.run({ ...NOVEMBER, mode: 'shadow' })).stats.candidateCycles, 0);
}));

// ── what is skipped, and why ─────────────────────────────────────────────────

test('a cycle with no approved payment is skipped, then settled once the payment is approved', () => inRollback(async (trx) => {
  const w = await world(trx);
  const m = await memberCycle(trx, { paymentStatus: 'pending' });
  await visits(trx, m, w.gymD, 5);
  const { settlement } = services(trx, '2027-01-05T09:00:00.000Z');
  const first = await settlement.run({ ...NOVEMBER, mode: 'live' });
  assert.deepEqual(first.exceptions, [{ subscriptionId: m.subscriptionId, memberId: m.memberId, reason: 'no_approved_payment' }]);
  assert.equal(first.stats.settledCycles, 0);
  assert.equal(first.run.configurationSnapshot.exceptions[0].reason, 'no_approved_payment');

  await trx('PaymentRequest').where({ subscriptionId: m.subscriptionId }).update({ status: 'approved' });
  const next = await settlement.run({ ...DECEMBER, mode: 'live' });   // picked up by the next run
  assert.equal(next.stats.settledCycles, 1);
  assert.equal(next.stats.totalFinalTzs, 50000);
}));

test('a disputed visit or a gym with no rate card holds the whole cycle: nothing is part-settled', () => inRollback(async (trx) => {
  const w = await world(trx);
  const disputed = await memberCycle(trx);
  const rows = await visits(trx, disputed, w.gymD, 5);
  await trx('Checkin').where({ id: rows[0].id }).update({ status: 'disputed', statusReason: 'Member says they were not there' });

  const noCard = await memberCycle(trx);
  const bareGym = uid('gym');
  await trx('Gym').insert({ id: bareGym, name: 'No Card Gym', tier: 'premium', location: 'Dar', updatedAt: new Date() });
  await visits(trx, noCard, w.gymD, 3);
  await visits(trx, noCard, bareGym, 2, { firstDay: 10 });

  const { settlement } = services(trx);
  const out = await settlement.run({ ...NOVEMBER, mode: 'live' });
  assert.equal(out.stats.settledCycles, 0);
  const by = Object.fromEntries(out.exceptions.map((e) => [e.subscriptionId, e]));
  assert.deepEqual([by[disputed.subscriptionId].reason, by[disputed.subscriptionId].held], ['held_visits', { disputed: 1 }]);
  assert.deepEqual([by[noCard.subscriptionId].reason, by[noCard.subscriptionId].held], ['held_visits', { no_rate_card: 2 }]);
  assert.equal((await trx('GymSettlement').where({ runId: out.run.id })).length, 0);
}));

test('a voided visit is simply not paid; a cycle with no pass version in force is skipped', () => inRollback(async (trx) => {
  const w = await world(trx);
  const voided = await memberCycle(trx);
  const rows = await visits(trx, voided, w.gymD, 4);
  await trx('Checkin').where({ id: rows[0].id }).update({ status: 'voided', statusReason: 'Duplicate', voidedAt: new Date(), voidedBy: 'admin', voidReason: 'Duplicate' });
  const basic = await memberCycle(trx, { tier: 'gold', paid: 60000 });   // no such pass tier version

  const { settlement } = services(trx);
  const out = await settlement.run({ ...NOVEMBER, mode: 'live' });
  assert.equal(out.stats.settledCycles, 1);
  assert.equal(out.stats.totalFinalTzs, 36000);   // 3 visits × 12,000, not the weekly rate for 4
  assert.deepEqual(out.exceptions.map((e) => [e.subscriptionId, e.reason]), [[basic.subscriptionId, 'no_pass_tier_version']]);
  const visit = await trx('SettlementVisit').where({ runId: out.run.id, checkinId: rows[0].id }).first();
  assert.deepEqual([visit.outcome, visit.eligibility, visit.lineId], ['excluded', 'voided', null]);
}));

test('only Platform Pass cycles are settled; check-ins with no cycle link are ignored', () => inRollback(async (trx) => {
  const w = await world(trx);
  const direct = await memberCycle(trx, { type: 'direct_sub', tier: null, paid: 50000 });
  await visits(trx, direct, w.gymD, 10);
  const pending = await memberCycle(trx, { status: 'payment_pending', paymentStatus: 'pending' });   // never activated
  await visits(trx, pending, w.gymD, 3);
  const pass = await memberCycle(trx);
  await visits(trx, pass, w.gymD, 2);
  await visits(trx, pass, w.gymC, 6, { firstDay: 10, subscriptionId: null });   // recorded before check-ins carried the link

  const { settlement } = services(trx);
  const out = await settlement.run({ ...NOVEMBER, mode: 'live' });
  assert.equal(out.stats.candidateCycles, 1);
  assert.equal(out.stats.payableVisits, 2);
  assert.equal(out.stats.totalFinalTzs, 24000);
  assert.equal(out.stats.statements, 1);
}));

test('a member who used nothing still gets a (zero) settlement, so the cycle is closed', () => inRollback(async (trx) => {
  await world(trx);
  const m = await memberCycle(trx);
  const { settlement } = services(trx);
  const out = await settlement.run({ ...NOVEMBER, mode: 'live' });
  assert.equal(out.stats.settledCycles, 1);
  assert.equal(out.stats.statements, 0);
  const mcs = await trx('MemberCycleSettlement').where({ subscriptionId: m.subscriptionId }).first();
  assert.deepEqual([mcs.totalFinalTzs, mcs.networkCapTzs, mcs.payableVisitCount], [0, 187500, 0]);
}));

// ── guards ───────────────────────────────────────────────────────────────────

test('bad requests are refused before anything is stored', () => inRollback(async (trx) => {
  const { settlement } = services(trx, '2026-11-15T09:00:00.000Z');
  assert.equal((await settlement.run({ ...NOVEMBER, mode: 'real' })).error, 'invalid_mode');
  assert.equal((await settlement.run({ periodStartDate: '2026-11-01', periodEndDate: '2026-11-01', mode: 'live' })).error, 'invalid_period');
  assert.equal((await settlement.run({ periodStartDate: '1 Nov', periodEndDate: '2026-12-01', mode: 'live' })).error, 'invalid_period');
  assert.deepEqual(await settlement.run({ ...NOVEMBER, mode: 'live' }), { error: 'period_not_finished', status: 409 });   // it is still November
  assert.ok((await settlement.run({ ...NOVEMBER, mode: 'shadow' })).run, 'a shadow preview of an unfinished month is allowed');
}));

test('only one settlement run at a time: a second server stands down', async () => {
  await db.transaction(async (holder) => {
    await holder.raw('select pg_advisory_xact_lock(?)', [SETTLEMENT_LOCK_KEY]);   // another server is mid-run
    const configService = createSettlementConfigService();
    const settlement = createSettlementService({ configService, now: () => new Date('2026-12-02T09:00:00.000Z') });
    assert.deepEqual(await settlement.run({ ...NOVEMBER, mode: 'shadow' }), { skipped: 'locked' });
  });
});

test('the scheduled run settles the previous EAT month once, in SETTLEMENT_MODE, and records a JobRun', () => inRollback(async (trx) => {
  const w = await world(trx);
  await example7(trx, w);
  const { settlement } = services(trx, '2026-12-01T21:30:00.000Z');   // 00:30 EAT 2 Dec
  assert.deepEqual(await settlement.runDue({ mode: 'off' }), { skipped: 'off' });
  assert.deepEqual(await settlement.runDue({ mode: 'everything' }), { skipped: 'invalid_mode' });

  const out = await settlement.runDue({ mode: 'shadow' });
  assert.deepEqual([out.run.mode, out.run.periodStartDate, out.run.periodEndDate], ['shadow', '2026-11-01', '2026-12-01']);
  const job = await trx('JobRun').where({ id: out.run.jobRunId }).first();
  assert.deepEqual([job.job, job.status, job.stats.settledCycles], ['settlement_closer', 'ok', 1]);
  assert.equal((await settlement.runDue({ mode: 'shadow' })).alreadyRun, true);   // the next night: nothing to do
  assert.equal((await settlement.listRuns({ mode: 'shadow' })).filter((r) => r.id === out.run.id).length, 1);
}));

// ── legacy invoices are frozen ───────────────────────────────────────────────

test('the legacy distribution report no longer creates invoices when it is read', async () => {
  const mem = (rows = []) => ({ rows, allAsync: async () => rows, filter: (f) => rows.filter(f), find: (f) => rows.find(f),
    findByIdAsync: async (id) => rows.find((r) => r.id === id) ?? null, insertAsync: async (r) => { rows.push(r); return r; } });
  const invoices = mem();
  const finance = createFinanceService({
    gyms: mem([{ id: 'g1', name: 'Gym One', ratePerDay: 5000, ratePerWeek: 15000 }]),
    checkins: mem([{ id: 'c1', gymId: 'g1', memberId: 'm1', timestamp: new Date(Date.now() - 86_400_000).toISOString() }]),
    invoices, users: mem([{ id: 'm1', displayName: 'Member' }]), gymPayouts: mem(),
    settingsService: { ensureDefaultSettings: () => ({ paymentPeriodDays: 14 }) },
  });
  const periods = await finance.periodDistribution();
  assert.equal(periods[0].gyms[0].totalOwed, 5000);    // the report still shows the legacy figure
  assert.equal(periods[0].gyms[0].invoice, null);
  assert.equal(invoices.rows.length, 0);               // …but writes nothing
});
