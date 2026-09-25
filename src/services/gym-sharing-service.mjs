// Gym ↔ member activity sharing.
//
// A gym always sees its own records of a member: check-ins (needed for
// entry) and the visit patterns derived from them. Anything from the
// member's activity log is private unless the member switches it on for
// that gym:
//   classAttendance — group classes the member logged at this gym
//   gymWorkouts     — workouts done at this gym (type, date, duration;
//                     never sets, weights or notes)
//   challenges      — progress on this gym's challenges the member joined
// Activity elsewhere, steps, goals and streaks are never visible to a gym.
import { randomUUID } from 'node:crypto';
import { localDay, addDays, daysBetween, weekStart, isWorkout, activeMinutesOf } from '../shared/member-progress.mjs';

export const GYM_PERMISSIONS = ['classAttendance', 'gymWorkouts', 'challenges'];
const HISTORY_DAYS = 90;
const LIST_LIMIT = 20;
// Visit-pattern bands (days since last visit).
const ACTIVE_DAYS = 7;
const SLIPPING_DAYS = 14;
const LAPSED_DAYS = 30;

export function normalizeGymPermissions(input, base = {}) {
  const out = {};
  for (const key of GYM_PERMISSIONS) {
    const v = input && Object.prototype.hasOwnProperty.call(input, key) ? input[key] : base[key];
    out[key] = v === true;
  }
  return out;
}

/**
 * Visit patterns from a member's check-ins at one gym. `status` bands:
 * active (visited in the last 7 days), slipping (8–14), at_risk (15–30),
 * lapsed (30+), none (no visits in the window).
 */
export function engagementFrom(checkinTimestamps, now) {
  const today = localDay(now);
  const days = [...new Set(checkinTimestamps.map(localDay))].filter(d => d > addDays(today, -HISTORY_DAYS)).sort();
  const within = (from, to) => days.filter(d => d > from && d <= to).length;
  const visits30 = within(addDays(today, -30), today);
  const previous30 = within(addDays(today, -60), addDays(today, -30));
  const last = days.at(-1) ?? null;
  const since = last ? daysBetween(last, today) : null;
  const status = since === null ? 'none'
    : since <= ACTIVE_DAYS ? 'active'
    : since <= SLIPPING_DAYS ? 'slipping'
    : since <= LAPSED_DAYS ? 'at_risk'
    : 'lapsed';
  // Consecutive Monday–Sunday weeks with a visit; this week can't break it.
  const weeks = new Set(days.map(weekStart));
  const thisWeek = weekStart(today);
  let n = weeks.has(thisWeek) ? 0 : 1;
  let weekStreak = 0;
  while (weeks.has(addDays(thisWeek, -7 * n))) { weekStreak += 1; n += 1; }
  const eightWeeks = within(addDays(thisWeek, -56), today);
  return {
    visits30,
    previous30,
    lastVisit: last,
    daysSinceLastVisit: since,
    weekStreak,
    avgVisitsPerWeek: Math.round((eightWeeks / 8) * 10) / 10,
    status,
  };
}

export function createGymSharingService({
  sharing, gyms, subscriptions, checkins, activities, users, now = () => new Date(),
  // (creatorType, creatorId, memberId) → progress on that gym's challenges.
  challengeProgressFor = async () => [],
}) {
  const gymCard = g => (g ? { id: g.id, name: g.name ?? null, location: g.location ?? null } : null);

  /** Gyms a member is connected to: their home gym(s) and gyms visited recently. */
  async function memberGymIds(memberId) {
    const reasons = new Map();
    const add = (gymId, reason) => {
      if (!gymId) return;
      reasons.set(gymId, [...new Set([...(reasons.get(gymId) ?? []), reason])]);
    };
    for (const s of await subscriptions.filterByColumnAsync('memberId', memberId)) {
      if (s.status !== 'cancelled' && s.status !== 'expired') add(s.homeGymId, 'member');
    }
    const cutoff = addDays(localDay(now()), -HISTORY_DAYS);
    for (const c of await checkins.filterByColumnAsync('memberId', memberId)) {
      if (localDay(c.timestamp) > cutoff) add(c.gymId, 'visited');
    }
    for (const r of await sharing.filterByColumnAsync('memberId', memberId)) add(r.gymId, 'shared');
    return reasons;
  }

  // ── Member ────────────────────────────────────────────────────────────────

  async function memberSharing(memberId) {
    const reasons = await memberGymIds(memberId);
    const rows = await sharing.filterByColumnAsync('memberId', memberId);
    const out = [];
    for (const [gymId, why] of reasons) {
      const gym = await gyms.findByIdAsync(gymId);
      if (!gym) continue;
      const row = rows.find(r => r.gymId === gymId);
      out.push({ gym: gymCard(gym), reasons: why, permissions: normalizeGymPermissions(row?.permissions) });
    }
    out.sort((a, b) => (a.gym.name ?? '').localeCompare(b.gym.name ?? ''));
    return { gyms: out };
  }

  async function updateMemberSharing(memberId, gymId, body = {}) {
    if (!body.permissions || typeof body.permissions !== 'object') return { error: 'invalid_permissions', status: 400 };
    const reasons = await memberGymIds(memberId);
    if (!reasons.has(gymId)) return { error: 'not_your_gym', status: 404 };
    const existing = (await sharing.filterByColumnAsync('memberId', memberId)).find(r => r.gymId === gymId);
    const permissions = normalizeGymPermissions(body.permissions, existing?.permissions);
    const stamp = now().toISOString();
    if (existing) {
      await sharing.updateByIdAsync(existing.id, { permissions, updatedAt: stamp });
    } else {
      await sharing.insertAsync({ id: `gms_${randomUUID().slice(0, 12)}`, gymId, memberId, permissions, createdAt: stamp, updatedAt: stamp });
    }
    const gym = await gyms.findByIdAsync(gymId);
    return { gym: gymCard(gym), permissions };
  }

  // ── Gym (owner / staff) ───────────────────────────────────────────────────

  const ownerGymIds = owner => owner?.gymIds || (owner?.gymId ? [owner.gymId] : []);

  /**
   * One member, per gym this owner manages that the member is connected
   * to: visit patterns always, and only the activity the member shares
   * with that gym.
   */
  async function ownerMemberActivity(owner, memberId) {
    const mine = ownerGymIds(owner);
    const reasons = await memberGymIds(memberId);
    const gymIds = mine.filter(id => reasons.has(id));
    if (!gymIds.length) return { error: 'not_your_member', status: 404 };
    const rows = await sharing.filterByColumnAsync('memberId', memberId);
    const memberCheckins = await checkins.filterByColumnAsync('memberId', memberId);
    const cutoff = addDays(localDay(now()), -HISTORY_DAYS);
    let acts = null;
    const out = [];
    for (const gymId of gymIds) {
      const perms = normalizeGymPermissions(rows.find(r => r.gymId === gymId)?.permissions);
      const entry = {
        gym: gymCard(await gyms.findByIdAsync(gymId)),
        permissions: perms,
        engagement: engagementFrom(memberCheckins.filter(c => c.gymId === gymId).map(c => c.timestamp), now()),
      };
      if (perms.classAttendance || perms.gymWorkouts) {
        acts ??= (await activities.filterByColumnAsync('userId', memberId))
          .filter(a => localDay(a.startedAt) > cutoff);
        const here = acts.filter(a => a.gymId === gymId)
          .sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt));
        // Only when, what and how long — never metrics, sets or notes.
        const brief = a => ({ date: localDay(a.startedAt), type: a.type, durationMinutes: a.durationMinutes ?? activeMinutesOf(a) ?? null });
        if (perms.classAttendance) {
          entry.classAttendance = here.filter(a => a.type === 'group_class').slice(0, LIST_LIMIT).map(brief);
        }
        if (perms.gymWorkouts) {
          entry.gymWorkouts = here.filter(a => a.type !== 'group_class' && isWorkout(a)).slice(0, LIST_LIMIT).map(brief);
        }
      }
      if (perms.challenges) entry.challenges = await challengeProgressFor('gym', gymId, memberId);
      out.push(entry);
    }
    return { gyms: out };
  }

  /**
   * Gym-wide visit patterns for the owner's dashboard, from check-ins only:
   * who's active, who's slipping away, and who's new.
   */
  async function ownerEngagement(owner, gymId) {
    const mine = ownerGymIds(owner);
    const ids = gymId ? mine.filter(id => id === gymId) : mine;
    if (!ids.length) return { error: gymId ? 'not_your_gym' : 'owner_has_no_gyms', status: gymId ? 403 : 400 };
    const today = localDay(now());
    const cutoff = addDays(today, -HISTORY_DAYS);
    const byMember = new Map();
    for (const id of ids) {
      for (const c of await checkins.filterByColumnAsync('gymId', id)) {
        if (localDay(c.timestamp) <= cutoff) continue;
        if (!byMember.has(c.memberId)) byMember.set(c.memberId, []);
        byMember.get(c.memberId).push(c.timestamp);
      }
    }
    const bands = { active: 0, slipping: 0, at_risk: 0, lapsed: 0 };
    const attention = [];
    let visits30 = 0, previous30 = 0, newThisMonth = 0;
    const monthStart = `${today.slice(0, 7)}-01`;
    for (const [memberId, stamps] of byMember) {
      const e = engagementFrom(stamps, now());
      if (e.status in bands) bands[e.status] += 1;
      visits30 += e.visits30;
      previous30 += e.previous30;
      const first = stamps.map(localDay).sort()[0];
      if (first >= monthStart) newThisMonth += 1;
      if (e.status === 'slipping' || e.status === 'at_risk') attention.push({ memberId, ...e });
    }
    attention.sort((a, b) => a.daysSinceLastVisit - b.daysSinceLastVisit);
    const list = [];
    for (const a of attention.slice(0, LIST_LIMIT)) {
      const u = await users.findByIdAsync(a.memberId);
      list.push({ member: { id: a.memberId, displayName: u?.displayName ?? null }, ...a, memberId: undefined });
    }
    return {
      members: byMember.size,
      ...bands,
      newThisMonth,
      visits30,
      previous30,
      // Members who used to come regularly and have stopped — worth a call.
      checkIn: list,
    };
  }

  return { memberSharing, updateMemberSharing, ownerMemberActivity, ownerEngagement, memberGymIds };
}
