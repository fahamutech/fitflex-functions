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
