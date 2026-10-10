// Find the FitFlex account someone means when they give an email address or
// a mobile number instead of a user id.
//
// One person can hold several accounts (member, trainer, gym owner, …) under
// the same email or number, so the caller says which kind it needs:
//   require: 'member'  only a member account will do
//   prefer:  'member'  a member account if there is one; otherwise the only
//                      account there is; otherwise the caller must say which
import { normalizeEmail, normalizePhone } from './identifiers.mjs';

const fail = (error, status, extra = {}) => ({ error, status, ...extra });

/**
 * @param users a collection with findByIdAsync and filterByColumnAsync
 * @returns {{ user } | { error, status }}
 */
export async function findUserByContact(users, { userId, email, phone } = {}, { require = null, prefer = null } = {}) {
  const given = [userId, email, phone].filter(v => v != null && String(v).trim() !== '');
  if (given.length === 0) return fail('user_contact_required', 400, { hint: 'Give an email address, a mobile number or a user id.' });
  if (given.length > 1) return fail('one_user_contact_only', 400);

  let candidates;
  if (userId) {
    const user = await users.findByIdAsync(String(userId).trim());
    candidates = user ? [user] : [];
  } else if (email) {
    const value = normalizeEmail(email);
    if (!value || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return fail('invalid_email', 400);
    const rows = await users.filterByColumnAsync('email', value);
    // Addresses saved before emails were normalised may differ in case.
    const exact = String(email).trim();
    candidates = rows.length || exact === value ? rows : await users.filterByColumnAsync('email', exact);
  } else {
    const value = normalizePhone(phone);
    if (!value) return fail('invalid_phone', 400, { hint: 'For example 0712 345 678 or +255712345678.' });
    candidates = await users.filterByColumnAsync('phone', value);
  }
  candidates = candidates.filter(u => u.accountStatus !== 'deleted');
  if (!candidates.length) return fail('user_not_found', 404, { hint: 'They need a FitFlex account first.' });

  const ofType = type => candidates.find(u => u.userType === type);
  if (require) {
    const user = ofType(require);
    return user ? { user } : fail(`${require}_account_required`, 400, { found: [...new Set(candidates.map(u => u.userType))] });
  }
  const user = (prefer && ofType(prefer)) || (candidates.length === 1 ? candidates[0] : null);
  return user ? { user } : fail('ambiguous_user', 409, { found: candidates.map(u => ({ userId: u.id, userType: u.userType })) });
}
