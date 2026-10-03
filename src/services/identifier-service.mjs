// Identity V2 · I6a — a signed-in person proves an email or phone is theirs.
//
// Decision (2 Oct 2026, replacing the Firebase part of O4): FitFlex generates
// the code and delivers it itself, by SMS to a phone and by email to an email.
// The person types it back, and the identifier is recorded as verified on
// their Person, exactly as a verified sign-in records one (I2). Invitations
// addressed to a newly verified identifier are then claimed.
//
// The code is short, so everything around it is limited: it expires quickly,
// dies after a few wrong tries, and requests are limited per identifier and
// per person (each SMS costs money). Only a keyed hash of the code is stored.
// A value another person has verified is never moved: it is refused, and a
// clash found at confirmation is left as an IdentityConflict for review.
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { normalizeEmail, normalizePhone } from '../shared/identifiers.mjs';

const PURPOSE = 'verify_identifier';
const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
/** Proposed defaults (2 Oct 2026); each can be overridden by env. */
export const verificationLimits = () => ({
  codeLength: num('VERIFY_CODE_LENGTH', 6),
  expiryMinutes: num('VERIFY_CODE_EXPIRY_MINUTES', 10),
  maxAttempts: num('VERIFY_CODE_MAX_ATTEMPTS', 5),
  resendSeconds: num('VERIFY_CODE_RESEND_SECONDS', 60),
  perIdentifierPerHour: num('VERIFY_CODE_PER_IDENTIFIER_PER_HOUR', 5),
  perPersonPerDay: num('VERIFY_CODE_PER_PERSON_PER_DAY', 10),
});

const MESSAGES = {
  en: (code, minutes) => `FitFlex: your verification code is ${code}. It expires in ${minutes} minutes. Do not share it with anyone.`,
  sw: (code, minutes) => `FitFlex: namba yako ya uthibitisho ni ${code}. Inaisha baada ya dakika ${minutes}. Usimpe mtu yeyote.`,
};
const SUBJECTS = { en: 'Your FitFlex verification code', sw: 'Namba yako ya uthibitisho ya FitFlex' };

/** { type, value } for exactly one phone or email, or null. */
export function parseIdentifier({ email, phone } = {}) {
  if (email && phone) return null;
  if (email) {
    const value = normalizeEmail(email);
    return value && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) ? { type: 'email', value } : null;
  }
  if (phone) {
    const value = normalizePhone(phone);
    return value ? { type: 'phone', value } : null;
  }
  return null;
}

export function createIdentifierService({
  db, users, identityLink, senders, secret,
  claimInvitations = null, linkingEnabled = () => false, auditLog = null,
}) {
  const hashOf = (rowId, code) => createHmac('sha256', String(secret)).update(`${rowId}:${code}`).digest('hex');
  const sameHash = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const verifiedOwner = ({ type, value }) => db('LoginIdentifier')
    .where({ type, normalizedValue: value, status: 'active' }).whereNotNull('verifiedAt').first('personId');
  const record = (row, purpose = PURPOSE) => db('VerificationCode').insert({ id: `vrc_${randomUUID().replace(/-/g, '').slice(0, 12)}`, purpose, ...row });

  /** The Person's verified emails and phones, plus profile values not verified yet. */
  async function list({ user }) {
    if (!user?.personId) return { error: 'user_not_found', status: 404 };
    const rows = await db('LoginIdentifier')
      .where({ personId: user.personId, status: 'active' }).whereIn('type', ['email', 'phone']).whereNotNull('verifiedAt')
      .orderBy('createdAt').select('type', 'normalizedValue', 'verifiedAt');
    const identifiers = rows.map(r => ({ type: r.type, value: r.normalizedValue, verified: true, verifiedAt: r.verifiedAt }));
    // What the person typed into a profile but has not proved: offered for verification.
    const verified = new Set(identifiers.map(i => `${i.type}:${i.value}`));
    const personas = await db('User').where({ personId: user.personId }).whereNot({ accountStatus: 'closed' }).select('email', 'phone');
    const unverified = new Map();
    for (const p of personas) {
      for (const [type, value] of [['email', normalizeEmail(p.email)], ['phone', normalizePhone(p.phone)]]) {
        if (value && !verified.has(`${type}:${value}`)) unverified.set(`${type}:${value}`, { type, value });
      }
    }
    return { identifiers, unverified: [...unverified.values()] };
  }

  /** Each person may ask only so often, whatever they ask about. */
  async function personLimited(user) {
    const perPerson = Number((await db('VerificationCode').where({ personId: user.personId })
      .where('createdAt', '>', new Date(Date.now() - 86400e3)).count({ n: '*' }).first()).n);
    return perPerson >= verificationLimits().perPersonPerDay ? { error: 'code_rate_limited', status: 429 } : null;
  }

  /** One identifier receives only so many codes, whoever asks. */
  async function identifierLimited(identifier) {
    const limits = verificationLimits();
    const recent = await db('VerificationCode')
      .where({ identifierType: identifier.type, identifierValue: identifier.value, outcome: 'sent' })
      .where('createdAt', '>', new Date(Date.now() - 3600e3)).orderBy('createdAt', 'desc').select('createdAt');
    if (recent.length >= limits.perIdentifierPerHour) return { error: 'code_rate_limited', status: 429 };
    const waited = recent.length ? (Date.now() - +new Date(recent[0].createdAt)) / 1000 : Infinity;
    if (waited < limits.resendSeconds) {
      return { error: 'code_resend_too_soon', status: 429, retryAfterSeconds: Math.ceil(limits.resendSeconds - waited) };
    }
    return null;
  }

  /** Send a code to one phone (SMS) or email. */
  async function requestCode({ user, body = {} }) {
    if (!user?.personId) return { error: 'user_not_found', status: 404 };
    const identifier = parseIdentifier(body);
    if (!identifier) return { error: 'one_phone_or_email_required', status: 400 };
    const channel = identifier.type === 'phone' ? 'sms' : 'email';
    const sender = identifier.type === 'phone' ? senders.sms() : senders.email();
    if (!sender.configured) return { error: `${channel}_not_configured`, status: 503 };

    const owner = await verifiedOwner(identifier);
    if (owner?.personId === user.personId) return { alreadyVerified: true, ...(await list({ user })) };
    const tooMany = await personLimited(user);
    if (tooMany) return tooMany;
    if (owner) {
      // Counted against the limits, so this cannot be used to test many numbers.
      await record({
        personId: user.personId, requestedBy: user.id, identifierType: identifier.type, identifierValue: identifier.value,
        channel, expiresAt: new Date(Date.now() + verificationLimits().expiryMinutes * 60e3), outcome: 'refused',
      });
      return { error: 'identifier_in_use', status: 409 };
    }
    return sendCode({ purpose: PURPOSE, personId: user.personId, requestedBy: user.id, identifier, locale: body.locale });
  }

  /**
   * Generate a code and send it to one identifier, for any flow (`purpose`).
   * Limited per identifier; only its keyed hash is kept. Used here for a
   * signed-in person, and by sign-in flows that start before there is a
   * session (PIN adoption today; registration and PIN reset later).
   */
  async function sendCode({ purpose, personId = null, requestedBy = null, identifier, locale }) {
    const channel = identifier.type === 'phone' ? 'sms' : 'email';
    const sender = identifier.type === 'phone' ? senders.sms() : senders.email();
    if (!sender.configured) return { error: `${channel}_not_configured`, status: 503 };
    const blocked = await identifierLimited(identifier);
    if (blocked) return blocked;
    const limits = verificationLimits();
    const base = {
      personId, requestedBy, identifierType: identifier.type, identifierValue: identifier.value,
      channel, expiresAt: new Date(Date.now() + limits.expiryMinutes * 60e3),
    };
    const rowId = `vrc_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const code = String(randomInt(0, 10 ** limits.codeLength)).padStart(limits.codeLength, '0');
    const lang = locale === 'sw' ? 'sw' : 'en';
    const sent = await sender.send(identifier.value, {
      text: MESSAGES[lang](code, limits.expiryMinutes), subject: SUBJECTS[lang],
    });
    if (!sent.ok) {
      await record({ ...base, outcome: 'send_failed' }, purpose);
      return { error: 'code_not_sent', status: 502 };
    }
    // A new code replaces any earlier one for this purpose and identifier.
    await db('VerificationCode')
      .where({ purpose, identifierType: identifier.type, identifierValue: identifier.value, outcome: 'sent' })
      .where(q => (personId ? q.where({ personId }) : q.whereNull('personId')))
      .whereNull('consumedAt').update({ consumedAt: db.fn.now() });
    await db('VerificationCode').insert({ id: rowId, purpose, ...base, outcome: 'sent', codeHash: hashOf(rowId, code) });
    return {
      sent: true, channel, identifierType: identifier.type, identifierValue: identifier.value,
      expiresInSeconds: limits.expiryMinutes * 60, resendAfterSeconds: limits.resendSeconds,
    };
  }

  /** Check a code sent with sendCode. Returns { ok, channel } or { error, status }. */
  async function consumeCode({ purpose, personId = null, identifier, code }) {
    const value = String(code ?? '').trim();
    if (!value) return { error: 'code_required', status: 400 };
    const row = await db('VerificationCode')
      .where({ purpose, identifierType: identifier.type, identifierValue: identifier.value, outcome: 'sent' })
      .where(q => (personId ? q.where({ personId }) : q.whereNull('personId')))
      .whereNull('consumedAt').where('expiresAt', '>', db.fn.now()).orderBy('createdAt', 'desc').first();
    if (!row) return { error: 'code_not_found_or_expired', status: 400 };
    const limits = verificationLimits();
    if (row.attempts >= limits.maxAttempts) return { error: 'code_attempts_exceeded', status: 429 };
    if (!sameHash(hashOf(row.id, value), row.codeHash)) {
      const attempts = row.attempts + 1;
      await db('VerificationCode').where({ id: row.id }).update({ attempts });
      return attempts >= limits.maxAttempts
        ? { error: 'code_attempts_exceeded', status: 429 }
        : { error: 'code_incorrect', status: 400, attemptsLeft: limits.maxAttempts - attempts };
    }
    await db('VerificationCode').where({ id: row.id }).update({ consumedAt: db.fn.now() });
    return { ok: true, channel: row.channel };
  }

  /** Check the code; on success the identifier is verified on the caller's Person. */
  async function confirmCode({ user, body = {} }) {
    if (!user?.personId) return { error: 'user_not_found', status: 404 };
    const identifier = parseIdentifier(body);
    if (!identifier) return { error: 'one_phone_or_email_required', status: 400 };
    const checked = await consumeCode({ purpose: PURPOSE, personId: user.personId, identifier, code: body.code });
    if (checked.error) return checked;
    const row = checked;

    const result = await identityLink.linkOnVerifiedSignIn({
      anchorUserId: user.id, uid: null,
      email: identifier.type === 'email' ? identifier.value : null,
      phone: identifier.type === 'phone' ? identifier.value : null,
      provider: `fitflex_${row.channel}`, trigger: 'identifier_verify', attachOnly: !linkingEnabled(),
    });
    const fresh = (await users.findByIdAsync(user.id)) || user;
    const taken = result.conflicts.some(c => c.kind === 'verified_identifier_collision' && c.identifierType === identifier.type);
    if (auditLog) {
      await auditLog.insertAsync({
        id: randomUUID(), at: new Date().toISOString(), actor: user.id, action: 'identifier_verified',
        target: fresh.personId, before: null, after: { identifierType: identifier.type, channel: row.channel, refused: taken },
      });
    }
    // Someone else proved it between the request and the confirmation.
    if (taken) return { error: 'identifier_in_use', status: 409 };
    if (claimInvitations) await claimInvitations(fresh.personId);
    return { verified: true, ...(await list({ user: fresh })) };
  }

  return { list, requestCode, confirmCode, sendCode, consumeCode };
}
