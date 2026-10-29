// Marathon & running events · S5 — webhook endpoints and the dispatcher (spec §7.2, §7.4, §7.5).
// SCENARIO 13 (endpoint times out, then recovers), SCENARIO 14 (invalid signature / replayed event), SSRF at delivery time, auto-disable, manual retry.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ensureInit } from '../functions/index.mjs';
import {
  organizerCreateWebhookEndpoint, organizerListWebhookEndpoints, organizerGetWebhookDelivery, organizerListWebhookDeliveries, organizerRetryWebhookDelivery, organizerIntegrationsHealth,
  organizerDisableWebhookEndpoint, resetEventsIntegrationsLimits,
} from '../functions/events-integrations.mjs';
import { harness, s5On, s5Off, db, webhookLab } from './fixtures/events-s5.mjs';
import { verifySignature, decryptSecret, webhookKeyRing } from '../src/shared/webhook-signing.mjs';
import { retryDelayMs } from '../src/shared/webhook-events.mjs';

await ensureInit();
const h = harness();
const { call } = h;
afterEach(() => { resetEventsIntegrationsLimits(); s5Off(); });
after(async () => { await h.cleanup(); await db.destroy(); });

const sec = ms => Math.floor(ms / 1000);
async function setup(opts = {}) {
  s5On();
  // the dispatcher claims EVERY due delivery in the database: clear what earlier tests left so counts are this test's own
  await db('WebhookDeliveryAttempt').del();
  await db('WebhookDelivery').del();
  const f = await h.kitEvent({ n: 1 });
  const lab = webhookLab(opts);
  const ep = await lab.endpoint(f.organizer);
  return { f, lab, ep };
}
const deliveryOf = async (eventId) => (await db('WebhookDelivery as d').join('OutboxEvent as o', 'o.id', 'd.outboxEventId').where('o.eventId', eventId).whereNot('o.type', 'registration.created').select('d.*').orderBy('d.createdAt'))[0];
const attemptsOf = id => db('WebhookDeliveryAttempt').where({ deliveryId: id }).orderBy('attemptNo');
const eventCalls = lab => lab.calls.filter(c => c.parsed.type !== 'endpoint.verification');

test('registration: https + public DNS only; the secret is returned ONCE, stored AES-GCM encrypted (and bound to the endpoint), fingerprinted by sha256; the list never shows it; unverified until the handshake', async () => {
  s5On();
  const f = await h.kitEvent({ n: 0 });
  const lab = webhookLab();
  const created = await lab.svc.createEndpoint({ organizerId: f.organizer.id, actorId: f.organizer.ownerUserId, body: { url: 'https://hooks.example.test/hook?x=1#frag', events: ['kit.collected', 'bib.assigned'], description: 'Timing system' } });
  assert.equal(created.status, 201, JSON.stringify(created));
  assert.match(created.signingSecret, /^whsec_[A-Za-z0-9_-]{43}$/);
  assert.equal(created.endpoint.url, 'https://hooks.example.test/hook?x=1', 'fragment dropped');
  assert.deepEqual([created.endpoint.verifiedAt, created.endpoint.health, created.endpoint.status], [null, 'unverified', 'active']);
  const row = await db('WebhookEndpoint').where({ id: created.endpoint.id }).first();
  assert.ok(!row.secretCiphertext.includes(created.signingSecret));
  assert.equal(decryptSecret(webhookKeyRing(process.env), { ciphertext: row.secretCiphertext, keyId: row.secretKeyId }, row.id), created.signingSecret);
  assert.equal(decryptSecret(webhookKeyRing(process.env), { ciphertext: row.secretCiphertext, keyId: row.secretKeyId }, 'whe_other'), null);
  assert.equal(row.secretHash.length, 64);
  assert.equal(created.endpoint.secretHint, `whsec_…${created.signingSecret.slice(-4)}`);
  for (const t of ['WebhookEndpoint', 'AuditLog', 'Notification', 'OutboxEvent']) assert.ok(!JSON.stringify(await db(t).select('*').limit(5000)).includes(created.signingSecret), `${t} holds the signing secret`);
  const list = await lab.svc.listEndpoints({ organizerId: f.organizer.id });
  assert.ok(!JSON.stringify(list).includes(created.signingSecret) && !JSON.stringify(list).includes('secretCiphertext'));
  assert.equal(list.items[0].description, 'Timing system');
  // refusals: every reason comes back as invalid_url { reason }
  lab.dns['private.example.test'] = ['10.0.0.9']; lab.dns['mixed.example.test'] = [PUBLIC_IPX(), '192.168.0.4'];
  for (const [url, reason] of [['http://hooks.example.test/', 'not_https'], ['https://hooks.example.test:8443/', 'bad_port'], ['https://127.0.0.1/', 'ip_literal'], ['https://localhost/', 'blocked_host'], ['https://private.example.test/', 'blocked_address'], ['https://mixed.example.test/', 'blocked_address'], ['https://nx.example.test/', 'unresolvable'], ['https://u:p@hooks.example.test/', 'credentials_in_url']]) {
    const r = await lab.svc.createEndpoint({ organizerId: f.organizer.id, actorId: f.organizer.ownerUserId, body: { url, events: ['kit.collected'] } });
    assert.deepEqual([url, r.status, r.error, r.reason], [url, 400, 'invalid_url', reason]);
  }
  // events: a closed list, no wildcard, payments never
  for (const events of [['*'], ['payment.succeeded'], ['registration.reserved'], [], 'kit.collected', ['kit.collected', 'ticket.issued']]) assert.ok(['invalid_event_type', 'validation_failed'].includes((await lab.svc.createEndpoint({ organizerId: f.organizer.id, actorId: f.organizer.ownerUserId, body: { url: 'https://hooks.example.test/', events } })).error), JSON.stringify(events));
  process.env.EVENTS_WEBHOOK_MAX_ENDPOINTS = '1';
});
const PUBLIC_IPX = () => '93.184.216.34';

test('flags, roles and the key: no EVENTS_WEBHOOK_SECRET_KEY → nothing is created or sent and options say so; flag off → 404; ops/timing/finance cannot manage endpoints', async () => {
  s5On();
  const o = await h.org();
  const body = { url: 'https://hooks.example.test/hook', events: ['kit.collected'] };
  for (const role of ['ops', 'timing', 'finance']) assert.equal((await call(organizerCreateWebhookEndpoint, o[role], { body })).status, 403, role);
  // the real route resolves real DNS: an unresolvable name proves the pipeline is wired without a network success
  const real = await call(organizerCreateWebhookEndpoint, o.owner, { body: { url: 'https://definitely-not-a-real-host.invalid/hook', events: ['kit.collected'] } });
  assert.deepEqual([real.status, real.body.error, real.body.reason], [400, 'invalid_url', 'unresolvable']);
  assert.equal((await call(organizerCreateWebhookEndpoint, o.owner, { body: { url: 'http://x.example.com/', events: ['kit.collected'] } })).body.reason, 'not_https');
  s5Off(); s5On({ key: false });
  assert.deepEqual((await call(organizerCreateWebhookEndpoint, o.owner, { body })).body, { error: 'feature_disabled' });
  assert.equal((await call(organizerListWebhookEndpoints, o.owner, {})).body.available, false);
  const lab = webhookLab();
  assert.deepEqual(await lab.svc.fanout(), { skipped: 'no_key', rows: 0, deliveries: 0 });
  assert.equal((await lab.svc.deliverDue()).skipped, 'no_key');
  s5Off(); s5On({ webhooks: false });
  assert.deepEqual((await call(organizerListWebhookEndpoints, o.owner, {})).body, { error: 'feature_disabled' });
  assert.deepEqual((await call(organizerIntegrationsHealth, o.owner, {})).status, 200, 'health answers while either of api / webhooks is on');
  s5Off(); assert.equal((await call(organizerIntegrationsHealth, o.owner, {})).status, 404);
});

test('the handshake: an unverified endpoint receives ONLY the challenge; a wrong or failing answer leaves it unverified with the reason; unverified endpoints are skipped by the fan-out', async () => {
  s5On();
  const f = await h.kitEvent({ n: 1 });
  const lab = webhookLab();
  const ep = await lab.endpoint(f.organizer, { verify: false });
  await lab.emit(f.event, f.organizer.id);
  const fan = await lab.svc.fanout();
  assert.equal(fan.deliveries, 0, 'unverified: nothing is queued');
  assert.deepEqual(lab.calls, [], 'and nothing at all was sent');
  lab.verifyAnswer = 'wrong';
  assert.deepEqual(await lab.svc.verifyEndpoint({ organizerId: f.organizer.id, id: ep.id, actorId: f.organizer.ownerUserId }), { ok: false, host: 'hooks.example.test', reason: 'challenge_mismatch' });
  lab.verifyAnswer = 'down';
  assert.equal((await lab.svc.verifyEndpoint({ organizerId: f.organizer.id, id: ep.id, actorId: f.organizer.ownerUserId })).reason, 'http_500');
  assert.equal((await db('WebhookEndpoint').where({ id: ep.id }).first()).verifiedAt, null);
  assert.equal(lab.calls.length, 2);
  assert.deepEqual(lab.calls.map(c => c.parsed.type), ['endpoint.verification', 'endpoint.verification']);
  assert.match(lab.calls[0].parsed.challenge, /^[A-Za-z0-9_-]{32}$/);
  assert.ok(lab.calls[0].headers['X-FitFlex-Signature'].startsWith('v1='), 'the handshake itself is signed');
  lab.verifyAnswer = 'echo';
  assert.equal((await lab.svc.verifyEndpoint({ organizerId: f.organizer.id, id: ep.id, actorId: f.organizer.ownerUserId })).ok, true);
  assert.ok((await db('WebhookEndpoint').where({ id: ep.id }).first()).verifiedAt);
  assert.equal((await db('WebhookDeliveryAttempt').where({ endpointId: ep.id, trigger: 'verify' })).length, 3);
  // endpoints created AFTER an event never receive it
  assert.equal((await lab.svc.fanout()).deliveries, 0, 'the earlier event predates the endpoint');
  await lab.emit(f.event, f.organizer.id);
  assert.equal((await lab.svc.fanout()).deliveries, 1);
  // a changed URL runs the handshake again, at once
  lab.dns['other.example.test'] = ['93.184.216.35'];
  const upd = await lab.svc.updateEndpoint({ organizerId: f.organizer.id, id: ep.id, actorId: f.organizer.ownerUserId, body: { url: 'https://other.example.test/hook' } });
  assert.equal(upd.verification.ok, true);
  assert.equal(lab.calls.at(-1).url, 'https://other.example.test/hook');
});

test('SCENARIO 13 — the receiver times out three times then recovers: attempt rows 1..3 timeout then success; delivered with attemptCount 4; the backoff follows the schedule; the event id never changes, the timestamp and signature do', async () => {
  const { f, lab, ep } = await setup();
  lab.script.push({ throw: 'timeout' }, { throw: 'timeout' }, { throw: 'timeout' }, { status: 200, body: 'ok' });
  const evt = await lab.emit(f.event, f.organizer.id);
  assert.equal((await lab.svc.fanout()).deliveries, 1);
  const d = await deliveryOf(f.event.id);
  assert.deepEqual([d.status, d.attemptCount], ['pending', 0]);
  // attempt 1
  let r = await lab.svc.deliverDue();
  assert.deepEqual([r.claimed, r.failed], [1, 1]);
  let row = await deliveryOf(f.event.id);
  assert.deepEqual([row.status, row.attemptCount, row.lastError], ['failed', 1, 'timeout']);
  assert.ok(Math.abs(+new Date(row.nextAttemptAt) - lab.clock.t - retryDelayMs(1, () => 0.5)) < 3000, '+1 minute');
  // not due yet: nothing is sent
  assert.equal((await lab.svc.deliverDue()).claimed, 0);
  const waits = [];
  for (const attempt of [2, 3, 4]) {
    waits.push(+new Date((await deliveryOf(f.event.id)).nextAttemptAt) - lab.clock.t);
    lab.advance(waits.at(-1) + 1000);
    await lab.svc.deliverDue();
    void attempt;
  }
  [60_000, 300_000, 900_000].forEach((want, i) => assert.ok(Math.abs(waits[i] - want) < 3000, `wait ${i + 1}: ${waits[i]} vs ${want}`));
  row = await deliveryOf(f.event.id);
  assert.deepEqual([row.status, row.attemptCount, row.responseCode, row.lastError], ['delivered', 4, 200, null]);
  assert.ok(row.deliveredAt);
  const attempts = await attemptsOf(d.id);
  assert.deepEqual(attempts.map(a => [a.attemptNo, a.outcome, a.trigger]), [[1, 'timeout', 'auto'], [2, 'timeout', 'auto'], [3, 'timeout', 'auto'], [4, 'success', 'auto']]);
  assert.deepEqual(attempts.map(a => a.errorCode), ['timeout', 'timeout', 'timeout', null]);
  assert.ok(attempts[0].nextAttemptAt && attempts[3].nextAttemptAt === null);
  // the same event id on every attempt; a new timestamp and a new signature each time; each verifies
  const sent = eventCalls(lab);
  assert.equal(sent.length, 4);
  assert.deepEqual([...new Set(sent.map(c => c.headers['X-FitFlex-Event-Id']))], [evt.id]);
  assert.deepEqual(sent.map(c => c.headers['X-FitFlex-Delivery-Attempt']), ['1', '2', '3', '4']);
  assert.equal(new Set(sent.map(c => c.headers['X-FitFlex-Timestamp'])).size, 4);
  assert.equal(new Set(sent.map(c => c.headers['X-FitFlex-Signature'])).size, 4);
  for (const c of sent) assert.deepEqual(verifySignature({ secrets: [ep.secret], headers: c.headers, rawBody: c.body, nowSeconds: sec(c.at) }), { ok: true });
  assert.ok(sent.every(c => c.headers['User-Agent'] === 'FitFlex-Webhooks/1' && c.headers['Content-Type'] === 'application/json' && c.headers['X-FitFlex-Event-Type'] === 'kit.collected'));
  assert.equal(JSON.parse(sent[0].body).id, evt.id);
});

test('SCENARIO 14 — a captured delivery: the reference verifier accepts it; a tampered body, a wrong secret and a replay after five minutes are rejected; the secret never appears in the payload or the headers', async () => {
  const { f, lab, ep } = await setup();
  await lab.emit(f.event, f.organizer.id);
  await lab.svc.fanout(); await lab.svc.deliverDue();
  const c = eventCalls(lab)[0];
  const now = sec(c.at);
  assert.equal(verifySignature({ secrets: [ep.secret], headers: c.headers, rawBody: c.body, nowSeconds: now }).ok, true);
  assert.equal(verifySignature({ secrets: [ep.secret], headers: c.headers, rawBody: c.body.replace('ecp_lab', 'ecp_evil'), nowSeconds: now }).ok, false);
  assert.equal(verifySignature({ secrets: ['whsec_wrong'], headers: c.headers, rawBody: c.body, nowSeconds: now }).ok, false);
  assert.deepEqual(verifySignature({ secrets: [ep.secret], headers: c.headers, rawBody: c.body, nowSeconds: now + 301 }), { ok: false, reason: 'stale_timestamp' });
  assert.ok(!JSON.stringify(c).includes(ep.secret));
  assert.ok(Buffer.byteLength(c.body) < 16 * 1024);
  assert.deepEqual(Object.keys(c.parsed), ['id', 'type', 'version', 'createdAt', 'organizerId', 'eventId', 'data']);
  assert.deepEqual(c.parsed.data, { registrationId: 'ereg_lab', collectionPointId: 'ecp_lab', collectedAt: c.parsed.data.collectedAt });
  assert.equal(c.parsed.organizerId, f.organizer.id);
  assert.ok(c.addresses.every(a => a.address === '93.184.216.34'), 'the validated addresses are what the sender is given');
});

test('rotation: both signatures during the grace window (new first), only the new one after; secret shown once; the old secret verifies a grace delivery', async () => {
  const { f, lab, ep } = await setup();
  const rot = await lab.svc.rotateSecret({ organizerId: f.organizer.id, id: ep.id, actorId: f.organizer.ownerUserId, body: { graceHours: 24 } });
  assert.match(rot.signingSecret, /^whsec_/);
  assert.notEqual(rot.signingSecret, ep.secret);
  assert.equal(rot.endpoint.rotation.inGrace, true);
  await lab.emit(f.event, f.organizer.id);
  await lab.svc.fanout(); await lab.svc.deliverDue();
  const first = eventCalls(lab)[0];
  const values = first.headers['X-FitFlex-Signature'].split(',');
  assert.equal(values.length, 2);
  assert.equal(verifySignature({ secrets: [rot.signingSecret], headers: first.headers, rawBody: first.body, nowSeconds: sec(first.at) }).ok, true);
  assert.equal(verifySignature({ secrets: [ep.secret], headers: first.headers, rawBody: first.body, nowSeconds: sec(first.at) }).ok, true, 'a consumer still on the old secret passes');
  assert.ok(values[0] !== values[1]);
  lab.advance(25 * 3_600_000);
  await lab.emit(f.event, f.organizer.id);
  await db('WebhookEndpoint').where({ id: ep.id }).update({ createdAt: new Date(lab.clock.t - 3_600_000 * 30) });
  await lab.svc.fanout(); await lab.svc.deliverDue();
  const later = eventCalls(lab).at(-1);
  assert.equal(later.headers['X-FitFlex-Signature'].split(',').length, 1);
  assert.equal(verifySignature({ secrets: [ep.secret], headers: later.headers, rawBody: later.body, nowSeconds: sec(later.at) }).ok, false);
  assert.equal((await lab.svc.rotateSecret({ organizerId: f.organizer.id, id: ep.id, actorId: f.organizer.ownerUserId, body: { graceHours: 5 } })).error, 'validation_failed');
});

test('terminal outcomes: 410 Gone → dead at once and the endpoint is disabled (endpoint_gone, owner told); max attempts → dead (dead letter); 3xx is a failed attempt, never followed; 4xx and 5xx retry', async () => {
  const { f, lab, ep } = await setup({ maxAttempts: 3 });
  lab.script.push({ status: 302, body: 'moved' });
  await lab.emit(f.event, f.organizer.id);
  await lab.svc.fanout(); await lab.svc.deliverDue();
  let d = await deliveryOf(f.event.id);
  assert.deepEqual([d.status, d.lastError, d.responseCode], ['failed', 'http_302', 302]);
  assert.equal((await attemptsOf(d.id))[0].outcome, 'redirect_not_followed');
  lab.script.push({ status: 429 }, { status: 503, body: 'down' });
  for (let i = 0; i < 2; i += 1) { lab.advance(24 * 3_600_000); await lab.svc.deliverDue(); }
  d = await deliveryOf(f.event.id);
  assert.deepEqual([d.status, d.attemptCount, d.nextAttemptAt], ['dead', 3, null]);
  assert.deepEqual((await attemptsOf(d.id)).map(a => a.outcome), ['redirect_not_followed', 'http_error', 'http_error']);
  assert.equal((await db('WebhookEndpoint').where({ id: ep.id }).first()).status, 'active', 'a dead delivery alone does not switch the endpoint off');
  // 410
  lab.script.push({ status: 410 });
  await lab.emit(f.event, f.organizer.id, 'bib.assigned', { registrationId: 'ereg_lab', categoryId: 'c', bibNumber: '5' });
  await lab.svc.fanout(); lab.advance(1000); await lab.svc.deliverDue();
  const gone = (await db('WebhookDelivery').orderBy('createdAt', 'desc').where('endpointId', ep.id).first());
  assert.deepEqual([gone.status, gone.lastError], ['dead', 'http_410']);
  const e = await db('WebhookEndpoint').where({ id: ep.id }).first();
  assert.deepEqual([e.status, e.disabledReason], ['disabled', 'endpoint_gone']);
  assert.ok(lab.notes.some(n => n.type === 'organizer_webhook_auto_disabled'));
});

test('AUTO-DISABLE after sustained failure (30 in a row and the first 24 h ago): the endpoint switches off, owner and admins are told in both languages, nothing more is fanned out; re-enable needs the handshake and can redeliver what was missed', async () => {
  const { f, lab, ep } = await setup();
  await db('WebhookEndpoint').where({ id: ep.id }).update({ consecutiveFailures: 29, firstFailureAt: new Date(lab.clock.t - 25 * 3_600_000) });
  lab.script.push({ status: 500 });
  await lab.emit(f.event, f.organizer.id);
  await lab.svc.fanout(); await lab.svc.deliverDue();
  const e = await db('WebhookEndpoint').where({ id: ep.id }).first();
  assert.deepEqual([e.status, e.disabledReason, e.consecutiveFailures], ['disabled', 'auto_failures', 30]);
  assert.ok(e.disabledAt);
  const told = lab.notes.filter(n => n.type === 'organizer_webhook_auto_disabled');
  const staff = await db('EventOrganizerStaff').where({ organizerId: f.organizer.id, status: 'active' }).whereIn('role', ['owner', 'admin']);
  assert.equal(told.length, staff.length);
  assert.ok(told.every(n => n.data.titleSw === 'Webhook imezimwa' && n.body.includes('hooks.example.test') && n.data.bodySw.includes('imezimwa')));
  assert.equal((await db('AuditLog').where({ action: 'events.webhook_auto_disabled', target: ep.id })).length, 1);
  // while disabled: not fanned out, and pending deliveries are not sent
  const before = lab.calls.length;
  await lab.emit(f.event, f.organizer.id, 'kit.collected', null, 'ereg_missed');
  assert.equal((await lab.svc.fanout()).deliveries, 0);
  lab.advance(2 * 3_600_000); await lab.svc.deliverDue();
  assert.equal(lab.calls.length, before);
  // enable: the handshake must pass
  lab.verifyAnswer = 'down';
  const refused = await lab.svc.enableEndpoint({ organizerId: f.organizer.id, id: ep.id, actorId: f.organizer.ownerUserId, body: { redeliverMissed: true } });
  assert.deepEqual([refused.status, refused.error], [409, 'verification_failed']);
  assert.equal((await db('WebhookEndpoint').where({ id: ep.id }).first()).status, 'disabled');
  lab.verifyAnswer = 'echo';
  const back = await lab.svc.enableEndpoint({ organizerId: f.organizer.id, id: ep.id, actorId: f.organizer.ownerUserId, body: { redeliverMissed: true } });
  assert.deepEqual([back.changed, back.requeued, back.endpoint.status, back.endpoint.consecutiveFailures], [true, 1, 'active', 0]);
  await lab.svc.deliverDue();
  assert.ok(eventCalls(lab).some(c => c.parsed.data.registrationId === 'ereg_missed'), 'the missed event reached the receiver (alongside the retry of the one that failed)');
  // a manual disable is not an auto one, and the sustained-72h rule
  assert.equal((await lab.svc.disableEndpoint({ organizerId: f.organizer.id, id: ep.id, actorId: f.organizer.ownerUserId })).endpoint.status, 'disabled');
  assert.equal((await db('WebhookEndpoint').where({ id: ep.id }).first()).disabledReason, 'manual');
});

test('auto-disable by the 72-hour rule: no success for 72 h and at least 10 failed deliveries', async () => {
  const { f, lab, ep } = await setup();
  await db('WebhookEndpoint').where({ id: ep.id }).update({ createdAt: new Date(lab.clock.t - 4 * 86_400_000), lastSuccessAt: new Date(lab.clock.t - 4 * 86_400_000) });
  for (let i = 0; i < 10; i += 1) {
    const evt = await lab.emit(f.event, f.organizer.id, 'kit.collected', null, `ereg_72_${i}`);
    await db('WebhookDelivery').insert({ id: `whd_72_${ep.id.slice(-6)}_${i}`, endpointId: ep.id, outboxEventId: evt.id, status: 'failed', attemptCount: 2, lastAttemptAt: new Date(lab.clock.t - 3600_000), nextAttemptAt: new Date(lab.clock.t + 3600_000) });
  }
  assert.equal(await lab.svc.internals.maybeAutoDisable(ep.id), true);
  assert.equal((await db('WebhookEndpoint').where({ id: ep.id }).first()).disabledReason, 'auto_failures');
  const other = await lab.endpoint(f.organizer, { url: 'https://hooks.example.test/other' });
  await db('WebhookEndpoint').where({ id: other.id }).update({ createdAt: new Date(lab.clock.t - 4 * 86_400_000) });
  assert.equal(await lab.svc.internals.maybeAutoDisable(other.id), false, 'too few failures: stays on');
});

test('SSRF at DELIVERY time: a name that turns private after registration is never dialled; the attempt is blocked_address, retried on the schedule, and counts toward auto-disable', async () => {
  const { f, lab, ep } = await setup();
  await lab.emit(f.event, f.organizer.id);
  await lab.svc.fanout();
  lab.dns['hooks.example.test'] = ['169.254.169.254'];
  const before = lab.calls.length;
  await lab.svc.deliverDue();
  assert.equal(lab.calls.length, before, 'no request was made');
  const d = await deliveryOf(f.event.id);
  assert.deepEqual([d.status, d.attemptCount, d.lastError], ['failed', 1, 'blocked_address']);
  assert.deepEqual((await attemptsOf(d.id)).map(a => [a.outcome, a.errorCode]), [['blocked_address', 'blocked_address']]);
  assert.equal((await db('WebhookEndpoint').where({ id: ep.id }).first()).consecutiveFailures, 1);
  lab.dns['hooks.example.test'] = ['127.0.0.1', PUBLIC_IPX()];
  lab.advance(2 * 60_000); await lab.svc.deliverDue();
  assert.equal((await deliveryOf(f.event.id)).lastError, 'blocked_address', 'one private answer among public ones is still blocked');
  lab.dns['hooks.example.test'] = [PUBLIC_IPX()];
  lab.advance(10 * 60_000); await lab.svc.deliverDue();
  assert.equal((await deliveryOf(f.event.id)).status, 'delivered');
  lab.dns['hooks.example.test'] = []; // vanished from DNS
  const t = await lab.svc.testSend({ organizerId: f.organizer.id, id: ep.id, actorId: f.organizer.ownerUserId, body: {} });
  assert.deepEqual([t.ok, t.outcome, t.errorCode], [false, 'blocked_address', 'unresolvable']);
});

test('manual retry: failed or dead only, idempotent (already queued → alreadyQueued), tagged `manual`, 5 per delivery per 24 h then 429, delivered is refused; the event id is unchanged', async () => {
  const { f, lab } = await setup({ maxAttempts: 1 });
  lab.script.push({ status: 500 });
  const evt = await lab.emit(f.event, f.organizer.id);
  await lab.svc.fanout(); await lab.svc.deliverDue();
  const d = await deliveryOf(f.event.id);
  assert.equal(d.status, 'dead');
  const retry = () => lab.svc.retryDelivery({ organizerId: f.organizer.id, id: d.id, actorId: f.organizer.ownerUserId });
  const first = await retry();
  assert.deepEqual([first.queued, first.delivery.status], [true, 'pending']);
  assert.deepEqual((await retry()).alreadyQueued, true, 'a second click while queued is a no-op');
  lab.script.push({ status: 500 });
  await lab.svc.deliverDue();
  assert.deepEqual((await attemptsOf(d.id)).map(a => a.trigger), ['auto', 'manual']);
  for (let i = 0; i < 4; i += 1) { const r = await retry(); assert.equal(r.queued, true, JSON.stringify(r)); lab.script.push({ status: 500 }); await lab.svc.deliverDue(); }
  const sixth = await retry();
  assert.deepEqual([sixth.status, sixth.error], [429, 'rate_limited']);
  assert.equal((await db('AuditLog').where({ action: 'events.webhook_delivery_retried', target: d.id })).length, 5);
  assert.deepEqual([...new Set(eventCalls(lab).map(c => c.headers['X-FitFlex-Event-Id']))], [evt.id]);
  // after a success it is delivered and cannot be retried; another organizer's delivery is 404
  await db('WebhookDelivery').where({ id: d.id }).update({ status: 'delivered', deliveredAt: new Date() });
  assert.equal((await retry()).error, 'already_delivered');
  const other = await h.org();
  assert.equal((await lab.svc.retryDelivery({ organizerId: other.id, id: d.id, actorId: other.ownerUserId })).error, 'delivery_not_found');
});

test('the delivery log: every attempt with a REDACTED snippet; the payload as sent; routes list and detail; another organizer sees nothing; the secret appears nowhere', async () => {
  const { f, lab, ep } = await setup();
  lab.script.push({ status: 500, body: `oops ${'whsec_leaked0123456789ABCDEFGHIJ'} mail amina@example.com Bearer abc.def.ghi` }, { status: 200, body: 'ok' });
  await lab.emit(f.event, f.organizer.id);
  await lab.svc.fanout(); await lab.svc.deliverDue(); lab.advance(61_000); await lab.svc.deliverDue();
  const d = await deliveryOf(f.event.id);
  const attempts = await attemptsOf(d.id);
  assert.ok(attempts[0].responseSnippet.includes('[redacted]'));
  assert.ok(!/whsec_leaked|amina@|abc\.def/.test(attempts[0].responseSnippet));
  const detail = await lab.svc.getDelivery({ organizerId: f.organizer.id, id: d.id });
  assert.deepEqual([detail.delivery.status, detail.attempts.length, detail.payload.type, detail.manualRetriesLeft], ['delivered', 2, 'kit.collected', 5]);
  assert.ok(!JSON.stringify(detail).includes(ep.secret));
  const list = await lab.svc.listDeliveries({ organizerId: f.organizer.id, query: { status: 'delivered' } });
  assert.equal(list.items.length, 1);
  assert.deepEqual(Object.keys(list.items[0]).sort(), ['attemptCount', 'createdAt', 'endpointId', 'eventType', 'id', 'lastAttemptAt', 'lastError', 'nextAttemptAt', 'outboxEventId', 'responseCode', 'status']);
  const o = await h.org();
  assert.deepEqual((await lab.svc.listDeliveries({ organizerId: o.id, query: {} })).items, []);
  assert.equal((await lab.svc.getDelivery({ organizerId: o.id, id: d.id })).error, 'delivery_not_found');
  // the real routes
  assert.equal((await call(organizerListWebhookDeliveries, f.organizer.owner, { query: {} })).status, 200);
  assert.equal((await call(organizerGetWebhookDelivery, f.organizer.owner, { params: { id: d.id } })).body.delivery.id, d.id);
  assert.equal((await call(organizerGetWebhookDelivery, o.owner, { params: { id: d.id } })).status, 404);
  assert.equal((await call(organizerRetryWebhookDelivery, f.organizer.timing, { params: { id: d.id } })).status, 403);
  for (const t of ['WebhookDelivery', 'WebhookDeliveryAttempt', 'AuditLog', 'Notification']) assert.ok(!JSON.stringify(await db(t).select('*').limit(5000)).includes(ep.secret), t);
});

test('test-send: one synthetic *.test event (data.test true, id obx_test_…), an attempt row with trigger `test` and no delivery; 10 an hour', async () => {
  const { f, lab, ep } = await setup();
  const r = await lab.svc.testSend({ organizerId: f.organizer.id, id: ep.id, actorId: f.organizer.ownerUserId, body: { type: 'bib.assigned' } });
  assert.deepEqual([r.ok, r.outcome, r.responseCode], [true, 'success', 200]);
  const c = eventCalls(lab).at(-1);
  assert.deepEqual([c.parsed.type, c.parsed.data, c.parsed.id.startsWith('obx_test_')], ['bib.assigned.test', { test: true }, true]);
  assert.equal((await db('WebhookDeliveryAttempt').where({ endpointId: ep.id, trigger: 'test' })).length, 1);
  assert.equal((await db('WebhookDelivery').where({ endpointId: ep.id })).length, 0);
  for (let i = 0; i < 9; i += 1) assert.equal((await lab.svc.testSend({ organizerId: f.organizer.id, id: ep.id, actorId: f.organizer.ownerUserId, body: {} })).ok, true);
  assert.equal((await lab.svc.testSend({ organizerId: f.organizer.id, id: ep.id, actorId: f.organizer.ownerUserId, body: {} })).status, 429);
});

test('two dispatchers at once deliver each event exactly once (lease + SKIP LOCKED); a suspended organizer\'s deliveries are held, then resume', async () => {
  const { f, lab } = await setup();
  for (let i = 0; i < 6; i += 1) await lab.emit(f.event, f.organizer.id, 'kit.collected', null, `ereg_par_${i}`);
  await lab.svc.fanout();
  await db('EventOrganizer').where({ id: f.organizer.id }).update({ status: 'suspended', statusReason: 'spec' });
  assert.equal((await lab.svc.deliverDue()).claimed, 0, 'held while suspended');
  assert.equal(eventCalls(lab).length, 0);
  await db('EventOrganizer').where({ id: f.organizer.id }).update({ status: 'active', statusReason: null });
  await Promise.all([lab.svc.deliverDue(), lab.svc.deliverDue(), lab.svc.deliverDue()]);
  const sent = eventCalls(lab).map(c => c.parsed.id);
  assert.equal(sent.length, 6);
  assert.equal(new Set(sent).size, 6, 'no event was sent twice');
});

test('health: healthy / degraded / failing / disabled / unverified from the data; the aggregate counts them', async () => {
  const { f, lab, ep } = await setup();
  assert.equal((await lab.svc.listEndpoints({ organizerId: f.organizer.id })).items[0].health, 'healthy');
  lab.script.push({ status: 500 });
  await lab.emit(f.event, f.organizer.id);
  await lab.svc.fanout(); await lab.svc.deliverDue();
  const failing = (await lab.svc.listEndpoints({ organizerId: f.organizer.id })).items[0];
  assert.equal(failing.health, 'failing', 'a failure in the last hour and no success yet');
  assert.deepEqual([failing.pending, failing.last24h.failed], [1, 1]);
  await db('WebhookEndpoint').where({ id: ep.id }).update({ lastSuccessAt: new Date(lab.clock.t - 3600_000) });
  assert.equal((await lab.svc.listEndpoints({ organizerId: f.organizer.id })).items[0].health, 'degraded');
  const u = await lab.endpoint(f.organizer, { url: 'https://hooks.example.test/u', verify: false });
  assert.equal((await lab.svc.getEndpoint({ organizerId: f.organizer.id, id: u.id })).endpoint.health, 'unverified');
  await lab.svc.disableEndpoint({ organizerId: f.organizer.id, id: ep.id, actorId: f.organizer.ownerUserId });
  const agg = await lab.svc.integrationsHealth({ organizerId: f.organizer.id });
  assert.deepEqual([agg.endpoints, agg.disabled, agg.unverified], [2, 1, 1]);
  assert.equal((await call(organizerDisableWebhookEndpoint, f.organizer.ops, { params: { id: ep.id } })).status, 403);
});

test('retention: attempts 30 days, delivered/dead deliveries and published outbox 90 days, idempotency 7 days; recent rows stay', async () => {
  const { f, lab, ep } = await setup();
  const evt = await lab.emit(f.event, f.organizer.id);
  await lab.svc.fanout(); await lab.svc.deliverDue();
  const d = await deliveryOf(f.event.id);
  await db('WebhookDeliveryAttempt').where({ deliveryId: d.id }).update({ startedAt: new Date(Date.now() - 31 * 86_400_000) });
  await db('OrganizerIdempotency').insert({ id: 'oid_old_1', scopeType: 'staff', scopeId: 'usr_x', key: 'old-key-0001', route: 'r', fingerprint: 'f', state: 'in_progress', createdAt: new Date(), expiresAt: new Date(Date.now() - 1000) });
  const r = await lab.svc.retention();
  assert.ok(r.attempts >= 1 && r.idempotency >= 1);
  assert.equal((await db('WebhookDelivery').where({ id: d.id }).first()).status, 'delivered');
  await db('OutboxEvent').where({ id: evt.id }).update({ createdAt: new Date(Date.now() - 91 * 86_400_000) });
  await db('WebhookDelivery').where({ id: d.id }).update({ createdAt: new Date(Date.now() - 91 * 86_400_000) });
  const r2 = await lab.svc.retention();
  assert.ok(r2.deliveries >= 1 && r2.outbox >= 1);
  assert.equal(await db('OutboxEvent').where({ id: evt.id }).first(), undefined);
  void ep;
});
