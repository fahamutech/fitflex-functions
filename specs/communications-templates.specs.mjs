// Communications M6 — templates: the FitFlex catalogue, gym templates,
// preview, campaigns started from a template in each member's language, and
// WhatsApp only through provider-approved templates.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import {
  communicationPreferences, deviceTokens, communicationCampaigns, communicationTemplates, gyms, users, notifications,
} from '../src/bootstrap/collections.mjs';
import { createSegmentService } from '../src/services/segment-service.mjs';
import { createCampaignService } from '../src/services/campaign-service.mjs';
import { createTemplateService } from '../src/services/template-service.mjs';
import { createNotificationService } from '../src/services/notification-service.mjs';
import { createDeliveryService } from '../src/services/delivery-service.mjs';
import { SYSTEM_TEMPLATES, TEMPLATE_GROUPS, systemTemplateId } from '../src/shared/communication-templates.mjs';
import { validateContent, variablesIn, contentFor, TEMPLATE_VARIABLES } from '../src/shared/communications.mjs';

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const at = (days) => new Date(Date.now() + days * 86_400_000);
const made = { users: [], gyms: [], wa: [] };
const w = {};

const templates = createTemplateService({ db, templates: communicationTemplates, gyms, whatsappProvider: () => 'spec_provider' });
const segments = (whatsapp = false) => createSegmentService({ db, communicationPreferences, deviceTokens, pushAvailable: () => true, whatsappAvailable: () => whatsapp });
const campaignsWith = (seg) => createCampaignService({ db, campaigns: communicationCampaigns, gyms, segmentService: seg, auditLog: null, templateService: templates });
const campaigns = campaignsWith(segments());

async function user(fields) {
  const id = uid('usr');
  await db('User').insert({ id, userType: 'member', updatedAt: new Date(), ...fields });
  made.users.push(id);
  return id;
}
async function gym(name) {
  const id = uid('gym');
  await db('Gym').insert({ id, name, tier: 'standard', location: uid('Mwanza'), updatedAt: new Date() });
  made.gyms.push(id);
  return id;
}
async function member(gymId, displayName, phone = null) {
  const id = await user({ displayName, phone });
  await db('Subscription').insert({
    id: uid('sub'), memberId: id, type: 'direct_sub', plan: 'monthly', status: 'active', homeGymId: gymId,
    startedAt: at(-20), cycleStartedAt: at(-20), renewsAt: at(4), expiresAt: at(4),
  });
  return id;
}

before(async () => {
  w.gymA = await gym('Simba Gym');
  w.gymB = await gym('Tembo Gym');
  w.ownerA = await user({ userType: 'gym_operator', gymIds: [w.gymA] });
  w.ownerB = await user({ userType: 'gym_operator', gymIds: [w.gymB] });
  w.A = { senderType: 'gym', owner: { id: w.ownerA, gymIds: [w.gymA] }, actorId: w.ownerA };
  w.B = { senderType: 'gym', owner: { id: w.ownerB, gymIds: [w.gymB] }, actorId: w.ownerB };
  w.FF = { senderType: 'platform', actorId: null };
  w.english = await member(w.gymA, 'Neema', '+255712000001');
  w.swahili = await member(w.gymA, 'Juma', '+255712000002');
  w.unknown = await member(w.gymA, 'Rehema');
  await db('CommunicationPreference').insert([{ id: w.english, locale: 'en' }, { id: w.swahili, locale: 'sw' }]);
});

after(async () => {
  if (made.wa.length) await db('WhatsAppTemplate').whereIn('id', made.wa).del();
  if (made.gyms.length) await db('Gym').whereIn('id', made.gyms).del();
  if (made.users.length) await db('User').whereIn('id', made.users).del();
});

// ── the catalogue ──────────────────────────────────────────────────────────

test('the FitFlex catalogue covers the brief, in English and Swahili', () => {
  const keys = SYSTEM_TEMPLATES.map(t => t.key);
  for (const k of ['welcome_member', 'membership_activated', 'membership_expiring', 'membership_expired', 'renewal_reminder',
    'payment_successful', 'payment_failed', 'payment_pending', 'payment_reminder',
    'new_promotion', 'discount_offer', 'new_class', 'new_trainer', 'new_equipment',
    'we_miss_you', 'welcome_back', 'congratulations', 'member_milestone']) assert.ok(keys.includes(k), k);
  assert.equal(new Set(keys).size, keys.length, 'keys are unique');
  assert.equal(new Set(SYSTEM_TEMPLATES.map(t => t.whatsapp.name)).size, keys.length, 'WhatsApp names are unique');
  for (const t of SYSTEM_TEMPLATES) {
    assert.ok(TEMPLATE_GROUPS.includes(t.group), t.key);
    const en = t.bodies.en;
    const sw = t.bodies.sw;
    assert.ok(en && sw, `${t.key} has both languages`);
    assert.deepEqual(variablesIn(`${sw.title} ${sw.body}`).sort(), variablesIn(`${en.title} ${en.body}`).sort(), `${t.key}: the Swahili uses the same variables`);
    assert.equal(Boolean(sw.ctaLabel), Boolean(en.ctaLabel), `${t.key}: both or neither have a button`);
    for (const lang of ['en', 'sw']) {
      const v = validateContent({ ...t.bodies[lang], offerName: 'x', discount: 'x', amountTzs: 1 });
      assert.ok(!v.error, `${t.key}/${lang}: ${v.detail}`);
    }
    assert.ok(variablesIn(`${en.title} ${en.body}`).every(v => TEMPLATE_VARIABLES.includes(v)));
    assert.equal(t.whatsapp.category, ['promotion', 'engagement', 'general'].includes(t.purpose) ? 'marketing' : 'utility');
  }
});

test('system templates are synced once and stay one row each', async () => {
  await templates.syncSystemTemplates();
  await templates.syncSystemTemplates();
  const rows = await db('CommunicationTemplate').whereNull('gymId').whereIn('key', SYSTEM_TEMPLATES.map(t => t.key));
  assert.equal(rows.length, SYSTEM_TEMPLATES.length);
  const expiring = rows.find(r => r.key === 'membership_expiring');
  assert.deepEqual([expiring.id, expiring.group, expiring.purpose, expiring.category, expiring.deepLink],
    [systemTemplateId('membership_expiring'), 'membership', 'renewal', 'transactional', 'renewal']);
  assert.deepEqual(expiring.variables.sort(), ['expiry_date', 'gym_name', 'member_name', 'plan_name']);
});

// ── browsing and gym templates ─────────────────────────────────────────────

test('owners see their own templates first, then FitFlex\'s; never another gym\'s', async () => {
  const mine = (await templates.create(w.A, { name: 'Friday closure', purpose: 'announcement', group: 'general', bodies: { en: { title: 'Closed Friday', body: 'Hi {{member_name}}, {{gym_name}} is closed on Friday.' } } })).template;
  const theirs = (await templates.create(w.B, { name: 'Their promo', purpose: 'promotion', bodies: { en: { title: 'Promo', body: 'x' } } })).template;
  const list = (await templates.list(w.A)).templates;
  assert.equal(list[0].id, mine.id);
  assert.ok(list.some(t => t.system && t.key === 'welcome_member'));
  assert.ok(!list.some(t => t.id === theirs.id));
  assert.equal((await templates.get(w.A, theirs.id)).error, 'not_found');
  assert.deepEqual((await templates.list(w.A, { group: 'payment' })).templates.map(t => t.key),
    ['payment_successful', 'payment_failed', 'payment_pending', 'payment_reminder']);
  const ff = (await templates.list(w.FF)).templates;
  assert.ok(ff.every(t => t.system), 'FitFlex admins see only FitFlex templates');
  assert.equal((await templates.list(w.A, { gymId: w.gymB })).error, 'not_your_gym');
});

test('gym templates are checked like campaign messages', async () => {
  const bad = (body) => templates.create(w.A, { name: 'x', purpose: 'general', ...body });
  assert.equal((await bad({ bodies: { en: { title: 'Hi', body: '{{shoe_size}}' } } })).detail, 'en:unknown_variable:shoe_size');
  assert.equal((await bad({ bodies: { sw: { title: '', body: 'x' } } })).detail, 'sw:title_required');
  assert.equal((await bad({ bodies: { fr: { title: 'x', body: 'y' } } })).error, 'invalid_bodies');
  assert.equal((await bad({ bodies: {} })).error, 'invalid_bodies');
  assert.equal((await templates.create(w.A, { purpose: 'general', bodies: { en: { title: 'x', body: 'y' } } })).error, 'invalid_name');
  assert.equal((await templates.create(w.FF, { name: 'x', purpose: 'general', bodies: { en: { title: 'x', body: 'y' } } })).error, 'gyms_only');
  // {{discount}} is fine in a template — the value is typed in per campaign.
  assert.ok((await bad({ bodies: { en: { title: '{{discount}} off', body: 'Hi {{member_name}}' } } })).template);
});

test('FitFlex templates are read-only; copying one makes a gym template to adapt', async () => {
  const sys = systemTemplateId('we_miss_you');
  assert.equal((await templates.update(w.A, sys, { name: 'mine' })).error, 'system_template_read_only');
  assert.equal((await templates.archive(w.A, sys)).error, 'system_template_read_only');
  const copy = (await templates.duplicate(w.A, sys)).template;
  assert.deepEqual([copy.system, copy.gymId, copy.basedOn, copy.group, copy.purpose], [false, w.gymA, sys, 'engagement', 'engagement']);
  assert.equal(copy.bodies.sw.title, 'Tumekukumbuka, {{member_name}}');
  assert.equal(copy.name, 'We miss you', 'a readable name when the app sends none');
  assert.equal((await templates.duplicate(w.A, sys, { name: 'Tunakukumbuka' })).template.name, 'Tunakukumbuka');
  const edited = (await templates.update(w.A, copy.id, { bodies: { ...copy.bodies, en: { title: 'Come back, {{member_name}}', body: 'We saved your spot at {{gym_name}}.' } } })).template;
  assert.equal(edited.bodies.en.title, 'Come back, {{member_name}}');
  assert.equal(edited.bodies.sw.title, 'Tumekukumbuka, {{member_name}}');
  assert.equal((await templates.update(w.B, copy.id, { name: 'hijack' })).error, 'not_found');
  assert.deepEqual(await templates.archive(w.A, copy.id), { ok: true });
  assert.ok(!(await templates.list(w.A)).templates.some(t => t.id === copy.id));
  assert.equal((await templates.update(w.A, copy.id, { name: 'x' })).error, 'template_archived');
});

// ── preview ────────────────────────────────────────────────────────────────

test('preview shows each channel in each language for a sample member at the gym', async () => {
  const p = await templates.preview(w.A, { templateId: systemTemplateId('membership_expiring') });
  assert.equal(p.senderName, 'Simba Gym');
  assert.match(p.byLocale.en.in_app.body, /^Hi Amina, your Monthly plan at Simba Gym ends on \d\d\/\d\d\/\d{4}\./);
  assert.match(p.byLocale.sw.in_app.body, /^Habari Amina, mpango wako wa Kila mwezi katika Simba Gym unaisha tarehe/);
  assert.deepEqual([p.byLocale.en.in_app.ctaLabel, p.byLocale.sw.in_app.ctaLabel, p.byLocale.en.in_app.deepLink], ['Renew now', 'Huisha sasa', 'renewal']);
  assert.equal(p.byLocale.en.push.title, 'Your plan ends soon');
  assert.deepEqual(p.whatsapp, { ready: false, byLocale: { en: { ready: false, reason: 'not_registered' }, sw: { ready: false, reason: 'not_registered' } } });
});

test('offer values show as placeholders until typed in; long messages are cut for push', async () => {
  const blank = await templates.preview(w.A, { templateId: systemTemplateId('discount_offer') });
  assert.equal(blank.byLocale.en.in_app.title, '[discount] off: [offer_name]');
  assert.deepEqual(blank.needsValues.sort(), ['discount', 'offer_name']);
  const filled = await templates.preview(w.A, { templateId: systemTemplateId('discount_offer'), values: { discount: '20%', offerName: 'October Deal' } });
  assert.equal(filled.byLocale.sw.in_app.title, 'Punguzo la 20%: October Deal');
  const long = await templates.preview(w.A, { body: { name: 'x', purpose: 'general', bodies: { en: { title: 'Hi', body: 'word '.repeat(80) } } } });
  assert.equal(long.byLocale.en.push.truncated, true);
  assert.ok(long.byLocale.en.push.body.endsWith('…') && long.byLocale.en.push.body.length <= 178);
});

// ── campaigns from templates ───────────────────────────────────────────────

test('a campaign started from a template reaches each member in their language', async () => {
  const { campaign } = await campaigns.create(w.A, {
    templateId: systemTemplateId('membership_expiring'), locale: 'sw',
    audience: { preset: 'active' }, channels: ['in_app'],
  });
  assert.equal(campaign.purpose, 'renewal', 'the template sets the purpose');
  assert.equal(campaign.templateId, systemTemplateId('membership_expiring'), 'the app shows which template it came from');
  assert.equal(campaign.content.locale, 'sw');
  assert.equal(campaign.content.translations.en.title, 'Your plan ends soon');
  const sent = await campaigns.send(w.A, campaign.id, { sendRequestId: uid('req') });
  assert.ok(sent.campaign, JSON.stringify(sent));
  const rows = await db('CommunicationMessage').where({ campaignId: campaign.id });
  const of = (m) => rows.find(r => r.memberId === m);
  assert.deepEqual([of(w.english).locale, of(w.english).title], ['en', 'Your plan ends soon']);
  assert.deepEqual([of(w.swahili).locale, of(w.swahili).title], ['sw', 'Mpango wako unakaribia kuisha']);
  assert.equal(of(w.unknown).locale, 'sw', 'no known language: the main version');
  assert.match(of(w.english).body, /^Hi Neema, your Monthly plan at Simba Gym/);
  assert.match(of(w.swahili).body, /^Habari Juma, mpango wako wa Kila mwezi katika Simba Gym/);

  // The inbox button is in the member's language too.
  const notificationService = createNotificationService({ users, deviceTokens, notifications, logger: { warn() {} } });
  const delivery = createDeliveryService({ db, notificationService, campaignService: campaigns, logger: { error() {} } });
  for (const r of rows) await delivery.deliver({ ...r, attempts: 1 });
  const inbox = async (m) => (await notificationService.inbox({ userId: m })).notifications.find(n => n.campaignId === campaign.id);
  assert.equal((await inbox(w.english)).data.ctaLabel, 'Renew now');
  assert.equal((await inbox(w.swahili)).data.ctaLabel, 'Huisha sasa');
});

test('a campaign can\'t use another gym\'s template; a template needs its offer values', async () => {
  const theirs = (await templates.create(w.B, { name: 'B only', purpose: 'general', bodies: { en: { title: 'x', body: 'y' } } })).template;
  assert.equal((await campaigns.create(w.A, { templateId: theirs.id, audience: { preset: 'all' } })).error, 'template_not_found');
  const noValues = await campaigns.create(w.A, { templateId: systemTemplateId('discount_offer'), audience: { preset: 'all' } });
  assert.deepEqual([noValues.error, noValues.detail], ['invalid_content', 'missing_value:discount']);
  const ok = await campaigns.create(w.A, { templateId: systemTemplateId('discount_offer'), templateValues: { discount: '15%', offerName: 'Rafiki' }, audience: { preset: 'all' } });
  assert.equal(ok.campaign.content.discount, '15%');
  assert.equal(ok.campaign.category, 'marketing');
});

test('translations are checked like the main message', () => {
  const base = { title: 'Hi', body: 'Hello {{member_name}}' };
  assert.equal(validateContent({ ...base, translations: { fr: base } }).detail, 'unknown_locale');
  assert.equal(validateContent({ ...base, translations: { en: base } }).detail, 'translation_same_as_main');
  assert.equal(validateContent({ ...base, translations: { sw: { title: 'x', body: '{{shoe}}' } } }).detail, 'unknown_variable:shoe');
  assert.equal(validateContent({ ...base, translations: { sw: { title: '', body: 'x' } } }).detail, 'sw_title_required');
  assert.equal(validateContent({ ...base, translations: { sw: { title: '{{discount}}', body: 'x' } } }).detail, 'missing_value:discount');
  const ok = validateContent({ ...base, locale: 'en', translations: { sw: { title: 'Habari', body: 'Habari {{member_name}}', ctaLabel: 'Fungua' } } }).content;
  assert.deepEqual(contentFor(ok, 'sw'), { title: 'Habari', body: 'Habari {{member_name}}', ctaLabel: 'Fungua', locale: 'sw' });
  assert.deepEqual(contentFor(ok, 'fr'), { title: 'Hi', body: 'Hello {{member_name}}', ctaLabel: null, locale: 'en' });
  assert.deepEqual(contentFor(ok, null).locale, 'en');
});

// ── WhatsApp compatibility ─────────────────────────────────────────────────

test('WhatsApp takes only provider-approved templates, never free text', async () => {
  const wa = campaignsWith(segments(true)); // as if a WhatsApp provider were configured
  const free = await wa.create(w.A, { purpose: 'renewal', audience: { preset: 'active' }, channels: ['whatsapp'], content: { title: 'Renew', body: 'Hi {{member_name}}' } });
  assert.equal((await wa.send(w.A, free.campaign.id, { sendRequestId: uid('req') })).error, 'whatsapp_template_required');

  const fromTemplate = await wa.create(w.A, { templateId: systemTemplateId('renewal_reminder'), audience: { preset: 'active' }, channels: ['whatsapp'] });
  assert.equal((await wa.schedule(w.A, fromTemplate.campaign.id, { scheduledAt: at(1).toISOString() })).error, 'whatsapp_template_required', 'not registered with the provider yet');

  const id = uid('wat');
  made.wa.push(id);
  await db('WhatsAppTemplate').insert({ id, provider: 'spec_provider', providerTemplateName: 'fitflex_renewal_reminder', language: 'en', category: 'utility', variables: ['member_name'], approvalStatus: 'approved', updatedAt: new Date() });
  const status = (await templates.get(w.A, systemTemplateId('renewal_reminder'))).template.whatsapp;
  assert.deepEqual(status.byLocale, { en: { ready: true }, sw: { ready: false, reason: 'not_registered' } });
  const sent = await wa.send(w.A, fromTemplate.campaign.id, { sendRequestId: uid('req') });
  assert.ok(sent.campaign, JSON.stringify(sent));
  const rows = await db('CommunicationMessage').where({ campaignId: fromTemplate.campaign.id });
  assert.ok(rows.every(r => r.channel === 'whatsapp'));
  assert.equal(rows.find(r => r.memberId === w.unknown).skipReason, 'no_phone');
});
