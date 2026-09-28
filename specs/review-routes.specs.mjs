// Review routes against the CI database: a trainer reads the reviews on their
// own profile, the public sees first name + initial only, admins moderate
// under the 'social' scope, and gym owners read reviews for gyms they own.
// Guards run exactly as bfast-function chains them.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { users, trainers, gyms } from '../src/bootstrap/collections.mjs';
import {
  trainerOwnReviews, listTrainerReviews, adminListTrainerReviews, adminModerateTrainerReview, adminFlaggedTrainerReviews,
} from '../functions/trainer-reviews.mjs';
import { listGymReviews, operatorGymReviews, adminListGymReviews, adminModerateGymReview } from '../functions/gym-reviews.mjs';

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const now = () => new Date().toISOString();
const created = { users: [], trainers: [], gyms: [] };

async function makeUser(userType, extra = {}) {
  const id = uid('usr');
  await users.insertAsync({ id, userType, displayName: 'Review Route Tester', createdAt: now(), updatedAt: now(), ...extra });
  created.users.push(id);
  return id;
}

async function makeTrainer(userId = null) {
  await trainers.ready;
  const id = uid('trn');
  await trainers.insertAsync({ id, userId, displayName: 'Review Route Coach', createdAt: now() });
  created.trainers.push(id);
  return id;
}

async function makeGym() {
  await gyms.ready;
  const id = uid('gym');
  await gyms.insertAsync({ id, name: 'Review Route Gym', tier: 'standard', location: 'Dar es Salaam', status: 'active', createdAt: now() });
  created.gyms.push(id);
  return id;
}

const review = (table, subject, memberId, rating, status = 'published') =>
  db(table).insert({ id: uid('rev'), ...subject, memberId, rating, text: 'Solid session', status, createdAt: new Date(), updatedAt: new Date() });

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

after(async () => {
  if (created.trainers.length) {
    await db('TrainerReview').whereIn('trainerId', created.trainers).del();
    for (const id of created.trainers) await trainers.removeAsync(t => t.id === id);
    await db('TrainerProfile').whereIn('id', created.trainers).del();
  }
  if (created.gyms.length) {
    await db('GymReview').whereIn('gymId', created.gyms).del();
    for (const id of created.gyms) await gyms.removeAsync(g => g.id === id);
    await db('Gym').whereIn('id', created.gyms).del();
  }
  if (created.users.length) await db('User').whereIn('id', created.users).del();
  await db.destroy();
});

test('a trainer reads the reviews on their own profile, not their user id', async () => {
  const trainerUser = await makeUser('trainer');
  const trainerId = await makeTrainer(trainerUser);
  assert.notEqual(trainerId, trainerUser);
  await review('TrainerReview', { trainerId }, await makeUser('member'), 4);

  const out = await call(trainerOwnReviews, { claims: { sub: trainerUser, userType: 'trainer' } });
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.trainerId, trainerId);
  assert.equal(out.body.summary.reviewCount, 1);
  assert.equal(out.body.reviews.length, 1);

  const noProfile = await call(trainerOwnReviews, { claims: { sub: await makeUser('trainer'), userType: 'trainer' } });
  assert.deepEqual([noProfile.statusCode, noProfile.body], [404, { error: 'trainer_profile_not_found' }]);
});

test('public review lists show first name + initial and no member id', async () => {
  const trainerId = await makeTrainer();
  const gymId = await makeGym();
  const memberId = await makeUser('member', { displayName: 'Aisha Mwakasege' });
  await review('TrainerReview', { trainerId }, memberId, 5);
  await review('GymReview', { gymId }, memberId, 3);
  await review('GymReview', { gymId }, await makeUser('member'), 1, 'hidden');

  for (const [route, id] of [[listTrainerReviews, trainerId], [listGymReviews, gymId]]) {
    const out = await call(route, { params: { id } });
    assert.equal(out.statusCode, 200);
    assert.equal(out.body.length, 1, 'hidden reviews stay out of the public list');
    assert.equal(out.body[0].memberName, 'Aisha M.');
    for (const key of ['memberId', 'status', 'moderatedBy']) assert.equal(key in out.body[0], false, key);
  }
});

test('admins list and moderate reviews under the social scope', async () => {
  const trainerId = await makeTrainer();
  const gymId = await makeGym();
  const memberId = await makeUser('member');
  await review('TrainerReview', { trainerId }, memberId, 2);
  await review('GymReview', { gymId }, memberId, 5);
  const superAdmin = { sub: await makeUser('admin'), userType: 'admin' };

  const all = await call(adminListTrainerReviews, { claims: superAdmin });
  const mine = all.body.find(r => r.trainerId === trainerId);
  assert.equal(mine.trainerName, 'Review Route Coach');
  assert.equal(mine.memberName, 'Review Route Tester');

  const hide = await call(adminModerateTrainerReview, { claims: superAdmin, params: { id: mine.id }, body: { action: 'hide' } });
  assert.equal(hide.statusCode, 200);
  const hidden = await call(adminListTrainerReviews, { claims: superAdmin, query: { status: 'hidden' } });
  assert.ok(hidden.body.some(r => r.id === mine.id));
  assert.ok(hidden.body.every(r => r.status === 'hidden'));
  assert.equal((await trainers.findByIdAsync(trainerId)).reviewCount, 0);

  const gymList = await call(adminListGymReviews, { claims: superAdmin });
  assert.equal(gymList.body.find(r => r.gymId === gymId)?.gymName, 'Review Route Gym');

  const bad = await call(adminListGymReviews, { claims: superAdmin, query: { status: 'deleted' } });
  assert.deepEqual([bad.statusCode, bad.body], [400, { error: 'invalid_status' }]);

  // Portal staff need 'social'; the old trainers/gyms scopes no longer grant moderation.
  const oldScopes = { sub: 'staff', userType: 'admin', portalUser: true, aclPermissions: ['trainers', 'gyms'] };
  const moderator = { sub: 'staff', userType: 'admin', portalUser: true, aclPermissions: ['social'] };
  for (const route of [adminListTrainerReviews, adminFlaggedTrainerReviews, adminListGymReviews]) {
    assert.equal((await call(route, { claims: oldScopes })).statusCode, 403);
  }
  assert.equal((await call(adminModerateGymReview, { claims: oldScopes, params: { id: 'x' }, body: { action: 'hide' } })).statusCode, 403);
  assert.equal((await call(adminListGymReviews, { claims: moderator })).statusCode, 200);
  assert.equal((await call(adminListTrainerReviews, { claims: { sub: memberId, userType: 'member' } })).statusCode, 403);
});

test('gym owners read reviews only for gyms they own, choosing one when they have several', async () => {
  const [gymA, gymB, otherGym] = [await makeGym(), await makeGym(), await makeGym()];
  await review('GymReview', { gymId: gymB }, await makeUser('member'), 4);
  const owner = { sub: await makeUser('gym_operator', { gymId: gymA, gymIds: [gymA, gymB] }), userType: 'gym_operator' };

  const unchosen = await call(operatorGymReviews, { claims: owner });
  assert.deepEqual([unchosen.statusCode, unchosen.body.error], [400, 'gym_required']);
  assert.deepEqual(unchosen.body.gymIds.sort(), [gymA, gymB].sort());

  const notMine = await call(operatorGymReviews, { claims: owner, query: { gymId: otherGym } });
  assert.deepEqual([notMine.statusCode, notMine.body.error], [403, 'not_your_gym']);

  const chosen = await call(operatorGymReviews, { claims: owner, query: { gymId: gymB } });
  assert.equal(chosen.statusCode, 200);
  assert.equal(chosen.body.gymId, gymB);
  assert.equal(chosen.body.summary.reviewCount, 1);
  assert.equal(chosen.body.reviews.length, 1);

  const singleGymOwner = { sub: await makeUser('gym_operator', { gymId: otherGym, gymIds: [otherGym] }), userType: 'gym_operator' };
  assert.equal((await call(operatorGymReviews, { claims: singleGymOwner })).body.gymId, otherGym);

  const staffWithout = { sub: await makeUser('gym_staff', { gymIds: [gymA] }), userType: 'gym_staff', aclPermissions: ['checkins'] };
  assert.equal((await call(operatorGymReviews, { claims: staffWithout, query: { gymId: gymA } })).statusCode, 403);
  const staffWith = { sub: await makeUser('gym_staff', { gymIds: [gymA] }), userType: 'gym_staff', aclPermissions: ['gyms'] };
  assert.equal((await call(operatorGymReviews, { claims: staffWith, query: { gymId: gymA } })).statusCode, 200);
});
