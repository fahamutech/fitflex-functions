// Identity V2 · I5 — membership-based organisation authorisation behind a
// compatibility layer. Off: legacy rules, unchanged. Shadow: legacy decides,
// disagreements are recorded. Enforce: an ACTIVE OrgMembership decides which
// gyms a persona acts on and which scopes staff hold there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerListMembers, ownerMemberDetail, ownerSuspendMember } from '../functions/owner-members.mjs';
import { ownerListStaff } from '../functions/owner-staff.mjs';
import { adminOrgAuthzReport } from '../functions/auth.mjs';
import { users, subscriptions } from '../src/bootstrap/services.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { orgAuthzStats, resetOrgAuthzStats, registerOrgMembershipLookup } from '../src/auth/org-authz.mjs';

const uniq = p => `${p}_${randomUUID().slice(0, 8)}`;
const days = n => new Date(Date.now() + n * 864e5).toISOString();

function res() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

/** Run a route the way the framework does: guards in order, then the handler. */
async function call(route, claims, { params = {}, body = {}, query = {} } = {}) {
  const req = { headers: { authorization: `Bearer ${sign(claims)}` }, params, body, query };
  const out = res();
  for (const guard of [route.onGuard].flat()) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return out;
}

async function withMode(mode, fn) {
  const saved = { a: process.env.IDENTITY_V2, b: process.env.V2_ORG_AUTHZ };
  delete process.env.IDENTITY_V2; delete process.env.V2_ORG_AUTHZ;
  if (mode !== 'off') { process.env.IDENTITY_V2 = 'true'; process.env.V2_ORG_AUTHZ = mode === 'enforce' ? 'true' : 'shadow'; }
  resetOrgAuthzStats();
  try { return await fn(); } finally {
    if (saved.a === undefined) delete process.env.IDENTITY_V2; else process.env.IDENTITY_V2 = saved.a;
    if (saved.b === undefined) delete process.env.V2_ORG_AUTHZ; else process.env.V2_ORG_AUTHZ = saved.b;
  }
}

async function makeGym() {
  const id = uniq('gym_i5');
  await db('Gym').insert({ id, name: `I5 ${id}`, tier: 'standard', location: 'Dar es Salaam', status: 'active', updatedAt: new Date() });
  return id;
}
async function makeUser(overrides = {}) {
  const row = {
    id: uniq('usr_i5'), userType: 'member', accountStatus: 'active', approvalStatus: 'approved',
    createdAt: new Date().toISOString(), ...overrides,
  };
  await users.upsertAsync(u => u.id === row.id, row);
  return db('User').where({ id: row.id }).first();
}
async function directMember(gymId) {
  const member = await makeUser({ displayName: 'Member' });
  await subscriptions.insertAsync({
    id: uniq('sub'), memberId: member.id, type: 'direct_sub', tier: 'standard', status: 'active', homeGymId: gymId,
    startedAt: new Date().toISOString(), cycleStartedAt: new Date().toISOString(), renewsAt: days(30), expiresAt: days(30),
  });
  return member;
}
const staffClaims = (staff, aclPermissions) => ({ sub: staff.id, userType: 'gym_staff', aclPermissions });
const ownerClaims = owner => ({ sub: owner.id, userType: 'gym_operator' });
const membership = (personaId, gymId) => db('OrgMembership').where({ personaId, gymId });

// ── Off: legacy, unchanged ─────────────────────────────────────────────────

test('off: the JWT ACL decides exactly as before and memberships are not read', async () => {
  await withMode('off', async () => {
    const gym = await makeGym();
    const staff = await makeUser({ userType: 'gym_staff', gymIds: [gym], aclPermissions: ['members'] });
    assert.equal((await call(ownerListMembers, staffClaims(staff, ['members']))).statusCode, 200);
    const denied = await call(ownerListMembers, staffClaims(staff, ['checkins']));
    assert.equal(denied.statusCode, 403);
    assert.deepEqual(denied.body, { error: 'acl_forbidden', requiredScope: 'members' });
    assert.equal(orgAuthzStats().checks, 0);
    assert.equal(orgAuthzStats().mode, 'off');
  });
});

// ── Stale token permissions ────────────────────────────────────────────────

async function staffWithReducedAcl() {
  const gym = await makeGym();
  const staff = await makeUser({ userType: 'gym_staff', gymIds: [gym], aclPermissions: ['members'] });
  // The owner later reduces the staff member's permissions; their token is older.
  await users.upsertAsync(u => u.id === staff.id, { ...staff, aclPermissions: ['checkins'] });
  assert.deepEqual((await membership(staff.id, gym).first()).aclPermissions, ['checkins']);
  return { staff, staleToken: staffClaims(staff, ['members']) };
}

test('shadow: legacy still decides, and the disagreement is recorded per route', async () => {
  await withMode('shadow', async () => {
    const { staleToken } = await staffWithReducedAcl();
    const out = await call(ownerListMembers, staleToken);
    assert.equal(out.statusCode, 200, 'behaviour is unchanged in shadow');
    const stats = orgAuthzStats();
    assert.equal(stats.mode, 'shadow');
    assert.ok(stats.mismatches >= 1);
    assert.ok(stats.byRoute['GET /owner/members'] >= 1);
  });
});

test('enforce: reduced permissions apply on the next request, not at token expiry', async () => {
  await withMode('enforce', async () => {
    const { staff, staleToken } = await staffWithReducedAcl();
    assert.equal((await call(ownerListMembers, staleToken)).statusCode, 403);
    // And the reverse: a scope granted after the token was issued works at once.
    await users.upsertAsync(u => u.id === staff.id, { ...staff, aclPermissions: ['members'] });
    assert.equal((await call(ownerListMembers, staffClaims(staff, []))).statusCode, 200);
  });
});

// ── Membership status ──────────────────────────────────────────────────────

test('enforce: a suspended or ended membership grants nothing', async () => {
  await withMode('enforce', async () => {
    const gym = await makeGym();
    const staff = await makeUser({ userType: 'gym_staff', gymIds: [gym], aclPermissions: ['members'] });
    const claims = staffClaims(staff, ['members']);
    assert.equal((await call(ownerListMembers, claims)).statusCode, 200);
    for (const status of ['suspended', 'removed']) {
      await membership(staff.id, gym).update({ status });
      assert.equal((await call(ownerListMembers, claims)).statusCode, 403, status);
    }
  });
});

// ── Organisation boundaries ────────────────────────────────────────────────

test('enforce: staff permissions are per gym', async () => {
  await withMode('enforce', async () => {
    const [gymA, gymB] = [await makeGym(), await makeGym()];
    const staff = await makeUser({ userType: 'gym_staff', gymIds: [gymA, gymB], aclPermissions: ['members'] });
    await membership(staff.id, gymB).update({ aclPermissions: ['checkins'] }); // members only at Gym A
    const [memberA, memberB] = [await directMember(gymA), await directMember(gymB)];
    const claims = staffClaims(staff, ['members']);
    assert.equal((await call(ownerMemberDetail, claims, { params: { memberId: memberA.id } })).statusCode, 200);
    const other = await call(ownerMemberDetail, claims, { params: { memberId: memberB.id } });
    assert.equal(other.statusCode, 403);
    assert.equal(other.body.error, 'not_your_member');
  });
});

test('a gym\'s staff can never act on another organisation\'s member, in any mode', async () => {
  const [gymA, gymB] = [await makeGym(), await makeGym()];
  const staff = await makeUser({ userType: 'gym_staff', gymIds: [gymA], aclPermissions: ['members'] });
  const stranger = await directMember(gymB);
  for (const mode of ['off', 'shadow', 'enforce']) {
    await withMode(mode, async () => {
      const claims = staffClaims(staff, ['members']);
      assert.equal((await call(ownerMemberDetail, claims, { params: { memberId: stranger.id } })).statusCode, 403, mode);
      assert.equal((await call(ownerSuspendMember, claims, { params: { memberId: stranger.id }, body: { suspend: true } })).statusCode, 403, mode);
    });
  }
});

test('an owner acts only on gyms they actively own (enforce); shadow records the difference', async () => {
  const [g1, g2] = [await makeGym(), await makeGym()];
  const owner = await makeUser({ userType: 'gym_operator', gymIds: [g1, g2] });
  const staffAtG2 = await makeUser({ userType: 'gym_staff', gymIds: [g2], aclPermissions: [] });
  // The owner's relationship with the second gym has ended, but the legacy
  // column still lists it.
  await membership(owner.id, g2).update({ status: 'removed' });
  const listed = async () => (await call(ownerListStaff, ownerClaims(owner))).body.map(s => s.id);

  await withMode('off', async () => assert.ok((await listed()).includes(staffAtG2.id)));
  await withMode('shadow', async () => {
    assert.ok((await listed()).includes(staffAtG2.id), 'unchanged in shadow');
    assert.ok(orgAuthzStats().byRoute['GET /owner/staff'] >= 1, 'gym-set difference recorded');
  });
  await withMode('enforce', async () => assert.equal((await listed()).includes(staffAtG2.id), false));
});

// ── Role and persona still gate first ──────────────────────────────────────

test('persona and role checks are unchanged', async () => {
  const gym = await makeGym();
  const staff = await makeUser({ userType: 'gym_staff', gymIds: [gym], aclPermissions: ['members'] });
  const trainer = await makeUser({ userType: 'trainer' });
  for (const mode of ['off', 'enforce']) {
    await withMode(mode, async () => {
      assert.equal((await call(ownerListMembers, { sub: trainer.id, userType: 'trainer' })).statusCode, 403, 'a trainer is not gym staff');
      assert.equal((await call(ownerListStaff, staffClaims(staff, ['members']))).statusCode, 403, 'staff cannot administer staff');
    });
  }
});

test('an owner with no gym yet still reaches an empty list', async () => {
  await withMode('enforce', async () => {
    const owner = await makeUser({ userType: 'gym_operator', gymIds: [] });
    const out = await call(ownerListStaff, ownerClaims(owner));
    assert.equal(out.statusCode, 200);
    assert.deepEqual(out.body, []);
  });
});

// ── Safety net and reporting ───────────────────────────────────────────────

test('if the membership read fails, the legacy decision is used', async () => {
  await withMode('enforce', async () => {
    const gym = await makeGym();
    const staff = await makeUser({ userType: 'gym_staff', gymIds: [gym], aclPermissions: ['members'] });
    const working = personaId => db('OrgMembership').where({ personaId, orgType: 'gym' })
      .whereIn('role', ['owner', 'staff']).select('gymId', 'role', 'status', 'aclPermissions');
    registerOrgMembershipLookup(async () => { throw new Error('db down'); });
    try {
      assert.equal((await call(ownerListMembers, staffClaims(staff, ['members']))).statusCode, 200);
      assert.equal((await call(ownerListMembers, staffClaims(staff, []))).statusCode, 403);
    } finally {
      registerOrgMembershipLookup(working);
    }
  });
});

test('admins can read the mode and comparison counts', async () => {
  await withMode('shadow', async () => {
    await staffWithReducedAcl().then(({ staleToken }) => call(ownerListMembers, staleToken));
    const admin = await makeUser({ userType: 'admin' });
    const out = await call(adminOrgAuthzReport, { sub: admin.id, userType: 'admin' });
    assert.equal(out.statusCode, 200);
    assert.equal(out.body.mode, 'shadow');
    assert.ok(out.body.checks >= 1 && out.body.mismatches >= 1);
    assert.equal((await call(adminOrgAuthzReport, { sub: admin.id, userType: 'gym_operator' })).statusCode, 403);
  });
});
