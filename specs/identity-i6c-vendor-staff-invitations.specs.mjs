// Identity V2 · I6 (slice C) — a vendor invites its staff.
// The vendor never creates an account or sets a password for someone. The
// invitation carries the staff role and permissions; accepting creates a
// vendor_staff persona for the invited Person at that vendor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  vendorPeopleLookup, vendorCreateInvitation, vendorListInvitations, vendorCancelInvitation, vendorResendInvitation,
  gymListInvitations, gymCancelInvitation, myInvitations, openMyInvitation, acceptMyInvitation, declineMyInvitation,
} from '../functions/invitations.mjs';
import { vendorCreateStaff, vendorStaff } from '../functions/shop.mjs';
import { users, shopService } from '../src/bootstrap/services.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';

const uniq = p => `${p}_${randomUUID().slice(0, 8)}`;

function res() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
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
async function withEnv(env, fn) {
  const names = ['IDENTITY_V2', 'V2_INVITES', ...Object.keys(env)];
  const saved = Object.fromEntries(names.map(n => [n, process.env[n]]));
  process.env.IDENTITY_V2 = 'true'; process.env.V2_INVITES = 'true';
  Object.assign(process.env, env);
  try { return await fn(); } finally {
    for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
  }
}
const on = fn => withEnv({}, fn);

async function makeUser(overrides = {}) {
  const row = {
    id: uniq('usr_i6c'), userType: 'member', accountStatus: 'active', approvalStatus: 'approved',
    createdAt: new Date().toISOString(), ...overrides,
  };
  await users.upsertAsync(u => u.id === row.id, row);
  return db('User').where({ id: row.id }).first();
}
async function makeVendor(name = 'Duka la Mazoezi') {
  const vendor = await makeUser({ userType: 'vendor', displayName: name, email: `${uniq('shop')}@example.com` });
  return { vendor, vendorId: vendor.id, claims: { sub: vendor.id, userType: 'vendor' } };
}
/** A person with a VERIFIED email, as a verified sign-in would record it. */
async function verifiedPerson(overrides = {}) {
  const email = `${uniq('person')}@example.com`;
  const user = await makeUser({ firebaseUid: uniq('fb'), email, displayName: 'Neema Abdallah', ...overrides });
  await db('LoginIdentifier').insert({
    id: uniq('lid'), personId: user.personId, type: 'email', value: email, normalizedValue: email,
    verifiedAt: new Date(), status: 'active',
  });
  return { user, email, claims: { sub: user.id, userType: user.userType } };
}
const invite = (v, body) => call(vendorCreateInvitation, v.claims, { params: { vendorId: v.vendorId }, body: { role: 'staff', ...body } });
const legacyStaffBody = () => ({ name: 'Old Way', email: `${uniq('old')}@example.com`, phone: `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, password: 'secret-pass-1', role: 'sales', permissions: ['orders'] });

test('flag off: no vendor invitation routes, and the legacy staff create still works', async () => {
  const v = await makeVendor();
  assert.equal((await invite(v, { email: 'a@example.com', vendorRole: 'sales' })).statusCode, 404);
  assert.equal((await call(vendorListInvitations, v.claims, { params: { vendorId: v.vendorId } })).statusCode, 404);
  assert.equal((await call(vendorPeopleLookup, v.claims, { params: { vendorId: v.vendorId }, body: { email: 'a@example.com' } })).statusCode, 404);
  const legacy = await call(vendorCreateStaff, v.claims, { body: legacyStaffBody() });
  assert.equal(legacy.statusCode, 201);
});

test('flag on: the legacy vendor staff create refuses credentials', async () => {
  await on(async () => {
    const v = await makeVendor();
    const body = legacyStaffBody();
    const refused = await call(vendorCreateStaff, v.claims, { body });
    assert.equal(refused.statusCode, 400);
    assert.equal(refused.body.error, 'credentials_not_accepted');
    assert.equal(await db('User').where({ email: body.email }).first(), undefined);
  });
});

test('a known person accepts a vendor staff invitation: persona, permissions and membership, no password', async () => {
  await on(async () => {
    const v = await makeVendor('Mazoezi Gear');
    const p = await verifiedPerson();

    const look = await call(vendorPeopleLookup, v.claims, { params: { vendorId: v.vendorId }, body: { email: p.email } });
    assert.deepEqual(look.body, { found: true, maskedName: 'N**** A*******' });
    assert.equal((await db('OrgLookupLog').where({ actorUserId: v.vendor.id }).first()).orgType, 'vendor');

    const sent = await invite(v, { email: p.email, vendorRole: 'orders_manager', permissions: ['orders', 'customers'] });
    assert.equal(sent.statusCode, 201);
    assert.ok(sent.body.token);
    assert.equal(sent.body.invitation.orgType, 'vendor');
    assert.equal(sent.body.invitation.orgId, v.vendorId);
    assert.equal(sent.body.invitation.vendorRole, 'orders_manager');
    assert.deepEqual(sent.body.invitation.aclPermissions, ['orders', 'customers']);
    assert.equal(await db('User').where({ personId: p.user.personId, userType: 'vendor_staff' }).first(), undefined, 'nothing is created before acceptance');
    assert.equal((await invite(v, { email: p.email, vendorRole: 'sales' })).body.created, false, 'one open invitation per person');

    const mine = await call(myInvitations, p.claims);
    assert.equal(mine.body.invitations.length, 1);
    assert.equal(mine.body.invitations[0].orgName, 'Mazoezi Gear');
    const opened = await call(openMyInvitation, p.claims, { body: { token: sent.body.token } });
    assert.equal(opened.body.invitation.id, sent.body.invitation.id);

    const accepted = await call(acceptMyInvitation, p.claims, { params: { invitationId: sent.body.invitation.id } });
    assert.equal(accepted.statusCode, 200);
    const staff = await db('User').where({ id: accepted.body.personaId }).first();
    assert.equal(staff.userType, 'vendor_staff');
    assert.equal(staff.personId, p.user.personId);
    assert.equal(staff.vendorId, v.vendorId);
    assert.equal(staff.vendorRole, 'orders_manager');
    assert.deepEqual(staff.vendorPermissions, ['orders', 'customers']);
    assert.equal(staff.passwordHash ?? null, null, 'the vendor set no password');
    assert.equal(staff.firebaseUid, p.user.firebaseUid);

    const membership = await db('OrgMembership').where({ id: accepted.body.membershipId }).first();
    assert.equal(membership.orgType, 'vendor');
    assert.equal(membership.vendorId, v.vendorId);
    assert.equal(membership.role, 'staff');
    assert.equal(membership.status, 'active');
    assert.equal(membership.source, 'invite');
    assert.equal(membership.invitedBy, v.vendor.id);

    // The existing shop permission check accepts the invited staff.
    const staffClaims = { sub: staff.id, userType: 'vendor_staff', vendorId: staff.vendorId };
    assert.equal(await shopService.authorizeStaff(staffClaims, 'orders'), true);
    assert.equal(await shopService.authorizeStaff(staffClaims, 'payments'), false);
    const listed = await call(vendorStaff, v.claims);
    assert.ok(listed.body.some(s => s.id === staff.id));

    const again = await invite(v, { email: p.email, vendorRole: 'sales' });
    assert.equal(again.statusCode, 409);
    assert.equal(again.body.error, 'already_a_member');
    assert.equal((await call(myInvitations, p.claims)).body.invitations.length, 0);
  });
});

test('declining leaves no persona and no membership', async () => {
  await on(async () => {
    const v = await makeVendor();
    const p = await verifiedPerson();
    const sent = await invite(v, { email: p.email, vendorRole: 'sales', permissions: ['orders'] });
    const declined = await call(declineMyInvitation, p.claims, { params: { invitationId: sent.body.invitation.id } });
    assert.equal(declined.body.invitation.status, 'declined');
    assert.equal(await db('User').where({ personId: p.user.personId, userType: 'vendor_staff' }).first(), undefined);
    assert.equal(await db('OrgMembership').where({ personId: p.user.personId, orgType: 'vendor' }).first(), undefined);
  });
});

test('input rules: role, staff role, permissions, the admin role, and staff at another vendor', async () => {
  await on(async () => {
    const v = await makeVendor();
    const p = await verifiedPerson();
    const bad = async (body, error, status = 400) => {
      const out = await invite(v, { email: p.email, ...body });
      assert.equal(out.statusCode, status, JSON.stringify(out.body));
      assert.equal(out.body.error, error);
    };
    await bad({ role: 'member', vendorRole: 'sales' }, 'role_not_invitable');
    await bad({ role: 'owner', vendorRole: 'sales' }, 'role_not_invitable');
    await bad({}, 'invalid_staff_role');
    await bad({ vendorRole: 'boss' }, 'invalid_staff_role');
    await bad({ vendorRole: 'sales', permissions: ['orders', 'everything'] }, 'invalid_staff_permissions');
    assert.equal((await invite(v, { vendorRole: 'sales' })).body.error, 'one_phone_or_email_required');

    const self = await verifiedPerson({ userType: 'vendor', displayName: 'Own Shop' });
    const own = await call(vendorCreateInvitation, self.claims, { params: { vendorId: self.user.id }, body: { role: 'staff', email: self.email, vendorRole: 'sales' } });
    assert.equal(own.statusCode, 409);
    assert.equal(own.body.error, 'already_owner');

    const admin = await invite(v, { email: p.email, vendorRole: 'admin', permissions: ['orders'] });
    assert.equal(admin.statusCode, 201);
    assert.deepEqual([...admin.body.invitation.aclPermissions].sort(), ['customers', 'orders', 'payments', 'products', 'reports', 'staff']);
    await call(acceptMyInvitation, p.claims, { params: { invitationId: admin.body.invitation.id } });

    const other = await makeVendor('Second Shop');
    const second = await invite(other, { email: p.email, vendorRole: 'sales' });
    assert.equal(second.statusCode, 201);
    const refused = await call(acceptMyInvitation, p.claims, { params: { invitationId: second.body.invitation.id } });
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.body.error, 'already_staff_elsewhere');
    assert.equal((await db('User').where({ personId: p.user.personId, userType: 'vendor_staff' })).length, 1);
  });
});

test('only the vendor itself manages its invitations', async () => {
  await on(async () => {
    const v = await makeVendor();
    const other = await makeVendor('Other Shop');
    const p = await verifiedPerson();
    const sent = await invite(v, { email: p.email, vendorRole: 'sales', permissions: ['orders'] });
    const invitationId = sent.body.invitation.id;

    const cross = await call(vendorCreateInvitation, other.claims, { params: { vendorId: v.vendorId }, body: { role: 'staff', email: p.email, vendorRole: 'sales' } });
    assert.equal(cross.statusCode, 403);
    assert.equal(cross.body.error, 'not_your_vendor');
    assert.equal((await call(vendorListInvitations, other.claims, { params: { vendorId: v.vendorId } })).statusCode, 403);
    assert.equal((await call(vendorCancelInvitation, other.claims, { params: { vendorId: other.vendorId, invitationId } })).statusCode, 404);
    assert.deepEqual((await call(vendorListInvitations, other.claims, { params: { vendorId: other.vendorId } })).body.invitations, []);

    // Staff, members and gym owners are not the vendor.
    const staffUser = await makeUser({ userType: 'vendor_staff', vendorId: v.vendorId, vendorPermissions: ['staff'] });
    for (const claims of [{ sub: staffUser.id, userType: 'vendor_staff', vendorId: v.vendorId }, p.claims, { sub: uniq('usr'), userType: 'gym_operator' }]) {
      assert.equal((await call(vendorListInvitations, claims, { params: { vendorId: v.vendorId } })).statusCode, 403);
    }
    // A gym route never reaches a vendor's invitation.
    const gymId = uniq('gym_i6c');
    await db('Gym').insert({ id: gymId, name: 'Iron Paradise', tier: 'standard', location: 'Dar es Salaam', status: 'active', updatedAt: new Date() });
    const owner = await makeUser({ userType: 'gym_operator', gymIds: [gymId], gymId });
    const ownerClaims = { sub: owner.id, userType: 'gym_operator' };
    assert.deepEqual((await call(gymListInvitations, ownerClaims, { params: { gymId } })).body.invitations, []);
    assert.equal((await call(gymCancelInvitation, ownerClaims, { params: { gymId, invitationId } })).statusCode, 404);

    const listed = await call(vendorListInvitations, v.claims, { params: { vendorId: v.vendorId } });
    assert.equal(listed.body.invitations.length, 1);
    assert.equal(listed.body.invitations[0].identifierValue, p.email);
  });
});

test('cancel and resend work for a vendor invitation', async () => {
  await on(async () => {
    const v = await makeVendor();
    const p = await verifiedPerson();
    const sent = await invite(v, { email: p.email, vendorRole: 'sales', permissions: ['orders'] });
    const params = { vendorId: v.vendorId, invitationId: sent.body.invitation.id };

    assert.equal((await call(vendorResendInvitation, v.claims, { params })).body.error, 'resend_too_soon');
    await db('Invitation').where({ id: params.invitationId }).update({ lastSentAt: new Date(Date.now() - 25 * 3600e3) });
    const resent = await call(vendorResendInvitation, v.claims, { params });
    assert.equal(resent.statusCode, 200);
    assert.equal((await call(openMyInvitation, p.claims, { body: { token: sent.body.token } })).statusCode, 404, 'the old link stops working');
    assert.equal((await call(openMyInvitation, p.claims, { body: { token: resent.body.token } })).statusCode, 200);

    const cancelled = await call(vendorCancelInvitation, v.claims, { params });
    assert.equal(cancelled.body.invitation.status, 'cancelled');
    const late = await call(acceptMyInvitation, p.claims, { params: { invitationId: params.invitationId } });
    assert.equal(late.statusCode, 409);
    assert.equal(late.body.error, 'invitation_not_open');
  });
});
