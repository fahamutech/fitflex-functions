// Self-service registration only takes what the partner may set themselves
// (runs against the CI database). A trainer registering cannot make themselves
// verified, top-rated or promoted; a gym owner registering cannot name an
// existing gym and take it over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trainerRegister, adminUpsertTrainer, getTrainer } from '../functions/trainers.mjs';
import { gymOwnerRegister } from '../functions/owner-gyms.mjs';
import { adminUpsertGym } from '../functions/gyms.mjs';
import { updateMemberProfile } from '../functions/subscriptions.mjs';
import { trainers, gyms, users } from '../src/bootstrap/services.mjs';

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
const admin = { sub: 'admin_allowlist_spec', userType: 'admin', aclPermissions: ['*'] };

async function ensureUser({ id, userType, displayName }) {
  const out = res();
  await updateMemberProfile.onRequest(
    { user: { sub: id, userType }, body: { displayName, email: `${id}@example.test`, phone: uniqPhone() } },
    out,
  );
  assert.equal(out.statusCode, 200, `ensureUser ${userType} failed: ${JSON.stringify(out.body)}`);
  return out.body.user;
}

// Everything a trainer might try to set that belongs to FitFlex.
const FORGED = {
  verified: true, rating: 5, reviewCount: 900, homepagePriority: 999, homepageVisible: true,
  status: 'active', approvalStatus: 'approved', userId: 'usr_someone_else', email: 'forged@example.test',
  id: 'trn_forged', pendingGymIds: ['gym_forged'], createdAt: '2020-01-01T00:00:00.000Z',
};
const OWN = {
  displayName: 'Allowlist Kocha', photoUrl: '/storage/bafytest/a.jpg', gender: 'male',
  bio: 'Strength coach', hourlyRateTzs: 20000, experienceYears: 4, specialties: ['strength'],
};

async function register(userId, body) {
  const out = res();
  await trainerRegister.onRequest({ user: { sub: userId, userType: 'trainer' }, body }, out);
  return out;
}

test('trainer register: FitFlex-owned fields in the body are ignored on a new profile', async () => {
  const user = await ensureUser({ id: uniq('usr_trn_allow'), userType: 'trainer', displayName: 'Allowlist Kocha' });
  const out = await register(user.id, { ...OWN, ...FORGED });
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));

  const row = trainers.find(t => t.userId === user.id);
  assert.ok(row, 'profile saved under the caller');
  assert.notEqual(row.id, 'trn_forged');
  assert.ok(!trainers.find(t => t.id === 'trn_forged'));
  assert.equal(row.userId, user.id);
  assert.equal(row.email, user.email);
  assert.equal(row.verified, false);
  assert.equal(row.rating, 0);
  assert.equal(row.reviewCount, 0);
  assert.equal(row.homepagePriority, 0);
  assert.equal(row.homepageVisible, true);
  assert.deepEqual(row.pendingGymIds, []);
  assert.notEqual(row.createdAt, FORGED.createdAt);
  // What the trainer may set is kept.
  assert.equal(row.displayName, OWN.displayName);
  assert.equal(row.bio, OWN.bio);
  assert.equal(row.hourlyRateTzs, OWN.hourlyRateTzs);
  assert.equal(row.experienceYears, OWN.experienceYears);
  assert.deepEqual(row.specialties, OWN.specialties);

  // And the public card shows no badge, rating or reviews the trainer sent.
  const pub = res();
  await getTrainer.onRequest({ params: { id: row.id } }, pub);
  assert.equal(pub.statusCode, 200);
  assert.notEqual(pub.body.verified, true);
  assert.equal(pub.body.rating, 0);
  assert.equal(pub.body.reviewCount, 0);
});

test('trainer register: registering again keeps FitFlex-set values and a suspension', async () => {
  const user = await ensureUser({ id: uniq('usr_trn_allow2'), userType: 'trainer', displayName: 'Allowlist Kocha' });
  assert.equal((await register(user.id, OWN)).statusCode, 200);
  const id = trainers.find(t => t.userId === user.id).id;

  const set = res();
  await adminUpsertTrainer.onRequest({
    user: admin,
    body: { id, verified: false, rating: 3.5, reviewCount: 2, homepagePriority: 1, homepageVisible: false, status: 'suspended' },
  }, set);
  assert.equal(set.statusCode, 200, JSON.stringify(set.body));

  const out = await register(user.id, { ...OWN, bio: 'Updated bio', ...FORGED });
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  const row = trainers.find(t => t.id === id);
  assert.equal(row.verified, false);
  assert.equal(row.rating, 3.5);
  assert.equal(row.reviewCount, 2);
  assert.equal(row.homepagePriority, 1);
  assert.equal(row.homepageVisible, false);
  assert.equal(row.status, 'suspended');
  assert.equal(row.userId, user.id);
  assert.equal(row.bio, 'Updated bio');
});

test('gym owner register: a gym id in the body never overwrites an existing gym', async () => {
  const victim = res();
  const victimName = uniq('Victim Gym');
  await adminUpsertGym.onRequest({
    user: admin,
    body: { name: victimName, tier: 'standard', location: 'Dar es Salaam', perVisitRate: 5000 },
  }, victim);
  assert.equal(victim.statusCode, 200, JSON.stringify(victim.body));
  const victimId = victim.body.id;

  const ownerId = uniq('usr_owner_allow');
  await ensureUser({ id: ownerId, userType: 'gym_operator', displayName: 'Allowlist Owner' });
  const out = res();
  await gymOwnerRegister.onRequest({
    user: { sub: ownerId, userType: 'gym_operator' },
    body: { displayName: 'Allowlist Owner', gyms: [{ id: victimId, name: 'Hijacked', tier: 'standard', location: 'Arusha' }] },
  }, out);
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));

  const [newId] = out.body.gymIds;
  assert.notEqual(newId, victimId);
  const kept = gyms.find(g => g.id === victimId);
  assert.equal(kept.name, victimName);
  assert.equal(kept.location, 'Dar es Salaam');
  const owner = await users.findByIdAsync(ownerId);
  assert.ok(!(owner.gymIds || []).includes(victimId), 'owner does not gain the existing gym');
});
