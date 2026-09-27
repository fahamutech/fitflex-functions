// Communications M7 — WhatsApp through the provider seam: choosing the
// provider from the environment, campaigns sending provider-approved
// templates in each member's language, last-moment checks at delivery, the
// webhook (receipts, STOP / START), the kill switch and the admin registry.
// No real provider exists yet, so this runs on the fake one.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { communicationPreferences, deviceTokens, communicationCampaigns, communicationTemplates, gyms } from '../src/bootstrap/collections.mjs';
import { createSegmentService } from '../src/services/segment-service.mjs';
import { createCampaignService } from '../src/services/campaign-service.mjs';
import { createTemplateService } from '../src/services/template-service.mjs';
import { createDeliveryService } from '../src/services/delivery-service.mjs';
import { createWhatsAppChannelService } from '../src/services/whatsapp-channel-service.mjs';
import { createWhatsAppProvider, registerWhatsAppProvider, parseStandardWebhook } from '../src/integrations/whatsapp/provider.mjs';
import { createFakeWhatsAppProvider } from '../src/integrations/whatsapp/fake-provider.mjs';
import { toE164, storedDigitVariants, maskPhone } from '../src/shared/phone.mjs';
import { systemTemplateId } from '../src/shared/communication-templates.mjs';

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const at = (days) => new Date(Date.now() + days * 86_400_000);
const made = { users: [], gyms: [] };
const w = {};
const quiet = { warn() {}, error() {} };

// A fake provider under a name of its own, so this spec's registry rows
// never mix with anyone else's.
const fake = createFakeWhatsAppProvider();
const provider = { ...fake, name: uid('specwa') };
const channel = createWhatsAppChannelService({ db, provider, settingsTtlMs: 0, logger: quiet });
const templates = createTemplateService({ db, templates: communicationTemplates, gyms, whatsappProvider: () => provider.name });
const segments = createSegmentService({ db, communicationPreferences, deviceTokens, pushAvailable: () => false, whatsappAvailable: () => channel.available() });
const campaigns = createCampaignService({ db, campaigns: communicationCampaigns, gyms, segmentService: segments, auditLog: null, templateService: templates });
const delivery = createDeliveryService({ db, notificationService: {}, campaignService: campaigns, whatsappChannel: channel, logger: quiet });

async function user(fields) {
  const id = uid('usr');
  await db('User').insert({ id, userType: 'member', updatedAt: new Date(), ...fields });
  made.users.push(id);
  return id;
}
async function member(displayName, phone, prefs = null) {
  const id = await user({ displayName, phone });
  await db('Subscription').insert({
    id: uid('sub'), memberId: id, type: 'direct_sub', plan: 'monthly', status: 'active', homeGymId: w.gym,
    startedAt: at(-25), cycleStartedAt: at(-25), renewsAt: at(5), expiresAt: at(5),
  });
  if (prefs) await db('CommunicationPreference').insert({ id, ...prefs, updatedAt: new Date() });
  return id;
}

/** Sends a WhatsApp campaign from a template and returns its ledger rows by member. */
async function sendFromTemplate(key, extra = {}) {
  const c = await campaigns.create(w.A, { templateId: systemTemplateId(key), audience: { preset: 'active' }, channels: ['whatsapp'], ...extra });
  assert.ok(c.campaign, JSON.stringify(c));
  const sent = await campaigns.send(w.A, c.campaign.id, { sendRequestId: uid('req') });
  assert.ok(sent.campaign, JSON.stringify(sent));
  const rows = await db('CommunicationMessage').where({ campaignId: c.campaign.id });
  return { id: c.campaign.id, rows, of: (m) => rows.find(r => r.memberId === m) };
}
// What the dispatcher does with one claimed row.
const dispatch = async (row) => delivery.deliver({ ...row, attempts: (row.attempts || 0) + 1 });
const reload = (id) => db('CommunicationMessage').where({ id }).first();

before(async () => {
  w.gym = uid('gym');
  await db('Gym').insert({ id: w.gym, name: 'Kilele Gym', tier: 'standard', location: uid('Moshi'), updatedAt: new Date() });
  made.gyms.push(w.gym);
  w.owner = await user({ userType: 'gym_operator', gymIds: [w.gym] });
  w.A = { senderType: 'gym', owner: { id: w.owner, gymIds: [w.gym] }, actorId: w.owner };
  w.neema = await member('Neema', '0712 345 678', { locale: 'en' });
  w.juma = await member('Juma', '+255 713 111 222', { locale: 'sw' });
  w.nophone = await member('Rehema', null);
  w.bad = await member('Bad Number', '12');
  w.gone = await member('Gone', '0714 000 000');       // fake: invalid recipient
  w.busy = await member('Busy', '0714 000 001');       // fake: provider unavailable
  w.stopped = await member('Stopped', '0714 000 002'); // fake: opted out at the provider
  w.offers = await member('Offers', '0715 555 555', { whatsappMarketing: true, locale: 'sw' });
  // FitFlex templates registered and approved for this provider.
  const synced = await channel.syncTemplates(w.owner);
  assert.equal(synced.synced, 36, 'every FitFlex template, in English and Swahili');
  w.platformBefore = await db('PlatformSettings').where({ id: 'platform' }).first('communications');
});

after(async () => {
  await db('PlatformSettings').where({ id: 'platform' }).update({ communications: w.platformBefore?.communications ?? null });
  await db('WhatsAppTemplate').where({ provider: provider.name }).del();
  if (made.gyms.length) await db('Gym').whereIn('id', made.gyms).del();
  if (made.users.length) await db('User').whereIn('id', made.users).del();
});

// ── phones and the provider registry ───────────────────────────────────────

test('phone numbers become E.164, and incoming numbers find members however they were typed', () => {
  assert.equal(toE164('0712 345 678'), '+255712345678');
  assert.equal(toE164('255712345678'), '+255712345678');
  assert.equal(toE164('+255 (712) 345-678'), '+255712345678');
  assert.equal(toE164('00255712345678'), '+255712345678');
  assert.equal(toE164('712345678'), '+255712345678');
  assert.equal(toE164('+254 712 345678'), '+254712345678', 'another country stays as it is');
  for (const bad of ['', '12', 'hello', null, undefined, '+0123456789']) assert.equal(toE164(bad), null, String(bad));
  assert.deepEqual(storedDigitVariants('+255712345678').sort(), ['0712345678', '255712345678', '712345678']);
  assert.equal(maskPhone('+255712345678'), '+2557•• ••• 678');
});

test('the provider comes from WHATSAPP_PROVIDER, never sends by accident, and never shows credentials', async () => {
  const off = createWhatsAppProvider({ env: {}, logger: quiet });
  assert.deepEqual([off.name, off.configured, off.setup.reason], ['not_configured', false, 'no_provider']);
  assert.deepEqual(await off.sendTemplate({ to: '+255712345678', templateName: 'x', language: 'en' }),
    { ok: false, error: 'whatsapp_not_configured', retryable: false });

  const typo = createWhatsAppProvider({ env: { WHATSAPP_PROVIDER: 'metta' }, logger: quiet });
  assert.deepEqual([typo.configured, typo.setup.reason, typo.setup.wanted], [false, 'unknown_provider', 'metta']);

  const prodFake = createWhatsAppProvider({ env: { WHATSAPP_PROVIDER: 'fake', NODE_ENV: 'production' }, logger: quiet });
  assert.deepEqual([prodFake.configured, prodFake.setup.reason], [false, 'dev_only_provider'], 'the fake provider never runs in production');
  assert.equal(createWhatsAppProvider({ env: { WHATSAPP_PROVIDER: 'fake' }, logger: quiet }).name, 'fake');

  // A real adapter plugs in by name; its credentials come only from the environment.
  let given = null;
  registerWhatsAppProvider('spec_real', ({ env }) => { given = env.SPEC_WA_KEY; return { ...createFakeWhatsAppProvider(), name: 'spec_real' }; }, { requiredEnv: ['SPEC_WA_KEY', 'SPEC_WA_NUMBER'] });
  const missing = createWhatsAppProvider({ env: { WHATSAPP_PROVIDER: 'spec_real', SPEC_WA_KEY: 's3cret-value' }, logger: quiet });
  assert.deepEqual([missing.configured, missing.setup.reason, missing.setup.missing], [false, 'missing_credentials', ['SPEC_WA_NUMBER']]);
  assert.ok(!JSON.stringify(missing.setup).includes('s3cret-value'), 'names of missing variables only, never values');
  const real = createWhatsAppProvider({ env: { WHATSAPP_PROVIDER: 'Spec_Real', SPEC_WA_KEY: 'k', SPEC_WA_NUMBER: 'n' }, logger: quiet });
  assert.deepEqual([real.name, real.configured, given], ['spec_real', true, 'k']);
});

test('with no provider configured, WhatsApp messages are skipped, not failed', async () => {
  const off = createWhatsAppChannelService({ db, provider: createWhatsAppProvider({ env: {}, logger: quiet }), settingsTtlMs: 0, logger: quiet });
  assert.equal(off.available(), false);
  assert.deepEqual(await off.deliver({ id: 'x', memberId: w.neema, category: 'transactional' }), { skipped: 'whatsapp_not_configured' });
  const noChannel = createDeliveryService({ db, notificationService: {}, campaignService: campaigns, logger: quiet });
  const row = { id: uid('cmm'), memberId: w.neema, channel: 'whatsapp', category: 'transactional', attempts: 1 };
  assert.equal(await noChannel.deliver(row), 'skipped');
});

// ── campaigns and delivery ────────────────────────────────────────────────

test('a WhatsApp campaign sends the approved template, in each member\'s language, with their values', async () => {
  const c = await sendFromTemplate('renewal_reminder');
  const neema = c.of(w.neema);
  assert.equal(neema.status, 'queued');
  assert.deepEqual(neema.payload.templateName, 'fitflex_renewal_reminder');
  assert.equal(neema.payload.language, 'en');
  assert.deepEqual(neema.payload.parameters.slice(0, 2), ['Neema', 'Kilele Gym'], 'in the order the template numbers them');
  assert.match(neema.payload.parameters[2], /^\d\d\/\d\d\/\d{4}$/);
  const juma = c.of(w.juma);
  assert.deepEqual([juma.payload.language, juma.locale], ['sw', 'sw']);
  assert.match(juma.body, /^Habari Juma, kikumbusho kutoka Kilele Gym/);
  assert.equal(c.of(w.nophone).skipReason, 'no_phone');

  const r = await dispatch(neema);
  assert.equal(r, 'sent');
  const after = await reload(neema.id);
  assert.equal(after.status, 'sent');
  assert.match(after.providerMessageId, /^fake_/);
  const out = fake.sent.find(s => s.providerMessageId === after.providerMessageId);
  assert.deepEqual([out.to, out.templateName, out.language, out.reference, out.category],
    ['+255712345678', 'fitflex_renewal_reminder', 'en', neema.id, 'transactional'], 'E.164 number; our ledger id as the reference');
});

test('WhatsApp carries the approved wording, not the sender\'s edits, and falls back to an approved language', async () => {
  await db('WhatsAppTemplate').where({ provider: provider.name, providerTemplateName: 'fitflex_membership_expiring', language: 'sw' })
    .update({ approvalStatus: 'pending' });
  const tpl = await templates.contentFromTemplate(w.A, systemTemplateId('membership_expiring'), { locale: 'en' });
  const c = await sendFromTemplate('membership_expiring', {
    // English only, edited by the sender.
    content: { ...tpl.content, body: 'Hi {{member_name}}, we edited this — renew soon!', translations: undefined },
    channels: ['in_app', 'whatsapp'],
  });
  const rows = c.rows.filter(r => r.memberId === w.juma);
  const inApp = rows.find(r => r.channel === 'in_app');
  const wa = rows.find(r => r.channel === 'whatsapp');
  assert.equal(inApp.body, 'Hi Juma, we edited this — renew soon!', 'the app shows the sender\'s text');
  assert.equal(wa.payload.language, 'en', 'Swahili isn\'t approved yet, so English');
  assert.match(wa.body, /^Hi Juma, your Monthly plan at Kilele Gym ends on/, 'the ledger records what WhatsApp actually carries');
  await db('WhatsAppTemplate').where({ provider: provider.name, providerTemplateName: 'fitflex_membership_expiring', language: 'sw' })
    .update({ approvalStatus: 'approved' });
});

test('provider results: bad numbers fail for good, outages are retried, a provider opt-out stops WhatsApp for that member', async () => {
  const c = await sendFromTemplate('renewal_reminder');
  assert.equal(await dispatch(c.of(w.gone)), 'failed');
  const gone = await reload(c.of(w.gone).id);
  assert.deepEqual([gone.status, gone.failureReason, gone.failurePermanent], ['failed', 'invalid_recipient', true]);

  assert.equal(await dispatch(c.of(w.busy)), 'retry');
  const busy = await reload(c.of(w.busy).id);
  assert.deepEqual([busy.status, busy.failureReason], ['queued', 'provider_unavailable']);
  assert.ok(busy.nextAttemptAt > new Date());

  assert.equal(await dispatch(c.of(w.stopped)), 'skipped');
  assert.equal((await reload(c.of(w.stopped).id)).skipReason, 'whatsapp_opted_out');
  const prefs = await db('CommunicationPreference').where({ id: w.stopped }).first();
  assert.ok(prefs.whatsappOptedOutAt);
  assert.deepEqual([prefs.whatsappMarketing, prefs.whatsappTransactional], [false, false]);

  assert.equal(c.of(w.bad).skipReason, 'invalid_phone', 'an unusable number is skipped when the campaign is sent');
});

test('right before sending, WhatsApp is checked again: kill switch, opt-out and template approval', async () => {
  const c = await sendFromTemplate('renewal_reminder');
  await channel.setEnabled(w.owner, false);
  assert.equal(channel.available(), false);
  assert.equal(await dispatch(c.of(w.neema)), 'skipped');
  assert.equal((await reload(c.of(w.neema).id)).skipReason, 'whatsapp_disabled');
  await channel.setEnabled(w.owner, true);

  await db('CommunicationPreference').where({ id: w.juma }).update({ whatsappTransactional: false });
  assert.equal(await dispatch(c.of(w.juma)), 'skipped');
  assert.equal((await reload(c.of(w.juma).id)).skipReason, 'whatsapp_transactional_off');
  await db('CommunicationPreference').where({ id: w.juma }).update({ whatsappTransactional: true });

  const again = await sendFromTemplate('renewal_reminder');
  await db('WhatsAppTemplate').where({ provider: provider.name, providerTemplateName: 'fitflex_renewal_reminder', language: 'en' })
    .update({ approvalStatus: 'paused' });
  assert.equal(await dispatch(again.of(w.neema)), 'skipped');
  assert.equal((await reload(again.of(w.neema).id)).skipReason, 'whatsapp_template_not_approved');
  await db('WhatsAppTemplate').where({ provider: provider.name, providerTemplateName: 'fitflex_renewal_reminder', language: 'en' })
    .update({ approvalStatus: 'approved' });
});

test('marketing on WhatsApp reaches only members who opted in', async () => {
  const c = await sendFromTemplate('discount_offer', { templateValues: { discount: '20%', offerName: 'Rafiki' } });
  assert.equal(c.of(w.neema).skipReason, 'whatsapp_marketing_not_opted_in');
  const offers = c.of(w.offers);
  assert.equal(offers.status, 'queued');
  assert.deepEqual([offers.payload.language, offers.payload.parameters], ['sw', ['Offers', '20%', 'Rafiki', 'Kilele Gym']]);
});

test('the kill switch is shared: another server sees it', async () => {
  const other = createWhatsAppChannelService({ db, provider, settingsTtlMs: 0, logger: quiet });
  await channel.setEnabled(w.owner, false);
  assert.equal(await other.isEnabled(), false);
  assert.equal((await other.status()).available, false);
  await channel.setEnabled(w.owner, true);
  assert.equal(await other.isEnabled(), true);
  assert.equal((await channel.setEnabled(w.owner, 'yes')).error, 'invalid_enabled');
});

// ── webhook ───────────────────────────────────────────────────────────────

test('delivery receipts move the ledger forward, never back', async () => {
  const c = await sendFromTemplate('renewal_reminder');
  await dispatch(c.of(w.neema));
  const { providerMessageId } = await reload(c.of(w.neema).id);
  const hook = (statuses, messages = []) => channel.handleWebhook({ body: { statuses, messages } });

  let r = await hook([{ id: providerMessageId, status: 'delivered', timestamp: Math.floor(Date.now() / 1000) }, { id: 'unknown_id', status: 'delivered' }]);
  assert.deepEqual([r.statuses, r.unknown], [1, 1]);
  let row = await reload(c.of(w.neema).id);
  assert.equal(row.status, 'delivered');
  assert.ok(row.deliveredAt);

  await hook([{ id: providerMessageId, status: 'read' }]);
  row = await reload(c.of(w.neema).id);
  assert.equal(row.status, 'read');
  assert.ok(row.openedAt);

  await hook([{ id: providerMessageId, status: 'delivered' }, { id: providerMessageId, status: 'failed', error: 'late' }]);
  assert.equal((await reload(c.of(w.neema).id)).status, 'read', 'a late or repeated receipt changes nothing');

  await dispatch(c.of(w.juma));
  const juma = await reload(c.of(w.juma).id);
  await hook([{ id: juma.providerMessageId, status: 'failed', error: 'undeliverable' }]);
  const failed = await reload(juma.id);
  assert.deepEqual([failed.status, failed.failureReason, failed.failurePermanent], ['failed', 'undeliverable', true]);
});

test('STOP or ACHA opts the member out of all WhatsApp messages, stops queued ones, and is confirmed in their language', async () => {
  const c = await sendFromTemplate('renewal_reminder');
  const sentBefore = fake.sent.length;
  const r = await channel.handleWebhook({ body: { messages: [{ from: '+255713111222', text: ' acha! ' }, { from: '+255712345678', text: 'thanks' }] } });
  assert.deepEqual([r.optedOut, r.ignored], [1, 1]);
  const prefs = await db('CommunicationPreference').where({ id: w.juma }).first();
  assert.ok(prefs.whatsappOptedOutAt);
  assert.deepEqual([prefs.whatsappTransactional, prefs.whatsappMarketing], [false, false]);
  assert.equal((await reload(c.of(w.juma).id)).skipReason, 'whatsapp_opted_out', 'already queued: skipped');
  assert.equal((await reload(c.of(w.neema).id)).status, 'queued', 'other members untouched');
  const confirmation = fake.sent.slice(sentBefore).find(s => s.kind === 'text');
  assert.deepEqual(confirmation.to, '+255713111222');
  assert.match(confirmation.text, /^Hutapokea tena ujumbe wa WhatsApp/);

  const next = await sendFromTemplate('renewal_reminder');
  assert.equal(next.of(w.juma).skipReason, 'whatsapp_opted_out');

  await channel.handleWebhook({ body: { messages: [{ from: '0713 111 222', text: 'Anza' }] } });
  const back = await db('CommunicationPreference').where({ id: w.juma }).first();
  assert.equal(back.whatsappOptedOutAt, null);
  assert.deepEqual([back.whatsappTransactional, back.whatsappMarketing], [true, false], 'offers stay off until turned on in the app');
});

test('a malformed webhook body is ignored, not trusted', async () => {
  assert.deepEqual(parseStandardWebhook({ body: 'nope' }), { statuses: [], inbound: [] });
  const r = parseStandardWebhook({ body: { statuses: [{ id: 'x', status: 'hacked' }, { status: 'delivered' }], messages: [{ from: 5, text: 'STOP' }] } });
  assert.deepEqual(r, { statuses: [], inbound: [] });
  const broken = createWhatsAppChannelService({ db, provider: { ...provider, parseWebhook: () => { throw new Error('bad signature'); } }, logger: quiet });
  assert.equal((await broken.handleWebhook({ body: {} })).error, 'bad_webhook');
});

// ── admin ─────────────────────────────────────────────────────────────────

test('admin status and registry: what each FitFlex template needs, and registering one', async () => {
  const s = await channel.status();
  assert.deepEqual([s.provider.name, s.provider.configured, s.enabled, s.available], [provider.name, true, true, true]);
  assert.equal(s.templates.approved, 36);
  assert.ok(s.members.withPhone >= 7);
  assert.equal(typeof s.webhook.secretSet, 'boolean');

  const reg = await channel.registry();
  assert.equal(reg.expected.length, 36);
  const need = reg.expected.find(e => e.providerTemplateName === 'fitflex_discount_offer' && e.language === 'sw');
  assert.deepEqual([need.category, need.variables, need.registered.approvalStatus], ['marketing', ['member_name', 'discount', 'offer_name', 'gym_name'], 'approved']);

  assert.equal((await channel.registerTemplate(w.owner, { providerTemplateName: 'Bad Name', language: 'en', category: 'utility' })).error, 'invalid_template_name');
  assert.equal((await channel.registerTemplate(w.owner, { providerTemplateName: 'x_y', language: 'fr', category: 'utility' })).error, 'invalid_language');
  assert.equal((await channel.registerTemplate(w.owner, { providerTemplateName: 'x_y', language: 'en', category: 'utility', variables: ['shoe_size'] })).error, 'invalid_variables');
  const created = await channel.registerTemplate(w.owner, { providerTemplateName: 'fitflex_spec_extra', language: 'en', category: 'utility', variables: ['member_name'] });
  assert.deepEqual([created.template.provider, created.template.approvalStatus], [provider.name, 'pending']);
  const again = await channel.registerTemplate(w.owner, { providerTemplateName: 'fitflex_spec_extra', language: 'en', category: 'utility', approvalStatus: 'approved' });
  assert.equal(again.template.id, created.template.id, 'registering again updates the same row');
  const paused = await channel.updateTemplate(w.owner, created.template.id, { approvalStatus: 'paused' });
  assert.equal(paused.template.approvalStatus, 'paused');
  assert.equal((await channel.updateTemplate(w.owner, created.template.id, { approvalStatus: 'maybe' })).error, 'invalid_approval_status');
  assert.equal((await channel.updateTemplate(w.owner, 'wat_nope', {})).error, 'not_found');
});

test('admin test send: only approved templates, only while WhatsApp is on', async () => {
  const ok = await channel.sendTest(w.owner, { phone: '0716 123 456', templateName: 'fitflex_renewal_reminder', language: 'en', parameters: ['Test', 'Kilele Gym', '01/01/2027'] });
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.equal(fake.sent.at(-1).to, '+255716123456');
  assert.equal((await channel.sendTest(w.owner, { phone: '12', templateName: 'fitflex_renewal_reminder', language: 'en' })).error, 'invalid_phone');
  assert.equal((await channel.sendTest(w.owner, { phone: '0716 123 456', templateName: 'fitflex_nope', language: 'en' })).error, 'whatsapp_template_not_approved');
  await channel.setEnabled(w.owner, false);
  assert.equal((await channel.sendTest(w.owner, { phone: '0716 123 456', templateName: 'fitflex_renewal_reminder', language: 'en' })).error, 'whatsapp_disabled');
  await channel.setEnabled(w.owner, true);
  const off = createWhatsAppChannelService({ db, provider: createWhatsAppProvider({ env: {}, logger: quiet }), logger: quiet });
  assert.equal((await off.sendTest(w.owner, {})).error, 'whatsapp_not_configured');
  assert.equal((await off.syncTemplates(w.owner)).error, 'whatsapp_not_configured');
});
