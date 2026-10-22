// Shop home — which products go in which section, for whom. Pure: no I/O, no
// clock of its own, no randomness, so the same input always gives the same page.
//
// Four layers, each with its own input and output and each tested on its own:
//
//   (a) identity    resolveShoppingMode  who is shopping, as which role
//   (b) needs       buildNeeds           what that shopper is likely to look for
//   (c) eligibility filterEligible       what can actually be sold to them
//   (d) assembly    assembleSections     the configured sections, ranked, de-duplicated
//
// `buildShopHome` runs all four in order. Rules are deterministic and written
// here; no model, no external service.
//
// Phase 1 (owner, 2026-10-19): role defaults, a declared member fitness goal, a
// declared trainer specialty and the `recent` ids the app sends.
// Phase 2 · slice 2 (SHOP_PERSONALISATION): purchase history fills `needs.purchaseHistory`, and
// gender/age reorder within a rail after assembly (shop-personalisation.mjs). Location is slice 3.
// Without a `personalisation` input every function here behaves exactly as in Phase 1.
import { PRODUCT_CATEGORIES } from '../shared/product-categories.mjs';
import { reorderForAudience } from './shop-personalisation.mjs';

// ── (a) identity ─────────────────────────────────────────────────────────────

/** The shopping modes, and the account type (User.userType) that holds each. */
export const SHOPPING_MODES = Object.freeze({
  member: 'member',
  trainer: 'trainer',
  owner: 'gym_operator',
  vendor_personal: 'vendor',
});
const MODE_OF_USER_TYPE = Object.freeze(Object.fromEntries(Object.entries(SHOPPING_MODES).map(([mode, type]) => [type, mode])));
/** When the signed-in role is not a shopping role, the first one held in this order is used. */
const DEFAULT_MODE_ORDER = ['member', 'trainer', 'owner', 'vendor_personal'];

/**
 * The mode to shop in. `heldUserTypes` are the account types this person
 * actually holds (their signed-in role and their other usable personas); the
 * client's `requested` mode is only accepted when it is one of them.
 * → { mode } | { error: 'mode_not_allowed' }
 */
export function resolveShoppingMode({ requested, sessionUserType, heldUserTypes = [] }) {
  const held = new Set([sessionUserType, ...heldUserTypes].map(t => MODE_OF_USER_TYPE[t]).filter(Boolean));
  if (requested !== undefined && requested !== null && requested !== '') {
    return held.has(requested) ? { mode: requested } : { error: 'mode_not_allowed' };
  }
  const own = MODE_OF_USER_TYPE[sessionUserType];
  if (own) return { mode: own };
  const first = DEFAULT_MODE_ORDER.find(m => held.has(m));
  return first ? { mode: first } : { error: 'mode_not_allowed' };
}

// ── (b) needs ────────────────────────────────────────────────────────────────

/**
 * What each role usually shops for, as the existing 8 categories, most
 * relevant first. Configuration, not a restriction: every role can still see
 * and buy everything.
 */
export const DEFAULT_ROLE_CATEGORIES = Object.freeze({
  // equipment, accessories, nutrition/supplements, recovery, training essentials (apparel and shoes)
  member: ['equipment', 'accessories_gear', 'supplements_nutrition', 'health_recovery', 'sportswear_footwear'],
  // coaching accessories, bands, mats (accessories & gear), training equipment, coaching apparel
  trainer: ['accessories_gear', 'equipment', 'sportswear_footwear'],
  // commercial equipment, bulk accessories, facility supplies (no category of their own: "other")
  owner: ['equipment', 'accessories_gear', 'other'],
  // a vendor shopping for themselves shops like a member
  vendor_personal: ['equipment', 'accessories_gear', 'supplements_nutrition', 'health_recovery', 'sportswear_footwear'],
});

/** A member's declared fitness goal (memberProfile.fitnessGoal / fitnessGoals) → categories. */
export const DEFAULT_GOAL_CATEGORIES = Object.freeze({
  lose_weight: ['sportswear_footwear', 'food_drinks', 'supplements_nutrition'],
  gain_muscle: ['supplements_nutrition', 'equipment'],
  build_muscle: ['supplements_nutrition', 'equipment'],
  stay_fit: ['sportswear_footwear', 'accessories_gear'],
  improve_endurance: ['sportswear_footwear', 'food_drinks', 'health_recovery'],
  improve_flexibility: ['accessories_gear', 'health_recovery'],
  learn_new_skill: ['accessories_gear', 'events'],
  stress_relief: ['health_recovery', 'events'],
});

/**
 * A trainer's declared specialties are free text (TrainerProfile.specialties),
 * so they are matched by keyword. Case-insensitive; the first match wins per
 * specialty. Specialties that describe who is trained (e.g. "Women Only") map
 * to nothing on purpose.
 */
export const DEFAULT_SPECIALTY_CATEGORIES = Object.freeze([
  { match: ['yoga', 'pilates', 'stretch', 'mobility', 'physio'], categories: ['accessories_gear', 'health_recovery'] },
  { match: ['boxing', 'kickbox', 'martial'], categories: ['accessories_gear', 'equipment'] },
  { match: ['crossfit', 'hiit', 'weight', 'calisthenic', 'strength', 'muscle'], categories: ['equipment', 'accessories_gear'] },
  { match: ['nutrition'], categories: ['supplements_nutrition', 'food_drinks'] },
  { match: ['cardio', 'aerobic', 'zumba', 'dance', 'swim', 'run'], categories: ['sportswear_footwear', 'accessories_gear'] },
]);

/**
 * Phase 2 places in the needs object:
 *   purchaseHistory  shop-personalisation.purchaseHistoryFrom(): { categories, boughtProducts, recentNonConsumableIds } (slice 2)
 *   audience         { gender, ageBand }: applied after assembly as a stable reorder, never here (slice 2)
 *   location         { areaIds, source } for a "popular near you" section (slice 3; still null)
 */
export const NEEDS_PHASE2_FIELDS = Object.freeze(['purchaseHistory', 'audience', 'location']);

const MAX_RECENT = 20;
const ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const uniq = list => [...new Set(list)];

/** The `recent` query value (comma-separated ids, most recent first) → at most 20 clean, unique ids. */
export function parseRecentIds(value) {
  const raw = Array.isArray(value) ? value.join(',') : typeof value === 'string' ? value : '';
  return uniq(raw.split(',').map(s => s.trim()).filter(s => ID_RE.test(s))).slice(0, MAX_RECENT);
}

/**
 * What this shopper is likely to need. Typed: every field is always present.
 *   mode               the shopping mode
 *   roleCategories     categories for the role (config)
 *   goalCategories     from a declared member goal (member mode only)
 *   specialtyCategories from declared trainer specialties (trainer mode only)
 *   categories         all of the above, specific first, unique
 *   recentIds          what the app says was viewed recently on this device (never stored)
 *   signalsUsed        which of these actually contributed
 *   purchaseHistory, audience, location: null (Phase 2, see NEEDS_PHASE2_FIELDS)
 */
export function buildNeeds({ mode, memberProfile = null, trainerProfile = null, recentIds = [], config = {}, purchaseHistory = null, optedOut = false }) {
  const roleMap = config.roleCategories || DEFAULT_ROLE_CATEGORIES;
  const goalMap = config.goalCategories || DEFAULT_GOAL_CATEGORIES;
  const specialtyRules = config.specialtyCategories || DEFAULT_SPECIALTY_CATEGORIES;
  const roleCategories = [...(roleMap[mode] || [])];

  let goalCategories = [];
  // Switched off ("Personalised shop" off): no declared goal or specialty either; only the role.
  if (mode === 'member' && memberProfile && !optedOut) {
    const goals = uniq([...(Array.isArray(memberProfile.fitnessGoals) ? memberProfile.fitnessGoals : []), memberProfile.fitnessGoal].filter(g => typeof g === 'string'));
    goalCategories = uniq(goals.flatMap(g => goalMap[g] || []));
  }
  let specialtyCategories = [];
  if (mode === 'trainer' && trainerProfile && Array.isArray(trainerProfile.specialties) && !optedOut) {
    specialtyCategories = uniq(trainerProfile.specialties.filter(s => typeof s === 'string').flatMap((s) => {
      const text = s.toLowerCase();
      return specialtyRules.find(rule => rule.match.some(word => text.includes(word)))?.categories || [];
    }));
  }
  const recent = parseRecentIds(recentIds);
  const signalsUsed = ['role'];
  if (goalCategories.length) signalsUsed.push('goal');
  if (specialtyCategories.length) signalsUsed.push('specialty');
  if (recent.length) signalsUsed.push('recently_viewed');
  return {
    mode,
    roleCategories,
    goalCategories,
    specialtyCategories,
    categories: uniq([...goalCategories, ...specialtyCategories, ...roleCategories]),
    recentIds: recent,
    signalsUsed,
    optedOut: Boolean(optedOut),
    purchaseHistory: optedOut ? null : purchaseHistory || null,
    audience: null,
    location: null,
  };
}

// ── (c) eligibility ──────────────────────────────────────────────────────────

/**
 * What may appear on the home. The products passed in should already be the
 * buyer-visible list (shopService.listProducts: active, approved, visible,
 * listed, vendor allowed to sell, not hidden or suspended in moderation or on the account); the
 * same row checks are repeated here so the module is safe on its own. Then:
 *   - out of stock (stock ≤ 0) never appears on the home (it stays in search and results);
 *   - the shopper's own products (any vendor persona they hold) never appear;
 *   - products of a vendor whose account is suspended (User.accountStatus) never appear.
 *     (listProducts now applies this too; repeated here so the module is safe on its own.)
 * Delivery: products carry no buyer-area coverage in Phase 1, and gym pickup is
 * always offered, so nothing is excluded by delivery yet.
 * → { eligible: Product[], excluded: { [productId]: reason } }
 */
export function filterEligible(products, { ownVendorIds = [], suspendedVendorIds = [] } = {}) {
  const own = new Set(ownVendorIds.filter(Boolean));
  const suspended = new Set(suspendedVendorIds.filter(Boolean));
  const eligible = [];
  const excluded = {};
  for (const p of products || []) {
    if (!p || !p.id) continue;
    let reason = null;
    if (p.deletedAt) reason = 'deleted';
    else if (p.status !== 'active') reason = 'inactive';
    else if (['pending', 'rejected'].includes(p.approvalStatus)) reason = 'not_approved';
    else if (p.visibility === 'hidden' || p.homepageVisible === false) reason = 'hidden';
    else if (!(Number(p.stock) > 0)) reason = 'out_of_stock';
    else if (suspended.has(p.vendorId)) reason = 'vendor_suspended';
    else if (own.has(p.vendorId)) reason = 'own_product';
    if (reason) excluded[p.id] = reason;
    else eligible.push(p);
  }
  return { eligible, excluded };
}

// ── (d) assembly ─────────────────────────────────────────────────────────────

/**
 * Every section, in the default display order (design spec §5.1: Featured, then Best sellers, then
 * Recommended). SHOP_HOME_SECTIONS can choose and reorder them for display.
 */
export const SECTION_KEYS = Object.freeze(['featured', 'best_sellers', 'recommended', 'essentials', 'recently_viewed', 'deals', 'new_arrivals']);
/**
 * Which section gets a product that fits several (design DD-7: Featured > Best sellers > Recommended).
 * Recently viewed is the shopper's own explicit history (at most 20), so it takes its products before the
 * suggestion sections do; otherwise those would always have taken them and it would never show.
 * This order is fixed; the display order above is configurable.
 */
export const ALLOCATION_ORDER = Object.freeze(['featured', 'best_sellers', 'recently_viewed', 'recommended', 'essentials', 'deals', 'new_arrivals']);
export const DEFAULT_ASSEMBLY = Object.freeze({ sections: SECTION_KEYS, minItems: 4, maxItems: 12, newArrivalDays: 90 });

/** SHOP_HOME_SECTIONS → the enabled keys in that order (unknown keys and repeats dropped). Empty → all. */
export function parseSectionList(value) {
  const keys = uniq(String(value ?? '').split(',').map(s => s.trim()).filter(k => SECTION_KEYS.includes(k)));
  return keys.length ? keys : [...SECTION_KEYS];
}

/** A sale is on when the sale price is set and below the price (same rule as checkout). */
export const onSale = p => Number(p.discountPriceTzs || 0) > 0 && Number(p.discountPriceTzs) < Number(p.priceTzs || 0);
const discountPct = p => (onSale(p) ? Math.floor(((Number(p.priceTzs) - Number(p.discountPriceTzs)) / Number(p.priceTzs)) * 100) : 0);
const time = v => { const t = +new Date(v || 0); return Number.isFinite(t) ? t : 0; };
const byId = (a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
/** Shared tie-breaks: the listing's admin priority, then newest, then id (so order never depends on input order). */
const tieBreak = (a, b) => Number(b.homepagePriority || 0) - Number(a.homepagePriority || 0) || time(b.createdAt) - time(a.createdAt) || byId(a, b);

/**
 * Sales from paid, not cancelled orders in the last 30 days, per product:
 * { orders, units, byMode: { member, trainer, owner, vendor_personal } } (orders).
 * `orders` are rows with { buyerRole, items: [{ productId, qty }], createdAt }.
 */
export function salesStats(orders, { now, days = 30 } = {}) {
  const since = time(now) - days * 86_400_000;
  const stats = new Map();
  for (const order of orders || []) {
    if (order.paymentStatus !== undefined && order.paymentStatus !== 'paid') continue;
    if (order.status === 'cancelled') continue;
    if (time(order.createdAt) < since) continue;
    const mode = MODE_OF_USER_TYPE[order.buyerRole] || 'member';
    const seen = new Set();
    for (const item of order.items || []) {
      if (!item?.productId) continue;
      const s = stats.get(item.productId) || { orders: 0, units: 0, byMode: {} };
      if (!seen.has(item.productId)) {
        s.orders += 1;
        s.byMode[mode] = (s.byMode[mode] || 0) + 1;
        seen.add(item.productId);
      }
      s.units += Math.max(0, Number(item.qty) || 0);
      stats.set(item.productId, s);
    }
  }
  return stats;
}

/** Each section's candidates, best first, before de-duplication and limits. */
function rankers({ needs, eligible, featured, paidPlacementIds, sales, now, config }) {
  const ordersOf = p => sales.get(p.id)?.orders || 0;
  const unitsOf = p => sales.get(p.id)?.units || 0;
  const roleOrdersOf = p => sales.get(p.id)?.byMode?.[needs.mode] || 0;
  const rank = new Map(needs.categories.map((c, i) => [c, i]));
  const byIdMap = new Map(eligible.map(p => [p.id, p]));
  const paid = new Set(paidPlacementIds || []);
  // Purchase history (slice 2): bought categories first; a non-consumable bought in the last 30 days is not suggested again.
  const hist = needs.purchaseHistory;
  const boughtRank = new Map((hist?.categories || []).map((c, i) => [c, i]));
  const boughtPos = p => (boughtRank.has(p.category) ? boughtRank.get(p.category) : 1e9);
  const notJustBought = p => !hist?.recentNonConsumableIds?.has(p.id);
  return {
    // The Featured system's set, in this role's category order (a reorder, never a filter);
    // within a category, the Featured system's own order.
    featured: () => {
      const order = CATEGORY_ORDER[needs.mode] || CATEGORY_ORDER.member;
      const pos = c => { const i = order.indexOf(c); return i < 0 ? order.length : i; };
      return (featured || []).map((f, i) => ({ p: byIdMap.get(f.productId), i })).filter(x => x.p)
        .sort((a, b) => pos(a.p.category) - pos(b.p.category) || a.i - b.i).map(x => x.p);
    },
    // Organic only: anything with a live paid or editorial placement is left out.
    // The role's own categories first, then what people shopping in this role buy, then everyone.
    recommended: () => eligible.filter(p => !paid.has(p.id) && notJustBought(p)).sort((a, b) =>
      (hist ? boughtPos(a) - boughtPos(b) : 0)
      || (rank.has(a.category) ? 0 : 1) - (rank.has(b.category) ? 0 : 1)
      || roleOrdersOf(b) - roleOrdersOf(a) || ordersOf(b) - ordersOf(a) || tieBreak(a, b)),
    // Bought in paid orders in the last 30 days, most orders first. Never the stored soldCount.
    best_sellers: () => eligible.filter(p => ordersOf(p) > 0).sort((a, b) => ordersOf(b) - ordersOf(a) || unitsOf(b) - unitsOf(a) || byId(a, b)),
    // Round-robin over the needed categories (most specific first), so one category cannot fill it.
    // Organic like recommended: no paid or editorial placement.
    essentials: () => {
      const laneKeys = hist ? uniq([...hist.categories, ...needs.categories]) : needs.categories;
      const lanes = laneKeys.map(c => eligible.filter(p => p.category === c && !paid.has(p.id) && notJustBought(p)).sort((a, b) => ordersOf(b) - ordersOf(a) || tieBreak(a, b)));
      const out = [];
      for (let i = 0; lanes.some(l => i < l.length); i += 1) for (const lane of lanes) if (lane[i]) out.push(lane[i]);
      return out;
    },
    // The app's order (most recent first); ids that are not eligible simply drop out.
    recently_viewed: () => needs.recentIds.map(id => byIdMap.get(id)).filter(Boolean),
    deals: () => eligible.filter(onSale).sort((a, b) => discountPct(b) - discountPct(a) || tieBreak(a, b)),
    new_arrivals: () => {
      const since = time(now) - config.newArrivalDays * 86_400_000;
      return eligible.filter(p => time(p.createdAt) >= since).sort((a, b) => time(b.createdAt) - time(a.createdAt) || byId(a, b));
    },
  };
}

/**
 * "View all" for a section: a GET /shop/products query whose results include every product the
 * section shows. A category is added only when every product shown is in it. Where the list has no
 * filter for the section's own rule (Featured, Recently viewed, New arrivals, Essentials across
 * several categories), "all" cannot be shown faithfully, so the section reports `hasMore: false`
 * and the app offers no "View all" for it.
 * → { viewAll: { path, query }, faithful }
 */
export function viewAllFor(key, picked) {
  const cats = uniq(picked.map(p => p.category));
  const category = cats.length === 1 && cats[0] ? { category: cats[0] } : {};
  const base = { best_sellers: { sort: 'popularity' }, recommended: { sort: 'popularity' }, deals: { promotions: 'true' } }[key] || {};
  const faithful = ['best_sellers', 'recommended', 'deals'].includes(key) || (key === 'essentials' && Boolean(category.category));
  return { viewAll: { path: '/shop/products', query: { ...category, ...base } }, faithful };
}

/**
 * The sections. Products are allocated in ALLOCATION_ORDER (a product appears in at most one section);
 * the answer lists them in the configured display order. A section with fewer than `minItems`
 * products is left out, and the products it would have taken stay free for the sections after it.
 * → [{ key, productIds, hasMore, viewAll }]
 */
export function assembleSections({ needs, eligible, featured = [], paidPlacementIds = [], sales = new Map(), now, config = {} }) {
  const cfg = { ...DEFAULT_ASSEMBLY, ...config };
  const rank = rankers({ needs, eligible, featured, paidPlacementIds, sales, now, config: cfg });
  const enabled = new Set(cfg.sections);
  const used = new Set();
  const built = new Map();
  for (const key of ALLOCATION_ORDER) {
    if (!enabled.has(key) || !rank[key]) continue;
    const free = rank[key]().filter(p => !used.has(p.id));
    const picked = free.slice(0, cfg.maxItems);
    if (picked.length < cfg.minItems) continue;
    for (const p of picked) used.add(p.id);
    const { viewAll, faithful } = viewAllFor(key, picked);
    built.set(key, { key, productIds: picked.map(p => p.id), hasMore: faithful && free.length > picked.length, viewAll });
  }
  return cfg.sections.filter(k => built.has(k)).map(k => built.get(k));
}

// ── copy (English + Swahili; Swahili is a draft for native review) ───────────

const ROLE_WORD = {
  member: { en: 'a member', sw: 'mwanachama' },
  trainer: { en: 'a trainer', sw: 'trainer' },
  owner: { en: 'a gym owner', sw: 'mmiliki wa gym' },
  // A vendor buying for themselves is not "a member": the app says "You're shopping for yourself."
  vendor_personal: { en: 'yourself', sw: 'wewe mwenyewe' },
};
// [SW review] every `sw` string below. Terms follow docs/localization/fitflex-terminology-glossary.md
// (parent repo): "trainer" / "ma-trainer" (never kocha or mkufunzi), role = "nafasi" (never jukumu),
// the Sponsored badge reads "Iliyodhaminiwa" as in the app.
const COPY = {
  featured: {
    title: {
      member: { en: 'Featured gear', sw: 'Vifaa vilivyoangaziwa' },
      trainer: { en: 'Featured coaching gear', sw: 'Vifaa vya trainer vilivyoangaziwa' },
      owner: { en: 'Featured equipment', sw: 'Vifaa vya gym vilivyoangaziwa' },
      vendor_personal: { en: 'Featured gear', sw: 'Vifaa vilivyoangaziwa' },
    },
    reason: () => ({ en: 'Featured products are chosen by FitFlex or paid for by sellers. Paid ones are labelled Sponsored.', sw: 'Bidhaa zilizoangaziwa huchaguliwa na FitFlex au hulipiwa na wauzaji. Zilizolipiwa zimeandikwa "Iliyodhaminiwa".' }),
    codes: () => ['featured_disclosure'],
  },
  recommended: {
    title: {
      member: { en: 'Popular with members', sw: 'Maarufu kwa wanachama' },
      trainer: { en: 'Popular with trainers', sw: 'Maarufu kwa ma-trainer' },
      owner: { en: 'Popular with gym owners', sw: 'Maarufu kwa wamiliki wa gym' },
      vendor_personal: { en: 'Popular in the shop', sw: 'Maarufu dukani' },
    },
    reason: mode => (mode === 'vendor_personal'
      ? { en: "Suggested from what's popular on FitFlex.", sw: 'Imependekezwa kutokana na kinachopendwa kwenye FitFlex.' }
      : { en: "It's popular with others shopping in this role.", sw: 'Ni maarufu kwa wengine wanaonunua katika nafasi hii.' }),
    codes: mode => (mode === 'vendor_personal' ? ['generic', 'role_context'] : ['popular_with_role', 'role_context']),
  },
  best_sellers: {
    title: { all: { en: 'Best sellers', sw: 'Zinazouzwa zaidi' } },
    reason: () => ({ en: 'The most bought on FitFlex in the last 30 days.', sw: 'Zilizonunuliwa zaidi kwenye FitFlex katika siku 30 zilizopita.' }),
    codes: () => ['best_sellers_30d'],
  },
  essentials: {
    title: {
      member: { en: 'Training essentials', sw: 'Mahitaji muhimu ya mazoezi' },
      trainer: { en: 'Coaching essentials', sw: 'Mahitaji muhimu ya trainer' },
      owner: { en: 'Gym essentials', sw: 'Mahitaji muhimu ya gym' },
      vendor_personal: { en: 'Training essentials', sw: 'Mahitaji muhimu ya mazoezi' },
    },
    reason: (mode, needs) => {
      if (needs.goalCategories.length) return { en: 'Matches the fitness goal in your profile.', sw: 'Inalingana na lengo la mazoezi kwenye wasifu wako.' };
      if (needs.specialtyCategories.length) return { en: 'Matches the specialties on your trainer profile.', sw: 'Inalingana na utaalamu ulio kwenye wasifu wako wa trainer.' };
      // [SW review] "Unanunua kwa ajili yako mwenyewe."
      if (mode === 'vendor_personal') return { en: "You're shopping for yourself.", sw: 'Unanunua kwa ajili yako mwenyewe.' };
      return { en: `Picked for people shopping as ${ROLE_WORD[mode].en}.`, sw: `Imechaguliwa kwa wanaonunua kama ${ROLE_WORD[mode].sw}.` };
    },
    codes: (mode, needs) => [...(needs.goalCategories.length ? ['profile_goal'] : []), ...(needs.specialtyCategories.length ? ['trainer_specialty'] : []), 'role_context'],
  },
  recently_viewed: {
    title: { all: { en: 'Recently viewed', sw: 'Ulizotazama hivi karibuni' } },
    reason: () => ({ en: 'Products you opened recently on this device.', sw: 'Bidhaa ulizofungua hivi karibuni kwenye kifaa hiki.' }),
    codes: () => ['recently_viewed'],
  },
  deals: {
    title: { all: { en: 'Deals', sw: 'Ofa' } },
    reason: () => ({ en: 'The seller has lowered the price.', sw: 'Muuzaji amepunguza bei.' }),
    codes: () => ['seller_discount'],
  },
  new_arrivals: {
    title: { all: { en: 'New arrivals', sw: 'Bidhaa mpya' } },
    reason: () => ({ en: 'Recently added to the shop.', sw: 'Zimeongezwa dukani hivi karibuni.' }),
    codes: () => ['new_arrival'],
  },
};

// Slice 2 copy. [SW review] Wording from the P1 spec §10.6 (shop.home.recommended, shop.why.boughtCategory,
// shop.why.boughtProduct). No title or reason ever names a gender or an age group.
const PERSONAL_COPY = {
  recommendedTitle: { en: 'Recommended for you', sw: 'Zilizopendekezwa kwako' },
  popularInShop: { en: 'Popular in the shop', sw: 'Maarufu dukani' },
  generic: { en: "Suggested from what's popular on FitFlex.", sw: 'Imependekezwa kutokana na kinachopendwa kwenye FitFlex.' },
  boughtCategory: c => ({ en: `You've bought ${c.en} before.`, sw: `Uliwahi kununua ${c.sw}.` }),
  boughtProduct: name => ({ en: `Suggested because you bought ${name}.`, sw: `Imependekezwa kwa sababu ulinunua ${name}.` }),
};
const CATEGORY_BY_KEY = new Map(PRODUCT_CATEGORIES.map(c => [c.key, c]));

/**
 * Titles, reasons and "view all" for assembled sections. `personal` (slice 2, optional):
 * { [sectionKey]: { history, gender, age } } — which personal signal changed that section.
 */
export function describeSections(sections, needs, personal = {}) {
  return sections.map((s) => {
    const copy = COPY[s.key];
    let title = copy.title[needs.mode] || copy.title.all;
    let reason = copy.reason(needs.mode, needs);
    let reasonCodes = copy.codes(needs.mode, needs);
    let reasonParams = null;
    const mine = personal[s.key] || {};
    if (s.key === 'recommended' && needs.optedOut) {
      // Switched off (P1 §8.2): the same suggestions as everyone, no personal reason.
      title = PERSONAL_COPY.popularInShop;
      reason = PERSONAL_COPY.generic;
      reasonCodes = ['generic', 'role_context'];
    }
    const hist = needs.purchaseHistory;
    if (mine.history && hist) {
      const rebought = s.productIds.find(id => hist.boughtProducts.has(id) && hist.boughtProducts.get(id).name);
      const topCategory = hist.categories.find(c => s.categories?.includes(c)) || hist.categories[0] || null;
      if (s.key === 'recommended') title = PERSONAL_COPY.recommendedTitle;
      if (s.key === 'recommended' && rebought) {
        const productName = hist.boughtProducts.get(rebought).name;
        reason = PERSONAL_COPY.boughtProduct(productName);
        reasonParams = { productName };
        reasonCodes = ['bought_product', ...reasonCodes.filter(c => c !== 'popular_with_role' && c !== 'generic')];
      } else if (topCategory && CATEGORY_BY_KEY.has(topCategory)) {
        reason = PERSONAL_COPY.boughtCategory(CATEGORY_BY_KEY.get(topCategory));
        reasonParams = { category: topCategory };
        reasonCodes = ['bought_category', ...reasonCodes.filter(c => c !== 'popular_with_role' && c !== 'generic')];
      }
    }
    const audienceCodes = [...(mine.gender ? ['profile_gender'] : []), ...(mine.age ? ['profile_age'] : [])];
    if (audienceCodes.length) {
      const at = reasonCodes.indexOf('role_context');
      reasonCodes = at < 0 ? [...reasonCodes, ...audienceCodes] : [...reasonCodes.slice(0, at), ...audienceCodes, ...reasonCodes.slice(at)];
    }
    return {
      key: s.key,
      title,
      reason,
      reasonCodes,
      ...(reasonParams ? { reasonParams } : {}),
      viewAll: s.viewAll || { path: '/shop/products', query: {} },
      productIds: s.productIds,
      hasMore: s.hasMore,
    };
  });
}

/** Category order per mode (design spec §5.2). "other" is always last. */
export const CATEGORY_ORDER = Object.freeze({
  member: ['sportswear_footwear', 'supplements_nutrition', 'health_recovery', 'food_drinks', 'events', 'accessories_gear', 'equipment', 'other'],
  trainer: ['accessories_gear', 'equipment', 'sportswear_footwear', 'supplements_nutrition', 'health_recovery', 'events', 'food_drinks', 'other'],
  owner: ['equipment', 'accessories_gear', 'health_recovery', 'supplements_nutrition', 'food_drinks', 'sportswear_footwear', 'events', 'other'],
  vendor_personal: ['sportswear_footwear', 'supplements_nutrition', 'health_recovery', 'food_drinks', 'events', 'accessories_gear', 'equipment', 'other'],
});

/** The 8 categories in this mode's order, only those with something eligible, with counts. */
export function categoriesFor(mode, eligible) {
  const counts = new Map();
  for (const p of eligible) counts.set(p.category, (counts.get(p.category) || 0) + 1);
  const order = CATEGORY_ORDER[mode] || CATEGORY_ORDER.member;
  return PRODUCT_CATEGORIES
    .filter(c => counts.get(c.key) > 0)
    .sort((a, b) => (a.key === 'other') - (b.key === 'other') || order.indexOf(a.key) - order.indexOf(b.key))
    .map(c => ({ key: c.key, en: c.en, sw: c.sw, count: counts.get(c.key) }));
}

/**
 * All four layers. `products` are buyer-visible listings; `featured` is
 * [{ productId }] from the Featured system in its order; `paidPlacementIds`
 * are products with any live promotion; `orders` are recent paid orders.
 * → { mode, signalsUsed, categories, allProductsCount, sections } or { error }
 * `allProductsCount` is how many products GET /shop/products lists (the input `products`), so the
 * app can show an "All products" grid when no section reached the minimum, or "getting ready" at 0.
 */
/** The sections where personal signals may act (organic suggestion rails only). */
export const PERSONAL_SECTIONS = Object.freeze(['recommended', 'essentials']);
const sameIds = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);
const sameSections = (a, b) => a.length === b.length && a.every((s, i) => s.key === b[i].key && sameIds(s.productIds, b[i].productIds));

/**
 * All four layers. `products` are buyer-visible listings; `featured` is
 * [{ productId }] from the Featured system in its order; `paidPlacementIds`
 * are products with any live promotion; `orders` are recent paid orders.
 * → { mode, signalsUsed, categories, allProductsCount, sections, personalised } or { error }
 * `allProductsCount` is how many products GET /shop/products lists (the input `products`), so the
 * app can show an "All products" grid when no section reached the minimum, or "getting ready" at 0.
 *
 * `personalisation` (slice 2; null = Phase 1 exactly): { optedOut, history, audienceFor(mode) → { gender, ageBand } }.
 * A personal signal counts as used only when it changed the page compared with the page without it.
 * Gender/age act after assembly, inside a rail: the set of products never changes, only their order.
 */
export function buildShopHome({ mode, sessionUserType, heldUserTypes, memberProfile, trainerProfile, recentIds, ownVendorIds, suspendedVendorIds = [], products, featured, paidPlacementIds, orders, config = {}, now, personalisation = null }) {
  const identity = resolveShoppingMode({ requested: mode, sessionUserType, heldUserTypes });
  if (identity.error) return identity;
  const p = personalisation;
  let needs = buildNeeds({ mode: identity.mode, memberProfile, trainerProfile, recentIds, config, optedOut: Boolean(p?.optedOut) });
  const { eligible } = filterEligible(products, { ownVendorIds, suspendedVendorIds });
  const sales = salesStats(orders, { now });
  const assemble = n => assembleSections({ needs: n, eligible, featured, paidPlacementIds, sales, now, config });
  let sections = assemble(needs);
  const personal = {};
  const signals = [];

  if (p && !p.optedOut && p.history) {
    const withHistory = { ...needs, purchaseHistory: p.history };
    const changed = assemble(withHistory);
    if (!sameSections(sections, changed)) {
      for (const key of PERSONAL_SECTIONS) {
        const before = sections.find(s => s.key === key);
        const after = changed.find(s => s.key === key);
        if (after && (!before || !sameIds(before.productIds, after.productIds))) personal[key] = { ...personal[key], history: true };
      }
      signals.push('purchase_history');
      sections = changed;
      needs = withHistory;
    }
  }

  const audience = p && !p.optedOut && p.audienceFor ? p.audienceFor(identity.mode) : null;
  if (audience && (audience.gender || audience.ageBand)) {
    const rows = new Map(eligible.map(row => [row.id, row]));
    const rowOf = id => rows.get(id);
    let genderUsed = false;
    let ageUsed = false;
    sections = sections.map((s) => {
      if (!PERSONAL_SECTIONS.includes(s.key)) return s;
      const final = reorderForAudience(s.productIds, rowOf, audience);
      // Used only when the final order differs. A signal counts when the page without it would differ
      // from the final one, or when on its own it already gives the final order (both point the same way).
      if (sameIds(final, s.productIds)) return s;
      const byGender = reorderForAudience(s.productIds, rowOf, { gender: audience.gender });
      const byAge = reorderForAudience(s.productIds, rowOf, { ageBand: audience.ageBand });
      const g = !sameIds(final, byAge) || sameIds(final, byGender);
      const a = !sameIds(final, byGender) || sameIds(final, byAge);
      genderUsed ||= g;
      ageUsed ||= a;
      personal[s.key] = { ...personal[s.key], gender: g, age: a };
      return { ...s, productIds: final };
    });
    if (genderUsed) signals.push('profile_gender');
    if (ageUsed) signals.push('profile_age');
  }

  // Categories each section shows (for the bought-category reason).
  const catOf = new Map(eligible.map(row => [row.id, row.category]));
  const described = describeSections(sections.map(s => ({ ...s, categories: uniq(s.productIds.map(id => catOf.get(id))) })), needs, personal);
  return {
    mode: identity.mode,
    signalsUsed: [...needs.signalsUsed.filter(s => s !== 'recently_viewed' || sections.some(x => x.key === 'recently_viewed')), ...signals],
    categories: categoriesFor(identity.mode, eligible),
    allProductsCount: (products || []).length,
    sections: described,
    personalised: signals.length > 0,
  };
}
