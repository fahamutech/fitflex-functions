// Portal (admin) staff user management — email/password accounts scoped by ACL.
import { randomUUID } from 'node:crypto';
import { deleteFirebaseUserIfUnshared } from '../shared/firebase-identity.mjs';
import { normalizeEmail, sameEmail } from '../shared/identifiers.mjs';

// Must cover every requireAcl(scope) in functions/*.mjs (enforced by specs/portal-acl-scopes.specs.mjs)
// plus the scopes the portal's Users page offers, or admins can't grant them.
export const PORTAL_ACL_SCOPES = [
  'gyms', 'owners', 'trainers', 'members', 'shop', 'payments', 'approvals', 'settings', 'users',
  'analytics', 'challenges', 'rewards', 'social', 'corporate', 'vendors', 'communications',
  'kyc', 'b2b',
  // The exercise library members' training plans are made from.
  'exercises',
  // Identity V2: deciding account recovery requests (given only to the people who should).
  'account_recovery',
  // B2B billing (Phase 5): raising invoices, approving corrections and recording payments are separate grants.
  'b2b_billing', 'b2b_billing_approve', 'b2b_payments',
  // Gym settlement workflow (DR-09): preparing, approving and paying are separate grants.
  'settlements_prepare', 'settlements_approve', 'settlements_pay',
  // Moderation & Promotion: seeing and deciding moderation are separate, as are running promotions and approving them.
  'moderation', 'moderation_decide', 'promotions', 'promotions_approve', 'campaigns', 'promotion_analytics',
];

// Who may change portal access (security fix 2026-10-19):
//   - The caller comes from the verified token (req.user), never the body, and
//     is re-read from the DB so a stale token can't keep powers since removed.
//   - A super-admin is a caller with portalUser falsy (token AND row), or an
//     env-configured admin (FITFLEX_ADMIN_EMAILS). Super-admins may do anything
//     below; requireAcl's semantics are unchanged.
//   - Only a super-admin may change anyone's portalUser flag, or edit a
//     super-admin account at all.
//   - Nobody changes their OWN aclPermissions, portalUser or accountStatus
//     (displayName is fine).
//   - Portal staff may only add or remove scopes they hold themselves; scopes
//     outside their own stay as they are. The same applies to create().
//   - "Change" means a value different from the stored one, so a form that
//     re-sends unchanged values (the portal's edit dialog does) is not refused.
//   - Every refusal is audited (portal_user_create_refused / _update_refused).
export function createPortalUserService({ users, auditLog, initFirebaseAdmin, getAdminAuth, isConfiguredAdminEmail }) {
  const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));

  /** The caller's effective access: the tighter of the token claims and the stored row. */
  async function resolveActor(actor) {
    if (!actor?.id) return null;
    const row = await users.findAsync(u => u.id === actor.id);
    if (!row) return null;
    const envAdmin = Boolean((row.email && isConfiguredAdminEmail(row.email)));
    const superAdmin = envAdmin || (!actor.portalUser && !row.portalUser);
    const tokenScopes = Array.isArray(actor.aclPermissions) ? actor.aclPermissions : [];
    const rowScopes = Array.isArray(row.aclPermissions) ? row.aclPermissions : [];
    return { id: row.id, superAdmin, scopes: tokenScopes.filter(s => rowScopes.includes(s)) };
  }

  // `target` is the user id for updates, the requested email for creates (the column is NOT NULL).
  async function refuse(action, { actorId, target, requested, error, status = 403, message, extra = {} }) {
    await auditLog.insertAsync({
      id: randomUUID(), at: new Date().toISOString(),
      actor: actorId ?? null, action, target: target ?? 'unknown',
      before: null, after: { refused: error, requested },
    });
    return { error, status, message, ...extra };
  }

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

  async function create({ email: rawEmail, password, displayName, aclPermissions = [], actor, actorId = actor?.id }) {
    const email = normalizeEmail(rawEmail);
    if (!email || !password) return { error: 'email_and_password_required', status: 400 };
    if (!Array.isArray(aclPermissions)) return { error: 'aclPermissions_must_be_array', status: 400 };
    const invalid = aclPermissions.filter(p => !PORTAL_ACL_SCOPES.includes(p));
    if (invalid.length) return { error: 'invalid_acl_scopes', status: 400, invalid };
    aclPermissions = [...new Set(aclPermissions)];
    const caller = await resolveActor(actor);
    const requested = { email, aclPermissions };
    if (!caller) {
      return refuse('portal_user_create_refused', { actorId, target: email, requested, error: 'actor_not_found', message: 'The signed-in account could not be found.' });
    }
    if (!caller.superAdmin) {
      const exceeding = aclPermissions.filter(p => !caller.scopes.includes(p));
      if (exceeding.length) {
        return refuse('portal_user_create_refused', {
          actorId: caller.id, target: email, requested, error: 'acl_grant_exceeds_own',
          message: 'You can only grant permissions you hold yourself.', extra: { exceeding },
        });
      }
    }
    const existing = await users.findAsync(u => sameEmail(u.email, email) && u.userType === 'admin');
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
    await auditLog.insertAsync({
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

  async function update({ id, aclPermissions, accountStatus, displayName, portalUser, actor, actorId = actor?.id }) {
    const target = await users.findAsync(u => u.id === id && u.userType === 'admin');
    if (!target) return { error: 'portal_user_not_found', status: 404 };
    if (target.email && isConfiguredAdminEmail(target.email)) {
      return { error: 'env_admin_immutable', status: 403, message: 'Super-admin accounts from environment config cannot be modified.' };
    }
    const patch = {};
    if (Array.isArray(aclPermissions)) {
      const invalid = aclPermissions.filter(p => !PORTAL_ACL_SCOPES.includes(p));
      if (invalid.length) return { error: 'invalid_acl_scopes', status: 400, invalid };
      patch.aclPermissions = [...new Set(aclPermissions)];
    }
    if (accountStatus && ['active', 'suspended'].includes(accountStatus)) patch.accountStatus = accountStatus;
    if (displayName) patch.displayName = displayName;
    if (typeof portalUser === 'boolean') patch.portalUser = portalUser;

    // Only real changes count, so re-sent unchanged values pass.
    const currentScopes = Array.isArray(target.aclPermissions) ? target.aclPermissions : [];
    const currentStatus = target.accountStatus || 'active';
    const currentPortalUser = target.portalUser === true;
    const scopesChange = 'aclPermissions' in patch && !sameSet(patch.aclPermissions, currentScopes);
    const statusChange = 'accountStatus' in patch && patch.accountStatus !== currentStatus;
    const portalUserChange = 'portalUser' in patch && patch.portalUser !== currentPortalUser;
    const requested = { ...patch };
    const refused = (error, message, extra) => refuse('portal_user_update_refused', {
      actorId: caller?.id ?? actorId, target: target.id, requested, error, message, extra,
    });

    const caller = await resolveActor(actor);
    if (!caller) return refused('actor_not_found', 'The signed-in account could not be found.');
    if (caller.id === target.id && (scopesChange || statusChange || portalUserChange)) {
      return refused('cannot_change_own_access', 'You cannot change your own permissions, role or status.');
    }
    if (!caller.superAdmin) {
      if (portalUserChange) return refused('super_admin_required', 'Only a super-admin can change whether an account is a super-admin.');
      if (!currentPortalUser) return refused('super_admin_required', 'Only a super-admin can change a super-admin account.');
      if (scopesChange) {
        const added = patch.aclPermissions.filter(p => !currentScopes.includes(p));
        const removed = currentScopes.filter(p => !patch.aclPermissions.includes(p));
        const exceeding = [...added, ...removed].filter(p => !caller.scopes.includes(p));
        if (exceeding.length) {
          return refused('acl_grant_exceeds_own', 'You can only grant or remove permissions you hold yourself.', { exceeding });
        }
      }
    }

    const updated = await users.upsertAsync(u => u.id === target.id, { ...target, ...patch, updatedAt: new Date().toISOString() });
    await auditLog.insertAsync({
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
    await deleteFirebaseUserIfUnshared({ users, row: target, initFirebaseAdmin, getAdminAuth, logTag: 'portal-users' });
    await users.removeAsync(u => u.id === target.id);
    await auditLog.insertAsync({
      id: randomUUID(), at: new Date().toISOString(),
      actor: actorId, action: 'portal_user_deleted',
      target: target.id, before: { email: target.email }, after: null
    });
    return { ok: true };
  }

  return { list, create, update, remove };
}
