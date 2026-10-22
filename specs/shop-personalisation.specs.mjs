// Shop personalisation (Phase 2 · slice 2): the pure rules, then the shop home service over the
// real shop rules with in-memory stores. Routes and the database: shop-personalisation-routes.specs.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  purchaseHistoryFrom, personalisationEligibility, audienceFrom, reorderForAudience, historyDaysFromEnv, eatDay,
  CONSUMABLE_CATEGORIES, REBUY_WINDOW_DAYS,
} from '../src/services/shop-personalisation.mjs';
import { parseProductTargets, withoutTargets, ageBandOf } from '../src/shared/product-targets.mjs';
import { buildShopHome } from '../src/services/shop-recommendations.mjs';
import { createShopService } from '../src/services/shop-service.mjs';
import { createShopHomeService, shopHomeConfigFromEnv } from '../src/services/shop-home-service.mjs';
import { createShopPreferenceService } from '../src/services/shop-preference-service.mjs';
import { createMemoryShopPreferenceStore } from '../src/infra/shop-preference-store-pg.mjs';
import { PRODUCT_CATEGORIES } from '../src/shared/product-categories.mjs';

const NOW = new Date('2026-10-22T08:00:00Z');
const DAY = 86_400_000;
const ago = days => new Date(NOW - days * DAY).toISOString();
const PERSONAL_CODES = ['bought_category', 'bought_product', 'profile_gender', 'profile_age'];
const PERSONAL_SIGNALS = ['purchase_history', 'profile_gender', 'profile_age'];
// Words that would name a gender or an age group, in either language.
const GENDER_AGE_WORDS = /\b(women|woman|men|man|female|male|ladies|her|his|wanawake|wanaume|mwanamke|mwanamume|kike|kiume|over \d+|under \d+|\d+\s*[-–]\s*\d+|60\+|umri)\b/i;

const order = (buyerId, items, extra = {}) => ({ id: `ord_${Math.random().toString(36).slice(2, 8)}`, buyerId, items, paymentStatus: 'paid', status: 'delivered', createdAt: ago(5), ...extra });
const line = (productId, name = productId, category = undefined) => ({ productId, name, qty: 1, ...(category ? { category } : {}) });

// ── pure rules ───────────────────────────────────────────────────────────────

test('history: only the person\'s own paid, not cancelled orders inside the window count', () => {
  const cat = { a: 'sportswear_footwear', b: 'equipment', c: 'health_recovery', d: 'events', e: 'accessories_gear', f: 'food_drinks' };
  const orders = [
    order('me', [line('a')]),
    order('me', [line('a')], { createdAt: ago(40) }),
    order('me_trainer', [line('f')]), // another persona of the same person
    order('someone_else', [line('b')]),
    order('me', [line('c')], { paymentStatus: 'pending' }),
    order('me', [line('c')], { paymentStatus: 'refunded' }),
    order('me', [line('d')], { status: 'cancelled' }),
    order('me', [line('e')], { createdAt: ago(400) }),
  ];
  const h = purchaseHistoryFrom(orders, { buyerIds: ['me', 'me_trainer'], now: NOW, days: 365, categoryOf: id => cat[id] });
  assert.deepEqual(h.categories, ['sportswear_footwear', 'food_drinks']);
  assert.deepEqual([...h.boughtProducts.keys()].sort(), ['a', 'f']);
  // Non-consumable bought 5 days ago is "just bought"; the consumable is not.
  assert.deepEqual([...h.recentNonConsumableIds], ['a']);
  assert.equal(purchaseHistoryFrom(orders, { buyerIds: ['nobody'], now: NOW, categoryOf: id => cat[id] }), null);
  assert.equal(purchaseHistoryFrom([], { buyerIds: ['me'], now: NOW }), null);
});

test('history: categories ranked by number of orders, then most recent; rebuy window and consumables', () => {
  const cat = { a: 'equipment', b: 'equipment', c: 'health_recovery', d: 'supplements_nutrition' };
  const h = purchaseHistoryFrom([
    order('me', [line('a'), line('b')], { createdAt: ago(100) }), // one order, one category count
    order('me', [line('c')], { createdAt: ago(50) }),
    order('me', [line('c')], { createdAt: ago(60) }),
    order('me', [line('d')], { createdAt: ago(1) }),
  ], { buyerIds: ['me'], now: NOW, categoryOf: id => cat[id] });
  assert.deepEqual(h.categories, ['health_recovery', 'supplements_nutrition', 'equipment']);
  assert.equal(h.recentNonConsumableIds.size, 0, `nothing non-consumable within ${REBUY_WINDOW_DAYS} days`);
  assert.deepEqual(CONSUMABLE_CATEGORIES, ['supplements_nutrition', 'food_drinks']);
  // A line keeps its own category when the product is no longer listed.
  const gone = purchaseHistoryFrom([order('me', [line('zz', 'Old', 'events')])], { buyerIds: ['me'], now: NOW });
  assert.deepEqual(gone.categories, ['events']);
});

test('SHOP_HISTORY_DAYS is whole days within 1..730, else 365', () => {
  assert.equal(historyDaysFromEnv({}), 365);
  assert.equal(historyDaysFromEnv({ SHOP_HISTORY_DAYS: '90' }), 90);
  for (const bad of ['0', '-3', '731', '1.5', 'x']) assert.equal(historyDaysFromEnv({ SHOP_HISTORY_DAYS: bad }), 365, bad);
});

test('eligibility: flag, adult member persona, under 18 and no date of birth', () => {
  const at = NOW;
  assert.deepEqual(personalisationEligibility({ flagOn: false, hasMember: true, memberProfile: { dateOfBirth: '1990-01-01' }, now: at }).available, false);
  assert.equal(personalisationEligibility({ flagOn: true, hasMember: false, memberProfile: null, now: at }).reason, 'no_member');
  const minor = personalisationEligibility({ flagOn: true, hasMember: true, memberProfile: { dateOfBirth: '2010-06-01' }, now: at });
  assert.deepEqual([minor.available, minor.reason, minor.age], [false, 'under_18', 16]);
  // 18th birthday is today (East Africa day): adult.
  const today = eatDay(at);
  const eighteen = `${Number(today.slice(0, 4)) - 18}${today.slice(4)}`;
  assert.equal(personalisationEligibility({ flagOn: true, hasMember: true, memberProfile: { dateOfBirth: eighteen }, now: at }).available, true);
  const noDob = personalisationEligibility({ flagOn: true, hasMember: true, memberProfile: { gender: 'female' }, now: at });
  assert.deepEqual([noDob.available, noDob.age], [true, null]);
});

test('audience: member mode only; declared gender and age band; other/unset gender is not used', () => {
  assert.deepEqual(audienceFrom({ mode: 'member', memberProfile: { gender: 'female' }, age: 33 }), { gender: 'women', ageBand: '30_44' });
  assert.deepEqual(audienceFrom({ mode: 'member', memberProfile: { gender: 'male' }, age: null }), { gender: 'men', ageBand: null });
  assert.deepEqual(audienceFrom({ mode: 'member', memberProfile: { gender: 'other' }, age: 61 }), { gender: null, ageBand: '60_plus' });
  for (const mode of ['trainer', 'owner', 'vendor_personal']) assert.deepEqual(audienceFrom({ mode, memberProfile: { gender: 'female' }, age: 30 }), { gender: null, ageBand: null }, mode);
  assert.deepEqual([17, 18, 29, 30, 44, 45, 59, 60].map(ageBandOf), [null, '18_29', '18_29', '30_44', '30_44', '45_59', '45_59', '60_plus']);
});

test('reorder: stable, never adds or drops; other-gender and untagged keep their relative order', () => {
  const rows = { a: {}, b: { targetGender: 'men' }, c: { targetGender: 'women' }, d: { targetAgeBands: ['30_44'] }, e: { targetGender: 'women', targetAgeBands: ['30_44'] }, f: {} };
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const out = reorderForAudience(ids, id => rows[id], { gender: 'women', ageBand: '30_44' });
  assert.deepEqual(out, ['e', 'c', 'd', 'a', 'b', 'f']);
  assert.deepEqual([...out].sort(), ids);
  assert.deepEqual(reorderForAudience(ids, id => rows[id], {}), ids);
});

test('product targets: values validated; bands stored in fixed order; buyer rows lose them', () => {
  assert.deepEqual(parseProductTargets({ targetGender: 'women', targetAgeBands: ['60_plus', '18_29'] }).patch, { targetGender: 'women', targetAgeBands: ['18_29', '60_plus'] });
  assert.deepEqual(parseProductTargets({ targetGender: null, targetAgeBands: [] }).patch, { targetGender: null, targetAgeBands: [] });
  assert.deepEqual(parseProductTargets({}).patch, {});
  for (const bad of ['female', 'everyone', 'WOMEN', 1, '']) assert.equal(parseProductTargets({ targetGender: bad }).field, 'targetGender', String(bad));
  for (const bad of ['18_29', ['18_29', '18_29'], ['kids'], [null], {}]) assert.equal(parseProductTargets({ targetAgeBands: bad }).field, 'targetAgeBands', JSON.stringify(bad));
  assert.deepEqual(withoutTargets({ id: 'p', targetGender: 'men', targetAgeBands: [], name: 'x' }), { id: 'p', name: 'x' });
});

// ── property: gender/age only reorder ───────────────────────────────────────

function prng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

test('property: with or without gender/age the product ids of every section are the same set; only order differs; no title names a group', () => {
  const cats = PRODUCT_CATEGORIES.map(c => c.key);
  const genders = [null, null, 'women', 'men'];
  const bands = [[], [], ['18_29'], ['30_44', '45_59'], ['60_plus']];
  for (let seed = 1; seed <= 200; seed += 1) {
    const r = prng(seed);
    const pick = list => list[Math.floor(r() * list.length)];
    const products = Array.from({ length: 6 + Math.floor(r() * 40) }, (_, i) => ({
      id: `p${seed}_${i}`, vendorId: `v${i % 4}`, name: `P${i}`, category: pick(cats), priceTzs: 10_000, discountPriceTzs: r() < 0.3 ? 5_000 : null,
      stock: 3, status: 'active', approvalStatus: 'approved', visibility: 'visible', homepageVisible: true, homepagePriority: Math.floor(r() * 3),
      createdAt: ago(Math.floor(r() * 120)), targetGender: pick(genders), targetAgeBands: pick(bands),
    }));
    const orders = products.filter(() => r() < 0.2).map(p => ({ buyerRole: 'member', items: [{ productId: p.id, qty: 1 }], paymentStatus: 'paid', status: 'delivered', createdAt: ago(3) }));
    const history = r() < 0.5 ? purchaseHistoryFrom([order('me', [line(pick(products).id)])], { buyerIds: ['me'], now: NOW, categoryOf: id => products.find(p => p.id === id)?.category }) : null;
    const audience = { gender: pick(['women', 'men', null]), ageBand: pick(['18_29', '30_44', '45_59', '60_plus', null]) };
    const base = { sessionUserType: 'member', heldUserTypes: [], memberProfile: { fitnessGoal: pick(['lose_weight', 'gain_muscle', null]) }, products, featured: [], paidPlacementIds: products.filter(() => r() < 0.1).map(p => p.id), orders, config: { minItems: 2 }, now: NOW };
    const without = buildShopHome({ ...base, personalisation: { optedOut: false, history, audienceFor: () => null } });
    const withAud = buildShopHome({ ...base, personalisation: { optedOut: false, history, audienceFor: () => audience } });
    assert.deepEqual(withAud.sections.map(s => s.key), without.sections.map(s => s.key), `seed ${seed}`);
    for (const [i, s] of withAud.sections.entries()) {
      assert.deepEqual([...s.productIds].sort(), [...without.sections[i].productIds].sort(), `seed ${seed} ${s.key}`);
      if (!['recommended', 'essentials'].includes(s.key)) assert.deepEqual(s.productIds, without.sections[i].productIds, `seed ${seed} ${s.key} untouched`);
      for (const text of [s.title.en, s.title.sw, s.reason.en, s.reason.sw]) assert.ok(!GENDER_AGE_WORDS.test(text), `seed ${seed}: "${text}"`);
      // A reason code is there exactly when the order changed in that rail.
      if (!sameOrder(s.productIds, without.sections[i].productIds)) assert.ok(s.reasonCodes.some(c => c === 'profile_gender' || c === 'profile_age'), `seed ${seed} ${s.key} code`);
      else assert.ok(!s.reasonCodes.includes('profile_gender') && !s.reasonCodes.includes('profile_age'), `seed ${seed} ${s.key} no code`);
    }
    assert.equal(withAud.allProductsCount, without.allProductsCount);
  }
});
const sameOrder = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// ── the service ─────────────────────────────────────────────────────────────

function memStore(rows = []) {
  return {
    rows,
    async filterAsync(fn) { return rows.filter(fn); },
    async findAsync(fn) { return rows.find(fn) || null; },
    async findByIdAsync(id) { return rows.find(r => r.id === id) || null; },
    async filterByColumnInAsync(col, values) { return rows.filter(r => values.includes(r[col])); },
    async insertAsync(row) { rows.push(row); return row; },
    async updateByIdAsync(id, patch) { const i = rows.findIndex(r => r.id === id); if (i >= 0) rows[i] = { ...rows[i], ...patch }; return rows[i] || null; },
  };
}

/**
 * users: [{ id, userType, personId?, memberProfile? }]. myOrders: every order in the "database";
 * buyerPaidOrders deliberately returns ALL of them (as a broken query would), so the rules have to
 * keep other people's orders out on their own.
 */
function setup({ users = [], orders = [], flag = true, live = [], env = {} } = {}) {
  const products = memStore();
  const userStore = memStore(users.map(u => ({ ...u })));
  const shopService = createShopService({
    products, shopOrders: memStore(), users: userStore, auditLog: { insertAsync: async () => {} },
    partnerGate: { operationalUserIds: async ids => new Set(ids), isOperational: async () => true, exempt: () => true },
    publicGate: { blocked: async () => new Set(), isBlocked: async () => false },
  });
  const identityLink = { personasOf: async personId => userStore.rows.filter(u => u.personId === personId) };
  const store = createMemoryShopPreferenceStore();
  const flagState = { on: flag };
  const preferences = createShopPreferenceService({ store, users: userStore, identityLink, flagOn: () => flagState.on, now: () => NOW });
  const seen = [];
  const deps = {
    shopService,
    discoveryService: { discover: async () => ({ featured: [] }) },
    promotionService: { listLive: async () => live.map(id => ({ entityType: 'product', entityId: id })) },
    users: userStore, trainerService: { findProfileByUser: () => null }, identityLink,
    recentPaidOrders: async () => orders.map(o => ({ ...o, buyerRole: o.buyerRole || 'member' })),
    config: () => shopHomeConfigFromEnv({ SHOP_HOME_MIN_ITEMS: '1', SHOP_HOME_CACHE_SECONDS: '300', ...env }),
    now: () => NOW,
  };
  const service = createShopHomeService({
    ...deps, preferences, personalisationOn: () => flagState.on,
    buyerPaidOrders: async ({ buyerIds }) => { seen.push([...buyerIds]); return orders; },
  });
  // Phase 1 exactly: no personalisation dependencies at all.
  const phase1 = createShopHomeService(deps);
  let n = 0;
  const add = (extra = {}) => {
    n += 1;
    const row = {
      id: `prd_${String(n).padStart(3, '0')}`, vendorId: 'v1', name: `P${n}`, category: 'equipment', priceTzs: 10_000, discountPriceTzs: null,
      stock: 3, status: 'active', approvalStatus: 'approved', visibility: 'visible', homepageVisible: true, homepagePriority: 0,
      rating: 0, reviewCount: 0, soldCount: 0, createdAt: new Date(NOW - n * 60_000).toISOString(), targetGender: null, targetAgeBands: [], ...extra,
    };
    products.rows.push(row);
    return row;
  };
  return { service, phase1, preferences, store, add, seen, flagState, users: userStore };
}
const sec = (body, key) => body.sections.find(s => s.key === key);
const ADULT_F = { id: 'm1', userType: 'member', personId: 'per1', memberProfile: { gender: 'female', dateOfBirth: '1990-05-01' } };
const claimsOf = u => ({ sub: u.id, userType: u.userType });

test('flag off: /shop/home is byte-identical to Phase 1, with history, tags and an opt-out all present', async () => {
  const s = setup({ users: [ADULT_F], flag: false, orders: [order('m1', [line('prd_001')])] });
  for (let i = 0; i < 8; i += 1) s.add({ category: i % 2 ? 'sportswear_footwear' : 'equipment', targetGender: i % 3 ? 'women' : null, targetAgeBands: ['30_44'] });
  await s.store.save({ personId: 'per1', subjectType: 'person', personalised: false, source: 'why_sheet', actorId: 'm1', at: NOW.toISOString() });
  for (const query of [{}, { mode: 'member', recent: 'prd_002' }]) {
    const a = await s.service.home({ claims: claimsOf(ADULT_F), query });
    const b = await s.phase1.home({ claims: claimsOf(ADULT_F), query });
    assert.equal(JSON.stringify(a.body), JSON.stringify(b.body));
    assert.ok(!('personalisation' in a.body));
    assert.equal(a.body.personalised, false);
  }
  assert.deepEqual(s.seen, [], 'no order read for history with the flag off');
});

test('on, with history: bought category first, "Recommended for you", bought_category reason, signal used', async () => {
  const s = setup({ users: [ADULT_F], orders: [order('m1', [line('prd_009', 'Running shoes')], { createdAt: ago(60) })], env: { SHOP_HOME_SECTIONS: 'recommended' } });
  for (let i = 0; i < 8; i += 1) s.add({ category: 'equipment' });
  for (let i = 0; i < 3; i += 1) s.add({ category: 'sportswear_footwear' }); // prd_009..011
  const off = await s.phase1.home({ claims: claimsOf(ADULT_F) });
  const on = await s.service.home({ claims: claimsOf(ADULT_F) });
  assert.deepEqual(on.body.personalisation, { available: true, enabled: true });
  assert.equal(on.body.personalised, true);
  assert.ok(on.body.signalsUsed.includes('purchase_history'));
  const rec = sec(on.body, 'recommended');
  // Bought category first; the shoes themselves (non-consumable, bought 60 days ago) may come back after 30 days.
  assert.deepEqual([...rec.productIds.slice(0, 3)].sort(), ['prd_009', 'prd_010', 'prd_011']);
  assert.deepEqual(rec.title, { en: 'Recommended for you', sw: 'Zilizopendekezwa kwako' });
  assert.equal(rec.reasonCodes[0], 'bought_product', 'the rail shows something bought before');
  assert.notDeepEqual(rec.productIds, sec(off.body, 'recommended').productIds);
  for (const row of Object.values(on.body.products)) assert.ok(!('targetGender' in row) && !('targetAgeBands' in row));
});

test('on, history: a non-consumable bought in the last 30 days is not suggested again; a consumable is (bought_product)', async () => {
  const s = setup({ users: [ADULT_F], orders: [order('m1', [line('prd_001', 'Dumbbell'), line('prd_005', 'Whey 1kg')], { createdAt: ago(3) })], env: { SHOP_HOME_SECTIONS: 'recommended,essentials' } });
  for (let i = 0; i < 4; i += 1) s.add({ category: 'equipment' });
  for (let i = 0; i < 4; i += 1) s.add({ category: 'supplements_nutrition' });
  const out = await s.service.home({ claims: claimsOf(ADULT_F) });
  const shown = out.body.sections.flatMap(x => x.productIds);
  assert.ok(!shown.includes('prd_001'), 'the dumbbell bought 3 days ago is not re-shown');
  assert.ok(shown.includes('prd_005'), 'the whey (consumable) may be bought again');
  const rec = sec(out.body, 'recommended');
  assert.equal(rec.reasonCodes[0], 'bought_product');
  assert.deepEqual(rec.reasonParams, { productName: 'Whey 1kg' });
  assert.equal(rec.reason.en, 'Suggested because you bought Whey 1kg.');
});

test('on, history only in a category the shop no longer has → bought_category names it from the list', async () => {
  const s = setup({ users: [ADULT_F], orders: [order('m1', [line('gone', 'Ticket', 'events')])], env: { SHOP_HOME_SECTIONS: 'essentials' } });
  for (let i = 0; i < 4; i += 1) s.add({ category: 'events' });
  for (let i = 0; i < 4; i += 1) s.add({ category: 'equipment' });
  const out = await s.service.home({ claims: claimsOf(ADULT_F) });
  const ess = sec(out.body, 'essentials');
  assert.equal(ess.reasonCodes[0], 'bought_category');
  assert.deepEqual(ess.reasonParams, { category: 'events' });
  const events = PRODUCT_CATEGORIES.find(c => c.key === 'events');
  assert.deepEqual(ess.reason, { en: `You've bought ${events.en} before.`, sw: `Uliwahi kununua ${events.sw}.` });
});

test('on, member mode: a Women-tagged product moves earlier; nothing added or removed; profile_gender only on that rail; no gender word', async () => {
  const s = setup({ users: [{ ...ADULT_F, memberProfile: { gender: 'female' } }], env: { SHOP_HOME_SECTIONS: 'recommended,new_arrivals' } });
  for (let i = 0; i < 6; i += 1) s.add({ category: 'equipment', targetGender: i === 5 ? 'women' : i === 4 ? 'men' : null });
  const off = await s.phase1.home({ claims: claimsOf(ADULT_F) });
  const on = await s.service.home({ claims: claimsOf(ADULT_F) });
  const a = sec(off.body, 'recommended').productIds;
  const b = sec(on.body, 'recommended').productIds;
  assert.deepEqual([...b].sort(), [...a].sort());
  assert.ok(b.indexOf('prd_006') < a.indexOf('prd_006'), 'tagged product moved earlier');
  assert.equal(b[0], 'prd_006');
  assert.ok(b.includes('prd_005'), 'Men-tagged product still shown');
  assert.ok(sec(on.body, 'recommended').reasonCodes.includes('profile_gender'));
  assert.ok(!sec(on.body, 'recommended').reasonCodes.includes('profile_age'), 'no date of birth: no age');
  assert.deepEqual(on.body.signalsUsed.filter(x => PERSONAL_SIGNALS.includes(x)), ['profile_gender']);
  assert.equal(on.body.personalised, true);
  for (const x of on.body.sections) assert.ok(!GENDER_AGE_WORDS.test(`${x.title.en} ${x.title.sw} ${x.reason.en} ${x.reason.sw}`), x.key);
  assert.ok(!('reasonParams' in sec(on.body, 'recommended')), 'gender carries no parameter');
});

test('on, age band from date of birth reorders (profile_age); gender other is not used', async () => {
  const u = { ...ADULT_F, memberProfile: { gender: 'other', dateOfBirth: '1960-01-01' } };
  const s = setup({ users: [u], env: { SHOP_HOME_SECTIONS: 'recommended' } });
  for (let i = 0; i < 5; i += 1) s.add({ targetGender: i === 3 ? 'women' : null, targetAgeBands: i === 4 ? ['60_plus'] : [] });
  const on = await s.service.home({ claims: claimsOf(u) });
  const rec = sec(on.body, 'recommended');
  assert.equal(rec.productIds[0], 'prd_005');
  assert.ok(rec.reasonCodes.includes('profile_age') && !rec.reasonCodes.includes('profile_gender'));
});

test('member mode only: the same adult in owner or trainer mode gets the off order for tagged products and no gender/age reason', async () => {
  const users = [ADULT_F, { id: 'o1', userType: 'gym_operator', personId: 'per1' }, { id: 't1', userType: 'trainer', personId: 'per1' }];
  const s = setup({ users, env: { SHOP_HOME_SECTIONS: 'recommended' } });
  for (let i = 0; i < 6; i += 1) s.add({ targetGender: i >= 3 ? 'women' : null, targetAgeBands: i >= 3 ? ['30_44'] : [] });
  for (const [claims, mode] of [[claimsOf(users[1]), undefined], [claimsOf(users[2]), undefined], [claimsOf(ADULT_F), 'owner'], [claimsOf(ADULT_F), 'trainer']]) {
    const off = await s.phase1.home({ claims, query: { mode } });
    const on = await s.service.home({ claims, query: { mode } });
    assert.deepEqual(sec(on.body, 'recommended').productIds, sec(off.body, 'recommended').productIds, `${claims.userType} ${mode}`);
    const codes = on.body.sections.flatMap(x => x.reasonCodes);
    assert.ok(!codes.includes('profile_gender') && !codes.includes('profile_age'));
    assert.deepEqual(on.body.personalisation, { available: true, enabled: true }, 'the person is an adult member, so history may still apply');
  }
});

test('under 18: personalisation fully off — no history, no gender, no age, tagged products not reordered', async () => {
  const kid = { id: 'k1', userType: 'member', personId: 'perk', memberProfile: { gender: 'female', dateOfBirth: '2010-03-01' } };
  const s = setup({ users: [kid], orders: [order('k1', [line('prd_006', 'Shoes')])], env: { SHOP_HOME_SECTIONS: 'recommended,essentials' } });
  for (let i = 0; i < 5; i += 1) s.add({ category: 'equipment', targetGender: i === 4 ? 'women' : null, targetAgeBands: i === 4 ? ['18_29'] : [] });
  for (let i = 0; i < 3; i += 1) s.add({ category: 'sportswear_footwear' });
  const off = await s.phase1.home({ claims: claimsOf(kid) });
  const on = await s.service.home({ claims: claimsOf(kid) });
  assert.deepEqual(on.body.personalisation, { available: false, enabled: false });
  assert.equal(on.body.personalised, false);
  assert.deepEqual(on.body.sections, off.body.sections, 'exactly the Phase 1 page');
  assert.ok(!on.body.sections.flatMap(x => x.reasonCodes).some(c => PERSONAL_CODES.includes(c)));
  assert.ok(!on.body.signalsUsed.some(x => PERSONAL_SIGNALS.includes(x)));
  assert.deepEqual(s.seen, [], 'a minor\'s orders are not even read');
  assert.deepEqual((await s.preferences.get({ claims: claimsOf(kid) })).body, { personalised: true, available: false });
});

test('no member persona (trainer only): not available, Phase 1 page', async () => {
  const t = { id: 't9', userType: 'trainer' };
  const s = setup({ users: [t], orders: [order('t9', [line('prd_001')])] });
  for (let i = 0; i < 5; i += 1) s.add();
  const on = await s.service.home({ claims: claimsOf(t) });
  assert.deepEqual(on.body.personalisation, { available: false, enabled: false });
  assert.deepEqual(on.body.sections, (await s.phase1.home({ claims: claimsOf(t) })).body.sections);
});

test('switch off: no personal reason or signal at all; "Popular in the shop"; declared goal dropped too', async () => {
  const u = { ...ADULT_F, memberProfile: { ...ADULT_F.memberProfile, fitnessGoal: 'gain_muscle' } };
  const s = setup({ users: [u], orders: [order('m1', [line('prd_007', 'Shoes')])] });
  for (let i = 0; i < 6; i += 1) s.add({ category: i < 3 ? 'supplements_nutrition' : 'equipment', targetGender: 'women', targetAgeBands: ['30_44'] });
  for (let i = 0; i < 3; i += 1) s.add({ category: 'sportswear_footwear' });
  const before = await s.service.home({ claims: claimsOf(u) });
  assert.equal(before.body.personalised, true);
  await s.preferences.set({ claims: claimsOf(u), body: { personalised: false, source: 'privacy_page' } });
  const out = await s.service.home({ claims: claimsOf(u) });
  assert.deepEqual(out.body.personalisation, { available: true, enabled: false });
  assert.equal(out.body.personalised, false);
  assert.deepEqual(out.body.signalsUsed, ['role']);
  const codes = out.body.sections.flatMap(x => x.reasonCodes);
  for (const c of [...PERSONAL_CODES, 'profile_goal', 'trainer_specialty']) assert.ok(!codes.includes(c), c);
  assert.ok(out.body.sections.every(x => !('reasonParams' in x)));
  assert.deepEqual(sec(out.body, 'recommended').title, { en: 'Popular in the shop', sw: 'Maarufu dukani' });
  assert.deepEqual(sec(out.body, 'recommended').reasonCodes, ['generic', 'role_context']);
  // Applies across roles of the same Person.
  s.users.rows.push({ id: 'o1', userType: 'gym_operator', personId: 'per1' });
  assert.deepEqual((await s.preferences.get({ claims: { sub: 'o1', userType: 'gym_operator' } })).body, { personalised: false, available: true });
});

test('recommended never holds a paid placement, even in a bought category', async () => {
  const s = setup({ users: [ADULT_F], live: ['prd_001', 'prd_002'], orders: [order('m1', [line('prd_009', 'x', 'sportswear_footwear')], { createdAt: ago(200) })], env: { SHOP_HOME_SECTIONS: 'recommended' } });
  for (let i = 0; i < 2; i += 1) s.add({ category: 'sportswear_footwear', targetGender: 'women' });
  for (let i = 0; i < 6; i += 1) s.add({ category: 'equipment' });
  const out = await s.service.home({ claims: claimsOf(ADULT_F) });
  const rec = sec(out.body, 'recommended').productIds;
  assert.ok(!rec.includes('prd_001') && !rec.includes('prd_002'));
});

test('isolation: another user\'s orders never leak, the shared cache holds nothing personal, each request reads only its own buyers', async () => {
  const other = { id: 'm2', userType: 'member', personId: 'per2', memberProfile: { gender: 'male', dateOfBirth: '1985-01-01' } };
  const s = setup({ users: [ADULT_F, other], orders: [order('m1', [line('prd_006', 'Shoes')]), order('someone', [line('prd_007', 'Mat')])], env: { SHOP_HOME_SECTIONS: 'recommended' } });
  for (let i = 0; i < 5; i += 1) s.add({ category: 'equipment' });
  s.add({ category: 'sportswear_footwear' }); // prd_006
  s.add({ category: 'accessories_gear' }); // prd_007
  for (let i = 0; i < 2; i += 1) s.add({ category: 'sportswear_footwear' });
  const mine = await s.service.home({ claims: claimsOf(ADULT_F) });
  const theirs = await s.service.home({ claims: claimsOf(other) });
  const phase1 = await s.phase1.home({ claims: claimsOf(other) });
  assert.equal(mine.body.personalised, true);
  assert.equal(theirs.body.personalised, false, 'm2 bought nothing: the orders of m1 and "someone" are not theirs');
  assert.deepEqual(theirs.body.sections, phase1.body.sections);
  assert.deepEqual(s.seen, [['m1'], ['m2']], 'each request asks for its own buyer ids only');
  // And again after the other user, from the same warm cache: still mine only.
  const again = await s.service.home({ claims: claimsOf(ADULT_F) });
  assert.deepEqual(again.body.sections, mine.body.sections);
  assert.ok(!sec(mine.body, 'recommended').reasonCodes.includes('bought_category') || sec(mine.body, 'recommended').reasonParams?.category !== 'accessories_gear');
});

test('preferences (service): default on, validation, change audited once, same value writes nothing; flag off refuses saves', async () => {
  const s = setup({ users: [ADULT_F, { id: 'solo', userType: 'member' }] });
  assert.deepEqual((await s.preferences.get({ claims: claimsOf(ADULT_F) })).body, { personalised: true, available: true });
  assert.deepEqual(await s.preferences.set({ claims: claimsOf(ADULT_F), body: { personalised: 'no', source: 'why_sheet' } }), { error: 'invalid_field', status: 400, field: 'personalised' });
  assert.equal((await s.preferences.set({ claims: claimsOf(ADULT_F), body: { personalised: false, source: 'settings' } })).field, 'source');
  assert.deepEqual((await s.preferences.set({ claims: claimsOf(ADULT_F), body: { personalised: false, source: 'why_sheet' } })).body, { personalised: false, available: true });
  await s.preferences.set({ claims: claimsOf(ADULT_F), body: { personalised: false, source: 'privacy_page' } });
  assert.equal(s.store.audit.length, 1);
  assert.deepEqual([s.store.audit[0].target, s.store.audit[0].before, s.store.audit[0].after], ['per1', { personalised: true }, { personalised: false, source: 'why_sheet' }]);
  // No Person: keyed by the user id.
  await s.preferences.set({ claims: { sub: 'solo', userType: 'member' }, body: { personalised: false, source: 'privacy_page' } });
  assert.equal(s.store.rows.get('solo').subjectType, 'user');
  s.flagState.on = false;
  assert.deepEqual(await s.preferences.set({ claims: claimsOf(ADULT_F), body: { personalised: true, source: 'why_sheet' } }), { error: 'feature_disabled', status: 404 });
  assert.deepEqual((await s.preferences.get({ claims: claimsOf(ADULT_F) })).body, { personalised: false, available: false });
});
