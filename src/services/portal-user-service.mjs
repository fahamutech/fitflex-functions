// Portal (admin) staff user management — email/password accounts scoped by ACL.
import { randomUUID } from 'node:crypto';

export const PORTAL_ACL_SCOPES = ['gyms', 'owners', 'trainers', 'members', 'shop', 'payments', 'approvals', 'settings', 'users', 'communications'];

export function createPortalUserService({ users, auditLog, initFirebaseAdmin, getAdminAuth, isConfiguredAdminEmail }) {
  function slim(u) {
    return {
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      userType: u.userType,
      accountStatus: u.accountStatus || 'active',
      portalUser: u.portalUser || false,
      aclPermissions: u.aclPermissions || [],
      createdAt: u.createdAt,
      isEnvAdmin: isConfiguredAdminEmail(u.email),
    };
  }

  async function list() {
    const rows = await users.filterAsync(u => u.portalUser === true || u.userType === 'admin');
    return rows.map(slim);
  }

  async function create({ email, password, displayName, aclPermissions = [], actorId }) {
    if (!email || !password) return { error: 'email_and_password_required', status: 400 };
    if (!Array.isArray(aclPermissions)) return { error: 'aclPermissions_must_be_array', status: 400 };
    const invalid = aclPermissions.filter(p => !PORTAL_ACL_SCOPES.includes(p));
    if (invalid.length) return { error: 'invalid_acl_scopes', status: 400, invalid };
    const existing = await users.findAsync(u => u.email === email && u.userType === 'admin');
    if (existing) return { error: 'email_already_exists', status: 409 };

    let firebaseUid = null;
    try {
      initFirebaseAdmin();
      const fbUser = await getAdminAuth().createUser({ email, password, displayName: displayName || email });
      firebaseUid = fbUser.uid;
    } catch (fbErr) {
      const duplicateIdentity = ['auth/email-already-exists', 'email-already-exists']
        .includes(fbErr?.code);
      if (!duplicateIdentity) {
        console.error('[portal-users] Firebase user creation failed:', fbErr?.message);
        return { error: 'firebase_user_creation_failed', status: 502, detail: fbErr?.message };
      }
      try {
        firebaseUid = (await getAdminAuth().getUserByEmail(email)).uid;
      } catch (lookupErr) {
        console.error('[portal-users] Existing Firebase identity lookup failed:', lookupErr?.message);
        return { error: 'firebase_user_lookup_failed', status: 502, detail: lookupErr?.message };
      }
    }

    const row = {
      id: `usr_${randomUUID().slice(0, 8)}`,
      firebaseUid,
      email,
      displayName: displayName || email,
      userType: 'admin',
      accountStatus: 'active',
      approvalStatus: 'approved',
      portalUser: true,
      aclPermissions,
      onboardingCompleted: true,
      createdAt: new Date().toISOString(),
    };
    const created = await users.upsertAsync(u => u.id === row.id, row);
    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: actorId, action: 'portal_user_created',
      target: row.id, before: null, after: { email: row.email, aclPermissions }
    });
    return {
      user: {
        id: created.id, email: created.email, displayName: created.displayName, userType: created.userType,
        accountStatus: created.accountStatus, portalUser: true, aclPermissions: created.aclPermissions || [],
        createdAt: created.createdAt,
      },
    };
  }

  async function update({ id, aclPermissions, accountStatus, displayName, portalUser, actorId }) {
    const target = await users.findAsync(u => u.id === id && u.userType === 'admin');
    if (!target) return { error: 'portal_user_not_found', status: 404 };
    if (target.email && isConfiguredAdminEmail(target.email)) {
      return { error: 'env_admin_immutable', status: 403, message: 'Super-admin accounts from environment config cannot be modified.' };
    }
    const patch = {};
    if (Array.isArray(aclPermissions)) {
      const invalid = aclPermissions.filter(p => !PORTAL_ACL_SCOPES.includes(p));
      if (invalid.length) return { error: 'invalid_acl_scopes', status: 400, invalid };
      patch.aclPermissions = aclPermissions;
    }
    if (accountStatus && ['active', 'suspended'].includes(accountStatus)) patch.accountStatus = accountStatus;
    if (displayName) patch.displayName = displayName;
    if (typeof portalUser === 'boolean') patch.portalUser = portalUser;
    const updated = await users.upsertAsync(u => u.id === target.id, { ...target, ...patch, updatedAt: new Date().toISOString() });
    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: actorId, action: 'portal_user_updated',
      target: target.id, before: { aclPermissions: target.aclPermissions, accountStatus: target.accountStatus, portalUser: target.portalUser }, after: patch
    });
    return {
      user: {
        id: updated.id, email: updated.email, displayName: updated.displayName, userType: updated.userType,
        accountStatus: updated.accountStatus, portalUser: updated.portalUser || false, aclPermissions: updated.aclPermissions || [],
      },
    };
  }

  async function remove({ id, requesterId, actorId }) {
    if (id === requesterId) return { error: 'cannot_delete_self', status: 400 };
    const target = await users.findAsync(u => u.id === id && u.portalUser === true);
    if (!target) return { error: 'portal_user_not_found', status: 404 };
    if (target.email && isConfiguredAdminEmail(target.email)) {
      return { error: 'env_admin_immutable', status: 403, message: 'Super-admin accounts from environment config cannot be deleted.' };
    }
    if (target.firebaseUid) {
      try {
        initFirebaseAdmin();
        await getAdminAuth().deleteUser(target.firebaseUid);
      } catch (fbErr) {
        console.warn('[portal-users] Firebase user deletion failed:', fbErr?.message);
      }
    }
    await users.removeAsync(u => u.id === target.id);
    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: actorId, action: 'portal_user_deleted',
      target: target.id, before: { email: target.email }, after: null
    });
    return { ok: true };
  }

  return { list, create, update, remove };
}
