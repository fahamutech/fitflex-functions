// Shop "Popular near you" (Phase 2 · slice 3): the pure area rules, the section, and the shop home
// service with in-memory stores. The database-backed routes are in shop-near-you-routes.specs.mjs.
// Contract: docs/shop-near-you-api.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  indexAreas, resolveViewerArea, vendorAreasOf, deliversTo, basedIn, validateVendorAreas, publicAreas, MAX_DELIVERY_AREAS,
} from '../src/shared/shop-areas.mjs';
import { ALLOCATION_ORDER, SECTION_KEYS, NEAR_REASON_CODES } from '../src/services/shop-recommendations.mjs';
import { createShopService } from '../src/services/shop-service.mjs';
import { createShopHomeService, shopHomeConfigFromEnv } from '../src/services/shop-home-service.mjs';
import { createShopPreferenceService } from '../src/services/shop-preference-service.mjs';
import { createMemoryShopPreferenceStore } from '../src/infra/shop-preference-store-pg.mjs';
import { withoutAreaId, redactAreaId } from '../functions/shop-home.mjs';

const require = createRequire(import.meta.url);
const { matchVendorAreas } = require('../db/migrations/20270111120000-vendor-shop-areas.cjs');

const NOW = new Date('2026-10-22T08:00:00Z');
const DAY = 86_400_000;

// country > region > city > district, with an inactive city and a region switched off with its children.
const AREAS = [
  { id: 'tz', level: 'country', name: 'Tanzania', parentId: null, lat: -6.3, lng: 34.8, radiusKm: null, active: true },
  { id: 'tz-dar', level: 'region', name: 'Dar es Salaam', parentId: 'tz', lat: -6.79, lng: 39.2, radiusKm: 40, active: true },
  { id: 'tz-dar-city', level: 'city', name: 'Dar es Salaam', parentId: 'tz-dar', lat: -6.79, lng: 39.2, radiusKm: 25, active: true },
  { id: 'tz-dar-kino', level: 'district', name: 'Kinondoni', parentId: 'tz-dar-city', lat: -6.77, lng: 39.24, radiusKm: 6, active: true },
  { id: 'tz-dar-ila', level: 'district', name: 'Ilala', parentId: 'tz-dar-city', lat: -6.82, lng: 39.27, radiusKm: 6, active: true },
  { id: 'tz-aru', level: 'region', name: 'Arusha', parentId: 'tz', lat: -3.38, lng: 36.68, radiusKm: 60, active: true },
  { id: 'tz-aru-city', level: 'city', name: 'Arusha', parentId: 'tz-aru', lat: -3.38, lng: 36.68, radiusKm: 15, active: true },
  { id: 'tz-aru-old', level: 'city', name: 'Old Town', parentId: 'tz-aru', lat: null, lng: null, radiusKm: null, active: false },
  { id: 'tz-off', level: 'region', name: 'Closed Region', parentId: 'tz', lat: 0, lng: 0, radiusKm: 5, active: false },
  { id: 'tz-off-city', level: 'city', name: 'Closed City', parentId: 'tz-off', lat: 0, lng: 0, radiusKm: 5, active: true },
];
const IDX = indexAreas(AREAS);

// ── pure area rules ─────────────────────────────────────────────────────────

test('areas: usable = active all the way up; GET /shop/areas rows by level then name, names in both languages', () => {
  assert.deepEqual([...IDX.usable].sort(), ['tz', 'tz-aru', 'tz-aru-city', 'tz-dar', 'tz-dar-city', 'tz-dar-ila', 'tz-dar-kino']);
  const rows = publicAreas(AREAS);
  assert.deepEqual(rows.map(r => r.id), ['tz', 'tz-aru', 'tz-dar', 'tz-aru-city', 'tz-dar-city', 'tz-dar-ila', 'tz-dar-kino']);
  assert.deepEqual(rows.find(r => r.id === 'tz-dar-kino'), { id: 'tz-dar-kino', level: 'district', name: 'Kinondoni', names: { en: 'Kinondoni', sw: 'Kinondoni' }, parentId: 'tz-dar-city', lat: -6.77, lng: 39.24, radiusKm: 6 });
  assert.equal(rows.find(r => r.id === 'tz').radiusKm, null);
  assert.ok(!rows.some(r => 'active' in r || 'createdAt' in r));
});

test('viewer area: district rolls up to its city; region has no city; unknown, inactive, malformed, country → ignored', () => {
  assert.deepEqual(resolveViewerArea(IDX, 'tz-dar-kino'), { areaId: 'tz-dar-kino', name: 'Kinondoni', level: 'district', cityId: 'tz-dar-city', regionId: 'tz-dar', chain: ['tz-dar-kino', 'tz-dar-city', 'tz-dar', 'tz'] });
  assert.deepEqual(resolveViewerArea(IDX, 'tz-dar-city'), { areaId: 'tz-dar-city', name: 'Dar es Salaam', level: 'city', cityId: 'tz-dar-city', regionId: 'tz-dar', chain: ['tz-dar-city', 'tz-dar', 'tz'] });
  assert.equal(resolveViewerArea(IDX, 'tz-dar').cityId, null);
  assert.equal(resolveViewerArea(IDX, 'tz-dar').regionId, 'tz-dar');
  for (const bad of ['tz', 'nope', 'tz-aru-old', 'tz-off-city', 'tz-off', '', ' tz-dar', 'tz-dar;drop', 'x'.repeat(200), undefined, null, 42, ['tz-dar'], { id: 'tz-dar' }]) {
    assert.equal(resolveViewerArea(IDX, bad), null, String(bad));
  }
});

const V = {
  a: { cityId: 'tz-dar-city', deliveryAreaIds: [] },                        // based in Dar, no delivery
  b: { cityId: 'tz-aru-city', deliveryAreaIds: ['tz-dar'] },                // region covers its cities and districts
  c: { cityId: 'tz-aru-city', deliveryAreaIds: ['tz'] },                    // nationwide
  d: { cityId: 'tz-aru-city', deliveryAreaIds: ['tz-dar-kino'] },           // one district only
  e: { cityId: 'tz-aru-city', deliveryAreaIds: ['tz-aru'] },                // Arusha only
  k: { cityId: 'tz-dar-kino' },                                             // based in a district of Dar
  z: { cityId: 'tz-aru-old', deliveryAreaIds: ['tz-aru-old', 'tz-off'] },   // only unusable areas
};
const va = key => vendorAreasOf(V[key], IDX);

test('coverage: region covers its cities and districts, the country covers all, a district only itself', () => {
  const at = id => resolveViewerArea(IDX, id);
  const who = (viewer, fn) => Object.keys(V).filter(k => fn(va(k), viewer));
  assert.deepEqual(who(at('tz-dar-kino'), deliversTo), ['b', 'c', 'd']);
  assert.deepEqual(who(at('tz-dar-ila'), deliversTo), ['b', 'c']);
  assert.deepEqual(who(at('tz-dar-city'), deliversTo), ['b', 'c'], 'a city viewer is not covered by one district');
  assert.deepEqual(who(at('tz-dar'), deliversTo), ['b', 'c']);
  assert.deepEqual(who(at('tz-aru-city'), deliversTo), ['c', 'e']);
  // Based in: city (district → city); a region viewer matches vendors of that region.
  assert.deepEqual(who(at('tz-dar-kino'), basedIn), ['a', 'k']);
  assert.deepEqual(who(at('tz-dar-ila'), basedIn), ['a', 'k'], 'a district viewer rolls up to the city');
  assert.deepEqual(who(at('tz-dar'), basedIn), ['a', 'k'], 'region derived from the city');
  assert.deepEqual(who(at('tz-aru-city'), basedIn), ['b', 'c', 'd', 'e']);
  assert.deepEqual(va('z'), { cityId: null, regionId: null, delivery: new Set() }, 'unusable areas are dropped');
  assert.equal(deliversTo(undefined, at('tz-dar')), false);
  assert.equal(basedIn(va('a'), null), false);
});

test('vendor areas: validated against usable areas; city → its region; errors name the field and ids', () => {
  const ok = body => validateVendorAreas(body, {}, IDX);
  assert.deepEqual(ok({ cityId: 'tz-dar-city' }), { patch: { cityId: 'tz-dar-city', regionId: 'tz-dar' } });
  assert.deepEqual(ok({ cityId: 'tz-dar-kino' }), { patch: { cityId: 'tz-dar-kino', regionId: 'tz-dar' } }, 'a district is accepted as "based in"');
  assert.deepEqual(ok({ cityId: 'tz-dar-city', regionId: 'tz-dar' }), { patch: { cityId: 'tz-dar-city', regionId: 'tz-dar' } });
  assert.deepEqual(ok({ regionId: 'tz-aru' }), { patch: { regionId: 'tz-aru' } });
  assert.deepEqual(ok({ cityId: null, regionId: null, deliveryAreaIds: [] }), { patch: { cityId: null, regionId: null, deliveryAreaIds: [] } });
  assert.deepEqual(ok({ deliveryAreaIds: ['tz', 'tz-dar', 'tz-dar-kino', 'tz-dar'] }), { patch: { deliveryAreaIds: ['tz', 'tz-dar', 'tz-dar-kino'] } }, 'country = nationwide; repeats removed');
  assert.deepEqual(ok({ businessName: 'x' }), { patch: {} });
  const err = (body, field, ids, reason, prior = {}) => assert.deepEqual(validateVendorAreas(body, prior, IDX), { error: 'invalid_area', status: 400, field, ids, reason }, JSON.stringify(body));
  err({ cityId: 'tz-dar' }, 'cityId', ['tz-dar'], 'wrong_level');
  err({ cityId: 'tz' }, 'cityId', ['tz'], 'wrong_level');
  err({ regionId: 'tz-dar-city' }, 'regionId', ['tz-dar-city'], 'wrong_level');
  err({ regionId: 'tz' }, 'regionId', ['tz'], 'wrong_level');
  err({ cityId: 'nope' }, 'cityId', ['nope'], 'unknown');
  err({ cityId: 7 }, 'cityId', ['7'], 'unknown');
  err({ cityId: 'tz-aru-old' }, 'cityId', ['tz-aru-old'], 'inactive');
  err({ cityId: 'tz-off-city' }, 'cityId', ['tz-off-city'], 'inactive', {}); // parent switched off
  err({ cityId: 'tz-dar-city', regionId: 'tz-aru' }, 'regionId', ['tz-aru'], 'not_in_region');
  err({ regionId: 'tz-aru' }, 'regionId', ['tz-aru'], 'not_in_region', { cityId: 'tz-dar-city', regionId: 'tz-dar' });
  err({ deliveryAreaIds: 'tz-dar' }, 'deliveryAreaIds', [], 'not_a_list');
  err({ deliveryAreaIds: ['tz-dar', 'nope', 5] }, 'deliveryAreaIds', ['nope', '5'], 'unknown');
  err({ deliveryAreaIds: ['tz-dar', 'tz-off'] }, 'deliveryAreaIds', ['tz-off'], 'inactive');
  err({ deliveryAreaIds: Array.from({ length: MAX_DELIVERY_AREAS + 1 }, (_, i) => `a${i}`) }, 'deliveryAreaIds', [], 'too_many');
});

test('backfill matcher: free text → ids, case-insensitive, whole words, never overwrites, no guess when ambiguous', () => {
  const m = p => matchVendorAreas(p, AREAS);
  assert.deepEqual(m({ address: 'Masaki, DAR ES SALAAM', deliveryRegions: ['dar es salaam', 'Arusha', 'Mbeya'] }), { cityId: 'tz-dar-city', regionId: 'tz-dar', deliveryAreaIds: ['tz-dar', 'tz-aru'] });
  assert.deepEqual(m({ address: 'Plot 4, Kinondoni' }), { cityId: 'tz-dar-city', regionId: 'tz-dar' }, 'a district names its city');
  assert.deepEqual(m({ address: 'Dar es Salaam and Arusha' }), {}, 'two different cities: no guess');
  assert.deepEqual(m({ address: 'Arushawide street' }), {}, 'whole words only');
  assert.deepEqual(m({ address: 'Old Town' }), {}, 'inactive areas are never matched');
  assert.deepEqual(m({ deliveryRegions: 'Nationwide' }), { deliveryAreaIds: ['tz'] });
  assert.deepEqual(m({ deliveryRegions: 'Tanzania; Ilala' }), { deliveryAreaIds: ['tz', 'tz-dar-ila'] });
  assert.deepEqual(m({ deliveryRegions: ['Unknown place'] }), {});
  // Existing ids are never overwritten; [] is a choice ("no delivery") and is kept.
  assert.deepEqual(m({ cityId: 'tz-aru-city', regionId: 'tz-aru', address: 'Dar es Salaam', deliveryAreaIds: [], deliveryRegions: ['Arusha'] }), {});
  assert.deepEqual(m({ cityId: 'tz-aru-city', address: 'Dar es Salaam' }), {}, 'region from text must agree with the stored city');
  assert.deepEqual(m({ address: { street: 'Sokoine Rd', city: 'Arusha' } }), { cityId: 'tz-aru-city', regionId: 'tz-aru' });
  assert.deepEqual(m(null), {});
});

test('log redaction: areaId is taken out of the logged URL, every other parameter stays', () => {
  assert.equal(withoutAreaId('/shop/home?areaId=tz-dar-kino'), '/shop/home');
  assert.equal(withoutAreaId('/shop/home?mode=member&areaId=tz-dar-kino&recent=a,b'), '/shop/home?mode=member&recent=a,b');
  assert.equal(withoutAreaId('/shop/home?AREAID=x&areaId=y&mode=member'), '/shop/home?mode=member');
  assert.equal(withoutAreaId('/shop/home?areaId&mode=member'), '/shop/home?mode=member');
  assert.equal(withoutAreaId('/shop/home?mode=member'), '/shop/home?mode=member');
  assert.equal(withoutAreaId('/shop/home?myareaId=1'), '/shop/home?myareaId=1');
  assert.equal(withoutAreaId(undefined), undefined);
  const req = { originalUrl: '/shop/home?areaId=tz-dar&mode=member', url: '/?areaId=tz-dar&mode=member' };
  redactAreaId(req);
  assert.deepEqual(req, { originalUrl: '/shop/home?mode=member', url: '/?areaId=tz-dar&mode=member' }, 'routing (req.url) is untouched');
});

test('allocation and display order: near-you takes products after Recently viewed and before Recommended, shows after Recommended', () => {
  assert.deepEqual(ALLOCATION_ORDER.slice(0, 5), ['featured', 'best_sellers', 'recently_viewed', 'popular_near_you', 'recommended']);
  assert.equal(SECTION_KEYS.indexOf('popular_near_you'), SECTION_KEYS.indexOf('recommended') + 1);
  assert.equal(SECTION_KEYS.indexOf('essentials'), SECTION_KEYS.indexOf('popular_near_you') + 1);
  assert.deepEqual(NEAR_REASON_CODES, ['popular_in_area', 'delivers_to_area', 'seller_in_area']);
});

// ── the shop home service (in-memory) ──────────────────────────────────────

function memStore(rows = []) {
  return {
    rows,
    async allAsync() { return rows; },
    async filterAsync(fn) { return rows.filter(fn); },
    async findAsync(fn) { return rows.find(fn) || null; },
    async findByIdAsync(id) { return rows.find(r => r.id === id) || null; },
    async filterByColumnInAsync(col, values) { return rows.filter(r => values.includes(r[col])); },
    async insertAsync(row) { rows.push(row); return row; },
    async upsertAsync(fn, row) { const i = rows.findIndex(fn); if (i >= 0) rows[i] = row; else rows.push(row); return row; },
    async updateByIdAsync(id, patch) { const i = rows.findIndex(r => r.id === id); if (i >= 0) rows[i] = { ...rows[i], ...patch }; return rows[i] || null; },
  };
}

const vendorUser = (key, extra = {}) => ({ id: `v_${key}`, userType: 'vendor', accountStatus: 'active', vendorProfile: { businessName: `Vendor ${key}`, ...V[key] }, ...extra });
const ADULT = { id: 'm1', userType: 'member', personId: 'per1', memberProfile: { gender: 'female', dateOfBirth: '1990-05-01' } };
const claimsOf = u => ({ sub: u.id, userType: u.userType });

/**
 * Every write the service could do is recorded: it must never write anything (and never the area).
 * `flags`: { personalisation, near } switched live.
 */
function setup({ users = [], orders = [], flags = { personalisation: true, near: true }, env = {}, vendors = ['a', 'b', 'c', 'd', 'e', 'k', 'z'], perVendor = 1 } = {}) {
  const writes = [];
  const track = (name, store) => new Proxy(store, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v === 'function' && /insert|update|upsert|save|delete|remove/i.test(String(prop))) return (...args) => { writes.push([name, prop, JSON.stringify(args)]); return v.apply(target, args); };
      return v;
    },
  });
  const products = memStore();
  const userStore = memStore([...vendors.map(k => vendorUser(k)), ...users.map(u => ({ ...u }))]);
  const areaReads = { n: 0 };
  const geoAreas = { allAsync: async () => { areaReads.n += 1; return AREAS; } };
  const shopService = createShopService({
    products: track('products', products), shopOrders: memStore(), users: track('users', userStore), auditLog: track('audit', { insertAsync: async () => {} }),
    partnerGate: { operationalUserIds: async ids => new Set(ids), isOperational: async () => true, exempt: () => true },
    publicGate: { blocked: async () => new Set(), isBlocked: async () => false },
  });
  const identityLink = { personasOf: async personId => userStore.rows.filter(u => u.personId === personId) };
  const store = createMemoryShopPreferenceStore();
  const preferences = createShopPreferenceService({ store: track('prefs', store), users: userStore, identityLink, flagOn: () => flags.personalisation, nearYouOn: () => flags.near, now: () => NOW });
  const logs = [];
  const logger = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(k => [k, (...a) => logs.push(a.map(String).join(' '))]));
  const deps = {
    shopService,
    discoveryService: { discover: async () => ({ featured: [] }) },
    promotionService: { listLive: async () => [] },
    users: userStore, trainerService: { findProfileByUser: () => null }, identityLink,
    recentPaidOrders: async () => orders,
    config: () => shopHomeConfigFromEnv({ SHOP_HOME_CACHE_SECONDS: '300', ...env }),
    now: () => NOW,
    preferences, personalisationOn: () => flags.personalisation,
    buyerPaidOrders: async () => [],
    logger,
  };
  const service = createShopHomeService({
    ...deps, geoAreas, nearYouOn: () => flags.near,
    gymAreas: async () => [{ id: 'g_dar', cityId: 'tz-dar-city', regionId: 'tz-dar' }, { id: 'g_aru', cityId: 'tz-aru-city', regionId: 'tz-aru' }],
  });
  // As before slice 3: no area dependencies at all.
  const before = createShopHomeService(deps);
  let n = 0;
  const add = (vendorKey, extra = {}) => {
    n += 1;
    const row = {
      id: `prd_${String(n).padStart(3, '0')}`, vendorId: `v_${vendorKey}`, name: `P${n}`, category: 'equipment', priceTzs: 10_000, discountPriceTzs: null,
      stock: 3, status: 'active', approvalStatus: 'approved', visibility: 'visible', homepageVisible: true, homepagePriority: 0,
      rating: 0, reviewCount: 0, soldCount: 0, createdAt: new Date(NOW - n * 60_000).toISOString(), targetGender: null, targetAgeBands: [],
      // Vendor-typed distance: must never matter for near-you.
      distanceKm: vendorKey === 'e' ? 0.1 : 500, ...extra,
    };
    products.rows.push(row);
    return row;
  };
  for (const k of vendors) for (let i = 0; i < perVendor; i += 1) add(k);
  return { service, before, store, add, writes, logs, flags, areaReads, users: userStore, products };
}
const sec = (body, key) => body.sections.find(s => s.key === key);
const vendorOfRow = (body, id) => body.products[id].vendorId;

test('flag off: /shop/home is byte-identical to before slice 3, even with an areaId; areas are never read', async () => {
  for (const personalisation of [false, true]) {
    const s = setup({ users: [ADULT], flags: { personalisation, near: false }, env: { SHOP_HOME_MIN_ITEMS: '1' } });
    for (const query of [{}, { areaId: 'tz-dar-kino' }, { mode: 'member', recent: 'prd_002', areaId: 'tz-dar' }]) {
      const a = await s.service.home({ claims: claimsOf(ADULT), query });
      const b = await s.before.home({ claims: claimsOf(ADULT), query: { ...query, areaId: undefined } });
      assert.equal(JSON.stringify(a.body), JSON.stringify(b.body), `personalisation ${personalisation} ${JSON.stringify(query)}`);
      assert.ok(!('nearYou' in a.body));
      assert.ok(!a.body.sections.some(x => x.key === 'popular_near_you'));
      assert.ok(!Object.values(a.body.products).some(p => 'deliversToViewerArea' in p));
    }
    assert.equal(s.areaReads.n, 0, 'GeoArea not read with the flag off');
  }
});

test('on: a district viewer gets vendors based in the city or delivering there; badge only for delivery; never distanceKm', async () => {
  const s = setup({ users: [ADULT], perVendor: 2 });
  const { body } = await s.service.home({ claims: claimsOf(ADULT), query: { areaId: 'tz-dar-kino' } });
  assert.deepEqual(body.nearYou, { available: true, areaId: 'tz-dar-kino', areaName: { en: 'Kinondoni', sw: 'Kinondoni' } });
  const near = sec(body, 'popular_near_you');
  assert.ok(near, JSON.stringify(body.sections.map(x => x.key)));
  assert.deepEqual([...new Set(near.productIds.map(id => vendorOfRow(body, id)))].sort(), ['v_a', 'v_b', 'v_c', 'v_d', 'v_k']);
  assert.deepEqual(near.title, { en: 'Popular near you', sw: 'Maarufu karibu nawe' });
  assert.deepEqual(near.reasonCodes, ['delivers_to_area', 'seller_in_area']);
  assert.deepEqual(near.reason, { en: 'It delivers to your current area.', sw: 'Ina delivery kwenye eneo ulipo sasa.' });
  assert.deepEqual(near.reasonParams, { areaName: 'Kinondoni' });
  assert.equal(near.hasMore, false);
  for (const [id, row] of Object.entries(body.products)) {
    const delivers = ['v_b', 'v_c', 'v_d'].includes(row.vendorId);
    assert.equal(row.deliversToViewerArea, delivers ? true : undefined, `${id} ${row.vendorId}`);
  }
  assert.ok(body.signalsUsed.includes('location'));
  assert.equal(body.personalised, true);
  // Display order: after Recommended (if shown), before Essentials (if shown).
  const keys = body.sections.map(x => x.key);
  if (keys.includes('essentials')) assert.ok(keys.indexOf('popular_near_you') < keys.indexOf('essentials'));
  if (keys.includes('recommended')) assert.ok(keys.indexOf('recommended') < keys.indexOf('popular_near_you'));
});

test('on: Ilala (no district delivery), the city and the region resolve differently', async () => {
  const s = setup({ users: [ADULT], perVendor: 2 });
  const vendorsAt = async (areaId) => {
    const { body } = await s.service.home({ claims: claimsOf(ADULT), query: { areaId } });
    const near = sec(body, 'popular_near_you');
    return near ? [...new Set(near.productIds.map(id => vendorOfRow(body, id)))].sort() : [];
  };
  assert.deepEqual(await vendorsAt('tz-dar-ila'), ['v_a', 'v_b', 'v_c', 'v_k']);
  assert.deepEqual(await vendorsAt('tz-dar-city'), ['v_a', 'v_b', 'v_c', 'v_k']);
  assert.deepEqual(await vendorsAt('tz-dar'), ['v_a', 'v_b', 'v_c', 'v_k']);
  assert.deepEqual(await vendorsAt('tz-aru-city'), ['v_b', 'v_c', 'v_d', 'v_e']);
});

test('on: unknown, inactive, country or malformed areaId is ignored silently (no section, no badge, no areaId echoed)', async () => {
  const s = setup({ users: [ADULT], perVendor: 2 });
  for (const areaId of ['nope', 'tz', 'tz-aru-old', 'tz-off-city', 'a b', '', undefined]) {
    const out = await s.service.home({ claims: claimsOf(ADULT), query: { areaId } });
    assert.equal(out.error, undefined);
    assert.deepEqual(out.body.nearYou, { available: true }, String(areaId));
    assert.ok(!sec(out.body, 'popular_near_you'));
    assert.ok(!Object.values(out.body.products).some(p => 'deliversToViewerArea' in p));
    assert.ok(!out.body.signalsUsed.includes('location'));
  }
});

test('gating: switch off, under 18, invalid date of birth, no member persona, personalisation flag off → no section and no badge', async () => {
  const cases = [
    ['switch off', ADULT, async s => s.store.save({ personId: 'per1', subjectType: 'person', personalised: false, source: 'why_sheet', actorId: 'm1', at: NOW.toISOString() })],
    ['under 18', { ...ADULT, memberProfile: { gender: 'female', dateOfBirth: '2012-01-01' } }],
    ['invalid dob', { ...ADULT, memberProfile: { dateOfBirth: '01/05/1990' } }],
    ['future dob', { ...ADULT, memberProfile: { dateOfBirth: '2030-01-01' } }],
    ['trainer only', { id: 't1', userType: 'trainer', personId: 'per2' }],
    ['owner only', { id: 'o1', userType: 'gym_operator', personId: 'per3' }],
    ['personalisation flag off', ADULT, null, { personalisation: false, near: true }],
  ];
  for (const [name, u, prep, flags] of cases) {
    const s = setup({ users: [u], perVendor: 2, flags: flags || { personalisation: true, near: true } });
    if (prep) await prep(s);
    const { body } = await s.service.home({ claims: claimsOf(u), query: { areaId: 'tz-dar-kino' } });
    assert.deepEqual(body.nearYou, { available: false }, name);
    assert.ok(!sec(body, 'popular_near_you'), name);
    assert.ok(!Object.values(body.products).some(p => 'deliversToViewerArea' in p), name);
    assert.ok(!body.signalsUsed.includes('location'), name);
  }
  // No date of birth: personalisation is available (purchase history only), so near-you works.
  const s = setup({ users: [{ ...ADULT, memberProfile: {} }], perVendor: 2 });
  const { body } = await s.service.home({ claims: claimsOf(ADULT), query: { areaId: 'tz-dar-kino' } });
  assert.equal(body.nearYou.available, true);
  assert.ok(sec(body, 'popular_near_you'));
});

test('min 4: three qualifying products → no section (the area is still echoed and the badge still shows elsewhere)', async () => {
  const s = setup({ users: [ADULT], vendors: ['a', 'b', 'e'], perVendor: 1, env: { SHOP_HOME_MIN_ITEMS: '1' } });
  s.add('b');
  // a (based in), b ×2 (delivers): 3 products in Dar, below the default minimum of 4 (min 1 elsewhere).
  const four = setup({ users: [ADULT], vendors: ['a', 'b', 'e'], perVendor: 1 });
  four.add('b');
  let { body } = await four.service.home({ claims: claimsOf(ADULT), query: { areaId: 'tz-dar-city' } });
  assert.ok(!sec(body, 'popular_near_you'), 'below 4');
  assert.equal(body.nearYou.areaId, 'tz-dar-city');
  four.add('a');
  four.service.clearCache();
  ({ body } = await four.service.home({ claims: claimsOf(ADULT), query: { areaId: 'tz-dar-city' } }));
  assert.equal(sec(body, 'popular_near_you').productIds.length, 4);
  // With other rails allowed at 1, delivering products outside near-you still carry the badge.
  ({ body } = await s.service.home({ claims: claimsOf(ADULT), query: { areaId: 'tz-dar-city' } }));
  const ids = body.sections.flatMap(x => x.productIds);
  for (const id of ids) assert.equal(body.products[id].deliversToViewerArea, body.products[id].vendorId === 'v_b' ? true : undefined);
});

test('dedupe and allocation: a product is in one section; recently viewed keeps its own; near-you is taken before Recommended', async () => {
  const s = setup({ users: [ADULT], perVendor: 3, env: { SHOP_HOME_MIN_ITEMS: '4' } });
  const { body: plain } = await s.service.home({ claims: claimsOf(ADULT), query: {} });
  const recentIds = ['prd_001', 'prd_002', 'prd_004', 'prd_005'];
  const { body } = await s.service.home({ claims: claimsOf(ADULT), query: { areaId: 'tz-dar-kino', recent: recentIds.join(',') } });
  const all = body.sections.flatMap(x => x.productIds);
  assert.equal(all.length, new Set(all).size, 'no duplicates');
  assert.deepEqual(sec(body, 'recently_viewed').productIds, recentIds);
  const near = sec(body, 'popular_near_you').productIds;
  for (const id of recentIds) assert.ok(!near.includes(id));
  // Without an area these local products would have filled Recommended; now they are near-you's.
  const recommendedBefore = sec(plain, 'recommended')?.productIds || [];
  const local = recommendedBefore.filter(id => ['v_a', 'v_b', 'v_c', 'v_d', 'v_k'].includes(plain.products[id].vendorId) && !recentIds.includes(id));
  assert.ok(local.length > 0);
  for (const id of local) assert.ok(near.includes(id) || !sec(body, 'recommended')?.productIds.includes(id), id);
  for (const id of sec(body, 'recommended')?.productIds || []) assert.ok(!near.includes(id));
});

test('ranking: orders picked up at a gym in the viewer\'s city first, then all paid orders; reason popular_in_area', async () => {
  const ord = (productId, gymId, extra = {}) => ({ id: `o_${Math.random()}`, buyerRole: 'member', items: [{ productId, qty: 1 }], paymentStatus: 'paid', status: 'delivered', createdAt: new Date(NOW - 2 * DAY).toISOString(), pickupGymId: gymId, ...extra });
  const s = setup({
    users: [ADULT], perVendor: 2,
    // prd_003 (v_b) twice at a Dar gym; prd_001 (v_a) four times at an Arusha gym; prd_009 (v_e, Arusha only) once at
    // the Arusha gym; plus one cancelled and one unpaid order at Dar, which never count.
    orders: [ord('prd_003', 'g_dar'), ord('prd_003', 'g_dar'), ...Array.from({ length: 4 }, () => ord('prd_001', 'g_aru')), ord('prd_005', 'g_dar', { status: 'cancelled' }), ord('prd_006', 'g_dar', { paymentStatus: 'pending' }), ord('prd_009', 'g_aru')],
    env: { SHOP_HOME_SECTIONS: 'popular_near_you' },
  });
  const { body } = await s.service.home({ claims: claimsOf(ADULT), query: { areaId: 'tz-dar-kino' } });
  const near = sec(body, 'popular_near_you');
  assert.deepEqual(near.productIds.slice(0, 2), ['prd_003', 'prd_001'], 'local first, then global');
  assert.deepEqual(near.reasonCodes, ['popular_in_area', 'delivers_to_area', 'seller_in_area']);
  assert.deepEqual(near.reason, { en: 'Popular with shoppers in Kinondoni.', sw: 'Maarufu kwa wanunuzi wa Kinondoni.' });
  assert.ok(!near.productIds.includes('prd_009'), 'v_e does not serve Dar');
  // In Arusha, prd_009's one local pickup beats prd_003's two Dar pickups; v_a (Dar only) is not there.
  const { body: aru } = await s.service.home({ claims: claimsOf(ADULT), query: { areaId: 'tz-aru-city' } });
  const aruIds = sec(aru, 'popular_near_you').productIds;
  assert.deepEqual(aruIds.slice(0, 2), ['prd_009', 'prd_003']);
  assert.ok(!aruIds.includes('prd_001'));
  // Cancelled and unpaid orders never rank: prd_005/prd_006 sit behind on the tie-break only.
  assert.ok(near.productIds.indexOf('prd_005') > 1 && near.productIds.indexOf('prd_006') > 1);
});

test('privacy: the service writes nothing and logs nothing with the areaId, also when a part fails', async () => {
  const s = setup({ users: [ADULT], perVendor: 2 });
  const failing = createShopHomeService({
    shopService: { listProducts: async () => s.products.rows },
    discoveryService: { discover: async () => ({ featured: [] }) },
    promotionService: { listLive: async () => [] },
    users: s.users, trainerService: { findProfileByUser: () => null }, identityLink: { personasOf: async () => [] },
    recentPaidOrders: async () => [], now: () => NOW,
    preferences: { stateFor: async () => ({ enabled: true, available: true, personalised: true, buyerIds: ['m1'], audienceAllowed: true, age: 36 }) },
    buyerPaidOrders: async () => [], personalisationOn: () => true, nearYouOn: () => true,
    geoAreas: { allAsync: async () => AREAS },
    bannerFeed: async () => { throw new Error('banner store down'); }, bannersOn: () => true,
    logger: { error: (...a) => s.logs.push(a.map(String).join(' ')) },
  });
  const secret = 'tz-dar-kino';
  await s.service.home({ claims: claimsOf(ADULT), query: { areaId: secret } });
  await failing.home({ claims: claimsOf(ADULT), query: { areaId: secret } });
  assert.deepEqual(s.writes, []);
  assert.ok(s.logs.length >= 1, 'the banner failure was logged');
  assert.ok(!s.logs.some(l => l.includes(secret) || l.includes('Kinondoni')), s.logs.join('\n'));
  // The shared (cached) data is the same object before and after viewers with different areas.
  const before = JSON.stringify(Object.keys(await s.service.loadShared()));
  await s.service.home({ claims: claimsOf(ADULT), query: { areaId: 'tz-aru-city' } });
  assert.equal(JSON.stringify(Object.keys(await s.service.loadShared())), before);
});

test('preferences: uses lists location only with SHOP_NEAR_YOU on and personalisation enabled', async () => {
  const s = setup({ users: [ADULT] });
  const prefs = (flags) => createShopPreferenceService({
    store: s.store, users: s.users, identityLink: { personasOf: async () => [] }, flagOn: () => flags.personalisation, nearYouOn: () => flags.near, now: () => NOW,
  });
  const usesOf = async flags => (await prefs(flags).get({ claims: claimsOf(ADULT) })).body.uses;
  assert.deepEqual(await usesOf({ personalisation: true, near: true }), ['purchase_history', 'profile_gender', 'profile_age', 'location']);
  assert.deepEqual(await usesOf({ personalisation: true, near: false }), ['purchase_history', 'profile_gender', 'profile_age']);
  assert.deepEqual(await usesOf({ personalisation: false, near: true }), []);
  await s.store.save({ personId: 'per1', subjectType: 'person', personalised: false, source: 'why_sheet', actorId: 'm1', at: NOW.toISOString() });
  assert.deepEqual(await usesOf({ personalisation: true, near: true }), []);
});
