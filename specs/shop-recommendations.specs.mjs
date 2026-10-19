// Shop home rules (pure): each of the four layers on its own, then all four together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveShoppingMode, buildNeeds, parseRecentIds, filterEligible, assembleSections, salesStats, parseSectionList,
  describeSections, categoriesFor, buildShopHome, SECTION_KEYS, NEEDS_PHASE2_FIELDS, DEFAULT_ROLE_CATEGORIES, ALLOCATION_ORDER, onSale,
} from '../src/services/shop-recommendations.mjs';
import { PRODUCT_CATEGORY_KEYS } from '../src/shared/product-categories.mjs';

const NOW = new Date('2026-10-19T08:00:00Z');
const daysAgo = d => new Date(NOW.getTime() - d * 86_400_000).toISOString();
let seq = 0;
const product = (extra = {}) => {
  seq += 1;
  return {
    id: `p${String(seq).padStart(3, '0')}`, vendorId: 'v1', name: `Product ${seq}`, category: 'equipment',
    priceTzs: 10_000, discountPriceTzs: null, stock: 5, status: 'active', approvalStatus: 'approved',
    visibility: 'visible', homepageVisible: true, homepagePriority: 0, createdAt: daysAgo(200), ...extra,
  };
};
const many = (n, extra) => Array.from({ length: n }, () => product(extra));
const order = (items, extra = {}) => ({ buyerRole: 'member', paymentStatus: 'paid', status: 'delivered', createdAt: daysAgo(2), items, ...extra });
const needsFor = (mode, extra = {}) => buildNeeds({ mode, ...extra });
const only = (sections, keys) => sections.filter(s => keys.includes(s.key));

// ── (a) identity ─────────────────────────────────────────────────────────────

test('identity: the signed-in role is the default mode', () => {
  assert.deepEqual(resolveShoppingMode({ sessionUserType: 'member' }), { mode: 'member' });
  assert.deepEqual(resolveShoppingMode({ sessionUserType: 'trainer' }), { mode: 'trainer' });
  assert.deepEqual(resolveShoppingMode({ sessionUserType: 'gym_operator' }), { mode: 'owner' });
  assert.deepEqual(resolveShoppingMode({ sessionUserType: 'vendor' }), { mode: 'vendor_personal' });
});

test('identity: a mode the account does not hold is refused, one it holds is accepted', () => {
  assert.deepEqual(resolveShoppingMode({ requested: 'owner', sessionUserType: 'member' }), { error: 'mode_not_allowed' });
  assert.deepEqual(resolveShoppingMode({ requested: 'vendor_personal', sessionUserType: 'member', heldUserTypes: ['trainer'] }), { error: 'mode_not_allowed' });
  assert.deepEqual(resolveShoppingMode({ requested: 'admin', sessionUserType: 'admin' }), { error: 'mode_not_allowed' });
  assert.deepEqual(resolveShoppingMode({ requested: 'owner', sessionUserType: 'member', heldUserTypes: ['gym_operator'] }), { mode: 'owner' });
});

test('identity: a non-shopping role falls back to a held shopping persona, or is refused', () => {
  assert.deepEqual(resolveShoppingMode({ sessionUserType: 'gym_staff', heldUserTypes: ['trainer', 'member'] }), { mode: 'member' });
  assert.deepEqual(resolveShoppingMode({ sessionUserType: 'admin' }), { error: 'mode_not_allowed' });
  assert.deepEqual(resolveShoppingMode({ sessionUserType: 'vendor_staff' }), { error: 'mode_not_allowed' });
});

// ── (b) needs ────────────────────────────────────────────────────────────────

test('needs: role defaults per mode, all from the existing 8 categories', () => {
  for (const mode of ['member', 'trainer', 'owner', 'vendor_personal']) {
    const n = needsFor(mode);
    assert.deepEqual(n.roleCategories, DEFAULT_ROLE_CATEGORIES[mode]);
    assert.ok(n.roleCategories.length > 0);
    for (const c of n.roleCategories) assert.ok(PRODUCT_CATEGORY_KEYS.has(c), c);
    assert.deepEqual(n.signalsUsed, ['role']);
  }
  assert.equal(needsFor('owner').roleCategories[0], 'equipment');
  assert.equal(needsFor('trainer').roleCategories[0], 'accessories_gear');
});

test('needs: missing or incomplete profiles fall back to role defaults', () => {
  for (const memberProfile of [null, {}, { fitnessGoals: 'gain_muscle' }, { fitnessGoal: 'not_a_goal' }, { fitnessGoals: [42] }]) {
    const n = needsFor('member', { memberProfile });
    assert.deepEqual(n.goalCategories, []);
    assert.deepEqual(n.categories, DEFAULT_ROLE_CATEGORIES.member);
    assert.deepEqual(n.signalsUsed, ['role']);
  }
  assert.deepEqual(needsFor('trainer', { trainerProfile: null }).specialtyCategories, []);
  assert.deepEqual(needsFor('trainer', { trainerProfile: { specialties: ['Women Only'] } }).specialtyCategories, []);
});

test('needs: a declared member goal and declared trainer specialties come first', () => {
  const m = needsFor('member', { memberProfile: { fitnessGoals: ['improve_endurance'] } });
  assert.deepEqual(m.goalCategories, ['sportswear_footwear', 'food_drinks', 'health_recovery']);
  assert.equal(m.categories[0], 'sportswear_footwear');
  assert.deepEqual(m.signalsUsed, ['role', 'goal']);
  const t = needsFor('trainer', { trainerProfile: { specialties: ['Yoga', 'Boxing'] } });
  assert.deepEqual(t.specialtyCategories, ['accessories_gear', 'health_recovery', 'equipment']);
  assert.deepEqual(t.signalsUsed, ['role', 'specialty']);
  // A goal is a member-profile field: it is not used when shopping as an owner.
  assert.deepEqual(needsFor('owner', { memberProfile: { fitnessGoals: ['lose_weight'] } }).goalCategories, []);
});

test('needs: recent ids are cleaned, de-duplicated and capped at 20; Phase 2 fields are present and empty', () => {
  const ids = Array.from({ length: 30 }, (_, i) => `prd_${i}`);
  assert.equal(parseRecentIds(ids.join(',')).length, 20);
  assert.deepEqual(parseRecentIds(' a1, a1 ,bad id!,,b2'), ['a1', 'b2']);
  assert.deepEqual(parseRecentIds(undefined), []);
  const n = needsFor('member', { recentIds: 'a1,b2' });
  assert.deepEqual(n.recentIds, ['a1', 'b2']);
  assert.ok(n.signalsUsed.includes('recently_viewed'));
  for (const f of NEEDS_PHASE2_FIELDS) assert.equal(n[f], null, f);
});

// ── (c) eligibility ──────────────────────────────────────────────────────────

test('eligibility: inactive, unapproved, hidden, unlisted, deleted, out of stock and own products are out', () => {
  const ok = product();
  const rows = [
    ok,
    product({ status: 'paused' }), product({ approvalStatus: 'pending' }), product({ approvalStatus: 'rejected' }),
    product({ visibility: 'hidden' }), product({ homepageVisible: false }), product({ deletedAt: daysAgo(1) }),
    product({ stock: 0 }), product({ stock: null }), product({ vendorId: 'me' }), product({ vendorId: 'v_suspended' }),
  ];
  const { eligible, excluded } = filterEligible(rows, { ownVendorIds: ['me', null], suspendedVendorIds: ['v_suspended'] });
  assert.deepEqual(eligible.map(p => p.id), [ok.id]);
  assert.deepEqual(Object.values(excluded).sort(), ['deleted', 'hidden', 'hidden', 'inactive', 'not_approved', 'not_approved', 'out_of_stock', 'out_of_stock', 'own_product', 'vendor_suspended'].sort());
});

// ── (d) assembly ─────────────────────────────────────────────────────────────

test('assembly: sections with fewer than minItems are left out and their products stay free', () => {
  const deals = many(3, { discountPriceTzs: 5_000, category: 'other' });
  const fresh = many(5, { createdAt: daysAgo(1), category: 'other' });
  const sections = assembleSections({ needs: needsFor('member'), eligible: [...deals, ...fresh], now: NOW, config: { sections: ['deals', 'new_arrivals'], minItems: 4 } });
  assert.deepEqual(sections.map(s => s.key), ['new_arrivals']);
  assert.equal(sections[0].productIds.length, 5);
  assert.deepEqual(assembleSections({ needs: needsFor('member'), eligible: [], now: NOW }), []);
});

test('assembly: no product appears in two sections; the first section in order wins', () => {
  const rows = many(30, { discountPriceTzs: 5_000, createdAt: daysAgo(3) });
  const orders = rows.slice(0, 10).map(p => order([{ productId: p.id, qty: 1 }]));
  const sections = assembleSections({
    needs: needsFor('member', { recentIds: rows.map(p => p.id).join(',') }), eligible: rows,
    featured: rows.slice(0, 4).map(p => ({ productId: p.id })), paidPlacementIds: rows.slice(0, 4).map(p => p.id),
    sales: salesStats(orders, { now: NOW }), now: NOW,
  });
  const all = sections.flatMap(s => s.productIds);
  assert.equal(new Set(all).size, all.length, 'unique across sections');
  assert.deepEqual(sections[0], { key: 'featured', productIds: rows.slice(0, 4).map(p => p.id), hasMore: false, viewAll: { path: '/shop/products', query: { category: 'equipment' } } });
  for (const s of sections) assert.ok(s.productIds.length >= 4 && s.productIds.length <= 12, s.key);
});

test('assembly: recommended never holds a paid placement', () => {
  const rows = many(8);
  const paid = rows.slice(0, 5).map(p => p.id);
  const [rec] = assembleSections({ needs: needsFor('member'), eligible: rows, paidPlacementIds: paid, now: NOW, config: { sections: ['recommended'], minItems: 1 } });
  assert.deepEqual(rec.productIds, rows.slice(5).map(p => p.id));
});

test('assembly: essentials hold no paid placement either', () => {
  const rows = many(6, { category: 'equipment' });
  const paid = [rows[0].id, rows[2].id];
  const [ess] = assembleSections({ needs: needsFor('owner'), eligible: rows, paidPlacementIds: paid, now: NOW, config: { sections: ['essentials'], minItems: 1 } });
  assert.deepEqual(ess.productIds, [rows[1], rows[3], rows[4], rows[5]].map(p => p.id));
});

test('assembly: recommended puts the role\'s categories first, then what that role buys', () => {
  const food = product({ category: 'food_drinks' });
  const plainEquip = product({ category: 'equipment' });
  const ownerFavourite = product({ category: 'equipment' });
  const memberFavourite = product({ category: 'equipment' });
  const sales = salesStats([
    order([{ productId: ownerFavourite.id, qty: 1 }], { buyerRole: 'gym_operator' }),
    order([{ productId: memberFavourite.id, qty: 1 }]), order([{ productId: memberFavourite.id, qty: 1 }]),
    order([{ productId: food.id, qty: 9 }], { buyerRole: 'gym_operator' }),
  ], { now: NOW });
  const ids = mode => assembleSections({ needs: needsFor(mode), eligible: [food, plainEquip, ownerFavourite, memberFavourite], sales, now: NOW, config: { sections: ['recommended'], minItems: 1 } })[0].productIds;
  assert.deepEqual(ids('owner'), [ownerFavourite.id, memberFavourite.id, plainEquip.id, food.id]);
  assert.deepEqual(ids('member'), [memberFavourite.id, ownerFavourite.id, plainEquip.id, food.id]);
});

test('assembly: best sellers count paid, uncancelled orders of the last 30 days, never soldCount', () => {
  const [a, b, c, d] = many(4);
  a.soldCount = 1_000; // stored counter: ignored
  const orders = [
    order([{ productId: b.id, qty: 1 }]), order([{ productId: b.id, qty: 1 }]),
    order([{ productId: c.id, qty: 5 }]),
    order([{ productId: d.id, qty: 1 }], { status: 'cancelled' }),
    order([{ productId: d.id, qty: 1 }], { paymentStatus: 'pending' }),
    order([{ productId: d.id, qty: 1 }], { createdAt: daysAgo(31) }),
  ];
  const [best] = assembleSections({ needs: needsFor('member'), eligible: [a, b, c, d], sales: salesStats(orders, { now: NOW }), now: NOW, config: { sections: ['best_sellers'], minItems: 1 } });
  assert.deepEqual(best.productIds, [b.id, c.id]);
});

test('assembly: essentials take turns across the needed categories', () => {
  const eq = many(3, { category: 'equipment' });
  const acc = many(3, { category: 'accessories_gear' });
  const other = many(3, { category: 'events' });
  const [ess] = assembleSections({ needs: needsFor('trainer'), eligible: [...eq, ...acc, ...other], now: NOW, config: { sections: ['essentials'], minItems: 1 } });
  assert.deepEqual(ess.productIds, [acc[0], eq[0], acc[1], eq[1], acc[2], eq[2]].map(p => p.id));
});

test('assembly: recently viewed keeps the app\'s order and drops what is not eligible', () => {
  const rows = many(5);
  const recent = [rows[3].id, 'gone', rows[0].id, rows[4].id, rows[1].id].join(',');
  const [rv] = assembleSections({ needs: needsFor('member', { recentIds: recent }), eligible: rows, now: NOW, config: { sections: ['recently_viewed'] } });
  assert.deepEqual(rv.productIds, [rows[3].id, rows[0].id, rows[4].id, rows[1].id]);
});

test('assembly: deals are real discounts, biggest first; new arrivals are recent, newest first', () => {
  const small = product({ priceTzs: 10_000, discountPriceTzs: 9_000 });
  const big = product({ priceTzs: 10_000, discountPriceTzs: 5_000 });
  const fake = product({ priceTzs: 10_000, discountPriceTzs: 12_000 });
  const zero = product({ priceTzs: 10_000, discountPriceTzs: 0 });
  const [deals] = assembleSections({ needs: needsFor('member'), eligible: [small, big, fake, zero], now: NOW, config: { sections: ['deals'], minItems: 1 } });
  assert.deepEqual(deals.productIds, [big.id, small.id]);
  const old = product({ createdAt: daysAgo(120) });
  const newer = product({ createdAt: daysAgo(1) });
  const newest = product({ createdAt: daysAgo(0) });
  const [na] = assembleSections({ needs: needsFor('member'), eligible: [old, newer, newest], now: NOW, config: { sections: ['new_arrivals'], minItems: 1 } });
  assert.deepEqual(na.productIds, [newest.id, newer.id]);
});

test('assembly: SHOP_HOME_SECTIONS chooses and orders sections; unknown keys are ignored', () => {
  assert.deepEqual(parseSectionList(undefined), [...SECTION_KEYS]);
  assert.deepEqual(parseSectionList(''), [...SECTION_KEYS]);
  assert.deepEqual(parseSectionList('deals, featured,nope,deals'), ['deals', 'featured']);
  assert.ok(!SECTION_KEYS.includes('popular_near_you'), 'Phase 2');
  const rows = many(8, { discountPriceTzs: 5_000, createdAt: daysAgo(1) });
  // Display order follows the setting; allocation does not: deals is allocated before new arrivals, takes all 8, and new arrivals has nothing left.
  const keys = assembleSections({ needs: needsFor('member'), eligible: rows, now: NOW, config: { sections: parseSectionList('new_arrivals,deals') } }).map(s => s.key);
  assert.deepEqual(keys, ['deals']);
  const both = assembleSections({ needs: needsFor('member'), eligible: [...rows, ...many(4, { createdAt: daysAgo(1) })], now: NOW, config: { sections: parseSectionList('new_arrivals,deals') } }).map(s => s.key);
  assert.deepEqual(both, ['new_arrivals', 'deals'], 'shown in the configured order');
});

test('copy: every section has English and Swahili title and reason for every mode', () => {
  for (const mode of ['member', 'trainer', 'owner', 'vendor_personal']) {
    const needs = needsFor(mode);
    const described = describeSections(SECTION_KEYS.map(key => ({ key, productIds: [], hasMore: false })), needs);
    for (const s of described) {
      for (const field of ['title', 'reason']) {
        assert.ok(s[field].en && s[field].sw && s[field].en !== s[field].sw, `${mode}.${s.key}.${field}`);
      }
      assert.equal(s.viewAll.path, '/shop/products');
      assert.ok(Array.isArray(s.reasonCodes) && s.reasonCodes.length);
    }
  }
  const self = describeSections([{ key: 'essentials', productIds: [], hasMore: false }], needsFor('vendor_personal'))[0];
  assert.deepEqual(self.reason, { en: "You're shopping for yourself.", sw: 'Unanunua kwa ajili yako mwenyewe.' });
  for (const mode of ['member', 'trainer', 'owner', 'vendor_personal']) {
    const all = describeSections(SECTION_KEYS.map(key => ({ key, productIds: [], hasMore: false })), needsFor(mode));
    if (mode === 'vendor_personal') assert.ok(all.every(s => !/as a member/.test(s.reason.en) && !/kama mwanachama/.test(s.reason.sw)), 'vendor never told they shop as a member');
  }
  const owner = describeSections([{ key: 'featured', productIds: [], hasMore: false }], needsFor('owner'))[0];
  assert.equal(owner.title.en, 'Featured equipment');
});

test('categories: in the mode\'s order, only those with eligible products, "other" last', () => {
  const rows = [product({ category: 'other' }), product({ category: 'equipment' }), product({ category: 'sportswear_footwear' }), product({ category: 'equipment' })];
  assert.deepEqual(categoriesFor('owner', rows).map(c => [c.key, c.count]), [['equipment', 2], ['sportswear_footwear', 1], ['other', 1]]);
  assert.deepEqual(categoriesFor('member', rows).map(c => c.key), ['sportswear_footwear', 'equipment', 'other']);
  assert.ok(categoriesFor('member', rows).every(c => c.en && c.sw));
});

test('all layers: vendor shopping personally never sees own products; faked mode is refused', () => {
  const mine = many(6, { vendorId: 'v_me', createdAt: daysAgo(1) });
  const theirs = many(6, { vendorId: 'v_other', createdAt: daysAgo(1) });
  const out = buildShopHome({ sessionUserType: 'vendor', ownVendorIds: ['v_me'], products: [...mine, ...theirs], orders: [], now: NOW });
  assert.equal(out.mode, 'vendor_personal');
  const ids = new Set(out.sections.flatMap(s => s.productIds));
  assert.ok(ids.size > 0);
  for (const p of mine) assert.ok(!ids.has(p.id));
  assert.deepEqual(buildShopHome({ mode: 'owner', sessionUserType: 'member', products: theirs, orders: [], now: NOW }), { error: 'mode_not_allowed' });
});

test('all layers: signalsUsed lists only what contributed', () => {
  const rows = many(6, { createdAt: daysAgo(1) });
  assert.deepEqual(buildShopHome({ sessionUserType: 'member', products: rows, orders: [], now: NOW }).signalsUsed, ['role']);
  // Recent ids that are all ineligible do not count as used.
  assert.deepEqual(buildShopHome({ sessionUserType: 'member', recentIds: 'x1,x2', products: rows, orders: [], now: NOW }).signalsUsed, ['role']);
  const withRecent = buildShopHome({ sessionUserType: 'member', recentIds: rows.map(p => p.id).join(','), products: rows, orders: [], now: NOW, config: { sections: ['recently_viewed'] } });
  assert.deepEqual(withRecent.signalsUsed, ['role', 'recently_viewed']);
});

test('all layers: same input, same page', () => {
  const rows = many(25, { discountPriceTzs: 4_000, createdAt: daysAgo(2) });
  const input = { sessionUserType: 'member', products: rows, orders: rows.slice(0, 6).map(p => order([{ productId: p.id, qty: 1 }])), now: NOW };
  assert.deepEqual(buildShopHome(input), buildShopHome({ ...input, products: [...rows].reverse() }));
});

// ── QA round 1 ───────────────────────────────────────────────────────────────

test('order: Featured, Best sellers, then Recommended (design §5.1 / DD-7), so top sellers stay in Best sellers', () => {
  assert.deepEqual(SECTION_KEYS.slice(0, 3), ['featured', 'best_sellers', 'recommended']);
  assert.deepEqual(ALLOCATION_ORDER.slice(0, 3), ['featured', 'best_sellers', 'recently_viewed']);
  // Every product sells, in the role's category: recommended would rank the same top sellers first.
  const rows = many(20, { category: 'equipment' });
  const orders = rows.slice(0, 10).flatMap((p, i) => Array.from({ length: 10 - i }, () => order([{ productId: p.id, qty: 1 }])));
  const out = buildShopHome({ sessionUserType: 'member', products: rows, orders, now: NOW, config: { sections: ['best_sellers', 'recommended'] } });
  assert.deepEqual(out.sections.map(x => x.key), ['best_sellers', 'recommended']);
  assert.deepEqual(out.sections[0].productIds.slice(0, 4), rows.slice(0, 4).map(p => p.id), 'the four top sellers are in Best sellers');
  for (const id of out.sections[0].productIds) assert.ok(!out.sections[1].productIds.includes(id));
});

test('recently viewed takes its products before the suggestion sections but is shown in its own place', () => {
  const rows = many(30, { discountPriceTzs: 5_000, createdAt: daysAgo(1), category: 'equipment' });
  const recent = rows.slice(10, 15).map(p => p.id);
  const out = buildShopHome({ sessionUserType: 'member', recentIds: recent.join(','), products: rows, orders: [], now: NOW });
  const keys = out.sections.map(x => x.key);
  const rv = out.sections.find(x => x.key === 'recently_viewed');
  assert.ok(rv, 'recently viewed is shown even though every product also fits recommended, essentials, deals and new arrivals');
  assert.deepEqual(rv.productIds, recent);
  assert.ok(keys.indexOf('recommended') < keys.indexOf('recently_viewed') && keys.indexOf('essentials') < keys.indexOf('recently_viewed'), 'display order per spec');
  const all = out.sections.flatMap(x => x.productIds);
  assert.equal(new Set(all).size, all.length, 'still no duplicates');
  // Featured and Best sellers still win over recently viewed (DD-7).
  const sold = rows.slice(10, 14);
  const withSales = buildShopHome({ sessionUserType: 'member', recentIds: recent.join(','), products: rows, orders: sold.map(p => order([{ productId: p.id, qty: 1 }])), now: NOW });
  assert.deepEqual(withSales.sections.find(x => x.key === 'best_sellers').productIds, sold.map(p => p.id));
  assert.equal(withSales.sections.find(x => x.key === 'recently_viewed'), undefined, 'only one recent product left: below the minimum');
});

/** Would GET /shop/products with this query list this product? (the filters the home uses) */
const listMatches = (query, p) => (!query.category || p.category === query.category) && (query.promotions !== 'true' || onSale(p));

test('view all: every section\'s query lists every product it shows; mixed categories carry no category', () => {
  const mixed = [
    ...many(15, { category: 'equipment', createdAt: daysAgo(1) }),
    ...many(15, { category: 'accessories_gear', discountPriceTzs: 5_000, createdAt: daysAgo(1) }),
    ...many(15, { category: 'supplements_nutrition', discountPriceTzs: 5_000 }),
    ...many(15, { category: 'events', createdAt: daysAgo(1) }),
  ];
  const orders = mixed.slice(0, 5).map(p => order([{ productId: p.id, qty: 1 }]));
  const byId = new Map(mixed.map(p => [p.id, p]));
  for (const mode of ['member', 'trainer', 'owner']) {
    const out = buildShopHome({ sessionUserType: { member: 'member', trainer: 'trainer', owner: 'gym_operator' }[mode], recentIds: mixed.slice(16, 20).map(p => p.id).join(','),
      products: mixed, featured: mixed.slice(26, 30).map(p => ({ productId: p.id })), orders, now: NOW, config: { minItems: 1 } });
    assert.deepEqual(out.sections.map(x => x.key), SECTION_KEYS, `${mode}: every section present`);
    for (const sec of out.sections) {
      assert.equal(sec.viewAll.path, '/shop/products');
      const shown = sec.productIds.map(id => byId.get(id));
      for (const p of shown) assert.ok(listMatches(sec.viewAll.query, p), `${mode}.${sec.key}: ${p.id} not in its view all`);
      const cats = new Set(shown.map(p => p.category));
      if (cats.size > 1) assert.equal(sec.viewAll.query.category, undefined, `${mode}.${sec.key} mixes categories`);
      else assert.equal(sec.viewAll.query.category, [...cats][0], `${mode}.${sec.key} is one category`);
    }
  }
  // The reported case (UAT D5): a member's rail with equipment, accessories and supplements said {category:'equipment'}.
  const small = [...many(2, { category: 'equipment' }), ...many(2, { category: 'accessories_gear' }), ...many(2, { category: 'supplements_nutrition' })];
  const rec = buildShopHome({ sessionUserType: 'member', products: small, orders: [], now: NOW, config: { sections: ['recommended'] } }).sections[0];
  assert.equal(new Set(rec.productIds.map(id => small.find(p => p.id === id).category)).size, 3);
  assert.deepEqual(rec.viewAll.query, { sort: 'popularity' });
  // And a rail that is all one category says so.
  const oneCat = buildShopHome({ sessionUserType: 'member', products: mixed, orders: [], now: NOW, config: { sections: ['recommended'] } }).sections[0];
  assert.deepEqual(oneCat.viewAll.query, { category: 'equipment', sort: 'popularity' });
});

test('view all: sections the list cannot reproduce never claim more', () => {
  const rows = many(40, { createdAt: daysAgo(1), discountPriceTzs: 5_000 });
  const cats = ['equipment', 'accessories_gear'];
  rows.forEach((p, i) => { p.category = cats[i % 2]; });
  const out = buildShopHome({ sessionUserType: 'gym_operator', recentIds: rows.slice(0, 20).map(p => p.id).join(','), products: rows,
    featured: rows.slice(20, 34).map(p => ({ productId: p.id })), orders: [], now: NOW, config: { sections: ['featured', 'recently_viewed', 'essentials', 'new_arrivals', 'deals'], minItems: 1 } });
  const get = k => out.sections.find(x => x.key === k);
  for (const k of ['featured', 'recently_viewed', 'new_arrivals']) assert.equal(get(k)?.hasMore ?? false, false, k);
  assert.equal(get('featured').productIds.length, 12, 'more were featured, but the list cannot show "all featured"');
  // Essentials across several categories cannot be reproduced either; a single-category one can.
  const ess = get('essentials');
  if (ess && new Set(ess.productIds.map(id => rows.find(p => p.id === id).category)).size > 1) assert.equal(ess.hasMore, false);
  const one = many(20, { category: 'equipment' });
  const single = buildShopHome({ sessionUserType: 'gym_operator', products: one, orders: [], now: NOW, config: { sections: ['essentials'] } }).sections[0];
  assert.deepEqual(single.viewAll.query, { category: 'equipment' });
  assert.equal(single.hasMore, true);
});

test('featured: same set for every role, ordered by the role\'s category order', () => {
  const sw = product({ category: 'sportswear_footwear' });
  const eq = product({ category: 'equipment' });
  const acc = product({ category: 'accessories_gear' });
  const sup = product({ category: 'supplements_nutrition' });
  const featured = [sw, eq, acc, sup].map(p => ({ productId: p.id }));
  const ids = userType => buildShopHome({ sessionUserType: userType, products: [sw, eq, acc, sup], featured, orders: [], now: NOW, config: { sections: ['featured'] } }).sections[0].productIds;
  assert.deepEqual(ids('gym_operator'), [eq, acc, sup, sw].map(p => p.id));
  assert.deepEqual(ids('trainer'), [acc, eq, sw, sup].map(p => p.id));
  assert.deepEqual(ids('member'), [sw, sup, acc, eq].map(p => p.id));
  for (const t of ['gym_operator', 'trainer', 'member']) assert.deepEqual([...ids(t)].sort(), [sw, eq, acc, sup].map(p => p.id).sort());
  // Within a category the Featured system's own order is kept.
  const e2 = product({ category: 'equipment' });
  const kept = buildShopHome({ sessionUserType: 'gym_operator', products: [eq, e2, sw, acc], featured: [e2, sw, eq, acc].map(p => ({ productId: p.id })), orders: [], now: NOW, config: { sections: ['featured'] } });
  assert.deepEqual(kept.sections[0].productIds, [e2, eq, acc, sw].map(p => p.id));
});

test('small catalogue: no section reaches the minimum, categories and allProductsCount still come back', () => {
  const rows = [product({ category: 'equipment' }), product({ category: 'other' }), product({ category: 'equipment', stock: 0 })];
  const out = buildShopHome({ sessionUserType: 'member', products: rows, orders: [], now: NOW });
  assert.deepEqual(out.sections, []);
  assert.deepEqual(out.categories.map(c => [c.key, c.count]), [['equipment', 1], ['other', 1]]);
  assert.equal(out.allProductsCount, 3, 'everything GET /shop/products lists, out of stock included');
  assert.equal(buildShopHome({ sessionUserType: 'member', products: [], orders: [], now: NOW }).allProductsCount, 0);
});
