// Device sync: daily step totals from the member's phone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActivityService } from '../src/services/activity-service.mjs';
import { createChallengeService } from '../src/services/challenge-service.mjs';

function store(rows = []) {
  const clone = (r) => JSON.parse(JSON.stringify(r));
  return {
    rows,
    async allAsync() { return rows.map(clone); },
    async filterAsync(pred) { return rows.filter(pred).map(clone); },
    async filterByColumnAsync(col, v) { return rows.filter(r => r[col] === v).map(clone); },
    async findByIdAsync(id) { const r = rows.find(x => x.id === id); return r ? clone(r) : null; },
    async insertAsync(row) { rows.push(clone(row)); return row; },
    async updateByIdAsync(id, patch) { const r = rows.find(x => x.id === id); Object.assign(r, clone(patch)); return clone(r); },
  };
}

// Thursday 24 Sep 2026, 12:00 EAT.
const NOW = new Date('2026-09-24T09:00:00.000Z');
const now = () => NOW;
// Local (EAT) midnight of 24 Sep.
const DAY = '2026-09-23T21:00:00.000Z';
const rec = (over = {}) => ({ devicePlatform: 'phone_sensor', externalId: 'steps:2026-09-24', type: 'walking', startedAt: DAY, steps: 4210, ...over });

test('a day of phone steps is saved once and only goes up', async () => {
  const activities = store();
  const svc = createActivityService({ activities, now });
  assert.deepEqual(await svc.syncDevice('m1', { records: [rec()] }), { created: 1, updated: 0, unchanged: 0 });
  const row = activities.rows[0];
  assert.equal(row.source, 'device');
  assert.equal(row.devicePlatform, 'phone_sensor');
  assert.equal(row.externalId, 'steps:2026-09-24');
  assert.equal(row.steps, 4210);

  assert.deepEqual(await svc.syncDevice('m1', { records: [rec({ steps: 6120 })] }), { created: 0, updated: 1, unchanged: 0 });
  assert.deepEqual(await svc.syncDevice('m1', { records: [rec({ steps: 900 })] }), { created: 0, updated: 0, unchanged: 1 }, 'a lower count (reinstall) never lowers the day');
  assert.equal(activities.rows.length, 1);
  assert.equal(activities.rows[0].steps, 6120);

  // Another member's same day is their own record.
  await svc.syncDevice('m2', { records: [rec()] });
  assert.equal(activities.rows.length, 2);
  // And the synced day shows in the member's list.
  assert.equal((await svc.list('m1')).activities[0].steps, 6120);
});

test('only genuine phone/health-platform readings are accepted', async () => {
  const svc = createActivityService({ activities: store(), now });
  const err = async (over, body) => (await svc.syncDevice('m1', body ?? { records: [rec(over)] })).error;
  assert.equal(await err({}, {}), 'invalid_records');
  assert.equal(await err({}, { records: [] }), 'invalid_records');
  assert.equal(await err({}, { records: Array.from({ length: 63 }, () => rec()) }), 'invalid_records');
  assert.equal(await err({ devicePlatform: 'fitbit' }), 'invalid_device_platform', 'wearables sync server to server');
  assert.equal(await err({ devicePlatform: undefined }), 'invalid_device_platform');
  assert.equal(await err({ externalId: '' }), 'invalid_external_id');
  assert.equal(await err({ type: 'running' }), 'invalid_type');
  assert.equal(await err({ startedAt: 'yesterday' }), 'invalid_started_at');
  assert.equal(await err({ startedAt: '2026-09-25T09:00:00.000Z' }), 'started_in_future');
  assert.equal(await err({ startedAt: '2026-08-01T00:00:00.000Z' }), 'too_old');
  assert.equal(await err({ steps: 100_001 }), 'invalid_steps');
  assert.equal(await err({ steps: 12.5 }), 'invalid_steps');
  assert.equal(await err({ steps: -1 }), 'invalid_steps');
  // Manual logging still can't claim to be a device.
  assert.equal((await svc.log('m1', { type: 'walking', source: 'device', startedAt: DAY, steps: 10 })).error, 'source_not_loggable');
});

test('phone steps count toward a steps challenge', async () => {
  const activities = store();
  const act = createActivityService({ activities, now });
  const challenges = createChallengeService({
    challenges: store(), participants: store(), teams: store(), users: store([{ id: 'm1', userType: 'member' }]),
    trainers: store(), gyms: store(), relationships: store(), gymMemberSharing: store(), gymMemberIds: async () => new Map(),
    activities, checkins: store(), now,
  });
  const c = (await challenges.create({ creatorType: 'fitflex', createdBy: 'a' }, { name: '10K', type: 'steps', target: 10000, startDate: '2026-09-20', endDate: '2026-09-30' })).challenge;
  await challenges.join('m1', c.id);
  await act.syncDevice('m1', { records: [rec({ steps: 7000 }), rec({ externalId: 'steps:2026-09-23', startedAt: '2026-09-22T21:00:00.000Z', steps: 3500 })] });
  assert.equal(await challenges.progressFor(c, 'm1'), 10500);
});
