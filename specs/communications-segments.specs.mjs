// Communications M2 — audiences against the CI database, through the real
// endpoints: a gym's audiences hold only its own direct members, match the
// owner's Members list, and never reach another gym's members or FitFlex
// pass holders who visit. FitFlex admins see every member, by area too.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { updateMemberProfile } from '../functions/subscriptions.mjs';
import { ownerCreateGym } from '../functions/owner-gyms.mjs';
import { ownerCreateMember, ownerListMembers } from '../functions/owner-members.mjs';
import {
  ownerCommunicationSegments, ownerAudiencePreview, adminCommunicationSegments, adminAudiencePreview,
} from '../functions/communications.mjs';
import { segmentService } from '../src/bootstrap/services.mjs';
import { sign } from '../src/auth/jwt.mjs';

function res() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}
const uniq = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const uniqPhone = () => `+2557${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const at = (n) => new Date(Date.now() + n * 86_400_000);

async function call(endpoint, user, body) {
  const out = res();
  await endpoint.onRequest({ user, body, query: {} }, out);
  return out;
}

function runGuard(guard, user) {
  let result = null;
  let nextCalled = false;
  guard({ user }, { status(code) { result = { code }; return this; }, json(body) { result = { ...result, body }; return this; } }, () => { nextCalled = true; });
  return { nextCalled, result };
}

// requireAuth checks a real signed token and the caller's role.
function runAuth(guard, claims) {
  let code = null;
  let nextCalled = false;
  const req = { headers: { authorization: `Bearer ${sign(claims)}` } };
  guard(req, { status(c) { code = c; return this; }, json() { return this; } }, () => { nextCalled = true; });
  return { nextCalled, code };
}

const made = { users: [], gyms: [] };
const w = {}; // the world the tests look at

async function ownerWithGym(location) {
  const ownerId = uniq('usr_owner_comms');
  const profile = res();
  await updateMemberProfile.onRequest({ user: { sub: ownerId, userType: 'gym_operator' }, body: { displayName: 'Comms Owner', phone: uniqPhone() } }, profile);
  assert.equal(profile.statusCode, 200);
  made.users.push(ownerId);
  const gym = await call(ownerCreateGym, { sub: ownerId, userType: 'gym_operator' }, { name: uniq('Comms Gym'), tier: 'standard', location, perVisitRate: 5000 });
  assert.equal(gym.statusCode, 201);
  made.gyms.push(gym.body.id);
  return { owner: { sub: ownerId, userType: 'gym_operator' }, gymId: gym.body.id };
}

async function directMember(o, name, { start, end }) {
  const out = await call(ownerCreateMember, o.owner, {
    displayName: name, phone: uniqPhone(), gymId: o.gymId, durationUnit: 'M', startDate: day(start), endDate: day(end), tier: 'basic',
  });
  assert.equal(out.statusCode, 201, JSON.stringify(out.body));
  made.users.push(out.body.member.id);
  return out.body.member.id;
}

async function visit(memberId, gymId, daysAgo, subscriptionType = 'direct_sub') {
  await db('Checkin').insert({
    id: uniq('ci'), memberId, gymId, timestamp: at(-daysAgo), method: 'qr',
    subscriptionType, gymTier: 'standard', visitConsumed: false,
  });
}

before(async () => {
  w.area = uniq('Mbeya');
  w.A = await ownerWithGym(`${w.area} Town`);
  w.B = await ownerWithGym(uniq('Tabora'));
  w.a = {
    active: await directMember(w.A, 'Amina Active', { start: -60, end: 40 }),
    expiring: await directMember(w.A, 'Baraka Expiring', { start: -40, end: 5 }),
    recentExpired: await directMember(w.A, 'Chausiku Lapsed', { start: -40, end: -10 }),
    oldExpired: await directMember(w.A, 'Daudi Gone', { start: -120, end: -60 }),
    inactive: await directMember(w.A, 'Eliya Quiet', { start: -60, end: 40 }),
    fresh: await directMember(w.A, 'Faraja New', { start: -5, end: 25 }),
  };
  await visit(w.a.active, w.A.gymId, 2);
  await visit(w.a.expiring, w.A.gymId, 3);
  await visit(w.a.inactive, w.A.gymId, 20);
  w.b1 = await directMember(w.B, 'Gift OtherGym', { start: -30, end: 30 });
  await visit(w.b1, w.B.gymId, 1);

  // A FitFlex pass holder who visits gym A: on A's Members list, never in A's audiences.
  w.roamer = uniq('usr_roamer');
  await db('User').insert({ id: w.roamer, userType: 'member', displayName: 'Hamisi Roamer', phone: uniqPhone(), updatedAt: new Date() });
  made.users.push(w.roamer);
  await db('Subscription').insert({
    id: uniq('sub'), memberId: w.roamer, type: 'platform_pass', tier: 'pro', status: 'active',
    startedAt: at(-10), cycleStartedAt: at(-10), renewsAt: at(20), expiresAt: at(20),
  });
  await visit(w.roamer, w.A.gymId, 1, 'platform_pass');

  // Gym A staff: one with the communications scope, one without.
  w.staff = uniq('usr_staff');
  await db('User').insert({ id: w.staff, userType: 'gym_staff', displayName: 'Front Desk', gymIds: [w.A.gymId], aclPermissions: ['communications'], updatedAt: new Date() });
  made.users.push(w.staff);

  // Amina switched off in-app offers.
  await db('CommunicationPreference').insert({ id: w.a.active, inAppMarketing: false });
});

after(async () => {
  if (made.gyms.length) await db('Gym').whereIn('id', made.gyms).del();
  if (made.users.length) await db('User').whereIn('id', made.users).del();
});

const preview = (user, body) => call(ownerAudiencePreview, user, body);
const ids = async (sender, audience) => {
  const r = await segmentService.resolveAudience({ sender, ...audience });
  assert.ok(!r.error, JSON.stringify(r));
  return new Set(r.members.map(m => m.memberId));
};

// ── gym audiences ──────────────────────────────────────────────────────────

test('each preset finds the right direct members', async () => {
  const count = async (preset) => {
    const out = await preview(w.A.owner, { preset });
    assert.equal(out.statusCode, 200, JSON.stringify(out.body));
    return out.body.count;
  };
  assert.equal(await count('all'), 6);
  assert.equal(await count('active'), 4);
  assert.equal(await count('expiring'), 1);
  assert.equal(await count('expired'), 2);
  assert.equal(await count('recently_expired'), 1);
  assert.equal(await count('new'), 1);
  assert.equal(await count('inactive'), 1);

  const sender = { senderType: 'gym', owner: { gymIds: [w.A.gymId] } };
  assert.deepEqual([...await ids(sender, { preset: 'inactive' })], [w.a.inactive]);
  assert.deepEqual([...await ids(sender, { preset: 'new' })], [w.a.fresh]);
  assert.deepEqual([...await ids(sender, { preset: 'recently_expired' })], [w.a.recentExpired]);
});

test('custom and compound audiences, and one that matches no one', async () => {
  const expiringSoon = await preview(w.A.owner, { filter: { all: [
    { field: 'status', op: 'in', value: ['active', 'expiring_soon'] },
    { field: 'daysUntilExpiry', op: 'lte', value: 7 },
  ] } });
  assert.equal(expiringSoon.body.count, 1);

  const visitedThisMonth = await preview(w.A.owner, { preset: 'active', filter: { all: [{ field: 'lastVisitDaysAgo', op: 'lte', value: 7 }] } });
  assert.equal(visitedThisMonth.body.count, 2);

  const none = await preview(w.A.owner, { filter: { all: [{ field: 'age', op: 'gte', value: 18 }] } });
  assert.equal(none.statusCode, 200);
  assert.equal(none.body.count, 0, 'no one entered a birth date, so no one matches an age filter');
  assert.deepEqual(none.body.sample, []);
});

test('audience counts agree with the owner Members list', async () => {
  const out = res();
  await ownerListMembers.onRequest({ user: w.A.owner, query: { gymId: w.A.gymId } }, out);
  assert.equal(out.statusCode, 200);
  const rows = out.body.members;
  const direct = rows.filter(r => r.memberType === 'direct');
  assert.equal(direct.length, 6);
  assert.ok(rows.some(r => r.id === w.roamer && r.memberType === 'fitflex'), 'owners still see FitFlex visitors, tagged');
  const expiring = await preview(w.A.owner, { preset: 'expiring' });
  assert.equal(expiring.body.count, out.body.stats.expiringSoon);
  assert.equal(expiring.body.count, direct.filter(r => r.status === 'expiring_soon').length);
});

test('a FitFlex pass holder who visits the gym is never in its audience', async () => {
  const everyone = await ids({ senderType: 'gym', owner: { gymIds: [w.A.gymId] } }, { preset: 'all' });
  assert.equal(everyone.has(w.roamer), false);
  const visitors = await ids({ senderType: 'gym', owner: { gymIds: [w.A.gymId] } }, { filter: { all: [{ field: 'lastVisitDaysAgo', op: 'lte', value: 3 }] } });
  assert.equal(visitors.has(w.roamer), false);
});

// ── tenancy ────────────────────────────────────────────────────────────────

test('an owner never sees or targets another gym\'s members', async () => {
  const bAll = await ids({ senderType: 'gym', owner: { gymIds: [w.B.gymId] } }, { preset: 'all' });
  assert.deepEqual([...bAll], [w.b1]);
  const aAll = await ids({ senderType: 'gym', owner: { gymIds: [w.A.gymId] } }, { preset: 'all' });
  assert.equal(aAll.has(w.b1), false);

  const foreign = await preview(w.A.owner, { gymId: w.B.gymId, preset: 'all' });
  assert.equal(foreign.statusCode, 403);
  assert.equal(foreign.body.error, 'not_your_gym');

  // A homeGymId condition can only narrow within the owner's own gyms.
  const sneaky = await preview(w.A.owner, { filter: { all: [{ field: 'homeGymId', op: 'eq', value: w.B.gymId }] } });
  assert.equal(sneaky.body.count, 0);
  assert.deepEqual(sneaky.body.gymIds, [w.A.gymId]);
});

test('gym staff need the communications scope; with it they see their gym only', async () => {
  const [, gymAcl] = ownerAudiencePreview.onGuard;
  assert.equal(runGuard(gymAcl, { userType: 'gym_staff', aclPermissions: ['members'] }).result.code, 403);
  assert.equal(runGuard(gymAcl, { userType: 'gym_staff', aclPermissions: ['communications'] }).nextCalled, true);
  assert.equal(runGuard(gymAcl, { userType: 'gym_operator', aclPermissions: [] }).nextCalled, true);
  const [auth] = ownerAudiencePreview.onGuard;
  assert.equal(runAuth(auth, { sub: 'm', userType: 'member' }).code, 403, 'members cannot preview audiences');
  assert.equal(runAuth(auth, { sub: w.staff, userType: 'gym_staff' }).nextCalled, true);

  const out = await preview({ sub: w.staff, userType: 'gym_staff' }, { preset: 'all' });
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.count, 6);
  assert.deepEqual(out.body.gymIds, [w.A.gymId]);
});

test('bad requests are refused with a reason', async () => {
  const area = await preview(w.A.owner, { filter: { all: [{ field: 'area', op: 'contains', value: 'Dar' }] } });
  assert.equal(area.statusCode, 400);
  assert.deepEqual(area.body, { error: 'invalid_audience', detail: 'field_not_allowed:area' });
  assert.equal((await preview(w.A.owner, {})).body.detail, 'audience_required');
  assert.equal((await preview(w.A.owner, { preset: 'all', purpose: 'spam' })).body.error, 'invalid_purpose');

  const noGyms = uniq('usr_owner_nogym');
  const p = res();
  await updateMemberProfile.onRequest({ user: { sub: noGyms, userType: 'gym_operator' }, body: { displayName: 'No Gym', phone: uniqPhone() } }, p);
  made.users.push(noGyms);
  const out = await preview({ sub: noGyms, userType: 'gym_operator' }, { preset: 'all' });
  assert.equal(out.statusCode, 400);
  assert.equal(out.body.error, 'owner_has_no_gyms');
});

// ── channels ───────────────────────────────────────────────────────────────

test('channel reach follows preferences and what is set up', async () => {
  const promo = (await preview(w.A.owner, { preset: 'active', purpose: 'promotion' })).body;
  assert.equal(promo.category, 'marketing');
  assert.equal(promo.count, 4);
  assert.equal(promo.channels.in_app.eligible, 3);
  assert.deepEqual(promo.channels.in_app.excluded, { in_app_marketing_off: 1 });
  assert.deepEqual(promo.channels.whatsapp, { eligible: 0, excluded: { whatsapp_not_configured: 4 } });
  assert.equal(promo.channels.push.eligible, 0, 'no one here has registered a device');

  const renewal = (await preview(w.A.owner, { preset: 'active', purpose: 'renewal' })).body;
  assert.equal(renewal.category, 'transactional');
  assert.equal(renewal.channels.in_app.eligible, 4, 'an offers opt-out never blocks a renewal reminder');

  const noPurpose = (await preview(w.A.owner, { preset: 'active' })).body;
  assert.equal(noPurpose.category, 'marketing', 'without a purpose the stricter rules apply');
});

test('the preview shows a few names, sorted', async () => {
  const out = (await preview(w.A.owner, { preset: 'all' })).body;
  assert.equal(out.sample.length, 5);
  assert.deepEqual(out.sample.map(s => s.displayName), ['Amina Active', 'Baraka Expiring', 'Chausiku Lapsed', 'Daudi Gone', 'Eliya Quiet']);
  assert.ok(out.sample.every(s => Object.keys(s).sort().join() === 'displayName,id,status'), 'no phone numbers in the preview');
});

test('the owner catalogue has gym presets and no FitFlex-only fields', async () => {
  const out = await call(ownerCommunicationSegments, w.A.owner);
  assert.equal(out.body.scope, 'gym');
  assert.ok(!out.body.fields.some(f => f.key === 'area'));
  assert.ok(out.body.presets.some(p => p.key === 'expiring'));
});

// ── FitFlex (platform) audiences ───────────────────────────────────────────

test('FitFlex admins see every member, and can target an area', async () => {
  const admin = { sub: uniq('usr_admin'), userType: 'admin' };
  const byArea = await call(adminAudiencePreview, admin, { preset: 'all', filter: { all: [{ field: 'area', op: 'contains', value: w.area }] } });
  assert.equal(byArea.statusCode, 200, JSON.stringify(byArea.body));
  assert.equal(byArea.body.count, 7, "gym A's six direct members plus the pass holder who trains there");

  const members = await ids({ senderType: 'platform' }, { preset: 'pass_holders' });
  assert.ok(members.has(w.roamer));
  assert.equal(members.has(w.a.active), false);

  const catalog = await call(adminCommunicationSegments, admin);
  assert.ok(catalog.body.fields.some(f => f.key === 'area'));
});

test('portal staff need the communications scope', () => {
  const [, acl] = adminAudiencePreview.onGuard;
  assert.equal(runGuard(acl, { userType: 'admin', portalUser: true, aclPermissions: ['members'] }).result.code, 403);
  assert.equal(runGuard(acl, { userType: 'admin', portalUser: true, aclPermissions: ['communications'] }).nextCalled, true);
  const [auth] = adminAudiencePreview.onGuard;
  assert.equal(runAuth(auth, { sub: 'o', userType: 'gym_operator' }).code, 403, 'owners cannot use FitFlex audiences');
  assert.equal(runAuth(auth, { sub: 'a', userType: 'admin' }).nextCalled, true);
});
