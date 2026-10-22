// Phase B · B3a — gym staff must change the PIN their owner chose (owner
// decisions 2026-10-20), reusing the portal-admin start-password mechanism of
// functions#219 (User.passwordChangeRequired, the `pwc` claim, 403
// password_change_required, requireAuthAllowingPasswordChange).
//
// Contract, while STAFF_PIN_CHANGE_REQUIRED is on:
//   - POST /owner/staff marks the new staff row; existing owner-made staff are
//     marked by migration 20270112090000 (invitation-made staff never are);
//   - a marked staff member's sessions (Firebase sign-in and PIN sign-in) carry
//     pwc: true, and every route except POST /auth/pin/change refuses them with
//     403 password_change_required;
//   - POST /auth/pin/change { newPin } replaces the Firebase password and the
//     FitFlex-held PIN, clears the mark, ends every earlier session, audits, and
//     returns a session without pwc;
//   - POST /owner/staff/:id/pin { pin } sets a new start PIN and marks again.
// Off: nothing about staff changes (new routes 404 feature_disabled).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { authFirebaseSession, authStaffChangeStartPin, authPortalChangeStartPassword } from '../functions/auth.mjs';
import { ownerCreateStaff, ownerListStaff, ownerResetStaffPin } from '../functions/owner-staff.mjs';
import { operatorVerifyQr, operatorCheckIn, operatorRecentCheckIns, operatorDashboard, operatorGymEntranceQr } from '../functions/checkins.mjs';
import { pinLogin, changeMyPin } from '../functions/pin-auth.mjs';
import { users, auditLog, portalFirebaseAdmin, pinAuthService, firebasePasswordCheck } from '../src/bootstrap/services.mjs';
import { sign, verify, invalidateAccountStatus } from '../src/auth/jwt.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { mustChangeStartCredential } from '../src/shared/credential-change.mjs';
import { toSessionUser } from '../src/shared/session-user.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const marking = require('../db/migrations/20270112090000-staff-pin-change-marking.cjs');

const uniq = p => `${p}_${randomUUID().slice(0, 8)}`;
const devToken = payload => `dev:${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const OWNER_PIN = '1234';
const NEW_PIN = '4821';

// ── environment ─────────────────────────────────────────────────────────────
const ENV_NAMES = ['STAFF_PIN_CHANGE_REQUIRED', 'IDENTITY_V2', 'V2_PIN_LOGIN', 'V2_PERSONAS', 'V2_INVITES', 'V2_LINKING', 'NODE_ENV'];
async function withEnv(env, fn) {
  const saved = Object.fromEntries(ENV_NAMES.map(n => [n, process.env[n]]));
  for (const [k, v] of Object.entries(env)) { if (v === null) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const n of ENV_NAMES) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
  }
}
const FLAG_ON = { STAFF_PIN_CHANGE_REQUIRED: 'true', V2_INVITES: null };
const FLAG_OFF = { STAFF_PIN_CHANGE_REQUIRED: null, V2_INVITES: null };
const PIN_ON = { IDENTITY_V2: 'true', V2_PIN_LOGIN: 'true', V2_LINKING: null };

// ── Firebase admin stand-in (same holder #219 uses) ───────────────────────
const fb = { updated: [], revoked: [], failUpdate: false };
const original = { ...portalFirebaseAdmin };
portalFirebaseAdmin.init = () => {};
portalFirebaseAdmin.auth = () => ({
  async createUser() { return { uid: uniq('fbuid') }; },
  async getUserByEmail() { throw new Error('not used'); },
  async updateUser(uid, patch) {
    if (fb.failUpdate) throw new Error('firebase down');
    fb.updated.push({ uid, ...patch });
    return { uid };
  },
  async revokeRefreshTokens(uid) { fb.revoked.push(uid); },
  async deleteUser() {},
});
const originalPasswordCheck = firebasePasswordCheck.verify;
after(() => { Object.assign(portalFirebaseAdmin, original); firebasePasswordCheck.verify = originalPasswordCheck; });

// ── request helpers ─────────────────────────────────────────────────────────
function res() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const guardsOf = route => (Array.isArray(route.onGuard) ? route.onGuard : route.onGuard ? [route.onGuard] : []);
/** Run the guards only. Returns { passed, out }. */
async function guardsPass(route, token, extra = {}) {
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {}, body: {}, params: {}, query: {}, ...extra };
  const out = res();
  for (const guard of guardsOf(route)) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return { passed: false, out };
  }
  return { passed: true, out, req };
}
/** Run a route the way the server does: guards in order, then the handler. */
async function call(route, { token, body = {}, params = {}, query = {}, headers = {} } = {}) {
  const req = { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body, params, query };
  const out = res();
  for (const guard of guardsOf(route)) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return out;
}

// ── fixtures ────────────────────────────────────────────────────────────────
async function makeOwner() {
  const gymId = uniq('gym_b3');
  const row = {
    id: uniq('usr_owner_b3'), userType: 'gym_operator', email: `${uniq('owner')}@example.com`,
    accountStatus: 'active', approvalStatus: 'approved', gymId, gymIds: [gymId], createdAt: new Date().toISOString(),
  };
  await users.upsertAsync(u => u.id === row.id, row);
  return { row, gymId, token: sign({ sub: row.id, userType: 'gym_operator', gymId }) };
}
/** Staff made through POST /owner/staff, with the owner-chosen PIN as the mobile app sends it. */
async function createStaff(owner, { pin = OWNER_PIN } = {}) {
  const email = `${uniq('staff')}@example.com`;
  const out = await call(ownerCreateStaff, {
    token: owner.token,
    body: { email, password: `fitflex-pin:${pin}`, displayName: 'Rehema Staff', aclPermissions: ['checkins'], gymIds: [owner.gymId] },
  });
  assert.equal(out.statusCode, 201, JSON.stringify(out.body));
  const row = await db('User').where({ id: out.body.id }).first();
  return { email, created: out.body, row };
}
function firebaseSignIn(row, authTime = nowSeconds()) {
  return call(authFirebaseSession, {
    body: { idToken: devToken({ uid: row.firebaseUid, email: row.email, email_verified: true, auth_time: authTime }), requestedRole: 'gym_staff', existingOnly: true },
  });
}
/** Give the staff Person a verified email and a FitFlex-held PIN (signed in with the app before). */
async function holdPinWithFitFlex(row, pin = OWNER_PIN) {
  await db('LoginIdentifier').insert({
    id: uniq('lid'), personId: row.personId, type: 'email', value: row.email, normalizedValue: row.email,
    verifiedAt: new Date(), status: 'active',
  });
  await pinAuthService.setPin(row.personId, pin);
}
let addr = 0;
const appPinLogin = (email, pin) => {
  const out = res();
  return pinLogin.onRequest({ body: { email, pin }, headers: { 'x-forwarded-for': `10.33.${Math.floor(addr / 250)}.${(addr++ % 250) + 1}` } }, out).then(() => out);
};
/** An older session (issued 10 s ago), as a phone that signed in earlier holds. */
const olderSession = (row, extra = {}) => sign({ sub: row.id, userType: 'gym_staff', gymId: row.gymId, aclPermissions: row.aclPermissions || [], iat: nowSeconds() - 10, ...extra });
const auditsFor = (target, action) => db('AuditLog').where({ target, action });

// ── the rule ────────────────────────────────────────────────────────────────

test('the rule: staff are held only while the flag is on; admins always', async () => {
  const staff = { userType: 'gym_staff', passwordChangeRequired: true };
  const admin = { userType: 'admin', passwordChangeRequired: true };
  await withEnv(FLAG_OFF, async () => {
    assert.equal(mustChangeStartCredential(staff), false);
    assert.equal(mustChangeStartCredential(admin), true, '#219 admins do not depend on the staff flag');
    assert.equal(toSessionUser(staff).passwordChangeRequired, false);
  });
  await withEnv(FLAG_ON, async () => {
    assert.equal(mustChangeStartCredential(staff), true);
    assert.equal(mustChangeStartCredential({ ...staff, passwordChangeRequired: false }), false);
    assert.equal(toSessionUser(staff).passwordChangeRequired, true);
  });
});

// ── flag off: unchanged ─────────────────────────────────────────────────────

test('flag off: staff sign in and work as before; the new routes do not exist', async () => {
  await withEnv(FLAG_OFF, async () => {
    const owner = await makeOwner();
    const { row, created } = await createStaff(owner);
    assert.equal(created.passwordChangeRequired, undefined, 'the staff response shape is unchanged');
    assert.equal(row.passwordChangeRequired, true, 'the owner-chosen credential is recorded (dormant)');

    const session = await firebaseSignIn(row);
    assert.equal(session.statusCode, 200, JSON.stringify(session.body));
    assert.equal(verify(session.body.token).pwc, undefined);
    assert.equal(session.body.user.passwordChangeRequired, false);
    assert.equal((await guardsPass(operatorRecentCheckIns, session.body.token)).passed, true);
    // A token minted without the claim is not held by the account check either.
    assert.equal((await guardsPass(operatorVerifyQr, olderSession(row))).passed, true);

    const change = await call(authStaffChangeStartPin, { token: session.body.token, body: { newPin: NEW_PIN } });
    assert.equal(change.statusCode, 404);
    assert.equal(change.body.error, 'feature_disabled');
    const reset = await call(ownerResetStaffPin, { token: owner.token, params: { id: row.id }, body: { pin: '9999' } });
    assert.equal(reset.statusCode, 404);
    assert.equal(reset.body.error, 'feature_disabled');
    assert.equal(fb.updated.filter(u => u.uid === row.firebaseUid).length, 0);

    const listed = (await call(ownerListStaff, { token: owner.token })).body.find(s => s.id === row.id);
    assert.equal(listed.passwordChangeRequired, undefined);
  });
});

test('flag off: PIN sign-in of an owner-made staff member has no pwc', async () => {
  await withEnv({ ...FLAG_OFF, ...PIN_ON }, async () => {
    const owner = await makeOwner();
    const { row, email } = await createStaff(owner);
    await holdPinWithFitFlex(row);
    const out = await appPinLogin(email, OWNER_PIN);
    assert.equal(out.statusCode, 200, JSON.stringify(out.body));
    assert.equal(out.body.user.id, row.id);
    assert.equal(verify(out.body.token).pwc, undefined);
  });
});

// ── flag on: both sign-in paths are held ────────────────────────────────────

test('create marks the staff member and the owner sees it', async () => {
  await withEnv(FLAG_ON, async () => {
    const owner = await makeOwner();
    const { row, created } = await createStaff(owner);
    assert.equal(created.passwordChangeRequired, true);
    assert.equal(row.passwordChangeRequired, true);
    assert.match(row.startPasswordHash, /^[0-9a-f]{64}$/, 'a keyed digest, never the PIN');
    assert.ok(!row.startPasswordHash.includes(OWNER_PIN));
    const audit = (await auditsFor(row.id, 'gym_staff_created'))[0];
    assert.equal(audit.after.passwordChangeRequired, true);
    const listed = (await call(ownerListStaff, { token: owner.token })).body.find(s => s.id === row.id);
    assert.equal(listed.passwordChangeRequired, true);
  });
});

test('Firebase sign-in (portal) of a marked staff member carries pwc and says so', async () => {
  await withEnv(FLAG_ON, async () => {
    const owner = await makeOwner();
    const { row } = await createStaff(owner);
    const out = await firebaseSignIn(row);
    assert.equal(out.statusCode, 200, JSON.stringify(out.body));
    assert.equal(verify(out.body.token).pwc, true);
    assert.equal(out.body.user.passwordChangeRequired, true);
    assert.equal(out.body.user.startPasswordHash, undefined);
  });
});

test('PIN sign-in (app) of a marked staff member carries pwc: held PIN and first-time adoption', async () => {
  await withEnv({ ...FLAG_ON, ...PIN_ON }, async () => {
    const owner = await makeOwner();
    // Already keeps a PIN with FitFlex.
    const held = await createStaff(owner);
    await holdPinWithFitFlex(held.row);
    const a = await appPinLogin(held.email, OWNER_PIN);
    assert.equal(a.statusCode, 200, JSON.stringify(a.body));
    assert.equal(a.body.user.id, held.row.id);
    assert.equal(verify(a.body.token).pwc, true);
    assert.equal(a.body.user.passwordChangeRequired, true);

    // First app sign-in: the PIN still lives only in Firebase (adopted on the spot).
    const fresh = await createStaff(owner);
    await db('LoginIdentifier').insert({
      id: uniq('lid'), personId: fresh.row.personId, type: 'email', value: fresh.email, normalizedValue: fresh.email,
      verifiedAt: new Date(), status: 'active',
    });
    firebasePasswordCheck.verify = async (email, password) => (email === fresh.email && password === `fitflex-pin:${OWNER_PIN}`
      ? { configured: true, ok: true, uid: fresh.row.firebaseUid } : { configured: true, ok: false });
    try {
      const b = await appPinLogin(fresh.email, OWNER_PIN);
      assert.equal(b.statusCode, 200, JSON.stringify(b.body));
      assert.equal(b.body.user.id, fresh.row.id);
      assert.equal(verify(b.body.token).pwc, true);
    } finally {
      firebasePasswordCheck.verify = originalPasswordCheck;
    }
  });
});

// ── flag on: every other route refuses ──────────────────────────────────────

test('a pwc staff session cannot scan, check in, or use any other route', async () => {
  await withEnv({ ...FLAG_ON, ...PIN_ON }, async () => {
    const owner = await makeOwner();
    const { row } = await createStaff(owner);
    const token = (await firebaseSignIn(row)).body.token;
    // A token minted without the claim (before the mark) is held by the account check.
    const plain = olderSession(row, { iat: nowSeconds() });
    for (const t of [token, plain]) {
      for (const route of [operatorVerifyQr, operatorCheckIn, operatorRecentCheckIns, operatorDashboard, operatorGymEntranceQr, changeMyPin]) {
        const { passed, out } = await guardsPass(route, t);
        assert.equal(passed, false, `${route.method} ${route.path} let a pwc session through`);
        assert.equal(out.statusCode, 403);
        assert.equal(out.body.error, 'password_change_required');
      }
    }
    // The admin start-password route is admins only.
    assert.equal((await guardsPass(authPortalChangeStartPassword, token)).passed, false);
  });
});

test('sweep: of every guarded route in functions/, only POST /auth/pin/change lets a pwc staff session through', async () => {
  await withEnv({ ...FLAG_ON, ...PIN_ON, V2_PERSONAS: 'true' }, async () => {
    const owner = await makeOwner();
    const { row } = await createStaff(owner);
    const token = (await firebaseSignIn(row)).body.token;
    const dir = path.join(here, '..', 'functions');
    const letThrough = [];
    let checked = 0;
    for (const file of readdirSync(dir).filter(f => f.endsWith('.mjs'))) {
      const mod = await import(pathToFileURL(path.join(dir, file)).href);
      for (const [name, route] of Object.entries(mod)) {
        if (!route || typeof route !== 'object' || !route.path || !route.onRequest) continue;
        if (!guardsOf(route).length) continue; // public routes (pwc counts as anonymous: optionalSessionClaims)
        checked += 1;
        const { passed } = await guardsPass(route, token, { params: { id: row.id, gymId: owner.gymId } });
        if (passed) letThrough.push(`${file}:${name} ${route.method.toUpperCase()} ${route.path}`);
      }
    }
    assert.ok(checked > 100, `only ${checked} guarded routes found`);
    assert.deepEqual(letThrough, ['auth.mjs:authStaffChangeStartPin POST /auth/pin/change']);
  });
});

// ── the change ──────────────────────────────────────────────────────────────

test('POST /auth/pin/change validates and refuses the owner-chosen PIN', async () => {
  await withEnv(FLAG_ON, async () => {
    const owner = await makeOwner();
    const { row } = await createStaff(owner);
    const token = (await firebaseSignIn(row)).body.token;
    for (const [newPin, error] of [[undefined, 'pin_must_be_4_digits'], ['12', 'pin_must_be_4_digits'], ['12345', 'pin_must_be_4_digits'], ['abcd', 'pin_must_be_4_digits'], [OWNER_PIN, 'pin_unchanged']]) {
      const out = await call(authStaffChangeStartPin, { token, body: { newPin } });
      assert.equal(out.statusCode, 400, `${newPin}: ${JSON.stringify(out.body)}`);
      assert.equal(out.body.error, error);
    }
    assert.equal((await db('User').where({ id: row.id }).first()).passwordChangeRequired, true);
  });
});

test('a successful change clears the mark, replaces both credentials, ends every other session and audits', async () => {
  await withEnv({ ...FLAG_ON, ...PIN_ON }, async () => {
    const owner = await makeOwner();
    const { row, email } = await createStaff(owner);
    await holdPinWithFitFlex(row);
    const oldFirebaseAuthTime = nowSeconds() - 10;
    const otherDevice = olderSession(row, { pwc: true });
    const token = olderSession(row, { pwc: true });

    const out = await call(authStaffChangeStartPin, { token, body: { newPin: NEW_PIN }, headers: { 'user-agent': 'spec' } });
    assert.equal(out.statusCode, 200, JSON.stringify(out.body));
    assert.equal(verify(out.body.token).pwc, undefined, 'the new session has no pwc');
    assert.equal(out.body.user.passwordChangeRequired, false);

    const stored = await db('User').where({ id: row.id }).first();
    assert.equal(stored.passwordChangeRequired, false);
    assert.equal(stored.startPasswordHash, null);
    assert.equal(stored.passwordChangeClaimedAt, null);
    // Firebase: the owner's password replaced, refresh tokens revoked.
    assert.deepEqual(fb.updated.filter(u => u.uid === row.firebaseUid).map(u => u.password), [`fitflex-pin:${NEW_PIN}`]);
    assert.ok(fb.revoked.includes(row.firebaseUid));
    // Every earlier session is over; the new one works, also where scanning happens.
    const ended = await guardsPass(operatorRecentCheckIns, otherDevice);
    assert.equal(ended.out.statusCode, 401);
    assert.equal(ended.out.body.error, 'session_ended');
    assert.equal((await guardsPass(operatorVerifyQr, out.body.token)).passed, true);
    // A Firebase ID token from before the change opens nothing.
    const stale = await firebaseSignIn(row, oldFirebaseAuthTime);
    assert.equal(stale.statusCode, 401);
    assert.equal(stale.body.error, 'session_ended');
    // The FitFlex-held PIN: the owner's no longer works, the new one does (no pwc).
    assert.equal((await appPinLogin(email, OWNER_PIN)).statusCode, 401);
    const fresh = await appPinLogin(email, NEW_PIN);
    assert.equal(fresh.statusCode, 200, JSON.stringify(fresh.body));
    assert.equal(verify(fresh.body.token).pwc, undefined);
    // Audit.
    const audit = (await auditsFor(row.id, 'gym_staff.pin_changed'))[0];
    assert.equal(audit.actor, row.id);
    assert.equal(audit.after.passwordChangeRequired, false);
    assert.equal(audit.after.sessionsEnded, true);
    assert.equal(audit.after.heldPin, 'replaced');
    assert.equal(audit.after.userAgent, 'spec');
    assert.ok(!JSON.stringify(audit).includes(NEW_PIN), 'the PIN never reaches the audit trail');

    // Done once: a second change is refused (the route would let a pwc session in, but this one has none).
    const again = await call(authStaffChangeStartPin, { token: out.body.token, body: { newPin: '5555' } });
    assert.equal(again.statusCode, 409);
    assert.equal(again.body.error, 'pin_change_not_required');
  });
});

test('Firebase failure: nothing changes and the staff member stays held', async () => {
  await withEnv(FLAG_ON, async () => {
    const owner = await makeOwner();
    const { row } = await createStaff(owner);
    const token = (await firebaseSignIn(row)).body.token;
    fb.failUpdate = true;
    try {
      const out = await call(authStaffChangeStartPin, { token, body: { newPin: NEW_PIN } });
      assert.equal(out.statusCode, 502);
      assert.equal(out.body.error, 'firebase_update_failed');
    } finally { fb.failUpdate = false; }
    const stored = await db('User').where({ id: row.id }).first();
    assert.equal(stored.passwordChangeRequired, true);
    assert.equal(stored.passwordChangeClaimedAt, null, 'the claim is released');
    assert.equal((await auditsFor(row.id, 'gym_staff.pin_changed')).length, 0);
  });
});

test('a concurrent change is refused while another holds the row', async () => {
  await withEnv(FLAG_ON, async () => {
    const owner = await makeOwner();
    const { row } = await createStaff(owner);
    const token = (await firebaseSignIn(row)).body.token;
    await db('User').where({ id: row.id }).update({ passwordChangeClaimedAt: new Date() });
    const out = await call(authStaffChangeStartPin, { token, body: { newPin: NEW_PIN } });
    assert.equal(out.statusCode, 409);
    assert.equal(out.body.error, 'pin_change_in_progress');
  });
});

// ── owner reset ─────────────────────────────────────────────────────────────

test('owner reset gives a new start PIN, signs the staff member out and holds them again', async () => {
  await withEnv({ ...FLAG_ON, ...PIN_ON }, async () => {
    const owner = await makeOwner();
    const { row, email } = await createStaff(owner);
    await holdPinWithFitFlex(row);
    const changed = await call(authStaffChangeStartPin, { token: olderSession(row, { pwc: true }), body: { newPin: NEW_PIN } });
    assert.equal(changed.statusCode, 200, JSON.stringify(changed.body));
    const before = olderSession(row);

    const reset = await call(ownerResetStaffPin, { token: owner.token, params: { id: row.id }, body: { pin: '7777' } });
    assert.equal(reset.statusCode, 200, JSON.stringify(reset.body));
    assert.equal(reset.body.passwordChangeRequired, true);
    assert.equal(reset.body.startPasswordHash, undefined);
    const stored = await db('User').where({ id: row.id }).first();
    assert.equal(stored.passwordChangeRequired, true);
    assert.equal(fb.updated.filter(u => u.uid === row.firebaseUid).at(-1).password, 'fitflex-pin:7777');
    // Signed out everywhere.
    const ended = await guardsPass(operatorRecentCheckIns, before);
    assert.equal(ended.out.statusCode, 401);
    assert.equal(ended.out.body.error, 'session_ended');
    // The next sign-in (app, with the reset PIN) is held again; the staff member's own PIN is gone.
    assert.equal((await appPinLogin(email, NEW_PIN)).statusCode, 401);
    const next = await appPinLogin(email, '7777');
    assert.equal(next.statusCode, 200, JSON.stringify(next.body));
    assert.equal(verify(next.body.token).pwc, true);
    // And they cannot keep the PIN the owner just chose.
    const same = await call(authStaffChangeStartPin, { token: next.body.token, body: { newPin: '7777' } });
    assert.equal(same.body.error, 'pin_unchanged');
    const audit = (await auditsFor(row.id, 'gym_staff.pin_reset'))[0];
    assert.equal(audit.actor, owner.row.id);
    assert.equal(audit.after.passwordChangeRequired, true);
    assert.equal(audit.after.heldPin, 'replaced');
    assert.ok(!JSON.stringify(audit).includes('7777'));
  });
});

test('owner reset: validation, other owners, shared identities, invitations on', async () => {
  await withEnv(FLAG_ON, async () => {
    const owner = await makeOwner();
    const { row } = await createStaff(owner);
    const bad = await call(ownerResetStaffPin, { token: owner.token, params: { id: row.id }, body: { pin: '12' } });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.body.error, 'pin_must_be_4_digits');

    const stranger = await makeOwner();
    const other = await call(ownerResetStaffPin, { token: stranger.token, params: { id: row.id }, body: { pin: '7777' } });
    assert.equal(other.statusCode, 403);
    assert.equal(other.body.error, 'staff_not_at_your_gym');
    const missing = await call(ownerResetStaffPin, { token: owner.token, params: { id: 'usr_nope' }, body: { pin: '7777' } });
    assert.equal(missing.statusCode, 404);

    // A staff profile that signs in with the person's own account (as after an invitation).
    const memberId = uniq('usr_member_b3');
    await users.upsertAsync(u => u.id === memberId, { id: memberId, userType: 'member', accountStatus: 'active', approvalStatus: 'approved', createdAt: new Date().toISOString() });
    const member = await db('User').where({ id: memberId }).first();
    const staffId = uniq('usr_invstaff_b3');
    await db('User').insert({
      id: staffId, personId: member.personId, userType: 'gym_staff', firebaseUid: uniq('fbuid'), email: `${uniq('inv')}@example.com`,
      accountStatus: 'active', approvalStatus: 'approved', onboardingCompleted: true, portalUser: false,
      aclPermissions: ['checkins'], gymIds: [owner.gymId], gymId: owner.gymId, createdAt: new Date(), updatedAt: new Date(),
    });
    const shared = await call(ownerResetStaffPin, { token: owner.token, params: { id: staffId }, body: { pin: '7777' } });
    assert.equal(shared.statusCode, 409);
    assert.equal(shared.body.error, 'staff_identity_shared');
    assert.equal((await db('User').where({ id: staffId }).first()).passwordChangeRequired, false);

    await withEnv({ IDENTITY_V2: 'true', V2_INVITES: 'true' }, async () => {
      const inv = await call(ownerResetStaffPin, { token: owner.token, params: { id: row.id }, body: { pin: '7777' } });
      assert.equal(inv.statusCode, 400);
      assert.equal(inv.body.error, 'credentials_not_accepted');
    });
    assert.equal(fb.updated.filter(u => u.uid === row.firebaseUid).length, 0, 'no refusal touched Firebase');
  });
});

// ── existing staff ──────────────────────────────────────────────────────────

test('migration marks existing owner-made staff once, with an audit row each; invitation-made and changed staff are left alone', async () => {
  const owner = await makeOwner();
  const insertStaff = async (extra = {}) => {
    const id = uniq('usr_old_b3');
    await db('User').insert({
      id, userType: 'gym_staff', firebaseUid: uniq('fbuid'), email: `${uniq('old')}@example.com`,
      accountStatus: 'active', approvalStatus: 'approved', onboardingCompleted: true, portalUser: false,
      aclPermissions: ['checkins'], gymIds: [owner.gymId], gymId: owner.gymId, passwordChangeRequired: false,
      createdAt: new Date(), updatedAt: new Date(), ...extra,
    });
    return id;
  };
  const ownerMade = await insertStaff();
  const invited = await insertStaff();
  await auditLog.insertAsync({ id: randomUUID(), at: new Date().toISOString(), actor: 'usr_x', action: 'invitation_accepted', target: uniq('inv'), before: null, after: { orgType: 'gym', personaId: invited } });
  const alreadyChanged = await insertStaff();
  await auditLog.insertAsync({ id: randomUUID(), at: new Date().toISOString(), actor: alreadyChanged, action: 'gym_staff.pin_changed', target: alreadyChanged, before: null, after: {} });
  const noLogin = await insertStaff({ firebaseUid: null, email: null });

  await marking.up(db);
  const flagOf = async id => (await db('User').where({ id }).first()).passwordChangeRequired;
  assert.equal(await flagOf(ownerMade), true);
  assert.equal(await flagOf(invited), false);
  assert.equal(await flagOf(alreadyChanged), false);
  assert.equal(await flagOf(noLogin), false);
  const marks = await auditsFor(ownerMade, 'gym_staff.pin_change_required_marked');
  assert.equal(marks.length, 1);
  assert.equal(marks[0].actor, 'system:migration');
  assert.equal(marks[0].after.reason, 'owner_chosen_pin');

  // Idempotent.
  await marking.up(db);
  assert.equal((await auditsFor(ownerMade, 'gym_staff.pin_change_required_marked')).length, 1);

  // Held only while the flag is on.
  const token = olderSession(await db('User').where({ id: ownerMade }).first(), { iat: nowSeconds() });
  await withEnv(FLAG_OFF, async () => assert.equal((await guardsPass(operatorRecentCheckIns, token)).passed, true));
  // The account check is cached for 30 s; in production the switch is an env var, so turning it on restarts the process.
  invalidateAccountStatus(ownerMade);
  await withEnv(FLAG_ON, async () => {
    const { passed, out } = await guardsPass(operatorRecentCheckIns, token);
    assert.equal(passed, false);
    assert.equal(out.body.error, 'password_change_required');
  });

  // Down unmarks what it marked and says so.
  await marking.down(db);
  assert.equal(await flagOf(ownerMade), false);
  assert.equal((await auditsFor(ownerMade, 'gym_staff.pin_change_required_unmarked')).length, 1);
  await marking.up(db); // leave the shared CI DB as migrated
});
