import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authFirebaseSession } from '../functions/auth.mjs';
import { subscribe, updateMemberProfile } from '../functions/subscriptions.mjs';
import { myQr } from '../functions/checkins.mjs';

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

test('Firebase session creates a FitFlex member session from a verified identity', async () => {
  const out = res();
  await authFirebaseSession.onRequest({
    body: {
      idToken: devToken({ uid: `fb_test_${Date.now()}`, email: `pilot-${Date.now()}@example.com`, name: 'Pilot Member' }),
      requestedRole: 'member'
    }
  }, out);

  assert.equal(out.statusCode, 200);
  assert.ok(out.body.token);
  assert.equal(out.body.user.userType, 'member');
  assert.ok(out.body.user.firebaseUid);
});

test('Firebase session maps the configured Google account to FitFlex admin', async () => {
  const out = res();
  await authFirebaseSession.onRequest({
    body: {
      idToken: devToken({ uid: `fb_admin_${Date.now()}`, email: 'mama27j@gmail.com', name: 'FitFlex Admin' }),
      requestedRole: 'gym_operator'
    }
  }, out);

  assert.equal(out.statusCode, 200);
  assert.ok(out.body.token);
  assert.equal(out.body.user.email, 'mama27j@gmail.com');
  assert.equal(out.body.user.userType, 'admin');
  assert.ok(out.body.user.firebaseUid);
});

test('Firebase session creates gym owner and trainer profiles pending admin approval', async () => {
  const owner = res();
  await authFirebaseSession.onRequest({
    body: {
      idToken: devToken({ uid: `fb_owner_${Date.now()}`, email: `owner-${Date.now()}@example.com`, name: 'Gym Owner' }),
      requestedRole: 'gym_owner'
    }
  }, owner);

  assert.equal(owner.statusCode, 200);
  assert.equal(owner.body.user.userType, 'gym_operator');
  assert.equal(owner.body.user.approvalStatus, 'pending_approval');

  const trainer = res();
  await authFirebaseSession.onRequest({
    body: {
      idToken: devToken({ uid: `fb_trainer_${Date.now()}`, email: `trainer-${Date.now()}@example.com`, name: 'Trainer' }),
      requestedRole: 'trainer'
    }
  }, trainer);

  assert.equal(trainer.statusCode, 200);
  assert.equal(trainer.body.user.userType, 'trainer');
  assert.equal(trainer.body.user.approvalStatus, 'pending_approval');
});

test('Firebase session rejects reusing one email for a different role', async () => {
  const email = `role-conflict-${Date.now()}@example.com`;
  const member = res();
  await authFirebaseSession.onRequest({
    body: {
      idToken: devToken({ uid: `fb_member_${Date.now()}`, email, name: 'Member' }),
      requestedRole: 'member'
    }
  }, member);
  assert.equal(member.statusCode, 200);
  assert.equal(member.body.user.userType, 'member');

  const owner = res();
  await authFirebaseSession.onRequest({
    body: {
      idToken: devToken({ uid: `fb_owner_conflict_${Date.now()}`, email, name: 'Owner' }),
      requestedRole: 'gym_owner'
    }
  }, owner);
  assert.equal(owner.statusCode, 409);
  assert.equal(owner.body.error, 'email_already_used_for_different_role');
});

test('pass request stays payment_pending and cannot issue QR before admin approval', async () => {
  const userId = `usr_pay_${Date.now()}`;
  await updateMemberProfile.onRequest({ user: { sub: userId, userType: 'member' }, body: { displayName: 'Pay Test' } }, res());
  const req = { user: { sub: userId, userType: 'member' }, body: { tier: 'pro', type: 'platform_pass' } };
  const created = res();
  await subscribe.onRequest(req, created);

  assert.equal(created.statusCode, 202);
  assert.equal(created.body.subscription.status, 'payment_pending');
  assert.equal(created.body.paymentRequest.status, 'pending');

  const qr = res();
  await myQr.onRequest({ user: req.user }, qr);
  assert.equal(qr.statusCode, 403);
  assert.equal(qr.body.error, 'active_subscription_required');
});

test('online free plan activates without creating a payment request', async () => {
  const userId = `usr_online_${Date.now()}`;
  await updateMemberProfile.onRequest({ user: { sub: userId, userType: 'member' }, body: { displayName: 'Online Test' } }, res());
  const req = { user: { sub: userId, userType: 'member' }, body: { tier: 'online_free', type: 'platform_pass' } };
  const created = res();
  await subscribe.onRequest(req, created);

  assert.equal(created.statusCode, 201);
  assert.equal(created.body.subscription.status, 'active');
  assert.equal(created.body.subscription.paymentRef, 'FREE_ONLINE');
  assert.equal(created.body.paymentRequest, null);
});
