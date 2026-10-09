// Training Plans — the recommendation engine's contract.
//
// The engine turns what FitFlex knows about a member into a plan draft.
// It is a seam, not an algorithm: a provider does the thinking.
//
//   'rules'  deterministic, built from the exercise library (the default)
//   'ai'     reserved for a later provider; nothing calls a model today
//
// A provider is `{ recommend(input) -> draft | { error, status } }`.
//
// input  (see buildRecommendationInput)
//   goal, targetAreas[], experience, environment, equipment[],
//   sessionMinutes, daysPerWeek, style, durationWeeks, startDate,
//   history: { completedExerciseIds[], skippedExerciseIds[], feedback[] }
//
// draft
//   { name, durationWeeks, weeks: [{ week, days: [{ day (1 = Monday … 7),
//       focusAreas[], workout: <workout definition> | null }] }] }
//   A day with `workout: null` is rest or recovery. A workout definition is
//   what the workout engine already accepts (name, activityType,
//   estimatedDuration, exercises[]), each exercise also naming the library
//   entry it came from (`libraryId`).
//
// Whatever the provider, the draft is checked here before anything is
// saved, so a future provider can never write a malformed plan.
import { validateWorkoutDefinition } from '../workout-service.mjs';
import { exerciseById } from '../../shared/exercise-library.mjs';
import { TARGET_AREAS } from '../../shared/training-taxonomy.mjs';
import { effectiveTrainingPreferences } from './training-preference-service.mjs';

export const RECOMMENDATION_PROVIDERS = ['rules', 'ai'];
export const DEFAULT_PLAN_WEEKS = 4;
export const MAX_PLAN_WEEKS = 12;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Everything a provider may use, from the member's profile and history. */
export function buildRecommendationInput({ profile = {}, preferences, durationWeeks = DEFAULT_PLAN_WEEKS, startDate, history = {} }) {
  return {
    ...effectiveTrainingPreferences(profile, preferences ?? profile?.trainingPreferences),
    durationWeeks,
    startDate,
    history: {
      completedExerciseIds: history.completedExerciseIds ?? [],
      skippedExerciseIds: history.skippedExerciseIds ?? [],
      feedback: history.feedback ?? [],
    },
  };
}

/** Why a draft can't be saved, or null when it can. */
export function planDraftProblem(draft, input) {
  if (!draft || typeof draft !== 'object') return 'invalid_draft';
  if (typeof draft.name !== 'string' || !draft.name.trim()) return 'invalid_plan_name';
  if (!Number.isInteger(draft.durationWeeks) || draft.durationWeeks < 1 || draft.durationWeeks > MAX_PLAN_WEEKS) return 'invalid_duration_weeks';
  if (!Array.isArray(draft.weeks) || draft.weeks.length !== draft.durationWeeks) return 'invalid_weeks';
  for (const [i, week] of draft.weeks.entries()) {
    if (week?.week !== i + 1 || !Array.isArray(week.days)) return 'invalid_weeks';
    const seen = new Set();
    let sessions = 0;
    for (const d of week.days) {
      if (!Number.isInteger(d?.day) || d.day < 1 || d.day > 7 || seen.has(d.day)) return 'invalid_day';
      seen.add(d.day);
      if (!Array.isArray(d.focusAreas) || !d.focusAreas.every(a => TARGET_AREAS.includes(a))) return 'invalid_focus_areas';
      if (d.workout == null) continue;
      sessions += 1;
      if (validateWorkoutDefinition(d.workout).error) return 'invalid_workout';
      const ids = d.workout.exercises.map(e => e.libraryId);
      // Every exercise comes from the library, and none twice in a session.
      if (!ids.every(id => exerciseById(id)) || new Set(ids).size !== ids.length) return 'invalid_exercise';
    }
    if (input?.daysPerWeek && sessions > input.daysPerWeek) return 'too_many_sessions';
  }
  return null;
}

export function createRecommendationEngine({ providers = {}, defaultProvider = 'rules' } = {}) {
  /** A checked plan draft for `input`, or { error, status }. */
  async function recommend(input, { provider = defaultProvider } = {}) {
    if (!RECOMMENDATION_PROVIDERS.includes(provider)) return { error: 'unknown_provider', status: 400 };
    if (!DATE_RE.test(input?.startDate ?? '')) return { error: 'invalid_start_date', status: 400 };
    if (!Number.isInteger(input.durationWeeks) || input.durationWeeks < 1 || input.durationWeeks > MAX_PLAN_WEEKS) {
      return { error: 'invalid_duration_weeks', status: 400 };
    }
    const impl = providers[provider];
    if (!impl) return { error: 'provider_unavailable', status: 503 };
    const draft = await impl.recommend(input);
    if (draft?.error) return draft;
    const problem = planDraftProblem(draft, input);
    if (problem) return { error: problem, status: 500 };
    return { draft, provider };
  }

  return { recommend, available: () => RECOMMENDATION_PROVIDERS.filter(p => providers[p]) };
}
