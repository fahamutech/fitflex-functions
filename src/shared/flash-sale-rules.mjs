// Shop flash sales — pure rules (no I/O). Contract: docs/shop-flash-sales-api.md.
//
// Owner decisions (2026-10-20 / 2026-10-29): discount at least 5 %, no maximum; refused if the
// product's priceTzs was raised in the 14 days before the start; the sale price must be below the
// current effective price (regular, or a standing discount); 1 hour to 7 days; one approved sale per
// product at a time; proposals expire after 14 days or at their start.
//
// States, "live" and expiry follow the banners exactly (shop-banner-rules.mjs).
import { effectiveStatus, proposalExpiry, DEFAULT_PROPOSAL_EXPIRY_DAYS, MIN_LEAD_MS, BANNER_EFFECTIVE_STATUSES } from './shop-banner-rules.mjs';
import { standingPrice, validDiscount, discountPct } from './shop-pricing.mjs';

export { effectiveStatus, proposalExpiry };
export const SALE_EFFECTIVE_STATUSES = BANNER_EFFECTIVE_STATUSES;
export const SALE_ORIGINS = Object.freeze(['vendor', 'staff']);
export const SALE_REJECT_CODES = Object.freeze(['price_not_credible', 'product', 'timing', 'other']);
export const REASON_MAX = 500;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const SALE_RULES = Object.freeze({
  minDiscountPct: 5,
  minLengthMs: HOUR_MS,
  maxLengthMs: 7 * DAY_MS,
  minLeadMs: MIN_LEAD_MS,
  priceRaiseLookbackDays: 14,
});
export const MAX_SALE_TZS = 100_000_000;
export const DEFAULT_MAX_OPEN_SALES = 10;

const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const ms = v => (v == null ? NaN : new Date(v).getTime());
const positiveInt = (v, fallback) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : fallback);

/** SHOP_PROPOSAL_EXPIRY_DAYS (shared with banners, default 14) and SHOP_FLASH_SALE_MAX_OPEN (default 10). */
export function flashSaleConfigFromEnv(env = process.env) {
  return {
    proposalExpiryDays: positiveInt(env.SHOP_PROPOSAL_EXPIRY_DAYS, DEFAULT_PROPOSAL_EXPIRY_DAYS),
    maxOpenProposals: positiveInt(env.SHOP_FLASH_SALE_MAX_OPEN, DEFAULT_MAX_OPEN_SALES),
  };
}

const FIELDS = ['productId', 'salePriceTzs', 'startsAt', 'endsAt'];

/**
 * The body of create / PATCH → { value } or { error }. `create` needs every field; PATCH may send any
 * of salePriceTzs, startsAt, endsAt (productId is fixed once created).
 */
export function parseSaleInput(body, { create = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid_body', 400);
  const unknown = Object.keys(body).filter(k => !FIELDS.includes(k));
  if (unknown.length) return fail('unknown_field', 400, { fields: unknown });
  const value = {};
  if ('productId' in body) {
    if (!create) return fail('product_not_editable', 400, { field: 'productId' });
    if (typeof body.productId !== 'string' || !body.productId.trim() || body.productId.length > 100) return fail('invalid_field', 400, { field: 'productId' });
    value.productId = body.productId.trim();
  }
  if ('salePriceTzs' in body) {
    const n = Number(body.salePriceTzs);
    if (body.salePriceTzs === null || body.salePriceTzs === '' || !Number.isInteger(n) || n < 1 || n > MAX_SALE_TZS) return fail('invalid_field', 400, { field: 'salePriceTzs' });
    value.salePriceTzs = n;
  }
  for (const field of ['startsAt', 'endsAt']) {
    if (!(field in body)) continue;
    const v = body[field];
    if (typeof v !== 'string' || !Number.isFinite(ms(v))) return fail('invalid_date', 400, { field });
    value[field] = new Date(v).toISOString();
  }
  if (create) {
    const missing = FIELDS.filter(f => value[f] === undefined);
    if (missing.length) return fail('missing_field', 400, { fields: missing });
  }
  return { value };
}

/** The window rules. `checkLead`: the start must be ≥ 1 hour from `now` (create, edit, submit). */
export function windowError(sale, { now = new Date(), checkLead = true } = {}) {
  const start = ms(sale.startsAt);
  const end = ms(sale.endsAt);
  if (end <= start) return fail('end_before_start', 422, { field: 'endsAt' });
  const length = end - start;
  if (length < SALE_RULES.minLengthMs || length > SALE_RULES.maxLengthMs) {
    return fail('sale_length_out_of_range', 422, { field: 'endsAt', minMs: SALE_RULES.minLengthMs, maxMs: SALE_RULES.maxLengthMs });
  }
  if (checkLead && start < ms(now) + SALE_RULES.minLeadMs) {
    return fail('start_too_soon', 422, { field: 'startsAt', earliestStart: new Date(ms(now) + SALE_RULES.minLeadMs).toISOString() });
  }
  return null;
}

/** The highest sale price that is still ≥ 5 % off `regularTzs`: floor(regular × 95 / 100). */
export const maxSalePrice = regularTzs => Math.floor((Math.round(Number(regularTzs) || 0) * (100 - SALE_RULES.minDiscountPct)) / 100);

/** The price rules against the product as it is now. */
export function discountError(salePriceTzs, product) {
  const regular = Math.round(Number(product.priceTzs) || 0);
  const max = maxSalePrice(regular);
  if (!(regular > 0) || salePriceTzs > max || discountPct(regular, salePriceTzs) < SALE_RULES.minDiscountPct) {
    return fail('discount_out_of_range', 422, { field: 'salePriceTzs', reason: 'below_minimum', minDiscountPct: SALE_RULES.minDiscountPct, maxSalePriceTzs: Math.max(0, max), regularPriceTzs: regular });
  }
  const effective = standingPrice(product);
  if (!(salePriceTzs < effective)) {
    return fail('discount_out_of_range', 422, { field: 'salePriceTzs', reason: 'not_below_effective', effectivePriceTzs: effective, discountPriceTzs: validDiscount(product) });
  }
  return null;
}

/** Tanzania (EAT) calendar date of an instant: YYYY-MM-DD. */
export function eatDate(at) {
  const d = new Date(ms(at) + 3 * HOUR_MS);
  return d.toISOString().slice(0, 10);
}

/**
 * The 14-day rule. `changes` = ProductPriceChange rows of the product ({ field, fromTzs, toTzs, at }).
 * A raise is a priceTzs change from a known price to a higher one. Fails when the latest raise is
 * after startsAt − 14 days. → null | { error: 'price_raised_recently', raisedAt, raisedOn, earliestStart, fromTzs, toTzs }.
 */
export function priceRaiseError(changes, startsAt) {
  const raise = latestRaise(changes);
  if (!raise) return null;
  const windowStart = ms(startsAt) - SALE_RULES.priceRaiseLookbackDays * DAY_MS;
  if (ms(raise.at) <= windowStart) return null;
  return fail('price_raised_recently', 422, {
    field: 'startsAt', raisedAt: new Date(raise.at).toISOString(), raisedOn: eatDate(raise.at),
    earliestStart: new Date(ms(raise.at) + SALE_RULES.priceRaiseLookbackDays * DAY_MS).toISOString(),
    fromTzs: raise.fromTzs, toTzs: raise.toTzs,
  });
}

export const isRaise = c => c.field === 'priceTzs' && c.fromTzs != null && c.toTzs != null && Number(c.toTzs) > Number(c.fromTzs);
export function latestRaise(changes = []) {
  let best = null;
  for (const c of changes) if (isRaise(c) && (!best || ms(c.at) > ms(best.at))) best = c;
  return best;
}

/** Two windows [a.startsAt, a.endsAt) and [b.startsAt, b.endsAt) overlap. */
export const overlaps = (a, b) => ms(a.startsAt) < ms(b.endsAt) && ms(b.startsAt) < ms(a.endsAt);
