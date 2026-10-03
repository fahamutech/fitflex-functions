// Identity V2 · I7b — registering with a mobile number or email.
//
// Design confirmed 2 Oct 2026 (O9–O11): the number or email is proved once,
// with a code FitFlex sends; the person then sets a four-digit PIN; only then
// does the account exist. Three steps:
//   start     send the code (to a number or email that is not registered yet)
//   confirm   check the code; hand back a short-lived registration token
//   complete  the token + role + PIN → the profile, the verified identifier
//             and the PIN, and a session
//
// Nobody is signed in during the first two steps, and each code costs money,
// so requests are limited per network address and capped per day, on top of
// the per-identifier limits every code already has.
//
// Existing people are reused, never duplicated (P6): a profile an
// organisation created earlier with this number or email, and that has no
// sign-in of its own, becomes this person's profile instead of a second one.
import { createHash, randomUUID } from 'node:crypto';
import { normalizeEmail, normalizePhone } from '../shared/identifiers.mjs';
import { parseIdentifier } from './identifier-service.mjs';
import { isPin } from './pin-auth-service.mjs';

const CODE = 'register';
const TOKEN = 'register';
// Roles a person may give themselves; everything else is invited or assigned.
const SELF_ROLES = { member: 'member', trainer: 'trainer', gym_owner: 'gym_operator', gym_operator: 'gym_operator', vendor: 'vendor' };
const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
/** Defaults; env-overridable. */
export const registrationLimits = () => ({
  startsPerAddressPerHour: num('REGISTER_STARTS_PER_ADDRESS_PER_HOUR', 10),
  codesPerDay: num('REGISTER_CODES_PER_DAY', 1000),
});

export function createRegistrationService({
  db, users, codes, identityLink, pinAuth, sessionForPerson, approvalStatusForRole,
  signPurpose, verifyPurpose, claimInvitations = null, linkingEnabled = () => false, auditLog = null,
}) {
  const matchingRows = async identifier => (identifier.type === 'email'
    ? db('User').whereRaw('lower(btrim(email)) = ?', [identifier.value])
    : (await db('User').whereNotNull('phone')
      .whereRaw("regexp_replace(phone, '\\D', '', 'g') LIKE ?", [`%${identifier.value.slice(-9)}`]))
      .filter(u => normalizePhone(u.phone) === identifier.value));

  /** Someone already signs in with this: they should sign in, not register. */
  async function alreadyRegistered(identifier) {
    const verified = await db('LoginIdentifier')
      .join('Person', 'Person.id', 'LoginIdentifier.personId')
      .where({ 'LoginIdentifier.type': identifier.type, 'LoginIdentifier.normalizedValue': identifier.value, 'LoginIdentifier.status': 'active' })
      .whereNotNull('LoginIdentifier.verifiedAt').whereIn('Person.status', ['active', 'suspended']).first('Person.id');
    if (verified) return true;
    if (identifier.type !== 'email') return false;
    // An email that already has a Firebase sign-in (today's app users, Google).
    return (await matchingRows(identifier)).some(u => u.firebaseUid && u.accountStatus !== 'closed');
  }

  /** Send the code. */
  async function start({ body = {}, ip = null }) {
    if (!pinAuth.configured()) return { error: 'pin_not_configured', status: 503 };
    const identifier = parseIdentifier(body);
    if (!identifier) return { error: 'one_phone_or_email_required', status: 400 };
    const limits = registrationLimits();
    if (ip) {
      const recent = Number((await db('AuthAttempt').where({ kind: 'register_start', ip })
        .where('createdAt', '>', new Date(Date.now() - 3600e3)).count({ n: '*' }).first()).n);
      if (recent >= limits.startsPerAddressPerHour) return { error: 'too_many_attempts', status: 429, retryAfterSeconds: 3600 };
    }
    await db('AuthAttempt').insert({
      id: `aat_${randomUUID().replace(/-/g, '').slice(0, 12)}`, kind: 'register_start',
      identifierHash: createHash('sha256').update(`${identifier.type}:${identifier.value}`).digest('hex'), ip: ip || null, outcome: 'ok',
    });
    if (await alreadyRegistered(identifier)) return { error: 'already_registered', status: 409 };
    const today = Number((await db('VerificationCode').where({ purpose: CODE, outcome: 'sent' })
      .where('createdAt', '>', new Date(Date.now() - 86400e3)).count({ n: '*' }).first()).n);
    if (today >= limits.codesPerDay) {
      // The daily cap is the last line of defence against a run-away SMS bill.
      console.error(`[registration] daily code cap reached (${today}/${limits.codesPerDay}); refusing new registrations`);
      return { error: 'registration_busy', status: 503 };
    }
    return codes.sendCode({ purpose: CODE, identifier, locale: body.locale });
  }

  /** Check the code; the token it returns is what completes the registration. */
  async function confirm({ body = {} }) {
    if (!pinAuth.configured()) return { error: 'pin_not_configured', status: 503 };
    const identifier = parseIdentifier(body);
    if (!identifier) return { error: 'one_phone_or_email_required', status: 400 };
    const checked = await codes.consumeCode({ purpose: CODE, identifier, code: body.code });
    if (checked.error) return checked;
    return {
      verified: true, identifierType: identifier.type, identifierValue: identifier.value,
      registrationToken: signPurpose(TOKEN, { type: identifier.type, value: identifier.value, channel: checked.channel }),
      expiresInSeconds: 15 * 60,
    };
  }

  /** A profile created for this person earlier (by a gym, say) that has no sign-in of its own. */
  async function claimable(identifier, userType) {
    for (const row of await matchingRows(identifier)) {
      if (row.userType !== userType || row.firebaseUid || row.accountStatus === 'closed' || !row.personId) continue;
      const person = await db('Person').where({ id: row.personId }).first('status', 'pinHash');
      if (person?.status === 'active' && !person.pinHash) return row;
    }
    return null;
  }

  /** The role and the PIN: the account now exists and the person is signed in. */
  async function complete({ body = {} }) {
    if (!pinAuth.configured()) return { error: 'pin_not_configured', status: 503 };
    const claims = verifyPurpose(body.registrationToken, TOKEN);
    if (!claims) return { error: 'registration_token_invalid', status: 401 };
    const userType = SELF_ROLES[String(body.role ?? 'member')];
    if (!userType) return { error: 'role_not_allowed', status: 400, allowed: ['member', 'trainer', 'gym_owner', 'vendor'] };
    if (!isPin(body.pin)) return { error: 'pin_must_be_4_digits', status: 400 };
    const identifier = { type: claims.type, value: claims.type === 'email' ? normalizeEmail(claims.value) : normalizePhone(claims.value) };
    // The token works once: after it, the identifier is verified and this answers "already registered".
    if (await alreadyRegistered(identifier)) return { error: 'already_registered', status: 409 };

    let row = await claimable(identifier, userType);
    const reused = Boolean(row);
    if (!row) {
      const id = `usr_${randomUUID().slice(0, 8)}`;
      const now = new Date();
      // A phone someone else typed into a profile of this role is only a display
      // copy there; ours is the proved one, kept as the login identifier.
      const phoneTaken = identifier.type === 'phone'
        ? (await matchingRows(identifier)).some(u => u.userType === userType) : false;
      try {
        await db('User').insert({
          id, userType, accountStatus: 'active', approvalStatus: approvalStatusForRole(userType), onboardingCompleted: false,
          email: identifier.type === 'email' ? identifier.value : null,
          phone: identifier.type === 'phone' && !phoneTaken ? identifier.value : null,
          displayName: body.displayName ? String(body.displayName).trim().slice(0, 120) : null,
          createdAt: now, updatedAt: now,
        });
      } catch (err) {
        if (err?.code === '23505') return { error: 'already_registered', status: 409 };
        throw err;
      }
      row = await db('User').where({ id }).first();
    }

    const linked = await identityLink.linkOnVerifiedSignIn({
      anchorUserId: row.id, uid: null,
      email: identifier.type === 'email' ? identifier.value : null,
      phone: identifier.type === 'phone' ? identifier.value : null,
      provider: `fitflex_${claims.channel}`, trigger: 'registration', attachOnly: !linkingEnabled(),
    });
    if (linked.conflicts.some(c => c.kind === 'verified_identifier_collision' && c.identifierType === identifier.type)) {
      // Someone proved it in the same moment. A row we just made is withdrawn.
      if (!reused) await db('User').where({ id: row.id }).update({ accountStatus: 'closed', updatedAt: db.fn.now() });
      return { error: 'already_registered', status: 409 };
    }
    // Through the collection, so the hooks that follow a profile run.
    await users.updateByIdAsync(row.id, { updatedAt: new Date().toISOString() });
    const fresh = await db('User').where({ id: row.id }).first();
    await pinAuth.setPin(fresh.personId, String(body.pin));
    await identityLink.rememberPersona(fresh.personId, fresh.id);
    if (claimInvitations) await claimInvitations(fresh.personId);
    if (auditLog) {
      await auditLog.insertAsync({
        id: randomUUID(), at: new Date().toISOString(), actor: fresh.id, action: 'registered', target: fresh.personId,
        before: null, after: { userType, identifierType: identifier.type, reusedProfile: reused },
      });
    }
    return sessionForPerson(fresh.personId);
  }

  return { start, confirm, complete };
}
