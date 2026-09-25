// A6 — Verified vs Unverified gyms (FitFlex App Issues 25.07.2026).
// A gym is auto-verified when its profile is complete (location, coordinates,
// photos, amenities and equipment). Admin can force the flag explicitly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGymService } from '../src/services/gym-service.mjs';

const service = createGymService({
  gyms: { find: () => null, filter: () => [], all: () => [], upsert: () => {}, remove: () => {} },
  users: { findAsync: async () => null },
  checkins: { findAsync: async () => null },
  auditLog: { insert: () => {}, insertAsync: async () => {} },
});

const completeGym = {
  name: 'Complete Gym',
  tier: 'standard',
  location: 'Dar es Salaam',
  lat: -6.8,
  lng: 39.28,
  images: ['data:image/webp;base64,xxx'],
  amenities: ['showers', 'lockers'],
  equipment: ['treadmills'],
};

test('A6: a gym with complete details is verified', () => {
  const row = service.normalizeGymPayload({ ...completeGym }, {});
  assert.equal(row.verified, true);
});

test('A6: a gym missing photos is unverified', () => {
  const row = service.normalizeGymPayload({ ...completeGym, images: [] }, {});
  assert.equal(row.verified, false);
});

test('A6: a gym missing coordinates is unverified', () => {
  const row = service.normalizeGymPayload(
    { ...completeGym, lat: null, lng: null },
    {},
  );
  assert.equal(row.verified, false);
});

test('A6: a gym missing amenities and equipment is unverified', () => {
  const row = service.normalizeGymPayload(
    { ...completeGym, amenities: [], equipment: [] },
    {},
  );
  assert.equal(row.verified, false);
});

test('A6: admin can explicitly set verified', () => {
  const forcedOn = service.normalizeGymPayload(
    { ...completeGym, images: [], verified: true },
    {},
  );
  assert.equal(forcedOn.verified, true);

  const forcedOff = service.normalizeGymPayload(
    { ...completeGym, verified: false },
    {},
  );
  assert.equal(forcedOff.verified, false);
});

test('A6: an explicit prior verified flag is preserved on partial update', () => {
  const prior = service.normalizeGymPayload({ ...completeGym, verified: true, images: [] }, {});
  const updated = service.normalizeGymPayload({ name: 'Renamed Gym' }, prior);
  assert.equal(updated.verified, true);
});

test('A6: slim gym payloads expose the verified flag', () => {
  const row = service.normalizeGymPayload({ ...completeGym }, {});
  assert.equal(service.slimGym(row).verified, true);
  assert.equal(service.slimGymForTable ? service.slimGymForTable(row).verified : row.verified, true);
});
