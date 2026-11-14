// Custom gym passes — pure rules (no I/O). Behind GYM_CUSTOM_PASSES.
//
// A gym owner designs a pass: a category (individual / couples / group), a duration and one price in TZS.
// The numbers below are PLATFORM LIMITS (sanity bounds so a typo cannot create a 90,000-day pass or a free one);
// they are not prices or business terms and the owner chooses everything inside them.

export const PASS_CATEGORIES = Object.freeze(['individual', 'couples', 'group']);
export const DURATION_UNITS = Object.freeze(['days', 'weeks', 'months']);
export const PLAN_STATUSES = Object.freeze(['active', 'inactive']);
export const CURRENCY = 'TZS';

export const PASS_LIMITS = Object.freeze({
  nameMin: 2, nameMax: 80,
  descriptionMax: 500,
  termsMax: 4000,
  // Longest pass: two years, whatever the unit.
  durationMax: Object.freeze({ days: 730, weeks: 104, months: 24 }),
  priceMaxTzs: 100_000_000,
  // A group is 3 people or more, up to this many.
  groupMax: 50,
  groupMin: 3,
});

/** The people a category covers: individual 1, couples 2, group 3..groupMax (chosen by the owner). */
export const fixedLimitOf = (category) => ({ individual: 1, couples: 2 })[category] ?? null;

const isInt = (v) => typeof v === 'number' ? Number.isInteger(v) : (typeof v === 'string' && /^\d+$/.test(v.trim()));
const toInt = (v) => (typeof v === 'number' ? v : Number(v.trim()));
const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const bad = (field, reason) => ({ error: 'invalid_field', status: 400, field, ...(reason ? { reason } : {}) });

/**
 * A plan as an owner may create or change it. `prior` (a stored plan) makes this a partial edit: only the fields
 * sent change, and the result is checked as a whole. → { value } | { error, status, field, reason? }
 * The price is the owner's own whole number of TZS, never anything the buyer sends.
 */
export function validatePlanInput(body = {}, prior = null) {
  const b = body && typeof body === 'object' ? body : {};
  const has = (k) => Object.hasOwn(b, k);
  const out = prior ? {
    name: prior.name, description: prior.description ?? null, category: prior.category,
    durationValue: prior.durationValue, durationUnit: prior.durationUnit, beneficiaryLimit: prior.beneficiaryLimit,
    priceTzs: prior.priceTzs, terms: prior.terms ?? null,
  } : { description: null, terms: null };

  if (has('name') || !prior) {
    const name = text(b.name, PASS_LIMITS.nameMax);
    if (!name || name.length < PASS_LIMITS.nameMin) return bad('name', 'name_required');
    out.name = name;
  }
  if (has('description')) {
    if (b.description !== null && b.description !== '' && typeof b.description !== 'string') return bad('description');
    if (typeof b.description === 'string' && b.description.trim().length > PASS_LIMITS.descriptionMax) return bad('description', 'too_long');
    out.description = text(b.description, PASS_LIMITS.descriptionMax);
  }
  if (has('terms')) {
    if (b.terms !== null && b.terms !== '' && typeof b.terms !== 'string') return bad('terms');
    if (typeof b.terms === 'string' && b.terms.trim().length > PASS_LIMITS.termsMax) return bad('terms', 'too_long');
    out.terms = text(b.terms, PASS_LIMITS.termsMax);
  }
  if (has('category') || !prior) {
    if (!PASS_CATEGORIES.includes(b.category)) return bad('category');
    out.category = b.category;
  }
  if (has('durationUnit') || !prior) {
    if (!DURATION_UNITS.includes(b.durationUnit)) return bad('durationUnit');
    out.durationUnit = b.durationUnit;
  }
  if (has('durationValue') || !prior) {
    if (!isInt(b.durationValue) || toInt(b.durationValue) < 1) return bad('durationValue');
    out.durationValue = toInt(b.durationValue);
  }
  if (out.durationValue > PASS_LIMITS.durationMax[out.durationUnit]) return bad('durationValue', 'too_long');
  if (has('priceTzs') || !prior) {
    if (!isInt(b.priceTzs) || toInt(b.priceTzs) < 1) return bad('priceTzs');
    out.priceTzs = toInt(b.priceTzs);
  }
  if (out.priceTzs > PASS_LIMITS.priceMaxTzs) return bad('priceTzs', 'too_large');

  // The number of people follows the category: 1, 2, or the owner's group size (3..groupMax).
  const fixed = fixedLimitOf(out.category);
  if (fixed) {
    if (has('beneficiaryLimit') && b.beneficiaryLimit !== null && b.beneficiaryLimit !== '' && (!isInt(b.beneficiaryLimit) || toInt(b.beneficiaryLimit) !== fixed)) {
      return bad('beneficiaryLimit', 'category_fixes_limit');
    }
    out.beneficiaryLimit = fixed;
  } else if (has('beneficiaryLimit') || !prior || fixedLimitOf(prior.category)) {
    if (!isInt(b.beneficiaryLimit)) return bad('beneficiaryLimit', 'group_limit_required');
    const n = toInt(b.beneficiaryLimit);
    if (n < PASS_LIMITS.groupMin || n > PASS_LIMITS.groupMax) return bad('beneficiaryLimit', 'group_limit_range');
    out.beneficiaryLimit = n;
  }
  return { value: out };
}

/** Whole calendar months after `from` (UTC); a 31st lands on the last day of a shorter month. */
function addMonths(from, months) {
  const d = new Date(from);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/** When a pass bought at `from` ends: days and weeks are 24-hour days, months are calendar months. */
export function passExpiry(from, durationValue, durationUnit) {
  const start = new Date(from);
  if (durationUnit === 'months') return addMonths(start, durationValue);
  const days = durationUnit === 'weeks' ? durationValue * 7 : durationValue;
  return new Date(+start + days * 86_400_000);
}

/** What the buyer saw and paid for. Later edits of the plan never change it. */
export function planSnapshot(plan) {
  return {
    name: plan.name, description: plan.description ?? null, category: plan.category,
    priceTzs: plan.priceTzs, currency: CURRENCY,
    durationValue: plan.durationValue, durationUnit: plan.durationUnit,
    beneficiaryLimit: plan.beneficiaryLimit,
    terms: plan.terms ?? null, termsVersion: plan.termsVersion ?? 1,
  };
}

/**
 * How many OTHER people (besides the purchaser) a purchase may name at checkout:
 *   individual  none
 *   couples     exactly one (two people in all)
 *   group       2 up to limit-1 (3 .. limit people in all)
 * After checkout a group may still fill free slots up to its limit (see the service).
 * → { ok: true } | { error }
 */
export function checkoutHeadcount(snapshot, others) {
  const total = others + 1;
  if (snapshot.category === 'individual') return others === 0 ? { ok: true } : { error: 'beneficiaries_not_allowed' };
  if (snapshot.category === 'couples') return total === 2 ? { ok: true } : { error: 'couples_needs_two_people' };
  if (total < PASS_LIMITS.groupMin) return { error: 'group_needs_minimum', min: PASS_LIMITS.groupMin };
  if (total > snapshot.beneficiaryLimit) return { error: 'beneficiary_limit_exceeded', limit: snapshot.beneficiaryLimit };
  return { ok: true };
}

/** A purchaser may take people out this many times per purchase (the owner and the person themself: no limit). */
export const purchaserRemovalCap = (snapshot) => snapshot.beneficiaryLimit;

/** "+255712345678" → "+255•••••678", "amina@x.com" → "a•••@x.com": enough to recognise, not to identify. */
export function maskContact(type, value) {
  if (!value) return null;
  const v = String(value);
  if (type === 'email') {
    const [local, domain] = v.split('@');
    return `${(local || '').slice(0, 1)}•••@${domain ?? ''}`;
  }
  return v.length > 7 ? `${v.slice(0, 4)}${'•'.repeat(v.length - 7)}${v.slice(-3)}` : '•••';
}

/** The effective state of a purchase: an active one past its end is expired, whatever was stored. */
export const effectivePurchaseStatus = (p, now = new Date()) =>
  (p.status === 'active' && p.expiresAt && +now >= +new Date(p.expiresAt) ? 'expired' : p.status);

/** Beneficiary states that hold one of the purchase's slots. */
export const SLOT_HOLDING = Object.freeze(['active', 'pending_registration', 'suspended']);
