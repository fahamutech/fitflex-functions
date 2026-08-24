// B11/B12/C4 — gym classes configuration + trainer pass.
// B11: owners configure classes (name, schedule, price, location).
// B12: owners configure a trainer pass (fee for external trainers to train
//      their clients at the gym); C4: trainers see the fee on the gym.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGymService } from '../src/services/gym-service.mjs';

const service = createGymService({
  gyms: { find: () => null, filter: () => [], filterAsync: async () => [], all: () => [], upsert: () => {}, remove: () => {} },
  users: { findAsync: async () => null },
  checkins: { findAsync: async () => null },
  auditLog: { insert: () => {} },
});

test('active gym catalogue can be read asynchronously', async () => {
  const rows = [{ id: 'gym_active', status: 'active' }, { id: 'gym_inactive', status: 'inactive' }];
  const asyncService = createGymService({
    gyms: { filter: () => [], filterAsync: async (predicate) => rows.filter(predicate) },
    users: { findAsync: async () => null },
    checkins: { findAsync: async () => null },
    auditLog: { insert: () => {} },
  });
  assert.deepEqual(await asyncService.listActiveAsync(), [rows[0]]);
});

test('B11: classes are normalized onto the gym payload', () => {
  const row = service.normalizeGymPayload({
    name: 'Class Gym',
    classes: [
      { name: 'Yoga', schedule: 'Mon/Wed 07:00', price: 10000, location: 'Studio A' },
      { name: 'Aerobics', schedule: 'Sat 09:00', price: 8000 },
    ],
  }, {});
  assert.equal(row.classes.length, 2);
  assert.equal(row.classes[0].name, 'Yoga');
  assert.equal(row.classes[0].price, 10000);
  assert.ok(row.classes[0].id, 'each class gets an id');
  assert.equal(row.classes[1].location, null);
});

test('B11: classes without a name are dropped', () => {
  const row = service.normalizeGymPayload({
    name: 'Class Gym',
    classes: [{ schedule: 'Mon 07:00' }, { name: 'Zumba' }],
  }, {});
  assert.equal(row.classes.length, 1);
  assert.equal(row.classes[0].name, 'Zumba');
});

test('B11: prior classes are preserved on partial update', () => {
  const prior = service.normalizeGymPayload({
    name: 'Class Gym',
    classes: [{ name: 'Yoga', price: 10000 }],
  }, {});
  const updated = service.normalizeGymPayload({ location: 'New Street' }, prior);
  assert.equal(updated.classes.length, 1);
  assert.equal(updated.classes[0].name, 'Yoga');
});

test('B12: trainer pass config is normalized with fee and period', () => {
  const row = service.normalizeGymPayload({
    name: 'TP Gym',
    trainerPass: { enabled: true, feeTzs: 50000, period: 'monthly' },
  }, {});
  assert.equal(row.trainerPass.enabled, true);
  assert.equal(row.trainerPass.feeTzs, 50000);
  assert.equal(row.trainerPass.period, 'monthly');
});

test('B12: trainer pass defaults to disabled', () => {
  const row = service.normalizeGymPayload({ name: 'No TP Gym' }, {});
  assert.equal(row.trainerPass.enabled, false);
  assert.equal(row.trainerPass.feeTzs, 0);
});

test('B12: invalid trainer pass period falls back to monthly', () => {
  const row = service.normalizeGymPayload({
    name: 'TP Gym',
    trainerPass: { enabled: true, feeTzs: 1000, period: 'yearly' },
  }, {});
  assert.equal(row.trainerPass.period, 'monthly');
});

// ── C4: trainer pass purchase ─────────────────────────────

import { createSubscriptionService } from '../src/services/subscription-service.mjs';

function memStore(rows = []) {
  return {
    rows,
    async filterAsync(fn) { return rows.filter(fn); },
    async findAsync(fn) { return rows.find(fn) || null; },
    async findByIdAsync(id) { return rows.find((r) => r.id === id) || null; },
    async insertAsync(row) { rows.push(row); return row; },
    async updateByIdAsync(id, patch) {
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows[i] = { ...rows[i], ...patch };
      return rows[i] || null;
    },
  };
}

function makeSubService(gyms) {
  return createSubscriptionService({
    subscriptions: memStore(),
    paymentRequests: memStore(),
    checkins: memStore(),
    gyms,
    settingsService: { priceForTier: () => 0, visitCapForTier: () => null },
    publicUserId: async () => 'FF-7000',
  });
}

const tpGym = {
  id: 'gym_tp',
  name: 'TP Gym',
  tier: 'standard',
  trainerPass: { enabled: true, feeTzs: 50000, period: 'weekly' },
};

test('C4: trainer pass purchase creates a pending weekly trainer_pass subscription', async () => {
  const sub = makeSubService([tpGym]);
  const out = await sub.trainerPassPurchase({ trainerUserId: 'usr_trainer_1', gymId: 'gym_tp' });
  assert.equal(out.status, 202);
  assert.equal(out.subscription.type, 'trainer_pass');
  assert.equal(out.subscription.homeGymId, 'gym_tp');
  const durationMs = +new Date(out.subscription.expiresAt) - +new Date(out.subscription.startedAt);
  assert.equal(Math.round(durationMs / 86_400_000), 7);
  assert.equal(out.paymentRequest.amountTzs, 50000);
});

test('C4: gyms without a trainer pass reject the purchase', async () => {
  const sub = makeSubService([{ ...tpGym, trainerPass: { enabled: false, feeTzs: 0, period: 'monthly' } }]);
  const out = await sub.trainerPassPurchase({ trainerUserId: 'usr_trainer_1', gymId: 'gym_tp' });
  assert.equal(out.status, 400);
  assert.equal(out.error, 'trainer_pass_not_offered');
});

test('C4: unknown gym rejects the purchase', async () => {
  const sub = makeSubService([]);
  const out = await sub.trainerPassPurchase({ trainerUserId: 'usr_trainer_1', gymId: 'gym_nope' });
  assert.equal(out.status, 404);
});
