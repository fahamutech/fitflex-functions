// Who an email address or mobile number belongs to: verified evidence only.
//
// Anything that routes to, attaches to, enrols or grants a role to "the person
// with this email / number" (friend invitations, B2B invite matching and bulk
// import, adding an organisation user / beneficiary / company employee by
// contact) resolves the contact through the person who has PROVEN it. The
// proof lives in LoginIdentifier rows with verifiedAt set: written by a
// Firebase sign-in whose ID token says email_verified / carries a
// phone_number, by FitFlex SMS / email codes (registration, PIN set-up and
// reset, identifier change, recovery), or by scripts/identity-reconcile.mjs.
//
// User.email and User.phone are deliberately NOT used. They are contact
// fields, not proof: an unverified Firebase sign-up writes its email there,
// POST /me/profile lets a member type any email or number into their own row,
// and staff type them in when creating accounts. Someone with no verified
// identifier is matched by nothing here (fail closed).
//
// Lookups use the (type, normalizedValue) index on LoginIdentifier (migration
// 20261030090000) and its partial unique index, which lets a verified, active
// identifier belong to one Person only.
import { normalizeEmail, normalizePhone } from './identifiers.mjs';

const LIVE_STATUSES_EXCLUDED = ['suspended', 'closed', 'deleted'];
const CONTACT_TYPES = ['email', 'phone'];

/** User rows that count as a usable account (not suspended, closed or deleted). */
export const whereLiveAccount = (q, column = 'accountStatus') =>
  q.where(b => b.whereNull(column).orWhereNotIn(column, LIVE_STATUSES_EXCLUDED));

/** @param {import('knex').Knex} db */
export function createVerifiedContacts(db) {
  const liveMembers = () => whereLiveAccount(db('User').where({ userType: 'member' }));

  /** The active Person who has verified this contact, or null. */
  async function personFor({ type, value }) {
    if (!CONTACT_TYPES.includes(type) || !value) return null;
    const owner = await db('LoginIdentifier')
      .join('Person', 'Person.id', 'LoginIdentifier.personId')
      .where({
        'LoginIdentifier.type': type, 'LoginIdentifier.normalizedValue': value,
        'LoginIdentifier.status': 'active', 'Person.status': 'active',
      })
      .whereNotNull('LoginIdentifier.verifiedAt')
      .first('LoginIdentifier.personId as personId');
    return owner?.personId ?? null;
  }

  /**
   * The member behind a verified email / number, or null. `value` is already
   * normalised (lower-case email, E.164 phone) by parseContact. The number can
   * live only in LoginIdentifier (User.phone is null when another persona of
   * the same person holds it), which is fine: LoginIdentifier is the source.
   */
  async function findMember({ type, value }) {
    const personId = await personFor({ type, value });
    if (!personId) return null;
    return (await liveMembers().where({ personId }).orderBy('createdAt').first('id', 'displayName')) ?? null;
  }

  /**
   * A subquery aliased `v` (for .from() or .join()) of (type,
   * normalizedValue, userId, userCreatedAt): every
   * verified, active email / number of an active Person, paired with each of
   * that person's live member accounts. Join it to whatever holds contacts.
   */
  function verifiedMemberRows() {
    return db('LoginIdentifier as li')
      .join('Person as p', 'p.id', 'li.personId')
      .join('User as u', 'u.personId', 'li.personId')
      .where({ 'li.status': 'active', 'p.status': 'active', 'u.userType': 'member' })
      .whereIn('li.type', CONTACT_TYPES)
      .whereNotNull('li.verifiedAt')
      .where(b => whereLiveAccount(b, 'u.accountStatus'))
      .select('li.type', 'li.normalizedValue', 'u.id as userId', 'u.createdAt as userCreatedAt')
      .as('v');
  }

  /**
   * Member accounts behind many emails and numbers at once (one query,
   * whatever the size of the list). Input is normalised here: emails
   * lower-case and trimmed, numbers E.164. Returns
   * { byEmail: Map<email, userId>, byPhone: Map<phone, userId> }; a contact
   * nobody has verified is simply absent.
   */
  async function findMembers({ emails = [], phones = [] } = {}) {
    const byEmail = new Map();
    const byPhone = new Map();
    const e = [...new Set(emails.map(v => normalizeEmail(v)).filter(Boolean))];
    const p = [...new Set(phones.map(v => normalizePhone(v)).filter(Boolean))];
    if (!e.length && !p.length) return { byEmail, byPhone };
    const rows = await db.from(verifiedMemberRows())
      .where(b => {
        if (e.length) b.orWhere(w => w.where('v.type', 'email').whereIn('v.normalizedValue', e));
        if (p.length) b.orWhere(w => w.where('v.type', 'phone').whereIn('v.normalizedValue', p));
      })
      .orderBy('v.userCreatedAt')
      .select('v.type', 'v.normalizedValue', 'v.userId');
    for (const r of rows) {
      const map = r.type === 'email' ? byEmail : byPhone;
      if (!map.has(r.normalizedValue)) map.set(r.normalizedValue, r.userId);
    }
    return { byEmail, byPhone };
  }

  /**
   * Every account id (any persona) of the person who has verified this
   * contact, oldest first. Account status is left to the caller to judge.
   * `value` is normalised by the caller.
   */
  async function userIdsFor({ type, value }) {
    const personId = await personFor({ type, value });
    if (!personId) return [];
    return (await db('User').where({ personId }).orderBy('createdAt').select('id')).map(r => r.id);
  }

  /** Every verified email / number of the (active) person behind an account. */
  async function contactsFor(userId) {
    const u = await db('User').join('Person', 'Person.id', 'User.personId')
      .where({ 'User.id': userId, 'Person.status': 'active' }).first('User.personId as personId');
    if (!u?.personId) return [];
    const rows = await db('LoginIdentifier')
      .where({ personId: u.personId, status: 'active' }).whereIn('type', CONTACT_TYPES).whereNotNull('verifiedAt')
      .select('type', 'normalizedValue');
    return rows.map(r => ({ type: r.type, value: r.normalizedValue }));
  }

  return { findMember, findMembers, verifiedMemberRows, userIdsFor, contactsFor };
}
