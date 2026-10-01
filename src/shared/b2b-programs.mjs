// B2B Phase 2 — wellness programme and benefit rules. Pure data and functions.
//
// These are the rules a later usage engine (Phase 3) consumes: who is eligible,
// what share of a price the sponsor and the beneficiary each pay, and which
// usage window a day falls in. Nothing here counts usage or moves money, and
// provider payouts stay with the settlement engine (src/shared/settlement-*).
//
// Money is whole TZS, shares are basis points, days are EAT "YYYY-MM-DD"
// with inclusive ends (same as challenges and settlement configuration).
import { addDays, weekStart } from './member-progress.mjs';
import { GYM_TIERS } from './constants.mjs';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDay = v => typeof v === 'string' && DAY_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
  && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

export const PROGRAM_TYPES = Object.freeze({
  wellness: 'Wellness',
  fitness: 'Fitness',
  employee_wellness: 'Employee wellness',
  member_wellness: 'Member wellness',
  insurance_wellness: 'Insurance wellness',
  campaign: 'Campaign',
  other: 'Other',
});

// Who may make each move is decided in the service: → active needs FitFlex.
export const PROGRAM_TRANSITIONS = Object.freeze({
  draft: ['pending', 'cancelled'],
  pending: ['draft', 'active', 'cancelled'],
  active: ['paused', 'cancelled'],
  paused: ['active', 'cancelled'],
  expired: [],
  cancelled: [],
});
export const PROGRAM_STATUS = Object.freeze(Object.keys(PROGRAM_TRANSITIONS));
export const CLOSED_PROGRAM_STATUSES = Object.freeze(['expired', 'cancelled']);
// While live, only these programme fields may change (no destructive edits).
export const LIVE_PROGRAM_FIELDS = Object.freeze(['name', 'description', 'endDate', 'budgetTzs']);

export const BENEFIT_TRANSITIONS = Object.freeze({
  draft: ['active', 'inactive'],
  active: ['inactive'],
  inactive: ['active'],
});
export const BENEFIT_STATUS = Object.freeze(Object.keys(BENEFIT_TRANSITIONS));
// An active benefit of a live programme only changes wording; funding, limits,
// providers and dates change after deactivating it.
export const LIVE_BENEFIT_FIELDS = Object.freeze(['name', 'description', 'terms']);

/**
 * Benefit types and the existing FitFlex capability that will fulfil each.
 * `providerKeys` are the provider-rule lists a benefit of that type may use.
 */
export const BENEFIT_TYPES = Object.freeze({
  gym_access: { label: 'Gym access', fulfilledBy: 'Gym check-in (Checkin)', providerKeys: ['gymIds', 'gymTiers'] },
  trainer_session: { label: 'Trainer sessions', fulfilledBy: 'Trainer booking (TrainerBooking)', providerKeys: ['trainerIds'] },
  challenge: { label: 'Challenge access', fulfilledBy: 'Challenges and challenge rewards', providerKeys: ['challengeIds'] },
  marketplace: { label: 'Marketplace', fulfilledBy: 'Shop orders (ShopOrder)', providerKeys: ['vendorIds', 'productCategories'] },
  wellness_activity: { label: 'Wellness activity', fulfilledBy: 'Not in FitFlex yet (events / workshops)', providerKeys: [] },
  custom: { label: 'Custom', fulfilledBy: 'Described in the benefit terms', providerKeys: [] },
});

export const FUNDING_TYPES = Object.freeze({
  full: 'Fully sponsored',
  sponsor_fixed: 'Sponsor pays a fixed amount',
  sponsor_percentage: 'Sponsor pays a percentage',
  beneficiary_fixed: 'Beneficiary pays a fixed copay',
  none: 'No money involved',
});
export const USAGE_PERIODS = Object.freeze(['day', 'week', 'month', 'quarter', 'program', 'unlimited']);

export const ELIGIBILITY_SCOPES = Object.freeze(['all', 'groups', 'selected']);
export const MAX_SELECTED_BENEFICIARIES = 2000;

const fail = (error, extra = {}) => ({ error, status: 400, ...extra });
const strings = v => (Array.isArray(v) ? [...new Set(v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()))] : null);
const wholeTzs = v => Number.isInteger(v) && v >= 0;

// ── Validation ──────────────────────────────────────────────────────────────

/** Programme eligibility → normalised value, or an error. */
export function readEligibility(raw) {
  if (raw === undefined || raw === null) return { value: { scope: 'all', groups: [], beneficiaryIds: [], beneficiaryTypes: [], enrolledOnOrBefore: null } };
  if (typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_eligibility');
  const scope = raw.scope ?? 'all';
  if (!ELIGIBILITY_SCOPES.includes(scope)) return fail('invalid_eligibility_scope', { allowed: ELIGIBILITY_SCOPES });
  const groups = strings(raw.groups ?? []);
  const beneficiaryIds = strings(raw.beneficiaryIds ?? []);
  const beneficiaryTypes = strings(raw.beneficiaryTypes ?? []);
  if (!groups || !beneficiaryIds || !beneficiaryTypes) return fail('invalid_eligibility');
  if (scope === 'groups' && !groups.length) return fail('eligibility_groups_required');
  if (scope === 'selected' && !beneficiaryIds.length) return fail('eligibility_beneficiaries_required');
  if (beneficiaryIds.length > MAX_SELECTED_BENEFICIARIES) return fail('too_many_beneficiaries', { max: MAX_SELECTED_BENEFICIARIES });
  const enrolledOnOrBefore = raw.enrolledOnOrBefore ?? null;
  if (enrolledOnOrBefore !== null && !isDay(enrolledOnOrBefore)) return fail('invalid_enrolled_on_or_before');
  return {
    value: {
      scope,
      groups: scope === 'groups' ? groups : [],
      beneficiaryIds: scope === 'selected' ? beneficiaryIds : [],
      beneficiaryTypes,
      enrolledOnOrBefore,
    },
  };
}

/** Optional benefit-level narrowing: only groups and beneficiary types. */
export function readBenefitEligibility(raw) {
  if (raw === undefined || raw === null) return { value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_benefit_eligibility');
  const groups = strings(raw.groups ?? []);
  const beneficiaryTypes = strings(raw.beneficiaryTypes ?? []);
  if (!groups || !beneficiaryTypes) return fail('invalid_benefit_eligibility');
  return { value: groups.length || beneficiaryTypes.length ? { groups, beneficiaryTypes } : null };
}

/**
 * Funding fields for a benefit → the full set of funding columns (unused ones
 * null), or an error. Mirrors the b2b_benefit_funding_chk constraint.
 */
export function readFunding(body) {
  const fundingType = body.fundingType;
  if (!FUNDING_TYPES[fundingType]) return fail('invalid_funding_type', { allowed: Object.keys(FUNDING_TYPES) });
  const patch = { fundingType, sponsorAmountTzs: null, sponsorShareBps: null, sponsorCapTzs: null, beneficiaryAmountTzs: null };
  if (fundingType === 'sponsor_fixed') {
    if (!wholeTzs(body.sponsorAmountTzs) || body.sponsorAmountTzs === 0) return fail('invalid_sponsor_amount');
    patch.sponsorAmountTzs = body.sponsorAmountTzs;
  }
  if (fundingType === 'sponsor_percentage') {
    const bps = body.sponsorShareBps;
    if (!Number.isInteger(bps) || bps < 0 || bps > 10000) return fail('invalid_sponsor_share', { min: 0, max: 10000 });
    patch.sponsorShareBps = bps;
    if (body.sponsorCapTzs !== undefined && body.sponsorCapTzs !== null) {
      if (!wholeTzs(body.sponsorCapTzs)) return fail('invalid_sponsor_cap');
      patch.sponsorCapTzs = body.sponsorCapTzs;
    }
  }
  if (fundingType === 'beneficiary_fixed') {
    if (!wholeTzs(body.beneficiaryAmountTzs)) return fail('invalid_beneficiary_amount');
    patch.beneficiaryAmountTzs = body.beneficiaryAmountTzs;
  }
  return { patch };
}

/** Usage-limit fields → columns, or an error. Mirrors the usage constraints. */
export function readUsage(body, fundingType) {
  const usagePeriod = body.usagePeriod ?? 'unlimited';
  if (!USAGE_PERIODS.includes(usagePeriod)) return fail('invalid_usage_period', { allowed: USAGE_PERIODS });
  const usageLimit = body.usageLimit ?? null;
  const periodSponsorCapTzs = body.periodSponsorCapTzs ?? null;
  if (usageLimit !== null && (!Number.isInteger(usageLimit) || usageLimit < 1)) return fail('invalid_usage_limit');
  if (periodSponsorCapTzs !== null && !wholeTzs(periodSponsorCapTzs)) return fail('invalid_period_sponsor_cap');
  if (usagePeriod === 'unlimited' && (usageLimit !== null || periodSponsorCapTzs !== null)) return fail('unlimited_has_no_limits');
  if (fundingType === 'none' && periodSponsorCapTzs !== null) return fail('no_sponsor_money_to_cap');
  return { patch: { usagePeriod, usageLimit, periodSponsorCapTzs } };
}

/** Provider rules → normalised shape for the benefit type, or an error. Existence is checked by the service. */
export function readProviderRules(benefitType, raw) {
  const keys = BENEFIT_TYPES[benefitType]?.providerKeys ?? [];
  if (raw === undefined || raw === null || raw.scope === 'all' || (!keys.length && !raw.scope)) return { value: { scope: 'all' } };
  if (typeof raw !== 'object' || Array.isArray(raw) || raw.scope !== 'selected') return fail('invalid_provider_rules');
  if (!keys.length) return fail('provider_rules_not_supported', { benefitType });
  const unknown = Object.keys(raw).filter(k => k !== 'scope' && !keys.includes(k));
  if (unknown.length) return fail('invalid_provider_rules', { unknown, allowed: keys });
  const value = { scope: 'selected' };
  for (const k of keys) {
    const list = strings(raw[k] ?? []);
    if (!list) return fail('invalid_provider_rules', { field: k });
    if (list.length) value[k] = list;
  }
  if (Object.keys(value).length === 1) return fail('provider_rules_empty', { allowed: keys });
  if (value.gymTiers?.some(t => !GYM_TIERS.includes(t))) return fail('invalid_gym_tier', { allowed: GYM_TIERS });
  return { value };
}

// ── Money ───────────────────────────────────────────────────────────────────

/**
 * Split one use's price between sponsor and beneficiary. The two always add
 * up to the price and neither is negative. Per-period money caps
 * (periodSponsorCapTzs) need usage history and are applied by Phase 3.
 */
export function calculateResponsibility({ benefit, priceTzs }) {
  if (!Number.isInteger(priceTzs) || priceTzs < 0) throw new Error('invalid price');
  let sponsorTzs;
  switch (benefit.fundingType) {
    case 'full': sponsorTzs = priceTzs; break;
    case 'sponsor_fixed': sponsorTzs = Math.min(priceTzs, benefit.sponsorAmountTzs); break;
    case 'sponsor_percentage': {
      sponsorTzs = Math.round((priceTzs * benefit.sponsorShareBps) / 10000);
      if (benefit.sponsorCapTzs !== null && benefit.sponsorCapTzs !== undefined) sponsorTzs = Math.min(sponsorTzs, benefit.sponsorCapTzs);
      break;
    }
    case 'beneficiary_fixed': sponsorTzs = Math.max(0, priceTzs - benefit.beneficiaryAmountTzs); break;
    case 'none': sponsorTzs = 0; break;
    default: throw new Error(`unknown funding type: ${benefit.fundingType}`);
  }
  return { priceTzs, sponsorTzs, beneficiaryTzs: priceTzs - sponsorTzs, fundingType: benefit.fundingType, currency: 'TZS' };
}

/** One-line description of a benefit's funding, for lists. */
export function describeFunding(b) {
  const tzs = n => `TZS ${Number(n).toLocaleString('en-US')}`;
  switch (b.fundingType) {
    case 'full': return 'Sponsor pays 100%';
    case 'sponsor_fixed': return `Sponsor pays up to ${tzs(b.sponsorAmountTzs)}; beneficiary pays the rest`;
    case 'sponsor_percentage': return `Sponsor pays ${b.sponsorShareBps / 100}%${b.sponsorCapTzs != null ? ` (max ${tzs(b.sponsorCapTzs)})` : ''}; beneficiary pays the rest`;
    case 'beneficiary_fixed': return `Beneficiary pays ${tzs(b.beneficiaryAmountTzs)}; sponsor pays the rest`;
    default: return 'No payment';
  }
}

// ── Dates and usage windows ─────────────────────────────────────────────────

/** A benefit's validity: its own dates, else the programme's. */
export function benefitValidity(benefit, program) {
  return { startDate: benefit.startDate ?? program.startDate, endDate: benefit.endDate ?? program.endDate ?? null };
}

const within = (day, { startDate, endDate }) => day >= startDate && (endDate === null || day <= endDate);

/**
 * The usage window (inclusive EAT days) that `day` falls in, clipped to the
 * benefit's validity — what Phase 3 counts usage against. Null = unlimited.
 */
export function usageWindow({ benefit, program, day }) {
  const valid = benefitValidity(benefit, program);
  let start;
  let end;
  switch (benefit.usagePeriod) {
    case 'unlimited': return null;
    case 'day': start = day; end = day; break;
    case 'week': start = weekStart(day); end = addDays(start, 6); break;
    case 'month': {
      start = `${day.slice(0, 7)}-01`;
      const next = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7), 1));
      end = addDays(next.toISOString().slice(0, 10), -1);
      break;
    }
    case 'quarter': {
      const q = Math.floor((+day.slice(5, 7) - 1) / 3);
      start = `${day.slice(0, 4)}-${String(q * 3 + 1).padStart(2, '0')}-01`;
      const next = new Date(Date.UTC(+day.slice(0, 4), q * 3 + 3, 1));
      end = addDays(next.toISOString().slice(0, 10), -1);
      break;
    }
    case 'program': start = valid.startDate; end = valid.endDate; break;
    default: throw new Error(`unknown usage period: ${benefit.usagePeriod}`);
  }
  if (start < valid.startDate) start = valid.startDate;
  if (valid.endDate !== null && (end === null || end > valid.endDate)) end = valid.endDate;
  return { start, end, usageLimit: benefit.usageLimit ?? null, periodSponsorCapTzs: benefit.periodSponsorCapTzs ?? null };
}

/** `expired` once a live programme's last day has passed. */
export function programEffectiveStatus(program, today) {
  if (['active', 'paused'].includes(program.status) && program.endDate && program.endDate < today) return 'expired';
  return program.status;
}

// ── Eligibility ─────────────────────────────────────────────────────────────

/** Does a beneficiary fall inside a programme's population (ignoring dates and statuses of the programme)? */
export function matchesPopulation({ program, beneficiary, benefit = null }) {
  const rule = program.eligibility || { scope: 'all' };
  if (rule.scope === 'groups' && !(rule.groups || []).includes(beneficiary.groupName)) return 'not_in_group';
  if (rule.scope === 'selected' && !(rule.beneficiaryIds || []).includes(beneficiary.id)) return 'not_selected';
  if ((rule.beneficiaryTypes || []).length && !rule.beneficiaryTypes.includes(beneficiary.beneficiaryType)) return 'beneficiary_type_not_eligible';
  if (rule.enrolledOnOrBefore) {
    const enrolled = beneficiary.enrolledAt ? String(beneficiary.enrolledAt).slice(0, 10) : null;
    if (!enrolled || enrolled > rule.enrolledOnOrBefore) return 'enrolled_too_late';
  }
  const narrow = benefit?.eligibility;
  if (narrow?.groups?.length && !narrow.groups.includes(beneficiary.groupName)) return 'benefit_not_for_group';
  if (narrow?.beneficiaryTypes?.length && !narrow.beneficiaryTypes.includes(beneficiary.beneficiaryType)) return 'benefit_not_for_beneficiary_type';
  return null;
}

/**
 * The Phase 3 gate, minus usage counting: may this beneficiary use this
 * benefit (or, without a benefit, take part in this programme) on `day`?
 * Returns { eligible, reason } — reason names the first check that failed.
 */
export function evaluateEligibility({ program, benefit = null, beneficiary, day }) {
  const no = reason => ({ eligible: false, reason });
  if (!beneficiary || beneficiary.status !== 'active') return no('beneficiary_not_active');
  const status = programEffectiveStatus(program, day);
  if (status !== 'active') return no(status === 'expired' ? 'program_expired' : 'program_not_active');
  if (!within(day, { startDate: program.startDate, endDate: program.endDate ?? null })) return no('outside_program_dates');
  if (benefit) {
    if (benefit.status !== 'active') return no('benefit_not_active');
    if (!within(day, benefitValidity(benefit, program))) return no('outside_benefit_dates');
  }
  const mismatch = matchesPopulation({ program, beneficiary, benefit });
  if (mismatch) return no(mismatch);
  return { eligible: true, reason: null };
}

// ── Consumption (Phase 3) ───────────────────────────────────────────────────

export const CONSUMPTION_STATUS = Object.freeze(['pending', 'approved', 'rejected', 'reversed', 'cancelled']);
// Rows that hold allowance and sponsor money.
export const LIVE_CONSUMPTION_STATUSES = Object.freeze(['pending', 'approved']);

/** Existing usage events a consumption can point at, and the benefit type each can use. */
export const USAGE_SOURCES = Object.freeze({
  gym_checkin: { serviceType: 'gym_access', providerType: 'gym', table: 'Checkin' },
  trainer_booking: { serviceType: 'trainer_session', providerType: 'trainer', table: 'TrainerBooking' },
});

/** Retail value of one gym visit: the gym's day rate (never a payout figure). */
export function gymVisitValueTzs(gym) {
  const value = Math.round(Number(gym?.ratePerDay ?? gym?.perVisitRate ?? 0));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Does the benefit's provider rule allow this provider? `provider` is
 * { type: 'gym', id, tier } or { type: 'trainer', id }. With several lists, a
 * provider qualifies by matching any one of them (a listed gym OR a listed tier).
 */
export function providerMatches(benefit, provider) {
  const rules = benefit.providerRules || { scope: 'all' };
  if (rules.scope !== 'selected') return true;
  if (provider.type === 'gym') {
    return (rules.gymIds || []).includes(provider.id) || (!!provider.tier && (rules.gymTiers || []).includes(provider.tier));
  }
  if (provider.type === 'trainer') return (rules.trainerIds || []).includes(provider.id);
  return false;
}

/**
 * Deterministic choice between benefits that could each cover one usage.
 * Exactly one is ever applied (no stacking): the one that leaves the member
 * paying least; if equal, an employer's; then the older programme; then id.
 * Each candidate is { organization, program, benefit, split }.
 */
export function orderCandidates(candidates) {
  const employerFirst = c => (c.organization.organizationType === 'employer' ? 0 : 1);
  return [...candidates].sort((a, b) =>
    a.split.beneficiaryTzs - b.split.beneficiaryTzs
    || employerFirst(a) - employerFirst(b)
    || String(a.program.createdAt ?? '').localeCompare(String(b.program.createdAt ?? ''))
    || String(a.benefit.id).localeCompare(String(b.benefit.id)));
}

/**
 * Apply the allowance to one use, given what the ledger already holds in the
 * benefit's window. Returns { ok, sponsorTzs, beneficiaryTzs, remaining } or
 * { ok: false, reason }. A per-period sponsor cap covers what is left of it
 * (the member pays the rest); a count limit is all-or-nothing.
 */
export function applyAllowance({ benefit, split, quantity = 1, used }) {
  const limit = benefit.usageLimit ?? null;
  if (limit !== null && used.quantity + quantity > limit) return { ok: false, reason: 'usage_limit_reached' };
  let sponsorTzs = split.sponsorTzs;
  const cap = benefit.periodSponsorCapTzs ?? null;
  if (cap !== null) {
    const left = Math.max(0, cap - used.sponsorTzs);
    if (left === 0 && sponsorTzs > 0) return { ok: false, reason: 'period_sponsor_cap_reached' };
    sponsorTzs = Math.min(sponsorTzs, left);
  }
  return {
    ok: true,
    sponsorTzs,
    beneficiaryTzs: split.priceTzs - sponsorTzs,
    remaining: {
      uses: limit === null ? null : limit - used.quantity - quantity,
      sponsorTzs: cap === null ? null : cap - used.sponsorTzs - sponsorTzs,
    },
  };
}

/** What Phase 4 settlement reads from an approved consumption. No payout figures. */
export function settlementCandidate(row) {
  return {
    consumptionId: row.id,
    organizationId: row.organizationId,
    programId: row.programId,
    benefitId: row.benefitId,
    beneficiaryId: row.beneficiaryId,
    userId: row.userId,
    providerType: row.providerType,
    providerId: row.providerId,
    serviceType: row.serviceType,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    consumedAt: row.consumedAt,
    businessDate: row.businessDate,
    quantity: row.quantity,
    grossTzs: row.grossTzs,
    sponsorTzs: row.sponsorTzs,
    beneficiaryTzs: row.beneficiaryTzs,
    currency: 'TZS',
    status: row.status,
    verifiedAt: row.verifiedAt,
    settleable: row.status === 'approved',
  };
}
