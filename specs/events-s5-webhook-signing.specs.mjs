// Marathon & running events · S5 — webhook signing, secret storage and redaction (spec §7.3, §7.5). OWNER REVIEW (D35). SCENARIO 14 (reference verifier).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  signBody, signatureHeader, deliveryHeaders, verifySignature, newWebhookSecret, webhookKeyRing, encryptSecret, decryptSecret, redactSnippet, last4, sha256hex, REPLAY_WINDOW_SECONDS,
} from '../src/shared/webhook-signing.mjs';
import { projectOutbox, envelopeOf, retryDelayMs, RETRY_MINUTES, WEBHOOK_EVENT_TYPES, isSubscribable, testEnvelope, verificationEnvelope } from '../src/shared/webhook-events.mjs';

// The KNOWN-ANSWER VECTOR printed in docs/api/organizer-webhooks.md; also checked below with an independent implementation (Python's hmac).
const SECRET = 'whsec_test_secret_for_known_answer_vector';
const OLD = 'whsec_old_secret';
const TS = 1800000000;
const BODY = '{"id":"obx_0123456789abcdef","type":"kit.collected","version":"1","createdAt":"2027-03-14T05:41:07.123Z","organizerId":"eorg_1","eventId":"evt_1","data":{"registrationId":"erg_1"}}';
const EXPECTED = 'aac48e25012eaea4e63d9f8b9b6d2ef938f392616c9ef101ff65cb2756d0b4f6';
const EXPECTED_OLD = '9f41695483b1c2a36f567fa1397b8fd87d70d0407f006962b471a87f1d8932c8';

test('the known-answer vector: HMAC_SHA256(secret, timestamp + "." + rawBody) as hex; an independent implementation agrees', () => {
  assert.equal(signBody(SECRET, TS, BODY), EXPECTED);
  assert.equal(signBody(OLD, TS, BODY), EXPECTED_OLD);
  let python = null;
  try { python = execFileSync('python3', ['-I', '-c', 'import hmac,hashlib,sys; print(hmac.new(sys.argv[1].encode(), (sys.argv[2]+"."+sys.argv[3]).encode(), hashlib.sha256).hexdigest())', SECRET, String(TS), BODY]).toString().trim(); } catch { /* python not installed */ }
  if (python) assert.equal(python, EXPECTED);
  assert.equal(signatureHeader([SECRET], TS, BODY), `v1=${EXPECTED}`);
  assert.equal(signatureHeader([SECRET, OLD], TS, BODY), `v1=${EXPECTED},v1=${EXPECTED_OLD}`, 'two values during rotation grace: new first, old second');
  assert.equal(signatureHeader([SECRET, null, undefined], TS, BODY), `v1=${EXPECTED}`);
});

test('headers on every delivery: the fixed set, names exact, timestamp in seconds, attempt number', () => {
  const h = deliveryHeaders({ eventId: 'obx_1', eventType: 'kit.collected', timestamp: TS, attemptNo: 3, signature: `v1=${EXPECTED}` });
  assert.deepEqual(h, {
    'Content-Type': 'application/json', 'User-Agent': 'FitFlex-Webhooks/1', 'X-FitFlex-Event-Id': 'obx_1', 'X-FitFlex-Event-Type': 'kit.collected',
    'X-FitFlex-Timestamp': '1800000000', 'X-FitFlex-Delivery-Attempt': '3', 'X-FitFlex-Signature': `v1=${EXPECTED}`,
  });
});

test('SCENARIO 14 — the reference verifier: accepts a good delivery; rejects a tampered body, a wrong secret, a stale and a future timestamp, a missing or malformed header; accepts EITHER v1 during rotation', () => {
  const headers = { 'x-fitflex-timestamp': String(TS), 'x-fitflex-signature': `v1=${EXPECTED}`, 'X-FitFlex-Event-Id': 'obx_1' };
  const ok = { secrets: [SECRET], headers, rawBody: BODY, nowSeconds: TS + 10 };
  assert.deepEqual(verifySignature(ok), { ok: true });
  assert.deepEqual(verifySignature({ ...ok, rawBody: BODY.replace('erg_1', 'erg_2') }), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verifySignature({ ...ok, rawBody: `${BODY} ` }), { ok: false, reason: 'bad_signature' }, 'one extra byte');
  assert.deepEqual(verifySignature({ ...ok, secrets: ['whsec_wrong'] }), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verifySignature({ ...ok, secrets: [] }), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verifySignature({ ...ok, nowSeconds: TS + REPLAY_WINDOW_SECONDS + 1 }), { ok: false, reason: 'stale_timestamp' }, 'a replay after the window');
  assert.deepEqual(verifySignature({ ...ok, nowSeconds: TS - REPLAY_WINDOW_SECONDS - 1 }), { ok: false, reason: 'stale_timestamp' });
  assert.deepEqual(verifySignature({ ...ok, nowSeconds: TS + REPLAY_WINDOW_SECONDS }), { ok: true }, 'the window is inclusive');
  // a replay with a fresh timestamp but the old signature fails: the timestamp is part of what is signed
  assert.deepEqual(verifySignature({ ...ok, headers: { ...headers, 'x-fitflex-timestamp': String(TS + 100) }, nowSeconds: TS + 110 }), { ok: false, reason: 'bad_signature' });
  for (const bad of [{ 'x-fitflex-signature': `v1=${EXPECTED}` }, { 'x-fitflex-timestamp': String(TS) }, { ...headers, 'x-fitflex-timestamp': 'yesterday' }, { ...headers, 'x-fitflex-signature': 'v2=abc' }, { ...headers, 'x-fitflex-signature': `v1=${EXPECTED.slice(0, 60)}` }]) {
    assert.equal(verifySignature({ ...ok, headers: bad }).ok, false);
  }
  // rotation: two signatures, a consumer that knows only one secret passes with either
  const dual = { ...headers, 'x-fitflex-signature': `v1=${EXPECTED},v1=${EXPECTED_OLD}` };
  assert.equal(verifySignature({ ...ok, headers: dual, secrets: [SECRET] }).ok, true);
  assert.equal(verifySignature({ ...ok, headers: dual, secrets: [OLD] }).ok, true);
  assert.equal(verifySignature({ ...ok, headers: dual, secrets: ['whsec_other'] }).ok, false);
  assert.equal(verifySignature({ ...ok, headers: { ...headers, 'X-FITFLEX-SIGNATURE': `v1=${EXPECTED}` } }).ok, true, 'header names are case-insensitive');
});

test('secret generation and the AES-256-GCM key ring: whsec_ + 43 base64url, shown once; encrypted at rest; bound to the endpoint; tamper-evident; rotated keys keep working; no key → null (feature off)', () => {
  const s = newWebhookSecret();
  assert.match(s, /^whsec_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(s, newWebhookSecret());
  assert.equal(last4(s), s.slice(-4));
  assert.equal(sha256hex(s).length, 64);
  const key = randomBytes(32).toString('base64');
  const ring = webhookKeyRing({ EVENTS_WEBHOOK_SECRET_KEY: key });
  assert.deepEqual([ring.keyId, Object.keys(ring.previous)], ['k1', []]);
  const sealed = encryptSecret(ring, s, 'whe_1');
  assert.match(sealed.ciphertext, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.ok(!sealed.ciphertext.includes(s) && !Buffer.from(sealed.ciphertext.split('.')[3], 'base64url').toString('latin1').includes('whsec_'));
  assert.equal(decryptSecret(ring, sealed, 'whe_1'), s);
  assert.notEqual(encryptSecret(ring, s, 'whe_1').ciphertext, sealed.ciphertext, 'a fresh IV every time');
  // a ciphertext copied to another endpoint will not open (AAD), nor one that was altered, nor one from another key
  assert.equal(decryptSecret(ring, sealed, 'whe_2'), null);
  const parts = sealed.ciphertext.split('.');
  const flipped = [...parts]; flipped[3] = Buffer.from(Buffer.from(parts[3], 'base64url').map((b, i) => (i === 0 ? b ^ 1 : b))).toString('base64url');
  assert.equal(decryptSecret(ring, { ciphertext: flipped.join('.'), keyId: 'k1' }, 'whe_1'), null);
  assert.equal(decryptSecret(webhookKeyRing({ EVENTS_WEBHOOK_SECRET_KEY: randomBytes(32).toString('base64') }), sealed, 'whe_1'), null);
  for (const junk of ['', 'v1', 'v2.a.b.c', 'v1...', null, undefined]) assert.equal(decryptSecret(ring, { ciphertext: junk, keyId: 'k1' }, 'whe_1'), null);
  // key rotation: the old key stays in the ring as `previous`
  const next = webhookKeyRing({ EVENTS_WEBHOOK_SECRET_KEY: randomBytes(32).toString('base64'), EVENTS_WEBHOOK_SECRET_KEY_ID: 'k2', EVENTS_WEBHOOK_SECRET_KEY_PREVIOUS: JSON.stringify({ k1: key, bad: 'short', k2: key }) });
  assert.deepEqual([next.keyId, Object.keys(next.previous)], ['k2', ['k1']]);
  assert.equal(decryptSecret(next, sealed, 'whe_1'), s, 'a secret sealed under the previous key still opens');
  assert.equal(encryptSecret(next, s, 'whe_1').keyId, 'k2');
  // fail closed: no key, a short key, a bad key id
  for (const env of [{}, { EVENTS_WEBHOOK_SECRET_KEY: '' }, { EVENTS_WEBHOOK_SECRET_KEY: randomBytes(16).toString('base64') }, { EVENTS_WEBHOOK_SECRET_KEY: 'not base64 at all!!' }, { EVENTS_WEBHOOK_SECRET_KEY: key, EVENTS_WEBHOOK_SECRET_KEY_ID: 'bad id!' }]) assert.equal(webhookKeyRing(env), null, JSON.stringify(env).slice(0, 50));
});

test('response snippets: text only, control characters stripped, 200 characters, every secret-looking thing redacted BEFORE the cut', () => {
  const secrets = ['whsec_abcdefghij1234567890', 'ffs_live_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg', 'Bearer abc.def.ghi', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl', 'amina@example.com', '+255 712 345 678', '0712345678', 'QWxhZGRpbjpvcGVuIHNlc2FtZQ0123456789abcd', 'a'.repeat(32)];
  for (const secret of secrets) {
    const out = redactSnippet(`error: ${secret} rejected`, 'text/plain');
    assert.ok(out.includes('[redacted]') && !out.includes(secret.slice(0, 12)), `${secret} -> ${out}`);
  }
  assert.equal(redactSnippet('<html>', 'image/png'), null);
  assert.equal(redactSnippet('x', 'application/octet-stream'), null);
  assert.equal(redactSnippet('', 'text/plain'), null);
  assert.equal(redactSnippet(null), null);
  assert.equal(redactSnippet('line1\r\nline2\u0000\u0007\ttab', 'text/plain'), 'line1 line2 tab');
  assert.ok(redactSnippet('word '.repeat(200), 'text/plain').length <= 200);
  // a secret that straddles the 200-character cut is redacted first, so no half of it survives
  const straddle = redactSnippet(`${'z '.repeat(97)}whsec_${'Q'.repeat(40)}`, 'text/plain');
  assert.ok(!/whsec_|QQQQQ/.test(straddle), straddle);
  assert.equal(redactSnippet('{"ok":false,"message":"nope"}', 'application/json'), '{"ok":false,"message":"nope"}');
});

test('the retry schedule: 1m · 5m · 15m · 1h · 3h · 6h · 12h · 24h (the last repeats), ±20 % jitter', () => {
  assert.deepEqual(RETRY_MINUTES, [1, 5, 15, 60, 180, 360, 720, 1440]);
  assert.equal(retryDelayMs(1, () => 0.5), 60_000);
  assert.equal(retryDelayMs(4, () => 0.5), 3_600_000);
  assert.equal(retryDelayMs(8, () => 0.5), 86_400_000);
  assert.equal(retryDelayMs(15, () => 0.5), 86_400_000, 'beyond the table the last interval repeats');
  assert.equal(retryDelayMs(3, () => 0), 12 * 60_000);
  assert.equal(retryDelayMs(3, () => 1), 18 * 60_000);
  assert.equal(retryDelayMs(0, () => 0.5), 60_000);
  const total = RETRY_MINUTES.reduce((a, b) => a + b, 0) / 60;
  assert.ok(total > 46 && total < 47, `about 47 hours: ${total}`);
});

test('what organizers may be sent: a closed type list, no wildcard, payments / tickets / reserved never; refund rows are mapped; the unfulfilled-payment refund is dropped; projectors are allowlists', () => {
  assert.deepEqual([...WEBHOOK_EVENT_TYPES].sort(), ['bib.assigned', 'event.cancelled', 'event.updated', 'kit.collected', 'refund.updated', 'registration.cancelled', 'registration.created', 'registration.paid', 'registration.updated', 'result.corrected', 'result.disputed', 'result.published', 'result.verified']); // S6 added the four result types
  for (const t of ['*', 'registration.*', 'payment.succeeded', 'payment.failed', 'ticket.issued', 'ticket.revoked', 'registration.reserved', 'result.*', 'result.created', 'endpoint.verification', 'refund.requested', 'refund.paid']) assert.equal(isSubscribable(t), false, t);
  const row = (type, payload) => ({ id: 'obx_1', type, organizerId: 'eorg_1', eventId: 'evt_1', createdAt: new Date('2027-01-01T00:00:00Z'), payload });
  for (const internal of ['payment.succeeded', 'payment.failed', 'ticket.issued', 'ticket.revoked', 'registration.reserved', 'something.else']) assert.equal(projectOutbox(row(internal, { amountTzs: 1 })), null, internal);
  // PII and money in an outbox payload never reach the envelope
  const dirty = projectOutbox(row('registration.created', { registrationId: 'erg_1', orderId: 'eor_1', categoryId: 'c', ticketTypeId: 't', status: 'confirmed', firstName: 'Amina', phone: '+255712000000', email: 'a@b.co', amountTzs: 20000, token: 'ev1.x', payer: 'Zed' }));
  assert.deepEqual(dirty, { type: 'registration.created', data: { registrationId: 'erg_1', categoryId: 'c', ticketTypeId: 't', status: 'confirmed' } });
  assert.ok(!/Amina|255712|a@b|20000|ev1|Zed|eor_1/.test(JSON.stringify(envelopeOf(row('registration.created', {}), dirty))));
  assert.deepEqual(projectOutbox(row('registration.cancelled', { registrationId: 'erg_1', reason: 'free text from a user' })).data, { registrationId: 'erg_1', status: 'cancelled', reasonCode: 'other' });
  assert.deepEqual(projectOutbox(row('registration.updated', { registrationId: 'erg_1', changed: ['kit', 'phone', 'claimed'] })).data.changed, ['kit', 'claimed']);
  assert.deepEqual(projectOutbox(row('refund.paid', { refundId: 'r', orderId: 'eor_1', eventId: 'evt_1', scope: 'order', amountTzs: 99 })), { type: 'refund.updated', data: { orderId: 'eor_1', eventId: 'evt_1', scope: 'order', status: 'paid' } });
  assert.equal(projectOutbox(row('refund.requested', { scope: 'unfulfilled_payment' })), null, 'a late payment that was never the organizer\'s sale');
  assert.equal(projectOutbox(row('refund.requested', { scope: 'registration' })).data.status, 'requested');
  const env = envelopeOf(row('kit.collected', { registrationId: 'erg_1', collectionPointId: 'ecp_1', collectedAt: '2027-01-01T01:00:00Z' }), projectOutbox(row('kit.collected', { registrationId: 'erg_1', collectionPointId: 'ecp_1', collectedAt: '2027-01-01T01:00:00Z' })));
  assert.deepEqual(Object.keys(env), ['id', 'type', 'version', 'createdAt', 'organizerId', 'eventId', 'data']);
  assert.equal(env.version, '1');
  // control messages
  assert.equal(verificationEnvelope('abc', new Date(0)).challenge, 'abc');
  const t = testEnvelope('bib.assigned', { organizerId: 'eorg_1' });
  assert.deepEqual([t.type, t.data, t.id.startsWith('obx_test_')], ['bib.assigned.test', { test: true }, true]);
  assert.equal(testEnvelope('payment.succeeded', { organizerId: 'e' }).type, 'registration.created.test', 'an unlisted type cannot be tested into existence');
});
