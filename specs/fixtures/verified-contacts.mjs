// Test helper: record that the person behind an account has VERIFIED an email
// and/or a mobile number (LoginIdentifier rows with verifiedAt), the way a
// verified Firebase sign-in or a FitFlex SMS code does. Matching by contact
// (B2B invites and import, add-by-contact, friend invitations) only counts
// these rows, never User.email / User.phone.
import { randomUUID } from 'node:crypto';
import { normalizeEmail, normalizePhone } from '../../src/shared/identifiers.mjs';

export async function verifyContacts(db, userId, { email = null, phone = null } = {}) {
  const { personId } = await db('User').where({ id: userId }).first('personId');
  const rows = [
    email && { type: 'email', value: email, normalizedValue: normalizeEmail(email) },
    phone && { type: 'phone', value: phone, normalizedValue: normalizePhone(phone) },
  ].filter(Boolean);
  for (const r of rows) {
    await db('LoginIdentifier').insert({ id: `lid_${randomUUID().replace(/-/g, '').slice(0, 12)}`, personId, ...r, verifiedAt: new Date(), provider: 'test', status: 'active' });
  }
  return personId;
}

/** Remove the identifiers and Persons behind these accounts (call before deleting the User rows is fine too). */
export async function purgeIdentity(db, userIds) {
  if (!userIds.length) return;
  const persons = (await db('User').whereIn('id', userIds).pluck('personId')).filter(Boolean);
  if (!persons.length) return;
  await db('LoginIdentifier').whereIn('personId', persons).del();
  return persons;
}
