// Training Plans — plans a trainer makes for a client.
//
// A trainer lays out a week — one of their saved workouts, or the session
// FitFlex suggests, on each training day — and how many weeks it runs. It
// goes to the client as an offer: nothing of the client's changes until
// they accept, and accepting replaces the plan they are on.
//
// The trainer sees only what the client has chosen to share. FitFlex's
// suggestion uses the client's own goal and preferences only when they
// share goals with the trainer, and their workout history only when they
// share that; otherwise it is built from what the trainer enters.
import { randomUUID } from 'node:crypto';
import { localDay } from '../../shared/member-progress.mjs';
import { normalizePermissions } from '../trainer-client-service.mjs';
import { validateWorkoutDefinition } from '../workout-service.mjs';
import { validateTrainingPreferences } from './training-preference-service.mjs';
import { buildRecommendationInput, DEFAULT_PLAN_WEEKS, MAX_PLAN_WEEKS } from './recommendation-engine.mjs';
import { addPlanDays } from './rules-recommendation-provider.mjs';
import { exerciseHistory, planDate } from './training-plan-service.mjs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_START_AHEAD_DAYS = 30;
const MAX_SESSIONS_PER_WEEK = 6;
const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

export function createTrainerPlanService({
  plans, workouts, users, relationships, trainers, workoutPlans, engine,
  notify = async () => {}, now = () => new Date(),
}) {
  const today = () => localDay(now());

  async function safeNotify(userId, message) {
    try { await notify(userId, message); } catch { /* best effort */ }
  }

  /** The trainer and their active connection to this client. */
  async function connection(trainerUserId, relId) {
    const trainer = await trainers.findAsync(t => t.userId === trainerUserId);
    if (!trainer) return { error: 'trainer_profile_not_found', status: 404 };
    const r = await relationships.findByIdAsync(relId);
    if (!r || r.trainerId !== trainer.id) return { error: 'not_found', status: 404 };
    if (r.status !== 'active') return { error: 'not_active', status: 409 };
    return { trainer, relationship: r, perms: normalizePermissions(r.permissions) };
  }

  function schedule(body) {
    const durationWeeks = body.durationWeeks ?? DEFAULT_PLAN_WEEKS;
    if (!Number.isInteger(durationWeeks) || durationWeeks < 1 || durationWeeks > MAX_PLAN_WEEKS) {
      return { error: 'invalid_duration_weeks', status: 400 };
    }
    const startDate = body.startDate ?? today();
    if (!DATE_RE.test(startDate) || Number.isNaN(Date.parse(`${startDate}T00:00:00Z`))) return { error: 'invalid_start_date', status: 400 };
    if (startDate < today()) return { error: 'start_in_past', status: 400 };
    if (startDate > addPlanDays(today(), MAX_START_AHEAD_DAYS)) return { error: 'start_too_far', status: 400 };
    return { durationWeeks, startDate };
  }

  /**
   * FitFlex's suggested plan for the client. Built from the client's goal
   * and preferences when they share goals, with anything the trainer
   * entered on top; from the trainer's entries and defaults otherwise.
   */
  async function draft({ relationship: r, perms }, body, when) {
    let preferences = null;
    if (body.preferences != null) {
      const v = validateTrainingPreferences(body.preferences);
      if (v.error) return v;
      preferences = v.patch;
    }
    const client = await users.findByIdAsync(r.memberId);
    const shared = perms.goals ? client?.memberProfile ?? {} : {};
    const input = buildRecommendationInput({
      profile: shared,
      preferences: { ...(shared.trainingPreferences ?? {}), ...(preferences ?? {}) },
      durationWeeks: when.durationWeeks,
      startDate: when.startDate,
      history: perms.workoutHistory ? exerciseHistory(await workouts.filterByColumnAsync('userId', r.memberId)) : {},
      lang: body.lang,
    });
    const result = await engine.recommend(input);
    if (result.error) return result;
    return { draft: result.draft, input, usedClientPreferences: perms.goals };
  }

  const sessionOutline = d => ({
    day: d.day,
    focusAreas: d.focusAreas,
    name: d.workout.name,
    estimatedDuration: d.workout.estimatedDuration ?? null,
    exercises: d.workout.exercises.map(e => ({ exerciseName: e.exerciseName, sets: e.sets ?? 1, reps: e.reps ?? null, duration: e.duration ?? null })),
  });

  /** What FitFlex would suggest for this client: the first week, session by session. */
  async function suggest(trainerUserId, relId, body = {}) {
    const conn = await connection(trainerUserId, relId);
    if (conn.error) return conn;
    const when = schedule(body);
    if (when.error) return when;
    const made = await draft(conn, body, when);
    if (made.error) return made;
    return {
      ...when,
      // Tells the trainer whether this reflects the client's own choices.
      usedClientPreferences: made.usedClientPreferences,
      days: made.draft.weeks[0].days.map(sessionOutline),
    };
  }

  /**
   * Offer a plan to a client. `days` is the weekly layout, one entry per
   * training day: `{ day (1 = Monday … 7), planId }` for one of the
   * trainer's saved workouts, or `{ day, suggested: true }` for the
   * session FitFlex suggests that day (see `suggest`).
   */
  async function offer(trainerUserId, relId, body = {}) {
    const conn = await connection(trainerUserId, relId);
    if (conn.error) return conn;
    const { trainer, relationship: r } = conn;
    const when = schedule(body);
    if (when.error) return when;

    const layout = Array.isArray(body.days) ? body.days : [];
    if (!layout.length || layout.length > MAX_SESSIONS_PER_WEEK) return { error: 'invalid_days', status: 400 };
    const seen = new Set();
    for (const d of layout) {
      if (!Number.isInteger(d?.day) || d.day < 1 || d.day > 7 || seen.has(d.day)) return { error: 'invalid_days', status: 400 };
      if ((d.planId == null) === (d.suggested !== true)) return { error: 'invalid_days', status: 400 };
      seen.add(d.day);
    }

    // The trainer's own workouts used in the layout.
    const saved = new Map();
    for (const d of layout.filter(x => x.planId != null)) {
      if (saved.has(d.planId)) continue;
      const p = await workoutPlans.findByIdAsync(d.planId);
      if (!p || p.trainerId !== trainer.id) return { error: 'plan_not_found', status: 404 };
      const def = validateWorkoutDefinition(p);
      if (def.error) return { error: 'invalid_saved_workout', status: 400 };
      saved.set(d.planId, def.definition);
    }

    // FitFlex's sessions, when any day uses one. Always made, too, for the
    // plan's own description (goal, level…), which never leaves this service.
    const made = await draft(conn, body, when);
    if (made.error) return made;
    const suggestedFor = (week, day) => made.draft.weeks[week - 1].days.find(x => x.day === day) ?? null;
    for (const d of layout.filter(x => x.suggested === true)) {
      if (!suggestedFor(1, d.day)) return { error: 'no_suggestion_for_day', status: 400 };
    }

    const weeks = [];
    for (let week = 1; week <= when.durationWeeks; week += 1) {
      const days = layout.map(d => {
        const s = d.suggested === true ? suggestedFor(week, d.day) ?? suggestedFor(1, d.day) : null;
        const workout = s ? s.workout : saved.get(d.planId);
        return {
          day: d.day, date: planDate(when.startDate, week, d.day),
          focusAreas: s ? s.focusAreas : [], name: workout.name, workout,
        };
      }).sort((a, b) => a.date.localeCompare(b.date));
      weeks.push({ week, days });
    }

    // One waiting offer per trainer and client: a new one takes the old one's place.
    const stamp = now().toISOString();
    for (const p of await plans.filterByColumnAsync('userId', r.memberId)) {
      if (p.status === 'offered' && p.trainerId === trainer.id) await plans.updateByIdAsync(p.id, { status: 'cancelled', updatedAt: stamp });
    }

    const minutes = weeks[0].days.map(d => d.workout.estimatedDuration).filter(Boolean);
    const plan = {
      id: `tpn_${randomUUID().slice(0, 12)}`,
      userId: r.memberId,
      name: text(body.name, 80) ?? `${when.durationWeeks}-week plan`,
      note: text(body.note, 500),
      goal: made.input.goal,
      targetAreas: made.input.targetAreas,
      experience: made.input.experience,
      environment: made.input.environment,
      equipment: made.input.equipment,
      style: made.input.style,
      durationWeeks: when.durationWeeks,
      daysPerWeek: layout.length,
      sessionMinutes: minutes.length ? Math.round(minutes.reduce((a, b) => a + b, 0) / minutes.length) : made.input.sessionMinutes,
      status: 'offered',
      createdByType: 'trainer',
      createdById: trainerUserId,
      trainerId: trainer.id,
      engine: layout.some(d => d.suggested === true) ? 'rules' : null,
      startDate: when.startDate,
      endDate: addPlanDays(when.startDate, when.durationWeeks * 7 - 1),
      weeks,
      createdAt: stamp,
      updatedAt: stamp,
    };
    await plans.insertAsync(plan);
    await safeNotify(r.memberId, {
      type: 'training_plan_offered',
      title: 'Your trainer made you a plan',
      body: `${trainer.displayName || 'Your trainer'} made you "${plan.name}". Open it to take a look and accept it.`,
      data: { planId: plan.id },
    });
    return { plan: await trainerView(plan, conn.perms) };
  }

  /**
   * A plan as its trainer sees it: always the outline they wrote and where
   * the offer stands; how the sessions are going only when the client
   * shares their workout history.
   */
  async function trainerView(plan, perms) {
    const out = {
      id: plan.id, name: plan.name, note: plan.note ?? null, status: plan.status,
      durationWeeks: plan.durationWeeks, daysPerWeek: plan.daysPerWeek,
      startDate: plan.startDate, endDate: plan.endDate, createdAt: plan.createdAt,
      weeks: plan.weeks.map(w => ({ week: w.week, days: w.days.map(d => ({ day: d.day, date: d.date, name: d.name })) })),
    };
    if (plan.status === 'offered' || !perms.workoutHistory) return out;
    const rows = (await workouts.filterByColumnAsync('userId', plan.userId)).filter(w => w.trainingPlanId === plan.id);
    const day = today();
    return {
      ...out,
      progress: {
        sessions: rows.length,
        completed: rows.filter(w => w.status === 'completed').length,
        skipped: rows.filter(w => w.status === 'skipped').length,
        missed: rows.filter(w => (w.status === 'planned' || w.status === 'in_progress') && w.scheduledDate < day).length,
      },
    };
  }

  /** The plans this trainer has made for a client, newest first. */
  async function list(trainerUserId, relId) {
    const conn = await connection(trainerUserId, relId);
    if (conn.error) return conn;
    const rows = (await plans.filterByColumnAsync('userId', conn.relationship.memberId))
      .filter(p => p.trainerId === conn.trainer.id)
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    const out = [];
    for (const p of rows) out.push(await trainerView(p, conn.perms));
    return { plans: out };
  }

  /** Take back an offer, or stop a plan the client is on (sessions done stay theirs). */
  async function withdraw(trainerUserId, planId) {
    const trainer = await trainers.findAsync(t => t.userId === trainerUserId);
    if (!trainer) return { error: 'trainer_profile_not_found', status: 404 };
    const plan = await plans.findByIdAsync(planId);
    if (!plan || plan.trainerId !== trainer.id) return { error: 'not_found', status: 404 };
    if (plan.status !== 'offered' && plan.status !== 'active') return { error: 'not_active', status: 409 };
    if (plan.status === 'active') {
      for (const w of await workouts.filterByColumnAsync('userId', plan.userId)) {
        if (w.trainingPlanId === plan.id && w.status === 'planned') await workouts.removeByIdAsync(w.id);
      }
      await safeNotify(plan.userId, {
        type: 'training_plan_stopped', title: 'Your trainer stopped your plan',
        body: `${trainer.displayName || 'Your trainer'} stopped "${plan.name}". Workouts you have done stay in your history.`,
        data: { planId: plan.id },
      });
    }
    await plans.updateByIdAsync(plan.id, { status: 'cancelled', updatedAt: now().toISOString() });
    return { cancelled: true };
  }

  return { suggest, offer, list, withdraw };
}
