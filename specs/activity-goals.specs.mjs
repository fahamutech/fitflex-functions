// Activity & Progress Engine — activities and goals services.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActivityService } from '../src/services/activity-service.mjs';
import { createGoalService, DEFAULT_GOALS } from '../src/services/goal-service.mjs';

function store(rows = []) {
  return {
    rows,
    async filterByColumnAsync(col, v) { return rows.filter(r => r[col] === v).map(r => ({ ...r })); },
    async findByIdAsync(id) { const r = rows.find(x => x.id === id); return r ? { ...r } : null; },
    async insertAsync(row) { rows.push({ ...row }); return row; },
    async updateByIdAsync(id, patch) { const r = rows.find(x => x.id === id); Object.assign(r, patch); return { ...r }; },
    async removeByIdAsync(id) { const i = rows.findIndex(x => x.id === id); return i < 0 ? null : rows.splice(i, 1)[0]; },
  };
}

const NOW = new Date('2026-09-24T12:00:00.000Z');
const now = () => NOW;

// ── Activities ──────────────────────────────────────────────────────────────

test('log a manual run and list it newest first within the window', async () => {
  const activities = store();
  const svc = createActivityService({ activities, now });
  const a = await svc.log('m1', { type: 'running', startedAt: '2026-09-23T06:00:00Z', durationMinutes: 31.6, distanceKm: 5.2 });
  const b = await svc.log('m1', { type: 'walking', startedAt: '2026-09-24T07:00:00Z', steps: 4200 });
  await svc.log('m2', { type: 'walking', startedAt: '2026-09-24T07:00:00Z', steps: 100 });
  assert.equal(a.activity.source, 'manual');
  assert.equal(a.activity.durationMinutes, 32, 'integer metrics are rounded');
  assert.equal(a.activity.distanceKm, 5.2);
  const { activities: mine } = await svc.list('m1');
  assert.deepEqual(mine.map(x => x.id), [b.activity.id, a.activity.id]);
  const { activities: narrow } = await svc.list('m1', { from: '2026-09-24T00:00:00Z', to: '2026-09-25T00:00:00Z' });
  assert.deepEqual(narrow.map(x => x.id), [b.activity.id]);
});

test('a manual entry can never carry device provenance', async () => {
  const activities = store();
  const svc = createActivityService({ activities, now });
  const r = await svc.log('m1', {
    type: 'walking', startedAt: '2026-09-24T07:00:00Z', steps: 25000,
    devicePlatform: 'apple_health', externalId: 'HK-123', deviceName: 'Apple Watch',
  });
  assert.equal(r.activity.source, 'manual');
  for (const f of ['devicePlatform', 'externalId', 'deviceName']) {
    assert.equal(f in activities.rows[0], false, f);
  }
});

test('rejects bad activities', async () => {
  const svc = createActivityService({ activities: store(), now });
  const ok = { type: 'running', startedAt: '2026-09-24T06:00:00Z', durationMinutes: 30 };
  const cases = [
    [{ ...ok, type: 'teleporting' }, 'invalid_type'],
    [{ ...ok, source: 'satellite' }, 'invalid_source'],
    // Only manual entries can be typed in: device and FitFlex-tracked data
    // come from their own flows, so they can't be faked here.
    [{ ...ok, source: 'device' }, 'source_not_loggable'],
    [{ ...ok, source: 'fitflex' }, 'source_not_loggable'],
    [{ ...ok, source: 'trainer' }, 'source_not_loggable'],
    [{ ...ok, startedAt: 'yesterday' }, 'invalid_started_at'],
    [{ ...ok, startedAt: '2026-09-25T06:00:00Z' }, 'started_in_future'],
    [{ ...ok, intensity: 'extreme' }, 'invalid_intensity'],
    [{ ...ok, durationMinutes: -5 }, 'invalid_durationMinutes'],
    [{ ...ok, steps: 5_000_000 }, 'invalid_steps'],
    [{ ...ok, distanceKm: '5' }, 'invalid_distanceKm'],
    [{ type: 'running', startedAt: '2026-09-24T06:00:00Z' }, 'no_metrics'],
  ];
  for (const [body, error] of cases) {
    const r = await svc.log('m1', body);
    assert.equal(r.status, 400, error);
    assert.equal(r.error, error);
  }
});

test('an activity can be logged up to 90 days back, no further', async () => {
  const svc = createActivityService({ activities: store(), now });
  const daysAgo = n => new Date(+NOW - n * 86_400_000).toISOString();
  assert.ok((await svc.log('m1', { type: 'walking', startedAt: daysAgo(90), steps: 100 })).activity);
  assert.equal((await svc.log('m1', { type: 'walking', startedAt: daysAgo(92), steps: 100 })).error, 'started_too_long_ago');
  assert.equal((await svc.log('m1', { type: 'walking', startedAt: '2020-01-01T08:00:00Z', steps: 100 })).error, 'started_too_long_ago');
});

test('list rejects inverted or oversized ranges', async () => {
  const svc = createActivityService({ activities: store(), now });
  assert.equal((await svc.list('m1', { from: '2026-09-24T00:00:00Z', to: '2026-09-01T00:00:00Z' })).error, 'invalid_range');
  assert.equal((await svc.list('m1', { from: '2024-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' })).error, 'range_too_long');
});

test('members delete only their own member-sourced activities', async () => {
  const activities = store([
    { id: 'a1', userId: 'm1', source: 'manual', startedAt: '2026-09-20T06:00:00Z' },
    { id: 'a2', userId: 'm1', source: 'trainer', startedAt: '2026-09-20T06:00:00Z' },
    { id: 'a3', userId: 'm2', source: 'manual', startedAt: '2026-09-20T06:00:00Z' },
  ]);
  const svc = createActivityService({ activities, now });
  assert.deepEqual(await svc.remove('m1', 'a1'), { deleted: true });
  assert.equal((await svc.remove('m1', 'a2')).status, 403);
  assert.equal((await svc.remove('m1', 'a3')).status, 404);
  assert.deepEqual(activities.rows.map(r => r.id), ['a2', 'a3']);
});

// ── Goals ───────────────────────────────────────────────────────────────────

test('first list seeds the default goals exactly once', async () => {
  const goals = store();
  const svc = createGoalService({ goals, now });
  const first = await svc.list('m1');
  assert.equal(first.goals.length, DEFAULT_GOALS.length);
  assert.ok(first.goals.every(g => g.source === 'default' && g.status === 'active' && g.startDate === '2026-09-24'));
  await svc.list('m1');
  assert.equal(goals.rows.length, DEFAULT_GOALS.length, 'no re-seed');
});

test('archiving every goal does not bring the defaults back', async () => {
  const goals = store();
  const svc = createGoalService({ goals, now });
  const { goals: seeded } = await svc.list('m1');
  for (const g of seeded) await svc.update('m1', g.id, { status: 'archived' });
  assert.deepEqual((await svc.list('m1')).goals, []);
});

test('create weekly and custom goals with sane targets', async () => {
  const svc = createGoalService({ goals: store(), now });
  const weekly = await svc.create('m1', { type: 'workouts', period: 'week', target: 4 });
  assert.equal(weekly.goal.source, 'member');
  assert.equal(weekly.goal.endDate, null);
  const custom = await svc.create('m1', { type: 'distance_km', period: 'custom', target: 100, startDate: '2026-10-01', endDate: '2026-10-31' });
  assert.equal(custom.goal.endDate, '2026-10-31');

  const bad = [
    [{ type: 'pushups', period: 'week', target: 1 }, 'invalid_type'],
    [{ type: 'steps', period: 'fortnight', target: 1 }, 'invalid_period'],
    [{ type: 'steps', period: 'day', target: 0 }, 'invalid_target'],
    [{ type: 'steps', period: 'day', target: 2_000_000 }, 'invalid_target'],
    [{ type: 'workouts', period: 'week', target: 36 }, 'invalid_target'],
    [{ type: 'steps', period: 'custom', target: 1000, startDate: '2026-10-05', endDate: '2026-10-01' }, 'invalid_end_date'],
    [{ type: 'steps', period: 'day', target: 1000, startDate: '24/09/2026' }, 'invalid_start_date'],
  ];
  for (const [body, error] of bad) assert.equal((await svc.create('m1', body)).error, error);
});

test('members pause or archive any goal but cannot retarget trainer goals', async () => {
  const goals = store([
    { id: 'g1', userId: 'm1', type: 'steps', period: 'day', target: 8000, startDate: '2026-09-01', endDate: null, source: 'default', status: 'active', createdAt: '2026-09-01T00:00:00Z' },
    { id: 'g2', userId: 'm1', type: 'workouts', period: 'week', target: 3, startDate: '2026-09-01', endDate: null, source: 'trainer', trainerId: 't1', status: 'active', createdAt: '2026-09-02T00:00:00Z' },
  ]);
  const svc = createGoalService({ goals, now });
  assert.equal((await svc.update('m1', 'g1', { target: 10000 })).goal.target, 10000);
  assert.equal((await svc.update('m1', 'g2', { target: 1 })).error, 'target_locked');
  assert.equal((await svc.update('m1', 'g2', { status: 'paused' })).goal.status, 'paused');
  assert.equal((await svc.update('m1', 'g2', { status: 'completed' })).error, 'invalid_status');
  assert.equal((await svc.update('m2', 'g1', { status: 'archived' })).status, 404);
  assert.equal((await svc.update('m1', 'g1', {})).error, 'nothing_to_update');
});
