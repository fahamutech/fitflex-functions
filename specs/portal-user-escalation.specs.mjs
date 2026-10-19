// Security fix 2026-10-19: portal staff could PUT /admin/portal-users/<id>
// { portalUser: false } (on themselves or anyone) and become unrestricted
// super-admins, or grant themselves any scope. These specs pin the rules:
//   - only a super-admin changes portalUser, or edits a super-admin account
//   - nobody changes their own aclPermissions / portalUser / accountStatus
//   - staff only grant or remove scopes they hold (create() too)
//   - the caller comes from req.user, never the body; refusals are audited
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { adminUpdatePortalUser, adminCreatePortalUser } from '../functions/admin-portal-users.mjs';
import { users, auditLog } from '../src/bootstrap/services.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { createPortalUserService } from '../src/services/portal-user-service.mjs';

const made = [];
const uniq = p => `${p}_${randomUUID().slice(0, 8)}`;

after(async () => {
  if (!made.length) return;
  await db('AuditLog').whereIn('target', made).del();
  await db('AuditLog').whereIn('actor', made).del();
  await db('User').whereIn('id', made).del();
});

function res() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function adminRow({ portalUser = true, aclPermissions = [], accountStatus = 'active', email } = {}) {
  const id = uniq('usr_esc');
  const row = {
    id, userType: 'admin', email: email || `${id}@example.com`, displayName: id,
    accountStatus, approvalStatus: 'approved', onboardingCompleted: true,
    portalUser, aclPermissions, createdAt: new Date().toISOString(),
  };
  await users.upsertAsync(u => u.id === id, row);
  made.push(id);
  return row;
}

// The token claims a signed-in portal user carries (see auth-service sessionClaims).
const claimsOf = row => ({ sub: row.id, userType: 'admin', email: row.email, portalUser: row.portalUser || false, aclPermissions: row.aclPermissions || [] });

async function put(callerClaims, targetId, body) {
  const out = res();
  await adminUpdatePortalUser.onRequest({ params: { id: targetId }, body, user: callerClaims }, out);
  return out;
}

const reload = id => users.findByIdAsync(id);
const refusals = (actor, action) => db('AuditLog').where({ actor, action });

// ── portalUser: super-admin only ────────────────────────────────────────────

test('staff with users cannot make themselves a super-admin', async () => {
  const staff = await adminRow({ aclPermissions: ['users'] });
  const out = await put(claimsOf(staff), staff.id, { portalUser: false });
  assert.equal(out.statusCode, 403);
  assert.equal(out.body.error, 'cannot_change_own_access');
  assert.equal((await reload(staff.id)).portalUser, true);
});

test('staff with users cannot make someone else a super-admin', async () => {
  const staff = await adminRow({ aclPermissions: ['users'] });
  const other = await adminRow({ aclPermissions: [] });
  const out = await put(claimsOf(staff), other.id, { portalUser: false });
  assert.equal(out.statusCode, 403);
  assert.equal(out.body.error, 'super_admin_required');
  assert.equal((await reload(other.id)).portalUser, true);
});

test('staff cannot edit a super-admin account (suspend, rename, re-scope)', async () => {
  const staff = await adminRow({ aclPermissions: ['users'] });
  const sup = await adminRow({ portalUser: false });
  for (const body of [{ accountStatus: 'suspended' }, { displayName: 'Hijacked' }, { portalUser: true }]) {
    const out = await put(claimsOf(staff), sup.id, body);
    assert.equal(out.statusCode, 403, JSON.stringify(body));
    assert.equal(out.body.error, 'super_admin_required');
  }
  const row = await reload(sup.id);
  assert.equal(row.accountStatus, 'active');
  assert.equal(row.displayName, sup.displayName);
  assert.ok(!row.portalUser);
});

test('the body cannot claim super-admin: the caller comes from the token', async () => {
  const staff = await adminRow({ aclPermissions: ['users'] });
  const other = await adminRow();
  const out = await put(claimsOf(staff), other.id, { portalUser: false, actor: { id: 'x', portalUser: false }, actorId: 'x' });
  assert.equal(out.statusCode, 403);
  assert.equal(out.body.error, 'super_admin_required');
});

test('a stale token claiming super-admin does not beat the stored row', async () => {
  const staff = await adminRow({ aclPermissions: ['users'] });
  const other = await adminRow();
  const out = await put({ ...claimsOf(staff), portalUser: false }, other.id, { portalUser: false });
  assert.equal(out.statusCode, 403);
  assert.equal(out.body.error, 'super_admin_required');
});

test('a token for an account that no longer exists is refused', async () => {
  const other = await adminRow();
  const out = await put({ sub: uniq('usr_gone'), userType: 'admin', portalUser: false }, other.id, { accountStatus: 'suspended' });
  assert.equal(out.statusCode, 403);
  assert.equal(out.body.error, 'actor_not_found');
});

// ── own access ──────────────────────────────────────────────────────────────

test('staff cannot change their own scopes or status, even within their own scopes', async () => {
  const staff = await adminRow({ aclPermissions: ['users', 'gyms'] });
  for (const body of [{ aclPermissions: ['users', 'gyms', 'settlements_pay'] }, { aclPermissions: ['users'] }, { accountStatus: 'suspended' }]) {
    const out = await put(claimsOf(staff), staff.id, body);
    assert.equal(out.statusCode, 403, JSON.stringify(body));
    assert.equal(out.body.error, 'cannot_change_own_access');
  }
  const row = await reload(staff.id);
  assert.deepEqual([...row.aclPermissions].sort(), ['gyms', 'users']);
  assert.equal(row.accountStatus, 'active');
});

test('a super-admin cannot change their own role or status either', async () => {
  const sup = await adminRow({ portalUser: false });
  const demote = await put(claimsOf(sup), sup.id, { portalUser: true });
  assert.equal(demote.statusCode, 403);
  assert.equal(demote.body.error, 'cannot_change_own_access');
  const suspend = await put(claimsOf(sup), sup.id, { accountStatus: 'suspended' });
  assert.equal(suspend.body.error, 'cannot_change_own_access');
});

test('self-edit of displayName works, and re-sending unchanged access values is not a change', async () => {
  const staff = await adminRow({ aclPermissions: ['users', 'gyms'] });
  // The portal edit dialog always sends aclPermissions, accountStatus and portalUser.
  const out = await put(claimsOf(staff), staff.id, {
    displayName: 'New Name', aclPermissions: ['gyms', 'users'], accountStatus: 'active', portalUser: true,
  });
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  assert.equal((await reload(staff.id)).displayName, 'New Name');
});

// ── grants limited to own scopes ────────────────────────────────────────────

test('staff cannot grant a scope they lack', async () => {
  const staff = await adminRow({ aclPermissions: ['users', 'gyms'] });
  const other = await adminRow({ aclPermissions: ['gyms'] });
  const out = await put(claimsOf(staff), other.id, { aclPermissions: ['gyms', 'settlements_pay'] });
  assert.equal(out.statusCode, 403);
  assert.equal(out.body.error, 'acl_grant_exceeds_own');
  assert.deepEqual(out.body.exceeding, ['settlements_pay']);
  assert.deepEqual((await reload(other.id)).aclPermissions, ['gyms']);
});

test('staff cannot remove a scope they lack, but may change their own scopes on others and keep the rest', async () => {
  const staff = await adminRow({ aclPermissions: ['users', 'gyms', 'shop'] });
  const other = await adminRow({ aclPermissions: ['gyms', 'payments'] });
  const remove = await put(claimsOf(staff), other.id, { aclPermissions: ['gyms'] });
  assert.equal(remove.statusCode, 403);
  assert.deepEqual(remove.body.exceeding, ['payments']);
  // payments is re-sent unchanged; shop is added, gyms removed — all within the caller's scopes.
  const ok = await put(claimsOf(staff), other.id, { aclPermissions: ['payments', 'shop'], accountStatus: 'active', portalUser: true });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.deepEqual([...(await reload(other.id)).aclPermissions].sort(), ['payments', 'shop']);
});

test('a scope dropped from the stored row no longer counts, even if the token still has it', async () => {
  const staff = await adminRow({ aclPermissions: ['users'] });
  const other = await adminRow({ aclPermissions: [] });
  const out = await put({ ...claimsOf(staff), aclPermissions: ['users', 'kyc'] }, other.id, { aclPermissions: ['kyc'] });
  assert.equal(out.statusCode, 403);
  assert.deepEqual(out.body.exceeding, ['kyc']);
});

test('staff may suspend another staff account', async () => {
  const staff = await adminRow({ aclPermissions: ['users'] });
  const other = await adminRow({ aclPermissions: [] });
  const out = await put(claimsOf(staff), other.id, { accountStatus: 'suspended' });
  assert.equal(out.statusCode, 200);
  assert.equal((await reload(other.id)).accountStatus, 'suspended');
});

// ── super-admin can do all ──────────────────────────────────────────────────

test('a super-admin can promote, demote, re-scope and suspend others', async () => {
  const sup = await adminRow({ portalUser: false });
  const other = await adminRow({ aclPermissions: [] });
  const scope = await put(claimsOf(sup), other.id, { aclPermissions: ['settlements_pay', 'users'] });
  assert.equal(scope.statusCode, 200);
  const promote = await put(claimsOf(sup), other.id, { portalUser: false });
  assert.equal(promote.statusCode, 200);
  assert.equal(promote.body.portalUser, false);
  const demote = await put(claimsOf(sup), other.id, { portalUser: true, accountStatus: 'suspended' });
  assert.equal(demote.statusCode, 200);
  const row = await reload(other.id);
  assert.equal(row.portalUser, true);
  assert.equal(row.accountStatus, 'suspended');
  const audited = await db('AuditLog').where({ actor: sup.id, target: other.id, action: 'portal_user_updated' });
  assert.equal(audited.length, 3);
});

// ── audit of refused attempts ───────────────────────────────────────────────

test('refused attempts are audited with the actor and the requested change', async () => {
  const staff = await adminRow({ aclPermissions: ['users'] });
  const other = await adminRow();
  await put(claimsOf(staff), staff.id, { portalUser: false });
  await put(claimsOf(staff), other.id, { aclPermissions: ['payments'] });
  const rows = await refusals(staff.id, 'portal_user_update_refused');
  assert.equal(rows.length, 2);
  const parse = v => (typeof v === 'string' ? JSON.parse(v) : v);
  const self = rows.find(r => r.target === staff.id);
  assert.equal(parse(self.after).refused, 'cannot_change_own_access');
  assert.equal(parse(self.after).requested.portalUser, false);
  const grant = rows.find(r => r.target === other.id);
  assert.equal(parse(grant.after).refused, 'acl_grant_exceeds_own');
  assert.deepEqual(parse(grant.after).requested.aclPermissions, ['payments']);
});

// ── env admin immutability (unchanged) ──────────────────────────────────────

test('env-configured admins stay immutable, even to a super-admin', async () => {
  const envEmail = `${uniq('envadmin')}@example.com`;
  const env = await adminRow({ portalUser: false, email: envEmail });
  const sup = await adminRow({ portalUser: false });
  const svc = createPortalUserService({
    users, auditLog, initFirebaseAdmin() {}, getAdminAuth() {}, isConfiguredAdminEmail: e => e === envEmail,
  });
  const out = await svc.update({ id: env.id, portalUser: true, actor: { id: sup.id, portalUser: false } });
  assert.equal(out.error, 'env_admin_immutable');
  assert.equal(out.status, 403);
});

test('an env-configured admin counts as super-admin even if its row says portalUser', async () => {
  const envEmail = `${uniq('envadmin')}@example.com`;
  const env = await adminRow({ portalUser: true, aclPermissions: ['users'], email: envEmail });
  const other = await adminRow();
  const svc = createPortalUserService({
    users, auditLog, initFirebaseAdmin() {}, getAdminAuth() {}, isConfiguredAdminEmail: e => e === envEmail,
  });
  const out = await svc.update({ id: other.id, portalUser: false, actor: { id: env.id, portalUser: true, aclPermissions: ['users'] } });
  assert.ok(!out.error, JSON.stringify(out));
  assert.equal(out.user.portalUser, false);
});

// ── create() ────────────────────────────────────────────────────────────────

function createService() {
  const uids = [];
  return createPortalUserService({
    users, auditLog, initFirebaseAdmin() {},
    getAdminAuth: () => ({ createUser: async () => { const uid = uniq('fb_esc'); uids.push(uid); return { uid }; } }),
    isConfiguredAdminEmail: () => false,
  });
}

test('create() by staff cannot grant scopes beyond their own, and is audited', async () => {
  const staff = await adminRow({ aclPermissions: ['users', 'gyms'] });
  const out = await createService().create({
    email: `${uniq('new')}@example.com`, password: 'pw-123456', aclPermissions: ['gyms', 'settlements_pay'], actor: { id: staff.id, portalUser: true, aclPermissions: staff.aclPermissions },
  });
  assert.equal(out.error, 'acl_grant_exceeds_own');
  assert.equal(out.status, 403);
  assert.deepEqual(out.exceeding, ['settlements_pay']);
  const rows = await refusals(staff.id, 'portal_user_create_refused');
  assert.equal(rows.length, 1);
});

test('create() by staff within their scopes makes a portal user; portalUser:false in the body is ignored', async () => {
  const staff = await adminRow({ aclPermissions: ['users', 'gyms'] });
  const email = `${uniq('new')}@example.com`;
  const svc = createService();
  const result = await svc.create({ email, password: 'pw-123456', aclPermissions: ['gyms'], portalUser: false, actor: { id: staff.id, portalUser: true, aclPermissions: staff.aclPermissions } });
  assert.ok(!result.error, JSON.stringify(result));
  made.push(result.user.id);
  assert.equal(result.user.portalUser, true);
  assert.equal((await reload(result.user.id)).portalUser, true);
});

test('create() by a super-admin may grant any scope', async () => {
  const sup = await adminRow({ portalUser: false });
  const result = await createService().create({
    email: `${uniq('new')}@example.com`, password: 'pw-123456', aclPermissions: ['settlements_pay', 'users'], actor: { id: sup.id, portalUser: false },
  });
  assert.ok(!result.error, JSON.stringify(result));
  made.push(result.user.id);
  assert.deepEqual(result.user.aclPermissions, ['settlements_pay', 'users']);
});

test('the create route refuses staff granting beyond their scopes before touching Firebase', async () => {
  const staff = await adminRow({ aclPermissions: ['users'] });
  const out = res();
  await adminCreatePortalUser.onRequest({
    body: { email: `${uniq('new')}@example.com`, password: 'pw-123456', aclPermissions: ['payments'], portalUser: false },
    user: claimsOf(staff),
  }, out);
  assert.equal(out.statusCode, 403);
  assert.equal(out.body.error, 'acl_grant_exceeds_own');
  assert.deepEqual(out.body.exceeding, ['payments']);
});
