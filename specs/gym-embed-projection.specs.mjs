// Gyms embedded in what members and trainers read (the trainer's gym list,
// check-in history, trainer bookings, a trainer's day and their own profile)
// against the CI database: each carries the public gym and nothing private —
// no commission rate, payout details, TIN or listing controls. Trainers still
// see trainer-pass pricing; members never do.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { users, gyms, trainers, checkins, trainerBookings, trainerSessions } from '../src/bootstrap/collections.mjs';
import { trainerGyms } from '../functions/trainer-passes.mjs';
import { memberCheckIns } from '../functions/subscriptions.mjs';
import { trainerMyBookings, memberMyBookings } from '../functions/trainer-bookings.mjs';
import { trainerSessionsForDate } from '../functions/trainer-engagements.mjs';
import { trainerMyProfile } from '../functions/trainers.mjs';

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const now = () => new Date().toISOString();
const created = { users: [], gyms: [], trainers: [], checkins: [], bookings: [], sessions: [] };

const PRIVATE = ['commissionRate', 'paymentBank', 'paymentNumber', 'paymentNotes', 'tinNumber', 'homepageVisible', 'homepagePriority'];
const SECRETS = ['Secret Bank', '0100200300', 'pay by Friday', '123-456-789'];
const DAY = '2031-03-04';

async function makeGym() {
  await gyms.ready;
  const id = uid('gym');
  await gyms.insertAsync({
    id, name: `Embed Gym ${id}`, tier: 'standard', location: 'Dar es Salaam', status: 'active',
    venueType: 'physical', accessMode: 'paid_visit', coordinates: { lat: -6.8, lng: 39.28 },
    perVisitRate: 8000, ratePerDay: 8000, ratePerWeek: 40000, ratePerMonth: 120000,
    images: ['https://img.test/g.jpg'], thumbnails: ['https://img.test/t.jpg'], operatingHours: { mon: '06:00-22:00' },
    amenities: ['Sauna'], equipment: ['Treadmill'], classes: [],
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
  await users.insertAsync({ id, userType, displayName: 'Embed Tester', createdAt: now(), updatedAt: now(), ...extra });
  created.users.push(id);
  return id;
}

async function makeTrainer(userId, extra = {}) {
  await trainers.ready;
  const id = uid('trn');
  await trainers.insertAsync({
    id, userId, displayName: `Embed Coach ${id}`, specialties: ['Boxing'], bio: 'Bio', hourlyRateTzs: 30000,
    gymIds: [], pendingGymIds: [], status: 'active', approvalStatus: 'approved', availability: [], socialLinks: {},
    createdAt: now(), updatedAt: now(), ...extra,
  });
  created.trainers.push(id);
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

/** The embedded gym is the public one: named, and with nothing private anywhere in it. */
function assertPublic(gym, gymId, label) {
  assert.ok(gym, `${label} carries the gym`);
  assert.equal(gym.id, gymId, `${label} is the right gym`);
  assert.ok(gym.name && gym.location, `${label} still carries the name and location`);
  for (const k of PRIVATE) assert.ok(!(k in gym), `${label} must not carry ${k}`);
  const raw = JSON.stringify(gym);
  for (const secret of SECRETS) assert.ok(!raw.includes(secret), `${label} must not contain ${secret}`);
}

after(async () => {
  for (const id of created.checkins) await checkins.removeAsync(c => c.id === id);
  for (const id of created.bookings) await trainerBookings.removeAsync(b => b.id === id);
  for (const id of created.sessions) await trainerSessions.removeAsync(s => s.id === id);
  for (const id of created.trainers) await trainers.removeAsync(t => t.id === id);
  for (const id of created.gyms) await gyms.removeAsync(g => g.id === id);
  if (created.users.length) await db('User').whereIn('id', created.users).del();
  await db.destroy();
});

test("a trainer's gym list shows the public gym with trainer-pass pricing and how they get in, nothing private", async () => {
  const gymId = await makeGym();
  const userId = await makeUser('trainer');
  await makeTrainer(userId);

  const out = await call(trainerGyms, { claims: { sub: userId, userType: 'trainer' } });
  assert.equal(out.statusCode, 200);
  for (const g of out.body) for (const k of PRIVATE) assert.ok(!(k in g), `trainer gym row must not carry ${k}`);
  const row = out.body.find(g => g.id === gymId);
  assertPublic(row, gymId, 'trainer gym row');
  assert.equal(row.trainerPass.options.monthly, 50000, 'the trainer still sees trainer-pass pricing');
  assert.equal(row.trainerAccess.access, 'trainer_pass');
  assert.deepEqual(row.trainerAccess.options.map(o => o.feeTzs), [50000]);
  assert.equal(row.currentPass, null);
  assert.deepEqual(row.coordinates, { lat: -6.8, lng: 39.28 });
  assert.deepEqual(row.images, ['https://img.test/g.jpg']);
  assert.ok('profileComplete' in row && 'verified' in row, 'the badges are still there');
});

test("a member's check-in history embeds the public gym, without trainer-pass pricing", async () => {
  const gymId = await makeGym();
  const memberId = await makeUser('member');
  const id = uid('chk');
  await checkins.insertAsync({ id, memberId, gymId, gymTier: 'standard', subscriptionType: 'platform_pass', method: 'qr', timestamp: now(), visitConsumed: false });
  created.checkins.push(id);

  const out = await call(memberCheckIns, { claims: { sub: memberId, userType: 'member' } });
  assert.equal(out.statusCode, 200);
  const row = out.body.find(c => c.id === id);
  assert.ok(row, 'the check-in is listed');
  assertPublic(row.gym, gymId, 'check-in gym');
  assert.ok(!('trainerPass' in row.gym), 'members never see trainer-pass pricing');
  assert.equal(row.gym.ratePerMonth, 120000);
});

test('trainer bookings and a trainer day embed the public gym for both the member and the trainer', async () => {
  const gymId = await makeGym();
  const memberId = await makeUser('member');
  const trainerUserId = await makeUser('trainer');
  const trainerId = await makeTrainer(trainerUserId, { gymIds: [gymId] });

  const bookingId = uid('tbk');
  await trainerBookings.insertAsync({
    id: bookingId, groupId: bookingId, memberId, trainerId, gymId, date: DAY, slot: '09:00',
    status: 'confirmed', amountTzs: 30000, createdAt: now(), updatedAt: now(),
  });
  created.bookings.push(bookingId);
  const sessionId = uid('tsn');
  await trainerSessions.insertAsync({
    id: sessionId, trainerId, gymId, customerName: 'Walk-in', locationType: 'my_gym', date: DAY, slot: '11:00',
    source: 'manual', status: 'scheduled', amountTzs: 20000, createdAt: now(),
  });
  created.sessions.push(sessionId);

  const mine = await call(memberMyBookings, { claims: { sub: memberId, userType: 'member' } });
  assert.equal(mine.statusCode, 200);
  const memberRow = mine.body.find(b => b.id === bookingId);
  assert.ok(memberRow, 'the member sees the booking');
  assertPublic(memberRow.gym, gymId, 'member booking gym');
  assert.ok(!('trainerPass' in memberRow.gym), 'members never see trainer-pass pricing');
  for (const g of memberRow.trainer.gyms) assertPublic(g, gymId, "member booking trainer's gym");

  const trainerClaims = { sub: trainerUserId, userType: 'trainer' };
  const theirs = await call(trainerMyBookings, { claims: trainerClaims });
  assert.equal(theirs.statusCode, 200);
  const trainerRow = theirs.body.find(b => b.id === bookingId);
  assert.ok(trainerRow, 'the trainer sees the booking');
  assertPublic(trainerRow.gym, gymId, 'trainer booking gym');

  const day = await call(trainerSessionsForDate, { claims: trainerClaims, query: { date: DAY } });
  assert.equal(day.statusCode, 200);
  assert.deepEqual(day.body.sessions.map(s => s.id), [bookingId, sessionId]);
  for (const s of day.body.sessions) assertPublic(s.gym, gymId, `trainer day ${s.source} gym`);

  const me = await call(trainerMyProfile, { claims: trainerClaims });
  assert.equal(me.statusCode, 200);
  assert.equal(me.body.gyms.length, 1);
  assertPublic(me.body.gyms[0], gymId, "trainer profile's linked gym");
  assert.equal(me.body.gyms[0].thumbnail, 'https://img.test/t.jpg');
});
