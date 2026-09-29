// Who may send, and to which gyms' members (M11 — tenant isolation).
//
// The route guards check the signed token: a role, and for staff the
// `communications` scope as it was when they signed in. A token lives for
// days, so every communications request is checked again here against the
// account as it is now:
//
//   signed-in user → still exists, same kind of account, not suspended
//     → gym owner, or gym staff who still hold `communications`
//     → the gyms they own or are assigned to, that still exist (and, for
//       staff, that an owner still holds)
//     → those gyms' direct members only (enforced by each service)
//
// The gyms passed on are the only gyms any service will read or send for;
// a gymId in the request can only narrow them.

import { ownerGymIds } from '../shared/member-status.mjs';

export const COMMUNICATIONS_SCOPE = 'communications';

export function createCommunicationAccess({ db, resolveRequestUser }) {
  const denied = (error, status = 403, extra = {}) => ({ error, status, ...extra });

  async function freshAccount(req, userTypes) {
    if (!req.user?.sub) return denied('unauthenticated', 401);
    const user = await resolveRequestUser(req);
    if (!user) return denied('user_not_found', 404);
    // The token's role and the account's must agree — a token for another
    // kind of account (or one whose type changed) gets nothing.
    if (!userTypes.includes(user.userType) || user.userType !== req.user.userType) return denied('forbidden');
    if ((user.accountStatus || 'active') !== 'active') return denied('account_suspended');
    return { user };
  }

  const hasScope = (user) => Array.isArray(user.aclPermissions) && user.aclPermissions.includes(COMMUNICATIONS_SCOPE);
  const listOf = (user) => [...new Set(ownerGymIds(user).filter(Boolean))];

  /** Of `ids`, the gyms that exist. */
  async function existingGyms(ids) {
    if (!ids.length) return [];
    const rows = await db('Gym').whereIn('id', ids).select('id');
    const found = new Set(rows.map(r => r.id));
    return ids.filter(id => found.has(id));
  }

  /** Of `ids`, the gyms an active owner still holds (staff act for an owner). */
  async function ownedGyms(ids) {
    if (!ids.length) return [];
    const rows = await db('User').where('userType', 'gym_operator')
      .where(q => q.whereNull('accountStatus').orWhere('accountStatus', 'active'))
      .whereRaw('"gymIds" && ?::text[]', [ids]).select('gymIds');
    const held = new Set(rows.flatMap(r => r.gymIds || []));
    return ids.filter(id => held.has(id));
  }

  /**
   * The gym sender for an owner/staff request, or { error, status }.
   * `owner.gymIds` is replaced by the gyms this person may act for now.
   */
  async function gymSender(req) {
    const fresh = await freshAccount(req, ['gym_operator', 'gym_staff']);
    if (fresh.error) return fresh;
    const { user } = fresh;
    const staff = user.userType === 'gym_staff';
    if (staff && !hasScope(user)) return denied('acl_forbidden', 403, { requiredScope: COMMUNICATIONS_SCOPE });
    let gymIds = await existingGyms(listOf(user));
    if (staff) gymIds = await ownedGyms(gymIds);
    return {
      senderType: 'gym',
      owner: { ...user, gymIds, gymId: gymIds[0] ?? null },
      actorId: user.id,
    };
  }

  /** The FitFlex sender for an admin request, or { error, status }. */
  async function platformSender(req) {
    const fresh = await freshAccount(req, ['admin']);
    if (fresh.error) return fresh;
    const { user } = fresh;
    // Portal staff need the scope on their account now; super-admins don't.
    if (user.portalUser === true && !hasScope(user)) return denied('acl_forbidden', 403, { requiredScope: COMMUNICATIONS_SCOPE });
    return { senderType: 'platform', actorId: user.id };
  }

  return { gymSender, platformSender };
}
