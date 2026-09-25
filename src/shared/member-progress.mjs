// Server-side progress for views where the viewer may not see raw activity
// (a trainer with `goals` or `streaks` permission but not `steps`). Mirrors
// the app's rules in fitflex-mobile lib/shared/activity/{activity_summary,
// progress_engine,streaks}.dart — keep the two in step.
//
// Days are the member's local calendar days. FitFlex members are in East
// Africa Time (UTC+3, no daylight saving), so that offset is fixed here.

export const MEMBER_UTC_OFFSET_MINUTES = 180;
export const STREAK_MIN_ACTIVE_MINUTES = 30;
export const WORKOUT_STREAK_PER_WEEK = 2;

const DAY_MS = 86_400_000;

/** Local calendar day ("YYYY-MM-DD") of an instant. */
export function localDay(ts) {
  return new Date(+new Date(ts) + MEMBER_UTC_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
}

export function addDays(day, n) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from local day `a` to local day `b` ("YYYY-MM-DD"). */
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/** Monday of the week containing `day`. */
export function weekStart(day) {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(day, -((dow + 6) % 7));
}

/** Passive device step counts are background movement, not workouts. */
export function isWorkout(a) {
  return !(a.type === 'walking' && a.source === 'device');
}

export function activeMinutesOf(a) {
  return a.activeMinutes ?? a.durationMinutes ?? 0;
}

/** Per-day totals keyed by local day. */
export function dailyTotals(activities) {
  const days = new Map();
  for (const a of activities) {
    const d = localDay(a.startedAt);
    const t = days.get(d) ?? { steps: 0, distanceKm: 0, activeMinutes: 0, workouts: 0 };
    t.steps += a.steps ?? 0;
    t.distanceKm += a.distanceKm ?? 0;
    t.activeMinutes += activeMinutesOf(a);
    if (isWorkout(a)) t.workouts += 1;
    days.set(d, t);
  }
  return days;
}

/**
 * A goal's progress over [fromDay, toDayExclusive): measured from activity,
 * or, for a coaching goal (`custom`), the times the member marked it done.
 */
function measureGoal(goal, activities, fromDay, toDayExclusive) {
  if (goal.type === 'custom') {
    return (goal.completions ?? [])
      .map(localDay)
      .filter(d => d >= fromDay && d < toDayExclusive).length;
  }
  return measure(goal.type, activities, fromDay, toDayExclusive);
}

function measure(type, activities, fromDay, toDayExclusive) {
  let total = 0;
  for (const a of activities) {
    const d = localDay(a.startedAt);
    if (d < fromDay || d >= toDayExclusive) continue;
    if (type === 'steps') total += a.steps ?? 0;
    else if (type === 'workouts') total += isWorkout(a) ? 1 : 0;
    else if (type === 'active_minutes') total += activeMinutesOf(a);
    else if (type === 'distance_km') total += a.distanceKm ?? 0;
  }
  return total;
}

/** The goal's period containing `now`, as [start, end) local days. */
export function goalWindow(goal, now) {
  const today = localDay(now);
  switch (goal.period) {
    case 'day': return [today, addDays(today, 1)];
    case 'week': { const s = weekStart(today); return [s, addDays(s, 7)]; }
    case 'month': {
      const s = `${today.slice(0, 7)}-01`;
      const [y, m] = s.split('-').map(Number);
      const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
      return [s, next];
    }
    default: return [goal.startDate, addDays(goal.endDate ?? goal.startDate, 1)];
  }
}

export function goalProgress(goal, activities, now = new Date()) {
  const [from, to] = goalWindow(goal, now);
  const current = measureGoal(goal, activities, from, to);
  return { current, target: goal.target, completed: current >= goal.target, periodStart: from, periodEnd: addDays(to, -1) };
}

/**
 * Consecutive qualifying periods ending now; the period in progress never
 * breaks a streak. `step` is 1 (days) or 7 (weeks); `first` the current
 * period's start day; `floor` the earliest period considered.
 */
function run({ first, step, floor, qualifies }) {
  const back = n => addDays(first, -step * n);
  const from = start => {
    let n = 0;
    while (back(start + n) >= floor && qualifies(back(start + n))) n += 1;
    return n;
  };
  const current = qualifies(first) ? from(0) : from(1);
  let best = 0, streak = 0;
  for (let n = 0; back(n) >= floor; n += 1) {
    streak = qualifies(back(n)) ? streak + 1 : 0;
    best = Math.max(best, streak);
  }
  return { current, best, endedLength: current === 0 && from(2) > 0 ? from(2) : null };
}

export function streaks(activities, goals = [], now = new Date(), historyDays = 91) {
  const today = localDay(now);
  const floor = addDays(today, -(historyDays - 1));
  const days = dailyTotals(activities);
  const weekly = new Map();
  for (const [d, t] of days) weekly.set(weekStart(d), (weekly.get(weekStart(d)) ?? 0) + t.workouts);

  const out = {
    activity: {
      unit: 'day',
      ...run({
        first: today, step: 1, floor,
        qualifies: d => { const t = days.get(d); return !!t && (t.workouts > 0 || t.activeMinutes >= STREAK_MIN_ACTIVE_MINUTES); },
      }),
    },
    workout: {
      unit: 'week',
      ...run({ first: weekStart(today), step: 7, floor: weekStart(floor), qualifies: w => (weekly.get(w) ?? 0) >= WORKOUT_STREAK_PER_WEEK }),
    },
    goal: null,
  };
  const daily = goals.filter(g => g.period === 'day' && g.status === 'active');
  if (daily.length) {
    out.goal = {
      unit: 'day',
      ...run({
        first: today, step: 1, floor,
        qualifies: d => {
          const live = daily.filter(g => g.startDate <= d);
          return live.length > 0 && live.every(g => measureGoal(g, activities, d, addDays(d, 1)) >= g.target);
        },
      }),
    };
  }
  return out;
}

/**
 * Progress on a challenge over its dates (inclusive local days). Mirrors
 * the app's lib/shared/activity/challenge.dart.
 *  steps / distance_km / active_minutes — totals
 *  workouts        — workouts done
 *  consistency     — active days (a workout, or 30+ active minutes)
 *  gym_attendance  — distinct days with a gym check-in (only at `gymId`
 *                    when the challenge belongs to a gym)
 */
export function challengeProgress(challenge, activities, checkins = [], gymId = null) {
  const from = challenge.startDate;
  const to = challenge.endDate;
  const inRange = d => d >= from && d <= to;
  const acts = activities.filter(a => inRange(localDay(a.startedAt)));
  switch (challenge.type) {
    case 'steps': return acts.reduce((n, a) => n + (a.steps ?? 0), 0);
    case 'distance_km': return Math.round(acts.reduce((n, a) => n + (a.distanceKm ?? 0), 0) * 100) / 100;
    case 'active_minutes': return acts.reduce((n, a) => n + activeMinutesOf(a), 0);
    case 'workouts': return acts.filter(isWorkout).length;
    case 'consistency': {
      let n = 0;
      for (const t of dailyTotals(acts).values()) {
        if (t.workouts > 0 || t.activeMinutes >= STREAK_MIN_ACTIVE_MINUTES) n += 1;
      }
      return n;
    }
    case 'gym_attendance':
      return new Set(checkins
        .filter(c => !gymId || c.gymId === gymId)
        .map(c => localDay(c.timestamp))
        .filter(inRange)).size;
    default: return 0;
  }
}
