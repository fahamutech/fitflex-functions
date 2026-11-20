// Programmes P1, slice B1: FitFlex staff write programmes as drafts, publish,
// retire and make new versions; exercises gain a demo clip and still link.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createProgrammeService, publishProblem, tidyDays } from '../src/services/training/programme-service.mjs';
import { createExerciseAdminService } from '../src/services/training/exercise-admin-service.mjs';
import { EXERCISES, exerciseById, isMediaLink, localizedExercise, setLiveLibrary } from '../src/shared/exercise-library.mjs';
import { programmesCatalogueOn } from '../src/shared/feature-flags.mjs';

function store(rows = []) {
  const clone = r => JSON.parse(JSON.stringify(r));
  return {
    rows,
    async allAsync() { return rows.map(clone); },
    async findByIdAsync(id) { const r = rows.find(x => x.id === id); return r ? clone(r) : null; },
    async filterByColumnInAsync(col, values) { return rows.filter(r => values.includes(r[col])).map(clone); },
    async insertAsync(row) { rows.push(clone(row)); return row; },
    async updateByIdAsync(id, patch) { const r = rows.find(x => x.id === id); Object.assign(r, clone(patch)); return clone(r); },
    async removeByIdAsync(id) { const i = rows.findIndex(x => x.id === id); return i < 0 ? null : rows.splice(i, 1)[0]; },
  };
}

let clock;
function setup({ plans = [], catalogue = false, exists = () => true } = {}) {
  clock = new Date('2026-11-20T08:00:00.000Z');
  const programmes = store();
  const auditLog = store();
  const svc = createProgrammeService({
    programmes, plans: store(plans), auditLog, exerciseExists: exists, catalogueOn: () => catalogue,
    now: () => clock, logger: { warn() {} },
  });
  return { programmes, auditLog, svc };
}
const tick = () => { clock = new Date(+clock + 60_000); };

const workout = (name = 'Full body') => ({
  name, activityType: 'functional', estimatedDuration: 20,
  exercises: [{ exerciseName: 'Bodyweight Squat', libraryId: 'ex_bodyweight_squat', sets: 3, reps: 12 }],
});
const draft = (extra = {}) => ({
  title: '7-day home starter', summary: 'Short sessions to build a habit.',
  goal: 'stay_fit', level: 'beginner', environment: 'home', equipment: ['none'], lengthDays: 7,
  days: [
    { type: 'home', workout: workout('Day 1') }, { type: 'rest' }, { type: 'gym' },
    { type: 'home', workout: workout('Day 4') }, { type: 'rest' }, { type: 'gym', workout: workout('Suggested') },
  ],
  ...extra,
});
const sw = { i18n: { sw: { title: '[SW] 7-day home starter', summary: '[SW] Short sessions to build a habit.' } } };

afterEach(() => setLiveLibrary(EXERCISES));

test('a new programme is a draft, numbered day by day, with unsent days as rest', async () => {
  const s = setup();
  const { programme } = await s.svc.create('admin_1', draft());
  assert.match(programme.id, /^prg_/);
  assert.equal(programme.status, 'draft');
  assert.equal(programme.enrolled, 0);
  assert.equal(programme.days.length, 7);
  assert.deepEqual(programme.days.map(d => [d.day, d.type]), [[1, 'home'], [2, 'rest'], [3, 'gym'], [4, 'home'], [5, 'rest'], [6, 'gym'], [7, 'rest']]);
  assert.equal(programme.days[2].workout, undefined, 'a gym day without a suggestion has no workout');
  assert.equal(programme.days[5].workout.name, 'Suggested');
  assert.equal(programme.days[0].workout.exercises[0].libraryId, 'ex_bodyweight_squat');
  assert.equal(s.programmes.rows[0].createdBy, 'admin_1');
  assert.deepEqual(s.auditLog.rows.map(a => [a.action, a.target]), [['programme_created', programme.id]]);
});

test('what is saved is checked, and the field at fault is named', async () => {
  const { svc } = setup();
  const bad = async (body, field) => {
    const r = await svc.create('admin_1', body);
    assert.equal(r.status, 400, field);
    assert.equal(r.error, 'invalid_programme');
    assert.equal(r.field, field);
    return r;
  };
  await bad(draft({ title: ' ' }), 'title');
  await bad(draft({ goal: 'fly' }), 'goal');
  await bad(draft({ level: 'expert' }), 'level');
  await bad(draft({ environment: 'moon' }), 'environment');
  await bad(draft({ equipment: ['rocket'] }), 'equipment');
  await bad(draft({ lengthDays: 6 }), 'lengthDays');
  await bad(draft({ lengthDays: 85 }), 'lengthDays');
  await bad(draft({ lengthDays: 7.5 }), 'lengthDays');
  await bad(draft({ days: 'all' }), 'days');
  await bad(draft({ days: Array.from({ length: 8 }, () => ({ type: 'rest' })) }), 'days');
  await bad(draft({ days: [{ type: 'swim' }] }), 'days[0].type');
  await bad(draft({ days: [{ type: 'rest' }, { day: 5, type: 'rest' }] }), 'days[1].day');
  const r = await bad(draft({ days: [{ type: 'home', workout: { name: 'x', exercises: [] } }] }), 'days[0].workout');
  assert.equal(r.reason, 'invalid_exercises');
});

test('a rest day never keeps a workout', () => {
  const { days } = tidyDays([{ type: 'rest', workout: workout() }], 7);
  assert.deepEqual(days[0], { day: 1, type: 'rest' });
});

test('a draft can be changed; a shorter length drops later days, a longer one adds rest days', async () => {
  const s = setup();
  const { programme } = await s.svc.create('admin_1', draft());
  tick();
  const shorter = await s.svc.update('admin_2', programme.id, { title: 'Starter', lengthDays: 7, summary: 'New' });
  assert.equal(shorter.programme.title, 'Starter');
  assert.equal(shorter.programme.days[0].workout.name, 'Day 1', 'days kept when not sent');
  const longer = await s.svc.update('admin_2', programme.id, { lengthDays: 10 });
  assert.equal(longer.programme.days.length, 10);
  assert.deepEqual(longer.programme.days.slice(7).map(d => d.type), ['rest', 'rest', 'rest']);
  const cut = await s.svc.update('admin_2', programme.id, { lengthDays: 7 });
  assert.equal(cut.programme.days.length, 7);
  assert.equal(s.programmes.rows[0].updatedBy, 'admin_2');
  assert.equal((await s.svc.update('admin_2', 'prg_missing', {})).status, 404);
});

test('publishing needs a summary, both Swahili fields, a non-rest day, home workouts and live exercises', async () => {
  const s = setup({ exists: id => id !== 'ex_gone' });
  const { programme } = await s.svc.create('admin_1', draft());
  const notReady = async (field) => {
    const r = await s.svc.publish('admin_1', programme.id);
    assert.deepEqual([r.status, r.error, r.field], [400, 'not_ready_to_publish', field]);
  };
  await notReady('i18n.sw.title');
  await s.svc.update('admin_1', programme.id, { i18n: { sw: { title: '[SW] Starter' } } });
  await notReady('i18n.sw.summary');
  await s.svc.update('admin_1', programme.id, { ...sw, summary: '' });
  await notReady('summary');
  await s.svc.update('admin_1', programme.id, { summary: 'Short sessions.', days: [{ type: 'home' }] });
  await notReady('days[0].workout');
  await s.svc.update('admin_1', programme.id, { days: [] });
  await notReady('days');
  const gone = { ...workout(), exercises: [{ exerciseName: 'Old', libraryId: 'ex_gone', sets: 1, reps: 5 }] };
  await s.svc.update('admin_1', programme.id, { days: [{ type: 'home', workout: gone }] });
  await notReady('days[0].workout');
  assert.equal(s.programmes.rows[0].status, 'draft');

  await s.svc.update('admin_1', programme.id, { days: draft().days });
  tick();
  const live = await s.svc.publish('admin_1', programme.id);
  assert.equal(live.programme.status, 'live');
  assert.equal(live.programme.publishedAt, clock.toISOString());
  assert.equal((await s.svc.publish('admin_1', programme.id)).error, 'not_a_draft');
});

test('a live programme is not edited in place; a new version replaces it when published', async () => {
  const s = setup();
  const { programme } = await s.svc.create('admin_1', draft(sw));
  await s.svc.publish('admin_1', programme.id);
  const edit = await s.svc.update('admin_1', programme.id, { title: 'Changed' });
  assert.deepEqual([edit.status, edit.error], [409, 'not_a_draft']);

  tick();
  const { programme: v2 } = await s.svc.duplicate('admin_2', programme.id);
  assert.equal(v2.status, 'draft');
  assert.equal(v2.versionOf, programme.id);
  assert.deepEqual(v2.days, s.programmes.rows[0].days);
  await s.svc.update('admin_2', v2.id, { title: 'Starter v2' });
  assert.equal(s.programmes.rows.find(r => r.id === programme.id).title, '7-day home starter', 'the live one is untouched');

  tick();
  await s.svc.publish('admin_2', v2.id);
  const statuses = Object.fromEntries(s.programmes.rows.map(r => [r.id, r.status]));
  assert.deepEqual(statuses, { [programme.id]: 'retired', [v2.id]: 'live' });
  assert.deepEqual(s.auditLog.rows.map(a => a.action), [
    'programme_created', 'programme_published', 'programme_duplicated', 'programme_updated', 'programme_published', 'programme_retired',
  ]);
});

test('retiring stops new starts; only a live programme can be retired', async () => {
  const s = setup();
  const { programme } = await s.svc.create('admin_1', draft(sw));
  assert.deepEqual([(await s.svc.retire('admin_1', programme.id)).error], ['not_live']);
  await s.svc.publish('admin_1', programme.id);
  const r = await s.svc.retire('admin_1', programme.id);
  assert.equal(r.programme.status, 'retired');
  assert.ok(r.programme.retiredAt);
  assert.equal((await s.svc.retire('admin_1', programme.id)).error, 'not_live');
  assert.equal((await s.svc.retire('admin_1', 'prg_missing')).status, 404);
});

test('the list counts members who started each programme and says whether members can see them', async () => {
  const s = setup({ catalogue: false });
  const a = (await s.svc.create('admin_1', draft({ title: 'A' }))).programme;
  tick();
  const b = (await s.svc.create('admin_1', draft({ title: 'B' }))).programme;
  const withPlans = setup({ plans: [{ id: 'tpn_1', programmeId: a.id }, { id: 'tpn_2', programmeId: a.id }, { id: 'tpn_3', programmeId: null }], catalogue: true });
  withPlans.programmes.rows.push(...s.programmes.rows);

  const off = await s.svc.list();
  assert.equal(off.catalogueOn, false);
  assert.deepEqual(off.programmes.map(p => p.title), ['B', 'A'], 'newest change first');

  const on = await withPlans.svc.list();
  assert.equal(on.catalogueOn, true);
  assert.deepEqual(Object.fromEntries(on.programmes.map(p => [p.id, p.enrolled])), { [a.id]: 2, [b.id]: 0 });
  assert.equal((await withPlans.svc.get(a.id)).programme.enrolled, 2);
  assert.equal((await withPlans.svc.get('prg_missing')).status, 404);
});

test('publishProblem is null for a complete programme', () => {
  const { days } = tidyDays(draft().days, 7);
  assert.equal(publishProblem({ summary: 'x', i18n: sw.i18n, days }), null);
});

test('PROGRAMMES_CATALOGUE is off unless set', () => {
  const before = process.env.PROGRAMMES_CATALOGUE;
  try {
    delete process.env.PROGRAMMES_CATALOGUE;
    assert.equal(programmesCatalogueOn(), false);
    process.env.PROGRAMMES_CATALOGUE = 'true';
    assert.equal(programmesCatalogueOn(), true);
  } finally {
    if (before === undefined) delete process.env.PROGRAMMES_CATALOGUE; else process.env.PROGRAMMES_CATALOGUE = before;
  }
});

// ── Exercise demo clip and still (FR-P05) ───────────────────────────────────

test('media links must be https, without credentials, at most 500 characters', () => {
  assert.equal(isMediaLink('https://cdn.example.com/clips/squat.mp4'), true);
  assert.equal(isMediaLink('http://cdn.example.com/a.mp4'), false);
  assert.equal(isMediaLink('javascript:alert(1)'), false);
  assert.equal(isMediaLink('data:image/png;base64,AAAA'), false);
  assert.equal(isMediaLink('https://user:pw@cdn.example.com/a.mp4'), false);
  assert.equal(isMediaLink(`https://cdn.example.com/${'a'.repeat(500)}`), false);
  assert.equal(isMediaLink('not a link'), false);
});

test('staff can set, keep and clear an exercise\'s clip and still; members get them with the exercise', async () => {
  const exercises = store();
  const svc = createExerciseAdminService({ exercises, auditLog: store(), now: () => new Date('2026-11-20T08:00:00Z'), logger: { warn() {} } });
  const set = await svc.update('admin_1', 'ex_push_up', { clipUrl: 'https://cdn.example.com/push_up.mp4', stillUrl: 'https://cdn.example.com/push_up.jpg' });
  assert.equal(set.exercise.clipUrl, 'https://cdn.example.com/push_up.mp4');
  assert.equal(localizedExercise(exerciseById('ex_push_up'), 'sw').stillUrl, 'https://cdn.example.com/push_up.jpg');

  const kept = await svc.update('admin_1', 'ex_push_up', { defaultReps: 12 });
  assert.equal(kept.exercise.clipUrl, 'https://cdn.example.com/push_up.mp4', 'not sent, so kept');

  const bad = await svc.update('admin_1', 'ex_push_up', { clipUrl: 'http://cdn.example.com/x.mp4' });
  assert.deepEqual([bad.status, bad.field], [400, 'clipUrl']);
  const badStill = await svc.update('admin_1', 'ex_push_up', { stillUrl: 'javascript:alert(1)' });
  assert.deepEqual([badStill.status, badStill.field], [400, 'stillUrl']);

  const cleared = await svc.update('admin_1', 'ex_push_up', { clipUrl: '' });
  assert.equal(cleared.exercise.clipUrl, undefined);
  assert.equal(exercises.rows[0].clipUrl, null, 'stored as cleared');
  assert.equal(cleared.exercise.stillUrl, 'https://cdn.example.com/push_up.jpg');
});

test('the draft starter programmes for trainer review are valid and would publish', async () => {
  const { readFileSync } = await import('node:fs');
  const file = JSON.parse(readFileSync(new URL('../docs/programmes-starter-drafts.json', import.meta.url), 'utf8'));
  assert.ok(file.programmes.length >= 2);
  const s = setup({ exists: id => Boolean(exerciseById(id)?.active) });
  for (const body of file.programmes) {
    const made = await s.svc.create('admin_1', body);
    assert.equal(made.error, undefined, `${body.title}: ${made.field}`);
    assert.equal(made.programme.days.length, body.lengthDays);
    const live = await s.svc.publish('admin_1', made.programme.id);
    assert.equal(live.error, undefined, `${body.title}: ${live.field}`);
    assert.match(body.i18n.sw.title, /^\[SW\] /, 'Swahili is a marked placeholder');
  }
});
