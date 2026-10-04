// Identity V2 · I7e — changing the mobile number or email a person signs in with.
//
// Design confirmed 2 Oct 2026: the person enters their PIN, proves the new
// value with a code FitFlex sends to it, and it then replaces the old one of
// the same kind. So changing takes both something they know (the PIN) and
// control of the new number or email; a stolen session alone is not enough.
//
// The old value stops being a way to sign in at once, the copies shown on the
// person's profiles follow, and the old number or email is told about the
// change (best effort), so a change they did not make does not go unnoticed.
//
// Adding a second kind of identifier (a number to an email account, or the
// reverse) is the I6a flow; this is only replacing one. Someone who has lost
// every verified identifier cannot use this: that recovery is a support
// process and is not designed here.
import { randomUUID } from 'node:crypto';
import { parseIdentifier, verificationLimits } from './identifier-service.mjs';

const PURPOSE = 'change_identifier';
const NOTICE = {
  en: {
    subject: 'Your FitFlex sign-in details changed',
    phone: 'FitFlex: the mobile number on your account was changed. This number no longer signs in. If this was not you, contact FitFlex support.',
    email: 'FitFlex: the email on your account was changed. This email no longer signs in. If this was not you, contact FitFlex support.',
  },
  sw: {
    subject: 'Taarifa zako za kuingia FitFlex zimebadilishwa',
    phone: 'FitFlex: namba ya simu kwenye akaunti yako imebadilishwa. Namba hii haitumiki tena kuingia. Kama si wewe, wasiliana na huduma ya FitFlex.',
    email: 'FitFlex: barua pepe kwenye akaunti yako imebadilishwa. Barua pepe hii haitumiki tena kuingia. Kama si wewe, wasiliana na huduma ya FitFlex.',
  },
};

export function createIdentifierChangeService({
  db, users, codes, pinAuth, identityLink, senders = null, linkingEnabled = () => false, auditLog = null,
}) {
  const verifiedOf = (personId, type) => db('LoginIdentifier')
    .where({ personId, type, status: 'active' }).whereNotNull('verifiedAt').select('id', 'normalizedValue');

  /** Someone else already signs in with this value. */
  async function takenByAnother(personId, identifier) {
    const owner = await db('LoginIdentifier')
      .where({ type: identifier.type, normalizedValue: identifier.value, status: 'active' })
      .whereNotNull('verifiedAt').whereNot({ personId }).first('id');
    if (owner) return true;
    if (identifier.type !== 'email') return false;
    // An email another person signs in with through Firebase today.
    const rows = await db('User').whereRaw('lower(btrim(email)) = ?', [identifier.value])
      .whereNotNull('firebaseUid').whereNot({ accountStatus: 'closed' }).select('personId');
    return rows.some(r => r.personId !== personId);
  }

  /** PIN, then a code to the new number or email. */
  async function request({ user, body = {}, ip = null }) {
    if (!user?.personId) return { error: 'user_not_found', status: 404 };
    const identifier = parseIdentifier(body);
    if (!identifier) return { error: 'one_phone_or_email_required', status: 400 };
    const pin = await pinAuth.verifyPin({ personId: user.personId, pin: body.pin, ip });
    if (pin.error) return pin;
    const current = await verifiedOf(user.personId, identifier.type);
    // Nothing of this kind to replace: that is adding one, which is the verify flow.
    if (!current.length) return { error: 'nothing_to_change', status: 409, use: 'POST /me/identifiers/verify/request' };
    if (current.some(c => c.normalizedValue === identifier.value)) return { error: 'identifier_unchanged', status: 400 };
    if (await takenByAnother(user.personId, identifier)) return { error: 'identifier_in_use', status: 409 };
    const today = Number((await db('VerificationCode').where({ personId: user.personId })
      .where('createdAt', '>', new Date(Date.now() - 86400e3)).count({ n: '*' }).first()).n);
    if (today >= verificationLimits().perPersonPerDay) return { error: 'code_rate_limited', status: 429 };
    return codes.sendCode({ purpose: PURPOSE, personId: user.personId, requestedBy: user.id, identifier, locale: body.locale });
  }

  /** The code proves the new value; it replaces the old one of the same kind. */
  async function confirm({ user, body = {} }) {
    if (!user?.personId) return { error: 'user_not_found', status: 404 };
    const identifier = parseIdentifier(body);
    if (!identifier) return { error: 'one_phone_or_email_required', status: 400 };
    const checked = await codes.consumeCode({ purpose: PURPOSE, personId: user.personId, identifier, code: body.code });
    if (checked.error) return checked;
    if (await takenByAnother(user.personId, identifier)) return { error: 'identifier_in_use', status: 409 };

    const linked = await identityLink.linkOnVerifiedSignIn({
      anchorUserId: user.id, uid: null,
      email: identifier.type === 'email' ? identifier.value : null,
      phone: identifier.type === 'phone' ? identifier.value : null,
      provider: `fitflex_${checked.channel}`, trigger: 'identifier_change', attachOnly: !linkingEnabled(),
    });
    if (linked.conflicts.some(c => c.kind === 'verified_identifier_collision' && c.identifierType === identifier.type)) {
      return { error: 'identifier_in_use', status: 409 };
    }
    const personId = ((await users.findByIdAsync(user.id)) || user).personId;

    // The old value of this kind stops being a way to sign in.
    const old = (await verifiedOf(personId, identifier.type)).filter(o => o.normalizedValue !== identifier.value);
    if (old.length) {
      await db('LoginIdentifier').whereIn('id', old.map(o => o.id)).update({ status: 'revoked', updatedAt: db.fn.now() });
    }
    // The copies shown on the person's profiles follow. One that another
    // profile of the same role already shows is left as it was.
    for (const persona of await db('User').where({ personId }).whereNot({ accountStatus: 'closed' }).select('id')) {
      try {
        await users.updateByIdAsync(persona.id, { [identifier.type]: identifier.value, updatedAt: new Date().toISOString() });
      } catch (err) {
        if (err?.code !== '23505') throw err;
      }
    }
    if (auditLog) {
      await auditLog.insertAsync({
        id: randomUUID(), at: new Date().toISOString(), actor: user.id, action: 'identifier_changed', target: personId,
        before: null, after: { identifierType: identifier.type, replaced: old.length },
      });
    }
    await tellOld(identifier.type, old.map(o => o.normalizedValue), body.locale);
    const rows = await db('LoginIdentifier').where({ personId, status: 'active' }).whereIn('type', ['email', 'phone'])
      .whereNotNull('verifiedAt').orderBy('createdAt').select('type', 'normalizedValue', 'verifiedAt');
    return { changed: true, identifiers: rows.map(r => ({ type: r.type, value: r.normalizedValue, verified: true, verifiedAt: r.verifiedAt })) };
  }

  /** Tell the number or email that was replaced (best effort). */
  async function tellOld(type, values, locale) {
    if (!senders || !values.length) return;
    const sender = type === 'phone' ? senders.sms() : senders.email();
    if (!sender.configured) return;
    const text = NOTICE[locale === 'sw' ? 'sw' : 'en'];
    for (const value of values) {
      try {
        await sender.send(value, { text: text[type], subject: text.subject });
      } catch (err) {
        console.warn('[identifier] change notice skipped:', err?.message);
      }
    }
  }

  return { request, confirm };
}
