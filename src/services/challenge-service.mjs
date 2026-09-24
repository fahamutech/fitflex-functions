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
//
// Leaderboards (opt-in):
//   - A participant appears in a challenge's ranking only if they switch
//     `leaderboardOptIn` on (off by default), shown as first name + last
//     initial, ranked by progress toward the challenge goal. Everyone can
//     see where they would place without being listed.
//   - Team standings rank teams by average completion, so team size
//     doesn't decide the winner. A team's numbers are shown only once it
//     has MIN_TEAM_SIZE members, so they can't reveal one person's data.
//   - Only participants and the creator can see a leaderboard.
//   - Challenges measure activity and participation only — there is no
//     weight, body or appearance metric to rank on.
import { randomUUID } from 'node:crypto';
import { challengeProgress, localDay } from '../shared/member-progress.mjs';
import { normalizePermissions } from './trainer-client-service.mjs';
import { normalizeGymPermissions } from './gym-sharing-service.mjs';
import { PASS_TIERS } from '../shared/constants.mjs';

export const CHALLENGE_TYPES = ['steps', 'distance_km', 'workouts', 'active_minutes', 'consistency', 'gym_attendance'];
export const CREATOR_TYPES = ['fitflex', 'trainer', 'gym', 'corporate', 'partner'];
const VISIBILITY = ['public', 'audience'];
// individual | teams (creator-named) | gym_vs_gym (team = member's gym,
// FitFlex only) | department (team = employee's department, companies only)
export const MODES = ['individual', 'teams', 'gym_vs_gym', 'department'];
const MODE_CREATORS = { gym_vs_gym: ['fitflex'], department: ['corporate'] };
const MAX_TEAMS = 20;
export const MIN_TEAM_SIZE = 3;
// Per-day caps keep targets plausible for the challenge length.
const DAILY_CAP = { steps: 100_000, distance_km: 200, workouts: 5, active_minutes: 720, consistency: 1, gym_attendance: 1 };
const MAX_DAYS = 92;
const MAX_REWARDS = 5;
// Who pays for a challenge's rewards, by creator. The first is the default.
const REWARD_FUNDERS = {
  fitflex: ['fitflex', 'partner'],
  corporate: ['company', 'fitflex', 'partner'],
};
const MAX_ELIGIBLE_EMPLOYEES = 2000;
const EMPLOYEE_ELIGIBLE_STATUSES = new Set(['active', 'pending']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isDate = s => typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const daysInclusive = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;

/** upcoming | active | ended | cancelled, by the member's local date. */
export function challengePhase(c, now) {
  if (c.status === 'cancelled') return 'cancelled';
  // An archived challenge is finished: shown as ended to those who took part.
  if (c.status === 'archived' || c.status === 'closed') return 'ended';
  const today = localDay(now);
  if (today < c.startDate) return 'upcoming';
  if (today > c.endDate) return 'ended';
  return 'active';
}

export function createChallengeService({
  challenges, participants, users, trainers, gyms, relationships, gymMemberSharing, gymMemberIds,
  activities, checkins, teams = null, corporateEmployees = null, subscriptions = null,
  now = () => new Date(),
}) {
  // ── Audience ──────────────────────────────────────────────────────────────

  /** Can this member see (and join) the challenge? */
  async function visibleTo(c, memberId, ctx = {}) {
    if (c.status === 'cancelled' || c.status === 'archived') return false;
    if (!(await inAudience(c, memberId, ctx))) return false;
    return eligible(c, memberId, ctx);
  }

  /** Eligibility narrows the audience: pass tiers, departments, people. */
  async function eligible(c, memberId, ctx) {
    const e = c.eligibility;
    if (!e || e.kind === 'all') return true;
    if (e.kind === 'tiers') {
      if (!subscriptions) return false;
      const subs = await subscriptions.filterByColumnAsync('memberId', memberId);
      const today = now();
      return subs.some(sub => sub.status === 'active' && e.tiers.includes(sub.tier)
        && (!sub.expiresAt || new Date(sub.expiresAt) > today));
    }
    if (!corporateEmployees) return false;
    ctx.staff ??= await corporateEmployees.filterByColumnAsync('userId', memberId);
    const me = ctx.staff.find(x => x.corporateId === c.creatorId && EMPLOYEE_ELIGIBLE_STATUSES.has(x.status));
    if (!me) return false;
    if (e.kind === 'departments') {
      const want = new Set(e.departments.map(d => d.toLowerCase()));
      return !!me.department && want.has(me.department.toLowerCase());
    }
    if (e.kind === 'employees') return e.employeeIds.includes(me.id);
    return false;
  }

  async function inAudience(c, memberId, ctx) {
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
    return { ...c, mode: c.mode ?? 'individual', participantCount: joined.length };
  }

  async function teamList(challengeId) {
    if (!teams) return [];
    return (await teams.filterByColumnAsync('challengeId', challengeId))
      .map(t => ({ id: t.id, name: t.name, gymId: t.gymId ?? null, department: t.department ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Adds this member's team and leaderboard choice, and the team list. */
  async function forMember(c, rows, memberId) {
    const mine = rows.find(p => p.memberId === memberId && p.status === 'joined');
    return {
      ...withCounts(c, rows),
      phase: challengePhase(c, now()),
      joined: !!mine,
      myTeamId: mine?.teamId ?? null,
      leaderboardOptIn: mine?.leaderboardOptIn === true,
      teams: (c.mode ?? 'individual') === 'individual' ? [] : await teamList(c.id),
      creator: await creatorCard(c),
    };
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
      if ((phase === 'cancelled' || c.status === 'archived') && !joined) continue;
      if (!joined && (phase === 'ended' || !(await visibleTo(c, memberId, ctx)))) continue;
      const rows = await participants.filterByColumnAsync('challengeId', c.id);
      out.push(await forMember(c, rows, memberId));
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
    return { challenge: await forMember(c, rows, memberId) };
  }

  /** The team a member joins with, creating gym/department teams on demand. */
  async function resolveTeam(c, memberId, body) {
    const mode = c.mode ?? 'individual';
    if (mode === 'individual') return { teamId: null };
    const list = await teams.filterByColumnAsync('challengeId', c.id);
    if (mode === 'teams') {
      const t = list.find(x => x.id === body.teamId);
      return t ? { teamId: t.id } : { error: body.teamId ? 'invalid_team' : 'team_required', status: 400 };
    }
    const create = async (fields) => {
      const row = { id: `ctm_${randomUUID().slice(0, 12)}`, challengeId: c.id, createdAt: now().toISOString(), gymId: null, department: null, ...fields };
      await teams.insertAsync(row);
      return { teamId: row.id };
    };
    if (mode === 'gym_vs_gym') {
      const mine = await gymMemberIds(memberId);
      let gymId = body.gymId;
      if (gymId && !mine.has(gymId)) return { error: 'not_your_gym', status: 400 };
      if (!gymId) {
        const home = [...mine].filter(([, why]) => why.includes('member')).map(([id]) => id);
        if (home.length !== 1) return { error: 'gym_required', status: 400 };
        gymId = home[0];
      }
      const existing = list.find(x => x.gymId === gymId);
      if (existing) return { teamId: existing.id };
      const gym = await gyms.findByIdAsync(gymId);
      return create({ name: gym?.name ?? 'Gym', gymId });
    }
    // department — from the employee record at the challenge's company.
    const staff = corporateEmployees ? await corporateEmployees.filterByColumnAsync('userId', memberId) : [];
    const me = staff.find(e => e.corporateId === c.creatorId);
    const department = me?.department?.trim() || 'Other';
    const existing = list.find(x => x.department === department);
    return existing ? { teamId: existing.id } : create({ name: department, department });
  }

  async function join(memberId, id, body = {}) {
    const c = await challenges.findByIdAsync(id);
    if (!c || !(await visibleTo(c, memberId))) return { error: 'not_found', status: 404 };
    const phase = challengePhase(c, now());
    if (phase === 'ended' || phase === 'cancelled') return { error: 'challenge_closed', status: 409 };
    const existing = (await participants.filterByColumnAsync('challengeId', id)).find(p => p.memberId === memberId);
    if (existing?.status === 'joined') return { error: 'already_joined', status: 409 };
    const team = await resolveTeam(c, memberId, body);
    if (team.error) return team;
    const stamp = now().toISOString();
    const fields = {
      status: 'joined', joinedAt: stamp, leftAt: null,
      teamId: team.teamId,
      // Off unless the member explicitly chooses to appear in the ranking.
      leaderboardOptIn: body.leaderboardOptIn === true,
    };
    if (existing) {
      await participants.updateByIdAsync(existing.id, fields);
    } else {
      await participants.insertAsync({ id: `cpt_${randomUUID().slice(0, 12)}`, challengeId: id, memberId, ...fields });
    }
    return memberChallenge(memberId, id);
  }

  async function setLeaderboardOptIn(memberId, id, body = {}) {
    if (typeof body.optIn !== 'boolean') return { error: 'invalid_opt_in', status: 400 };
    const p = (await participants.filterByColumnAsync('challengeId', id)).find(x => x.memberId === memberId);
    if (!p || p.status !== 'joined') return { error: 'not_joined', status: 409 };
    await participants.updateByIdAsync(p.id, { leaderboardOptIn: body.optIn });
    return { leaderboardOptIn: body.optIn };
  }

  const shortName = n => {
    const parts = (n ?? '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return 'FitFlex member';
    return parts.length === 1 ? parts[0] : `${parts[0]} ${parts.at(-1)[0].toUpperCase()}.`;
  };

  /**
   * The ranking for a challenge. `viewer` is { memberId } (must have
   * joined) or a creator (must own it). Individuals: opted-in only.
   * Teams: all members count toward their team, shown once big enough.
   */
  async function leaderboard(viewer, id) {
    let c;
    if (viewer.memberId) {
      c = await challenges.findByIdAsync(id);
      const rows = c ? await participants.filterByColumnAsync('challengeId', id) : [];
      if (!c || !rows.some(p => p.memberId === viewer.memberId && p.status === 'joined')) {
        return { error: 'join_to_see_leaderboard', status: 403 };
      }
    } else {
      c = await owned(viewer, id);
      if (!c) return { error: 'not_found', status: 404 };
    }
    const joined = (await participants.filterByColumnAsync('challengeId', id)).filter(p => p.status === 'joined');
    const scored = [];
    for (const p of joined) {
      const progress = await progressFor(c, p.memberId);
      scored.push({ p, progress, fraction: c.target > 0 ? progress / c.target : 0 });
    }
    const byScore = (a, b) => b.fraction - a.fraction || +new Date(a.p.joinedAt) - +new Date(b.p.joinedAt);

    const listed = scored.filter(s => s.p.leaderboardOptIn === true).sort(byScore);
    const individuals = [];
    for (const [i, s] of listed.entries()) {
      const u = await users.findByIdAsync(s.p.memberId);
      individuals.push({
        rank: i + 1,
        name: shortName(u?.displayName),
        progress: s.progress,
        fraction: Math.round(s.fraction * 1000) / 1000,
        completed: s.progress >= c.target,
        ...(viewer.memberId && { you: s.p.memberId === viewer.memberId }),
      });
    }

    let you;
    if (viewer.memberId) {
      const mine = scored.find(s => s.p.memberId === viewer.memberId);
      // Where you'd place among those listed — revealing nothing about
      // anyone who chose not to appear.
      const pool = [...listed.filter(s => s !== mine), mine].sort(byScore);
      you = {
        optedIn: mine.p.leaderboardOptIn === true,
        rank: pool.indexOf(mine) + 1,
        of: pool.length,
        progress: mine.progress,
        teamId: mine.p.teamId ?? null,
      };
    }

    let teamStandings = [];
    let hiddenTeams = 0;
    if ((c.mode ?? 'individual') !== 'individual') {
      const names = new Map((await teamList(id)).map(t => [t.id, t.name]));
      const groups = new Map();
      for (const s of scored) {
        if (!s.p.teamId) continue;
        if (!groups.has(s.p.teamId)) groups.set(s.p.teamId, []);
        groups.get(s.p.teamId).push(s);
      }
      for (const [teamId, members] of groups) {
        if (members.length < MIN_TEAM_SIZE) { hiddenTeams += 1; continue; }
        const avg = members.reduce((n, s) => n + Math.min(s.fraction, 1), 0) / members.length;
        teamStandings.push({
          teamId,
          name: names.get(teamId) ?? 'Team',
          members: members.length,
          averageCompletion: Math.round(avg * 1000) / 1000,
          total: Math.round(members.reduce((n, s) => n + s.progress, 0) * 100) / 100,
        });
      }
      teamStandings.sort((a, b) => b.averageCompletion - a.averageCompletion || b.members - a.members);
      teamStandings = teamStandings.map((t, i) => ({ rank: i + 1, ...t }));
    }

    return {
      challengeId: id,
      type: c.type,
      target: c.target,
      mode: c.mode ?? 'individual',
      participants: joined.length,
      individuals,
      ...(you && { you }),
      teams: teamStandings,
      hiddenTeams,
      minTeamSize: MIN_TEAM_SIZE,
    };
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
    const mode = body.mode ?? 'individual';
    if (!MODES.includes(mode)) return { error: 'invalid_mode', status: 400 };
    let teamNames = [];
    if (mode === 'teams') {
      teamNames = Array.isArray(body.teams) ? body.teams.map(t => text(t, 40)).filter(Boolean) : [];
      if (teamNames.length < 2 || teamNames.length > MAX_TEAMS || new Set(teamNames.map(n => n.toLowerCase())).size !== teamNames.length) {
        return { error: 'invalid_teams', status: 400 };
      }
    }
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
        mode,
      },
      teamNames,
    };
  }

  /** Validates eligibility for this creator. Returns { eligibility } or an error. */
  async function validateEligibility(creator, raw) {
    if (raw == null || raw.kind === 'all') return { eligibility: null };
    if (creator.creatorType === 'fitflex' && raw.kind === 'tiers') {
      const tiers = Array.isArray(raw.tiers) ? [...new Set(raw.tiers)] : [];
      if (!tiers.length || !tiers.every(t => t in PASS_TIERS)) return { error: 'invalid_eligibility', status: 400 };
      return { eligibility: { kind: 'tiers', tiers } };
    }
    if (creator.creatorType === 'corporate' && corporateEmployees) {
      const staff = (await corporateEmployees.filterByColumnAsync('corporateId', creator.creatorId))
        .filter(x => EMPLOYEE_ELIGIBLE_STATUSES.has(x.status));
      if (raw.kind === 'departments') {
        const known = new Map(staff.filter(x => x.department).map(x => [x.department.toLowerCase(), x.department]));
        const wanted = Array.isArray(raw.departments) ? raw.departments.map(d => text(d, 60)).filter(Boolean) : [];
        if (!wanted.length || !wanted.every(d => known.has(d.toLowerCase()))) return { error: 'invalid_eligibility', status: 400 };
        return { eligibility: { kind: 'departments', departments: [...new Set(wanted.map(d => known.get(d.toLowerCase())))] } };
      }
      if (raw.kind === 'employees') {
        const ids = Array.isArray(raw.employeeIds) ? [...new Set(raw.employeeIds)] : [];
        const mine = new Set(staff.map(x => x.id));
        if (!ids.length || ids.length > MAX_ELIGIBLE_EMPLOYEES || !ids.every(id => mine.has(id))) {
          return { error: 'invalid_eligibility', status: 400 };
        }
        return { eligibility: { kind: 'employees', employeeIds: ids } };
      }
    }
    return { error: 'invalid_eligibility', status: 400 };
  }

  function validateFunding(creator, value, fallback = undefined) {
    const allowed = REWARD_FUNDERS[creator.creatorType];
    if (!allowed) return { rewardFunding: null };
    if (value === undefined) return { rewardFunding: fallback ?? allowed[0] };
    if (!allowed.includes(value)) return { error: 'invalid_reward_funding', status: 400 };
    return { rewardFunding: value };
  }

  /** Create a challenge for a creator (resolved and authorised by the caller). */
  async function create({ creatorType, creatorId, createdBy }, body = {}) {
    if (!CREATOR_TYPES.includes(creatorType) || creatorType === 'partner') return { error: 'invalid_creator', status: 400 };
    const v = validate(body);
    if (v.error) return v;
    const allowed = MODE_CREATORS[v.fields.mode];
    if (allowed && !allowed.includes(creatorType)) return { error: 'mode_not_allowed', status: 400 };
    const creator = { creatorType, creatorId };
    const el = await validateEligibility(creator, body.eligibility);
    if (el.error) return el;
    const fund = validateFunding(creator, body.rewardFunding);
    if (fund.error) return fund;
    const stamp = now().toISOString();
    const row = {
      id: `chl_${randomUUID().slice(0, 12)}`,
      ...v.fields,
      eligibility: el.eligibility,
      rewardFunding: fund.rewardFunding,
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
    for (const name of v.teamNames) {
      await teams.insertAsync({ id: `ctm_${randomUUID().slice(0, 12)}`, challengeId: row.id, name, gymId: null, department: null, createdAt: stamp });
    }
    return { challenge: { ...row, participantCount: 0, phase: challengePhase(row, now()), teams: await teamList(row.id) } };
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

  /**
   * Edit a challenge you created. Anything can change before it starts and
   * before anyone joins; after that the measure (type, mode) and the start
   * date stay put so nobody's progress changes meaning under them.
   */
  async function update(creator, id, body = {}) {
    const c = await owned(creator, id);
    if (!c) return { error: 'not_found', status: 404 };
    if (c.status !== 'active') return { error: 'not_editable', status: 409 };
    const started = localDay(now()) >= c.startDate;
    const joined = (await participants.filterByColumnAsync('challengeId', id)).some(p => p.status === 'joined');
    if ((started || joined) && ((body.type && body.type !== c.type) || (body.mode && body.mode !== (c.mode ?? 'individual')))) {
      return { error: 'measure_locked', status: 409 };
    }
    if (started && body.startDate && body.startDate !== c.startDate) return { error: 'start_locked', status: 409 };
    const pick = k => (body[k] !== undefined ? body[k] : c[k]);
    const v = validate({
      name: pick('name'), description: pick('description'), type: pick('type'),
      target: pick('target'), startDate: pick('startDate'), endDate: pick('endDate'),
      rewards: pick('rewards') ?? [], visibility: pick('visibility') ?? 'audience',
      mode: pick('mode') ?? 'individual',
      teams: (await teamList(id)).map(t => t.name),
    });
    if (v.error) return v;
    const allowed = MODE_CREATORS[v.fields.mode];
    if (allowed && !allowed.includes(c.creatorType)) return { error: 'mode_not_allowed', status: 400 };
    const patch = { ...v.fields, updatedAt: now().toISOString() };
    if (c.creatorType === 'fitflex') patch.visibility = 'public';
    if (body.eligibility !== undefined) {
      const el = await validateEligibility(creator, body.eligibility);
      if (el.error) return el;
      patch.eligibility = el.eligibility;
    }
    if (body.rewardFunding !== undefined) {
      const fund = validateFunding(creator, body.rewardFunding);
      if (fund.error) return fund;
      patch.rewardFunding = fund.rewardFunding;
    }
    const updated = await challenges.updateByIdAsync(id, patch);
    const row = updated ?? { ...c, ...patch };
    return { challenge: { ...withCounts(row, await participants.filterByColumnAsync('challengeId', id)), phase: challengePhase(row, now()), teams: await teamList(id) } };
  }

  /** End a running challenge now, keeping everyone's results up to today. */
  async function close(creator, id) {
    const c = await owned(creator, id);
    if (!c) return { error: 'not_found', status: 404 };
    if (c.status !== 'active') return { error: 'not_running', status: 409 };
    const today = localDay(now());
    if (today < c.startDate) return { error: 'not_started_cancel_instead', status: 409 };
    if (today > c.endDate) return { error: 'already_ended', status: 409 };
    await challenges.updateByIdAsync(id, { status: 'closed', endDate: today, updatedAt: now().toISOString() });
    return { challenge: { ...c, status: 'closed', endDate: today, phase: 'ended' } };
  }

  /** Put a finished (ended or cancelled) challenge away. */
  async function archive(creator, id) {
    const c = await owned(creator, id);
    if (!c) return { error: 'not_found', status: 404 };
    if (c.status === 'archived') return { error: 'already_archived', status: 409 };
    if (c.status === 'active' && localDay(now()) <= c.endDate) return { error: 'still_running', status: 409 };
    await challenges.updateByIdAsync(id, { status: 'archived', updatedAt: now().toISOString() });
    return { challenge: { ...c, status: 'archived', phase: 'ended' } };
  }

  /** Who the challenge is open to, as a count (for participation rates). */
  async function eligibleCount(c) {
    const e = c.eligibility;
    if (c.creatorType === 'fitflex') {
      if (e?.kind === 'tiers' && subscriptions) {
        const today = now();
        const subs = (await subscriptions.allAsync()).filter(sub => sub.status === 'active' && e.tiers.includes(sub.tier)
          && (!sub.expiresAt || new Date(sub.expiresAt) > today));
        return new Set(subs.map(sub => sub.memberId)).size;
      }
      return (await users.filterByColumnAsync('userType', 'member')).length;
    }
    if (c.creatorType === 'corporate' && corporateEmployees) {
      return (await eligibleStaff(c)).length;
    }
    return null;
  }

  async function eligibleStaff(c) {
    const e = c.eligibility;
    const staff = (await corporateEmployees.filterByColumnAsync('corporateId', c.creatorId))
      .filter(x => EMPLOYEE_ELIGIBLE_STATUSES.has(x.status));
    if (e?.kind === 'departments') {
      const want = new Set(e.departments.map(d => d.toLowerCase()));
      return staff.filter(x => x.department && want.has(x.department.toLowerCase()));
    }
    if (e?.kind === 'employees') return staff.filter(x => e.employeeIds.includes(x.id));
    return staff;
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
      const fractions = new Map();
      for (const p of joined) {
        const v = await progressFor(c, p.memberId);
        const f = Math.min(v / c.target, 1);
        fractions.set(p.memberId, f);
        if (v >= c.target) completed += 1;
        sum += f;
      }
      const eligibleN = await eligibleCount(c);
      const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 1000 : null);
      const summary = {
        eligible: eligibleN,
        joined: joined.length,
        participationRate: eligibleN == null ? null : pct(joined.length, eligibleN),
        completed,
        completionRate: pct(completed, joined.length),
        averageProgress: joined.length ? Math.round((sum / joined.length) * 100) / 100 : 0,
      };
      if (c.creatorType !== 'corporate' || !corporateEmployees) return { summary };
      // By department, for HR. Groups smaller than MIN_TEAM_SIZE are folded
      // together so no one person's numbers show.
      const staff = await eligibleStaff(c);
      const groups = new Map();
      for (const x of staff) {
        const key = x.department || null;
        const g = groups.get(key) ?? { department: key, eligible: 0, joined: 0, completed: 0, sum: 0 };
        g.eligible += 1;
        if (x.userId && fractions.has(x.userId)) {
          g.joined += 1;
          g.sum += fractions.get(x.userId);
          if (fractions.get(x.userId) >= 1) g.completed += 1;
        }
        groups.set(key, g);
      }
      const shown = [];
      const small = { department: null, other: true, eligible: 0, joined: 0, completed: 0, sum: 0 };
      for (const g of groups.values()) {
        const target = g.department && g.eligible >= MIN_TEAM_SIZE ? g : small;
        if (target === g) shown.push(g);
        else for (const k of ['eligible', 'joined', 'completed', 'sum']) small[k] += g[k];
      }
      if (small.eligible) shown.push(small);
      const view = g => ({
        department: g.department, other: g.other === true, eligible: g.eligible,
        joined: g.joined, participationRate: pct(g.joined, g.eligible),
        // Progress and completion only once the group is big enough.
        ...(g.eligible >= MIN_TEAM_SIZE && g.joined >= MIN_TEAM_SIZE
          ? { completed: g.completed, averageProgress: Math.round((g.sum / g.joined) * 100) / 100 }
          : {}),
      });
      return {
        summary,
        byDepartment: shown.sort((a, b) => (a.other ? 1 : 0) - (b.other ? 1 : 0) || b.eligible - a.eligible).map(view),
        minGroupSize: MIN_TEAM_SIZE,
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
    setLeaderboardOptIn, leaderboard,
    create, creatorList, cancel, update, close, archive, creatorParticipants,
  };
}

