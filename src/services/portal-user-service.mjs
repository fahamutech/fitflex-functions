// Portal (admin) staff user management — email/password accounts scoped by ACL.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
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
  // Marathon & running events · S2: the moderation queue (/admin/events*). KYC decisions still need `kyc`.
  'events',
  // Identity V2: deciding account recovery requests (given only to the people who should).
  'account_recovery',
  // B2B billing (Phase 5): raising invoices, approving corrections and recording payments are separate grants.
  'b2b_billing', 'b2b_billing_approve', 'b2b_payments',
  // Gym settlement workflow (DR-09): preparing, approving and paying are separate grants.
  'settlements_prepare', 'settlements_approve', 'settlements_pay',
  // Moderation & Promotion: seeing and deciding moderation are separate, as are running promotions and approving them.
  'moderation', 'moderation_decide', 'promotions', 'promotions_approve', 'campaigns', 'promotion_analytics',
  // Admin-managed app photos: upload, edit and publish (one admin publishes alone, owner decision D-4).
  'brand_media',
];

/** Shortest password accepted when an admin replaces the start password (Firebase's own floor is 6). */
export const PORTAL_PASSWORD_MIN_LENGTH = 10;

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
/** A change request holds the row this long at most; after it another request may take over. */
const CHANGE_CLAIM_MS = 60_000;

export function createPortalUserService({
  users, auditLog, initFirebaseAdmin, getAdminAuth, isConfiguredAdminEmail,
  // Knex handle: the change-password claim is one conditional UPDATE (null in unit specs that never change).
  db = null,
  // The server key the start password is mixed with (PIN_PEPPER). Null = not configured: fail closed.
  pepper = () => null,
  // Drop the cached session check for a profile, so ended sessions stop at once.
  forgetSession = () => {},
}) {
  /** Keyed digest of the start password, so "new = start" can be refused without keeping the password. */
  const startPasswordHash = (userId, password) =>
    createHmac('sha256', String(pepper())).update(`start-password:${userId}:${password}`).digest('hex');
  const sameDigest = (a, b) => {
    const x = Buffer.from(String(a || ''), 'hex');
    const y = Buffer.from(String(b || ''), 'hex');
    return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
  };
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
      // Still on the start password the creator chose (never the hash itself).
      passwordChangeRequired: u.passwordChangeRequired === true,
    };
  }

  async function list() {
    const rows = await users.filterAsync(u => u.portalUser === true || u.userType === 'admin');
    return rows.map(slim);
  }

  async function create({ email: rawEmail, password, displayName, aclPermissions = [], actor, actorId = actor?.id, ip = null, userAgent = null }) {
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
    // The start password must be changed at first sign-in; without the key it can't be checked, so refuse.
    if (!pepper()) return { error: 'start_password_not_configured', status: 503 };

    let firebaseUid = null;
    // True only when this call set the Firebase password (the creator knows it).
    let passwordSetByCreator = false;
    try {
      initFirebaseAdmin();
      const fbUser = await getAdminAuth().createUser({ email, password, displayName: displayName || email });
      firebaseUid = fbUser.uid;
      passwordSetByCreator = true;
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

    const id = `usr_${randomUUID().slice(0, 8)}`;
    const row = {
      id,
      firebaseUid,
      email,
      displayName: displayName || email,
      userType: 'admin',
      accountStatus: 'active',
      approvalStatus: 'approved',
      portalUser: true,
      aclPermissions,
      onboardingCompleted: true,
      // Owner decision 2026-10-19: an admin made by another admin replaces the password before
      // anything else. Always flagged, also on an identity that already existed in Firebase
      // (security review: the creator may know or have set that password too). Only when this
      // call set the password is there a start password to refuse as "unchanged".
      passwordChangeRequired: true,
      startPasswordHash: passwordSetByCreator ? startPasswordHash(id, password) : null,
      createdAt: new Date().toISOString(),
    };
    const created = await users.upsertAsync(u => u.id === row.id, row);
    await auditLog.insertAsync({
      id: randomUUID(), at: new Date().toISOString(),
      actor: actorId, action: 'portal_user_created',
      target: row.id, before: null,
      after: { email: row.email, aclPermissions, passwordChangeRequired: true, existingIdentity: !passwordSetByCreator, ip, userAgent }
    });
    return {
      user: {
        id: created.id, email: created.email, displayName: created.displayName, userType: created.userType,
        accountStatus: created.accountStatus, portalUser: true, aclPermissions: created.aclPermissions || [],
        createdAt: created.createdAt, passwordChangeRequired: created.passwordChangeRequired === true,
      },
    };
  }

  /**
   * The forced first change of the start password (POST /auth/portal/password).
   *
   * 1. Claim the row (one conditional UPDATE) so a second concurrent change can't
   *    also reach Firebase: it gets 409 password_change_in_progress.
   * 2. Set the Firebase password and revoke the identity's refresh tokens. On
   *    failure the claim is released and the flag stays.
   * 3. Clear the flag and end every earlier session of this profile (FitFlex
   *    tokens by issue time; Firebase ID tokens by auth_time, at sign-in).
   * Returns the updated row; the caller mints the new session.
   */
  async function changeStartPassword({ userId, newPassword, ip = null, userAgent = null }) {
    const user = userId ? await users.findByIdAsync(userId) : null;
    if (!user || user.userType !== 'admin') return { error: 'portal_user_not_found', status: 404 };
    if (user.passwordChangeRequired !== true) return { error: 'password_change_not_required', status: 409 };
    if (typeof newPassword !== 'string' || newPassword.length < PORTAL_PASSWORD_MIN_LENGTH) {
      return { error: 'password_too_short', status: 400, minLength: PORTAL_PASSWORD_MIN_LENGTH };
    }
    if (!pepper()) return { error: 'start_password_not_configured', status: 503 };
    // No start password to compare with when the identity existed before (startPasswordHash null).
    if (user.startPasswordHash && sameDigest(startPasswordHash(user.id, newPassword), user.startPasswordHash)) {
      return { error: 'password_unchanged', status: 400 };
    }
    if (!user.firebaseUid) return { error: 'firebase_update_failed', status: 502 };
    if (!db) return { error: 'start_password_not_configured', status: 503 };

    // 1. Claim. Whole milliseconds, so the release and the finish can match it exactly.
    const claimedAt = new Date(Date.now());
    const claimed = await db('User')
      .where({ id: user.id, passwordChangeRequired: true })
      .andWhere(q => q.whereNull('passwordChangeClaimedAt').orWhere('passwordChangeClaimedAt', '<', new Date(+claimedAt - CHANGE_CLAIM_MS)))
      .update({ passwordChangeClaimedAt: claimedAt })
      .returning('id');
    if (!claimed.length) {
      const now = await users.findByIdAsync(user.id);
      return now?.passwordChangeRequired === true
        ? { error: 'password_change_in_progress', status: 409 }
        : { error: 'password_change_not_required', status: 409 };
    }
    const mine = () => db('User').where({ id: user.id, passwordChangeClaimedAt: claimedAt });

    // 2. Firebase.
    let refreshTokensRevoked = false;
    try {
      initFirebaseAdmin();
      await getAdminAuth().updateUser(user.firebaseUid, { password: newPassword });
    } catch (fbErr) {
      // The flag stays: the start password is still the working one.
      console.error('[portal-users] Firebase password update failed:', fbErr?.message);
      await mine().update({ passwordChangeClaimedAt: null }).catch(err => console.error('[portal-users] claim release failed:', err?.message));
      return { error: 'firebase_update_failed', status: 502 };
    }
    try {
      await getAdminAuth().revokeRefreshTokens(user.firebaseUid);
      refreshTokensRevoked = true;
    } catch (err) {
      // The password is already changed; a saved ID token is still refused at sign-in by auth_time.
      console.error('[portal-users] Firebase refresh-token revocation failed:', err?.message);
    }

    // 3. Session issue times (FitFlex iat, Firebase auth_time) are whole seconds: cut
    // off at the start of this second, so the session minted straight after stays valid.
    const done = Date.now();
    let finished = 0;
    try {
      finished = (await mine().update({
        passwordChangeRequired: false, startPasswordHash: null, passwordChangeClaimedAt: null,
        sessionsValidAfter: new Date(Math.floor(done / 1000) * 1000), updatedAt: new Date(done),
      }).returning('id')).length;
    } catch (err) {
      console.error('[portal-users] clearing the start-password flag failed:', err?.message);
    }
    forgetSession(user.id);
    // The password IS changed but the profile could not be updated: tell the portal to sign in
    // again with the new password (the flag stays, so the next session is still held to this route).
    if (!finished) return { error: 'password_changed_session_failed', status: 500 };

    await auditLog.insertAsync({
      id: randomUUID(), at: new Date(done).toISOString(),
      actor: user.id, action: 'portal_user.password_changed',
      target: user.id, before: { passwordChangeRequired: true },
      after: { passwordChangeRequired: false, sessionsEnded: true, refreshTokensRevoked, ip, userAgent },
    });
    return { user: await users.findByIdAsync(user.id) };
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

    // Admin-portal audit S1: a change of scopes, status or super-admin standing ends the
    // person's existing sessions at the next request (the token's claims are otherwise
    // trusted until it expires). Cut off at the start of the NEXT whole second, because
    // token issue times are whole seconds; a fresh sign-in a moment later is valid.
    if (scopesChange || statusChange || portalUserChange) {
      patch.sessionsValidAfter = new Date((Math.floor(Date.now() / 1000) + 1) * 1000);
    }
    const updated = await users.upsertAsync(u => u.id === target.id, { ...target, ...patch, updatedAt: new Date().toISOString() });
    forgetSession(target.id);
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
    // S1: the deleted account's token must stop working now (the status lookup reports it missing).
    forgetSession(target.id);
    await auditLog.insertAsync({
      id: randomUUID(), at: new Date().toISOString(),
      actor: actorId, action: 'portal_user_deleted',
      target: target.id, before: { email: target.email }, after: null
    });
    return { ok: true };
  }

  return { list, create, update, remove, changeStartPassword };
}
