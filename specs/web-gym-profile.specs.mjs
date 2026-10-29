// Browser gym profile (S1) against the CI database: POST /public/gyms/resolve is dormant behind
// WEB_GYM_PROFILE, answers one identical 404 for every kind of miss, and carries only the whitelisted profile.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { gyms, users } from '../src/bootstrap/collections.mjs';
import { issueGymQr } from '../src/auth/qr-token.mjs';
import { resolveWebGym, resetWebGymProfileLimits, WEB_GYM_PROFILE_RATE_PER_MINUTE } from '../functions/web-gym-profile.mjs';
import { getGym } from '../functions/gyms.mjs';
import { memberScanGymQr } from '../functions/checkins.mjs';
import { extractQrPayload, publicRefFor } from '../src/services/web-gym-profile-service.mjs';

assert.match(String(process.env.DATABASE_URL_CI || ''), /fitflex_ci/, 'specs run against the CI database only');

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const now = () => new Date().toISOString();
const created = { gyms: [] };
const flagBefore = process.env.WEB_GYM_PROFILE;

const SECRETS = ['Secret Bank', '0100200300', 'pay by Friday', '123-456-789'];
const FORBIDDEN_KEYS = ['id', 'commissionRate', 'paymentBank', 'paymentNumber', 'paymentNotes', 'tinNumber', 'homepageVisible',
  'homepagePriority', 'ownerId', 'ownerIds', 'owners', 'kyc', 'members', 'regionId', 'cityId', 'createdAt', 'updatedAt',
  'trainerPass', 'perVisitRate', 'status', 'email', 'phone', 'userId', 'gymIds'];

async function makeGym(extra = {}) {
  await gyms.ready;
  const id = uid('gym');
  await gyms.insertAsync({
    id, name: `Web Profile Gym ${id.slice(-4)}x`, tier: 'standard', location: 'Masaki, Dar es Salaam', status: 'active',
    venueType: 'physical', accessMode: 'paid_visit', coordinates: { lat: -6.8, lng: 39.28 },
    perVisitRate: 8000, ratePerDay: 8000, ratePerWeek: 40000, ratePerMonth: 120000,
    images: ['https://img.test/1.jpg', 'https://img.test/2.jpg', 'https://img.test/3.jpg', 'https://img.test/4.jpg',
      'https://img.test/5.jpg', 'https://img.test/6.jpg', 'https://img.test/7.jpg'],
    thumbnails: ['https://img.test/t.jpg'], operatingHours: { mon: { open: '06:00', close: '22:00' }, default: { open: '07:00', close: '20:00' } },
    amenities: ['Sauna'], equipment: ['Treadmill'], classes: [{ id: 'cls_1', name: 'Yoga', schedule: 'Sat 09:00', price: 5000, location: 'Studio' }],
    trainerPass: { enabled: true, options: { monthly: 50000 }, feeTzs: 50000, period: 'monthly' },
    verified: false, homepageVisible: true, homepagePriority: 9,
    commissionRate: 17, paymentBank: 'Secret Bank', paymentNumber: '0100200300', paymentNotes: 'pay by Friday', tinNumber: '123-456-789',
    createdAt: now(), updatedAt: now(), ...extra,
  });
  created.gyms.push(id);
  return id;
}

function res() {
  return {
    statusCode: 200, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    set(k, v) { this.headers[k] = v; return this; },
  };
}
async function resolve(body, { ip = '203.0.113.7', route = resolveWebGym } = {}) {
  const req = { headers: { 'x-forwarded-for': ip }, body, params: {}, query: {} };
  const out = res();
  await route.onRequest(req, out);
  return out;
}
async function call(route, { params = {}, body = {} } = {}) {
  const out = res();
  await route.onRequest({ headers: {}, params, body, query: {} }, out);
  return out;
}
const keysDeep = (v, acc = new Set()) => {
  if (Array.isArray(v)) v.forEach(x => keysDeep(x, acc));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { acc.add(k); keysDeep(x, acc); }
  return acc;
};

beforeEach(() => { process.env.WEB_GYM_PROFILE = '1'; resetWebGymProfileLimits(); });
after(async () => {
  if (flagBefore === undefined) delete process.env.WEB_GYM_PROFILE; else process.env.WEB_GYM_PROFILE = flagBefore;
  for (const id of created.gyms) await gyms.removeAsync(g => g.id === id);
  if (created.gyms.length) await db('Gym').whereIn('id', created.gyms).del();
  await db.destroy();
});

test('flag off: the route is a 404 not_found even for a valid QR', async () => {
  const id = await makeGym();
  delete process.env.WEB_GYM_PROFILE;
  const out = await resolve({ q: issueGymQr(id) });
  assert.equal(out.statusCode, 404);
  assert.deepEqual(out.body, { error: 'not_found' });
});

test('a valid QR returns the whitelisted profile, from the same sources as the app', async () => {
  const id = await makeGym();
  const out = await resolve({ q: issueGymQr(id), lang: 'en' });
  assert.equal(out.statusCode, 200);
  const { gym, membership } = out.body;
  assert.equal(gym.name, `Web Profile Gym ${id.slice(-4)}x`);
  assert.equal(gym.publicRef, publicRefFor(id));
  assert.notEqual(gym.publicRef, id);
  assert.equal(gym.area, 'Masaki, Dar es Salaam');
  assert.equal(gym.lat, -6.8);
  assert.equal(gym.lng, 39.28);
  assert.equal(gym.photos.length, 5, 'photos are capped');
  assert.deepEqual(gym.equipment, ['Treadmill']);
  assert.deepEqual(gym.amenities, ['Sauna']);
  assert.equal(gym.operatingHours.mon.open, '06:00');
  assert.deepEqual(gym.classes, [{ name: 'Yoga', schedule: 'Sat 09:00', priceTzs: 5000, location: 'Studio' }]);
  assert.equal(gym.directions, null);
  assert.deepEqual(membership.gymPlans.map(p => [p.plan, p.priceTzs]), [['daily', 8000], ['weekly', 40000], ['monthly', 120000]]);
  assert.equal(membership.currency, 'TZS');
  assert.ok(Array.isArray(membership.passTiers));
  for (const t of membership.passTiers) assert.ok(Number.isInteger(t.monthlyPriceTzs) && t.monthlyPriceTzs > 0, 'tiers are the Settings tiers that are sellable');
  assert.ok(!JSON.stringify(out.body).includes(id), 'the internal gym id is nowhere in the response');
});

test('no owner, KYC, bank, commission, member keys or internal ids', async () => {
  const id = await makeGym();
  const out = await resolve({ q: issueGymQr(id) });
  const keys = keysDeep(out.body);
  for (const k of FORBIDDEN_KEYS) assert.ok(!keys.has(k), `response must not carry ${k}`);
  const text = JSON.stringify(out.body);
  for (const s of SECRETS) assert.ok(!text.includes(s), `response must not carry ${s}`);
});

test('the payload is also accepted from an https URL with ?q=', async () => {
  const id = await makeGym();
  const url = `https://app.example.test/g?lang=sw&q=${encodeURIComponent(issueGymQr(id))}`;
  const out = await resolve({ q: url });
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.gym.publicRef, publicRefFor(id));
  assert.equal(extractQrPayload('http://x.test/?q=' + issueGymQr(id)), null, 'plain http is refused');
  assert.equal(extractQrPayload('javascript:alert(1)'), null);
  assert.equal(extractQrPayload('https://x.test/?q=' + 'a'.repeat(5000)), null);
  assert.equal(extractQrPayload({ toString: () => 'fitflex:gym:a:b' }), null);
});

test('bad signature, tampered id, unknown, inactive and malformed all give the identical 404', async () => {
  const id = await makeGym();
  const inactive = await makeGym({ status: 'inactive' });
  const other = await makeGym();
  const good = issueGymQr(id);
  const cases = [
    `${good.slice(0, -2)}xx`,
    good.replace(id, other),                                   // tampered gym id, signature of another gym
    issueGymQr('gym_does_not_exist'),
    issueGymQr(inactive),
    'fitflex:gym:', '', null, undefined, 42, { a: 1 }, 'hello', 'https://x.test/?q=nope',
  ];
  const outs = [];
  for (const q of cases) outs.push(await resolve({ q }));
  outs.push(await resolve(undefined));
  for (const o of outs) {
    assert.equal(o.statusCode, 404);
    assert.deepEqual(o.body, { error: 'not_found' });
  }
});

test('rate limit per address: 429 after the cap, other addresses unaffected', async () => {
  const id = await makeGym();
  for (let i = 0; i < WEB_GYM_PROFILE_RATE_PER_MINUTE; i += 1) assert.equal((await resolve({ q: issueGymQr(id) }, { ip: '198.51.100.9' })).statusCode, 200);
  const over = await resolve({ q: issueGymQr(id) }, { ip: '198.51.100.9' });
  assert.equal(over.statusCode, 429);
  assert.equal(over.body.error, 'rate_limited');
  assert.equal((await resolve({ q: issueGymQr(id) }, { ip: '198.51.100.10' })).statusCode, 200);
});

test('lang en|sw returns localized labels; unknown lang falls back to English', async () => {
  const id = await makeGym();
  const en = await resolve({ q: issueGymQr(id), lang: 'en' });
  const sw = await resolve({ q: issueGymQr(id), lang: 'sw' });
  const other = await resolve({ q: issueGymQr(id), lang: 'fr' });
  assert.equal(en.body.membership.gymPlans[0].label, 'Daily');
  assert.equal(sw.body.membership.gymPlans[0].label, 'Kila siku');
  assert.equal(sw.body.labels.hours, 'Saa za kufungua');
  assert.equal(sw.body.lang, 'sw');
  assert.equal(other.body.lang, 'en');
  assert.deepEqual(Object.keys(en.body.labels).sort(), Object.keys(sw.body.labels).sort());
});

test('regression: GET /gyms/:id and the member gym-QR scan route are unchanged', async () => {
  const id = await makeGym();
  const detail = await call(getGym, { params: { id } });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.body.id, id, 'GET /gyms/:id still carries the id');
  assert.ok(!('commissionRate' in detail.body));
  assert.equal(memberScanGymQr.method, 'post');
  assert.equal(memberScanGymQr.path, '/me/checkins/scan');
});
