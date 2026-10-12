// Training Plans, Phase D — skipping one exercise, and replacing one with
// an alternative that keeps the workout's intent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exerciseById } from '../src/shared/exercise-library.mjs';
import { availableEquipment } from '../src/shared/training-taxonomy.mjs';
import { createRecommendationEngine } from '../src/services/training/recommendation-engine.mjs';
import { createRulesRecommendationProvider } from '../src/services/training/rules-recommendation-provider.mjs';
import { createTrainingPlanService, exerciseHistory } from '../src/services/training/training-plan-service.mjs';
import { createWorkoutExerciseService } from '../src/services/training/workout-exercise-service.mjs';
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

const now = () => new Date('2026-10-12T06:00:00.000Z');
const engine = createRecommendationEngine({ providers: { rules: createRulesRecommendationProvider() } });

async function setup(trainingPreferences = { environment: 'gym', daysPerWeek: 3 }) {
  const s = {
    users: store([
      { id: 'm1', userType: 'member', memberProfile: { fitnessGoals: ['gain_muscle'], fitnessLevel: 'beginner', trainingPreferences } },
      { id: 'm2', userType: 'member', memberProfile: {} },
    ]),
    plans: store(), workouts: store(), activities: store(),
  };
  s.planSvc = createTrainingPlanService({ plans: s.plans, workouts: s.workouts, users: s.users, engine, now });
  s.workoutSvc = createWorkoutService({ workouts: s.workouts, activities: s.activities, now });
  s.svc = createWorkoutExerciseService({ workouts: s.workouts, plans: s.plans, users: s.users, now });
  const { plan } = await s.planSvc.generate('m1', { durationWeeks: 1 });
  s.plan = plan;
  s.workoutId = plan.today.workoutId;
  s.workout = async () => (await s.workoutSvc.get('m1', s.workoutId)).workout;
  return s;
}
const allSets = (e, completed = true) => ({ id: e.id, workoutSets: e.workoutSets.map(x => ({ id: x.id, completed })) });

test('skipping an exercise never counts it as done', async () => {
  const s = await setup();
  await s.workoutSvc.start('m1', s.workoutId);
  const [first, second, ...rest] = (await s.workout()).exercises;

  // Skipped, even though the same request ticks its sets.
  const saved = await s.workoutSvc.saveProgress('m1', s.workoutId, { exercises: [{ ...allSets(first), skipped: true }, allSets(second)] });
  const a = saved.workout.exercises[0];
  assert.equal(a.skipped, true);
  assert.ok(a.workoutSets.every(x => !x.completed), 'no set of a skipped exercise is done');
  assert.ok(saved.workout.exercises[1].workoutSets.every(x => x.completed));
  assert.equal((await s.workoutSvc.saveProgress('m1', s.workoutId, { exercises: [{ id: first.id, skipped: 'yes' }] })).error, 'invalid_skipped');

  const done = await s.workoutSvc.complete('m1', s.workoutId, { exercises: rest.map(e => allSets(e)) });
  assert.equal(done.workout.status, 'completed');
  assert.equal(done.workout.exercises[0].skipped, true);
  assert.ok(done.activity.id, 'the workout still records its Activity');

  // And the next plan knows.
  const h = exerciseHistory(s.workouts.rows);
  assert.ok(h.skippedExerciseIds.includes(first.libraryId));
  assert.ok(h.completedExerciseIds.includes(second.libraryId));
});

test('a skip can be undone, and then the sets count again', async () => {
  const s = await setup();
  await s.workoutSvc.start('m1', s.workoutId);
  const [first] = (await s.workout()).exercises;
  await s.workoutSvc.saveProgress('m1', s.workoutId, { exercises: [{ id: first.id, skipped: true }] });
  const back = await s.workoutSvc.saveProgress('m1', s.workoutId, { exercises: [{ ...allSets(first), skipped: false }] });
  assert.equal(back.workout.exercises[0].skipped, false);
  assert.ok(back.workout.exercises[0].workoutSets.every(x => x.completed));
});

test('a workout where everything was skipped cannot be finished as done', async () => {
  const s = await setup();
  await s.workoutSvc.start('m1', s.workoutId);
  const w = await s.workout();
  const out = await s.workoutSvc.complete('m1', s.workoutId, { exercises: w.exercises.map(e => ({ ...allSets(e), skipped: true })) });
  assert.equal(out.error, 'nothing_completed');
  assert.equal(s.activities.rows.length, 0);
});

test('alternatives train the same area and fit what the member has', async () => {
  for (const prefs of [{ environment: 'gym' }, { environment: 'home', equipment: ['none'] }, { environment: 'home', equipment: ['dumbbells'] }]) {
    const s = await setup({ ...prefs, daysPerWeek: 3 });
    const w = await s.workout();
    const have = availableEquipment(s.plan.equipment);
    const inWorkout = new Set(w.exercises.map(e => e.libraryId));
    for (const e of w.exercises) {
      const { alternatives } = await s.svc.alternatives('m1', s.workoutId, e.id);
      const area = exerciseById(e.libraryId).targetAreas[0];
      for (const alt of alternatives) {
        const label = `${JSON.stringify(prefs)} ${e.exerciseName} → ${alt.name}`;
        const intent = new Set([...exerciseById(e.libraryId).targetAreas, ...exerciseById(e.libraryId).secondaryAreas]);
        assert.ok(alt.targetAreas.includes(area) || alt.targetAreas.some(a => intent.has(a)), `${label}: a different part of the body`);
        assert.ok(alt.equipment.every(x => have.has(x)), `${label}: needs ${alt.equipment}`);
        assert.ok(alt.environment.includes(s.plan.environment), `${label}: wrong place`);
        assert.equal(alt.difficulty, 'beginner', `${label}: too hard`);
        assert.ok(!inWorkout.has(alt.id), `${label}: already in the workout`);
      }
    }
  }
});

test('replacing keeps the place in the workout, the set count and the intent', async () => {
  const s = await setup();
  const before = await s.workout();
  const target = before.exercises[1];
  const { alternatives } = await s.svc.alternatives('m1', s.workoutId, target.id);
  assert.ok(alternatives.length >= 1);
  const pick = alternatives[0];

  const out = await s.svc.replace('m1', s.workoutId, target.id, { libraryId: pick.id });
  const after = await s.workout();
  assert.equal(after.exercises.length, before.exercises.length);
  const swapped = after.exercises[1];
  assert.equal(swapped.libraryId, pick.id);
  assert.equal(swapped.exerciseName, pick.name);
  assert.equal(swapped.replacedFrom, target.libraryId);
  assert.equal(swapped.sets, target.sets);
  assert.equal(swapped.workoutSets.length, target.sets);
  assert.ok(swapped.workoutSets.every(x => !x.completed && x.exerciseId === swapped.id));
  assert.equal(swapped.muscleGroup, pick.targetAreas[0]);
  assert.equal(out.exercise.id, swapped.id);
  assert.deepEqual(after.exercises.filter((_, i) => i !== 1), before.exercises.filter((_, i) => i !== 1), 'the others are untouched');
  assert.equal(new Set(after.exercises.map(e => e.libraryId)).size, after.exercises.length, 'still no exercise twice');

  // Swapping again remembers what the plan first asked for.
  const again = (await s.svc.alternatives('m1', s.workoutId, swapped.id)).alternatives[0];
  if (again) {
    const second = await s.svc.replace('m1', s.workoutId, swapped.id, { libraryId: again.id });
    assert.equal(second.exercise.replacedFrom, target.libraryId);
  }

  // The swapped workout runs and completes like any other.
  await s.workoutSvc.start('m1', s.workoutId);
  const live = await s.workout();
  const done = await s.workoutSvc.complete('m1', s.workoutId, { exercises: live.exercises.map(e => allSets(e)) });
  assert.equal(done.workout.status, 'completed');
  assert.ok(exerciseHistory(s.workouts.rows).skippedExerciseIds.includes(target.libraryId), 'the one swapped out is chosen less often next time');
});

test('replacing is refused when it would not make sense', async () => {
  const s = await setup();
  const w = await s.workout();
  const [first, second] = w.exercises;
  const other = (await s.svc.alternatives('m1', s.workoutId, first.id)).alternatives[0];

  assert.equal((await s.svc.replace('m1', s.workoutId, first.id, { libraryId: 'ex_hip_flexor_stretch' })).error, 'invalid_alternative', 'a different part of the body');
  assert.equal((await s.svc.replace('m1', s.workoutId, first.id, { libraryId: second.libraryId })).error, 'invalid_alternative', 'already in the workout');
  assert.equal((await s.svc.replace('m1', s.workoutId, first.id, {})).error, 'invalid_alternative');
  assert.equal((await s.svc.replace('m2', s.workoutId, first.id, { libraryId: other.id })).status, 404, 'someone else');
  assert.equal((await s.svc.alternatives('m2', s.workoutId, first.id)).status, 404);
  assert.equal((await s.svc.replace('m1', s.workoutId, 'wex_nope', { libraryId: other.id })).status, 404);

  // Once a set is done, the exercise stays.
  await s.workoutSvc.start('m1', s.workoutId);
  await s.workoutSvc.saveProgress('m1', s.workoutId, { exercises: [{ id: first.id, workoutSets: [{ id: first.workoutSets[0].id, completed: true }] }] });
  assert.equal((await s.svc.replace('m1', s.workoutId, first.id, { libraryId: other.id })).error, 'exercise_started');

  // A finished workout is closed.
  const live = await s.workout();
  await s.workoutSvc.complete('m1', s.workoutId, { exercises: live.exercises.map(e => allSets(e)) });
  assert.equal((await s.svc.replace('m1', s.workoutId, second.id, { libraryId: other.id })).error, 'not_editable');
});

test('a workout the member wrote themselves has nothing to swap', async () => {
  const s = await setup();
  const { workout } = await s.workoutSvc.create('m1', { name: 'Mine', scheduledDate: '2026-10-13', exercises: [{ exerciseName: 'Cable thing', reps: 10 }] });
  const e = workout.exercises[0];
  assert.deepEqual((await s.svc.alternatives('m1', workout.id, e.id)).alternatives, []);
  assert.equal((await s.svc.replace('m1', workout.id, e.id, { libraryId: 'ex_push_up' })).error, 'not_replaceable');
});

test('an exercise a trainer picked from the library can be swapped by their client', async () => {
  const { validateWorkoutDefinition, newWorkoutRow } = await import('../src/services/workout-service.mjs');
  const s = await setup();
  // What the trainer's saved workout holds: one library exercise, one of their own.
  const { definition } = validateWorkoutDefinition({
    name: 'Coach push day',
    exercises: [
      { libraryId: 'ex_push_up', exerciseName: 'Push-up', muscleGroup: 'chest', sets: 3, reps: 12 },
      { exerciseName: 'Coach special', sets: 2, reps: 8 },
    ],
  });
  assert.equal(definition.exercises[0].libraryId, 'ex_push_up', 'the link survives saving');
  assert.equal(definition.exercises[1].libraryId, undefined);
  // Assigned to the client as a workout from their trainer.
  const row = newWorkoutRow({ memberId: 'm1', base: definition, scheduledDate: '2026-10-13', trainerId: 't1', source: 'trainer', now: now() });
  await s.workouts.insertAsync(row);
  const [picked, own] = row.exercises;

  const { alternatives } = await s.svc.alternatives('m1', row.id, picked.id);
  assert.ok(alternatives.length >= 1, 'the library exercise has stand-ins');
  assert.ok(alternatives.every(a => a.targetAreas.includes('chest')));
  const swapped = await s.svc.replace('m1', row.id, picked.id, { libraryId: alternatives[0].id });
  assert.equal(swapped.exercise.replacedFrom, 'ex_push_up');
  assert.equal(swapped.workout.trainerId, 't1', 'still their trainer\'s workout');

  // The trainer's own exercise has nothing to swap for.
  assert.deepEqual((await s.svc.alternatives('m1', row.id, own.id)).alternatives, []);
  assert.equal((await s.svc.replace('m1', row.id, own.id, { libraryId: 'ex_push_up' })).error, 'not_replaceable');
});
