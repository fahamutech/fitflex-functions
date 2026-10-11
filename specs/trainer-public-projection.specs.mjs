// The open trainer endpoints (GET /trainers, GET /trainers/:id and
// GET /discover/trainers) against the CI database: they show what a member
// needs and nothing private — no email, phone, account id, pending gym
// applications or listing controls, and no gym business details. The trainer
// still reads their own full profile from GET /trainer/me, including a profile
// the admin created for their email before they had an account.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { users, trainers, gyms } from '../src/bootstrap/collections.mjs';
import { listTrainers, getTrainer, trainerMyProfile } from '../functions/trainers.mjs';
import { discoverTrainers } from '../functions/discover.mjs';
import { publicTrainer } from '../src/services/trainer-service.mjs';

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const now = () => new Date().toISOString();
const created = { users: [], trainers: [], gyms: [] };

const PRIVATE = ['email', 'phone', 'userId', 'pendingGymIds', 'pendingGyms', 'approvalStatus', 'homepageVisible', 'homepagePriority', 'regionId', 'cityId'];
const PRIVATE_GYM = ['commissionRate', 'paymentBank', 'paymentNumber', 'paymentNotes', 'tinNumber'];
const NEEDED = ['id', 'displayName', 'photoUrl', 'images', 'imageThumbnails', 'specialties', 'bio', 'rating', 'reviewCount',
  'hourlyRateTzs', 'sessionRateCurrency', 'experienceYears', 'gymIds', 'gyms', 'status', 'verified', 'availability', 'socialLinks', 'bookable'];

async function makeUser(userType, extra = {}) {
  const id = uid('usr');
  await users.insertAsync({ id, userType, displayName: 'Projection Tester', createdAt: now(), updatedAt: now(), ...extra });
  created.users.push(id);
  return id;
}

async function makeGym() {
  await gyms.ready;
  const id = uid('gym');
  await gyms.insertAsync({
    id, name: 'Projection Gym', tier: 'standard', location: 'Dar es Salaam', status: 'active', createdAt: now(),
    commissionRate: 12, paymentBank: 'Secret Bank', paymentNumber: '0100200300', paymentNotes: 'private', tinNumber: '123-456-789',
  });
  created.gyms.push(id);
  return id;
}

async function makeTrainer(extra = {}) {
  await trainers.ready;
  const id = uid('trn');
  await trainers.insertAsync({
    id, userId: null, displayName: `Projection Coach ${id}`, email: `${id}@private.test`, phone: '+255700000001',
    photoUrl: 'https://img.test/p.jpg', images: ['https://img.test/p.jpg'], imageThumbnails: ['https://img.test/t.jpg'],
    specialties: ['Boxing'], bio: 'Bio', rating: 4.5, reviewCount: 2, hourlyRateTzs: 30000, sessionRateCurrency: 'TZS',
    experienceYears: 3, gymIds: [], pendingGymIds: [], status: 'active', approvalStatus: 'approved', verified: true,
    homepageVisible: true, homepagePriority: 7, availability: [], socialLinks: { instagram: 'coach' },
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

function assertPublic(card, label) {
  for (const k of PRIVATE) assert.ok(!(k in card), `${label} must not carry ${k}`);
  for (const k of NEEDED) assert.ok(k in card, `${label} must still carry ${k}`);
  for (const g of card.gyms) for (const k of PRIVATE_GYM) assert.ok(!(k in g), `${label} gym must not carry ${k}`);
}

after(async () => {
  for (const id of created.trainers) await trainers.removeAsync(t => t.id === id);
  if (created.trainers.length) await db('TrainerProfile').whereIn('id', created.trainers).del();
  for (const id of created.gyms) await gyms.removeAsync(g => g.id === id);
  if (created.gyms.length) await db('Gym').whereIn('id', created.gyms).del();
  if (created.users.length) await db('User').whereIn('id', created.users).del();
  await db.destroy();
});

test('the public trainer list, detail and discovery carry no private fields', async () => {
  const gymId = await makeGym();
  const pendingGymId = await makeGym();
  const userId = await makeUser('trainer');
  const trainerId = await makeTrainer({ userId, gymIds: [gymId], pendingGymIds: [pendingGymId] });

  const list = await call(listTrainers);
  assert.equal(list.statusCode, 200);
  const card = list.body.find(t => t.id === trainerId);
  assert.ok(card, 'the trainer is listed');
  for (const t of list.body) assertPublic(t, 'list card');
  assert.equal(card.gyms.length, 1);
  assert.equal(card.gyms[0].id, gymId);
  assert.equal(card.gyms[0].name, 'Projection Gym');
  assert.equal(card.hourlyRateTzs, 30000);
  assert.deepEqual(card.socialLinks, { instagram: 'coach' });

  const detail = await call(getTrainer, { params: { id: trainerId } });
  assert.equal(detail.statusCode, 200);
  assertPublic(detail.body, 'detail');
  assert.equal(detail.body.displayName, card.displayName);

  const found = await call(discoverTrainers, { query: { q: trainerId, limit: '50' } });
  assert.equal(found.statusCode, 200);
  const cards = [...found.body.items, ...found.body.featured];
  assert.ok(cards.some(t => t.id === trainerId), 'discovery finds the trainer');
  for (const t of cards) assertPublic(t, 'discovery card');

  const raw = JSON.stringify([list.body, detail.body, found.body]);
  for (const secret of [`${trainerId}@private.test`, '+255700000001', userId, pendingGymId, 'Secret Bank', '0100200300', '123-456-789']) {
    assert.ok(!raw.includes(secret), `public payloads must not contain ${secret}`);
  }
});

test('a new stored column stays private until it is listed as public', () => {
  const out = publicTrainer({ id: 't1', displayName: 'A', nationalId: 'X', email: 'a@b.c', gyms: [{ id: 'g1', tinNumber: '1' }] });
  assert.deepEqual(out, { id: 't1', displayName: 'A', gyms: [{ id: 'g1' }] });
  assert.equal(publicTrainer(null), null);
});

test('a trainer still reads their own full profile', async () => {
  const pendingGymId = await makeGym();
  const userId = await makeUser('trainer');
  const trainerId = await makeTrainer({ userId, pendingGymIds: [pendingGymId] });

  const me = await call(trainerMyProfile, { claims: { sub: userId, userType: 'trainer' } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.body.id, trainerId);
  assert.equal(me.body.email, `${trainerId}@private.test`);
  assert.equal(me.body.phone, '+255700000001');
  assert.deepEqual(me.body.pendingGyms.map(g => g.id), [pendingGymId]);
});

test('a trainer finds the profile the admin made for their email, without the public list', async () => {
  const email = `${uid('coach')}@claim.test`;
  const trainerId = await makeTrainer({ email });                       // no account yet
  const userId = await makeUser('trainer', { email: email.toUpperCase() });

  const me = await call(trainerMyProfile, { claims: { sub: userId, userType: 'trainer' } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.body.id, trainerId);

  // Someone else's linked profile is never matched by email.
  const otherEmail = `${uid('coach')}@claim.test`;
  await makeTrainer({ email: otherEmail, userId: await makeUser('trainer') });
  const stranger = await call(trainerMyProfile, { claims: { sub: await makeUser('trainer', { email: otherEmail }), userType: 'trainer' } });
  assert.deepEqual([stranger.statusCode, stranger.body], [404, { error: 'trainer_profile_not_found' }]);

  // No email on the account must not match a profile with no email.
  await makeTrainer({ email: null });
  const noEmail = await call(trainerMyProfile, { claims: { sub: await makeUser('trainer'), userType: 'trainer' } });
  assert.equal(noEmail.statusCode, 404);
});
