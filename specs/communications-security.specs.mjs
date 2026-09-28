// Communications M11 — security and tenant isolation, through the real
// endpoints (guards and handlers) against the CI database.
//
// Two gyms, two owners. Owner A tries every owner communications endpoint
// with gym B's ids — its gym, campaigns, templates, automations, messages
// and members — and must never see or change any of it. Then: staff whose
// permission was taken away, suspended and deleted accounts, tokens for the
// wrong kind of account, suspended members, and the checks that stop a gym
// message reaching someone who isn't that gym's member even if a bug let it
// through.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { updateMemberProfile } from '../functions/subscriptions.mjs';
import { ownerCreateGym } from '../functions/owner-gyms.mjs';
import { ownerCreateMember } from '../functions/owner-members.mjs';
import * as routes from '../functions/communications.mjs';
import { deliveryService, segmentService } from '../src/bootstrap/services.mjs';
import { assertGymRecipients } from '../src/shared/communication-tenancy.mjs';
import { whatsappParameter, WHATSAPP_PARAMETER_MAX } from '../src/shared/message-render.mjs';

const uniq = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const uniqPhone = () => `+2557${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

function res() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

/** Runs a route as a real request: signed token → each guard → handler. */
async function invoke(route, claims, { params = {}, query = {}, body = {} } = {}) {
  const out = res();
  const req = { headers: { authorization: `Bearer ${sign(claims)}` }, params, query, body };
  for (const guard of [route.onGuard].flat()) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return out;
}

const made = { users: [], gyms: [] };
const w = {};

async function ownerWithGym(name) {
  const id = uniq('usr_owner_sec');
  const p = res();
  await updateMemberProfile.onRequest({ user: { sub: id, userType: 'gym_operator' }, body: { displayName: name, phone: uniqPhone() } }, p);
  assert.equal(p.statusCode, 200);
  made.users.push(id);
  const claims = { sub: id, userType: 'gym_operator' };
  const g = res();
  await ownerCreateGym.onRequest({ user: claims, body: { name: uniq(name), tier: 'standard', location: uniq('Moshi'), perVisitRate: 5000 } }, g);
  assert.equal(g.statusCode, 201);
  made.gyms.push(g.body.id);
  return { id, claims, gymId: g.body.id };
}

async function member(o, name) {
  const out = res();
  await ownerCreateMember.onRequest({ user: o.claims, body: {
    displayName: name, phone: uniqPhone(), gymId: o.gymId, durationUnit: 'M', startDate: day(-10), endDate: day(20), tier: 'basic',
  } }, out);
  assert.equal(out.statusCode, 201, JSON.stringify(out.body));
  made.users.push(out.body.member.id);
  return out.body.member.id;
}

const campaignBody = (title = 'Hello members') => ({
  name: uniq('Sec'), purpose: 'announcement', audience: { preset: 'all' }, content: { title, body: 'Doors open at 6.' }, channels: ['in_app'],
});

async function sentCampaign(o) {
  const c = await invoke(routes.ownerCampaignCreate, o.claims, { body: campaignBody() });
  assert.equal(c.statusCode, 201, JSON.stringify(c.body));
  const s = await invoke(routes.ownerCampaignSend, o.claims, { params: { id: c.body.campaign.id }, body: { sendRequestId: uniq('sendreq') } });
  assert.equal(s.statusCode, 200, JSON.stringify(s.body));
  return c.body.campaign.id;
}

before(async () => {
  w.A = await ownerWithGym('Alpha Gym');
  w.B = await ownerWithGym('Bravo Gym');
  w.a1 = await member(w.A, 'Asha Alpha');
  w.a2 = await member(w.A, 'Amani Alpha');
  w.b1 = await member(w.B, 'Bahati Bravo');

  // Gym B's things, which owner A goes after.
  w.bSent = await sentCampaign(w.B);
  const draft = await invoke(routes.ownerCampaignCreate, w.B.claims, { body: campaignBody('B draft') });
  w.bDraft = draft.body.campaign.id;
  const tpl = await invoke(routes.ownerTemplateCreate, w.B.claims, { body: {
    name: 'Bravo only', purpose: 'announcement', bodies: { en: { title: 'Bravo news', body: 'Only for Bravo.' } },
  } });
  assert.equal(tpl.statusCode, 201, JSON.stringify(tpl.body));
  w.bTemplate = tpl.body.template.id;
  const autos = await invoke(routes.ownerAutomationList, w.B.claims);
  w.bAutomation = autos.body.automations[0].id;
  w.bMessage = (await db('CommunicationMessage').where({ campaignId: w.bSent }).first('id')).id;

  // Gym A's own, so the "allowed" checks have something to find.
  w.aSent = await sentCampaign(w.A);
  await invoke(routes.ownerAutomationList, w.A.claims);

  w.staff = uniq('usr_staff_sec');
  await db('User').insert({ id: w.staff, userType: 'gym_staff', displayName: 'Desk', accountStatus: 'active', gymIds: [w.A.gymId], aclPermissions: ['communications'], updatedAt: new Date() });
  made.users.push(w.staff);
  w.admin = uniq('usr_admin_sec');
  await db('User').insert({ id: w.admin, userType: 'admin', displayName: 'Portal Staff', accountStatus: 'active', portalUser: true, aclPermissions: ['communications'], updatedAt: new Date() });
  made.users.push(w.admin);
});

after(async () => {
  const gyms = made.gyms;
  if (gyms.length) {
    await db('CommunicationMessage').whereIn('gymId', gyms).del();
    await db('CommunicationMessage').whereIn('memberId', made.users).del();
    await db('Notification').whereIn('userId', made.users).del().catch(() => {});
    await db('AutomationRun').whereIn('gymId', gyms).del();
    await db('CommunicationAutomation').whereIn('gymId', gyms).del();
    await db('CommunicationCampaign').whereIn('gymId', gyms).del();
    await db('CommunicationTemplate').whereIn('gymId', gyms).del();
    await db('PaymentRequest').whereIn('subscriptionId', db('Subscription').whereIn('homeGymId', gyms).select('id')).del().catch(() => {});
    await db('Subscription').whereIn('homeGymId', gyms).del();
    await db('Gym').whereIn('id', gyms).del();
  }
  if (made.users.length) await db('User').whereIn('id', made.users).del();
});

// ── owner A against gym B, on every endpoint ────────────────────────────────

const ownerRoutes = () => Object.entries(routes)
  .filter(([, r]) => r && typeof r === 'object' && typeof r.path === 'string' && r.path.startsWith('/owner/'));

function paramsFor(path, campaignId) {
  const p = {};
  if (path.includes('/campaigns/:id')) p.id = campaignId;
  else if (path.includes('/templates/:id')) p.id = w.bTemplate;
  else if (path.includes('/automations/:id')) p.id = w.bAutomation;
  else if (path.includes('/messages/:id')) p.id = w.bMessage;
  if (path.includes(':memberId')) p.memberId = w.b1;
  return p;
}

const bIds = () => [w.B.gymId, w.bSent, w.bDraft, w.bTemplate, w.bAutomation, w.bMessage, w.b1];

test('every owner endpoint is covered by this suite', () => {
  const paths = ownerRoutes().map(([, r]) => `${r.method} ${r.path}`);
  assert.ok(paths.length >= 35, `only ${paths.length} owner routes found`);
  for (const [name, r] of ownerRoutes()) {
    assert.ok([r.onGuard].flat().length >= 2, `${name} needs the auth and scope guards`);
  }
});

for (const which of ['sent', 'draft']) {
  test(`owner A never reads or changes gym B's data (${which} campaign)`, async () => {
    const campaignId = which === 'sent' ? w.bSent : w.bDraft;
    const before = await db('CommunicationCampaign').where({ id: campaignId }).first('status', 'name', 'updatedAt');
    const tplBefore = await db('CommunicationTemplate').where({ id: w.bTemplate }).first('status', 'name', 'updatedAt');
    const autoBefore = await db('CommunicationAutomation').where({ id: w.bAutomation }).first('status', 'channels', 'templateId');
    const leaks = [];
    for (const [name, r] of ownerRoutes()) {
      const params = paramsFor(r.path, campaignId);
      const body = { ...campaignBody(), gymId: w.B.gymId, status: 'enabled', sendRequestId: uniq('sendreq'), scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), confirmLargeSend: true, preset: 'all' };
      const out = await invoke(r, w.A.claims, { params, query: { gymId: w.B.gymId, campaignId, memberId: w.b1 }, body });
      const text = JSON.stringify(out.body ?? '');
      // The request names gym B's gym (and, for :id routes, B's thing):
      // refused outright, and nothing of B's in the answer.
      // The only 2xx allowed: the catalogue, which isn't gym data.
      if (out.statusCode < 400 && name !== 'ownerCommunicationSegments') leaks.push(`${name} ${r.method} ${r.path} → ${out.statusCode}`);
      for (const id of bIds()) {
        if (id !== w.B.gymId && text.includes(id)) leaks.push(`${name} returned ${id}`);
      }
    }
    assert.deepEqual(leaks, []);
    assert.deepEqual(await db('CommunicationCampaign').where({ id: campaignId }).first('status', 'name', 'updatedAt'), before);
    assert.deepEqual(await db('CommunicationTemplate').where({ id: w.bTemplate }).first('status', 'name', 'updatedAt'), tplBefore);
    assert.deepEqual(await db('CommunicationAutomation').where({ id: w.bAutomation }).first('status', 'channels', 'templateId'), autoBefore);
    assert.equal(await db('CommunicationMessage').where({ memberId: w.b1 }).whereNot({ gymId: w.B.gymId }).count({ n: '*' }).then(r => Number(r[0].n)), 0,
      'no message from anyone but gym B ever reached its member');
  });
}

test('without naming a gym, owner A gets only gym A — never gym B', async () => {
  const leaks = [];
  for (const [name, r] of ownerRoutes()) {
    if (r.method !== 'get' || r.path.includes(':')) continue;
    const out = await invoke(r, w.A.claims);
    assert.ok(out.statusCode < 400, `${name} → ${out.statusCode} ${JSON.stringify(out.body)}`);
    const text = JSON.stringify(out.body);
    for (const id of bIds()) if (text.includes(id)) leaks.push(`${name} returned ${id}`);
  }
  assert.deepEqual(leaks, []);
  const list = await invoke(routes.ownerCampaignList, w.A.claims);
  assert.ok(list.body.campaigns.some(c => c.id === w.aSent), 'and it does see its own');
});

test("a campaign's audience is the gym's own direct members, whatever the filter", async () => {
  const sneaky = await invoke(routes.ownerAudiencePreview, w.A.claims, { body: {
    preset: 'all', filter: { any: [{ field: 'homeGymId', op: 'eq', value: w.B.gymId }, { field: 'homeGymId', op: 'eq', value: w.A.gymId }] },
  } });
  assert.equal(sneaky.statusCode, 200, JSON.stringify(sneaky.body));
  assert.deepEqual(sneaky.body.gymIds, [w.A.gymId]);
  const rows = await db('CommunicationMessage').where({ campaignId: w.aSent }).select('memberId');
  assert.deepEqual(new Set(rows.map(r => r.memberId)), new Set([w.a1, w.a2]));
});

// ── the account behind the token, as it is now ─────────────────────────────

test('staff need the communications permission on their account now, not just in their token', async () => {
  const claims = { sub: w.staff, userType: 'gym_staff', aclPermissions: ['communications'] };
  assert.equal((await invoke(routes.ownerCommunicationOverview, claims)).statusCode, 200);

  // The owner takes the permission away; the old token still says yes.
  await db('User').where({ id: w.staff }).update({ aclPermissions: ['members'] });
  for (const r of [routes.ownerCommunicationOverview, routes.ownerCampaignList, routes.ownerAudiencePreview, routes.ownerCommunicationMessages, routes.ownerAutomationList, routes.ownerCommunicationAnalytics]) {
    const out = await invoke(r, claims, { body: { preset: 'all' } });
    assert.equal(out.statusCode, 403, `${r.path} → ${out.statusCode}`);
    assert.equal(out.body.error, 'acl_forbidden');
  }
  // A token without it is refused by the guard before any lookup.
  const noScope = await invoke(routes.ownerCampaignList, { sub: w.staff, userType: 'gym_staff', aclPermissions: ['members'] });
  assert.equal(noScope.statusCode, 403);
  await db('User').where({ id: w.staff }).update({ aclPermissions: ['communications'] });
});

test('staff act only for the gyms they are assigned to', async () => {
  const claims = { sub: w.staff, userType: 'gym_staff', aclPermissions: ['communications'] };
  const other = await invoke(routes.ownerCampaignList, claims, { query: { gymId: w.B.gymId } });
  assert.equal(other.statusCode, 403);
  // Assigned a gym no active owner holds (say, one taken off its owner): nothing.
  const orphan = uniq('gym_orphan');
  await db('Gym').insert({ id: orphan, name: 'Orphan', tier: 'standard', location: 'Nowhere', updatedAt: new Date() });
  made.gyms.push(orphan);
  await db('User').where({ id: w.staff }).update({ gymIds: [orphan] });
  const list = await invoke(routes.ownerCampaignList, claims);
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.body.campaigns, []);
  const out = await invoke(routes.ownerAudiencePreview, claims, { body: { preset: 'all' } });
  assert.equal(out.statusCode, 400);
  assert.equal(out.body.error, 'owner_has_no_gyms');
  await db('User').where({ id: w.staff }).update({ gymIds: [w.A.gymId] });
});

test('a suspended or deleted account is refused even with a valid token', async () => {
  const id = uniq('usr_owner_susp');
  await db('User').insert({ id, userType: 'gym_operator', displayName: 'Soon Suspended', accountStatus: 'active', gymIds: [w.A.gymId], updatedAt: new Date() });
  made.users.push(id);
  const claims = { sub: id, userType: 'gym_operator' };
  assert.equal((await invoke(routes.ownerCampaignList, claims)).statusCode, 200);
  // requireAuth caches the status for 30 seconds; the handler checks it fresh.
  await db('User').where({ id }).update({ accountStatus: 'suspended' });
  const out = await invoke(routes.ownerCampaignSend, claims, { params: { id: w.aSent }, body: { sendRequestId: uniq('sendreq') } });
  assert.equal(out.statusCode, 403);
  assert.equal(out.body.error, 'account_suspended');

  await db('User').where({ id }).del();
  const gone = await invoke(routes.ownerCampaignList, claims);
  assert.equal(gone.statusCode, 404);
  assert.equal(gone.body.error, 'user_not_found');
});

test("a token must match the account's kind, and gyms must exist", async () => {
  // A member's id in an owner-shaped token.
  const forged = await invoke(routes.ownerCampaignList, { sub: w.a1, userType: 'gym_operator' });
  assert.equal(forged.statusCode, 403);
  assert.equal(forged.body.error, 'forbidden');
  // Members and trainers never get past the guard.
  assert.equal((await invoke(routes.ownerCampaignList, { sub: w.a1, userType: 'member' })).statusCode, 403);
  // An owner whose account lists a gym that no longer exists can't use it.
  const ghost = uniq('gym_ghost');
  const id = uniq('usr_owner_ghost');
  await db('User').insert({ id, userType: 'gym_operator', displayName: 'Ghost', accountStatus: 'active', gymIds: [ghost], updatedAt: new Date() });
  made.users.push(id);
  const only = await invoke(routes.ownerCampaignCreate, { sub: id, userType: 'gym_operator' }, { body: { ...campaignBody(), gymId: ghost } });
  assert.equal(only.statusCode, 400);
  assert.equal(only.body.error, 'owner_has_no_gyms');
  await db('User').where({ id }).update({ gymIds: [ghost, w.A.gymId] });
  const named = await invoke(routes.ownerCampaignCreate, { sub: id, userType: 'gym_operator' }, { body: { ...campaignBody(), gymId: ghost } });
  assert.equal(named.statusCode, 403);
  assert.equal(named.body.error, 'not_your_gym');
});

test('FitFlex routes need an admin, with the permission on their account now', async () => {
  const claims = { sub: w.admin, userType: 'admin', portalUser: true, aclPermissions: ['communications'] };
  assert.equal((await invoke(routes.adminCampaignList, claims)).statusCode, 200);
  await db('User').where({ id: w.admin }).update({ aclPermissions: ['members'] });
  for (const r of [routes.adminCampaignList, routes.adminAudiencePreview, routes.adminWhatsAppStatus, routes.adminCommunicationMessages]) {
    const out = await invoke(r, claims, { body: { preset: 'all' } });
    assert.equal(out.statusCode, 403, `${r.path} → ${out.statusCode}`);
    assert.equal(out.body.error, 'acl_forbidden');
  }
  await db('User').where({ id: w.admin }).update({ aclPermissions: ['communications'] });
  // Owners never reach FitFlex's messages.
  assert.equal((await invoke(routes.adminCampaignList, w.A.claims)).statusCode, 403);
  assert.equal((await invoke(routes.adminWhatsAppSetEnabled, w.A.claims, { body: { enabled: false } })).statusCode, 403);
});

// ── members ────────────────────────────────────────────────────────────────

test('suspended members are left out of audiences, and skipped if suspended after queueing', async () => {
  const S = { senderType: 'gym', owner: { gymIds: [w.A.gymId] } };
  const ids = async () => new Set((await segmentService.resolveAudience({ sender: S, preset: 'all' })).members.map(m => m.memberId));
  assert.ok((await ids()).has(w.a2));

  const c = await invoke(routes.ownerCampaignCreate, w.A.claims, { body: campaignBody('Suspension check') });
  const sent = await invoke(routes.ownerCampaignSend, w.A.claims, { params: { id: c.body.campaign.id }, body: { sendRequestId: uniq('sendreq') } });
  assert.equal(sent.statusCode, 200);
  await db('User').where({ id: w.a2 }).update({ accountStatus: 'suspended' });
  assert.equal((await ids()).has(w.a2), false, 'no longer in any audience');
  const platform = await segmentService.resolveAudience({ sender: { senderType: 'platform' }, preset: 'all' });
  assert.equal(platform.members.some(m => m.memberId === w.a2), false, 'nor in FitFlex-wide ones');

  const row = await db('CommunicationMessage').where({ campaignId: c.body.campaign.id, memberId: w.a2 }).first();
  assert.equal(row.status, 'queued');
  assert.equal(await deliveryService.deliver({ ...row, attempts: 1 }), 'skipped');
  const after = await db('CommunicationMessage').where({ id: row.id }).first('status', 'skipReason');
  assert.deepEqual(after, { status: 'skipped', skipReason: 'account_suspended' });
  await db('User').where({ id: w.a2 }).update({ accountStatus: 'active' });
});

// ── if a bug ever let one through ──────────────────────────────────────────

test("a gym message for someone who isn't that gym's member is never stored or sent", async () => {
  const template = await db('CommunicationMessage').where({ campaignId: w.aSent }).first();
  const stray = { ...template, id: uniq('cmm'), memberId: w.b1, status: 'queued' };
  await assert.rejects(
    db.transaction(async trx => assertGymRecipients(trx, [stray])),
    err => err.code === 'TENANT_ISOLATION',
  );
  await assertGymRecipients(db, [{ ...stray, memberId: w.a1 }]); // A's own member: fine
  await assertGymRecipients(db, [{ ...stray, senderType: 'platform', gymId: null }]); // FitFlex: not gym-scoped

  // Already in the ledger somehow: the dispatcher refuses to send it.
  const { campaignId: _c, ...loose } = stray;
  await db('CommunicationMessage').insert({ ...loose, campaignId: null });
  assert.equal(await deliveryService.deliver({ ...stray, campaignId: null, attempts: 1 }), 'skipped');
  assert.equal((await db('CommunicationMessage').where({ id: stray.id }).first('skipReason')).skipReason, 'not_gym_member');
  assert.equal(await db('Notification').where({ userId: w.b1 }).whereNot({ gymId: w.B.gymId }).first('id').catch(() => null), undefined,
    "nothing in B's member's inbox from gym A");
});

// ── limits ─────────────────────────────────────────────────────────────────

test('message limits: title 65, body 1000, WhatsApp values cleaned', async () => {
  const long = await invoke(routes.ownerCampaignCreate, w.A.claims, { body: { ...campaignBody('x'.repeat(66)) } });
  assert.equal(long.statusCode, 400);
  assert.match(long.body.detail || long.body.error, /title_too_long/);
  const body = await invoke(routes.ownerCampaignCreate, w.A.claims, { body: { ...campaignBody(), content: { title: 'ok', body: 'y'.repeat(1001) } } });
  assert.equal(body.statusCode, 400);
  assert.match(body.body.detail || body.body.error, /body_too_long/);

  assert.equal(whatsappParameter('Asha\n\n\tAlpha     Gym\u0007'), 'Asha Alpha Gym');
  assert.equal(whatsappParameter(null), '');
  assert.equal(whatsappParameter('z'.repeat(5000)).length, WHATSAPP_PARAMETER_MAX);
});
