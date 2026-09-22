// FitFlex Af — Corporate Wellness Constants

// ─────────────────────────────────────────────────────────────────────────────
// Industry Sectors
// ─────────────────────────────────────────────────────────────────────────────
export const INDUSTRY_SECTORS = {
  banking: 'Banking & Financial Services',
  ngo: 'NGO & Development Agency',
  hospitality: 'Hospitality & Tourism',
  insurance: 'Insurance',
  telecom: 'Telecom & Tech',
  manufacturing: 'Manufacturing & Energy',
  government: 'Government & Public Sector',
  other: 'Other'
};

// ─────────────────────────────────────────────────────────────────────────────
// Workforce Brackets
// ─────────────────────────────────────────────────────────────────────────────
export const WORKFORCE_BRACKETS = {
  '50-100': '50 - 100 employees',
  '100-250': '100 - 250 employees',
  '250-500': '250 - 500 employees',
  '500-1000': '500 - 1,000 employees',
  '1000+': '1,000+ employees'
};

// ─────────────────────────────────────────────────────────────────────────────
// Subsidy Models
// ─────────────────────────────────────────────────────────────────────────────
export const SUBSIDY_MODELS = {
  FULLY_FUNDED: 'fully_funded',   // 100% employer pays
  CO_PAY_50_50: 'copay_50_50',    // 50/50 split
  CO_PAY_70_30: 'copay_70_30',    // 70% employer, 30% employee
  EMPLOYEE_PAID: 'employee_paid'  // employer provides platform access, employee pays subscription
};

// ─────────────────────────────────────────────────────────────────────────────
// Corporate Status
// ─────────────────────────────────────────────────────────────────────────────
export const CORPORATE_STATUS = {
  PENDING: 'pending',
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  TERMINATED: 'terminated'
};

// ─────────────────────────────────────────────────────────────────────────────
// Employee Status
// ─────────────────────────────────────────────────────────────────────────────
export const EMPLOYEE_STATUS = {
  PENDING: 'pending',         // provisioned but not yet activated
  ACTIVE: 'active',           // actively using the platform
  SUSPENDED: 'suspended',     // temporarily disabled
  EXITED: 'exited'            // left the company
};

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard Modes
// ─────────────────────────────────────────────────────────────────────────────
export const DASHBOARD_MODES = {
  EMPLOYER: 'employer',   // HR view — staff productivity, engagement, retention
  INSURER: 'insurer'       // Insurance view — claims reduction, actuarial metrics
};

// ─────────────────────────────────────────────────────────────────────────────
// HR Objectives
// ─────────────────────────────────────────────────────────────────────────────
export const HR_OBJECTIVES = [
  'mitigate_burnout',
  'lower_insurance_premiums',
  'boost_talent_retention',
  'hybrid_social_engagement',
  'reduce_absenteeism',
  'improve_productivity'
];

// ─────────────────────────────────────────────────────────────────────────────
// Engagement Target (% of enrolled staff actively using the platform)
// ─────────────────────────────────────────────────────────────────────────────
export const ENGAGEMENT_TARGET_PCT = 75;

// ─────────────────────────────────────────────────────────────────────────────
// Corporate Pass Tier Mapping
// Corporate employees get the same Pass tiers as regular members.
// The employer subsidizes a specific tier level.
// ─────────────────────────────────────────────────────────────────────────────
export const CORPORATE_PASS_TIERS = {
  basic: { price: 60000, visitsAllowed: 20 },
  pro: { price: 120000, visitsAllowed: 30 },
  premium: { price: 200000, visitsAllowed: 40 },
  executive: { price: 350000, visitsAllowed: null }  // unlimited
};

// ─────────────────────────────────────────────────────────────────────────────
// Billing Cycle
// ─────────────────────────────────────────────────────────────────────────────
export const BILLING_CYCLE = {
  MONTHLY: 'monthly',
  QUARTERLY: 'quarterly',
  ANNUALLY: 'annually'
};

// ─────────────────────────────────────────────────────────────────────────────
// Absenteeism Drop Index Calculation
// Estimates reduction in sick-leave days based on gym check-in frequency.
// Formula: (avg_visits_per_week × 0.3) × 52 weeks = estimated sick days reduced per year
// Capped at 30% reduction (industry standard for corporate wellness programs).
// ─────────────────────────────────────────────────────────────────────────────
export function calculateAbsenteeismDrop({ avgVisitsPerWeek, baselineSickDays }) {
  if (!avgVisitsPerWeek || avgVisitsPerWeek <= 0) return { dropPct: 0, estimatedDaysReduced: 0 };
  const dropPct = Math.min(30, Math.round(avgVisitsPerWeek * 3)); // 3% per visit/week, cap at 30%
  const estimatedDaysReduced = Math.round((baselineSickDays || 7) * (dropPct / 100));
  return { dropPct, estimatedDaysReduced };
}

// ─────────────────────────────────────────────────────────────────────────────
// Engagement Rate Calculation
// (active employees / total provisioned employees) × 100
// ─────────────────────────────────────────────────────────────────────────────
export function calculateEngagementRate({ activeCount, totalCount }) {
  if (!totalCount || totalCount === 0) return 0;
  return Math.round((activeCount / totalCount) * 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// Monthly Billing Calculation
// ─────────────────────────────────────────────────────────────────────────────
export function calculateMonthlyBill({ tier, seatCount, subsidyModel, billingCycle }) {
  const tierCfg = CORPORATE_PASS_TIERS[tier] || CORPORATE_PASS_TIERS.basic;
  const grossAmount = tierCfg.price * seatCount;

  let employerShare = 0;
  let employeeShare = 0;

  switch (subsidyModel) {
    case SUBSIDY_MODELS.FULLY_FUNDED:
      employerShare = grossAmount;
      employeeShare = 0;
      break;
    case SUBSIDY_MODELS.CO_PAY_50_50:
      employerShare = Math.round(grossAmount * 0.5);
      employeeShare = grossAmount - employerShare;
      break;
    case SUBSIDY_MODELS.CO_PAY_70_30:
      employerShare = Math.round(grossAmount * 0.7);
      employeeShare = grossAmount - employerShare;
      break;
    case SUBSIDY_MODELS.EMPLOYEE_PAID:
      employerShare = 0;
      employeeShare = grossAmount;
      break;
    default:
      employerShare = grossAmount;
      employeeShare = 0;
  }

  // FitFlex platform fee (0% for corporate — per-seat model, not commission)
  const platformFee = 0;
  const netAmount = grossAmount - platformFee;

  return {
    tier,
    seatCount,
    perSeat: tierCfg.price,
    grossAmount,
    employerShare,
    employeeShare,
    platformFee,
    netAmount,
    billingCycle: billingCycle || BILLING_CYCLE.MONTHLY,
    currency: 'TZS'
  };
}
