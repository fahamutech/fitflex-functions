import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { listTrainers, getTrainer } from '../functions/trainers.mjs';
import { adminUpsertTrainer } from '../functions/trainers.mjs';
import { adminUpsertGym } from '../functions/gyms.mjs';
import { updateMemberProfile, memberCheckIns } from '../functions/subscriptions.mjs';
import { createTrainerBooking } from '../functions/trainer-bookings.mjs';

function res() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('member can save onboarding goals and personal preferences', async () => {
  const out = res();
  await updateMemberProfile.onRequest({
    user: { sub: `usr_profile_${Date.now()}`, userType: 'member' },
    body: {
      displayName: 'Zawadi Mwangi',
      fitnessGoal: 'gain_muscle',
      fitnessLevel: 'beginner',
      preferredWorkoutTimes: ['early_morning', 'evening'],
      notificationPreferences: { checkinReminders: true }
    }
  }, out);

  assert.equal(out.statusCode, 200);
  assert.equal(out.body.user.displayName, 'Zawadi Mwangi');
  assert.equal(out.body.user.onboardingCompleted, true);
  assert.deepEqual(out.body.user.memberProfile.preferredWorkoutTimes, ['early_morning', 'evening']);
});

test('non-member can save basic profile details without member-only guard', async () => {
  const phone = `+25570011${String(Date.now()).slice(-4)}`;
  const out = res();
  await updateMemberProfile.onRequest({
    user: { sub: `usr_owner_profile_${Date.now()}`, userType: 'gym_operator' },
    body: {
      displayName: 'Gym Owner',
      phone
    }
  }, out);

  assert.equal(out.statusCode, 200);
  assert.equal(out.body.user.userType, 'gym_operator');
  assert.equal(out.body.user.displayName, 'Gym Owner');
  assert.equal(out.body.user.phone, phone);
  assert.equal(out.body.user.onboardingCompleted, undefined);
});

test('member trainer discovery supports list, detail, and booking branch', async () => {
  const suffix = randomUUID();
  const gym = res();
  await adminUpsertGym.onRequest({
    user: { sub: 'usr_admin_1', userType: 'admin' },
    body: {
      name: `Member Discovery Gym ${suffix}`,
      tier: 'standard',
      location: 'Dar es Salaam',
      perVisitRate: 5000,
      status: 'active',
    },
  }, gym);
  assert.equal(gym.statusCode, 200);

  const createdTrainer = res();
  await adminUpsertTrainer.onRequest({
    user: { sub: 'usr_admin_1', userType: 'admin' },
    body: {
      displayName: `Member Discovery Trainer ${suffix}`,
      email: `member-discovery-${suffix}@example.com`,
      gymIds: [gym.body.id],
      status: 'active',
      availability: [{ day: '2099-05-05', gymId: gym.body.id, slots: ['09:00'] }],
    },
  }, createdTrainer);
  assert.equal(createdTrainer.statusCode, 201);

  const list = res();
  await listTrainers.onRequest({}, list);

  assert.equal(list.statusCode, 200);
  const discovered = list.body.find((trainer) => trainer.id === createdTrainer.body.id);
  assert.ok(discovered);
  assert.equal(discovered.gyms[0].id, gym.body.id);

  const trainerId = discovered.id;
  const detail = res();
  await getTrainer.onRequest({ params: { id: trainerId } }, detail);
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.body.id, trainerId);
  assert.ok(detail.body.availability.length >= 1);

  const bookingUserId = `usr_booking_${suffix}`;
  await updateMemberProfile.onRequest({ user: { sub: bookingUserId, userType: 'member' }, body: { displayName: 'Booking Member' } }, res());
  const booking = res();
  await createTrainerBooking.onRequest({
    user: { sub: bookingUserId, userType: 'member' },
    body: { trainerId, gymId: gym.body.id, date: '2099-05-05', slot: '09:00' }
  }, booking);
  assert.equal(booking.statusCode, 201);
  assert.equal(booking.body.booking.status, 'confirmed');
  assert.equal(booking.body.booking.trainerId, trainerId);
});

test('member check-in history endpoint returns only that member records', async () => {
  const out = res();
  await memberCheckIns.onRequest({ user: { sub: `usr_history_${Date.now()}`, userType: 'member' } }, out);
  assert.equal(out.statusCode, 200);
  assert.deepEqual(out.body, []);
});
