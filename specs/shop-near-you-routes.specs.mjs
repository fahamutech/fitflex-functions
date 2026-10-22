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
import { vendorProfile, vendorSaveProfile, adminListVendors, adminUpdateVendor, vendorToolsOptionsRoute } from '../functions/shop.mjs';
import { shopHomeService } from '../src/bootstrap/services.mjs';
import { listGeoAreas, createGeoArea } from '../functions/promotions.mjs';

const require = createRequire(import.meta.url);
const migration = require('../db/migrations/20270111120000-vendor-shop-areas.cjs');

await ensureInit();

const tag = randomUUID().slice(0, 6);
const A = {
  region: `nyt${tag}-reg`, city: `nyt${tag}-city`, district: `nyt${tag}-dist`, other: `nyt${tag}-dist2`,
  farRegion: `nyt${tag}-far`, farCity: `nyt${tag}-farcity`, off: `nyt${tag}-off`,
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
async function call(route, claims, { query = {}, body = {}, params = {} } = {}) {
  const req = { headers: claims ? { authorization: `Bearer ${sign(claims)}` } : {}, params, query, body, get: () => null };
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
  await db('GeoArea').whereIn('id', [A.district, A.other, A.off]).del();
  await db('GeoArea').whereIn('id', [A.city, A.farCity]).del();
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
  assert.deepEqual(out.body.areas.find(a => a.id === A.district), { id: A.district, level: 'district', name: N.district, names: { en: N.district, sw: N.district }, parentId: A.city, lat: -1.01, lng: 30.01, radiusKm: 4 });
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
  const { out, seen } = await withQueries(() => call(shopHome, asMember(m), { query: { areaId: A.district } }));
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  assert.deepEqual(out.body.nearYou, { available: true, areaId: A.district, areaName: { en: N.district, sw: N.district } });
  const near = out.body.sections.find(s => s.key === 'popular_near_you');
  assert.ok(near, JSON.stringify(out.body.sections));
  assert.deepEqual([...near.productIds].sort(), [...p.based, ...p.delivers].sort(), 'the far vendor (and its 0.5 km distance) is not near');
  assert.deepEqual(near.reasonParams, { areaName: N.district });
  for (const id of p.delivers) assert.equal(out.body.products[id].deliversToViewerArea, true);
  for (const id of p.based) assert.equal(out.body.products[id].deliversToViewerArea, undefined);
  assert.ok(seen.length > 0, 'queries were captured');
  const writes = seen.filter(q => /^\s*(insert|update|delete|upsert|merge|create|alter|drop|truncate)\b/i.test(q.sql));
  assert.deepEqual(writes, [], 'GET /shop/home writes nothing');
  assert.deepEqual(seen.filter(q => q.sql.includes(A.district) || q.bindings.includes(A.district)), [], 'the areaId is in no query');
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
    assert.equal((await fetch(`${base}/shop/home?areaId=${A.district}`)).status, 401);
    delete process.env.SHOP_HOME_V2;
    assert.equal((await fetch(`${base}/shop/home?areaId=${A.district}&mode=member`, { headers: { authorization: `Bearer ${token}` } })).status, 404);
    await new Promise(r => setTimeout(r, 50));
  } finally {
    for (const k of Object.keys(orig)) console[k] = orig[k];
    await new Promise(r => server.close(r));
  }
  assert.equal(lines.length, 3, lines.join(''));
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
