// Shop home: the service over the real shop rules (with fake gates), then
// GET /shop/home and product create against the CI database.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { ensureInit } from '../functions/index.mjs';
import { shopHome, allowShopHome, resetShopHomeLimits, SHOP_HOME_LIMIT } from '../functions/shop-home.mjs';
import { vendorCreateProduct } from '../functions/shop.mjs';
import { shopHomeService } from '../src/bootstrap/services.mjs';
import { createShopService } from '../src/services/shop-service.mjs';
import { createShopHomeService, shopHomeConfigFromEnv, CACHE_SECONDS } from '../src/services/shop-home-service.mjs';
import { makeWorld, approved, HOUR } from './support/promotion-fixtures.mjs';
import { verifyServedToken, signServedToken } from '../src/auth/promotion-token.mjs';

await ensureInit();

const NOW = new Date('2026-10-19T08:00:00Z');
const uid = p => `${p}_${randomUUID().slice(0, 8)}`;

// ── the service, over the real shop rules, with fakes around it ──────────────

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

function setup({ personas = [], unverifiedVendors = [], blockedProducts = [], blockedVendors = [], featured = [], live = [], orders = [], users: extraUsers = [], trainers = [], env = {}, promotionService = null, ordersDelayMs = 0 } = {}) {
  const products = memStore();
  const users = memStore([...extraUsers]);
  const shopService = createShopService({
    products, shopOrders: memStore(), users, auditLog: { insertAsync: async () => {} },
    partnerGate: {
      operationalUserIds: async ids => new Set(ids.filter(id => !unverifiedVendors.includes(id))),
      isOperational: async id => !unverifiedVendors.includes(id),
      exempt: () => true,
    },
    publicGate: {
      blocked: async type => new Set(type === 'product' ? blockedProducts : blockedVendors),
      isBlocked: async (type, id) => (type === 'product' ? blockedProducts : blockedVendors).includes(id),
    },
  });
  const calls = { orders: 0 };
  const service = createShopHomeService({
    shopService,
    discoveryService: { discover: async () => ({ featured: featured.map(f => ({ id: f.productId, promotion: { id: f.promotionId, type: 'featured', label: 'Featured · Sponsored', disclosure: { codes: ['featured', 'sponsored'], en: 'Featured · Sponsored', sw: 'Iliyoangaziwa · Iliyodhaminiwa' }, commercial: true } })) }) },
    promotionService: promotionService || { listLive: async () => live.map(id => ({ entityType: 'product', entityId: id })) },
    users,
    trainerService: { findProfileByUser: id => trainers.find(t => t.userId === id) || null },
    identityLink: { personasOf: async () => personas },
    recentPaidOrders: async () => { calls.orders += 1; if (ordersDelayMs) await new Promise(r => setTimeout(r, ordersDelayMs)); return orders; },
    signToken: signServedToken,
    config: () => shopHomeConfigFromEnv({ SHOP_HOME_MIN_ITEMS: '1', SHOP_HOME_CACHE_SECONDS: '0', ...env }),
    now: () => NOW,
  });
  let n = 0;
  const add = (extra = {}) => {
    n += 1;
    const row = {
      id: `prd_${String(n).padStart(3, '0')}`, vendorId: 'v1', name: `P${n}`, category: 'equipment', priceTzs: 10_000, discountPriceTzs: null,
      stock: 3, status: 'active', approvalStatus: 'approved', visibility: 'visible', homepageVisible: true, homepagePriority: 0,
      rating: 0, reviewCount: 0, soldCount: 0, createdAt: new Date(NOW - n * 60_000).toISOString(), ...extra,
    };
    products.rows.push(row);
    return row;
  };
  return { service, shopService, products, users, add, calls };
}
const idsOf = body => body.sections.flatMap(s => s.productIds);

test('service: listing rules come from the shop — unverified vendor, moderated, pending, hidden and out of stock are left out', async () => {
  const s = setup({ unverifiedVendors: ['v_new'], blockedProducts: ['prd_002'], blockedVendors: ['v_bad'] });
  const ok = s.add();
  s.add(); // prd_002: hidden in moderation
  s.add({ vendorId: 'v_new' });
  s.add({ vendorId: 'v_bad' });
  s.add({ approvalStatus: 'pending' });
  s.add({ visibility: 'hidden' });
  s.add({ stock: 0 });
  const out = await s.service.home({ claims: { sub: 'm1', userType: 'member' } });
  assert.deepEqual([...new Set(idsOf(out.body))], [ok.id]);
  assert.deepEqual(Object.keys(out.body.products), [ok.id]);
  // Out of stock is only off the home: the results list still shows it.
  assert.equal((await s.shopService.listProducts({})).length, 2);
});

test('service: response shape, product rows as GET /shop/products returns them, nothing personal', async () => {
  const s = setup();
  for (let i = 0; i < 6; i += 1) s.add({ discountPriceTzs: i < 3 ? 5_000 : null });
  const out = await s.service.home({ claims: { sub: 'm1', userType: 'member' } });
  assert.deepEqual(Object.keys(out.body).sort(), ['allProductsCount', 'categories', 'currency', 'mode', 'personalised', 'products', 'sections', 'serverNow', 'signalsUsed'].sort());
  assert.equal(out.body.serverNow, NOW.toISOString());
  assert.equal(out.body.currency, 'TZS');
  assert.equal(out.body.mode, 'member');
  assert.equal(out.body.personalised, false);
  assert.deepEqual(out.body.signalsUsed, ['role']);
  assert.equal(out.body.allProductsCount, 6);
  const listed = new Map((await s.shopService.listProducts({})).map(p => [p.id, p]));
  for (const [id, row] of Object.entries(out.body.products)) assert.deepEqual(row, listed.get(id));
  for (const sec of out.body.sections) {
    assert.ok(sec.title.en && sec.title.sw && sec.reason.en && sec.reason.sw, sec.key);
    assert.equal(typeof sec.hasMore, 'boolean');
    assert.ok(sec.viewAll.query && typeof sec.viewAll.query === 'object');
  }
  assert.deepEqual(out.body.categories, [{ key: 'equipment', en: 'Gym & fitness equipment', sw: 'Vifaa vya gym na mazoezi', count: 6 }]);
});

test('service: Featured keeps its disclosure and gets a token for the session; recommended has no paid placement', async () => {
  const s = setup({ featured: [{ productId: 'prd_001', promotionId: 'promo_1' }], live: ['prd_002'] });
  for (let i = 0; i < 6; i += 1) s.add();
  const session = 'sess_12345678';
  const out = await s.service.home({ claims: { sub: 'm1', userType: 'member' }, query: { session } });
  const featured = out.body.sections.find(x => x.key === 'featured');
  assert.deepEqual(featured.productIds, ['prd_001']);
  const tag = out.body.products.prd_001.promotion;
  assert.equal(tag.label, 'Featured · Sponsored', 'English string kept for older apps');
  assert.deepEqual(tag.disclosure, { codes: ['featured', 'sponsored'], en: 'Featured · Sponsored', sw: 'Iliyoangaziwa · Iliyodhaminiwa' });
  assert.ok(verifyServedToken(tag.token, { promotionId: 'promo_1', entityType: 'product', entityId: 'prd_001', sessionId: session, at: NOW, now: NOW }).ok);
  const rec = out.body.sections.find(x => x.key === 'recommended');
  assert.ok(!rec.productIds.includes('prd_002') && !rec.productIds.includes('prd_001'));
  // Products outside Featured carry no promotion tag.
  for (const id of rec.productIds) assert.equal(out.body.products[id].promotion, undefined);
  // Without a session no token is minted.
  const plain = await s.service.home({ claims: { sub: 'm1', userType: 'member' } });
  assert.equal(plain.body.products.prd_001.promotion.token, undefined);
});

test('service: a radius-only paid promotion is kept out of recommended and essentials for a viewer with no position', async () => {
  // The real promotion service: a promoted product targeted only by a radius.
  const world = makeWorld();
  const promo = await approved(world, {
    entityType: 'product', entityId: 'prod_1', type: 'promoted', placements: ['marketplace'],
    geoScope: { areaIds: [], radius: { lat: -6.792, lng: 39.208, km: 5 } },
  });
  assert.ok(!(await world.promotionService.schedule({ id: promo.id, actorId: 'admin_checker' })).error);
  world.clock.advance(2 * HOUR);
  assert.equal((await world.promotionService.runLifecycle()).activated, 1, 'now running');
  // Matching by location would miss it (the viewer has no position); that is why the home asks for any location.
  assert.deepEqual((await world.promotionService.listLive({ entityType: 'product', checkEntities: false })).map(p => p.id), []);
  assert.deepEqual((await world.promotionService.listLive({ entityType: 'product', anyLocation: true, checkEntities: false })).map(p => p.id), [promo.id]);

  const s = setup({ promotionService: world.promotionService, env: { SHOP_HOME_SECTIONS: 'recommended,essentials,best_sellers' } });
  s.add({ id: 'prod_1', category: 'equipment' });
  for (let i = 0; i < 5; i += 1) s.add({ category: 'equipment' });
  const out = await s.service.home({ claims: { sub: 'own1', userType: 'gym_operator' } });
  const rec = out.body.sections.find(x => x.key === 'recommended');
  assert.ok(rec.productIds.length > 0);
  for (const sec of out.body.sections.filter(x => ['recommended', 'essentials'].includes(x.key))) assert.ok(!sec.productIds.includes('prod_1'), sec.key);
});

test('service: role defaults per mode drive essentials; a person may shop in another role they hold', async () => {
  const s = setup({
    personas: [{ id: 'own1', userType: 'gym_operator' }, { id: 'm1', userType: 'member' }],
    users: [{ id: 'm1', userType: 'member', personId: 'person1', memberProfile: {} }],
    env: { SHOP_HOME_SECTIONS: 'essentials' },
  });
  s.add({ category: 'sportswear_footwear' });
  s.add({ category: 'other' });
  s.add({ category: 'equipment' });
  const asMember = await s.service.home({ claims: { sub: 'm1', userType: 'member' } });
  assert.deepEqual(asMember.body.sections[0].productIds, ['prd_003', 'prd_001']);
  assert.equal(asMember.body.sections[0].title.en, 'Training essentials');
  const asOwner = await s.service.home({ claims: { sub: 'm1', userType: 'member' }, query: { mode: 'owner' } });
  assert.equal(asOwner.body.mode, 'owner');
  assert.deepEqual(asOwner.body.sections[0].productIds, ['prd_003', 'prd_002']);
  assert.equal(asOwner.body.sections[0].title.en, 'Gym essentials');
  assert.equal(asOwner.body.categories[0].key, 'equipment');
  assert.deepEqual(await s.service.home({ claims: { sub: 'm1', userType: 'member' }, query: { mode: 'trainer' } }), { error: 'mode_not_allowed', status: 403 });
});

test('service: missing profile is cold start; declared goal and specialty are used', async () => {
  const s = setup({
    users: [{ id: 'm1', userType: 'member', memberProfile: { fitnessGoals: ['improve_flexibility'] } }, { id: 'm2', userType: 'member' }],
    trainers: [{ userId: 't1', specialties: ['Nutrition'] }],
    env: { SHOP_HOME_SECTIONS: 'essentials' },
  });
  s.add({ category: 'equipment' });
  s.add({ category: 'health_recovery' });
  s.add({ category: 'supplements_nutrition' });
  const goal = await s.service.home({ claims: { sub: 'm1', userType: 'member' } });
  assert.deepEqual(goal.body.signalsUsed, ['role', 'goal']);
  assert.equal(goal.body.sections[0].productIds[0], 'prd_002');
  assert.equal(goal.body.sections[0].reason.en, 'Matches the fitness goal in your profile.');
  const cold = await s.service.home({ claims: { sub: 'm2', userType: 'member' } });
  assert.deepEqual(cold.body.signalsUsed, ['role']);
  assert.equal(cold.body.sections[0].productIds[0], 'prd_001');
  const unknownUser = await s.service.home({ claims: { sub: 'ghost', userType: 'member' } });
  assert.deepEqual(unknownUser.body.signalsUsed, ['role']);
  const trainer = await s.service.home({ claims: { sub: 't1', userType: 'trainer' } });
  assert.deepEqual(trainer.body.signalsUsed, ['role', 'specialty']);
  assert.equal(trainer.body.sections[0].productIds[0], 'prd_003');
});

test('service: a vendor never sees their own products, as a vendor or in another role', async () => {
  const s = setup({ personas: [{ id: 'v_me', userType: 'vendor' }, { id: 'm_me', userType: 'member' }], users: [{ id: 'm_me', userType: 'member', personId: 'p1' }, { id: 'v_me', userType: 'vendor', personId: 'p1' }] });
  for (let i = 0; i < 4; i += 1) s.add({ vendorId: 'v_me' });
  for (let i = 0; i < 4; i += 1) s.add({ vendorId: 'v_other' });
  for (const claims of [{ sub: 'v_me', userType: 'vendor' }, { sub: 'm_me', userType: 'member' }]) {
    const out = await s.service.home({ claims });
    const ids = idsOf(out.body);
    assert.ok(ids.length > 0);
    assert.ok(ids.every(id => out.body.products[id].vendorId === 'v_other'), claims.userType);
  }
  // A vendor's staff never see their employer's products either.
  const staff = await s.service.home({ claims: { sub: 'staff1', userType: 'vendor_staff', vendorId: 'v_me' }, query: { mode: 'vendor_personal' } });
  assert.equal(staff.error, 'mode_not_allowed');
});

test('config: SHOP_HOME_CACHE_SECONDS is bounded to 1..300 seconds', () => {
  assert.deepEqual(CACHE_SECONDS, { default: 60, min: 1, max: 300 });
  const secs = v => shopHomeConfigFromEnv({ SHOP_HOME_CACHE_SECONDS: v }).cacheSeconds;
  assert.equal(secs(undefined), 60);
  assert.equal(secs('0'), 60, 'not a positive whole number: default');
  assert.equal(secs('-5'), 60);
  assert.equal(secs('abc'), 60);
  assert.equal(secs('1'), 1);
  assert.equal(secs('120'), 120);
  assert.equal(secs('100000'), 300);
});

test('service: concurrent requests share one rebuild of the shared data', async () => {
  const s = setup({ env: { SHOP_HOME_CACHE_SECONDS: '60' }, ordersDelayMs: 30 });
  for (let i = 0; i < 4; i += 1) s.add();
  const outs = await Promise.all(Array.from({ length: 8 }, (_, i) => s.service.home({ claims: { sub: `m${i}`, userType: 'member' } })));
  assert.equal(s.calls.orders, 1, 'one rebuild for eight requests');
  assert.ok(outs.every(o => o.body.sections.length > 0));
  // A failed rebuild is not kept: the next request tries again.
  let fail = true;
  const broken = createShopHomeService({
    shopService: { listProducts: async () => { if (fail) throw new Error('db down'); return []; } },
    discoveryService: { discover: async () => ({ featured: [] }) }, promotionService: { listLive: async () => [] },
    users: memStore(), recentPaidOrders: async () => [], config: () => shopHomeConfigFromEnv({}), now: () => NOW,
  });
  await assert.rejects(broken.home({ claims: { sub: 'm1', userType: 'member' } }), /db down/);
  fail = false;
  assert.equal((await broken.home({ claims: { sub: 'm1', userType: 'member' } })).body.sections.length, 0);
});

test('service: shared data is cached for SHOP_HOME_CACHE_SECONDS, personal parts are not', async () => {
  const s = setup({ env: { SHOP_HOME_CACHE_SECONDS: '60' }, users: [{ id: 'm1', userType: 'member', memberProfile: {} }] });
  for (let i = 0; i < 4; i += 1) s.add();
  await s.service.home({ claims: { sub: 'm1', userType: 'member' } });
  s.users.rows[0].memberProfile = { fitnessGoals: ['gain_muscle'] };
  const second = await s.service.home({ claims: { sub: 'm1', userType: 'member' } });
  assert.equal(s.calls.orders, 1, 'orders read once within the window');
  assert.deepEqual(second.body.signalsUsed, ['role', 'goal'], 'the profile is read every time');
});

// ── GET /shop/home and product create, against the CI database ──────────────

const made = { users: [], products: [], persons: [], moderation: [] };
function res() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
async function call(route, claims, { query = {}, body = {} } = {}) {
  const req = { headers: { authorization: `Bearer ${sign(claims)}` }, params: {}, query, body, get: () => null };
  const out = res();
  for (const guard of [route.onGuard].flat().filter(Boolean)) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return out;
}
async function user(userType, extra = {}) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `Shop home ${userType}`, updatedAt: new Date(), ...extra });
  made.users.push(id);
  return id;
}
async function product(vendorId, extra = {}) {
  const id = uid('prd');
  await db('Product').insert({ id, vendorId, name: 'Home test', category: 'equipment', priceTzs: 20_000, stock: 4, status: 'active', approvalStatus: 'approved', updatedAt: new Date(), ...extra });
  made.products.push(id);
  return id;
}

beforeEach(() => {
  process.env.SHOP_HOME_V2 = '1';
  process.env.SHOP_HOME_MIN_ITEMS = '1';
  process.env.SHOP_HOME_CACHE_SECONDS = '1';
  shopHomeService.clearCache();
  resetShopHomeLimits();
});
after(async () => {
  for (const k of ['SHOP_HOME_V2', 'SHOP_HOME_MIN_ITEMS', 'SHOP_HOME_CACHE_SECONDS', 'SHOP_HOME_SECTIONS']) delete process.env[k];
  await db('AuditLog').whereIn('target', made.products).del();
  await db('ModerationState').whereIn('id', made.moderation).del();
  await db('Product').whereIn('id', made.products).del();
  await db('User').whereIn('id', made.users).del();
  if (made.persons.length) await db('Person').whereIn('id', made.persons).del();
  await db.destroy();
});

test('route: flag off answers 404 feature_disabled; signed out is 401', async () => {
  delete process.env.SHOP_HOME_V2;
  const member = await user('member');
  const off = await call(shopHome, { sub: member, userType: 'member' });
  assert.equal(off.statusCode, 404);
  assert.deepEqual(off.body, { error: 'feature_disabled' });
  const anon = res();
  await shopHome.onGuard({ headers: {}, query: {} }, anon, () => assert.fail('guard let an anonymous call through'));
  assert.equal(anon.statusCode, 401);
});

test('route: more than the per-user limit in a minute answers 429 rate_limited', async () => {
  const member = await user('member');
  const other = await user('member');
  const t = Date.now();
  for (let i = 0; i < SHOP_HOME_LIMIT.perMinute; i += 1) assert.equal(allowShopHome(member, t), true);
  assert.equal(allowShopHome(member, t), false);
  assert.equal(allowShopHome(member, t + 60_001), true, 'a new minute starts again');
  for (let i = 0; i < SHOP_HOME_LIMIT.perMinute; i += 1) allowShopHome(member);
  const out = await call(shopHome, { sub: member, userType: 'member' });
  assert.equal(out.statusCode, 429);
  assert.deepEqual(out.body, { error: 'rate_limited' });
  assert.equal((await call(shopHome, { sub: other, userType: 'member' })).statusCode, 200, 'other users are not affected');
});

test('route: hidden, moderation-blocked, unverified (KYC gate on) and suspended vendors\' products never appear', async () => {
  const before = process.env.KYC_ENFORCEMENT;
  const old = new Date('2026-01-01T00:00:00Z'); // before KYC enforcement started: exempt
  const okVendor = await user('vendor', { createdAt: old });
  const newVendor = await user('vendor'); // created now, no approved KYC case
  const modSuspendedVendor = await user('vendor', { createdAt: old });
  const accountSuspendedVendor = await user('vendor', { createdAt: old, accountStatus: 'suspended' });
  const shown = await product(okVendor);
  const hidden = await product(okVendor, { visibility: 'hidden' });
  const modHidden = await product(okVendor);
  const unverified = await product(newVendor);
  const ofModSuspended = await product(modSuspendedVendor);
  const ofAccountSuspended = await product(accountSuspendedVendor);
  const states = [
    { id: uid('mod'), entityType: 'product', entityId: modHidden, status: 'hidden', updatedAt: new Date() },
    { id: uid('mod'), entityType: 'vendor', entityId: modSuspendedVendor, status: 'suspended', updatedAt: new Date() },
  ];
  await db('ModerationState').insert(states);
  made.moderation.push(...states.map(x => x.id));
  const member = await user('member');
  try {
    process.env.KYC_ENFORCEMENT = 'on';
    process.env.SHOP_HOME_SECTIONS = 'recently_viewed,new_arrivals,recommended,essentials';
    const all = [shown, hidden, modHidden, unverified, ofModSuspended, ofAccountSuspended];
    const out = await call(shopHome, { sub: member, userType: 'member' }, { query: { recent: all.join(',') } });
    assert.equal(out.statusCode, 200, JSON.stringify(out.body));
    const ids = new Set([...out.body.sections.flatMap(x => x.productIds), ...Object.keys(out.body.products)]);
    assert.ok(ids.has(shown), 'the listable product is shown');
    for (const [name, id] of Object.entries({ hidden, modHidden, unverified, ofModSuspended, ofAccountSuspended })) assert.ok(!ids.has(id), name);
  } finally {
    if (before === undefined) delete process.env.KYC_ENFORCEMENT; else process.env.KYC_ENFORCEMENT = before;
    delete process.env.SHOP_HOME_SECTIONS;
  }
});

test('route: a faked mode is refused with 403 mode_not_allowed', async () => {
  const member = await user('member');
  for (const mode of ['owner', 'trainer', 'vendor_personal', 'admin']) {
    const out = await call(shopHome, { sub: member, userType: 'member' }, { query: { mode } });
    assert.equal(out.statusCode, 403, mode);
    assert.deepEqual(out.body, { error: 'mode_not_allowed' });
  }
});

test('route: a persona the person really holds is accepted; own vendor products and out of stock never appear', async () => {
  const personId = uid('per');
  await db('Person').insert({ id: personId, updatedAt: new Date() });
  made.persons.push(personId);
  const member = await user('member', { personId });
  const vendor = await user('vendor', { personId });
  const owner = await user('gym_operator', { personId });
  const otherVendor = await user('vendor');
  const mine = await product(vendor, { createdAt: new Date() });
  const theirs = await product(otherVendor, { createdAt: new Date() });
  const empty = await product(otherVendor, { stock: 0, createdAt: new Date() });
  for (const [claims, mode] of [[{ sub: member, userType: 'member' }, undefined], [{ sub: member, userType: 'member' }, 'owner'], [{ sub: vendor, userType: 'vendor' }, undefined], [{ sub: member, userType: 'member' }, 'vendor_personal']]) {
    const out = await call(shopHome, claims, { query: { ...(mode ? { mode } : {}), recent: `${mine},${theirs},${empty}` } });
    assert.equal(out.statusCode, 200, JSON.stringify(out.body));
    const ids = out.body.sections.flatMap(s => s.productIds);
    assert.ok(ids.includes(theirs), 'another vendor\'s product is shown');
    assert.ok(!ids.includes(mine), 'own product is never shown');
    assert.ok(!ids.includes(empty), 'out of stock is never shown');
    assert.equal(new Set(ids).size, ids.length, 'no product twice');
    assert.equal(out.body.personalised, false);
  }
  const asOwner = await call(shopHome, { sub: member, userType: 'member' }, { query: { mode: 'owner' } });
  assert.equal(asOwner.body.mode, 'owner', `held owner persona ${owner}`);
});

test('route: recently viewed follows the recent param and never outlives the request', async () => {
  const vendor = await user('vendor');
  const a = await product(vendor);
  const b = await product(vendor);
  const member = await user('member');
  process.env.SHOP_HOME_SECTIONS = 'recently_viewed';
  const out = await call(shopHome, { sub: member, userType: 'member' }, { query: { recent: `${b},nope,${a}` } });
  assert.deepEqual(out.body.sections.map(s => [s.key, s.productIds]), [['recently_viewed', [b, a]]]);
  assert.ok(out.body.signalsUsed.includes('recently_viewed'));
  const again = await call(shopHome, { sub: member, userType: 'member' });
  assert.deepEqual(again.body.sections, []);
  delete process.env.SHOP_HOME_SECTIONS;
});

test('route: sections smaller than SHOP_HOME_MIN_ITEMS are left out', async () => {
  const vendor = await user('vendor');
  const a = await product(vendor, { discountPriceTzs: 10_000 });
  const member = await user('member');
  process.env.SHOP_HOME_SECTIONS = 'deals';
  process.env.SHOP_HOME_MIN_ITEMS = '500';
  const out = await call(shopHome, { sub: member, userType: 'member' });
  assert.deepEqual(out.body.sections, []);
  process.env.SHOP_HOME_MIN_ITEMS = '1';
  const shown = await call(shopHome, { sub: member, userType: 'member' });
  assert.ok(shown.body.sections[0].productIds.includes(a));
  delete process.env.SHOP_HOME_SECTIONS;
});

test('security: product create ignores client rating, reviewCount and soldCount', async () => {
  const vendor = await user('vendor');
  const out = await call(vendorCreateProduct, { sub: vendor, userType: 'vendor' }, {
    body: { name: 'Seeded rating', category: 'equipment', priceTzs: 50_000, stock: 3, rating: 5, reviewCount: 999, soldCount: 12_000 },
  });
  assert.equal(out.statusCode, 201, JSON.stringify(out.body));
  made.products.push(out.body.id);
  const row = await db('Product').where({ id: out.body.id }).first();
  assert.equal(Number(row.rating), 0);
  assert.equal(row.reviewCount, 0);
  assert.equal(row.soldCount, 0);
  assert.equal(out.body.rating, 0);
});

test('security: duplicate and admin create do not carry or accept ratings either', async () => {
  const s = setup();
  const created = await s.shopService.upsertProduct({ vendorId: 'v1', body: { name: 'X', priceTzs: 1_000, rating: 4.9, reviewCount: 7, soldCount: 70 } });
  assert.deepEqual([created.product.rating, created.product.reviewCount, created.product.soldCount], [0, 0, 0]);
  await s.products.updateByIdAsync(created.product.id, { rating: 4.5, reviewCount: 2, soldCount: 3 }); // as the server would after real reviews and sales
  const copy = await s.shopService.duplicateProduct({ vendorId: 'v1', productId: created.product.id });
  assert.deepEqual([copy.product.rating, copy.product.reviewCount, copy.product.soldCount], [0, 0, 0]);
  // Update never touched them and still does not.
  const updated = await s.shopService.upsertProduct({ vendorId: 'v1', productId: created.product.id, body: { rating: 1, reviewCount: 0, soldCount: 0, stock: 9 } });
  assert.deepEqual([updated.product.rating, updated.product.reviewCount, updated.product.soldCount], [4.5, 2, 3]);
});
