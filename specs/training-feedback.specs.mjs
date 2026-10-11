// Training Plans, Phase E — calories on a finished workout, feedback on how
// it went, and the next plan taking that feedback into account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exerciseById } from '../src/shared/exercise-library.mjs';
import { buildRecommendationInput, createRecommendationEngine } from '../src/services/training/recommendation-engine.mjs';
import { createRulesRecommendationProvider } from '../src/services/training/rules-recommendation-provider.mjs';
import { createTrainingPlanService, exerciseHistory } from '../src/services/training/training-plan-service.mjs';
import { createWorkoutService, workoutCalories } from '../src/services/workout-service.mjs';

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

let clock = new Date('2026-10-12T06:00:00.000Z');
const now = () => clock;
const engine = createRecommendationEngine({ providers: { rules: createRulesRecommendationProvider() } });
const allSets = e => ({ id: e.id, workoutSets: e.workoutSets.map(x => ({ id: x.id, completed: true })) });

function setup(memberProfile = { fitnessGoals: ['gain_muscle'], weightKg: 70 }) {
  clock = new Date('2026-10-12T06:00:00.000Z');
  const s = {
    users: store([{ id: 'm1', userType: 'member', memberProfile }, { id: 'm2', userType: 'member', memberProfile: {} }]),
    plans: store(), workouts: store(), activities: store(),
  };
  s.planSvc = createTrainingPlanService({ plans: s.plans, workouts: s.workouts, users: s.users, engine, now });
  s.svc = createWorkoutService({ workouts: s.workouts, activities: s.activities, users: s.users, now });
  /** Runs today's plan session for `minutes` and returns the completion. */
  s.finishToday = async (minutes = 40) => {
    const { plan } = await s.planSvc.current('m1');
    const id = plan.today.workoutId;
    await s.svc.start('m1', id);
    const w = (await s.svc.get('m1', id)).workout;
    clock = new Date(+clock + minutes * 60000);
    return s.svc.complete('m1', id, { exercises: w.exercises.map(allSets) });
  };
  return s;
}

test('calories: from the kind of session, its length and body weight', () => {
  assert.equal(workoutCalories({ activityType: 'strength', minutes: 60, weightKg: 70 }), 245);
  assert.equal(workoutCalories({ activityType: 'hiit', minutes: 30, weightKg: 70 }), 280);
  assert.equal(workoutCalories({ activityType: 'mobility', minutes: 30, weightKg: 70 }), 88);
  assert.ok(workoutCalories({ activityType: 'hiit', minutes: 30, weightKg: 90 }) > workoutCalories({ activityType: 'hiit', minutes: 30, weightKg: 60 }));
  assert.equal(workoutCalories({ activityType: 'something_new', minutes: 60, weightKg: 70 }), 245, 'unknown kinds count as moderate');
  // No weight, no number — never a guess.
  assert.equal(workoutCalories({ activityType: 'strength', minutes: 60, weightKg: null }), null);
  assert.equal(workoutCalories({ activityType: 'strength', minutes: 60, weightKg: 5 }), null);
  assert.equal(workoutCalories({ activityType: 'strength', minutes: 0, weightKg: 70 }), null);
});

test('a finished workout records its calories on the Activity', async () => {
  const s = setup();
  await s.planSvc.generate('m1', {});
  const done = await s.finishToday(40);
  assert.equal(done.activity.durationMinutes, 40);
  assert.equal(done.activity.calories, 163, '3.5 MET × 70 kg × 40 min');
  assert.equal(s.activities.rows[0].calories, 163);

  const noWeight = setup({ fitnessGoals: ['gain_muscle'] });
  await noWeight.planSvc.generate('m1', {});
  assert.equal((await noWeight.finishToday(40)).activity.calories, null, 'no weight on the profile');
});

test('feedback is saved on a finished workout and can be changed', async () => {
  const s = setup();
  const { plan } = await s.planSvc.generate('m1', {});
  const id = plan.today.workoutId;
  assert.equal((await s.svc.feedback('m1', id, { rating: 'just_right' })).error, 'not_completed', 'not before it is done');
  const { workout } = await s.finishToday();
  const [first, second] = workout.exercises;

  const rated = await s.svc.feedback('m1', id, { rating: 'too_hard' });
  assert.equal(rated.workout.feedback.rating, 'too_hard');
  assert.ok(rated.workout.feedback.at);

  const noted = await s.svc.feedback('m1', id, { exercises: [{ id: first.id, reason: 'couldnt_perform' }, { id: second.id, reason: 'didnt_enjoy' }] });
  assert.equal(noted.workout.exercises[0].feedback, 'couldnt_perform');
  assert.equal(noted.workout.feedback.rating, 'too_hard', 'the rating is kept');

  const changed = await s.svc.feedback('m1', id, { rating: 'just_right', exercises: [{ id: second.id, reason: null }] });
  assert.equal(changed.workout.feedback.rating, 'just_right');
  assert.equal(changed.workout.exercises[1].feedback, undefined, 'cleared');
  assert.equal(changed.workout.exercises[0].feedback, 'couldnt_perform');
  assert.equal(changed.workout.status, 'completed');
  assert.equal(s.activities.rows.length, 1, 'feedback never touches the Activity');

  assert.equal((await s.svc.feedback('m1', id, { rating: 'amazing' })).error, 'invalid_rating');
  assert.equal((await s.svc.feedback('m1', id, { exercises: [{ id: first.id, reason: 'boring' }] })).error, 'invalid_reason');
  assert.equal((await s.svc.feedback('m1', id, { exercises: [{ id: 'wex_nope', reason: 'didnt_enjoy' }] })).error, 'unknown_exercise');
  assert.equal((await s.svc.feedback('m1', id, {})).error, 'nothing_to_save');
  assert.equal((await s.svc.feedback('m2', id, { rating: 'too_easy' })).status, 404, 'someone else');
});

const rated = (date, rating, exercises = []) => ({ status: 'completed', scheduledDate: date, feedback: rating ? { rating } : null, exercises });
const ex = (libraryId, feedback) => ({ libraryId, feedback, workoutSets: [{ completed: true }] });

test('history: two of the last three ratings agreeing is a pattern', () => {
  assert.equal(exerciseHistory([rated('2026-10-01', 'too_hard')]).effort, null, 'one bad day');
  assert.equal(exerciseHistory([rated('2026-10-01', 'too_hard'), rated('2026-10-03', 'just_right'), rated('2026-10-05', 'too_hard')]).effort, 'easier');
  assert.equal(exerciseHistory([rated('2026-10-01', 'too_easy'), rated('2026-10-03', 'too_easy')]).effort, 'harder');
  assert.equal(exerciseHistory([rated('2026-10-01', 'too_easy'), rated('2026-10-03', 'too_hard'), rated('2026-10-05', 'just_right')]).effort, null);
  // Older sessions fall out of the picture; unrated ones don't count either way.
  assert.equal(exerciseHistory([
    rated('2026-09-01', 'too_hard'), rated('2026-09-03', 'too_hard'),
    rated('2026-10-01', 'just_right'), rated('2026-10-03', null), rated('2026-10-05', 'just_right'), rated('2026-10-07', 'too_easy'),
  ]).effort, null);
});

test('history: the newest word on an exercise is the one that counts', () => {
  const h = exerciseHistory([
    rated('2026-10-01', null, [ex('ex_push_up', 'didnt_enjoy'), ex('ex_plank', 'couldnt_perform')]),
    rated('2026-10-05', null, [ex('ex_push_up', 'equipment_unavailable'), ex('ex_crunch')]),
  ]);
  assert.deepEqual(h.feedback.sort((a, b) => a.exerciseId.localeCompare(b.exerciseId)), [
    { exerciseId: 'ex_plank', reason: 'couldnt_perform' },
    { exerciseId: 'ex_push_up', reason: 'equipment_unavailable' },
  ]);
});

const draftWith = async history => {
  const input = buildRecommendationInput({ profile: { fitnessGoals: ['gain_muscle'] }, startDate: '2026-10-12', durationWeeks: 4, history });
  return (await engine.recommend(input)).draft;
};
const all = draft => draft.weeks.flatMap(w => w.days).flatMap(d => d.workout.exercises);

test('the next plan eases off after "too hard" and asks more after "too easy"', async () => {
  const normal = await draftWith({});
  const easier = await draftWith({ effort: 'easier' });
  const harder = await draftWith({ effort: 'harder' });
  const sets = d => all(d).reduce((n, e) => n + e.sets, 0) / all(d).length;
  assert.ok(sets(easier) < sets(normal), 'fewer sets');
  assert.ok(all(easier).every(e => e.sets >= 2), 'never below two');

  const repsOf = (d, week) => d.weeks[week].days[0].workout.exercises.find(e => e.reps);
  const first = repsOf(normal, 0);
  const lib = exerciseById(first.libraryId);
  assert.equal(first.reps, lib.defaultReps);
  assert.equal(repsOf(easier, 3).reps, exerciseById(repsOf(easier, 3).libraryId).defaultReps, 'no weekly increase');
  assert.equal(repsOf(harder, 0).reps, exerciseById(repsOf(harder, 0).libraryId).defaultReps + 2, 'starts further on');
});

test('the next plan leaves out what they could not do, and rarely picks what they did not enjoy', async () => {
  const normal = await draftWith({});
  const count = (d, id) => all(d).filter(e => e.libraryId === id).length;
  assert.ok(count(normal, 'ex_push_up') > 0 && count(normal, 'ex_bodyweight_squat') > 0);

  const next = await draftWith({ feedback: [
    { exerciseId: 'ex_push_up', reason: 'couldnt_perform' },
    { exerciseId: 'ex_glute_bridge', reason: 'equipment_unavailable' },
    { exerciseId: 'ex_bodyweight_squat', reason: 'didnt_enjoy' },
  ] });
  assert.equal(count(next, 'ex_push_up'), 0);
  assert.equal(count(next, 'ex_glute_bridge'), 0);
  assert.ok(count(next, 'ex_bodyweight_squat') < count(normal, 'ex_bodyweight_squat'));
  assert.ok(next.weeks.every(w => w.days.length === 3), 'still a full plan');
});

test('end to end: feedback on this plan shapes the one after', async () => {
  const s = setup();
  const first = (await s.planSvc.generate('m1', { durationWeeks: 1 })).plan;
  for (const d of first.weeks[0].days) {
    clock = new Date(`${d.date}T06:00:00.000Z`);
    const { workout } = await s.finishToday();
    await s.svc.feedback('m1', workout.id, { rating: 'too_hard', exercises: [{ id: workout.exercises[0].id, reason: 'couldnt_perform' }] });
  }
  const refused = new Set(s.workouts.rows.flatMap(w => w.exercises).filter(e => e.feedback).map(e => e.libraryId));
  assert.ok(refused.size >= 1);

  clock = new Date('2026-10-19T06:00:00.000Z');
  const second = (await s.planSvc.generate('m1', { durationWeeks: 1 })).plan;
  const next = s.workouts.rows.filter(w => w.trainingPlanId === second.id).flatMap(w => w.exercises);
  assert.ok(next.length > 0);
  assert.ok(next.every(e => !refused.has(e.libraryId)), 'none of the exercises they could not do');
  const before = s.workouts.rows.filter(w => w.trainingPlanId === first.id).flatMap(w => w.exercises);
  const avg = rows => rows.reduce((n, e) => n + e.sets, 0) / rows.length;
  assert.ok(avg(next) < avg(before), 'and an easier load');
});
