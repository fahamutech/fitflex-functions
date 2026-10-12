// Plans a trainer makes for a client: laid out from the trainer's saved
// workouts and/or FitFlex's suggestion, offered, and taken or declined by
// the client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecommendationEngine } from '../src/services/training/recommendation-engine.mjs';
import { createRulesRecommendationProvider } from '../src/services/training/rules-recommendation-provider.mjs';
import { createTrainingPlanService } from '../src/services/training/training-plan-service.mjs';
import { createTrainerPlanService } from '../src/services/training/trainer-plan-service.mjs';
import { createWorkoutService } from '../src/services/workout-service.mjs';

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

// Monday 12 Oct 2026, 09:00 EAT.
let clock = new Date('2026-10-12T06:00:00.000Z');
const now = () => clock;
const engine = createRecommendationEngine({ providers: { rules: createRulesRecommendationProvider() } });

const savedWorkout = (id, name, trainerId = 't1') => ({
  id, trainerId, name, description: null, activityType: 'strength', estimatedDuration: 50,
  exercises: [
    { exerciseName: 'Coach special', sets: 3, reps: 8, tracksWeight: true },
    { exerciseName: 'Finisher', sets: 2, duration: 40 },
  ],
});

function setup({ permissions = {}, memberProfile = { fitnessGoals: ['improve_flexibility'], fitnessLevel: 'intermediate' } } = {}) {
  clock = new Date('2026-10-12T06:00:00.000Z');
  const sent = [];
  const s = {
    sent,
    users: store([
      { id: 'm1', userType: 'member', displayName: 'Asha', memberProfile },
      { id: 'u_t1', userType: 'trainer' }, { id: 'u_t2', userType: 'trainer' },
    ]),
    trainers: store([{ id: 't1', userId: 'u_t1', displayName: 'Coach Amani' }, { id: 't2', userId: 'u_t2', displayName: 'Coach Baraka' }]),
    relationships: store([
      { id: 'rel1', trainerId: 't1', memberId: 'm1', status: 'active', permissions },
      { id: 'rel2', trainerId: 't2', memberId: 'm1', status: 'pending', permissions: {} },
    ]),
    workoutPlans: store([savedWorkout('wpl_a', 'Push day'), savedWorkout('wpl_b', 'Leg day'), savedWorkout('wpl_other', 'Not mine', 't2')]),
    plans: store(), workouts: store(), activities: store(),
  };
  const notify = async (userId, m) => { sent.push([userId, m.type]); };
  s.member = createTrainingPlanService({ plans: s.plans, workouts: s.workouts, users: s.users, engine, trainers: s.trainers, relationships: s.relationships, notify, now });
  s.trainer = createTrainerPlanService({ plans: s.plans, workouts: s.workouts, users: s.users, relationships: s.relationships, trainers: s.trainers, workoutPlans: s.workoutPlans, engine, notify, now });
  s.workoutSvc = createWorkoutService({ workouts: s.workouts, activities: s.activities, users: s.users, now });
  return s;
}
const fromSaved = { name: 'Strength block', note: 'Go steady in week one.', durationWeeks: 2, days: [{ day: 1, planId: 'wpl_a' }, { day: 4, planId: 'wpl_b' }] };

test('a trainer offers a plan from their saved workouts; nothing changes for the client yet', async () => {
  const s = setup();
  const own = (await s.member.generate('m1', { durationWeeks: 1 })).plan;
  const before = s.workouts.rows.length;

  const { plan } = await s.trainer.offer('u_t1', 'rel1', fromSaved);
  assert.equal(plan.status, 'offered');
  assert.equal(plan.name, 'Strength block');
  assert.equal(plan.note, 'Go steady in week one.');
  assert.equal(plan.daysPerWeek, 2);
  assert.deepEqual(plan.weeks.map(w => w.days.map(d => [d.date, d.name])), [
    [['2026-10-12', 'Push day'], ['2026-10-15', 'Leg day']],
    [['2026-10-19', 'Push day'], ['2026-10-22', 'Leg day']],
  ]);
  assert.equal(plan.progress, undefined, 'no progress on an offer');
  assert.deepEqual(s.sent, [['m1', 'training_plan_offered']]);

  // The client still has their own plan and no new workouts.
  assert.equal(s.workouts.rows.length, before);
  assert.equal((await s.member.current('m1')).plan.id, own.id);
  assert.equal((await s.member.list('m1')).plans.length, 1, 'an offer is not in their history');

  const [offer] = (await s.member.offers('m1')).offers;
  assert.equal(offer.id, plan.id);
  assert.equal(offer.trainer.displayName, 'Coach Amani');
  assert.equal(offer.trainer.userId, undefined);
  assert.equal(offer.note, 'Go steady in week one.');
  assert.deepEqual(offer.weeks[0].days[0].exercises.map(e => e.exerciseName), ['Coach special', 'Finisher']);
  assert.equal(offer.weeks[0].days[0].estimatedDuration, 50);
});

test('accepting replaces the plan they were on and schedules the trainer\'s sessions', async () => {
  const s = setup();
  const own = (await s.member.generate('m1', { durationWeeks: 1 })).plan;
  const { plan: offered } = await s.trainer.offer('u_t1', 'rel1', fromSaved);

  const { plan } = await s.member.accept('m1', offered.id);
  assert.equal(plan.status, 'active');
  assert.equal(plan.createdByType, 'trainer');
  assert.equal(plan.trainer.displayName, 'Coach Amani');
  assert.equal(plan.progress.sessions, 4);
  assert.equal(plan.today.name, 'Push day');
  assert.equal(plan.weeks[0].days[0].workout, undefined, 'the stored outline is not sent twice');
  assert.equal((await s.member.get('m1', own.id)).plan.status, 'cancelled');
  assert.equal(s.workouts.rows.filter(w => w.trainingPlanId === own.id).length, 0, 'its unstarted sessions are gone');

  const rows = s.workouts.rows.filter(w => w.trainingPlanId === plan.id);
  assert.equal(rows.length, 4);
  assert.ok(rows.every(w => w.trainerId === 't1' && w.source === 'trainer' && w.status === 'planned'));
  assert.equal(rows[0].exercises[0].workoutSets.length, 3);
  assert.deepEqual(s.sent.at(-1), ['u_t1', 'training_plan_accepted']);
  assert.equal((await s.member.accept('m1', offered.id)).error, 'not_offered', 'only once');
  assert.deepEqual((await s.member.offers('m1')).offers, []);

  // The sessions run and complete like any workout, and move the plan on.
  await s.workoutSvc.start('m1', plan.today.workoutId);
  const w = (await s.workoutSvc.get('m1', plan.today.workoutId)).workout;
  const done = await s.workoutSvc.complete('m1', w.id, { exercises: w.exercises.map(e => ({ id: e.id, workoutSets: e.workoutSets.map(x => ({ id: x.id, completed: true })) })) });
  assert.equal(done.activity.trainerId, 't1');
  assert.equal((await s.member.current('m1')).plan.progress.completed, 1);
});

test('declining leaves everything as it was and tells the trainer', async () => {
  const s = setup();
  const own = (await s.member.generate('m1', { durationWeeks: 1 })).plan;
  const { plan: offered } = await s.trainer.offer('u_t1', 'rel1', fromSaved);
  assert.deepEqual(await s.member.decline('m1', offered.id), { declined: true });
  assert.equal((await s.member.current('m1')).plan.id, own.id);
  assert.deepEqual(s.sent.at(-1), ['u_t1', 'training_plan_declined']);
  assert.equal((await s.trainer.list('u_t1', 'rel1')).plans[0].status, 'declined');
  assert.equal((await s.member.accept('m1', offered.id)).error, 'not_offered');
});

test('an offer accepted late moves forward by whole weeks, keeping its weekdays', async () => {
  const s = setup();
  const { plan: offered } = await s.trainer.offer('u_t1', 'rel1', fromSaved);
  clock = new Date('2026-10-14T06:00:00.000Z'); // Wednesday: Monday's session has passed
  const { plan } = await s.member.accept('m1', offered.id);
  assert.equal(plan.startDate, '2026-10-19');
  assert.equal(plan.endDate, '2026-11-01');
  assert.deepEqual(plan.weeks[0].days.map(d => d.date), ['2026-10-19', '2026-10-22'], 'still Monday and Thursday');
  assert.equal(plan.progress.missed, 0);
});

test('FitFlex\'s suggestion uses the client\'s goal only when they share goals', async () => {
  const closed = setup();
  const a = await closed.trainer.suggest('u_t1', 'rel1', { durationWeeks: 1 });
  assert.equal(a.usedClientPreferences, false);
  assert.ok(!a.days.some(d => d.name === 'Mobility'), 'their flexibility goal is not used');
  assert.equal(a.days.length, 3);

  const open = setup({ permissions: { goals: true } });
  const b = await open.trainer.suggest('u_t1', 'rel1', { durationWeeks: 1 });
  assert.equal(b.usedClientPreferences, true);
  assert.ok(b.days.some(d => d.name === 'Mobility'), 'built for their goal');

  // What the trainer enters is used either way.
  const c = await closed.trainer.suggest('u_t1', 'rel1', { preferences: { goal: 'gain_muscle', daysPerWeek: 4, environment: 'gym' } });
  assert.equal(c.days.length, 4);
  assert.ok(c.days[0].exercises.length >= 3);
  assert.equal((await closed.trainer.suggest('u_t1', 'rel1', { preferences: { goal: 'nope' } })).error, 'invalid_goal');
  // Nothing was saved or sent by looking.
  assert.equal(closed.plans.rows.length, 0);
  assert.deepEqual(closed.sent, []);
});

test('a plan can mix FitFlex\'s sessions with the trainer\'s own', async () => {
  const s = setup({ permissions: { goals: true } });
  const idea = await s.trainer.suggest('u_t1', 'rel1', { durationWeeks: 2 });
  const [first, second] = idea.days;
  const { plan } = await s.trainer.offer('u_t1', 'rel1', {
    durationWeeks: 2, days: [{ day: first.day, suggested: true }, { day: second.day, planId: 'wpl_b' }],
  });
  assert.equal(plan.name, '2-week plan');
  assert.deepEqual(plan.weeks[0].days.map(d => d.name), [first.name, 'Leg day']);
  const accepted = (await s.member.accept('m1', plan.id)).plan;
  const rows = s.workouts.rows.filter(w => w.trainingPlanId === accepted.id);
  const suggested = rows.filter(w => w.name === first.name);
  assert.equal(suggested.length, 2);
  assert.ok(suggested[0].exercises.every(e => e.libraryId), 'FitFlex sessions keep their library link, so they can be swapped');
  assert.ok(rows.filter(w => w.name === 'Leg day').every(w => w.exercises.every(e => !e.libraryId)));
  // A day FitFlex has no session for can't be marked "suggested".
  const free = [1, 2, 3, 4, 5, 6, 7].find(d => !idea.days.some(x => x.day === d));
  assert.equal((await s.trainer.offer('u_t1', 'rel1', { days: [{ day: free, suggested: true }] })).error, 'no_suggestion_for_day');
});

test('the trainer sees progress only if the client shares workout history', async () => {
  const closed = setup();
  const a = (await closed.trainer.offer('u_t1', 'rel1', fromSaved)).plan;
  await closed.member.accept('m1', a.id);
  const seen = (await closed.trainer.list('u_t1', 'rel1')).plans[0];
  assert.equal(seen.status, 'active');
  assert.equal(seen.progress, undefined);
  assert.equal(seen.weeks[0].days[0].name, 'Push day', 'their own outline is always theirs to see');

  const open = setup({ permissions: { workoutHistory: true } });
  const b = (await open.trainer.offer('u_t1', 'rel1', fromSaved)).plan;
  await open.member.accept('m1', b.id);
  assert.deepEqual((await open.trainer.list('u_t1', 'rel1')).plans[0].progress, { sessions: 4, completed: 0, skipped: 0, missed: 0 });
});

test('a new offer takes the old one\'s place; an offer can be taken back', async () => {
  const s = setup();
  const first = (await s.trainer.offer('u_t1', 'rel1', fromSaved)).plan;
  const second = (await s.trainer.offer('u_t1', 'rel1', { ...fromSaved, name: 'Better block' })).plan;
  assert.deepEqual((await s.member.offers('m1')).offers.map(o => o.name), ['Better block']);
  assert.equal((await s.member.accept('m1', first.id)).error, 'not_offered');

  assert.deepEqual(await s.trainer.withdraw('u_t1', second.id), { cancelled: true });
  assert.deepEqual((await s.member.offers('m1')).offers, []);
  assert.equal((await s.trainer.withdraw('u_t1', second.id)).error, 'not_active');
  assert.equal((await s.trainer.withdraw('u_t2', second.id)).status, 404, 'another trainer');
});

test('either side can stop a plan the client is on; finished workouts stay', async () => {
  const s = setup();
  const offered = (await s.trainer.offer('u_t1', 'rel1', fromSaved)).plan;
  const { plan } = await s.member.accept('m1', offered.id);
  await s.workoutSvc.start('m1', plan.today.workoutId);
  const w = (await s.workoutSvc.get('m1', plan.today.workoutId)).workout;
  await s.workoutSvc.complete('m1', w.id, { exercises: w.exercises.map(e => ({ id: e.id, workoutSets: e.workoutSets.map(x => ({ id: x.id, completed: true })) })) });

  await s.trainer.withdraw('u_t1', plan.id);
  assert.equal((await s.member.current('m1')).plan, null);
  assert.deepEqual(s.workouts.rows.filter(x => x.trainingPlanId === plan.id).map(x => x.status), ['completed']);
  assert.deepEqual(s.sent.at(-1), ['m1', 'training_plan_stopped']);

  // And the member can stop one themselves, which tells the trainer.
  const again = (await s.trainer.offer('u_t1', 'rel1', fromSaved)).plan;
  await s.member.accept('m1', again.id);
  await s.member.cancel('m1', again.id);
  assert.deepEqual(s.sent.at(-1), ['u_t1', 'training_plan_stopped']);
});

test('only a connected trainer, with their own workouts, and a sensible layout', async () => {
  const s = setup();
  assert.equal((await s.trainer.offer('u_t2', 'rel2', fromSaved)).error, 'not_active', 'connection not accepted yet');
  assert.equal((await s.trainer.offer('u_t2', 'rel1', fromSaved)).status, 404, "someone else's client");
  assert.equal((await s.trainer.offer('u_nobody', 'rel1', fromSaved)).error, 'trainer_profile_not_found');
  assert.equal((await s.trainer.offer('u_t1', 'rel1', { days: [{ day: 1, planId: 'wpl_other' }] })).error, 'plan_not_found', "another trainer's workout");
  for (const days of [[], [{ day: 8, planId: 'wpl_a' }], [{ day: 1, planId: 'wpl_a' }, { day: 1, planId: 'wpl_b' }], [{ day: 1 }], [{ day: 1, planId: 'wpl_a', suggested: true }]]) {
    assert.equal((await s.trainer.offer('u_t1', 'rel1', { days })).error, 'invalid_days', JSON.stringify(days));
  }
  assert.equal((await s.trainer.offer('u_t1', 'rel1', { ...fromSaved, durationWeeks: 13 })).error, 'invalid_duration_weeks');
  assert.equal((await s.trainer.offer('u_t1', 'rel1', { ...fromSaved, startDate: '2026-10-01' })).error, 'start_in_past');
  assert.equal(s.plans.rows.length, 0);
  assert.equal((await s.member.accept('m1', 'tpn_nope')).status, 404);
});

test('an offer from a trainer the client has left can no longer be accepted', async () => {
  const s = setup();
  const offered = (await s.trainer.offer('u_t1', 'rel1', fromSaved)).plan;
  s.relationships.rows[0].status = 'ended';
  assert.equal((await s.member.accept('m1', offered.id)).error, 'offer_expired');
  assert.deepEqual((await s.member.offers('m1')).offers, []);
  assert.equal(s.workouts.rows.length, 0);
});

// ── Editing a plan that has been sent ───────────────────────────────────────

const finish = async (s, workoutId) => {
  await s.workoutSvc.start('m1', workoutId);
  const w = (await s.workoutSvc.get('m1', workoutId)).workout;
  return s.workoutSvc.complete('m1', w.id, { exercises: w.exercises.map(e => ({ id: e.id, workoutSets: e.workoutSets.map(x => ({ id: x.id, completed: true })) })) });
};

test('an offer still waiting is rewritten in place, quietly', async () => {
  const s = setup();
  const offered = (await s.trainer.offer('u_t1', 'rel1', fromSaved)).plan;
  assert.deepEqual(offered.layout, [{ day: 1, name: 'Push day', planId: 'wpl_a' }, { day: 4, name: 'Leg day', planId: 'wpl_b' }]);

  const { plan } = await s.trainer.edit('u_t1', offered.id, {
    name: 'Strength block v2', note: 'Three days now.', durationWeeks: 3,
    days: [{ day: 1, planId: 'wpl_b' }, { day: 3, planId: 'wpl_a' }, { day: 5, planId: 'wpl_b' }],
  });
  assert.equal(plan.id, offered.id, 'the same offer');
  assert.equal(plan.status, 'offered');
  assert.equal(plan.name, 'Strength block v2');
  assert.equal(plan.durationWeeks, 3);
  assert.equal(plan.daysPerWeek, 3);
  assert.equal(plan.endDate, '2026-11-01');
  assert.deepEqual(plan.weeks[0].days.map(d => [d.date, d.name]), [['2026-10-12', 'Leg day'], ['2026-10-14', 'Push day'], ['2026-10-16', 'Leg day']]);
  assert.equal(s.workouts.rows.length, 0, 'still nothing scheduled for the client');
  assert.deepEqual(s.sent, [['m1', 'training_plan_offered']], 'no second notification for an offer');

  const [offer] = (await s.member.offers('m1')).offers;
  assert.equal(offer.name, 'Strength block v2');
  assert.equal(offer.note, 'Three days now.');
  assert.equal(offer.weeks.length, 3);
  // And what they accept is the edited plan.
  const accepted = (await s.member.accept('m1', offered.id)).plan;
  assert.equal(accepted.progress.sessions, 9);
});

test('name and note alone change nothing else', async () => {
  const s = setup();
  const offered = (await s.trainer.offer('u_t1', 'rel1', fromSaved)).plan;
  const { plan } = await s.member.accept('m1', offered.id);
  const before = s.workouts.rows.map(w => w.id);
  const edited = (await s.trainer.edit('u_t1', plan.id, { name: 'Renamed', note: null })).plan;
  assert.equal(edited.name, 'Renamed');
  assert.equal(edited.note, null);
  assert.deepEqual(s.workouts.rows.map(w => w.id), before, 'the same workouts');
  assert.deepEqual(s.sent.at(-1), ['m1', 'training_plan_updated']);
  assert.equal((await s.member.current('m1')).plan.name, 'Renamed');
  assert.equal((await s.trainer.edit('u_t1', plan.id, {})).error, 'nothing_to_update');
  assert.equal((await s.trainer.edit('u_t1', plan.id, { name: '  ' })).error, 'invalid_name');
});

test('a plan the client is on changes from today forward; what they have done stays', async () => {
  const s = setup({ permissions: { workoutHistory: true } });
  const offered = (await s.trainer.offer('u_t1', 'rel1', fromSaved)).plan; // Mon + Thu, 2 weeks
  const { plan } = await s.member.accept('m1', offered.id);
  const monday = plan.today.workoutId;
  await finish(s, monday);

  // Wednesday of week one: Monday is done, Thursday and next week are ahead.
  clock = new Date('2026-10-14T06:00:00.000Z');
  const { plan: edited } = await s.trainer.edit('u_t1', plan.id, {
    durationWeeks: 3, days: [{ day: 2, planId: 'wpl_b' }, { day: 5, planId: 'wpl_a' }],
  });
  assert.equal(edited.status, 'active');
  assert.equal(edited.durationWeeks, 3);
  assert.deepEqual(edited.weeks.map(w => w.days.map(d => [d.date, d.name])), [
    [['2026-10-12', 'Push day'], ['2026-10-16', 'Push day']], // Monday kept; Tuesday already past, so only Friday is new
    [['2026-10-20', 'Leg day'], ['2026-10-23', 'Push day']],
    [['2026-10-27', 'Leg day'], ['2026-10-30', 'Push day']],
  ]);
  assert.deepEqual(edited.progress, { sessions: 6, completed: 1, skipped: 0, missed: 0 });

  const rows = s.workouts.rows.filter(w => w.trainingPlanId === plan.id);
  assert.equal(rows.length, 6);
  const kept = rows.find(w => w.id === monday);
  assert.equal(kept.status, 'completed', 'the finished workout is untouched');
  assert.ok(!rows.some(w => w.scheduledDate === '2026-10-15'), 'the old Thursday session is gone');
  assert.ok(rows.filter(w => w.id !== monday).every(w => w.status === 'planned' && w.trainerId === 't1' && w.scheduledDate >= '2026-10-14'));
  assert.equal(s.activities.rows.length, 1, 'and so is its Activity');
  assert.deepEqual(s.sent.at(-1), ['m1', 'training_plan_updated']);

  // The member sees the new plan straight away.
  const mine = (await s.member.current('m1')).plan;
  assert.equal(mine.next.date, '2026-10-16');
  assert.equal(mine.progress.completed, 1);
  assert.equal(mine.endDate, '2026-11-01');
});

test('a session the client has started or skipped is never replaced', async () => {
  const s = setup();
  const offered = (await s.trainer.offer('u_t1', 'rel1', { durationWeeks: 1, days: [{ day: 1, planId: 'wpl_a' }, { day: 2, planId: 'wpl_b' }, { day: 4, planId: 'wpl_a' }] })).plan;
  const { plan } = await s.member.accept('m1', offered.id);
  const [mon, tue] = plan.weeks[0].days;
  await s.workoutSvc.start('m1', mon.workoutId); // under way today
  await s.workoutSvc.skip('m1', tue.workoutId);

  const { plan: edited } = await s.trainer.edit('u_t1', plan.id, { days: [{ day: 1, planId: 'wpl_b' }, { day: 2, planId: 'wpl_a' }, { day: 3, planId: 'wpl_b' }] });
  const rows = s.workouts.rows.filter(w => w.trainingPlanId === plan.id);
  assert.equal(rows.find(w => w.id === mon.workoutId).status, 'in_progress');
  assert.equal(rows.find(w => w.id === mon.workoutId).name, 'Push day', 'not swapped under them');
  assert.equal(rows.find(w => w.id === tue.workoutId).status, 'skipped');
  assert.equal(rows.filter(w => w.scheduledDate === '2026-10-12').length, 1, 'no second session today');
  assert.equal(rows.filter(w => w.scheduledDate === '2026-10-13').length, 1);
  assert.deepEqual(edited.weeks[0].days.map(d => [d.date, d.name]), [['2026-10-12', 'Push day'], ['2026-10-13', 'Leg day'], ['2026-10-14', 'Leg day']]);
});

test('FitFlex sessions can be kept or swapped when editing', async () => {
  const s = setup({ permissions: { goals: true } });
  const idea = await s.trainer.suggest('u_t1', 'rel1', { durationWeeks: 2 });
  const [first, second] = idea.days;
  const offered = (await s.trainer.offer('u_t1', 'rel1', { durationWeeks: 2, days: [{ day: first.day, suggested: true }, { day: second.day, suggested: true }] })).plan;
  assert.deepEqual(offered.layout.map(d => d.suggested), [true, true]);
  const { plan } = await s.trainer.edit('u_t1', offered.id, { days: [{ day: first.day, suggested: true }, { day: second.day, planId: 'wpl_a' }] });
  assert.deepEqual(plan.layout, [
    { day: first.day, name: first.name, suggested: true },
    { day: second.day, name: 'Push day', planId: 'wpl_a' },
  ].sort((a, b) => a.day - b.day));
});

test('editing is refused when it would not make sense', async () => {
  const s = setup();
  const offered = (await s.trainer.offer('u_t1', 'rel1', fromSaved)).plan;
  assert.equal((await s.trainer.edit('u_t2', offered.id, { name: 'Mine now' })).status, 404, 'another trainer');
  assert.equal((await s.trainer.edit('u_t1', 'tpn_nope', { name: 'x' })).status, 404);
  assert.equal((await s.trainer.edit('u_t1', offered.id, { durationWeeks: 3 })).error, 'invalid_days', 'a new length needs the week');
  assert.equal((await s.trainer.edit('u_t1', offered.id, { days: [] })).error, 'invalid_days');
  assert.equal((await s.trainer.edit('u_t1', offered.id, { days: [{ day: 1, planId: 'wpl_other' }] })).error, 'plan_not_found');
  assert.equal((await s.trainer.edit('u_t1', offered.id, { days: fromSaved.days, durationWeeks: 13 })).error, 'invalid_duration_weeks');

  const { plan } = await s.member.accept('m1', offered.id);
  // A plan under way can't be cut to end before today.
  clock = new Date('2026-10-20T06:00:00.000Z');
  assert.equal((await s.trainer.edit('u_t1', plan.id, { days: fromSaved.days, durationWeeks: 1 })).error, 'invalid_duration_weeks');
  const before = JSON.stringify(s.workouts.rows);
  assert.equal(JSON.stringify(s.workouts.rows), before);

  // Once the client has left, or the plan is over, it is closed.
  s.relationships.rows[0].status = 'ended';
  assert.equal((await s.trainer.edit('u_t1', plan.id, { name: 'x' })).error, 'not_active');
  s.relationships.rows[0].status = 'active';
  await s.trainer.withdraw('u_t1', plan.id);
  assert.equal((await s.trainer.edit('u_t1', plan.id, { name: 'x' })).error, 'not_editable');
});
