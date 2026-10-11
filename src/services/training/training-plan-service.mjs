// Training Plans — a member's plan: made by the recommendation engine,
// stored as one TrainingPlan row plus an ordinary Workout per session.
//
// The plan keeps the outline (which day trains what); the workouts hold
// the exercises and are run, logged and completed by the workout engine
// like any other. So what the member actually did is still their
// Activity, and goals, streaks and challenges need nothing new.
import { randomUUID } from 'node:crypto';
import { localDay } from '../../shared/member-progress.mjs';
import { newWorkoutRow } from '../workout-service.mjs';
import { validateTrainingPreferences } from './training-preference-service.mjs';
import { buildRecommendationInput, DEFAULT_PLAN_WEEKS, MAX_PLAN_WEEKS } from './recommendation-engine.mjs';
import { addPlanDays, planWeekday } from './rules-recommendation-provider.mjs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_START_AHEAD_DAYS = 30;
// How far back the engine looks at what the member did and skipped.
const HISTORY_WORKOUTS = 60;

/** The date in plan week `week` (1-based, from `startDate`) that falls on weekday `day`. */
export function planDate(startDate, week, day) {
  const weekStart = addPlanDays(startDate, (week - 1) * 7);
  for (let i = 0; i < 7; i += 1) {
    const d = addPlanDays(weekStart, i);
    if (planWeekday(d) === day) return d;
  }
  return weekStart;
}

/** Exercises the member has completed and skipped recently, by library id. */
export function exerciseHistory(workoutRows) {
  const completed = new Set();
  const skipped = new Set();
  const recent = workoutRows
    .filter(w => w.status === 'completed')
    .sort((a, b) => String(b.scheduledDate).localeCompare(String(a.scheduledDate)))
    .slice(0, HISTORY_WORKOUTS);
  for (const w of recent) {
    for (const e of w.exercises ?? []) {
      if (!e.libraryId) continue;
      // In a finished workout, an exercise with no set done was passed over.
      if ((e.workoutSets ?? []).some(s => s.completed)) completed.add(e.libraryId);
      else skipped.add(e.libraryId);
    }
  }
  for (const id of completed) skipped.delete(id);
  return { completedExerciseIds: [...completed], skippedExerciseIds: [...skipped], feedback: [] };
}

export function createTrainingPlanService({ plans, workouts, users, engine, now = () => new Date() }) {
  const today = () => localDay(now());

  async function sessionsOf(plan) {
    return (await workouts.filterByColumnAsync('userId', plan.userId)).filter(w => w.trainingPlanId === plan.id);
  }

  /** The plan with its sessions' current state and where the member stands. */
  async function view(plan) {
    const rows = await sessionsOf(plan);
    const byId = new Map(rows.map(w => [w.id, w]));
    const day = today();
    const weeks = plan.weeks.map(w => ({
      week: w.week,
      days: w.days.map(d => {
        const workout = byId.get(d.workoutId);
        return {
          ...d,
          // A session the member removed or that was cleared away.
          workoutId: workout ? d.workoutId : null,
          name: workout?.name ?? d.name ?? null,
          status: workout?.status ?? 'removed',
          estimatedDuration: workout?.estimatedDuration ?? null,
          exerciseCount: workout?.exercises?.length ?? 0,
        };
      }),
    }));
    const all = weeks.flatMap(w => w.days).filter(d => d.status !== 'removed');
    const open = all.filter(d => d.status === 'planned' || d.status === 'in_progress');
    const completed = all.filter(d => d.status === 'completed').length;
    const todays = open.find(d => d.date === day) ?? null;
    const next = open.filter(d => d.date > day).sort((a, b) => a.date.localeCompare(b.date))[0] ?? null;
    const week = Math.min(Math.max(Math.floor((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${plan.startDate}T00:00:00Z`)) / (7 * 86_400_000)) + 1, 1), plan.durationWeeks);
    return {
      ...plan,
      weeks,
      progress: {
        sessions: all.length,
        completed,
        skipped: all.filter(d => d.status === 'skipped').length,
        // Open sessions whose day has passed: not done, not skipped.
        missed: open.filter(d => d.date < day).length,
        completionRate: all.length ? Math.round((completed / all.length) * 100) / 100 : 0,
        currentWeek: week,
      },
      today: todays,
      next,
    };
  }

  /** Marks a plan finished once its last day has passed. */
  async function settle(plan) {
    if (plan.status !== 'active' || plan.endDate >= today()) return plan;
    const patch = { status: 'completed', updatedAt: now().toISOString() };
    await plans.updateByIdAsync(plan.id, patch);
    return { ...plan, ...patch };
  }

  async function activePlan(memberId) {
    const rows = (await plans.filterByColumnAsync('userId', memberId)).filter(p => p.status === 'active');
    for (const p of rows) {
      const settled = await settle(p);
      if (settled.status === 'active') return settled;
    }
    return null;
  }

  /** Ends a plan and clears away the sessions that were never started. */
  async function end(plan, status) {
    for (const w of await sessionsOf(plan)) {
      if (w.status === 'planned') await workouts.removeByIdAsync(w.id);
    }
    const patch = { status, updatedAt: now().toISOString() };
    await plans.updateByIdAsync(plan.id, patch);
    return { ...plan, ...patch };
  }

  /**
   * Make a plan for the member. Body (all optional): `preferences` to use
   * for this plan only, `durationWeeks`, `startDate`, `replace` (end the
   * plan they are on).
   */
  async function generate(memberId, body = {}) {
    const user = await users.findByIdAsync(memberId);
    if (!user) return { error: 'not_found', status: 404 };

    const durationWeeks = body.durationWeeks ?? DEFAULT_PLAN_WEEKS;
    if (!Number.isInteger(durationWeeks) || durationWeeks < 1 || durationWeeks > MAX_PLAN_WEEKS) {
      return { error: 'invalid_duration_weeks', status: 400 };
    }
    const startDate = body.startDate ?? today();
    if (!DATE_RE.test(startDate) || Number.isNaN(Date.parse(`${startDate}T00:00:00Z`))) return { error: 'invalid_start_date', status: 400 };
    if (startDate < today()) return { error: 'start_in_past', status: 400 };
    if (startDate > addPlanDays(today(), MAX_START_AHEAD_DAYS)) return { error: 'start_too_far', status: 400 };

    let preferences = user.memberProfile?.trainingPreferences;
    if (body.preferences != null) {
      const v = validateTrainingPreferences(body.preferences);
      if (v.error) return v;
      preferences = { ...(preferences || {}), ...v.patch };
    }

    const current = await activePlan(memberId);
    if (current && body.replace !== true) return { error: 'active_plan_exists', status: 409, planId: current.id };

    const mine = await workouts.filterByColumnAsync('userId', memberId);
    const input = buildRecommendationInput({
      profile: user.memberProfile ?? {}, preferences, durationWeeks, startDate, history: exerciseHistory(mine),
    });
    const result = await engine.recommend(input);
    if (result.error) return result;
    const { draft, provider } = result;

    if (current) await end(current, 'cancelled');

    const stamp = now();
    const planId = `tpn_${randomUUID().slice(0, 12)}`;
    const rows = [];
    const weeks = draft.weeks.map(w => ({
      week: w.week,
      days: w.days.filter(d => d.workout).map(d => {
        const date = planDate(startDate, w.week, d.day);
        const row = newWorkoutRow({
          memberId, base: { id: null, ...d.workout }, scheduledDate: date, trainingPlanId: planId, source: 'training_plan', now: stamp,
        });
        rows.push(row);
        return { day: d.day, date, focusAreas: d.focusAreas, name: d.workout.name, workoutId: row.id };
      }).sort((a, b) => a.date.localeCompare(b.date)),
    }));

    const plan = {
      id: planId,
      userId: memberId,
      name: draft.name,
      goal: input.goal,
      targetAreas: input.targetAreas,
      experience: input.experience,
      environment: input.environment,
      equipment: input.equipment,
      style: input.style,
      durationWeeks,
      daysPerWeek: input.daysPerWeek,
      sessionMinutes: input.sessionMinutes,
      status: 'active',
      // FitFlex recommended it; a trainer-made plan would say 'trainer'.
      createdByType: 'fitflex',
      createdById: null,
      trainerId: null,
      engine: provider,
      startDate,
      endDate: addPlanDays(startDate, durationWeeks * 7 - 1),
      weeks,
      createdAt: stamp.toISOString(),
      updatedAt: stamp.toISOString(),
    };
    // The plan first: its workouts point at it.
    await plans.insertAsync(plan);
    try {
      for (const row of rows) await workouts.insertAsync(row);
    } catch (err) {
      // Don't leave half a plan behind.
      for (const row of rows) await workouts.removeByIdAsync(row.id).catch(() => {});
      await plans.removeByIdAsync(planId).catch(() => {});
      throw err;
    }
    return { plan: await view(plan) };
  }

  /** The plan the member is on, or `plan: null`. */
  async function current(memberId) {
    const plan = await activePlan(memberId);
    return { plan: plan ? await view(plan) : null };
  }

  /** Every plan the member has had, newest first (outline only). */
  async function list(memberId) {
    const rows = [];
    for (const p of await plans.filterByColumnAsync('userId', memberId)) rows.push(await settle(p));
    rows.sort((a, b) => b.startDate.localeCompare(a.startDate) || +new Date(b.createdAt) - +new Date(a.createdAt));
    return { plans: rows.map(({ weeks, ...p }) => ({ ...p, sessions: weeks.reduce((n, w) => n + w.days.length, 0) })) };
  }

  async function own(memberId, id) {
    const plan = await plans.findByIdAsync(id);
    return plan && plan.userId === memberId ? plan : null;
  }

  async function get(memberId, id) {
    const plan = await own(memberId, id);
    return plan ? { plan: await view(await settle(plan)) } : { error: 'not_found', status: 404 };
  }

  /** Stop a plan. Sessions already done or under way stay in the member's history. */
  async function cancel(memberId, id) {
    const plan = await own(memberId, id);
    if (!plan) return { error: 'not_found', status: 404 };
    if (plan.status !== 'active') return { error: 'not_active', status: 409 };
    return { plan: await view(await end(plan, 'cancelled')) };
  }

  return { generate, current, list, get, cancel };
}
