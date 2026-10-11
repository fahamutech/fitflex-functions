// The open gym endpoints (GET /gyms, GET /gyms/:id and GET /discover/gyms)
// against the CI database: they show what a member needs and nothing private —
// no commission rate, payout details, TIN or listing controls. Owners still
// read the full gym from GET /owner/gyms and admins from GET /admin/gyms.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { users, gyms } from '../src/bootstrap/collections.mjs';
import { listGyms, getGym, adminListGyms } from '../functions/gyms.mjs';
import { discoverGyms } from '../functions/discover.mjs';
import { ownerMyGyms } from '../functions/owner-gyms.mjs';
import { publicGym } from '../src/services/gym-service.mjs';

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const now = () => new Date().toISOString();
const created = { users: [], gyms: [] };

const PRIVATE = ['commissionRate', 'paymentBank', 'paymentNumber', 'paymentNotes', 'tinNumber', 'homepageVisible', 'homepagePriority'];
const NEEDED = ['id', 'name', 'tier', 'location', 'venueType', 'accessMode', 'status', 'coordinates', 'perVisitRate',
  'ratePerDay', 'ratePerWeek', 'ratePerMonth', 'images', 'thumbnails', 'operatingHours', 'amenities', 'equipment',
  'classes', 'verified', 'profileComplete'];
const SECRETS = ['Secret Bank', '0100200300', 'pay by Friday', '123-456-789'];

async function makeGym() {
  await gyms.ready;
  const id = uid('gym');
  await gyms.insertAsync({
    id, name: `Projection Gym ${id}`, tier: 'standard', location: 'Dar es Salaam', status: 'active',
    venueType: 'physical', accessMode: 'paid_visit', coordinates: { lat: -6.8, lng: 39.28 },
    perVisitRate: 8000, ratePerDay: 8000, ratePerWeek: 40000, ratePerMonth: 120000,
    images: ['https://img.test/g.jpg'], thumbnails: ['https://img.test/t.jpg'], operatingHours: { mon: '06:00-22:00' },
    amenities: ['Sauna'], equipment: ['Treadmill'], classes: [{ id: 'cls_1', name: 'Yoga', schedule: null, price: 5000, location: null }],
    trainerPass: { enabled: true, options: { monthly: 50000 }, feeTzs: 50000, period: 'monthly' },
    verified: false, homepageVisible: true, homepagePriority: 9,
    commissionRate: 17, paymentBank: 'Secret Bank', paymentNumber: '0100200300', paymentNotes: 'pay by Friday', tinNumber: '123-456-789',
    createdAt: now(), updatedAt: now(),
  });
  created.gyms.push(id);
  return id;
}

async function makeUser(userType, extra = {}) {
  const id = uid('usr');
  await users.insertAsync({ id, userType, displayName: 'Projection Tester', createdAt: now(), updatedAt: now(), ...extra });
  created.users.push(id);
  return id;
}

function res() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

/** Run a route's guards, then its handler if every guard passes. */
async function call(route, { claims, params = {}, body = {}, query = {} } = {}) {
  const req = { headers: claims ? { authorization: `Bearer ${sign(claims)}` } : {}, params, body, query };
  const out = res();
  for (const guard of [route.onGuard].flat().filter(Boolean)) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return out;
}

function assertPublic(gym, label) {
  for (const k of PRIVATE) assert.ok(!(k in gym), `${label} must not carry ${k}`);
}

after(async () => {
  for (const id of created.gyms) await gyms.removeAsync(g => g.id === id);
  if (created.gyms.length) await db('Gym').whereIn('id', created.gyms).del();
  if (created.users.length) await db('User').whereIn('id', created.users).del();
  await db.destroy();
});

test('the public gym list, detail and discovery carry no private fields', async () => {
  const gymId = await makeGym();

  const list = await call(listGyms);
  assert.equal(list.statusCode, 200);
  const card = list.body.find(g => g.id === gymId);
  assert.ok(card, 'the gym is listed');
  for (const g of list.body) assertPublic(g, 'list card');
  for (const k of NEEDED) assert.ok(k in card, `list card must still carry ${k}`);
  assert.equal(card.ratePerMonth, 120000);
  assert.deepEqual(card.images, ['https://img.test/g.jpg']);
  assert.deepEqual(card.coordinates, { lat: -6.8, lng: 39.28 });
  assert.ok(!('trainerPass' in card), 'trainer-pass pricing stays hidden from anonymous callers');

  const detail = await call(getGym, { params: { id: gymId } });
  assert.equal(detail.statusCode, 200);
  assertPublic(detail.body, 'detail');
  for (const k of NEEDED) assert.ok(k in detail.body, `detail must still carry ${k}`);

  const found = await call(discoverGyms, { query: { q: gymId, limit: '50' } });
  assert.equal(found.statusCode, 200);
  const cards = [...found.body.items, ...(found.body.featured || [])];
  const hit = cards.find(g => g.id === gymId);
  assert.ok(hit, 'discovery finds the gym');
  for (const g of cards) assertPublic(g, 'discovery card');
  for (const k of NEEDED) assert.ok(k in hit, `discovery card must still carry ${k}`);

  const raw = JSON.stringify([card, detail.body, hit]);
  for (const secret of SECRETS) assert.ok(!raw.includes(secret), `public payloads must not contain ${secret}`);
});

test('a signed-in caller gets the same public gym: trainers and admins also see the trainer pass, nothing private', async () => {
  const gymId = await makeGym();
  for (const userType of ['member', 'trainer', 'admin']) {
    const claims = { sub: await makeUser(userType), userType };
    const detail = await call(getGym, { claims, params: { id: gymId } });
    const list = await call(listGyms, { claims });
    const found = await call(discoverGyms, { claims, query: { q: gymId, limit: '50' } });
    const seen = [detail.body, list.body.find(g => g.id === gymId), found.body.items.find(g => g.id === gymId)];
    for (const g of seen) {
      assert.ok(g, `${userType} sees the gym`);
      assertPublic(g, `${userType} gym`);
      assert.equal('trainerPass' in g, userType !== 'member', `trainer pass for ${userType}`);
    }
  }
});

test('a new stored column stays private until it is listed as public', () => {
  const out = publicGym({ id: 'g1', name: 'A', bankAccountName: 'X', tinNumber: '1', commissionRate: 12 });
  assert.deepEqual(out, { id: 'g1', name: 'A' });
  assert.equal(publicGym(null), null);
});

test('owners and admins still read the full gym', async () => {
  const gymId = await makeGym();
  const ownerId = await makeUser('gym_operator', { gymId, gymIds: [gymId] });

  const mine = await call(ownerMyGyms, { claims: { sub: ownerId, userType: 'gym_operator' } });
  assert.equal(mine.statusCode, 200);
  const own = mine.body.find(g => g.id === gymId);
  assert.ok(own, 'the owner sees their gym');
  assert.equal(own.commissionRate, 17);
  assert.equal(own.paymentBank, 'Secret Bank');
  assert.equal(own.paymentNumber, '0100200300');
  assert.equal(own.paymentNotes, 'pay by Friday');
  assert.equal(own.tinNumber, '123-456-789');

  const adminId = await makeUser('admin', { role: 'super_admin' });
  const all = await call(adminListGyms, { claims: { sub: adminId, userType: 'admin', role: 'super_admin' }, query: { full: 'true' } });
  assert.equal(all.statusCode, 200);
  const row = all.body.find(g => g.id === gymId);
  assert.equal(row.paymentNumber, '0100200300');
  assert.equal(row.tinNumber, '123-456-789');
  assert.equal(row.homepagePriority, 9);
});
