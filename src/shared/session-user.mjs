import { mustChangeStartCredential } from './credential-change.mjs';

// Credential material on a User row must never leave the backend. Every
// response that returns a whole row goes through this.
const SECRET_FIELDS = ['passwordHash', 'pinHash', 'startPasswordHash'];
// Identity V2 internals stay out of responses until a phase exposes them
// deliberately (the Person link reaches V2 clients in I2, not legacy ones).
const INTERNAL_FIELDS = ['personId'];

/** Copy of a User row without credential or internal identity fields. */
export function toSessionUser(row) {
  if (!row || typeof row !== 'object') return row;
  const safe = { ...row };
  for (const field of [...SECRET_FIELDS, ...INTERNAL_FIELDS]) delete safe[field];
  // What the session is actually held to (gym staff only while STAFF_PIN_CHANGE_REQUIRED is on).
  if ('passwordChangeRequired' in safe) safe.passwordChangeRequired = mustChangeStartCredential(row);
  return safe;
}
