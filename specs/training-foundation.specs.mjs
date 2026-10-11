// Training Plans, Phase A — vocabulary, exercise model, preferences and
// the recommendation engine's contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FITNESS_GOAL_IDS, TARGET_AREAS, availableEquipment, trainingOptions,
} from '../src/shared/training-taxonomy.mjs';
import {
  EXERCISES, alternativesFor, exerciseById, exerciseProblem, listExercises, localizedExercise,
} from '../src/shared/exercise-library.mjs';
import {
  createTrainingPreferenceService, effectiveTrainingPreferences, validateTrainingPreferences,
} from '../src/services/training/training-preference-service.mjs';
import {
  buildRecommendationInput, createRecommendationEngine, planDraftProblem,
} from '../src/services/training/recommendation-engine.mjs';
import { newWorkoutRow, validateWorkoutDefinition } from '../src/services/workout-service.mjs';

function store(rows = []) {
  const clone = (r) => JSON.parse(JSON.stringify(r));
  return {
    rows,
    async findByIdAsync(id) { const r = rows.find(x => x.id === id); return r ? clone(r) : null; },
    async updateByIdAsync(id, patch) { const r = rows.find(x => x.id === id); Object.assign(r, clone(patch)); return clone(r); },
  };
}
const now = () => new Date('2026-10-09T06:00:00.000Z');

test('goals are the ones members already pick at onboarding and on their profile', () => {
  for (const g of ['lose_weight', 'gain_muscle', 'stay_fit', 'improve_endurance', 'learn_new_skill']) {
    assert.ok(FITNESS_GOAL_IDS.includes(g), g);
  }
  const o = trainingOptions();
  assert.equal(o.goals.length, FITNESS_GOAL_IDS.length);
  assert.deepEqual(o.targetAreaGroups.flatMap(g => g.areas), TARGET_AREAS);
  assert.ok(o.sessionMinutes.includes(45) && o.daysPerWeek.includes(4));
});

test('equipment: bodyweight is always there; a full gym has everything', () => {
  assert.deepEqual([...availableEquipment([])], ['none']);
  assert.ok(availableEquipment(['free_weights']).has('dumbbells'));
  const gym = availableEquipment(['full_gym']);
  for (const x of ['machines', 'free_weights', 'dumbbells', 'resistance_bands']) assert.ok(gym.has(x), x);
  assert.ok(!availableEquipment(['dumbbells', 'made_up']).has('made_up'));
});

test('every library exercise is well-formed, with unique ids', () => {
  assert.equal(new Set(EXERCISES.map(e => e.id)).size, EXERCISES.length);
  for (const e of EXERCISES) assert.equal(exerciseProblem(e), null, e.id);
});

test('a malformed exercise is caught', () => {
  const ok = exerciseById('ex_push_up');
  assert.equal(exerciseProblem({ ...ok, targetAreas: ['elbows'] }), 'targetAreas');
  assert.equal(exerciseProblem({ ...ok, defaultDuration: 30 }), 'defaultReps_or_defaultDuration', 'reps and time');
  assert.equal(exerciseProblem({ ...ok, defaultReps: undefined }), 'defaultReps_or_defaultDuration', 'neither');
  assert.equal(exerciseProblem({ ...ok, alternatives: ['ex_push_up'] }), 'alternatives', 'itself');
  assert.equal(exerciseProblem({ ...ok, alternatives: ['ex_nope'] }), 'alternatives', 'unknown');
  assert.equal(exerciseProblem({ ...ok, equipment: [] }), 'equipment');
});

test('the library filters by area, equipment, environment and experience', () => {
  const ids = f => listExercises(f).map(e => e.id);
  const chestAtHome = ids({ area: 'chest', environment: 'home', equipment: ['none'] });
  assert.deepEqual(chestAtHome, ['ex_push_up', 'ex_incline_push_up'], 'no equipment: bodyweight only');
  assert.ok(ids({ area: 'chest', equipment: ['full_gym'] }).includes('ex_bench_press'));
  assert.ok(!ids({ area: 'chest', equipment: ['full_gym'], experience: 'beginner' }).includes('ex_bench_press'), 'too hard for a beginner');
  assert.ok(!ids({ environment: 'outdoor', equipment: ['full_gym'] }).includes('ex_lat_pulldown'), 'gym only');
  assert.ok(ids({ environment: 'any' }).length === EXERCISES.length);
  const hidden = EXERCISES.map(e => (e.id === 'ex_push_up' ? { ...e, active: false } : e));
  assert.ok(!listExercises({ area: 'chest' }, hidden).some(e => e.id === 'ex_push_up'), 'inactive is hidden');
});

test('alternatives keep the intent and respect what the member has', () => {
  const all = alternativesFor('ex_bench_press', { equipment: ['full_gym'] }).map(e => e.id);
  assert.deepEqual(all, ['ex_dumbbell_bench_press', 'ex_machine_chest_press', 'ex_push_up']);
  for (const id of all) assert.ok(exerciseById(id).targetAreas.includes('chest'), `${id} is still a chest exercise`);
  assert.deepEqual(alternativesFor('ex_bench_press', { equipment: ['none'] }).map(e => e.id), ['ex_push_up']);
  assert.deepEqual(alternativesFor('ex_unknown'), []);
});

test('an exercise falls back to English until it is translated', () => {
  const e = exerciseById('ex_plank');
  assert.equal(localizedExercise(e, 'sw').name, 'Plank');
  const sw = localizedExercise({ ...e, i18n: { sw: { name: 'Ubao' } } }, 'sw');
  assert.equal(sw.name, 'Ubao');
  assert.equal(sw.description, e.description, 'untranslated parts stay English');
});

test('preferences: nothing is required, the profile and defaults fill the gaps', () => {
  assert.deepEqual(effectiveTrainingPreferences({}), {
    goal: 'stay_fit', targetAreas: ['full_body'], experience: 'beginner', environment: 'any',
    equipment: ['none'], sessionMinutes: 30, daysPerWeek: 3, style: 'mixed',
  });
  const fromOnboarding = effectiveTrainingPreferences({ fitnessGoals: ['something_old', 'gain_muscle'], fitnessLevel: 'intermediate' });
  assert.equal(fromOnboarding.goal, 'gain_muscle', 'first goal FitFlex knows');
  assert.equal(fromOnboarding.style, 'strength');
  assert.equal(fromOnboarding.experience, 'intermediate');
  const chosen = effectiveTrainingPreferences({
    fitnessGoals: ['lose_weight'], fitnessLevel: 'beginner',
    trainingPreferences: { goal: 'improve_endurance', environment: 'gym', targetAreas: ['glutes'], experience: 'advanced' },
  });
  assert.equal(chosen.goal, 'improve_endurance', 'their choice wins over onboarding');
  assert.deepEqual(chosen.targetAreas, ['glutes']);
  assert.deepEqual(chosen.equipment, ['full_gym'], 'a gym comes with its equipment');
  assert.equal(chosen.experience, 'advanced');
});

test('preferences: validation', () => {
  assert.equal(validateTrainingPreferences({ goal: 'get_shredded' }).error, 'invalid_goal');
  assert.equal(validateTrainingPreferences({ targetAreas: ['chest', 'chest'] }).error, 'invalid_target_areas');
  assert.equal(validateTrainingPreferences({ targetAreas: 'chest' }).error, 'invalid_target_areas');
  assert.equal(validateTrainingPreferences({ sessionMinutes: 20 }).error, 'invalid_session_minutes');
  assert.equal(validateTrainingPreferences({ daysPerWeek: 7 }).error, 'invalid_days_per_week');
  assert.equal(validateTrainingPreferences({ equipment: ['kettlebell'] }).error, 'invalid_equipment');
  assert.deepEqual(validateTrainingPreferences({ style: null, unknown: 1 }).patch, { style: null });
});

test('preferences are saved on the member profile without touching the rest of it', async () => {
  const users = store([{ id: 'm1', memberProfile: { fitnessGoals: ['gain_muscle'], fitnessLevel: 'beginner', heightCm: 170 } }]);
  const svc = createTrainingPreferenceService({ users, now });

  const before = await svc.get('m1');
  assert.equal(before.preferences.goal, null, 'nothing chosen yet');
  assert.equal(before.effective.goal, 'gain_muscle');
  assert.equal(before.updatedAt, null);

  const saved = await svc.update('m1', { targetAreas: ['chest', 'triceps'], daysPerWeek: 4, environment: 'gym' });
  assert.deepEqual(saved.preferences.targetAreas, ['chest', 'triceps']);
  assert.equal(saved.effective.daysPerWeek, 4);
  assert.equal(saved.updatedAt, now().toISOString());

  const again = await svc.update('m1', { daysPerWeek: null, sessionMinutes: 45 });
  assert.equal(again.preferences.daysPerWeek, null, 'cleared');
  assert.equal(again.effective.daysPerWeek, 3, 'back to the default');
  assert.deepEqual(again.preferences.targetAreas, ['chest', 'triceps'], 'kept');

  const profile = users.rows[0].memberProfile;
  assert.deepEqual(profile.fitnessGoals, ['gain_muscle']);
  assert.equal(profile.heightCm, 170);
  assert.equal((await svc.update('m1', { goal: 'nope' })).status, 400);
  assert.equal((await svc.get('ghost')).status, 404);
});

const session = (ids = ['ex_push_up', 'ex_plank']) => ({
  name: 'Chest + Core', activityType: 'strength', estimatedDuration: 30,
  exercises: ids.map(id => {
    const e = exerciseById(id) ?? { name: 'Mystery', defaultSets: 1, defaultReps: 1 };
    return { libraryId: id, exerciseName: e.name, sets: e.defaultSets, reps: e.defaultReps ?? null, duration: e.defaultDuration ?? null };
  }),
});
const draftOf = (days) => ({ name: '1-Week Starter', durationWeeks: 1, weeks: [{ week: 1, days }] });

test('engine input gathers preferences, dates and history', () => {
  const input = buildRecommendationInput({ profile: { fitnessGoals: ['lose_weight'] }, startDate: '2026-10-12' });
  assert.equal(input.goal, 'lose_weight');
  assert.equal(input.durationWeeks, 4);
  assert.deepEqual(input.history, { completedExerciseIds: [], skippedExerciseIds: [], feedback: [] });
});

test('a plan draft is checked whoever produced it', () => {
  const input = { daysPerWeek: 2 };
  const good = draftOf([{ day: 1, focusAreas: ['chest', 'abs'], workout: session() }, { day: 2, focusAreas: [], workout: null }]);
  assert.equal(planDraftProblem(good, input), null);
  assert.equal(planDraftProblem({ ...good, durationWeeks: 2 }, input), 'invalid_weeks');
  assert.equal(planDraftProblem(draftOf([{ day: 8, focusAreas: [], workout: null }]), input), 'invalid_day');
  assert.equal(planDraftProblem(draftOf([{ day: 1, focusAreas: ['elbows'], workout: null }]), input), 'invalid_focus_areas');
  assert.equal(planDraftProblem(draftOf([{ day: 1, focusAreas: [], workout: session(['ex_push_up', 'ex_push_up']) }]), input), 'invalid_exercise', 'twice in one session');
  assert.equal(planDraftProblem(draftOf([{ day: 1, focusAreas: [], workout: session(['ex_made_up']) }]), input), 'invalid_exercise', 'not in the library');
  assert.equal(planDraftProblem(draftOf([{ day: 1, focusAreas: [], workout: { name: 'Empty', exercises: [] } }]), input), 'invalid_workout');
  const three = draftOf([1, 2, 3].map(day => ({ day, focusAreas: [], workout: session() })));
  assert.equal(planDraftProblem(three, input), 'too_many_sessions');
});

test('the engine runs a provider and refuses a bad draft', async () => {
  const input = buildRecommendationInput({ profile: {}, startDate: '2026-10-12', durationWeeks: 1 });
  const none = createRecommendationEngine();
  assert.deepEqual(none.available(), []);
  assert.equal((await none.recommend(input)).error, 'provider_unavailable');
  assert.equal((await none.recommend(input, { provider: 'magic' })).error, 'unknown_provider');
  assert.equal((await none.recommend({ ...input, startDate: 'soon' })).error, 'invalid_start_date');

  const good = draftOf([{ day: 1, focusAreas: ['chest'], workout: session() }]);
  const engine = createRecommendationEngine({ providers: { rules: { recommend: async () => good } } });
  assert.deepEqual(engine.available(), ['rules']);
  const out = await engine.recommend(input);
  assert.equal(out.provider, 'rules');
  assert.equal(out.draft.weeks[0].days[0].workout.exercises.length, 2);

  const bad = createRecommendationEngine({ providers: { rules: { recommend: async () => ({ name: 'x' }) } } });
  assert.equal((await bad.recommend(input)).status, 500);
  const refused = createRecommendationEngine({ providers: { rules: { recommend: async () => ({ error: 'no_exercises', status: 422 }) } } });
  assert.equal((await refused.recommend(input)).error, 'no_exercises');
});

test('a plan session becomes an ordinary workout that remembers its plan and exercises', () => {
  const { definition } = validateWorkoutDefinition(session());
  assert.equal(definition.exercises[0].libraryId, 'ex_push_up');
  const row = newWorkoutRow({ memberId: 'm1', base: definition, scheduledDate: '2026-10-12', trainingPlanId: 'tpn_1', source: 'fitflex', now: now() });
  assert.equal(row.trainingPlanId, 'tpn_1');
  assert.equal(row.exercises[0].libraryId, 'ex_push_up');
  assert.equal(row.exercises[0].workoutSets.length, 3);
  // Workouts made any other way are unchanged.
  const plain = newWorkoutRow({ memberId: 'm1', base: validateWorkoutDefinition({ name: 'Mine', exercises: [{ exerciseName: 'Curl', reps: 10 }] }).definition, scheduledDate: '2026-10-12', source: 'member', now: now() });
  assert.equal(plain.trainingPlanId, null);
  assert.ok(!('libraryId' in plain.exercises[0]));
});
