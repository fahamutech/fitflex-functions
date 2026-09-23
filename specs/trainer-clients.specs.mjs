// Trainer ↔ member connections, permissions, plans and assignments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrainerClientService, normalizePermissions, PERMISSIONS } from '../src/services/trainer-client-service.mjs';
import { streaks, goalProgress, localDay } from '../src/shared/member-progress.mjs';

function store(rows = []) {
  const clone = (r) => JSON.parse(JSON.stringify(r));
  return {
    rows,
    async filterByColumnAsync(col, v) { return rows.filter(r => r[col] === v).map(clone); },
    async findByIdAsync(id) { const r = rows.find(x => x.id === id); return r ? clone(r) : null; },
    async findAsync(pred) { const r = rows.find(pred); return r ? clone(r) : null; },
    async insertAsync(row) { rows.push(clone(row)); return row; },
    async updateByIdAsync(id, patch) { const r = rows.find(x => x.id === id); Object.assign(r, clone(patch)); return clone(r); },
    async removeByIdAsync(id) { const i = rows.findIndex(x => x.id === id); return i < 0 ? null : rows.splice(i, 1)[0]; },
  };
}

// Wednesday 24 Sep 2026, 09:00 EAT.
const NOW = new Date('2026-09-24T06:00:00.000Z');
const now = () => NOW;

function setup() {
  const s = {
    relationships: store(),
    trainers: store([
      { id: 'trn_1', userId: 'usr_t1', displayName: 'Coach Amani', status: 'active' },
      { id: 'trn_2', userId: 'usr_t2', displayName: 'Coach Neema', status: 'active' },
    ]),
    users: store([{ id: 'm1', displayName: 'Amina' }, { id: 'm2', displayName: 'Baraka' }]),
    workouts: store(),
    workoutPlans: store(),
    activities: store([
      { id: 'a1', userId: 'm1', type: 'walking', source: 'device', startedAt: '2026-09-24T04:00:00Z', steps: 6000, activeMinutes: 40, distanceKm: 4.5 },
      { id: 'a2', userId: 'm1', type: 'running', source: 'fitflex', startedAt: '2026-09-23T15:00:00Z', durationMinutes: 30, distanceKm: 5 },
      { id: 'a3', userId: 'm1', type: 'walking', source: 'device', startedAt: '2026-09-22T05:00:00Z', steps: 9000, activeMinutes: 50 },
    ]),
    goals: store([{ id: 'g1', userId: 'm1', type: 'steps', period: 'day', target: 5000, startDate: '2026-09-01', status: 'active', source: 'default' }]),
    sent: [],
  };
  s.svc = createTrainerClientService({ ...s, notify: async (userId, msg) => { s.sent.push({ userId, ...msg }); }, now });
  return s;
}

async function connect(s, permissions = {}) {
  const { connection } = await s.svc.request('m1', 'trn_1', { permissions });
  await s.svc.accept('usr_t1', connection.id);
  return connection.id;
}

test('permissions default to off and ignore unknown keys', () => {
  const p = normalizePermissions({ steps: true, workoutDetails: true, bankBalance: true, goals: 'yes' });
  assert.deepEqual(Object.keys(p), PERMISSIONS);
  assert.equal(p.steps, true);
  assert.equal(p.goals, false, 'only true counts');
  assert.equal(p.workoutDetails, false, 'details need history');
  assert.equal('bankBalance' in p, false);
});

test('member requests, trainer is notified and accepts', async () => {
  const s = setup();
  const { connection } = await s.svc.request('m1', 'trn_1', {});
  assert.equal(connection.status, 'pending');
  assert.ok(Object.values(connection.permissions).every(v => v === false));
  assert.equal(s.sent[0].userId, 'usr_t1');
  assert.equal(s.sent[0].type, 'trainer_client_request');

  assert.equal((await s.svc.request('m1', 'trn_1', {})).error, 'already_requested');
  assert.equal((await s.svc.clients('usr_t2')).clients.length, 0, 'other trainers see nothing');
  const { clients } = await s.svc.clients('usr_t1');
  assert.equal(clients[0].member.displayName, 'Amina');

  const accepted = await s.svc.accept('usr_t1', connection.id);
  assert.equal(accepted.client.status, 'active');
  assert.ok(accepted.client.connectedAt);
  assert.equal(s.sent.at(-1).userId, 'm1');
  assert.equal((await s.svc.request('m1', 'trn_1', {})).error, 'already_connected');
  assert.equal((await s.svc.accept('usr_t1', connection.id)).error, 'not_pending');
  assert.equal((await s.svc.accept('usr_t2', connection.id)).status, 404, 'not their request');
});

test('decline, end and cancel', async () => {
  const s = setup();
  const a = (await s.svc.request('m1', 'trn_1', {})).connection;
  assert.equal((await s.svc.decline('usr_t1', a.id)).client.status, 'declined');
  const b = (await s.svc.request('m1', 'trn_1', {})).connection;
  assert.equal((await s.svc.memberEnd('m1', b.id)).connection.status, 'ended', 'cancel a pending request');
  const c = (await s.svc.request('m1', 'trn_1', {})).connection;
  await s.svc.accept('usr_t1', c.id);
  assert.equal((await s.svc.trainerEnd('usr_t1', c.id)).client.endedBy, 'trainer');
  assert.equal((await s.svc.overview('usr_t1', c.id)).error, 'not_active', 'no access after ending');
  assert.equal((await s.svc.memberEnd('m2', c.id)).status, 404);
  assert.equal((await s.svc.request('m1', 'trn_x', {})).status, 404);
});

test('a client with nothing shared shows the trainer nothing but their own assignments', async () => {
  const s = setup();
  const rel = await connect(s);
  s.workouts.rows.push({ id: 'own', userId: 'm1', trainerId: null, source: 'member', name: 'My run club', scheduledDate: '2026-09-23', status: 'completed', exercises: [] });
  await s.svc.assign('usr_t1', rel, { name: 'Legs', exercises: [{ exerciseName: 'Squat', sets: 3, reps: 8 }], dates: ['2026-09-25'] });
  const o = await s.svc.overview('usr_t1', rel);
  assert.equal(o.client.member.displayName, 'Amina');
  for (const key of ['activity', 'goals', 'streaks', 'challenges']) assert.equal(key in o, false, key);
  assert.deepEqual(o.workouts.map(w => w.name), ['Legs']);
  assert.equal('status' in o.workouts[0], false, 'completion needs workoutHistory');
  assert.equal(JSON.stringify(o).includes('6000'), false, 'no raw steps leak');
});

test('each permission reveals exactly its own data', async () => {
  const s = setup();
  const rel = await connect(s, { steps: true });
  let o = await s.svc.overview('usr_t1', rel);
  const today = o.activity.days.at(-1);
  assert.equal(o.activity.days.length, 14);
  assert.deepEqual(today, { date: '2026-09-24', steps: 6000 });

  await s.svc.updatePermissions('m1', rel, { permissions: { steps: false, distance: true, activeMinutes: true } });
  o = await s.svc.overview('usr_t1', rel);
  assert.deepEqual(o.activity.days.at(-1), { date: '2026-09-24', distanceKm: 4.5, activeMinutes: 40 });
  assert.equal('goals' in o, false);

  await s.svc.updatePermissions('m1', rel, { permissions: { distance: false, activeMinutes: false, goals: true, streaks: true } });
  o = await s.svc.overview('usr_t1', rel);
  assert.equal('activity' in o, false);
  assert.equal(o.goals[0].current, 6000);
  assert.equal(o.goals[0].completed, true);
  assert.equal(o.streaks.activity.current, 3);
  assert.equal(o.streaks.goal.current, 1, '22nd met, 23rd not — only today counts');
});

test('workout history and details are separate permissions', async () => {
  const s = setup();
  const rel = await connect(s, { workoutHistory: true });
  s.workouts.rows.push({
    id: 'w1', userId: 'm1', trainerId: null, source: 'template', name: 'Upper Body Strength',
    scheduledDate: '2026-09-23', status: 'completed', notes: 'felt good',
    startedAt: '2026-09-23T15:00:00Z', completedAt: '2026-09-23T15:45:00Z',
    exercises: [{ id: 'e', exerciseName: 'Bench Press', workoutSets: [{ id: 's1', completed: true, weight: 60 }, { id: 's2', completed: false }] }],
  });
  let [w] = (await s.svc.overview('usr_t1', rel)).workouts;
  assert.equal(w.status, 'completed');
  assert.equal(w.durationMinutes, 45);
  assert.equal(w.setsCompleted, 1);
  assert.equal(w.setsTotal, 2);
  assert.equal('exercises' in w, false);
  assert.equal('notes' in w, false);

  await s.svc.updatePermissions('m1', rel, { permissions: { workoutDetails: true } });
  [w] = (await s.svc.overview('usr_t1', rel)).workouts;
  assert.equal(w.exercises[0].workoutSets[0].weight, 60);
  assert.equal(w.notes, 'felt good');
});

test('plans: create, update, assign on several dates, cancel', async () => {
  const s = setup();
  const rel = await connect(s, { workoutHistory: true });
  const { plan } = await s.svc.savePlan('usr_t1', null, {
    name: 'Push Day', activityType: 'strength', estimatedDuration: 40,
    exercises: [{ exerciseName: 'Bench Press', sets: 4, reps: 8, tracksWeight: true, instructions: 'Slow down' }],
  });
  assert.equal((await s.svc.listPlans('usr_t1')).plans.length, 1);
  assert.equal((await s.svc.listPlans('usr_t2')).plans.length, 0);
  assert.equal((await s.svc.savePlan('usr_t2', plan.id, { name: 'x', exercises: [{ exerciseName: 'x', reps: 1 }] })).status, 404);
  assert.equal((await s.svc.savePlan('usr_t1', null, { name: 'Bad', exercises: [] })).error, 'invalid_exercises');

  const out = await s.svc.assign('usr_t1', rel, { planId: plan.id, dates: ['2026-09-27', '2026-09-25', '2026-09-25'] });
  assert.deepEqual(out.workouts.map(w => w.scheduledDate), ['2026-09-25', '2026-09-27']);
  const stored = s.workouts.rows.filter(w => w.source === 'trainer');
  assert.equal(stored.length, 2);
  assert.ok(stored.every(w => w.trainerId === 'trn_1' && w.userId === 'm1' && w.status === 'planned'));
  assert.equal(stored[0].exercises[0].workoutSets.length, 4);
  assert.equal(stored[0].exercises[0].instructions, 'Slow down');
  assert.equal(s.sent.at(-1).type, 'trainer_workout_assigned');

  for (const [body, error] of [
    [{ planId: plan.id, dates: [] }, 'invalid_dates'],
    [{ planId: plan.id, dates: ['2026-09-01'] }, 'date_in_past'],
    [{ planId: 'nope', dates: ['2026-09-25'] }, 'plan_not_found'],
  ]) assert.equal((await s.svc.assign('usr_t1', rel, body)).error, error);

  // Editing the plan doesn't touch workouts already assigned.
  await s.svc.savePlan('usr_t1', plan.id, { name: 'Push Day v2', exercises: [{ exerciseName: 'Dips', reps: 10 }] });
  assert.equal(s.workouts.rows.find(w => w.id === stored[0].id).name, 'Push Day');

  assert.deepEqual(await s.svc.cancelAssignment('usr_t1', stored[0].id), { deleted: true });
  assert.equal((await s.svc.cancelAssignment('usr_t2', stored[1].id)).status, 404);
  s.workouts.rows.find(w => w.id === stored[1].id).status = 'in_progress';
  assert.equal((await s.svc.cancelAssignment('usr_t1', stored[1].id)).error, 'already_started');
  assert.deepEqual(await s.svc.deletePlan('usr_t1', plan.id), { deleted: true });
});

test('assigning needs an active connection', async () => {
  const s = setup();
  const { connection } = await s.svc.request('m1', 'trn_1', {});
  const body = { name: 'x', exercises: [{ exerciseName: 'x', reps: 5 }], dates: ['2026-09-25'] };
  assert.equal((await s.svc.assign('usr_t1', connection.id, body)).error, 'not_active');
});

test('server progress rules match the app: local days, grace, weeks', () => {
  assert.equal(localDay('2026-09-23T21:30:00Z'), '2026-09-24', 'EAT is UTC+3');
  const acts = [
    { type: 'running', source: 'fitflex', startedAt: '2026-09-21T15:00:00Z', durationMinutes: 30 },
    { type: 'strength', source: 'fitflex', startedAt: '2026-09-22T15:00:00Z', durationMinutes: 45 },
    { type: 'walking', source: 'device', startedAt: '2026-09-23T05:00:00Z', activeMinutes: 10, steps: 2000 },
  ];
  const s = streaks(acts, [], NOW);
  // Today (24th) not yet active and the 23rd was short → streak ended.
  assert.equal(s.activity.current, 0);
  assert.equal(s.activity.endedLength, 2);
  assert.equal(s.workout.current, 1, 'this week has 2 workouts');
  assert.equal(s.goal, null);
  const g = goalProgress({ type: 'workouts', period: 'week', target: 3 }, acts, NOW);
  assert.deepEqual(g, { current: 2, target: 3, completed: false, periodStart: '2026-09-21', periodEnd: '2026-09-27' });
});

test('client list summaries: this week from shared data only, plus prompts', async () => {
  const s = setup();
  // m1 shares steps and workout history; nothing else.
  const rel = await connect(s, { steps: true, workoutHistory: true });
  // One assignment last Monday the member didn't do.
  await s.svc.assign('usr_t1', rel, { name: 'Legs', exercises: [{ exerciseName: 'Squat', reps: 5 }], dates: ['2026-09-23'] });
  const [c] = (await s.svc.clients('usr_t1')).clients;
  const sum = c.summary;
  assert.equal(sum.weekStart, '2026-09-21');
  assert.deepEqual(sum.week, { workouts: 1, steps: 15000 }, 'Mon–Wed: run + 6000 + 9000 steps; no minutes or distance');
  assert.equal('goal' in sum, false);
  assert.equal('streak' in sum, false);
  assert.equal(sum.lastWorkoutDate, '2026-09-23');
  const codes = sum.attention.map(a => a.code);
  assert.deepEqual(codes.sort(), ['missed_workouts', 'nothing_planned'].sort());
  assert.equal(sum.attention.find(a => a.code === 'missed_workouts').value, 1);
});

test('summaries respect goals and streaks permissions and flag inactivity', async () => {
  const s = setup();
  s.goals.rows.push({ id: 'g2', userId: 'm1', type: 'workouts', period: 'week', target: 1, startDate: '2026-09-01', status: 'active', source: 'member' });
  const rel = await connect(s, { goals: true, streaks: true });
  await s.svc.assign('usr_t1', rel, { name: 'Legs', exercises: [{ exerciseName: 'Squat', reps: 5 }], dates: ['2026-09-26'] });
  let [c] = (await s.svc.clients('usr_t1')).clients;
  assert.deepEqual(c.summary.week, {}, 'no activity permissions → no numbers');
  assert.equal(c.summary.goal.type, 'workouts', 'weekly workout goal preferred');
  assert.equal(c.summary.goal.current, 1);
  assert.ok(c.summary.attention.some(a => a.code === 'goal_met' && a.kind === 'positive'));
  assert.equal(c.summary.streak.current, 3);
  assert.equal(c.summary.plannedNext7Days, 1);
  assert.equal(c.summary.attention.some(a => a.code === 'nothing_planned'), false);
  assert.equal('lastWorkoutDate' in c.summary, false, 'needs workout history');

  // Revoking takes effect on the very next read.
  await s.svc.updatePermissions('m1', rel, { permissions: { goals: false, streaks: false, workoutHistory: true } });
  s.activities.rows.splice(0);
  [c] = (await s.svc.clients('usr_t1')).clients;
  assert.equal('goal' in c.summary, false);
  assert.equal('streak' in c.summary, false);
  assert.deepEqual(c.summary.attention.find(a => a.code === 'inactive'), { kind: 'attention', code: 'inactive', value: null });
});

test('requests stay on top; clients needing attention come next', async () => {
  const s = setup();
  s.trainers.rows.push({ id: 'trn_3', userId: 'usr_t3', displayName: 'C', status: 'active' });
  // m1 active with prompts; m2 pending.
  const rel = await connect(s, { workoutHistory: true });
  await s.svc.request('m2', 'trn_1', {});
  const list = (await s.svc.clients('usr_t1')).clients;
  assert.equal(list[0].status, 'pending');
  assert.equal(list[1].id, rel);
  assert.equal('summary' in list[0], false, 'no summary before accepting');
});
