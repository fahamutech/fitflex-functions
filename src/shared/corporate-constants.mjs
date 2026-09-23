// Corporate wellness (B2B) constants and pure calculations.
//
// Seat pricing deliberately lives in platform settings (PASS_TIERS /
// settingsService.priceForTier) rather than here: corporate seats are billed
// at the same Pass tier prices as retail members, and admins can change those
// at runtime from the portal. Duplicating the numbers would let the two drift.

export const INDUSTRY_SECTORS = Object.freeze({
  banking: 'Banking & Financial Services',
  ngo: 'NGO & Development Agency',
  hospitality: 'Hospitality & Tourism',
  insurance: 'Insurance',
  telecom: 'Telecom & Tech',
  manufacturing: 'Manufacturing & Energy',
  government: 'Government & Public Sector',
  other: 'Other',
});

export const WORKFORCE_BRACKETS = Object.freeze({
  '50-100': '50 - 100 employees',
  '100-250': '100 - 250 employees',
  '250-500': '250 - 500 employees',
  '500-1000': '500 - 1,000 employees',
  '1000+': '1,000+ employees',
});

// Employer share of the gross seat bill. The employee pays the remainder.
export const SUBSIDY_MODELS = Object.freeze({
  fully_funded: 1,
  copay_50_50: 0.5,
  copay_70_30: 0.7,
  employee_paid: 0,
});

export const CORPORATE_STATUS = Object.freeze(['pending', 'active', 'suspended', 'terminated']);
export const EMPLOYEE_STATUS = Object.freeze(['pending', 'active', 'suspended', 'exited']);
export const BILLING_CYCLES = Object.freeze(['monthly', 'quarterly', 'annually']);
export const DASHBOARD_MODES = Object.freeze(['employer', 'insurer']);

export const HR_OBJECTIVES = Object.freeze([
  'mitigate_burnout',
  'lower_insurance_premiums',
  'boost_talent_retention',
  'hybrid_social_engagement',
  'reduce_absenteeism',
  'improve_productivity',
]);

// Share of enrolled staff expected to be active for a programme to be on track.
export const ENGAGEMENT_TARGET_PCT = 75;

// Billing-cycle length in months, used to scale a monthly seat price.
export const BILLING_CYCLE_MONTHS = Object.freeze({ monthly: 1, quarterly: 3, annually: 12 });

/**
 * Absenteeism drop index — estimates sick days avoided from check-in frequency.
 * 3 percentage points per weekly visit, capped at the 30% ceiling that
 * corporate wellness literature treats as the realistic upper bound.
 */
export function calculateAbsenteeismDrop({ avgVisitsPerWeek, baselineSickDays = 7 }) {
  if (!Number.isFinite(avgVisitsPerWeek) || avgVisitsPerWeek <= 0) {
    return { dropPct: 0, estimatedDaysReduced: 0 };
  }
  const dropPct = Math.min(30, Math.round(avgVisitsPerWeek * 3));
  return {
    dropPct,
    estimatedDaysReduced: Math.round(baselineSickDays * (dropPct / 100)),
  };
}

/** Engagement rate — active employees as a percentage of provisioned seats. */
export function calculateEngagementRate({ activeCount, totalCount }) {
  if (!totalCount) return 0;
  return Math.round((activeCount / totalCount) * 100);
}

/**
 * Split a seat bill between employer and employee for one billing cycle.
 * `perSeatMonthlyTzs` comes from settingsService.priceForTier(tier).
 */
export function calculateBill({ perSeatMonthlyTzs, seatCount, subsidyModel, billingCycle = 'monthly' }) {
  const employerShareRate = SUBSIDY_MODELS[subsidyModel];
  if (employerShareRate === undefined) throw new Error(`unknown subsidy model: ${subsidyModel}`);
  const months = BILLING_CYCLE_MONTHS[billingCycle];
  if (!months) throw new Error(`unknown billing cycle: ${billingCycle}`);
  if (!Number.isFinite(perSeatMonthlyTzs) || perSeatMonthlyTzs < 0) throw new Error('invalid per-seat price');
  if (!Number.isInteger(seatCount) || seatCount < 0) throw new Error('invalid seat count');

  const grossTzs = perSeatMonthlyTzs * months * seatCount;
  const employerTzs = Math.round(grossTzs * employerShareRate);

  return {
    seatCount,
    perSeatMonthlyTzs,
    months,
    billingCycle,
    subsidyModel,
    grossTzs,
    employerTzs,
    employeeTzs: grossTzs - employerTzs,
    currency: 'TZS',
  };
}
