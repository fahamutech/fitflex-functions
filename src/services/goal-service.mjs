// Activity & Progress Engine — member goals. Only the goal definition is
// stored; progress is derived from Activity rows by the client progress
// engine, so it can never drift from the underlying activity.
import { randomUUID } from 'node:crypto';

export const GOAL_TYPES = ['steps', 'workouts', 'active_minutes', 'distance_km'];
export const GOAL_PERIODS = ['day', 'week', 'month', 'custom'];
export const GOAL_SOURCES = ['member', 'default', 'trainer', 'challenge'];
const MEMBER_STATUSES = ['active', 'paused', 'archived'];

// Upper bound per period-day — a per-day cap scaled by period length keeps
// e.g. "2,000,000 steps a day" out while allowing ambitious monthly targets.
const DAILY_CAP = { steps: 100_000, workouts: 5, active_minutes: 720, distance_km: 200 };
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

export function createGoalService({ goals, now = () => new Date() }) {
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
        status: 'active',
        createdAt: stamp,
        updatedAt: stamp,
      }));
      for (const row of rows) await goals.insertAsync(row);
    }
    return {
      goals: rows
        .filter(g => g.status !== 'archived')
        .sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt)),
    };
  }

  async function create(memberId, body = {}) {
    const { type, period } = body;
    if (!GOAL_TYPES.includes(type)) return { error: 'invalid_type', status: 400 };
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
    const existing = await goals.filterByColumnAsync('userId', memberId);
    if (existing.filter(g => g.status === 'active').length >= MAX_ACTIVE_GOALS) {
      return { error: 'too_many_goals', status: 400 };
    }
    const stamp = now().toISOString();
    const row = {
      id: `goal_${randomUUID().slice(0, 12)}`,
      userId: memberId,
      type,
      period,
      target: body.target,
      startDate,
      endDate,
      source: 'member',
      trainerId: null,
      challengeId: null,
      status: 'active',
      createdAt: stamp,
      updatedAt: stamp,
    };
    await goals.insertAsync(row);
    return { goal: row };
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

  return { list, create, update };
}
