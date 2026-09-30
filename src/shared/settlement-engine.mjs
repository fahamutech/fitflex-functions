// Gym settlement engine — pure logic (Phase 1 of the settlement rebuild).
//
// This is the future authoritative calculation for what FitFlex owes gyms for
// Platform Pass visits. It is NOT wired into any payout flow yet: the legacy
// payout-engine.mjs (5-band, retired by DR-21) and finance-service.mjs keep
// running untouched until the cutover phase.
//
// Everything here is deterministic and side-effect free: no database, clock,
// network or global state. Money is integer TZS; percentages are integer
// basis points (7500 = 75.00%). Decision numbers (DR-xx) refer to the approved
// decision register in the "FitFlex Gym Settlement Specification" doc.
//
// Pipeline (calculateMemberSettlement):
//   validate cycle → classify each visit (cycle, subscription type, status,
//   same EAT day, consumed, allowance, rate card) → count payable visit-days
//   per gym → bracket + monotonic guard = preliminary → member network cap →
//   payout-weighted allocation with largest remainder → result.

import { SUBSCRIPTION_GRACE_HOURS } from './constants.mjs';
import { localDay } from './member-progress.mjs';
import { CHECKIN_STATUS } from './checkin-status.mjs';

export const SETTLEMENT_ENGINE_VERSION = 'settlement-engine/1';

// DR-03: only Platform Pass visits enter visit-based gym settlement in MVP.
// Values are the Checkin.subscriptionType strings the check-in service writes.
export const SETTLEABLE_SUBSCRIPTION_TYPES = Object.freeze(['platform_pass']);

// DR-14: the check-in lifecycle, as stored on Checkin (one definition).
export { CHECKIN_STATUS };

/** What happens to a visit in this calculation. */
export const VISIT_OUTCOME = Object.freeze({
  PAYABLE:  'payable',   // counted in the gym's preliminary payout
  HELD:     'held',      // not paid now; may become payable once resolved
  EXCLUDED: 'excluded'   // never paid in this cycle
});

/** Machine-readable reason for each visit's outcome. */
export const VISIT_ELIGIBILITY = Object.freeze({
  ELIGIBLE:                'eligible',
  OUTSIDE_MEMBER_CYCLE:    'outside_member_cycle',
  WRONG_SUBSCRIPTION_TYPE: 'wrong_subscription_type',
  VOIDED:                  'voided',
  SECOND_GYM_SAME_DAY:     'second_gym_same_day',   // DR-13
  DUPLICATE_SAME_DAY:      'duplicate_same_day',    // same gym again that EAT day
  NOT_CONSUMED:            'not_consumed',          // visitConsumed was false
  OVER_ALLOWANCE:          'over_allowance',        // DR-01
  DISPUTED:                'disputed',              // DR-14, held
  FLAGGED:                 'flagged',               // DR-14, held
  UNKNOWN_STATUS:          'unknown_status',        // no/unknown status: held, never paid silently
  NO_RATE_CARD:            'no_rate_card'           // no rate snapshot for the gym: held
});

/** Visit bracket names (the approved commercial model, §4 of the brief). */
export const VISIT_BRACKET = Object.freeze({
  NONE:          'none',           // 0 visits
  DAILY:         'daily',          // 1–3: visits × daily
  WEEKLY:        'weekly',         // 4–7: 1 × weekly
  DOUBLE_WEEKLY: 'double_weekly',  // 8–14: 2 × weekly
  MONTHLY:       'monthly'         // 15+: 1 × monthly
});

// DR-14: disputes may be raised for 7 days; a cycle is final after its end,
// the 24 h subscription grace (DR-15) and this window.
export const SETTLEMENT_DISPUTE_WINDOW_DAYS = 7;

const BPS = 10_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MONTHLY_FROM_VISITS = 15;

// ── validation ───────────────────────────────────────────────────────────────

function assertTzs(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative whole number of TZS (got ${value})`);
  }
}

function assertBps(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > BPS) {
    throw new TypeError(`${name} must be whole basis points 0–10000 (got ${value})`);
  }
}

function instant(value, name) {
  const ms = Date.parse(value);
  if (typeof value !== 'string' || Number.isNaN(ms)) throw new TypeError(`${name} must be an ISO timestamp (got ${value})`);
  return ms;
}

const byGymId = (a, b) => (a.gymId < b.gymId ? -1 : a.gymId > b.gymId ? 1 : 0);

// ── rates and brackets ───────────────────────────────────────────────────────

/**
 * Wholesale rate = MIN(floor(retail × (1 − discount)), ceiling)  (DR-17 floor).
 * @param {number} retailTzs     gym's retail rate
 * @param {number} discountBps   e.g. 2500 = 25%
 * @param {number} ceilingTzs    absolute ceiling for the gym's tier (DR-06)
 */
export function calculateWholesaleRate(retailTzs, discountBps, ceilingTzs) {
  assertTzs(retailTzs, 'retailTzs');
  assertBps(discountBps, 'discountBps');
  assertTzs(ceilingTzs, 'ceilingTzs');
  const discounted = Number(BigInt(retailTzs) * BigInt(BPS - discountBps) / BigInt(BPS));
  return Math.min(discounted, ceilingTzs);
}

/** The three wholesale rates of a gym rate snapshot. */
export function calculateWholesaleRates(snapshot) {
  return {
    dailyTzs:   calculateWholesaleRate(snapshot.retailDailyTzs,   snapshot.dailyDiscountBps,   snapshot.dailyCeilingTzs),
    weeklyTzs:  calculateWholesaleRate(snapshot.retailWeeklyTzs,  snapshot.weeklyDiscountBps,  snapshot.weeklyCeilingTzs),
    monthlyTzs: calculateWholesaleRate(snapshot.retailMonthlyTzs, snapshot.monthlyDiscountBps, snapshot.monthlyCeilingTzs)
  };
}

/**
 * The approved bracket, WITHOUT the monotonic guard.
 * 1–3 visits × daily · 4–7 one weekly · 8–14 two weekly · 15+ one monthly.
 */
export function bracketPayout(visitCount, rates) {
  if (!Number.isInteger(visitCount) || visitCount < 0) throw new TypeError(`visitCount must be a whole number ≥ 0 (got ${visitCount})`);
  if (visitCount === 0) return { bracket: VISIT_BRACKET.NONE, amountTzs: 0 };
  if (visitCount <= 3) return { bracket: VISIT_BRACKET.DAILY, amountTzs: visitCount * rates.dailyTzs };
  if (visitCount <= 7) return { bracket: VISIT_BRACKET.WEEKLY, amountTzs: rates.weeklyTzs };
  if (visitCount < MONTHLY_FROM_VISITS) return { bracket: VISIT_BRACKET.DOUBLE_WEEKLY, amountTzs: 2 * rates.weeklyTzs };
  return { bracket: VISIT_BRACKET.MONTHLY, amountTzs: rates.monthlyTzs };
}

/**
 * DR-11: a higher visit count may never pay less. The guarded amount is the
 * highest bracket amount at any count up to `visitCount`; the raw bracket is
 * kept alongside so the guard is visible, not a replacement of the model.
 * (Every count from 15 up pays the same monthly amount, so 0..15 suffices.)
 */
export function applyMonotonicGuard(visitCount, rates) {
  const raw = bracketPayout(visitCount, rates);
  let guarded = raw.amountTzs;
  let guardSourceVisitCount = visitCount;
  for (let k = Math.min(visitCount, MONTHLY_FROM_VISITS); k >= 0; k--) {
    const amount = bracketPayout(k, rates).amountTzs;
    if (amount > guarded) { guarded = amount; guardSourceVisitCount = k; }
  }
  return {
    bracket: raw.bracket,
    rawPreliminaryTzs: raw.amountTzs,
    guardedPreliminaryTzs: guarded,
    monotonicGuardApplied: guarded > raw.amountTzs,
    guardSourceVisitCount
  };
}

/** A gym's preliminary payout for its qualifying visit-days in one member cycle. */
export function calculatePreliminaryGymPayout(visitCount, snapshot) {
  const rates = calculateWholesaleRates(snapshot);
  return { rates, ...applyMonotonicGuard(visitCount, rates) };
}

// ── network cap and allocation ───────────────────────────────────────────────

/** DR-05 / DR-17: floor(collected approved amount × network %). */
export function calculateNetworkCap(collectedApprovedAmountTzs, networkPayoutBps) {
  assertTzs(collectedApprovedAmountTzs, 'collectedApprovedAmountTzs');
  assertBps(networkPayoutBps, 'networkPayoutBps');
  return Number(BigInt(collectedApprovedAmountTzs) * BigInt(networkPayoutBps) / BigInt(BPS));
}

/**
 * DR-02 / DR-17: payout-weighted pro-rata with largest-remainder rounding.
 * Under the cap every gym keeps its preliminary amount. Over it, each gym gets
 * floor(preliminary × cap / total); the TZS left over go one at a time to the
 * largest remainders, ties broken by gymId ascending, so the parts sum to the
 * cap exactly. Integer (BigInt) arithmetic throughout: no float drift.
 *
 * @param {Array<{gymId:string, preliminaryTzs:number}>} preliminaries
 * @param {number} capTzs
 */
export function allocateNetworkCap(preliminaries, capTzs) {
  assertTzs(capTzs, 'capTzs');
  const seen = new Set();
  for (const p of preliminaries) {
    if (seen.has(p.gymId)) throw new Error(`duplicate gymId in allocation: ${p.gymId}`);
    seen.add(p.gymId);
    assertTzs(p.preliminaryTzs, `preliminaryTzs(${p.gymId})`);
  }
  const rows = [...preliminaries].sort(byGymId);
  const totalPreliminaryTzs = rows.reduce((s, r) => s + r.preliminaryTzs, 0);

  if (totalPreliminaryTzs <= capTzs) {
    return {
      capApplied: false, capTzs, totalPreliminaryTzs, totalFinalTzs: totalPreliminaryTzs,
      allocations: rows.map(r => ({ gymId: r.gymId, preliminaryTzs: r.preliminaryTzs, finalTzs: r.preliminaryTzs, remainderRank: null }))
    };
  }

  const total = BigInt(totalPreliminaryTzs);
  const cap = BigInt(capTzs);
  const parts = rows.map(r => {
    const numerator = BigInt(r.preliminaryTzs) * cap;
    return { gymId: r.gymId, preliminaryTzs: r.preliminaryTzs, final: numerator / total, remainder: numerator % total };
  });
  let left = cap - parts.reduce((s, p) => s + p.final, 0n);
  const byRemainder = [...parts].sort((a, b) =>
    a.remainder === b.remainder ? byGymId(a, b) : (a.remainder > b.remainder ? -1 : 1));
  byRemainder.forEach((p, i) => { p.rank = i + 1; });
  for (let i = 0; left > 0n; i++) { byRemainder[i].final += 1n; left -= 1n; }

  return {
    capApplied: true, capTzs, totalPreliminaryTzs, totalFinalTzs: capTzs,
    allocations: parts.map(p => ({ gymId: p.gymId, preliminaryTzs: p.preliminaryTzs, finalTzs: Number(p.final), remainderRank: p.rank }))
  };
}

// ── visit eligibility ────────────────────────────────────────────────────────

/**
 * Classify every visit of one member cycle. Order matters and is explicit:
 *  1. cycle assignment (DR-15: the caller assigns grace-period visits to the
 *     expiring cycle; the engine only checks the assignment and that the
 *     timestamp lies within the cycle plus the existing 24 h grace)
 *  2. subscription type (DR-03)            3. VOIDED never counts (DR-14)
 *  4. one visit per EAT day: the day's first remaining visit keeps the day;
 *     a second gym that day is not payable (DR-13)
 *  5. the day's visit must have been consumed (visitConsumed, BL-010/011)
 *  6. allowance, chronologically (DR-01). DISPUTED/FLAGGED visits occupy
 *     allowance slots so resolving them can never push payable visits past
 *     the allowance.
 *  7. DISPUTED / FLAGGED / unknown status are held (DR-14)
 *  8. a gym without a rate snapshot is held (never paid at 0 or a guess)
 */
export function classifyVisits({ cycle, visits, gymIdsWithRates }) {
  const cycleStartMs = instant(cycle.cycleStart, 'cycle.cycleStart');
  const graceEndMs = instant(cycle.cycleEnd, 'cycle.cycleEnd') + SUBSCRIPTION_GRACE_HOURS * HOUR_MS;
  const cycleSettleable = SETTLEABLE_SUBSCRIPTION_TYPES.includes(cycle.subscriptionType);

  const ordered = [...visits].sort((a, b) => {
    const d = instant(a.timestamp, `visit ${a.checkinId} timestamp`) - instant(b.timestamp, `visit ${b.checkinId} timestamp`);
    return d !== 0 ? d : (a.checkinId < b.checkinId ? -1 : a.checkinId > b.checkinId ? 1 : 0);
  });

  const ids = new Set();
  const results = [];
  const dayOwner = new Map();   // EAT day → the visit that holds that day
  let slot = 0;

  for (const v of ordered) {
    if (ids.has(v.checkinId)) throw new Error(`duplicate checkinId: ${v.checkinId}`);
    ids.add(v.checkinId);
    if (v.memberId !== cycle.memberId) throw new Error(`visit ${v.checkinId} belongs to another member`);

    const ts = Date.parse(v.timestamp);
    const businessDate = localDay(v.timestamp);
    const out = (outcome, eligibility, extra = {}) =>
      results.push({ checkinId: v.checkinId, gymId: v.gymId, timestamp: v.timestamp, businessDate, status: v.status ?? null, outcome, eligibility, allowanceSlot: null, ...extra });

    if (v.cycleId !== cycle.cycleId || ts < cycleStartMs || ts >= graceEndMs) {
      out(VISIT_OUTCOME.EXCLUDED, VISIT_ELIGIBILITY.OUTSIDE_MEMBER_CYCLE); continue;
    }
    if (!cycleSettleable || !SETTLEABLE_SUBSCRIPTION_TYPES.includes(v.subscriptionType)) {
      out(VISIT_OUTCOME.EXCLUDED, VISIT_ELIGIBILITY.WRONG_SUBSCRIPTION_TYPE); continue;
    }
    if (v.status === CHECKIN_STATUS.VOIDED) {
      out(VISIT_OUTCOME.EXCLUDED, VISIT_ELIGIBILITY.VOIDED); continue;
    }
    const owner = dayOwner.get(businessDate);
    if (owner) {
      out(VISIT_OUTCOME.EXCLUDED, owner.gymId === v.gymId ? VISIT_ELIGIBILITY.DUPLICATE_SAME_DAY : VISIT_ELIGIBILITY.SECOND_GYM_SAME_DAY);
      continue;
    }
    dayOwner.set(businessDate, v);
    if (v.visitConsumed !== true) {
      out(VISIT_OUTCOME.EXCLUDED, VISIT_ELIGIBILITY.NOT_CONSUMED); continue;
    }
    slot += 1;
    if (slot > cycle.visitAllowance) {
      out(VISIT_OUTCOME.EXCLUDED, VISIT_ELIGIBILITY.OVER_ALLOWANCE, { allowanceSlot: slot }); continue;
    }
    if (v.status === CHECKIN_STATUS.DISPUTED) { out(VISIT_OUTCOME.HELD, VISIT_ELIGIBILITY.DISPUTED, { allowanceSlot: slot }); continue; }
    if (v.status === CHECKIN_STATUS.FLAGGED)  { out(VISIT_OUTCOME.HELD, VISIT_ELIGIBILITY.FLAGGED,  { allowanceSlot: slot }); continue; }
    if (v.status !== CHECKIN_STATUS.VALID)    { out(VISIT_OUTCOME.HELD, VISIT_ELIGIBILITY.UNKNOWN_STATUS, { allowanceSlot: slot }); continue; }
    if (!gymIdsWithRates.has(v.gymId))        { out(VISIT_OUTCOME.HELD, VISIT_ELIGIBILITY.NO_RATE_CARD, { allowanceSlot: slot }); continue; }
    out(VISIT_OUTCOME.PAYABLE, VISIT_ELIGIBILITY.ELIGIBLE, { allowanceSlot: slot });
  }
  return results;
}

// ── member settlement ────────────────────────────────────────────────────────

function validateCycle(cycle) {
  if (!cycle || typeof cycle !== 'object') throw new TypeError('cycle is required');
  for (const k of ['memberId', 'cycleId', 'subscriptionType', 'passTier']) {
    if (typeof cycle[k] !== 'string' || !cycle[k]) throw new TypeError(`cycle.${k} is required`);
  }
  const start = instant(cycle.cycleStart, 'cycle.cycleStart');
  const end = instant(cycle.cycleEnd, 'cycle.cycleEnd');
  if (end <= start) throw new RangeError('cycle.cycleEnd must be after cycle.cycleStart');
  assertTzs(cycle.collectedApprovedAmountTzs, 'cycle.collectedApprovedAmountTzs');
  assertBps(cycle.networkPayoutBps, 'cycle.networkPayoutBps');
  if (!Number.isInteger(cycle.visitAllowance) || cycle.visitAllowance < 0) {
    throw new TypeError(`cycle.visitAllowance must be a whole number ≥ 0 (got ${cycle.visitAllowance})`);
  }
}

function snapshotOf(s, rates) {
  return {
    gymId: s.gymId, gymTier: s.gymTier,
    rateCardId: s.rateCardId ?? null, rateCardVersion: s.rateCardVersion ?? null,
    retailDailyTzs: s.retailDailyTzs, retailWeeklyTzs: s.retailWeeklyTzs, retailMonthlyTzs: s.retailMonthlyTzs,
    dailyDiscountBps: s.dailyDiscountBps, weeklyDiscountBps: s.weeklyDiscountBps, monthlyDiscountBps: s.monthlyDiscountBps,
    dailyCeilingTzs: s.dailyCeilingTzs, weeklyCeilingTzs: s.weeklyCeilingTzs, monthlyCeilingTzs: s.monthlyCeilingTzs,
    wholesaleDailyTzs: rates.dailyTzs, wholesaleWeeklyTzs: rates.weeklyTzs, wholesaleMonthlyTzs: rates.monthlyTzs,
    ruleSources: s.ruleSources ?? null
  };
}

/**
 * Settle one member billing cycle across every gym the member visited.
 *
 * @param {Object} args
 * @param {Object} args.cycle  one member cycle, with its economics already
 *   resolved as of the cycle start (see settlement-config.mjs):
 *   { memberId, cycleId, subscriptionId?, subscriptionType, passTier,
 *     cycleStart, cycleEnd (ISO instants), collectedApprovedAmountTzs,
 *     networkPayoutBps, visitAllowance }
 * @param {Array}  args.visits  check-ins assigned by the caller, each
 *   { checkinId, memberId, cycleId, gymId, timestamp, status, visitConsumed,
 *     subscriptionType, passTier?, gymTier? }
 * @param {Array}  args.gymRates  immutable rate snapshots, one per gym:
 *   { gymId, gymTier, rateCardId, rateCardVersion, retail{Daily,Weekly,Monthly}Tzs,
 *     {daily,weekly,monthly}DiscountBps, {daily,weekly,monthly}CeilingTzs, ruleSources? }
 */
export function calculateMemberSettlement({ cycle, visits = [], gymRates = [] }) {
  validateCycle(cycle);
  const snapshots = new Map();
  for (const s of gymRates) {
    if (snapshots.has(s.gymId)) throw new Error(`two rate snapshots for gym ${s.gymId}`);
    snapshots.set(s.gymId, s);
  }

  const warnings = [];
  const visitResults = classifyVisits({ cycle, visits, gymIdsWithRates: new Set(snapshots.keys()) });

  // Per-gym counts.
  const perGym = new Map();
  for (const r of visitResults) {
    if (r.outcome === VISIT_OUTCOME.EXCLUDED) continue;
    const g = perGym.get(r.gymId) || { payable: 0, held: 0 };
    if (r.outcome === VISIT_OUTCOME.PAYABLE) g.payable += 1; else g.held += 1;
    perGym.set(r.gymId, g);
  }
  for (const v of visits) {
    const s = snapshots.get(v.gymId);
    if (s && v.gymTier && v.gymTier !== s.gymTier) {
      warnings.push({ code: 'gym_tier_changed', checkinId: v.checkinId, gymId: v.gymId, visitGymTier: v.gymTier, snapshotGymTier: s.gymTier });
    }
  }

  // Preliminary per gym (bracket + monotonic guard).
  const gymRows = [...perGym.entries()].map(([gymId, counts]) => {
    const s = snapshots.get(gymId);
    if (!s) {
      warnings.push({ code: 'no_rate_card', gymId });
      return { gymId, gymTier: null, counts, prelim: null, snapshot: null };
    }
    const prelim = calculatePreliminaryGymPayout(counts.payable, s);
    return { gymId, gymTier: s.gymTier, counts, prelim, snapshot: snapshotOf(s, prelim.rates) };
  }).sort(byGymId);

  const networkCapTzs = calculateNetworkCap(cycle.collectedApprovedAmountTzs, cycle.networkPayoutBps);
  const allocation = allocateNetworkCap(
    gymRows.map(g => ({ gymId: g.gymId, preliminaryTzs: g.prelim ? g.prelim.guardedPreliminaryTzs : 0 })),
    networkCapTzs
  );
  const finalByGym = new Map(allocation.allocations.map(a => [a.gymId, a]));

  const gyms = gymRows.map(g => {
    const a = finalByGym.get(g.gymId);
    return {
      gymId: g.gymId,
      gymTier: g.gymTier,
      qualifyingVisitCount: g.counts.payable,
      heldVisitCount: g.counts.held,
      bracket: g.prelim ? g.prelim.bracket : null,
      rawPreliminaryTzs: g.prelim ? g.prelim.rawPreliminaryTzs : 0,
      preliminaryTzs: a.preliminaryTzs,
      monotonicGuardApplied: g.prelim ? g.prelim.monotonicGuardApplied : false,
      finalTzs: a.finalTzs,
      networkAdjustmentTzs: a.finalTzs - a.preliminaryTzs,
      rateCardSnapshot: g.snapshot,
      calculationBasis: g.prelim
        ? { visitCount: g.counts.payable, bracket: g.prelim.bracket, guardSourceVisitCount: g.prelim.guardSourceVisitCount,
            capApplied: allocation.capApplied, allocationRatio: allocation.capApplied ? `${networkCapTzs}/${allocation.totalPreliminaryTzs}` : null,
            remainderRank: a.remainderRank }
        : null
    };
  });

  const count = outcome => visitResults.filter(r => r.outcome === outcome).length;
  const cycleEndMs = Date.parse(cycle.cycleEnd);
  return {
    engineVersion: SETTLEMENT_ENGINE_VERSION,
    member: {
      memberId: cycle.memberId,
      cycleId: cycle.cycleId,
      subscriptionId: cycle.subscriptionId ?? null,
      subscriptionType: cycle.subscriptionType,
      settleable: SETTLEABLE_SUBSCRIPTION_TYPES.includes(cycle.subscriptionType),
      passTier: cycle.passTier,
      cycleStart: cycle.cycleStart,
      cycleEnd: cycle.cycleEnd,
      cycleStartDate: localDay(cycle.cycleStart),     // EAT; also the rule resolution date (DR-10)
      cycleEndDate: localDay(cycle.cycleEnd),
      finalizableAt: new Date(cycleEndMs + SUBSCRIPTION_GRACE_HOURS * HOUR_MS + SETTLEMENT_DISPUTE_WINDOW_DAYS * DAY_MS).toISOString(),
      collectedApprovedAmountTzs: cycle.collectedApprovedAmountTzs,
      networkPayoutBps: cycle.networkPayoutBps,
      visitAllowance: cycle.visitAllowance,
      networkCapTzs,
      capApplied: allocation.capApplied,
      totalPreliminaryTzs: allocation.totalPreliminaryTzs,
      totalFinalTzs: allocation.totalFinalTzs,
      networkAdjustmentTzs: allocation.totalFinalTzs - allocation.totalPreliminaryTzs,
      retainedHeadroomTzs: networkCapTzs - allocation.totalFinalTzs,
      payableVisitCount: count(VISIT_OUTCOME.PAYABLE),
      heldVisitCount: count(VISIT_OUTCOME.HELD),
      excludedVisitCount: count(VISIT_OUTCOME.EXCLUDED)
    },
    gyms,
    visits: visitResults,
    warnings
  };
}
