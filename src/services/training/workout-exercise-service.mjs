// Training Plans — swapping one exercise in a workout for another that
// keeps the session's intent.
//
// Only exercises that came from the FitFlex library can be swapped: the
// library knows what each one trains and what can stand in for it. A
// replacement trains the same main area and is something the member can
// actually do (their equipment, place and experience).
import { alternativesFor, exerciseById, listExercises, localizedExercise } from '../../shared/exercise-library.mjs';
import { buildExercise } from '../workout-service.mjs';
import { effectiveTrainingPreferences } from './training-preference-service.mjs';

const MAX_ALTERNATIVES = 6;

export function createWorkoutExerciseService({ workouts, plans, users, now = () => new Date(),
  // Picks up changes to the exercise library before alternatives are offered. Must not throw.
  ensureLibrary = async () => {} }) {
  /** What the member can do: from the plan the workout belongs to, else their preferences. */
  async function limits(workout) {
    const plan = workout.trainingPlanId ? await plans.findByIdAsync(workout.trainingPlanId) : null;
    const from = plan ?? effectiveTrainingPreferences((await users.findByIdAsync(workout.userId))?.memberProfile ?? {});
    return { environment: from.environment, equipment: from.equipment, experience: from.experience };
  }

  async function find(memberId, workoutId, exerciseId) {
    const workout = await workouts.findByIdAsync(workoutId);
    if (!workout || workout.userId !== memberId) return { error: 'not_found', status: 404 };
    const exercise = workout.exercises.find(e => e.id === exerciseId);
    if (!exercise) return { error: 'not_found', status: 404 };
    return { workout, exercise };
  }

  async function candidates(workout, exercise) {
    await ensureLibrary();
    const current = exercise.libraryId ? exerciseById(exercise.libraryId) : null;
    if (!current) return [];
    const filters = await limits(workout);
    const inWorkout = new Set(workout.exercises.map(e => e.libraryId).filter(Boolean));
    // The library's named alternatives first, then anything else for the same main area.
    const sameArea = listExercises({ ...filters, area: current.targetAreas[0] });
    const seen = new Set();
    return [...alternativesFor(current.id, filters), ...sameArea]
      .filter(e => e.active && !inWorkout.has(e.id) && !seen.has(e.id) && seen.add(e.id))
      .slice(0, MAX_ALTERNATIVES);
  }

  /** Exercises that could stand in for one in the member's workout. */
  async function alternatives(memberId, workoutId, exerciseId) {
    const found = await find(memberId, workoutId, exerciseId);
    if (found.error) return found;
    return { alternatives: await candidates(found.workout, found.exercise) };
  }

  /** Swap an exercise the member hasn't started for one of its alternatives. */
  async function replace(memberId, workoutId, exerciseId, body = {}) {
    const lang = body.lang;
    const found = await find(memberId, workoutId, exerciseId);
    if (found.error) return found;
    const { workout, exercise } = found;
    if (workout.status !== 'planned' && workout.status !== 'in_progress') return { error: 'not_editable', status: 409 };
    if (!exercise.libraryId) return { error: 'not_replaceable', status: 409 };
    if (exercise.workoutSets.some(s => s.completed)) return { error: 'exercise_started', status: 409 };
    const next = (await candidates(workout, exercise)).find(e => e.id === body.libraryId);
    if (!next) return { error: 'invalid_alternative', status: 400 };

    const built = buildExercise(workout.id, {
      libraryId: next.id,
      exerciseName: localizedExercise(next, lang).name,
      muscleGroup: next.targetAreas[0],
      // The same number of sets as planned; reps or time as the new exercise is done.
      sets: exercise.sets,
      reps: next.defaultReps ?? null,
      duration: next.defaultDuration ?? null,
      instructions: localizedExercise(next, lang).instructions.join(' '),
      tracksWeight: next.tracksWeight,
    });
    // Remember what the plan first asked for, however many swaps later.
    built.replacedFrom = exercise.replacedFrom ?? exercise.libraryId;
    const exercises = workout.exercises.map(e => (e.id === exerciseId ? built : e));
    const patch = { exercises, updatedAt: now().toISOString() };
    await workouts.updateByIdAsync(workoutId, patch);
    return { workout: { ...workout, ...patch }, exercise: built };
  }

  return { alternatives, replace };
}
