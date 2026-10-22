// Date of birth: one strict rule for writing it (POST /me/profile, admin member save) and for reading
// it (shop personalisation eligibility, communications audience age). Strict "YYYY-MM-DD", a real
// calendar date, from 1901-01-01 up to today (East Africa day). An invalid stored date counts as no
// date of birth when read. Nothing else is guessed at: '2011/05/03', '03/05/2011', '2011-5-3'
// and ' 2011-05-03' are all invalid.

const EAT_OFFSET_MS = 3 * 3_600_000; // Africa/Dar_es_Salaam, UTC+3, no daylight saving
export const DOB_MIN = '1901-01-01';
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Today's East Africa day, "YYYY-MM-DD". */
export const eatToday = (now = new Date()) => new Date(+new Date(now) + EAT_OFFSET_MS).toISOString().slice(0, 10);

/** True for a real calendar day written "YYYY-MM-DD" (2023-02-29 and 2024-02-30 are not days). */
export function isCalendarDay(value) {
  if (typeof value !== 'string') return false;
  const m = DAY_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = m.slice(1).map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** True for a real "YYYY-MM-DD" date between DOB_MIN and the day `today` ("YYYY-MM-DD"), inclusive. */
export const isValidDateOfBirthOn = (value, today) =>
  isCalendarDay(value) && isCalendarDay(today) && value >= DOB_MIN && value <= today;

/** True for a real "YYYY-MM-DD" date between DOB_MIN and today (inclusive). */
export const isValidDateOfBirth = (value, now = new Date()) => isValidDateOfBirthOn(value, eatToday(now));

/**
 * Whole years from a stored date of birth to the day `today` ("YYYY-MM-DD"), or null when the date
 * of birth is absent or invalid by the rule above (an invalid one is treated as no date of birth).
 */
export function ageOnDay(dateOfBirth, today) {
  if (!isValidDateOfBirthOn(dateOfBirth, today)) return null;
  const [by, bm, bd] = dateOfBirth.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

/** Nothing stored: undefined, null, or an empty / whitespace-only string. */
export const isAbsentDateOfBirth = value => value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

/**
 * What a stored date of birth says.
 * → { status: 'absent' } | { status: 'invalid' } | { status: 'valid', age }
 */
export function readDateOfBirth(value, now = new Date()) {
  if (isAbsentDateOfBirth(value)) return { status: 'absent' };
  const age = ageOnDay(value, eatToday(now));
  return age === null ? { status: 'invalid' } : { status: 'valid', age };
}

/**
 * Why a stored date of birth is or is not usable (reporting only, scripts/member-dob-audit.mjs).
 * → 'absent' | 'valid' | 'invalid_not_text' | 'invalid_format' | 'invalid_impossible_day'
 *   | 'invalid_before_1901' | 'invalid_in_future'
 */
export function classifyStoredDateOfBirth(value, now = new Date()) {
  if (isAbsentDateOfBirth(value)) return 'absent';
  if (typeof value !== 'string') return 'invalid_not_text';
  if (!DAY_RE.test(value)) return 'invalid_format';
  // Before the calendar check: Date.UTC maps years 0–99 to 1900–1999, so isCalendarDay says no to
  // every day in 0001–0099; those are early dates, not impossible ones.
  if (value < DOB_MIN) return 'invalid_before_1901';
  if (!isCalendarDay(value)) return 'invalid_impossible_day';
  return value > eatToday(now) ? 'invalid_in_future' : 'valid';
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
