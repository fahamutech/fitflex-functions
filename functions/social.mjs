// Sharing activities between members: mutual follows, groups, the company
// audience, kudos, comments, blocking and reports. Everything a member
// shares is checked by socialService.canView on every read.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl, requireGymAcl } from '../src/auth/jwt.mjs';
import { socialService as svc, corporateService, resolveRequestUser, trainers } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();
const member = requireAuth('member');

function send(res, result, ok = 200) {
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.status(ok).json(result);
}
const route = (method, path, description, handler, guard = member, extra = {}) => ({
  created, method, path, description, onGuard: guard, ...extra,
  onRequest: async (req, res) => send(res, await handler(req), method === 'post' && extra.createdStatus ? 201 : 200),
});
const me = req => req.user.sub;

// ── Settings, people, follows, blocks ───────────────────────────────────
export const socialSettings = route('get', '/me/social/settings', 'Member: default audience for new activities, invite code, blocked people.', req => svc.settings(me(req)));
export const updateSocialSettings = route('put', '/me/social/settings', 'Member: public profile on/off, and the default audience. { publicProfile?, defaultShare?: null | { v: 2, friends, followers, public, groups: [id], company } }', req => svc.updateSettings(me(req), req.body || {}));
export const myConnections = route('get', '/me/connections', 'Member: friends (mutual follows), people you follow, and people who follow you.', req => svc.connections(me(req)));
export const findPeople = route('get', '/social/people', 'Member: find people who share a group or company with you (?q=name), or anyone by invite code (?code=).', req => svc.findPeople(me(req), { q: req.query?.q, code: req.query?.code }));
export const followPerson = route('post', '/me/follows', 'Member: follow someone. { userId } — you see each other\'s shared activity once they follow back.', req => svc.follow(me(req), req.body?.userId));
export const unfollowPerson = route('delete', '/me/follows/:userId', 'Member: stop following someone.', req => svc.unfollow(me(req), req.params.userId));
export const removeMyFollower = route('delete', '/me/followers/:userId', 'Member: remove someone who follows you.', req => svc.removeFollower(me(req), req.params.userId));
export const blockPerson = route('post', '/me/blocks', 'Member: block someone (hides you from each other, ends follows). { userId }', req => svc.block(me(req), req.body?.userId));
export const unblockPerson = route('delete', '/me/blocks/:userId', 'Member: unblock someone.', req => svc.unblock(me(req), req.params.userId));

// ── Sharing, feed, kudos, comments, reports ─────────────────────────────
export const shareMyActivity = route('put', '/me/activities/:id/sharing', 'Member: who can see one of your activities. { shareWith: null | { followers, groups: [id], company } }', req => svc.setActivitySharing(me(req), req.params.id, req.body || {}));
export const myFeed = route('get', '/me/feed', 'Member: what friends, group-mates and colleagues shared, newest first (last 30 days). ?before=ISO for the next page.', req => svc.feed(me(req), { before: req.query?.before || null }));
export const sharedActivity = route('get', '/social/activities/:id', 'Member: one shared activity with kudos and comments (only if you can see it).', req => svc.activityDetail(me(req), req.params.id));
export const activityEngagement = route('get', '/social/activities/:id/engagement', 'Poster: views (count only), who gave kudos and who commented — to follow them back.', req => svc.engagement(me(req), req.params.id));
export const exploreFeed = route('get', '/social/explore', 'Member: recent public posts from public profiles (last 14 days). ?before=ISO for the next page.', req => svc.explore(me(req), { before: req.query?.before || null }));
export const personProfile = route('get', '/social/people/:id', 'Member: someone\'s profile — follower counts, how you\'re connected, and the posts you can see. Public profiles, or people you\'re connected to.', req => svc.profilePage(me(req), req.params.id, { before: req.query?.before || null }));
export const giveKudos = route('post', '/social/activities/:id/kudos', 'Member: give kudos.', req => svc.toggleKudos(me(req), req.params.id, true));
export const takeBackKudos = route('delete', '/social/activities/:id/kudos', 'Member: take kudos back.', req => svc.toggleKudos(me(req), req.params.id, false));
export const activityComments = route('get', '/social/activities/:id/comments', 'Member: comments on a shared activity.', req => svc.listComments(me(req), req.params.id));
export const addActivityComment = route('post', '/social/activities/:id/comments', 'Member: comment. { text }', req => svc.addComment(me(req), req.params.id, req.body || {}), member, { createdStatus: true });
export const deleteActivityComment = route('delete', '/social/comments/:id', 'Member: delete your comment, or one on your activity.', req => svc.deleteComment(me(req), req.params.id));
export const reportSocial = route('post', '/social/reports', 'Member: report a person, activity, comment or group. { targetType, targetId, reason? }', req => svc.report(me(req), req.body || {}), member, { createdStatus: true });

// ── Groups (members) ────────────────────────────────────────────────────
const asMember = req => ({ userId: me(req), ownerType: 'member' });
export const myGroups = route('get', '/me/groups', 'Member: groups you belong to or asked to join.', req => svc.myGroups(me(req)));
export const createMyGroup = route('post', '/me/groups', 'Member: create a group (you become its admin). { name, description?, joinPolicy: open|approval, discoverable? }', req => svc.createGroup({ ownerType: 'member', ownerId: me(req), createdBy: me(req) }, req.body || {}), member, { createdStatus: true });
export const discoverGroups = route('get', '/social/groups', 'Member: groups you can find and join (?q=). Company groups show only to that company\'s employees.', req => svc.discoverGroups(me(req), { q: req.query?.q }));
export const joinGroup = route('post', '/social/groups/join', 'Member: join by invite code, or a discoverable group by id. { inviteCode } | { groupId }', req => svc.joinGroup(me(req), req.body || {}));
export const groupDetail = route('get', '/social/groups/:id', 'Member: a group and (if you belong) its members.', req => svc.groupDetail(asMember(req), req.params.id));
export const updateGroup = route('patch', '/social/groups/:id', 'Group admin: edit a group.', req => svc.updateGroup(asMember(req), req.params.id, req.body || {}));
export const archiveGroup = route('post', '/social/groups/:id/archive', 'Group admin: close a group.', req => svc.archiveGroup(asMember(req), req.params.id));
export const leaveGroup = route('post', '/social/groups/:id/leave', 'Member: leave a group.', req => svc.leaveGroup(me(req), req.params.id));
export const manageGroupMember = route('post', '/social/groups/:id/members/:userId/:action', 'Group admin: approve | remove | make_admin | make_member.', req => svc.setMember(asMember(req), req.params.id, req.params.userId, req.params.action));

// ── Groups run by trainers, gyms and companies ──────────────────────────
async function trainerOwner(req) {
  const t = await trainers.findAsync(x => x.userId === req.user.sub);
  return t ? { ownerType: 'trainer', ownerId: t.id, createdBy: req.user.sub } : { error: 'trainer_profile_not_found', status: 404 };
}
async function gymOwner(req) {
  const owner = await resolveRequestUser(req);
  const mine = owner?.gymIds || (owner?.gymId ? [owner.gymId] : []);
  const gymId = req.query?.gymId || req.body?.gymId || (mine.length === 1 ? mine[0] : null);
  if (!gymId) return { error: 'gymId_required', status: 400 };
  if (!mine.includes(gymId)) return { error: 'not_your_gym', status: 403 };
  return { ownerType: 'gym', ownerId: gymId, createdBy: req.user.sub };
}
async function companyOwner(req) {
  const actor = await corporateService.resolveActorAccount({ userId: req.user.sub, userType: req.user.userType, corporateIdParam: req.query?.corporateId });
  return actor.error ? actor : { ownerType: 'corporate', ownerId: actor.corporateId, createdBy: req.user.sub };
}

function ownerRoutes(prefix, guard, resolve, label) {
  const withOwner = fn => async req => { const o = await resolve(req); return o.error ? o : fn(o, req); };
  return {
    list: route('get', `${prefix}/groups`, `${label}: groups you run.`, withOwner(o => svc.ownedGroups(o)), guard),
    create: route('post', `${prefix}/groups`, `${label}: create a group members join with its invite code. { name, description?, joinPolicy, discoverable? }`, withOwner((o, req) => svc.createGroup(o, req.body || {})), guard, { createdStatus: true }),
    detail: route('get', `${prefix}/groups/:id`, `${label}: a group you run, with its members and requests.`, withOwner((o, req) => svc.groupDetail(o, req.params.id)), guard),
    update: route('patch', `${prefix}/groups/:id`, `${label}: edit a group.`, withOwner((o, req) => svc.updateGroup(o, req.params.id, req.body || {})), guard),
    archive: route('post', `${prefix}/groups/:id/archive`, `${label}: close a group.`, withOwner((o, req) => svc.archiveGroup(o, req.params.id)), guard),
    member: route('post', `${prefix}/groups/:id/members/:userId/:action`, `${label}: approve | remove | make_admin | make_member.`, withOwner((o, req) => svc.setMember(o, req.params.id, req.params.userId, req.params.action)), guard),
  };
}
const tr = ownerRoutes('/trainer', requireAuth('trainer'), trainerOwner, 'Trainer');
export const trainerGroups = tr.list; export const trainerCreateGroup = tr.create; export const trainerGroupDetail = tr.detail;
export const trainerUpdateGroup = tr.update; export const trainerArchiveGroup = tr.archive; export const trainerGroupMember = tr.member;
const gy = ownerRoutes('/owner', [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('members')], gymOwner, 'Gym');
export const ownerGroups = gy.list; export const ownerCreateGroup = gy.create; export const ownerGroupDetail = gy.detail;
export const ownerUpdateGroup = gy.update; export const ownerArchiveGroup = gy.archive; export const ownerGroupMember = gy.member;
const co = ownerRoutes('/corporate', [requireAuth('corporate_hr', 'admin'), requireAcl('corporate')], companyOwner, 'Company HR');
export const corporateGroups = co.list; export const corporateCreateGroup = co.create; export const corporateGroupDetail = co.detail;
export const corporateUpdateGroup = co.update; export const corporateArchiveGroup = co.archive; export const corporateGroupMember = co.member;

// ── Moderation (admin) ──────────────────────────────────────────────────
const adminGuard = [requireAuth('admin'), requireAcl('social')];
export const adminSocialReports = route('get', '/admin/social/reports', 'Admin: reports (?status=open|actioned|dismissed).', req => svc.listReports({ status: req.query?.status ?? 'open' }), adminGuard);
export const adminResolveSocialReport = route('post', '/admin/social/reports/:id/resolve', 'Admin: remove what was reported (hide comment, close group, make activity private) or dismiss. { action: remove|dismiss }', req => svc.resolveReport(me(req), req.params.id, req.body || {}), adminGuard);
