// TDD: B.2 — Trainer created via owner email should be able to log in with email + PIN.
// The ownerAddTrainer endpoint must also create a user record so authFirebaseSession can match it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownerAddTrainer, authFirebaseSession, authDevLogin } from '../functions/index.mjs';

function res() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

// Seed the dev owner first
test('B.2: setup - seed dev owner', async () => {
  const r = res();
  await authDevLogin.onRequest({ body: { role: 'owner' } }, r);
  assert.equal(r.statusCode, 200, 'dev owner seed should succeed');
});

test('B.2: ownerAddTrainer creates a user record with trainer email', async () => {
  const trainerEmail = `trainer_b2_${Date.now()}@test.com`;
  const ownerReq = {
    user: { sub: 'usr_dev_owner', userType: 'gym_operator' },
    body: {
      email: trainerEmail,
      displayName: 'Test Trainer B2',
      gymIds: ['gym_dev_owner'],
      hourlyRateTzs: 15000,
      specialties: ['yoga'],
    },
  };
  const ownerRes = res();
  await ownerAddTrainer.onRequest(ownerReq, ownerRes);
  assert.equal(ownerRes.statusCode, 200, `trainer creation should succeed, got: ${JSON.stringify(ownerRes.body)}`);
  assert.ok(ownerRes.body.id, 'trainer should have an ID');

  // Now the trainer signs in with Firebase using same email
  // Simulate Firebase session exchange
  const sessionReq = {
    body: {
      idToken: `dev:${Buffer.from(JSON.stringify({
        uid: `fb_trainer_b2_${Date.now()}`,
        email: trainerEmail,
        name: 'Test Trainer B2',
      })).toString('base64url')}`,
      requestedRole: 'trainer',
    },
  };
  const sessionRes = res();
  await authFirebaseSession.onRequest(sessionReq, sessionRes);

  assert.equal(sessionRes.statusCode, 200, `firebase session should succeed for trainer email, got: ${JSON.stringify(sessionRes.body)}`);
  assert.equal(sessionRes.body.user.userType, 'trainer');
  assert.equal(sessionRes.body.user.email, trainerEmail);
  assert.ok(sessionRes.body.token, 'should return a JWT token');
});

test('B.2: trainer created by owner can log in without Google, just email+PIN', async () => {
  const trainerEmail = `trainer_pin_${Date.now()}@test.com`;
  const ownerReq = {
    user: { sub: 'usr_dev_owner', userType: 'gym_operator' },
    body: {
      email: trainerEmail,
      displayName: 'PIN Trainer',
      gymIds: ['gym_dev_owner'],
      hourlyRateTzs: 20000,
      specialties: ['cardio'],
    },
  };
  const ownerRes = res();
  await ownerAddTrainer.onRequest(ownerReq, ownerRes);
  assert.equal(ownerRes.statusCode, 200);

  // The trainer's user record should exist with their email
  // When they sign in via Firebase email/password (PIN), the session endpoint
  // should find them by email and link their firebaseUid
  const fbUid = `fb_pin_trainer_${Date.now()}`;
  const sessionReq = {
    body: {
      idToken: `dev:${Buffer.from(JSON.stringify({
        uid: fbUid,
        email: trainerEmail,
        name: 'PIN Trainer',
      })).toString('base64url')}`,
      requestedRole: 'trainer',
    },
  };
  const sessionRes = res();
  await authFirebaseSession.onRequest(sessionReq, sessionRes);

  assert.equal(sessionRes.statusCode, 200, `login should work: ${JSON.stringify(sessionRes.body)}`);
  assert.equal(sessionRes.body.user.email, trainerEmail);
  assert.equal(sessionRes.body.user.userType, 'trainer');
  // The firebaseUid should now be linked
  assert.equal(sessionRes.body.user.firebaseUid, fbUid);
});
