// Communications M9 — lifecycle automations: the defaults every gym gets,
// when each trigger is due, sending exactly once per occurrence (reruns,
// overlaps, events plus the sweep), one automation message per member per
// day, the runaway guard, the events from payments and memberships, and the
// platform reminder stepping aside for a gym's own (D4).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import {
  communicationPreferences, deviceTokens, communicationTemplates, gyms, users, notifications, paymentRequests, subscriptions,
} from '../src/bootstrap/collections.mjs';
import { createSegmentService } from '../src/services/segment-service.mjs';
import { createTemplateService } from '../src/services/template-service.mjs';
import { createAutomationService, DEFAULT_AUTOMATIONS } from '../src/services/automation-service.mjs';
import { createDeliveryService } from '../src/services/delivery-service.mjs';
import { createNotificationService } from '../src/services/notification-service.mjs';
import { createAdminPaymentService } from '../src/services/admin-payment-service.mjs';
import { createWebhookService } from '../src/services/webhook-service.mjs';
import { addDays, localDay } from '../src/shared/member-progress.mjs';

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const days = (n) => new Date(Date.now() + n * 86_400_000);
const made = { users: [], gyms: [] };
const w = {};
const quiet = { warn() {}, error() {} };

const segments = createSegmentService({ db, communicationPreferences, deviceTokens, pushAvailable: () => false, whatsappAvailable: () => false });
const templates = createTemplateService({ db, templates: communicationTemplates, gyms });
const make = (opts = {}) => createAutomationService({ db, segmentService: segments, templateService: templates, sendHours: { from: 0, to: 24 }, logger: quiet, ...opts });
const automations = make();

async function user(fields) {
  const id = uid('usr');
  await db('User').insert({ id, userType: 'member', updatedAt: new Date(), ...fields });
  made.users.push(id);
  return id;
}
async function gym(name) {
  const id = uid('gym');
  await db('Gym').insert({ id, name, tier: 'standard', location: uid('Moshi'), updatedAt: new Date() });
  made.gyms.push(id);
  return id;
}
async function member(gymId, name, { expiresIn = 30, startedDaysAgo = 30, status = 'active', lastVisitDaysAgo = 1 } = {}) {
  const id = await user({ displayName: name });
  const sub = uid('sub');
  await db('Subscription').insert({
    id: sub, memberId: id, type: 'direct_sub', plan: 'monthly', status, homeGymId: gymId,
    startedAt: days(-startedDaysAgo), cycleStartedAt: days(-startedDaysAgo), renewsAt: days(expiresIn), expiresAt: days(expiresIn),
  });
  if (lastVisitDaysAgo != null) {
    await db('Checkin').insert({ id: uid('ci'), memberId: id, gymId, timestamp: days(-lastVisitDaysAgo), method: 'qr', subscriptionType: 'direct_sub', gymTier: 'standard', visitConsumed: true });
  }
  return { id, sub };
}
const auto = (gymId, key) => `aut_${gymId}_${key}`;
const enable = (gymId, keys, channels = ['in_app']) => db('CommunicationAutomation').where({ gymId }).whereIn('id', keys.map(k => auto(gymId, k))).update({ status: 'enabled', channels });
const runsOf = (gymId, memberId) => db('AutomationRun').where({ gymId, memberId }).orderBy('createdAt');
const messagesOf = (runId) => db('CommunicationMessage').where({ automationRunId: runId });
const clean = async (gymId) => {
  await db('CommunicationMessage').whereIn('automationRunId', db('AutomationRun').where({ gymId }).select('id')).del();
  await db('AutomationRun').where({ gymId }).del();
};

before(async () => {
  w.gym = await gym('Simba Gym');
  w.other = await gym('Tembo Gym');
  w.owner = await user({ userType: 'gym_operator', gymIds: [w.gym] });
  w.S = { senderType: 'gym', owner: { id: w.owner, gymIds: [w.gym] }, actorId: w.owner };
  w.O = { senderType: 'gym', owner: { id: uid('usr'), gymIds: [w.other] }, actorId: null };
  await automations.ensureDefaults(w.gym);
  await automations.ensureDefaults(w.other);
});

after(async () => {
  for (const g of made.gyms) await clean(g);
  if (made.gyms.length) {
    await db('CommunicationAutomation').whereIn('gymId', made.gyms).del();
    await db('Gym').whereIn('id', made.gyms).del();
  }
  if (made.users.length) await db('User').whereIn('id', made.users).del();
});

// ── defaults and settings ──────────────────────────────────────────────────

test('every gym gets the seven default automations, switched off, created once', async () => {
  await automations.ensureDefaults(w.gym); // again: nothing new
  const { automations: list } = await automations.list(w.S);
  assert.equal(list.length, DEFAULT_AUTOMATIONS.length);
  assert.ok(list.every(a => a.status === 'disabled' && a.gymId === w.gym));
  const by = Object.fromEntries(list.map(a => [`${a.trigger}:${a.offsetDays}`, a]));
  assert.deepEqual(
    Object.keys(by).sort(),
    ['member_inactive:14', 'membership_activated:0', 'membership_expired:0', 'membership_expiring:1', 'membership_expiring:3', 'membership_expiring:7', 'payment_failed:0'],
  );
  assert.equal(by['membership_expiring:7'].template.key, 'membership_expiring');
  assert.equal(by['membership_expiring:1'].template.key, 'membership_final_reminder');
  assert.equal(by['membership_activated:0'].template.key, 'welcome_member');
  assert.deepEqual(by['membership_activated:0'].conditions, { firstMembershipOnly: true });
  assert.deepEqual(by['membership_expiring:7'].channels, ['in_app', 'push', 'whatsapp']);
  assert.deepEqual(by['payment_failed:0'].stats, { fired: 0, skipped: 0, messages: 0, reached: 0, failed: 0, opened: 0 });
  assert.equal(list[0].trigger, 'payment_failed', 'most urgent first');
});

test('owners switch automations on and off, and change channels or template — only their own', async () => {
  const id = auto(w.gym, 'expiring_3');
  assert.equal((await automations.update(w.S, id, { status: 'enabled', channels: ['in_app', 'whatsapp'] })).automation.status, 'enabled');
  assert.equal((await automations.update(w.S, id, { status: 'paused' })).error, 'invalid_status', 'only the engine pauses');
  assert.equal((await automations.update(w.S, id, { channels: ['sms'] })).error, 'invalid_channels');
  assert.equal((await automations.update(w.S, id, { channels: [] })).error, 'invalid_channels');
  assert.equal((await automations.update(w.S, id, { templateId: 'tpl_sys_discount_offer' })).error, 'template_needs_values', 'offers need someone to type them');
  assert.equal((await automations.update(w.S, auto(w.gym, 'payment_failed'), { templateId: 'tpl_sys_payment_failed' })).automation.template.key, 'payment_failed', 'the payment amount is known');
  assert.equal((await automations.update(w.S, id, { templateId: 'tpl_sys_renewal_reminder' })).automation.template.key, 'renewal_reminder');
  assert.equal((await automations.update(w.O, id, { status: 'disabled' })).error, 'not_found', 'another gym\'s automation');
  assert.equal((await automations.get(w.O, id)).error, 'not_found');
  assert.equal((await automations.list(w.S, { gymId: w.other })).error, 'not_your_gym');
  await automations.update(w.S, id, { status: 'disabled', channels: ['in_app', 'push', 'whatsapp'] });
});

// ── when triggers are due ──────────────────────────────────────────────────

test('each trigger has a window, so one missed run doesn\'t lose a message — and nobody is messaged for something long past', async () => {
  const today = localDay(new Date());
  const f = (memberId, x) => ({ memberId, status: 'active', subscriptionStatus: 'active', ...x });
  const facts = [
    f('m7', { daysUntilExpiry: 7, expiresOn: addDays(today, 7), status: 'expiring_soon' }),
    f('m6', { daysUntilExpiry: 6, expiresOn: addDays(today, 6), status: 'expiring_soon' }),
    f('m5', { daysUntilExpiry: 5, expiresOn: addDays(today, 5), status: 'expiring_soon' }),
    f('m1', { daysUntilExpiry: 1, expiresOn: addDays(today, 1), status: 'expiring_soon' }),
    f('mCancelled', { daysUntilExpiry: 7, expiresOn: addDays(today, 7), status: 'expiring_soon', subscriptionStatus: 'cancelled' }),
    f('gone1', { status: 'expired', daysSinceExpiry: 1, expiresOn: addDays(today, -1) }),
    f('gone9', { status: 'expired', daysSinceExpiry: 9, expiresOn: addDays(today, -9) }),
    f('quiet14', { lastVisitDaysAgo: 14 }),
    f('quiet15', { lastVisitDaysAgo: 15 }),
    f('quiet90', { lastVisitDaysAgo: 90 }),
    f('never14', { lastVisitDaysAgo: null, joinedDaysAgo: 14 }),
    f('quietSuspended', { lastVisitDaysAgo: 14, status: 'suspended' }),
  ];
  const due = async (trigger, offsetDays) => (await automations.candidates({ trigger, offsetDays, gymId: w.gym }, facts, today, new Date()))
    .map(c => `${c.facts.memberId}|${c.occurrenceKey}`);
  assert.deepEqual(await due('membership_expiring', 7), [`m7|${addDays(today, 7)}:T-7`, `m6|${addDays(today, 6)}:T-7`], 'not m5, not a cancelled membership');
  assert.deepEqual(await due('membership_expiring', 1), [`m1|${addDays(today, 1)}:T-1`]);
  assert.deepEqual(await due('membership_expired', 0), [`gone1|${addDays(today, -1)}:expired`]);
  assert.deepEqual(await due('member_inactive', 14), [
    `quiet14|inactive:${addDays(today, -14)}`, `quiet15|inactive:${addDays(today, -15)}`, `never14|inactive:never:${addDays(today, -14)}`,
  ], 'just crossed 14 days — not someone gone for 90');
  assert.equal(make({ sendHours: { from: 8, to: 20 } }).inSendHours(new Date('2026-10-01T04:59:00Z')), false, '07:59 in Dar es Salaam');
  assert.equal(make({ sendHours: { from: 8, to: 20 } }).inSendHours(new Date('2026-10-01T05:00:00Z')), true, '08:00');
  assert.equal(make({ sendHours: { from: 8, to: 20 } }).inSendHours(new Date('2026-10-01T17:00:00Z')), false, '20:00');
});

// ── sending once ──────────────────────────────────────────────────────────

test('the hourly run sends each due reminder once, however often it runs', async () => {
  const g = await gym('Kilele Gym');
  await automations.ensureDefaults(g);
  const due7 = await member(g, 'Asha', { expiresIn: 6.5 });
  const later = await member(g, 'Baraka', { expiresIn: 20 });
  await enable(g, ['expiring_7']);
  const first = await automations.runDue({ gymIds: [g] });
  assert.equal(first.ran, true);
  assert.ok(first.fired >= 1);
  const again = await automations.runDue({ gymIds: [g] });
  assert.equal(again.fired, 0, 'a rerun sends nothing new');
  const runs = await runsOf(g, due7.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].occurrenceKey.endsWith(':T-7'), true);
  assert.equal(runs[0].subscriptionId, due7.sub);
  const [msg] = await messagesOf(runs[0].id);
  assert.deepEqual([msg.channel, msg.status, msg.category, msg.messageType, msg.gymId], ['in_app', 'queued', 'transactional', 'renewal', g]);
  assert.match(msg.title, /ends soon/);
  assert.match(msg.body, /^Hi Asha, your Monthly plan at Kilele Gym ends on/);
  assert.equal((await runsOf(g, later.id)).length, 0);

  // Two runs at once: one does the work, the other steps aside.
  await db('AutomationRun').where({ gymId: g }).del().catch(() => {});
  const [a, b] = await Promise.all([automations.runDue({ gymIds: [g] }), make().runDue({ gymIds: [g] })]);
  assert.equal([a.ran, b.ran].filter(Boolean).length >= 1, true);
  const after = await runsOf(g, due7.id);
  assert.equal(after.length, 1, 'still exactly one');
});

test('a member gets at most one automation message a day from a gym; the rest wait for a later run', async () => {
  const g = await gym('Mnazi Gym');
  await automations.ensureDefaults(g);
  // Ends in 1 day and hasn't visited for 14: two automations due.
  const m = await member(g, 'Chiku', { expiresIn: 0.6, lastVisitDaysAgo: 14 });
  await enable(g, ['expiring_1', 'inactive_14']);
  const r = await automations.runDue({ gymIds: [g] });
  assert.equal(r.deferred, 1);
  const runs = await runsOf(g, m.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].automationId, auto(g, 'expiring_1'), 'the most urgent one wins the day');
  // Tomorrow the inactivity message can go (its window is still open).
  await db('AutomationRun').where({ id: runs[0].id }).update({ createdAt: days(-1) });
  await automations.runDue({ gymIds: [g] });
  assert.deepEqual((await runsOf(g, m.id)).map(x => x.automationId).sort(), [auto(g, 'expiring_1'), auto(g, 'inactive_14')].sort());
});

test('an automation that would message too many members at once is paused, not sent', async () => {
  const g = await gym('Pwani Gym');
  await automations.ensureDefaults(g);
  await member(g, 'D1', { expiresIn: 2.5 });
  await member(g, 'D2', { expiresIn: 2.5 });
  await enable(g, ['expiring_3']);
  const r = await make({ maxPerRun: 1 }).runDue({ gymIds: [g] });
  assert.equal(r.paused, 1);
  const a = await db('CommunicationAutomation').where({ id: auto(g, 'expiring_3') }).first();
  assert.deepEqual([a.status, a.pausedReason], ['paused', 'too_many_members:2']);
  assert.equal((await db('AutomationRun').where({ gymId: g })).length, 0, 'nobody messaged');
  const owner = { senderType: 'gym', owner: { gymIds: [g] }, actorId: null };
  const back = await automations.update(owner, auto(g, 'expiring_3'), { status: 'enabled' });
  assert.deepEqual([back.automation.status, back.automation.pausedReason], ['enabled', null], 'turning it back on clears the pause');
});

test('outside 08:00–20:00 in Dar es Salaam, scheduled reminders wait', async () => {
  const g = await gym('Usiku Gym');
  await automations.ensureDefaults(g);
  await member(g, 'E1', { expiresIn: 6.5 });
  await enable(g, ['expiring_7']);
  const night = make({ now: () => new Date('2026-10-01T21:00:00Z'), sendHours: { from: 8, to: 20 } });
  const r = await night.runDue({ gymIds: [g] });
  assert.deepEqual([r.outsideSendHours, r.fired], [true, 0]);
});

// ── events ────────────────────────────────────────────────────────────────

test('a new member is welcomed once; a renewal is not a welcome', async () => {
  const g = await gym('Karibu Gym');
  await automations.ensureDefaults(g);
  await enable(g, ['welcome']);
  const m = await member(g, 'Fatma', { startedDaysAgo: 0 });
  const sub = await db('Subscription').where({ id: m.sub }).first();
  assert.equal((await automations.handleEvent({ type: 'membership_activated', subscription: sub })).fired, 1);
  assert.equal((await automations.handleEvent({ type: 'membership_activated', subscription: sub })).fired, 0, 'the same activation twice');
  const r = await automations.runDue({ gymIds: [g] });
  assert.equal(r.fired, 0, 'the sweep sees it was sent');
  const [run] = await runsOf(g, m.id);
  const [msg] = await messagesOf(run.id);
  assert.match(msg.title, /^Welcome to Karibu Gym/);

  // A renewal later on the same membership.
  const renewed = { ...sub, cycleStartedAt: days(0).toISOString(), startedAt: days(-40).toISOString() };
  assert.equal((await automations.handleEvent({ type: 'membership_activated', subscription: renewed })).fired, 0);
  // Not a gym membership, or a gym with the automation off: nothing.
  assert.equal((await automations.handleEvent({ type: 'membership_activated', subscription: { ...sub, type: 'platform_pass' } })).fired, 0);
  assert.equal((await automations.handleEvent({ type: 'bogus', subscription: sub })).fired, 0);
});

test('a rejected payment sends a recovery message with the amount — from the event or, if it was lost, the sweep', async () => {
  const g = await gym('Malipo Gym');
  await automations.ensureDefaults(g);
  await enable(g, ['payment_failed']);
  const m = await member(g, 'Gabriel', { status: 'payment_pending' });
  const pay = uid('pay');
  await db('PaymentRequest').insert({ id: pay, memberId: m.id, subscriptionId: m.sub, amountTzs: 50000, status: 'pending', provider: 'manual', requestedAt: new Date() });
  const fired = [];
  const admin = createAdminPaymentService({
    paymentRequests, subscriptions, users, auditLog: { insertAsync: async () => {} },
    onPaymentRejected: async (sub, request) => fired.push(await automations.handleEvent({ type: 'payment_failed', subscription: sub, paymentRequestId: request.id, amountTzs: request.amountTzs })),
  });
  await admin.decide({ id: pay, decision: 'reject', actorId: w.owner });
  assert.deepEqual(fired.map(f => f.fired), [1]);
  const [run] = await runsOf(g, m.id);
  assert.equal(run.occurrenceKey, `payment:${pay}`);
  assert.deepEqual(run.context, { amountTzs: 50000 });
  const [msg] = await messagesOf(run.id);
  assert.match(msg.body, /TZS 50,000/);
  assert.equal((await automations.runDue({ gymIds: [g] })).fired, 0, 'the sweep finds it already sent');

  // An event that never arrived: the sweep sends it.
  const m2 = await member(g, 'Halima', { status: 'payment_pending' });
  const pay2 = uid('pay');
  await db('PaymentRequest').insert({ id: pay2, memberId: m2.id, subscriptionId: m2.sub, amountTzs: 30000, status: 'rejected', provider: 'manual', requestedAt: new Date(), decidedAt: new Date() });
  await automations.runDue({ gymIds: [g] });
  const [run2] = await runsOf(g, m2.id);
  assert.equal(run2.occurrenceKey, `payment:${pay2}`);
});

test('Selcom: a paid membership raises the activation event, a failed payment the payment event', async () => {
  const seen = [];
  const webhookSeen = { findAsync: async () => null, insertAsync: async () => {} };
  const store = new Map([['sub_w1', { id: 'sub_w1', status: 'payment_pending', type: 'direct_sub' }], ['sub_w2', { id: 'sub_w2', status: 'payment_pending', type: 'direct_sub' }]]);
  const subs = { findByIdAsync: async (i) => store.get(i), updateByIdAsync: async (i, p) => ({ ...store.get(i), ...p }) };
  const hooks = createWebhookService({
    subscriptions: subs, webhookSeen,
    onSubscriptionActivated: async (s) => seen.push(['activated', s.id, s.status]),
    onPaymentFailed: async (s, paymentId) => seen.push(['failed', s.id, paymentId]),
  });
  await hooks.handleSelcom({ payment_id: 'p1', status: 'success', subscription_id: 'sub_w1' });
  await hooks.handleSelcom({ payment_id: 'p2', status: 'failed', subscription_id: 'sub_w2' });
  assert.deepEqual(seen, [['activated', 'sub_w1', 'active'], ['failed', 'sub_w2', 'p2']]);
});

// ── delivery and the platform reminder ────────────────────────────────────

test('the dispatcher delivers an automation message with its template\'s button and the gym\'s name', async () => {
  const g = await gym('Kitufe Gym');
  await automations.ensureDefaults(g);
  await enable(g, ['expiring_7']);
  const m = await member(g, 'Ivan', { expiresIn: 6.5 });
  await automations.runDue({ gymIds: [g] });
  const [run] = await runsOf(g, m.id);
  const [row] = await messagesOf(run.id);
  const notes = createNotificationService({ users, deviceTokens, notifications, logger: quiet });
  const delivery = createDeliveryService({ db, logger: quiet, campaignService: { releaseDue: async () => ({ released: 0 }) }, notificationService: notes });
  assert.equal(await delivery.deliver({ ...row, attempts: 1 }), 'sent');
  const inbox = await db('Notification').where({ userId: m.id }).first();
  const data = typeof inbox.data === 'string' ? JSON.parse(inbox.data) : inbox.data;
  assert.equal(inbox.type, 'automation');
  assert.deepEqual([data.ctaLabel, data.senderName, data.campaignId], ['Renew now', 'Kitufe Gym', '']);
});

test('a gym\'s own expiry reminders replace the platform one (D4), and the platform one is sent once', async () => {
  const g = await gym('Zamu Gym');
  await automations.ensureDefaults(g);
  assert.ok(!(await automations.gymsWithReminders()).has(g));
  await enable(g, ['expiring_3']);
  assert.ok((await automations.gymsWithReminders()).has(g));

  const m = await user({ displayName: 'Juma' });
  let pushes = 0;
  const fcm = { async sendEachForMulticast({ tokens }) { pushes += 1; return { successCount: tokens.length, failureCount: 0, responses: tokens.map(() => ({ success: true, messageId: 'x' })) }; } };
  await db('DeviceToken').insert({ id: uid('dvt'), userId: m, token: uid('tok'), platform: 'android' });
  const notes = createNotificationService({ users, deviceTokens, notifications, logger: quiet, getMessaging: () => fcm });
  const sub = { id: uid('sub'), memberId: m, tier: 'basic', renewsAt: days(3).toISOString() };
  const first = await notes.notifyRenewal(sub, 3);
  const second = await notes.notifyRenewal(sub, 3);
  assert.equal(first.duplicate, undefined);
  assert.equal(second.duplicate, true, 'a rerun of the job finds it already sent');
  assert.equal(pushes, 1);
  assert.equal((await db('Notification').where({ userId: m, type: 'subscription_renewal' })).length, 1);
});
