// Date of birth: one strict rule for writing it (PUT /me/profile, admin member save) and for reading
// it (shop personalisation eligibility). Strict "YYYY-MM-DD", a real calendar date, from 1901-01-01
// up to today (East Africa day). Nothing else is guessed at: '2011/05/03', '03/05/2011', '2011-5-3'
// and ' 2011-05-03' are all invalid.

const EAT_OFFSET_MS = 3 * 3_600_000; // Africa/Dar_es_Salaam, UTC+3, no daylight saving
export const DOB_MIN = '1901-01-01';
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Today's East Africa day, "YYYY-MM-DD". */
export const eatToday = (now = new Date()) => new Date(+new Date(now) + EAT_OFFSET_MS).toISOString().slice(0, 10);

/** True for a real "YYYY-MM-DD" date between DOB_MIN and today (inclusive). */
export function isValidDateOfBirth(value, now = new Date()) {
  if (typeof value !== 'string') return false;
  const m = DAY_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = m.slice(1).map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return false;
  return value >= DOB_MIN && value <= eatToday(now);
}

/** Nothing stored: undefined, null, or an empty / whitespace-only string. */
export const isAbsentDateOfBirth = value => value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

/**
 * What a stored date of birth says.
 * → { status: 'absent' } | { status: 'invalid' } | { status: 'valid', age }
 */
export function readDateOfBirth(value, now = new Date()) {
  if (isAbsentDateOfBirth(value)) return { status: 'absent' };
  if (!isValidDateOfBirth(value, now)) return { status: 'invalid' };
  const [by, bm, bd] = value.split('-').map(Number);
  const [ty, tm, td] = eatToday(now).split('-').map(Number);
  return { status: 'valid', age: ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0) };
}

/**
 * A date of birth in a profile write body.
 * → { skip: true } (not sent, or null: keep what is stored) | { value: null } ('' or blanks: clear it)
 *   | { value } (valid) | { error: 'invalid_field', status: 400, field: 'dateOfBirth' }
 */
export function parseDateOfBirthInput(value, now = new Date()) {
  if (value === undefined || value === null) return { skip: true };
  if (typeof value === 'string' && value.trim() === '') return { value: null };
  if (!isValidDateOfBirth(value, now)) return { error: 'invalid_field', status: 400, field: 'dateOfBirth' };
  return { value };
}
