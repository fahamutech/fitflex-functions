// Where a member's username shows (flag MEMBER_USERNAMES), against the CI
// database: public views show the username instead of the real name, gyms
// see both, searching never links a real name to a handle, and with the flag
// off nothing changes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { users, gyms, checkins, socialProfiles, gymReviews, memberUsernames } from '../src/bootstrap/collections.mjs';
import { socialService, gymReviewService } from '../src/bootstrap/services.mjs';
import { ownerGymCheckins } from '../functions/owner-gyms.mjs';
import { createPartnerNotifier } from '../src/services/partner-notifier.mjs';

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const letters = () => randomUUID().replace(/-/g, '').slice(0, 8).replace(/[0-9]/g, (d) => 'ghijklmnop'[d]);
const now = () => new Date().toISOString();
const made = { users: [], gyms: [], checkins: [], reviews: [], profiles: [], reports: [] };
const on = () => { process.env.MEMBER_USERNAMES = '1'; };
const off = () => { delete process.env.MEMBER_USERNAMES; };

async function member(displayName, handle = null, { publicProfile = false } = {}) {
  const id = uid('usr');
  await users.insertAsync({ id, userType: 'member', displayName, createdAt: now(), updatedAt: now() });
  made.users.push(id);
  if (handle) {
    await memberUsernames.insertAsync({ id, handle, handleLower: handle.toLowerCase(), status: 'active', changedAt: now(), createdAt: now(), updatedAt: now() });
  }
  if (publicProfile) {
    await socialProfiles.insertAsync({ id, defaultShare: null, inviteCode: letters().toUpperCase(), publicProfile: true, createdAt: now(), updatedAt: now() });
    made.profiles.push(id);
  }
  return id;
}

test('flag off: public people show the real name and no username field', async () => {
  off();
  const real = `Zuri Mwakyusa ${letters()}`;
  const other = await member(`Viewer ${letters()}`);
  const target = await member(real, `zuri_${letters()}`, { publicProfile: true });
  const found = await socialService.findPeople(other, { q: real.slice(0, 12) });
  const hit = found.people.find((p) => p.id === target);
  assert.ok(hit, 'found by real name while the feature is off');
  assert.equal(hit.displayName, real);
  assert.ok(!('username' in hit));
});

test('flag on: a public profile with a username shows as the username, found by it, not by real name', async () => {
  on();
  try {
    const real = `Neema Kitomari ${letters()}`;
    const handle = `neema_${letters()}`;
    const viewer = await member(`Viewer ${letters()}`);
    const target = await member(real, handle, { publicProfile: true });

    const byHandle = await socialService.findPeople(viewer, { q: handle.slice(0, 9) });
    const hit = byHandle.people.find((p) => p.id === target);
    assert.ok(hit, 'found by username');
    assert.equal(hit.displayName, handle, 'public name is the username');
    assert.equal(hit.username, handle);
    assert.ok(!JSON.stringify(hit).includes('Kitomari'), 'real name never in the public payload');

    const byName = await socialService.findPeople(viewer, { q: 'neema kitomari' });
    assert.ok(!byName.people.some((p) => p.id === target), 'searching a real name does not reveal the handle');
  } finally { off(); }
});

test('flag on: a member without a username is unchanged, and searchable by name', async () => {
  on();
  try {
    const real = `Baraka Lyimo ${letters()}`;
    const viewer = await member(`Viewer ${letters()}`);
    const target = await member(real, null, { publicProfile: true });
    const found = await socialService.findPeople(viewer, { q: 'baraka lyimo' });
    const hit = found.people.find((p) => p.id === target);
    assert.ok(hit);
    assert.equal(hit.displayName, real);
    assert.ok(!('username' in hit));
  } finally { off(); }
});

test('reviews: the username replaces "Aisha M." only when there is one', async () => {
  const gymId = uid('gym');
  await gyms.ready;
  await gyms.insertAsync({ id: gymId, name: `Views Gym ${gymId}`, tier: 'standard', location: 'DSM', status: 'active', createdAt: now(), updatedAt: now() });
  made.gyms.push(gymId);
  const a = await member('Aisha Mushi', `aisha_${letters()}`);
  const b = await member('Juma Shaban');
  for (const memberId of [a, b]) {
    const id = uid('rev');
    await gymReviews.insertAsync({ id, gymId, memberId, rating: 5, text: 'Great', status: 'published', createdAt: now(), updatedAt: now() });
    made.reviews.push(id);
  }
  const names = async () => (await gymReviewService.listForGym(gymId)).map((r) => r.memberName).sort();
  off();
  assert.deepEqual(await names(), ['Aisha M.', 'Juma S.']);
  on();
  try {
    const handle = (await memberUsernames.findByIdAsync(a)).handle;
    assert.deepEqual(await names(), [handle, 'Juma S.'].sort());
  } finally { off(); }
});

test('a gym sees the name and the username on its check-ins', async () => {
  on();
  try {
    const gymId = uid('gym');
    await gyms.insertAsync({ id: gymId, name: `Own Gym ${gymId}`, tier: 'standard', location: 'DSM', status: 'active', createdAt: now(), updatedAt: now() });
    made.gyms.push(gymId);
    const ownerId = uid('usr');
    await users.insertAsync({ id: ownerId, userType: 'gym_operator', displayName: 'Owner', gymId, gymIds: [gymId], createdAt: now(), updatedAt: now() });
    made.users.push(ownerId);
    const handle = `amina_${letters()}`;
    const visitor = await member('Amina Said', handle);
    const ck = uid('ck');
    await checkins.insertAsync({ id: ck, memberId: visitor, gymId, timestamp: now(), method: 'qr', subscriptionType: 'platform_pass', passTier: 'pro', gymTier: 'standard', visitConsumed: true, status: 'valid' });
    made.checkins.push(ck);
    process.env.CHECKIN_VISITOR_NAMES = '1';
    const req = { headers: { authorization: `Bearer ${sign({ sub: ownerId, userType: 'gym_operator' })}` }, params: { gymId }, body: {}, query: {} };
    const out = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    for (const g of [ownerGymCheckins.onGuard].flat()) await g(req, out, () => {});
    await ownerGymCheckins.onRequest(req, out);
    const row = out.body.find((r) => r.id === ck);
    assert.equal(row.displayName, 'Amina Said');
    assert.equal(row.username, handle);
  } finally { off(); delete process.env.CHECKIN_VISITOR_NAMES; }
});

test('the gym check-in push carries the name with the username beside it', async () => {
  const gymId = 'gym_push';
  const handle = `amina_${letters()}`;
  const sent = [];
  const people = [
    { id: 'own_1', userType: 'gym_operator', gymId, gymIds: [gymId] },
    { id: 'mem_1', userType: 'member', displayName: 'Amina Said' },
  ];
  const notifier = createPartnerNotifier({
    usernames: { handleOf: async (id) => (id === 'mem_1' ? handle : null) },
    users: {
      filterAsync: async (fn) => people.filter(fn),
      findByIdAsync: async (id) => people.find((p) => p.id === id),
    },
    gyms: { findByIdAsync: async () => ({ id: gymId, name: 'Mikocheni Fitness' }) },
    notify: async (userId, message) => { sent.push({ userId, message }); },
  });
  await notifier.gymCheckin({ id: 'ck_push', gymId, memberId: 'mem_1' });
  assert.equal(sent.length, 1, 'the owner is notified once');
  assert.equal(sent[0].userId, 'own_1');
  assert.equal(sent[0].message.body, `Amina Said (@${handle}) checked in at Mikocheni Fitness.`);
});

after(async () => {
  off();
  for (const id of made.reviews) await db('GymReview').where({ id }).del().catch(() => {});
  for (const id of made.checkins) await db('Checkin').where({ id }).del().catch(() => {});
  for (const id of made.gyms) await db('Gym').where({ id }).del().catch(() => {});
  for (const id of made.profiles) await db('SocialProfile').where({ id }).del().catch(() => {});
  for (const id of made.users) {
    await db('MemberUsername').where({ id }).del().catch(() => {});
    await db('User').where({ id }).del().catch(() => {});
  }
});
