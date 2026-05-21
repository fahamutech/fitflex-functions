import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listTrainers,
  getTrainer,
  updateMemberProfile,
  createTrainerBooking,
  memberCheckIns
} from '../functions/index.mjs';

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
  const out = res();
  await updateMemberProfile.onRequest({
    user: { sub: `usr_owner_profile_${Date.now()}`, userType: 'gym_operator' },
    body: {
      displayName: 'Gym Owner',
      phone: '+255700111222'
    }
  }, out);

  assert.equal(out.statusCode, 200);
  assert.equal(out.body.user.userType, 'gym_operator');
  assert.equal(out.body.user.displayName, 'Gym Owner');
  assert.equal(out.body.user.phone, '+255700111222');
  assert.equal(out.body.user.onboardingCompleted, undefined);
});

test('member trainer discovery supports list, detail, and booking branch', () => {
  const list = res();
  listTrainers.onRequest({}, list);

  assert.equal(list.statusCode, 200);
  assert.ok(list.body.length >= 1);
  assert.ok(list.body[0].gyms.length >= 1);

  const trainerId = list.body[0].id;
  const detail = res();
  getTrainer.onRequest({ params: { id: trainerId } }, detail);
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.body.id, trainerId);
  assert.ok(detail.body.availability.length >= 1);

  const booking = res();
  createTrainerBooking.onRequest({
    user: { sub: `usr_booking_${Date.now()}`, userType: 'member' },
    body: { trainerId, gymId: detail.body.gyms[0].id, date: '2026-05-05', slot: '09:00' }
  }, booking);
  assert.equal(booking.statusCode, 201);
  assert.equal(booking.body.booking.status, 'confirmed');
  assert.equal(booking.body.booking.trainerId, trainerId);
});

test('member check-in history endpoint returns only that member records', () => {
  const out = res();
  memberCheckIns.onRequest({ user: { sub: `usr_history_${Date.now()}`, userType: 'member' } }, out);
  assert.equal(out.statusCode, 200);
  assert.deepEqual(out.body, []);
});
