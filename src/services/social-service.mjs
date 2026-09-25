// Sharing activities between members.
//
// Who can see an activity someone shares (and nobody else):
//   followers — people they follow AND who follow them back (mutual)
//   groups    — members of those groups who are members themselves
//   company   — colleagues at the same company (members, never HR)
// Everything is private until the member shares it. A block hides both
// people from each other entirely. Owners of trainer, gym or company groups
// manage the group; they don't see anyone's activity through it.
//
// Never shared: the route, calories, notes about health — a shared activity
// shows its type, date, duration, distance, pace, splits and climb.
import { randomUUID } from 'node:crypto';

export const GROUP_OWNER_TYPES = ['member', 'trainer', 'gym', 'corporate'];
const JOIN_POLICIES = ['open', 'approval'];
const MAX_GROUP_MEMBERS = 5000;
const MAX_COMMENT = 500;
const FEED_DAYS = 30;
const FEED_PAGE = 20;
const REPORT_TARGETS = ['user', 'activity', 'comment', 'group'];
const DAY_MS = 86_400_000;

const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const id = prefix => `${prefix}_${randomUUID().slice(0, 12)}`;
const code = () => randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();

/** What a viewer may see of someone else's activity. */
export function publicActivity(a) {
  return {
    id: a.id,
    userId: a.userId,
    type: a.type,
    startedAt: a.startedAt,
    durationMinutes: a.durationMinutes ?? null,
    activeMinutes: a.activeMinutes ?? null,
    distanceKm: a.distanceKm ?? null,
    steps: a.steps ?? null,
    movingSeconds: a.movingSeconds ?? null,
    elevationGainM: a.elevationGainM ?? null,
    splits: a.splits ?? [],
    // The name the member gave it (e.g. "Morning run").
    title: a.source === 'manual' || a.source === 'fitflex' ? a.notes ?? null : null,
  };
}

export function createSocialService({
  users, activities, follows, blocks, profiles, groups, groupMembers, kudos, comments, reports,
  notify = async () => {}, auditLog = null, now = () => new Date(),
}) {
  // ── Relationships ──────────────────────────────────────────────────────

  async function isBlocked(a, b) {
    const mine = await blocks.filterByColumnAsync('blockerId', a);
    if (mine.some(x => x.blockedId === b)) return true;
    const theirs = await blocks.filterByColumnAsync('blockerId', b);
    return theirs.some(x => x.blockedId === a);
  }

  async function following(userId) {
    return new Set((await follows.filterByColumnAsync('followerId', userId)).map(f => f.followeeId));
  }

  async function followers(userId) {
    return new Set((await follows.filterByColumnAsync('followeeId', userId)).map(f => f.followerId));
  }

  async function friends(userId) {
    const [out, inc] = await Promise.all([following(userId), followers(userId)]);
    return new Set([...out].filter(x => inc.has(x)));
  }

  /** Groups the user is an active member of. */
  async function activeGroupIds(userId) {
    return new Set((await groupMembers.filterByColumnAsync('userId', userId))
      .filter(m => m.status === 'active').map(m => m.groupId));
  }

  async function companyOf(userId) {
    const u = await users.findByIdAsync(userId);
    return u?.userType === 'member' ? u.corporateId ?? null : null;
  }

  /** Can [viewerId] see [activity]? The one check every read goes through. */
  async function canView(viewerId, activity) {
    if (!activity) return false;
    if (activity.userId === viewerId) return true;
    const share = activity.shareWith;
    if (!share) return false;
    if (await isBlocked(viewerId, activity.userId)) return false;
    if (share.followers && (await friends(viewerId)).has(activity.userId)) return true;
    if (Array.isArray(share.groups) && share.groups.length) {
      const [mine, theirs] = await Promise.all([activeGroupIds(viewerId), activeGroupIds(activity.userId)]);
      if (share.groups.some(g => mine.has(g) && theirs.has(g))) return true;
    }
    if (share.company) {
      const [a, b] = await Promise.all([companyOf(viewerId), companyOf(activity.userId)]);
      if (a && a === b) return true;
    }
    return false;
  }

  async function nameOf(userId) {
    const u = await users.findByIdAsync(userId);
    return u?.displayName ?? null;
  }

  async function person(viewerId, userId, ctx = {}) {
    ctx.following ??= await following(viewerId);
    ctx.followers ??= await followers(viewerId);
    const f = ctx.following.has(userId), b = ctx.followers.has(userId);
    return {
      id: userId,
      displayName: await nameOf(userId),
      relationship: f && b ? 'friends' : f ? 'following' : b ? 'follows_you' : 'none',
    };
  }

  // ── Profile & settings ────────────────────────────────────────────────

  async function profile(userId) {
    const existing = await profiles.findByIdAsync(userId);
    if (existing) return existing;
    const stamp = now().toISOString();
    const row = { id: userId, defaultShare: null, inviteCode: code(), createdAt: stamp, updatedAt: stamp };
    try {
      await profiles.insertAsync(row);
    } catch (err) {
      if (!/unique|duplicate/i.test(err.message ?? '')) throw err;
      return (await profiles.findByIdAsync(userId)) ?? row;
    }
    return row;
  }

  /**
   * Checks a share setting against what this member can actually use.
   * Returns null for private, or { followers, groups, company }.
   */
  async function normalizeShare(userId, raw) {
    if (raw == null || raw === false) return { share: null };
    if (typeof raw !== 'object') return { error: 'invalid_share', status: 400 };
    const followersOn = raw.followers === true;
    const wanted = Array.isArray(raw.groups) ? [...new Set(raw.groups.filter(g => typeof g === 'string'))] : [];
    const mine = await activeGroupIds(userId);
    if (wanted.some(g => !mine.has(g))) return { error: 'not_in_group', status: 400 };
    const company = raw.company === true;
    if (company && !(await companyOf(userId))) return { error: 'no_company', status: 400 };
    if (!followersOn && !wanted.length && !company) return { share: null };
    return { share: { followers: followersOn, groups: wanted, company } };
  }

  async function settings(userId) {
    const p = await profile(userId);
    return {
      defaultShare: p.defaultShare ?? null,
      inviteCode: p.inviteCode,
      hasCompany: !!(await companyOf(userId)),
      blocked: await Promise.all((await blocks.filterByColumnAsync('blockerId', userId))
        .map(async b => ({ id: b.blockedId, displayName: await nameOf(b.blockedId) }))),
    };
  }

  async function updateSettings(userId, body = {}) {
    const p = await profile(userId);
    const n = await normalizeShare(userId, body.defaultShare);
    if (n.error) return n;
    await profiles.updateByIdAsync(p.id, { defaultShare: n.share, updatedAt: now().toISOString() });
    return { settings: await settings(userId) };
  }

  /** The member's default for a new activity (used when one is created). */
  async function defaultShareFor(userId) {
    const p = await profiles.findByIdAsync(userId);
    if (!p?.defaultShare) return null;
    // Groups they've since left drop out; a company they've left does too.
    const mine = await activeGroupIds(userId);
    const n = await normalizeShare(userId, {
      followers: p.defaultShare.followers === true,
      groups: (p.defaultShare.groups ?? []).filter(g => mine.has(g)),
      company: p.defaultShare.company === true && !!(await companyOf(userId)),
    });
    return n.error ? null : n.share;
  }

  /**
   * Who a new activity is shared with: [raw] when the member chose while
   * saving, otherwise their default. Returns { share } or an error.
   */
  async function resolveShare(userId, raw) {
    if (raw === undefined) return { share: await defaultShareFor(userId) };
    return normalizeShare(userId, raw);
  }

  // ── Following & blocking ─────────────────────────────────────────────

  async function isMember(userId) {
    const u = await users.findByIdAsync(userId);
    return u?.userType === 'member' && u.accountStatus !== 'suspended' ? u : null;
  }

  async function follow(userId, targetId) {
    if (!targetId || targetId === userId) return { error: 'invalid_user', status: 400 };
    if (!(await isMember(targetId))) return { error: 'not_found', status: 404 };
    if (await isBlocked(userId, targetId)) return { error: 'not_found', status: 404 };
    const mine = await following(userId);
    if (!mine.has(targetId)) {
      try {
        await follows.insertAsync({ id: id('flw'), followerId: userId, followeeId: targetId, createdAt: now().toISOString() });
      } catch (err) {
        if (!/unique|duplicate/i.test(err.message ?? '')) throw err;
      }
      const back = (await following(targetId)).has(userId);
      const name = (await nameOf(userId)) ?? 'Someone';
      await notify(targetId, back
        ? { type: 'social_friends', title: 'You\'re connected', body: `${name} followed you back. You can now see what you share with each other.`, data: { userId } }
        : { type: 'social_follow', title: 'New follower', body: `${name} followed you. Follow back to see what you share with each other.`, data: { userId } });
    }
    return { person: await person(userId, targetId) };
  }

  async function unfollow(userId, targetId) {
    for (const f of await follows.filterByColumnAsync('followerId', userId)) {
      if (f.followeeId === targetId) await follows.removeByIdAsync(f.id);
    }
    return { person: await person(userId, targetId) };
  }

  /** Remove someone who follows you (they stop being a friend). */
  async function removeFollower(userId, followerId) {
    for (const f of await follows.filterByColumnAsync('followerId', followerId)) {
      if (f.followeeId === userId) await follows.removeByIdAsync(f.id);
    }
    return { person: await person(userId, followerId) };
  }

  async function block(userId, targetId) {
    if (!targetId || targetId === userId) return { error: 'invalid_user', status: 400 };
    const existing = (await blocks.filterByColumnAsync('blockerId', userId)).some(b => b.blockedId === targetId);
    if (!existing) await blocks.insertAsync({ id: id('blk'), blockerId: userId, blockedId: targetId, createdAt: now().toISOString() });
    await unfollow(userId, targetId);
    await removeFollower(userId, targetId);
    return { blocked: true };
  }

  async function unblock(userId, targetId) {
    for (const b of await blocks.filterByColumnAsync('blockerId', userId)) {
      if (b.blockedId === targetId) await blocks.removeByIdAsync(b.id);
    }
    return { blocked: false };
  }

  async function connections(userId) {
    const [out, inc] = await Promise.all([following(userId), followers(userId)]);
    const ctx = { following: out, followers: inc };
    const all = [...new Set([...out, ...inc])];
    const people = await Promise.all(all.map(u => person(userId, u, ctx)));
    const by = r => people.filter(p => p.relationship === r).sort((a, b) => (a.displayName ?? '').localeCompare(b.displayName ?? ''));
    return { friends: by('friends'), following: by('following'), followers: by('follows_you') };
  }

  /**
   * People the member can find: those sharing a group or company with them
   * (by name), or anyone by their invite code. No open search of everyone.
   */
  async function findPeople(userId, { q = '', code: invite = '' } = {}) {
    const out = new Map();
    const ctx = {};
    if (invite) {
      const p = (await profiles.allAsync()).find(x => x.inviteCode === String(invite).trim().toUpperCase());
      if (p && p.id !== userId && (await isMember(p.id)) && !(await isBlocked(userId, p.id))) {
        out.set(p.id, await person(userId, p.id, ctx));
      }
      return { people: [...out.values()] };
    }
    const query = String(q).trim().toLowerCase();
    if (query.length < 2) return { people: [] };
    const pool = new Set();
    for (const g of await activeGroupIds(userId)) {
      for (const m of await groupMembers.filterByColumnAsync('groupId', g)) if (m.status === 'active') pool.add(m.userId);
    }
    const corp = await companyOf(userId);
    if (corp) for (const u of await users.filterByColumnAsync('corporateId', corp)) if (u.userType === 'member') pool.add(u.id);
    pool.delete(userId);
    for (const uid of pool) {
      if (out.size >= 30) break;
      const u = await users.findByIdAsync(uid);
      if (!u || u.userType !== 'member' || !(u.displayName ?? '').toLowerCase().includes(query)) continue;
      if (await isBlocked(userId, uid)) continue;
      out.set(uid, await person(userId, uid, ctx));
    }
    return { people: [...out.values()] };
  }

  // ── Sharing an activity ──────────────────────────────────────────────

  async function setActivitySharing(userId, activityId, body = {}) {
    const a = await activities.findByIdAsync(activityId);
    if (!a || a.userId !== userId) return { error: 'not_found', status: 404 };
    const n = await normalizeShare(userId, body.shareWith ?? body);
    if (n.error) return n;
    await activities.updateByIdAsync(activityId, { shareWith: n.share });
    return { activityId, shareWith: n.share };
  }

  // ── Feed, kudos & comments ───────────────────────────────────────────

  async function socialCounts(viewerId, activityId) {
    const k = await kudos.filterByColumnAsync('activityId', activityId);
    const c = (await comments.filterByColumnAsync('activityId', activityId)).filter(x => !x.deletedAt);
    return { kudos: k.length, youKudoed: k.some(x => x.userId === viewerId), comments: c.length };
  }

  async function feedItem(viewerId, a, ctx) {
    return {
      activity: publicActivity(a),
      owner: a.userId === viewerId ? { id: viewerId, displayName: await nameOf(viewerId), relationship: 'you' } : await person(viewerId, a.userId, ctx),
      sharedWith: a.userId === viewerId ? a.shareWith ?? null : undefined,
      ...(await socialCounts(viewerId, a.id)),
    };
  }

  /**
   * What the member's friends, group-mates and colleagues shared (and the
   * member's own shared activities), newest first, the last 30 days.
   */
  async function feed(viewerId, { before = null } = {}) {
    const circle = new Set(await friends(viewerId));
    for (const g of await activeGroupIds(viewerId)) {
      for (const m of await groupMembers.filterByColumnAsync('groupId', g)) if (m.status === 'active') circle.add(m.userId);
    }
    const corp = await companyOf(viewerId);
    if (corp) for (const u of await users.filterByColumnAsync('corporateId', corp)) if (u.userType === 'member') circle.add(u.id);
    circle.add(viewerId);

    const since = +now() - FEED_DAYS * DAY_MS;
    const cutoff = before ? Date.parse(before) : Infinity;
    const candidates = [];
    for (const uid of circle) {
      for (const a of await activities.filterByColumnAsync('userId', uid)) {
        const t = +new Date(a.startedAt);
        if (!a.shareWith || t < since || !(t < cutoff)) continue;
        candidates.push(a);
      }
    }
    candidates.sort((x, y) => +new Date(y.startedAt) - +new Date(x.startedAt));
    const items = [];
    const ctx = {};
    for (const a of candidates) {
      if (items.length >= FEED_PAGE) break;
      if (await canView(viewerId, a)) items.push(await feedItem(viewerId, a, ctx));
    }
    const last = items[items.length - 1];
    return { items, next: items.length === FEED_PAGE ? new Date(last.activity.startedAt).toISOString() : null };
  }

  async function visible(viewerId, activityId) {
    const a = await activities.findByIdAsync(activityId);
    return (await canView(viewerId, a)) ? a : null;
  }

  async function activityDetail(viewerId, activityId) {
    const a = await visible(viewerId, activityId);
    if (!a) return { error: 'not_found', status: 404 };
    return { item: await feedItem(viewerId, a, {}), comments: (await listComments(viewerId, activityId)).comments };
  }

  async function toggleKudos(viewerId, activityId, on) {
    const a = await visible(viewerId, activityId);
    if (!a) return { error: 'not_found', status: 404 };
    const mine = (await kudos.filterByColumnAsync('activityId', activityId)).filter(k => k.userId === viewerId);
    if (on && !mine.length) {
      try {
        await kudos.insertAsync({ id: id('kud'), activityId, userId: viewerId, createdAt: now().toISOString() });
      } catch (err) {
        if (!/unique|duplicate/i.test(err.message ?? '')) throw err;
      }
      if (a.userId !== viewerId) {
        await notify(a.userId, { type: 'social_kudos', title: 'Kudos', body: `${(await nameOf(viewerId)) ?? 'Someone'} gave you kudos.`, data: { activityId } });
      }
    }
    if (!on) for (const k of mine) await kudos.removeByIdAsync(k.id);
    return socialCounts(viewerId, activityId);
  }

  async function listComments(viewerId, activityId) {
    const a = await visible(viewerId, activityId);
    if (!a) return { error: 'not_found', status: 404 };
    const rows = (await comments.filterByColumnAsync('activityId', activityId))
      .filter(c => !c.deletedAt)
      .sort((x, y) => +new Date(x.createdAt) - +new Date(y.createdAt));
    const out = [];
    for (const c of rows) {
      // Someone who blocked (or was blocked by) the viewer isn't shown.
      if (c.userId !== viewerId && (await isBlocked(viewerId, c.userId))) continue;
      out.push({
        id: c.id, text: c.text, createdAt: c.createdAt,
        author: { id: c.userId, displayName: await nameOf(c.userId) },
        canDelete: c.userId === viewerId || a.userId === viewerId,
      });
    }
    return { comments: out };
  }

  async function addComment(viewerId, activityId, body = {}) {
    const a = await visible(viewerId, activityId);
    if (!a) return { error: 'not_found', status: 404 };
    const t = text(body.text, MAX_COMMENT);
    if (!t) return { error: 'empty_comment', status: 400 };
    const row = { id: id('cmt'), activityId, userId: viewerId, text: t, createdAt: now().toISOString(), deletedAt: null };
    await comments.insertAsync(row);
    if (a.userId !== viewerId) {
      await notify(a.userId, { type: 'social_comment', title: 'New comment', body: `${(await nameOf(viewerId)) ?? 'Someone'}: ${t.slice(0, 80)}`, data: { activityId } });
    }
    return { comment: { id: row.id, text: t, createdAt: row.createdAt, author: { id: viewerId, displayName: await nameOf(viewerId) }, canDelete: true } };
  }

  async function deleteComment(viewerId, commentId) {
    const c = await comments.findByIdAsync(commentId);
    if (!c || c.deletedAt) return { error: 'not_found', status: 404 };
    const a = await activities.findByIdAsync(c.activityId);
    if (c.userId !== viewerId && a?.userId !== viewerId) return { error: 'not_found', status: 404 };
    await comments.updateByIdAsync(commentId, { deletedAt: now().toISOString() });
    return { deleted: true };
  }

  // ── Groups ───────────────────────────────────────────────────────────

  function groupView(g, membership, count) {
    return {
      id: g.id, name: g.name, description: g.description ?? null,
      ownerType: g.ownerType, joinPolicy: g.joinPolicy, discoverable: g.discoverable === true,
      memberCount: count,
      you: membership ? { role: membership.role, status: membership.status } : null,
    };
  }

  async function memberCount(groupId) {
    return (await groupMembers.filterByColumnAsync('groupId', groupId)).filter(m => m.status === 'active').length;
  }

  function validateGroup(body, existing = null) {
    const name = text(body.name ?? existing?.name, 60);
    if (!name) return { error: 'invalid_name', status: 400 };
    const joinPolicy = body.joinPolicy ?? existing?.joinPolicy ?? 'approval';
    if (!JOIN_POLICIES.includes(joinPolicy)) return { error: 'invalid_join_policy', status: 400 };
    return {
      fields: {
        name,
        description: body.description !== undefined ? text(body.description, 300) : existing?.description ?? null,
        joinPolicy,
        discoverable: body.discoverable !== undefined ? body.discoverable === true : existing?.discoverable ?? false,
      },
    };
  }

  /**
   * Create a group. [owner] is { ownerType, ownerId, createdBy, corporateId? }
   * resolved by the route. A member who creates one is its first admin.
   */
  async function createGroup(owner, body = {}) {
    if (!GROUP_OWNER_TYPES.includes(owner.ownerType)) return { error: 'invalid_owner', status: 400 };
    const v = validateGroup(body);
    if (v.error) return v;
    const stamp = now().toISOString();
    const g = {
      id: id('grp'), ...v.fields,
      ownerType: owner.ownerType, ownerId: owner.ownerId,
      corporateId: owner.ownerType === 'corporate' ? owner.ownerId : null,
      inviteCode: code(), status: 'active', createdBy: owner.createdBy ?? null, createdAt: stamp, updatedAt: stamp,
    };
    await groups.insertAsync(g);
    if (owner.ownerType === 'member') {
      await groupMembers.insertAsync({ id: id('gmb'), groupId: g.id, userId: owner.ownerId, role: 'admin', status: 'active', createdAt: stamp, updatedAt: stamp });
    }
    return { group: { ...groupView(g, owner.ownerType === 'member' ? { role: 'admin', status: 'active' } : null, owner.ownerType === 'member' ? 1 : 0), inviteCode: g.inviteCode } };
  }

  /** Is [actor] allowed to manage [g]? Member admins, or the owning trainer/gym/company. */
  async function canManage(actor, g) {
    if (!g || g.status !== 'active') return false;
    if (actor.ownerType && actor.ownerType !== 'member') return g.ownerType === actor.ownerType && g.ownerId === actor.ownerId;
    const m = (await groupMembers.filterByColumnAsync('groupId', g.id)).find(x => x.userId === actor.userId);
    return m?.role === 'admin' && m.status === 'active';
  }

  async function updateGroup(actor, groupId, body = {}) {
    const g = await groups.findByIdAsync(groupId);
    if (!(await canManage(actor, g))) return { error: 'not_found', status: 404 };
    const v = validateGroup(body, g);
    if (v.error) return v;
    await groups.updateByIdAsync(groupId, { ...v.fields, updatedAt: now().toISOString() });
    return groupDetail(actor, groupId);
  }

  async function archiveGroup(actor, groupId) {
    const g = await groups.findByIdAsync(groupId);
    if (!(await canManage(actor, g))) return { error: 'not_found', status: 404 };
    await groups.updateByIdAsync(groupId, { status: 'archived', updatedAt: now().toISOString() });
    // Shares with the group simply stop matching (no active group).
    for (const m of await groupMembers.filterByColumnAsync('groupId', groupId)) await groupMembers.removeByIdAsync(m.id);
    return { archived: true };
  }

  /** Groups a member belongs to (or asked to join). */
  async function myGroups(userId) {
    const out = [];
    for (const m of await groupMembers.filterByColumnAsync('userId', userId)) {
      const g = await groups.findByIdAsync(m.groupId);
      if (!g || g.status !== 'active') continue;
      out.push({ ...groupView(g, m, await memberCount(g.id)), ...(m.role === 'admin' && { inviteCode: g.inviteCode }) });
    }
    return { groups: out.sort((a, b) => a.name.localeCompare(b.name)) };
  }

  /** Groups a trainer, gym or company owns. */
  async function ownedGroups(owner) {
    const out = [];
    for (const g of await groups.filterByColumnAsync('ownerId', owner.ownerId)) {
      if (g.ownerType !== owner.ownerType || g.status !== 'active') continue;
      const all = await groupMembers.filterByColumnAsync('groupId', g.id);
      out.push({ ...groupView(g, null, all.filter(m => m.status === 'active').length), inviteCode: g.inviteCode, pending: all.filter(m => m.status === 'pending').length });
    }
    return { groups: out.sort((a, b) => a.name.localeCompare(b.name)) };
  }

  /** Discoverable groups a member could join (company groups: their company only). */
  async function discoverGroups(userId, { q = '' } = {}) {
    const query = String(q).trim().toLowerCase();
    const corp = await companyOf(userId);
    const mine = new Set((await groupMembers.filterByColumnAsync('userId', userId)).map(m => m.groupId));
    const out = [];
    for (const g of await groups.allAsync()) {
      if (g.status !== 'active' || !g.discoverable || mine.has(g.id)) continue;
      if (g.corporateId && g.corporateId !== corp) continue;
      if (query && !g.name.toLowerCase().includes(query)) continue;
      out.push(groupView(g, null, await memberCount(g.id)));
      if (out.length >= 30) break;
    }
    return { groups: out };
  }

  async function joinGroup(userId, { groupId = null, inviteCode = null } = {}) {
    if (!(await isMember(userId))) return { error: 'members_only', status: 403 };
    const all = await groups.allAsync();
    const g = inviteCode
      ? all.find(x => x.inviteCode === String(inviteCode).trim().toUpperCase())
      : all.find(x => x.id === groupId);
    if (!g || g.status !== 'active') return { error: 'not_found', status: 404 };
    // Without the code, only discoverable groups can be joined.
    if (!inviteCode && !g.discoverable) return { error: 'not_found', status: 404 };
    if (g.corporateId && g.corporateId !== (await companyOf(userId))) return { error: 'company_only', status: 403 };
    const members = await groupMembers.filterByColumnAsync('groupId', g.id);
    const existing = members.find(m => m.userId === userId);
    if (existing) return { group: groupView(g, existing, members.filter(m => m.status === 'active').length) };
    if (members.length >= MAX_GROUP_MEMBERS) return { error: 'group_full', status: 409 };
    // An invite code lets you straight in; otherwise the group's policy decides.
    const status = inviteCode || g.joinPolicy === 'open' ? 'active' : 'pending';
    const stamp = now().toISOString();
    const row = { id: id('gmb'), groupId: g.id, userId, role: 'member', status, createdAt: stamp, updatedAt: stamp };
    await groupMembers.insertAsync(row);
    return { group: groupView(g, row, await memberCount(g.id)) };
  }

  async function leaveGroup(userId, groupId) {
    const members = await groupMembers.filterByColumnAsync('groupId', groupId);
    const m = members.find(x => x.userId === userId);
    if (!m) return { error: 'not_found', status: 404 };
    const g = await groups.findByIdAsync(groupId);
    // The last admin of a member-run group hands over first (or archives it).
    if (g?.ownerType === 'member' && m.role === 'admin' && !members.some(x => x.id !== m.id && x.role === 'admin' && x.status === 'active')) {
      if (members.some(x => x.id !== m.id && x.status === 'active')) return { error: 'last_admin', status: 409 };
      return archiveGroup({ userId }, groupId);
    }
    await groupMembers.removeByIdAsync(m.id);
    return { left: true };
  }

  async function groupDetail(actor, groupId) {
    const g = await groups.findByIdAsync(groupId);
    if (!g || g.status !== 'active') return { error: 'not_found', status: 404 };
    const members = await groupMembers.filterByColumnAsync('groupId', groupId);
    const mine = actor.userId ? members.find(m => m.userId === actor.userId) : null;
    const manager = await canManage(actor, g);
    // Members see the member list; managers also see who's waiting.
    if (!manager && mine?.status !== 'active') {
      return g.discoverable ? { group: groupView(g, mine, members.filter(m => m.status === 'active').length) } : { error: 'not_found', status: 404 };
    }
    const list = [];
    for (const m of members) {
      if (m.status !== 'active' && !manager) continue;
      list.push({ id: m.userId, displayName: await nameOf(m.userId), role: m.role, status: m.status });
    }
    return {
      group: { ...groupView(g, mine, members.filter(m => m.status === 'active').length), ...(manager && { inviteCode: g.inviteCode }), canManage: manager },
      members: list.sort((a, b) => (a.status === b.status ? (a.displayName ?? '').localeCompare(b.displayName ?? '') : a.status === 'pending' ? -1 : 1)),
    };
  }

  async function setMember(actor, groupId, userId, action) {
    const g = await groups.findByIdAsync(groupId);
    if (!(await canManage(actor, g))) return { error: 'not_found', status: 404 };
    const m = (await groupMembers.filterByColumnAsync('groupId', groupId)).find(x => x.userId === userId);
    if (!m) return { error: 'not_found', status: 404 };
    const stamp = now().toISOString();
    if (action === 'approve') await groupMembers.updateByIdAsync(m.id, { status: 'active', updatedAt: stamp });
    else if (action === 'remove') {
      if (m.userId === actor.userId) return { error: 'use_leave', status: 400 };
      await groupMembers.removeByIdAsync(m.id);
    } else if (action === 'make_admin') await groupMembers.updateByIdAsync(m.id, { role: 'admin', status: 'active', updatedAt: stamp });
    else if (action === 'make_member') await groupMembers.updateByIdAsync(m.id, { role: 'member', updatedAt: stamp });
    else return { error: 'invalid_action', status: 400 };
    return groupDetail(actor, groupId);
  }

  // ── Reports ──────────────────────────────────────────────────────────

  async function report(reporterId, body = {}) {
    if (!REPORT_TARGETS.includes(body.targetType) || typeof body.targetId !== 'string' || !body.targetId) {
      return { error: 'invalid_report', status: 400 };
    }
    const row = { id: id('rpt'), reporterId, targetType: body.targetType, targetId: body.targetId, reason: text(body.reason, 500), status: 'open', resolvedBy: null, resolvedAt: null, createdAt: now().toISOString() };
    await reports.insertAsync(row);
    return { report: { id: row.id, status: row.status } };
  }

  /** Admin: open reports with what was reported. */
  async function listReports({ status = 'open' } = {}) {
    const rows = (await reports.allAsync()).filter(r => !status || r.status === status)
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    const out = [];
    for (const r of rows.slice(0, 200)) {
      let target = null;
      if (r.targetType === 'comment') {
        const c = await comments.findByIdAsync(r.targetId);
        target = c ? { text: c.text, author: await nameOf(c.userId), removed: !!c.deletedAt } : null;
      } else if (r.targetType === 'user') {
        target = { displayName: await nameOf(r.targetId) };
      } else if (r.targetType === 'group') {
        const g = await groups.findByIdAsync(r.targetId);
        target = g ? { name: g.name, archived: g.status !== 'active' } : null;
      } else if (r.targetType === 'activity') {
        const a = await activities.findByIdAsync(r.targetId);
        target = a ? { owner: await nameOf(a.userId), type: a.type, title: a.notes ?? null } : null;
      }
      out.push({ ...r, reporter: await nameOf(r.reporterId), target });
    }
    return { reports: out };
  }

  /** Admin: remove what was reported (hide the comment, archive the group, make the activity private) or dismiss. */
  async function resolveReport(adminId, reportId, { action } = {}) {
    const r = await reports.findByIdAsync(reportId);
    if (!r || r.status !== 'open') return { error: 'not_found', status: 404 };
    if (!['remove', 'dismiss'].includes(action)) return { error: 'invalid_action', status: 400 };
    const stamp = now().toISOString();
    if (action === 'remove') {
      if (r.targetType === 'comment') await comments.updateByIdAsync(r.targetId, { deletedAt: stamp });
      if (r.targetType === 'group') await groups.updateByIdAsync(r.targetId, { status: 'archived', updatedAt: stamp });
      if (r.targetType === 'activity') await activities.updateByIdAsync(r.targetId, { shareWith: null });
    }
    await reports.updateByIdAsync(reportId, { status: action === 'remove' ? 'actioned' : 'dismissed', resolvedBy: adminId, resolvedAt: stamp });
    await auditLog?.insertAsync({ id: id('aud'), at: stamp, actor: adminId, action: `social_report.${action}`, target: reportId, before: { status: 'open' }, after: { targetType: r.targetType, targetId: r.targetId } });
    return { resolved: true };
  }

  return {
    canView, defaultShareFor, resolveShare, settings, updateSettings,
    follow, unfollow, removeFollower, block, unblock, connections, findPeople,
    setActivitySharing, feed, activityDetail, toggleKudos, listComments, addComment, deleteComment,
    createGroup, updateGroup, archiveGroup, myGroups, ownedGroups, discoverGroups, joinGroup, leaveGroup,
    groupDetail, setMember,
    report, listReports, resolveReport,
  };
}
