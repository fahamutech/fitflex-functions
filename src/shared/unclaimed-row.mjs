// Which User rows an email or phone alone may reach (security fix, 20 Oct 2026).
//
// User.email and User.phone are typed in by anyone (profile edits, unverified
// Firebase sign-ups, staff). They prove nothing on their own. A row reached
// only through them may be claimed or linked when it is genuinely unclaimed:
// a profile an organisation created for someone who has not signed in yet
// (decision O7). That means:
//   - no Firebase account of its own,
//   - not closed,
//   - an active Person with no PIN (the same test as registration-service
//     `claimable`), and
//   - no verified LoginIdentifier of any kind on that Person: nobody has ever
//     proved they own it.
// Anything else belongs to someone, and an email or phone match must ignore it.

/**
 * @param {import('knex').Knex | import('knex').Knex.Transaction} q
 * @param {{ firebaseUid?: string|null, personId?: string|null, accountStatus?: string|null }} row
 * @returns {Promise<boolean>}
 */
export async function isUnclaimed(q, row) {
  if (!row || row.firebaseUid || !row.personId || row.accountStatus === 'closed') return false;
  const person = await q('Person').where({ id: row.personId }).first('status', 'pinHash');
  if (person?.status !== 'active' || person.pinHash) return false;
  const verified = await q('LoginIdentifier')
    .where({ personId: row.personId, status: 'active' }).whereNotNull('verifiedAt').first('id');
  return !verified;
}

/**
 * Does this Person, while active, already hold the value as an active,
 * verified identifier? Same rule as src/shared/verified-contacts.mjs
 * (functions#234): a merged, closed or suspended Person proves nothing.
 * TODO: fold this file into verified-contacts.mjs once #234 and #235 are both merged.
 * @param {import('knex').Knex | import('knex').Knex.Transaction} q
 * @param {string|null} personId
 * @param {'email'|'phone'|'firebase_uid'} type
 * @param {string|null} normalizedValue
 */
export async function holdsVerified(q, personId, type, normalizedValue) {
  if (!personId || !normalizedValue) return false;
  const row = await q('LoginIdentifier')
    .join('Person', 'Person.id', 'LoginIdentifier.personId')
    .where({
      'LoginIdentifier.personId': personId, 'LoginIdentifier.type': type,
      'LoginIdentifier.normalizedValue': normalizedValue, 'LoginIdentifier.status': 'active',
      'Person.status': 'active',
    })
    .whereNotNull('LoginIdentifier.verifiedAt').first('LoginIdentifier.id');
  return Boolean(row);
}
