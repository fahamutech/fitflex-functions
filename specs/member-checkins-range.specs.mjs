// GET /me/checkins with an optional date range, against the CI database.
// Without from/to the route keeps returning the newest 50 (older app builds);
// with from and/or to it returns every own check-in with from <= timestamp < to,
// newest first, with the same row shape (public gym, no trainer-pass pricing).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { users, gyms, checkins } from '../src/bootstrap/collections.mjs';
import { memberCheckIns } from '../functions/subscriptions.mjs';
import { CHECKIN_RANGE_MAX_ROWS } from '../src/services/subscription-service.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const iso = (ms) => new Date(ms).toISOString();
const created = { users: [], gyms: [], checkins: [] };

async function makeGym() {
  await gyms.ready;
  const id = uid('gym');
  const at = new Date().toISOString();
  await gyms.insertAsync({
    id, name: `Range Gym ${id}`, tier: 'standard', location: 'Dar es Salaam', status: 'active',
    venueType: 'physical', accessMode: 'paid_visit', coordinates: { lat: -6.8, lng: 39.28 },
    perVisitRate: 8000, ratePerDay: 8000, ratePerWeek: 40000, ratePerMonth: 120000,
    images: [], thumbnails: [], operatingHours: {}, amenities: [], equipment: [], classes: [],
    trainerPass: { enabled: true, options: { monthly: 50000 }, feeTzs: 50000, period: 'monthly' },
    verified: false, commissionRate: 17, paymentBank: 'Secret Bank', paymentNumber: '0100200300',
    createdAt: at, updatedAt: at,
  });
  created.gyms.push(id);
  return id;
}

async function makeMember() {
  const id = uid('usr');
  const at = new Date().toISOString();
  await users.insertAsync({ id, userType: 'member', displayName: 'Range Tester', createdAt: at, updatedAt: at });
  created.users.push(id);
  return id;
}

async function addCheckIn(memberId, gymId, timestamp) {
  await checkins.ready;
  const id = uid('chk');
  await checkins.insertAsync({ id, memberId, gymId, gymTier: 'standard', subscriptionType: 'platform_pass', method: 'qr', timestamp, visitConsumed: false });
  created.checkins.push(id);
  return id;
}

function res() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

/** Run the route's guards, then its handler if every guard passes. */
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

const asMember = (memberId, query) => call(memberCheckIns, { claims: { sub: memberId, userType: 'member' }, query });
const ids = (rows) => rows.map(r => r.id);

after(async () => {
  if (created.checkins.length) await db('Checkin').whereIn('id', created.checkins).del();
  for (const id of created.gyms) await gyms.removeAsync(g => g.id === id);
  if (created.users.length) await db('User').whereIn('id', created.users).del();
  await db.destroy();
});

test('no from/to: still the newest 50, newest first (older app builds unaffected)', async () => {
  const gymId = await makeGym();
  const memberId = await makeMember();
  const base = Date.now() - DAY_MS;
  const all = [];
  for (let i = 0; i < 55; i++) all.push(await addCheckIn(memberId, gymId, iso(base - i * 60_000)));

  const out = await asMember(memberId);
  assert.equal(out.statusCode, 200);
  assert.ok(Array.isArray(out.body), 'the default response is still a plain array');
  assert.equal(out.body.length, 50);
  assert.deepEqual(ids(out.body), all.slice(0, 50), 'the newest 50, newest first');

  const empty = await asMember(memberId, { from: '', to: '' });
  assert.equal(empty.statusCode, 200);
  assert.equal(empty.body.length, 50, 'empty params count as absent');

  const ranged = await asMember(memberId, { from: iso(base - 2 * DAY_MS), to: iso(base + 1) });
  assert.equal(ranged.statusCode, 200);
  assert.equal(ranged.body.length, 55, 'a date range is not limited to 50');
  assert.deepEqual(ids(ranged.body), all);
});

test('from is inclusive, to is exclusive; rows keep the public gym shape', async () => {
  const gymId = await makeGym();
  const memberId = await makeMember();
  const from = Date.parse('2030-02-01T00:00:00.000Z');
  const to = Date.parse('2030-03-01T00:00:00.000Z');
  const beforeFrom = await addCheckIn(memberId, gymId, iso(from - 1));
  const atFrom = await addCheckIn(memberId, gymId, iso(from));
  const middle = await addCheckIn(memberId, gymId, iso(from + 10 * DAY_MS));
  const justBeforeTo = await addCheckIn(memberId, gymId, iso(to - 1));
  const atTo = await addCheckIn(memberId, gymId, iso(to));

  const out = await asMember(memberId, { from: iso(from), to: iso(to) });
  assert.equal(out.statusCode, 200);
  assert.deepEqual(ids(out.body), [justBeforeTo, middle, atFrom]);
  assert.ok(!ids(out.body).includes(beforeFrom) && !ids(out.body).includes(atTo));

  const row = out.body[0];
  assert.equal(row.memberId, memberId);
  assert.equal(row.gymId, gymId);
  assert.equal(row.gym.id, gymId);
  assert.equal(row.gym.ratePerMonth, 120000);
  assert.ok(!('trainerPass' in row.gym), 'members never see trainer-pass pricing');
  for (const k of ['commissionRate', 'paymentBank', 'paymentNumber']) assert.ok(!(k in row.gym), `gym must not carry ${k}`);
});

test('only from: to defaults to now', async () => {
  const gymId = await makeGym();
  const memberId = await makeMember();
  const now = Date.now();
  const tooOld = await addCheckIn(memberId, gymId, iso(now - 20 * DAY_MS));
  const recent = await addCheckIn(memberId, gymId, iso(now - 5 * DAY_MS));
  const future = await addCheckIn(memberId, gymId, iso(now + DAY_MS));

  const out = await asMember(memberId, { from: iso(now - 10 * DAY_MS) });
  assert.equal(out.statusCode, 200);
  assert.deepEqual(ids(out.body), [recent]);
  assert.ok(!ids(out.body).includes(tooOld) && !ids(out.body).includes(future));
});

test('only to: from defaults to 90 days before to', async () => {
  const gymId = await makeGym();
  const memberId = await makeMember();
  const to = Date.parse('2030-06-01T00:00:00.000Z');
  const outside = await addCheckIn(memberId, gymId, iso(to - 91 * DAY_MS));
  const atStart = await addCheckIn(memberId, gymId, iso(to - 90 * DAY_MS));
  const inside = await addCheckIn(memberId, gymId, iso(to - 89 * DAY_MS));
  const atTo = await addCheckIn(memberId, gymId, iso(to));

  const out = await asMember(memberId, { to: iso(to) });
  assert.equal(out.statusCode, 200);
  assert.deepEqual(ids(out.body), [inside, atStart]);
  assert.ok(!ids(out.body).includes(outside) && !ids(out.body).includes(atTo));
});

test('unparseable dates are 400 invalid_date', async () => {
  const memberId = await makeMember();
  for (const query of [{ from: 'not-a-date' }, { to: 'yesterday-ish' }, { from: '2030-01-01T00:00:00Z', to: '2030-13-45' }, { from: ['2030-01-01', '2030-02-01'] }]) {
    const out = await asMember(memberId, query);
    assert.equal(out.statusCode, 400, JSON.stringify(query));
    assert.deepEqual(out.body, { error: 'invalid_date' });
  }
});

test('from after to is 400 invalid_range', async () => {
  const memberId = await makeMember();
  const out = await asMember(memberId, { from: '2030-03-01T00:00:00Z', to: '2030-02-01T00:00:00Z' });
  assert.equal(out.statusCode, 400);
  assert.deepEqual(out.body, { error: 'invalid_range' });
});

test('a window longer than 366 days is 400 range_too_long; exactly 366 days is allowed', async () => {
  const memberId = await makeMember();
  const from = Date.parse('2030-01-01T00:00:00.000Z');
  const tooLong = await asMember(memberId, { from: iso(from), to: iso(from + 366 * DAY_MS + 1) });
  assert.equal(tooLong.statusCode, 400);
  assert.deepEqual(tooLong.body, { error: 'range_too_long' });

  const ok = await asMember(memberId, { from: iso(from), to: iso(from + 366 * DAY_MS) });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.body, []);
});

test("another member's check-ins are never returned, with or without a range", async () => {
  const gymId = await makeGym();
  const me = await makeMember();
  const other = await makeMember();
  const at = Date.parse('2030-04-10T08:00:00.000Z');
  const mine = await addCheckIn(me, gymId, iso(at));
  const theirs = await addCheckIn(other, gymId, iso(at));
  const theirsRecent = await addCheckIn(other, gymId, iso(Date.now() - DAY_MS));

  const ranged = await asMember(me, { from: '2030-04-01T00:00:00Z', to: '2030-05-01T00:00:00Z' });
  assert.equal(ranged.statusCode, 200);
  assert.deepEqual(ids(ranged.body), [mine]);
  assert.ok(ranged.body.every(r => r.memberId === me));

  const plain = await asMember(me);
  assert.ok(!ids(plain.body).includes(theirs) && !ids(plain.body).includes(theirsRecent));
  assert.ok(plain.body.every(r => r.memberId === me));
});

test('non-members cannot read /me/checkins', async () => {
  const out = await call(memberCheckIns, { claims: { sub: uid('usr'), userType: 'gym_operator' }, query: { from: '2030-01-01T00:00:00Z' } });
  assert.notEqual(out.statusCode, 200);
  assert.equal(out.body?.length, undefined);
});

test('the defensive row cap is documented as 1000', () => {
  assert.equal(CHECKIN_RANGE_MAX_ROWS, 1000);
});
