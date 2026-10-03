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
});

export const isPin = pin => /^\d{4}$/.test(String(pin ?? ''));
const SETUP = 'pin_setup';
const ADOPT_CODE = 'pin_adopt';
const sha256 = v => createHash('sha256').update(String(v)).digest('hex');
const INVALID = { error: 'invalid_credentials', status: 401 };

export function createPinAuthService({
  db, users, codes, identityLink, sessionForPerson, verifyFirebasePassword,
  signPurpose, verifyPurpose, pepper, linkingEnabled = () => false, auditLog = null,
}) {
  const keyed = (personId, pin) => createHmac('sha256', String(pepper())).update(`${personId}:${pin}`).digest('hex');
  const configured = () => Boolean(pepper());

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
      return { session: await sessionForPerson(person.id) };
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
      return checked.ok ? sessionForPerson(person.id) : checked;
    }
    const adopted = await adopt(identifier, pin, ip, body.locale);
    if (adopted) return adopted.session ?? adopted.response;
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
    return sessionForPerson(person.id);
  }

  /** End every session of this person issued before now (for PIN reset and change, I7c). */
  async function endSessions(personId) {
    await db('Person').where({ id: personId }).update({ sessionsValidAfter: db.fn.now(), updatedAt: db.fn.now() });
  }

  return { login, setup, setPin, endSessions, configured };
}
