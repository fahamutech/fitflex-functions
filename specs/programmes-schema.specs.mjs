// Programmes P1, slice B1, against the CI database: the new tables and
// columns round-trip through the collection API (nothing silently dropped by
// ALLOWED_FIELDS, jsonb kept as objects), and the database itself refuses a
// bad status, a length out of range, a bad completion source and a second
// live completion for the same plan day.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { programmes, programmeDayCompletions, trainingPlans, trainingExercises } from '../src/bootstrap/collections.mjs';

const uid = p => `${p}_${randomUUID().slice(0, 10)}`;
const made = { users: [], programmes: [], plans: [], exercises: [] };

after(async () => {
  await db('ProgrammeDayCompletion').whereIn('planId', made.plans).del();
  await db('TrainingPlan').whereIn('id', made.plans).del();
  await db('Programme').whereIn('id', made.programmes).del();
  await db('TrainingExercise').whereIn('id', made.exercises).del();
  await db('User').whereIn('id', made.users).del();
});

function programmeRow(extra = {}) {
  const id = uid('prg');
  made.programmes.push(id);
  const stamp = new Date().toISOString();
  return {
    id, title: 'Schema starter', summary: 'Checks the table.', i18n: { sw: { title: '[SW] Schema starter' } },
    goal: 'stay_fit', level: 'beginner', environment: 'home', equipment: ['none'], lengthDays: 7,
    days: [{ day: 1, type: 'home', workout: { name: 'W', activityType: 'functional', exercises: [{ exerciseName: 'Squat', sets: 1, reps: 5 }] } }, { day: 2, type: 'rest' }],
    status: 'draft', versionOf: null, createdBy: 'admin_x', updatedBy: 'admin_x', publishedAt: null, retiredAt: null,
    createdAt: stamp, updatedAt: stamp, ...extra,
  };
}

async function member() {
  const id = uid('usr');
  made.users.push(id);
  await db('User').insert({ id, userType: 'member', displayName: 'Programme Schema', accountStatus: 'active', updatedAt: new Date() });
  return id;
}

async function plan(userId, programmeId) {
  const id = uid('tpn');
  made.plans.push(id);
  await trainingPlans.insertAsync({
    id, userId, name: 'Schema starter', goal: 'stay_fit', targetAreas: [], experience: 'beginner', environment: 'home',
    equipment: [], style: null, durationWeeks: 1, daysPerWeek: 3, sessionMinutes: 30, status: 'active',
    createdByType: 'fitflex', createdById: null, trainerId: null, engine: null, startDate: '2026-11-20', endDate: '2026-11-26',
    weeks: [], programmeId, lengthDays: 7, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  return id;
}

test('a programme round-trips with its days, Swahili and timestamps', async () => {
  const row = programmeRow();
  await programmes.insertAsync(row);
  const back = await programmes.findByIdAsync(row.id);
  assert.deepEqual(back.days, row.days);
  assert.deepEqual(back.i18n, row.i18n);
  assert.deepEqual(back.equipment, ['none']);
  assert.equal(back.status, 'draft');
  const publishedAt = new Date().toISOString();
  await programmes.updateByIdAsync(row.id, { status: 'live', publishedAt });
  const live = await programmes.findByIdAsync(row.id);
  assert.equal(live.status, 'live');
  assert.equal(new Date(live.publishedAt).toISOString(), publishedAt);
});

test('the database refuses a bad status or a length out of range', async () => {
  await assert.rejects(programmes.insertAsync(programmeRow({ status: 'archived' })), /Programme_status_check/);
  await assert.rejects(programmes.insertAsync(programmeRow({ lengthDays: 6 })), /Programme_lengthDays_check/);
  await assert.rejects(programmes.insertAsync(programmeRow({ lengthDays: 85 })), /Programme_lengthDays_check/);
});

test('a training plan keeps its programme and length; enrolled plans are found by programme', async () => {
  const row = programmeRow();
  await programmes.insertAsync(row);
  const userId = await member();
  const planId = await plan(userId, row.id);
  const back = await trainingPlans.findByIdAsync(planId);
  assert.equal(back.programmeId, row.id);
  assert.equal(back.lengthDays, 7);
  const found = await trainingPlans.filterByColumnInAsync('programmeId', [row.id]);
  assert.deepEqual(found.map(p => p.id), [planId]);
});

test('one live completion per plan day; a reversed one makes room for another', async () => {
  const row = programmeRow();
  await programmes.insertAsync(row);
  const userId = await member();
  const planId = await plan(userId, row.id);
  const completion = extra => ({
    id: uid('pdc'), planId, userId, date: '2026-11-22', source: 'checkin', checkinId: null,
    completedAt: new Date().toISOString(), reversedAt: null, reversedReason: null, createdAt: new Date().toISOString(), ...extra,
  });
  const first = completion();
  await programmeDayCompletions.insertAsync(first);
  await assert.rejects(programmeDayCompletions.insertAsync(completion({ source: 'workout' })), /ProgrammeDayCompletion_live_day/);
  await assert.rejects(programmeDayCompletions.insertAsync(completion({ date: '2026-11-23', source: 'walk' })), /ProgrammeDayCompletion_source_check/);

  await programmeDayCompletions.updateByIdAsync(first.id, { reversedAt: new Date().toISOString(), reversedReason: 'check-in voided' });
  const again = completion();
  await programmeDayCompletions.insertAsync(again);
  const rows = await programmeDayCompletions.filterByColumnAsync('planId', planId);
  assert.equal(rows.length, 2);
  assert.equal(rows.find(r => r.id === first.id).reversedReason, 'check-in voided');
  assert.ok(rows.find(r => r.id === first.id).reversedAt);
});

test('an exercise keeps its clip and still links', async () => {
  const id = `ex_schema_${randomUUID().slice(0, 8).replace(/-/g, '')}`;
  made.exercises.push(id);
  await trainingExercises.insertAsync({
    id, name: 'Schema Squat', description: '', category: 'strength', targetAreas: ['glutes'], secondaryAreas: [], movementPattern: 'squat',
    difficulty: 'beginner', equipment: ['none'], environment: ['home'], suitableGoals: ['stay_fit'], defaultSets: 1, defaultReps: 5,
    restSeconds: 30, tracksWeight: false, instructions: ['Squat.'], alternatives: [], active: true, i18n: null,
    clipUrl: 'https://cdn.example.com/a.mp4', stillUrl: 'https://cdn.example.com/a.jpg', updatedBy: 'admin_x',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const back = await trainingExercises.findByIdAsync(id);
  assert.equal(back.clipUrl, 'https://cdn.example.com/a.mp4');
  assert.equal(back.stillUrl, 'https://cdn.example.com/a.jpg');
});
