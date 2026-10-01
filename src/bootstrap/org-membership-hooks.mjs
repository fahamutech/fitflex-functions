// Identity V2 · I4 — keep OrgMembership in step with its sources.
//
// A gym or vendor relationship can change through ~75 call sites that write
// users, trainer profiles or subscriptions. Rather than touch each one (and
// miss the next), the three collections' write methods are wrapped once here:
// after a write succeeds, the affected persona is reconciled.
//
// The original write always wins. A sync failure is logged and swallowed, and
// scripts/org-membership-sync.mjs (dry run = drift check) repairs anything
// missed.

export function attachOrgMembershipSync({ users, trainers, subscriptions, orgMemberships }) {
  async function sync(userIds) {
    for (const id of new Set(userIds.filter(Boolean))) {
      try {
        await orgMemberships.syncUser(id);
      } catch (err) {
        console.warn('[org-membership] sync skipped for', id, '-', err?.message);
      }
    }
  }

  /** Replace `target[method]` so `affected(args, result)` personas sync after it. */
  function after(target, method, affected) {
    const original = target?.[method];
    if (typeof original !== 'function') return;
    target[method] = async (...args) => {
      const before = affected.before ? await affected.before(args) : null;
      const result = await original(...args);
      try {
        await sync(await affected.ids(args, result, before));
      } catch (err) {
        console.warn('[org-membership] sync skipped -', err?.message);
      }
      return result;
    };
  }

  // Users: the row itself decides owner / staff / vendor relationships.
  after(users, 'upsertAsync', { ids: ([, row], result) => [row?.id ?? result?.id] });
  after(users, 'insertAsync', { ids: ([row], result) => [row?.id ?? result?.id] });
  after(users, 'updateByIdAsync', { ids: ([id]) => [id] });
  // A removed persona's memberships lose their persona (FK SET NULL): end them.
  const removeUsers = users?.removeAsync;
  if (typeof removeUsers === 'function') {
    users.removeAsync = async (...args) => {
      const result = await removeUsers(...args);
      try { await orgMemberships.endOrphaned(); } catch (err) { console.warn('[org-membership] orphan cleanup skipped -', err?.message); }
      return result;
    };
  }

  // Trainer profiles are cached in memory, so the rows a predicate hits are
  // known before the write.
  const trainerUsers = pred => (typeof trainers?.filter === 'function' ? trainers.filter(pred) : []).map(t => t.userId);
  const trainerUserOf = row => row?.userId ?? trainers?.find?.(t => t.id === row?.id)?.userId;
  after(trainers, 'upsertAsync', { ids: ([, row]) => [trainerUserOf(row)] });
  after(trainers, 'updateAsync', { before: ([pred]) => trainerUsers(pred), ids: (_a, _r, before) => before || [] });
  after(trainers, 'removeAsync', { before: ([pred]) => trainerUsers(pred), ids: (_a, _r, before) => before || [] });

  // Subscriptions: a direct subscription is the gym membership.
  const memberOf = async id => (await subscriptions.findByIdAsync?.(id))?.memberId;
  after(subscriptions, 'insertAsync', { ids: ([row]) => [row?.memberId] });
  after(subscriptions, 'upsertAsync', { ids: ([, row]) => [row?.memberId] });
  after(subscriptions, 'updateByIdAsync', { ids: async ([id]) => [await memberOf(id)] });
}
