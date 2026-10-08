// Communications M8 — history: campaign history with delivery numbers,
// who a campaign went to, a member's communication timeline, the filterable
// message log and one message in full — all read from the ledger, and a gym
// only ever sees what its own gyms sent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { communicationCampaigns, gyms, users, deviceTokens, notifications } from '../src/bootstrap/collections.mjs';
import { createCommunicationHistoryService, parseFilters, outcomeOf } from '../src/services/communication-history-service.mjs';
import { createCampaignService } from '../src/services/campaign-service.mjs';
import { createNotificationService } from '../src/services/notification-service.mjs';
import { createDeliveryService } from '../src/services/delivery-service.mjs';
import { memberManagement } from '../src/bootstrap/services.mjs';

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const ago = (hours) => new Date(Date.now() - hours * 3_600_000);
const made = { users: [], gyms: [], campaigns: [] };
const w = {};
const quiet = { warn() {}, error() {} };

const history = createCommunicationHistoryService({ db });
const campaigns = createCampaignService({ db, campaigns: communicationCampaigns, gyms, segmentService: null, auditLog: null, historyService: history });

async function user(fields) {
  const id = uid('usr');
  await db('User').insert({ id, userType: 'member', updatedAt: new Date(), ...fields });
  made.users.push(id);
  return id;
}
async function gym(name) {
  const id = uid('gym');
  await db('Gym').insert({ id, name, tier: 'standard', location: uid('Arusha'), updatedAt: new Date() });
  made.gyms.push(id);
  return id;
}
async function campaign(fields) {
  const id = uid('cmp');
  await db('CommunicationCampaign').insert({
    id, senderType: 'gym', name: 'x', purpose: 'renewal', category: 'transactional', status: 'sent',
    channels: ['in_app'], content: { title: 'T', body: 'B' }, audience: { preset: 'active' }, createdAt: ago(1), updatedAt: new Date(), ...fields,
  });
  made.campaigns.push(id);
  return id;
}
async function msg(fields) {
  const id = uid('cmm');
  await db('CommunicationMessage').insert({
    id, senderType: 'gym', category: 'transactional', messageType: 'renewal', title: 'T', body: 'B',
    status: 'queued', attempts: 0, createdAt: ago(1), updatedAt: new Date(), ...fields,
  });
  return id;
}
const ids = (xs) => xs.map(x => x.id);

before(async () => {
  w.gymA = await gym('Simba Gym');
  w.gymA2 = await gym('Simba Annex');
  w.gymB = await gym('Tembo Gym');
  w.ownerA = await user({ userType: 'gym_operator', displayName: 'Owner Asha', gymIds: [w.gymA, w.gymA2] });
  w.ownerB = await user({ userType: 'gym_operator', displayName: 'Owner Bakari', gymIds: [w.gymB] });
  w.A = { senderType: 'gym', owner: { id: w.ownerA, gymIds: [w.gymA, w.gymA2] }, actorId: w.ownerA };
  w.B = { senderType: 'gym', owner: { id: w.ownerB, gymIds: [w.gymB] }, actorId: w.ownerB };
  w.FF = { senderType: 'platform', actorId: null };

  w.neema = await user({ displayName: 'Neema Mushi', phone: '0712000001' });
  w.juma = await user({ displayName: 'Juma Said', phone: '0712000002' });
  w.quiet = await user({ displayName: 'Quiet Member' });
  w.stranger = await user({ displayName: 'Stranger' });
  for (const [m, g] of [[w.neema, w.gymA], [w.juma, w.gymA], [w.quiet, w.gymA]]) {
    await db('Subscription').insert({ id: uid('sub'), memberId: m, type: 'direct_sub', plan: 'monthly', status: 'active', homeGymId: g, startedAt: ago(500), cycleStartedAt: ago(500), renewsAt: ago(-100), expiresAt: ago(-100) });
  }
  // Neema also visits Tembo Gym, which messages her too.
  await db('Checkin').insert({ id: uid('ci'), memberId: w.neema, gymId: w.gymB, timestamp: ago(30), method: 'qr', subscriptionType: 'fitflex_pass', gymTier: 'standard', visitConsumed: true });

  w.ntf = uid('ntf');
  await db('Notification').insert({ id: w.ntf, userId: w.neema, type: 'campaign', title: 'T', body: 'B', createdAt: ago(3) });
  // Simba's renewal reminder: Neema on three channels, Juma on two.
  w.cRenew = await campaign({ gymId: w.gymA, name: 'October renewals', channels: ['in_app', 'push', 'whatsapp'], createdBy: w.ownerA, createdAt: ago(3), sentAt: ago(3) });
  w.nInApp = await msg({ campaignId: w.cRenew, gymId: w.gymA, memberId: w.neema, channel: 'in_app', status: 'clicked', notificationId: w.ntf, sentAt: ago(3), deliveredAt: ago(3), openedAt: ago(2), clickedAt: ago(2), createdAt: ago(3) });
  w.nPush = await msg({ campaignId: w.cRenew, gymId: w.gymA, memberId: w.neema, channel: 'push', status: 'sent', providerMessageId: 'projects/fitflex/messages/0:111', payload: { fcm: { messageIds: ['projects/fitflex/messages/0:111', 'projects/fitflex/messages/0:112'], failed: 0, errors: [] } }, sentAt: ago(3), createdAt: ago(3) });
  w.nWa = await msg({ campaignId: w.cRenew, gymId: w.gymA, memberId: w.neema, channel: 'whatsapp', status: 'failed', failureReason: 'invalid_recipient', failurePermanent: true, failedAt: ago(3), attempts: 1, payload: { templateName: 'fitflex_renewal_reminder', language: 'sw', parameters: ['Neema Mushi', 'Simba Gym'] }, createdAt: ago(3) });
  w.jInApp = await msg({ campaignId: w.cRenew, gymId: w.gymA, memberId: w.juma, channel: 'in_app', status: 'queued', createdAt: ago(3) });
  w.jPush = await msg({ campaignId: w.cRenew, gymId: w.gymA, memberId: w.juma, channel: 'push', status: 'skipped', skipReason: 'no_device', createdAt: ago(3) });
  // An older Simba promotion from the annex, read by Neema.
  w.cPromo = await campaign({ gymId: w.gymA2, name: 'Ramadan offer', purpose: 'promotion', category: 'marketing', channels: ['in_app'], createdBy: w.ownerA, createdAt: ago(48), sentAt: ago(48) });
  w.pInApp = await msg({ campaignId: w.cPromo, gymId: w.gymA2, memberId: w.neema, channel: 'in_app', category: 'marketing', messageType: 'promotion', status: 'read', sentAt: ago(48), deliveredAt: ago(48), openedAt: ago(40), createdAt: ago(48) });
  // Tembo's message to Neema, and FitFlex's.
  w.cTembo = await campaign({ gymId: w.gymB, name: 'Tembo news', purpose: 'announcement', channels: ['in_app'], createdBy: w.ownerB, createdAt: ago(5) });
  w.tInApp = await msg({ campaignId: w.cTembo, gymId: w.gymB, memberId: w.neema, channel: 'in_app', messageType: 'announcement', status: 'delivered', createdAt: ago(5) });
  w.cFitFlex = await campaign({ senderType: 'platform', gymId: null, name: 'FitFlex update', purpose: 'announcement', createdAt: ago(6) });
  w.fInApp = await msg({ campaignId: w.cFitFlex, senderType: 'platform', gymId: null, memberId: w.neema, channel: 'in_app', messageType: 'announcement', status: 'delivered', createdAt: ago(6) });
  // A draft that never went out.
  w.cDraft = await campaign({ gymId: w.gymA, name: 'Draft idea', status: 'draft', createdBy: w.ownerA, createdAt: ago(0.5) });
});

after(async () => {
  if (made.campaigns.length) {
    await db('CommunicationMessage').whereIn('campaignId', made.campaigns).del();
    await db('CommunicationCampaign').whereIn('id', made.campaigns).del();
  }
  if (made.gyms.length) await db('Gym').whereIn('id', made.gyms).del();
  if (made.users.length) await db('User').whereIn('id', made.users).del();
});

// ── rules ─────────────────────────────────────────────────────────────────

test('filters are checked, and outcomes summarise every channel of a message', () => {
  assert.equal(parseFilters({ channel: 'fax' }).detail, 'channel');
  assert.equal(parseFilters({ status: 'lost' }).detail, 'status');
  assert.equal(parseFilters({ messageType: 'spam' }).detail, 'messageType');
  assert.equal(parseFilters({ from: 'yesterday' }).detail, 'from');
  assert.equal(parseFilters({ cursor: '%%%' }).detail, 'cursor');
  assert.equal(parseFilters({ limit: '0' }).detail, 'limit');
  assert.equal(parseFilters({ limit: '5000' }).filters.limit, 100);
  const f = parseFilters({ channel: 'push,whatsapp', status: 'failed,pending', to: '2026-09-01' }).filters;
  assert.deepEqual(f.channel, ['push', 'whatsapp']);
  assert.equal(f.to.toISOString(), '2026-09-01T23:59:59.999Z', 'a date alone means the whole day');
  assert.equal(outcomeOf(['failed', 'sent', 'skipped']), 'reached');
  assert.equal(outcomeOf(['failed', 'queued']), 'pending');
  assert.equal(outcomeOf(['failed', 'skipped']), 'failed');
  assert.equal(outcomeOf(['skipped']), 'skipped');
});

// ── campaign history ──────────────────────────────────────────────────────

test('campaign history: only the gym\'s own campaigns, with who created them and live delivery numbers', async () => {
  const r = await campaigns.list(w.A, {});
  const mine = r.campaigns.filter(c => made.campaigns.includes(c.id));
  assert.deepEqual(ids(mine), [w.cDraft, w.cRenew, w.cPromo], 'newest first, across both of Simba\'s gyms');
  const renew = mine.find(c => c.id === w.cRenew);
  assert.equal(renew.createdByName, 'Owner Asha');
  assert.deepEqual(renew.stats.totals, { pending: 1, sent: 2, delivered: 1, opened: 1, clicked: 1, failed: 1, skipped: 1 });
  assert.equal(renew.stats.targeted, 2);
  assert.equal(renew.stats.messages, 5);
  assert.deepEqual([renew.stats.byChannel.whatsapp.failed, renew.stats.byChannel.push.skipped, renew.stats.byChannel.in_app.clicked], [1, 1, 1]);
  assert.equal(mine.find(c => c.id === w.cDraft).stats.messages, 0, 'a draft has no messages yet');
  assert.ok(!r.campaigns.some(c => c.id === w.cTembo || c.id === w.cFitFlex));
  assert.equal((await campaigns.list(w.A, { gymId: w.gymB })).error, 'not_your_gym');
  assert.deepEqual(ids((await campaigns.list(w.FF, {})).campaigns.filter(c => made.campaigns.includes(c.id))), [w.cFitFlex]);
});

test('campaign history filters and pages', async () => {
  const only = async (filters) => ids((await campaigns.list(w.A, filters)).campaigns).filter(id => made.campaigns.includes(id));
  assert.deepEqual(await only({ purpose: 'promotion' }), [w.cPromo]);
  assert.deepEqual(await only({ channel: 'whatsapp' }), [w.cRenew]);
  assert.deepEqual(await only({ status: 'draft' }), [w.cDraft]);
  assert.deepEqual(await only({ status: 'sent,draft', gymId: w.gymA2 }), [w.cPromo]);
  assert.deepEqual(await only({ search: 'octob' }), [w.cRenew]);
  assert.deepEqual(await only({ from: ago(10).toISOString() }), [w.cDraft, w.cRenew]);
  assert.deepEqual(await only({ to: ago(10).toISOString() }), [w.cPromo]);
  assert.equal((await campaigns.list(w.A, { purpose: 'spam' })).error, 'invalid_filter');
  // Page through one at a time: every campaign once, in order.
  const seen = [];
  let cursor = null;
  do {
    const page = await campaigns.list(w.A, { limit: 1, cursor, gymId: null });
    seen.push(...ids(page.campaigns));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen.filter(id => made.campaigns.includes(id)), [w.cDraft, w.cRenew, w.cPromo]);
  assert.equal(new Set(seen).size, seen.length, 'no campaign twice');
});

test('one campaign: numbers, creator and progress; another gym\'s is not found', async () => {
  const r = await campaigns.get(w.A, w.cRenew);
  assert.equal(r.campaign.createdByName, 'Owner Asha');
  assert.equal(r.stats.totals.failed, 1);
  assert.deepEqual(r.progress.push, { sent: 1, skipped: 1 });
  assert.equal((await campaigns.get(w.B, w.cRenew)).error, 'not_found');
});

// ── recipients ────────────────────────────────────────────────────────────

test('recipients: one row per member with every channel, filterable and paged', async () => {
  const r = await history.recipients(w.A, w.cRenew, {});
  assert.deepEqual(r.recipients.map(x => [x.memberName, x.outcome, x.channels.map(c => `${c.channel}:${c.status}`)]), [
    ['Juma Said', 'pending', ['in_app:queued', 'push:skipped']],
    ['Neema Mushi', 'reached', ['in_app:clicked', 'push:sent', 'whatsapp:failed']],
  ]);
  const failed = await history.recipients(w.A, w.cRenew, { status: 'failed' });
  assert.deepEqual(failed.recipients.map(x => [x.memberName, x.channels.map(c => c.channel)]), [['Neema Mushi', ['whatsapp']]]);
  assert.equal(failed.recipients[0].channels[0].failureReason, 'invalid_recipient');
  assert.deepEqual((await history.recipients(w.A, w.cRenew, { search: 'jum' })).recipients.map(x => x.memberId), [w.juma]);
  const first = await history.recipients(w.A, w.cRenew, { limit: 1 });
  const second = await history.recipients(w.A, w.cRenew, { limit: 1, cursor: first.nextCursor });
  assert.deepEqual([first.recipients[0].memberId, second.recipients[0].memberId, second.nextCursor], [w.juma, w.neema, null]);
  assert.equal((await history.recipients(w.B, w.cRenew, {})).error, 'not_found');
  assert.equal((await history.recipients(w.FF, w.cRenew, {})).error, 'not_found');
  assert.deepEqual((await history.recipients(w.A, w.cDraft, {})).recipients, [], 'a draft has nobody yet');
});

// ── member timeline ───────────────────────────────────────────────────────

test('a member\'s timeline shows only this gym\'s messages, each with its channels side by side', async () => {
  const r = await history.memberTimeline(w.A, w.neema, {});
  assert.deepEqual(r.items.map(i => i.campaignId), [w.cRenew, w.cPromo], 'newest first; not Tembo\'s, not FitFlex\'s');
  const renew = r.items[0];
  assert.deepEqual([renew.campaignName, renew.messageType, renew.category, renew.outcome], ['October renewals', 'renewal', 'transactional', 'reached']);
  assert.deepEqual(renew.channels.map(c => c.channel), ['in_app', 'push', 'whatsapp']);
  const wa = renew.channels[2];
  assert.deepEqual([wa.status, wa.failureReason, wa.provider.name, wa.provider.templateName], ['failed', 'invalid_recipient', 'whatsapp', 'fitflex_renewal_reminder']);
  assert.ok(wa.failedAt);
  assert.equal(wa.provider.parameters, undefined, 'member values only in the full message view');
  const push = renew.channels[1];
  assert.deepEqual([push.provider.name, push.provider.messageId, push.provider.devices], ['fcm', 'projects/fitflex/messages/0:111', 2]);
  assert.ok(renew.channels[0].openedAt && renew.channels[0].clickedAt);

  const tembo = await history.memberTimeline(w.B, w.neema, {});
  assert.deepEqual(tembo.items.map(i => i.campaignId), [w.cTembo], 'Tembo sees only its own message to her');
  const fitflex = await history.memberTimeline(w.FF, w.neema, {});
  assert.deepEqual(fitflex.items.map(i => i.campaignId), [w.cFitFlex]);
});

test('timeline filters, paging, empty history and members the gym doesn\'t know', async () => {
  const only = async (q) => (await history.memberTimeline(w.A, w.neema, q)).items.map(i => [i.campaignId, i.channels.map(c => c.channel)]);
  assert.deepEqual(await only({ channel: 'whatsapp' }), [[w.cRenew, ['whatsapp']]]);
  assert.deepEqual(await only({ status: 'failed' }), [[w.cRenew, ['whatsapp']]]);
  assert.deepEqual(await only({ status: 'opened' }), [[w.cRenew, ['in_app']], [w.cPromo, ['in_app']]]);
  assert.deepEqual(await only({ category: 'marketing' }), [[w.cPromo, ['in_app']]]);
  assert.deepEqual(await only({ messageType: 'renewal' }), [[w.cRenew, ['in_app', 'push', 'whatsapp']]]);
  assert.deepEqual(await only({ from: ago(24).toISOString() }), [[w.cRenew, ['in_app', 'push', 'whatsapp']]]);
  assert.deepEqual(await only({ gymId: w.gymA2 }), [[w.cPromo, ['in_app']]]);
  const p1 = await history.memberTimeline(w.A, w.neema, { limit: 1 });
  const p2 = await history.memberTimeline(w.A, w.neema, { limit: 1, cursor: p1.nextCursor });
  assert.deepEqual([p1.items[0].campaignId, p2.items[0].campaignId, p2.nextCursor], [w.cRenew, w.cPromo, null]);

  assert.deepEqual(await history.memberTimeline(w.A, w.quiet, {}), { memberId: w.quiet, items: [], nextCursor: null }, 'a member with no messages yet');
  assert.equal((await history.memberTimeline(w.A, w.stranger, {})).error, 'not_your_member');
  assert.equal((await history.memberTimeline(w.B, w.juma, {})).error, 'not_your_member', 'another gym\'s member');
  assert.equal((await history.memberTimeline(w.A, w.neema, { gymId: w.gymB })).error, 'not_your_gym');
});

// ── the message log and one message ───────────────────────────────────────

test('the message log: newest first, every filter, paged, and scoped to the gym', async () => {
  const log = async (q, s = w.A) => (await history.messages(s, { limit: 100, ...q })).messages.map(m => m.id);
  const all = await log({});
  assert.ok([w.nInApp, w.nPush, w.nWa, w.jInApp, w.jPush, w.pInApp].every(id => all.includes(id)));
  assert.ok(!all.includes(w.tInApp) && !all.includes(w.fInApp), 'no other gym\'s or FitFlex\'s messages');
  assert.equal(all.indexOf(w.pInApp) > all.indexOf(w.nInApp), true);
  assert.deepEqual((await log({ memberId: w.juma })).sort(), [w.jInApp, w.jPush].sort());
  assert.deepEqual(await log({ campaignId: w.cPromo }), [w.pInApp]);
  assert.deepEqual(await log({ campaignId: w.cRenew, channel: 'push' }).then(x => x.sort()), [w.nPush, w.jPush].sort());
  assert.deepEqual(await log({ campaignId: w.cRenew, status: 'failed' }), [w.nWa]);
  assert.deepEqual(await log({ campaignId: w.cRenew, status: 'pending' }), [w.jInApp]);
  assert.deepEqual((await log({ campaignId: w.cRenew, status: 'reached' })).sort(), [w.nInApp, w.nPush].sort());
  assert.deepEqual(await log({ campaignId: w.cRenew, status: 'skipped' }), [w.jPush]);
  assert.deepEqual(await log({ category: 'marketing', memberId: w.neema }), [w.pInApp]);
  assert.deepEqual(await log({ search: 'juma', campaignId: w.cRenew }).then(x => x.sort()), [w.jInApp, w.jPush].sort());
  assert.deepEqual(await log({ memberId: w.neema, to: ago(24).toISOString() }), [w.pInApp]);
  assert.deepEqual(await log({ campaignId: w.cTembo }), [], 'another gym\'s campaign: nothing');
  assert.deepEqual(await log({ memberId: w.neema }, w.FF), [w.fInApp]);

  const walked = [];
  let cursor = null;
  do {
    const page = await history.messages(w.A, { campaignId: w.cRenew, limit: 2, cursor });
    walked.push(...page.messages.map(m => m.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(walked.sort(), [w.nInApp, w.nPush, w.nWa, w.jInApp, w.jPush].sort(), 'every message once');
  assert.equal((await history.messages(w.A, { gymId: w.gymB })).error, 'not_your_gym');
});

test('one message in full keeps campaign, template, rendered text, provider reference and failure', async () => {
  const { message: m } = await history.message(w.A, w.nWa);
  assert.deepEqual([m.campaign.name, m.memberName, m.channel, m.status, m.failureReason, m.failurePermanent, m.attempts],
    ['October renewals', 'Neema Mushi', 'whatsapp', 'failed', 'invalid_recipient', true, 1]);
  assert.deepEqual(m.provider, { name: 'whatsapp', messageId: null, templateName: 'fitflex_renewal_reminder', language: 'sw', parameters: ['Neema Mushi', 'Simba Gym'] });
  assert.ok(m.failedAt && m.createdAt);
  assert.equal(m.template, null, 'this campaign wasn\'t started from a template');
  const push = (await history.message(w.A, w.nPush)).message;
  assert.deepEqual([push.provider.messageId, push.provider.devices, push.provider.failedDevices], ['projects/fitflex/messages/0:111', 2, 0]);
  const inApp = (await history.message(w.A, w.nInApp)).message;
  assert.deepEqual([inApp.provider.name, inApp.notificationId], ['inbox', w.ntf]);
  assert.equal((await history.message(w.B, w.nWa)).error, 'not_found');
  assert.equal((await history.message(w.FF, w.nWa)).error, 'not_found');
  assert.equal((await history.message(w.A, w.tInApp)).error, 'not_found');
});

test('summary: the counts M10 analytics builds on', async () => {
  const s = await history.summary(w.A, { campaignId: w.cRenew });
  assert.deepEqual(s.totals, { pending: 1, sent: 2, delivered: 1, opened: 1, clicked: 1, failed: 1, skipped: 1 });
  assert.equal(s.messages, 5);
  assert.equal(s.byDay.reduce((n, d) => n + d.messages, 0), 5);
  assert.equal((await history.summary(w.B, { campaignId: w.cRenew })).messages, 0);
});

// ── provider references from real delivery ────────────────────────────────

test('a delivered push keeps FCM\'s message ids; a refused one keeps FCM\'s error codes', async () => {
  const token = uid('tok');
  await db('DeviceToken').insert({ id: uid('dvt'), userId: w.juma, token, platform: 'android' });
  let ok = true;
  const fcm = {
    async sendEachForMulticast({ tokens }) {
      return {
        successCount: ok ? tokens.length : 0, failureCount: ok ? 0 : tokens.length,
        responses: tokens.map((_, i) => (ok ? { success: true, messageId: `projects/fitflex/messages/0:9${i}` } : { success: false, error: { code: 'messaging/internal-error' } })),
      };
    },
  };
  const notificationService = createNotificationService({ users, deviceTokens, notifications, logger: quiet, getMessaging: () => fcm });
  const delivery = createDeliveryService({ db, notificationService, campaignService: campaigns, logger: quiet });
  const c1 = await campaign({ gymId: w.gymA, channels: ['push'] });
  const c2 = await campaign({ gymId: w.gymA, channels: ['push'] });
  const sent = await msg({ campaignId: c1, gymId: w.gymA, memberId: w.juma, channel: 'push', status: 'sending', attempts: 1, createdAt: ago(0.1) });
  assert.equal(await delivery.deliver(await db('CommunicationMessage').where({ id: sent }).first()), 'sent');
  const m1 = (await history.message(w.A, sent)).message;
  assert.deepEqual([m1.status, m1.provider.messageId, m1.provider.devices], ['sent', 'projects/fitflex/messages/0:90', 1]);

  ok = false;
  const refused = await msg({ campaignId: c2, gymId: w.gymA, memberId: w.juma, channel: 'push', status: 'sending', attempts: 4, createdAt: ago(0.1) });
  assert.equal(await delivery.deliver(await db('CommunicationMessage').where({ id: refused }).first()), 'failed');
  const m2 = (await history.message(w.A, refused)).message;
  assert.deepEqual([m2.status, m2.failureReason, m2.provider.errors], ['failed', 'push_failed', ['messaging/internal-error']]);
  assert.ok(m2.failedAt, 'a failure is kept, with its time');
  await db('DeviceToken').where({ token }).del();
});

// ── audit S1: payments ────────────────────────────────────────────────────

test('an owner sees a member\'s payments to their own gyms only (audit S1)', async () => {
  const sub = await db('Subscription').where({ memberId: w.neema, homeGymId: w.gymA }).first('id');
  const pass = uid('sub');
  await db('Subscription').insert({ id: pass, memberId: w.neema, type: 'fitflex_pass', tier: 'basic', plan: 'monthly', status: 'active', startedAt: ago(10), cycleStartedAt: ago(10), renewsAt: ago(-500), expiresAt: ago(-500) });
  const mine = uid('pay');
  await db('PaymentRequest').insert([
    { id: mine, memberId: w.neema, subscriptionId: sub.id, gymId: w.gymA, amountTzs: 50000, status: 'approved', provider: 'cash', requestedAt: ago(20) },
    { id: uid('pay'), memberId: w.neema, subscriptionId: pass, gymId: null, amountTzs: 60000, status: 'approved', provider: 'selcom', requestedAt: ago(10) },
    { id: uid('pay'), memberId: w.neema, subscriptionId: null, gymId: w.gymA, plan: 'trainer_session', amountTzs: 20000, status: 'approved', provider: 'selcom', requestedAt: ago(5) },
  ]);
  const owner = { ...(await db('User').where({ id: w.ownerA }).first()), gymIds: [w.gymA, w.gymA2] };
  const detail = await memberManagement.getMemberDetail({ owner, memberId: w.neema });
  assert.deepEqual(detail.detail.paymentHistory.map(p => p.id), [mine], 'not her FitFlex pass, not a trainer\'s session');
  const page = await memberManagement.listMemberPayments({ owner, memberId: w.neema, query: {} });
  assert.deepEqual(page.items.map(p => p.id), [mine]);
  await db('PaymentRequest').where({ memberId: w.neema }).del();
  await db('Subscription').where({ id: pass }).del();
});
