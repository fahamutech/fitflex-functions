// Sharing between members: only mutual followers, group-mates or company
// colleagues ever see a shared activity; private by default; blocks hide
// everything; group owners who aren't members see nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocialService, publicActivity } from '../src/services/social-service.mjs';
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

const NOW = new Date('2026-09-25T09:00:00.000Z');
const ago = h => new Date(+NOW - h * 3600e3).toISOString();

function setup() {
  const u = (id, extra = {}) => ({ id, userType: 'member', displayName: id.toUpperCase(), accountStatus: 'active', corporateId: null, ...extra });
  const s = {
    users: store([u('ana'), u('ben'), u('cy'), u('dee', { corporateId: 'corp_1' }), u('eli', { corporateId: 'corp_1' }), u('hr', { userType: 'corporate_hr', corporateId: 'corp_1' }), u('fay', { corporateId: 'corp_2' })]),
    activities: store(),
    follows: store(), blocks: store(), profiles: store(), groups: store(), groupMembers: store(),
    kudos: store(), comments: store(), reports: store(), auditLog: store(),
    sent: [],
  };
  s.svc = createSocialService({ ...s, notify: async (to, m) => s.sent.push({ to, type: m.type }), now: () => NOW });
  s.acts = createActivityService({ activities: s.activities, resolveShare: (m, raw) => s.svc.resolveShare(m, raw), now: () => NOW });
  s.log = async (who, shareWith) => (await s.acts.log(who, { type: 'running', startedAt: ago(2), distanceKm: 5, durationMinutes: 30, calories: 400, notes: 'Morning run', ...(shareWith !== undefined && { shareWith }) })).activity;
  s.sees = async (viewer, a) => s.svc.canView(viewer, await s.activities.findByIdAsync(a.id));
  return s;
}

test('private by default; `followers` from older apps still means mutual friends', async () => {
  const s = setup();
  const priv = await s.log('ana');
  assert.equal(priv.shareWith, null, 'nothing is shared unless chosen');
  const shared = await s.log('ana', { followers: true });

  assert.equal(await s.sees('ben', shared), false);
  await s.svc.follow('ben', 'ana');
  assert.equal(await s.sees('ben', shared), false, 'one-way follow shows nothing');
  assert.deepEqual(s.sent.pop(), { to: 'ana', type: 'social_follow' });
  const back = await s.svc.follow('ana', 'ben');
  assert.equal(back.person.relationship, 'friends');
  assert.deepEqual(s.sent.pop(), { to: 'ben', type: 'social_friends' });
  assert.equal(await s.sees('ben', shared), true);
  assert.equal(await s.sees('ben', priv), false, 'private stays private, even for friends');
  assert.equal(await s.sees('cy', shared), false);

  await s.svc.unfollow('ben', 'ana');
  assert.equal(await s.sees('ben', shared), false, 'no longer mutual');
  const c = await s.svc.connections('ana');
  assert.deepEqual(c.followers.map(p => p.id), [], 'ben unfollowed');
  assert.deepEqual(c.following.map(p => p.id), ['ben']);
});

test('what a friend sees: never calories, route or health notes', async () => {
  const s = setup();
  const a = await s.log('ana', { followers: true });
  const pub = publicActivity({ ...a, hasRoute: true });
  assert.ok(!('calories' in pub));
  assert.ok(!('hasRoute' in pub) && !('shareWith' in pub));
  assert.equal(pub.title, 'Morning run');
  assert.equal(pub.distanceKm, 5);
});

test('groups: members see what is shared with the group; owners who are not members see nothing', async () => {
  const s = setup();
  const { group } = await s.svc.createGroup({ ownerType: 'member', ownerId: 'ana', createdBy: 'ana' }, { name: 'Dar Runners', joinPolicy: 'approval', discoverable: true });
  assert.equal(group.you.role, 'admin');

  // Sharing with a group you're not in is refused.
  assert.equal((await s.acts.log('ben', { type: 'walking', startedAt: ago(1), steps: 100, shareWith: { groups: [group.id] } })).error, 'not_in_group');

  const pending = await s.svc.joinGroup('ben', { groupId: group.id });
  assert.equal(pending.group.you.status, 'pending', 'approval groups wait for an admin');
  const a = await s.log('ana', { groups: [group.id] });
  assert.equal(await s.sees('ben', a), false, 'pending members see nothing');
  await s.svc.setMember({ userId: 'ana' }, group.id, 'ben', 'approve');
  assert.equal(await s.sees('ben', a), true);

  const viaCode = await s.svc.joinGroup('cy', { inviteCode: group.inviteCode.toLowerCase() });
  assert.equal(viaCode.group.you.status, 'active', 'the invite code lets you straight in');
  assert.equal(await s.sees('cy', a), true);
  await s.svc.leaveGroup('cy', group.id);
  assert.equal(await s.sees('cy', a), false);

  // A trainer's group: members see each other; the trainer sees nobody.
  const t = (await s.svc.createGroup({ ownerType: 'trainer', ownerId: 'tr_1', createdBy: 'u_trainer' }, { name: 'PT clients', joinPolicy: 'open' })).group;
  assert.equal(t.memberCount, 0, 'the trainer is not a member');
  await s.svc.joinGroup('ben', { inviteCode: t.inviteCode });
  await s.svc.joinGroup('cy', { inviteCode: t.inviteCode });
  const b = (await s.acts.log('ben', { type: 'walking', startedAt: ago(1), steps: 4000, shareWith: { groups: [t.id] } })).activity;
  assert.equal(await s.sees('cy', b), true);
  assert.equal(await s.sees('u_trainer', b), false);
  const owned = await s.svc.ownedGroups({ ownerType: 'trainer', ownerId: 'tr_1' });
  assert.equal(owned.groups[0].memberCount, 2);
  assert.equal((await s.svc.groupDetail({ ownerType: 'trainer', ownerId: 'tr_1' }, t.id)).members.length, 2, 'owner manages the member list');
  assert.equal((await s.svc.groupDetail({ ownerType: 'trainer', ownerId: 'tr_other' }, t.id)).status, 404);

  // The last admin can't walk away from a group that still has members.
  assert.equal((await s.svc.leaveGroup('ana', group.id)).error, 'last_admin');
});

test('company audience: colleagues only — never HR, never another company', async () => {
  const s = setup();
  assert.equal((await s.acts.log('ana', { type: 'walking', startedAt: ago(1), steps: 1, shareWith: { company: true } })).error, 'no_company');
  const a = (await s.acts.log('dee', { type: 'walking', startedAt: ago(1), steps: 6000, shareWith: { company: true } })).activity;
  assert.equal(await s.sees('eli', a), true);
  assert.equal(await s.sees('hr', a), false, 'HR sees no one\'s activity');
  assert.equal(await s.sees('fay', a), false);

  // Company groups are for that company's staff.
  const g = (await s.svc.createGroup({ ownerType: 'corporate', ownerId: 'corp_1', createdBy: 'hr' }, { name: 'Kilimo walkers', joinPolicy: 'open', discoverable: true })).group;
  assert.equal((await s.svc.joinGroup('fay', { groupId: g.id })).error, 'company_only');
  assert.equal((await s.svc.joinGroup('eli', { groupId: g.id })).group.you.status, 'active');
  assert.deepEqual((await s.svc.discoverGroups('fay')).groups, []);
  assert.equal((await s.svc.joinGroup('hr', { groupId: g.id })).error, 'members_only');
});

test('a block hides everything both ways and ends the connection', async () => {
  const s = setup();
  await s.svc.follow('ana', 'ben'); await s.svc.follow('ben', 'ana');
  const a = await s.log('ana', { followers: true });
  assert.equal(await s.sees('ben', a), true);
  await s.svc.block('ana', 'ben');
  assert.equal(await s.sees('ben', a), false);
  assert.equal((await s.svc.connections('ben')).friends.length, 0);
  assert.equal((await s.svc.follow('ben', 'ana')).status, 404, 'can\'t follow someone who blocked you');
  assert.deepEqual((await s.svc.settings('ana')).blocked.map(b => b.id), ['ben']);
  await s.svc.unblock('ana', 'ben');
  assert.equal((await s.svc.follow('ben', 'ana')).person.relationship, 'following');
});

test('feed, kudos and comments', async () => {
  const s = setup();
  await s.svc.follow('ana', 'ben'); await s.svc.follow('ben', 'ana');
  const mine = await s.log('ben', { followers: true });
  const hidden = await s.log('ben');
  const old = (await s.acts.log('ben', { type: 'walking', startedAt: new Date(+NOW - 40 * 86400e3).toISOString(), steps: 1, shareWith: { followers: true } })).activity;

  const feed = await s.svc.feed('ana');
  assert.deepEqual(feed.items.map(i => i.activity.id), [mine.id], 'shared, recent, visible only');
  assert.equal(feed.items[0].owner.relationship, 'friends');
  assert.ok(!feed.items.some(i => [hidden.id, old.id].includes(i.activity.id)));

  assert.deepEqual(await s.svc.toggleKudos('ana', mine.id, true), { kudos: 1, youKudoed: true, comments: 0 });
  assert.deepEqual(await s.svc.toggleKudos('ana', mine.id, true), { kudos: 1, youKudoed: true, comments: 0 }, 'once per person');
  assert.equal((await s.svc.toggleKudos('cy', mine.id, true)).status, 404, 'only people who can see it');
  const c = (await s.svc.addComment('ana', mine.id, { text: '  Strong pace!  ' })).comment;
  assert.equal(c.text, 'Strong pace!');
  assert.equal((await s.svc.addComment('ana', mine.id, { text: '   ' })).error, 'empty_comment');
  assert.deepEqual(s.sent.slice(-2).map(x => x.type), ['social_kudos', 'social_comment']);
  const detail = await s.svc.activityDetail('ben', mine.id);
  assert.equal(detail.item.kudos, 1);
  assert.equal(detail.comments[0].canDelete, true, 'the activity owner can remove comments');
  assert.equal((await s.svc.deleteComment('cy', c.id)).status, 404);
  assert.deepEqual(await s.svc.deleteComment('ben', c.id), { deleted: true });
  assert.equal((await s.svc.listComments('ana', mine.id)).comments.length, 0);

  // Changing who can see it applies at once.
  await s.svc.setActivitySharing('ben', mine.id, { shareWith: null });
  assert.equal((await s.svc.feed('ana')).items.length, 0);
  assert.equal((await s.svc.setActivitySharing('ana', mine.id, { shareWith: null })).status, 404, 'only the owner');
});

test('finding people: shared groups or company by name, anyone by invite code', async () => {
  const s = setup();
  assert.deepEqual((await s.svc.findPeople('ana', { q: 'ben' })).people, [], 'no open search');
  const code = (await s.svc.settings('ben')).inviteCode;
  assert.equal((await s.svc.findPeople('ana', { code })).people[0].id, 'ben');
  assert.deepEqual((await s.svc.findPeople('dee', { q: 'el' })).people.map(p => p.id), ['eli'], 'colleague by name');
  assert.deepEqual((await s.svc.findPeople('dee', { q: 'hr' })).people, [], 'HR isn\'t a member');
});

test('default audience applies to new activities', async () => {
  const s = setup();
  const { group } = await s.svc.createGroup({ ownerType: 'member', ownerId: 'ana', createdBy: 'ana' }, { name: 'Club' });
  await s.svc.updateSettings('ana', { defaultShare: { followers: true, groups: [group.id] } });
  assert.deepEqual((await s.log('ana')).shareWith, { friends: true, followers: false, public: false, groups: [group.id], company: false });
  assert.equal((await s.log('ana', null)).shareWith, null, 'choosing private while saving wins');
  assert.equal((await s.svc.updateSettings('ana', { defaultShare: { groups: ['grp_nope'] } })).error, 'not_in_group');
});

test('reports: moderators remove what was reported, with an audit trail', async () => {
  const s = setup();
  await s.svc.follow('ana', 'ben'); await s.svc.follow('ben', 'ana');
  const a = await s.log('ben', { followers: true });
  const c = (await s.svc.addComment('ana', a.id, { text: 'rude words' })).comment;
  const r = (await s.svc.report('ben', { targetType: 'comment', targetId: c.id, reason: 'abuse' })).report;
  assert.equal((await s.svc.report('ben', { targetType: 'nope', targetId: 'x' })).error, 'invalid_report');
  const list = await s.svc.listReports();
  assert.equal(list.reports[0].target.text, 'rude words');
  await s.svc.resolveReport('adm', r.id, { action: 'remove' });
  assert.equal((await s.svc.listComments('ben', a.id)).comments.length, 0);
  assert.equal((await s.svc.listReports()).reports.length, 0);
  assert.equal(s.auditLog.rows[0].action, 'social_report.remove');
});
