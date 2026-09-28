// A6 — Verified vs Unverified gyms (FitFlex App Issues 25.07.2026), as
// changed by decision D4 (28 Sep 2026): a complete profile (location,
// coordinates, photos, amenities, equipment) no longer switches "Verified"
// on; members see it as profileComplete, and "Verified" follows the owner's
// KYC. The stored flag is set by an admin or kept from before.

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

test('D4: a complete profile no longer makes a new gym verified', () => {
  const row = service.normalizeGymPayload({ ...completeGym }, {});
  assert.equal(row.verified, false);
});

test('D4: an existing gym keeps its verified flag when edited', () => {
  const row = service.normalizeGymPayload({ name: 'Renamed' }, { ...completeGym, verified: true });
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
  const row = service.normalizeGymPayload({ ...completeGym, verified: true }, {});
  assert.equal(service.slimGym(row).verified, true);
  assert.equal(service.slimGymForTable ? service.slimGymForTable(row).verified : row.verified, true);
});
