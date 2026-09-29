import { deriveRateCardRuleValues } from '../../src/shared/settlement-config.mjs';

// Approved initial Dar es Salaam settlement configuration (decision register
// DR-06, DR-07, DR-22), used by the settlement specs only. Not production
// config: nothing reads this outside specs/ (bfast.json ignores specs/).
//
// Pass tier keys are the existing ones; the approved labels map as
// basic = Standard, pro = Mid-Tier, premium = Premium, executive = Luxury/Executive.

export const EFFECTIVE_FROM = '2026-01-01';

// Pass tier controls price, allowance (PassTierVersion) and network % (rules).
export const PASS_TIER_VERSIONS = [
  { id: 'ptv-basic-1',     tierKey: 'basic',     version: 1, status: 'active', effectiveFrom: EFFECTIVE_FROM, effectiveTo: null, priceTzs: 60_000,  visitAllowance: 16 },
  { id: 'ptv-pro-1',       tierKey: 'pro',       version: 1, status: 'active', effectiveFrom: EFFECTIVE_FROM, effectiveTo: null, priceTzs: 150_000, visitAllowance: 18 },
  { id: 'ptv-premium-1',   tierKey: 'premium',   version: 1, status: 'active', effectiveFrom: EFFECTIVE_FROM, effectiveTo: null, priceTzs: 250_000, visitAllowance: 20 },
  { id: 'ptv-executive-1', tierKey: 'executive', version: 1, status: 'active', effectiveFrom: EFFECTIVE_FROM, effectiveTo: null, priceTzs: 400_000, visitAllowance: 24 }
];

// Gym tier controls the reimbursement ceilings (DR-06).
export const CEILINGS = {
  standard:         { daily: 3_500,  weekly: 12_000, monthly: 42_000 },
  midtier:          { daily: 7_500,  weekly: 30_000, monthly: 105_000 },
  premium:          { daily: 12_000, weekly: 50_000, monthly: 175_000 },
  luxury_executive: { daily: 18_000, weekly: 75_000, monthly: 270_000 }
};

// Which gym tier a pass tier is priced against (for the tier matrix only).
export const PASS_FOR_GYM_TIER = { standard: 'basic', midtier: 'pro', premium: 'premium', luxury_executive: 'executive' };

export const RULES = [
  // GLOBAL: wholesale = 75% of daily, 80% of weekly and monthly retail; network 75%.
  { id: 'rule-global', version: 1, scopeType: 'global', scopeId: null, status: 'active', effectiveFrom: EFFECTIVE_FROM, effectiveTo: null,
    dailyDiscountBps: 2_500, weeklyDiscountBps: 2_000, monthlyDiscountBps: 2_000, networkPayoutBps: 7_500 },
  ...Object.entries(CEILINGS).map(([tier, c]) => ({
    id: `rule-ceil-${tier}`, version: 1, scopeType: 'gym_tier', scopeId: tier, status: 'active', effectiveFrom: EFFECTIVE_FROM, effectiveTo: null,
    dailyCeilingTzs: c.daily, weeklyCeilingTzs: c.weekly, monthlyCeilingTzs: c.monthly
  }))
];

/** A rate card as approval leaves it: the rules in force on its start date copied onto it (DR-23). */
export function approveCard(card, rules = RULES) {
  const { values, sources, missing } = deriveRateCardRuleValues({ rules, effectiveFrom: card.effectiveFrom, gymTier: card.gymTier, gymId: card.gymId });
  if (missing.length) throw new Error(`rules missing for ${card.id}: ${missing.join(', ')}`);
  return { ...card, ...values, ruleSources: sources };
}

// Illustrative gyms (retail rates are examples, not real gyms).
export const RATE_CARDS = [
  { id: 'rc-A-1', gymId: 'gym-A', version: 1, gymTier: 'standard',         status: 'active', effectiveFrom: EFFECTIVE_FROM, effectiveTo: null, retailDailyTzs: 5_000,  retailWeeklyTzs: 15_000,  retailMonthlyTzs: 50_000 },
  { id: 'rc-B-1', gymId: 'gym-B', version: 1, gymTier: 'standard',         status: 'active', effectiveFrom: EFFECTIVE_FROM, effectiveTo: null, retailDailyTzs: 4_000,  retailWeeklyTzs: 12_000,  retailMonthlyTzs: 40_000 },
  { id: 'rc-C-1', gymId: 'gym-C', version: 1, gymTier: 'midtier',          status: 'active', effectiveFrom: EFFECTIVE_FROM, effectiveTo: null, retailDailyTzs: 10_000, retailWeeklyTzs: 35_000,  retailMonthlyTzs: 120_000 },
  { id: 'rc-D-1', gymId: 'gym-D', version: 1, gymTier: 'premium',          status: 'active', effectiveFrom: EFFECTIVE_FROM, effectiveTo: null, retailDailyTzs: 20_000, retailWeeklyTzs: 70_000,  retailMonthlyTzs: 250_000 },
  { id: 'rc-E-1', gymId: 'gym-E', version: 1, gymTier: 'luxury_executive', status: 'active', effectiveFrom: EFFECTIVE_FROM, effectiveTo: null, retailDailyTzs: 30_000, retailWeeklyTzs: 100_000, retailMonthlyTzs: 350_000 }
].map(card => approveCard(card));

/** A rate snapshot whose retail rates sit above every ceiling of the tier, so wholesale = the tier ceilings. */
export function ceilingSnapshot(gymId, gymTier) {
  const c = CEILINGS[gymTier];
  return Object.freeze({
    gymId, gymTier, rateCardId: `rc-${gymId}`, rateCardVersion: 1,
    retailDailyTzs: c.daily * 2, retailWeeklyTzs: c.weekly * 2, retailMonthlyTzs: c.monthly * 2,
    dailyDiscountBps: 2_500, weeklyDiscountBps: 2_000, monthlyDiscountBps: 2_000,
    dailyCeilingTzs: c.daily, weeklyCeilingTzs: c.weekly, monthlyCeilingTzs: c.monthly
  });
}

// A 30-day member cycle: 1 Oct 2026 10:00 EAT to 31 Oct 2026 10:00 EAT.
export const CYCLE_START = '2026-10-01T07:00:00.000Z';
export const CYCLE_END   = '2026-10-31T07:00:00.000Z';

export function cycleFor(passTier, overrides = {}) {
  const v = PASS_TIER_VERSIONS.find(p => p.tierKey === passTier);
  return {
    memberId: 'member-1', cycleId: 'cycle-1', subscriptionId: 'sub-1', subscriptionType: 'platform_pass', passTier,
    cycleStart: CYCLE_START, cycleEnd: CYCLE_END,
    collectedApprovedAmountTzs: v.priceTzs, networkPayoutBps: 7_500, visitAllowance: v.visitAllowance,
    ...overrides
  };
}

/** One valid, consumed visit per consecutive EAT day, at 15:00 EAT, from `firstDay` (1 = 1 Oct). */
export function dailyVisits(gymId, count, { firstDay = 1, prefix = gymId, ...extra } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    checkinId: `${prefix}-${String(i + 1).padStart(2, '0')}`,
    memberId: 'member-1', cycleId: 'cycle-1', gymId,
    timestamp: new Date(Date.UTC(2026, 9, firstDay + i, 12, 0, 0)).toISOString(),
    status: 'valid', visitConsumed: true, subscriptionType: 'platform_pass',
    ...extra
  }));
}
