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

export const SCOPES = ['gym', 'platform'];
const BOTH = ['gym', 'platform'];
const PLATFORM = ['platform'];

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
  joinedDaysAgo: { type: 'number', scopes: BOTH },
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
});

export const MAX_DEPTH = 3;
export const MAX_CONDITIONS = 25;
const MAX_LIST = 50;
const MAX_TEXT = 100;
const MAX_NUMBER = 100_000;
const MAX_KM = 500;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const bad = (detail) => ({ error: 'invalid_audience', status: 400, detail });
const isDay = (v) => typeof v === 'string' && DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
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

/** Whole years between a "YYYY-MM-DD" birth date and a local day, or null. */
export function ageOn(dateOfBirth, today) {
  if (!isDay(dateOfBirth) || !isDay(today) || dateOfBirth > today) return null;
  const [by, bm, bd] = dateOfBirth.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}
