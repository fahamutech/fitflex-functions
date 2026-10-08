// Discovery against the CI database: the existing public lists with moderation
// applied, and the /discover routes end to end through real promotions.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { trainers as trainerStore } from '../src/bootstrap/collections.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { moderationService, promotionService, shopService } from '../src/bootstrap/services.mjs';
import { listGyms } from '../functions/gyms.mjs';
import { listTrainers } from '../functions/trainers.mjs';
import { discoverGyms, discoverTrainers, discoverProducts } from '../functions/discover.mjs';

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const tok = () => randomUUID().replace(/-/g, '').slice(0, 8);               // a name no other test (or run) shares
const TOKEN = tok();
const HOUR = 3_600_000;
const iso = ms => new Date(Date.now() + ms).toISOString();
const made = { gyms: [], trainers: [], users: [], products: [], promotions: [] };

function res() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
async function call(route, { claims, query = {} } = {}) {
  const req = { headers: claims ? { authorization: `Bearer ${sign(claims)}` } : {}, params: {}, body: {}, query };
  const out = res();
  for (const guard of [route.onGuard].flat().filter(Boolean)) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return out;
}

async function gym(name, over = {}, token = TOKEN) {
  const id = uid('gym');
  await db('Gym').insert({ id, name: `${name} ${token}`, tier: 'standard', location: 'Dar es Salaam', status: 'active', trainerPass: JSON.stringify({ price: 5000 }), updatedAt: new Date(), ...over });
  made.gyms.push(id);
  return id;
}
async function admin() {
  const id = uid('usr');
  await db('User').insert({ id, userType: 'admin', displayName: 'Discovery admin', updatedAt: new Date() });
  made.users.push(id);
  return id;
}
async function liveFeatured(entityType, entityId, placement, maker, checker, over = {}) {
  const c = await promotionService.create({ actorId: maker, body: { entityType, entityId, type: 'featured', placements: [placement], startsAt: iso(-HOUR), endsAt: iso(48 * HOUR), priority: 1, ...over } });
  assert.equal(c.error, undefined, JSON.stringify(c));
  made.promotions.push(c.promotion.id);
  for (const [fn, who] of [['submit', maker], ['approve', checker], ['activate', checker]]) {
    const out = await promotionService[fn]({ id: c.promotion.id, actorId: who });
    assert.equal(out.error, undefined, `${fn}: ${JSON.stringify(out)}`);
  }
  return c.promotion.id;
}

after(async () => {
  if (made.promotions.length) {
    await db('PromotionPlacement').whereIn('promotionId', made.promotions).del();
    await db('Promotion').whereIn('id', made.promotions).del();
  }
  for (const g of made.gyms) await db('ModerationEvent').where({ entityType: 'gym', entityId: g }).del();
  for (const t of made.trainers) await db('ModerationEvent').where({ entityType: 'trainer', entityId: t }).del();
  for (const p of made.products) await db('ModerationEvent').where({ entityType: 'product', entityId: p }).del();
  for (const u of made.users) await db('ModerationEvent').where({ entityType: 'vendor', entityId: u }).del();
  await db('ModerationState').whereIn('entityId', [...made.gyms, ...made.trainers, ...made.products, ...made.users]).del();
  if (made.products.length) await db('Product').whereIn('id', made.products).del();
  for (const id of made.trainers) await trainerStore.removeAsync(t => t.id === id);
  if (made.gyms.length) await db('Gym').whereIn('id', made.gyms).del();
  if (made.users.length) { await db('AuditLog').whereIn('actor', made.users).del(); await db('User').whereIn('id', made.users).del(); }
});

test('the existing /gyms list is unchanged for listings with no moderation decision, and drops hidden and suspended ones', async () => {
  const a = await gym('Plain Gym');
  const b = await gym('Hidden Gym');
  const c = await gym('Suspended Gym');
  const mod = await admin();
  const names = async () => (await call(listGyms)).body.map(g => g.id);
  assert.ok((await names()).includes(a) && (await names()).includes(b) && (await names()).includes(c));       // nothing decided: all listed
  await moderationService.decide({ entityType: 'gym', entityId: b, action: 'hide', reason: 'x', actorId: mod });
  await moderationService.decide({ entityType: 'gym', entityId: c, action: 'suspend', reason: 'x', actorId: mod });
  const after = await names();
  assert.ok(after.includes(a));
  assert.ok(!after.includes(b) && !after.includes(c));
  await moderationService.decide({ entityType: 'gym', entityId: b, action: 'restore', actorId: mod });
  assert.ok((await names()).includes(b));                                                                    // restored: back
});

test('the existing /trainers list drops a suspended trainer', async () => {
  const id = uid('tr');
  await trainerStore.insertAsync({ id, displayName: `Moderated Trainer ${TOKEN}`, specialties: ['boxing'], status: 'active', approvalStatus: 'approved', gymIds: [] });
  made.trainers.push(id);
  const mod = await admin();
  assert.ok((await call(listTrainers, { query: { q: TOKEN } })).body.some(t => t.id === id));
  await moderationService.decide({ entityType: 'trainer', entityId: id, action: 'suspend', reason: 'x', actorId: mod });
  assert.ok(!(await call(listTrainers, { query: { q: TOKEN } })).body.some(t => t.id === id));
});

test('the shop hides a blocked product and a blocked vendor\'s products and storefront', async () => {
  const vendor = uid('usr');
  await db('User').insert({ id: vendor, userType: 'vendor', displayName: 'Shop vendor', approvalStatus: 'approved', accountStatus: 'active', vendorProfile: JSON.stringify({ businessName: 'Vendor', status: 'published' }), updatedAt: new Date() });
  made.users.push(vendor);
  const mk = async name => {
    const id = uid('prd');
    await db('Product').insert({ id, vendorId: vendor, name: `${name} ${TOKEN}`, category: 'gear', priceTzs: 10000, stock: 5, status: 'active', approvalStatus: 'approved', visibility: 'visible', updatedAt: new Date() });
    made.products.push(id);
    return id;
  };
  const p1 = await mk('Visible Mat'); const p2 = await mk('Hidden Mat');
  const mod = await admin();
  const listed = async () => (await shopService.listProducts({ vendorId: vendor })).map(p => p.id);
  assert.deepEqual((await listed()).sort(), [p1, p2].sort());
  await moderationService.decide({ entityType: 'product', entityId: p2, action: 'hide', reason: 'x', actorId: mod });
  assert.deepEqual(await listed(), [p1]);
  assert.equal(await shopService.getProduct(p2), null);                                                   // a direct link is hidden too
  assert.ok(await shopService.getVendorStore(vendor));
  await moderationService.decide({ entityType: 'vendor', entityId: vendor, action: 'suspend', reason: 'x', actorId: mod });
  assert.deepEqual(await listed(), []);
  assert.equal(await shopService.getVendorStore(vendor), null);
});

test('/discover/gyms: a Featured gym leads, a search returns only matches, and a suspended gym vanishes', async () => {
  const maker = await admin(); const checker = await admin(); const mod = await admin();
  const T = tok();
  const box = await gym('Knockout Boxing', { amenities: ['boxing'], rating: 4.5, reviewCount: 10 }, T);
  const other = await gym('Quiet Yoga', { amenities: ['yoga'], rating: 4.0, reviewCount: 5 }, T);
  const promoId = await liveFeatured('gym', other, 'gym_discovery', maker, checker);

  // Browse: Featured section; anonymous callers are fine and never see trainer-pass prices.
  assert.equal((await call(discoverGyms, { query: { q: T, limit: '50' } })).statusCode, 200);
  const bare = await call(discoverGyms, { query: { limit: '50' } });                                      // no search: placement gym_discovery
  assert.equal(bare.body.placement, 'gym_discovery');
  const featuredCard = bare.body.featured.find(g => g.id === other);
  assert.ok(featuredCard, 'the Featured gym leads');
  assert.deepEqual([featuredCard.promotion.type, featuredCard.promotion.label], ['featured', 'Featured']);
  assert.equal(featuredCard.trainerPass, undefined);
  assert.ok(bare.body.items.every(g => g.id !== other));

  // Search "boxing <token>": only the boxing gym; the Featured yoga gym is not inserted.
  const search = await call(discoverGyms, { query: { q: `boxing ${T}` } });
  assert.deepEqual(search.body.items.map(g => g.id), [box]);
  assert.deepEqual(search.body.featured, []);
  assert.equal(search.body.placement, 'search_results');

  // An explicit sort turns promotion off.
  const sorted = await call(discoverGyms, { query: { q: T, sort: 'rating' } });
  assert.deepEqual(sorted.body.items.map(g => g.id), [box, other]);
  assert.equal(sorted.body.promotionsApplied, false);
  assert.deepEqual(sorted.body.featured, []);

  // Only an admin can ask why.
  assert.equal((await call(discoverGyms, { query: { q: T, explain: 'true' } })).body.items[0].ranking, undefined);
  const explained = await call(discoverGyms, { claims: { sub: maker, userType: 'admin' }, query: { q: `boxing ${T}`, explain: 'true' } });
  assert.ok(typeof explained.body.items[0].ranking.baseScore === 'number');

  // Suspending the Featured gym removes it, and its promotion is paused.
  await moderationService.decide({ entityType: 'gym', entityId: other, action: 'suspend', reason: 'x', actorId: mod });
  const after = await call(discoverGyms, { query: { limit: '50' } });
  assert.ok(!after.body.featured.some(g => g.id === other));
  assert.ok(!after.body.items.some(g => g.id === other));
  assert.equal((await db('Promotion').where({ id: promoId }).first()).status, 'paused');

  assert.equal((await call(discoverGyms, { query: { sort: 'cheapest' } })).statusCode, 400);
  assert.equal((await call(discoverGyms, { query: { placement: 'trainer_discovery' } })).statusCode, 400);
});

test('/discover/gyms: a trainer sees trainer-pass prices, and a viewer\'s area scopes a local promotion', async () => {
  const maker = await admin(); const checker = await admin();
  const g = await gym('Island Gym', { location: 'Stone Town, Zanzibar', regionId: 'tz-znz', cityId: 'tz-znz-city' });
  await liveFeatured('gym', g, 'gym_discovery', maker, checker, { geoScope: { areaIds: ['tz-znz'] } });
  const inZnz = await call(discoverGyms, { claims: { sub: maker, userType: 'trainer' }, query: { areaId: 'tz-znz-stone-town', limit: '50' } });
  assert.ok(inZnz.body.featured.some(x => x.id === g));
  assert.deepEqual(inZnz.body.featured.find(x => x.id === g).trainerPass, { price: 5000 });
  assert.ok(!(await call(discoverGyms, { query: { areaId: 'tz-dar-city', limit: '50' } })).body.featured.some(x => x.id === g));
  // Coordinates inside Stone Town resolve to the area too.
  const byPosition = await call(discoverGyms, { query: { lat: '-6.163', lng: '39.189', limit: '50' } });
  assert.ok(byPosition.body.featured.some(x => x.id === g));
});

test('/discover/trainers and /discover/products', async () => {
  const maker = await admin(); const checker = await admin();
  const T = tok();
  const t1 = uid('tr'); const t2 = uid('tr');
  for (const [id, name, spec] of [[t1, 'Boxer', 'boxing'], [t2, 'Yogi', 'yoga']]) {
    await trainerStore.insertAsync({ id, displayName: `${name} ${T}`, specialties: [spec], status: 'active', approvalStatus: 'approved', gymIds: [] });
    made.trainers.push(id);
  }
  await liveFeatured('trainer', t2, 'trainer_discovery', maker, checker);
  const out = await call(discoverTrainers, { query: { limit: '50' } });
  assert.ok(out.body.featured.map(t => t.id).includes(t2));
  assert.deepEqual((await call(discoverTrainers, { query: { q: `boxing ${T}` } })).body.items.map(t => t.id), [t1]);
  const yogaOnly = await call(discoverTrainers, { query: { specialty: 'yoga', limit: '50' } });         // a filter alone is browsing: the Featured yogi passes it
  assert.ok(yogaOnly.body.featured.some(t => t.id === t2));
  assert.ok(!yogaOnly.body.items.some(t => t.id === t2));

  // Products need a signed-in user, as the shop list does.
  assert.equal((await call(discoverProducts, {})).statusCode, 401);
  const vendor = uid('usr');
  await db('User').insert({ id: vendor, userType: 'vendor', displayName: 'V', approvalStatus: 'approved', accountStatus: 'active', vendorProfile: JSON.stringify({ businessName: 'V', status: 'published' }), updatedAt: new Date() });
  made.users.push(vendor);
  const prod = uid('prd');
  await db('Product').insert({ id: prod, vendorId: vendor, name: `Discover Whey ${TOKEN}`, category: 'supplements', priceTzs: 50000, stock: 3, status: 'active', approvalStatus: 'approved', visibility: 'visible', updatedAt: new Date() });
  made.products.push(prod);
  const res1 = await call(discoverProducts, { claims: { sub: maker, userType: 'member' }, query: { q: `whey ${TOKEN}` } });
  assert.equal(res1.statusCode, 200);
  assert.deepEqual(res1.body.items.map(p => p.id), [prod]);
  assert.equal((await call(discoverProducts, { claims: { sub: maker, userType: 'member' }, query: { q: `whey ${TOKEN}`, sort: 'price_desc' } })).body.promotionsApplied, false);
});
