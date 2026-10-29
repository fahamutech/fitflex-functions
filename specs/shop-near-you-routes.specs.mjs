// Shop "Popular near you" (Phase 2 · slice 3) against the CI database: GET /shop/areas, the vendor
// and admin area fields, the backfill, GET /shop/home?areaId= with every query captured (nothing is
// written, the area is in no query), and the real request logger (morgan) never printing the areaId.
// Contract: docs/shop-near-you-api.md.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Writable } from 'node:stream';
import express from 'express';
import morgan from 'morgan';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { ensureInit } from '../functions/index.mjs';
import { shopHome, shopAreas, resetShopHomeLimits } from '../functions/shop-home.mjs';
import { getShopPreferences } from '../functions/shop-preferences.mjs';
import { vendorProfile, vendorSaveProfile, adminListVendors, adminUpdateVendor, vendorToolsOptionsRoute, listShopProducts, getShopProduct } from '../functions/shop.mjs';
import { discoverProducts } from '../functions/discover.mjs';
import { shopHomeService } from '../src/bootstrap/services.mjs';
import { listGeoAreas, createGeoArea, updateGeoArea } from '../functions/promotions.mjs';

const require = createRequire(import.meta.url);
const migration = require('../db/migrations/20270111120000-vendor-shop-areas.cjs');

await ensureInit();

const tag = randomUUID().slice(0, 6);
const A = {
  region: `nyt${tag}-reg`, city: `nyt${tag}-city`, district: `nyt${tag}-dist`, other: `nyt${tag}-dist2`,
  farRegion: `nyt${tag}-far`, farCity: `nyt${tag}-farcity`, off: `nyt${tag}-off`, tiny: `nyt${tag}-tiny`, smallCity: `nyt${tag}-smallcity`,
};
// Unique names, so the backfill can only match these.
const N = { region: `Nyreg${tag}`, city: `Nycity${tag}`, district: `Nydist${tag}`, farCity: `Nyfar${tag}` };
const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], products: [] };
const old = new Date('2026-01-01T00:00:00Z'); // vendors created before KYC enforcement: exempt

function res() {
  return {
    statusCode: 200, body: null, headers: {},
    status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; },
    set(k, v) { this.headers[k] = v; return this; },
  };
}
async function call(route, claims, { query = {}, body = {}, params = {}, headers = {} } = {}) {
  const all = { ...(claims ? { authorization: `Bearer ${sign(claims)}` } : {}), ...headers };
  const req = { headers: all, params, query, body, get: name => all[String(name).toLowerCase()] ?? null };
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
  await db('User').insert({ id, userType, displayName: `Near-you ${userType}`, approvalStatus: 'approved', accountStatus: 'active', createdAt: old, updatedAt: new Date(), ...extra });
  made.users.push(id);
  return id;
}
const vendor = (profile = {}) => user('vendor', { vendorProfile: JSON.stringify({ businessName: `Near-you store ${tag}`, status: 'published', ...profile }) });
async function product(vendorId, extra = {}) {
  const id = uid('prd');
  await db('Product').insert({ id, vendorId, name: `Near-you ${tag}`, category: 'equipment', priceTzs: 20_000, stock: 4, status: 'active', approvalStatus: 'approved', updatedAt: new Date(), ...extra });
  made.products.push(id);
  return id;
}
const member = (dob = '1990-04-01') => user('member', { memberProfile: JSON.stringify({ gender: 'female', dateOfBirth: dob }) });
const asMember = id => ({ sub: id, userType: 'member' });
const profileOf = async id => (await db('User').where({ id }).first()).vendorProfile;

const FLAGS = ['SHOP_HOME_V2', 'SHOP_HOME_MIN_ITEMS', 'SHOP_HOME_CACHE_SECONDS', 'SHOP_PERSONALISATION', 'SHOP_NEAR_YOU', 'SHOP_HOME_SECTIONS'];
await db('GeoArea').insert([
  { id: A.region, level: 'region', name: N.region, parentId: 'tz', lat: -1, lng: 30, radiusKm: 50 },
  { id: A.city, level: 'city', name: N.city, parentId: A.region, lat: -1, lng: 30, radiusKm: 20 },
  { id: A.district, level: 'district', name: N.district, parentId: A.city, lat: -1.01, lng: 30.01, radiusKm: 4 },
  { id: A.other, level: 'district', name: `Nyother${tag}`, parentId: A.city, lat: -1.05, lng: 30.05, radiusKm: 4 },
  { id: A.farRegion, level: 'region', name: `Nyfarreg${tag}`, parentId: 'tz', lat: -9, lng: 33, radiusKm: 50 },
  { id: A.farCity, level: 'city', name: N.farCity, parentId: A.farRegion, lat: -9, lng: 33, radiusKm: 20 },
  { id: A.off, level: 'city', name: `Nyoff${tag}`, parentId: A.region, lat: -1, lng: 30, radiusKm: 5, active: false },
  // M1: too small to stand for a position (district < 2 km, city < 5 km).
  { id: A.tiny, level: 'district', name: `Nytiny${tag}`, nameSw: `Nytiny-sw${tag}`, parentId: A.city, lat: -1.02, lng: 30.02, radiusKm: 1, active: true },
  { id: A.smallCity, level: 'city', name: `Nysmall${tag}`, parentId: A.region, lat: -1.3, lng: 30.3, radiusKm: 3, active: true },
]);

beforeEach(() => {
  process.env.SHOP_HOME_V2 = '1';
  process.env.SHOP_HOME_CACHE_SECONDS = '1';
  process.env.SHOP_HOME_SECTIONS = 'popular_near_you';
  delete process.env.SHOP_HOME_MIN_ITEMS;
  delete process.env.SHOP_PERSONALISATION;
  delete process.env.SHOP_NEAR_YOU;
  shopHomeService.clearCache();
  resetShopHomeLimits();
});
after(async () => {
  for (const k of FLAGS) delete process.env[k];
  await db('AuditLog').whereIn('target', made.users).del();
  await db('ShopPreference').whereIn('personId', db('User').whereIn('id', made.users).select('personId')).del();
  await db('Product').whereIn('id', made.products).del();
  await db('User').whereIn('id', made.users).del();
  await db('AuditLog').whereIn('target', Object.values(A)).del();
  await db('GeoArea').whereIn('id', [A.district, A.other, A.off, A.tiny]).del();
  await db('GeoArea').whereIn('parentId', [A.city]).del();
  await db('GeoArea').whereIn('id', [A.city, A.farCity, A.smallCity]).del();
  await db('GeoArea').whereIn('id', [A.region, A.farRegion]).del();
  await db.destroy();
});

// ── GET /shop/areas ─────────────────────────────────────────────────────────

test('GET /shop/areas: flag off 404; signed out 401; on → usable areas only, cacheable, no personal data', async () => {
  const m = await member();
  assert.equal((await call(shopAreas, asMember(m))).statusCode, 404);
  process.env.SHOP_NEAR_YOU = '1';
  assert.equal((await call(shopAreas, null)).statusCode, 401);
  const out = await call(shopAreas, asMember(m));
  assert.equal(out.statusCode, 200);
  assert.equal(out.headers['Cache-Control'], 'private, max-age=3600');
  const ids = out.body.areas.map(a => a.id);
  for (const id of [A.region, A.city, A.district, 'tz', 'tz-dar-city']) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes(A.off), 'inactive left out');
  assert.deepEqual(out.body.areas.find(a => a.id === A.district), { id: A.district, level: 'district', name: N.district, names: { en: N.district, sw: N.district }, parentId: A.city, locatable: true, lat: -1.01, lng: 30.01, radiusKm: 4 });
  // M1: listed for vendor pickers, but no circle the device could map to; Swahili name from nameSw.
  assert.deepEqual(out.body.areas.find(a => a.id === A.tiny), { id: A.tiny, level: 'district', name: `Nytiny${tag}`, names: { en: `Nytiny${tag}`, sw: `Nytiny-sw${tag}` }, parentId: A.city, locatable: false, lat: null, lng: null, radiusKm: null });
  assert.equal(out.body.areas.find(a => a.id === A.smallCity).locatable, false);
  // The seeded Swahili names (native review).
  assert.deepEqual(out.body.areas.find(a => a.id === 'tz-znz-city').names, { en: 'Zanzibar City', sw: 'Mji wa Zanzibar' });
  assert.deepEqual(out.body.areas.find(a => a.id === 'tz-znz-stone-town').names, { en: 'Stone Town', sw: 'Mji Mkongwe' });
  assert.deepEqual(Object.keys(out.body), ['areas']);
});

// ── vendor and admin area fields ────────────────────────────────────────────

test('vendor profile: area fields validated against GeoArea, stored with areasSource vendor; bad input saves nothing', async () => {
  const v = await vendor({ address: 'Somewhere' });
  const asVendor = { sub: v, userType: 'vendor' };
  const before = await profileOf(v);
  for (const [body, field, reason] of [
    [{ cityId: A.region }, 'cityId', 'wrong_level'],
    [{ cityId: 'nope-x' }, 'cityId', 'unknown'],
    [{ cityId: A.off }, 'cityId', 'inactive'],
    [{ cityId: A.city, regionId: A.farRegion }, 'regionId', 'not_in_region'],
    [{ deliveryAreaIds: [A.region, 'nope-y'] }, 'deliveryAreaIds', 'unknown'],
    [{ deliveryAreaIds: A.region }, 'deliveryAreaIds', 'not_a_list'],
  ]) {
    const out = await call(vendorSaveProfile, asVendor, { body: { description: 'changed', ...body } });
    assert.equal(out.statusCode, 400, JSON.stringify(body));
    assert.equal(out.body.error, 'invalid_area');
    assert.equal(out.body.field, field);
    assert.equal(out.body.reason, reason);
    assert.deepEqual(await profileOf(v), before, 'nothing saved');
  }
  const ok = await call(vendorSaveProfile, asVendor, { body: { cityId: A.district, deliveryAreaIds: ['tz', A.farCity, 'tz'] } });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.cityId, ok.body.regionId, ok.body.deliveryAreaIds, ok.body.areasSource], [A.district, A.region, ['tz', A.farCity], 'vendor']);
  assert.equal(ok.body.address, 'Somewhere', 'other fields kept');
  const got = await call(vendorProfile, asVendor);
  assert.deepEqual([got.body.cityId, got.body.regionId, got.body.deliveryAreaIds], [A.district, A.region, ['tz', A.farCity]]);
  // Leaving them out keeps them; null / [] clear.
  await call(vendorSaveProfile, asVendor, { body: { description: 'again' } });
  assert.equal((await profileOf(v)).cityId, A.district);
  await call(vendorSaveProfile, asVendor, { body: { cityId: null, regionId: null, deliveryAreaIds: [] } });
  const cleared = await profileOf(v);
  assert.deepEqual([cleared.cityId, cleared.regionId, cleared.deliveryAreaIds], [null, null, []]);
  // vendor_staff still cannot write the profile.
  assert.equal((await call(vendorSaveProfile, { sub: uid('usr'), userType: 'vendor_staff', vendorId: v }, { body: { cityId: A.city } })).statusCode, 403);
});

test('admin: PUT /admin/vendors/:id maps areas (audited, areasSource admin); GET /admin/vendors shows them', async () => {
  const v = await vendor();
  const admin = { sub: await user('admin'), userType: 'admin' };
  const bad = await call(adminUpdateVendor, admin, { params: { id: v }, body: { regionId: A.city } });
  assert.equal(bad.statusCode, 400);
  assert.deepEqual(bad.body, { error: 'invalid_area', field: 'regionId', ids: [A.city], reason: 'wrong_level' });
  const ok = await call(adminUpdateVendor, admin, { params: { id: v }, body: { cityId: A.city, deliveryAreaIds: [A.region] } });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  const stored = await profileOf(v);
  assert.deepEqual([stored.cityId, stored.regionId, stored.deliveryAreaIds, stored.areasSource, stored.businessName], [A.city, A.region, [A.region], 'admin', `Near-you store ${tag}`]);
  const audit = await db('AuditLog').where({ target: v, action: 'vendor_management_updated' }).first();
  assert.deepEqual(audit.before.areas, { cityId: null, regionId: null, deliveryAreaIds: null, areasSource: null });
  assert.deepEqual(audit.after.areas, { cityId: A.city, regionId: A.region, deliveryAreaIds: [A.region], areasSource: 'admin' });
  assert.equal(audit.after.commissionPct, undefined, 'commission not touched, not reported as changed');
  const listed = (await call(adminListVendors, admin)).body.find(x => x.id === v);
  assert.deepEqual([listed.vendorProfile.cityId, listed.vendorProfile.deliveryAreaIds], [A.city, [A.region]]);
});

test('vendor tools options: merch.shopAreas follows SHOP_NEAR_YOU', async () => {
  const v = await vendor();
  assert.equal((await call(vendorToolsOptionsRoute, { sub: v, userType: 'vendor' })).body.merch.shopAreas, false);
  process.env.SHOP_NEAR_YOU = '1';
  assert.equal((await call(vendorToolsOptionsRoute, { sub: v, userType: 'vendor' })).body.merch.shopAreas, true);
});

// ── backfill (the migration's function, limited to this spec's vendors) ────

test('backfill: free text → ids on the real table; never overwrites; counts; down removes only backfilled fields', async () => {
  const filled = await vendor({ address: `Plot 9, ${N.district}`, deliveryRegions: [N.region.toUpperCase(), N.farCity, 'Mars'] });
  const nationwide = await vendor({ address: 'No known place', deliveryRegions: 'Nationwide' });
  const kept = await vendor({ address: N.farCity, cityId: A.city, regionId: A.region, deliveryAreaIds: [], areasSource: 'vendor', deliveryRegions: [N.region] });
  const ambiguous = await vendor({ address: `${N.city} and ${N.farCity}` });
  const nothing = await vendor({ address: 'Nowhere' });
  const ids = [filled, nationwide, kept, ambiguous, nothing];
  const counts = await migration.backfill(db, { vendorIds: ids });
  assert.deepEqual(counts, { vendors: 5, city: 1, region: 1, delivery: 2, none: 3 });
  const f = await profileOf(filled);
  assert.deepEqual([f.cityId, f.regionId, f.deliveryAreaIds, f.areasSource], [A.city, A.region, [A.region, A.farCity], 'backfill']);
  assert.deepEqual(f.deliveryRegions, [N.region.toUpperCase(), N.farCity, 'Mars'], 'free text kept for display');
  const nw = await profileOf(nationwide);
  assert.deepEqual([nw.cityId, nw.deliveryAreaIds, nw.areasSource], [undefined, ['tz'], 'backfill']);
  const k = await profileOf(kept);
  assert.deepEqual([k.cityId, k.regionId, k.deliveryAreaIds, k.areasSource], [A.city, A.region, [], 'vendor']);
  assert.equal((await profileOf(ambiguous)).cityId, undefined);
  // Running it again changes nothing.
  assert.deepEqual(await migration.backfill(db, { vendorIds: ids }), { vendors: 5, city: 0, region: 0, delivery: 0, none: 5 });
  // Down: only rows still marked backfill lose the fields.
  await migration.down(db);
  const fd = await profileOf(filled);
  assert.deepEqual([fd.cityId, fd.deliveryAreaIds, fd.areasSource, fd.address], [undefined, undefined, undefined, `Plot 9, ${N.district}`]);
  assert.equal((await profileOf(kept)).cityId, A.city);
});

// ── GET /shop/home?areaId= ──────────────────────────────────────────────────

async function nearCatalogue() {
  const based = await vendor({ cityId: A.city, regionId: A.region });
  const delivers = await vendor({ cityId: A.farCity, deliveryAreaIds: [A.region] });
  const far = await vendor({ cityId: A.farCity, deliveryAreaIds: [A.farCity] });
  const p = {
    based: [await product(based), await product(based)],
    delivers: [await product(delivers), await product(delivers)],
    far: [await product(far, { distanceKm: 0.5 })],
  };
  return { based, delivers, far, p };
}
const withQueries = async (fn) => {
  const seen = [];
  const listen = q => seen.push({ sql: String(q.sql), bindings: JSON.stringify(q.bindings || []) });
  db.on('query', listen);
  try { return { out: await fn(), seen }; } finally { db.removeListener('query', listen); }
};

test('home: flag on + personalisation on → popular_near_you from the database; no write and no query carries the areaId', async () => {
  process.env.SHOP_PERSONALISATION = '1';
  process.env.SHOP_NEAR_YOU = '1';
  const { p } = await nearCatalogue();
  const m = await member();
  const { out, seen } = await withQueries(() => call(shopHome, asMember(m), { headers: { 'x-ff-area': A.district } }));
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  assert.deepEqual(out.body.nearYou, { available: true, areaId: A.district, areaName: { en: N.district, sw: N.district } });
  const near = out.body.sections.find(s => s.key === 'popular_near_you');
  assert.ok(near, JSON.stringify(out.body.sections));
  assert.deepEqual([...near.productIds].sort(), [...p.based, ...p.delivers].sort(), 'the far vendor (and its 0.5 km distance) is not near');
  // QA1: the delivering vendor lists the region and the other is based in the city → the city is named.
  assert.deepEqual(near.reasonParams, { areaName: { en: N.city, sw: N.city } });
  assert.deepEqual(out.body.nearYou.areaName, { en: N.district, sw: N.district });
  assert.deepEqual(near.viewAll, { path: '/shop/products', query: {} });
  for (const id of p.delivers) assert.equal(out.body.products[id].deliversToViewerArea, true);
  for (const id of p.based) assert.equal(out.body.products[id].deliversToViewerArea, undefined);
  assert.ok(seen.length > 0, 'queries were captured');
  const writes = seen.filter(q => /^\s*(insert|update|delete|upsert|merge|create|alter|drop|truncate)\b/i.test(q.sql));
  assert.deepEqual(writes, [], 'GET /shop/home writes nothing');
  assert.deepEqual(seen.filter(q => q.sql.includes(A.district) || q.bindings.includes(A.district)), [], 'the areaId is in no query');
});

test('home: X-FF-Area header is preferred over ?areaId=; ?areaId= still works; too-small areas are ignored (M1, M3)', async () => {
  process.env.SHOP_PERSONALISATION = '1';
  process.env.SHOP_NEAR_YOU = '1';
  await nearCatalogue();
  const m = await member();
  const areaOf = async opts => (await call(shopHome, asMember(m), opts)).body.nearYou;
  assert.equal((await areaOf({ headers: { 'x-ff-area': A.city }, query: { areaId: A.district } })).areaId, A.city, 'header wins');
  assert.equal((await areaOf({ query: { areaId: A.district } })).areaId, A.district, 'query still accepted (one release)');
  assert.equal((await areaOf({ headers: { 'x-ff-area': '  ' }, query: { areaId: A.district } })).areaId, A.district, 'blank header falls back');
  for (const small of [A.tiny, A.smallCity]) {
    const near = await areaOf({ headers: { 'x-ff-area': small } });
    assert.deepEqual(near, { available: true }, small);
  }
});

test('home: flag off → byte-identical body with or without areaId; switch off / under 18 → no section, no badge', async () => {
  process.env.SHOP_PERSONALISATION = '1';
  process.env.SHOP_HOME_SECTIONS = '';
  process.env.SHOP_HOME_MIN_ITEMS = '1';
  await nearCatalogue();
  const m = await member();
  const strip = b => JSON.stringify({ ...b, serverNow: null });
  const plain = await call(shopHome, asMember(m));
  shopHomeService.clearCache();
  const withArea = await call(shopHome, asMember(m), { query: { areaId: A.district } });
  assert.equal(strip(withArea.body), strip(plain.body));
  assert.ok(!('nearYou' in withArea.body));

  process.env.SHOP_NEAR_YOU = '1';
  const minor = await member('2012-03-03');
  const off = await member();
  const offPerson = (await db('User').where({ id: off }).first()).personId;
  await db('ShopPreference').insert({ personId: offPerson, subjectType: 'person', personalised: false, source: 'why_sheet', updatedBy: off, updatedAt: new Date() });
  for (const who of [minor, off]) {
    const out = await call(shopHome, asMember(who), { query: { areaId: A.district } });
    assert.equal(out.statusCode, 200);
    assert.deepEqual(out.body.nearYou, { available: false });
    assert.ok(!out.body.sections.some(s => s.key === 'popular_near_you'));
    assert.ok(!Object.values(out.body.products).some(r => 'deliversToViewerArea' in r));
  }
  const prefs = await call(getShopPreferences, asMember(m));
  assert.ok(prefs.body.uses.includes('location'));
  assert.ok(!(await call(getShopPreferences, asMember(off))).body.uses.includes('location'));
});

test('request log: the real request logger (morgan, as bfast-function mounts it) never prints the areaId, on any status', async () => {
  process.env.SHOP_PERSONALISATION = '1';
  process.env.SHOP_NEAR_YOU = '1';
  const m = await member();
  const lines = [];
  const app = express();
  app.use(morgan('dev', { stream: new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } }) }));
  // As bfast-function: guards with app.use(path, guard), handlers with app[method](path, handler).
  app.use(shopHome.path, shopHome.onGuard);
  app.get(shopHome.path, shopHome.onRequest);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const consoleLines = [];
  const orig = {};
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) { orig[k] = console[k]; console[k] = (...a) => { consoleLines.push(a.map(String).join(' ')); }; }
  try {
    const token = sign(asMember(m));
    const okRes = await fetch(`${base}/shop/home?mode=member&areaId=${A.district}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(okRes.status, 200);
    assert.equal((await okRes.json()).nearYou.areaId, A.district, 'the handler still read the areaId');
    // M3: the header (never in the log line), and keys hidden by percent-encoding, case or brackets.
    const viaHeader = await fetch(`${base}/shop/home?mode=member`, { headers: { authorization: `Bearer ${token}`, 'x-ff-area': A.district } });
    assert.equal((await viaHeader.json()).nearYou.areaId, A.district);
    for (const q of [`%61reaId=${A.district}`, `area%49d=${A.district}`, `AREAID=${A.district}`, `areaId[]=${A.district}`, `areaId%5B%5D=${A.district}`, `%2561reaId=${A.district}`, `mode=member&areaid=${encodeURIComponent(A.district)}`]) {
      const r = await fetch(`${base}/shop/home?${q}`, { headers: { authorization: `Bearer ${token}` } });
      assert.ok([200, 403].includes(r.status), `${q}: ${r.status}`);
    }
    const encoded = await fetch(`${base}/shop/home?%61reaId=${A.district}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal((await encoded.json()).nearYou.areaId, A.district, 'Express decodes %61reaId to areaId — exactly why it must be redacted');
    assert.equal((await fetch(`${base}/shop/home?areaId=${A.district}`)).status, 401);
    delete process.env.SHOP_HOME_V2;
    assert.equal((await fetch(`${base}/shop/home?areaId=${A.district}&mode=member`, { headers: { authorization: `Bearer ${token}` } })).status, 404);
    await new Promise(r => setTimeout(r, 50));
  } finally {
    for (const k of Object.keys(orig)) console[k] = orig[k];
    await new Promise(r => server.close(r));
  }
  assert.equal(lines.length, 12, lines.join(''));
  assert.ok(lines.every(l => l.includes('/shop/home')), lines.join(''));
  assert.ok(lines.some(l => l.includes('/shop/home?mode=member')), 'other parameters still logged');
  assert.deepEqual([...lines, ...consoleLines].filter(l => l.includes(A.district) || l.includes(N.district) || /areaId/i.test(l)), []);
});

test('admin areas: GET /admin/geo-areas opens to the shop scope (read only); POST still needs campaigns; vendor update rejects unknown/inactive ids', async () => {
  const id = await user('admin');
  const portal = scopes => ({ sub: id, userType: 'admin', portalUser: true, aclPermissions: scopes });
  const list = await call(listGeoAreas, portal(['shop']));
  assert.equal(list.statusCode, 200, JSON.stringify(list.body));
  assert.ok(list.body.areas.some(a => a.id === A.city));
  assert.equal((await call(listGeoAreas, portal(['promotions']))).statusCode, 200);
  assert.equal((await call(listGeoAreas, portal(['analytics']))).statusCode, 403);
  const create = await call(createGeoArea, portal(['shop']), { body: { level: 'district', name: `Nynew${tag}`, parentId: A.city } });
  assert.equal(create.statusCode, 403, 'shop cannot add areas');
  assert.equal(await db('GeoArea').where({ name: `Nynew${tag}` }).first(), undefined);
  const v = await vendor();
  for (const [body, ids, reason] of [[{ cityId: 'nope-z' }, ['nope-z'], 'unknown'], [{ cityId: A.off }, [A.off], 'inactive'], [{ deliveryAreaIds: [A.off] }, [A.off], 'inactive']]) {
    const out = await call(adminUpdateVendor, portal(['shop']), { params: { id: v }, body });
    assert.equal(out.statusCode, 400);
    assert.deepEqual([out.body.error, out.body.ids, out.body.reason], ['invalid_area', ids, reason]);
  }
  assert.equal((await profileOf(v)).cityId, undefined);
});

test('area Swahili names: POST /admin/geo-areas takes nameSw; PATCH sets / clears it (campaigns only), audited', async () => {
  const id = await user('admin');
  const portal = scopes => ({ sub: id, userType: 'admin', portalUser: true, aclPermissions: scopes });
  const made1 = await call(createGeoArea, portal(['campaigns']), { body: { level: 'district', name: `Nynew${tag}`, nameSw: ` Mpya${tag} `, parentId: A.city, lat: -1, lng: 30, radiusKm: 3 } });
  assert.equal(made1.statusCode, 201, JSON.stringify(made1.body));
  const newId = made1.body.area.id;
  assert.equal((await db('GeoArea').where({ id: newId }).first()).nameSw, `Mpya${tag}`);
  assert.equal((await call(updateGeoArea, portal(['shop']), { params: { id: newId }, body: { nameSw: 'x' } })).statusCode, 403, 'shop is read only');
  const set = await call(updateGeoArea, portal(['campaigns']), { params: { id: A.district }, body: { nameSw: `Wilaya${tag}` } });
  assert.equal(set.statusCode, 200, JSON.stringify(set.body));
  assert.equal((await db('GeoArea').where({ id: A.district }).first()).nameSw, `Wilaya${tag}`);
  process.env.SHOP_NEAR_YOU = '1';
  const m = await member();
  assert.deepEqual((await call(shopAreas, asMember(m))).body.areas.find(a => a.id === A.district).names, { en: N.district, sw: `Wilaya${tag}` });
  const audit = await db('AuditLog').where({ target: A.district, action: 'promotion.geo_area_updated' }).first();
  assert.deepEqual([audit.before, audit.after], [{ nameSw: null }, { nameSw: `Wilaya${tag}` }]);
  assert.equal((await call(updateGeoArea, portal(['campaigns']), { params: { id: A.district }, body: { nameSw: null } })).statusCode, 200);
  assert.equal((await db('GeoArea').where({ id: A.district }).first()).nameSw, null);
  assert.equal((await call(updateGeoArea, portal(['campaigns']), { params: { id: A.district }, body: { name: 'x' } })).statusCode, 422);
  assert.equal((await call(updateGeoArea, portal(['campaigns']), { params: { id: A.district }, body: { nameSw: 5 } })).statusCode, 422);
  assert.equal((await call(updateGeoArea, portal(['campaigns']), { params: { id: 'nope-q' }, body: { nameSw: 'x' } })).statusCode, 404);
});

// ── QA1: the badge on GET /shop/products and GET /shop/products/:id ─────────

test('QA1 products: X-FF-Area marks rows whose vendor delivers there; nothing written, the area in no query', async () => {
  process.env.SHOP_PERSONALISATION = '1';
  process.env.SHOP_NEAR_YOU = '1';
  const { based, delivers, far, p } = await nearCatalogue();
  const m = await member();
  const mine = rows => rows.filter(r => [based, delivers, far].includes(r.vendorId));
  const { out, seen } = await withQueries(() => call(listShopProducts, asMember(m), { query: { search: `Near-you ${tag}` }, headers: { 'x-ff-area': A.district } }));
  assert.equal(out.statusCode, 200);
  const rows = mine(out.body);
  assert.equal(rows.length, 5);
  for (const r of rows) assert.equal(r.deliversToViewerArea, r.vendorId === delivers ? true : undefined, r.vendorId);
  assert.deepEqual(seen.filter(q => /^\s*(insert|update|delete)\b/i.test(q.sql)), []);
  assert.deepEqual(seen.filter(q => q.sql.includes(A.district) || q.bindings.includes(A.district)), []);
  // Product details: the product and its similar products.
  const detail = await call(getShopProduct, asMember(m), { params: { id: p.delivers[0] }, headers: { 'x-ff-area': A.district } });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.body.deliversToViewerArea, true);
  const sim = detail.body.similarProducts.filter(r => r.vendorId === delivers || r.vendorId === based);
  assert.ok(sim.length > 0);
  for (const r of sim) assert.equal(r.deliversToViewerArea, r.vendorId === delivers ? true : undefined);
  const basedDetail = await call(getShopProduct, asMember(m), { params: { id: p.based[0] }, headers: { 'x-ff-area': A.district } });
  assert.equal(basedDetail.body.deliversToViewerArea, undefined, 'based in only: no badge');
  // The query is not read on these routes (header only).
  const viaQuery = await call(listShopProducts, asMember(m), { query: { search: `Near-you ${tag}`, areaId: A.district } });
  assert.ok(!mine(viaQuery.body).some(r => 'deliversToViewerArea' in r));
});

test('QA1 products: flag off / switch off / under 18 / unusable area → body byte-identical to no header', async () => {
  process.env.SHOP_PERSONALISATION = '1';
  const { p } = await nearCatalogue();
  const adult = await member();
  const minor = await member('2012-03-03');
  const off = await member();
  const offPerson = (await db('User').where({ id: off }).first()).personId;
  await db('ShopPreference').insert({ personId: offPerson, subjectType: 'person', personalised: false, source: 'why_sheet', updatedBy: off, updatedAt: new Date() });
  const same = async (who, area, label) => {
    for (const [route, opts] of [[listShopProducts, { query: { search: `Near-you ${tag}` } }], [getShopProduct, { params: { id: p.delivers[0] } }]]) {
      const plain = await call(route, asMember(who), opts);
      const withArea = await call(route, asMember(who), { ...opts, headers: { 'x-ff-area': area } });
      assert.equal(JSON.stringify(withArea.body), JSON.stringify(plain.body), `${label} ${route.path}`);
      assert.ok(!JSON.stringify(withArea.body).includes('deliversToViewerArea'), label);
    }
  };
  await same(adult, A.district, 'flag off');
  process.env.SHOP_NEAR_YOU = '1';
  await same(minor, A.district, 'under 18');
  await same(off, A.district, 'switch off');
  for (const area of [A.tiny, A.smallCity, A.off, 'tz', 'nope']) await same(adult, area, `area ${area}`);
});

test('QA1 products: the real request logger never prints the area for /shop/products or /shop/products/:id', async () => {
  process.env.SHOP_PERSONALISATION = '1';
  process.env.SHOP_NEAR_YOU = '1';
  const { p } = await nearCatalogue();
  const m = await member();
  const lines = [];
  const app = express();
  app.use(morgan('dev', { stream: new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } }) }));
  // As bfast-function mounts them: both guards by path prefix, then the handlers.
  app.use(listShopProducts.path, listShopProducts.onGuard);
  app.use(getShopProduct.path, getShopProduct.onGuard);
  app.get(listShopProducts.path, listShopProducts.onRequest);
  app.get(getShopProduct.path, getShopProduct.onRequest);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { authorization: `Bearer ${sign(asMember(m))}` };
  try {
    const list = await fetch(`${base}/shop/products?search=${encodeURIComponent(`Near-you ${tag}`)}`, { headers: { ...auth, 'x-ff-area': A.district } });
    assert.ok((await list.json()).some(r => r.deliversToViewerArea === true));
    const one = await fetch(`${base}/shop/products/${p.delivers[0]}?areaId=${A.district}`, { headers: { ...auth, 'x-ff-area': A.district } });
    assert.equal((await one.json()).deliversToViewerArea, true);
    for (const q of [`areaId=${A.district}`, `%61reaId=${A.district}`, `areaId[]=${A.district}`]) {
      assert.equal((await fetch(`${base}/shop/products?${q}`, { headers: auth })).status, 200);
      assert.equal((await fetch(`${base}/shop/products/${p.based[0]}?${q}`)).status, 401);
    }
    await new Promise(r => setTimeout(r, 50));
  } finally {
    await new Promise(r => server.close(r));
  }
  assert.equal(lines.length, 8, lines.join(''));
  assert.deepEqual(lines.filter(l => l.includes(A.district) || /areaid/i.test(l) || l.includes('%61reaId')), [], lines.join(''));
});

// ── QA2: ?maxDistanceKm= (vendor-typed distance) is ignored once areas exist ───

test('QA2 maxDistanceKm: flag off filters by the vendor-typed distance exactly as before; flag on with areas ignores it', async () => {
  const v = await vendor({ cityId: A.city });
  const near = await product(v, { distanceKm: 3, name: `QA2 dist ${tag}` });
  const far = await product(v, { distanceKm: 30, name: `QA2 dist ${tag}` });
  const none = await product(v, { name: `QA2 dist ${tag}` }); // no distance typed
  const m = await member();
  const ids = body => (Array.isArray(body) ? body : [...(body.featured || []), ...(body.items || body.results || [])]).map(r => r.id).filter(id => [near, far, none].includes(id)).sort();
  const list = q => call(listShopProducts, asMember(m), { query: { search: `QA2 dist ${tag}`, ...q } });
  const disc = q => call(discoverProducts, asMember(m), { query: { q: `QA2 dist ${tag}`, ...q } });
  // Flag off: today's behaviour.
  assert.deepEqual(ids((await list({ maxDistanceKm: '10' })).body), [near]);
  assert.deepEqual(ids((await list({})).body), [near, far, none].sort());
  const dOff = await disc({ maxDistanceKm: '10' });
  assert.equal(dOff.statusCode, 200, JSON.stringify(dOff.body));
  assert.deepEqual(ids(dOff.body), [near]);
  // Flag on, areas configured (the seeded GeoArea rows): the filter is ignored on both routes.
  process.env.SHOP_NEAR_YOU = '1';
  assert.ok((await shopHomeService.areas()).length > 0);
  assert.deepEqual(ids((await list({ maxDistanceKm: '10' })).body), [near, far, none].sort());
  assert.deepEqual(JSON.stringify((await list({ maxDistanceKm: '10' })).body), JSON.stringify((await list({})).body), 'same as no filter');
  assert.deepEqual(ids((await disc({ maxDistanceKm: '10' })).body), [near, far, none].sort());
  // Other filters still apply.
  assert.deepEqual(ids((await list({ maxDistanceKm: '10', maxPrice: '1' })).body), []);
});
