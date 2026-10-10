// SMS in the backend (moved from the Supabase edge functions): the Beem
// client, choosing the provider from the environment, the log with its
// send-once keys, SMS as a campaign channel, the session and renewal
// reminders, the admin routes' use cases and the verification-code log.
// Runs on the fake provider; Beem itself is called through a stub fetch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { communicationPreferences, deviceTokens, communicationCampaigns, communicationTemplates, gyms } from '../src/bootstrap/collections.mjs';
import { createSegmentService } from '../src/services/segment-service.mjs';
import { createCampaignService } from '../src/services/campaign-service.mjs';
import { createTemplateService } from '../src/services/template-service.mjs';
import { createDeliveryService } from '../src/services/delivery-service.mjs';
import { createCommunicationPreferenceService } from '../src/services/communication-preference-service.mjs';
import { createCommunicationHistoryService } from '../src/services/communication-history-service.mjs';
import { createSmsService, smsText, SMS_MAX_LENGTH, REMINDER_MAX_ATTEMPTS } from '../src/services/sms-service.mjs';
import { createSmsProvider, createFakeSmsProvider, createBeemSmsProvider } from '../src/integrations/sms/provider.mjs';
import { beemSend, beemSettings, beemCredentialShape, BEEM_SEND_URL } from '../src/integrations/sms/beem.mjs';
import { channelAllowed, CHANNELS } from '../src/shared/communications.mjs';

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const at = (days) => new Date(Date.now() + days * 86_400_000);
const made = { users: [], gyms: [], trainers: [], phones: [] };
const w = {};
const quiet = { warn() {}, error() {} };

const provider = createFakeSmsProvider();
const sms = createSmsService({ db, provider, logger: quiet, gymsWithReminders: async () => w.ownReminders || new Set() });
const templates = createTemplateService({ db, templates: communicationTemplates, gyms });
const segments = createSegmentService({ db, communicationPreferences, deviceTokens, pushAvailable: () => false, smsAvailable: () => sms.available() });
const campaigns = createCampaignService({ db, campaigns: communicationCampaigns, gyms, segmentService: segments, auditLog: null, templateService: templates });
const delivery = createDeliveryService({ db, notificationService: {}, campaignService: campaigns, smsChannel: sms, logger: quiet });
const preferences = createCommunicationPreferenceService({ preferences: communicationPreferences, smsAvailable: () => sms.available() });

// Every test number is unique to this run, so log rows never mix.
const phone = () => {
  const p = `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  made.phones.push(`+255${p.slice(1)}`);
  return p;
};
const e164 = (local) => `+255${local.slice(1)}`;

async function user(fields) {
  const id = uid('usr');
  await db('User').insert({ id, userType: 'member', updatedAt: new Date(), ...fields });
  made.users.push(id);
  return id;
}
async function member(displayName, number, prefs = null, sub = {}) {
  const id = await user({ displayName, phone: number });
  await db('Subscription').insert({
    id: uid('sub'), memberId: id, type: 'direct_sub', plan: 'monthly', status: 'active', homeGymId: w.gym,
    startedAt: at(-25), cycleStartedAt: at(-25), renewsAt: at(10), expiresAt: at(10), ...sub,
  });
  if (prefs) await db('CommunicationPreference').insert({ id, ...prefs, updatedAt: new Date() });
  return id;
}
const logsOf = (userId) => db('SmsLog').where({ userId }).orderBy('createdAt');
const textsTo = (number) => provider.sent.filter(s => s.to.includes(e164(number))).map(s => s.text);
const dispatch = async (row) => delivery.deliver({ ...row, attempts: (row.attempts || 0) + 1 });
const reload = (id) => db('CommunicationMessage').where({ id }).first();

before(async () => {
  w.gym = uid('gym');
  await db('Gym').insert({ id: w.gym, name: 'Kilele Gym', tier: 'standard', location: uid('Moshi'), updatedAt: new Date() });
  made.gyms.push(w.gym);
  w.owner = await user({ userType: 'gym_operator', gymIds: [w.gym] });
  w.A = { senderType: 'gym', owner: { id: w.owner, gymIds: [w.gym] }, actorId: w.owner };
});

after(async () => {
  if (made.users.length) await db('SmsLog').whereIn('userId', made.users).del();
  if (made.phones.length) await db('SmsLog').whereIn('phone', made.phones).del();
  if (made.trainers.length) await db('TrainerProfile').whereIn('id', made.trainers).del();
  if (made.gyms.length) await db('Gym').whereIn('id', made.gyms).del();
  if (made.users.length) await db('User').whereIn('id', made.users).del();
});

// ── Beem and the provider registry ─────────────────────────────────────────

const stubFetch = (status, body, seen = []) => async (url, init) => {
  seen.push({ url, init, body: JSON.parse(init.body) });
  return { ok: status >= 200 && status < 300, status, statusText: 'x', json: async () => body };
};

test('Beem: one request per send, Basic auth, numbers without the "+", and its answers told apart', async () => {
  const seen = [];
  const creds = { apiKey: 'key', secretKey: 'secret', sender: 'INFO', text: 'Hello', to: ['+255712345678', '+255713111222'] };
  const ok = await beemSend({ ...creds, fetchImpl: stubFetch(200, { successful: true, request_id: 4821, code: 100, valid: 2 }, seen) });
  assert.deepEqual(ok, { ok: true, requestId: '4821' });
  assert.equal(seen[0].url, BEEM_SEND_URL);
  assert.equal(seen[0].init.headers.Authorization, `Basic ${Buffer.from('key:secret').toString('base64')}`);
  assert.deepEqual(seen[0].body, {
    source_addr: 'INFO', encoding: 0, schedule_time: '', message: 'Hello',
    recipients: [{ recipient_id: 1, dest_addr: '255712345678' }, { recipient_id: 2, dest_addr: '255713111222' }],
  });

  // Wrong key or secret: Beem's own code and words come back, and it is not worth retrying.
  const refused = await beemSend({ ...creds, fetchImpl: stubFetch(401, { code: 120, message: 'Invalid Authentication Parameters' }) });
  assert.deepEqual(refused, { ok: false, error: 'provider_rejected', retryable: false, code: 120, message: 'Invalid Authentication Parameters' });
  assert.equal((await beemSend({ ...creds, fetchImpl: stubFetch(200, { successful: true, valid: 0 }) })).ok, false, 'no valid number');
  assert.equal((await beemSend({ ...creds, fetchImpl: stubFetch(503, {}) })).retryable, true);
  const down = await beemSend({ ...creds, fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  assert.deepEqual({ error: down.error, retryable: down.retryable }, { error: 'provider_unreachable', retryable: true });
});

test('a key or secret pasted with spaces, a line break or quotes is cleaned before use, and its shape can be checked', () => {
  const key = '0123456789abcdef';
  const secret = `${'Ab3+/'.repeat(17)}Yg==`;
  for (const env of [
    { BEEM_API_KEY: key, BEEM_SECRET_KEY: secret },
    { BEEM_API_KEY: ` ${key}\n`, BEEM_SECRET_KEY: `"${secret}"` },
    { BEEM_API_KEY: `'${key}'`, BEEM_SECRET_KEY: `\t${secret} \r\n` },
  ]) {
    const s = beemSettings(env);
    assert.deepEqual([s.apiKey, s.secretKey], [key, secret]);
  }
  assert.equal(beemSettings({ BEEM_API_KEY: '""', BEEM_SECRET_KEY: secret }), null);

  const good = beemCredentialShape({ BEEM_API_KEY: key, BEEM_SECRET_KEY: secret });
  assert.deepEqual(good.apiKey, { set: true, length: 16, hadPadding: false, spaceInside: false, looksRight: true });
  assert.deepEqual(good.secretKey, { set: true, length: 89, hadPadding: false, spaceInside: false, looksRight: true });
  const odd = beemCredentialShape({ BEEM_API_KEY: `"${key}" `, BEEM_SECRET_KEY: `${secret}${secret}` });
  assert.deepEqual([odd.apiKey.hadPadding, odd.apiKey.looksRight, odd.secretKey.looksRight], [true, true, false], 'a secret pasted twice does not look right');
  assert.equal(beemCredentialShape({ BEEM_API_KEY: 'xxx' }).apiKey.looksRight, false);
  assert.deepEqual(beemCredentialShape({}).secretKey, { set: false, length: 0, hadPadding: false, spaceInside: false, looksRight: false });
  assert.ok(!JSON.stringify(good).includes(key) && !JSON.stringify(good).includes(secret), 'never the values');
});

test('the provider comes from SMS_PROVIDER; anything unknown, incomplete or dev-only in production stays off', () => {
  const pick = (env) => createSmsProvider({ env, logger: quiet });
  assert.deepEqual(pick({}).setup, { reason: 'no_provider', wanted: null, missing: [] });
  assert.equal(pick({}).configured, false);
  assert.equal(pick({ SMS_PROVIDER: 'pigeon' }).setup.reason, 'unknown_provider');
  assert.deepEqual(pick({ SMS_PROVIDER: 'beem', BEEM_API_KEY: 'k' }).setup, { reason: 'missing_credentials', wanted: 'beem', missing: ['BEEM_SECRET_KEY'] });
  assert.equal(pick({ SMS_PROVIDER: 'fake', NODE_ENV: 'production' }).setup.reason, 'dev_only_provider');
  assert.equal(pick({ SMS_PROVIDER: 'fake' }).configured, true);

  const env = { SMS_PROVIDER: ' Beem ', BEEM_API_KEY: 'k', BEEM_SECRET_KEY: 's' };
  assert.deepEqual({ name: pick(env).name, configured: pick(env).configured, sender: pick(env).sender }, { name: 'beem', configured: true, sender: 'INFO' });
  assert.equal(pick({ ...env, VERIFICATION_SMS_SENDER_ID: 'FitFlexOTP' }).sender, 'FitFlexOTP');
  assert.equal(pick({ ...env, VERIFICATION_SMS_SENDER_ID: 'FitFlexOTP', BEEM_SENDER_ID: 'FITFLEX' }).sender, 'FITFLEX');
});

test('the Beem provider sends through the Beem client and hands back its request id', async () => {
  const seen = [];
  const beem = createBeemSmsProvider({ env: { BEEM_API_KEY: 'k', BEEM_SECRET_KEY: 's', BEEM_SENDER_ID: 'FITFLEX' }, fetchImpl: stubFetch(200, { successful: true, request_id: 7 }, seen) });
  assert.deepEqual(await beem.send({ to: ['+255712345678'], text: 'Hi' }), { ok: true, providerMessageId: '7' });
  assert.equal(seen[0].body.source_addr, 'FITFLEX');
});

// ── the text of a campaign SMS ─────────────────────────────────────────────

test('a campaign SMS says who it is from, fits two parts, and offers say how to stop them', () => {
  assert.equal(smsText({ body: 'Your plan ends\n on 12 Oct.', gymName: 'Kilele Gym' }), 'FitFlex x Kilele Gym: Your plan ends on 12 Oct.');
  assert.equal(smsText({ body: 'New gyms near you.' }), 'FitFlex: New gyms near you.');
  assert.equal(smsText({ body: 'FitFlex: already named.' }), 'FitFlex: already named.');
  assert.equal(smsText({ body: '20% off.', category: 'marketing', locale: 'sw' }), 'FitFlex: 20% off. Kujiondoa: App > Settings.');
  assert.equal(smsText({ body: '20% off.', category: 'marketing' }), 'FitFlex: 20% off. Opt out: App > Settings.');
  const long = smsText({ body: 'x'.repeat(1000), gymName: 'Kilele Gym', category: 'marketing' });
  assert.equal(long.length, SMS_MAX_LENGTH);
  assert.ok(long.endsWith('… Opt out: App > Settings.'));
});

// ── sending and the log ────────────────────────────────────────────────────

test('every send is logged; a bad number is skipped; a key sends once; a failure is tried again, a few times', async () => {
  const [good, other] = [phone(), phone()];
  const key = uid('key');
  const first = await sms.send({ category: 'reminder', text: 'One', recipients: [
    { phone: good, dedupeKey: key }, { phone: '12' }, { phone: null }, { phone: other },
  ] });
  assert.deepEqual({ sent: first.sent, failed: first.failed, skipped: first.skipped }, { sent: 2, failed: 0, skipped: 2 });
  assert.deepEqual(first.results.map(r => r.reason ?? r.outcome), ['sent', 'invalid_phone', 'no_phone', 'sent']);
  assert.deepEqual(provider.sent.at(-1), { to: [e164(good), e164(other)], text: 'One' }, 'one request for both numbers');
  const row = await db('SmsLog').where({ dedupeKey: key }).first();
  assert.deepEqual({ phone: row.phone, category: row.category, message: row.message, status: row.status, provider: row.provider, attempts: row.attempts },
    { phone: e164(good), category: 'reminder', message: 'One', status: 'accepted', provider: 'fake', attempts: 1 });
  assert.ok(row.providerMessageId);

  // Asked again with the same key: nothing goes out.
  const before = provider.sent.length;
  const again = await sms.send({ category: 'reminder', text: 'One', recipients: [{ phone: good, dedupeKey: key }] });
  assert.deepEqual({ sent: again.sent, skipped: again.skipped, reason: again.results[0].reason }, { sent: 0, skipped: 1, reason: 'duplicate' });
  assert.equal(provider.sent.length, before);

  // A send the provider refused (say, a wrong key) is not lost: later runs try it again.
  const failing = uid('key');
  provider.failWith = { error: 'provider_rejected', retryable: false, code: 120, message: 'Invalid Authentication Parameters' };
  for (let i = 1; i <= REMINDER_MAX_ATTEMPTS; i += 1) {
    const r = await sms.send({ category: 'reminder', text: 'Two', recipients: [{ phone: good, dedupeKey: failing }] });
    assert.equal(r.failed, 1, `attempt ${i}`);
  }
  const failed = await db('SmsLog').where({ dedupeKey: failing }).first();
  assert.deepEqual({ status: failed.status, attempts: failed.attempts, providerCode: failed.providerCode, error: failed.error },
    { status: 'failed', attempts: REMINDER_MAX_ATTEMPTS, providerCode: 120, error: 'provider_rejected: Invalid Authentication Parameters' });
  assert.equal((await sms.send({ category: 'reminder', text: 'Two', recipients: [{ phone: good, dedupeKey: failing }] })).skipped, 1, 'gives up after the last attempt');

  // …and goes through once the provider is fixed.
  const fixed = uid('key');
  await sms.send({ category: 'reminder', text: 'Three', recipients: [{ phone: good, dedupeKey: fixed }] });
  provider.failWith = null;
  assert.equal((await sms.send({ category: 'reminder', text: 'Three', recipients: [{ phone: good, dedupeKey: fixed }] })).sent, 1);
  assert.deepEqual(await db('SmsLog').where({ dedupeKey: fixed }).first('status', 'attempts', 'error'), { status: 'accepted', attempts: 2, error: null });
});

test('more numbers than the provider takes at once go out in several requests', async () => {
  const small = { ...createFakeSmsProvider(), maxRecipients: 2 };
  const calls = [];
  small.send = async ({ to }) => { calls.push(to.length); return { ok: true, providerMessageId: `b${calls.length}` }; };
  const service = createSmsService({ db, provider: small, logger: quiet });
  const r = await service.send({ category: 'test', text: 'Batch', recipients: [phone(), phone(), phone(), phone(), phone()].map(p => ({ phone: p })) });
  assert.equal(r.sent, 5);
  assert.deepEqual(calls, [2, 2, 1]);
});

test('with no provider nothing is sent or logged', async () => {
  const off = createSmsService({ db, provider: createSmsProvider({ env: {}, logger: quiet }), logger: quiet });
  const number = phone();
  const r = await off.send({ category: 'reminder', text: 'Off', recipients: [{ phone: number }] });
  assert.deepEqual({ sent: r.sent, skipped: r.skipped, reason: r.results[0].reason }, { sent: 0, skipped: 1, reason: 'sms_not_configured' });
  assert.equal(await db('SmsLog').where({ phone: e164(number) }).first(), undefined);
  assert.equal((await off.sendDueReminders()).skipped, 'sms_not_configured');
  assert.deepEqual(await off.testSend({ phone: number }), { error: 'sms_not_configured', status: 503 });
  assert.deepEqual(await off.deliver({ id: 'x', memberId: 'nobody', category: 'transactional' }), { skipped: 'sms_not_configured' });
});

// ── a member's SMS choices ─────────────────────────────────────────────────

test('SMS is a channel: service messages on unless switched off, offers only after opting in', async () => {
  assert.ok(CHANNELS.includes('sms'));
  assert.deepEqual(channelAllowed(null, 'sms', 'transactional'), { allowed: true });
  assert.deepEqual(channelAllowed(null, 'sms', 'marketing'), { allowed: false, reason: 'sms_marketing_not_opted_in' });
  assert.deepEqual(channelAllowed({ smsTransactional: false }, 'sms', 'transactional'), { allowed: false, reason: 'sms_transactional_off' });
  assert.deepEqual(channelAllowed({ smsMarketing: true }, 'sms', 'marketing'), { allowed: true });
  assert.deepEqual(channelAllowed({ smsMarketing: true, smsOptedOutAt: new Date() }, 'sms', 'marketing'), { allowed: false, reason: 'sms_opted_out' });
  // WhatsApp's switches are its own.
  assert.equal(channelAllowed({ smsMarketing: true }, 'whatsapp', 'marketing').reason, 'whatsapp_marketing_not_opted_in');

  const id = await user({ displayName: 'Chooser', phone: phone() });
  const start = (await preferences.get(id)).preferences;
  assert.deepEqual({ t: start.smsTransactional, m: start.smsMarketing, out: start.smsOptedOut, on: start.smsAvailable }, { t: true, m: false, out: false, on: true });
  const on = await preferences.update(id, { smsMarketing: true });
  assert.equal(on.preferences.smsMarketing, true);
  const row = await db('CommunicationPreference').where({ id }).first();
  assert.ok(row.smsMarketingConsentAt, 'when the member agreed');
  assert.equal(row.smsMarketingConsentSource, 'app_settings');
  assert.equal(row.whatsappMarketingConsentAt, null);
  assert.equal((await preferences.update(id, { smsTransactional: false })).preferences.smsTransactional, false);
  assert.equal((await preferences.update(id, { smsMarketing: 'yes' })).error, 'invalid_preference');
});

// ── SMS as a campaign channel ──────────────────────────────────────────────

test('a gym offer by SMS reaches only members who opted in, with the gym named and how to stop', async () => {
  const [inNumber, outNumber] = [phone(), phone()];
  const optedIn = await member('Neema Opted', inNumber, { smsMarketing: true, locale: 'sw' });
  const notOpted = await member('Juma Quiet', outNumber);
  const noPhone = await member('Rehema', null, { smsMarketing: true });
  const badPhone = await member('Bad Number', '12', { smsMarketing: true });

  const preview = await segments.previewAudience({ sender: { senderType: 'gym', owner: w.A.owner, gymId: w.gym }, preset: 'active', purpose: 'promotion' });
  assert.deepEqual(preview.channels.sms, { eligible: 1, excluded: { sms_marketing_not_opted_in: 1, no_phone: 1, invalid_phone: 1 } });

  const c = await campaigns.create(w.A, {
    purpose: 'promotion', audience: { preset: 'active' }, channels: ['sms'],
    content: { title: 'October Deal', body: 'Hi {{member_name}}, 20% off this week at {{gym_name}}.', deepLink: 'gym' },
  });
  assert.ok(c.campaign, JSON.stringify(c));
  const sent = await campaigns.send(w.A, c.campaign.id, { sendRequestId: uid('req') });
  assert.ok(sent.campaign, JSON.stringify(sent));
  const rows = await db('CommunicationMessage').where({ campaignId: c.campaign.id });
  const of = (m) => rows.find(r => r.memberId === m);
  assert.deepEqual([of(optedIn).status, of(notOpted).skipReason, of(noPhone).skipReason, of(badPhone).skipReason],
    ['queued', 'sms_marketing_not_opted_in', 'no_phone', 'invalid_phone']);

  assert.equal(await dispatch(of(optedIn)), 'sent');
  assert.deepEqual(textsTo(inNumber), ['FitFlex x Kilele Gym: Hi Neema Opted, 20% off this week at Kilele Gym. Opt out: App > Settings.']);
  const done = await reload(of(optedIn).id);
  assert.equal(done.status, 'sent');
  assert.ok(done.providerMessageId);
  const [log] = await logsOf(optedIn);
  assert.deepEqual({ category: log.category, status: log.status, dedupeKey: log.dedupeKey }, { category: 'campaign', status: 'accepted', dedupeKey: `cmm:${of(optedIn).id}` });

  // The campaign's history names SMS as the way it went, with the provider's reference.
  const history = await createCommunicationHistoryService({ db }).recipients(w.A, c.campaign.id, {});
  const mine = history.recipients.find(r => r.memberId === optedIn).channels[0];
  assert.deepEqual([mine.channel, mine.status, mine.provider], ['sms', 'sent', { name: 'sms', messageId: done.providerMessageId }]);

  // The dispatcher taking the same row again (a crash before the ledger update) does not text twice.
  assert.equal(await dispatch(of(optedIn)), 'sent');
  assert.equal(textsTo(inNumber).length, 1);
  assert.equal(textsTo(outNumber).length, 0);
});

test('at delivery: a member who has since switched SMS off is skipped; a busy provider is retried, a refusal is final', async () => {
  const [a, b, c2] = [phone(), phone(), phone()];
  const changed = await member('Changed Mind', a, { smsMarketing: true });
  const retried = await member('Retry Me', b, { smsMarketing: true });
  const refused = await member('Refused', c2, { smsMarketing: true });
  const made2 = await campaigns.create(w.A, {
    purpose: 'promotion', audience: { preset: 'active' }, channels: ['sms'],
    content: { title: 'Deal', body: 'Deal for {{member_name}}.', deepLink: 'gym' },
  });
  assert.ok(made2.campaign, JSON.stringify(made2));
  assert.ok((await campaigns.send(w.A, made2.campaign.id, { sendRequestId: uid('req') })).campaign);
  const rows = await db('CommunicationMessage').where({ campaignId: made2.campaign.id });
  const of = (m) => rows.find(r => r.memberId === m);

  await db('CommunicationPreference').where({ id: changed }).update({ smsMarketing: false });
  assert.equal(await dispatch(of(changed)), 'skipped');
  assert.equal((await reload(of(changed).id)).skipReason, 'sms_marketing_not_opted_in');

  provider.failWith = { error: 'provider_rejected', retryable: true, code: 503, message: 'busy' };
  assert.equal(await dispatch(of(retried)), 'retry');
  provider.failWith = null;
  assert.equal(await dispatch({ ...(await reload(of(retried).id)) }), 'sent');
  assert.equal(textsTo(b).length, 1);
  assert.equal((await logsOf(retried))[0].attempts, 2, 'the same log row, tried twice');

  provider.failWith = { error: 'provider_rejected', retryable: false, code: 120, message: 'Invalid Authentication Parameters' };
  assert.equal(await dispatch(of(refused)), 'failed');
  provider.failWith = null;
  const row = await reload(of(refused).id);
  assert.deepEqual({ status: row.status, failureReason: row.failureReason, failurePermanent: row.failurePermanent }, { status: 'failed', failureReason: 'provider_rejected', failurePermanent: true });
});

// ── reminders ──────────────────────────────────────────────────────────────

// A session `hours` from now, as the EAT date and HH:MM a booking stores.
function slotIn(hours) {
  const eat = new Date(Date.now() + hours * 3_600_000 + 3 * 3_600_000).toISOString();
  return { date: eat.slice(0, 10), slot: eat.slice(11, 16) };
}
async function booking(memberId, hours, status = 'confirmed') {
  const id = uid('tbk');
  await db('TrainerBooking').insert({ id, memberId, trainerId: w.trainer, gymId: w.gym, ...slotIn(hours), amountTzs: 20000, status });
  return id;
}

test('a confirmed session starting within three hours is texted once, in the member\'s language', async () => {
  w.trainer = uid('trn');
  await db('TrainerProfile').insert({ id: w.trainer, displayName: 'Baraka Mushi', updatedAt: new Date() });
  made.trainers.push(w.trainer);
  const [n1, n2, n3, n4, n5] = [phone(), phone(), phone(), phone(), phone()];
  const soon = await user({ displayName: 'Asha Mrema', phone: n1 });
  const english = await user({ displayName: 'Peter Shayo', phone: n2 });
  await db('CommunicationPreference').insert({ id: english, locale: 'en', updatedAt: new Date() });
  const later = await user({ displayName: 'Later', phone: n3 });
  const unpaid = await user({ displayName: 'Unpaid', phone: n4 });
  const off = await user({ displayName: 'No Texts', phone: n5 });
  await db('CommunicationPreference').insert({ id: off, smsTransactional: false, updatedAt: new Date() });

  const soonBooking = await booking(soon, 2);
  const { slot } = slotIn(2);
  await booking(english, 1);
  await booking(later, 5);
  await booking(unpaid, 2, 'payment_pending');
  await booking(off, 2);

  const first = await sms.sendDueReminders();
  assert.ok(first.bookings.sent >= 2 && first.bookings.skipped >= 1, JSON.stringify(first));
  assert.deepEqual(textsTo(n1), [`FitFlex: Habari Asha, kipindi chako na Baraka kinaanza saa ${slot} @ Kilele Gym. Tukutane huko!`]);
  assert.match(textsTo(n2)[0], /^FitFlex: Hi Peter, your session with Baraka starts at \d\d:\d\d at Kilele Gym\. See you there!$/);
  assert.deepEqual([textsTo(n3), textsTo(n4), textsTo(n5)], [[], [], []], 'too far off, not paid for, or SMS switched off');
  const [log] = await logsOf(soon);
  assert.deepEqual({ category: log.category, dedupeKey: log.dedupeKey, status: log.status }, { category: 'reminder', dedupeKey: `booking_reminder:${soonBooking}`, status: 'accepted' });

  await sms.sendDueReminders();
  assert.equal(textsTo(n1).length, 1, 'the next run does not text again');
  assert.equal((await logsOf(soon)).length, 1);
});

test('a pass ending in three days is texted once; a gym that sends its own expiry reminders is left to it', async () => {
  const [n1, n2, n3, n4] = [phone(), phone(), phone(), phone()];
  const ends = at(2.5);
  const due = await member('Zawadi Kimaro', n1, null, { type: 'platform_pass', tier: 'gold', homeGymId: null, renewsAt: ends, expiresAt: ends });
  const notYet = await member('Not Yet', n2, null, { renewsAt: at(6), expiresAt: at(6) });
  const lapsed = await member('Lapsed', n3, null, { status: 'expired', renewsAt: ends, expiresAt: ends });
  const gymMember = await member('Gym Member', n4, null, { renewsAt: ends, expiresAt: ends });
  const sub = await db('Subscription').where({ memberId: due }).first('id');

  w.ownReminders = new Set([w.gym]);
  await sms.sendDueReminders();
  const date = ends.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Africa/Dar_es_Salaam' });
  assert.deepEqual(textsTo(n1), [`FitFlex: Habari Zawadi, pass yako inaisha ${date}. Lipia tena kwenye app ya FitFlex ili uendelee na mazoezi.`]);
  assert.deepEqual([textsTo(n2), textsTo(n3), textsTo(n4)], [[], [], []]);
  assert.equal((await logsOf(due))[0].dedupeKey, `renewal_t3:${sub.id}:${ends.toISOString().slice(0, 10)}`);

  // Without its own reminders the gym's member is FitFlex's to remind.
  w.ownReminders = new Set();
  await sms.sendDueReminders();
  assert.equal(textsTo(n4).length, 1);
  assert.equal(textsTo(n1).length, 1, 'still once');
  assert.deepEqual([(await logsOf(notYet)).length, (await logsOf(lapsed)).length, (await logsOf(gymMember)).length], [0, 0, 1]);
});

// ── admin: status, test send, log ──────────────────────────────────────────

test('the test send texts one number and, when the provider refuses, says what it answered', async () => {
  const number = phone();
  const ok = await sms.testSend({ phone: number, actorId: w.owner });
  assert.deepEqual({ ok: ok.ok, provider: ok.provider, sender: ok.sender }, { ok: true, provider: 'fake', sender: 'FAKE' });
  assert.ok(ok.to.includes('•') && !ok.to.includes(number.slice(3, 7)), 'the number is masked');
  assert.deepEqual(textsTo(number), ['FitFlex: test SMS. Your SMS provider is connected.']);
  assert.deepEqual(await sms.testSend({ phone: '12' }), { error: 'invalid_phone', status: 400 });

  provider.failWith = { error: 'provider_rejected', retryable: false, code: 120, message: 'Invalid Authentication Parameters' };
  const refused = await sms.testSend({ phone: number });
  provider.failWith = null;
  assert.deepEqual({ ok: refused.ok, reason: refused.reason, providerCode: refused.providerCode, providerMessage: refused.providerMessage },
    { ok: false, reason: 'provider_rejected', providerCode: 120, providerMessage: 'Invalid Authentication Parameters' });
});

test('the log lists what was sent, newest first, with numbers masked; status counts the last day', async () => {
  // Rows written in the same millisecond have no certain order, so space them out.
  const tick = () => new Promise(resolve => setTimeout(resolve, 5));
  const number = phone();
  await tick();
  await sms.testSend({ phone: number });
  await tick();
  provider.failWith = { error: 'provider_unreachable', retryable: true };
  await sms.testSend({ phone: number });
  provider.failWith = null;

  const all = await sms.logs({ category: 'test', limit: 2 });
  assert.equal(all.logs.length, 2);
  assert.ok(all.logs.every(l => l.phone.includes('•') && !JSON.stringify(l).includes(e164(number))));
  assert.deepEqual(all.logs.map(l => l.status), ['failed', 'accepted']);
  assert.ok(all.nextBefore, 'there are older test sends');
  const older = await sms.logs({ category: 'test', limit: 2, before: all.nextBefore });
  assert.ok(older.logs.every(l => new Date(l.createdAt) < new Date(all.nextBefore)));
  assert.ok((await sms.logs({ status: 'failed', limit: 200 })).logs.every(l => l.status === 'failed'));
  assert.equal((await sms.logs({ status: 'lost' })).error, 'invalid_status');
  assert.equal((await sms.logs({ category: 'spam' })).error, 'invalid_category');
  assert.equal((await sms.logs({ before: 'yesterday' })).error, 'invalid_before');

  const s = await sms.status();
  assert.deepEqual({ provider: s.provider, configured: s.configured, sender: s.sender }, { provider: 'fake', configured: true, sender: 'FAKE' });
  assert.ok(s.last24h.accepted >= 1 && s.last24h.failed >= 1);
});

// ── verification codes ─────────────────────────────────────────────────────

test('verification codes go out through their own sender and are logged without the code', async () => {
  const number = phone();
  const sentBy = [];
  const sender = { configured: true, send: async (to, message) => { sentBy.push({ to, ...message }); return { ok: true }; } };
  const logged = sms.verificationSender(sender);
  assert.deepEqual(await logged.send(e164(number), { text: 'FitFlex code: 482913' }), { ok: true });
  assert.deepEqual(sentBy, [{ to: e164(number), text: 'FitFlex code: 482913' }]);
  const row = await db('SmsLog').where({ phone: e164(number) }).first();
  assert.deepEqual({ category: row.category, message: row.message, status: row.status }, { category: 'otp', message: 'Verification code [redacted]', status: 'accepted' });

  const failing = sms.verificationSender({ configured: true, send: async () => ({ ok: false, error: 'provider_rejected' }) });
  assert.deepEqual(await failing.send(e164(number), { text: 'FitFlex code: 111111' }), { ok: false, error: 'provider_rejected' });
  assert.equal((await db('SmsLog').where({ phone: e164(number), status: 'failed' }).first()).error, 'provider_rejected');
  assert.ok(!(await db('SmsLog').where({ phone: e164(number) })).some(r => /\d{6}/.test(r.message)));

  // A sender that is switched off is passed through untouched.
  const offSender = { configured: false, send: async () => ({ ok: false, error: 'not_configured' }) };
  assert.equal(sms.verificationSender(offSender), offSender);
});
