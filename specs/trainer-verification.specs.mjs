import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrainerService } from '../src/services/trainer-service.mjs';

const rows = [];
const trainers = {
  find: (predicate) => rows.find(predicate),
  all: () => rows,
  update: (predicate, patch) => {
    const index = rows.findIndex(predicate);
    if (index < 0) return null;
    rows[index] = { ...rows[index], ...patch };
    return rows[index];
  },
  upsert: (predicate, row) => {
    const index = rows.findIndex(predicate);
    if (index >= 0) rows[index] = row;
    else rows.push(row);
    return row;
  },
};

const service = createTrainerService({
  trainers,
  gyms: { find: () => null },
  trainerBookings: { findAsync: async () => null },
  auditLog: { insert: () => {} },
  gymService: { slimGym: (gym) => gym, slimGymRef: (gym) => gym },
});

test('admin verification is explicit and preserved on trainer updates', () => {
  const created = service.adminUpsert({
    actorId: 'admin-1',
    body: { displayName: 'Amina Trainer', verified: true },
  });
  assert.equal(created.trainer.verified, true);

  const updated = service.adminUpsert({
    actorId: 'admin-1',
    body: { id: created.trainer.id, bio: 'Updated bio' },
  });
  assert.equal(updated.trainer.verified, true);
});

test('new trainers are unverified until an admin verifies them', () => {
  const trainer = service.normalizeTrainerPayload({ displayName: 'New Trainer' });
  assert.equal(trainer.verified, false);
});

test('trainer professional updates persist the selected session currency', () => {
  const created = service.adminUpsert({
    actorId: 'admin-1',
    body: {
      userId: 'trainer-user-currency',
      displayName: 'Currency Trainer',
      hourlyRateTzs: 25000,
      sessionRateCurrency: 'TZS',
    },
  });

  const updated = service.updateProfile({
    userId: created.trainer.userId,
    body: { hourlyRateTzs: 50, sessionRateCurrency: 'USD' },
  });

  assert.equal(updated.trainer.hourlyRateTzs, 50);
  assert.equal(updated.trainer.sessionRateCurrency, 'USD');
});
