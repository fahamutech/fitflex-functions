// Portal admins created by another admin must change the start password before
// doing anything else (owner decision 2026-10-19).
//
// Contract: create flags the new admin (passwordChangeRequired + a keyed digest
// of the start password, never the password); every session of a flagged admin
// carries pwc: true and is refused with 403 password_change_required except on
// POST /auth/portal/password; the change sets the Firebase password, clears the
// flag, ends every earlier session and returns a new one without pwc.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import {
  adminCreatePortalUser, adminListPortalUsers,
} from '../functions/admin-portal-users.mjs';
import { authFirebaseSession, authPortalChangeStartPassword, myPersonas } from '../functions/auth.mjs';
import { users, auditLog, portalFirebaseAdmin } from '../src/bootstrap/services.mjs';
import { createPortalUserService } from '../src/services/portal-user-service.mjs';
import { sign, verify, optionalSessionClaims } from '../src/auth/jwt.mjs';
import { db } from '../src/infra/knex-store.mjs';

const uniq = p => `${p}_${randomUUID().slice(0, 8)}`;
const devToken = payload => `dev:${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const START = 'creator-chose-this-1';
const NEW = 'my-own-new-password-1';

// ── Firebase admin stand-in ─────────────────────────────────────────────────
const fb = { created: [], updated: [], revoked: [], failUpdate: false, failRevoke: false, existing: new Map(), onUpdate: null };
const original = { ...portalFirebaseAdmin };
portalFirebaseAdmin.init = () => {};
portalFirebaseAdmin.auth = () => ({
  async createUser({ email }) {
    if (fb.existing.has(email)) { const e = new Error('exists'); e.code = 'auth/email-already-exists'; throw e; }
    const uid = uniq('fbuid');
    fb.created.push({ email, uid });
    return { uid };
  },
  async getUserByEmail(email) { return { uid: fb.existing.get(email) }; },
  async updateUser(uid, patch) {
    if (fb.failUpdate) throw new Error('firebase down');
    if (fb.onUpdate) await fb.onUpdate(uid);
    fb.updated.push({ uid, ...patch });
    return { uid };
  },
  async revokeRefreshTokens(uid) {
    if (fb.failRevoke) throw new Error('revoke down');
    fb.revoked.push(uid);
  },
});
after(() => Object.assign(portalFirebaseAdmin, original));

// ── request helpers ─────────────────────────────────────────────────────────
function res() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
/** Run a route the way the server does: guards in order, then the handler. */
async function call(route, { token, body = {}, params = {}, query = {}, headers = {} } = {}) {
  const req = { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body, params, query };
  const out = res();
  const guards = Array.isArray(route.onGuard) ? route.onGuard : route.onGuard ? [route.onGuard] : [];
  for (const guard of guards) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return out;
}

// Create re-reads the caller from the DB (escalation fix), so the creator is a real super-admin row.
const superAdminRow = {
  id: uniq('usr_super'), userType: 'admin', email: `${uniq('super')}@example.com`, portalUser: false,
  aclPermissions: [], accountStatus: 'active', approvalStatus: 'approved', createdAt: new Date().toISOString(),
};
await users.upsertAsync(u => u.id === superAdminRow.id, superAdminRow);
const superAdmin = sign({ sub: superAdminRow.id, userType: 'admin', portalUser: false, aclPermissions: [] });

const nowSeconds = () => Math.floor(Date.now() / 1000);
async function createAdmin({ email = `${uniq('newadmin')}@example.com`, password = START, headers = {} } = {}) {
  const out = await call(adminCreatePortalUser, {
    token: superAdmin, headers, body: { email, password, displayName: 'New Admin', aclPermissions: ['users', 'gyms'] },
  });
  assert.equal(out.statusCode, 201, JSON.stringify(out.body));
  const row = await db('User').where({ id: out.body.id }).first();
  return { email, created: out.body, row };
}
/** Exchange a Firebase ID token; `authTime` is Firebase's auth_time (seconds of the actual sign-in). */
function firebaseSignIn(row, authTime = nowSeconds()) {
  return call(authFirebaseSession, {
    body: { idToken: devToken({ uid: row.firebaseUid, email: row.email, email_verified: true, auth_time: authTime }), requestedRole: 'admin' },
  });
}
async function signIn(row, authTime) {
  const out = await firebaseSignIn(row, authTime);
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  return out.body;
}

test('create flags the new admin and keeps a keyed digest of the start password, never the password', async () => {
  const { created, row } = await createAdmin({ headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1', 'user-agent': 'spec-agent/1' } });
  assert.equal(created.passwordChangeRequired, true);
  assert.equal(row.passwordChangeRequired, true);
  assert.match(row.startPasswordHash, /^[0-9a-f]{64}$/);
  const expected = createHmac('sha256', 'fitflex-dev-pin-pepper').update(`start-password:${row.id}:${START}`).digest('hex');
  assert.equal(row.startPasswordHash, expected);
  assert.ok(!JSON.stringify(row).includes(START), 'the start password itself is not stored');
  assert.ok(!JSON.stringify(created).includes(row.startPasswordHash));

  // The list shows the flag only.
  const list = await call(adminListPortalUsers, { token: superAdmin });
  assert.equal(list.statusCode, 200);
  const listed = list.body.find(u => u.id === row.id);
  assert.equal(listed.passwordChangeRequired, true);
  assert.ok(!JSON.stringify(list.body).includes(row.startPasswordHash));
  assert.ok(!('startPasswordHash' in listed));

  // The creation audit records the flag, no secret.
  const audit = await db('AuditLog').where({ target: row.id, action: 'portal_user_created' });
  assert.equal(audit.length, 1);
  const after = typeof audit[0].after === 'string' ? JSON.parse(audit[0].after) : audit[0].after;
  assert.equal(after.ip, '203.0.113.7');
  assert.equal(after.userAgent, 'spec-agent/1');
  assert.equal(after.passwordChangeRequired, true);
  assert.ok(!JSON.stringify(audit).includes(START) && !JSON.stringify(audit).includes(row.startPasswordHash));
});

test('an admin created on an identity that already existed in Firebase is flagged too, with no start password to compare', async () => {
  const email = `${uniq('existing')}@example.com`;
  fb.existing.set(email, uniq('fbuid_existing'));
  const { created, row } = await createAdmin({ email });
  assert.equal(created.passwordChangeRequired, true);
  assert.equal(row.passwordChangeRequired, true);
  assert.equal(row.startPasswordHash, null);
  const audit = await db('AuditLog').where({ target: row.id, action: 'portal_user_created' }).first();
  assert.equal((typeof audit.after === 'string' ? JSON.parse(audit.after) : audit.after).existingIdentity, true);
  const session = await signIn(row);
  assert.equal(verify(session.token).pwc, true);
  assert.equal((await call(adminListPortalUsers, { token: session.token })).body.error, 'password_change_required');
  // Any password of the right length is accepted (nothing to compare with), and it clears the flag.
  const out = await call(authPortalChangeStartPassword, { token: session.token, body: { newPassword: START } });
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  assert.equal(verify(out.body.token).pwc, undefined);
});

test('a flagged admin gets pwc on the session and is refused everywhere but the allowlist', async () => {
  const { row } = await createAdmin();
  const session = await signIn(row);
  assert.equal(verify(session.token).pwc, true);
  assert.ok(!JSON.stringify(session.user).includes(row.startPasswordHash), 'the session user carries no digest');
  assert.equal(session.user.startPasswordHash, undefined);

  // An ordinary ACL'd admin route.
  const adminRoute = await call(adminListPortalUsers, { token: session.token });
  assert.equal(adminRoute.statusCode, 403);
  assert.deepEqual(adminRoute.body, { error: 'password_change_required' });
  // A route open to any signed-in user.
  const anyRoute = await call(myPersonas, { token: session.token });
  assert.equal(anyRoute.statusCode, 403);
  assert.deepEqual(anyRoute.body, { error: 'password_change_required' });
  // Open routes treat it as anonymous.
  assert.equal(optionalSessionClaims({ headers: { authorization: `Bearer ${session.token}` } }), null);

  // Even a token minted without the claim is held by the account flag.
  const noClaim = sign({ sub: row.id, userType: 'admin', portalUser: true, aclPermissions: ['users'] });
  const held = await call(adminListPortalUsers, { token: noClaim });
  assert.equal(held.statusCode, 403);
  assert.equal(held.body.error, 'password_change_required');

  // The allowlisted route lets the session through (here: refuses a short password).
  const allowed = await call(authPortalChangeStartPassword, { token: session.token, body: { newPassword: 'short' } });
  assert.equal(allowed.statusCode, 400);
  assert.equal(allowed.body.error, 'password_too_short');
});

test('the change refuses a short password, the start password, and a profile that is not flagged', async () => {
  const { row } = await createAdmin();
  const { token } = await signIn(row);

  const tooShort = await call(authPortalChangeStartPassword, { token, body: { newPassword: '123456789' } });
  assert.equal(tooShort.statusCode, 400);
  assert.equal(tooShort.body.error, 'password_too_short');
  assert.equal(tooShort.body.minLength, 10);
  const missing = await call(authPortalChangeStartPassword, { token, body: {} });
  assert.equal(missing.body.error, 'password_too_short');

  const unchanged = await call(authPortalChangeStartPassword, { token, body: { newPassword: START } });
  assert.equal(unchanged.statusCode, 400);
  assert.equal(unchanged.body.error, 'password_unchanged');
  assert.equal(fb.updated.filter(u => u.uid === row.firebaseUid).length, 0, 'Firebase untouched');

  // Not flagged (an admin who isn't on a start password): this route is only for the forced first change.
  const plainRow = {
    id: uniq('usr_plain'), userType: 'admin', email: `${uniq('plain')}@example.com`, firebaseUid: uniq('fbuid_plain'),
    portalUser: true, aclPermissions: ['users'], accountStatus: 'active', approvalStatus: 'approved', createdAt: new Date().toISOString(),
  };
  await users.upsertAsync(u => u.id === plainRow.id, plainRow);
  const plainSession = await signIn(plainRow);
  assert.equal(verify(plainSession.token).pwc, undefined);
  assert.equal((await call(adminListPortalUsers, { token: plainSession.token })).statusCode, 200);
  const notRequired = await call(authPortalChangeStartPassword, { token: plainSession.token, body: { newPassword: NEW } });
  assert.equal(notRequired.statusCode, 409);
  assert.equal(notRequired.body.error, 'password_change_not_required');

  // Admins only.
  const member = sign({ sub: uniq('usr_m'), userType: 'member' });
  assert.equal((await call(authPortalChangeStartPassword, { token: member, body: { newPassword: NEW } })).statusCode, 403);
  assert.equal((await call(authPortalChangeStartPassword, { body: { newPassword: NEW } })).statusCode, 401);

  const still = await db('User').where({ id: row.id }).first();
  assert.equal(still.passwordChangeRequired, true);
});

test('a Firebase failure keeps the flag and the session', async () => {
  const { row } = await createAdmin();
  const { token } = await signIn(row);
  fb.failUpdate = true;
  try {
    const out = await call(authPortalChangeStartPassword, { token, body: { newPassword: NEW } });
    assert.equal(out.statusCode, 502);
    assert.equal(out.body.error, 'firebase_update_failed');
  } finally {
    fb.failUpdate = false;
  }
  const still = await db('User').where({ id: row.id }).first();
  assert.equal(still.passwordChangeRequired, true);
  assert.ok(still.startPasswordHash);
  assert.equal(still.sessionsValidAfter, null);
  assert.equal(still.passwordChangeClaimedAt, null, 'the claim is released');
  assert.equal((await db('AuditLog').where({ target: row.id, action: 'portal_user.password_changed' })).length, 0);
  // Free to try again straight away.
  const retry = await call(authPortalChangeStartPassword, { token, body: { newPassword: NEW } });
  assert.equal(retry.statusCode, 200, JSON.stringify(retry.body));
});

test('success sets the Firebase password, clears the flag, ends earlier sessions and returns a working one', async () => {
  const { row } = await createAdmin();
  // The creator signs in with the start password first; the new admin too.
  const creatorSignedInAt = nowSeconds();
  const creatorSession = await signIn(row, creatorSignedInAt);
  const ownSession = await signIn(row);
  // Sessions carry whole-second issue times: make sure the change happens in a later second.
  await sleep(1100);

  const out = await call(authPortalChangeStartPassword, {
    token: ownSession.token, body: { newPassword: NEW }, headers: { 'x-forwarded-for': '198.51.100.9', 'user-agent': 'portal-spec' },
  });
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  assert.ok(fb.revoked.includes(row.firebaseUid), 'Firebase refresh tokens revoked');
  assert.ok(out.body.token);
  assert.equal(out.body.user.id, row.id);
  assert.equal(out.body.user.userType, 'admin');
  assert.equal(out.body.user.passwordChangeRequired, false);
  assert.equal(out.body.user.startPasswordHash, undefined);
  assert.equal(verify(out.body.token).pwc, undefined, 'the new session has no pwc');
  assert.ok(!JSON.stringify(out.body).includes(NEW));

  assert.deepEqual(fb.updated.filter(u => u.uid === row.firebaseUid), [{ uid: row.firebaseUid, password: NEW }]);

  const stored = await db('User').where({ id: row.id }).first();
  assert.equal(stored.passwordChangeRequired, false);
  assert.equal(stored.startPasswordHash, null);
  assert.ok(stored.sessionsValidAfter);

  // Every earlier session is over, the creator's included.
  for (const old of [creatorSession.token, ownSession.token]) {
    const ended = await call(adminListPortalUsers, { token: old });
    assert.equal(ended.statusCode, 401);
    assert.equal(ended.body.error, 'session_ended');
  }
  // The new one works on an ordinary route.
  const ordinary = await call(adminListPortalUsers, { token: out.body.token });
  assert.equal(ordinary.statusCode, 200, JSON.stringify(ordinary.body));
  // A saved Firebase ID token from before the change can't open a new session…
  const replay = await firebaseSignIn(row, creatorSignedInAt);
  assert.equal(replay.statusCode, 401);
  assert.equal(replay.body.error, 'session_ended');
  // …nor one without auth_time (fail closed).
  const noAuthTime = await call(authFirebaseSession, {
    body: { idToken: devToken({ uid: row.firebaseUid, email: row.email, email_verified: true }), requestedRole: 'admin' },
  });
  assert.equal(noAuthTime.body.error, 'session_ended');
  // A sign-in after the change (with the new password) works, with no pwc.
  await sleep(1000);
  assert.equal(verify((await signIn(row, nowSeconds())).token).pwc, undefined);

  // Once only.
  const again = await call(authPortalChangeStartPassword, { token: out.body.token, body: { newPassword: 'another-new-password' } });
  assert.equal(again.statusCode, 409);
  assert.equal(again.body.error, 'password_change_not_required');

  const audit = await db('AuditLog').where({ target: row.id, action: 'portal_user.password_changed' });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor, row.id);
  const changed = typeof audit[0].after === 'string' ? JSON.parse(audit[0].after) : audit[0].after;
  assert.deepEqual([changed.ip, changed.userAgent, changed.refreshTokensRevoked], ['198.51.100.9', 'portal-spec', true]);
  const text = JSON.stringify(audit);
  assert.ok(!text.includes(NEW) && !text.includes(START) && !text.includes(row.startPasswordHash), 'no secret in the audit');
});

test('without the server key, creating a portal admin fails closed before Firebase is touched', async () => {
  const calls = [];
  const service = createPortalUserService({
    users, auditLog, isConfiguredAdminEmail: () => false, pepper: () => null,
    initFirebaseAdmin: () => {}, getAdminAuth: () => ({ createUser: async a => { calls.push(a); return { uid: 'x' }; } }),
  });
  const out = await service.create({ email: `${uniq('nokey')}@example.com`, password: START, actor: { id: superAdminRow.id, portalUser: false } });
  assert.equal(out.status, 503);
  assert.equal(out.error, 'start_password_not_configured');
  assert.equal(calls.length, 0);
});

test('two changes at once: only one reaches Firebase, the other gets 409 password_change_in_progress', async () => {
  const { row } = await createAdmin();
  const { token } = await signIn(row);
  let release;
  const gate = new Promise(r => { release = r; });
  fb.onUpdate = async uid => { if (uid === row.firebaseUid) await gate; };
  try {
    const first = call(authPortalChangeStartPassword, { token, body: { newPassword: NEW } });
    // Let the first one claim the row and wait inside Firebase.
    for (let i = 0; i < 50 && !(await db('User').where({ id: row.id }).first()).passwordChangeClaimedAt; i += 1) await sleep(20);
    const second = await call(authPortalChangeStartPassword, { token, body: { newPassword: 'the-creators-password-2' } });
    assert.equal(second.statusCode, 409);
    assert.equal(second.body.error, 'password_change_in_progress');
    release();
    const done = await first;
    assert.equal(done.statusCode, 200, JSON.stringify(done.body));
  } finally {
    fb.onUpdate = null;
    release();
  }
  assert.deepEqual(fb.updated.filter(u => u.uid === row.firebaseUid).map(u => u.password), [NEW], 'Firebase got one password only');
});

test('Firebase changed but the profile could not be finished: 500 password_changed_session_failed', async () => {
  const { row } = await createAdmin();
  const { token } = await signIn(row);
  // Someone else's claim replaces ours while Firebase runs, so finishing matches no row.
  fb.onUpdate = async uid => {
    if (uid === row.firebaseUid) await db('User').where({ id: row.id }).update({ passwordChangeClaimedAt: new Date(Date.now() + 5000) });
  };
  try {
    const out = await call(authPortalChangeStartPassword, { token, body: { newPassword: NEW } });
    assert.equal(out.statusCode, 500);
    assert.equal(out.body.error, 'password_changed_session_failed');
  } finally {
    fb.onUpdate = null;
  }
  assert.equal((await db('User').where({ id: row.id }).first()).passwordChangeRequired, true, 'the flag stays: the next session is still held');
  assert.equal((await db('AuditLog').where({ target: row.id, action: 'portal_user.password_changed' })).length, 0);
});

test('a Firebase ID token signed in before the change is refused; one after is accepted', async () => {
  const { row } = await createAdmin();
  const before = nowSeconds();
  const { token } = await signIn(row, before);
  await sleep(1100);
  assert.equal((await call(authPortalChangeStartPassword, { token, body: { newPassword: NEW } })).statusCode, 200);
  const refused = await firebaseSignIn(row, before);
  assert.deepEqual([refused.statusCode, refused.body.error], [401, 'session_ended']);
  await sleep(1000);
  const accepted = await firebaseSignIn(row, nowSeconds());
  assert.equal(accepted.statusCode, 200, JSON.stringify(accepted.body));
});
