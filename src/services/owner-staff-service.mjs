// Gym-staff roster service (RBAC) — owners create gym-level staff (e.g.
// receptionists) scoped to their own gym(s) with a per-feature ACL.
import { randomUUID } from 'node:crypto';
import { parseStringList } from '../shared/parse-list.mjs';

export const GYM_STAFF_ACL_SCOPES = ['members', 'checkins', 'payments', 'trainers', 'gyms', 'shop'];

export function createOwnerStaffService({ users, auditLog, initFirebaseAdmin, getAdminAuth }) {
  function hydrateStaff(u) {
    return {
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      userType: u.userType,
      accountStatus: u.accountStatus || 'active',
      gymIds: u.gymIds || [],
      aclPermissions: u.aclPermissions || [],
      createdAt: u.createdAt,
    };
  }

  async function list(ownerGymIds) {
    const rows = await users.filterAsync(u => u.userType === 'gym_staff' && (u.gymIds || []).some(id => ownerGymIds.includes(id)));
    return rows.map(hydrateStaff);
  }

  async function create({ ownerGymIds, body, actorId }) {
    const { email, password, displayName, aclPermissions = [], gymIds = [] } = body || {};
    if (!email || !password) return { error: 'email_and_password_required', status: 400 };
    if (!displayName) return { error: 'displayName_required', status: 400 };
    if (!Array.isArray(aclPermissions)) return { error: 'aclPermissions_must_be_array', status: 400 };
    const invalidScopes = aclPermissions.filter(p => !GYM_STAFF_ACL_SCOPES.includes(p));
    if (invalidScopes.length) return { error: 'invalid_acl_scopes', status: 400, invalid: invalidScopes };
    const scopedGymIds = parseStringList(gymIds, []).filter(id => ownerGymIds.includes(id));
    if (scopedGymIds.length === 0) return { error: 'must_assign_to_at_least_one_owned_gym', status: 400 };

    const existing = await users.findAsync(u => u.email === email && u.userType === 'gym_staff');
    if (existing) return { error: 'email_already_in_use', status: 409 };

    let firebaseUid = null;
    try {
      initFirebaseAdmin();
      const fbUser = await getAdminAuth().createUser({ email, password, displayName });
      firebaseUid = fbUser.uid;
    } catch (fbErr) {
      const duplicateIdentity = ['auth/email-already-exists', 'email-already-exists']
        .includes(fbErr?.code);
      if (!duplicateIdentity) {
        console.error('[owner-staff] Firebase user creation failed:', fbErr?.message);
        return { error: 'firebase_user_creation_failed', status: 502, detail: fbErr?.message };
      }
      try {
        firebaseUid = (await getAdminAuth().getUserByEmail(email)).uid;
      } catch (lookupErr) {
        console.error('[owner-staff] Existing Firebase identity lookup failed:', lookupErr?.message);
        return { error: 'firebase_user_lookup_failed', status: 502, detail: lookupErr?.message };
      }
    }

    const row = {
      id: `usr_${randomUUID().slice(0, 8)}`,
      firebaseUid,
      email,
      displayName,
      userType: 'gym_staff',
      accountStatus: 'active',
      approvalStatus: 'approved',
      portalUser: false,
      aclPermissions,
      gymIds: scopedGymIds,
      gymId: scopedGymIds[0],
      onboardingCompleted: true,
      createdAt: new Date().toISOString(),
    };
    const created = await users.upsertAsync(u => u.id === row.id, row);
    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: actorId, action: 'gym_staff_created',
      target: row.id, before: null, after: { email: row.email, aclPermissions, gymIds: scopedGymIds },
    });
    return { staff: hydrateStaff(created) };
  }

  async function update({ ownerGymIds, staffId, body, actorId }) {
    const target = await users.findAsync(u => u.id === staffId && u.userType === 'gym_staff');
    if (!target) return { error: 'staff_not_found', status: 404 };
    if (!(target.gymIds || []).some(id => ownerGymIds.includes(id))) return { error: 'staff_not_at_your_gym', status: 403 };
    const { displayName, aclPermissions, gymIds, accountStatus } = body || {};
    const patch = {};
    if (displayName) patch.displayName = displayName;
    if (Array.isArray(aclPermissions)) {
      const invalidScopes = aclPermissions.filter(p => !GYM_STAFF_ACL_SCOPES.includes(p));
      if (invalidScopes.length) return { error: 'invalid_acl_scopes', status: 400, invalid: invalidScopes };
      patch.aclPermissions = aclPermissions;
    }
    if (gymIds !== undefined) {
      const scopedGymIds = parseStringList(gymIds, []).filter(id => ownerGymIds.includes(id));
      if (scopedGymIds.length === 0) return { error: 'must_assign_to_at_least_one_owned_gym', status: 400 };
      patch.gymIds = scopedGymIds;
      patch.gymId = scopedGymIds[0];
    }
    if (accountStatus && ['active', 'suspended'].includes(accountStatus)) patch.accountStatus = accountStatus;
    const updated = await users.upsertAsync(u => u.id === target.id, { ...target, ...patch, updatedAt: new Date().toISOString() });
    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: actorId, action: 'gym_staff_updated',
      target: target.id, before: { aclPermissions: target.aclPermissions, gymIds: target.gymIds, accountStatus: target.accountStatus }, after: patch,
    });
    return { staff: hydrateStaff(updated) };
  }

  async function remove({ ownerGymIds, staffId, actorId }) {
    const target = await users.findAsync(u => u.id === staffId && u.userType === 'gym_staff');
    if (!target) return { error: 'staff_not_found', status: 404 };
    if (!(target.gymIds || []).some(id => ownerGymIds.includes(id))) return { error: 'staff_not_at_your_gym', status: 403 };
    if (target.firebaseUid) {
      try {
        initFirebaseAdmin();
        await getAdminAuth().deleteUser(target.firebaseUid);
      } catch (fbErr) {
        console.warn('[owner-staff] Firebase user deletion failed:', fbErr?.message);
      }
    }
    await users.removeAsync(u => u.id === target.id);
    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: actorId, action: 'gym_staff_removed',
      target: target.id, before: { email: target.email }, after: null,
    });
    return { ok: true };
  }

  return { list, create, update, remove };
}
