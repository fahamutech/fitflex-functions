import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateMemberProfile, deleteMyAccount, me } from '../functions/subscriptions.mjs';
import { authFirebaseSession } from '../functions/auth.mjs';
import { trainerRegister } from '../functions/trainers.mjs';
import { createTrainerBooking } from '../functions/trainer-bookings.mjs';
import { adminUpsertGym } from '../functions/gyms.mjs';

function devToken(payload) {
  return `dev:${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

function res() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function uniq(prefix) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

test('deleteMyAccount: member can permanently delete their own account', async () => {
  const userId = uniq('usr_del_member');
  await updateMemberProfile.onRequest(
    { user: { sub: userId, userType: 'member' }, body: { displayName: 'Delete Me', phone: `+25570${Date.now()}` } },
    res(),
  );

  const del = res();
  await deleteMyAccount.onRequest({ user: { sub: userId, userType: 'member' } }, del);
  assert.equal(del.statusCode, 200);
  assert.equal(del.body.ok, true);

  const after = res();
  await me.onRequest({ user: { sub: userId } }, after);
  assert.equal(after.statusCode, 404);
  assert.equal(after.body.error, 'user_not_found');
});

test('deleteMyAccount: 404s when the account no longer exists', async () => {
  const out = res();
  await deleteMyAccount.onRequest({ user: { sub: 'usr_does_not_exist' } }, out);
  assert.equal(out.statusCode, 404);
  assert.equal(out.body.error, 'user_not_found');
});

test('deleteMyAccount: blocks a trainer with active bookings and keeps the account intact', async () => {
  const gymRes = res();
  await adminUpsertGym.onRequest({
    user: { sub: 'usr_admin_1', userType: 'admin' },
    body: { name: uniq('Delete Test Gym'), tier: 'standard', location: 'DSM Test', perVisitRate: 5000 }
  }, gymRes);
  assert.equal(gymRes.statusCode, 200);
  const gymId = gymRes.body.id;

  const email = `${uniq('trainer')}@example.com`;
  const sessionRes = res();
  await authFirebaseSession.onRequest({
    body: {
      idToken: devToken({ uid: uniq('fb_trainer'), email, name: 'Booked Trainer' }),
      requestedRole: 'trainer'
    }
  }, sessionRes);
  assert.equal(sessionRes.statusCode, 200);
  const trainerUser = sessionRes.body.user;

  const registerRes = res();
  await trainerRegister.onRequest({
    user: { sub: trainerUser.id, userType: 'trainer' },
    body: {
      displayName: 'Booked Trainer',
      photoUrl: 'https://example.com/booked.jpg',
      gender: 'male',
      bio: 'Has bookings',
      hourlyRateTzs: 15000,
      specialties: ['strength'],
      gymIds: [gymId],
    }
  }, registerRes);
  assert.equal(registerRes.statusCode, 200);
  const trainerId = registerRes.body.id;

  const memberId = uniq('usr_member_booker');
  await updateMemberProfile.onRequest(
    { user: { sub: memberId, userType: 'member' }, body: { displayName: 'Booker', phone: `+25570${Date.now()}` } },
    res(),
  );
  const bookingRes = res();
  await createTrainerBooking.onRequest({
    user: { sub: memberId, userType: 'member' },
    body: { trainerId, gymId, date: '2026-06-06', slot: '10:00' }
  }, bookingRes);
  assert.equal(bookingRes.statusCode, 201);

  const del = res();
  await deleteMyAccount.onRequest({ user: { sub: trainerUser.id, userType: 'trainer' } }, del);
  assert.equal(del.statusCode, 409);
  assert.equal(del.body.error, 'trainer_has_bookings');

  const after = res();
  await me.onRequest({ user: { sub: trainerUser.id } }, after);
  assert.equal(after.statusCode, 200);
});
