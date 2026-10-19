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
const fb = { created: [], updated: [], failUpdate: false, existing: new Map() };
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
    fb.updated.push({ uid, ...patch });
    return { uid };
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
async function call(route, { token, body = {}, params = {}, query = {} } = {}) {
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {}, body, params, query };
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

const superAdmin = sign({ sub: uniq('usr_super'), userType: 'admin', portalUser: false, aclPermissions: [] });

async function createAdmin({ email = `${uniq('newadmin')}@example.com`, password = START } = {}) {
  const out = await call(adminCreatePortalUser, {
    token: superAdmin, body: { email, password, displayName: 'New Admin', aclPermissions: ['users', 'gyms'] },
  });
  assert.equal(out.statusCode, 201, JSON.stringify(out.body));
  const row = await db('User').where({ id: out.body.id }).first();
  return { email, created: out.body, row };
}
async function signIn(row) {
  const out = await call(authFirebaseSession, {
    body: { idToken: devToken({ uid: row.firebaseUid, email: row.email, email_verified: true }), requestedRole: 'admin' },
  });
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  return out.body;
}

test('create flags the new admin and keeps a keyed digest of the start password, never the password', async () => {
  const { created, row } = await createAdmin();
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
  assert.ok(!JSON.stringify(audit).includes(START) && !JSON.stringify(audit).includes(row.startPasswordHash));
});

test('an identity that already existed in Firebase is not flagged (the creator did not set its password)', async () => {
  const email = `${uniq('existing')}@example.com`;
  fb.existing.set(email, uniq('fbuid_existing'));
  const { created, row } = await createAdmin({ email });
  assert.equal(created.passwordChangeRequired, false);
  assert.equal(row.passwordChangeRequired, false);
  assert.equal(row.startPasswordHash, null);
  const session = await signIn(row);
  assert.equal(verify(session.token).pwc, undefined);
  assert.equal((await call(adminListPortalUsers, { token: session.token })).statusCode, 200);
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

  // Not flagged: this route is only for the forced first change.
  const email = `${uniq('plain')}@example.com`;
  fb.existing.set(email, uniq('fbuid_plain'));
  const plain = await createAdmin({ email });
  const plainSession = await signIn(plain.row);
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
  assert.equal((await db('AuditLog').where({ target: row.id, action: 'portal_user.password_changed' })).length, 0);
  // Still allowed to try again.
  const retry = await call(authPortalChangeStartPassword, { token, body: { newPassword: 'x' } });
  assert.equal(retry.body.error, 'password_too_short');
});

test('success sets the Firebase password, clears the flag, ends earlier sessions and returns a working one', async () => {
  const { row } = await createAdmin();
  // The creator signs in with the start password first; the new admin too.
  const creatorSession = await signIn(row);
  const ownSession = await signIn(row);
  // Sessions carry whole-second issue times: make sure the change happens in a later second.
  await sleep(1100);

  const out = await call(authPortalChangeStartPassword, { token: ownSession.token, body: { newPassword: NEW } });
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
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
  // A later sign-in has no pwc either.
  assert.equal(verify((await signIn(row)).token).pwc, undefined);

  // Once only.
  const again = await call(authPortalChangeStartPassword, { token: out.body.token, body: { newPassword: 'another-new-password' } });
  assert.equal(again.statusCode, 409);
  assert.equal(again.body.error, 'password_change_not_required');

  const audit = await db('AuditLog').where({ target: row.id, action: 'portal_user.password_changed' });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor, row.id);
  const text = JSON.stringify(audit);
  assert.ok(!text.includes(NEW) && !text.includes(START) && !text.includes(row.startPasswordHash), 'no secret in the audit');
});

test('without the server key, creating a portal admin fails closed before Firebase is touched', async () => {
  const calls = [];
  const service = createPortalUserService({
    users, auditLog, isConfiguredAdminEmail: () => false, pepper: () => null,
    initFirebaseAdmin: () => {}, getAdminAuth: () => ({ createUser: async a => { calls.push(a); return { uid: 'x' }; } }),
  });
  const out = await service.create({ email: `${uniq('nokey')}@example.com`, password: START, actorId: 'usr_x' });
  assert.equal(out.status, 503);
  assert.equal(out.error, 'start_password_not_configured');
  assert.equal(calls.length, 0);
});
