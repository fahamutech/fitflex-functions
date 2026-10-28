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
