// FitFlex's management of the exercise library: adding, editing and
// switching off exercises, and plans picking the changes up.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXERCISES, exerciseById, liveExercises, listExercises, mergeLibrary, setLiveLibrary,
} from '../src/shared/exercise-library.mjs';
import { createExerciseAdminService } from '../src/services/training/exercise-admin-service.mjs';
import { buildRecommendationInput, createRecommendationEngine } from '../src/services/training/recommendation-engine.mjs';
import { createRulesRecommendationProvider } from '../src/services/training/rules-recommendation-provider.mjs';

function store(rows = []) {
  const clone = r => JSON.parse(JSON.stringify(r));
  return {
    rows, fail: false,
    async allAsync() { if (this.fail) throw new Error('db is down'); return rows.map(clone); },
    async insertAsync(row) { rows.push(clone(row)); return row; },
    async updateByIdAsync(id, patch) { const r = rows.find(x => x.id === id); Object.assign(r, clone(patch)); return clone(r); },
    async removeByIdAsync(id) { const i = rows.findIndex(x => x.id === id); return i < 0 ? null : rows.splice(i, 1)[0]; },
  };
}

let clock = new Date('2026-10-12T09:00:00.000Z');
function setup() {
  clock = new Date('2026-10-12T09:00:00.000Z');
  const exercises = store();
  const auditLog = store();
  const svc = createExerciseAdminService({ exercises, auditLog, now: () => clock, logger: { warn() {} } });
  return { exercises, auditLog, svc };
}
// Every test leaves the live library as FitFlex shipped it.
afterEach(() => setLiveLibrary(EXERCISES));

const kettlebell = {
  name: 'Kettlebell Swing', description: 'A hip hinge that swings a kettlebell to chest height.',
  category: 'strength', targetAreas: ['glutes'], secondaryAreas: ['hamstrings'], movementPattern: 'hinge',
  difficulty: 'beginner', equipment: ['other'], environment: ['gym', 'home'], suitableGoals: ['gain_muscle', 'stay_fit'],
  defaultSets: 3, defaultReps: 15, restSeconds: 60, tracksWeight: true,
  instructions: ['Hinge at the hips with a flat back.', 'Drive your hips forward to swing the bell up.'],
  alternatives: ['ex_glute_bridge'],
};

test('the library starts as FitFlex shipped it, each exercise marked as built in', async () => {
  const { svc } = setup();
  const { exercises } = await svc.list();
  assert.equal(exercises.length, EXERCISES.length);
  assert.ok(exercises.every(e => e.source === 'builtin'));
  assert.equal(svc.builtInCount, EXERCISES.length);
});

test('a new exercise joins the library and can be chosen for plans', async () => {
  const s = setup();
  const { exercise } = await s.svc.create('admin_1', kettlebell);
  assert.equal(exercise.id, 'ex_kettlebell_swing');
  assert.equal(exercise.source, 'custom');
  assert.equal(exercise.active, true);
  assert.equal(exercise.defaultDuration, undefined);
  assert.equal(s.exercises.rows[0].updatedBy, 'admin_1');

  assert.equal(exerciseById('ex_kettlebell_swing').name, 'Kettlebell Swing', 'live straight away');
  assert.equal(liveExercises().length, EXERCISES.length + 1);
  assert.ok(listExercises({ area: 'glutes', equipment: ['other'] }).some(e => e.id === 'ex_kettlebell_swing'));
  assert.ok(!listExercises({ area: 'glutes', equipment: ['none'] }).some(e => e.id === 'ex_kettlebell_swing'), 'still needs its equipment');

  // A second one with the same name gets its own id.
  assert.equal((await s.svc.create('admin_1', kettlebell)).exercise.id, 'ex_kettlebell_swing_2');
  assert.deepEqual(s.auditLog.rows.map(a => [a.action, a.target]), [['exercise_created', 'ex_kettlebell_swing'], ['exercise_created', 'ex_kettlebell_swing_2']]);
});

test('editing a built-in keeps FitFlex\'s version; only what was sent changes', async () => {
  const s = setup();
  const before = EXERCISES.find(e => e.id === 'ex_push_up');
  const { exercise } = await s.svc.update('admin_1', 'ex_push_up', { defaultReps: 12, i18n: { sw: { name: 'Pushapu', instructions: ['Mikono chini ya mabega.', ''] } } });
  assert.equal(exercise.source, 'edited');
  assert.equal(exercise.defaultReps, 12);
  assert.equal(exercise.name, before.name);
  assert.deepEqual(exercise.targetAreas, before.targetAreas);
  assert.deepEqual(exercise.instructions, before.instructions);
  assert.deepEqual(exercise.i18n, { sw: { name: 'Pushapu', instructions: ['Mikono chini ya mabega.'] } }, 'blank lines dropped');
  assert.equal(exerciseById('ex_push_up').defaultReps, 12);
  assert.equal(EXERCISES.find(e => e.id === 'ex_push_up').defaultReps, before.defaultReps, 'the shipped library itself is untouched');
  assert.equal((await s.svc.list()).exercises.filter(e => e.source === 'edited').length, 1);

  // Counted or timed, never both: giving seconds makes it a timed exercise.
  const timed = (await s.svc.update('admin_1', 'ex_push_up', { defaultReps: null, defaultDuration: 40 })).exercise;
  assert.equal(timed.defaultDuration, 40);
  assert.equal(timed.defaultReps, undefined);
  assert.equal(s.exercises.rows[0].defaultReps, null, 'the old rep count is cleared in storage too');
  assert.equal(exerciseById('ex_push_up').defaultReps, undefined);

  // Back to how FitFlex shipped it.
  const back = (await s.svc.reset('admin_1', 'ex_push_up')).exercise;
  assert.equal(back.source, 'builtin');
  assert.equal(back.defaultReps, before.defaultReps);
  assert.equal(s.exercises.rows.length, 0);
  assert.equal((await s.svc.reset('admin_1', 'ex_push_up')).error, 'not_edited');
  assert.equal((await s.svc.reset('admin_1', 'ex_nope')).status, 404);
});

test('switching an exercise off takes it out of new plans, not out of the library', async () => {
  const s = setup();
  const profile = { fitnessGoals: ['gain_muscle'] };
  const engine = createRecommendationEngine({ providers: { rules: createRulesRecommendationProvider() }, beforeRecommend: () => s.svc.ensureFresh() });
  const plan = async () => (await engine.recommend(buildRecommendationInput({ profile, startDate: '2026-10-12', durationWeeks: 1 }))).draft;
  const uses = (d, id) => d.weeks.flatMap(w => w.days).flatMap(x => x.workout.exercises).some(e => e.libraryId === id);
  assert.ok(uses(await plan(), 'ex_push_up'));

  const off = (await s.svc.update('admin_1', 'ex_push_up', { active: false })).exercise;
  assert.equal(off.active, false);
  assert.ok(!uses(await plan(), 'ex_push_up'), 'not chosen any more');
  assert.equal(exerciseById('ex_push_up').name, 'Push-up', 'workouts that already name it still find it');
  assert.ok((await s.svc.list()).exercises.some(e => e.id === 'ex_push_up' && !e.active), 'the admin still sees it');
  assert.equal(s.auditLog.rows.at(-1).action, 'exercise_deactivated');

  await s.svc.update('admin_1', 'ex_push_up', { active: true });
  assert.ok(uses(await plan(), 'ex_push_up'));
  assert.equal(s.auditLog.rows.at(-1).action, 'exercise_activated');
});

test('what is saved is checked, and the field at fault is named', async () => {
  const s = setup();
  const bad = async (patch, field) => {
    const out = await s.svc.create('admin_1', { ...kettlebell, ...patch });
    assert.equal(out.error, 'invalid_exercise', JSON.stringify(patch));
    assert.equal(out.field, field, JSON.stringify(patch));
  };
  await bad({ name: '  ' }, 'name');
  await bad({ category: 'dance' }, 'category');
  await bad({ targetAreas: [] }, 'targetAreas');
  await bad({ targetAreas: ['elbows'] }, 'targetAreas');
  await bad({ equipment: [] }, 'equipment');
  await bad({ difficulty: 'expert' }, 'difficulty');
  await bad({ suitableGoals: [] }, 'suitableGoals');
  await bad({ defaultSets: 0 }, 'defaultSets');
  await bad({ defaultReps: null }, 'defaultReps_or_defaultDuration');
  await bad({ instructions: [] }, 'instructions');
  await bad({ instructions: Array(9).fill('Do it.') }, 'instructions');
  await bad({ alternatives: ['ex_does_not_exist'] }, 'alternatives');
  assert.equal(s.exercises.rows.length, 0, 'nothing was saved');
  assert.equal((await s.svc.update('admin_1', 'ex_nope', { name: 'x' })).status, 404);
  // An exercise can't be its own alternative.
  assert.equal((await s.svc.update('admin_1', 'ex_push_up', { alternatives: ['ex_push_up'] })).field, 'alternatives');
});

test('the library is re-read after a minute, so a change made on one server reaches the others', async () => {
  const s = setup();
  await s.svc.ensureFresh();
  // Another server saves a change.
  s.exercises.rows.push({ ...EXERCISES.find(e => e.id === 'ex_plank'), name: 'Front Plank' });
  await s.svc.ensureFresh();
  assert.equal(exerciseById('ex_plank').name, 'Plank', 'not yet: this copy is still fresh');
  clock = new Date(+clock + 61_000);
  await s.svc.ensureFresh();
  assert.equal(exerciseById('ex_plank').name, 'Front Plank');
});

test('if the changes cannot be read, plans go on from the last good library', async () => {
  const s = setup();
  await s.svc.update('admin_1', 'ex_plank', { name: 'Front Plank' });
  s.exercises.fail = true;
  clock = new Date(+clock + 61_000);
  await s.svc.ensureFresh(); // must not throw
  assert.equal(exerciseById('ex_plank').name, 'Front Plank');
  assert.ok(listExercises({}).length >= EXERCISES.length - 1);
});

test('merging: stored rows replace built-ins by id, others are added', () => {
  const merged = mergeLibrary([{ id: 'ex_plank', name: 'Changed' }, { id: 'ex_new', name: 'New' }], [{ id: 'ex_plank', name: 'Plank' }, { id: 'ex_crunch', name: 'Crunch' }]);
  assert.deepEqual(merged.map(e => [e.id, e.name, e.source]), [['ex_plank', 'Changed', 'edited'], ['ex_crunch', 'Crunch', 'builtin'], ['ex_new', 'New', 'custom']]);
});
