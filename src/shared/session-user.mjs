// Credential material on a User row must never leave the backend. Every
// response that returns a whole row goes through this.
const SECRET_FIELDS = ['passwordHash', 'pinHash'];

/** Copy of a User row without credential fields; passes null/undefined through. */
export function toSessionUser(row) {
  if (!row || typeof row !== 'object') return row;
  const safe = { ...row };
  for (const field of SECRET_FIELDS) delete safe[field];
  return safe;
}
