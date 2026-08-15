import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrainerService } from '../src/services/trainer-service.mjs';

const rows = [];
const trainers = {
  find: (predicate) => rows.find(predicate),
  all: () => rows,
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
