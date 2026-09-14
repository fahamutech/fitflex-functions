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
  upsertAsync: async (predicate, row) => trainers.upsert(predicate, row),
};

const service = createTrainerService({
  trainers,
  gyms: { find: () => null },
  trainerBookings: { findAsync: async () => null },
  auditLog: { insert: () => {} },
  gymService: { slimGym: (gym) => gym, slimGymRef: (gym) => gym },
});

test('admin verification is explicit and preserved on trainer updates', async () => {
  const created = await service.adminUpsert({
    actorId: 'admin-1',
    body: { displayName: 'Amina Trainer', verified: true },
  });
  assert.equal(created.trainer.verified, true);

  const updated = await service.adminUpsert({
    actorId: 'admin-1',
    body: { id: created.trainer.id, bio: 'Updated bio' },
  });
  assert.equal(updated.trainer.verified, true);
});

test('new trainers are unverified until an admin verifies them', () => {
  const trainer = service.normalizeTrainerPayload({ displayName: 'New Trainer' });
  assert.equal(trainer.verified, false);
});

test('trainer professional updates persist the selected session currency', async () => {
  const created = await service.adminUpsert({
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

test('admin trainer profiles retain multiple portfolio images without a gym assignment', async () => {
  const images = [
    'https://images.example.test/trainer-one.webp',
    'https://images.example.test/trainer-two.webp',
  ];
  const imageThumbnails = [
    'https://images.example.test/trainer-one-thumb.webp',
    'https://images.example.test/trainer-two-thumb.webp',
  ];
  const created = await service.adminUpsert({
    actorId: 'admin-1',
    body: {
      displayName: 'Independent Trainer',
      images,
      imageThumbnails,
      gymIds: [],
    },
  });

  assert.deepEqual(created.trainer.images, images);
  assert.deepEqual(created.trainer.imageThumbnails, imageThumbnails);
  assert.equal(created.trainer.photoUrl, images[0]);
  assert.deepEqual(created.trainer.gymIds, []);

  const updated = await service.adminUpsert({
    actorId: 'admin-1',
    body: { id: created.trainer.id, bio: 'Updated independently' },
  });
  assert.deepEqual(updated.trainer.images, images);
  assert.deepEqual(updated.trainer.imageThumbnails, imageThumbnails);
});
