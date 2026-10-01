// Identity V2 · I4 — organisation memberships.
// OrgMembership mirrors a Person's gym and vendor relationships from today's
// sources, with an explicit lifecycle. Suspension is the membership's, never
// the Person's; vendor ids stay the vendor's User.id; nothing is hard-deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { myMemberships } from '../functions/auth.mjs';
import { users, trainers, subscriptions, orgMembershipService } from '../src/bootstrap/services.mjs';
import { db } from '../src/infra/knex-store.mjs';

const uniq = p => `${p}_${randomUUID().slice(0, 8)}`;
const days = n => new Date(Date.now() + n * 864e5);

function res() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

async function makeGym() {
  const id = uniq('gym_i4');
  await db('Gym').insert({ id, name: `I4 ${id}`, tier: 'standard', location: 'Dar es Salaam', status: 'active', updatedAt: new Date() });
  return id;
}
async function makeUser(overrides = {}) {
  const row = {
    id: uniq('usr_i4'), userType: 'member', accountStatus: 'active', approvalStatus: 'approved',
    createdAt: new Date().toISOString(), ...overrides,
  };
  await users.upsertAsync(u => u.id === row.id, row);
  return db('User').where({ id: row.id }).first();
}
const save = (user, patch) => users.upsertAsync(u => u.id === user.id, { ...user, ...patch });
const membershipsOf = personaId => db('OrgMembership').where({ personaId }).orderBy('createdAt');
const one = async where => db('OrgMembership').where(where).first();
async function directSub(memberId, gymId, overrides = {}) {
  const row = {
    id: uniq('sub'), memberId, type: 'direct_sub', tier: 'standard', status: 'active', homeGymId: gymId,
    startedAt: new Date().toISOString(), cycleStartedAt: new Date().toISOString(),
    renewsAt: days(30).toISOString(), expiresAt: days(30).toISOString(), ...overrides,
  };
  await subscriptions.insertAsync(row);
  return row;
}

// ── Gym owner and staff ────────────────────────────────────────────────────

test('a gym owner gets an owner membership per gym, ended (not deleted) when a gym is dropped', async () => {
  const [g1, g2] = [await makeGym(), await makeGym()];
  const owner = await makeUser({ userType: 'gym_operator', gymIds: [g1, g2], gymId: g1 });
  let rows = await membershipsOf(owner.id);
  assert.deepEqual(rows.map(m => [m.gymId, m.role, m.status]).sort(), [[g1, 'owner', 'active'], [g2, 'owner', 'active']].sort());
  assert.ok(rows.every(m => m.personId === owner.personId && m.orgType === 'gym'));

  await save(owner, { gymIds: [g1] });
  rows = await membershipsOf(owner.id);
  assert.equal(rows.length, 2, 'the row is kept as history');
  const dropped = rows.find(m => m.gymId === g2);
  assert.equal(dropped.status, 'removed');
  assert.ok(dropped.endedAt);
  assert.deepEqual((await db('User').where({ id: owner.id }).first()).gymIds, [g1], 'the source column is untouched');
});

test('gym staff carry their ACL on the membership; suspending them suspends only that membership', async () => {
  const gym = await makeGym();
  const uid = uniq('fb');
  const member = await makeUser({ firebaseUid: uid });
  const staff = await makeUser({ firebaseUid: uid, userType: 'gym_staff', gymIds: [gym], gymId: gym, aclPermissions: ['members', 'checkins'] });
  assert.equal(staff.personId, member.personId, 'two personas of one Person');
  let m = await one({ personaId: staff.id });
  assert.deepEqual([m.role, m.status, [...m.aclPermissions].sort()], ['staff', 'active', ['checkins', 'members']]);

  await save(staff, { accountStatus: 'suspended', aclPermissions: ['members'] });
  m = await one({ personaId: staff.id });
  assert.equal(m.status, 'suspended');
  assert.deepEqual(m.aclPermissions, ['members']);
  assert.equal((await db('Person').where({ id: staff.personId }).first()).status, 'active', 'the Person is not suspended');
  assert.equal((await db('User').where({ id: member.id }).first()).accountStatus, 'active', 'the other persona is untouched');
});

// ── Trainers ───────────────────────────────────────────────────────────────

test('a trainer is requested at a gym they applied to and active once joined', async () => {
  const [joined, applied] = [await makeGym(), await makeGym()];
  const trainer = await makeUser({ userType: 'trainer' });
  const profile = { id: uniq('trn'), userId: trainer.id, displayName: 'Coach', gymIds: [joined], pendingGymIds: [applied] };
  await trainers.upsertAsync(t => t.id === profile.id, profile);
  let rows = await membershipsOf(trainer.id);
  assert.deepEqual(rows.map(m => [m.gymId, m.status]).sort(), [[applied, 'requested'], [joined, 'active']].sort());

  // The owner approves the application.
  await trainers.updateAsync(t => t.id === profile.id, { gymIds: [joined, applied], pendingGymIds: [] });
  assert.equal((await one({ personaId: trainer.id, gymId: applied })).status, 'active');

  // The trainer stops working at the first gym.
  await trainers.updateAsync(t => t.id === profile.id, { gymIds: [applied] });
  const left = await one({ personaId: trainer.id, gymId: joined });
  assert.equal(left.status, 'removed');
  assert.ok(left.endedAt);
});

// ── Members: suspension is the membership's ────────────────────────────────

test('a gym pausing a member suspends that membership only', async () => {
  const [gymA, gymB] = [await makeGym(), await makeGym()];
  const uid = uniq('fb');
  const member = await makeUser({ firebaseUid: uid });
  const trainer = await makeUser({ firebaseUid: uid, userType: 'trainer' });
  const subA = await directSub(member.id, gymA);
  await directSub(member.id, gymB);
  assert.equal((await one({ personaId: member.id, gymId: gymA })).status, 'active');

  // What the owner's "suspend member" does today: pause the plan at their gym.
  await subscriptions.updateByIdAsync(subA.id, { status: 'suspended' });

  assert.equal((await one({ personaId: member.id, gymId: gymA })).status, 'suspended');
  assert.equal((await one({ personaId: member.id, gymId: gymB })).status, 'active', 'Gym B is unaffected');
  assert.equal((await db('User').where({ id: member.id }).first()).accountStatus, 'active', 'the member persona is not suspended');
  assert.equal((await db('User').where({ id: trainer.id }).first()).accountStatus, 'active', 'the trainer persona is not suspended');
  assert.equal((await db('Person').where({ id: member.personId }).first()).status, 'active', 'the Person is not suspended');

  await subscriptions.updateByIdAsync(subA.id, { status: 'active' });
  assert.equal((await one({ personaId: member.id, gymId: gymA })).status, 'active');
});

test('an expired plan ends the membership as left; rejoining starts a new one', async () => {
  const gym = await makeGym();
  const member = await makeUser();
  const old = await directSub(member.id, gym, { startedAt: days(-40).toISOString(), expiresAt: days(-10).toISOString() });
  let rows = await membershipsOf(member.id);
  assert.deepEqual(rows.map(m => m.status), ['left']);
  assert.equal(+new Date(rows[0].endedAt), +new Date(old.expiresAt));

  await directSub(member.id, gym);
  rows = await membershipsOf(member.id);
  assert.deepEqual(rows.map(m => m.status).sort(), ['active', 'left'], 'history is kept beside the new membership');
});

test('a FitFlex Pass (not a direct plan) is not a gym membership', async () => {
  const member = await makeUser();
  await subscriptions.insertAsync({
    id: uniq('sub'), memberId: member.id, type: 'platform_pass', tier: 'basic', status: 'active',
    startedAt: new Date().toISOString(), cycleStartedAt: new Date().toISOString(),
    renewsAt: days(30).toISOString(), expiresAt: days(30).toISOString(),
  });
  assert.equal((await membershipsOf(member.id)).length, 0);
});

// ── Vendors: ids stay the vendor's User.id ─────────────────────────────────

test('a vendor gets a Vendor record with the same id as its User row, and staff join it', async () => {
  const vendorUser = await makeUser({ userType: 'vendor', displayName: 'Asha', vendorProfile: { businessName: 'Asha Fitness Store' } });
  const vendor = await db('Vendor').where({ id: vendorUser.id }).first();
  assert.ok(vendor, 'Vendor.id is the existing vendor User.id');
  assert.equal(vendor.name, 'Asha Fitness Store');
  const owner = await one({ personaId: vendorUser.id });
  assert.deepEqual([owner.orgType, owner.vendorId, owner.role, owner.status], ['vendor', vendorUser.id, 'owner', 'active']);
  assert.equal((await db('User').where({ id: vendorUser.id }).first()).vendorProfile.businessName, 'Asha Fitness Store', 'the store profile stays on the User row');

  const staff = await makeUser({ userType: 'vendor_staff', vendorId: vendorUser.id, vendorPermissions: ['orders'] });
  let m = await one({ personaId: staff.id });
  assert.deepEqual([m.vendorId, m.role, m.status, m.aclPermissions], [vendorUser.id, 'staff', 'active', ['orders']]);
  await save(staff, { accountStatus: 'suspended' });
  m = await one({ personaId: staff.id });
  assert.equal(m.status, 'suspended');
  assert.equal((await db('Vendor').count({ n: '*' }).where({ id: staff.id }).first()).n, '0', 'staff never get a store of their own');
});

// ── Lifecycle and integrity ────────────────────────────────────────────────

test('the database enforces organisation, role, status and one live membership', async () => {
  const gym = await makeGym();
  const owner = await makeUser({ userType: 'gym_operator', gymIds: [gym] });
  const base = { personId: owner.personId, personaId: owner.id, orgType: 'gym', gymId: gym, role: 'staff', status: 'active' };
  const insert = extra => db('OrgMembership').insert({ id: uniq('om'), ...base, ...extra });
  await assert.rejects(insert({ status: 'paused' }), /org_membership_status_check/);
  await assert.rejects(insert({ role: 'hr_admin' }), /org_membership_role_check/);
  await assert.rejects(insert({ gymId: null }), /org_membership_one_org_check/);
  // Either check may fire first for an unsupported organisation type.
  await assert.rejects(insert({ orgType: 'corporate' }), /org_membership_(org_type|one_org)_check/);
  await assert.rejects(insert({ role: 'owner' }), /org_membership_gym_live_unique/);
});

test('removing a persona ends its memberships without deleting them', async () => {
  const gym = await makeGym();
  const staff = await makeUser({ userType: 'gym_staff', gymIds: [gym] });
  const before = await one({ personaId: staff.id });
  await users.removeAsync(u => u.id === staff.id);
  const after = await db('OrgMembership').where({ id: before.id }).first();
  assert.equal(after.status, 'removed');
  assert.equal(after.personaId, null);
  assert.equal(after.personId, staff.personId, 'still the same Person');
});

test('the drift check finds a missing membership, apply repairs it, and re-running changes nothing', async () => {
  const gym = await makeGym();
  const owner = await makeUser({ userType: 'gym_operator', gymIds: [gym] });
  await orgMembershipService.syncAll({ apply: true });
  const clean = await orgMembershipService.syncAll({ apply: false });
  assert.equal(clean.inserted + clean.updated + clean.ended + clean.vendors, 0, 'in step after the hooks');

  await db('OrgMembership').where({ personaId: owner.id }).del();
  const drift = await orgMembershipService.syncAll({ apply: false });
  assert.equal(drift.inserted, 1);
  assert.equal((await membershipsOf(owner.id)).length, 0, 'a dry run writes nothing');

  await orgMembershipService.syncAll({ apply: true });
  assert.equal((await membershipsOf(owner.id)).length, 1);
  const again = await orgMembershipService.syncAll({ apply: true });
  assert.equal(again.inserted + again.updated + again.ended + again.vendors, 0);
});

test('a sync failure never blocks the write it follows', async () => {
  const original = orgMembershipService.syncUser;
  orgMembershipService.syncUser = async () => { throw new Error('boom'); };
  try {
    const user = await makeUser({ userType: 'gym_operator', gymIds: [await makeGym()] });
    assert.ok(user.id, 'the user was still written');
  } finally {
    orgMembershipService.syncUser = original;
  }
});

// ── One list across gyms, vendors and companies ────────────────────────────

test('/me/memberships lists gym, vendor and corporate relationships; 404 with the flag off', async () => {
  const gym = await makeGym();
  const uid = uniq('fb');
  const member = await makeUser({ firebaseUid: uid });
  await makeUser({ firebaseUid: uid, userType: 'vendor', vendorProfile: { businessName: 'Shop' } });
  await directSub(member.id, gym);
  const orgId = uniq('b2b');
  await db('B2BOrganization').insert({ id: orgId, organizationType: 'employer', legalName: 'Acme Ltd', status: 'active' });
  await db('B2BOrganizationUser').insert({ id: uniq('b2bu'), organizationId: orgId, userId: member.id, role: 'admin', status: 'active' });
  await db('B2BBeneficiary').insert({ id: uniq('b2bb'), organizationId: orgId, userId: member.id, beneficiaryType: 'employee', status: 'active' });

  const saved = { a: process.env.IDENTITY_V2, b: process.env.V2_ORG_WRITE };
  try {
    delete process.env.IDENTITY_V2; delete process.env.V2_ORG_WRITE;
    const off = res();
    await myMemberships.onRequest({ user: { sub: member.id }, query: {} }, off);
    assert.equal(off.statusCode, 404);

    process.env.IDENTITY_V2 = 'true'; process.env.V2_ORG_WRITE = 'true';
    const out = res();
    await myMemberships.onRequest({ user: { sub: member.id }, query: {} }, out);
    assert.equal(out.statusCode, 200);
    const summary = out.body.memberships.map(m => `${m.orgType}:${m.role}:${m.status}`).sort();
    assert.deepEqual(summary, ['corporate:admin:active', 'corporate:beneficiary:active', 'gym:member:active', 'vendor:owner:active']);
    assert.equal(await db('OrgMembership').where({ personId: member.personId }).count({ n: '*' }).first().then(r => Number(r.n)), 2,
      'corporate relationships are read from the B2B tables, not copied');
  } finally {
    if (saved.a === undefined) delete process.env.IDENTITY_V2; else process.env.IDENTITY_V2 = saved.a;
    if (saved.b === undefined) delete process.env.V2_ORG_WRITE; else process.env.V2_ORG_WRITE = saved.b;
  }
});
