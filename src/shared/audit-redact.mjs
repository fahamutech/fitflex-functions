// What may be written to AuditLog.before / AuditLog.after.
//
// Audit rows are read by staff in the portal and kept for a long time, so
// credential material must never land there, and whole User rows (which carry
// the member profile: date of birth, gender, height, weight) are cut down to
// the account fields an audit trail needs.

// Credential keys, matched at any depth of an audit value.
const SECRET_KEYS = new Set([
  'passwordHash', 'startPasswordHash', 'pinHash', 'startPinHash', 'tokenHash',
  'password', 'pin', 'otp', 'refreshToken', 'accessToken', 'idToken',
]);

/** Deep copy of an audit value with every credential key removed. */
export function redactAuditValue(value) {
  if (Array.isArray(value)) return value.map(redactAuditValue);
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEYS.has(k)) continue;
    out[k] = redactAuditValue(v);
  }
  return out;
}

// ── Viewer output (GET /admin/audit-log) ──
// The exact-key list above is what is kept OUT of the table. Rows written by older code, or by callers that put
// other values in before/after, are read through a broader net: any key that contains one of these words (as a
// whole word of the camelCase / snake_case name, so "shipping" is not "pin") is removed, and payment account
// numbers are masked to their last three digits.
const SECRET_WORDS = new Set([
  'secret', 'secrets', 'token', 'tokens', 'hash', 'hashes', 'password', 'passwords', 'pin', 'pins', 'otp', 'tin',
  'apikey', 'nationalid', 'accountnumber',
]);
const MASKED_KEYS = new Set(['lipanamba']);   // platform settings: manualPayment.lipaNamba

function keyWords(key) {
  const words = String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const pairs = words.slice(1).map((w, i) => words[i] + w);   // api + key, national + id, account + number
  return [...words, ...pairs];
}
/** True when an audit key looks like credential or identity-number material. */
export function isSecretLookingKey(key) {
  return SECRET_KEYS.has(key) || keyWords(key).some(w => SECRET_WORDS.has(w));
}
const maskNumber = v => {
  const digits = String(v ?? '').replace(/\D/g, '');
  return digits ? `${'*'.repeat(Math.max(digits.length - 3, 3))}${digits.slice(-3)}` : '***';
};

/** redactAuditValue plus the key-pattern removal and account-number masking, for what the viewer returns. */
export function redactAuditForDisplay(value) {
  if (Array.isArray(value)) return value.map(redactAuditForDisplay);
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (isSecretLookingKey(k)) continue;
    out[k] = MASKED_KEYS.has(k.toLowerCase()) && v !== null && typeof v !== 'object' ? maskNumber(v) : redactAuditForDisplay(v);
  }
  return out;
}

// User-row fields an audit entry may keep. Anything else (hashes, Firebase
// uid, Person link, profiles) is dropped.
const USER_AUDIT_FIELDS = [
  'id', 'userType', 'email', 'phone', 'displayName', 'photoUrl',
  'accountStatus', 'approvalStatus', 'approvalNote', 'onboardingCompleted',
  'gymId', 'gymIds', 'vendorId', 'vendorRole', 'corporateId',
  'portalUser', 'aclPermissions', 'passwordChangeRequired', 'subscription',
  'createdAt', 'updatedAt',
];

/**
 * Allow-listed snapshot of a User row for an audit entry. The member and
 * vendor profiles are reduced to the names of the fields that hold a value,
 * so the trail shows what was set without copying date of birth etc.
 */
export function userAuditSnapshot(row) {
  if (!row || typeof row !== 'object') return row ?? null;
  const out = {};
  for (const k of USER_AUDIT_FIELDS) if (row[k] !== undefined) out[k] = row[k];
  for (const [profile, label] of [['memberProfile', 'memberProfileFields'], ['vendorProfile', 'vendorProfileFields']]) {
    const p = row[profile];
    if (p && typeof p === 'object') {
      out[label] = Object.keys(p).filter(k => p[k] !== null && p[k] !== undefined && p[k] !== '').sort();
    }
  }
  return redactAuditValue(out);
}
