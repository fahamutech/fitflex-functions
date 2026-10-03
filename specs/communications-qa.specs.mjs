// Communications M12 — QA. Fills the gaps the milestone specs leave against
// the QA brief, and walks the Definition of Done end to end. The full map
// of brief cases → tests is in COMMUNICATION_TEST_PLAN.md.
//
// Two worlds:
// - "wired": services built here with every channel on (fake FCM, fake
//   WhatsApp provider), for what production can't do yet (push and WhatsApp
//   are off there).
// - the real endpoints and bootstrap services, exactly as production runs
//   them today (push and WhatsApp not set up), for the owner and member
//   journeys.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import {
  users, deviceTokens, notifications, communicationPreferences, communicationCampaigns, communicationTemplates, gyms,
} from '../src/bootstrap/collections.mjs';
import { createNotificationService } from '../src/services/notification-service.mjs';
import { createSegmentService } from '../src/services/segment-service.mjs';
import { createCampaignService } from '../src/services/campaign-service.mjs';
import { createTemplateService } from '../src/services/template-service.mjs';
import { createDeliveryService } from '../src/services/delivery-service.mjs';
import { createAutomationService } from '../src/services/automation-service.mjs';
import { createWhatsAppChannelService } from '../src/services/whatsapp-channel-service.mjs';
import { createFakeWhatsAppProvider } from '../src/integrations/whatsapp/fake-provider.mjs';
import { systemTemplateId } from '../src/shared/communication-templates.mjs';
import { DEEP_LINKS, labelText } from '../src/shared/communications.mjs';
import campaignNamesMigration from '../db/migrations/20261113090000-communication-campaign-names.cjs';
import { updateMemberProfile } from '../functions/subscriptions.mjs';
import { ownerCreateGym } from '../functions/owner-gyms.mjs';
import { ownerCreateMember, ownerListMembers } from '../functions/owner-members.mjs';
import { myNotifications, markNotificationRead, clickNotification, myCommunicationPreferences, updateMyCommunicationPreferences } from '../functions/notifications.mjs';
import * as routes from '../functions/communications.mjs';
import { deliveryService as liveDelivery, segmentService as liveSegments, templateService as liveTemplates } from '../src/bootstrap/services.mjs';

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const uniqPhone = () => `+2557${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const at = (days) => new Date(Date.now() + days * 86_400_000);
const day = (n) => at(n).toISOString().slice(0, 10);
const quiet = { warn() {}, error() {}, log() {} };
const made = { users: [], gyms: [] };
const w = {};

// ── the wired world: every channel on ──────────────────────────────────────

const fcm = {
  sent: [],
  async sendEachForMulticast({ tokens, notification, data }) {
    this.sent.push({ tokens, notification, data });
    return { successCount: tokens.length, failureCount: 0, responses: tokens.map((_, i) => ({ success: true, messageId: `fcm_${i}` })) };
  },
};
const provider = { ...createFakeWhatsAppProvider(), name: uid('qawa') };
const channel = createWhatsAppChannelService({ db, provider, settingsTtlMs: 0, logger: quiet });
const templates = createTemplateService({ db, templates: communicationTemplates, gyms, whatsappProvider: () => provider.name });
const segments = createSegmentService({ db, communicationPreferences, deviceTokens, pushAvailable: () => true, whatsappAvailable: () => channel.available() });
const campaigns = createCampaignService({
  db, campaigns: communicationCampaigns, gyms, segmentService: segments, auditLog: null, templateService: templates, largeSendThreshold: 500,
});
let delivery;
const notificationService = createNotificationService({
  users, deviceTokens, notifications, logger: quiet, getMessaging: () => fcm,
  onOpened: (rows) => delivery.onOpened(rows), onClicked: (row, opts) => delivery.onClicked(row, opts),
});
delivery = createDeliveryService({ db, notificationService, campaignService: campaigns, whatsappChannel: channel, logger: quiet, batchSize: 250 });
const automations = createAutomationService({ db, segmentService: segments, templateService: templates, sendHours: { from: 0, to: 24 }, logger: quiet });

async function user(fields) {
  const id = uid('usr');
  await db('User').insert({ id, userType: 'member', accountStatus: 'active', updatedAt: new Date(), ...fields });
  made.users.push(id);
  return id;
}
async function gym(name) {
  const id = uid('gym');
  await db('Gym').insert({ id, name, tier: 'standard', location: uid('Arusha'), updatedAt: new Date() });
  made.gyms.push(id);
  return id;
}
async function member(gymId, displayName, { expiresIn = 30, startedDaysAgo = 30, phone = uniqPhone(), status = 'active', lastVisitDaysAgo = 1, device = false, prefs = null } = {}) {
  const id = await user({ displayName, phone });
  const sub = uid('sub');
  await db('Subscription').insert({
    id: sub, memberId: id, type: 'direct_sub', plan: 'monthly', status, homeGymId: gymId,
    startedAt: at(-startedDaysAgo), cycleStartedAt: at(-startedDaysAgo), renewsAt: at(expiresIn), expiresAt: at(expiresIn),
  });
  if (lastVisitDaysAgo != null) {
    await db('Checkin').insert({ id: uid('ci'), memberId: id, gymId, timestamp: at(-lastVisitDaysAgo), method: 'qr', subscriptionType: 'direct_sub', gymTier: 'standard', visitConsumed: true });
  }
  if (device) await db('DeviceToken').insert({ id: uid('dvt'), userId: id, token: uid('tok'), platform: 'android' });
  if (prefs) await db('CommunicationPreference').insert({ id, ...prefs, updatedAt: new Date() });
  return { id, sub };
}
const gymSender = (ownerId, gymIds) => ({ senderType: 'gym', owner: { id: ownerId, gymIds }, actorId: ownerId });
const rowsOf = (campaignId) => db('CommunicationMessage').where({ campaignId });
const dispatch = (row) => delivery.deliver({ ...row, attempts: (row.attempts || 0) + 1 });

// ── the real endpoints ─────────────────────────────────────────────────────

function res() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
/** A real request: signed token → each guard → handler. */
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
const ok = (out, what, code = 200) => {
  assert.equal(out.statusCode, code, `${what}: ${out.statusCode} ${JSON.stringify(out.body)}`);
  return out.body;
};

before(async () => {
  const synced = await channel.syncTemplates(null);
  assert.ok(synced.synced > 0, 'FitFlex templates approved on the fake provider');
  w.settingsBefore = await db('PlatformSettings').where({ id: 'platform' }).first('communications');
});

after(async () => {
  await db('PlatformSettings').where({ id: 'platform' }).update({ communications: w.settingsBefore?.communications ?? null }).catch(() => {});
  await db('WhatsAppTemplate').where({ provider: provider.name }).del();
  if (made.gyms.length) {
    await db('CommunicationMessage').whereIn('gymId', made.gyms).del();
    await db('AutomationRun').whereIn('gymId', made.gyms).del();
    await db('CommunicationAutomation').whereIn('gymId', made.gyms).del();
    await db('CommunicationCampaign').whereIn('gymId', made.gyms).del();
    await db('CommunicationTemplate').whereIn('gymId', made.gyms).del();
    await db('PaymentRequest').whereIn('subscriptionId', db('Subscription').whereIn('homeGymId', made.gyms).select('id')).del();
    await db('Subscription').whereIn('homeGymId', made.gyms).del();
    await db('Gym').whereIn('id', made.gyms).del();
  }
  for (let i = 0; i < made.users.length; i += 1000) await db('User').whereIn('id', made.users.slice(i, i + 1000)).del();
});

// ══ Audience ═══════════════════════════════════════════════════════════════
// Active / expired / expiring / no match: communications-segments and
// communications-audience. Here: an owner with several gyms, and a large one.

test('audience — an owner with several gyms: all of them by default, one when chosen, never double-counted', async () => {
  const x = await gym('Xavier Gym');
  const y = await gym('Yusuf Gym');
  const owner = await user({ userType: 'gym_operator', gymIds: [x, y] });
  const S = gymSender(owner, [x, y]);
  const onlyX = await member(x, 'Only X');
  const onlyY = await member(y, 'Only Y');
  const both = await member(x, 'Both Gyms');
  await db('Subscription').insert({
    id: uid('sub'), memberId: both.id, type: 'direct_sub', plan: 'monthly', status: 'active', homeGymId: y,
    startedAt: at(-5), cycleStartedAt: at(-5), renewsAt: at(25), expiresAt: at(25),
  });
  const ids = async (gymId) => {
    const r = await segments.resolveAudience({ sender: { ...S, gymId }, preset: 'all' });
    return r.members.map(m => m.memberId).sort();
  };
  assert.deepEqual(await ids(null), [onlyX.id, onlyY.id, both.id].sort(), 'both gyms, the shared member once');
  assert.deepEqual(await ids(x), [onlyX.id, both.id].sort());
  assert.deepEqual(await ids(y), [onlyY.id, both.id].sort());

  // A campaign belongs to one gym: with two, the owner has to say which.
  assert.equal((await campaigns.create(S, { purpose: 'announcement' })).error, 'gym_required');
  const { campaign } = await campaigns.create(S, {
    gymId: y, purpose: 'announcement', audience: { preset: 'all' }, channels: ['in_app'],
    content: { title: 'Yusuf news', body: 'Hi {{member_name}}, {{gym_name}} has a new class.' },
  });
  assert.ok((await campaigns.send(S, campaign.id, { sendRequestId: uid('req') })).campaign);
  const rows = await rowsOf(campaign.id);
  assert.deepEqual(rows.map(r => r.memberId).sort(), [onlyY.id, both.id].sort());
  assert.ok(rows.every(r => r.gymId === y));
  assert.match(rows.find(r => r.memberId === both.id).body, /Yusuf Gym/, "named as the chosen gym, not the member's other one");
});

test('audience — a large audience (1,200 members): counted, confirmed, queued in chunks and delivered in batches', async () => {
  const big = await gym('Uhuru Stadium Gym');
  const owner = await user({ userType: 'gym_operator', gymIds: [big] });
  const S = gymSender(owner, [big]);
  const N = 1200;
  const ids = Array.from({ length: N }, (_, i) => `usr_qabig_${randomUUID().slice(0, 8)}_${i}`);
  made.users.push(...ids);
  for (let i = 0; i < N; i += 400) {
    const part = ids.slice(i, i + 400);
    await db('User').insert(part.map((id, j) => ({ id, userType: 'member', accountStatus: 'active', displayName: `Member ${i + j}`, updatedAt: new Date() })));
    await db('Subscription').insert(part.map(id => ({
      id: uid('sub'), memberId: id, type: 'direct_sub', plan: 'monthly', status: 'active', homeGymId: big,
      startedAt: at(-10), cycleStartedAt: at(-10), renewsAt: at(20), expiresAt: at(20),
    })));
  }
  const started = Date.now();
  const { campaign } = await campaigns.create(S, {
    purpose: 'announcement', audience: { preset: 'all' }, channels: ['in_app'],
    content: { title: 'Big news', body: 'Hi {{member_name}}, the pool opens Monday.' },
  });
  const preview = await campaigns.preview(S, { campaignId: campaign.id });
  assert.equal(preview.counts.targeted, N);
  assert.equal(preview.largeSendThreshold, 500);
  const refused = await campaigns.send(S, campaign.id, { sendRequestId: uid('req') });
  assert.deepEqual([refused.error, refused.count], ['confirm_large_send', N]);
  const sent = await campaigns.send(S, campaign.id, { sendRequestId: uid('req'), confirmLargeSend: true });
  assert.ok(sent.campaign, JSON.stringify(sent));
  assert.equal(Number((await rowsOf(campaign.id).count({ n: '*' }))[0].n), N, 'one row per member, over several insert chunks');
  assert.ok(Date.now() - started < 60_000, `planning and queueing took ${Date.now() - started} ms`);

  // The dispatcher takes it in batches; nothing is sent twice.
  const claimed = [];
  for (let run = 0; run < 10; run += 1) {
    const batch = (await delivery.claim(250)).filter(r => r.campaignId === campaign.id);
    if (!batch.length) break;
    claimed.push(batch.length);
    for (const row of batch) await delivery.deliver(row);
  }
  assert.ok(claimed.length >= 5 && claimed.every(n => n <= 250), `batches: ${claimed}`);
  const byStatus = Object.fromEntries((await rowsOf(campaign.id).groupBy('status').select('status').count({ n: '*' })).map(r => [r.status, Number(r.n)]));
  assert.deepEqual(byStatus, { delivered: N });
  assert.equal(Number((await db('Notification').whereIn('userId', ids).count({ n: '*' }))[0].n), N, 'one inbox message each');
  await delivery.closeFinished();
  assert.equal((await db('CommunicationCampaign').where({ id: campaign.id }).first('status')).status, 'sent');
  await db('Notification').whereIn('userId', ids).del();
});

// ══ Campaign ═══════════════════════════════════════════════════════════════
// Draft / send now / schedule / cancel / invalid content:
// communications-campaigns and communications-delivery. Here: duplicating.

test('campaign — duplicate: any campaign becomes a new draft, and its audience is worked out again on send', async () => {
  const g = await gym('Nakuru Gym');
  const owner = await user({ userType: 'gym_operator', gymIds: [g] });
  const S = gymSender(owner, [g]);
  const first = await member(g, 'First Member');
  const { campaign } = await campaigns.create(S, {
    name: 'September renewals', templateId: systemTemplateId('renewal_reminder'), audience: { preset: 'active' }, channels: ['in_app', 'whatsapp'],
  });
  assert.ok((await campaigns.send(S, campaign.id, { sendRequestId: uid('req') })).campaign);

  const later = await member(g, 'Joined Later');
  const copy = await campaigns.duplicate(S, campaign.id);
  assert.ok(copy.campaign, JSON.stringify(copy));
  const c = copy.campaign;
  assert.notEqual(c.id, campaign.id);
  assert.deepEqual([c.status, c.name, c.purpose, c.gymId], ['draft', 'September renewals (copy)', campaign.purpose, g]);
  assert.deepEqual(c.audience, campaign.audience);
  assert.deepEqual(c.content, campaign.content);
  assert.deepEqual(c.channels, ['in_app', 'whatsapp']);
  assert.ok(!c.sendRequestId && !c.sentAt, 'nothing of the send is copied');
  assert.ok((await campaigns.send(S, c.id, { sendRequestId: uid('req') })).campaign);
  const members = new Set((await rowsOf(c.id)).map(r => r.memberId));
  assert.ok(members.has(first.id) && members.has(later.id), 'today\'s audience, including the member who joined since');

  // A name of its own; a bad one is refused.
  assert.equal((await campaigns.duplicate(S, campaign.id, { name: 'October renewals' })).campaign.name, 'October renewals');
  assert.equal((await campaigns.duplicate(S, campaign.id, { name: '' })).error, 'invalid_name');
  // A channel switched off since is left out.
  await channel.setEnabled(null, false);
  try {
    assert.deepEqual((await campaigns.duplicate(S, campaign.id)).campaign.channels, ['in_app']);
  } finally {
    await channel.setEnabled(null, true);
  }
  // Another gym's campaign doesn't exist as far as this owner is concerned.
  const other = gymSender(await user({ userType: 'gym_operator', gymIds: [await gym('Other Gym')] }), []);
  other.owner.gymIds = [made.gyms.at(-1)];
  assert.equal((await campaigns.duplicate(other, campaign.id)).error, 'not_found');
});

test('campaign — pressing Send twice, or sending a copy, never messages a member twice for the same campaign', async () => {
  const g = await gym('Twice Gym');
  const owner = await user({ userType: 'gym_operator', gymIds: [g] });
  const S = gymSender(owner, [g]);
  const m = await member(g, 'Once Only');
  const { campaign } = await campaigns.create(S, { purpose: 'announcement', audience: { preset: 'all' }, channels: ['in_app'], content: { title: 'Hi', body: 'Once.' } });
  const reqId = uid('req');
  const [a, b] = await Promise.all([campaigns.send(S, campaign.id, { sendRequestId: reqId }), campaigns.send(S, campaign.id, { sendRequestId: reqId })]);
  assert.ok(a.campaign && b.campaign);
  assert.equal((await rowsOf(campaign.id)).length, 1);
  assert.equal((await campaigns.send(S, campaign.id, { sendRequestId: uid('req') })).error, 'invalid_state', 'a sent campaign cannot be sent again');
  assert.equal((await db('CommunicationMessage').where({ memberId: m.id })).length, 1);
});

test('campaign — lists, history and results show a readable name, never {{placeholders}}', async () => {
  assert.equal(labelText('{{discount}} off: {{offer_name}}', { discount: '20%', offerName: 'Ramadan special' }), '20% off: Ramadan special');
  assert.equal(labelText('We miss you, {{member_name}}', {}), 'We miss you');
  assert.equal(labelText('Hi {{member_name}}, renew at {{gym_name}}', {}, { gymName: 'Kilele Gym' }), 'Hi, renew at Kilele Gym');
  assert.equal(labelText('{{discount}} off: {{offer_name}}', {}), '… off: …', 'values not typed yet');
  assert.equal(labelText('Pay {{amount}} today', { amountTzs: 45000 }), 'Pay TZS 45,000 today');

  const g = await gym('Label Gym');
  const owner = await user({ userType: 'gym_operator', gymIds: [g] });
  const S = gymSender(owner, [g]);
  const m = await member(g, 'Zawadi');
  const title = '{{discount}} off: {{offer_name}}';
  const content = { title, body: 'Hi {{member_name}}, get {{discount}} off with {{offer_name}} at {{gym_name}}.', offerName: 'KULA TIZI', discount: '50%' };
  // The apps send the raw title as the name.
  const { campaign } = await campaigns.create(S, { name: title, purpose: 'promotion', audience: { preset: 'all' }, channels: ['in_app'], content });
  assert.equal(campaign.name, '50% off: KULA TIZI');
  assert.equal(campaign.content.title, title, 'the message itself keeps its variables');

  // Changing the offer changes the name with it; a name the owner chose stays.
  const edited = await campaigns.update(S, campaign.id, { content: { ...content, discount: '70%' } });
  assert.equal(edited.campaign.name, '70% off: KULA TIZI');
  const named = await campaigns.update(S, campaign.id, { name: 'October push' });
  assert.equal(named.campaign.name, 'October push');
  assert.equal((await campaigns.update(S, campaign.id, { content: { ...content, discount: '80%' } })).campaign.name, 'October push');
  await campaigns.update(S, campaign.id, { name: title });

  const listed = (await campaigns.list(S, {})).campaigns.find(c => c.id === campaign.id);
  assert.deepEqual([listed.name, listed.title], ['80% off: KULA TIZI', '80% off: KULA TIZI']);
  assert.equal((await campaigns.get(S, campaign.id)).campaign.title, '80% off: KULA TIZI', 'the heading on the campaign page too');
  const greeting = await campaigns.create(S, { purpose: 'engagement', content: { title: 'We miss you, {{member_name}}', body: 'Come back to {{gym_name}}.' } });
  assert.equal(greeting.campaign.name, 'We miss you');
  assert.equal((await campaigns.duplicate(S, campaign.id)).campaign.name, '80% off: KULA TIZI (copy)');

  // Each member still gets their own text.
  await campaigns.send(S, campaign.id, { sendRequestId: uid('req') });
  const [row] = await rowsOf(campaign.id);
  assert.equal(row.memberId, m.id);
  assert.deepEqual([row.title, row.body], ['80% off: KULA TIZI', 'Hi Zawadi, get 80% off with KULA TIZI at Label Gym.']);

  // Campaigns saved before this fix are renamed by the migration.
  await db('CommunicationCampaign').where({ id: greeting.campaign.id }).update({ name: 'We miss you, {{member_name}}' });
  await db('CommunicationCampaign').where({ id: campaign.id }).update({ name: title });
  await campaignNamesMigration.up(db);
  const after = await db('CommunicationCampaign').whereIn('id', [campaign.id, greeting.campaign.id]).select('id', 'name');
  assert.equal(after.find(r => r.id === campaign.id).name, '80% off: KULA TIZI');
  assert.equal(after.find(r => r.id === greeting.campaign.id).name, 'We miss you');
  assert.equal(Number((await db('CommunicationCampaign').whereIn('gymId', made.gyms).where('name', 'like', '%{{%').count({ n: '*' }))[0].n), 0);
});

test('campaign — the preview warns when a placeholder will be blank for some of the audience', async () => {
  const g = await gym('Blank Gym');
  const owner = await user({ userType: 'gym_operator', gymIds: [g] });
  const S = gymSender(owner, [g]);
  await member(g, 'Named Member');
  await member(g, null);
  const draft = (content) => ({ body: { purpose: 'announcement', audience: { preset: 'all' }, channels: ['in_app'], content } });
  const warningsOf = async (sender, d) => {
    const p = await campaigns.preview(sender, d);
    assert.ok(p.warnings, JSON.stringify(p));
    return p.warnings.filter(x => ['empty_value', 'gym_name_is_fitflex'].includes(x.code));
  };

  // Everyone has an end date and the gym has a name: nothing to warn about.
  assert.deepEqual(await warningsOf(S, draft({ title: 'Hello', body: 'Your plan at {{gym_name}} ends {{expiry_date}}.' })), []);
  // One of the two has no name on their account.
  assert.deepEqual(await warningsOf(S, draft({ title: 'Hi {{member_name}}', body: 'See you at {{gym_name}}.' })),
    [{ code: 'empty_value', variable: 'member_name', count: 1, of: 2 }]);
  // A Swahili version counts too, once.
  assert.deepEqual(await warningsOf(S, draft({ title: 'Hello', body: 'Welcome.', translations: { sw: { title: 'Habari {{member_name}}', body: 'Karibu {{member_name}}.' } } })),
    [{ code: 'empty_value', variable: 'member_name', count: 1, of: 2 }]);

  // FitFlex to trainers: no trainer has a membership end date, and
  // {{gym_name}} reads "FitFlex" — the "JOB OFFER … Last Date to Apply" case.
  const trainer = await user({ userType: 'trainer', displayName: 'Coach QA' });
  await db('TrainerProfile').insert({ id: uid('trn'), userId: trainer, displayName: 'Coach QA', status: 'active', approvalStatus: 'approved', updatedAt: new Date() });
  const w2 = await warningsOf({ senderType: 'platform', actorId: null }, { body: {
    purpose: 'general', audience: { recipients: 'trainers', preset: 'all' }, channels: ['in_app'],
    content: { title: 'JOB OFFER', body: 'TRAINER NEEDED at {{gym_name}}. Last date to apply {{expiry_date}}' },
  } });
  const date = w2.find(x => x.variable === 'expiry_date');
  assert.ok(date && date.count === date.of && date.of >= 1, JSON.stringify(w2));
  assert.ok(w2.some(x => x.code === 'gym_name_is_fitflex'));
  assert.equal(w2.some(x => x.variable === 'gym_name'), false, 'it is not blank — it says FitFlex');
  await db('TrainerProfile').where({ userId: trainer }).del();
});

// ══ In-app ═════════════════════════════════════════════════════════════════

test('in-app — delivered, unread, read, CTA tapped and the deep link, through the member\'s own endpoints', async () => {
  const g = await gym('Inbox Gym');
  const owner = await user({ userType: 'gym_operator', gymIds: [g] });
  const S = gymSender(owner, [g]);
  const m = await member(g, 'Reader', { device: true });
  const claims = { sub: m.id, userType: 'member' };
  const unread = async () => ok(await invoke(myNotifications, claims), 'inbox').unread;
  const before = await unread();

  const { campaign } = await campaigns.create(S, {
    purpose: 'renewal', audience: { preset: 'all' }, channels: ['in_app', 'push'],
    content: { title: 'Renew now', body: 'Hi {{member_name}}, renew at {{gym_name}}.', ctaLabel: 'Renew', deepLink: 'renewal' },
  });
  await campaigns.send(S, campaign.id, { sendRequestId: uid('req') });
  for (const row of await rowsOf(campaign.id)) await dispatch(row);
  const rows = await rowsOf(campaign.id);
  const inApp = rows.find(r => r.channel === 'in_app');
  const push = rows.find(r => r.channel === 'push');
  assert.equal(inApp.status, 'delivered');
  assert.ok(inApp.deliveredAt && inApp.notificationId);
  assert.equal(push.status, 'sent', 'push has no delivery receipt');

  // Unread in the inbox, with everything the app needs to open the right screen.
  const inbox = ok(await invoke(myNotifications, claims), 'inbox');
  assert.equal(inbox.unread, before + 1);
  const n = inbox.notifications.find(x => x.id === inApp.notificationId);
  assert.ok(n && !n.readAt);
  assert.equal(n.title, 'Renew now');
  assert.match(n.body, /^Hi Reader, renew at Inbox Gym\.$/);
  assert.deepEqual([n.data.source, n.data.deepLink, n.data.ctaLabel, n.data.senderName, n.data.campaignId], ['communication', 'renewal', 'Renew', 'Inbox Gym', campaign.id]);
  // The push opens the same inbox message.
  const sentPush = fcm.sent.find(p => p.data?.messageId === push.id);
  assert.equal(sentPush.data.notificationId, inApp.notificationId);
  assert.equal(sentPush.data.deepLink, 'renewal');

  // Read, then tap the button.
  ok(await invoke(markNotificationRead, claims, { params: { id: n.id } }), 'read');
  assert.equal(await unread(), before);
  let row = await db('CommunicationMessage').where({ id: inApp.id }).first();
  assert.equal(row.status, 'read');
  assert.ok(row.openedAt);
  ok(await invoke(clickNotification, claims, { params: { id: n.id }, body: { via: 'inbox' } }), 'click');
  row = await db('CommunicationMessage').where({ id: inApp.id }).first();
  assert.equal(row.status, 'clicked');
  assert.ok(row.clickedAt);
  // Someone else can't read or tap it.
  const stranger = { sub: (await member(g, 'Stranger')).id, userType: 'member' };
  assert.equal((await invoke(clickNotification, stranger, { params: { id: n.id }, body: {} })).statusCode, 404);
});

test('in-app — every deep link a sender can choose reaches the member as that link, and nothing else is accepted', async () => {
  const g = await gym('Links Gym');
  const owner = await user({ userType: 'gym_operator', gymIds: [g] });
  const S = gymSender(owner, [g]);
  const m = await member(g, 'Linker');
  for (const link of DEEP_LINKS) {
    const { campaign } = await campaigns.create(S, { purpose: 'announcement', audience: { preset: 'all' }, channels: ['in_app'], content: { title: link, body: 'x', ctaLabel: 'Open', deepLink: link } });
    await campaigns.send(S, campaign.id, { sendRequestId: uid('req') });
    const [row] = await rowsOf(campaign.id);
    await dispatch(row);
    const n = await db('Notification').where({ id: (await db('CommunicationMessage').where({ id: row.id }).first()).notificationId }).first();
    const data = typeof n.data === 'string' ? JSON.parse(n.data) : n.data;
    assert.equal(data.deepLink, link);
  }
  const bad = await campaigns.create(S, { purpose: 'announcement', content: { title: 'x', body: 'x', deepLink: 'https://evil.example' } });
  assert.equal(bad.error, 'invalid_content');
  assert.equal(bad.detail, 'unknown_deep_link');
  assert.equal(await db('Notification').where({ userId: m.id }).count({ n: '*' }).then(r => Number(r[0].n)), DEEP_LINKS.length);
});

// ══ WhatsApp ═══════════════════════════════════════════════════════════════
// Valid number, opted-out, provider failure, template unavailable, delivery
// failure: communications-whatsapp. Here: all channels together, and a
// number that disappears between queueing and sending.

test('WhatsApp — one campaign on every channel: each member gets what they can receive, and why not otherwise', async () => {
  const g = await gym('Channels Gym');
  const owner = await user({ userType: 'gym_operator', gymIds: [g] });
  const S = gymSender(owner, [g]);
  const everything = await member(g, 'All Channels', { device: true, phone: '0712 000 111' });
  const noPhone = await member(g, 'No Phone', { device: true, phone: null });
  const optedOut = await member(g, 'Said Stop', { phone: '0712 000 222', prefs: { whatsappOptedOutAt: new Date() } });
  const { campaign } = await campaigns.create(S, { templateId: systemTemplateId('renewal_reminder'), audience: { preset: 'all' }, channels: ['in_app', 'push', 'whatsapp'] });
  assert.ok((await campaigns.send(S, campaign.id, { sendRequestId: uid('req') })).campaign);
  for (const row of (await rowsOf(campaign.id)).filter(r => r.status === 'queued')) await dispatch(row);
  const rows = await rowsOf(campaign.id);
  const of = (m) => Object.fromEntries(rows.filter(r => r.memberId === m.id).map(r => [r.channel, r.status === 'skipped' ? `skipped:${r.skipReason}` : r.status]));
  assert.deepEqual(of(everything), { in_app: 'delivered', push: 'sent', whatsapp: 'sent' });
  assert.deepEqual(of(noPhone), { in_app: 'delivered', push: 'sent', whatsapp: 'skipped:no_phone' });
  assert.deepEqual(of(optedOut), { in_app: 'delivered', push: 'skipped:no_device', whatsapp: 'skipped:whatsapp_opted_out' });
  const wa = rows.find(r => r.memberId === everything.id && r.channel === 'whatsapp');
  assert.ok(wa.providerMessageId, 'the provider reference is kept');
});

test('WhatsApp — a number removed after the message was queued is skipped, not sent or retried', async () => {
  const g = await gym('Vanished Gym');
  const owner = await user({ userType: 'gym_operator', gymIds: [g] });
  const S = gymSender(owner, [g]);
  const m = await member(g, 'Changed Mind', { phone: '0712 000 333' });
  const { campaign } = await campaigns.create(S, { templateId: systemTemplateId('renewal_reminder'), audience: { preset: 'all' }, channels: ['whatsapp'] });
  await campaigns.send(S, campaign.id, { sendRequestId: uid('req') });
  const [row] = await rowsOf(campaign.id);
  assert.equal(row.status, 'queued');
  await db('User').where({ id: m.id }).update({ phone: null });
  assert.equal(await dispatch(row), 'skipped');
  const after = await db('CommunicationMessage').where({ id: row.id }).first();
  assert.deepEqual([after.status, after.skipReason, after.nextAttemptAt], ['skipped', 'no_phone', null]);
});

// ══ Automation ═════════════════════════════════════════════════════════════

test('automation — 7, 3 and 1 day, expired, payment failed and inactive: each fires its own message, once', async () => {
  const g = await gym('Lifecycle Gym');
  await automations.ensureDefaults(g);
  await db('CommunicationAutomation').where({ gymId: g }).update({ status: 'enabled', channels: ['in_app'] });
  const who = {
    expiring_7: await member(g, 'Seven', { expiresIn: 6.5 }),
    expiring_3: await member(g, 'Three', { expiresIn: 2.5 }),
    expiring_1: await member(g, 'One', { expiresIn: 0.6 }),
    expired: await member(g, 'Lapsed', { expiresIn: -1.2 }),
    inactive_14: await member(g, 'Quiet', { lastVisitDaysAgo: 14 }),
    payment_failed: await member(g, 'Declined', { status: 'payment_pending' }),
    nobody: await member(g, 'Nothing Due', { expiresIn: 20 }),
  };
  await db('PaymentRequest').insert({
    id: uid('pay'), memberId: who.payment_failed.id, subscriptionId: who.payment_failed.sub, amountTzs: 45000,
    status: 'rejected', provider: 'manual', requestedAt: new Date(), decidedAt: new Date(),
  });
  const first = await automations.runDue({ gymIds: [g] });
  assert.equal(first.ran, true);
  const expected = {
    expiring_7: ['membership_expiring', /ends/],
    expiring_3: ['renewal_reminder', /./],
    expiring_1: ['membership_final_reminder', /./],
    expired: ['membership_expired', /./],
    inactive_14: ['we_miss_you', /./],
    payment_failed: ['payment_failed', /TZS 45,000/],
  };
  for (const [key, [templateKey, body]] of Object.entries(expected)) {
    const runs = await db('AutomationRun as r').join('CommunicationAutomation as a', 'a.id', 'r.automationId')
      .leftJoin('CommunicationTemplate as t', 't.id', 'a.templateId')
      .where({ 'r.gymId': g, 'r.memberId': who[key].id }).select('a.id as automationId', 't.key as templateKey', 'r.id');
    assert.equal(runs.length, 1, `${key}: one run`);
    assert.equal(runs[0].automationId, `aut_${g}_${key}`, key);
    assert.equal(runs[0].templateKey, templateKey, key);
    const [msg] = await db('CommunicationMessage').where({ automationRunId: runs[0].id });
    assert.equal(msg.status, 'queued', key);
    assert.match(msg.body, body, key);
  }
  assert.equal((await db('AutomationRun').where({ gymId: g, memberId: who.nobody.id })).length, 0, 'nothing due, nothing sent');

  // Running again (the job is hourly) sends nothing new.
  const again = await automations.runDue({ gymIds: [g] });
  assert.equal(again.fired, 0);
  assert.equal((await db('AutomationRun').where({ gymId: g })).length, 6);
  // And the dispatcher delivers them like any other message.
  const queued = await db('CommunicationMessage').whereIn('automationRunId', db('AutomationRun').where({ gymId: g }).select('id'));
  for (const row of queued) await dispatch(row);
  assert.equal((await db('Notification').whereIn('userId', Object.values(who).map(x => x.id))).length, 6);
});

// ══ Definition of Done — owner, member and system, through the real endpoints ══

test('Definition of Done — the owner journey, the member side and the system guarantees, as production runs today', async () => {
  // An owner with two gyms and members at different stages.
  const ownerId = uid('usr_owner_qa');
  const owner = { sub: ownerId, userType: 'gym_operator' };
  ok(await invoke(updateMemberProfile, owner, { body: { displayName: 'QA Owner', phone: uniqPhone() } }), 'owner profile');
  made.users.push(ownerId);
  const gymA = ok(await invoke(ownerCreateGym, owner, { body: { name: uid('Doneness Gym'), tier: 'standard', location: uid('Dodoma'), perVisitRate: 5000 } }), 'gym A', 201).id;
  const gymB = ok(await invoke(ownerCreateGym, owner, { body: { name: uid('Second Gym'), tier: 'standard', location: uid('Dodoma'), perVisitRate: 5000 } }), 'gym B', 201).id;
  made.gyms.push(gymA, gymB);
  const addMember = async (name, start, end, gymId = gymA) => {
    const out = ok(await invoke(ownerCreateMember, owner, { body: { displayName: name, phone: uniqPhone(), gymId, durationUnit: 'M', startDate: day(start), endDate: day(end), tier: 'basic' } }), name, 201);
    made.users.push(out.member.id);
    return out.member.id;
  };
  const expiring = await addMember('Ending Soon', -25, 4);
  const lapsed = await addMember('Already Lapsed', -40, -5);
  const active = await addMember('Going Strong', -5, 40);
  await addMember('Other Gym Member', -5, 40, gymB);

  // Owner: select a gym, view members, segment them.
  const overview = ok(await invoke(routes.ownerCommunicationOverview, owner, { query: { gymId: gymA } }), 'overview');
  assert.deepEqual(overview.gymIds, [gymA]);
  assert.equal(overview.members, 3, 'the chosen gym\'s three members; not the other gym\'s');
  const list = ok(await invoke(ownerListMembers, owner, { query: { gymId: gymA } }), 'members');
  assert.equal(list.members.filter(x => x.memberType === 'direct').length, 3);
  const catalogue = ok(await invoke(routes.ownerCommunicationSegments, owner), 'segments');
  assert.ok(catalogue.presets.some(p => p.key === 'expiring'));
  const seg = ok(await invoke(routes.ownerAudiencePreview, owner, { body: { gymId: gymA, preset: 'expiring', purpose: 'renewal' } }), 'audience');
  assert.equal(seg.count, 1, 'the system identifies expiring memberships');
  assert.equal(ok(await invoke(routes.ownerAudiencePreview, owner, { body: { gymId: gymA, preset: 'expired' } }), 'expired').count, 1, 'and expired ones');

  // Templates: create one, use it.
  const tpl = ok(await invoke(routes.ownerTemplateCreate, owner, { body: {
    gymId: gymA, name: 'Renewal nudge', purpose: 'renewal',
    bodies: { en: { title: 'Time to renew', body: 'Hi {{member_name}}, {{gym_name}} misses you.', ctaLabel: 'Renew' }, sw: { title: 'Wakati wa kulipia', body: 'Habari {{member_name}}, {{gym_name}} inakukumbuka.', ctaLabel: 'Lipia' } },
    deepLink: 'renewal',
  } }), 'template', 201).template;

  // Create a campaign from it, preview, choose channels.
  const draft = ok(await invoke(routes.ownerCampaignCreate, owner, { body: { gymId: gymA, templateId: tpl.id, audience: { preset: 'expiring' } } }), 'campaign', 201).campaign;
  const waRefused = await invoke(routes.ownerCampaignUpdate, owner, { params: { id: draft.id }, body: { channels: ['in_app', 'whatsapp'] } });
  assert.equal(waRefused.statusCode, 400, 'WhatsApp can only be chosen once it is set up (it is not in production yet)');
  ok(await invoke(routes.ownerCampaignUpdate, owner, { params: { id: draft.id }, body: { channels: ['in_app'] } }), 'channels');
  const preview = ok(await invoke(routes.ownerCampaignPreview, owner, { params: { id: draft.id } }), 'preview');
  assert.equal(preview.counts.targeted, 1);
  assert.equal(preview.example.memberName, 'Ending Soon', 'the preview shows a real member\'s copy');
  assert.match(preview.example.body, /Ending Soon/);

  // Send now; schedule a second one; see status and results.
  const sent = ok(await invoke(routes.ownerCampaignSend, owner, { params: { id: draft.id }, body: { sendRequestId: uid('req') } }), 'send').campaign;
  assert.equal(sent.status, 'sending');
  const later = ok(await invoke(routes.ownerCampaignCreate, owner, { body: { gymId: gymA, purpose: 'announcement', audience: { preset: 'all' }, channels: ['in_app'], content: { title: 'Holiday hours', body: 'Closed on the 9th.' } } }), 'second', 201).campaign;
  const scheduled = ok(await invoke(routes.ownerCampaignSchedule, owner, { params: { id: later.id }, body: { scheduledAt: at(1).toISOString() } }), 'schedule').campaign;
  assert.equal(scheduled.status, 'scheduled');
  for (const row of await rowsOf(draft.id)) await liveDelivery.deliver({ ...row, attempts: 1 });
  await liveDelivery.closeFinished();
  const status = ok(await invoke(routes.ownerCampaignGet, owner, { params: { id: draft.id } }), 'status').campaign;
  assert.equal(status.status, 'sent');
  const results = ok(await invoke(routes.ownerCampaignAnalytics, owner, { params: { id: draft.id } }), 'results');
  assert.equal(results.members.recipients, 1);
  assert.equal(results.members.delivered, 1);

  // Member: receives it in-app, opens the right screen, manages preferences.
  const m = { sub: expiring, userType: 'member' };
  const inbox = ok(await invoke(myNotifications, m), 'member inbox');
  const n = inbox.notifications.find(x => x.data?.campaignId === draft.id);
  assert.ok(n, 'received in-app');
  assert.equal(n.data.deepLink, 'renewal');
  ok(await invoke(clickNotification, m, { params: { id: n.id }, body: { via: 'inbox' } }), 'tap');
  const prefs = ok(await invoke(myCommunicationPreferences, m), 'prefs').preferences;
  assert.equal(prefs.inAppMarketing, true);
  ok(await invoke(updateMyCommunicationPreferences, m, { body: { inAppMarketing: false } }), 'turn offers off');

  // History: campaign history, the message log and the member timeline.
  const history = ok(await invoke(routes.ownerCampaignList, owner, { query: { gymId: gymA } }), 'history');
  assert.deepEqual(history.campaigns.map(c => c.id).sort(), [draft.id, later.id].sort());
  const log = ok(await invoke(routes.ownerCommunicationMessages, owner, { query: { memberId: expiring } }), 'log');
  assert.ok(log.messages.some(x => x.campaignId === draft.id && x.status === 'clicked'), 'delivery status is logged, through to the tap');
  const timeline = ok(await invoke(routes.ownerMemberCommunications, owner, { params: { memberId: expiring } }), 'timeline');
  assert.ok(JSON.stringify(timeline).includes(draft.id));

  // A promotion now skips the member who turned offers off — and says why.
  const promo = ok(await invoke(routes.ownerCampaignCreate, owner, { body: { gymId: gymA, purpose: 'promotion', audience: { preset: 'all' }, channels: ['in_app'], content: { title: 'Half price', body: 'This week only.' } } }), 'promo', 201).campaign;
  ok(await invoke(routes.ownerCampaignSend, owner, { params: { id: promo.id }, body: { sendRequestId: uid('req') } }), 'send promo');
  const skipped = (await rowsOf(promo.id)).find(r => r.memberId === expiring);
  assert.deepEqual([skipped.status, skipped.skipReason], ['skipped', 'in_app_marketing_off']);

  // Automations: configure, and the system triggers them once.
  const autos = ok(await invoke(routes.ownerAutomationList, owner, { query: { gymId: gymA } }), 'automations').automations;
  const expiredAuto = autos.find(a => a.trigger === 'membership_expired');
  ok(await invoke(routes.ownerAutomationUpdate, owner, { params: { id: expiredAuto.id }, body: { status: 'enabled', channels: ['in_app'] } }), 'enable');
  const run = createAutomationService({ db, segmentService: liveSegments, templateService: liveTemplates, sendHours: { from: 0, to: 24 }, logger: quiet });
  assert.equal((await run.runDue({ gymIds: [gymA] })).fired, 0, 'expired 5 days ago is outside the catch-up window — not messaged late');
  await db('Subscription').where({ memberId: lapsed, homeGymId: gymA }).update({ expiresAt: at(-1.2) });
  assert.equal((await run.runDue({ gymIds: [gymA] })).fired, 1, 'the system triggers the automated message');
  assert.equal((await run.runDue({ gymIds: [gymA] })).fired, 0, 'and never twice');

  // Isolation: the other gym's member got nothing from gym A.
  assert.equal((await db('CommunicationMessage').where({ gymId: gymA }).whereNotIn('memberId', [expiring, lapsed, active])).length, 0);

  // Audit log: sends, schedules and automation changes are recorded.
  await new Promise(r => setTimeout(r, 200));
  const actions = new Set((await db('AuditLog').whereIn('target', [draft.id, later.id, expiredAuto.id]).select('action')).map(r => r.action));
  for (const a of ['communication_campaign_sent', 'communication_campaign_scheduled']) assert.ok(actions.has(a), `${a} in ${[...actions]}`);
  assert.ok(actions.has('automation_updated'), `automation change in ${[...actions]}`);
});
