// Member usernames (feature flag MEMBER_USERNAMES): choose, change, clear,
// and let an admin clear one that was reported.
//
// Rules (owner decisions, 13 Oct 2026): optional; case-insensitive unique;
// one change per 30 days (setting, changing or clearing all count); a handle
// that was let go is held 90 days against everyone else; a handle an admin
// cleared is never given back to that member; a handle may not collide with a
// trainer's nickname or a gym's name.
import { randomUUID } from 'node:crypto';
import { cleanUsername, squash, CHANGE_COOLDOWN_DAYS, RELEASE_HOLD_DAYS } from '../shared/username.mjs';

const DAY = 86_400_000;

export function createUsernameService({
  memberUsernames, usernameReleases, users, trainers = null, gyms = null, auditLog = null,
  now = () => new Date(),
}) {
  const iso = () => now().toISOString();
  const changeableAtOf = (row) => (row?.changedAt
    ? new Date(+new Date(row.changedAt) + CHANGE_COOLDOWN_DAYS * DAY).toISOString()
    : null);
  const inCooldown = (row) => !!row?.changedAt && +now() < +new Date(changeableAtOf(row));

  async function release(handleLower, userId, reason) {
    if (!handleLower) return;
    await usernameReleases.insertAsync({ id: `rel_${randomUUID().slice(0, 12)}`, handleLower, userId, reason, releasedAt: iso() });
  }

  /** Why a handle can't be used by this member right now, or null. */
  async function blockedFor(userId, cleaned) {
    const { handleLower } = cleaned;
    const flat = squash(handleLower);
    const holder = await memberUsernames.findAsync((r) => r.handleLower === handleLower && r.id !== userId);
    if (holder) return 'username_taken';
    const lookalike = (trainers?.find?.((t) => [t.nickname, t.displayName, t.fullName].some((n) => n && squash(n) === flat)))
      || (gyms?.find?.((g) => g.name && squash(g.name) === flat));
    if (lookalike) return 'username_reserved';
    const earlier = await usernameReleases.filterAsync((r) => r.handleLower === handleLower);
    for (const r of earlier) {
      if (r.reason === 'cleared_by_admin' && r.userId === userId) return 'username_not_allowed';
      if (r.userId !== userId && +now() - +new Date(r.releasedAt) < RELEASE_HOLD_DAYS * DAY) {
        return 'username_released_recently';
      }
    }
    return null;
  }

  async function mine(userId) {
    const row = await memberUsernames.findByIdAsync(userId);
    return {
      username: row?.handle ?? null,
      usernameStatus: row?.status ?? 'none',
      usernameChangeableAt: inCooldown(row) ? changeableAtOf(row) : null,
    };
  }

  async function available(userId, raw) {
    const cleaned = cleanUsername(raw);
    if (!cleaned.ok) return { available: false, reason: cleaned.error };
    const own = await memberUsernames.findByIdAsync(userId);
    if (own?.handleLower === cleaned.handleLower) return { available: true, reason: null };
    const why = await blockedFor(userId, cleaned);
    return { available: !why, reason: why };
  }

  async function set(user, raw) {
    if (user.userType !== 'member') return { error: 'not_a_member', status: 403 };
    const cleaned = cleanUsername(raw);
    if (!cleaned.ok) return { error: cleaned.error, status: 400 };
    const own = await memberUsernames.findByIdAsync(user.id);
    if (own?.handleLower === cleaned.handleLower) {
      // Same handle: only the capitalisation may change, and that is free.
      if (own.handle !== cleaned.handle) await memberUsernames.updateByIdAsync(user.id, { handle: cleaned.handle, updatedAt: iso() });
      return { ...(await mine(user.id)) };
    }
    if (inCooldown(own)) {
      return { error: 'username_cooldown', status: 429, nextChangeAt: changeableAtOf(own) };
    }
    const why = await blockedFor(user.id, cleaned);
    if (why) return { error: why, status: why === 'username_taken' ? 409 : 400 };
    const stamp = iso();
    try {
      if (own) {
        await memberUsernames.updateByIdAsync(user.id, { handle: cleaned.handle, handleLower: cleaned.handleLower, status: 'active', changedAt: stamp, updatedAt: stamp });
      } else {
        await memberUsernames.insertAsync({ id: user.id, handle: cleaned.handle, handleLower: cleaned.handleLower, status: 'active', changedAt: stamp, createdAt: stamp, updatedAt: stamp });
      }
    } catch (err) {
      // The unique index is the real guard against two members racing for a handle.
      if (/unique|duplicate/i.test(err?.message ?? '')) return { error: 'username_taken', status: 409 };
      throw err;
    }
    if (own?.handleLower) await release(own.handleLower, user.id, 'changed');
    return { ...(await mine(user.id)) };
  }

  async function clear(user) {
    const own = await memberUsernames.findByIdAsync(user.id);
    if (!own?.handleLower) return { ...(await mine(user.id)) };
    if (inCooldown(own)) return { error: 'username_cooldown', status: 429, nextChangeAt: changeableAtOf(own) };
    const stamp = iso();
    await release(own.handleLower, user.id, 'cleared');
    await memberUsernames.updateByIdAsync(user.id, { handle: null, handleLower: null, status: 'none', changedAt: stamp, updatedAt: stamp });
    return { ...(await mine(user.id)) };
  }

  /** Admin: remove a reported username. The member may pick another straight away (not the same one). */
  async function adminClear(adminId, userId, reason = null) {
    const own = await memberUsernames.findByIdAsync(userId);
    if (!own?.handleLower) return { cleared: false };
    const stamp = iso();
    await release(own.handleLower, userId, 'cleared_by_admin');
    // The clock is reset: being reported is not a change the member chose.
    await memberUsernames.updateByIdAsync(userId, { handle: null, handleLower: null, status: 'cleared', changedAt: null, updatedAt: stamp });
    await auditLog?.insertAsync({
      id: randomUUID(), at: stamp, actor: adminId, action: 'username.clear', target: userId,
      before: { handle: own.handle }, after: { status: 'cleared', reason },
    });
    return { cleared: true };
  }

  /** The account is gone: free the handle (held 90 days) and forget the row. */
  async function forgetUser(userId) {
    const own = await memberUsernames.findByIdAsync(userId);
    if (!own) return;
    await release(own.handleLower, userId, 'account_deleted');
    await memberUsernames.removeAsync((r) => r.id === userId);
  }

  /** Map of userId -> handle for those who have one (for the name resolver). */
  async function handlesFor(userIds) {
    const wanted = new Set(userIds);
    const rows = await memberUsernames.filterAsync((r) => wanted.has(r.id) && r.handle && r.status === 'active');
    return new Map(rows.map((r) => [r.id, r.handle]));
  }

  return { mine, available, set, clear, adminClear, forgetUser, handlesFor };
}
