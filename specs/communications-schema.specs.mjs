// Communications M1 — schema and store against the CI database: rows
// round-trip through the collection API (jsonb, text[] and timestamps), and
// the database itself refuses what must never happen — a gym campaign with
// no gym, a FitFlex one tied to a gym, or the same member messaged twice on
// one channel by one campaign or one automation firing.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import {
  notifications, communicationCampaigns, communicationMessages, communicationTemplates,
  whatsappTemplates, communicationPreferences, communicationAutomations, automationRuns, jobRuns,
} from '../src/bootstrap/collections.mjs';

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const now = () => new Date().toISOString();
const created = { users: [], gyms: [] };

async function makeUser() {
  const id = uid('usr');
  await db('User').insert({ id, userType: 'member', displayName: 'Comms Test', updatedAt: new Date() });
  created.users.push(id);
  return id;
}

async function makeGym() {
  const id = uid('gym');
  await db('Gym').insert({ id, name: 'Comms Test Gym', tier: 'standard', location: 'Dar es Salaam', updatedAt: new Date() });
  created.gyms.push(id);
  return id;
}

async function rejects(promise, code) {
  await assert.rejects(promise, (err) => err.code === code, `expected Postgres error ${code}`);
}

after(async () => {
  // Every communications row cascades from its gym or member.
  if (created.gyms.length) await db('Gym').whereIn('id', created.gyms).del();
  if (created.users.length) await db('User').whereIn('id', created.users).del();
  await db('WhatsAppTemplate').where('provider', 'spec_provider').del();
  await db('CommunicationTemplate').whereNull('gymId').where('key', 'like', 'spec_%').del();
  await db('JobRun').where('job', 'spec_job').del();
});

test('a gym campaign round-trips with its audience, content and channels intact', async () => {
  const gymId = await makeGym();
  const ownerId = await makeUser();
  const id = uid('cmp');
  await communicationCampaigns.insertAsync({
    id, senderType: 'gym', gymId, name: 'October renewals', purpose: 'renewal', category: 'transactional',
    audience: { all: [{ field: 'daysUntilExpiry', op: 'between', value: [0, 7] }] },
    content: { title: 'Renew {{plan_name}}', body: 'Hi {{member_name}}', variables: ['plan_name', 'member_name'] },
    channels: ['in_app', 'push'], scheduledAt: '2026-10-05T06:00:00.000Z', createdBy: ownerId, createdAt: now(),
  });
  const row = await communicationCampaigns.findByIdAsync(id);
  assert.equal(row.status, 'draft');
  assert.deepEqual(row.channels, ['in_app', 'push']);
  assert.deepEqual(row.audience.all[0].value, [0, 7]);
  assert.equal(row.content.title, 'Renew {{plan_name}}');
  assert.equal(new Date(row.scheduledAt).toISOString(), '2026-10-05T06:00:00.000Z');

  const updated = await communicationCampaigns.updateByIdAsync(id, { status: 'scheduled', counts: { targeted: 12 } });
  assert.equal(updated.status, 'scheduled');
  assert.equal(updated.counts.targeted, 12);
  assert.ok(+new Date(updated.updatedAt) >= +new Date(row.updatedAt));
});

test('a FitFlex (platform) campaign has no gym; the database refuses mixed-up senders', async () => {
  const gymId = await makeGym();
  await communicationCampaigns.insertAsync({ id: uid('cmp'), senderType: 'platform', gymId: null, name: 'FitFlex news', purpose: 'announcement', category: 'transactional', channels: ['in_app'] });
  await rejects(communicationCampaigns.insertAsync({ id: uid('cmp'), senderType: 'gym', gymId: null, name: 'x', purpose: 'promotion', category: 'marketing' }), '23514');
  await rejects(communicationCampaigns.insertAsync({ id: uid('cmp'), senderType: 'platform', gymId, name: 'x', purpose: 'promotion', category: 'marketing' }), '23514');
  await rejects(communicationCampaigns.insertAsync({ id: uid('cmp'), senderType: 'gym', gymId, name: 'x', purpose: 'promotion', category: 'urgent' }), '23514');
  await db('CommunicationCampaign').where({ senderType: 'platform', name: 'FitFlex news' }).del();
});

test('a second Send with the same request id is refused', async () => {
  const gymId = await makeGym();
  const sendRequestId = uid('req');
  const base = { senderType: 'gym', gymId, name: 'Promo', purpose: 'promotion', category: 'marketing', sendRequestId };
  await communicationCampaigns.insertAsync({ id: uid('cmp'), ...base });
  await rejects(communicationCampaigns.insertAsync({ id: uid('cmp'), ...base }), '23505');
});

test('one campaign messages a member at most once per channel', async () => {
  const gymId = await makeGym();
  const memberId = await makeUser();
  const campaignId = uid('cmp');
  await communicationCampaigns.insertAsync({ id: campaignId, senderType: 'gym', gymId, name: 'Promo', purpose: 'promotion', category: 'marketing' });
  const msg = { senderType: 'gym', gymId, memberId, campaignId, category: 'marketing', title: 'Hi', body: 'Offer' };
  await communicationMessages.insertAsync({ id: uid('msg'), ...msg, channel: 'in_app' });
  await communicationMessages.insertAsync({ id: uid('msg'), ...msg, channel: 'push' });
  await rejects(communicationMessages.insertAsync({ id: uid('msg'), ...msg, channel: 'in_app' }), '23505');
  await rejects(communicationMessages.insertAsync({ id: uid('msg'), ...msg, channel: 'fax' }), '23514');

  const rows = await communicationMessages.filterByColumnAsync('campaignId', campaignId);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.status === 'queued' && r.attempts === 0 && r.failurePermanent === false));
});

test('an automation fires once per member per occurrence, however often the job runs', async () => {
  const gymId = await makeGym();
  const memberId = await makeUser();
  const automationId = uid('aut');
  await communicationAutomations.insertAsync({
    id: automationId, senderType: 'gym', gymId, name: '7 days before expiry', trigger: 'membership_expiring',
    offsetDays: 7, channels: ['in_app'], conditions: { planTypes: ['direct_sub'] },
  });
  const auto = await communicationAutomations.findByIdAsync(automationId);
  assert.equal(auto.status, 'disabled', 'automations start disabled until the owner turns them on');
  assert.deepEqual(auto.conditions, { planTypes: ['direct_sub'] });

  // Same gym, trigger and offset twice is refused.
  await rejects(communicationAutomations.insertAsync({ id: uid('aut'), senderType: 'gym', gymId, name: 'dup', trigger: 'membership_expiring', offsetDays: 7 }), '23505');

  const run = { automationId, gymId, memberId, occurrenceKey: 'sub_abc:T-7' };
  const runId = uid('run');
  await automationRuns.insertAsync({ id: runId, ...run });
  await rejects(automationRuns.insertAsync({ id: uid('run'), ...run }), '23505');
  await automationRuns.insertAsync({ id: uid('run'), ...run, occurrenceKey: 'sub_abc:T-3' });

  const msg = { senderType: 'gym', gymId, memberId, automationRunId: runId, category: 'transactional', channel: 'in_app' };
  await communicationMessages.insertAsync({ id: uid('msg'), ...msg });
  await rejects(communicationMessages.insertAsync({ id: uid('msg'), ...msg }), '23505');
});

test('templates: bodies in both languages round-trip; system template keys are unique', async () => {
  const gymId = await makeGym();
  const waId = uid('wat');
  await whatsappTemplates.insertAsync({
    id: waId, provider: 'spec_provider', providerTemplateName: 'renewal_reminder', language: 'sw',
    category: 'utility', variables: ['member_name', 'expiry_date'],
  });
  assert.equal((await whatsappTemplates.findByIdAsync(waId)).approvalStatus, 'pending');

  const key = `spec_${randomUUID().slice(0, 6)}`;
  const bodies = { en: { title: 'Renew soon', body: 'Hi {{member_name}}' }, sw: { title: 'Huisha mapema', body: 'Habari {{member_name}}' } };
  const sysId = uid('tpl');
  await communicationTemplates.insertAsync({ id: sysId, gymId: null, key, name: 'Renewal', category: 'transactional', purpose: 'renewal', channels: ['in_app', 'whatsapp'], bodies, variables: ['member_name'], whatsappTemplateId: waId });
  const sys = await communicationTemplates.findByIdAsync(sysId);
  assert.deepEqual(sys.bodies, bodies);
  assert.deepEqual(sys.variables, ['member_name']);
  assert.equal(sys.whatsappTemplateId, waId);

  await rejects(communicationTemplates.insertAsync({ id: uid('tpl'), gymId: null, key, name: 'dup', category: 'transactional', purpose: 'renewal', bodies }), '23505');
  // A gym can keep its own copy under the same key.
  await communicationTemplates.insertAsync({ id: uid('tpl'), gymId, key, name: 'Our renewal', category: 'transactional', purpose: 'renewal', bodies });
  await rejects(communicationTemplates.insertAsync({ id: uid('tpl'), gymId, key, name: 'dup', category: 'transactional', purpose: 'renewal', bodies }), '23505');

  // Removing a WhatsApp template unlinks it rather than deleting FitFlex templates.
  await db('WhatsAppTemplate').where({ id: waId }).del();
  assert.equal((await communicationTemplates.findByIdAsync(sysId)).whatsappTemplateId, null);
});

test('a new preference row starts with WhatsApp marketing off, and records consent when turned on', async () => {
  const memberId = await makeUser();
  await communicationPreferences.insertAsync({ id: memberId });
  const fresh = await communicationPreferences.findByIdAsync(memberId);
  assert.equal(fresh.inAppMarketing, true);
  assert.equal(fresh.pushMarketing, true);
  assert.equal(fresh.whatsappTransactional, true);
  assert.equal(fresh.whatsappMarketing, false);

  const consentAt = '2026-10-01T08:00:00.000Z';
  const on = await communicationPreferences.updateByIdAsync(memberId, { whatsappMarketing: true, whatsappMarketingConsentAt: consentAt, whatsappMarketingConsentSource: 'app_settings', locale: 'sw' });
  assert.equal(on.whatsappMarketing, true);
  assert.equal(new Date(on.whatsappMarketingConsentAt).toISOString(), consentAt);
  assert.equal(on.locale, 'sw');
});

test('the inbox keeps working and can now carry its gym, campaign, category and click', async () => {
  const gymId = await makeGym();
  const memberId = await makeUser();
  const campaignId = uid('cmp');
  await communicationCampaigns.insertAsync({ id: campaignId, senderType: 'gym', gymId, name: 'News', purpose: 'announcement', category: 'transactional' });

  const legacyId = uid('ntf');
  await notifications.insertAsync({ id: legacyId, userId: memberId, type: 'subscription_renewal', title: 't', body: 'b', data: { daysLeft: 3 }, readAt: null, createdAt: now() });
  const legacy = await notifications.findByIdAsync(legacyId);
  assert.equal(legacy.gymId, null);
  assert.equal(legacy.category, null);

  const id = uid('ntf');
  await notifications.insertAsync({ id, userId: memberId, type: 'campaign', title: 'Closed Friday', body: 'b', data: { deepLink: 'announcement' }, category: 'transactional', gymId, campaignId, createdAt: now() });
  const clicked = await notifications.updateByIdAsync(id, { clickedAt: '2026-10-01T10:00:00.000Z' });
  assert.equal(clicked.gymId, gymId);
  assert.equal(clicked.campaignId, campaignId);
  assert.equal(clicked.category, 'transactional');
  assert.equal(new Date(clicked.clickedAt).toISOString(), '2026-10-01T10:00:00.000Z');

  // Deleting a campaign keeps the member's inbox row.
  await db('CommunicationCampaign').where({ id: campaignId }).del();
  assert.equal((await notifications.findByIdAsync(id)).campaignId, null);
});

test('a job run records its outcome and stats', async () => {
  const id = uid('job');
  await jobRuns.insertAsync({ id, job: 'spec_job' });
  const done = await jobRuns.updateByIdAsync(id, { status: 'ok', finishedAt: now(), stats: { sent: 3, failed: 1 } });
  assert.equal(done.status, 'ok');
  assert.deepEqual(done.stats, { sent: 3, failed: 1 });
});
