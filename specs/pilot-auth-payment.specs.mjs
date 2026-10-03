import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authFirebaseSession, authRequestOtp, authVerifyOtp } from '../functions/auth.mjs';
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

test('Firebase session creates owner and trainer profiles active at once; a vendor waits for approval', async () => {
  const owner = res();
  await authFirebaseSession.onRequest({
    body: {
      idToken: devToken({ uid: `fb_owner_${Date.now()}`, email: `owner-${Date.now()}@example.com`, name: 'Gym Owner' }),
      requestedRole: 'gym_owner'
    }
  }, owner);

  assert.equal(owner.statusCode, 200);
  assert.equal(owner.body.user.userType, 'gym_operator');
  assert.equal(owner.body.user.approvalStatus, 'approved');
  assert.equal(owner.body.pendingApproval, false);
  // Whether they are verified yet rides along (always true here: the suite runs with KYC enforcement off).
  assert.equal(typeof owner.body.partnerVerified, 'boolean');

  const trainer = res();
  await authFirebaseSession.onRequest({
    body: {
      idToken: devToken({ uid: `fb_trainer_${Date.now()}`, email: `trainer-${Date.now()}@example.com`, name: 'Trainer' }),
      requestedRole: 'trainer'
    }
  }, trainer);

  assert.equal(trainer.statusCode, 200);
  assert.equal(trainer.body.user.userType, 'trainer');
  assert.equal(trainer.body.user.approvalStatus, 'approved');
  assert.equal(typeof trainer.body.partnerVerified, 'boolean');

  const vendor = res();
  await authFirebaseSession.onRequest({
    body: {
      idToken: devToken({ uid: `fb_vendor_${Date.now()}`, email: `vendor-${Date.now()}@example.com`, name: 'Vendor' }),
      requestedRole: 'vendor'
    }
  }, vendor);

  assert.equal(vendor.statusCode, 200);
  assert.equal(vendor.body.user.userType, 'vendor');
  assert.equal(vendor.body.user.approvalStatus, 'pending_approval');
  assert.equal(vendor.body.partnerVerified, undefined);
});

test('sign-in automatically resolves existing owner, trainer and vendor roles', async () => {
  for (const requestedRole of ['gym_owner', 'trainer', 'vendor']) {
    const stamp = `${requestedRole}-${Date.now()}-${Math.random()}`;
    const identity = {
      uid: `fb_auto_${stamp}`,
      email: `auto-${stamp}@example.com`,
      name: `Auto ${requestedRole}`,
    };
    const created = res();
    await authFirebaseSession.onRequest({
      body: { idToken: devToken(identity), requestedRole },
    }, created);
    assert.equal(created.statusCode, 200);

    const signedIn = res();
    await authFirebaseSession.onRequest({
      body: { idToken: devToken(identity) },
    }, signedIn);
    assert.equal(signedIn.statusCode, 200);
    assert.equal(signedIn.body.user.userType, created.body.user.userType);
  }
});

test('sign-in prefers a single operational profile over a duplicate member profile', async () => {
  for (const requestedRole of ['gym_owner', 'trainer', 'vendor']) {
    const stamp = `${requestedRole}-${Date.now()}-${Math.random()}`;
    const identity = {
      uid: `fb_duplicate_${stamp}`,
      email: `duplicate-${stamp}@example.com`,
      name: `Duplicate ${requestedRole}`,
    };

    const member = res();
    await authFirebaseSession.onRequest({
      body: { idToken: devToken(identity), requestedRole: 'member' },
    }, member);
    assert.equal(member.statusCode, 200);

    const operational = res();
    await authFirebaseSession.onRequest({
      body: { idToken: devToken(identity), requestedRole },
    }, operational);
    assert.equal(operational.statusCode, 200);

    const signedIn = res();
    await authFirebaseSession.onRequest({
      body: { idToken: devToken(identity) },
    }, signedIn);
    assert.equal(signedIn.statusCode, 200);
    assert.equal(signedIn.body.user.userType, operational.body.user.userType);
  }
});

test('Firebase session gives one identity separate member, trainer, and vendor profiles', async () => {
  const email = `role-conflict-${Date.now()}@example.com`;
  const uid = `fb_multi_role_${Date.now()}`;
  const member = res();
  await authFirebaseSession.onRequest({
    body: {
      idToken: devToken({ uid, email, name: 'Multi-role User' }),
      requestedRole: 'member'
    }
  }, member);
  assert.equal(member.statusCode, 200);
  assert.equal(member.body.user.userType, 'member');

  const owner = res();
  await authFirebaseSession.onRequest({
    body: {
      idToken: devToken({ uid, email, name: 'Multi-role User' }),
      requestedRole: 'trainer'
    }
  }, owner);
  assert.equal(owner.statusCode, 200);
  assert.equal(owner.body.user.userType, 'trainer');
  assert.notEqual(owner.body.user.id, member.body.user.id);

  const vendor = res();
  await authFirebaseSession.onRequest({
    body: {
      idToken: devToken({ uid, email, name: 'Multi-role User' }),
      requestedRole: 'vendor'
    }
  }, vendor);
  assert.equal(vendor.statusCode, 200);
  assert.equal(vendor.body.user.userType, 'vendor');
  assert.notEqual(vendor.body.user.id, member.body.user.id);
  assert.notEqual(vendor.body.user.id, owner.body.user.id);
});

test('one mobile number can create separate member, trainer, and vendor profiles', async () => {
  const phone = `+2557${String(Date.now()).slice(-8)}`;
  const ids = new Set();

  for (const userType of ['member', 'trainer', 'vendor']) {
    const requested = res();
    await authRequestOtp.onRequest({ body: { phone, userType } }, requested);
    assert.equal(requested.statusCode, 200);

    const verified = res();
    await authVerifyOtp.onRequest({
      body: { phone, code: requested.body.devOtp }
    }, verified);
    assert.equal(verified.statusCode, 200);
    assert.equal(verified.body.user.userType, userType);
    ids.add(verified.body.user.id);
  }

  assert.equal(ids.size, 3);
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
