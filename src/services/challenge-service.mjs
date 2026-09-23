// Challenge engine — time-boxed challenges members join, from FitFlex,
// trainers, gyms and corporate accounts (partners later).
//
// Who can see a challenge (and join it):
//   fitflex   — every member
//   trainer   — the trainer's active clients (or everyone if public)
//   gym       — the gym's members and recent visitors (or everyone)
//   corporate — the company's employees (or everyone)
//
// What creators see about participants:
//   trainer / gym — each participant's progress only if that member shares
//                   `challenges` with them (Activity sharing); otherwise
//                   just that they joined
//   fitflex / corporate — totals only (joined, completed, average progress),
//                   never individuals
import { randomUUID } from 'node:crypto';
import { challengeProgress, localDay } from '../shared/member-progress.mjs';
import { normalizePermissions } from './trainer-client-service.mjs';
import { normalizeGymPermissions } from './gym-sharing-service.mjs';

export const CHALLENGE_TYPES = ['steps', 'distance_km', 'workouts', 'active_minutes', 'consistency', 'gym_attendance'];
export const CREATOR_TYPES = ['fitflex', 'trainer', 'gym', 'corporate', 'partner'];
const VISIBILITY = ['public', 'audience'];
// Per-day caps keep targets plausible for the challenge length.
const DAILY_CAP = { steps: 100_000, distance_km: 200, workouts: 5, active_minutes: 720, consistency: 1, gym_attendance: 1 };
const MAX_DAYS = 92;
const MAX_REWARDS = 5;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isDate = s => typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const daysInclusive = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;

/** upcoming | active | ended | cancelled, by the member's local date. */
export function challengePhase(c, now) {
  if (c.status === 'cancelled') return 'cancelled';
  const today = localDay(now);
  if (today < c.startDate) return 'upcoming';
  if (today > c.endDate) return 'ended';
  return 'active';
}

export function createChallengeService({
  challenges, participants, users, trainers, gyms, relationships, gymMemberSharing, gymMemberIds,
  activities, checkins, now = () => new Date(),
}) {
  // ── Audience ──────────────────────────────────────────────────────────────

  /** Can this member see (and join) the challenge? */
  async function visibleTo(c, memberId, ctx = {}) {
    if (c.status === 'cancelled') return false;
    if (c.creatorType === 'fitflex' || c.visibility === 'public') return true;
    switch (c.creatorType) {
      case 'trainer': {
        ctx.rels ??= await relationships.filterByColumnAsync('memberId', memberId);
        return ctx.rels.some(r => r.trainerId === c.creatorId && r.status === 'active');
      }
      case 'gym': {
        ctx.gyms ??= await gymMemberIds(memberId);
        return ctx.gyms.has(c.creatorId);
      }
      case 'corporate': {
        ctx.user ??= await users.findByIdAsync(memberId);
        return !!ctx.user?.corporateId && ctx.user.corporateId === c.creatorId;
      }
      default: return false;
    }
  }

  function withCounts(c, rows) {
    const joined = rows.filter(p => p.challengeId === c.id && p.status === 'joined');
    return { ...c, participantCount: joined.length };
  }

  // ── Member ────────────────────────────────────────────────────────────────

  /**
   * Challenges for the member: every one they joined (any phase) plus the
   * ones they could join that haven't ended. Progress is computed on the
   * device from the member's own data.
   */
  async function memberChallenges(memberId) {
    const mine = (await participants.filterByColumnAsync('memberId', memberId));
    const joinedIds = new Set(mine.filter(p => p.status === 'joined').map(p => p.challengeId));
    const all = await challenges.allAsync();
    const ctx = {};
    const out = [];
    for (const c of all) {
      const phase = challengePhase(c, now());
      const joined = joinedIds.has(c.id);
      if (phase === 'cancelled' && !joined) continue;
      if (!joined && (phase === 'ended' || !(await visibleTo(c, memberId, ctx)))) continue;
      const rows = await participants.filterByColumnAsync('challengeId', c.id);
      out.push({ ...withCounts(c, rows), phase, joined, creator: await creatorCard(c) });
    }
    out.sort((a, b) => a.endDate.localeCompare(b.endDate));
    return { challenges: out };
  }

  async function creatorCard(c) {
    if (c.creatorType === 'trainer') {
      const t = await trainers.findByIdAsync(c.creatorId);
      return { type: 'trainer', id: c.creatorId, name: t?.displayName ?? null };
    }
    if (c.creatorType === 'gym') {
      const g = await gyms.findByIdAsync(c.creatorId);
      return { type: 'gym', id: c.creatorId, name: g?.name ?? null };
    }
    return { type: c.creatorType, id: c.creatorId ?? null, name: null };
  }

  async function memberChallenge(memberId, id) {
    const c = await challenges.findByIdAsync(id);
    if (!c) return { error: 'not_found', status: 404 };
    const rows = await participants.filterByColumnAsync('challengeId', id);
    const joined = rows.some(p => p.memberId === memberId && p.status === 'joined');
    if (!joined && !(await visibleTo(c, memberId))) return { error: 'not_found', status: 404 };
    return { challenge: { ...withCounts(c, rows), phase: challengePhase(c, now()), joined, creator: await creatorCard(c) } };
  }

  async function join(memberId, id) {
    const c = await challenges.findByIdAsync(id);
    if (!c || !(await visibleTo(c, memberId))) return { error: 'not_found', status: 404 };
    const phase = challengePhase(c, now());
    if (phase === 'ended' || phase === 'cancelled') return { error: 'challenge_closed', status: 409 };
    const existing = (await participants.filterByColumnAsync('challengeId', id)).find(p => p.memberId === memberId);
    const stamp = now().toISOString();
    if (existing?.status === 'joined') return { error: 'already_joined', status: 409 };
    if (existing) {
      await participants.updateByIdAsync(existing.id, { status: 'joined', joinedAt: stamp, leftAt: null });
    } else {
      await participants.insertAsync({ id: `cpt_${randomUUID().slice(0, 12)}`, challengeId: id, memberId, status: 'joined', joinedAt: stamp, leftAt: null });
    }
    return memberChallenge(memberId, id);
  }

  async function leave(memberId, id) {
    const existing = (await participants.filterByColumnAsync('challengeId', id)).find(p => p.memberId === memberId);
    if (!existing || existing.status !== 'joined') return { error: 'not_joined', status: 409 };
    await participants.updateByIdAsync(existing.id, { status: 'left', leftAt: now().toISOString() });
    return { left: true };
  }

  // ── Creators ──────────────────────────────────────────────────────────────

  function validate(body) {
    const name = text(body.name, 80);
    if (!name) return { error: 'invalid_name', status: 400 };
    if (!CHALLENGE_TYPES.includes(body.type)) return { error: 'invalid_type', status: 400 };
    if (!isDate(body.startDate) || !isDate(body.endDate) || body.endDate < body.startDate) {
      return { error: 'invalid_dates', status: 400 };
    }
    const days = daysInclusive(body.startDate, body.endDate);
    if (days > MAX_DAYS) return { error: 'too_long', status: 400 };
    if (body.endDate < localDay(now())) return { error: 'ends_in_past', status: 400 };
    const t = body.target;
    if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0 || t > DAILY_CAP[body.type] * days) {
      return { error: 'invalid_target', status: 400 };
    }
    const visibility = body.visibility ?? 'audience';
    if (!VISIBILITY.includes(visibility)) return { error: 'invalid_visibility', status: 400 };
    const rewards = body.rewards ?? [];
    if (!Array.isArray(rewards) || rewards.length > MAX_REWARDS || !rewards.every(r => text(r, 80))) {
      return { error: 'invalid_rewards', status: 400 };
    }
    return {
      fields: {
        name,
        description: text(body.description, 500),
        type: body.type,
        target: ['workouts', 'consistency', 'gym_attendance', 'steps', 'active_minutes'].includes(body.type) ? Math.round(t) : t,
        startDate: body.startDate,
        endDate: body.endDate,
        rewards: rewards.map(r => text(r, 80)),
        visibility,
      },
    };
  }

  /** Create a challenge for a creator (resolved and authorised by the caller). */
  async function create({ creatorType, creatorId, createdBy }, body = {}) {
    if (!CREATOR_TYPES.includes(creatorType) || creatorType === 'partner') return { error: 'invalid_creator', status: 400 };
    const v = validate(body);
    if (v.error) return v;
    const stamp = now().toISOString();
    const row = {
      id: `chl_${randomUUID().slice(0, 12)}`,
      ...v.fields,
      // FitFlex challenges are for everyone.
      visibility: creatorType === 'fitflex' ? 'public' : v.fields.visibility,
      creatorType,
      creatorId: creatorId ?? null,
      createdBy: createdBy ?? null,
      status: 'active',
      createdAt: stamp,
      updatedAt: stamp,
    };
    await challenges.insertAsync(row);
    return { challenge: { ...row, participantCount: 0, phase: challengePhase(row, now()) } };
  }

  async function creatorList({ creatorType, creatorId }) {
    const rows = (await challenges.allAsync())
      .filter(c => c.creatorType === creatorType && (creatorType === 'fitflex' || c.creatorId === creatorId))
      .sort((a, b) => b.startDate.localeCompare(a.startDate));
    const out = [];
    for (const c of rows) {
      out.push({ ...withCounts(c, await participants.filterByColumnAsync('challengeId', c.id)), phase: challengePhase(c, now()) });
    }
    return { challenges: out };
  }

  async function owned(creator, id) {
    const c = await challenges.findByIdAsync(id);
    if (!c || c.creatorType !== creator.creatorType) return null;
    if (creator.creatorType !== 'fitflex' && c.creatorId !== creator.creatorId) return null;
    return c;
  }

  async function cancel(creator, id) {
    const c = await owned(creator, id);
    if (!c) return { error: 'not_found', status: 404 };
    if (c.status === 'cancelled') return { error: 'already_cancelled', status: 409 };
    await challenges.updateByIdAsync(id, { status: 'cancelled', updatedAt: now().toISOString() });
    return { challenge: { ...c, status: 'cancelled', phase: 'cancelled' } };
  }

  async function progressFor(c, memberId) {
    const acts = c.type === 'gym_attendance' ? [] : await activities.filterByColumnAsync('userId', memberId);
    const chk = c.type === 'gym_attendance' ? await checkins.filterByColumnAsync('memberId', memberId) : [];
    return challengeProgress(c, acts, chk, c.creatorType === 'gym' ? c.creatorId : null);
  }

  /** Does this member share challenge data with the trainer/gym creator? */
  async function sharesWithCreator(c, memberId) {
    if (c.creatorType === 'trainer') {
      const rels = await relationships.filterByColumnAsync('memberId', memberId);
      const r = rels.find(x => x.trainerId === c.creatorId && x.status === 'active');
      return !!r && normalizePermissions(r.permissions).challenges;
    }
    if (c.creatorType === 'gym') {
      const rows = await gymMemberSharing.filterByColumnAsync('memberId', memberId);
      const row = rows.find(x => x.gymId === c.creatorId);
      return normalizeGymPermissions(row?.permissions).challenges;
    }
    return false;
  }

  /**
   * Participants as the creator may see them. Trainers and gyms get names,
   * plus progress for members who share challenge data with them.
   * FitFlex and corporate get totals only.
   */
  async function creatorParticipants(creator, id) {
    const c = await owned(creator, id);
    if (!c) return { error: 'not_found', status: 404 };
    const joined = (await participants.filterByColumnAsync('challengeId', id)).filter(p => p.status === 'joined');
    if (creator.creatorType === 'fitflex' || creator.creatorType === 'corporate') {
      let completed = 0, sum = 0;
      for (const p of joined) {
        const v = await progressFor(c, p.memberId);
        if (v >= c.target) completed += 1;
        sum += Math.min(v / c.target, 1);
      }
      return {
        summary: {
          joined: joined.length,
          completed,
          averageProgress: joined.length ? Math.round((sum / joined.length) * 100) / 100 : 0,
        },
      };
    }
    const out = [];
    for (const p of joined) {
      const u = await users.findByIdAsync(p.memberId);
      const row = { member: { id: p.memberId, displayName: u?.displayName ?? null }, joinedAt: p.joinedAt };
      if (await sharesWithCreator(c, p.memberId)) {
        const progress = await progressFor(c, p.memberId);
        row.progress = progress;
        row.completed = progress >= c.target;
      }
      out.push(row);
    }
    // Shared progress first, highest first; then everyone else by name.
    out.sort((a, b) => (b.progress ?? -1) - (a.progress ?? -1)
      || (a.member.displayName ?? '').localeCompare(b.member.displayName ?? ''));
    return { participants: out, target: c.target, type: c.type };
  }

  /**
   * For a trainer's or gym's view of one member (already permission-checked
   * by the caller): that member's progress on the creator's challenges.
   */
  async function memberProgressForCreator(creatorType, creatorId, memberId) {
    const mine = (await participants.filterByColumnAsync('memberId', memberId)).filter(p => p.status === 'joined');
    const out = [];
    for (const p of mine) {
      const c = await challenges.findByIdAsync(p.challengeId);
      if (!c || c.creatorType !== creatorType || c.creatorId !== creatorId || c.status === 'cancelled') continue;
      const progress = await progressFor(c, memberId);
      out.push({
        id: c.id, name: c.name, type: c.type, target: c.target, endDate: c.endDate,
        phase: challengePhase(c, now()), progress, completed: progress >= c.target,
      });
    }
    return out.sort((a, b) => b.endDate.localeCompare(a.endDate));
  }

  return {
    memberChallenges, memberChallenge, join, leave, memberProgressForCreator,
    create, creatorList, cancel, creatorParticipants,
  };
}

