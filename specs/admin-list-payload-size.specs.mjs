// Regression: admin list endpoints must return slimmed payloads.
// Ensures gym objects embedded in owners/trainers do NOT carry heavy fields
// (images, thumbnails, operatingHours) — only a single `thumbnail`.
// Also verifies adminListGyms strips operatingHours by default but keeps
// images (needed for table thumbnails).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adminListGyms,
  adminListGymOwners,
  adminListTrainers,
  adminUpsertGym,
  updateMemberProfile,
} from '../functions/index.mjs';

function res() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const uniq = (p) => `${p}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const uniqPhone = () => `+2557${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

const adminReq = (extra = {}) => ({
  user: { sub: 'admin_test', userType: 'admin', aclPermissions: ['gyms', 'owners', 'trainers'] },
  query: {},
  ...extra,
});

async function ensureUser({ id, userType, displayName, email, phone, gymId, gymIds }) {
  const out = res();
  await updateMemberProfile.onRequest(
    { user: { sub: id, userType }, body: { displayName, email, phone, gymId, gymIds } },
    out,
  );
  return out.body?.user;
}

test('adminListGyms strips operatingHours from default response', async () => {
  // Seed a gym with images and operatingHours
  const gymId = uniq('gym');
  const gymRes = res();
  await adminUpsertGym.onRequest(adminReq({
    body: {
      id: gymId,
      name: 'Test Gym',
      tier: 'standard',
      location: 'DSM',
      images: ['data:image/png;base64,AAAA'],
      thumbnails: ['data:image/webp;base64,BBBB'],
      operatingHours: { mon: '06-22' },
    },
  }), gymRes);
  assert.equal(gymRes.statusCode < 300, true, `gym upsert failed: ${JSON.stringify(gymRes.body)}`);

  // Default list should NOT include operatingHours
  const listRes = res();
  await adminListGyms.onRequest(adminReq(), listRes);
  const gym = listRes.body.find(g => g.id === gymId);
  assert.ok(gym, 'seeded gym should appear in list');
  assert.equal(gym.operatingHours, undefined, 'operatingHours should be stripped from default list');
  assert.ok(gym.images, 'images should still be present for table thumbnails');

  // ?full=true should include everything
  const fullRes = res();
  await adminListGyms.onRequest(adminReq({ query: { full: 'true' } }), fullRes);
  const fullGym = fullRes.body.find(g => g.id === gymId);
  assert.ok(fullGym.operatingHours, 'operatingHours should be present with ?full=true');
});

test('adminListGymOwners returns slimmed gym objects without images/thumbnails', async () => {
  // Seed a gym with heavy image data
  const gymId = uniq('gym_o');
  const oGymRes = res();
  await adminUpsertGym.onRequest(adminReq({
    body: {
      id: gymId,
      name: 'Owner Gym',
      tier: 'midtier',
      location: 'Arusha',
      images: ['data:image/png;base64,' + 'A'.repeat(1000)],
      thumbnails: ['data:image/webp;base64,THUMB'],
    },
  }), oGymRes);

  // Seed an operator linked to this gym
  const ownerId = uniq('usr_op');
  await ensureUser({
    id: ownerId,
    userType: 'gym_operator',
    displayName: 'Test Owner',
    phone: uniqPhone(),
    gymId: gymId,
    gymIds: [gymId],
  });

  const listRes = res();
  await adminListGymOwners.onRequest(adminReq(), listRes);
  const owner = listRes.body.find(o => o.id === ownerId);
  assert.ok(owner, 'seeded owner should appear in list');

  // The embedded gym should be slimmed
  if (owner.gym) {
    assert.equal(owner.gym.images, undefined, 'embedded gym should NOT have images array');
    assert.equal(owner.gym.thumbnails, undefined, 'embedded gym should NOT have thumbnails array');
    assert.ok(owner.gym.thumbnail !== undefined, 'embedded gym should have a single thumbnail field');
  }
  if (owner.gyms && owner.gyms.length > 0) {
    for (const g of owner.gyms) {
      assert.equal(g.images, undefined, 'each embedded gym should NOT have images');
      assert.equal(g.thumbnails, undefined, 'each embedded gym should NOT have thumbnails');
    }
  }
});

test('adminListTrainers returns slimmed gym objects without images/thumbnails', async () => {
  const listRes = res();
  await adminListTrainers.onRequest(adminReq(), listRes);

  // Check any trainer that has linked gyms
  for (const t of listRes.body) {
    if (t.gyms && t.gyms.length > 0) {
      for (const g of t.gyms) {
        assert.equal(g.images, undefined, `trainer ${t.id}: embedded gym should NOT have images`);
        assert.equal(g.thumbnails, undefined, `trainer ${t.id}: embedded gym should NOT have thumbnails`);
        assert.equal(g.operatingHours, undefined, `trainer ${t.id}: embedded gym should NOT have operatingHours`);
      }
    }
  }
});
