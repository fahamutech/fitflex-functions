// Identity V2 · I7a — sign in with a mobile number or email and a PIN.
//
// Design confirmed 2 Oct 2026: FitFlex keeps the PIN and checks it itself;
// a number or email signs in only once it has been verified; the PIN is four
// digits; there is no code at sign-in. Because a four-digit PIN has only
// 10,000 possibilities, everything here limits guessing:
//   - the PIN is stored as a slow hash of a keyed digest; the key (PIN_PEPPER)
//     lives in the server environment, so a copied database is not enough
//   - 5 wrong PINs in a row pause sign-in for 15 minutes; 10 in a row switch
//     the PIN off until it is reset with a code
//   - attempts are also limited per identifier and per network address
//   - "no such account" and "wrong PIN" get the same answer
//
// Existing users' PINs have only ever lived in Firebase (as the password
// `fitflex-pin:<pin>`). The first time such a person signs in here, the PIN is
// checked against Firebase once, their email is proved with a FitFlex code,
// and they then keep a four-digit PIN with FitFlex (their old one if it is
// four digits, a new one otherwise).
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { hashPassword, verifyPassword } from '../auth/password-credentials.mjs';
import { parseIdentifier } from './identifier-service.mjs';

const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
/** Confirmed 2 Oct 2026 (lockout); the per-identifier and per-address limits are defaults. Env-overridable. */
export const pinLimits = () => ({
  lockAfter: num('PIN_LOCK_AFTER', 5),
  lockMinutes: num('PIN_LOCK_MINUTES', 15),
  disableAfter: num('PIN_DISABLE_AFTER', 10),
  windowMinutes: num('PIN_ATTEMPT_WINDOW_MINUTES', 15),
  failuresPerIdentifier: num('PIN_FAILURES_PER_IDENTIFIER', 10),
  failuresPerAddress: num('PIN_FAILURES_PER_ADDRESS', 30),
  resetStartsPerAddressPerHour: num('PIN_RESET_STARTS_PER_ADDRESS_PER_HOUR', 10),
});

export const isPin = pin => /^\d{4}$/.test(String(pin ?? ''));
const SETUP = 'pin_setup';
const ADOPT_CODE = 'pin_adopt';
const RESET = 'pin_reset';
export const INVITE_START = 'invite_start';
export const ONBOARDING = 'onboarding';
const START_PIN_TRIES = 5;
const sha256 = v => createHash('sha256').update(String(v)).digest('hex');
const INVALID = { error: 'invalid_credentials', status: 401 };

export function createPinAuthService({
  db, users, codes, identityLink, sessionForPerson, verifyFirebasePassword,
  signPurpose, verifyPurpose, pepper, linkingEnabled = () => false, auditLog = null,
  // Drop cached session checks for a profile, so an ended session stops at once.
  forgetSession = () => {},
  // For a person who has no profile yet: their open invitations (I6 start PIN).
  invitationsFor = async () => [],
}) {
  const keyed = (personId, pin) => createHmac('sha256', String(pepper())).update(`${personId}:${pin}`).digest('hex');
  const configured = () => Boolean(pepper());
  /** The start PIN sent with an invitation: short-lived and try-limited, so a keyed digest is enough. */
  const startPinHash = (invitationId, pin) => createHmac('sha256', String(pepper())).update(`start:${invitationId}:${pin}`).digest('hex');

  /** What a signed-in person with no profile yet gets instead of a session. */
  async function onboarding(personId) {
    return {
      onboarding: true,
      onboardingToken: signPurpose(ONBOARDING, { pid: personId }, '30m'),
      invitations: await invitationsFor(personId),
    };
  }
  /**
   * A session, or the onboarding step when the person has no profile to open
   * (someone who declined an invitation and has not chosen a role yet). Every
   * flow that ends by signing the person in goes through this.
   */
  async function enter(personId) {
    const session = await sessionForPerson(personId);
    return session.error === 'no_profile' ? onboarding(personId) : session;
  }

  /**
   * Someone new to FitFlex signing in with the start PIN from an invitation.
   * A match hands back a token for the next step (their name and their own
   * PIN); nothing exists for them yet. A miss counts against every open
   * start PIN for that identifier, and five misses switch it off.
   */
  async function startPinLogin(identifier, pin, ip) {
    if (!isPin(pin)) return null;
    const open = await db('Invitation')
      .where({ identifierType: identifier.type, identifierValue: identifier.value, status: 'pending' })
      .whereNull('targetPersonId').whereNotNull('startPinHash').whereNull('startPinUsedAt')
      .where('expiresAt', '>', db.fn.now()).orderBy('createdAt', 'desc');
    if (!open.length) return null;
    const match = open.find(inv => inv.startPinHash === startPinHash(inv.id, pin));
    if (!match) {
      for (const inv of open) {
        const tries = inv.startPinAttempts + 1;
        await db('Invitation').where({ id: inv.id })
          .update({ startPinAttempts: tries, ...(tries >= START_PIN_TRIES ? { startPinHash: null } : {}) });
      }
      return null;
    }
    await attempt(identifier, ip, null, 'ok');
    return {
      startPin: true,
      startToken: signPurpose(INVITE_START, { inv: match.id, type: identifier.type, value: identifier.value }, '30m'),
      invitation: { orgType: match.orgType, role: match.role },
    };
  }

  async function setPin(personId, pin) {
    await db('Person').where({ id: personId }).update({
      pinHash: await hashPassword(keyed(personId, pin)), pinSetAt: db.fn.now(),
      pinFailedCount: 0, pinLockedUntil: null, updatedAt: db.fn.now(),
    });
  }

  const attempt = (identifier, ip, personId, outcome) => db('AuthAttempt').insert({
    id: `aat_${randomUUID().replace(/-/g, '').slice(0, 12)}`, kind: 'pin_login',
    identifierHash: sha256(`${identifier.type}:${identifier.value}`), ip: ip || null, personId: personId || null, outcome,
  });

  /** Too many recent failures for this identifier, or from this address. */
  async function throttled(identifier, ip) {
    const limits = pinLimits();
    const since = new Date(Date.now() - limits.windowMinutes * 60e3);
    const failures = where => db('AuthAttempt').where({ kind: 'pin_login', outcome: 'fail', ...where })
      .where('createdAt', '>', since).count({ n: '*' }).first().then(r => Number(r.n));
    if (await failures({ identifierHash: sha256(`${identifier.type}:${identifier.value}`) }) >= limits.failuresPerIdentifier) return true;
    return Boolean(ip) && await failures({ ip }) >= limits.failuresPerAddress;
  }
  const tooMany = seconds => ({ error: 'too_many_attempts', status: 429, retryAfterSeconds: Math.max(1, Math.ceil(seconds)) });

  const verifiedPerson = identifier => db('LoginIdentifier')
    .join('Person', 'Person.id', 'LoginIdentifier.personId')
    .where({ 'LoginIdentifier.type': identifier.type, 'LoginIdentifier.normalizedValue': identifier.value, 'LoginIdentifier.status': 'active' })
    .whereNotNull('LoginIdentifier.verifiedAt')
    .first('Person.id as id', 'Person.status as status', 'Person.pinHash as pinHash',
      'Person.pinFailedCount as pinFailedCount', 'Person.pinLockedUntil as pinLockedUntil');

  /** The PIN FitFlex holds for this person, with the lockout. */
  async function checkHeldPin(person, pin, identifier, ip) {
    const limits = pinLimits();
    if (person.pinFailedCount >= limits.disableAfter) return { error: 'pin_reset_required', status: 403 };
    const lockedFor = person.pinLockedUntil ? (+new Date(person.pinLockedUntil) - Date.now()) / 1000 : 0;
    if (lockedFor > 0) return tooMany(lockedFor);
    if (await verifyPassword(keyed(person.id, pin), person.pinHash)) {
      await db('Person').where({ id: person.id }).update({ pinFailedCount: 0, pinLockedUntil: null });
      await attempt(identifier, ip, person.id, 'ok');
      return { ok: true };
    }
    const failed = person.pinFailedCount + 1;
    await db('Person').where({ id: person.id }).update({
      pinFailedCount: failed,
      // From the fifth wrong PIN on, every wrong one pauses sign-in again.
      pinLockedUntil: failed >= limits.lockAfter ? new Date(Date.now() + limits.lockMinutes * 60e3) : null,
    });
    await attempt(identifier, ip, person.id, 'fail');
    if (auditLog && failed === limits.disableAfter) {
      await auditLog.insertAsync({ id: randomUUID(), at: new Date().toISOString(), actor: null, action: 'pin_disabled', target: person.id, before: null, after: { failed } });
    }
    if (failed >= limits.disableAfter) return { error: 'pin_reset_required', status: 403 };
    if (failed >= limits.lockAfter) return tooMany(limits.lockMinutes * 60);
    return INVALID;
  }

  /**
   * An existing user whose PIN is still only in Firebase. Proves the PIN
   * there; then either adopts it at once (email already verified, four
   * digits) or hands back a setup token for the next step.
   */
  async function adopt(identifier, pin, ip, locale) {
    if (identifier.type !== 'email' || !/^\d{4,8}$/.test(pin)) return null;
    const fb = await verifyFirebasePassword(identifier.value, `fitflex-pin:${pin}`);
    if (!fb.ok) return null;
    const row = await db('User').where({ firebaseUid: fb.uid }).whereNotNull('personId').orderBy('createdAt').first('id', 'personId');
    if (!row) return null;
    const person = await db('Person').where({ id: row.personId }).first('id', 'status', 'pinHash');
    // Someone who already keeps a PIN with FitFlex signs in with a verified identifier.
    if (!person || person.status !== 'active' || person.pinHash) return null;

    const emailVerified = Boolean(await db('LoginIdentifier')
      .where({ personId: person.id, type: 'email', normalizedValue: identifier.value, status: 'active' }).whereNotNull('verifiedAt').first('id'));
    await attempt(identifier, ip, person.id, 'ok');
    if (emailVerified && isPin(pin)) {
      await setPin(person.id, pin);
      return { session: await enter(person.id) };
    }
    let sent = null;
    if (!emailVerified) {
      sent = await codes.sendCode({ purpose: ADOPT_CODE, personId: person.id, requestedBy: row.id, identifier, locale });
      // A code sent a moment ago is still good: let them use it.
      if (sent.error && sent.error !== 'code_resend_too_soon') return { response: sent };
    }
    return {
      response: {
        setupRequired: true,
        // Prove the email with the code we just sent, then set the PIN.
        verificationRequired: !emailVerified, identifierType: 'email', identifierValue: identifier.value,
        // Their old PIN can be kept only if it is four digits.
        pinChangeRequired: !isPin(pin),
        setupToken: signPurpose(SETUP, { pid: person.id, uid: fb.uid, anchor: row.id, email: identifier.value, needsCode: !emailVerified }),
        ...(sent && !sent.error ? { expiresInSeconds: sent.expiresInSeconds, resendAfterSeconds: sent.resendAfterSeconds } : {}),
      },
    };
  }

  /** Number or email + PIN. */
  async function login({ body = {}, ip = null }) {
    if (!configured()) return { error: 'pin_not_configured', status: 503 };
    const identifier = parseIdentifier(body);
    if (!identifier) return { error: 'one_phone_or_email_required', status: 400 };
    const pin = String(body.pin ?? '');
    if (!/^\d{4,8}$/.test(pin)) return { error: 'pin_required', status: 400 };
    if (await throttled(identifier, ip)) return tooMany(pinLimits().windowMinutes * 60);

    const person = await verifiedPerson(identifier);
    if (person?.pinHash) {
      if (person.status !== 'active') { await attempt(identifier, ip, person.id, 'fail'); return INVALID; }
      const checked = await checkHeldPin(person, pin, identifier, ip);
      return checked.ok ? enter(person.id) : checked;
    }
    const adopted = await adopt(identifier, pin, ip, body.locale);
    if (adopted) return adopted.session ?? adopted.response;
    const invited = await startPinLogin(identifier, pin, ip);
    if (invited) return invited;
    await attempt(identifier, ip, person?.id ?? null, 'fail');
    return INVALID;
  }

  /** Finish adoption: the code (when one was sent) and the four-digit PIN to keep. */
  async function setup({ body = {} }) {
    if (!configured()) return { error: 'pin_not_configured', status: 503 };
    const claims = verifyPurpose(body.setupToken, SETUP);
    if (!claims) return { error: 'setup_token_invalid', status: 401 };
    if (!isPin(body.pin)) return { error: 'pin_must_be_4_digits', status: 400 };
    const person = await db('Person').where({ id: claims.pid }).first('id', 'status', 'pinHash');
    if (!person || person.status !== 'active') return { error: 'setup_token_invalid', status: 401 };
    // The token works once: after it, they sign in with the PIN.
    if (person.pinHash) return { error: 'pin_already_set', status: 409 };

    const identifier = { type: 'email', value: claims.email };
    if (claims.needsCode) {
      const checked = await codes.consumeCode({ purpose: ADOPT_CODE, personId: person.id, identifier, code: body.code });
      if (checked.error) return checked;
      const linked = await identityLink.linkOnVerifiedSignIn({
        anchorUserId: claims.anchor, uid: claims.uid, email: claims.email,
        provider: 'fitflex_email', trigger: 'pin_adoption', attachOnly: !linkingEnabled(),
      });
      // Someone else proved this email first: it cannot become this person's sign-in.
      if (linked.conflicts.some(c => c.kind === 'verified_identifier_collision' && c.identifierType === 'email')) {
        return { error: 'identifier_in_use', status: 409 };
      }
    }
    await setPin(person.id, String(body.pin));
    if (auditLog) {
      await auditLog.insertAsync({ id: randomUUID(), at: new Date().toISOString(), actor: claims.anchor, action: 'pin_adopted', target: person.id, before: null, after: { emailVerifiedNow: Boolean(claims.needsCode) } });
    }
    return enter(person.id);
  }

  /**
   * End every session of this person issued before now. A session's issue
   * time has whole seconds, so the cut-off is the start of this second: a
   * session minted straight after stays valid.
   */
  async function endSessions(personId) {
    await db('Person').where({ id: personId })
      .update({ sessionsValidAfter: db.raw("date_trunc('second', now())"), updatedAt: db.fn.now() });
    for (const row of await db('User').where({ personId }).select('id')) forgetSession(row.id);
  }

  // ── Forgot PIN (I7c) ──────────────────────────────────────────────────────

  /**
   * Who may reset a PIN through this identifier: the person who has verified
   * it, or, for an email, the one existing account that still signs in
   * through Firebase and has not moved its PIN to FitFlex yet (proving the
   * email by code is then what moves it).
   */
  async function resettable(identifier) {
    const person = await verifiedPerson(identifier);
    if (person) return person.status === 'active' ? { personId: person.id, anchor: null, uid: null } : null;
    if (identifier.type !== 'email') return null;
    const rows = (await db('User').whereRaw('lower(btrim(email)) = ?', [identifier.value]).whereNotNull('firebaseUid').whereNotNull('personId'))
      .filter(u => u.accountStatus !== 'closed');
    const personIds = [...new Set(rows.map(u => u.personId))];
    if (personIds.length !== 1) return null;
    const owner = await db('Person').where({ id: personIds[0] }).first('id', 'status', 'pinHash');
    if (!owner || owner.status !== 'active' || owner.pinHash) return null;
    return { personId: owner.id, anchor: rows[0].id, uid: rows[0].firebaseUid };
  }

  /**
   * Send the reset code. The answer is the same whether or not anyone signs
   * in with this number or email, so it cannot be used to find accounts.
   */
  async function resetStart({ body = {}, ip = null }) {
    if (!configured()) return { error: 'pin_not_configured', status: 503 };
    const identifier = parseIdentifier(body);
    if (!identifier) return { error: 'one_phone_or_email_required', status: 400 };
    const limits = pinLimits();
    if (ip) {
      const recent = Number((await db('AuthAttempt').where({ kind: 'pin_reset_start', ip })
        .where('createdAt', '>', new Date(Date.now() - 3600e3)).count({ n: '*' }).first()).n);
      if (recent >= limits.resetStartsPerAddressPerHour) return tooMany(3600);
    }
    await db('AuthAttempt').insert({
      id: `aat_${randomUUID().replace(/-/g, '').slice(0, 12)}`, kind: 'pin_reset_start',
      identifierHash: sha256(`${identifier.type}:${identifier.value}`), ip: ip || null, outcome: 'ok',
    });
    const channel = identifier.type === 'phone' ? 'sms' : 'email';
    const generic = { sent: true, channel, identifierType: identifier.type, identifierValue: identifier.value, expiresInSeconds: 600, resendAfterSeconds: 60 };
    const target = await resettable(identifier);
    if (!target) return generic;
    const sent = await codes.sendCode({ purpose: RESET, personId: target.personId, requestedBy: target.anchor, identifier, locale: body.locale });
    // Only "we cannot send at all" is reported; limits look like a normal send.
    if (sent.error && ['sms_not_configured', 'email_not_configured', 'code_not_sent'].includes(sent.error)) return sent;
    return sent.error ? { ...generic, ...(sent.retryAfterSeconds ? { resendAfterSeconds: sent.retryAfterSeconds } : {}) } : sent;
  }

  /** Check the reset code; the token it returns is what sets the new PIN. */
  async function resetConfirm({ body = {} }) {
    if (!configured()) return { error: 'pin_not_configured', status: 503 };
    const identifier = parseIdentifier(body);
    if (!identifier) return { error: 'one_phone_or_email_required', status: 400 };
    const target = await resettable(identifier);
    // No account: the same answer as a wrong or expired code.
    if (!target) return { error: 'code_not_found_or_expired', status: 400 };
    const checked = await codes.consumeCode({ purpose: RESET, personId: target.personId, identifier, code: body.code });
    if (checked.error) return checked;
    const person = await db('Person').where({ id: target.personId }).first('pinSetAt');
    return {
      verified: true, expiresInSeconds: 15 * 60,
      resetToken: signPurpose(RESET, {
        pid: target.personId, type: identifier.type, value: identifier.value, channel: checked.channel,
        anchor: target.anchor, uid: target.uid,
        // Ties the token to the PIN as it is now, so it sets a new PIN only once.
        was: person?.pinSetAt ? +new Date(person.pinSetAt) : 0,
      }),
    };
  }

  /** The new PIN. Clears the lockout, ends every other session, and signs in. */
  async function resetComplete({ body = {} }) {
    if (!configured()) return { error: 'pin_not_configured', status: 503 };
    const claims = verifyPurpose(body.resetToken, RESET);
    if (!claims) return { error: 'reset_token_invalid', status: 401 };
    if (!isPin(body.pin)) return { error: 'pin_must_be_4_digits', status: 400 };
    const person = await db('Person').where({ id: claims.pid }).first('id', 'status', 'pinSetAt');
    if (!person || person.status !== 'active') return { error: 'reset_token_invalid', status: 401 };
    if ((person.pinSetAt ? +new Date(person.pinSetAt) : 0) !== claims.was) return { error: 'reset_token_invalid', status: 401 };
    if (claims.anchor) {
      // An account moving off Firebase: the code just proved its email.
      const linked = await identityLink.linkOnVerifiedSignIn({
        anchorUserId: claims.anchor, uid: claims.uid, email: claims.value,
        provider: `fitflex_${claims.channel}`, trigger: 'pin_reset', attachOnly: !linkingEnabled(),
      });
      if (linked.conflicts.some(c => c.kind === 'verified_identifier_collision' && c.identifierType === 'email')) {
        return { error: 'identifier_in_use', status: 409 };
      }
    }
    await setPin(person.id, String(body.pin));
    await endSessions(person.id);
    if (auditLog) {
      await auditLog.insertAsync({ id: randomUUID(), at: new Date().toISOString(), actor: null, action: 'pin_reset', target: person.id, before: null, after: { identifierType: claims.type } });
    }
    return enter(person.id);
  }

  // ── Change PIN (I7c) ──────────────────────────────────────────────────────

  /** A signed-in person changes their PIN: the current one, then the new one. */
  async function changePin({ user, body = {}, ip = null }) {
    if (!configured()) return { error: 'pin_not_configured', status: 503 };
    if (!user?.personId) return { error: 'user_not_found', status: 404 };
    if (!isPin(body.newPin)) return { error: 'pin_must_be_4_digits', status: 400 };
    const person = await db('Person').where({ id: user.personId })
      .first('id', 'status', 'pinHash', 'pinFailedCount', 'pinLockedUntil');
    // Signed in another way (Google, or a PIN still held by Firebase): there is no PIN to change yet.
    if (!person?.pinHash) return { error: 'pin_not_set', status: 409 };
    const checked = await checkHeldPin(person, String(body.currentPin ?? ''), { type: 'person', value: person.id }, ip);
    if (!checked.ok) return checked.error === 'invalid_credentials' ? { error: 'current_pin_incorrect', status: 400 } : checked;
    if (String(body.newPin) === String(body.currentPin)) return { error: 'pin_unchanged', status: 400 };
    await setPin(person.id, String(body.newPin));
    await endSessions(person.id);
    if (auditLog) {
      await auditLog.insertAsync({ id: randomUUID(), at: new Date().toISOString(), actor: user.id, action: 'pin_changed', target: person.id, before: null, after: null });
    }
    // Every earlier session is over, including this one: hand back a new one.
    await identityLink.rememberPersona(person.id, user.id);
    return sessionForPerson(person.id);
  }

  return { login, setup, setPin, endSessions, configured, resetStart, resetConfirm, resetComplete, changePin, startPinHash, onboarding, enter };
}
