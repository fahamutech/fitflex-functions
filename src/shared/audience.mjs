// Audiences for member communications — which members a message goes to.
//
// An audience is a preset, a custom filter, or both (AND-ed). A filter is a
// small tree of conditions:
//   { all: [ { field: 'status', op: 'eq', value: 'expired' },
//            { field: 'daysSinceExpiry', op: 'between', value: [0, 30] } ] }
// Groups use `all` (AND) or `any` (OR) and can nest up to MAX_DEPTH.
//
// Conditions are evaluated against per-member facts that the segment
// service builds from the real subscription, check-in and payment records
// (see src/services/segment-service.mjs). Pure functions only.
import { haversineM } from './run-metrics.mjs';
import { isCalendarDay, ageOnDay } from './date-of-birth.mjs';

// `trainers` and `vendors` are FitFlex-only audiences (not members): admins
// send them promotions and news with the same composer. Gyms never address
// either (audienceScope).
export const SCOPES = ['gym', 'platform', 'trainers', 'vendors'];
const BOTH = ['gym', 'platform'];
const PLATFORM = ['platform'];
const TRAINERS = ['trainers'];
const VENDORS = ['vendors'];

/** Who a FitFlex campaign goes to. Gym campaigns always go to members. */
export const RECIPIENTS = Object.freeze(['members', 'trainers', 'vendors']);

const OPS = {
  enum: ['eq', 'neq', 'in', 'not_in', 'exists'],
  text: ['eq', 'neq', 'in', 'not_in', 'exists'],
  number: ['eq', 'gte', 'lte', 'between', 'exists'],
  date: ['before', 'after', 'between', 'exists'],
  area: ['contains', 'within_km', 'exists'],
};

// Every field a condition can use. `scopes` limits platform-only fields
// (area, pass tier…) to FitFlex admins.
export const FIELDS = Object.freeze({
  // Membership
  status: { type: 'enum', scopes: BOTH, values: ['active', 'expiring_soon', 'expired', 'suspended', 'none'] },
  plan: { type: 'enum', scopes: BOTH, values: ['daily', 'weekly', 'monthly'] },
  tier: { type: 'text', scopes: BOTH },
  paymentStatus: { type: 'enum', scopes: BOTH, values: ['approved', 'pending', 'rejected', 'cancelled', 'none'] },
  expiresOn: { type: 'date', scopes: BOTH },
  daysUntilExpiry: { type: 'number', scopes: BOTH },
  daysSinceExpiry: { type: 'number', scopes: BOTH },
  joinedDaysAgo: { type: 'number', scopes: [...BOTH, ...TRAINERS, ...VENDORS] },
  homeGymId: { type: 'text', scopes: BOTH },
  // Engagement (from check-ins; days are East Africa Time days)
  lastVisitDaysAgo: { type: 'number', scopes: BOTH },
  visitsLast30Days: { type: 'number', scopes: BOTH },
  totalVisits: { type: 'number', scopes: BOTH },
  engagement: { type: 'enum', scopes: BOTH, values: ['active', 'slipping', 'at_risk', 'lapsed', 'none'] },
  // Demographics (optional, entered by the member)
  age: { type: 'number', scopes: BOTH },
  gender: { type: 'enum', scopes: BOTH, values: ['male', 'female', 'other'] },
  // FitFlex-wide only
  subscriptionType: { type: 'enum', scopes: PLATFORM, values: ['direct_sub', 'platform_pass', 'trainer_pass', 'credits'] },
  passTier: { type: 'text', scopes: PLATFORM },
  area: { type: 'area', scopes: PLATFORM },
  // Trainers (FitFlex-wide trainer audiences)
  trainerStatus: { type: 'enum', scopes: TRAINERS, values: ['active', 'inactive', 'suspended'] },
  trainerVerified: { type: 'enum', scopes: TRAINERS, values: ['yes', 'no'] },
  trainerApproval: { type: 'enum', scopes: TRAINERS, values: ['approved', 'pending_approval', 'rejected'] },
  // Any trainer pass: active somewhere, awaiting payment, or none.
  trainerPass: { type: 'enum', scopes: TRAINERS, values: ['active', 'pending', 'none'] },
  // Gyms the trainer is linked to (a list: `eq` = linked to that gym).
  linkedGymId: { type: 'text', scopes: TRAINERS },
  // Vendors (FitFlex-wide vendor audiences). A vendor's staff who receive its
  // messages (active staff with vendorRole 'admin') carry the vendor's facts;
  // `vendorRecipient` tells the vendor account and those staff apart.
  vendorApproval: { type: 'enum', scopes: VENDORS, values: ['approved', 'pending_approval', 'rejected'] },
  // Recorded at least one (not voided) walk-in sale in the last 30 days.
  vendorWalkInSales: { type: 'enum', scopes: VENDORS, values: ['yes', 'no'] },
  // Products listed (not deleted) and of those, approved and on sale.
  vendorProducts: { type: 'number', scopes: VENDORS },
  vendorLiveProducts: { type: 'number', scopes: VENDORS },
  // The vendor's business category as typed at onboarding (vendorProfile.businessCategory).
  vendorCategory: { type: 'text', scopes: VENDORS },
  vendorRecipient: { type: 'enum', scopes: VENDORS, values: ['account', 'admin_staff'] },
});

const has = (field, scope) => Boolean(FIELDS[field]?.scopes.includes(scope));
const c = (field, op, value) => ({ field, op, value });

// Starting points offered to owners and admins. Labels live in the apps'
// translations, keyed by preset key.
const VALID_MEMBERSHIP = c('status', 'in', ['active', 'expiring_soon']);
const INACTIVE = {
  any: [
    c('lastVisitDaysAgo', 'gte', 14),
    { all: [c('lastVisitDaysAgo', 'exists', false), c('joinedDaysAgo', 'gte', 14)] },
  ],
};
export const PRESETS = Object.freeze({
  gym: {
    all: { all: [c('status', 'in', ['active', 'expiring_soon', 'expired'])] },
    active: { all: [VALID_MEMBERSHIP] },
    expiring: { all: [c('status', 'eq', 'expiring_soon')] },
    expired: { all: [c('status', 'eq', 'expired')] },
    recently_expired: { all: [c('status', 'eq', 'expired'), c('daysSinceExpiry', 'between', [0, 30])] },
    new: { all: [VALID_MEMBERSHIP, c('joinedDaysAgo', 'lte', 30)] },
    inactive: { all: [VALID_MEMBERSHIP, INACTIVE] },
  },
  platform: {
    all: { all: [c('status', 'neq', 'suspended')] },
    active: { all: [VALID_MEMBERSHIP] },
    pass_holders: { all: [VALID_MEMBERSHIP, c('subscriptionType', 'eq', 'platform_pass')] },
    expiring: { all: [c('status', 'eq', 'expiring_soon')] },
    expired: { all: [c('status', 'eq', 'expired')] },
    recently_expired: { all: [c('status', 'eq', 'expired'), c('daysSinceExpiry', 'between', [0, 30])] },
    no_plan: { all: [c('status', 'eq', 'none')] },
    new: { all: [c('status', 'neq', 'suspended'), c('joinedDaysAgo', 'lte', 30)] },
    inactive: { all: [VALID_MEMBERSHIP, INACTIVE] },
  },
  trainers: {
    all: { all: [c('trainerStatus', 'eq', 'active')] },
    verified: { all: [c('trainerStatus', 'eq', 'active'), c('trainerVerified', 'eq', 'yes')] },
    with_pass: { all: [c('trainerStatus', 'eq', 'active'), c('trainerPass', 'eq', 'active')] },
    no_gym: { all: [c('trainerStatus', 'eq', 'active'), c('linkedGymId', 'exists', false)] },
    new: { all: [c('trainerStatus', 'eq', 'active'), c('joinedDaysAgo', 'lte', 30)] },
  },
  // Suspended and closed vendors (and their staff) are never in a vendor audience;
  // `all` also leaves out vendors whose application was rejected.
  vendors: {
    all: { all: [c('vendorApproval', 'in', ['approved', 'pending_approval'])] },
    approved: { all: [c('vendorApproval', 'eq', 'approved')] },
    pending: { all: [c('vendorApproval', 'eq', 'pending_approval')] },
    walk_in: { all: [c('vendorApproval', 'eq', 'approved'), c('vendorWalkInSales', 'eq', 'yes')] },
    no_live_products: { all: [c('vendorApproval', 'eq', 'approved'), c('vendorLiveProducts', 'eq', 0)] },
    new: { all: [c('vendorApproval', 'in', ['approved', 'pending_approval']), c('joinedDaysAgo', 'lte', 30)] },
  },
});

/** The audience scope for a sender scope + recipients (null when not allowed). */
export function audienceScope(senderScope, recipients = 'members') {
  if (!RECIPIENTS.includes(recipients)) return null;
  if (recipients === 'trainers' || recipients === 'vendors') return senderScope === 'platform' ? recipients : null;
  return senderScope;
}

export const MAX_DEPTH = 3;
export const MAX_CONDITIONS = 25;
const MAX_LIST = 50;
const MAX_TEXT = 100;
const MAX_NUMBER = 100_000;
const MAX_KM = 500;

const bad = (detail) => ({ error: 'invalid_audience', status: 400, detail });
// Strict: a real calendar day (Date.parse would roll 2023-02-31 on to 3 March).
const isDay = isCalendarDay;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_NUMBER;
const isText = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_TEXT;

function checkValue(def, op, value) {
  if (op === 'exists') return typeof value === 'boolean';
  if (def.type === 'enum' || def.type === 'text') {
    const one = def.type === 'enum' ? (v) => def.values.includes(v) : isText;
    if (op === 'in' || op === 'not_in') return Array.isArray(value) && value.length > 0 && value.length <= MAX_LIST && value.every(one);
    return one(value);
  }
  if (def.type === 'number') {
    if (op === 'between') return Array.isArray(value) && value.length === 2 && value.every(isNum) && value[0] <= value[1];
    return isNum(value);
  }
  if (def.type === 'date') {
    if (op === 'between') return Array.isArray(value) && value.length === 2 && value.every(isDay) && value[0] <= value[1];
    return isDay(value);
  }
  if (op === 'contains') return isText(value);
  return value && isText(value.gymId) && isNum(value.km) && value.km > 0 && value.km <= MAX_KM;
}

/**
 * Checks a filter against the field catalogue for a scope and returns a
 * clean copy. Unknown fields, platform-only fields in a gym audience, bad
 * operators or values, and over-large trees are refused.
 * @returns {{ filter: object } | { error: string, status: number, detail: string }}
 */
export function validateFilter(input, scope) {
  if (!SCOPES.includes(scope)) return bad('unknown_scope');
  if (input == null) return { filter: { all: [] } };
  let conditions = 0;
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return bad('group_must_be_object');
    const keys = Object.keys(node);
    if (keys.length === 1 && (keys[0] === 'all' || keys[0] === 'any')) {
      if (depth >= MAX_DEPTH) return bad('too_deep');
      const items = node[keys[0]];
      if (!Array.isArray(items)) return bad('group_must_be_array');
      if (keys[0] === 'any' && items.length === 0) return bad('empty_any');
      const out = [];
      for (const item of items) {
        const r = walk(item, depth + 1);
        if (r.error) return r;
        out.push(r.node);
      }
      return { node: { [keys[0]]: out } };
    }
    if (depth === 0) return bad('root_must_be_group');
    const { field, op, value } = node;
    if (!FIELDS[field]) return bad(`unknown_field:${field}`);
    if (!has(field, scope)) return bad(`field_not_allowed:${field}`);
    if (!OPS[FIELDS[field].type].includes(op)) return bad(`bad_operator:${field}:${op}`);
    if (!checkValue(FIELDS[field], op, value)) return bad(`bad_value:${field}`);
    conditions += 1;
    if (conditions > MAX_CONDITIONS) return bad('too_many_conditions');
    return { node: c(field, op, value) };
  };
  const r = walk(input, 0);
  return r.error ? r : { filter: r.node };
}

/**
 * The filter for a preset and/or a custom filter, AND-ed together.
 * @returns {{ filter: object } | { error: string, status: number, detail: string }}
 */
export function buildAudienceFilter({ preset, filter } = {}, scope) {
  const parts = [];
  if (preset != null) {
    const p = PRESETS[scope]?.[preset];
    if (!p) return bad(`unknown_preset:${preset}`);
    parts.push(p);
  }
  if (filter != null) {
    const v = validateFilter(filter, scope);
    if (v.error) return v;
    parts.push(v.filter);
  }
  if (!parts.length) return bad('audience_required');
  return { filter: parts.length === 1 ? parts[0] : { all: parts } };
}

function lower(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : v;
}

// A condition on a fact the member doesn't have (no expiry date, never
// visited, no birth date) matches only `exists: false`.
function test(cond, facts, ctx) {
  const actual = cond.field === 'area' ? facts.areaGymId ?? null : facts[cond.field] ?? null;
  const { op, value } = cond;
  // List facts (a trainer's gyms): true when any entry matches; empty = missing.
  if (Array.isArray(actual)) {
    if (op === 'exists') return (actual.length > 0) === value;
    if (op === 'neq' || op === 'not_in') return actual.every(a => test(cond, { ...facts, [cond.field]: a }, ctx));
    return actual.some(a => test(cond, { ...facts, [cond.field]: a }, ctx));
  }
  if (op === 'exists') return (actual !== null) === value;
  if (actual === null) return false;
  const def = FIELDS[cond.field];
  if (def.type === 'area') {
    const gym = ctx.gymsById?.get(actual);
    if (op === 'contains') return Boolean(gym?.location && lower(gym.location).includes(lower(value)));
    const from = coords(gym);
    const to = coords(ctx.gymsById?.get(value.gymId));
    return Boolean(from && to && haversineM(from, to) <= value.km * 1000);
  }
  const a = def.type === 'text' ? lower(actual) : actual;
  const v = def.type === 'text' ? (Array.isArray(value) ? value.map(lower) : lower(value)) : value;
  switch (op) {
    case 'eq': return a === v;
    case 'neq': return a !== v;
    case 'in': return v.includes(a);
    case 'not_in': return !v.includes(a);
    case 'gte': return a >= v;
    case 'lte': return a <= v;
    case 'before': return a < v;
    case 'after': return a > v;
    case 'between': return a >= v[0] && a <= v[1];
    default: return false;
  }
}

function coords(gym) {
  const lat = Number(gym?.coordinates?.lat);
  const lng = Number(gym?.coordinates?.lng);
  return gym?.coordinates?.lat != null && gym?.coordinates?.lng != null && Number.isFinite(lat) && Number.isFinite(lng)
    ? [lat, lng] : null;
}

/** Whether a member's facts satisfy a validated filter. */
export function matchesFilter(facts, filter, ctx = {}) {
  if (filter.all) return filter.all.every(n => matchesFilter(facts, n, ctx));
  if (filter.any) return filter.any.some(n => matchesFilter(facts, n, ctx));
  return test(filter, facts, ctx);
}

/** Field and preset catalogue for a scope, for building audiences in the apps. */
export function audienceCatalog(scope) {
  return {
    scope,
    presets: Object.entries(PRESETS[scope] || {}).map(([key, filter]) => ({ key, filter })),
    fields: Object.entries(FIELDS)
      .filter(([key]) => has(key, scope))
      .map(([key, def]) => ({ key, type: def.type, ops: OPS[def.type], ...(def.values ? { values: def.values } : {}) })),
    limits: { maxDepth: MAX_DEPTH, maxConditions: MAX_CONDITIONS },
  };
}

/**
 * Whole years between a stored "YYYY-MM-DD" birth date and a local day, or null. The rule is the
 * one in date-of-birth.mjs: an impossible date (2023-02-31), one before 1901-01-01 or one after
 * `today` counts as no birth date, so it never matches an age condition (only `exists: false`).
 */
export const ageOn = (dateOfBirth, today) => ageOnDay(dateOfBirth, today);
