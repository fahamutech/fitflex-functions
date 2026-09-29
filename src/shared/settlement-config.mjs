// Settlement configuration resolvers — pure logic (Phase 1).
//
// Turn effective-dated configuration (settlement rules, gym rate cards, pass
// tier versions) into the immutable snapshots settlement-engine.mjs consumes.
// Everything is resolved as of the member-cycle start date in EAT (DR-10), so
// a later configuration change never alters an earlier cycle's calculation.
// No database or clock: callers pass the rows and the date.
//
// Dates are EAT calendar days "YYYY-MM-DD". A row applies on day D when
// effectiveFrom <= D and (effectiveTo is null or D < effectiveTo).

import { localDay } from './member-progress.mjs';

export const RULE_SCOPE = Object.freeze({
  GLOBAL:           'global',
  PASS_TIER:        'pass_tier',
  GYM_TIER:         'gym_tier',
  GYM:              'gym',
  SPECIAL_CONTRACT: 'special_contract'   // reserved: never resolved in MVP (DR-10)
});

export const REIMBURSEMENT_FIELDS = Object.freeze([
  'dailyDiscountBps', 'weeklyDiscountBps', 'monthlyDiscountBps',
  'dailyCeilingTzs', 'weeklyCeilingTzs', 'monthlyCeilingTzs'
]);

// Most specific first. Only these scopes are active in MVP:
// reimbursement GLOBAL < GYM_TIER < GYM (DR-06, DR-10); network % GLOBAL <
// PASS_TIER (DR-07). A rule at any other scope is ignored for that field.
const REIMBURSEMENT_PRECEDENCE = Object.freeze([RULE_SCOPE.GYM, RULE_SCOPE.GYM_TIER, RULE_SCOPE.GLOBAL]);
const NETWORK_PRECEDENCE = Object.freeze([RULE_SCOPE.PASS_TIER, RULE_SCOPE.GLOBAL]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(date, name) {
  if (typeof date !== 'string' || !DATE_RE.test(date)) throw new TypeError(`${name} must be an EAT date "YYYY-MM-DD" (got ${date})`);
}

/** Is this row active and in effect on EAT day `date`? */
export function isEffectiveOn(row, date) {
  assertDate(date, 'date');
  return row.status === 'active'
    && typeof row.effectiveFrom === 'string' && row.effectiveFrom <= date
    && (row.effectiveTo == null || date < row.effectiveTo);
}

/** DR-10: the rule/rate resolution date of a cycle = its start, as an EAT day. */
export function resolutionDateForCycle(cycleStart) {
  if (Number.isNaN(Date.parse(cycleStart))) throw new TypeError(`cycleStart must be an ISO timestamp (got ${cycleStart})`);
  return localDay(cycleStart);
}

function onlyOne(rows, what) {
  if (rows.length > 1) {
    throw new Error(`overlapping ${what}: ${rows.map(r => `${r.id}@v${r.version ?? '?'}`).join(', ')}`);
  }
  return rows[0] || null;
}

const scopeMatches = (rule, scope, ctx) => {
  if (rule.scopeType !== scope) return false;
  switch (scope) {
    case RULE_SCOPE.GLOBAL:    return true;
    case RULE_SCOPE.PASS_TIER: return rule.scopeId === ctx.passTier;
    case RULE_SCOPE.GYM_TIER:  return rule.scopeId === ctx.gymTier;
    case RULE_SCOPE.GYM:       return rule.scopeId === ctx.gymId;
    default:                   return false;
  }
};

/**
 * Field-level precedence (DR-10): each field comes from the most specific
 * effective rule that sets it (null/undefined = inherit). Two effective rules
 * at the same scope for the same target are a configuration error.
 */
function resolveFields({ rules, date, fields, precedence, ctx, family }) {
  const effective = rules.filter(r => isEffectiveOn(r, date));
  const values = {};
  const sources = {};
  const missing = [];
  for (const field of fields) {
    let found = false;
    for (const scope of precedence) {
      const rule = onlyOne(effective.filter(r => scopeMatches(r, scope, ctx) && r[field] != null), `${family} rules for ${field} at ${scope}`);
      if (rule) {
        values[field] = rule[field];
        sources[field] = { ruleId: rule.id, version: rule.version ?? null, scopeType: rule.scopeType, scopeId: rule.scopeId ?? null };
        found = true;
        break;
      }
    }
    if (!found) missing.push(field);
  }
  return { values, sources, missing };
}

/** Discounts and ceilings for one gym (gym tier drives ceilings, DR-06). */
export function resolveReimbursementRule({ rules, date, gymTier, gymId }) {
  return resolveFields({ rules, date, fields: REIMBURSEMENT_FIELDS, precedence: REIMBURSEMENT_PRECEDENCE, ctx: { gymTier, gymId }, family: 'reimbursement' });
}

/** Network payout % for a pass tier (GLOBAL + PASS_TIER only, DR-07). */
export function resolveNetworkPayoutBps({ rules, date, passTier }) {
  const r = resolveFields({ rules, date, fields: ['networkPayoutBps'], precedence: NETWORK_PRECEDENCE, ctx: { passTier }, family: 'network' });
  return { networkPayoutBps: r.values.networkPayoutBps ?? null, source: r.sources.networkPayoutBps ?? null, missing: r.missing };
}

/** The gym's rate card in effect on `date`, or null. */
export function resolveRateCard({ rateCards, gymId, date }) {
  return onlyOne(rateCards.filter(c => c.gymId === gymId && isEffectiveOn(c, date)), `rate cards for gym ${gymId}`);
}

/** The pass tier version (price, allowance) in effect on `date`, or null (DR-22). */
export function resolvePassTierVersion({ passTierVersions, tierKey, date }) {
  return onlyOne(passTierVersions.filter(v => v.tierKey === tierKey && isEffectiveOn(v, date)), `pass tier versions for ${tierKey}`);
}

/**
 * The discounts and ceilings to copy onto a gym rate card when it is approved
 * (DR-23): the rules in force on the card's effectiveFrom, for the card's gym
 * tier and gym. Returns { values, sources, missing }; approve only when
 * `missing` is empty. A later rule change never edits an approved card: it
 * needs a new card version from the rule's effective date.
 */
export function deriveRateCardRuleValues({ rules, effectiveFrom, gymTier, gymId }) {
  assertDate(effectiveFrom, 'effectiveFrom');
  return resolveReimbursementRule({ rules, date: effectiveFrom, gymTier, gymId });
}

/**
 * The immutable rate snapshot the engine needs for one gym: the gym's card in
 * force on the cycle start (DR-10), with the retail rates and the discounts
 * and ceilings copied onto it when it was approved (DR-23). Returns
 * { snapshot } or { error, missing } — never a partial snapshot, so a gym is
 * held rather than paid on a guess.
 */
export function resolveGymRateSnapshot({ rateCards, gymId, date }) {
  const card = resolveRateCard({ rateCards, gymId, date });
  if (!card) return { error: 'no_rate_card', missing: [] };
  const missing = REIMBURSEMENT_FIELDS.filter(f => card[f] == null);
  if (missing.length) return { error: 'rate_card_incomplete', missing };
  return {
    snapshot: Object.freeze({
      gymId, gymTier: card.gymTier, rateCardId: card.id, rateCardVersion: card.version ?? null,
      retailDailyTzs: card.retailDailyTzs, retailWeeklyTzs: card.retailWeeklyTzs, retailMonthlyTzs: card.retailMonthlyTzs,
      ...Object.fromEntries(REIMBURSEMENT_FIELDS.map(f => [f, card[f]])),
      ruleSources: card.ruleSources ? Object.freeze({ ...card.ruleSources }) : null
    })
  };
}

/**
 * The member side of a cycle (DR-05, DR-06, DR-22): allowance and catalogue
 * price come from the pass tier version, the network % from the rules, and the
 * cap basis is the amount actually collected and approved (never the
 * catalogue price). Returns { terms } or { error, missing }.
 */
export function resolveMemberCycleTerms({ passTierVersions, rules, passTier, cycleStart, collectedApprovedAmountTzs }) {
  const date = resolutionDateForCycle(cycleStart);
  const version = resolvePassTierVersion({ passTierVersions, tierKey: passTier, date });
  if (!version) return { error: 'no_pass_tier_version', missing: [] };
  const net = resolveNetworkPayoutBps({ rules, date, passTier });
  if (net.missing.length) return { error: 'rule_missing', missing: net.missing };
  return {
    terms: Object.freeze({
      passTier, resolutionDate: date,
      passTierVersion: version.version ?? null,
      catalogPriceTzs: version.priceTzs,
      visitAllowance: version.visitAllowance,
      networkPayoutBps: net.networkPayoutBps,
      networkPayoutSource: net.source,
      collectedApprovedAmountTzs
    })
  };
}

/**
 * DR-08 placeholder for the later payout workflow: legacy partners may be
 * paid without a verified settlement account only until a FIXED grace end
 * date, which the workflow must supply. There is no default date and no
 * permanent exemption: without a date the grace is simply not active.
 */
export function legacyKycGraceActive({ legacyKycGraceEndsAt, at }) {
  if (legacyKycGraceEndsAt == null) return false;
  const end = Date.parse(legacyKycGraceEndsAt);
  const now = Date.parse(at);
  if (Number.isNaN(end)) throw new TypeError(`legacyKycGraceEndsAt must be an ISO timestamp (got ${legacyKycGraceEndsAt})`);
  if (Number.isNaN(now)) throw new TypeError(`at must be an ISO timestamp (got ${at})`);
  return now < end;
}
