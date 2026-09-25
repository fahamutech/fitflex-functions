// TDD — Gym staff roster RBAC. Owners create gym-level staff (e.g. receptionists) with a
// per-feature ACL (GYM_STAFF_ACL_SCOPES: members, checkins, payments, trainers, gyms, shop, communications).
// Owners are always unrestricted over their own gyms; staff need the matching scope.
//
// ownerCreateStaff's success path calls Firebase Admin (to actually create the staff
// member's login), which isn't available in this test environment — see
// specs/uat-phase2-endpoints.specs.mjs for the request-validation coverage of that endpoint.
// This spec instead unit-tests the requireGymAcl() guard directly (the core RBAC mechanism)
// and the parts of the staff endpoints that don't require a live Firebase project.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireGymAcl } from '../src/auth/jwt.mjs';
import { updateMemberProfile } from '../functions/subscriptions.mjs';
import { ownerListStaff, ownerUpdateStaff, ownerRemoveStaff } from '../functions/owner-staff.mjs';
import { createOwnerStaffService } from '../src/services/owner-staff-service.mjs';

function res() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function runGuard(guard, user) {
  let result = null;
  const req = { user };
  const response = {
    status(code) { result = { code }; return this; },
    json(body) { result = { ...result, body }; return this; },
  };
  let nextCalled = false;
  guard(req, response, () => { nextCalled = true; });
  return { nextCalled, result };
}

const uniq = (p) => `${p}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const uniqPhone = () => `+2557${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

test('requireGymAcl: gym_operator (owner) is always unrestricted', () => {
  const guard = requireGymAcl('members');
  const { nextCalled } = runGuard(guard, { userType: 'gym_operator', aclPermissions: [] });
  assert.equal(nextCalled, true);
});

test('requireGymAcl: gym_staff with the matching scope passes', () => {
  const guard = requireGymAcl('members');
  const { nextCalled } = runGuard(guard, { userType: 'gym_staff', aclPermissions: ['members', 'checkins'] });
  assert.equal(nextCalled, true);
});

test('requireGymAcl: gym_staff without the matching scope is forbidden', () => {
  const guard = requireGymAcl('trainers');
  const { nextCalled, result } = runGuard(guard, { userType: 'gym_staff', aclPermissions: ['members'] });
  assert.equal(nextCalled, false);
  assert.equal(result.code, 403);
  assert.equal(result.body.error, 'acl_forbidden');
  assert.equal(result.body.requiredScope, 'trainers');
});

test('requireGymAcl: any other role (e.g. trainer) is forbidden', () => {
  const guard = requireGymAcl('members');
  const { nextCalled, result } = runGuard(guard, { userType: 'trainer', aclPermissions: ['members'] });
  assert.equal(nextCalled, false);
  assert.equal(result.code, 403);
});

test('owner can reuse an existing member Firebase email for a separate staff profile', async () => {
  const email = 'shared-role@example.com';
  const rows = [{
    id: 'usr_existing_member',
    email,
    firebaseUid: 'firebase-shared-role',
    userType: 'member',
  }];
  const users = {
    findAsync: async (predicate) => rows.find(predicate) || null,
    filterAsync: async (predicate) => rows.filter(predicate),
    upsertAsync: async (predicate, row) => {
      const index = rows.findIndex(predicate);
      if (index >= 0) rows[index] = row;
      else rows.push(row);
      return row;
    },
  };
  const duplicate = Object.assign(new Error('email already exists'), {
    code: 'auth/email-already-exists',
  });
  const service = createOwnerStaffService({
    users,
    auditLog: { insert: () => {}, insertAsync: async () => {} },
    initFirebaseAdmin: () => {},
    getAdminAuth: () => ({
      createUser: async () => { throw duplicate; },
      getUserByEmail: async () => ({ uid: 'firebase-shared-role' }),
    }),
  });

  const result = await service.create({
    ownerGymIds: ['gym-one'],
    actorId: 'usr-owner',
    body: {
      email,
      password: '246810',
      displayName: 'Shared Role Staff',
      gymIds: ['gym-one'],
      aclPermissions: ['members'],
    },
  });

  assert.equal(result.staff.userType, 'gym_staff');
  assert.equal(rows.length, 2);
  assert.equal(rows[1].firebaseUid, 'firebase-shared-role');
  assert.equal(rows[0].userType, 'member');
});

test('ownerListStaff: a fresh owner with no staff sees an empty roster', async () => {
  const ownerId = uniq('usr_owner_staff');
  await updateMemberProfile.onRequest(
    { user: { sub: ownerId, userType: 'gym_operator' }, body: { displayName: 'Staff Roster Owner', phone: uniqPhone() } },
    res(),
  );
  const out = res();
  await ownerListStaff.onRequest({ user: { sub: ownerId, userType: 'gym_operator' } }, out);
  assert.equal(out.statusCode, 200);
  assert.deepEqual(out.body, []);
});

test('ownerUpdateStaff: 404s for a staff id that does not exist', async () => {
  const ownerId = uniq('usr_owner_staff2');
  await updateMemberProfile.onRequest(
    { user: { sub: ownerId, userType: 'gym_operator' }, body: { displayName: 'Owner Two', phone: uniqPhone() } },
    res(),
  );
  const out = res();
  await ownerUpdateStaff.onRequest(
    { user: { sub: ownerId, userType: 'gym_operator' }, params: { id: 'usr_does_not_exist' }, body: { displayName: 'New Name' } },
    out,
  );
  assert.equal(out.statusCode, 404);
  assert.equal(out.body.error, 'staff_not_found');
});

test('ownerRemoveStaff: 404s for a staff id that does not exist', async () => {
  const ownerId = uniq('usr_owner_staff3');
  await updateMemberProfile.onRequest(
    { user: { sub: ownerId, userType: 'gym_operator' }, body: { displayName: 'Owner Three', phone: uniqPhone() } },
    res(),
  );
  const out = res();
  await ownerRemoveStaff.onRequest(
    { user: { sub: ownerId, userType: 'gym_operator' }, params: { id: 'usr_does_not_exist' } },
    out,
  );
  assert.equal(out.statusCode, 404);
  assert.equal(out.body.error, 'staff_not_found');
});
