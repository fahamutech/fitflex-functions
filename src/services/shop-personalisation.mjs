// Shop home personalisation (Phase 2 · slice 2) — pure rules, no I/O and no clock of their own.
// Contract: docs/shop-personalisation-api.md.
//
// Owner decisions (2026-10-20): purchase history and gender/age on by default with one opt-out;
// gender/age only REORDER products a vendor tagged, member mode only, never filter, never in a
// title; under-18 → personalisation fully off. Only the declared profile and the person's own paid
// orders are read: never activity, health, training, sponsor/company or KYC data.
import { ageOn } from '../shared/audience.mjs';
import { ageBandOf, targetsOf } from '../shared/product-targets.mjs';

/** Categories bought again and again: a recent purchase in one of these may be suggested again. */
export const CONSUMABLE_CATEGORIES = Object.freeze(['supplements_nutrition', 'food_drinks']);
/** A non-consumable bought within this many days is not suggested again. */
export const REBUY_WINDOW_DAYS = 30;
export const HISTORY_DAYS = Object.freeze({ default: 365, min: 1, max: 730 });
const DAY_MS = 86_400_000;
const EAT_OFFSET_MS = 3 * 3_600_000; // Africa/Dar_es_Salaam, UTC+3, no daylight saving

/** SHOP_HISTORY_DAYS → whole days within 1–730, else 365. */
export function historyDaysFromEnv(env = process.env) {
  const n = Number(env.SHOP_HISTORY_DAYS);
  return Number.isInteger(n) && n >= HISTORY_DAYS.min && n <= HISTORY_DAYS.max ? n : HISTORY_DAYS.default;
}

/** Today's East Africa day, "YYYY-MM-DD". */
export const eatDay = now => new Date(+new Date(now) + EAT_OFFSET_MS).toISOString().slice(0, 10);

const time = v => { const t = +new Date(v || 0); return Number.isFinite(t) ? t : 0; };

/**
 * Who may be personalised. Needs an adult member: the member persona's declared date of birth
 * must not make them under 18. No member persona → not available (no date of birth to rule out a
 * minor). No date of birth → available, the age signal is simply never used.
 * → { available, reason: null | 'flag_off' | 'no_member' | 'under_18', age: number|null }
 */
export function personalisationEligibility({ flagOn, hasMember, memberProfile, now }) {
  if (!flagOn) return { available: false, reason: 'flag_off', age: null };
  if (!hasMember) return { available: false, reason: 'no_member', age: null };
  const age = ageOn(memberProfile?.dateOfBirth, eatDay(now));
  if (age !== null && age < 18) return { available: false, reason: 'under_18', age };
  return { available: true, reason: null, age };
}

/**
 * The person's own purchase history from their orders. Only orders whose buyer is one of
 * `buyerIds`, paid, not cancelled, placed within `days` count (the query should already ask for
 * exactly that; the rules are repeated so this is safe on its own).
 * `categoryOf(productId)` gives the current category of a product (falls back to the line's own).
 * → null (nothing bought) | { categories: [key, …] most bought first, boughtProducts: Map(id → { name, category, lastAt }),
 *                            recentNonConsumableIds: Set }
 */
export function purchaseHistoryFrom(orders, { buyerIds, now, days = HISTORY_DAYS.default, categoryOf = () => null }) {
  const buyers = new Set((buyerIds || []).filter(Boolean));
  const since = time(now) - days * DAY_MS;
  const rebuySince = time(now) - REBUY_WINDOW_DAYS * DAY_MS;
  const cats = new Map(); // key → { orders, lastAt }
  const boughtProducts = new Map();
  const recentNonConsumableIds = new Set();
  for (const order of orders || []) {
    if (!buyers.has(order?.buyerId)) continue;
    if (order.paymentStatus !== 'paid' || order.status === 'cancelled') continue;
    const at = time(order.createdAt);
    if (at < since || at > time(now)) continue;
    const seen = new Set();
    for (const item of Array.isArray(order.items) ? order.items : []) {
      if (!item?.productId) continue;
      const category = categoryOf(item.productId) || item.category || null;
      const prior = boughtProducts.get(item.productId);
      if (!prior || prior.lastAt < at) boughtProducts.set(item.productId, { name: String(item.name || ''), category, lastAt: at });
      if (category && !CONSUMABLE_CATEGORIES.includes(category) && at >= rebuySince) recentNonConsumableIds.add(item.productId);
      if (!category || seen.has(category)) continue;
      seen.add(category);
      const c = cats.get(category) || { orders: 0, lastAt: 0 };
      c.orders += 1;
      c.lastAt = Math.max(c.lastAt, at);
      cats.set(category, c);
    }
  }
  if (!boughtProducts.size) return null;
  const categories = [...cats.entries()]
    .sort(([ka, a], [kb, b]) => b.orders - a.orders || b.lastAt - a.lastAt || (ka < kb ? -1 : ka > kb ? 1 : 0))
    .map(([k]) => k);
  return { categories, boughtProducts, recentNonConsumableIds };
}

/**
 * Declared gender and age band for reordering — member mode only, adults only.
 * memberProfile.gender: female → women, male → men; other/unset → none.
 * → { gender: 'women'|'men'|null, ageBand: band|null }
 */
export function audienceFrom({ mode, memberProfile, age }) {
  if (mode !== 'member' || !memberProfile) return { gender: null, ageBand: null };
  const gender = memberProfile.gender === 'female' ? 'women' : memberProfile.gender === 'male' ? 'men' : null;
  const ageBand = Number.isInteger(age) && age >= 18 ? ageBandOf(age) : null;
  return { gender, ageBand };
}

/**
 * A stable reorder of `ids`: products whose vendor tag matches the audience move earlier
 * (gender match +1, age band match +1); everything else keeps its relative order. The set of
 * ids never changes. `rowOf(id)` gives the product row (with its target fields).
 */
export function reorderForAudience(ids, rowOf, { gender = null, ageBand = null } = {}) {
  if (!gender && !ageBand) return [...ids];
  const score = (id) => {
    const t = targetsOf(rowOf(id));
    return (gender && t.targetGender === gender ? 1 : 0) + (ageBand && t.targetAgeBands.includes(ageBand) ? 1 : 0);
  };
  return ids.map((id, i) => ({ id, i, s: score(id) })).sort((a, b) => b.s - a.s || a.i - b.i).map(x => x.id);
}
