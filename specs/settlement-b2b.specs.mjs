// Two fixes that affect gym settlement (decided 1 Oct 2026):
//
// 1. Company-funded (B2B) gym visits are settled to gyms: the same brackets
//    and network cap as a member's own pass, per beneficiary per EAT month.
// 2. A pass's visit count and its "already visited today" rule look only at
//    that pass's own check-ins, so a company-funded visit (or a visit on
//    another membership) no longer uses up a pass visit or makes a pass visit
//    elsewhere that day an unpaid "second gym".
//
// Database tests run in a transaction that is rolled back.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { createCheckInService } from '../src/services/check-in-service.mjs';
import { fundedBySubscription } from '../src/shared/check-in-rules.mjs';
import { calculateMemberSettlement, VISIT_ELIGIBILITY, VISIT_OUTCOME, SETTLEABLE_SUBSCRIPTION_TYPES } from '../src/shared/settlement-engine.mjs';
import { createSettlementConfigService } from '../src/services/settlement-config-service.mjs';
import { createSettlementService, periodForMonth, b2bCycleKey } from '../src/services/settlement-service.mjs';
import { ceilingSnapshot } from './fixtures/settlement-dar.mjs';

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;

// ── fix 2: a pass counts only its own visits ────────────────────────────────

const mkCol = (initial = []) => {
  const rows = [...initial];
  return {
    rows, find: (f) => rows.find(f),
    findByIdAsync: async (id) => rows.find((r) => r.id === id) ?? null,
    filterAsync: async (f) => rows.filter(f),
    insertAsync: async (row) => { rows.push(row); return row; },
  };
};

describe('a pass counts only its own check-ins', () => {
  const at = (h) => new Date(`2026-10-05T${String(h).padStart(2, '0')}:00:00.000Z`);
  const b2bVisit = (gymId, hour = 5) => ({ id: uid('c'), memberId: 'm1', gymId, timestamp: at(hour).toISOString(), subscriptionType: 'b2b_benefit', subscriptionId: null, visitConsumed: false, status: 'valid' });
  const setup = ({ tier = 'pro', existing = [] } = {}) => {
    const checkins = mkCol(existing);
    const svc = createCheckInService({
      users: mkCol([{ id: 'm1', userType: 'member' }]),
      gyms: mkCol([{ id: 'g1', tier: 'standard' }, { id: 'g2', tier: 'standard' }]),
      subscriptions: mkCol([{ id: 'pass-1', memberId: 'm1', type: 'platform_pass', tier, status: 'active', startedAt: '2026-10-01T07:00:00Z', cycleStartedAt: '2026-10-01T07:00:00Z', expiresAt: '2099-01-01T00:00:00Z' }]),
      checkins,
    });
    return { checkins, svc };
  };

  test('the rule: by subscription link, else by type; untyped legacy rows count', () => {
    const own = fundedBySubscription({ id: 'pass-1', type: 'platform_pass' });
    assert.equal(own({ subscriptionId: 'pass-1', subscriptionType: 'platform_pass' }), true);
    assert.equal(own({ subscriptionId: 'direct-9', subscriptionType: 'direct_sub' }), false);
    assert.equal(own({ subscriptionId: null, subscriptionType: 'b2b_benefit' }), false);
    assert.equal(own({ subscriptionId: null, subscriptionType: 'platform_pass' }), true);   // before the link existed
    assert.equal(own({}), true);
    assert.equal(fundedBySubscription(null)({ subscriptionId: 'pass-1' }), false);
  });

  test('a company-funded visit in the morning does not make a pass visit elsewhere an unpaid second gym', async () => {
    const { svc } = setup({ existing: [b2bVisit('g1')] });
    const r = await svc.perform({ memberId: 'm1', gymId: 'g2', now: at(12) });
    assert.equal(r.ok, true);
    assert.equal(r.checkin.subscriptionType, 'platform_pass');
    assert.equal(r.checkin.visitConsumed, true);     // was false: the gym would not have been paid
    assert.equal(r.checkin.visitNumberInCycle, 1);   // the B2B visit used no pass visit
  });

  test('a Basic pass is not blocked from its one gym a day by a company-funded visit at another gym', async () => {
    const { svc } = setup({ tier: 'basic', existing: [b2bVisit('g1')] });
    const r = await svc.perform({ memberId: 'm1', gymId: 'g2', now: at(12) });
    assert.equal(r.ok, true);
    assert.equal(r.checkin.visitConsumed, true);
  });

  test('a visit on another membership (a direct plan) does not use a pass visit', async () => {
    const direct = { id: uid('c'), memberId: 'm1', gymId: 'g1', timestamp: '2026-10-03T09:00:00.000Z', subscriptionType: 'direct_sub', subscriptionId: 'direct-9', visitConsumed: true };
    const { svc } = setup({ existing: [direct] });
    const r = await svc.perform({ memberId: 'm1', gymId: 'g2', now: at(12) });
    assert.equal(r.checkin.visitNumberInCycle, 1);
  });

  test('two gyms on one day on the same pass: the second is still not consumed (unchanged)', async () => {
    const { svc } = setup();
    const first = await svc.perform({ memberId: 'm1', gymId: 'g1', now: at(6) });
    const second = await svc.perform({ memberId: 'm1', gymId: 'g2', now: at(12) });
    assert.equal(first.checkin.visitConsumed, true);
    assert.equal(second.checkin.visitConsumed, false);
  });
});

// ── fix 1: the engine settles a B2B cycle ───────────────────────────────────

describe('the engine settles company-funded visits with the same brackets and cap', () => {
  const visit = (id, gymId, day, hour = 12, type = 'b2b_benefit') => ({
    checkinId: id, memberId: 'emp-1', cycleId: 'b2b:ben-1:2026-10', gymId, status: 'valid', visitConsumed: true, subscriptionType: type,
    timestamp: new Date(Date.UTC(2026, 9, day, hour)).toISOString(),
  });
  const cycle = (extra = {}) => ({
    memberId: 'emp-1', cycleId: 'b2b:ben-1:2026-10', subscriptionType: 'b2b_benefit', passTier: 'b2b_benefit',
    cycleStart: '2026-09-30T21:00:00.000Z', cycleEnd: '2026-10-31T21:00:00.000Z',   // October in EAT
    collectedApprovedAmountTzs: 100000, networkPayoutBps: 7500, visitAllowance: 100, oneGymPerDay: false, ...extra,
  });
  const rates = [ceilingSnapshot('gym-A', 'standard'), ceilingSnapshot('gym-B', 'standard')];

  test('both pass and company-funded visits are settleable types', () => {
    assert.deepEqual([...SETTLEABLE_SUBSCRIPTION_TYPES], ['platform_pass', 'b2b_benefit']);
  });
  test('the brackets are the same: 5 visits at one gym earn one weekly rate', () => {
    const r = calculateMemberSettlement({ cycle: cycle(), visits: [1, 2, 3, 4, 5].map((d) => visit(`v${d}`, 'gym-A', d)), gymRates: rates });
    assert.equal(r.gyms[0].bracket, 'weekly');
    assert.equal(r.gyms[0].finalTzs, 12000);
    assert.equal(r.member.settleable, true);
  });
  test('two gyms on one day both count (each visit was charged on its own)', () => {
    const r = calculateMemberSettlement({ cycle: cycle(), visits: [visit('a', 'gym-A', 5, 6), visit('b', 'gym-B', 5, 15)], gymRates: rates });
    assert.equal(r.member.payableVisitCount, 2);
    assert.deepEqual(r.gyms.map((g) => [g.gymId, g.finalTzs]), [['gym-A', 3500], ['gym-B', 3500]]);
    // …while a pass cycle still pays one gym a day.
    const pass = calculateMemberSettlement({
      cycle: cycle({ subscriptionType: 'platform_pass', oneGymPerDay: undefined }),
      visits: [visit('a', 'gym-A', 5, 6, 'platform_pass'), visit('b', 'gym-B', 5, 15, 'platform_pass')], gymRates: rates });
    assert.equal(pass.visits[1].eligibility, VISIT_ELIGIBILITY.SECOND_GYM_SAME_DAY);
  });
  test('the cap is 75% of what was charged for the visits, shared by payout', () => {
    // 8 visits at each gym: 24,000 + 24,000 preliminary against 75% of 40,000 charged.
    const visits = [...Array(8)].flatMap((_, i) => [visit(`a${i}`, 'gym-A', i + 1, 6), visit(`b${i}`, 'gym-B', i + 1, 15)]);
    const r = calculateMemberSettlement({ cycle: cycle({ collectedApprovedAmountTzs: 40000 }), visits, gymRates: rates });
    assert.equal(r.member.networkCapTzs, 30000);
    assert.deepEqual(r.gyms.map((g) => g.finalTzs), [15000, 15000]);
  });
  test('a cycle only settles visits of its own type', () => {
    const r = calculateMemberSettlement({ cycle: cycle(), visits: [visit('p', 'gym-A', 5, 12, 'platform_pass'), visit('b', 'gym-A', 6)], gymRates: rates });
    assert.deepEqual(r.visits.map((v) => [v.checkinId, v.outcome]), [['p', VISIT_OUTCOME.EXCLUDED], ['b', VISIT_OUTCOME.PAYABLE]]);
    assert.equal(r.visits[0].eligibility, VISIT_ELIGIBILITY.WRONG_SUBSCRIPTION_TYPE);
  });
});

// ── fix 1: the settlement service, from real rows ───────────────────────────

const ROLLBACK = Symbol('rollback');
async function inRollback(fn) {
  try {
    await db.transaction(async (trx) => { await fn(trx); throw ROLLBACK; });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
}

function settlementFor(trx, at = '2026-12-02T09:00:00.000Z') {
  const configService = createSettlementConfigService({ db: trx, now: () => new Date('2026-09-01T09:00:00.000Z') });
  return { configService, settlement: createSettlementService({ db: trx, configService, now: () => new Date(at), logger: { error() {} } }) };
}

/** Two standard gyms with approved rate cards (retail 5,000 / 15,000 / 50,000), and a sponsor with a gym benefit. */
async function world(trx) {
  await trx('Subscription').update({ status: 'payment_cancelled' });
  await trx('B2BBenefitConsumption').whereIn('status', ['approved', 'pending']).update({ status: 'cancelled' });
  const { configService } = settlementFor(trx);
  const gym = async () => {
    const id = uid('gym');
    await trx('Gym').insert({ id, name: 'B2B Gym', tier: 'standard', location: 'Dar es Salaam', ratePerDay: 5000, updatedAt: new Date() });
    const card = (await configService.createRateCard({ gymId: id, retailDailyTzs: 5000, retailWeeklyTzs: 15000, retailMonthlyTzs: 50000, actorId: 'maker' }, { trx })).rateCard;
    assert.ok((await configService.activate({ kind: 'rate_card', id: card.id, effectiveFrom: '2026-10-01', actorId: 'checker' }, { trx })).rateCard);
    return id;
  };
  const organizationId = uid('org');
  const programId = uid('prog');
  const benefitId = uid('ben');
  await trx('B2BOrganization').insert({ id: organizationId, organizationType: 'employer', legalName: 'Acme Ltd' });
  await trx('B2BWellnessProgram').insert({ id: programId, organizationId, name: 'Wellness 2026', startDate: '2026-01-01', eligibility: '{}' });
  await trx('B2BBenefit').insert({ id: benefitId, programId, name: 'Gym access', benefitType: 'gym_access', fundingType: 'full', usagePeriod: 'unlimited', providerRules: '{}' });
  return { gymA: await gym(), gymB: await gym(), organizationId, programId, benefitId };
}

async function employee(trx) {
  const userId = uid('usr');
  await trx('User').insert({ id: userId, userType: 'member', displayName: 'B2B Employee', updatedAt: new Date() });
  return { userId, beneficiaryId: uid('bnf') };
}

/** A company-funded visit: the check-in as the check-in service writes it, plus its approved ledger row. */
async function b2bVisit(trx, w, e, gymId, day, { hour = 12, month = 10, consumption = 'approved', checkin = {} } = {}) {
  const timestamp = new Date(Date.UTC(2026, month - 1, day, hour));
  const businessDate = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const checkinId = uid('chk');
  await trx('Checkin').insert({
    id: checkinId, memberId: e.userId, gymId, timestamp, method: 'gym_scanned', subscriptionType: 'b2b_benefit', passTier: null, visitNumberInCycle: null,
    gymTier: 'standard', creditsDeductedTzs: 0, visitConsumed: false, status: 'valid', subscriptionId: null, businessDate, source: 'member_qr_by_staff', ...checkin,
  });
  await trx('B2BBenefitConsumption').insert({
    id: uid('con'), organizationId: w.organizationId, programId: w.programId, benefitId: w.benefitId, beneficiaryId: e.beneficiaryId, beneficiarySource: 'b2b_beneficiary',
    userId: e.userId, sourceType: 'gym_checkin', sourceId: checkinId, serviceType: 'gym_access', providerType: 'gym', providerId: gymId,
    consumedAt: timestamp, businessDate, unitValueTzs: 5000, grossTzs: 5000, sponsorTzs: 5000, beneficiaryTzs: 0, status: consumption,
    verifiedAt: ['approved', 'reversed'].includes(consumption) ? timestamp : null,
    ...(consumption === 'reversed' ? { reversedAt: timestamp, reversedBy: 'admin-1', reversalReason: 'check-in voided' } : {}),
  });
  return checkinId;
}

const NOVEMBER = periodForMonth('2026-11');

test('a month of company-funded visits is settled to the gyms with the pass brackets', () => inRollback(async (trx) => {
  const w = await world(trx);
  const e = await employee(trx);
  for (let d = 1; d <= 5; d++) await b2bVisit(trx, w, e, w.gymA, d);        // 5 visits → one weekly rate
  for (let d = 10; d <= 11; d++) await b2bVisit(trx, w, e, w.gymB, d);      // 2 visits → 2 × daily
  const { settlement } = settlementFor(trx);
  const out = await settlement.run({ ...NOVEMBER, mode: 'live' });

  assert.deepEqual(out.stats, { candidateCycles: 1, settledCycles: 1, skippedCycles: 0, statements: 2, b2bCycles: 1, payableVisits: 7, totalPreliminaryTzs: 19000, totalFinalTzs: 19000 });
  const mcs = await trx('MemberCycleSettlement').where({ runId: out.run.id }).first();
  assert.deepEqual([mcs.fundingType, mcs.subscriptionId, mcs.memberId, mcs.collectedApprovedAmountTzs, mcs.networkCapTzs, mcs.totalFinalTzs],
    ['b2b_benefit', b2bCycleKey(e.beneficiaryId, '2026-10'), e.userId, 35000, 26250, 19000]);
  assert.deepEqual(mcs.explanation.b2b, { beneficiaryId: e.beneficiaryId, month: '2026-10', organizationIds: [w.organizationId], sponsorTzs: 35000, beneficiaryTzs: 0 });
  const statements = Object.fromEntries((await trx('GymSettlement').where({ runId: out.run.id })).map((s) => [s.gymId, s.finalNetTzs]));
  assert.deepEqual(statements, { [w.gymA]: 12000, [w.gymB]: 7000 });
  assert.equal((await trx('SettlementVisit').where({ runId: out.run.id, outcome: 'payable' })).length, 7);

  // Settled once: the next month's run doesn't take October again.
  const { settlement: later } = settlementFor(trx, '2027-01-05T09:00:00.000Z');
  assert.equal((await later.run({ ...periodForMonth('2026-12'), mode: 'live' })).stats.candidateCycles, 0);
}));

test('the cap binds on what was charged: a heavy month is shared between gyms by payout', () => inRollback(async (trx) => {
  const w = await world(trx);
  const e = await employee(trx);
  for (let d = 1; d <= 15; d++) await b2bVisit(trx, w, e, w.gymA, d, { hour: 6 });    // monthly 40,000
  for (let d = 1; d <= 8; d++) await b2bVisit(trx, w, e, w.gymB, d, { hour: 15 });    // same days, second gym: 2 × weekly 24,000
  const { settlement } = settlementFor(trx);
  const out = await settlement.run({ ...NOVEMBER, mode: 'live' });
  // 23 visits charged 115,000 → cap 86,250; preliminary 64,000 is under it.
  assert.equal(out.stats.payableVisits, 23);
  assert.equal(out.stats.totalFinalTzs, 64000);
  const mcs = await trx('MemberCycleSettlement').where({ runId: out.run.id }).first();
  assert.deepEqual([mcs.networkCapTzs, mcs.capApplied], [86250, false]);
}));

test('pass and company-funded visits at the same gym land on one statement, as separate lines', () => inRollback(async (trx) => {
  const w = await world(trx);
  const e = await employee(trx);
  for (let d = 1; d <= 2; d++) await b2bVisit(trx, w, e, w.gymA, d);
  // The same person's own Premium pass, used at the same gym on other days.
  const subscriptionId = uid('sub');
  await trx('Subscription').insert({ id: subscriptionId, memberId: e.userId, type: 'platform_pass', tier: 'premium', status: 'expired',
    startedAt: new Date('2026-10-01T07:00:00Z'), cycleStartedAt: new Date('2026-10-01T07:00:00Z'), renewsAt: new Date('2026-10-31T07:00:00Z'), expiresAt: new Date('2026-10-31T07:00:00Z') });
  await trx('PaymentRequest').insert({ id: uid('pay'), memberId: e.userId, subscriptionId, tier: 'premium', amountTzs: 250000, status: 'approved', provider: 'admin_approved', requestedAt: new Date('2026-10-01T06:00:00Z') });
  await trx('Checkin').insert([10, 11, 12].map((d) => ({
    id: uid('chk'), memberId: e.userId, gymId: w.gymA, timestamp: new Date(Date.UTC(2026, 9, d, 12)), method: 'gym_scanned', subscriptionType: 'platform_pass', passTier: 'premium',
    gymTier: 'standard', creditsDeductedTzs: 0, visitConsumed: true, status: 'valid', subscriptionId, businessDate: `2026-10-${d}`, source: 'member_qr_by_staff',
  })));
  const { settlement } = settlementFor(trx);
  const out = await settlement.run({ ...NOVEMBER, mode: 'live' });
  assert.deepEqual([out.stats.settledCycles, out.stats.b2bCycles, out.stats.statements], [2, 1, 1]);
  const statement = await trx('GymSettlement').where({ runId: out.run.id, gymId: w.gymA }).first();
  assert.deepEqual([statement.memberCycleCount, statement.qualifyingVisitCount, statement.finalNetTzs], [2, 5, 17500]);   // 3 × 3,500 + 2 × 3,500
  const funding = (await trx('MemberCycleSettlement').where({ runId: out.run.id })).map((m) => m.fundingType).sort();
  assert.deepEqual(funding, ['b2b_benefit', 'platform_pass']);
}));

test('only approved consumptions of finished months are settled; a disputed visit holds the month', () => inRollback(async (trx) => {
  const w = await world(trx);
  const reversed = await employee(trx);
  await b2bVisit(trx, w, reversed, w.gymA, 3, { consumption: 'reversed' });       // voided visit: allowance given back
  await b2bVisit(trx, w, reversed, w.gymA, 4, { consumption: 'pending' });        // never confirmed
  const notFinal = await employee(trx);
  await b2bVisit(trx, w, notFinal, w.gymA, 20, { month: 11 });                    // November is not final in the November run
  const disputed = await employee(trx);
  const id = await b2bVisit(trx, w, disputed, w.gymA, 5);
  await b2bVisit(trx, w, disputed, w.gymA, 6);
  await trx('Checkin').where({ id }).update({ status: 'disputed', statusReason: 'Employee says they were not there' });

  const { settlement } = settlementFor(trx);
  const out = await settlement.run({ ...NOVEMBER, mode: 'live' });
  assert.equal(out.stats.settledCycles, 0);
  assert.deepEqual(out.exceptions, [{ subscriptionId: b2bCycleKey(disputed.beneficiaryId, '2026-10'), memberId: disputed.userId, reason: 'held_visits', held: { disputed: 1 } }]);

  // November becomes final for the December run.
  const { settlement: later } = settlementFor(trx, '2027-01-05T09:00:00.000Z');
  const december = await later.run({ ...periodForMonth('2026-12'), mode: 'shadow' });
  assert.ok(december.exceptions.some((x) => x.reason === 'held_visits'));
  assert.equal(december.stats.b2bCycles, 1);   // notFinal's November
}));
