// Display names for the FitFlex staff recorded on money rows (who verified,
// approved, asked for a change, paid). Admin lists only: names come from
// portal/admin user rows; anything else (members, 'policy', automated
// actors, deleted users) is null.

/** A staff user's display name (displayName, else email), or null for anyone who is not portal/admin staff. */
export function staffName(user) {
  if (!user || !(user.portalUser === true || user.userType === 'admin')) return null;
  const name = typeof user.displayName === 'string' && user.displayName.trim() ? user.displayName.trim() : null;
  return name || (typeof user.email === 'string' && user.email.trim() ? user.email.trim() : null);
}

/**
 * One lookup for every actor id on the rows: (users, rows, fields) → (id) => name | null.
 * `users` needs filterByColumnInAsync('id', ids).
 */
export async function staffNameLookup(users, rows, fields) {
  const ids = new Set();
  for (const row of rows) {
    for (const f of fields) {
      const v = row?.[f];
      if (typeof v === 'string' && v && v !== 'policy') ids.add(v);
    }
  }
  if (!ids.size || !users?.filterByColumnInAsync) return () => null;
  const found = await users.filterByColumnInAsync('id', [...ids]);
  const byId = new Map(found.map(u => [u.id, staffName(u)]));
  return (id) => (id ? byId.get(id) ?? null : null);
}
