// TDD: B.2 — Trainers now self-register (see trainer-registration.specs.mjs) and no longer
// get an email+PIN account pre-created by the owner. The same "pre-created account, then
// Firebase email/PIN sign-in links by email" mechanism now applies to gym staff created by
// the owner (see ownerCreateStaff) — but that endpoint also calls Firebase Admin to actually
// create the login itself, so the trainer-style "link by email on first Firebase sign-in"
// path only remains relevant for roles that self-register. This spec now asserts that a
// self-registering trainer's Firebase session behaves the same way B.2 originally covered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authFirebaseSession, authDevLogin } from '../functions/index.mjs';

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

test('B.2: a self-registering trainer can sign in via Firebase email/PIN and gets a JWT', async () => {
  const trainerEmail = `trainer_b2_${Date.now()}@test.com`;
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
  assert.equal(sessionRes.body.user.approvalStatus, 'pending_approval', 'new trainers await admin approval before onboarding');
  assert.ok(sessionRes.body.token, 'should return a JWT token');
});

test('B.2: gym staff self-registration via Firebase is explicitly blocked — must be created by the owner', async () => {
  const staffEmail = `staff_b2_${Date.now()}@test.com`;
  const sessionReq = {
    body: {
      idToken: `dev:${Buffer.from(JSON.stringify({
        uid: `fb_staff_b2_${Date.now()}`,
        email: staffEmail,
        name: 'Rogue Staff',
      })).toString('base64url')}`,
      requestedRole: 'gym_staff',
    },
  };
  const sessionRes = res();
  await authFirebaseSession.onRequest(sessionReq, sessionRes);

  assert.equal(sessionRes.statusCode, 403);
  assert.equal(sessionRes.body.error, 'gym_staff_self_registration_not_allowed');
});
