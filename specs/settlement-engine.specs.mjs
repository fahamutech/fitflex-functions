// Gym settlement engine (Phase 1): scenario matrix, edge cases and invariants.
// Pure-function tests: no database. DR-xx = approved decision register.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateWholesaleRate, calculateWholesaleRates, bracketPayout, applyMonotonicGuard,
  calculatePreliminaryGymPayout, calculateNetworkCap, allocateNetworkCap, calculateMemberSettlement,
  VISIT_OUTCOME, VISIT_ELIGIBILITY, VISIT_BRACKET, SETTLEMENT_ENGINE_VERSION
} from '../src/shared/settlement-engine.mjs';
import { resolveGymRateSnapshot } from '../src/shared/settlement-config.mjs';
import { localDay } from '../src/shared/member-progress.mjs';
import {
  RULES, RATE_CARDS, CEILINGS, PASS_FOR_GYM_TIER, PASS_TIER_VERSIONS,
  ceilingSnapshot, cycleFor, dailyVisits, CYCLE_END
} from './fixtures/settlement-dar.mjs';

const snap = gymId => resolveGymRateSnapshot({ rateCards: RATE_CARDS, rules: RULES, gymId, date: '2026-10-01' }).snapshot;
const gymOf = (r, gymId) => r.gyms.find(g => g.gymId === gymId);
const visitOf = (r, checkinId) => r.visits.find(v => v.checkinId === checkinId);
const sum = xs => xs.reduce((s, x) => s + x, 0);

// ── wholesale rates (§2, DR-06, DR-17) ───────────────────────────────────────

describe('wholesale rate = MIN(floor(retail × (1 − discount)), ceiling)', () => {
  test('discounted retail below the ceiling: the discounted rate', () => {
    assert.equal(calculateWholesaleRate(4_000, 2_500, 3_500), 3_000);
  });
  test('discounted retail equal to the ceiling: the ceiling', () => {
    assert.equal(calculateWholesaleRate(15_000, 2_000, 12_000), 12_000);
  });
  test('discounted retail above the ceiling: the ceiling', () => {
    assert.equal(calculateWholesaleRate(20_000, 2_500, 12_000), 12_000);
  });
  test('floors to whole TZS (DR-17)', () => {
    assert.equal(calculateWholesaleRate(4_999, 2_500, 100_000), 3_749); // 3,749.25
    assert.equal(calculateWholesaleRate(1, 2_500, 100_000), 0);         // 0.75
  });
  test('the Dar gyms resolve to the expected wholesale rates', () => {
    const w = id => calculateWholesaleRates(snap(id));
    assert.deepEqual(w('gym-A'), { dailyTzs: 3_500,  weeklyTzs: 12_000, monthlyTzs: 40_000 });
    assert.deepEqual(w('gym-B'), { dailyTzs: 3_000,  weeklyTzs: 9_600,  monthlyTzs: 32_000 });
    assert.deepEqual(w('gym-C'), { dailyTzs: 7_500,  weeklyTzs: 28_000, monthlyTzs: 96_000 });
    assert.deepEqual(w('gym-D'), { dailyTzs: 12_000, weeklyTzs: 50_000, monthlyTzs: 175_000 });
    assert.deepEqual(w('gym-E'), { dailyTzs: 18_000, weeklyTzs: 75_000, monthlyTzs: 270_000 });
  });
  test('rejects fractional money and out-of-range percentages', () => {
    assert.throws(() => calculateWholesaleRate(100.5, 2_500, 1_000), TypeError);
    assert.throws(() => calculateWholesaleRate(-1, 2_500, 1_000), TypeError);
    assert.throws(() => calculateWholesaleRate(100, 10_001, 1_000), TypeError);
    assert.throws(() => calculateWholesaleRate(100, 0.25, 1_000), TypeError);  // decimals are not bps
  });
});

// ── bracket thresholds (§4, DR-12) ───────────────────────────────────────────

describe('visit bracket at every threshold (Standard ceilings)', () => {
  const rates = { dailyTzs: 3_500, weeklyTzs: 12_000, monthlyTzs: 42_000 };
  const expected = {
    0: [VISIT_BRACKET.NONE, 0], 1: [VISIT_BRACKET.DAILY, 3_500], 2: [VISIT_BRACKET.DAILY, 7_000], 3: [VISIT_BRACKET.DAILY, 10_500],
    4: [VISIT_BRACKET.WEEKLY, 12_000], 5: [VISIT_BRACKET.WEEKLY, 12_000], 6: [VISIT_BRACKET.WEEKLY, 12_000], 7: [VISIT_BRACKET.WEEKLY, 12_000],
    8: [VISIT_BRACKET.DOUBLE_WEEKLY, 24_000], 9: [VISIT_BRACKET.DOUBLE_WEEKLY, 24_000], 14: [VISIT_BRACKET.DOUBLE_WEEKLY, 24_000],
    15: [VISIT_BRACKET.MONTHLY, 42_000], 16: [VISIT_BRACKET.MONTHLY, 42_000], 18: [VISIT_BRACKET.MONTHLY, 42_000],
    20: [VISIT_BRACKET.MONTHLY, 42_000], 24: [VISIT_BRACKET.MONTHLY, 42_000], 25: [VISIT_BRACKET.MONTHLY, 42_000]
  };
  for (const [n, [bracket, amount]] of Object.entries(expected)) {
    test(`${n} visits → ${bracket} ${amount}`, () => {
      assert.deepEqual(bracketPayout(Number(n), rates), { bracket, amountTzs: amount });
    });
  }
  test('DR-12: the jumps at visits 8 and 15 are kept, not smoothed', () => {
    assert.equal(bracketPayout(8, rates).amountTzs - bracketPayout(7, rates).amountTzs, 12_000);
    assert.equal(bracketPayout(15, rates).amountTzs - bracketPayout(14, rates).amountTzs, 18_000);
  });
});

// ── monotonic guard (DR-11) ──────────────────────────────────────────────────

describe('DR-11 monotonic guard', () => {
  // Retail 5,000 / 12,000 / 20,000 at a Standard gym → wholesale 3,500 / 9,600 / 16,000:
  // raw 3 visits = 10,500 but 4 visits = 9,600; raw 15 visits = 16,000 but 14 = 19,200.
  const rates = { dailyTzs: 3_500, weeklyTzs: 9_600, monthlyTzs: 16_000 };

  test('4 visits never pay less than 3', () => {
    const g = applyMonotonicGuard(4, rates);
    assert.equal(g.rawPreliminaryTzs, 9_600);
    assert.equal(g.guardedPreliminaryTzs, 10_500);
    assert.equal(g.monotonicGuardApplied, true);
    assert.equal(g.guardSourceVisitCount, 3);
    assert.equal(g.bracket, VISIT_BRACKET.WEEKLY);   // the approved bracket is still reported
  });
  test('the guard is off where the bracket already rises', () => {
    const g = applyMonotonicGuard(8, rates);
    assert.equal(g.guardedPreliminaryTzs, 19_200);
    assert.equal(g.monotonicGuardApplied, false);
  });
  test('15+ visits never pay less than 14', () => {
    for (const n of [15, 16, 30]) {
      const g = applyMonotonicGuard(n, rates);
      assert.equal(g.rawPreliminaryTzs, 16_000);
      assert.equal(g.guardedPreliminaryTzs, 19_200);
      assert.equal(g.monotonicGuardApplied, true);
    }
  });
  test('the guard leaves Dar-ceiling gyms unchanged at every count', () => {
    for (const tier of Object.keys(CEILINGS)) {
      const r = calculateWholesaleRates(ceilingSnapshot('g', tier));
      for (let n = 0; n <= 30; n++) assert.equal(applyMonotonicGuard(n, r).monotonicGuardApplied, false, `${tier} ${n}`);
    }
  });
  test('the guard applies inside a member settlement and is reported', () => {
    const f = { ...ceilingSnapshot('gym-F', 'standard'), retailDailyTzs: 5_000, retailWeeklyTzs: 12_000, retailMonthlyTzs: 20_000 };
    const r = calculateMemberSettlement({ cycle: cycleFor('basic'), visits: dailyVisits('gym-F', 4), gymRates: [f] });
    const g = gymOf(r, 'gym-F');
    assert.equal(g.rawPreliminaryTzs, 9_600);
    assert.equal(g.preliminaryTzs, 10_500);
    assert.equal(g.monotonicGuardApplied, true);
    assert.equal(g.finalTzs, 10_500);
  });
});

// ── scenario matrix A–D: one gym, the matching pass tier (§21) ───────────────

describe('scenario matrix: single gym at each tier (ceiling rates)', () => {
  const matrix = {
    standard:         { counts: [1, 3, 4, 7, 8, 14, 15, 16, 17], allowance: 16 },
    midtier:          { counts: [1, 3, 4, 7, 8, 14, 15, 18, 19], allowance: 18 },
    premium:          { counts: [1, 3, 4, 7, 8, 14, 15, 20, 21], allowance: 20 },
    luxury_executive: { counts: [1, 3, 4, 7, 8, 14, 15, 24, 25], allowance: 24 }
  };
  for (const [tier, { counts, allowance }] of Object.entries(matrix)) {
    const c = CEILINGS[tier];
    const passTier = PASS_FOR_GYM_TIER[tier];
    for (const n of counts) {
      const payable = Math.min(n, allowance);
      const expected = payable <= 3 ? payable * c.daily : payable <= 7 ? c.weekly : payable <= 14 ? 2 * c.weekly : c.monthly;
      test(`${tier} gym, ${passTier} pass, ${n} visits → ${expected}${n > allowance ? ` (visit ${n} over the ${allowance}-visit allowance)` : ''}`, () => {
        const r = calculateMemberSettlement({ cycle: cycleFor(passTier), visits: dailyVisits('gym-X', n), gymRates: [ceilingSnapshot('gym-X', tier)] });
        const g = gymOf(r, 'gym-X');
        assert.equal(r.member.visitAllowance, allowance);
        assert.equal(g.qualifyingVisitCount, payable);
        assert.equal(g.preliminaryTzs, expected);
        assert.equal(g.finalTzs, expected);           // one gym never reaches the 75% cap
        assert.equal(r.member.capApplied, false);
        assert.equal(r.member.excludedVisitCount, n - payable);
        if (n > allowance) {
          const over = r.visits.filter(v => v.eligibility === VISIT_ELIGIBILITY.OVER_ALLOWANCE);
          assert.equal(over.length, n - allowance);
          assert.equal(over[0].allowanceSlot, allowance + 1);
        }
      });
    }
  }
});

// ── allowance (DR-01) ────────────────────────────────────────────────────────

describe('DR-01 hard allowance', () => {
  for (const { tier, allowance } of PASS_TIER_VERSIONS.map(p => ({ tier: p.tierKey, allowance: p.visitAllowance }))) {
    test(`${tier}: visit ${allowance + 1} is over the ${allowance}-visit allowance and not payable`, () => {
      const r = calculateMemberSettlement({ cycle: cycleFor(tier), visits: dailyVisits('gym-A', allowance + 1), gymRates: [snap('gym-A')] });
      assert.equal(r.member.payableVisitCount, allowance);
      const last = r.visits.at(-1);
      assert.equal(last.outcome, VISIT_OUTCOME.EXCLUDED);
      assert.equal(last.eligibility, VISIT_ELIGIBILITY.OVER_ALLOWANCE);
    });
  }
  test('the allowance counts across gyms, in visit order', () => {
    const visits = [...dailyVisits('gym-A', 10), ...dailyVisits('gym-B', 10, { firstDay: 11 })];
    const r = calculateMemberSettlement({ cycle: cycleFor('basic'), visits, gymRates: [snap('gym-A'), snap('gym-B')] });
    assert.equal(gymOf(r, 'gym-A').qualifyingVisitCount, 10);
    assert.equal(gymOf(r, 'gym-B').qualifyingVisitCount, 6);        // B's last 4 are visits 17–20
    assert.equal(r.visits.filter(v => v.eligibility === VISIT_ELIGIBILITY.OVER_ALLOWANCE).length, 4);
  });
  test('a voided visit does not use an allowance slot', () => {
    const visits = dailyVisits('gym-A', 17);
    visits[0].status = 'voided';
    const r = calculateMemberSettlement({ cycle: cycleFor('basic'), visits, gymRates: [snap('gym-A')] });
    assert.equal(r.member.payableVisitCount, 16);
    assert.equal(r.visits.filter(v => v.eligibility === VISIT_ELIGIBILITY.OVER_ALLOWANCE).length, 0);
  });
  test('a held (disputed) visit keeps its allowance slot, so resolving it can never exceed the allowance', () => {
    const visits = dailyVisits('gym-A', 17);
    visits[0].status = 'disputed';
    const r = calculateMemberSettlement({ cycle: cycleFor('basic'), visits, gymRates: [snap('gym-A')] });
    assert.equal(r.member.payableVisitCount, 15);
    assert.equal(r.member.heldVisitCount, 1);
    assert.equal(visitOf(r, 'gym-A-17').eligibility, VISIT_ELIGIBILITY.OVER_ALLOWANCE);
  });
});

// ── same EAT day (DR-13) ─────────────────────────────────────────────────────

describe('DR-13 one payable gym per member per EAT day', () => {
  const cycle = cycleFor('pro');
  const rates = [snap('gym-A'), snap('gym-C')];
  const v = (checkinId, gymId, timestamp, visitConsumed = true) =>
    ({ checkinId, memberId: 'member-1', cycleId: 'cycle-1', gymId, timestamp, status: 'valid', visitConsumed, subscriptionType: 'platform_pass' });

  test('first gym payable, second gym same day not payable, next EAT day payable', () => {
    const r = calculateMemberSettlement({ cycle, gymRates: rates, visits: [
      v('c1', 'gym-A', '2026-10-05T06:00:00.000Z'),            // 09:00 EAT 5 Oct
      v('c2', 'gym-C', '2026-10-05T15:00:00.000Z', false),     // 18:00 EAT 5 Oct (logged, not consumed)
      v('c3', 'gym-C', '2026-10-06T06:00:00.000Z')             // 09:00 EAT 6 Oct
    ] });
    assert.equal(visitOf(r, 'c1').outcome, VISIT_OUTCOME.PAYABLE);
    assert.equal(visitOf(r, 'c2').eligibility, VISIT_ELIGIBILITY.SECOND_GYM_SAME_DAY);
    assert.equal(visitOf(r, 'c3').outcome, VISIT_OUTCOME.PAYABLE);
  });
  test('the day is the EAT day, not the UTC day: 23:59 and 00:00 EAT are different days', () => {
    const r = calculateMemberSettlement({ cycle, gymRates: rates, visits: [
      v('c1', 'gym-A', '2026-10-05T20:59:00.000Z'),            // 23:59 EAT 5 Oct
      v('c2', 'gym-C', '2026-10-05T21:00:00.000Z')             // 00:00 EAT 6 Oct (same UTC day)
    ] });
    assert.equal(r.member.payableVisitCount, 2);
  });
  test('two UTC days can be one EAT day', () => {
    const r = calculateMemberSettlement({ cycle, gymRates: rates, visits: [
      v('c1', 'gym-A', '2026-10-05T21:30:00.000Z'),            // 00:30 EAT 6 Oct
      v('c2', 'gym-C', '2026-10-06T06:00:00.000Z', false)      // 09:00 EAT 6 Oct
    ] });
    assert.equal(visitOf(r, 'c2').eligibility, VISIT_ELIGIBILITY.SECOND_GYM_SAME_DAY);
    assert.equal(visitOf(r, 'c1').businessDate, '2026-10-06');
  });
  test('the same gym twice in one day counts once', () => {
    const r = calculateMemberSettlement({ cycle, gymRates: rates, visits: [
      v('c1', 'gym-A', '2026-10-05T06:00:00.000Z'), v('c2', 'gym-A', '2026-10-05T10:00:00.000Z', false)
    ] });
    assert.equal(visitOf(r, 'c2').eligibility, VISIT_ELIGIBILITY.DUPLICATE_SAME_DAY);
    assert.equal(gymOf(r, 'gym-A').qualifyingVisitCount, 1);
  });
  test('second gym is excluded even if wrongly marked consumed', () => {
    const r = calculateMemberSettlement({ cycle, gymRates: rates, visits: [
      v('c1', 'gym-A', '2026-10-05T06:00:00.000Z'), v('c2', 'gym-C', '2026-10-05T10:00:00.000Z', true)
    ] });
    assert.equal(visitOf(r, 'c2').eligibility, VISIT_ELIGIBILITY.SECOND_GYM_SAME_DAY);
  });
  test('a day whose visit was not consumed pays nothing', () => {
    const r = calculateMemberSettlement({ cycle, gymRates: rates, visits: [v('c1', 'gym-A', '2026-10-05T06:00:00.000Z', false)] });
    assert.equal(visitOf(r, 'c1').eligibility, VISIT_ELIGIBILITY.NOT_CONSUMED);
    assert.equal(r.member.totalFinalTzs, 0);
  });
});

// ── statuses (DR-14) ─────────────────────────────────────────────────────────

describe('DR-14 visit statuses', () => {
  const run = status => {
    const visits = dailyVisits('gym-A', 1, { status });
    return calculateMemberSettlement({ cycle: cycleFor('basic'), visits, gymRates: [snap('gym-A')] });
  };
  test('VALID → payable', () => {
    const r = run('valid');
    assert.equal(r.visits[0].outcome, VISIT_OUTCOME.PAYABLE);
    assert.equal(r.visits[0].eligibility, VISIT_ELIGIBILITY.ELIGIBLE);
    assert.equal(r.member.totalFinalTzs, 3_500);
  });
  test('VOIDED → excluded, never paid', () => {
    const r = run('voided');
    assert.equal(r.visits[0].outcome, VISIT_OUTCOME.EXCLUDED);
    assert.equal(r.visits[0].eligibility, VISIT_ELIGIBILITY.VOIDED);
    assert.equal(r.member.totalFinalTzs, 0);
  });
  for (const [status, reason] of [['disputed', VISIT_ELIGIBILITY.DISPUTED], ['flagged', VISIT_ELIGIBILITY.FLAGGED]]) {
    test(`${status.toUpperCase()} → held, not in the payable amount`, () => {
      const r = run(status);
      assert.equal(r.visits[0].outcome, VISIT_OUTCOME.HELD);
      assert.equal(r.visits[0].eligibility, reason);
      assert.equal(r.member.totalFinalTzs, 0);
      assert.equal(gymOf(r, 'gym-A').heldVisitCount, 1);
    });
  }
  test('a missing or unknown status is held, never silently paid', () => {
    for (const status of [undefined, null, 'pending', 'VALID']) {
      const r = run(status);
      assert.equal(r.visits[0].outcome, VISIT_OUTCOME.HELD, String(status));
      assert.equal(r.visits[0].eligibility, VISIT_ELIGIBILITY.UNKNOWN_STATUS);
    }
  });
  test('the result says when the dispute window closes: cycle end + 24 h grace + 7 days', () => {
    const r = run('valid');
    assert.equal(r.member.finalizableAt, new Date(Date.parse(CYCLE_END) + 8 * 86_400_000).toISOString());
  });
});

// ── subscription types (DR-03, DR-04, DR-19) ─────────────────────────────────

describe('DR-03 only Platform Pass visits are settled', () => {
  for (const type of ['direct_sub', 'trainer_home', 'trainer_pass', 'corporate', 'roaming_topup']) {
    test(`a ${type} check-in is excluded`, () => {
      const r = calculateMemberSettlement({ cycle: cycleFor('basic'), visits: dailyVisits('gym-A', 3, { subscriptionType: type }), gymRates: [snap('gym-A')] });
      assert.ok(r.visits.every(v => v.eligibility === VISIT_ELIGIBILITY.WRONG_SUBSCRIPTION_TYPE));
      assert.equal(r.member.totalFinalTzs, 0);
      assert.equal(r.gyms.length, 0);
    });
  }
  test('an owner-created direct subscription cycle does not enter Platform Pass settlement', () => {
    const cycle = cycleFor('basic', { subscriptionType: 'direct_sub' });
    const r = calculateMemberSettlement({ cycle, visits: dailyVisits('gym-A', 5, { subscriptionType: 'direct_sub' }), gymRates: [snap('gym-A')] });
    assert.equal(r.member.settleable, false);
    assert.equal(r.member.totalFinalTzs, 0);
    assert.equal(r.member.payableVisitCount, 0);
  });
  test('a Platform Pass check-in on a non-pass cycle is still excluded', () => {
    const cycle = cycleFor('basic', { subscriptionType: 'direct_sub' });
    const r = calculateMemberSettlement({ cycle, visits: dailyVisits('gym-A', 2), gymRates: [snap('gym-A')] });
    assert.equal(r.member.payableVisitCount, 0);
  });
});

// ── cycle assignment and 24 h grace (DR-04b, DR-15) ──────────────────────────

describe('DR-15 grace visits follow the caller\'s cycle assignment', () => {
  const graceVisit = (checkinId, timestamp, cycleId = 'cycle-1') =>
    ({ checkinId, memberId: 'member-1', cycleId, gymId: 'gym-A', timestamp, status: 'valid', visitConsumed: true, subscriptionType: 'platform_pass' });

  test('a visit 13 h after the cycle ends, assigned to it, is payable in the expiring cycle', () => {
    const r = calculateMemberSettlement({ cycle: cycleFor('basic'), gymRates: [snap('gym-A')],
      visits: [graceVisit('g1', '2026-10-31T20:00:00.000Z')] });
    assert.equal(r.visits[0].outcome, VISIT_OUTCOME.PAYABLE);
  });
  test('the same visit assigned to the next cycle is not counted here', () => {
    const r = calculateMemberSettlement({ cycle: cycleFor('basic'), gymRates: [snap('gym-A')],
      visits: [graceVisit('g1', '2026-10-31T20:00:00.000Z', 'cycle-2')] });
    assert.equal(r.visits[0].eligibility, VISIT_ELIGIBILITY.OUTSIDE_MEMBER_CYCLE);
  });
  test('an assignment beyond the 24 h grace is rejected defensively', () => {
    const r = calculateMemberSettlement({ cycle: cycleFor('basic'), gymRates: [snap('gym-A')],
      visits: [graceVisit('g1', '2026-11-01T07:00:00.000Z')] });   // exactly end + 24 h
    assert.equal(r.visits[0].eligibility, VISIT_ELIGIBILITY.OUTSIDE_MEMBER_CYCLE);
  });
  test('a visit before the cycle start is outside the cycle', () => {
    const r = calculateMemberSettlement({ cycle: cycleFor('basic'), gymRates: [snap('gym-A')],
      visits: [graceVisit('g1', '2026-10-01T06:59:59.000Z')] });
    assert.equal(r.visits[0].eligibility, VISIT_ELIGIBILITY.OUTSIDE_MEMBER_CYCLE);
  });
  test('a visit with no cycle assignment is outside the cycle', () => {
    const r = calculateMemberSettlement({ cycle: cycleFor('basic'), gymRates: [snap('gym-A')],
      visits: [graceVisit('g1', '2026-10-05T06:00:00.000Z', null)] });
    assert.equal(r.visits[0].eligibility, VISIT_ELIGIBILITY.OUTSIDE_MEMBER_CYCLE);
  });
});

// ── network cap (DR-05, DR-17) ───────────────────────────────────────────────

describe('network cap', () => {
  test('cap = floor(collected × network %): 150,000 × 75% = 112,500', () => {
    assert.equal(calculateNetworkCap(150_000, 7_500), 112_500);
    assert.equal(calculateNetworkCap(99_999, 7_500), 74_999);      // 74,999.25 floors
    assert.equal(calculateNetworkCap(0, 7_500), 0);
  });
  test('preliminary below the cap: paid in full, headroom retained', () => {
    const r = calculateMemberSettlement({ cycle: cycleFor('basic'), visits: dailyVisits('gym-A', 2), gymRates: [snap('gym-A')] });
    assert.equal(r.member.networkCapTzs, 45_000);
    assert.equal(r.member.totalFinalTzs, 7_000);
    assert.equal(r.member.capApplied, false);
    assert.equal(r.member.retainedHeadroomTzs, 38_000);
  });
  test('preliminary equal to the cap: paid in full, no allocation', () => {
    const cycle = cycleFor('basic', { collectedApprovedAmountTzs: 32_000 });   // cap 24,000
    const r = calculateMemberSettlement({ cycle, visits: dailyVisits('gym-A', 8), gymRates: [snap('gym-A')] });
    assert.equal(r.member.networkCapTzs, 24_000);
    assert.equal(r.member.totalPreliminaryTzs, 24_000);
    assert.equal(r.member.capApplied, false);
    assert.equal(r.member.networkAdjustmentTzs, 0);
  });
  test('preliminary above the cap with one gym: that gym gets exactly the cap', () => {
    const cycle = cycleFor('basic', { collectedApprovedAmountTzs: 20_000 });   // cap 15,000
    const r = calculateMemberSettlement({ cycle, visits: dailyVisits('gym-A', 8), gymRates: [snap('gym-A')] });
    const g = gymOf(r, 'gym-A');
    assert.equal(g.preliminaryTzs, 24_000);
    assert.equal(g.finalTzs, 15_000);
    assert.equal(g.networkAdjustmentTzs, -9_000);
    assert.equal(r.member.networkAdjustmentTzs, -9_000);
  });
  test('L: the cap uses the collected approved amount, not the catalogue price', () => {
    // Pro catalogue price is 150,000 (cap 112,500) but this member paid 120,000.
    const cycle = cycleFor('pro', { collectedApprovedAmountTzs: 120_000 });
    const r = calculateMemberSettlement({ cycle, visits: dailyVisits('gym-C', 15), gymRates: [snap('gym-C')] });
    assert.equal(r.member.networkCapTzs, 90_000);
    assert.equal(gymOf(r, 'gym-C').preliminaryTzs, 96_000);
    assert.equal(r.member.totalFinalTzs, 90_000);
  });
});

// ── multi-gym allocation (DR-02) ─────────────────────────────────────────────

describe('DR-02 payout-weighted allocation', () => {
  test('E1: two gyms over the cap (Premium; D × 15 + C × 5)', () => {
    const visits = [...dailyVisits('gym-D', 15), ...dailyVisits('gym-C', 5, { firstDay: 16 })];
    const r = calculateMemberSettlement({ cycle: cycleFor('premium'), visits, gymRates: [snap('gym-C'), snap('gym-D')] });
    assert.equal(r.member.totalPreliminaryTzs, 203_000);
    assert.equal(r.member.networkCapTzs, 187_500);
    assert.equal(gymOf(r, 'gym-D').finalTzs, 161_638);   // 175,000 × 187,500 / 203,000 = 161,637.93
    assert.equal(gymOf(r, 'gym-C').finalTzs, 25_862);    // 28,000 × 187,500 / 203,000 = 25,862.07
    assert.equal(r.member.totalFinalTzs, 187_500);
    assert.equal(r.member.networkAdjustmentTzs, -15_500);
  });
  test('E2: three gyms over the cap (Executive; E × 15 + D × 4 + C × 5)', () => {
    const visits = [...dailyVisits('gym-E', 15), ...dailyVisits('gym-D', 4, { firstDay: 16 }), ...dailyVisits('gym-C', 5, { firstDay: 20 })];
    const r = calculateMemberSettlement({ cycle: cycleFor('executive'), visits, gymRates: [snap('gym-C'), snap('gym-D'), snap('gym-E')] });
    assert.equal(r.member.totalPreliminaryTzs, 348_000);   // 270,000 + 50,000 + 28,000
    assert.equal(r.member.networkCapTzs, 300_000);
    // exact shares 232,758.62 / 43,103.45 / 24,137.93 → floors leave 2 TZS → C (.93), then E (.62)
    assert.equal(gymOf(r, 'gym-E').finalTzs, 232_759);
    assert.equal(gymOf(r, 'gym-D').finalTzs, 43_103);
    assert.equal(gymOf(r, 'gym-C').finalTzs, 24_138);
    assert.equal(sum(r.gyms.map(g => g.finalTzs)), 300_000);
  });
  test('allocation is by payout, not by visit count', () => {
    // D (premium) and C (midtier) both have 5 visits but very different payouts.
    const visits = [...dailyVisits('gym-D', 5), ...dailyVisits('gym-C', 5, { firstDay: 6 })];
    const cycle = cycleFor('premium', { collectedApprovedAmountTzs: 52_000 });   // cap 39,000 < 78,000
    const r = calculateMemberSettlement({ cycle, visits, gymRates: [snap('gym-C'), snap('gym-D')] });
    assert.equal(gymOf(r, 'gym-D').finalTzs, 25_000);    // 50,000 / 78,000 × 39,000
    assert.equal(gymOf(r, 'gym-C').finalTzs, 14_000);    // 28,000 / 78,000 × 39,000
  });
  test('one gym under the cap, several gyms under the cap: preliminary paid in full', () => {
    const visits = [...dailyVisits('gym-A', 4), ...dailyVisits('gym-C', 6, { firstDay: 5 })];
    const r = calculateMemberSettlement({ cycle: cycleFor('pro'), visits, gymRates: [snap('gym-A'), snap('gym-C')] });
    assert.deepEqual(r.gyms.map(g => [g.gymId, g.finalTzs, g.networkAdjustmentTzs]), [['gym-A', 12_000, 0], ['gym-C', 28_000, 0]]);
  });
});

describe('largest-remainder allocation (DR-17)', () => {
  test('the brief\'s example divides exactly: 50k / 30k / 20k into 75,000', () => {
    const a = allocateNetworkCap([{ gymId: 'A', preliminaryTzs: 50_000 }, { gymId: 'B', preliminaryTzs: 30_000 }, { gymId: 'C', preliminaryTzs: 20_000 }], 75_000);
    assert.deepEqual(a.allocations.map(x => x.finalTzs), [37_500, 22_500, 15_000]);
  });
  test('fractional shares: 20,000 among three equal gyms → 6,667 / 6,667 / 6,666 (ties by gymId)', () => {
    const a = allocateNetworkCap([{ gymId: 'g-c', preliminaryTzs: 10_000 }, { gymId: 'g-a', preliminaryTzs: 10_000 }, { gymId: 'g-b', preliminaryTzs: 10_000 }], 20_000);
    assert.deepEqual(a.allocations.map(x => [x.gymId, x.finalTzs]), [['g-a', 6_667], ['g-b', 6_667], ['g-c', 6_666]]);
    assert.equal(a.totalFinalTzs, 20_000);
  });
  test('the largest fractional remainder wins the spare TZS, not the largest gym', () => {
    // exact: 7 → 4.2, 3 → 1.8; floors 4 + 1 = 5, 1 left → the .8 remainder
    const a = allocateNetworkCap([{ gymId: 'big', preliminaryTzs: 7 }, { gymId: 'small', preliminaryTzs: 3 }], 6);
    assert.deepEqual(a.allocations.map(x => [x.gymId, x.finalTzs]), [['big', 4], ['small', 2]]);
  });
  test('a cap of 1 TZS among three equal gyms goes to the first gymId', () => {
    const a = allocateNetworkCap([{ gymId: 'z', preliminaryTzs: 5 }, { gymId: 'y', preliminaryTzs: 5 }, { gymId: 'x', preliminaryTzs: 5 }], 1);
    assert.deepEqual(a.allocations.map(x => [x.gymId, x.finalTzs]), [['x', 1], ['y', 0], ['z', 0]]);
  });
  test('a zero cap pays nothing; nothing to allocate is fine', () => {
    assert.deepEqual(allocateNetworkCap([{ gymId: 'a', preliminaryTzs: 100 }], 0).allocations[0].finalTzs, 0);
    assert.equal(allocateNetworkCap([], 45_000).totalFinalTzs, 0);
  });
  test('large amounts stay exact (no float drift)', () => {
    const prelims = [{ gymId: 'a', preliminaryTzs: 999_999_937 }, { gymId: 'b', preliminaryTzs: 999_999_929 }, { gymId: 'c', preliminaryTzs: 3 }];
    const a = allocateNetworkCap(prelims, 1_000_000_007);
    assert.equal(sum(a.allocations.map(x => x.finalTzs)), 1_000_000_007);
    assert.ok(a.allocations.every(x => Number.isSafeInteger(x.finalTzs)));
  });
  test('duplicate gyms are rejected', () => {
    assert.throws(() => allocateNetworkCap([{ gymId: 'a', preliminaryTzs: 1 }, { gymId: 'a', preliminaryTzs: 2 }], 1), /duplicate/);
  });
});

// ── rate snapshots, missing rates, determinism ──────────────────────────────

describe('rate snapshots and reproducibility', () => {
  test('each gym result carries the snapshot needed to reproduce it', () => {
    const r = calculateMemberSettlement({ cycle: cycleFor('basic'), visits: dailyVisits('gym-B', 5), gymRates: [snap('gym-B')] });
    const s = gymOf(r, 'gym-B').rateCardSnapshot;
    assert.equal(s.rateCardId, 'rc-B-1');
    assert.equal(s.gymTier, 'standard');
    assert.deepEqual([s.wholesaleDailyTzs, s.wholesaleWeeklyTzs, s.wholesaleMonthlyTzs], [3_000, 9_600, 32_000]);
    assert.equal(s.ruleSources.weeklyCeilingTzs.ruleId, 'rule-ceil-standard');
    const again = calculatePreliminaryGymPayout(gymOf(r, 'gym-B').qualifyingVisitCount, s);
    assert.equal(again.guardedPreliminaryTzs, gymOf(r, 'gym-B').preliminaryTzs);
  });
  test('DR-06: a Premium member at a Standard gym is paid on Standard ceilings', () => {
    const r = calculateMemberSettlement({ cycle: cycleFor('premium'), visits: dailyVisits('gym-A', 15), gymRates: [snap('gym-A')] });
    assert.equal(gymOf(r, 'gym-A').preliminaryTzs, 40_000);          // Standard monthly, not Premium's 175,000
    assert.equal(r.member.networkCapTzs, 187_500);                   // pass tier drives the cap
    assert.equal(r.member.visitAllowance, 20);                       // and the allowance
  });
  test('a gym without a rate snapshot is held, not paid at zero or a guess', () => {
    const r = calculateMemberSettlement({ cycle: cycleFor('basic'), visits: dailyVisits('gym-Z', 3), gymRates: [] });
    assert.ok(r.visits.every(v => v.outcome === VISIT_OUTCOME.HELD && v.eligibility === VISIT_ELIGIBILITY.NO_RATE_CARD));
    assert.equal(gymOf(r, 'gym-Z').heldVisitCount, 3);
    assert.equal(r.member.totalFinalTzs, 0);
    assert.deepEqual(r.warnings, [{ code: 'no_rate_card', gymId: 'gym-Z' }]);
  });
  test('identical input gives identical output, whatever the visit order', () => {
    const visits = [...dailyVisits('gym-D', 15), ...dailyVisits('gym-C', 5, { firstDay: 16 })];
    const args = () => ({ cycle: cycleFor('premium'), visits: structuredClone(visits), gymRates: [snap('gym-C'), snap('gym-D')] });
    const a = calculateMemberSettlement(args());
    const b = calculateMemberSettlement(args());
    const shuffled = args();
    shuffled.visits.reverse();
    shuffled.gymRates.reverse();
    assert.deepEqual(a, b);
    assert.deepEqual(calculateMemberSettlement(shuffled), a);
    assert.equal(a.engineVersion, SETTLEMENT_ENGINE_VERSION);
  });
  test('the input is not mutated', () => {
    const input = { cycle: cycleFor('basic'), visits: dailyVisits('gym-A', 17), gymRates: [snap('gym-A')] };
    const before = structuredClone(input);
    calculateMemberSettlement(input);
    assert.deepEqual(input, before);
  });
  test('bad input fails loudly', () => {
    const ok = { visits: [], gymRates: [] };
    assert.throws(() => calculateMemberSettlement({ ...ok, cycle: cycleFor('basic', { collectedApprovedAmountTzs: 60_000.5 }) }), TypeError);
    assert.throws(() => calculateMemberSettlement({ ...ok, cycle: cycleFor('basic', { networkPayoutBps: 0.75 }) }), TypeError);
    assert.throws(() => calculateMemberSettlement({ ...ok, cycle: cycleFor('basic', { cycleEnd: '2026-09-01T00:00:00.000Z' }) }), RangeError);
    assert.throws(() => calculateMemberSettlement({ ...ok, cycle: cycleFor('basic', { visitAllowance: Infinity }) }), TypeError);
    assert.throws(() => calculateMemberSettlement({ cycle: cycleFor('basic'), visits: dailyVisits('gym-A', 1, { memberId: 'other' }), gymRates: [] }), /another member/);
    const dup = dailyVisits('gym-A', 2); dup[1].checkinId = dup[0].checkinId;
    assert.throws(() => calculateMemberSettlement({ cycle: cycleFor('basic'), visits: dup, gymRates: [] }), /duplicate checkinId/);
  });
});

// ── invariants over generated scenarios (§16) ────────────────────────────────

// Seeded PRNG (mulberry32): deterministic "property" runs without a new dependency.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function scenario(seed) {
  const r = rng(seed);
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = xs => xs[int(0, xs.length - 1)];
  const tiers = Object.keys(CEILINGS);
  const gymCount = int(1, 4);
  const gymRates = Array.from({ length: gymCount }, (_, i) => {
    const tier = pick(tiers);
    const c = CEILINGS[tier];
    return { gymId: `g${i}`, gymTier: tier, rateCardId: `rc${i}`, rateCardVersion: 1,
      retailDailyTzs: int(0, c.daily * 2), retailWeeklyTzs: int(0, c.weekly * 2), retailMonthlyTzs: int(0, c.monthly * 2),
      dailyDiscountBps: int(0, 5_000), weeklyDiscountBps: int(0, 5_000), monthlyDiscountBps: int(0, 5_000),
      dailyCeilingTzs: c.daily, weeklyCeilingTzs: c.weekly, monthlyCeilingTzs: c.monthly };
  });
  const passTier = pick(PASS_TIER_VERSIONS).tierKey;
  const cycle = cycleFor(passTier, { collectedApprovedAmountTzs: int(0, 500_000), networkPayoutBps: int(0, 10_000) });
  const visits = Array.from({ length: int(0, 40) }, (_, i) => ({
    checkinId: `v${String(i).padStart(3, '0')}`, memberId: 'member-1',
    cycleId: r() < 0.95 ? 'cycle-1' : 'cycle-2',
    gymId: r() < 0.97 ? `g${int(0, gymCount - 1)}` : 'g-unrated',
    timestamp: new Date(Date.parse('2026-10-01T07:00:00.000Z') + int(-86_400, 31 * 86_400) * 1_000).toISOString(),
    status: pick(['valid', 'valid', 'valid', 'valid', 'voided', 'disputed', 'flagged']),
    visitConsumed: r() < 0.9,
    subscriptionType: pick(['platform_pass', 'platform_pass', 'platform_pass', 'direct_sub', 'trainer_home'])
  }));
  return { cycle, visits, gymRates };
}

describe('invariants over 400 generated scenarios', () => {
  const runs = Array.from({ length: 400 }, (_, i) => {
    const input = scenario(i + 1);
    return { input, result: calculateMemberSettlement(input) };
  });
  const each = (name, check) => test(name, () => {
    for (const { input, result } of runs) check(result, input);
  });

  each('1. payable visits never exceed the allowance', r => assert.ok(r.member.payableVisitCount <= r.member.visitAllowance));
  each('2. no negative payouts', r => r.gyms.forEach(g => { assert.ok(g.finalTzs >= 0); assert.ok(g.preliminaryTzs >= 0); }));
  each('3. when the cap applies, the total equals the cap', r => { if (r.member.capApplied) assert.equal(r.member.totalFinalTzs, r.member.networkCapTzs); });
  each('4. never more than the cap', r => assert.ok(r.member.totalFinalTzs <= r.member.networkCapTzs));
  each('5. gym finals add up to the member total', r => assert.equal(sum(r.gyms.map(g => g.finalTzs)), r.member.totalFinalTzs));
  each('6. largest remainder reconciles exactly', r => {
    const again = allocateNetworkCap(r.gyms.map(g => ({ gymId: g.gymId, preliminaryTzs: g.preliminaryTzs })), r.member.networkCapTzs);
    assert.equal(again.totalFinalTzs, Math.min(r.member.totalPreliminaryTzs, r.member.networkCapTzs));
    assert.equal(sum(again.allocations.map(a => a.finalTzs)), again.totalFinalTzs);
  });
  each('7. deterministic', (r, input) => assert.deepEqual(calculateMemberSettlement(structuredClone(input)), r));
  each('8. at most one payable visit per EAT day', r => {
    const days = r.visits.filter(v => v.outcome === VISIT_OUTCOME.PAYABLE).map(v => localDay(v.timestamp));
    assert.equal(new Set(days).size, days.length);
  });
  each('9. VOIDED is never payable or held', (r, input) => {
    const voided = new Set(input.visits.filter(v => v.status === 'voided').map(v => v.checkinId));
    r.visits.filter(v => voided.has(v.checkinId)).forEach(v => assert.equal(v.outcome, VISIT_OUTCOME.EXCLUDED));
  });
  each('10. only Platform Pass visits are payable', (r, input) => {
    const byId = new Map(input.visits.map(v => [v.checkinId, v]));
    r.visits.filter(v => v.outcome === VISIT_OUTCOME.PAYABLE).forEach(v => assert.equal(byId.get(v.checkinId).subscriptionType, 'platform_pass'));
  });
  each('whole TZS only, final ≤ preliminary per gym (payout weighting never overpays a gym)', r => r.gyms.forEach(g => {
    assert.ok(Number.isSafeInteger(g.finalTzs) && Number.isSafeInteger(g.preliminaryTzs));
    assert.ok(g.finalTzs <= g.preliminaryTzs);
  }));
  each('every visit gets exactly one outcome and a reason', (r, input) => {
    assert.equal(r.visits.length, input.visits.length);
    r.visits.forEach(v => { assert.ok(Object.values(VISIT_OUTCOME).includes(v.outcome)); assert.ok(Object.values(VISIT_ELIGIBILITY).includes(v.eligibility)); });
  });

  test('11. monotonic: one more qualifying visit never lowers the payout', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const { gymRates } = scenario(seed);
      const rates = calculateWholesaleRates(gymRates[0]);
      for (let n = 0; n < 30; n++) {
        assert.ok(applyMonotonicGuard(n + 1, rates).guardedPreliminaryTzs >= applyMonotonicGuard(n, rates).guardedPreliminaryTzs, `seed ${seed} n ${n}`);
      }
      // and at member level: the member total never falls as visits are added
      const cycle = cycleFor('executive', { collectedApprovedAmountTzs: 200_000 });
      let previous = -1;
      for (let n = 0; n <= 24; n++) {
        const total = calculateMemberSettlement({ cycle, visits: dailyVisits('g0', n), gymRates: [gymRates[0]] }).member.totalFinalTzs;
        assert.ok(total >= previous, `seed ${seed} n ${n}`);
        previous = total;
      }
    }
  });
});
