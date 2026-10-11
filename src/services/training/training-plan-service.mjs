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

// How many recent ratings decide whether the next plan eases off or asks more.
const EFFORT_WINDOW = 3;

/**
 * What the member's finished workouts say: exercises completed and skipped
 * (by library id), what they said about individual exercises, and whether
 * recent sessions felt too easy or too hard.
 */
export function exerciseHistory(workoutRows) {
  const completed = new Set();
  const skipped = new Set();
  const feedback = new Map();
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
      // One swapped out for another was passed over too.
      if (e.replacedFrom) skipped.add(e.replacedFrom);
      // The newest word on an exercise is the one that counts.
      if (e.feedback && !feedback.has(e.libraryId)) feedback.set(e.libraryId, e.feedback);
    }
  }
  for (const id of completed) skipped.delete(id);
  // Two of the last three rated sessions agreeing is a pattern, one is a bad day.
  const ratings = recent.map(w => w.feedback?.rating).filter(Boolean).slice(0, EFFORT_WINDOW);
  const count = r => ratings.filter(x => x === r).length;
  const effort = count('too_hard') >= 2 ? 'easier' : count('too_easy') >= 2 ? 'harder' : null;
  return {
    completedExerciseIds: [...completed],
    skippedExerciseIds: [...skipped],
    feedback: [...feedback].map(([exerciseId, reason]) => ({ exerciseId, reason })),
    effort,
  };
}

export function createTrainingPlanService({
  plans, workouts, users, engine,
  // For plans a trainer makes: who they are, whether the member still trains with them, and telling them the answer.
  trainers = null, relationships = null, notify = async () => {},
  now = () => new Date(),
}) {
  const today = () => localDay(now());

  async function safeNotify(userId, message) {
    try { if (userId) await notify(userId, message); } catch { /* best effort */ }
  }

  /** The trainer who made a plan, as the member sees them. */
  async function trainerOf(plan) {
    if (!plan.trainerId || !trainers) return null;
    const t = await trainers.findByIdAsync(plan.trainerId);
    return t ? { id: t.id, displayName: t.displayName ?? null, photoUrl: t.photoUrl ?? null, userId: t.userId ?? null } : null;
  }
  const publicTrainer = t => (t ? { id: t.id, displayName: t.displayName, photoUrl: t.photoUrl } : null);

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
      days: w.days.map(({ workout: _pending, ...d }) => {
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
      trainer: publicTrainer(await trainerOf(plan)),
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
   * plan they are on), `lang` (en|sw: the language its names are written in).
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
      profile: user.memberProfile ?? {}, preferences, durationWeeks, startDate, history: exerciseHistory(mine), lang: body.lang,
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
    for (const p of await plans.filterByColumnAsync('userId', memberId)) {
      // An offer isn't a plan the member has had until they take it.
      if (p.status !== 'offered' && p.status !== 'declined') rows.push(await settle(p));
    }
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
    const ended = await end(plan, 'cancelled');
    const trainer = await trainerOf(plan);
    if (trainer) {
      await safeNotify(trainer.userId, {
        type: 'training_plan_stopped', title: 'A client stopped your plan',
        body: `Your client stopped "${plan.name}".`, data: { planId: plan.id },
      });
    }
    return { plan: await view(ended) };
  }

  // ── Plans offered by a trainer ────────────────────────────────────────────

  /** A waiting offer as the member sees it: who, what, and each session in outline. */
  async function offerView(plan) {
    return {
      id: plan.id, name: plan.name, note: plan.note ?? null, status: plan.status,
      durationWeeks: plan.durationWeeks, daysPerWeek: plan.daysPerWeek, sessionMinutes: plan.sessionMinutes,
      startDate: plan.startDate, endDate: plan.endDate, createdAt: plan.createdAt,
      trainer: publicTrainer(await trainerOf(plan)),
      weeks: plan.weeks.map(w => ({
        week: w.week,
        days: w.days.map(d => ({
          day: d.day, date: d.date, focusAreas: d.focusAreas ?? [], name: d.name,
          estimatedDuration: d.workout?.estimatedDuration ?? null,
          exercises: (d.workout?.exercises ?? []).map(e => ({ exerciseName: e.exerciseName, sets: e.sets ?? 1, reps: e.reps ?? null, duration: e.duration ?? null })),
        })),
      })),
    };
  }

  /** Plans trainers have made for the member that they haven't answered yet. */
  async function offers(memberId) {
    const rows = (await plans.filterByColumnAsync('userId', memberId)).filter(p => p.status === 'offered')
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    const out = [];
    for (const p of rows) out.push(await offerView(p));
    return { offers: out };
  }

  async function ownOffer(memberId, id) {
    const plan = await own(memberId, id);
    if (!plan) return { error: 'not_found', status: 404 };
    if (plan.status !== 'offered') return { error: 'not_offered', status: 409 };
    return { plan };
  }

  /**
   * Take a trainer's plan. It becomes the member's plan — replacing the one
   * they are on — and its sessions become their workouts. If its start has
   * passed, it moves forward by whole weeks so the weekdays stay as planned.
   */
  async function accept(memberId, id) {
    const found = await ownOffer(memberId, id);
    if (found.error) return found;
    const { plan } = found;
    const trainer = await trainerOf(plan);
    const rels = relationships ? await relationships.filterByColumnAsync('memberId', memberId) : [];
    // An offer from a trainer the member no longer trains with has lapsed.
    if (!trainer || !rels.some(r => r.trainerId === plan.trainerId && r.status === 'active')) {
      await plans.updateByIdAsync(plan.id, { status: 'cancelled', updatedAt: now().toISOString() });
      return { error: 'offer_expired', status: 409 };
    }

    const day = today();
    const first = plan.weeks.flatMap(w => w.days).map(d => d.date).sort()[0] ?? plan.startDate;
    const lateDays = Math.max(0, Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000));
    const shift = Math.ceil(lateDays / 7) * 7;

    const current = await activePlan(memberId);
    if (current) await end(current, 'cancelled');

    const stamp = now();
    const rows = [];
    const weeks = plan.weeks.map(w => ({
      week: w.week,
      days: w.days.map(({ workout, ...d }) => {
        const date = addPlanDays(d.date, shift);
        const row = newWorkoutRow({
          memberId, base: { id: null, ...workout }, scheduledDate: date, trainerId: plan.trainerId,
          trainingPlanId: plan.id, source: 'trainer', now: stamp,
        });
        rows.push(row);
        return { ...d, date, workoutId: row.id };
      }),
    }));
    const patch = {
      status: 'active', weeks,
      startDate: addPlanDays(plan.startDate, shift), endDate: addPlanDays(plan.endDate, shift),
      updatedAt: stamp.toISOString(),
    };
    try {
      for (const row of rows) await workouts.insertAsync(row);
      await plans.updateByIdAsync(plan.id, patch);
    } catch (err) {
      for (const row of rows) await workouts.removeByIdAsync(row.id).catch(() => {});
      throw err;
    }
    await safeNotify(trainer.userId, {
      type: 'training_plan_accepted', title: 'Your plan was accepted',
      body: `Your client accepted "${plan.name}".`, data: { planId: plan.id },
    });
    return { plan: await view({ ...plan, ...patch }) };
  }

  /** Say no to a trainer's plan. Nothing of the member's changes. */
  async function decline(memberId, id) {
    const found = await ownOffer(memberId, id);
    if (found.error) return found;
    const { plan } = found;
    await plans.updateByIdAsync(plan.id, { status: 'declined', updatedAt: now().toISOString() });
    const trainer = await trainerOf(plan);
    if (trainer) {
      await safeNotify(trainer.userId, {
        type: 'training_plan_declined', title: 'Your plan was declined',
        body: `Your client declined "${plan.name}".`, data: { planId: plan.id },
      });
    }
    return { declined: true };
  }

  return { generate, current, list, get, cancel, offers, accept, decline, viewPlan: view, endPlan: end };
}
