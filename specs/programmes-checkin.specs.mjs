// Programmes P1, slice B3: a check-in on a programme's gym day marks that day
// done (QR, web, B2B-funded and owner manual visits alike, PD-6); a check-in on
// a home or rest day is not counted (PD-5); voiding the visit reopens the day
// unless another visit that day still stands. Nothing here can fail a check-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProgrammeService } from '../src/services/training/programme-service.mjs';
import { createTrainingPlanService } from '../src/services/training/training-plan-service.mjs';
import { createProgrammeCheckinService } from '../src/services/training/programme-checkin-service.mjs';
import { createCheckinStatusService } from '../src/services/checkin-status-service.mjs';
import { createMemberManagementService } from '../src/services/member-management-service.mjs';
import { CHECKIN_SOURCE } from '../src/shared/checkin-status.mjs';

function store(rows = []) {
  const clone = r => JSON.parse(JSON.stringify(r));
  return {
    rows,
    async allAsync() { return rows.map(clone); },
    async filterAsync(pred) { return rows.filter(pred).map(clone); },
    async findAsync(pred) { const r = rows.find(pred); return r ? clone(r) : null; },
    async filterByColumnAsync(col, v) { return rows.filter(r => r[col] === v).map(clone); },
    async filterByColumnInAsync(col, values) { return rows.filter(r => values.includes(r[col])).map(clone); },
    async findByIdAsync(id) { const r = rows.find(x => x.id === id); return r ? clone(r) : null; },
    async insertAsync(row) { rows.push(clone(row)); return row; },
    async updateByIdAsync(id, patch) { const r = rows.find(x => x.id === id); Object.assign(r, clone(patch)); return clone(r); },
    async removeByIdAsync(id) { const i = rows.findIndex(x => x.id === id); return i < 0 ? null : rows.splice(i, 1)[0]; },
  };
}

const workout = name => ({
  name, activityType: 'functional', estimatedDuration: 20,
  exercises: [{ exerciseName: 'Bodyweight Squat', libraryId: 'ex_bodyweight_squat', sets: 2, reps: 10 }],
});
// Started Friday 20 Nov 2026: 20 home, 21 rest, 22 gym, 23 home, 24 rest, 25 gym (suggested workout), 26 home.
const days7 = [
  { type: 'home', workout: workout('Day 1') }, { type: 'rest' }, { type: 'gym' },
  { type: 'home', workout: workout('Day 4') }, { type: 'rest' }, { type: 'gym', workout: workout('Suggested') }, { type: 'home', workout: workout('Day 7') },
];
const body = {
  title: '7-day starter', summary: 'Build the habit.',
  i18n: { sw: { title: '[SW] 7-day starter', summary: '[SW] Build the habit.' } },
  goal: 'stay_fit', level: 'beginner', environment: 'any', equipment: ['none'], lengthDays: 7, days: days7,
};

// A visit at 09:00 EAT on `date`.
const visit = (id, date, extra = {}) => ({
  id, memberId: 'm1', gymId: 'g1', timestamp: `${date}T06:00:00.000Z`, businessDate: date, status: 'valid', method: 'member_scanned', ...extra,
});

async function setup({ on = true, start = true } = {}) {
  let clock = new Date('2026-11-20T06:00:00.000Z');
  const now = () => clock;
  const programmes = store();
  const plans = store();
  const workouts = store();
  const checkins = store();
  const dayCompletions = store();
  const users = store([{ id: 'm1', userType: 'member', memberProfile: { weightKg: 70 } }]);
  const flag = { on };
  const admin = createProgrammeService({ programmes, plans, now, logger: { warn() {} } });
  const training = createTrainingPlanService({ plans, workouts, users, engine: null, dayCompletions, now });
  const warnings = [];
  const hook = createProgrammeCheckinService({
    plans, dayCompletions, checkins, enabled: () => flag.on, now, logger: { warn: (...a) => warnings.push(a.join(' ')) },
  });
  let plan = null;
  if (start) {
    const { programme } = await admin.create('admin_1', body);
    await admin.publish('admin_1', programme.id);
    ({ plan } = await training.startProgramme('m1', (await admin.startable(programme.id)).programme, {}));
  }
  // Records a visit as the check-in service does, then runs the reaction.
  const checkIn = async row => { await checkins.insertAsync(row); return hook.recordCheckin(row); };
  const statuses = createCheckinStatusService({
    checkins, auditLog: store(),
    onVoided: ({ checkin, reason }) => hook.reverseCheckin(checkin, reason),
  });
  const voidVisit = id => statuses.setStatus({ checkinId: id, status: 'voided', reason: 'Scanned by mistake', actorId: 'admin_1' });
  const dayOn = async date => {
    clock = new Date(`${date}T18:00:00.000Z`);
    const v = await training.viewPlan(await plans.findByIdAsync(plan.id));
    return v.weeks.flatMap(w => w.days).find(d => d.date === date);
  };
  const live = () => dayCompletions.rows.filter(c => !c.reversedAt);
  return { plans, checkins, dayCompletions, training, hook, flag, warnings, checkIn, voidVisit, dayOn, live, get plan() { return plan; } };
}

test('a check-in on a gym day marks the day done by that visit', async () => {
  const s = await setup();
  const r = await s.checkIn(visit('c1', '2026-11-22'));
  assert.equal(r.results[0].completed, s.live()[0].id);
  const [row] = s.live();
  assert.equal(row.planId, s.plan.id);
  assert.equal(row.userId, 'm1');
  assert.equal(row.date, '2026-11-22');
  assert.equal(row.source, 'checkin');
  assert.equal(row.checkinId, 'c1');
  const day = await s.dayOn('2026-11-22');
  assert.equal(day.status, 'completed');
  assert.deepEqual(day.completedBy, { source: 'checkin', checkinId: 'c1', completedAt: '2026-11-22T06:00:00.000Z' });
});

test('a check-in also completes a gym day that has a suggested workout', async () => {
  const s = await setup();
  await s.checkIn(visit('c1', '2026-11-25'));
  const day = await s.dayOn('2026-11-25');
  assert.equal(day.status, 'completed');
  assert.equal(day.completedBy.source, 'checkin');
  const v = await s.training.viewPlan(await s.plans.findByIdAsync(s.plan.id));
  assert.equal(v.progress.byCheckin, 1);
});

test('PD-5: a check-in on a home day, a rest day or outside the programme is not counted', async () => {
  const s = await setup();
  assert.equal((await s.checkIn(visit('c1', '2026-11-20'))).results[0].skipped, 'not_a_gym_day');
  assert.equal((await s.checkIn(visit('c2', '2026-11-21'))).results[0].skipped, 'not_a_gym_day');
  assert.equal((await s.checkIn(visit('c3', '2026-11-30'))).results[0].skipped, 'not_in_programme');
  assert.equal(s.dayCompletions.rows.length, 0);
});

test('a second visit the same day keeps one completion, for the first visit', async () => {
  const s = await setup();
  await s.checkIn(visit('c1', '2026-11-22'));
  const again = await s.checkIn(visit('c2', '2026-11-22', { gymId: 'g2', timestamp: '2026-11-22T14:00:00.000Z' }));
  assert.equal(again.results[0].skipped, 'already_done');
  assert.equal(s.dayCompletions.rows.length, 1);
  assert.equal(s.live()[0].checkinId, 'c1');
});

test('the day of a visit is its East Africa business day', async () => {
  const s = await setup();
  // 22:30 UTC on the 21st is 01:30 EAT on the 22nd (no businessDate on an older row).
  await s.checkIn(visit('c1', '2026-11-21', { timestamp: '2026-11-21T22:30:00.000Z', businessDate: undefined }));
  assert.equal(s.live()[0].date, '2026-11-22');
});

test('voiding the only visit that day reopens the gym day', async () => {
  const s = await setup();
  await s.checkIn(visit('c1', '2026-11-22'));
  const r = await s.voidVisit('c1');
  assert.equal(r.checkin.status, 'voided');
  assert.equal(s.live().length, 0);
  const [row] = s.dayCompletions.rows;
  assert.ok(row.reversedAt);
  assert.equal(row.reversedReason, 'check-in voided: Scanned by mistake');
  const day = await s.dayOn('2026-11-22');
  assert.equal(day.status, 'planned');
  assert.equal(day.completedBy, null);
});

test('voiding one of two visits that day keeps the day done, now by the other visit', async () => {
  const s = await setup();
  await s.checkIn(visit('c1', '2026-11-22'));
  await s.checkIn(visit('c2', '2026-11-22', { gymId: 'g2', timestamp: '2026-11-22T14:00:00.000Z' }));
  await s.voidVisit('c1');
  assert.equal(s.dayCompletions.rows.length, 1);
  const [row] = s.live();
  assert.equal(row.checkinId, 'c2');
  assert.equal(row.completedAt, '2026-11-22T14:00:00.000Z');
  assert.equal((await s.dayOn('2026-11-22')).completedBy.checkinId, 'c2');
});

test('a visit after a voided one completes the day again', async () => {
  const s = await setup();
  await s.checkIn(visit('c1', '2026-11-22'));
  await s.voidVisit('c1');
  await s.checkIn(visit('c2', '2026-11-22', { timestamp: '2026-11-22T15:00:00.000Z' }));
  assert.equal(s.dayCompletions.rows.length, 2, 'the reversed row is kept');
  assert.equal(s.live()[0].checkinId, 'c2');
});

test('voiding a visit that completed nothing changes nothing', async () => {
  const s = await setup();
  await s.checkIn(visit('c1', '2026-11-20')); // a home day
  await s.voidVisit('c1');
  assert.equal(s.dayCompletions.rows.length, 0);
});

test('PD-6: a visit the owner records by hand completes the gym day', async () => {
  const s = await setup();
  const seen = [];
  const svc = createMemberManagementService({
    users: store([{ id: 'm1', userType: 'member' }]),
    gyms: [{ id: 'g1', name: 'Gym One', tier: 'standard' }],
    subscriptions: store([{ id: 'sub-direct', memberId: 'm1', type: 'direct_sub', plan: 'monthly', homeGymId: 'g1', status: 'active', startedAt: '2026-10-01T07:00:00Z', expiresAt: '2099-01-01T00:00:00Z' }]),
    checkins: s.checkins, paymentRequests: store(), publicUserId: async () => 'FM001',
    // The manual path stamps the real clock; the visit is moved onto the programme's gym day here.
    onManualVisit: async row => { seen.push(row); await s.hook.recordCheckin({ ...row, businessDate: '2026-11-22', timestamp: '2026-11-22T06:00:00.000Z' }); },
  });
  const r = await svc.checkInMember({ owner: { id: 'o1', userType: 'gym_operator', gymIds: ['g1'] }, memberId: 'm1', gymId: 'g1' });
  assert.equal(r.ok, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(seen.length, 1, 'the hook ran once');
  assert.equal(seen[0].source, CHECKIN_SOURCE.OWNER_MANUAL);
  assert.equal(seen[0].id, r.checkin.id);
  assert.equal(s.live()[0].checkinId, r.checkin.id);
});

test('a manual visit is recorded even when the hook fails', async () => {
  const s = await setup();
  const svc = createMemberManagementService({
    users: store([{ id: 'm1', userType: 'member' }]),
    gyms: [{ id: 'g1', name: 'Gym One', tier: 'standard' }],
    subscriptions: store([{ id: 'sub-direct', memberId: 'm1', type: 'direct_sub', plan: 'monthly', homeGymId: 'g1', status: 'active', startedAt: '2026-10-01T07:00:00Z', expiresAt: '2099-01-01T00:00:00Z' }]),
    checkins: s.checkins, paymentRequests: store(), publicUserId: async () => 'FM001',
    onManualVisit: async () => { throw new Error('boom'); },
  });
  const r = await svc.checkInMember({ owner: { id: 'o1', userType: 'gym_operator', gymIds: ['g1'] }, memberId: 'm1', gymId: 'g1' });
  assert.equal(r.ok, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.checkins.rows.length, 1);
});

test('with PROGRAMMES_CATALOGUE off the hook does nothing', async () => {
  const s = await setup({ on: false });
  assert.deepEqual(await s.checkIn(visit('c1', '2026-11-22')), { skipped: 'disabled' });
  assert.equal(s.dayCompletions.rows.length, 0);
  s.flag.on = true;
  await s.checkIn(visit('c2', '2026-11-22'));
  s.flag.on = false;
  await s.voidVisit('c2');
  assert.equal(s.live().length, 1, 'a void while off leaves the row as it is');
});

test('a member with no programme, or an ended one, gets nothing', async () => {
  const none = await setup({ start: false });
  assert.deepEqual((await none.checkIn(visit('c1', '2026-11-22'))).results, []);
  const s = await setup();
  await s.plans.updateByIdAsync(s.plan.id, { status: 'cancelled' });
  assert.deepEqual((await s.checkIn(visit('c1', '2026-11-22'))).results, []);
  assert.equal(s.dayCompletions.rows.length, 0);
});

test('the hook never throws: a store failure is logged and the check-in goes on', async () => {
  const s = await setup();
  s.dayCompletions.insertAsync = async () => { throw new Error('db down'); };
  assert.deepEqual(await s.hook.recordCheckin(visit('c1', '2026-11-22')), { error: 'failed' });
  s.dayCompletions.filterByColumnAsync = async () => { throw new Error('db down'); };
  assert.deepEqual(await s.hook.reverseCheckin(visit('c1', '2026-11-22'), 'x'), { error: 'failed' });
  assert.equal(s.warnings.length, 2);
});

test('the same-moment unique clash is treated as already done', async () => {
  const s = await setup();
  s.dayCompletions.insertAsync = async () => {
    throw Object.assign(new Error('duplicate key value violates unique constraint "ProgrammeDayCompletion_live_day"'), { code: '23505' });
  };
  const r = await s.hook.recordCheckin(visit('c1', '2026-11-22'));
  assert.equal(r.results[0].skipped, 'already_done');
  assert.equal(s.warnings.length, 0);
});
