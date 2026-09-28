// Communications M10 — analytics: delivery, engagement (opened, tapped,
// CTA completed) and business results (renewed, paid, attributed revenue)
// for a campaign, an automation and the overview. Attribution is last touch:
// a tap in the 7 days before paying, else an open in the 3 days before.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { createCommunicationAnalyticsService, ATTRIBUTION } from '../src/services/communication-analytics-service.mjs';

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const ago = (days) => new Date(Date.now() - days * 86_400_000);
const made = { users: [], gyms: [], campaigns: [], automations: [] };
const w = {};
const analytics = createCommunicationAnalyticsService({ db });

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
async function sub(memberId, gymId, { type = 'direct_sub', startedDaysAgo = 60 } = {}) {
  const id = uid('sub');
  await db('Subscription').insert({
    id, memberId, type, plan: 'monthly', status: 'active', homeGymId: gymId,
    startedAt: ago(startedDaysAgo), cycleStartedAt: ago(startedDaysAgo), renewsAt: ago(-5), expiresAt: ago(-5),
  });
  return id;
}
async function pay(memberId, subscriptionId, amountTzs, paidDaysAgo, status = 'approved') {
  await db('PaymentRequest').insert({ id: uid('pay'), memberId, subscriptionId, amountTzs, status, provider: 'admin_manual', requestedAt: ago(paidDaysAgo), decidedAt: status === 'approved' ? ago(paidDaysAgo) : null });
}
async function campaign(gymId, name, fields = {}) {
  const id = uid('cmp');
  await db('CommunicationCampaign').insert({
    id, senderType: gymId ? 'gym' : 'platform', gymId, name, purpose: 'renewal', category: 'transactional', status: 'sent',
    channels: ['in_app', 'push'], content: { title: 'T', body: 'B' }, createdAt: ago(10), updatedAt: new Date(), ...fields,
  });
  made.campaigns.push(id);
  return id;
}
async function msg(campaignId, gymId, memberId, channel, fields = {}) {
  await db('CommunicationMessage').insert({
    id: uid('cmm'), campaignId, senderType: gymId ? 'gym' : 'platform', gymId, memberId, channel,
    category: 'transactional', messageType: 'renewal', title: 'T', body: 'B', deepLink: 'renewal',
    status: 'sent', attempts: 1, createdAt: ago(10), updatedAt: new Date(), ...fields,
  });
}
const reached = (at, extra = {}) => ({ status: 'delivered', sentAt: ago(at), deliveredAt: ago(at), ...extra });

before(async () => {
  w.gym = await gym('Simba Gym');
  w.otherGym = await gym('Tembo Gym');
  w.S = { senderType: 'gym', owner: { gymIds: [w.gym] } };
  w.T = { senderType: 'gym', owner: { gymIds: [w.otherGym] } };
  w.FF = { senderType: 'platform' };
  w.september = await campaign(w.gym, 'September renewals');
  w.october = await campaign(w.gym, 'October offer');
  w.gymVisit = await campaign(w.gym, 'Come back', { purpose: 'engagement', category: 'marketing' });

  // Asha taps the renewal button, renews 2 days later: renewed, CTA done.
  w.asha = await user({ displayName: 'Asha' });
  const ashaSub = await sub(w.asha, w.gym);
  await msg(w.september, w.gym, w.asha, 'in_app', reached(9, { status: 'clicked', openedAt: ago(9), clickedAt: ago(9) }));
  await msg(w.september, w.gym, w.asha, 'push', { status: 'sent', sentAt: ago(9) });
  await pay(w.asha, ashaSub, 50000, 7);
  // Baraka only opens it, and pays the next day: credited through the open.
  w.baraka = await user({ displayName: 'Baraka' });
  const barakaSub = await sub(w.baraka, w.gym);
  await msg(w.september, w.gym, w.baraka, 'in_app', reached(9, { status: 'read', openedAt: ago(9) }));
  await pay(w.baraka, barakaSub, 30000, 8);
  // Chiku opens it but pays 5 days later: outside the 3-day open window.
  w.chiku = await user({ displayName: 'Chiku' });
  const chikuSub = await sub(w.chiku, w.gym);
  await msg(w.september, w.gym, w.chiku, 'in_app', reached(9, { status: 'read', openedAt: ago(9) }));
  await pay(w.chiku, chikuSub, 40000, 4);
  // Daudi taps September, then taps October, then pays: October's (last touch).
  w.daudi = await user({ displayName: 'Daudi' });
  const daudiSub = await sub(w.daudi, w.gym);
  await msg(w.september, w.gym, w.daudi, 'in_app', reached(9, { status: 'clicked', openedAt: ago(9), clickedAt: ago(9) }));
  await msg(w.october, w.gym, w.daudi, 'in_app', reached(6, { status: 'clicked', openedAt: ago(6), clickedAt: ago(6) }));
  await pay(w.daudi, daudiSub, 60000, 5);
  // Esther: push failed, WhatsApp skipped — never reached.
  w.esther = await user({ displayName: 'Esther' });
  await sub(w.esther, w.gym);
  await msg(w.september, w.gym, w.esther, 'push', { status: 'failed', failureReason: 'push_failed', failedAt: ago(9) });
  await msg(w.september, w.gym, w.esther, 'whatsapp', { status: 'skipped', skipReason: 'no_phone' });
  // Faraja taps, then pays — at another gym, and a payment still pending.
  w.faraja = await user({ displayName: 'Faraja' });
  await sub(w.faraja, w.gym);
  const farajaElsewhere = await sub(w.faraja, w.otherGym);
  await msg(w.september, w.gym, w.faraja, 'in_app', reached(9, { status: 'clicked', openedAt: ago(9), clickedAt: ago(9) }));
  await pay(w.faraja, farajaElsewhere, 45000, 8);
  const farajaHere = await sub(w.faraja, w.gym, { startedDaysAgo: 1 });
  await pay(w.faraja, farajaHere, 45000, 7, 'pending');
  // A new member joins after tapping: paid, but not a renewal.
  w.gabriel = await user({ displayName: 'Gabriel' });
  await msg(w.september, w.gym, w.gabriel, 'in_app', reached(9, { status: 'clicked', openedAt: ago(9), clickedAt: ago(9) }));
  const gabrielSub = await sub(w.gabriel, w.gym, { startedDaysAgo: 8 });
  await pay(w.gabriel, gabrielSub, 50000, 8);

  // "Come back" leads to the gym: Halima taps and visits within 7 days.
  w.halima = await user({ displayName: 'Halima' });
  await sub(w.halima, w.gym);
  await msg(w.gymVisit, w.gym, w.halima, 'in_app', reached(6, { status: 'clicked', openedAt: ago(6), clickedAt: ago(6), deepLink: 'gym', category: 'marketing' }));
  await db('Checkin').insert({ id: uid('ci'), memberId: w.halima, gymId: w.gym, timestamp: ago(4), method: 'qr', subscriptionType: 'direct_sub', gymTier: 'standard', visitConsumed: true });

  // An automation, and FitFlex's own campaign to a pass holder.
  w.automation = uid('aut');
  await db('CommunicationAutomation').insert({ id: w.automation, senderType: 'gym', gymId: w.gym, name: 'Membership ends in 3 days', trigger: 'membership_expiring', offsetDays: 3, channels: ['in_app'], status: 'enabled', createdAt: ago(20), updatedAt: new Date() });
  made.automations.push(w.automation);
  w.ivan = await user({ displayName: 'Ivan' });
  const ivanSub = await sub(w.ivan, w.gym);
  const run = uid('run');
  await db('AutomationRun').insert({ id: run, automationId: w.automation, gymId: w.gym, memberId: w.ivan, occurrenceKey: 'k', status: 'queued', createdAt: ago(3) });
  await db('CommunicationMessage').insert({ id: uid('cmm'), automationRunId: run, senderType: 'gym', gymId: w.gym, memberId: w.ivan, channel: 'in_app', category: 'transactional', messageType: 'renewal', title: 'T', body: 'B', deepLink: 'renewal', status: 'clicked', attempts: 1, deliveredAt: ago(3), openedAt: ago(3), clickedAt: ago(3), createdAt: ago(3), updatedAt: new Date() });
  await pay(w.ivan, ivanSub, 25000, 2);

  w.fitflex = await campaign(null, 'Pass renewals');
  w.jamila = await user({ displayName: 'Jamila' });
  const pass = await sub(w.jamila, null, { type: 'platform_pass' });
  await msg(w.fitflex, null, w.jamila, 'in_app', reached(9, { status: 'clicked', openedAt: ago(9), clickedAt: ago(9) }));
  await pay(w.jamila, pass, 60000, 8);
});

after(async () => {
  if (made.campaigns.length) await db('CommunicationMessage').whereIn('campaignId', made.campaigns).del();
  await db('CommunicationMessage').whereIn('automationRunId', db('AutomationRun').whereIn('automationId', made.automations).select('id')).del();
  await db('AutomationRun').whereIn('automationId', made.automations).del();
  await db('CommunicationAutomation').whereIn('id', made.automations).del();
  if (made.campaigns.length) await db('CommunicationCampaign').whereIn('id', made.campaigns).del();
  await db('PaymentRequest').whereIn('memberId', made.users).del();
  await db('Checkin').whereIn('memberId', made.users).del();
  await db('Subscription').whereIn('memberId', made.users).del();
  if (made.gyms.length) await db('Gym').whereIn('id', made.gyms).del();
  if (made.users.length) await db('User').whereIn('id', made.users).del();
});

test('a campaign\'s results: delivery, engagement and business, like the September example', async () => {
  const r = await analytics.campaign(w.S, w.september);
  assert.deepEqual(r.attribution, { model: 'last_touch', clickWindowDays: 7, openWindowDays: 3 });
  assert.deepEqual(r.members, {
    recipients: 7,     // Asha, Baraka, Chiku, Daudi, Esther, Faraja, Gabriel
    sent: 6,           // all but Esther
    delivered: 6,
    failed: 1,         // Esther: nothing reached her
    opened: 6,
    clicked: 4,        // Asha, Daudi, Faraja, Gabriel
    ctaCompleted: 3,   // Asha, Daudi and Gabriel paid within 7 days of tapping (Faraja paid another gym)
    renewed: 2,        // Asha (tap), Baraka (open) — Daudi's went to October, Gabriel is new
    paid: 3,           // + Gabriel
  });
  assert.deepEqual(r.revenue, { currency: 'TZS', attributedTzs: 130000, payments: 3 });
  assert.deepEqual(r.conversions.map(c => [c.memberName, c.amountTzs, c.via, c.renewal]).sort(), [
    ['Asha', 50000, 'click', true], ['Baraka', 30000, 'open', true], ['Gabriel', 50000, 'click', false],
  ]);
  assert.equal(r.channels.push.delivered, null, 'push can\'t confirm delivery — no data, not zero');
  assert.deepEqual([r.channels.push.messages, r.channels.push.sent, r.channels.push.failed], [2, 1, 1]);
  assert.equal(r.channels.in_app.delivered, 6);
  assert.deepEqual(r.reasons, { failed: { push_failed: 1 }, skipped: { no_phone: 1 } });
});

test('a payment goes to the last message tapped, so no two campaigns take the same money', async () => {
  const oct = await analytics.campaign(w.S, w.october);
  assert.deepEqual([oct.members.paid, oct.revenue.attributedTzs, oct.conversions[0].memberName], [1, 60000, 'Daudi']);
  const sept = await analytics.campaign(w.S, w.september);
  assert.ok(!sept.conversions.some(c => c.memberName === 'Daudi'));
});

test('a renewal on the same membership counts as renewed, not a first payment', async () => {
  const g = await gym('Upya Gym');
  const S = { senderType: 'gym', owner: { gymIds: [g] } };
  const c = await campaign(g, 'Renew now');
  const m = await user({ displayName: 'Kassim' });
  // The membership starts after the tap (a new sign-up)… then is renewed.
  const s1 = await sub(m, g, { startedDaysAgo: 8 });
  await pay(m, s1, 50000, 8);
  await msg(c, g, m, 'in_app', reached(3, { status: 'clicked', openedAt: ago(3), clickedAt: ago(3) }));
  await pay(m, s1, 50000, 2);
  const r = await analytics.campaign(S, c);
  assert.deepEqual([r.members.paid, r.members.renewed], [1, 1]);
  assert.equal(r.conversions[0].renewal, true);
});

test('CTA completed follows the button: a gym button counts a visit', async () => {
  const r = await analytics.campaign(w.S, w.gymVisit);
  assert.deepEqual([r.members.clicked, r.members.ctaCompleted, r.members.paid], [1, 1, 0]);
});

test('an automation\'s results over a period, and a message with no CTA has none to complete', async () => {
  const r = await analytics.automation(w.S, w.automation, { days: 30 });
  assert.equal(r.automation.trigger, 'membership_expiring');
  assert.deepEqual([r.members.recipients, r.members.clicked, r.members.ctaCompleted, r.members.renewed], [1, 1, 1, 1]);
  assert.equal(r.revenue.attributedTzs, 25000);
  assert.ok(r.period.from && r.period.to);
  const short = await analytics.automation(w.S, w.automation, { days: 1 });
  assert.equal(short.members.recipients, 0, 'nothing sent in the last day');
  assert.equal(short.members.ctaCompleted, null);
  assert.equal((await analytics.automation(w.S, w.automation, { days: 0 })).error, 'invalid_days');
});

test('the overview: totals for the period, and each campaign and automation', async () => {
  const o = await analytics.overview(w.S, { days: 30 });
  assert.equal(o.period.days, 30);
  assert.ok(o.members.ctaCompleted >= 5, 'CTA completed counted across the period too');
  assert.ok(o.members.recipients >= 9);
  assert.deepEqual([o.revenue.attributedTzs, o.revenue.payments], [130000 + 60000 + 25000, 5]);
  const by = Object.fromEntries(o.sources.map(s => [s.name, s]));
  assert.deepEqual([by['September renewals'].paid, by['September renewals'].attributedTzs], [3, 130000]);
  assert.deepEqual([by['October offer'].attributedTzs, by['Membership ends in 3 days'].attributedTzs], [60000, 25000]);
  assert.equal(by['Membership ends in 3 days'].type, 'automation');
  assert.equal(by['Pass renewals'], undefined, 'not FitFlex\'s campaign');
});

test('each sender sees only its own results; FitFlex is credited with pass payments', async () => {
  assert.equal((await analytics.campaign(w.T, w.september)).error, 'not_found');
  assert.equal((await analytics.automation(w.T, w.automation)).error, 'not_found');
  assert.equal((await analytics.campaign(w.FF, w.september)).error, 'not_found');
  assert.equal((await analytics.overview(w.S, { gymId: w.otherGym })).error, 'not_your_gym');
  const tembo = await analytics.overview(w.T, { days: 30 });
  assert.deepEqual([tembo.members.recipients, tembo.revenue.attributedTzs], [0, 0], 'Faraja\'s payment there isn\'t credited to Simba\'s message, nor to Tembo');
  const ff = await analytics.campaign(w.FF, w.fitflex);
  assert.deepEqual([ff.members.paid, ff.revenue.attributedTzs], [1, 60000]);
  assert.equal(ATTRIBUTION.clickWindowDays, 7);
});
