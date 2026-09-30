// Login identifier normalisation. Emails are compared case-insensitively and
// without surrounding whitespace everywhere an account is looked up or created.

/** Trimmed, lower-cased email, or null when empty. */
export function normalizeEmail(email) {
  if (email == null) return null;
  const value = String(email).trim().toLowerCase();
  return value || null;
}

/** True when both emails are present and equal after normalisation. */
export function sameEmail(a, b) {
  const left = normalizeEmail(a);
  return left !== null && left === normalizeEmail(b);
}

const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * E.164 phone, defaulting to Tanzania (+255), or null when it can't be read
 * as a phone number. Accepts `0712 345 678`, `712345678`, `255712345678`,
 * `+255 712 345 678` and `00255…`; other countries need their `+` prefix.
 */
export function normalizePhone(phone, defaultCountryCode = '255') {
  if (phone == null) return null;
  const raw = String(phone).trim();
  if (!raw) return null;
  let digits = raw.replace(/[\s().-]/g, '');
  if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;
  if (digits.startsWith('+')) {
    const value = `+${digits.slice(1).replace(/\D/g, '')}`;
    return E164.test(value) && value.length === digits.length ? value : null;
  }
  if (!/^\d+$/.test(digits)) return null;
  let value = null;
  if (digits.startsWith(defaultCountryCode) && digits.length === defaultCountryCode.length + 9) value = `+${digits}`;
  else if (digits.startsWith('0') && digits.length === 10) value = `+${defaultCountryCode}${digits.slice(1)}`;
  else if (digits.length === 9 && digits[0] !== '0') value = `+${defaultCountryCode}${digits}`;
  return value && E164.test(value) ? value : null;
}
