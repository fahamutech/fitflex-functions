// Internal product analytics for FitFlex staff (admin portal only).
//
// Everything here is an aggregate: counts and rates, per day or per gym.
// No member names, ids or individual activity leave this service, and no
// member-facing route calls it.
//
// "Active" means the member did something FitFlex recorded that day: an
// activity, a completed workout or a gym check-in. There is no app-open
// tracking, so browsing without recording anything doesn't count.
//
// Days are members' local days (EAT), as in member-progress.mjs. The
// computation loads the relevant tables in memory, which is fine at pilot
// scale; the window is capped so it stays bounded.
import {
  localDay, addDays, weekStart, goalProgress, streaks, challengeProgress,
} from '../shared/member-progress.mjs';

export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 92;
const STREAK_BUCKETS = [[0, 0], [1, 2], [3, 6], [7, 13], [14, Infinity]];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const rate = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : null);
const inDays = (day, from, to) => day >= from && day <= to;
const anyTrue = obj => !!obj && Object.values(obj).some(v => v === true);

/** Device, FitFlex or manual, with the app's rule for unproven "device". */
export function originOf(a) {
  if (a.source === 'device') return a.devicePlatform ? 'device' : 'manual';
  if (a.source === 'fitflex') return 'fitflex';
  return 'manual';
}

export function createAnalyticsService({
  users, activities, workouts, goals, checkins, challenges, participants,
  relationships, gymSharing, gyms, now = () => new Date(),
}) {
  function period(query = {}) {
    const today = localDay(now());
    const to = query.to ?? today;
    const from = query.from ?? addDays(to, -(DEFAULT_DAYS - 1));
    if (!DAY_RE.test(from) || !DAY_RE.test(to)) return { error: 'invalid_date' };
    if (from > to) return { error: 'invalid_range' };
    if (to > today) return { error: 'future_range' };
    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
    if (days.length > MAX_DAYS) return { error: 'range_too_long' };
    return { from, to, days, today };
  }

  async function overview(query = {}) {
    const p = period(query);
    if (p.error) return { error: p.error, status: 400 };
    const { from, to, days, today } = p;
    // End of the window as an instant: local midnight after `to`.
    const endInstant = new Date(Date.parse(`${addDays(to, 1)}T00:00:00+03:00`) - 1);

    const [allUsers, acts, wos, gls, ins, chs, parts, rels, shares, gymRows] = await Promise.all([
      users.filterByColumnAsync('userType', 'member'),
      activities.allAsync(), workouts.allAsync(), goals.allAsync(),
      checkins.allAsync(), challenges.allAsync(), participants.allAsync(),
      relationships.allAsync(), gymSharing.allAsync(), gyms.allAsync(),
    ]);
    const members = allUsers.filter(u => !u.createdAt || localDay(u.createdAt) <= to);
    const memberIds = new Set(members.map(m => m.id));
    const mine = rows => rows.filter(r => memberIds.has(r.userId ?? r.memberId));

    const actsIn = mine(acts).filter(a => inDays(localDay(a.startedAt), from, to));
    const insIn = mine(ins).filter(c => inDays(localDay(c.timestamp), from, to));
    const completedIn = mine(wos).filter(w => w.completedAt && inDays(localDay(w.completedAt), from, to));

    // ── Daily active members ────────────────────────────────────────────
    const activeOn = new Map(days.map(d => [d, new Set()]));
    const mark = (day, id) => activeOn.get(day)?.add(id);
    for (const a of actsIn) mark(localDay(a.startedAt), a.userId);
    for (const w of completedIn) mark(localDay(w.completedAt), w.userId);
    for (const c of insIn) mark(localDay(c.timestamp), c.memberId);
    const activeAny = new Set();
    for (const s of activeOn.values()) for (const id of s) activeAny.add(id);
    const series = days.map(d => ({ day: d, members: activeOn.get(d).size }));
    const avgDaily = series.reduce((n, s) => n + s.members, 0) / days.length;
    const last7 = new Set();
    for (const d of days.slice(-7)) for (const id of activeOn.get(d)) last7.add(id);

    const dailyActive = {
      series,
      averageDaily: Math.round(avgDaily * 10) / 10,
      activeInPeriod: activeAny.size,
      activeLast7Days: last7.size,
      // Average daily actives ÷ actives over the whole period.
      stickiness: rate(avgDaily, activeAny.size),
    };

    // ── Activity logging ────────────────────────────────────────────────
    const byOrigin = { device: 0, fitflex: 0, manual: 0 };
    for (const a of actsIn) byOrigin[originOf(a)] += 1;
    const loggers = new Set(actsIn.map(a => a.userId));
    const activityLogging = {
      activities: actsIn.length,
      membersLogging: loggers.size,
      loggingRate: rate(loggers.size, members.length),
      perLoggingMember: loggers.size ? Math.round((actsIn.length / loggers.size) * 10) / 10 : null,
      byOrigin,
    };

    // ── Workout completion ──────────────────────────────────────────────
    // Workouts scheduled in the window whose day has passed (today's may
    // still happen).
    const due = mine(wos).filter(w => inDays(w.scheduledDate, from, to) && w.scheduledDate < today);
    const tally = list => {
      const completed = list.filter(w => w.status === 'completed').length;
      const skipped = list.filter(w => w.status === 'skipped').length;
      return { due: list.length, completed, skipped, missed: list.length - completed - skipped, completionRate: rate(completed, list.length) };
    };
    const workoutStats = {
      ...tally(due),
      trainerAssigned: tally(due.filter(w => w.trainerId)),
      selfPlanned: tally(due.filter(w => !w.trainerId)),
      completedInPeriod: completedIn.length,
    };

    // ── Challenge participation ─────────────────────────────────────────
    const live = chs.filter(c => c.status !== 'cancelled' && c.startDate <= to && c.endDate >= from);
    const liveIds = new Set(live.map(c => c.id));
    // Taking part at some point in the window: joined by its end, and not
    // left before it began.
    const joined = parts.filter(x =>
      liveIds.has(x.challengeId) && memberIds.has(x.memberId) &&
      (!x.joinedAt || localDay(x.joinedAt) <= to) &&
      (x.status === 'joined' || (x.leftAt && localDay(x.leftAt) >= from)));
    const joinedMembers = new Set(joined.map(x => x.memberId));
    // Finished inside the window: did each participant reach the target?
    const actsBy = groupBy(mine(acts), a => a.userId);
    const insBy = groupBy(mine(ins), c => c.memberId);
    let finishedEntries = 0, finishedReached = 0;
    for (const c of live.filter(c => c.endDate < today && c.endDate <= to)) {
      for (const x of joined.filter(x => x.challengeId === c.id)) {
        finishedEntries += 1;
        const gymId = c.creatorType === 'gym' ? c.creatorId : null;
        const progress = challengeProgress(c, actsBy.get(x.memberId) ?? [], insBy.get(x.memberId) ?? [], gymId);
        if (progress >= Number(c.target)) finishedReached += 1;
      }
    }
    const challengeStats = {
      running: live.length,
      byCreator: countBy(live, c => c.creatorType),
      joinsInPeriod: joined.filter(x => x.joinedAt && inDays(localDay(x.joinedAt), from, to)).length,
      participants: joinedMembers.size,
      participationRate: rate(joinedMembers.size, members.length),
      finishedEntries,
      completionRate: rate(finishedReached, finishedEntries),
      leaderboardOptInRate: rate(joined.filter(x => x.leaderboardOptIn === true).length, joined.length),
    };

    // ── Streak retention ────────────────────────────────────────────────
    // Activity streaks (a workout or 30+ active minutes a day), as the app
    // counts them.
    const startInstant = new Date(Date.parse(`${from}T00:00:00+03:00`) - 1);
    const distribution = STREAK_BUCKETS.map(([lo, hi]) => ({ from: lo, to: Number.isFinite(hi) ? hi : null, members: 0 }));
    let onStreakAtStart = 0, keptThrough = 0;
    for (const id of activeAny) {
      const history = actsBy.get(id) ?? [];
      const end = streaks(history, [], endInstant).activity.current;
      distribution.find(b => end >= b.from && (b.to == null || end <= b.to)).members += 1;
      const start = streaks(history, [], startInstant).activity.current;
      if (start >= 3) {
        onStreakAtStart += 1;
        // Every day of the window counted (today may still be in progress).
        const need = start + days.length - (to === today ? 1 : 0);
        if (end >= need) keptThrough += 1;
      }
    }
    // Of members active in one week, how many were active the next.
    const weeks = [];
    for (let w = weekStart(from); addDays(w, 13) <= to; w = addDays(w, 7)) {
      if (w < from) continue;
      const a = activeIn(activeOn, w, addDays(w, 6));
      const b = activeIn(activeOn, addDays(w, 7), addDays(w, 13));
      const kept = [...a].filter(id => b.has(id)).length;
      weeks.push({ week: w, active: a.size, activeNextWeek: kept, retention: rate(kept, a.size) });
    }
    const streakStats = {
      distributionAtEnd: distribution,
      onStreakAtStart,
      unbrokenThroughPeriod: keptThrough,
      streakRetention: rate(keptThrough, onStreakAtStart),
      weeklyRetention: weeks,
    };

    // ── Goal completion ─────────────────────────────────────────────────
    // Each whole goal period that ended inside the window, before today.
    const goalRows = mine(gls).filter(g => g.status !== 'archived');
    const byType = {}, byPeriod = {};
    let evaluated = 0, met = 0;
    const add = (g, ok) => {
      evaluated += 1; if (ok) met += 1;
      for (const [map, key] of [[byType, g.type], [byPeriod, g.period]]) {
        const t = (map[key] ??= { evaluated: 0, met: 0 });
        t.evaluated += 1; if (ok) t.met += 1;
      }
    };
    for (const g of goalRows) {
      const history = actsBy.get(g.userId) ?? [];
      for (const end of periodEnds(g, from, to, today)) {
        const at = new Date(Date.parse(`${end}T12:00:00+03:00`));
        add(g, goalProgress(g, history, at).completed);
      }
    }
    for (const m of [byType, byPeriod]) for (const t of Object.values(m)) t.completionRate = rate(t.met, t.evaluated);
    const goalStats = {
      membersWithGoals: new Set(goalRows.map(g => g.userId)).size,
      periodsEvaluated: evaluated,
      periodsMet: met,
      completionRate: rate(met, evaluated),
      byType, byPeriod,
    };

    // ── Trainer engagement ──────────────────────────────────────────────
    const myRels = rels.filter(r => memberIds.has(r.memberId));
    const activeRels = myRels.filter(r => r.status === 'active');
    const requested = myRels.filter(r => r.requestedAt && inDays(localDay(r.requestedAt), from, to));
    const accepted = requested.filter(r => r.connectedAt && r.status !== 'pending').length;
    const declined = requested.filter(r => r.status === 'declined').length;
    const assigned = mine(wos).filter(w => w.trainerId && w.createdAt && inDays(localDay(w.createdAt), from, to));
    const trainerStats = {
      activeConnections: activeRels.length,
      trainersWithClients: new Set(activeRels.map(r => r.trainerId)).size,
      requests: requested.length,
      accepted, declined,
      pending: requested.filter(r => r.status === 'pending').length,
      acceptanceRate: rate(accepted, accepted + declined),
      clientsSharingData: activeRels.filter(r => anyTrue(r.permissions)).length,
      workoutsAssigned: assigned.length,
      trainersAssigning: new Set(assigned.map(w => w.trainerId)).size,
      assignedCompletionRate: workoutStats.trainerAssigned.completionRate,
    };

    // ── Gym engagement ──────────────────────────────────────────────────
    const gymName = new Map(gymRows.map(g => [g.id, g.name]));
    const perGym = new Map();
    for (const c of insIn) {
      const g = perGym.get(c.gymId) ?? { gymId: c.gymId, name: gymName.get(c.gymId) ?? null, checkins: 0, members: new Set() };
      g.checkins += 1; g.members.add(c.memberId);
      perGym.set(c.gymId, g);
    }
    const visitors = new Set(insIn.map(c => c.memberId));
    const gymChallenges = live.filter(c => c.creatorType === 'gym');
    const gymChallengeIds = new Set(gymChallenges.map(c => c.id));
    const gymStats = {
      checkins: insIn.length,
      membersVisiting: visitors.size,
      visitRate: rate(visitors.size, members.length),
      visitsPerVisitingMember: visitors.size ? Math.round((insIn.length / visitors.size) * 10) / 10 : null,
      gymsVisited: perGym.size,
      topGyms: [...perGym.values()]
        .map(g => ({ gymId: g.gymId, name: g.name, checkins: g.checkins, members: g.members.size }))
        .sort((a, b) => b.checkins - a.checkins || b.members - a.members)
        .slice(0, 10),
      gymChallenges: gymChallenges.length,
      gymChallengeParticipants: new Set(joined.filter(x => gymChallengeIds.has(x.challengeId)).map(x => x.memberId)).size,
      membersSharingWithGyms: new Set(shares.filter(s => memberIds.has(s.memberId) && anyTrue(s.permissions)).map(s => s.memberId)).size,
    };

    return {
      period: { from, to, days: days.length },
      generatedAt: now().toISOString(),
      members: members.length,
      dailyActive,
      activityLogging,
      workouts: workoutStats,
      challenges: challengeStats,
      streaks: streakStats,
      goals: goalStats,
      trainers: trainerStats,
      gyms: gymStats,
    };
  }

  return { overview, period };
}

function groupBy(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const k = key(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

function countBy(rows, key) {
  const out = {};
  for (const r of rows) { const k = key(r) ?? 'unknown'; out[k] = (out[k] ?? 0) + 1; }
  return out;
}

function activeIn(activeOn, from, to) {
  const s = new Set();
  for (let d = from; d <= to; d = addDays(d, 1)) for (const id of activeOn.get(d) ?? []) s.add(id);
  return s;
}

/**
 * Last days of a goal's whole periods that end inside [from, to], before
 * today, and start on or after the goal did.
 */
export function periodEnds(goal, from, to, today) {
  const out = [];
  const ok = (start, end) => start >= goal.startDate && end >= from && end <= to && end < today;
  switch (goal.period) {
    case 'day':
      for (let d = from; d <= to; d = addDays(d, 1)) if (ok(d, d)) out.push(d);
      break;
    case 'week':
      for (let s = weekStart(from); s <= to; s = addDays(s, 7)) if (ok(s, addDays(s, 6))) out.push(addDays(s, 6));
      break;
    case 'month': {
      let s = `${from.slice(0, 7)}-01`;
      while (s <= to) {
        const [y, m] = s.split('-').map(Number);
        const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
        if (ok(s, addDays(next, -1))) out.push(addDays(next, -1));
        s = next;
      }
      break;
    }
    default:
      if (goal.endDate && ok(goal.startDate, goal.endDate)) out.push(goal.endDate);
  }
  return out;
}
