// Who a friend invitation is for: verified evidence only.
//
// Friend invitations made for an email address or mobile number are routed to
// (lookup) and attached to (inbox / link claim) the member who has PROVEN that
// contact. The proof lives in LoginIdentifier rows with verifiedAt set:
// written by a Firebase sign-in whose ID token says email_verified / carries a
// phone_number, by FitFlex SMS / email codes (registration, PIN set-up and
// reset, identifier change, recovery), or by scripts/identity-reconcile.mjs.
//
// User.email and User.phone are deliberately NOT used. They are contact
// fields, not proof: an unverified Firebase sign-up writes its email there,
// POST /me/profile lets a member type any email or number into their own row,
// and staff type them in when creating accounts.
const LIVE_STATUSES_EXCLUDED = ['suspended', 'closed', 'deleted'];

/** @param {import('knex').Knex} db */
export function createVerifiedContacts(db) {
  const liveMembers = () => db('User').where({ userType: 'member' })
    .where(b => b.whereNull('accountStatus').orWhereNotIn('accountStatus', LIVE_STATUSES_EXCLUDED));

  /**
   * The member behind a verified email / number, or null. `value` is already
   * normalised (lower-case email, E.164 phone) by parseContact. The number can
   * live only in LoginIdentifier (User.phone is null when another persona of
   * the same person holds it), which is fine: LoginIdentifier is the source.
   */
  async function findMember({ type, value }) {
    if ((type !== 'email' && type !== 'phone') || !value) return null;
    const owner = await db('LoginIdentifier')
      .join('Person', 'Person.id', 'LoginIdentifier.personId')
      .where({
        'LoginIdentifier.type': type, 'LoginIdentifier.normalizedValue': value,
        'LoginIdentifier.status': 'active', 'Person.status': 'active',
      })
      .whereNotNull('LoginIdentifier.verifiedAt')
      .first('LoginIdentifier.personId as personId');
    if (!owner?.personId) return null;
    return (await liveMembers().where({ personId: owner.personId }).orderBy('createdAt').first('id', 'displayName')) ?? null;
  }

  /** Every verified email / number of the person behind a member. */
  async function contactsFor(userId) {
    const u = await db('User').where({ id: userId }).first('personId');
    if (!u?.personId) return [];
    const rows = await db('LoginIdentifier')
      .where({ personId: u.personId, status: 'active' }).whereIn('type', ['email', 'phone']).whereNotNull('verifiedAt')
      .select('type', 'normalizedValue');
    return rows.map(r => ({ type: r.type, value: r.normalizedValue }));
  }

  return { findMember, contactsFor };
}
