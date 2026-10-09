// Training Plans, Phase B — the exercise library, the rules-based
// recommendation engine, and plans stored as ordinary workouts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXERCISES, exerciseById, exerciseProblem, listExercises } from '../src/shared/exercise-library.mjs';
import { TARGET_AREAS, FITNESS_GOAL_IDS, availableEquipment } from '../src/shared/training-taxonomy.mjs';
import { buildRecommendationInput, createRecommendationEngine } from '../src/services/training/recommendation-engine.mjs';
import { createRulesRecommendationProvider } from '../src/services/training/rules-recommendation-provider.mjs';
import { createTrainingPlanService, exerciseHistory, planDate } from '../src/services/training/training-plan-service.mjs';
import { createWorkoutService } from '../src/services/workout-service.mjs';

function store(rows = []) {
  const clone = (r) => JSON.parse(JSON.stringify(r));
  return {
    rows,
    async filterByColumnAsync(col, v) { return rows.filter(r => r[col] === v).map(clone); },
    async findByIdAsync(id) { const r = rows.find(x => x.id === id); return r ? clone(r) : null; },
    async insertAsync(row) { rows.push(clone(row)); return row; },
    async updateByIdAsync(id, patch) { const r = rows.find(x => x.id === id); Object.assign(r, clone(patch)); return clone(r); },
    async removeByIdAsync(id) { const i = rows.findIndex(x => x.id === id); return i < 0 ? null : rows.splice(i, 1)[0]; },
  };
}

// Monday 12 Oct 2026, 09:00 EAT.
let clock = new Date('2026-10-12T06:00:00.000Z');
const now = () => clock;
const engine = createRecommendationEngine({ providers: { rules: createRulesRecommendationProvider() } });

const draftFor = async (profile, extra = {}) => {
  const input = buildRecommendationInput({ profile, startDate: '2026-10-12', durationWeeks: 4, ...extra });
  const out = await engine.recommend(input);
  assert.equal(out.error, undefined, out.error);
  return { input, draft: out.draft };
};
const sessions = draft => draft.weeks.flatMap(w => w.days);
const exercisesOf = draft => sessions(draft).flatMap(d => d.workout.exercises);

test('the library covers every area, goal and level of equipment', () => {
  assert.ok(EXERCISES.length >= 60, `${EXERCISES.length} exercises`);
  assert.equal(new Set(EXERCISES.map(e => e.id)).size, EXERCISES.length);
  for (const e of EXERCISES) assert.equal(exerciseProblem(e), null, e.id);
  for (const area of TARGET_AREAS) {
    assert.ok(listExercises({ area }).length >= 2, `${area}: at least two to choose from`);
    // Someone at home with nothing still gets something for every area.
    assert.ok(listExercises({ area, environment: 'home', equipment: ['none'], experience: 'beginner' }).length >= 1, `${area} with no equipment`);
  }
  for (const goal of FITNESS_GOAL_IDS) assert.ok(listExercises({ goal }).length >= 8, goal);
});

test('alternatives keep the workout intent: they share a main area', () => {
  for (const e of EXERCISES) {
    for (const id of e.alternatives) {
      const alt = exerciseById(id);
      const areas = new Set([...e.targetAreas, ...e.secondaryAreas]);
      assert.ok(alt.targetAreas.some(a => areas.has(a)), `${e.id} → ${id}`);
    }
  }
});

test('a member who has told FitFlex nothing still gets a sensible plan', async () => {
  const { draft } = await draftFor({});
  assert.equal(draft.name, '4-Week Fitness Plan');
  assert.equal(draft.weeks.length, 4);
  for (const w of draft.weeks) assert.equal(w.days.length, 3, 'three days a week by default');
  assert.deepEqual(draft.weeks[0].days.map(d => d.day), [1, 3, 5], 'rest days between sessions');
  for (const e of exercisesOf(draft)) {
    const lib = exerciseById(e.libraryId);
    assert.deepEqual(lib.equipment, ['none'], `${e.exerciseName}: no equipment assumed`);
    assert.equal(lib.difficulty, 'beginner', `${e.exerciseName}: beginner by default`);
  }
});

test('same input, same plan', async () => {
  const profile = { fitnessGoals: ['gain_muscle'], trainingPreferences: { daysPerWeek: 4, environment: 'gym' } };
  assert.deepEqual((await draftFor(profile)).draft, (await draftFor(profile)).draft);
});

test('the onboarding goal shapes the plan', async () => {
  const strength = (await draftFor({ fitnessGoals: ['gain_muscle'] })).draft;
  assert.equal(strength.name, '4-Week Strength Plan');
  assert.ok(sessions(strength).every(d => d.workout.activityType === 'strength'));

  const endurance = (await draftFor({ fitnessGoals: ['improve_endurance'] })).draft;
  assert.equal(endurance.name, '4-Week Endurance Plan');
  assert.ok(endurance.weeks[0].days.filter(d => d.workout.name === 'Cardio').length >= 2);

  const flexible = (await draftFor({ fitnessGoals: ['improve_flexibility'] })).draft;
  assert.ok(flexible.weeks[0].days.some(d => d.workout.activityType === 'mobility'));
  assert.ok(exercisesOf(flexible).some(e => exerciseById(e.libraryId).category === 'stretching'));
});

test('chosen target areas lead the sessions and name them', async () => {
  const { draft } = await draftFor({
    fitnessGoals: ['gain_muscle'], fitnessLevel: 'intermediate',
    trainingPreferences: { targetAreas: ['chest', 'shoulders', 'triceps'], daysPerWeek: 4, sessionMinutes: 45, environment: 'gym' },
  });
  const week = draft.weeks[0].days;
  assert.equal(week.length, 4);
  assert.equal(week[0].workout.name, 'Chest + Shoulders');
  assert.ok(week.some(d => d.workout.name === 'Lower Body'), 'the rest of the body is not forgotten');
  assert.equal(week[0].workout.exercises[0].muscleGroup, 'chest');
  const upper = week.filter(d => d.workout.name !== 'Lower Body').flatMap(d => d.workout.exercises);
  const mine = upper.filter(e => ['chest', 'shoulders', 'triceps'].includes(e.muscleGroup)).length;
  assert.ok(mine > upper.length / 2, 'most of the upper-body work is on the chosen areas');
});

test('equipment, place and experience are respected', async () => {
  const combos = [
    { environment: 'home', equipment: ['none'], experience: 'beginner' },
    { environment: 'home', equipment: ['dumbbells'], experience: 'intermediate' },
    { environment: 'home', equipment: ['resistance_bands'], experience: 'beginner' },
    { environment: 'outdoor', equipment: ['none'], experience: 'advanced' },
    { environment: 'gym', equipment: ['full_gym'], experience: 'beginner' },
    { environment: 'gym', equipment: ['machines'], experience: 'advanced' },
  ];
  const level = { beginner: 0, intermediate: 1, advanced: 2 };
  for (const goal of ['gain_muscle', 'lose_weight', 'improve_endurance', 'improve_flexibility']) {
    for (const prefs of combos) {
      const { draft } = await draftFor({ fitnessGoals: [goal], trainingPreferences: prefs });
      const have = availableEquipment(prefs.equipment);
      for (const e of exercisesOf(draft)) {
        const lib = exerciseById(e.libraryId);
        const label = `${goal} ${JSON.stringify(prefs)}: ${e.exerciseName}`;
        assert.ok(lib.equipment.every(x => have.has(x)), `${label} needs ${lib.equipment}`);
        assert.ok(lib.environment.includes(prefs.environment), `${label} can't be done ${prefs.environment}`);
        assert.ok(level[lib.difficulty] <= level[prefs.experience], `${label} is too hard`);
      }
    }
  }
});

test('a gym member training for strength uses the equipment', async () => {
  const { draft } = await draftFor({ fitnessGoals: ['gain_muscle'], fitnessLevel: 'intermediate', trainingPreferences: { environment: 'gym' } });
  const all = exercisesOf(draft);
  const loaded = all.filter(e => e.tracksWeight).length;
  assert.ok(loaded > all.length / 2, `${loaded} of ${all.length} use a load`);
});

test('session length and days per week set the size of the plan', async () => {
  const minutes = e => { const l = exerciseById(e.libraryId); return (e.sets * ((l.defaultDuration ?? l.defaultReps * 3) + l.restSeconds)) / 60; };
  for (const sessionMinutes of [15, 30, 45, 60, 75]) {
    for (const daysPerWeek of [2, 3, 4, 5, 6]) {
      const { draft } = await draftFor({ fitnessGoals: ['stay_fit'], trainingPreferences: { sessionMinutes, daysPerWeek, environment: 'gym' } }, { durationWeeks: 1 });
      assert.equal(draft.weeks[0].days.length, daysPerWeek);
      assert.equal(new Set(draft.weeks[0].days.map(d => d.day)).size, daysPerWeek, 'one session a day');
      for (const d of draft.weeks[0].days) {
        const n = d.workout.exercises.length;
        assert.ok(n >= 2 && n <= 11, `${sessionMinutes} min: ${n} exercises`);
        assert.equal(d.workout.estimatedDuration, sessionMinutes);
        const total = d.workout.exercises.reduce((s, e) => s + minutes(e), 0);
        assert.ok(total <= sessionMinutes * 1.3, `${d.workout.name}: ${Math.round(total)} min of work for a ${sessionMinutes} min session`);
      }
    }
  }
  const short = (await draftFor({ trainingPreferences: { sessionMinutes: 15 } })).draft.weeks[0].days[0].workout.exercises.length;
  const long = (await draftFor({ trainingPreferences: { sessionMinutes: 60 } })).draft.weeks[0].days[0].workout.exercises.length;
  assert.ok(long > short);
});

test('no exercise twice in a session, and weeks ask a little more', async () => {
  const { draft } = await draftFor({ fitnessGoals: ['gain_muscle'], trainingPreferences: { daysPerWeek: 5, sessionMinutes: 60 } });
  for (const d of sessions(draft)) {
    const ids = d.workout.exercises.map(e => e.libraryId);
    assert.equal(new Set(ids).size, ids.length, d.workout.name);
  }
  const first = draft.weeks[0].days[0].workout.exercises.find(e => e.reps);
  const later = draft.weeks[3].days[0].workout.exercises.find(e => e.libraryId === first.libraryId);
  assert.equal(later.reps, first.reps + 3);
});

test('what the member skipped or could not do steers the next plan', async () => {
  const profile = { fitnessGoals: ['gain_muscle'] };
  const base = exercisesOf((await draftFor(profile, { durationWeeks: 1 })).draft).map(e => e.libraryId);
  assert.ok(base.includes('ex_push_up'));
  const avoided = (await draftFor(profile, { durationWeeks: 1, history: { feedback: [{ exerciseId: 'ex_push_up', reason: 'couldnt_perform' }] } })).draft;
  assert.ok(!exercisesOf(avoided).some(e => e.libraryId === 'ex_push_up'), 'left out entirely');
  const skipped = (await draftFor(profile, { durationWeeks: 1, history: { skippedExerciseIds: ['ex_push_up'] } })).draft;
  const count = d => exercisesOf(d).filter(e => e.libraryId === 'ex_push_up').length;
  assert.ok(count(skipped) < base.filter(id => id === 'ex_push_up').length, 'chosen less often');
});

test('nothing usable is an error, not an empty plan', async () => {
  const none = createRecommendationEngine({ providers: { rules: createRulesRecommendationProvider({ library: [] }) } });
  const out = await none.recommend(buildRecommendationInput({ profile: {}, startDate: '2026-10-12' }));
  assert.equal(out.error, 'no_exercises');
  assert.equal(out.status, 422);
});

test('plan dates follow the weekday from the start date', () => {
  assert.equal(planDate('2026-10-12', 1, 1), '2026-10-12');
  assert.equal(planDate('2026-10-12', 2, 3), '2026-10-21');
  // Starting on a Thursday: that week's "Monday" session is the following Monday.
  assert.equal(planDate('2026-10-15', 1, 4), '2026-10-15');
  assert.equal(planDate('2026-10-15', 1, 1), '2026-10-19');
});

function setup(profile = { fitnessGoals: ['gain_muscle'], fitnessLevel: 'beginner' }) {
  clock = new Date('2026-10-12T06:00:00.000Z');
  const s = {
    users: store([{ id: 'm1', userType: 'member', memberProfile: profile }, { id: 'm2', userType: 'member', memberProfile: {} }]),
    plans: store(), workouts: store(), activities: store(),
  };
  s.svc = createTrainingPlanService({ plans: s.plans, workouts: s.workouts, users: s.users, engine, now });
  s.workoutSvc = createWorkoutService({ workouts: s.workouts, activities: s.activities, now });
  return s;
}

test('generating a plan stores it and schedules a workout per session', async () => {
  const s = setup();
  const { plan } = await s.svc.generate('m1', {});
  assert.equal(plan.status, 'active');
  assert.equal(plan.goal, 'gain_muscle');
  assert.equal(plan.createdByType, 'fitflex');
  assert.equal(plan.engine, 'rules');
  assert.equal(plan.startDate, '2026-10-12');
  assert.equal(plan.endDate, '2026-11-08');
  assert.equal(plan.weeks.length, 4);
  assert.equal(plan.progress.sessions, 12);
  assert.equal(s.workouts.rows.length, 12);
  assert.deepEqual(plan.weeks[0].days.map(d => d.date), ['2026-10-12', '2026-10-14', '2026-10-16']);

  const w = s.workouts.rows[0];
  assert.equal(w.trainingPlanId, plan.id);
  assert.equal(w.source, 'training_plan');
  assert.equal(w.status, 'planned');
  assert.equal(w.userId, 'm1');
  assert.ok(w.exercises.every(e => e.libraryId && e.workoutSets.length === e.sets));

  assert.equal(plan.today.workoutId, plan.weeks[0].days[0].workoutId, "today's workout");
  assert.equal(plan.next.date, '2026-10-14');
  assert.equal(plan.progress.currentWeek, 1);
  // They show up with the member's other workouts.
  assert.equal((await s.workoutSvc.list('m1', { from: '2026-10-12', to: '2026-10-18' })).workouts.length, 3);
});

test('one plan at a time; replacing clears what was never started', async () => {
  const s = setup();
  const first = (await s.svc.generate('m1', {})).plan;
  const again = await s.svc.generate('m1', {});
  assert.equal(again.error, 'active_plan_exists');
  assert.equal(again.planId, first.id);

  // Monday's session is done before they change their mind.
  const monday = first.today.workoutId;
  const body = { exercises: (await s.workoutSvc.get('m1', monday)).workout.exercises.map(e => ({ id: e.id, workoutSets: e.workoutSets.map(x => ({ id: x.id, completed: true })) })) };
  await s.workoutSvc.complete('m1', monday, body);

  const second = (await s.svc.generate('m1', { replace: true, durationWeeks: 2, preferences: { daysPerWeek: 2, environment: 'gym' } })).plan;
  assert.equal(second.daysPerWeek, 2);
  assert.equal(second.environment, 'gym');
  assert.equal(second.progress.sessions, 4);
  assert.equal((await s.svc.get('m1', first.id)).plan.status, 'cancelled');
  const left = s.workouts.rows.filter(w => w.trainingPlanId === first.id);
  assert.deepEqual(left.map(w => w.status), ['completed'], 'the finished session stays in their history');
  assert.equal(s.users.rows[0].memberProfile.trainingPreferences, undefined, 'one-off preferences are not saved');
  assert.equal((await s.svc.list('m1')).plans.length, 2);
});

test('completing a session records the Activity and moves the plan on', async () => {
  const s = setup();
  const { plan } = await s.svc.generate('m1', {});
  const id = plan.today.workoutId;
  await s.workoutSvc.start('m1', id);
  const w = (await s.workoutSvc.get('m1', id)).workout;
  clock = new Date('2026-10-12T06:40:00.000Z');
  const done = await s.workoutSvc.complete('m1', id, { exercises: w.exercises.map(e => ({ id: e.id, workoutSets: e.workoutSets.map(x => ({ id: x.id, completed: true })) })) });
  assert.equal(done.activity.source, 'fitflex');
  assert.equal(done.activity.workoutId, id);
  assert.equal(done.activity.durationMinutes, 40);
  assert.equal(s.activities.rows.length, 1, 'one Activity, no second history');

  const after = (await s.svc.current('m1')).plan;
  assert.equal(after.progress.completed, 1);
  assert.equal(after.progress.completionRate, 0.08);
  assert.equal(after.today, null, 'nothing left today');
  assert.equal(after.next.date, '2026-10-14');
  assert.equal(after.weeks[0].days[0].status, 'completed');

  // Wednesday is skipped, Friday is simply missed.
  clock = new Date('2026-10-17T06:00:00.000Z');
  await s.workoutSvc.skip('m1', after.weeks[0].days[1].workoutId);
  const week2 = (await s.svc.current('m1')).plan;
  assert.equal(week2.progress.skipped, 1);
  assert.equal(week2.progress.missed, 1);
  assert.equal(week2.next.date, '2026-10-19');
});

test('a plan ends on its own after its last day, or when the member stops it', async () => {
  const s = setup();
  const { plan } = await s.svc.generate('m1', { durationWeeks: 1 });
  clock = new Date('2026-10-19T06:00:00.000Z');
  assert.equal((await s.svc.current('m1')).plan, null);
  assert.equal((await s.svc.get('m1', plan.id)).plan.status, 'completed');
  assert.equal((await s.svc.cancel('m1', plan.id)).error, 'not_active');

  const next = (await s.svc.generate('m1', {})).plan;
  assert.equal(next.startDate, '2026-10-19');
  const stopped = (await s.svc.cancel('m1', next.id)).plan;
  assert.equal(stopped.status, 'cancelled');
  assert.equal(s.workouts.rows.filter(w => w.trainingPlanId === next.id).length, 0);
  assert.equal((await s.svc.current('m1')).plan, null);
});

test('plans are private to their member, and bad requests are refused', async () => {
  const s = setup();
  const { plan } = await s.svc.generate('m1', {});
  assert.equal((await s.svc.get('m2', plan.id)).status, 404);
  assert.equal((await s.svc.cancel('m2', plan.id)).status, 404);
  assert.equal((await s.svc.current('m2')).plan, null);
  assert.equal((await s.svc.generate('m2', { durationWeeks: 13 })).error, 'invalid_duration_weeks');
  assert.equal((await s.svc.generate('m2', { startDate: '2026-10-11' })).error, 'start_in_past');
  assert.equal((await s.svc.generate('m2', { startDate: '2026-12-25' })).error, 'start_too_far');
  assert.equal((await s.svc.generate('m2', { startDate: 'monday' })).error, 'invalid_start_date');
  assert.equal((await s.svc.generate('m2', { preferences: { goal: 'nope' } })).error, 'invalid_goal');
  assert.equal((await s.svc.generate('ghost', {})).status, 404);
  assert.equal(s.workouts.rows.filter(w => w.userId === 'm2').length, 0);
});

test('history is read from finished workouts', () => {
  const sets = done => [{ completed: done }];
  const h = exerciseHistory([
    { status: 'completed', scheduledDate: '2026-10-01', exercises: [
      { libraryId: 'ex_push_up', workoutSets: sets(true) },
      { libraryId: 'ex_plank', workoutSets: sets(false) },
      { exerciseName: 'Something of my own', workoutSets: sets(true) },
    ] },
    { status: 'completed', scheduledDate: '2026-10-03', exercises: [{ libraryId: 'ex_plank', workoutSets: sets(true) }] },
    { status: 'skipped', scheduledDate: '2026-10-05', exercises: [{ libraryId: 'ex_crunch', workoutSets: sets(false) }] },
  ]);
  assert.deepEqual(h.completedExerciseIds.sort(), ['ex_plank', 'ex_push_up']);
  assert.deepEqual(h.skippedExerciseIds, [], 'done later, so not counted as skipped; a skipped workout says nothing about its exercises');
});
