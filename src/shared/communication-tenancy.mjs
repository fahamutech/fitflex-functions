// The last line of tenant isolation (M11): before any gym message goes into
// the ledger, and again before it is delivered, the member must hold a
// direct membership at that gym. Audiences already guarantee this — these
// checks are there so that a bug elsewhere can never become a message to
// another gym's member.

const CHUNK = 1000;

/** `${gymId}:${memberId}` for each pair in `pairs` that is a direct membership. */
export async function directMemberships(db, pairs) {
  const ok = new Set();
  const byGym = new Map();
  for (const { gymId, memberId } of pairs) {
    if (!gymId || !memberId) continue;
    if (!byGym.has(gymId)) byGym.set(gymId, new Set());
    byGym.get(gymId).add(memberId);
  }
  for (const [gymId, members] of byGym) {
    const ids = [...members];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const rows = await db('Subscription').where({ type: 'direct_sub', homeGymId: gymId })
        .whereIn('memberId', ids.slice(i, i + CHUNK)).distinct('memberId');
      for (const r of rows) ok.add(`${gymId}:${r.memberId}`);
    }
  }
  return ok;
}

/**
 * Throws (so the surrounding transaction rolls back) if any gym row in
 * `rows` is for someone who is not a direct member of the row's gym.
 */
export async function assertGymRecipients(db, rows) {
  const gymRows = rows.filter(r => r.senderType === 'gym');
  if (!gymRows.length) return;
  const ok = await directMemberships(db, gymRows);
  const stray = gymRows.filter(r => !ok.has(`${r.gymId}:${r.memberId}`));
  if (stray.length) {
    console.error('[communications] refused messages outside the gym', {
      count: stray.length, gymIds: [...new Set(stray.map(r => r.gymId))],
    });
    throw Object.assign(new Error('recipient_outside_gym'), { code: 'TENANT_ISOLATION', count: stray.length });
  }
}
