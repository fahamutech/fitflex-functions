// Communications M5 — delivery through the existing inbox and FCM, against
// the CI database: the dispatcher delivers each queued message once, retries
// temporary failures and gives up on permanent ones, releases scheduled
// campaigns, closes finished ones, and records opens and taps.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import {
  users, deviceTokens, notifications, communicationPreferences, communicationCampaigns, gyms,
} from '../src/bootstrap/collections.mjs';
import { createNotificationService } from '../src/services/notification-service.mjs';
import { createSegmentService } from '../src/services/segment-service.mjs';
import { createCampaignService } from '../src/services/campaign-service.mjs';
import { createDeliveryService, MAX_ATTEMPTS } from '../src/services/delivery-service.mjs';
import { createCommunicationPreferenceService } from '../src/services/communication-preference-service.mjs';

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const at = (days) => new Date(Date.now() + days * 86_400_000);
const quiet = { warn: () => {}, error: () => {} };
const made = { users: [], gyms: [] };
const w = {};

// Fake FCM: every token succeeds unless the test says otherwise.
const fcm = {
  mode: 'ok',
  sent: [],
  async sendEachForMulticast({ tokens, notification, data }) {
    if (this.mode === 'down') throw new Error('fcm unavailable');
    this.sent.push({ tokens, notification, data });
    const ok = this.mode === 'ok';
    return {
      successCount: ok ? tokens.length : 0,
      failureCount: ok ? 0 : tokens.length,
      responses: tokens.map(() => (ok ? { success: true } : { success: false, error: { code: 'messaging/internal-error' } })),
    };
  },
};

let delivery;
let pushOn = true;
const notificationService = createNotificationService({
  users, deviceTokens, notifications, logger: quiet,
  getMessaging: () => { if (!pushOn) throw new Error('push is off'); return fcm; },
  onOpened: (rows) => delivery.onOpened(rows),
  onClicked: (row, opts) => delivery.onClicked(row, opts),
});
const segments = createSegmentService({ db, communicationPreferences, deviceTokens, pushAvailable: () => true, whatsappAvailable: () => false });
const campaigns = createCampaignService({
  db, campaigns: communicationCampaigns, gyms, segmentService: segments, auditLog: null, largeSendThreshold: 50,
});
delivery = createDeliveryService({ db, notificationService, campaignService: campaigns, logger: quiet });
const prefs = createCommunicationPreferenceService({ preferences: communicationPreferences });

async function user(fields) {
  const id = uid('usr');
  await db('User').insert({ id, userType: 'member', updatedAt: new Date(), ...fields });
  made.users.push(id);
  return id;
}

before(async () => {
  w.gym = uid('gym');
  await db('Gym').insert({ id: w.gym, name: 'Mnazi Gym', tier: 'standard', location: uid('Tanga'), updatedAt: new Date() });
  made.gyms.push(w.gym);
  w.owner = await user({ userType: 'gym_operator', gymIds: [w.gym] });
  for (const name of ['Amani', 'Bahati', 'Cheka']) {
    const id = await user({ displayName: name });
    w[name] = id;
    await db('Subscription').insert({
      id: uid('sub'), memberId: id, type: 'direct_sub', plan: 'monthly', status: 'active', homeGymId: w.gym,
      startedAt: at(-10), cycleStartedAt: at(-10), renewsAt: at(20), expiresAt: at(20),
    });
  }
  for (const id of [w.Amani, w.Bahati]) await db('DeviceToken').insert({ id: uid('dvt'), userId: id, token: uid('tok'), platform: 'android' });
  w.sender = { senderType: 'gym', owner: { id: w.owner, gymIds: [w.gym] }, actorId: w.owner };
});

after(async () => {
  if (made.gyms.length) await db('Gym').whereIn('id', made.gyms).del();
  if (made.users.length) await db('User').whereIn('id', made.users).del();
});

const draft = (over = {}) => ({
  purpose: 'announcement', audience: { preset: 'all' }, channels: ['in_app', 'push'],
  content: { title: 'Closed Friday', body: 'Hi {{member_name}}, {{gym_name}} is closed on Friday.', ctaLabel: 'See hours', deepLink: 'gym' },
  ...over,
});
async function sendNew(over) {
  const { campaign } = await campaigns.create(w.sender, draft(over));
  const r = await campaigns.send(w.sender, campaign.id, { sendRequestId: uid('req') });
  assert.ok(r.campaign, JSON.stringify(r));
  return campaign.id;
}
const ledger = (campaignId) => db('CommunicationMessage').where({ campaignId }).orderBy(['memberId', 'channel']);
// Deliver just this campaign's rows, so other specs' rows don't matter.
async function deliverAll(campaignId) {
  for (const msg of await db('CommunicationMessage').where({ campaignId, status: 'queued' })) {
    const [claimed] = await db('CommunicationMessage').where({ id: msg.id }).update({ status: 'sending', attempts: msg.attempts + 1 }).returning('*');
    await delivery.deliver(claimed);
  }
  await delivery.closeFinished();
}

// ── delivery ───────────────────────────────────────────────────────────────

test('each member gets their own message in the inbox and by push, once', async () => {
  fcm.mode = 'ok'; fcm.sent.length = 0;
  const id = await sendNew();
  await deliverAll(id);
  const rows = await ledger(id);
  const inApp = rows.filter(r => r.channel === 'in_app');
  assert.equal(inApp.length, 3);
  assert.ok(inApp.every(r => r.status === 'delivered' && r.deliveredAt && r.notificationId === `ntf_${r.id}`));
  const push = rows.filter(r => r.channel === 'push');
  assert.deepEqual(push.map(r => r.status).sort(), ['sent', 'sent', 'skipped'], 'Cheka has no phone with the app');

  const inbox = await notificationService.inbox({ userId: w.Amani });
  const mine = inbox.notifications.find(n => n.campaignId === id);
  assert.equal(mine.body, 'Hi Amani, Mnazi Gym is closed on Friday.');
  assert.deepEqual([mine.category, mine.gymId, mine.type, mine.data.deepLink], ['transactional', w.gym, 'campaign', 'gym']);
  assert.deepEqual([mine.data.ctaLabel, mine.data.senderName], ['See hours', 'Mnazi Gym']);
  assert.equal(inbox.unread >= 1, true);

  const toAmani = fcm.sent.find(s => s.notification.body.startsWith('Hi Amani'));
  assert.equal(toAmani.data.notificationId, mine.id, 'the push opens the inbox copy');
  assert.equal(toAmani.data.deepLink, 'gym');

  const c = await communicationCampaigns.findByIdAsync(id);
  assert.equal(c.status, 'sent');
  assert.ok(c.sentAt);
});

test('delivering the same in-app message again never adds a second inbox row', async () => {
  const id = await sendNew({ channels: ['in_app'] });
  await deliverAll(id);
  const [row] = (await ledger(id)).filter(r => r.memberId === w.Bahati);
  // As if the server crashed after writing the inbox but before the ledger update.
  await db('CommunicationMessage').where({ id: row.id }).update({ status: 'queued' });
  await deliverAll(id);
  const copies = (await notificationService.inbox({ userId: w.Bahati })).notifications.filter(n => n.campaignId === id);
  assert.equal(copies.length, 1);
});

test('a temporary push failure is retried with back-off, then given up', async () => {
  fcm.mode = 'fail';
  const id = await sendNew({ channels: ['push'] });
  const [row] = (await ledger(id)).filter(r => r.memberId === w.Amani);
  let r = row;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const [claimed] = await db('CommunicationMessage').where({ id: r.id }).update({ status: 'sending', attempts: attempt }).returning('*');
    const outcome = await delivery.deliver(claimed);
    r = await db('CommunicationMessage').where({ id: r.id }).first();
    if (attempt < MAX_ATTEMPTS) {
      assert.equal(outcome, 'retry');
      assert.equal(r.status, 'queued');
      assert.ok(+r.nextAttemptAt > Date.now() + 30_000, 'waits before retrying');
    } else {
      assert.equal(outcome, 'failed');
      assert.deepEqual([r.status, r.failureReason, r.failurePermanent], ['failed', 'push_failed', false]);
    }
  }
  fcm.mode = 'ok';
});

test('permanent problems fail straight away, and the campaign reports a partial send', async () => {
  const id = await sendNew();
  const bahatiTokens = await db('DeviceToken').where({ userId: w.Bahati });
  await db('DeviceToken').where({ userId: w.Bahati }).del(); // signed out since the send
  pushOn = false;
  const amaniPush = (await ledger(id)).find(r => r.memberId === w.Amani && r.channel === 'push');
  const [claimed] = await db('CommunicationMessage').where({ id: amaniPush.id }).update({ status: 'sending', attempts: 1 }).returning('*');
  await delivery.deliver(claimed);
  pushOn = true;
  await deliverAll(id);
  const rows = await ledger(id);
  const byMember = (m) => rows.find(r => r.memberId === m && r.channel === 'push');
  assert.deepEqual([byMember(w.Amani).status, byMember(w.Amani).failureReason], ['failed', 'push_unavailable']);
  assert.deepEqual([byMember(w.Bahati).status, byMember(w.Bahati).failureReason, byMember(w.Bahati).failurePermanent], ['failed', 'no_device', true]);
  assert.equal((await communicationCampaigns.findByIdAsync(id)).status, 'partially_failed');
  await db('DeviceToken').insert(bahatiTokens);
});

test('two dispatchers never claim the same message; a stuck one is taken back', async () => {
  const id = await sendNew({ channels: ['in_app'] });
  const [a, b] = await Promise.all([delivery.claim(500), delivery.claim(500)]);
  const mine = (rows) => rows.filter(r => r.campaignId === id).map(r => r.id);
  const both = [...mine(a), ...mine(b)];
  assert.equal(both.length, 3);
  assert.equal(new Set(both).size, 3, 'no row claimed twice');
  // Nothing is re-claimed while the send is in progress…
  assert.equal(mine(await delivery.claim(500)).length, 0);
  // …but a row left in `sending` for over 10 minutes is taken back.
  await db('CommunicationMessage').where({ campaignId: id }).update({ updatedAt: new Date(Date.now() - 11 * 60_000) });
  const again = mine(await delivery.claim(500));
  assert.equal(again.length, 3);
  for (const msgId of again) await delivery.deliver(await db('CommunicationMessage').where({ id: msgId }).first());
  assert.ok((await ledger(id)).every(r => r.status === 'delivered'));
});

test('a message another dispatcher is working on is skipped, not waited for', async () => {
  const id = await sendNew({ channels: ['in_app'] });
  const [locked, ...rest] = await ledger(id);
  const mine = (rows) => rows.filter(r => r.campaignId === id).map(r => r.id);
  await db.transaction(async (trx) => {
    await trx('CommunicationMessage').where({ id: locked.id }).forUpdate().select('id'); // another server holds this row
    const got = await Promise.race([
      delivery.claim(500),
      new Promise((_, reject) => setTimeout(() => reject(new Error('claim waited on a locked row')), 3000)),
    ]);
    assert.deepEqual(mine(got).sort(), rest.map(r => r.id).sort());
  });
  for (const msg of await db('CommunicationMessage').where({ campaignId: id, status: 'sending' })) await delivery.deliver(msg);
  await deliverAll(id);
});

// ── scheduled campaigns ────────────────────────────────────────────────────

test('a scheduled campaign goes out when due, once; a cancelled one never does', async () => {
  const { campaign } = await campaigns.create(w.sender, draft({ channels: ['in_app'] }));
  const s = await campaigns.schedule(w.sender, campaign.id, { scheduledAt: at(1).toISOString() });
  assert.equal(s.campaign.status, 'scheduled');
  const { campaign: other } = await campaigns.create(w.sender, draft({ channels: ['in_app'] }));
  await campaigns.schedule(w.sender, other.id, { scheduledAt: at(1).toISOString() });
  await campaigns.cancel(w.sender, other.id);
  // Time passes.
  await db('CommunicationCampaign').whereIn('id', [campaign.id, other.id]).update({ scheduledAt: at(-0.001) });
  const [r1, r2] = await Promise.all([campaigns.releaseDue(), campaigns.releaseDue()]);
  assert.equal(r1.released + r2.released >= 1, true);
  assert.equal((await ledger(campaign.id)).length, 3, 'queued once even when released twice at the same time');
  assert.equal((await communicationCampaigns.findByIdAsync(campaign.id)).status, 'sending');
  assert.equal((await ledger(other.id)).length, 0);
  assert.equal((await communicationCampaigns.findByIdAsync(other.id)).status, 'cancelled');
  await deliverAll(campaign.id);
  assert.equal((await communicationCampaigns.findByIdAsync(campaign.id)).status, 'sent');
});

test('a scheduled campaign with nobody left to reach is marked failed, not sent', async () => {
  const { campaign } = await campaigns.create(w.sender, draft({ purpose: 'promotion', channels: ['in_app'], audience: { filter: { all: [{ field: 'daysUntilExpiry', op: 'gte', value: 1 }] } } }));
  await campaigns.schedule(w.sender, campaign.id, { scheduledAt: at(1).toISOString() });
  for (const m of [w.Amani, w.Bahati, w.Cheka]) await prefs.update(m, { inAppMarketing: false });
  await db('CommunicationCampaign').where({ id: campaign.id }).update({ scheduledAt: at(-0.001) });
  await campaigns.releaseDue();
  const c = await communicationCampaigns.findByIdAsync(campaign.id);
  assert.equal(c.status, 'failed');
  assert.equal(c.counts.skipped.in_app_marketing_off, 3);
  for (const m of [w.Amani, w.Bahati, w.Cheka]) await prefs.update(m, { inAppMarketing: true });
});

test('scheduling a large audience needs the same confirmation as sending now', async () => {
  const strict = createCampaignService({ db, campaigns: communicationCampaigns, gyms, segmentService: segments, auditLog: null, largeSendThreshold: 3 });
  const { campaign } = await strict.create(w.sender, draft({ channels: ['in_app'] }));
  const refused = await strict.schedule(w.sender, campaign.id, { scheduledAt: at(1).toISOString() });
  assert.deepEqual([refused.error, refused.count], ['confirm_large_send', 3]);
  const ok = await strict.schedule(w.sender, campaign.id, { scheduledAt: at(1).toISOString(), confirmLargeSend: true });
  assert.equal(ok.campaign.status, 'scheduled');
});

test('the dispatcher run records itself', async () => {
  const stats = await delivery.runOnce();
  assert.equal(typeof stats.claimed, 'number');
  const run = await db('JobRun').where({ job: 'communication_dispatcher' }).orderBy('startedAt', 'desc').first();
  assert.equal(run.status, 'ok');
  assert.ok(run.finishedAt);
});

// ── opens and taps ─────────────────────────────────────────────────────────

test('reading and tapping a message move its ledger rows forward', async () => {
  const id = await sendNew();
  await deliverAll(id);
  const n = (await notificationService.inbox({ userId: w.Amani })).notifications.find(x => x.campaignId === id);
  await notificationService.markRead({ userId: w.Amani, id: n.id });
  let rows = await ledger(id);
  const amani = (ch) => rows.find(r => r.memberId === w.Amani && r.channel === ch);
  assert.equal(amani('in_app').status, 'read');
  assert.ok(amani('in_app').openedAt);
  assert.equal(amani('push').status, 'sent', 'reading in the app says nothing about the push');

  await notificationService.markClicked({ userId: w.Amani, id: n.id, via: 'push' });
  rows = await ledger(id);
  assert.equal(amani('in_app').status, 'clicked');
  assert.equal(amani('push').status, 'clicked');
  assert.ok(amani('push').openedAt);
  assert.ok((await notifications.findByIdAsync(n.id)).clickedAt);

  assert.equal((await notificationService.markClicked({ userId: w.Bahati, id: n.id })).error, 'not_found', 'nobody can tap someone else\'s message');
});

test('opening a push that has no inbox copy is recorded', async () => {
  const id = await sendNew({ channels: ['push'] });
  await deliverAll(id);
  const push = (await ledger(id)).find(r => r.memberId === w.Bahati);
  assert.equal(push.status, 'sent');
  assert.deepEqual(await delivery.pushOpened({ userId: w.Bahati, messageId: push.id }), { ok: true });
  assert.equal((await db('CommunicationMessage').where({ id: push.id }).first()).status, 'read');
  assert.equal((await delivery.pushOpened({ userId: w.Amani, messageId: push.id })).error, 'not_found');
});

test('ordinary notifications keep working and are not tracked', async () => {
  const r = await notificationService.notify(w.Cheka, { type: 'subscription_renewal', title: 'Renews soon', body: 'x', data: { daysLeft: 3 } });
  assert.equal(r.ok, true);
  assert.deepEqual(await notificationService.markRead({ userId: w.Cheka, id: r.notification.id }), { ok: true });
  const all = await notificationService.markRead({ userId: w.Cheka, id: 'all' });
  assert.equal(all.ok, true);
  assert.equal((await notificationService.inbox({ userId: w.Cheka })).unread, 0);
});

// ── preferences ────────────────────────────────────────────────────────────

test('preferences: offers can be switched off, WhatsApp offers need consent, service messages can\'t be', async () => {
  const m = w.Cheka;
  const fresh = (await prefs.get(m)).preferences;
  assert.deepEqual([fresh.inAppMarketing, fresh.pushMarketing, fresh.whatsappMarketing], [true, true, false]);
  assert.deepEqual(fresh.alwaysOn, ['in_app_transactional', 'push_transactional']);
  assert.equal((await prefs.update(m, { inAppMarketing: 'no' })).error, 'invalid_preference');
  assert.equal((await prefs.update(m, { locale: 'fr' })).error, 'invalid_locale');
  const on = await prefs.update(m, { whatsappMarketing: true, locale: 'sw' });
  assert.equal(on.preferences.whatsappMarketing, true);
  const row = await communicationPreferences.findByIdAsync(m);
  assert.ok(row.whatsappMarketingConsentAt);
  assert.equal(row.whatsappMarketingConsentSource, 'app_settings');
  assert.equal(row.locale, 'sw');
  await prefs.update(m, { whatsappMarketing: false });
});
