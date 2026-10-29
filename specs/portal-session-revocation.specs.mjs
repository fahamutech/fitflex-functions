// Admin-portal audit S1: changing a portal user's scopes / status / super-admin standing, or
// deleting the user, ends their existing token on the next request. Runs the real requireAuth
// guard against the real status lookup (registered by bootstrap) on the CI database.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { adminUpdatePortalUser, adminDeletePortalUser } from '../functions/admin-portal-users.mjs';
import { users } from '../src/bootstrap/services.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { sign, requireAuth } from '../src/auth/jwt.mjs';

const made = [];
after(async () => {
  if (!made.length) return;
  await db('AuditLog').whereIn('target', made).del();
  await db('AuditLog').whereIn('actor', made).del();
  await db('User').whereIn('id', made).del();
});

const res = () => ({
  statusCode: 200, body: null,
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
});

async function staff(scopes = ['gyms', 'payments']) {
  const id = `usr_s1_${randomUUID().slice(0, 8)}`;
  await users.upsertAsync(u => u.id === id, {
    id, userType: 'admin', email: `${id}@example.com`, displayName: id, accountStatus: 'active',
    approvalStatus: 'approved', onboardingCompleted: true, portalUser: true, aclPermissions: scopes,
    createdAt: new Date().toISOString(),
  });
  made.push(id);
  return id;
}
const tokenFor = id => sign({ sub: id, userType: 'admin', portalUser: true, aclPermissions: ['gyms', 'payments'] });
const SUPER = { sub: 'usr_admin_1', userType: 'admin', portalUser: false };

// Runs the guard the way express does; returns the response (statusCode 0 = passed through).
async function through(token) {
  const out = res();
  out.statusCode = 0;
  let passed = false;
  await requireAuth('admin')({ headers: { authorization: `Bearer ${token}` } }, out, () => { passed = true; });
  return { passed, status: out.statusCode, body: out.body };
}
const put = async (id, body) => { const out = res(); await adminUpdatePortalUser.onRequest({ params: { id }, body, user: SUPER }, out); return out; };

test('baseline: a staff token passes the guard', async () => {
  const id = await staff();
  assert.equal((await through(tokenFor(id))).passed, true);
});

test('removing a scope ends the existing token on the next request', async () => {
  const id = await staff();
  const t = tokenFor(id);
  assert.equal((await through(t)).passed, true); // primes the status cache
  assert.equal((await put(id, { aclPermissions: ['gyms'] })).statusCode, 200);
  const after = await through(t);
  assert.equal(after.passed, false);
  assert.equal(after.status, 401);
  assert.equal(after.body.error, 'session_ended');
});

test('suspending ends the token; a re-sent unchanged value does not', async () => {
  const id = await staff();
  const t = tokenFor(id);
  assert.equal((await through(t)).passed, true);
  assert.equal((await put(id, { aclPermissions: ['gyms', 'payments'], accountStatus: 'active', displayName: 'Renamed' })).statusCode, 200);
  assert.equal((await through(t)).passed, true, 'no real access change: session stays');
  await put(id, { accountStatus: 'suspended' });
  assert.equal((await through(t)).status, 403);
});

test('demotion/promotion of super-admin standing ends the token', async () => {
  const id = await staff();
  const t = tokenFor(id);
  assert.equal((await through(t)).passed, true);
  assert.equal((await put(id, { portalUser: false })).statusCode, 200);
  assert.equal((await through(t)).status, 401);
});

test('a sign-in after the change works', async () => {
  const id = await staff();
  await put(id, { aclPermissions: ['gyms'] });
  await new Promise(r => setTimeout(r, 1100));
  assert.equal((await through(sign({ sub: id, userType: 'admin', portalUser: true, aclPermissions: ['gyms'] }))).passed, true);
});

test('deleting the user fails closed with 401', async () => {
  const id = await staff();
  const t = tokenFor(id);
  assert.equal((await through(t)).passed, true);
  const out = res();
  await adminDeletePortalUser.onRequest({ params: { id }, user: SUPER }, out);
  assert.equal(out.statusCode, 200);
  const after = await through(t);
  assert.equal(after.passed, false);
  assert.equal(after.status, 401);
});

test('an id that never had a row keeps the old pass-through (only deleted portal users are cut off)', async () => {
  assert.equal((await through(sign({ sub: 'usr_nobody_s1', userType: 'admin', portalUser: true, aclPermissions: [] }))).passed, true);
});

test('missing non-admin accounts are unchanged (no behaviour change for other users)', async () => {
  assert.equal((await through(sign({ sub: 'usr_nobody_s1', userType: 'member' }))).status, 403); // role gate, as before
});
