// Programmes P1, slice B2: members browse live programmes and start one. A
// started programme is their training plan, day by day, with gym, home and
// rest days; a gym day is done by a workout or by a check-in that day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProgrammeService } from '../src/services/training/programme-service.mjs';
import { createTrainingPlanService } from '../src/services/training/training-plan-service.mjs';
import { createWorkoutService } from '../src/services/workout-service.mjs';

function store(rows = []) {
  const clone = r => JSON.parse(JSON.stringify(r));
  return {
    rows,
    async allAsync() { return rows.map(clone); },
    async filterByColumnAsync(col, v) { return rows.filter(r => r[col] === v).map(clone); },
    async filterByColumnInAsync(col, values) { return rows.filter(r => values.includes(r[col])).map(clone); },
    async findByIdAsync(id) { const r = rows.find(x => x.id === id); return r ? clone(r) : null; },
    async insertAsync(row) { rows.push(clone(row)); return row; },
    async updateByIdAsync(id, patch) { const r = rows.find(x => x.id === id); Object.assign(r, clone(patch)); return clone(r); },
    async removeByIdAsync(id) { const i = rows.findIndex(x => x.id === id); return i < 0 ? null : rows.splice(i, 1)[0]; },
  };
}

// Friday 20 Nov 2026, 09:00 EAT.
let clock;
const at = iso => { clock = new Date(iso); };

const workout = name => ({
  name, activityType: 'functional', estimatedDuration: 20,
  exercises: [{ exerciseName: 'Bodyweight Squat', libraryId: 'ex_bodyweight_squat', sets: 2, reps: 10 }],
});
const days7 = [
  { type: 'home', workout: workout('Day 1') }, { type: 'rest' }, { type: 'gym' },
  { type: 'home', workout: workout('Day 4') }, { type: 'rest' }, { type: 'gym', workout: workout('Suggested') }, { type: 'home', workout: workout('Day 7') },
];
const body = extra => ({
  title: '7-day home starter', summary: 'Build the habit.',
  i18n: { sw: { title: '[SW] 7-day home starter', summary: '[SW] Build the habit.' } },
  goal: 'stay_fit', level: 'beginner', environment: 'home', equipment: ['none'], lengthDays: 7, days: days7, ...extra,
});

async function setup() {
  at('2026-11-20T06:00:00.000Z');
  const programmes = store();
  const plans = store();
  const workouts = store();
  const activities = store();
  const users = store([{ id: 'm1', userType: 'member', memberProfile: { weightKg: 70 } }]);
  const dayCompletions = store();
  const now = () => clock;
  const admin = createProgrammeService({ programmes, plans, now, logger: { warn() {} } });
  const training = createTrainingPlanService({ plans, workouts, users, engine: null, dayCompletions, now });
  const workoutService = createWorkoutService({ workouts, activities, users, now });
  const publish = async (extra) => {
    const { programme } = await admin.create('admin_1', body(extra));
    await admin.publish('admin_1', programme.id);
    return programme.id;
  };
  const start = async (id, b = {}) => {
    const found = await admin.startable(id);
    return found.error ? found : training.startProgramme('m1', found.programme, b);
  };
  return { programmes, plans, workouts, users, dayCompletions, admin, training, workoutService, publish, start };
}

test('the catalogue lists live programmes only, without days, in the member\'s language', async () => {
  const s = await setup();
  const live = await s.publish();
  await s.admin.create('admin_1', body({ title: 'Still a draft' }));
  const retired = await s.publish({ title: 'Old one' });
  await s.admin.retire('admin_1', retired);

  const { programmes } = await s.admin.catalogue({});
  assert.deepEqual(programmes.map(p => p.id), [live]);
  const [p] = programmes;
  assert.equal(p.days, undefined);
  assert.deepEqual(p.dayCounts, { gym: 2, home: 3, rest: 2 });
  assert.deepEqual(p.dayTypes, ['home', 'rest', 'gym', 'home', 'rest', 'gym', 'home']);
  assert.equal(p.free, true);
  assert.equal(p.createdBy, undefined, 'no authoring fields');
  assert.equal((await s.admin.catalogue({ lang: 'sw' })).programmes[0].title, '[SW] 7-day home starter');
});

test('catalogue filters: goal, level, place (any matches all), length range; bad filters are named', async () => {
  const s = await setup();
  const home = await s.publish();
  const gym14 = await s.publish({
    title: 'Gym 14', goal: 'build_muscle', level: 'intermediate', environment: 'gym', lengthDays: 14,
  });
  const anywhere = await s.publish({ title: 'Anywhere 21', environment: 'any', lengthDays: 21 });
  const ids = async q => (await s.admin.catalogue(q)).programmes.map(p => p.id).sort();

  assert.deepEqual(await ids({ goal: 'build_muscle' }), [gym14]);
  assert.deepEqual(await ids({ level: 'beginner' }), [anywhere, home].sort());
  assert.deepEqual(await ids({ environment: 'home' }), [anywhere, home].sort());
  assert.deepEqual(await ids({ environment: 'gym' }), [anywhere, gym14].sort());
  assert.deepEqual(await ids({ minDays: '14', maxDays: '14' }), [gym14]);
  assert.deepEqual(await ids({ minDays: 28 }), []);
  for (const [q, field] of [[{ goal: 'fly' }, 'goal'], [{ level: 'pro' }, 'level'], [{ environment: 'moon' }, 'environment'], [{ minDays: 'x' }, 'minDays'], [{ maxDays: '1.5' }, 'maxDays']]) {
    const r = await s.admin.catalogue(q);
    assert.deepEqual([r.status, r.error, r.field], [400, 'invalid_filter', field]);
  }
});

test('a member sees a live programme\'s days; drafts and retired ones are not found', async () => {
  const s = await setup();
  const live = await s.publish();
  const { programme } = await s.admin.forMember(live, 'en');
  assert.equal(programme.days.length, 7);
  assert.deepEqual(programme.days[0], { day: 1, type: 'home', workout: { name: 'Day 1', activityType: 'functional', estimatedDuration: 20, exerciseCount: 1 } });
  assert.deepEqual(programme.days[2], { day: 3, type: 'gym', workout: null });
  const draft = (await s.admin.create('admin_1', body())).programme.id;
  assert.equal((await s.admin.forMember(draft)).status, 404);
  assert.equal((await s.admin.forMember('prg_missing')).status, 404);
  assert.equal((await s.admin.startable(draft)).error, 'programme_unavailable');
  assert.equal((await s.admin.startable('prg_missing')).status, 404);
});

test('starting a programme makes a day-by-day plan; home and suggested gym workouts become planned workouts', async () => {
  const s = await setup();
  const id = await s.publish();
  const { plan } = await s.start(id, { lang: 'sw' });
  assert.equal(plan.programmeId, id);
  assert.equal(plan.name, '[SW] 7-day home starter');
  assert.deepEqual([plan.startDate, plan.endDate, plan.lengthDays, plan.durationWeeks], ['2026-11-20', '2026-11-26', 7, 1]);
  assert.equal(plan.engine, 'programme');
  const days = plan.weeks.flatMap(w => w.days);
  assert.deepEqual(days.map(d => [d.programmeDay, d.date, d.type, d.status]), [
    [1, '2026-11-20', 'home', 'planned'], [2, '2026-11-21', 'rest', 'rest'], [3, '2026-11-22', 'gym', 'planned'],
    [4, '2026-11-23', 'home', 'planned'], [5, '2026-11-24', 'rest', 'rest'], [6, '2026-11-25', 'gym', 'planned'], [7, '2026-11-26', 'home', 'planned'],
  ]);
  assert.equal(days[0].day, 5, 'weekday kept for the existing plan screen (Friday)');
  assert.equal(days[2].workoutId, null, 'a gym day without a suggestion has no workout');
  assert.deepEqual(s.workouts.rows.map(w => [w.name, w.scheduledDate, w.source, w.trainingPlanId]), [
    ['Day 1', '2026-11-20', 'programme', plan.id], ['Day 4', '2026-11-23', 'programme', plan.id],
    ['Suggested', '2026-11-25', 'programme', plan.id], ['Day 7', '2026-11-26', 'programme', plan.id],
  ]);
  assert.equal(plan.today.programmeDay, 1);
  assert.equal(plan.next.programmeDay, 3);
  assert.deepEqual(
    [plan.progress.sessions, plan.progress.completed, plan.progress.currentDay, plan.progress.lengthDays, plan.progress.streak],
    [5, 0, 1, 7, 0],
  );
  const listed = await s.training.list('m1');
  assert.equal(listed.plans[0].sessions, 5, 'rest days are not sessions');
});

test('start date rules match plans: today to 30 days ahead', async () => {
  const s = await setup();
  const id = await s.publish();
  assert.equal((await s.start(id, { startDate: '2026-11-19' })).error, 'start_in_past');
  assert.equal((await s.start(id, { startDate: '2026-12-21' })).error, 'start_too_far');
  assert.equal((await s.start(id, { startDate: '20-11-2026' })).error, 'invalid_start_date');
  const { plan } = await s.start(id, { startDate: '2026-12-20' });
  assert.deepEqual([plan.startDate, plan.endDate], ['2026-12-20', '2026-12-26']);
  assert.equal(plan.today, null, 'not started yet');
});

test('a member on another plan must say replace; replacing ends it and clears its unstarted workouts', async () => {
  const s = await setup();
  const id = await s.publish();
  s.plans.rows.push({ id: 'tpn_old', userId: 'm1', name: 'Trainer plan', status: 'active', startDate: '2026-11-16', endDate: '2026-12-13', weeks: [], durationWeeks: 4, trainerId: 'trn_1' });
  s.workouts.rows.push(
    { id: 'wkt_done', userId: 'm1', trainingPlanId: 'tpn_old', status: 'completed', scheduledDate: '2026-11-17', exercises: [] },
    { id: 'wkt_next', userId: 'm1', trainingPlanId: 'tpn_old', status: 'planned', scheduledDate: '2026-11-21', exercises: [] },
  );
  const refused = await s.start(id);
  assert.deepEqual([refused.status, refused.error, refused.planId], [409, 'active_plan_exists', 'tpn_old']);
  assert.equal(s.plans.rows.length, 1, 'nothing changed');

  const { plan } = await s.start(id, { replace: true });
  assert.equal(s.plans.rows.find(p => p.id === 'tpn_old').status, 'cancelled');
  assert.deepEqual(s.workouts.rows.filter(w => w.trainingPlanId === 'tpn_old').map(w => w.id), ['wkt_done'], 'finished work stays in history');
  assert.equal((await s.training.current('m1')).plan.id, plan.id);

  const again = await s.start(id, { replace: true });
  assert.deepEqual([again.status, again.error, again.planId], [409, 'already_on_programme', plan.id]);
});

test('a retired programme cannot be started; members already on it keep it', async () => {
  const s = await setup();
  const id = await s.publish();
  const { plan } = await s.start(id);
  await s.admin.retire('admin_1', id);
  assert.equal((await s.admin.startable(id)).error, 'programme_unavailable');
  assert.equal((await s.training.current('m1')).plan.id, plan.id);
  assert.equal((await s.admin.get(id)).programme.enrolled, 1);
});

test('days are done by workouts or check-ins; rest days never break the streak; a missed day does', async () => {
  const s = await setup();
  const id = await s.publish();
  const { plan } = await s.start(id);
  const dayOf = async n => (await s.training.current('m1')).plan.weeks.flatMap(w => w.days).find(d => d.programmeDay === n);

  // Day 1 (home): the workout is finished.
  const w1 = (await dayOf(1)).workoutId;
  await s.workoutService.start('m1', w1);
  const ex = s.workouts.rows.find(w => w.id === w1).exercises[0];
  const done = await s.workoutService.complete('m1', w1, { durationMinutes: 20, exercises: [{ id: ex.id, workoutSets: [{ id: ex.workoutSets[0].id, completed: true }] }] });
  assert.equal(done.error, undefined, done.error);
  assert.deepEqual((await dayOf(1)).completedBy, { source: 'workout', workoutId: w1 });

  // Day 2 is rest; day 3 (gym, no workout) is done by a check-in (as B3 will record it).
  at('2026-11-22T10:00:00.000Z');
  s.dayCompletions.rows.push({ id: 'pdc_1', planId: plan.id, userId: 'm1', date: '2026-11-22', source: 'checkin', checkinId: 'chk_1', completedAt: clock.toISOString(), reversedAt: null });
  let view = (await s.training.current('m1')).plan;
  assert.equal((await dayOf(2)).status, 'rest');
  assert.deepEqual((await dayOf(3)).completedBy, { source: 'checkin', checkinId: 'chk_1', completedAt: '2026-11-22T10:00:00.000Z' });
  assert.deepEqual([view.progress.completed, view.progress.streak, view.progress.bestStreak, view.progress.byWorkout, view.progress.byCheckin], [2, 2, 2, 1, 1]);
  assert.equal(view.today.programmeDay, 3);

  // A voided check-in (reversed completion) makes the day open again.
  s.dayCompletions.rows[0].reversedAt = clock.toISOString();
  assert.equal((await dayOf(3)).status, 'planned');
  s.dayCompletions.rows[0].reversedAt = null;

  // Day 4 is missed: the streak resets, the best one is kept. Day 6 (gym with a suggestion) is done by a check-in.
  at('2026-11-25T12:00:00.000Z');
  s.dayCompletions.rows.push({ id: 'pdc_2', planId: plan.id, userId: 'm1', date: '2026-11-25', source: 'checkin', checkinId: 'chk_2', completedAt: clock.toISOString(), reversedAt: null });
  view = (await s.training.current('m1')).plan;
  assert.equal((await dayOf(6)).status, 'completed', 'a check-in completes a gym day even with a suggested workout');
  assert.deepEqual([view.progress.missed, view.progress.streak, view.progress.bestStreak, view.progress.currentDay], [1, 1, 2, 6]);

  // After the last day the plan is completed.
  at('2026-11-27T06:00:00.000Z');
  const ended = (await s.training.get('m1', plan.id)).plan;
  assert.equal(ended.status, 'completed');
  assert.equal(ended.progress.currentDay, 7);
});

test('the member routes are behind PROGRAMMES_CATALOGUE, checked before sign-in', async () => {
  const before = process.env.PROGRAMMES_CATALOGUE;
  const { programmesCatalogue, programmeForMember, startProgramme } = await import('../functions/training.mjs');
  const run = async (ep) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let reached = false;
    await ep.onGuard[0]({ headers: {} }, res, () => { reached = true; });
    return { reached, status: res.statusCode, body: res.body };
  };
  try {
    delete process.env.PROGRAMMES_CATALOGUE;
    for (const ep of [programmesCatalogue, programmeForMember, startProgramme]) {
      assert.deepEqual(await run(ep), { reached: false, status: 404, body: { error: 'feature_disabled' } }, ep.path);
      assert.equal(ep.onGuard.length, 2, 'then the member sign-in check');
    }
    process.env.PROGRAMMES_CATALOGUE = 'true';
    assert.equal((await run(programmesCatalogue)).reached, true);
  } finally {
    if (before === undefined) delete process.env.PROGRAMMES_CATALOGUE; else process.env.PROGRAMMES_CATALOGUE = before;
  }
});
