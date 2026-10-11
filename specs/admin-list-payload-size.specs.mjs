// Regression: admin list endpoints must return slimmed payloads.
// Ensures gym objects embedded in trainers carry only a single `thumbnail`
// (no images/thumbnails/operatingHours), and gym objects embedded in owners
// are lean references (id/name/tier — no image at all, since an owner can be
// linked to many gyms). Also verifies adminListGyms is slimmed by default
// (single `thumbnail`, no `images`/`thumbnails`/`operatingHours` — gym images
// are full-size base64 data URIs, so embedding them per row previously made
// this the largest admin payload by far) and only returns everything with
// `?full=true`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminListGyms, adminUpsertGym } from '../functions/gyms.mjs';
import { adminListGymOwners, adminUpsertGymOwner } from '../functions/admin-owners.mjs';
import { adminListTrainers, adminUpsertTrainer } from '../functions/trainers.mjs';
import { updateMemberProfile } from '../functions/subscriptions.mjs';

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

  // Default list should be slimmed: no operatingHours, no images/thumbnails
  // arrays — just a single `thumbnail` (only set when a real thumbnail was
  // uploaded; never a fallback to the raw base64 image).
  const listRes = res();
  await adminListGyms.onRequest(adminReq(), listRes);
  const gym = listRes.body.find(g => g.id === gymId);
  assert.ok(gym, 'seeded gym should appear in list');
  assert.equal(gym.operatingHours, undefined, 'operatingHours should be stripped from default list');
  assert.equal(gym.images, undefined, 'images array should NOT be present in the default admin list');
  assert.equal(gym.thumbnails, undefined, 'thumbnails array should NOT be present in the default admin list');
  assert.equal(gym.thumbnail, 'data:image/webp;base64,BBBB', 'a real uploaded thumbnail should still surface as a single field');
  assert.equal(gym.amenities, undefined, 'amenities should be stripped from table-level list');
  assert.equal(gym.equipment, undefined, 'equipment should be stripped from table-level list');
  assert.equal(gym.coordinates, undefined, 'coordinates should be stripped from table-level list');
  assert.equal(gym.paymentBank, undefined, 'paymentBank should be stripped from table-level list');

  // ?full=true should include everything
  const fullRes = res();
  await adminListGyms.onRequest(adminReq({ query: { full: 'true' } }), fullRes);
  const fullGym = fullRes.body.find(g => g.id === gymId);
  assert.ok(fullGym.operatingHours, 'operatingHours should be present with ?full=true');
  assert.ok(fullGym.images, 'images should be present with ?full=true');
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

  // The embedded gym should be a lean reference (id/name/tier only — no image at all;
  // callers needing the image fetch the gym directly via GET /gyms/:id).
  if (owner.gym) {
    assert.equal(owner.gym.images, undefined, 'embedded gym should NOT have images array');
    assert.equal(owner.gym.thumbnails, undefined, 'embedded gym should NOT have thumbnails array');
    assert.equal(owner.gym.thumbnail, undefined, 'embedded gym should NOT have a thumbnail field either');
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

test('adminListGymOwners ?refs=true returns a lightweight id/displayName/email/gymIds projection', async () => {
  const gymId = uniq('gym_or');
  await adminUpsertGym.onRequest(adminReq({
    body: { id: gymId, name: 'Refs Owner Gym', tier: 'standard', location: 'DSM' },
  }), res());

  const ownerId = uniq('usr_or');
  const ownerUpsertRes = res();
  await adminUpsertGymOwner.onRequest(adminReq({
    body: { id: ownerId, displayName: 'Refs Owner', email: `${ownerId}@x.test`, gymId },
  }), ownerUpsertRes);
  assert.equal(ownerUpsertRes.statusCode < 300, true, `owner upsert failed: ${JSON.stringify(ownerUpsertRes.body)}`);

  const refsRes = res();
  await adminListGymOwners.onRequest(adminReq({ query: { refs: 'true' } }), refsRes);
  const owner = refsRes.body.find(o => o.id === ownerId);
  assert.ok(owner, 'seeded owner should appear in refs list');
  assert.deepEqual(
    Object.keys(owner).sort(),
    ['displayName', 'email', 'gymId', 'gymIds', 'id'],
    'refs projection should only contain id/displayName/email/gymId/gymIds'
  );
  assert.equal(owner.gymIds.includes(gymId), true);

  // Default (non-refs) list should still return the full hydrated shape.
  const fullRes = res();
  await adminListGymOwners.onRequest(adminReq(), fullRes);
  const fullOwner = fullRes.body.find(o => o.id === ownerId);
  assert.ok('accountStatus' in fullOwner, 'default list should retain full owner fields');
});

test('adminListTrainers ?refs=true returns a lightweight id/displayName/email/gymIds projection', async () => {
  const trainerId = uniq('trn_r');
  const upsertRes = res();
  await adminUpsertTrainer.onRequest(adminReq({
    body: { id: trainerId, displayName: 'Refs Trainer', email: `${trainerId}@x.test`, hourlyRateTzs: 10000, status: 'active' },
  }), upsertRes);
  assert.equal(upsertRes.statusCode < 300, true, `trainer upsert failed: ${JSON.stringify(upsertRes.body)}`);

  const refsRes = res();
  await adminListTrainers.onRequest(adminReq({ query: { refs: 'true' } }), refsRes);
  const trainer = refsRes.body.find(t => t.id === trainerId);
  assert.ok(trainer, 'seeded trainer should appear in refs list');
  assert.deepEqual(
    Object.keys(trainer).sort(),
    ['displayName', 'email', 'fullName', 'gymIds', 'id', 'nickname'],
    'refs projection should only contain id, the names, email and gymIds'
  );

  // Default (non-refs) list should still return the full profile shape.
  const fullRes = res();
  await adminListTrainers.onRequest(adminReq(), fullRes);
  const fullTrainer = fullRes.body.find(t => t.id === trainerId);
  assert.ok('specialties' in fullTrainer, 'default list should retain full trainer fields');
});
