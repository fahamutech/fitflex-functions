// Workout engine — structured workouts a member plans (from a template, or
// later from a trainer), runs set by set, and finishes. Finishing records
// an Activity, which is what goals, progress and streaks read.
import { randomUUID } from 'node:crypto';
import { WORKOUT_TEMPLATES } from '../shared/workout-templates.mjs';

const WORKOUT_ACTIVITY_TYPES = ['strength', 'hiit', 'functional', 'mobility', 'stretching', 'sports', 'other'];
const STATUSES = ['planned', 'in_progress', 'completed', 'skipped'];
const MAX_EXERCISES = 20;
const MAX_SETS = 10;
const MAX_PLANNED_PER_DAY = 5;
const LIMITS = { reps: 1000, weight: 1000, duration: 7200 };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const id = (prefix) => `${prefix}_${randomUUID().slice(0, 12)}`;
const isDate = (s) => typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(+new Date(`${s}T00:00:00Z`));
const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

function buildExercise(workoutId, ex) {
  const exerciseId = id('wex');
  const count = Math.min(Math.max(Math.round(ex.sets ?? 1), 1), MAX_SETS);
  const reps = Number.isFinite(ex.reps) ? Math.round(ex.reps) : null;
  const duration = Number.isFinite(ex.duration) ? Math.round(ex.duration) : null;
  return {
    id: exerciseId,
    workoutId,
    exerciseName: ex.exerciseName,
    muscleGroup: ex.muscleGroup ?? null,
    sets: count,
    reps,
    duration,
    instructions: ex.instructions ?? null,
    tracksWeight: ex.tracksWeight === true,
    notes: null,
    workoutSets: Array.from({ length: count }, (_, i) => ({
      id: id('wst'),
      exerciseId,
      setNumber: i + 1,
      reps,
      weight: null,
      duration,
      completed: false,
    })),
  };
}

function validExerciseInput(ex) {
  if (!ex || typeof ex !== 'object') return false;
  if (!text(ex.exerciseName, 80)) return false;
  if (ex.sets != null && !(Number.isInteger(ex.sets) && ex.sets >= 1 && ex.sets <= MAX_SETS)) return false;
  if (ex.reps != null && !(Number.isInteger(ex.reps) && ex.reps >= 1 && ex.reps <= LIMITS.reps)) return false;
  if (ex.duration != null && !(Number.isInteger(ex.duration) && ex.duration >= 1 && ex.duration <= LIMITS.duration)) return false;
  return ex.reps != null || ex.duration != null;
}

/** Applies a member's logged sets/notes onto a stored workout, in place. */
function applyProgress(workout, body) {
  if (body.notes !== undefined) workout.notes = text(body.notes, 1000);
  if (!Array.isArray(body.exercises)) return null;
  for (const patch of body.exercises) {
    const ex = workout.exercises.find(e => e.id === patch?.id);
    if (!ex) return 'unknown_exercise';
    if (patch.notes !== undefined) ex.notes = text(patch.notes, 500);
    if (!Array.isArray(patch.workoutSets)) continue;
    for (const sp of patch.workoutSets) {
      const set = ex.workoutSets.find(s => s.id === sp?.id);
      if (!set) return 'unknown_set';
      for (const field of ['reps', 'weight', 'duration']) {
        if (sp[field] === undefined) continue;
        const v = sp[field];
        if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > LIMITS[field])) {
          return `invalid_${field}`;
        }
        if (field === 'weight' && !ex.tracksWeight && v !== null) return 'weight_not_tracked';
        set[field] = v === null ? null : (field === 'weight' ? Math.round(v * 100) / 100 : Math.round(v));
      }
      if (sp.completed !== undefined) {
        if (typeof sp.completed !== 'boolean') return 'invalid_completed';
        set.completed = sp.completed;
      }
    }
  }
  return null;
}

export function createWorkoutService({ workouts, activities, now = () => new Date() }) {
  function templates() {
    return { templates: WORKOUT_TEMPLATES };
  }

  async function ownWorkout(memberId, workoutId) {
    const w = await workouts.findByIdAsync(workoutId);
    return w && w.userId === memberId ? w : null;
  }

  async function list(memberId, { from, to, status } = {}) {
    if (from != null && !isDate(from)) return { error: 'invalid_from', status: 400 };
    if (to != null && !isDate(to)) return { error: 'invalid_to', status: 400 };
    if (status != null && !STATUSES.includes(status)) return { error: 'invalid_status', status: 400 };
    const rows = (await workouts.filterByColumnAsync('userId', memberId))
      .filter(w => (!from || w.scheduledDate >= from) && (!to || w.scheduledDate <= to))
      .filter(w => !status || w.status === status)
      .sort((a, b) => b.scheduledDate.localeCompare(a.scheduledDate) || +new Date(b.createdAt) - +new Date(a.createdAt));
    return { workouts: rows };
  }

  async function get(memberId, workoutId) {
    const w = await ownWorkout(memberId, workoutId);
    return w ? { workout: w } : { error: 'not_found', status: 404 };
  }

  /** Plan a workout from a template, or from a custom exercise list. */
  async function create(memberId, body = {}) {
    if (!isDate(body.scheduledDate)) return { error: 'invalid_scheduled_date', status: 400 };
    let base;
    if (body.templateId != null) {
      base = WORKOUT_TEMPLATES.find(t => t.id === body.templateId);
      if (!base) return { error: 'template_not_found', status: 404 };
    } else {
      const name = text(body.name, 80);
      if (!name) return { error: 'invalid_name', status: 400 };
      if (!WORKOUT_ACTIVITY_TYPES.includes(body.activityType ?? 'strength')) return { error: 'invalid_activity_type', status: 400 };
      if (!Array.isArray(body.exercises) || !body.exercises.length || body.exercises.length > MAX_EXERCISES) {
        return { error: 'invalid_exercises', status: 400 };
      }
      if (!body.exercises.every(validExerciseInput)) return { error: 'invalid_exercises', status: 400 };
      const est = body.estimatedDuration;
      if (est != null && !(Number.isInteger(est) && est >= 1 && est <= 600)) {
        return { error: 'invalid_estimated_duration', status: 400 };
      }
      base = {
        id: null,
        name,
        description: text(body.description, 500),
        activityType: body.activityType ?? 'strength',
        estimatedDuration: est ?? null,
        exercises: body.exercises.map(e => ({ ...e, exerciseName: text(e.exerciseName, 80) })),
      };
    }
    const sameDay = (await workouts.filterByColumnAsync('userId', memberId))
      .filter(w => w.scheduledDate === body.scheduledDate && w.status === 'planned');
    if (sameDay.length >= MAX_PLANNED_PER_DAY) return { error: 'too_many_planned', status: 400 };

    const workoutId = id('wkt');
    const stamp = now().toISOString();
    const row = {
      id: workoutId,
      userId: memberId,
      trainerId: null,
      gymId: typeof body.gymId === 'string' ? body.gymId : null,
      templateId: base.id,
      source: base.id ? 'template' : 'member',
      name: base.name,
      description: base.description ?? null,
      activityType: base.activityType,
      scheduledDate: body.scheduledDate,
      estimatedDuration: base.estimatedDuration ?? null,
      status: 'planned',
      exercises: base.exercises.map(e => buildExercise(workoutId, e)),
      notes: null,
      startedAt: null,
      completedAt: null,
      activityId: null,
      createdAt: stamp,
      updatedAt: stamp,
    };
    await workouts.insertAsync(row);
    return { workout: row };
  }

  async function start(memberId, workoutId) {
    const w = await ownWorkout(memberId, workoutId);
    if (!w) return { error: 'not_found', status: 404 };
    if (w.status === 'in_progress') return { workout: w };
    if (w.status !== 'planned') return { error: 'not_startable', status: 409 };
    const patch = { status: 'in_progress', startedAt: now().toISOString(), updatedAt: now().toISOString() };
    await workouts.updateByIdAsync(workoutId, patch);
    return { workout: { ...w, ...patch } };
  }

  /** Save sets/notes mid-session so nothing is lost if the app closes. */
  async function saveProgress(memberId, workoutId, body = {}) {
    const w = await ownWorkout(memberId, workoutId);
    if (!w) return { error: 'not_found', status: 404 };
    if (w.status !== 'planned' && w.status !== 'in_progress') return { error: 'not_editable', status: 409 };
    const error = applyProgress(w, body);
    if (error) return { error, status: 400 };
    const patch = { exercises: w.exercises, notes: w.notes, updatedAt: now().toISOString() };
    await workouts.updateByIdAsync(workoutId, patch);
    return { workout: { ...w, ...patch } };
  }

  /**
   * Finish a workout: store the final log, then record the Activity that
   * feeds goals and streaks. Duration is measured from start unless the
   * member supplies one (e.g. they forgot to tap Start).
   */
  async function complete(memberId, workoutId, body = {}) {
    const w = await ownWorkout(memberId, workoutId);
    if (!w) return { error: 'not_found', status: 404 };
    if (w.status === 'completed') return { error: 'already_completed', status: 409 };
    if (w.status === 'skipped') return { error: 'not_editable', status: 409 };
    const error = applyProgress(w, body);
    if (error) return { error, status: 400 };

    const sets = w.exercises.flatMap(e => e.workoutSets);
    if (!sets.some(s => s.completed)) return { error: 'nothing_completed', status: 400 };

    const end = now();
    let minutes = body.durationMinutes;
    if (minutes != null && !(Number.isInteger(minutes) && minutes >= 1 && minutes <= 600)) {
      return { error: 'invalid_duration', status: 400 };
    }
    if (minutes == null) {
      minutes = w.startedAt
        ? Math.round((+end - +new Date(w.startedAt)) / 60000)
        : (w.estimatedDuration ?? 30);
      minutes = Math.min(Math.max(minutes, 1), 600);
    }
    const startedAt = new Date(+end - minutes * 60000).toISOString();

    const activity = {
      id: `act_${randomUUID().slice(0, 12)}`,
      userId: memberId,
      type: w.activityType,
      source: 'fitflex',
      startedAt: w.startedAt ?? startedAt,
      durationMinutes: minutes,
      activeMinutes: minutes,
      intensity: w.activityType === 'hiit' ? 'high' : w.activityType === 'mobility' ? 'low' : 'moderate',
      workoutId: w.id,
      gymId: w.gymId ?? null,
      trainerId: w.trainerId ?? null,
      notes: w.name,
      createdAt: end.toISOString(),
    };
    await activities.insertAsync(activity);
    const patch = {
      status: 'completed',
      exercises: w.exercises,
      notes: w.notes,
      startedAt: w.startedAt ?? startedAt,
      completedAt: end.toISOString(),
      activityId: activity.id,
      updatedAt: end.toISOString(),
    };
    try {
      await workouts.updateByIdAsync(workoutId, patch);
    } catch (err) {
      // Don't leave an Activity pointing at a workout that isn't completed.
      await activities.removeByIdAsync(activity.id).catch(() => {});
      throw err;
    }
    return { workout: { ...w, ...patch }, activity };
  }

  /** Skip or delete a workout that hasn't been done. */
  async function skip(memberId, workoutId) {
    const w = await ownWorkout(memberId, workoutId);
    if (!w) return { error: 'not_found', status: 404 };
    if (w.status !== 'planned' && w.status !== 'in_progress') return { error: 'not_editable', status: 409 };
    const patch = { status: 'skipped', updatedAt: now().toISOString() };
    await workouts.updateByIdAsync(workoutId, patch);
    return { workout: { ...w, ...patch } };
  }

  return { templates, list, get, create, start, saveProgress, complete, skip };
}
