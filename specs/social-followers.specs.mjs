// Followers and public posts: one-way follows see Followers posts; public
// profiles and posts, Explore, profiles, views and engagement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocialService } from '../src/services/social-service.mjs';
import { createActivityService } from '../src/services/activity-service.mjs';
import { deliveredTo } from './fixtures/notification-language.mjs';

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

const NOW = new Date('2026-09-26T09:00:00.000Z');
const ago = h => new Date(+NOW - h * 3600e3).toISOString();

function setup() {
  const u = (id, name) => ({ id, userType: 'member', displayName: name, accountStatus: 'active', corporateId: null });
  const s = {
    users: store([u('star', 'Neema Star'), u('fan', 'Juma Fan'), u('fan2', 'Asha Fan'), u('stranger', 'Baraka Stranger')]),
    activities: store(), follows: store(), blocks: store(), profiles: store(), groups: store(), groupMembers: store(),
    kudos: store(), comments: store(), reports: store(), views: store(), sent: [], messages: [],
  };
  s.svc = createSocialService({ ...s, notify: async (to, m) => { s.messages.push(m); s.sent.push({ to, type: m.type }); }, now: () => NOW });
  s.acts = createActivityService({ activities: s.activities, resolveShare: (m, raw) => s.svc.resolveShare(m, raw), now: () => NOW });
  s.post = async (who, shareWith, hours = 2) => (await s.acts.log(who, { type: 'running', startedAt: ago(hours), distanceKm: 8, durationMinutes: 40, notes: 'Hill repeats', shareWith })).activity;
  s.sees = async (viewer, a) => s.svc.canView(viewer, await s.activities.findByIdAsync(a.id));
  return s;
}

test('Followers: a one-way follow sees it — no follow-back needed; Friends still needs both', async () => {
  const s = setup();
  const forFollowers = await s.post('star', { v: 2, followers: true });
  const forFriends = await s.post('star', { v: 2, friends: true });
  assert.equal(await s.sees('fan', forFollowers), false, 'not following yet');
  await s.svc.follow('fan', 'star');
  assert.deepEqual(s.sent.pop(), { to: 'star', type: 'social_follow' });
  // The notice follows the reader's language: Swahili if they chose it, English otherwise.
  const notice = s.messages.at(-1);
  assert.deepEqual(notice.data, { userId: 'fan' });
  const sw = await deliveredTo(notice, 'sw');
  assert.deepEqual([sw.title, sw.body, sw.push.body], ['Mfuasi mpya', 'Juma Fan ameanza kukufuata.', 'Juma Fan ameanza kukufuata.']);
  const en = await deliveredTo(notice, null);
  assert.deepEqual([en.title, en.body], ['New follower', 'Juma Fan started following you.']);
  assert.equal(await s.sees('fan', forFollowers), true);
  assert.equal(await s.sees('fan', forFriends), false, 'friends means mutual');
  assert.equal((await s.svc.feed('fan')).items.map(i => i.activity.id).join(), forFollowers.id);

  // The star doesn't see the fan's Followers posts unless they follow back.
  const fanPost = await s.post('fan', { v: 2, followers: true });
  assert.equal(await s.sees('star', fanPost), false);
  await s.svc.follow('star', 'fan');
  assert.equal(await s.sees('star', fanPost), true);
  assert.equal(await s.sees('fan', forFriends), true, 'now friends');
});

test('Public: needs a public profile; then any member sees it, finds them and can open their profile', async () => {
  const s = setup();
  assert.equal((await s.acts.log('star', { type: 'walking', startedAt: ago(1), steps: 10, shareWith: { v: 2, public: true } })).error, 'profile_not_public');
  assert.deepEqual((await s.svc.findPeople('stranger', { q: 'neema' })).people, [], 'private profiles aren\'t searchable');
  assert.equal((await s.svc.profilePage('stranger', 'star')).status, 404);

  await s.svc.updateSettings('star', { publicProfile: true });
  const pub = await s.post('star', { v: 2, public: true });
  const followersOnly = await s.post('star', { v: 2, followers: true }, 3);
  assert.equal(await s.sees('stranger', pub), true);
  assert.equal(await s.sees('stranger', followersOnly), false);
  assert.deepEqual((await s.svc.findPeople('stranger', { q: 'neema' })).people.map(p => p.id), ['star']);

  const profile = await s.svc.profilePage('stranger', 'star');
  assert.equal(profile.person.publicProfile, true);
  assert.equal(profile.person.relationship, 'none');
  assert.deepEqual(profile.items.map(i => i.activity.id), [pub.id], 'only what they can see');
  await s.svc.follow('stranger', 'star');
  const after = await s.svc.profilePage('stranger', 'star');
  assert.deepEqual(after.items.map(i => i.activity.id), [pub.id, followersOnly.id]);
  assert.equal(after.person.followers, 1);

  // Turning the profile off hides public posts from non-followers again.
  await s.svc.updateSettings('star', { publicProfile: false });
  assert.equal(await s.sees('fan', pub), false);
});

test('Explore: recent public posts from public profiles; blocks respected', async () => {
  const s = setup();
  await s.svc.updateSettings('star', { publicProfile: true });
  const pub = await s.post('star', { v: 2, public: true });
  await s.post('star', { v: 2, followers: true });
  await s.post('star', { v: 2, public: true }, 24 * 20); // too old
  const ex = await s.svc.explore('stranger');
  assert.deepEqual(ex.items.map(i => i.activity.id), [pub.id]);
  assert.equal(ex.items[0].owner.relationship, 'none');
  await s.svc.block('star', 'stranger');
  assert.equal((await s.svc.explore('stranger')).items.length, 0);
});

test('views and engagement: the poster sees a view count and who engaged; viewers stay anonymous', async () => {
  const s = setup();
  await s.svc.updateSettings('star', { publicProfile: true });
  const pub = await s.post('star', { v: 2, public: true });
  await s.svc.activityDetail('fan', pub.id);
  await s.svc.activityDetail('fan', pub.id);
  await s.svc.activityDetail('fan2', pub.id);
  await s.svc.activityDetail('star', pub.id);
  await s.svc.toggleKudos('fan', pub.id, true);
  await s.svc.addComment('fan2', pub.id, { text: 'Inspiring!' });

  const own = (await s.svc.activityDetail('star', pub.id)).item;
  assert.equal(own.views, 2, 'two people, counted once each; the poster doesn\'t count');
  assert.ok(!('views' in (await s.svc.activityDetail('fan', pub.id)).item), 'only the poster sees views');

  const e = await s.svc.engagement('star', pub.id);
  assert.equal(e.views, 2);
  assert.deepEqual(e.kudos.map(p => [p.id, p.relationship]), [['fan', 'none']]);
  assert.deepEqual(e.commenters.map(p => p.id), ['fan2']);
  assert.ok(!('viewers' in e), 'no list of who viewed');
  assert.equal((await s.svc.engagement('fan', pub.id)).status, 404, 'only the poster');

  // Follow back from there.
  await s.svc.follow('star', 'fan');
  assert.equal((await s.svc.engagement('star', pub.id)).kudos[0].relationship, 'following');
});

test('the default audience can include followers and public', async () => {
  const s = setup();
  assert.equal((await s.svc.updateSettings('star', { defaultShare: { v: 2, public: true } })).error, 'profile_not_public');
  await s.svc.updateSettings('star', { publicProfile: true, defaultShare: { v: 2, followers: true, public: true } });
  assert.deepEqual((await s.post('star')).shareWith, { friends: false, followers: true, public: true, groups: [], company: false });
  await s.svc.updateSettings('star', { publicProfile: false });
  assert.deepEqual((await s.post('star')).shareWith, { friends: false, followers: true, public: false, groups: [], company: false }, 'public drops out with the profile');
});
