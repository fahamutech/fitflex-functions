// Shop home rules (pure): each of the four layers on its own, then all four together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveShoppingMode, buildNeeds, parseRecentIds, filterEligible, assembleSections, salesStats, parseSectionList,
  describeSections, categoriesFor, buildShopHome, SECTION_KEYS, NEEDS_PHASE2_FIELDS, DEFAULT_ROLE_CATEGORIES,
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
    product({ stock: 0 }), product({ stock: null }), product({ vendorId: 'me' }),
  ];
  const { eligible, excluded } = filterEligible(rows, { ownVendorIds: ['me', null] });
  assert.deepEqual(eligible.map(p => p.id), [ok.id]);
  assert.deepEqual(Object.values(excluded).sort(), ['deleted', 'hidden', 'hidden', 'inactive', 'not_approved', 'not_approved', 'out_of_stock', 'out_of_stock', 'own_product'].sort());
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
  assert.deepEqual(sections[0], { key: 'featured', productIds: rows.slice(0, 4).map(p => p.id), hasMore: false });
  for (const s of sections) assert.ok(s.productIds.length >= 4 && s.productIds.length <= 12, s.key);
});

test('assembly: recommended never holds a paid placement', () => {
  const rows = many(8);
  const paid = rows.slice(0, 5).map(p => p.id);
  const [rec] = assembleSections({ needs: needsFor('member'), eligible: rows, paidPlacementIds: paid, now: NOW, config: { sections: ['recommended'], minItems: 1 } });
  assert.deepEqual(rec.productIds, rows.slice(5).map(p => p.id));
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
  const keys = assembleSections({ needs: needsFor('member'), eligible: rows, now: NOW, config: { sections: parseSectionList('new_arrivals,deals') } }).map(s => s.key);
  assert.deepEqual(keys, ['new_arrivals']); // took all 8; deals had nothing left
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
