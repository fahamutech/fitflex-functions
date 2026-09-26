// Review ratings against the CI database: submitting or moderating a review
// must persist the rolling average + reviewCount onto TrainerProfile / Gym
// through the real collections. `trainers` and `gyms` are primed collections,
// which expose updateAsync(pred, patch) and not updateByIdAsync — the in-memory
// fakes in trainer-reviews / gym-reviews specs can't catch that.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import {
  users, gyms, trainers, trainerBookings, trainerReviews, gymReviews, checkins, subscriptions,
} from '../src/bootstrap/collections.mjs';
import { createTrainerReviewService } from '../src/services/trainer-review-service.mjs';
import { createGymReviewService } from '../src/services/gym-review-service.mjs';

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const now = () => new Date().toISOString();
const created = { users: [], gyms: [], trainers: [] };
const auditLog = { insert: () => {} };

async function makeUser(userType = 'member') {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: 'Rating Test', updatedAt: new Date() });
  created.users.push(id);
  return id;
}

async function makeGym() {
  await gyms.ready;
  const id = uid('gym');
  await gyms.insertAsync({ id, name: 'Rating Test Gym', tier: 'standard', location: 'Dar es Salaam', createdAt: now() });
  created.gyms.push(id);
  return id;
}

async function makeTrainer() {
  await trainers.ready;
  const id = uid('trn');
  await trainers.insertAsync({ id, displayName: 'Rating Test Coach', rating: 0, reviewCount: 0, createdAt: now() });
  created.trainers.push(id);
  return id;
}

async function stored(table, id) {
  const row = await db(table).where({ id }).first('rating', 'reviewCount');
  return { rating: Number(row.rating), reviewCount: row.reviewCount };
}

after(async () => {
  // TrainerReview / GymReview have no FKs; bookings and check-ins cascade.
  if (created.trainers.length) {
    await db('TrainerReview').whereIn('trainerId', created.trainers).del();
    for (const id of created.trainers) await trainers.removeAsync(t => t.id === id);
  }
  if (created.gyms.length) {
    await db('GymReview').whereIn('gymId', created.gyms).del();
    for (const id of created.gyms) await gyms.removeAsync(g => g.id === id);
  }
  if (created.users.length) await db('User').whereIn('id', created.users).del();
  await db.destroy();
});

test('trainer review submit + moderation persist rating and reviewCount on TrainerProfile', async () => {
  const svc = createTrainerReviewService({ trainerReviews, trainers, trainerBookings, users, auditLog });
  const [trainerId, gymId, m1, m2] = [await makeTrainer(), await makeGym(), await makeUser(), await makeUser()];
  for (const memberId of [m1, m2]) {
    await trainerBookings.insertAsync({
      id: uid('tbk'), memberId, trainerId, gymId, date: '2026-09-20', slot: '07:00', amountTzs: 20000,
      status: 'completed', createdAt: now(), updatedAt: now(),
    });
  }

  const first = await svc.submit({ memberId: m1, trainerId, rating: 5, text: 'Great session' });
  assert.ok(!first.error, first.error);
  assert.deepEqual(await stored('TrainerProfile', trainerId), { rating: 5, reviewCount: 1 });

  const second = await svc.submit({ memberId: m2, trainerId, rating: 2 });
  assert.ok(!second.error, second.error);
  assert.deepEqual(await stored('TrainerProfile', trainerId), { rating: 3.5, reviewCount: 2 });
  assert.equal((await trainers.findByIdAsync(trainerId)).rating, 3.5);

  const hidden = await svc.moderate({ reviewId: second.review.id, action: 'hide', adminId: 'admin_test' });
  assert.ok(!hidden.error, hidden.error);
  assert.deepEqual(await stored('TrainerProfile', trainerId), { rating: 5, reviewCount: 1 });
});

test('gym review submit + moderation persist rating and reviewCount on Gym', async () => {
  const svc = createGymReviewService({ gymReviews, gyms, checkins, subscriptions, users, auditLog });
  const [gymId, m1, m2] = [await makeGym(), await makeUser(), await makeUser()];
  for (const memberId of [m1, m2]) {
    await db('Checkin').insert({
      id: uid('chk'), memberId, gymId, timestamp: new Date(), method: 'qr', subscriptionType: 'credits', gymTier: 'standard', visitConsumed: true,
    });
  }

  const first = await svc.submit({ memberId: m1, gymId, rating: 4 });
  assert.ok(!first.error, first.error);
  assert.deepEqual(await stored('Gym', gymId), { rating: 4, reviewCount: 1 });

  const second = await svc.submit({ memberId: m2, gymId, rating: 1 });
  assert.ok(!second.error, second.error);
  assert.deepEqual(await stored('Gym', gymId), { rating: 2.5, reviewCount: 2 });

  const flagged = await svc.moderate({ reviewId: second.review.id, action: 'flag', adminId: 'admin_test' });
  assert.ok(!flagged.error, flagged.error);
  assert.deepEqual(await stored('Gym', gymId), { rating: 4, reviewCount: 1 });
});
