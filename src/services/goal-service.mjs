// Activity & Progress Engine — member goals. Only the goal definition is
// stored; progress is derived from Activity rows by the client progress
// engine, so it can never drift from the underlying activity.
import { randomUUID } from 'node:crypto';

// Measured from activity. A coaching goal (`custom`) is counted from the
// times the member marks it done; only trainers set those.
export const MEASURED_GOAL_TYPES = ['steps', 'workouts', 'active_minutes', 'distance_km'];
export const GOAL_TYPES = [...MEASURED_GOAL_TYPES, 'custom'];
export const GOAL_CREATOR_TYPES = ['member', 'trainer', 'system'];
const MAX_TITLE = 120;
const MAX_COMPLETIONS = 400;
export const GOAL_PERIODS = ['day', 'week', 'month', 'custom'];
export const GOAL_SOURCES = ['member', 'default', 'trainer', 'challenge'];
const MEMBER_STATUSES = ['active', 'paused', 'archived'];

// Upper bound per period-day — a per-day cap scaled by period length keeps
// e.g. "2,000,000 steps a day" out while allowing ambitious monthly targets.
const DAILY_CAP = { steps: 100_000, workouts: 5, active_minutes: 720, distance_km: 200, custom: 10 };
const PERIOD_DAYS = { day: 1, week: 7, month: 31 };
const MAX_ACTIVE_GOALS = 20;
const MAX_CUSTOM_DAYS = 366;

// Seeded once for members who have never had a goal, so progress screens
// have something meaningful to show from day one.
export const DEFAULT_GOALS = [
  { type: 'steps', period: 'day', target: 8000 },
  { type: 'workouts', period: 'week', target: 3 },
  { type: 'active_minutes', period: 'week', target: 150 },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isDate(s) {
  return typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(+new Date(`${s}T00:00:00Z`));
}
function daysBetween(a, b) {
  return Math.round((+new Date(`${b}T00:00:00Z`) - +new Date(`${a}T00:00:00Z`)) / 86_400_000);
}
function today(now) {
  return now().toISOString().slice(0, 10);
}

function validTarget(type, period, target, startDate, endDate) {
  if (typeof target !== 'number' || !Number.isFinite(target) || target <= 0) return false;
  const days = period === 'custom' ? daysBetween(startDate, endDate) + 1 : PERIOD_DAYS[period];
  return target <= DAILY_CAP[type] * days;
}

/**
 * Validates a goal definition (type, period, dates, target, title) the way
 * member and trainer creation share. `types` limits which types the caller
 * may set. Returns `{ definition }` or `{ error, status }`.
 */
export function validateGoalDefinition(body = {}, { now = () => new Date(), types = MEASURED_GOAL_TYPES } = {}) {
  const { type, period } = body;
  if (!types.includes(type)) return { error: 'invalid_type', status: 400 };
  if (!GOAL_PERIODS.includes(period)) return { error: 'invalid_period', status: 400 };
  const startDate = body.startDate ?? today(now);
  if (!isDate(startDate)) return { error: 'invalid_start_date', status: 400 };
  let endDate = null;
  if (period === 'custom') {
    if (!isDate(body.endDate)) return { error: 'invalid_end_date', status: 400 };
    const span = daysBetween(startDate, body.endDate);
    if (span < 0 || span >= MAX_CUSTOM_DAYS) return { error: 'invalid_end_date', status: 400 };
    endDate = body.endDate;
  }
  if (!validTarget(type, period, body.target, startDate, endDate)) {
    return { error: 'invalid_target', status: 400 };
  }
  if (type === 'custom' && !Number.isInteger(body.target)) return { error: 'invalid_target', status: 400 };
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, MAX_TITLE) : '';
  if (type === 'custom' && !title) return { error: 'title_required', status: 400 };
  return { definition: { type, period, target: body.target, startDate, endDate, title: title || null } };
}

/** The goal period containing `at`, as [start, end) days (see member-progress). */
function currentWindow(goal, at) {
  const d = at.toISOString().slice(0, 10);
  if (goal.period === 'custom') return [goal.startDate, daysAfter(goal.endDate, 1)];
  if (goal.period === 'day') return [d, daysAfter(d, 1)];
  if (goal.period === 'week') {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    const s = daysAfter(d, -((dow + 6) % 7));
    return [s, daysAfter(s, 7)];
  }
  const s = `${d.slice(0, 7)}-01`;
  const [y, m] = s.split('-').map(Number);
  return [s, new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10)];
}
function daysAfter(day, n) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export function createGoalService({ goals, trainers = null, now = () => new Date() }) {
  // Member-local (EAT) "now" for period maths, as member-progress uses.
  const localNow = () => new Date(+now() + 180 * 60_000);

  async function withCreators(rows) {
    const names = new Map();
    for (const g of rows) {
      if (g.source === 'trainer' && g.trainerId && trainers && !names.has(g.trainerId)) {
        const t = await trainers.findByIdAsync(g.trainerId);
        names.set(g.trainerId, t?.displayName ?? null);
      }
    }
    return rows.map(g => ({
      ...g,
      createdByType: g.createdByType ?? (g.source === 'member' ? 'member' : g.source === 'trainer' ? 'trainer' : 'system'),
      createdBy: g.source === 'trainer'
        ? { type: 'trainer', id: g.trainerId, name: names.get(g.trainerId) ?? null }
        : { type: g.source === 'member' ? 'member' : 'system' },
    }));
  }

  async function list(memberId) {
    let rows = await goals.filterByColumnAsync('userId', memberId);
    if (!rows.length) {
      const stamp = now().toISOString();
      rows = DEFAULT_GOALS.map(g => ({
        id: `goal_${randomUUID().slice(0, 12)}`,
        userId: memberId,
        ...g,
        startDate: today(now),
        endDate: null,
        source: 'default',
        trainerId: null,
        challengeId: null,
        createdByType: 'system',
        createdById: null,
        title: null,
        completions: null,
        status: 'active',
        createdAt: stamp,
        updatedAt: stamp,
      }));
      for (const row of rows) await goals.insertAsync(row);
    }
    return {
      goals: await withCreators(rows
        .filter(g => g.status !== 'archived')
        .sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt))),
    };
  }

  async function create(memberId, body = {}) {
    const def = validateGoalDefinition(body, { now });
    if (def.error) return def;
    const existing = await goals.filterByColumnAsync('userId', memberId);
    if (existing.filter(g => g.status === 'active').length >= MAX_ACTIVE_GOALS) {
      return { error: 'too_many_goals', status: 400 };
    }
    const stamp = now().toISOString();
    const row = {
      id: `goal_${randomUUID().slice(0, 12)}`,
      userId: memberId,
      ...def.definition,
      source: 'member',
      trainerId: null,
      challengeId: null,
      createdByType: 'member',
      createdById: memberId,
      completions: null,
      status: 'active',
      createdAt: stamp,
      updatedAt: stamp,
    };
    await goals.insertAsync(row);
    return { goal: row };
  }

  /** Marks a coaching goal done now (once per tap, up to the period's target). */
  async function checkIn(memberId, id) {
    const goal = await goals.findByIdAsync(id);
    if (!goal || goal.userId !== memberId) return { error: 'not_found', status: 404 };
    if (goal.type !== 'custom') return { error: 'not_a_coaching_goal', status: 400 };
    if (goal.status !== 'active') return { error: 'goal_not_active', status: 409 };
    const [from, to] = currentWindow(goal, localNow());
    const today = localNow().toISOString().slice(0, 10);
    if (today < from || today >= to) return { error: 'outside_goal_dates', status: 409 };
    const all = goal.completions ?? [];
    const inWindow = all.filter(c => {
      const d = new Date(+new Date(c) + 180 * 60_000).toISOString().slice(0, 10);
      return d >= from && d < to;
    });
    if (inWindow.length >= goal.target) return { error: 'already_complete', status: 409 };
    const completions = [...all, now().toISOString()].slice(-MAX_COMPLETIONS);
    const updated = await goals.updateByIdAsync(id, { completions, updatedAt: now().toISOString() });
    return { goal: updated ?? { ...goal, completions } };
  }

  /** Undoes the latest "done" in the current period. */
  async function undoCheckIn(memberId, id) {
    const goal = await goals.findByIdAsync(id);
    if (!goal || goal.userId !== memberId) return { error: 'not_found', status: 404 };
    if (goal.type !== 'custom') return { error: 'not_a_coaching_goal', status: 400 };
    const [from, to] = currentWindow(goal, localNow());
    const all = [...(goal.completions ?? [])];
    for (let i = all.length - 1; i >= 0; i -= 1) {
      const d = new Date(+new Date(all[i]) + 180 * 60_000).toISOString().slice(0, 10);
      if (d >= from && d < to) {
        all.splice(i, 1);
        const updated = await goals.updateByIdAsync(id, { completions: all, updatedAt: now().toISOString() });
        return { goal: updated ?? { ...goal, completions: all } };
      }
    }
    return { error: 'nothing_to_undo', status: 409 };
  }

  // Members control every goal on their list: they can pause or archive any
  // of them, but only retarget goals they (or the defaults) set — a trainer's
  // or challenge's target isn't theirs to change.
  async function update(memberId, id, body = {}) {
    const goal = await goals.findByIdAsync(id);
    if (!goal || goal.userId !== memberId) return { error: 'not_found', status: 404 };
    const patch = {};
    if (body.status !== undefined) {
      if (!MEMBER_STATUSES.includes(body.status)) return { error: 'invalid_status', status: 400 };
      patch.status = body.status;
    }
    if (body.target !== undefined) {
      if (goal.source === 'trainer' || goal.source === 'challenge') {
        return { error: 'target_locked', status: 403 };
      }
      if (!validTarget(goal.type, goal.period, body.target, goal.startDate, goal.endDate)) {
        return { error: 'invalid_target', status: 400 };
      }
      patch.target = body.target;
    }
    if (!Object.keys(patch).length) return { error: 'nothing_to_update', status: 400 };
    patch.updatedAt = now().toISOString();
    const updated = await goals.updateByIdAsync(id, patch);
    return { goal: updated ?? { ...goal, ...patch } };
  }

  return { list, create, update, checkIn, undoCheckIn };
}
