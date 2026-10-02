// Portal sign-in for gym owners and staff (the C10 defect).
// The portal has no self-registration, so it signs in with existingOnly: the
// session route then never creates a profile, it only finds one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { authFirebaseSession } from '../functions/auth.mjs';
import { users } from '../src/bootstrap/services.mjs';
import { db } from '../src/infra/knex-store.mjs';

const uniq = p => `${p}_${randomUUID().slice(0, 8)}`;
const devToken = payload => `dev:${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;

function res() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
async function session(fb, body = {}) {
  const out = res();
  await authFirebaseSession.onRequest({ body: { idToken: devToken(fb), ...body }, headers: {} }, out);
  return out;
}
async function makeUser(overrides = {}) {
  const row = {
    id: uniq('usr_c10'), userType: 'member', accountStatus: 'active', approvalStatus: 'approved',
    createdAt: new Date().toISOString(), ...overrides,
  };
  await users.upsertAsync(u => u.id === row.id, row);
  return row;
}
/** What the portal does: admin first, then owner, then staff, never creating. */
async function portalSignIn(fb) {
  let out = await session(fb, { requestedRole: 'admin' });
  for (const role of ['gym_operator', 'gym_staff']) {
    // Only "no such profile" moves on to the next role; any other refusal is final.
    if (!['admin_self_registration_not_allowed', 'profile_not_found'].includes(out.body?.error)) break;
    out = await session(fb, { requestedRole: role, existingOnly: true });
  }
  return out;
}
const rowsFor = uid => db('User').where({ firebaseUid: uid });

test('existingOnly never creates a profile', async () => {
  const uid = uniq('fb');
  const fb = { uid, email: `${uniq('nobody')}@example.com` };
  for (const role of ['gym_operator', 'gym_staff', 'member', undefined]) {
    const out = await session(fb, { requestedRole: role, existingOnly: true });
    assert.equal(out.statusCode, 404, `${role}: ${JSON.stringify(out.body)}`);
    assert.equal(out.body.error, 'profile_not_found');
  }
  assert.deepEqual(await rowsFor(uid), []);
  // Only the literal true counts; anything else keeps today's behaviour.
  const created = await session(fb, { requestedRole: 'member', existingOnly: 'true' });
  assert.equal(created.statusCode, 200);
  assert.equal((await rowsFor(uid)).length, 1);
});

test('a gym owner and a gym staff member sign in at the portal with their existing profile', async () => {
  for (const userType of ['gym_operator', 'gym_staff']) {
    const uid = uniq('fb');
    const email = `${uniq(userType)}@example.com`;
    const row = await makeUser({ userType, firebaseUid: uid, email, gymIds: ['gym_x'], gymId: 'gym_x', aclPermissions: userType === 'gym_staff' ? ['members'] : [] });
    const out = await portalSignIn({ uid, email });
    assert.equal(out.statusCode, 200, JSON.stringify(out.body));
    assert.equal(out.body.user.id, row.id);
    assert.equal(out.body.user.userType, userType);
    assert.ok(out.body.token);
    assert.equal((await rowsFor(uid)).length, 1, 'no extra profile was created along the way');
  }
});

test('an owner who is also a trainer signs in at the portal as the owner', async () => {
  const uid = uniq('fb');
  const email = `${uniq('both')}@example.com`;
  await makeUser({ userType: 'trainer', firebaseUid: uid, email });
  const owner = await makeUser({ userType: 'gym_operator', firebaseUid: uid, email });
  const out = await portalSignIn({ uid, email });
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.user.id, owner.id);
});

test('members, trainers, vendors and strangers get no portal session and nothing is created', async () => {
  for (const userType of ['member', 'trainer', 'vendor']) {
    const uid = uniq('fb');
    const email = `${uniq(userType)}@example.com`;
    await makeUser({ userType, firebaseUid: uid, email });
    const out = await portalSignIn({ uid, email });
    assert.equal(out.statusCode, 404, `${userType}: ${JSON.stringify(out.body)}`);
    assert.equal((await rowsFor(uid)).length, 1);
  }
  const uid = uniq('fb');
  assert.equal((await portalSignIn({ uid, email: `${uniq('stranger')}@example.com` })).statusCode, 404);
  assert.deepEqual(await rowsFor(uid), []);
});

test('an owner profile reached only by an unverified email still needs the email verified', async () => {
  const email = `${uniq('owner')}@example.com`;
  await makeUser({ userType: 'gym_operator', email });
  const uid = uniq('fb');
  const unverified = await session({ uid, email, email_verified: false }, { requestedRole: 'gym_operator', existingOnly: true });
  assert.equal(unverified.statusCode, 409);
  assert.equal(unverified.body.error, 'email_verification_required');
  const verified = await session({ uid, email, email_verified: true }, { requestedRole: 'gym_operator', existingOnly: true });
  assert.equal(verified.statusCode, 200);
  assert.equal(verified.body.user.userType, 'gym_operator');
});

test('a suspended owner is refused, and admins and app sign-up are unchanged', async () => {
  const uid = uniq('fb');
  const email = `${uniq('susp')}@example.com`;
  await makeUser({ userType: 'gym_operator', firebaseUid: uid, email, accountStatus: 'suspended' });
  const out = await portalSignIn({ uid, email });
  assert.equal(out.statusCode, 403);
  assert.equal(out.body.error, 'account_suspended');

  const adminUid = uniq('fb');
  const adminEmail = `${uniq('admin')}@example.com`;
  const admin = await makeUser({ userType: 'admin', firebaseUid: adminUid, email: adminEmail, portalUser: true, aclPermissions: ['gyms'] });
  const adminOut = await portalSignIn({ uid: adminUid, email: adminEmail });
  assert.equal(adminOut.statusCode, 200);
  assert.equal(adminOut.body.user.id, admin.id);

  const newUid = uniq('fb');
  const signUp = await session({ uid: newUid, email: `${uniq('new')}@example.com` }, { requestedRole: 'gym_operator' });
  assert.equal(signUp.statusCode, 200, 'the app can still register an owner');
  assert.equal(signUp.body.user.userType, 'gym_operator');
});
