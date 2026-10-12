// The exercise library as a file: export, edit in a spreadsheet, import.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EXERCISES, exerciseById, setLiveLibrary } from '../src/shared/exercise-library.mjs';
import { EXERCISE_COLUMNS, csvToExerciseRows, exercisesToCsv, parseCsv } from '../src/shared/exercise-csv.mjs';
import { createExerciseAdminService } from '../src/services/training/exercise-admin-service.mjs';

function store(rows = []) {
  const clone = r => JSON.parse(JSON.stringify(r));
  return {
    rows,
    async allAsync() { return rows.map(clone); },
    async insertAsync(row) { rows.push(clone(row)); return row; },
    async updateByIdAsync(id, patch) { const r = rows.find(x => x.id === id); Object.assign(r, clone(patch)); return clone(r); },
    async removeByIdAsync(id) { const i = rows.findIndex(x => x.id === id); return i < 0 ? null : rows.splice(i, 1)[0]; },
  };
}
function setup() {
  const exercises = store();
  const auditLog = store();
  const svc = createExerciseAdminService({ exercises, auditLog, now: () => new Date('2026-10-12T09:00:00.000Z'), logger: { warn() {} } });
  return { exercises, auditLog, svc };
}
afterEach(() => setLiveLibrary(EXERCISES));

const HEADER = EXERCISE_COLUMNS.map(c => c.label).join(',');
/** A file with the given header and rows of cells. */
const file = (header, ...rows) => [header, ...rows.map(r => r.map(c => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','))].join('\n');
const actions = out => out.rows.map(r => [r.id, r.action]);

test('CSV reading: quotes, doubled quotes, line breaks in a cell, blank rows, and the line each row starts on', () => {
  const rows = parseCsv('﻿a,b\r\n"x, y","he said ""go"""\n\n"two\nlines",z\n');
  assert.deepEqual(rows.map(r => r.cells), [['a', 'b'], ['x, y', 'he said "go"'], ['two\nlines', 'z']]);
  assert.deepEqual(rows.map(r => r.line), [1, 2, 4]);
  assert.deepEqual(parseCsv(''), []);
});

test('the whole library exports, one row an exercise, every field', async () => {
  const { svc } = setup();
  const { csv, count } = await svc.exportCsv();
  assert.equal(count, EXERCISES.length);
  const rows = parseCsv(csv);
  assert.equal(rows.length, EXERCISES.length + 1);
  assert.deepEqual(rows[0].cells, EXERCISE_COLUMNS.map(c => c.label));
  const pushUp = Object.fromEntries(rows[0].cells.map((h, i) => [h, rows.find(r => r.cells[0] === 'ex_push_up').cells[i]]));
  assert.equal(pushUp.name, 'Push-up');
  assert.equal(pushUp.target_areas, 'chest');
  assert.equal(pushUp.secondary_areas, 'triceps;shoulders;abs');
  assert.equal(pushUp.equipment, 'none');
  assert.equal(pushUp.sets, '3');
  assert.equal(pushUp.reps, '10');
  assert.equal(pushUp.seconds, '');
  assert.equal(pushUp.tracks_weight, 'no');
  assert.equal(pushUp.switched_on, 'yes');
  assert.match(pushUp.instructions, /^Hands under your shoulders.* \| .* \| /);
  assert.equal(pushUp.source, 'builtin');
});

test('exporting and importing unchanged changes nothing', async () => {
  const s = setup();
  // With an edit and an addition already in place, so stored rows round-trip too.
  await s.svc.update('admin', 'ex_plank', { i18n: { sw: { name: 'Ubao', instructions: ['Mikono chini.', 'Shikilia.'] } }, defaultDuration: 45 });
  await s.svc.create('admin', { ...EXERCISES[0], name: 'My Own Press', alternatives: ['ex_push_up'] });
  const stored = JSON.stringify(s.exercises.rows);
  const { csv } = await s.svc.exportCsv();

  const preview = await s.svc.importCsv('admin', csv);
  assert.equal(preview.applied, false);
  assert.deepEqual(preview.summary, { create: 0, update: 0, unchanged: EXERCISES.length + 1, errors: 0 });
  const applied = await s.svc.importCsv('admin', csv, { dryRun: false });
  assert.deepEqual(applied.summary, preview.summary);
  assert.equal(JSON.stringify(s.exercises.rows), stored, 'nothing was written');
  assert.ok((await s.svc.list()).exercises.filter(e => e.source === 'builtin').length === EXERCISES.length - 1, 'no built-in became "edited"');
});

test('a preview says what would change and writes nothing; applying makes exactly those changes', async () => {
  const s = setup();
  const csv = file('id,name,reps,sw_name,sw_instructions,switched_on',
    ['ex_push_up', 'Push-up', '12', 'Pushapu', 'Mikono chini ya mabega. | Shuka. | Sukuma juu.', 'yes'],
    ['ex_plank', 'Plank', '', '', '', 'no'],
    ['ex_crunch', 'Crunch', '15', '', '', 'yes']);

  const preview = await s.svc.importCsv('admin', csv);
  assert.deepEqual(actions(preview), [['ex_push_up', 'update'], ['ex_plank', 'update'], ['ex_crunch', 'unchanged']]);
  assert.deepEqual(preview.rows[0].changed.sort(), ['defaultReps', 'i18n']);
  assert.deepEqual(preview.rows[1].changed, ['active'], 'an empty reps cell on a timed exercise changes nothing');
  assert.deepEqual(preview.summary, { create: 0, update: 2, unchanged: 1, errors: 0 });
  assert.equal(s.exercises.rows.length, 0, 'a preview writes nothing');
  assert.equal(exerciseById('ex_push_up').defaultReps, 10);

  const done = await s.svc.importCsv('admin', csv, { dryRun: false });
  assert.equal(done.applied, true);
  const pushUp = exerciseById('ex_push_up');
  assert.equal(pushUp.defaultReps, 12);
  assert.deepEqual(pushUp.i18n.sw, { name: 'Pushapu', instructions: ['Mikono chini ya mabega.', 'Shuka.', 'Sukuma juu.'] });
  assert.deepEqual(pushUp.targetAreas, ['chest'], 'columns the file left out are kept');
  assert.equal(pushUp.instructions.length, 3);
  assert.equal(exerciseById('ex_plank').active, false);
  assert.equal(exerciseById('ex_plank').defaultDuration, 30);
  assert.equal(s.exercises.rows.length, 2, 'only the changed ones are stored');
  assert.deepEqual(s.auditLog.rows.map(a => [a.action, a.target]), [['exercise_updated', 'ex_push_up'], ['exercise_updated', 'ex_plank']]);
  // Exercises not in the file are untouched.
  assert.equal((await s.svc.list()).exercises.length, EXERCISES.length);
});

test('a file with only Swahili columns translates and touches nothing else', async () => {
  const s = setup();
  await s.svc.update('admin', 'ex_plank', { i18n: { sw: { name: 'Ubao', description: 'Kushikilia.' } } });
  const out = await s.svc.importCsv('admin', file('id,sw_instructions', ['ex_plank', 'Mikono chini. | Shikilia.']), { dryRun: false });
  assert.deepEqual(out.rows[0].changed, ['i18n']);
  assert.deepEqual(exerciseById('ex_plank').i18n.sw, { name: 'Ubao', description: 'Kushikilia.', instructions: ['Mikono chini.', 'Shikilia.'] }, 'the name and line already there are kept');
  assert.equal(exerciseById('ex_plank').name, 'Plank');
});

test('rows with no id add exercises, each with its own id', async () => {
  const s = setup();
  const row = ['', 'Kettlebell Swing', 'A hip hinge.', 'strength', 'glutes', 'hamstrings', 'hinge', 'beginner', 'other', 'gym;home', 'gain_muscle;stay_fit', '3', '15', '', '60', 'yes', 'Hinge at the hips. | Drive forward.', 'ex_glute_bridge', 'yes', 'Kuzungusha', '', '', ''];
  const out = await s.svc.importCsv('admin', file(HEADER, row, row), { dryRun: false });
  assert.deepEqual(actions(out), [['ex_kettlebell_swing', 'create'], ['ex_kettlebell_swing_2', 'create']]);
  const made = exerciseById('ex_kettlebell_swing');
  assert.deepEqual([made.category, made.targetAreas, made.equipment, made.environment], ['strength', ['glutes'], ['other'], ['gym', 'home']]);
  assert.deepEqual([made.defaultSets, made.defaultReps, made.tracksWeight, made.active], [3, 15, true, true]);
  assert.deepEqual(made.alternatives, ['ex_glute_bridge']);
  assert.equal(made.i18n.sw.name, 'Kuzungusha');
  assert.equal((await s.svc.list()).exercises.find(e => e.id === 'ex_kettlebell_swing').source, 'custom');
});

test('a row with a problem is reported with its line and field; the good rows still go through', async () => {
  const s = setup();
  const csv = file('id,name,target_areas,sets,reps,seconds,switched_on',
    ['ex_push_up', 'Push-up', 'chest', '4', '10', '', 'yes'],          // line 2: fine
    ['ex_plank', 'Plank', 'elbows', '3', '', '30', 'yes'],              // line 3: unknown area
    ['ex_nope', 'Ghost', 'chest', '3', '10', '', 'yes'],                // line 4: no such exercise
    ['ex_crunch', 'Crunch', 'abs', 'three', '15', '', 'yes'],           // line 5: sets not a number
    ['ex_dead_bug', 'Dead Bug', 'abs', '3', '12', '30', 'yes'],         // line 6: reps and seconds
    ['ex_push_up', 'Push-up', 'chest', '5', '10', '', 'yes'],           // line 7: same exercise twice
    ['ex_leg_raise', 'Lying Leg Raise', 'abs', '3', '10', '', 'maybe'], // line 8: not yes or no
    ['', '  ', 'abs', '3', '10', '', 'yes']);                           // line 9: a new one with no name
  const out = await s.svc.importCsv('admin', csv, { dryRun: false });
  assert.deepEqual(out.rows.map(r => [r.line, r.action, r.error ?? null, r.field ?? null]), [
    [2, 'update', null, null],
    [3, 'error', 'invalid_exercise', 'targetAreas'],
    [4, 'error', 'unknown_id', 'id'],
    [5, 'error', 'invalid_exercise', 'defaultSets'],
    [6, 'error', 'invalid_exercise', 'defaultReps_or_defaultDuration'],
    [7, 'error', 'listed_twice', 'id'],
    [8, 'error', 'invalid_exercise', 'active'],
    [9, 'error', 'invalid_exercise', 'name'],
  ]);
  assert.deepEqual(out.summary, { create: 0, update: 1, unchanged: 0, errors: 7 });
  assert.equal(exerciseById('ex_push_up').defaultSets, 4, 'the good row was saved');
  assert.equal(s.exercises.rows.length, 1);
  assert.equal(exerciseById('ex_plank').targetAreas[0], 'abs', 'the bad ones were not');
});

test('files that cannot be read are refused outright', async () => {
  const { svc } = setup();
  assert.equal((await svc.importCsv('admin', '')).error, 'empty_file');
  assert.equal((await svc.importCsv('admin', 'id,name\n')).error, 'empty_file');
  assert.equal((await svc.importCsv('admin', 'colour,shape\nred,round')).error, 'missing_header');
  assert.equal((await svc.importCsv('admin', `id,name\n${Array.from({ length: 1001 }, (_, i) => `,Move ${i}`).join('\n')}`)).error, 'too_many_rows');
  assert.equal((await svc.importCsv('admin', 'x'.repeat(2_000_001))).error, 'file_too_big');
  // Unknown columns are named, not silently dropped; the known ones are still used.
  const out = await svc.importCsv('admin', 'id,name,colour\nex_push_up,Press-up,red');
  assert.deepEqual(out.unknownColumns, ['colour']);
  assert.deepEqual(actions(out), [['ex_push_up', 'update']]);
});

test('an import cannot switch every exercise off', async () => {
  const { svc } = setup();
  const csv = file('id,switched_on', ...EXERCISES.map(e => [e.id, 'no']));
  assert.equal((await svc.importCsv('admin', csv, { dryRun: false })).error, 'last_active_exercise');
  assert.ok((await svc.list()).exercises.every(e => e.active));
});

test('cells a spreadsheet would run as a formula are guarded on the way out and restored on the way in', () => {
  const csv = exercisesToCsv([{ ...EXERCISES[0], description: '=SUM(A1)', instructions: ['-Lower slowly.', 'Up.'] }]);
  assert.ok(csv.includes("'=SUM(A1)") && csv.includes("'-Lower slowly."));
  const { rows } = csvToExerciseRows(csv);
  assert.equal(rows[0].fields.description, '=SUM(A1)');
  assert.deepEqual(rows[0].fields.instructions, ['-Lower slowly.', 'Up.']);
});
