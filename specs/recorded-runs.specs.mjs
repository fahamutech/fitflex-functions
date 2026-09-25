// Runs recorded in the app: metrics from the GPS track, estimated calories,
// plausibility, and a route only the member can read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActivityService } from '../src/services/activity-service.mjs';
import { cleanTrack, elevationGainM, haversineM, runCalories, trackMetrics } from '../src/shared/run-metrics.mjs';

function store(rows = []) {
  const clone = (r) => JSON.parse(JSON.stringify(r));
  return {
    rows,
    async allAsync() { return rows.map(clone); },
    async filterByColumnAsync(col, v) { return rows.filter(r => r[col] === v).map(clone); },
    async findByIdAsync(id) { const r = rows.find(x => x.id === id); return r ? clone(r) : null; },
    async insertAsync(row) { rows.push(clone(row)); return row; },
    async updateByIdAsync(id, patch) { const r = rows.find(x => x.id === id); Object.assign(r, clone(patch)); return clone(r); },
    async removeByIdAsync(id) { const i = rows.findIndex(x => x.id === id); if (i >= 0) rows.splice(i, 1); },
  };
}

const NOW = new Date('2026-09-25T07:00:00.000Z');
const T0 = Date.parse('2026-09-25T05:00:00.000Z');
// Due north: 0.0009° latitude ≈ 100 m.
const DEG_100M = 0.0009;

/** A run north at [secPer100m] pace for [meters], one point per 100 m. */
function run(meters, secPer100m = 30, { lat0 = -6.8, t0 = T0, alt = () => 20, acc = 5 } = {}) {
  const pts = [];
  for (let i = 0; i <= meters / 100; i++) pts.push([lat0 + i * DEG_100M, 39.28, alt(i), t0 + i * secPer100m * 1000, acc]);
  return pts;
}

test('distance, moving time and per-km splits from the track', () => {
  // 3 km at 5:00/km.
  const m = trackMetrics(cleanTrack([run(3000)]));
  assert.ok(Math.abs(m.distanceKm - 3.0) < 0.02, `distance ${m.distanceKm}`);
  assert.equal(m.movingSeconds, 900);
  assert.equal(m.splits.length, 3);
  for (const s of m.splits) assert.ok(Math.abs(s - 300) <= 2, `split ${s}`);
  assert.ok(Math.abs(haversineM([0, 0], [DEG_100M, 0]) - 100) < 0.5);
});

test('a pause is not counted: distance and time only inside segments', () => {
  const a = run(1000);
  const lastT = a[a.length - 1][3];
  // 10-minute pause, then 1 km more, starting where it stopped.
  const b = run(1000, 30, { lat0: a[a.length - 1][0], t0: lastT + 600_000 });
  const m = trackMetrics(cleanTrack([a, b]));
  assert.ok(Math.abs(m.distanceKm - 2.0) < 0.02);
  assert.equal(m.movingSeconds, 600, 'the 10 minutes paused are left out');
});

test('unsure and impossible points are dropped', () => {
  const pts = run(1000);
  pts.splice(5, 0, [pts[4][0] + 0.05, 39.28, 20, pts[4][3] + 1000, 5]); // 5 km jump in 1 s
  pts[7][4] = 80; // poor accuracy
  const clean = cleanTrack([pts]);
  assert.equal(clean[0].length, pts.length - 2);
  assert.ok(Math.abs(trackMetrics(clean).distanceKm - 1.0) < 0.02);
});

test('climb: real hills count, GPS jitter does not', () => {
  const flatNoisy = run(2000, 30, { alt: i => 20 + (i % 2 ? 1.5 : -1.5) });
  assert.equal(elevationGainM(cleanTrack([flatNoisy])[0]), 0);
  const hill = run(2000, 30, { alt: i => (i <= 10 ? 20 + i * 5 : 70 - (i - 10) * 5) });
  const g = elevationGainM(cleanTrack([hill])[0]);
  assert.ok(g >= 40 && g <= 50, `gain ${g}`);
});

test('calories: estimated from weight, none without it', () => {
  // 5 km in 30 min, 70 kg: ACSM running ≈ 0.2·166.7+3.5 = 36.8 ml/kg/min → ~386 kcal.
  const kcal = runCalories({ distanceKm: 5, movingSeconds: 1800, weightKg: 70 });
  assert.ok(kcal >= 370 && kcal <= 400, `kcal ${kcal}`);
  assert.equal(runCalories({ distanceKm: 5, movingSeconds: 1800, weightKg: null }), null);
  assert.equal(runCalories({ distanceKm: 5, movingSeconds: 1800, weightKg: 5 }), null);
  const brisk = runCalories({ distanceKm: 2, movingSeconds: 1200, weightKg: 70 });
  assert.ok(brisk > 0 && brisk < kcal / 2, 'walking pace uses the walking equation');
});

test('saving a run: numbers from the track, route kept private', async () => {
  const activities = store();
  const routes = store();
  const users = store([{ id: 'm1', memberProfile: { weightKg: 70 } }, { id: 'm2', memberProfile: {} }]);
  const svc = createActivityService({ activities, users, routes, now: () => NOW });
  const { activity: a } = await svc.recordRun('m1', { segments: [run(5000, 36)], notes: '  Coco beach  ' });
  assert.equal(a.type, 'running');
  assert.equal(a.source, 'fitflex');
  assert.ok(Math.abs(a.distanceKm - 5) < 0.03);
  assert.equal(a.movingSeconds, 1800);
  assert.equal(a.durationMinutes, 30);
  assert.equal(a.activeMinutes, 30);
  assert.equal(a.splits.length, 5);
  assert.equal(a.steps, null, 'steps stay in the phone\'s daily count');
  assert.ok(a.calories > 300);
  assert.equal(a.hasRoute, true);
  assert.equal(a.notes, 'Coco beach');
  assert.equal(a.startedAt, new Date(T0).toISOString());

  const r = await svc.route('m1', a.id);
  assert.equal(r.route.segments[0].length, 51);
  assert.equal((await svc.route('m2', a.id)).status, 404, 'nobody else can read it');
  assert.ok(!('segments' in (await svc.list('m1')).activities[0]), 'lists never carry the route');

  const noWeight = (await svc.recordRun('m2', { segments: [run(2000)] })).activity;
  assert.equal(noWeight.calories, null);
});

test('only plausible runs are saved', async () => {
  const svc = createActivityService({ activities: store(), routes: store(), now: () => NOW });
  const err = async body => (await svc.recordRun('m1', body)).error;
  assert.equal(await err({}), 'invalid_route');
  assert.equal(await err({ segments: [] }), 'invalid_route');
  assert.equal(await err({ segments: [[[1, 2, 3, T0, 5]]] }), 'invalid_route');
  assert.equal(await err({ type: 'cycling', segments: [run(2000)] }), 'invalid_type');
  assert.equal(await err({ segments: [run(300, 15)] }), 'too_short', '45 seconds');
  // 10 km in 10 minutes (60 km/h): every point looks like a GPS jump and is
  // dropped, leaving nothing to count.
  assert.equal(await err({ segments: [run(10000, 6)] }), 'too_short');
  // 30 km/h sustained: points pass, the average doesn't.
  assert.equal(await err({ segments: [run(10000, 12)] }), 'too_fast');
  assert.equal(await err({ segments: [run(2000, 30, { t0: Date.parse('2026-09-10T05:00:00Z') })] }), 'too_old');
  assert.equal(await err({ segments: [run(2000, 30, { t0: Date.parse('2026-09-26T05:00:00Z') })] }), 'started_in_future');
});
