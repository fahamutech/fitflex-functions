// Member sharing on by default (owner decision 2026-10-19): profiles are
// public and new activities go to Public and every group the member is in
// when the activity is created. Past activities keep who they were shared
// with, and a member's explicit choices are kept from then on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocialService, DEFAULT_SHARE } from '../src/services/social-service.mjs';
import { createActivityService } from '../src/services/activity-service.mjs';

function store(rows = []) {
  const clone = (r) => JSON.parse(JSON.stringify(r));
  return {
    rows,
    async allAsync() { return rows.map(clone); },
    async filterAsync(pred) { return rows.filter(pred).map(clone); },
    async filterByColumnAsync(col, v) { return rows.filter(r => r[col] === v).map(clone); },
    async findByIdAsync(id) { const r = rows.find(x => x.id === id); return r ? clone(r) : null; },
    async insertAsync(row) { rows.push(clone(row)); return row; },
    async updateByIdAsync(id, patch) { const r = rows.find(x => x.id === id); Object.assign(r, clone(patch)); return clone(r); },
    async removeByIdAsync(id) { const i = rows.findIndex(x => x.id === id); if (i >= 0) rows.splice(i, 1); },
  };
}

const NOW = new Date('2026-10-19T09:00:00.000Z');
const ago = h => new Date(+NOW - h * 3600e3).toISOString();

function setup() {
  const u = (id, name) => ({ id, userType: 'member', displayName: name, accountStatus: 'active', corporateId: null });
  const s = {
    users: store([u('ana', 'Ana Mrema'), u('ben', 'Ben Kimaro'), u('cy', 'Cy Lyimo')]),
    activities: store(), follows: store(), blocks: store(), profiles: store(), groups: store(), groupMembers: store(),
    kudos: store(), comments: store(), reports: store(), views: store(),
  };
  s.svc = createSocialService({ ...s, now: () => NOW });
  s.acts = createActivityService({ activities: s.activities, resolveShare: (m, raw) => s.svc.resolveShare(m, raw), now: () => NOW });
  s.log = async (who, hours = 2) => (await s.acts.log(who, { type: 'running', startedAt: ago(hours), distanceKm: 5, durationMinutes: 30 })).activity;
  s.sees = async (viewer, a) => s.svc.canView(viewer, await s.activities.findByIdAsync(a.id));
  s.group = async (owner, name) => (await s.svc.createGroup({ ownerType: 'member', ownerId: owner, createdBy: owner }, { name, joinPolicy: 'open', discoverable: true })).group;
  return s;
}

const share = (over = {}) => ({ friends: false, followers: false, public: true, groups: [], company: false, ...over });

test('a new social profile is public with Public + all groups as the default', async () => {
  const s = setup();
  const st = await s.svc.settings('ana');
  assert.equal(st.publicProfile, true);
  assert.deepEqual(st.defaultShare, { ...DEFAULT_SHARE, groups: [] });
  assert.equal(st.defaultShare.allGroups, true, 'the app can show "all my groups"');
  assert.equal(s.profiles.rows[0].publicProfile, true);
});

test('a member who never opened the settings (no profile row) is public by default', async () => {
  const s = setup();
  const a = await s.log('ana');
  assert.equal(s.profiles.rows.length, 0, 'saving an activity writes no profile row');
  assert.deepEqual(a.shareWith, share(), 'Public; no groups yet');
  assert.equal(await s.sees('cy', a), true, 'any member sees a public post');
  assert.deepEqual((await s.svc.findPeople('cy', { q: 'ana' })).people.map(p => p.id), ['ana']);
  assert.deepEqual((await s.svc.explore('cy')).items.map(i => i.activity.id), [a.id], 'and it reaches Explore');
  assert.equal((await s.svc.profilePage('cy', 'ana')).person.publicProfile, true);
});

test('all groups means the groups the member is in when each activity is saved', async () => {
  const s = setup();
  const runners = await s.group('ben', 'Runners');
  const walkers = await s.group('ben', 'Walkers');
  await s.svc.joinGroup('ana', { groupId: runners.id });
  const before = await s.log('ana', 3);
  assert.deepEqual(before.shareWith, share({ groups: [runners.id] }));
  assert.equal('allGroups' in before.shareWith, false, 'the stamp is the concrete list');

  await s.svc.joinGroup('ana', { groupId: walkers.id });
  const after = await s.log('ana', 1);
  assert.deepEqual(after.shareWith.groups.sort(), [runners.id, walkers.id].sort(), 'a group joined later gets activities logged after joining');
  assert.deepEqual((await s.activities.findByIdAsync(before.id)).shareWith.groups, [runners.id], 'past activities are not rewritten');

  await s.svc.leaveGroup('ana', runners.id);
  assert.deepEqual((await s.log('ana', 0.5)).shareWith.groups, [walkers.id], 'groups left drop out');
});

test('a default saved without allGroups is the member\'s choice and is kept', async () => {
  const s = setup();
  const g = await s.group('ben', 'Runners');
  await s.svc.joinGroup('ana', { groupId: g.id });
  const r = await s.svc.updateSettings('ana', { defaultShare: { v: 2, public: true } });
  assert.deepEqual(r.settings.defaultShare, share({ allGroups: false }));
  assert.deepEqual((await s.log('ana')).shareWith, share(), 'no groups');

  // Choosing specific groups.
  const other = await s.group('ben', 'Walkers');
  await s.svc.joinGroup('ana', { groupId: other.id });
  await s.svc.updateSettings('ana', { defaultShare: { v: 2, groups: [g.id] } });
  assert.deepEqual((await s.log('ana')).shareWith, share({ public: false, groups: [g.id] }));

  // Back to all groups, and private by default.
  await s.svc.updateSettings('ana', { defaultShare: { v: 2, allGroups: true } });
  assert.deepEqual((await s.svc.settings('ana')).defaultShare, share({ public: false, allGroups: true }));
  assert.deepEqual((await s.log('ana')).shareWith.groups.sort(), [g.id, other.id].sort());
  await s.svc.updateSettings('ana', { defaultShare: null });
  assert.equal((await s.log('ana')).shareWith, null, 'private by choice stays private');
});

test('allGroups sent with one activity shares it with the groups the member is in now', async () => {
  const s = setup();
  const g = await s.group('ben', 'Runners');
  await s.svc.joinGroup('ana', { groupId: g.id });
  const a = (await s.acts.log('ana', { type: 'walking', startedAt: ago(1), steps: 100, shareWith: { v: 2, allGroups: true } })).activity;
  assert.deepEqual(a.shareWith, share({ public: false, groups: [g.id] }));
});

test('turning the public profile off drops public from the default but keeps all groups', async () => {
  const s = setup();
  const g = await s.group('ben', 'Runners');
  await s.svc.joinGroup('ana', { groupId: g.id });
  const pub = await s.log('ana', 3);
  await s.svc.updateSettings('ana', { publicProfile: false });
  const st = await s.svc.settings('ana');
  assert.equal(st.publicProfile, false);
  assert.deepEqual(st.defaultShare, share({ public: false, allGroups: true }));
  const a = await s.log('ana');
  assert.deepEqual(a.shareWith, share({ public: false, groups: [g.id] }));
  assert.equal(await s.sees('cy', a), false, 'not public');
  assert.equal(await s.sees('ben', a), true, 'group-mates still see it');
  assert.equal(await s.sees('cy', pub), false, 'older public posts hide with the profile');
  assert.deepEqual((await s.svc.explore('cy')).items, []);
  assert.deepEqual((await s.svc.findPeople('cy', { q: 'ana' })).people, []);
});

test('device step rows get the member\'s default; rows already saved keep theirs', async () => {
  const s = setup();
  const g = await s.group('ben', 'Runners');
  await s.svc.joinGroup('ana', { groupId: g.id });
  const rec = (day, steps) => ({ devicePlatform: 'phone_sensor', externalId: `steps:${day}`, type: 'walking', startedAt: `${day}T00:00:00.000Z`, steps });
  assert.deepEqual(await s.acts.syncDevice('ana', { records: [rec('2026-10-18', 6000), rec('2026-10-19', 2000)] }), { created: 2, updated: 0, unchanged: 0 });
  for (const row of s.activities.rows) assert.deepEqual(row.shareWith, share({ groups: [g.id] }));

  // Switching to private changes neither the saved rows nor their updates.
  await s.svc.updateSettings('ana', { defaultShare: null });
  await s.acts.syncDevice('ana', { records: [rec('2026-10-19', 5000)] });
  const today = s.activities.rows.find(r => r.externalId === 'steps:2026-10-19');
  assert.equal(today.steps, 5000);
  assert.deepEqual(today.shareWith, share({ groups: [g.id] }));
  await s.acts.syncDevice('ana', { records: [rec('2026-10-17', 3000)] });
  assert.equal(s.activities.rows.find(r => r.externalId === 'steps:2026-10-17').shareWith, null, 'new rows follow the new default');
});
