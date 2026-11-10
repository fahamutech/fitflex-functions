// Trainer-assigned goals: authorship, consent-gated progress, coaching
// goals and challenge goals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrainerClientService } from '../src/services/trainer-client-service.mjs';
import { createGoalService } from '../src/services/goal-service.mjs';
import { goalProgress } from '../src/shared/member-progress.mjs';
import { deliveredTo } from './fixtures/notification-language.mjs';

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

// Thursday 24 Sep 2026, 09:00 EAT. Week: Mon 21 – Sun 27.
let NOW = new Date('2026-09-24T06:00:00.000Z');
const now = () => NOW;
const WEEK = { type: 'workouts', period: 'custom', startDate: '2026-09-21', endDate: '2026-09-27', target: 4 };

function setup() {
  NOW = new Date('2026-09-24T06:00:00.000Z');
  const s = {
    relationships: store(),
    trainers: store([
      { id: 'trn_1', userId: 'usr_t1', displayName: 'Sarah', status: 'active' },
      { id: 'trn_2', userId: 'usr_t2', displayName: 'Neema', status: 'active' },
    ]),
    users: store([{ id: 'm1', displayName: 'Aisha' }, { id: 'm2', displayName: 'Baraka' }]),
    workouts: store(),
    workoutPlans: store(),
    activities: store([
      { id: 'a1', userId: 'm1', type: 'running', source: 'fitflex', startedAt: '2026-09-22T15:00:00Z', durationMinutes: 30 },
      { id: 'a2', userId: 'm1', type: 'strength', source: 'manual', startedAt: '2026-09-23T15:00:00Z', durationMinutes: 45 },
    ]),
    goals: store(),
    challenges: store([
      { id: 'ch_t1', name: '50K Step Challenge', type: 'steps', target: 50000, startDate: '2026-09-20', endDate: '2026-09-30', creatorType: 'trainer', creatorId: 'trn_1', status: 'active' },
      { id: 'ch_gym', name: 'Gym month', type: 'steps', target: 90000, startDate: '2026-09-01', endDate: '2026-09-30', creatorType: 'gym', creatorId: 'g1', status: 'active' },
      { id: 'ch_att', name: 'Show up', type: 'gym_attendance', target: 8, startDate: '2026-09-20', endDate: '2026-09-30', creatorType: 'trainer', creatorId: 'trn_1', status: 'active' },
    ]),
    participants: store([
      { id: 'p1', challengeId: 'ch_t1', memberId: 'm1', status: 'joined' },
      { id: 'p2', challengeId: 'ch_gym', memberId: 'm1', status: 'joined' },
      { id: 'p3', challengeId: 'ch_att', memberId: 'm1', status: 'joined' },
    ]),
    sent: [],
  };
  s.svc = createTrainerClientService({ ...s, notify: async (u, m) => { s.sent.push({ u, ...m }); }, now });
  s.goalSvc = createGoalService({ goals: s.goals, trainers: s.trainers, now });
  return s;
}

async function connect(s, permissions = {}, trainer = 'trn_1', trainerUser = 'usr_t1', member = 'm1') {
  const { connection } = await s.svc.request(member, trainer, { permissions });
  await s.svc.accept(trainerUser, connection.id);
  return connection.id;
}

test('trainer sets a weekly workout goal; member sees who assigned it', async () => {
  const s = setup();
  const rel = await connect(s);
  const r = await s.svc.assignGoal('usr_t1', rel, WEEK);
  assert.equal(r.goal.type, 'workouts');
  const row = s.goals.rows.find(g => g.id === r.goal.id);
  assert.deepEqual(
    [row.source, row.trainerId, row.createdByType, row.createdById, row.userId],
    ['trainer', 'trn_1', 'trainer', 'usr_t1', 'm1'],
  );
  assert.equal(s.sent.at(-1).type, 'trainer_goal_assigned');
  assert.equal((await deliveredTo(s.sent.at(-1), 'sw')).title, 'Lengo jipya kutoka kwa trainer wako');
  assert.equal((await deliveredTo(s.sent.at(-1), null)).title, 'New goal from your trainer');

  const { goals } = await s.goalSvc.list('m1');
  const mine = goals.find(g => g.id === r.goal.id);
  assert.deepEqual(mine.createdBy, { type: 'trainer', id: 'trn_1', name: 'Sarah' });
  assert.equal(mine.createdByType, 'trainer');
  // 2 of 4 this week (a run and a manual strength session).
  assert.equal(goalProgress(row, s.activities.rows, NOW).current, 2);
});

test('member goals and defaults record their authorship too', async () => {
  const s = setup();
  const { goals } = await s.goalSvc.list('m2'); // seeds defaults
  assert.ok(goals.every(g => g.createdByType === 'system' && g.createdBy.type === 'system'));
  const { goal } = await s.goalSvc.create('m2', { type: 'steps', period: 'day', target: 9000 });
  assert.deepEqual([goal.createdByType, goal.createdById], ['member', 'm2']);
  assert.equal((await s.goalSvc.create('m2', { type: 'custom', period: 'week', target: 3, title: 'x' })).error, 'invalid_type', 'coaching goals are trainer-set');
});

test('only an active client, and only the trainer who set it, can be changed', async () => {
  const s = setup();
  const { connection } = await s.svc.request('m1', 'trn_1', {});
  assert.equal((await s.svc.assignGoal('usr_t1', connection.id, WEEK)).status, 409, 'pending relationship');
  await s.svc.accept('usr_t1', connection.id);
  assert.equal((await s.svc.assignGoal('usr_t2', connection.id, WEEK)).status, 404, 'not their client');

  const { goal } = await s.svc.assignGoal('usr_t1', connection.id, WEEK);
  const other = await connect(s, {}, 'trn_2', 'usr_t2');
  assert.equal((await s.svc.updateAssignedGoal('usr_t2', other, goal.id, { target: 1 })).status, 404);
  const own = await s.goalSvc.create('m1', { type: 'steps', period: 'day', target: 8000 });
  assert.equal((await s.svc.updateAssignedGoal('usr_t1', connection.id, own.goal.id, { status: 'archived' })).status, 404, "can't touch the member's own goals");

  const up = await s.svc.updateAssignedGoal('usr_t1', connection.id, goal.id, { target: 5 });
  assert.equal(up.goal.target, 5);
  assert.equal((await s.svc.updateAssignedGoal('usr_t1', connection.id, goal.id, { target: 999 })).error, 'invalid_target');
  const gone = await s.svc.updateAssignedGoal('usr_t1', connection.id, goal.id, { status: 'archived' });
  assert.equal(gone.goal.status, 'archived');
});

test('member can pause or archive a trainer goal, not retarget it', async () => {
  const s = setup();
  const rel = await connect(s);
  const { goal } = await s.svc.assignGoal('usr_t1', rel, WEEK);
  assert.equal((await s.goalSvc.update('m1', goal.id, { target: 1 })).error, 'target_locked');
  assert.equal((await s.goalSvc.update('m1', goal.id, { status: 'paused' })).goal.status, 'paused');
});

test('the trainer always sees goals they set; progress needs the goals permission', async () => {
  const s = setup();
  const rel = await connect(s, {});
  await s.svc.assignGoal('usr_t1', rel, WEEK);
  const hidden = await s.svc.overview('usr_t1', rel);
  assert.equal(hidden.assignedGoals.length, 1);
  assert.equal('progress' in hidden.assignedGoals[0], false);
  assert.equal(hidden.goals, undefined, "the member's other goals stay private");

  await s.svc.updatePermissions('m1', rel, { permissions: { goals: true } });
  const shown = await s.svc.overview('usr_t1', rel);
  assert.equal(shown.assignedGoals[0].progress.current, 2);
  assert.equal(shown.assignedGoals[0].progress.completed, false);
});

test('coaching goals: title required, marked done, capped, undoable', async () => {
  const s = setup();
  const rel = await connect(s, { goals: true });
  assert.equal((await s.svc.assignGoal('usr_t1', rel, { type: 'custom', period: 'week', target: 2 })).error, 'title_required');
  assert.equal((await s.svc.assignGoal('usr_t1', rel, { type: 'custom', period: 'week', target: 2.5, title: 'Stretch' })).error, 'invalid_target');
  const { goal } = await s.svc.assignGoal('usr_t1', rel, { type: 'custom', period: 'week', target: 2, title: '  Stretch after every session ' });
  assert.equal(goal.title, 'Stretch after every session');

  assert.equal((await s.goalSvc.checkIn('m2', goal.id)).status, 404, 'not their goal');
  await s.goalSvc.checkIn('m1', goal.id);
  NOW = new Date('2026-09-25T06:00:00.000Z');
  await s.goalSvc.checkIn('m1', goal.id);
  assert.equal((await s.goalSvc.checkIn('m1', goal.id)).error, 'already_complete');
  const row = () => s.goals.rows.find(g => g.id === goal.id);
  assert.equal(goalProgress(row(), [], NOW).current, 2);
  assert.equal(goalProgress(row(), [], NOW).completed, true);
  assert.equal((await s.svc.overview('usr_t1', rel)).assignedGoals[0].progress.current, 2);

  await s.goalSvc.undoCheckIn('m1', goal.id);
  assert.equal(goalProgress(row(), [], NOW).current, 1);
  // Next week starts from zero.
  NOW = new Date('2026-09-29T06:00:00.000Z');
  assert.equal(goalProgress(row(), [], NOW).current, 0);
  assert.equal((await s.goalSvc.undoCheckIn('m1', goal.id)).error, 'nothing_to_undo');
  const { goal: measured } = await s.goalSvc.create('m1', { type: 'steps', period: 'day', target: 8000 });
  assert.equal((await s.goalSvc.checkIn('m1', measured.id)).error, 'not_a_coaching_goal');
});

test('challenge goals: own joined challenges only, with the challenges permission', async () => {
  const s = setup();
  const rel = await connect(s, {});
  assert.equal((await s.svc.assignGoal('usr_t1', rel, { challengeId: 'ch_t1' })).error, 'challenges_not_shared');
  await s.svc.updatePermissions('m1', rel, { permissions: { challenges: true } });

  const view = await s.svc.overview('usr_t1', rel);
  assert.deepEqual(view.goalChallenges.map(c => c.id), ['ch_t1'], "not the gym's, not an unmeasurable one");
  assert.equal((await s.svc.assignGoal('usr_t1', rel, { challengeId: 'ch_gym' })).error, 'challenge_not_linkable');
  assert.equal((await s.svc.assignGoal('usr_t1', rel, { challengeId: 'ch_att' })).error, 'challenge_not_linkable');

  const { goal } = await s.svc.assignGoal('usr_t1', rel, { challengeId: 'ch_t1', target: 30000 });
  assert.deepEqual(
    [goal.type, goal.period, goal.startDate, goal.endDate, goal.target, goal.title, goal.challengeId],
    ['steps', 'custom', '2026-09-20', '2026-09-30', 30000, '50K Step Challenge', 'ch_t1'],
  );
});
