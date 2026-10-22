// Gym-staff roster service (RBAC) — owners create gym-level staff (e.g.
// receptionists) scoped to their own gym(s) with a per-feature ACL.
//
// Phase B · B3a (owner decisions 2026-10-20): the PIN an owner chooses for a
// staff member is a start PIN. The row is marked passwordChangeRequired (the
// column and `pwc` mechanism of functions#219); while STAFF_PIN_CHANGE_REQUIRED
// is on, every session of that staff member is held to POST /auth/pin/change
// until they choose their own. An owner reset (POST /owner/staff/:id/pin) sets
// a new start PIN and holds them again. Staff who joined by invitation chose
// their own credentials and are never marked.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { deleteFirebaseUserIfUnshared } from '../shared/firebase-identity.mjs';
import { parseStringList } from '../shared/parse-list.mjs';
import { normalizeEmail, sameEmail } from '../shared/identifiers.mjs';
import { staffPinChangeRequiredOn } from '../shared/feature-flags.mjs';
import { mustChangeStartCredential } from '../shared/credential-change.mjs';

export const GYM_STAFF_ACL_SCOPES = ['members', 'checkins', 'payments', 'trainers', 'gyms', 'shop', 'communications'];

/** The Firebase password the app and portal derive from a PIN (mobile pin_credentials.dart, portal passwordForPin). */
export const firebasePasswordForPin = pin => `fitflex-pin:${pin}`;
const isPin = pin => /^\d{4}$/.test(String(pin ?? ''));
/** A change request holds the row this long at most; after it another request may take over (as #219). */
const CHANGE_CLAIM_MS = 60_000;

export function createOwnerStaffService({
  users, auditLog, initFirebaseAdmin, getAdminAuth,
  // B3a. Knex handle (the change claim is one conditional UPDATE); null in unit specs that never reset or change.
  db = null,
  // The server key the start PIN digest is mixed with (PIN_PEPPER). Null = no digest kept ("unchanged" not checked).
  pepper = () => null,
  // The FitFlex-held PIN service (I7a), read lazily: { configured(), setPin(personId, pin), endSessions(personId) }.
  pinAuth = () => null,
  // Server-side email + password check against Firebase (src/auth/firebase-password.mjs):
  // async (email, password) => { configured, ok, uid?, unreachable? }. Used to refuse "change" to the owner's PIN.
  verifyFirebasePassword = async () => ({ configured: false, ok: false }),
  // Drop the cached session check for a profile, so ended sessions stop at once.
  forgetSession = () => {},
}) {
  /** Keyed digest of the Firebase password made from the start PIN, so "new = start" can be refused. */
  const startPinDigest = (userId, pin) => (pepper()
    ? createHmac('sha256', String(pepper())).update(`start-password:${userId}:${firebasePasswordForPin(pin)}`).digest('hex')
    : null);
  /** Same digest for a raw password as the owner's app sent it (already `fitflex-pin:<pin>`). */
  const startPasswordDigest = (userId, password) => (pepper()
    ? createHmac('sha256', String(pepper())).update(`start-password:${userId}:${password}`).digest('hex')
    : null);
  const sameDigest = (a, b) => {
    const x = Buffer.from(String(a || ''), 'hex');
    const y = Buffer.from(String(b || ''), 'hex');
    return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
  };
  const audit = (actor, action, target, before, after) => auditLog.insertAsync({
    id: randomUUID(), at: new Date().toISOString(), actor, action, target, before, after,
  });

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
      // B3a: still on the PIN the owner chose (only shown while the switch is on).
      ...(staffPinChangeRequiredOn() ? { passwordChangeRequired: mustChangeStartCredential(u) } : {}),
    };
  }

  async function list(ownerGymIds) {
    const rows = await users.filterAsync(u => u.userType === 'gym_staff' && (u.gymIds || []).some(id => ownerGymIds.includes(id)));
    return rows.map(hydrateStaff);
  }

  async function create({ ownerGymIds, body, actorId }) {
    const { email: rawEmail, password, displayName, aclPermissions = [], gymIds = [] } = body || {};
    const email = normalizeEmail(rawEmail);
    if (!email || !password) return { error: 'email_and_password_required', status: 400 };
    if (!displayName) return { error: 'displayName_required', status: 400 };
    if (!Array.isArray(aclPermissions)) return { error: 'aclPermissions_must_be_array', status: 400 };
    const invalidScopes = aclPermissions.filter(p => !GYM_STAFF_ACL_SCOPES.includes(p));
    if (invalidScopes.length) return { error: 'invalid_acl_scopes', status: 400, invalid: invalidScopes };
    const scopedGymIds = parseStringList(gymIds, []).filter(id => ownerGymIds.includes(id));
    if (scopedGymIds.length === 0) return { error: 'must_assign_to_at_least_one_owned_gym', status: 400 };

    const existing = await users.findAsync(u => sameEmail(u.email, email) && u.userType === 'gym_staff');
    if (existing) return { error: 'email_already_in_use', status: 409 };

    let firebaseUid = null;
    // True only when this call set the Firebase password (the owner knows it).
    let passwordSetByOwner = false;
    try {
      initFirebaseAdmin();
      const fbUser = await getAdminAuth().createUser({ email, password, displayName });
      firebaseUid = fbUser.uid;
      passwordSetByOwner = true;
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

    const id = `usr_${randomUUID().slice(0, 8)}`;
    const row = {
      id,
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
      // B3a: the owner chose this credential. Always recorded; it holds the
      // staff member's sessions only while STAFF_PIN_CHANGE_REQUIRED is on.
      // Marked also on an identity that already existed in Firebase (as #219).
      passwordChangeRequired: true,
      startPasswordHash: passwordSetByOwner ? startPasswordDigest(id, password) : null,
      createdAt: new Date().toISOString(),
    };
    const created = await users.upsertAsync(u => u.id === row.id, row);
    await auditLog.insertAsync({
      id: randomUUID(), at: new Date().toISOString(),
      actor: actorId, action: 'gym_staff_created',
      target: row.id, before: null, after: { email: row.email, aclPermissions, gymIds: scopedGymIds, passwordChangeRequired: true, existingIdentity: !passwordSetByOwner },
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
    await auditLog.insertAsync({
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
    await deleteFirebaseUserIfUnshared({ users, row: target, initFirebaseAdmin, getAdminAuth, logTag: 'owner-staff' });
    await users.removeAsync(u => u.id === target.id);
    await auditLog.insertAsync({
      id: randomUUID(), at: new Date().toISOString(),
      actor: actorId, action: 'gym_staff_removed',
      target: target.id, before: { email: target.email }, after: null,
    });
    return { ok: true };
  }

  // ── B3a: start PIN reset and the forced change ──────────────────────────────

  /** Whole seconds: session issue times (FitFlex iat, Firebase auth_time) are seconds. */
  const secondStart = ms => new Date(Math.floor(ms / 1000) * 1000);

  /**
   * The PIN FitFlex itself holds for this Person (I7a), if any, made to match
   * `pin`; without the PIN key it is cleared instead, so an old PIN can never
   * keep working. Returns what was done.
   */
  async function alignHeldPin(personId, pin) {
    if (!personId) return 'none';
    const person = await db('Person').where({ id: personId }).first('id', 'pinHash');
    if (!person?.pinHash) return 'none';
    const service = pinAuth();
    if (service?.configured()) { await service.setPin(personId, pin); return 'replaced'; }
    await db('Person').where({ id: personId }).update({ pinHash: null, pinSetAt: null, updatedAt: db.fn.now() });
    return 'cleared';
  }

  /** End every session of the Person (all its personas) and of this profile. */
  async function endAllSessions(user, at) {
    await db('User').where({ id: user.id }).update({ sessionsValidAfter: secondStart(at) });
    if (user.personId && pinAuth()) await pinAuth().endSessions(user.personId);
    forgetSession(user.id);
  }

  /**
   * Owner: give a staff member a new start PIN (they forgot theirs). The staff
   * member is signed out everywhere and must choose their own PIN at the next
   * sign-in (owner decision 2026-10-20). Refused for a staff profile that
   * shares its sign-in with another profile (joined by invitation, or an email
   * that already had a FitFlex account): that credential is the person's own.
   */
  async function resetPin({ ownerGymIds, staffId, body, actorId }) {
    const target = await users.findAsync(u => u.id === staffId && u.userType === 'gym_staff');
    if (!target) return { error: 'staff_not_found', status: 404 };
    // A credential reset needs the owner to own EVERY gym this staff row covers (review of #260, finding 4).
    const staffGymIds = (target.gymIds && target.gymIds.length) ? target.gymIds : (target.gymId ? [target.gymId] : []);
    if (!staffGymIds.length || !staffGymIds.every(id => ownerGymIds.includes(id))) return { error: 'staff_not_at_your_gym', status: 403 };
    const pin = String(body?.pin ?? '');
    if (!isPin(pin)) return { error: 'pin_must_be_4_digits', status: 400 };
    if (!db) return { error: 'pin_reset_not_configured', status: 503 };
    if (!target.firebaseUid) return { error: 'staff_identity_shared', status: 409 };
    const sharing = await db('User').whereNot({ id: target.id })
      .andWhere(q => {
        q.where({ firebaseUid: target.firebaseUid });
        if (target.personId) q.orWhere({ personId: target.personId });
      })
      .first('id');
    if (sharing) return { error: 'staff_identity_shared', status: 409 };

    // Hold first, then change the credential: if Firebase fails the staff member
    // is signed out and held (fail closed), never left on an unheld new PIN.
    const at = Date.now();
    await db('User').where({ id: target.id }).update({
      passwordChangeRequired: true, startPasswordHash: startPinDigest(target.id, pin),
      passwordChangeClaimedAt: null, updatedAt: new Date(at),
    });
    await endAllSessions(target, at);
    try {
      initFirebaseAdmin();
      await getAdminAuth().updateUser(target.firebaseUid, { password: firebasePasswordForPin(pin) });
    } catch (fbErr) {
      console.error('[owner-staff] Firebase PIN reset failed:', fbErr?.message);
      await audit(actorId, 'gym_staff.pin_reset_failed', target.id, null, { error: 'firebase_update_failed', sessionsEnded: true });
      return { error: 'firebase_update_failed', status: 502 };
    }
    let refreshTokensRevoked = false;
    try {
      await getAdminAuth().revokeRefreshTokens(target.firebaseUid);
      refreshTokensRevoked = true;
    } catch (err) {
      // The PIN is already changed; an older Firebase ID token is refused at sign-in by auth_time.
      console.error('[owner-staff] Firebase refresh-token revocation failed:', err?.message);
    }
    const heldPin = await alignHeldPin(target.personId, pin);
    await audit(actorId, 'gym_staff.pin_reset', target.id,
      { passwordChangeRequired: target.passwordChangeRequired === true },
      { passwordChangeRequired: true, sessionsEnded: true, refreshTokensRevoked, heldPin });
    return { staff: hydrateStaff(await users.findByIdAsync(target.id)) };
  }

  /**
   * Is `pin` the start PIN the owner chose? (security review of #260, finding 1)
   * - The keyed digest kept at create/reset answers it when present and the key is set.
   * - Otherwise (staff marked by the migration, a missing or changed PIN_PEPPER)
   *   the current Firebase credential does: signing in with `fitflex-pin:<pin>`
   *   works only if it is still the owner's. It is also asked when a digest
   *   exists, so a changed key cannot let the owner's PIN through.
   * - If neither can answer, refuse (503 pin_check_unavailable) rather than accept.
   */
  async function isStartPin(user, pin) {
    const digest = pepper() && user.startPasswordHash ? startPinDigest(user.id, pin) : null;
    if (digest && sameDigest(digest, user.startPasswordHash)) return { same: true };
    let firebase = { configured: false, ok: false };
    if (user.email) {
      try {
        firebase = await verifyFirebasePassword(user.email, firebasePasswordForPin(pin));
      } catch (err) {
        console.warn('[owner-staff] Firebase PIN check failed:', err?.message);
        firebase = { configured: true, ok: false, unreachable: true };
      }
    }
    const firebaseAnswered = firebase?.configured === true && !firebase.unreachable;
    if (firebaseAnswered && firebase.ok) return { same: true };
    if (firebaseAnswered || digest) return { same: false };
    return { error: 'pin_check_unavailable', status: 503 };
  }

  /**
   * The staff member replaces the start PIN the owner chose (POST /auth/pin/change).
   * The same sequence as the portal admin change (#219):
   * 1. claim the row (one conditional UPDATE): a concurrent change gets 409;
   * 2. set the Firebase password and revoke refresh tokens (failure: claim released, flag stays);
   * 3. make the FitFlex-held PIN match, clear the flag, end every earlier session
   *    of the Person, and audit. The caller mints the new session.
   */
  async function changeStartPin({ userId, newPin, ip = null, userAgent = null }) {
    const user = userId ? await users.findByIdAsync(userId) : null;
    if (!user || user.userType !== 'gym_staff') return { error: 'staff_not_found', status: 404 };
    if (!mustChangeStartCredential(user)) return { error: 'pin_change_not_required', status: 409 };
    const pin = String(newPin ?? '');
    if (!isPin(pin)) return { error: 'pin_must_be_4_digits', status: 400 };
    const unchanged = await isStartPin(user, pin);
    if (unchanged.error) return unchanged;
    if (unchanged.same) return { error: 'pin_unchanged', status: 400 };
    if (!db) return { error: 'pin_change_not_configured', status: 503 };
    if (!user.firebaseUid) return { error: 'firebase_update_failed', status: 502 };

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
        ? { error: 'pin_change_in_progress', status: 409 }
        : { error: 'pin_change_not_required', status: 409 };
    }
    const mine = () => db('User').where({ id: user.id, passwordChangeClaimedAt: claimedAt });

    // 2. Firebase: the credential the owner knows is the Firebase password.
    try {
      initFirebaseAdmin();
      await getAdminAuth().updateUser(user.firebaseUid, { password: firebasePasswordForPin(pin) });
    } catch (fbErr) {
      console.error('[owner-staff] Firebase PIN update failed:', fbErr?.message);
      await mine().update({ passwordChangeClaimedAt: null }).catch(err => console.error('[owner-staff] claim release failed:', err?.message));
      return { error: 'firebase_update_failed', status: 502 };
    }
    let refreshTokensRevoked = false;
    try {
      await getAdminAuth().revokeRefreshTokens(user.firebaseUid);
      refreshTokensRevoked = true;
    } catch (err) {
      console.error('[owner-staff] Firebase refresh-token revocation failed:', err?.message);
    }

    // 3. The PIN FitFlex holds (app PIN sign-in) must not stay the owner's either.
    let heldPin = 'none';
    try {
      heldPin = await alignHeldPin(user.personId, pin);
    } catch (err) {
      console.error('[owner-staff] held PIN update failed:', err?.message);
    }
    const done = Date.now();
    let finished = 0;
    try {
      finished = (await mine().update({
        passwordChangeRequired: false, startPasswordHash: null, passwordChangeClaimedAt: null,
        sessionsValidAfter: secondStart(done), updatedAt: new Date(done),
      }).returning('id')).length;
      if (finished && user.personId && pinAuth()) await pinAuth().endSessions(user.personId);
    } catch (err) {
      console.error('[owner-staff] clearing the start-PIN flag failed:', err?.message);
    }
    forgetSession(user.id);
    // The PIN IS changed but the profile could not be updated: sign in again with the new PIN
    // (the flag stays, so that session is still held to this route).
    if (!finished) {
      // Release the claim so the next attempt (with the new PIN) is not held for 60 s.
      await mine().update({ passwordChangeClaimedAt: null }).catch(err => console.error('[owner-staff] claim release failed:', err?.message));
      return { error: 'pin_changed_session_failed', status: 500 };
    }

    await audit(user.id, 'gym_staff.pin_changed', user.id,
      { passwordChangeRequired: true },
      { passwordChangeRequired: false, sessionsEnded: true, refreshTokensRevoked, heldPin, ip, userAgent });
    return { user: await users.findByIdAsync(user.id) };
  }

  return { list, create, update, remove, resetPin, changeStartPin };
}
