// Communications M4 — campaigns against the CI database: drafts, preview,
// schedule, cancel, and a send that queues each member's own message once,
// however often Send is pressed. Tenancy: a gym never sees, edits or sends
// another gym's (or FitFlex's) campaigns.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { communicationPreferences, deviceTokens, communicationCampaigns, gyms } from '../src/bootstrap/collections.mjs';
import { createSegmentService } from '../src/services/segment-service.mjs';
import { createCampaignService } from '../src/services/campaign-service.mjs';
import { validateContent, renderText, messageValues } from '../src/shared/communications.mjs';
import { ownerCampaignGet, ownerCampaignSend, ownerCampaignCreate, adminCampaignList } from '../functions/communications.mjs';

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const at = (days) => new Date(Date.now() + days * 86_400_000);
const made = { users: [], gyms: [] };
const w = {};

const segments = createSegmentService({ db, communicationPreferences, deviceTokens, pushAvailable: () => true, whatsappAvailable: () => false });
const svc = (opts = {}) => createCampaignService({
  db, campaigns: communicationCampaigns, gyms, segmentService: segments, auditLog: null,
  largeSendThreshold: 50, marketingWeeklyCap: 2, ...opts,
});
const campaigns = svc();

async function gym(name, location) {
  const id = uid('gym');
  await db('Gym').insert({ id, name, tier: 'standard', location, updatedAt: new Date() });
  made.gyms.push(id);
  return id;
}
async function user(fields) {
  const id = uid('usr');
  await db('User').insert({ id, userType: 'member', updatedAt: new Date(), ...fields });
  made.users.push(id);
  return id;
}
async function directMember(gymId, displayName, { expiresIn = 40, plan = 'monthly' } = {}) {
  const id = await user({ displayName, phone: `+2557${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}` });
  await db('Subscription').insert({
    id: uid('sub'), memberId: id, type: 'direct_sub', plan, status: 'active', homeGymId: gymId,
    startedAt: at(-30), cycleStartedAt: at(-30), renewsAt: at(expiresIn), expiresAt: at(expiresIn),
  });
  return id;
}

before(async () => {
  w.gymA = await gym('Kilele Fitness', uid('Moshi'));
  w.gymA2 = await gym('Kilele Annex', uid('Moshi'));
  w.gymB = await gym('Other Gym', uid('Dodoma'));
  w.ownerA = await user({ userType: 'gym_operator', displayName: 'Owner A', gymIds: [w.gymA] });
  w.ownerA2 = await user({ userType: 'gym_operator', displayName: 'Owner Two Gyms', gymIds: [w.gymA, w.gymA2] });
  w.ownerB = await user({ userType: 'gym_operator', displayName: 'Owner B', gymIds: [w.gymB] });
  w.asha = await directMember(w.gymA, 'Asha Mushi', { expiresIn: 5 });
  w.bakari = await directMember(w.gymA, 'Bakari Said', { expiresIn: 40 });
  w.chiku = await directMember(w.gymA, 'Chiku Ally', { expiresIn: 40 });
  w.dan = await directMember(w.gymB, 'Dan Other');
  await db('DeviceToken').insert({ id: uid('dvt'), userId: w.bakari, token: uid('tok'), platform: 'android' });
  await db('CommunicationPreference').insert({ id: w.chiku, inAppMarketing: false, pushMarketing: false });
  w.A = { senderType: 'gym', owner: { id: w.ownerA, gymIds: [w.gymA] }, actorId: w.ownerA };
  w.A2 = { senderType: 'gym', owner: { id: w.ownerA2, gymIds: [w.gymA, w.gymA2] }, actorId: w.ownerA2 };
  w.B = { senderType: 'gym', owner: { id: w.ownerB, gymIds: [w.gymB] }, actorId: w.ownerB };
  w.admin = await user({ userType: 'admin', displayName: 'FitFlex Admin' });
  w.FF = { senderType: 'platform', actorId: w.admin };
});

after(async () => {
  await db('CommunicationCampaign').where('createdBy', w.admin).del();
  if (made.gyms.length) await db('Gym').whereIn('id', made.gyms).del();
  if (made.users.length) await db('User').whereIn('id', made.users).del();
});

const renewal = (over = {}) => ({
  purpose: 'renewal',
  audience: { preset: 'active' },
  content: { title: 'Your {{plan_name}} plan', body: 'Hi {{member_name}}, your plan at {{gym_name}} ends on {{expiry_date}}.', ctaLabel: 'Renew', deepLink: 'renewal' },
  channels: ['in_app', 'push'],
  ...over,
});
const promo = (over = {}) => renewal({
  purpose: 'promotion',
  content: { title: '{{offer_name}}', body: 'Hi {{member_name}}, {{discount}} off this week at {{gym_name}}.', offerName: 'October Deal', discount: '20%', deepLink: 'gym' },
  ...over,
});
const ledger = (campaignId) => db('CommunicationMessage').where({ campaignId }).orderBy(['memberId', 'channel']);
const reqId = () => uid('send_req');

// ── message content ────────────────────────────────────────────────────────

test('message content: variables must exist and sender values must be filled in', () => {
  assert.equal(validateContent({ title: 'Hi', body: 'x {{shoe_size}}' }).detail, 'unknown_variable:shoe_size');
  assert.equal(validateContent({ title: 'Hi', body: '{{discount}} off' }).detail, 'missing_value:discount');
  assert.equal(validateContent({ title: 'Hi', body: 'Renew at {{renewal_link}}' }).detail, 'variable_unavailable:renewal_link');
  assert.ok(!validateContent({ title: 'Hi', body: 'Renew at {{renewal_link}}' }, { renewalLinkAvailable: true }).error);
  assert.equal(validateContent({ title: 'x'.repeat(66), body: 'b' }).detail, 'title_too_long');
  assert.equal(validateContent({ title: 'Hi', body: 'b', deepLink: 'https://evil.example' }).detail, 'unknown_deep_link');
  assert.equal(validateContent({ title: '  ', body: 'b' }).detail, 'title_required');
});

test('rendering fills each member\'s own values and tidies empty ones', () => {
  const values = messageValues({ amountTzs: 50000 }, { displayName: 'Asha', plan: 'monthly', expiresOn: '2026-10-05' }, { gymName: 'Kilele' });
  assert.equal(renderText('Hi {{member_name}}, {{plan_name}} at {{gym_name}} ends {{expiry_date}}: {{amount}}', values),
    'Hi Asha, Monthly at Kilele ends 05/10/2026: TZS 50,000');
  assert.equal(renderText('Hi {{member_name}} , welcome!', messageValues({}, { displayName: '' }, {})), 'Hi, welcome!');
});

// ── drafts ─────────────────────────────────────────────────────────────────

test('a draft needs only a purpose; an owner with one gym needn\'t name it', async () => {
  const r = await campaigns.create(w.A, { purpose: 'announcement' });
  assert.equal(r.campaign.status, 'draft');
  assert.equal(r.campaign.gymId, w.gymA);
  assert.equal(r.campaign.category, 'transactional');
  assert.equal((await campaigns.create(w.A, {})).error, 'invalid_purpose');
  assert.equal((await campaigns.create(w.A2, { purpose: 'general' })).error, 'gym_required');
  assert.equal((await campaigns.create(w.A2, { purpose: 'general', gymId: w.gymA2 })).campaign.gymId, w.gymA2);
  assert.equal((await campaigns.create(w.A, { purpose: 'general', gymId: w.gymB })).error, 'not_your_gym');
});

test('drafts reject bad audiences, content and channels', async () => {
  assert.equal((await campaigns.create(w.A, renewal({ audience: { preset: 'pass_holders' } }))).detail, 'unknown_preset:pass_holders');
  assert.equal((await campaigns.create(w.A, renewal({ audience: { filter: { all: [{ field: 'area', op: 'contains', value: 'x' }] } } }))).detail, 'field_not_allowed:area');
  assert.equal((await campaigns.create(w.A, renewal({ channels: ['whatsapp'] }))).error, 'channel_unavailable');
  assert.equal((await campaigns.create(w.A, renewal({ channels: ['fax'] }))).error, 'invalid_channels');
  assert.equal((await campaigns.create(w.A, renewal({ channels: [] }))).error, 'invalid_channels');
});

test('a draft can be edited and deleted; a sent campaign can\'t', async () => {
  const { campaign } = await campaigns.create(w.A, renewal());
  const edited = await campaigns.update(w.A, campaign.id, { name: 'October renewals', channels: ['in_app'] });
  assert.equal(edited.campaign.name, 'October renewals');
  assert.deepEqual(edited.campaign.channels, ['in_app']);
  assert.ok((await campaigns.send(w.A, campaign.id, { sendRequestId: reqId() })).campaign);
  assert.equal((await campaigns.update(w.A, campaign.id, { name: 'x' })).error, 'not_editable');
  assert.equal((await campaigns.remove(w.A, campaign.id)).error, 'only_drafts_can_be_deleted');
  const draft = (await campaigns.create(w.A, { purpose: 'general' })).campaign;
  assert.deepEqual(await campaigns.remove(w.A, draft.id), { ok: true });
  assert.equal((await campaigns.get(w.A, draft.id)).error, 'not_found');
});

// ── preview ────────────────────────────────────────────────────────────────

test('preview shows who each channel reaches and a real member\'s message', async () => {
  const p = await campaigns.preview(w.A, { body: renewal() });
  assert.equal(p.counts.targeted, 3);
  assert.deepEqual(p.counts.byChannel.in_app, { queued: 3, skipped: 0 }, 'offer opt-outs never block a renewal');
  assert.deepEqual(p.counts.byChannel.push, { queued: 1, skipped: 2 });
  assert.equal(p.counts.skipped.no_device, 2);
  assert.equal(p.example.memberName, 'Asha Mushi');
  assert.match(p.example.body, /^Hi Asha Mushi, your plan at Kilele Fitness ends on \d\d\/\d\d\/\d{4}\.$/);
  assert.equal(p.example.title, 'Your Monthly plan');
  assert.equal(p.example.deepLink, 'renewal');
  assert.deepEqual(p.warnings, []);
  assert.equal((await campaigns.preview(w.A, { body: { purpose: 'renewal', audience: { preset: 'all' } } })).detail, 'content_required');
});

test('preview warns when a channel reaches no one', async () => {
  const p = await campaigns.preview(w.A, { body: promo({ audience: { filter: { all: [{ field: 'daysUntilExpiry', op: 'gte', value: 30 }] } } }) });
  // Bakari (device, offers on) and Chiku (offers off) — push reaches Bakari only.
  assert.equal(p.counts.targeted, 2);
  assert.equal(p.counts.skipped.in_app_marketing_off, 1);
  assert.equal(p.counts.skipped.push_marketing_off, 1);
  const none = await campaigns.preview(w.A, { body: promo({ channels: ['push'], audience: { filter: { all: [{ field: 'daysUntilExpiry', op: 'lte', value: 7 }] } } }) });
  assert.ok(none.warnings.some(x => x.code === 'channel_reaches_no_one' && x.channel === 'push'));
  assert.ok(none.warnings.some(x => x.code === 'nobody_reachable'));
});

// ── send ───────────────────────────────────────────────────────────────────

test('send queues each member\'s own message on each channel they can get', async () => {
  const { campaign } = await campaigns.create(w.A, renewal());
  const r = await campaigns.send(w.A, campaign.id, { sendRequestId: reqId() });
  assert.equal(r.campaign.status, 'sending');
  assert.equal(r.campaign.counts.targeted, 3);
  assert.equal(r.campaign.counts.queued, 4);
  const rows = await ledger(campaign.id);
  assert.equal(rows.length, 6, 'one row per member per chosen channel');
  const bakariPush = rows.find(x => x.memberId === w.bakari && x.channel === 'push');
  assert.equal(bakariPush.status, 'queued');
  assert.match(bakariPush.body, /^Hi Bakari Said,/);
  const ashaPush = rows.find(x => x.memberId === w.asha && x.channel === 'push');
  assert.deepEqual([ashaPush.status, ashaPush.skipReason], ['skipped', 'no_device']);
  assert.ok(rows.every(x => x.gymId === w.gymA && x.category === 'transactional' && x.deepLink === 'renewal'));
  assert.ok(!rows.some(x => x.memberId === w.dan), 'never another gym\'s member');

  const got = await campaigns.get(w.A, campaign.id);
  assert.deepEqual(got.progress, { in_app: { queued: 3 }, push: { queued: 1, skipped: 2 } });
});

test('pressing Send again, or on two devices at once, never sends twice', async () => {
  const { campaign } = await campaigns.create(w.A, renewal({ channels: ['in_app'] }));
  const first = reqId();
  const [a, b] = await Promise.all([
    campaigns.send(w.A, campaign.id, { sendRequestId: first }),
    campaigns.send(w.A, campaign.id, { sendRequestId: reqId() }),
  ]);
  const ok = [a, b].filter(x => x.campaign && !x.replayed);
  assert.equal(ok.length, 1, 'exactly one of two simultaneous sends goes through');
  assert.ok([a, b].some(x => x.error === 'invalid_state'));
  const winner = ok[0].campaign;
  const again = await campaigns.send(w.A, campaign.id, { sendRequestId: (await communicationCampaigns.findByIdAsync(campaign.id)).sendRequestId });
  assert.equal(again.replayed, true);
  assert.equal(again.campaign.id, winner.id);
  assert.equal((await ledger(campaign.id)).length, 3);
  assert.equal((await campaigns.send(w.A, campaign.id, { sendRequestId: 'short' })).error, 'send_request_id_required');
});

test('a sendRequestId belongs to one campaign only', async () => {
  const one = (await campaigns.create(w.A, renewal({ channels: ['in_app'] }))).campaign;
  const two = (await campaigns.create(w.A, renewal({ channels: ['in_app'] }))).campaign;
  const shared = reqId();
  assert.ok((await campaigns.send(w.A, one.id, { sendRequestId: shared })).campaign);
  assert.equal((await campaigns.send(w.A, two.id, { sendRequestId: shared })).error, 'duplicate_send_request');
  assert.equal((await communicationCampaigns.findByIdAsync(two.id)).status, 'draft');
  assert.equal((await ledger(two.id)).length, 0);
});

test('large audiences need an explicit confirmation', async () => {
  const small = svc({ largeSendThreshold: 3 });
  const { campaign } = await small.create(w.A, renewal({ audience: { preset: 'all' }, channels: ['in_app'] }));
  const p = await small.preview(w.A, { campaignId: campaign.id });
  assert.ok(p.warnings.some(x => x.code === 'large_send' && x.count === 3));
  const refused = await small.send(w.A, campaign.id, { sendRequestId: reqId() });
  assert.deepEqual([refused.error, refused.count], ['confirm_large_send', 3]);
  assert.equal((await ledger(campaign.id)).length, 0);
  assert.ok((await small.send(w.A, campaign.id, { sendRequestId: reqId(), confirmLargeSend: true })).campaign);
});

test('a member gets at most the weekly number of marketing campaigns, across senders', async () => {
  const capped = svc({ marketingWeeklyCap: 1 });
  const aud = { filter: { all: [{ field: 'daysUntilExpiry', op: 'lte', value: 7 }] } }; // Asha only
  const first = (await capped.create(w.A, promo({ audience: aud, channels: ['in_app'] }))).campaign;
  assert.equal((await capped.send(w.A, first.id, { sendRequestId: reqId() })).campaign.counts.queued, 1);
  const second = (await capped.create(w.A, promo({ audience: aud, channels: ['in_app'] }))).campaign;
  const p = await capped.preview(w.A, { campaignId: second.id });
  assert.equal(p.counts.skipped.marketing_cap, 1);
  assert.equal((await capped.send(w.A, second.id, { sendRequestId: reqId() })).error, 'nobody_reachable');
  const reminder = (await capped.create(w.A, renewal({ audience: aud, channels: ['in_app'] }))).campaign;
  assert.equal((await capped.send(w.A, reminder.id, { sendRequestId: reqId() })).campaign.counts.queued, 1, 'service messages are never capped');
});

test('an empty audience is refused', async () => {
  const { campaign } = await campaigns.create(w.A, renewal({ audience: { filter: { all: [{ field: 'age', op: 'gte', value: 18 }] } } }));
  assert.equal((await campaigns.send(w.A, campaign.id, { sendRequestId: reqId() })).error, 'empty_audience');
});

// ── schedule and cancel ────────────────────────────────────────────────────

test('schedule, unschedule and cancel', async () => {
  const { campaign } = await campaigns.create(w.A, renewal());
  assert.equal((await campaigns.schedule(w.A, campaign.id, { scheduledAt: at(0).toISOString() })).error, 'schedule_too_soon');
  assert.equal((await campaigns.schedule(w.A, campaign.id, { scheduledAt: at(120).toISOString() })).error, 'schedule_too_far');
  const when = at(2).toISOString();
  const s = await campaigns.schedule(w.A, campaign.id, { scheduledAt: when });
  assert.deepEqual([s.campaign.status, s.campaign.scheduledAt], ['scheduled', when]);
  assert.equal((await campaigns.update(w.A, campaign.id, { name: 'x' })).error, 'not_editable');
  assert.equal((await campaigns.unschedule(w.A, campaign.id)).campaign.status, 'draft');
  await campaigns.schedule(w.A, campaign.id, { scheduledAt: when });
  const c = await campaigns.cancel(w.A, campaign.id);
  assert.equal(c.campaign.status, 'cancelled');
  assert.equal((await campaigns.send(w.A, campaign.id, { sendRequestId: reqId() })).error, 'invalid_state');
  assert.equal((await campaigns.cancel(w.A, campaign.id)).error, 'invalid_state');
  const bare = (await campaigns.create(w.A, { purpose: 'general' })).campaign;
  assert.equal((await campaigns.schedule(w.A, bare.id, { scheduledAt: when })).detail, 'audience_required');
});

// ── tenancy ────────────────────────────────────────────────────────────────

test('another gym\'s owner can\'t see, change or send a campaign', async () => {
  const { campaign } = await campaigns.create(w.A, renewal());
  for (const r of [
    await campaigns.get(w.B, campaign.id),
    await campaigns.update(w.B, campaign.id, { name: 'hijack' }),
    await campaigns.send(w.B, campaign.id, { sendRequestId: reqId() }),
    await campaigns.schedule(w.B, campaign.id, { scheduledAt: at(1).toISOString() }),
    await campaigns.cancel(w.B, campaign.id),
    await campaigns.remove(w.B, campaign.id),
    await campaigns.preview(w.B, { campaignId: campaign.id }),
  ]) assert.equal(r.error, 'not_found');
  assert.equal((await communicationCampaigns.findByIdAsync(campaign.id)).status, 'draft');
  assert.ok(!(await campaigns.list(w.B)).campaigns.some(c => c.id === campaign.id));
  assert.equal((await campaigns.list(w.B, { gymId: w.gymA })).error, 'not_your_gym');
  assert.ok((await campaigns.list(w.A)).campaigns.some(c => c.id === campaign.id));
});

test('FitFlex campaigns reach all members and stay out of gyms\' view', async () => {
  const { campaign } = await campaigns.create(w.FF, {
    purpose: 'announcement', gymId: w.gymA,
    audience: { filter: { all: [{ field: 'area', op: 'contains', value: (await gyms.findByIdAsync(w.gymB)).location }] } },
    content: { title: 'News from {{gym_name}}', body: 'Hi {{member_name}}!' }, channels: ['in_app'],
  });
  assert.equal(campaign.senderType, 'platform');
  assert.equal(campaign.gymId, null, 'a FitFlex campaign never belongs to a gym');
  assert.equal((await campaigns.get(w.A, campaign.id)).error, 'not_found');
  const sent = await campaigns.send(w.FF, campaign.id, { sendRequestId: reqId() });
  assert.equal(sent.campaign.counts.targeted, 1);
  const [row] = await ledger(campaign.id);
  assert.deepEqual([row.memberId, row.title, row.body, row.gymId, row.senderType], [w.dan, 'News from FitFlex', 'Hi Dan Other!', null, 'platform']);
  assert.ok(!(await campaigns.list(w.FF)).campaigns.some(c => c.senderType !== 'platform'));
});

test('overview: reachable members, campaigns by status, channels', async () => {
  const o = await campaigns.overview(w.A);
  assert.equal(o.members, 3);
  assert.ok(o.campaigns.draft >= 1 && o.campaigns.sending >= 1);
  assert.deepEqual(o.channels, { in_app: true, push: true, whatsapp: false, sms: false });
  assert.ok(o.recent.length <= 5 && o.recent.every(c => c.gymId === w.gymA));
  assert.equal((await campaigns.overview(w.A, { gymId: w.gymB })).error, 'not_your_gym');
});

// ── endpoints ──────────────────────────────────────────────────────────────

function res() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

test('endpoints take the sender from the signed-in user', async () => {
  const out = res();
  await ownerCampaignCreate.onRequest({ user: { sub: w.ownerA, userType: 'gym_operator' }, body: { purpose: 'announcement', senderType: 'platform' } }, out);
  assert.equal(out.statusCode, 201);
  assert.deepEqual([out.body.campaign.senderType, out.body.campaign.gymId], ['gym', w.gymA]);

  const peek = res();
  await ownerCampaignGet.onRequest({ user: { sub: w.ownerB, userType: 'gym_operator' }, params: { id: out.body.campaign.id } }, peek);
  assert.deepEqual([peek.statusCode, peek.body], [404, { error: 'not_found' }]);

  const large = res();
  await ownerCampaignSend.onRequest({ user: { sub: w.ownerA, userType: 'gym_operator' }, params: { id: out.body.campaign.id }, body: {} }, large);
  assert.deepEqual([large.statusCode, large.body.error], [400, 'send_request_id_required']);

  const adminList = res();
  await adminCampaignList.onRequest({ user: { sub: w.admin, userType: 'admin' }, query: {} }, adminList);
  assert.ok(adminList.body.campaigns.every(c => c.senderType === 'platform'));
});
