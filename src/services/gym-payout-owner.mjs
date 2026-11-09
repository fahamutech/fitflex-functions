// Gym payout owner (owner decision 2026-10-22, flag GYM_PAYOUT_OWNER).
//
// A gym can be shared by several owner accounts (gym_operator users whose
// gymId / gymIds list it). Payouts go to ONE of them: the gym's payout owner,
// whose KYC case and verified payout account decide whether the gym can be
// paid and where the money goes.
//
//   flag off  the first owner account found for the gym (today's behaviour).
//   flag on   Gym.payoutOwnerId when it names one of the gym's owners;
//             otherwise the only owner when there is exactly one (no admin
//             step); otherwise not payable: payout_owner_required (two or
//             more owners, none named) or no_owner_account (none).
//
// Admins name or clear a gym's payout owner (it must be one of its owners);
// taking an owner off a gym clears it when they were its payout owner. Both
// are audited. Owners only ever learn whether they themselves are the payout
// owner — never a co-owner's id.
import { randomUUID } from 'node:crypto';
import { gymPayoutOwnerOn } from '../shared/feature-flags.mjs';

export const PAYOUT_OWNER_REASONS = ['payout_owner_required', 'no_owner_account'];

/** Does this user own the gym? (the rule payout eligibility has always used) */
export const ownsGym = (u, gymId) => u?.userType === 'gym_operator' && (u.gymId === gymId || (u.gymIds || []).includes(gymId));

const ownerRef = u => ({ id: u.id, displayName: u.displayName ?? null, email: u.email ?? null });
const byName = (a, b) => String(a.displayName || a.email || a.id).localeCompare(String(b.displayName || b.email || b.id));

export function createGymPayoutOwner({ users, gyms, auditLog = null, flagOn = gymPayoutOwnerOn }) {
  const gymOf = gymId => gyms.find(g => g.id === gymId) || null;

  /** Every owner account of a gym, by name. */
  async function ownersOf(gymId, allOwners = null) {
    const rows = allOwners || await users.filterByColumnAsync('userType', 'gym_operator');
    return rows.filter(u => ownsGym(u, gymId)).sort(byName);
  }

  /** The flag-on rule, from a gym and its owners. */
  function decide(gym, owners) {
    const named = gym?.payoutOwnerId ? owners.find(o => o.id === gym.payoutOwnerId) : null;
    if (named) return { ok: true, owner: named, source: 'named' };
    if (owners.length === 1) return { ok: true, owner: owners[0], source: 'only_owner' };
    if (!owners.length) return { ok: false, reason: 'no_owner_account' };
    return { ok: false, reason: 'payout_owner_required' };
  }

  /**
   * Who is paid for a gym.
   * @returns {Promise<{ ok: true, owner: Object, source: 'first_owner'|'named'|'only_owner', owners?: Object[] }
   *                 | { ok: false, reason: string, owners?: Object[] }>}
   */
  async function resolve(gymId) {
    if (!flagOn()) {
      const owner = await users.findAsync(u => ownsGym(u, gymId));
      return owner ? { ok: true, owner, source: 'first_owner' } : { ok: false, reason: 'no_owner_account' };
    }
    const owners = await ownersOf(gymId);
    return { ...decide(gymOf(gymId), owners), owners };
  }

  async function audit(actorId, action, gymId, before, after) {
    if (!auditLog) return;
    await auditLog.insertAsync({
      id: randomUUID(), at: new Date().toISOString(), actor: actorId || 'system', action, target: gymId, before, after,
    });
  }

  /** What admins see about a gym's payout owner. */
  function adminFields(gym, owners) {
    const shown = flagOn() ? decide(gym, owners) : (owners.length ? { ok: true, owner: null, source: 'first_owner' } : { ok: false, reason: 'no_owner_account' });
    return {
      payoutOwnerId: gym?.payoutOwnerId ?? null,
      owners: owners.map(ownerRef),
      // Who would be paid now, under the current flag. With the flag off it
      // is the first owner account found (not named here: it depends on
      // database order, as it always has).
      payoutOwner: {
        mode: flagOn() ? 'named' : 'first_owner',
        ownerId: shown.ok ? (shown.owner?.id ?? null) : null,
        source: shown.ok ? shown.source : null,
        reason: shown.ok ? null : shown.reason,
      },
    };
  }

  /** Admin gym rows with payoutOwnerId, owners and payoutOwner added. One owner query for the lot. */
  async function decorateAdminGyms(rows) {
    if (!rows?.length) return rows;
    const all = await users.filterByColumnAsync('userType', 'gym_operator');
    return Promise.all(rows.map(async (g) => {
      // Slim table rows don't carry the column: read it from the stored gym.
      const stored = { ...g, payoutOwnerId: gymOf(g.id)?.payoutOwnerId ?? g.payoutOwnerId ?? null };
      return { ...g, ...adminFields(stored, await ownersOf(g.id, all)) };
    }));
  }

  async function adminView(gymId) {
    const gym = gymOf(gymId);
    if (!gym) return { error: 'gym_not_found', status: 404 };
    return { gymId, ...adminFields(gym, await ownersOf(gymId)) };
  }

  /**
   * Admin: name a gym's payout owner (one of its owners), or clear it with
   * ownerId null. Works with the flag off too (it is then only stored).
   */
  async function setPayoutOwner({ gymId, ownerId, actorId }) {
    const gym = gymOf(gymId);
    if (!gym) return { error: 'gym_not_found', status: 404 };
    if (ownerId !== null && (typeof ownerId !== 'string' || !ownerId.trim())) return { error: 'invalid_ownerId', status: 400 };
    const owners = await ownersOf(gymId);
    if (ownerId !== null && !owners.some(o => o.id === ownerId)) {
      return { error: 'not_a_gym_owner', status: 409, owners: owners.map(ownerRef) };
    }
    const before = gym.payoutOwnerId ?? null;
    if (before !== ownerId) {
      await gyms.updateAsync(g => g.id === gymId, { payoutOwnerId: ownerId });
      await audit(actorId, ownerId ? 'gym_payout_owner_set' : 'gym_payout_owner_cleared', gymId,
        { payoutOwnerId: before }, { payoutOwnerId: ownerId, ...(ownerId ? {} : { reason: 'admin_cleared' }) });
    }
    return adminView(gymId);
  }

  /**
   * An owner left these gyms (taken off, or their account deleted): where
   * they were the payout owner, clear it. Returns the gym ids cleared.
   */
  async function clearForRemovedOwner({ ownerId, gymIds = [], actorId, reason = 'owner_removed' }) {
    const cleared = [];
    for (const gymId of [...new Set(gymIds.filter(Boolean))]) {
      const gym = gymOf(gymId);
      if (!gym || gym.payoutOwnerId !== ownerId) continue;
      await gyms.updateAsync(g => g.id === gymId, { payoutOwnerId: null });
      await audit(actorId, 'gym_payout_owner_cleared', gymId, { payoutOwnerId: ownerId }, { payoutOwnerId: null, reason });
      cleared.push(gymId);
    }
    return cleared;
  }

  /** Of these gyms, the ones that now have 2+ owners and no payout owner (flag on only). */
  async function gymsNeedingPayoutOwner(gymIds = []) {
    if (!flagOn()) return [];
    const all = await users.filterByColumnAsync('userType', 'gym_operator');
    const out = [];
    for (const gymId of [...new Set(gymIds.filter(Boolean))]) {
      const r = decide(gymOf(gymId), await ownersOf(gymId, all));
      if (!r.ok && r.reason === 'payout_owner_required') out.push(gymId);
    }
    return out;
  }

  /**
   * An owner's own gym as they see it: never the payout owner's id; with the
   * flag on, isPayoutOwner says whether payouts for it go to them.
   */
  async function forOwner(gym, ownerId) {
    if (!gym) return gym;
    const { payoutOwnerId: _hidden, ...rest } = gym;
    if (!flagOn()) return rest;
    const r = decide(gym, await ownersOf(gym.id));
    return { ...rest, isPayoutOwner: Boolean(r.ok && r.owner.id === ownerId) };
  }

  return {
    resolve, ownersOf, adminView, decorateAdminGyms, setPayoutOwner, clearForRemovedOwner,
    gymsNeedingPayoutOwner, forOwner, flagOn,
  };
}
