// Workout engine — plan, run, complete; completion records an Activity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkoutService } from '../src/services/workout-service.mjs';
import { createActivityService } from '../src/services/activity-service.mjs';
import { WORKOUT_TEMPLATES } from '../src/shared/workout-templates.mjs';

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

let clock = new Date('2026-09-24T17:00:00.000Z');
const now = () => clock;

function setup() {
  const workouts = store();
  const activities = store();
  return { workouts, activities, svc: createWorkoutService({ workouts, activities, now }) };
}

test('templates are well-formed', () => {
  for (const t of WORKOUT_TEMPLATES) {
    assert.ok(t.id && t.name && t.activityType && t.exercises.length, t.id);
    for (const e of t.exercises) assert.ok(e.reps != null || e.duration != null, `${t.id}/${e.exerciseName}`);
  }
});

test('planning from a template builds exercises and sets', async () => {
  const { svc } = setup();
  const { workout } = await svc.create('m1', { templateId: 'tpl_upper_strength', scheduledDate: '2026-09-24' });
  assert.equal(workout.name, 'Upper Body Strength');
  assert.equal(workout.status, 'planned');
  assert.equal(workout.source, 'template');
  assert.equal(workout.exercises.length, 5);
  const bench = workout.exercises[0];
  assert.equal(bench.exerciseName, 'Bench Press');
  assert.equal(bench.workoutSets.length, 3);
  assert.deepEqual(bench.workoutSets.map(s => s.setNumber), [1, 2, 3]);
  assert.ok(bench.workoutSets.every(s => s.reps === 10 && s.weight === null && !s.completed && s.exerciseId === bench.id));
  assert.equal(bench.workoutId, workout.id);
});

test('custom workouts are validated', async () => {
  const { svc } = setup();
  const ok = await svc.create('m1', {
    name: 'Park session', activityType: 'functional', scheduledDate: '2026-09-25',
    exercises: [{ exerciseName: 'Pull-up', sets: 3, reps: 6 }, { exerciseName: 'Plank', sets: 2, duration: 45 }],
  });
  assert.equal(ok.workout.source, 'member');
  assert.equal(ok.workout.exercises[1].workoutSets[0].duration, 45);
  const bad = [
    [{ templateId: 'tpl_upper_strength', scheduledDate: '24/09/2026' }, 'invalid_scheduled_date'],
    [{ templateId: 'nope', scheduledDate: '2026-09-24' }, 'template_not_found'],
    [{ name: '', exercises: [{ exerciseName: 'x', reps: 1 }], scheduledDate: '2026-09-24' }, 'invalid_name'],
    [{ name: 'x', activityType: 'running', exercises: [{ exerciseName: 'x', reps: 1 }], scheduledDate: '2026-09-24' }, 'invalid_activity_type'],
    [{ name: 'x', exercises: [], scheduledDate: '2026-09-24' }, 'invalid_exercises'],
    [{ name: 'x', exercises: [{ exerciseName: 'Squat', sets: 3 }], scheduledDate: '2026-09-24' }, 'invalid_exercises'],
    [{ name: 'x', exercises: [{ exerciseName: 'Squat', sets: 30, reps: 5 }], scheduledDate: '2026-09-24' }, 'invalid_exercises'],
  ];
  for (const [body, error] of bad) assert.equal((await svc.create('m1', body)).error, error);
});

test('start, log sets, complete → activity with duration from start', async () => {
  const { svc, activities, workouts } = setup();
  const { workout } = await svc.create('m1', { templateId: 'tpl_upper_strength', scheduledDate: '2026-09-24' });
  clock = new Date('2026-09-24T17:00:00.000Z');
  assert.equal((await svc.start('m1', workout.id)).workout.status, 'in_progress');
  const bench = workout.exercises[0];
  const saved = await svc.saveProgress('m1', workout.id, {
    notes: 'Felt strong',
    exercises: [{ id: bench.id, notes: 'Grip wider', workoutSets: [{ id: bench.workoutSets[0].id, reps: 10, weight: 60.25, completed: true }] }],
  });
  assert.equal(saved.workout.exercises[0].workoutSets[0].weight, 60.25);
  assert.equal(saved.workout.exercises[0].notes, 'Grip wider');

  clock = new Date('2026-09-24T17:47:30.000Z');
  const done = await svc.complete('m1', workout.id, {
    exercises: [{ id: bench.id, workoutSets: [{ id: bench.workoutSets[1].id, reps: 8, weight: 62.5, completed: true }] }],
  });
  assert.equal(done.workout.status, 'completed');
  assert.equal(done.workout.activityId, done.activity.id);
  assert.equal(done.activity.type, 'strength');
  assert.equal(done.activity.source, 'fitflex');
  assert.equal(done.activity.workoutId, workout.id);
  assert.equal(done.activity.durationMinutes, 48);
  assert.equal(done.activity.startedAt, '2026-09-24T17:00:00.000Z');
  assert.equal(done.activity.notes, 'Upper Body Strength');
  assert.equal(activities.rows.length, 1);
  assert.equal(workouts.rows[0].exercises[0].workoutSets.filter(s => s.completed).length, 2);
  assert.equal(workouts.rows[0].notes, 'Felt strong');

  assert.equal((await svc.complete('m1', workout.id, {})).error, 'already_completed');
  assert.equal((await svc.saveProgress('m1', workout.id, { notes: 'late' })).error, 'not_editable');
});

test('completing without starting uses the given or estimated duration', async () => {
  const { svc } = setup();
  const { workout } = await svc.create('m1', { templateId: 'tpl_hiit_express', scheduledDate: '2026-09-24' });
  const set = workout.exercises[0].workoutSets[0];
  const done = await svc.complete('m1', workout.id, {
    durationMinutes: 22,
    exercises: [{ id: workout.exercises[0].id, workoutSets: [{ id: set.id, completed: true }] }],
  });
  assert.equal(done.activity.durationMinutes, 22);
  assert.equal(done.activity.intensity, 'high');
  assert.equal(+new Date(done.activity.startedAt), +clock - 22 * 60000);
});

test('rejects bad logs and empty completions', async () => {
  const { svc, activities } = setup();
  const { workout } = await svc.create('m1', { templateId: 'tpl_full_body_beginner', scheduledDate: '2026-09-24' });
  const pushup = workout.exercises[1];
  const set = pushup.workoutSets[0];
  const cases = [
    [{ exercises: [{ id: 'nope', workoutSets: [] }] }, 'unknown_exercise'],
    [{ exercises: [{ id: pushup.id, workoutSets: [{ id: 'nope' }] }] }, 'unknown_set'],
    [{ exercises: [{ id: pushup.id, workoutSets: [{ id: set.id, reps: -1 }] }] }, 'invalid_reps'],
    [{ exercises: [{ id: pushup.id, workoutSets: [{ id: set.id, weight: 20 }] }] }, 'weight_not_tracked'],
    [{ exercises: [{ id: pushup.id, workoutSets: [{ id: set.id, completed: 'yes' }] }] }, 'invalid_completed'],
  ];
  for (const [body, error] of cases) assert.equal((await svc.saveProgress('m1', workout.id, body)).error, error);
  assert.equal((await svc.complete('m1', workout.id, {})).error, 'nothing_completed');
  assert.equal(activities.rows.length, 0);
});

test('ownership, listing and skipping', async () => {
  const { svc } = setup();
  const a = (await svc.create('m1', { templateId: 'tpl_core_mobility', scheduledDate: '2026-09-23' })).workout;
  const b = (await svc.create('m1', { templateId: 'tpl_hiit_express', scheduledDate: '2026-09-25' })).workout;
  await svc.create('m2', { templateId: 'tpl_hiit_express', scheduledDate: '2026-09-25' });
  assert.equal((await svc.get('m2', a.id)).status, 404);
  assert.equal((await svc.start('m2', a.id)).status, 404);
  assert.deepEqual((await svc.list('m1')).workouts.map(w => w.id), [b.id, a.id]);
  assert.deepEqual((await svc.list('m1', { from: '2026-09-24', to: '2026-09-30' })).workouts.map(w => w.id), [b.id]);
  assert.equal((await svc.skip('m1', a.id)).workout.status, 'skipped');
  assert.equal((await svc.start('m1', a.id)).error, 'not_startable');
  assert.deepEqual((await svc.list('m1', { status: 'planned' })).workouts.map(w => w.id), [b.id]);
  assert.equal((await svc.list('m1', { status: 'done' })).error, 'invalid_status');
});

test('a failed workout update rolls back the new activity', async () => {
  const { workouts, activities } = setup();
  const svc = createWorkoutService({ workouts, activities, now });
  const { workout } = await svc.create('m1', { templateId: 'tpl_hiit_express', scheduledDate: '2026-09-24' });
  workouts.updateByIdAsync = async () => { throw new Error('db down'); };
  const ex = workout.exercises[0];
  await assert.rejects(() => svc.complete('m1', workout.id, {
    exercises: [{ id: ex.id, workoutSets: [{ id: ex.workoutSets[0].id, completed: true }] }],
  }), /db down/);
  assert.equal(activities.rows.length, 0);
});

test("a workout's activity cannot be deleted on its own", async () => {
  const activities = store([{ id: 'a1', userId: 'm1', source: 'fitflex', workoutId: 'wkt_1', startedAt: '2026-09-24T17:00:00Z' }]);
  const svc = createActivityService({ activities, now });
  assert.equal((await svc.remove('m1', 'a1')).error, 'linked_to_workout');
});
