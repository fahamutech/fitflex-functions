// Identity V2 · I0 security fixes:
//   - an unverified Firebase email never claims a FitFlex row it doesn't own
//   - credential fields never leave the backend
//   - suspended accounts are refused even with a live token
//   - phone OTP endpoints are closed in production
//   - removing a staff/portal profile keeps a Firebase login other profiles use
//   - demo:<plaintext> passwords are rehashed
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { authFirebaseSession, authLogin, authRequestOtp, authVerifyOtp } from '../functions/auth.mjs';
import { me } from '../functions/subscriptions.mjs';
import { users } from '../src/bootstrap/services.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { requireAuth, sign } from '../src/auth/jwt.mjs';
import { hashPassword, verifyPassword } from '../src/auth/password-credentials.mjs';
import { normalizeEmail, sameEmail } from '../src/shared/identifiers.mjs';
import { toSessionUser } from '../src/shared/session-user.mjs';
import { createOwnerStaffService } from '../src/services/owner-staff-service.mjs';
import { createPortalUserService } from '../src/services/portal-user-service.mjs';
import rehashMigration from '../db/migrations/20261021090000-rehash-demo-passwords.cjs';

function devToken(payload) {
  return `dev:${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

function res() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const uniq = prefix => `${prefix}_${randomUUID().slice(0, 8)}`;

async function session(payload, requestedRole) {
  const out = res();
  await authFirebaseSession.onRequest({ body: { idToken: devToken(payload), requestedRole } }, out);
  return out;
}

async function uidlessRow(overrides = {}) {
  const row = {
    id: uniq('usr_i0'), email: `${uniq('staffmade')}@example.com`, userType: 'gym_operator',
    accountStatus: 'active', approvalStatus: 'approved', createdAt: new Date().toISOString(), ...overrides,
  };
  await users.upsertAsync(u => u.id === row.id, row);
  return row;
}

// ── Verified-email rule ─────────────────────────────────────────────────────

test('an unverified email cannot claim a uid-less row created by staff', async () => {
  const row = await uidlessRow();
  const out = await session({ uid: uniq('fb_attacker'), email: row.email, email_verified: false });
  assert.equal(out.statusCode, 409);
  assert.equal(out.body.error, 'email_verification_required');
  const after = await users.findByIdAsync(row.id);
  assert.equal(after.firebaseUid ?? null, null, 'row must stay unclaimed');
});

test('an unverified email naming the uid-less row\'s role is also refused', async () => {
  const row = await uidlessRow({ userType: 'trainer' });
  const out = await session({ uid: uniq('fb_attacker'), email: row.email, email_verified: false }, 'trainer');
  assert.equal(out.statusCode, 409);
  assert.equal(out.body.error, 'email_verification_required');
});

test('a verified email claims the uid-less row and links the Firebase uid', async () => {
  const row = await uidlessRow();
  const uid = uniq('fb_owner');
  const out = await session({ uid, email: row.email.toUpperCase(), email_verified: true });
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.user.id, row.id);
  assert.equal((await users.findByIdAsync(row.id)).firebaseUid, uid);
});

test('an unverified email still signs into the row this uid already owns', async () => {
  const uid = uniq('fb_member');
  const email = `${uniq('own')}@example.com`;
  const first = await session({ uid, email, email_verified: false }, 'member');
  assert.equal(first.statusCode, 200);
  const other = await uidlessRow({ email, userType: 'trainer' });

  const again = await session({ uid, email, email_verified: false });
  assert.equal(again.statusCode, 200);
  assert.equal(again.body.user.id, first.body.user.id);
  assert.equal((await users.findByIdAsync(other.id)).firebaseUid ?? null, null);
});

test('the configured admin email only maps to admin once verified', async () => {
  const unverified = await session({ uid: uniq('fb_fake_admin'), email: 'mama27j@gmail.com', email_verified: false }, 'member');
  assert.notEqual(unverified.body?.user?.userType, 'admin');
});

// ── Credential fields never leave the backend ───────────────────────────────

test('toSessionUser strips password and PIN hashes', () => {
  const safe = toSessionUser({ id: 'u', passwordHash: 'scrypt:x:y', pinHash: 'p', email: 'a@b.c' });
  assert.deepEqual(safe, { id: 'u', email: 'a@b.c' });
  assert.equal(toSessionUser(null), null);
});

test('session and /me responses carry no passwordHash', async () => {
  const uid = uniq('fb_hash');
  const row = await uidlessRow({ firebaseUid: uid, passwordHash: await hashPassword('1234'), userType: 'trainer' });
  const out = await session({ uid, email: row.email });
  assert.equal(out.statusCode, 200);
  assert.equal('passwordHash' in out.body.user, false);

  const meOut = res();
  await me.onRequest({ user: { sub: row.id, userType: 'trainer' } }, meOut);
  assert.equal(meOut.statusCode, 200);
  assert.equal('passwordHash' in meOut.body.user, false);
});

test('password login matches email case-insensitively and hides the hash', async () => {
  const email = `${uniq('login')}@example.com`;
  await uidlessRow({ email, userType: 'admin', passwordHash: await hashPassword('pw-123456') });
  const out = res();
  await authLogin.onRequest({ body: { email: email.toUpperCase(), password: 'pw-123456', requestedRole: 'admin' } }, out);
  assert.equal(out.statusCode, 200);
  assert.equal('passwordHash' in out.body.user, false);
});

// ── Suspended accounts ──────────────────────────────────────────────────────

async function runGuard(guard, token) {
  const out = res();
  let passed = false;
  await guard({ headers: { authorization: `Bearer ${token}` } }, out, () => { passed = true; });
  return { out, passed };
}

test('requireAuth refuses a live token for a suspended account', async () => {
  const row = await uidlessRow({ userType: 'member', accountStatus: 'suspended' });
  const { out, passed } = await runGuard(requireAuth('member'), sign({ sub: row.id, userType: 'member' }));
  assert.equal(passed, false);
  assert.equal(out.statusCode, 403);
  assert.equal(out.body.error, 'account_suspended');
});

test('requireAuth still admits active accounts and tokens without a row', async () => {
  const row = await uidlessRow({ userType: 'member' });
  assert.equal((await runGuard(requireAuth('member'), sign({ sub: row.id, userType: 'member' }))).passed, true);
  // Some flows provision the row after the token is minted; they keep working.
  assert.equal((await runGuard(requireAuth(), sign({ sub: uniq('usr_norow'), userType: 'member' }))).passed, true);
});

// ── Phone OTP closed in production ──────────────────────────────────────────

test('phone OTP endpoints return 404 in production', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    for (const endpoint of [authRequestOtp, authVerifyOtp]) {
      const out = res();
      await endpoint.onRequest({ body: { phone: '+255700000000', userType: 'admin', code: '000000' } }, out);
      assert.equal(out.statusCode, 404);
    }
  } finally {
    process.env.NODE_ENV = previous;
  }
});

// ── Shared Firebase login survives profile removal ──────────────────────────

function memoryUsers(rows) {
  return {
    rows,
    async findAsync(p) { return rows.find(p) || null; },
    async removeAsync(p) { const i = rows.findIndex(p); if (i >= 0) rows.splice(i, 1); },
  };
}

function fakeAdminAuth() {
  const deleted = [];
  return { deleted, getAdminAuth: () => ({ deleteUser: async uid => { deleted.push(uid); } }) };
}

const auditLog = { insertAsync: async () => {} };

test('removing gym staff keeps a Firebase login the person\'s member profile uses', async () => {
  const rows = [
    { id: 'usr_staff', userType: 'gym_staff', gymIds: ['gym_1'], firebaseUid: 'fb_shared' },
    { id: 'usr_member', userType: 'member', firebaseUid: 'fb_shared' },
  ];
  const fb = fakeAdminAuth();
  const svc = createOwnerStaffService({ users: memoryUsers(rows), auditLog, initFirebaseAdmin: () => {}, getAdminAuth: fb.getAdminAuth });
  const result = await svc.remove({ ownerGymIds: ['gym_1'], staffId: 'usr_staff', actorId: 'own' });
  assert.equal(result.ok, true);
  assert.deepEqual(fb.deleted, []);
  assert.deepEqual(rows.map(r => r.id), ['usr_member']);
});

test('removing gym staff with an unshared login still deletes the Firebase user', async () => {
  const rows = [{ id: 'usr_staff', userType: 'gym_staff', gymIds: ['gym_1'], firebaseUid: 'fb_own' }];
  const fb = fakeAdminAuth();
  const svc = createOwnerStaffService({ users: memoryUsers(rows), auditLog, initFirebaseAdmin: () => {}, getAdminAuth: fb.getAdminAuth });
  await svc.remove({ ownerGymIds: ['gym_1'], staffId: 'usr_staff', actorId: 'own' });
  assert.deepEqual(fb.deleted, ['fb_own']);
});

test('removing a portal user keeps a Firebase login shared with another profile', async () => {
  const rows = [
    { id: 'usr_portal', userType: 'admin', portalUser: true, email: 'staff@example.com', firebaseUid: 'fb_shared' },
    { id: 'usr_trainer', userType: 'trainer', firebaseUid: 'fb_shared' },
  ];
  const fb = fakeAdminAuth();
  const svc = createPortalUserService({
    users: memoryUsers(rows), auditLog, initFirebaseAdmin: () => {}, getAdminAuth: fb.getAdminAuth,
    isConfiguredAdminEmail: () => false,
  });
  const result = await svc.remove({ id: 'usr_portal', requesterId: 'usr_admin', actorId: 'usr_admin' });
  assert.equal(result.ok, true);
  assert.deepEqual(fb.deleted, []);
});

// ── Email normalisation ─────────────────────────────────────────────────────

test('emails normalise to trimmed lower case', () => {
  assert.equal(normalizeEmail('  Coach@Example.COM '), 'coach@example.com');
  assert.equal(normalizeEmail(''), null);
  assert.equal(normalizeEmail(null), null);
  assert.equal(sameEmail('A@x.io', ' a@X.io'), true);
  assert.equal(sameEmail(null, null), false);
});

// ── demo:<plaintext> rehash migration ───────────────────────────────────────

test('the rehash migration replaces demo passwords with working scrypt hashes', async () => {
  const id = uniq('usr_demo');
  await db('User').insert({
    id, userType: 'trainer', email: `${id}@example.com`, passwordHash: 'demo:4321',
    accountStatus: 'active', approvalStatus: 'approved', createdAt: new Date(), updatedAt: new Date(),
  });
  await rehashMigration.up(db);
  const { passwordHash } = await db('User').where({ id }).first();
  assert.match(passwordHash, /^scrypt:/);
  assert.equal(await verifyPassword('4321', passwordHash), true);
  const left = await db('User').where('passwordHash', 'like', 'demo:%').count({ n: '*' }).first();
  assert.equal(Number(left.n), 0);
  // Idempotent: a second run changes nothing.
  await rehashMigration.up(db);
  assert.equal((await db('User').where({ id }).first()).passwordHash, passwordHash);
});
