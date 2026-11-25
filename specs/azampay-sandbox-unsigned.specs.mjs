// AzamPay's sandbox has no public key to check callback signatures with (its
// /azampay/v1/public-key answered 404 on 2026-11-17), so every sandbox callback was
// refused with 403. AZAMPAY_SANDBOX_UNSIGNED_CALLBACKS (owner decision 2026-11-17,
// sandbox only, never live): such a callback is acted on only when it names the
// attempt that is open right now — our reference and the transaction id AzamPay gave
// for that prompt — with the exact amount. Anything else changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCallback, createAzamPayClient } from '../src/integrations/payments/azampay.mjs';
import { createMobileMoneyService } from '../src/services/mobile-money-service.mjs';
import { createAdminPaymentService } from '../src/services/admin-payment-service.mjs';

const settings = (over = {}) => ({
  appName: 'FitFlex', clientId: 'cid', clientSecret: 'secret-value', apiKey: null, environment: 'sandbox',
  hosts: { auth: 'https://auth.test', checkout: 'https://checkout.test', disburse: 'https://disburse.test' },
  callbackUser: null, callbackPassword: null, ...over,
});

/** AzamPay as the sandbox behaves today: a token, but no public key (404). */
function sandboxWithoutKey() {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    const reply = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
    if (url.includes('GenerateToken')) return reply(200, { data: { accessToken: 'tok', expire: new Date(Date.now() + 3600_000).toISOString() } });
    if (url.includes('public-key')) return reply(404, { message: 'Not Found' });
    return reply(404, {});
  };
  return { calls, fetchFn };
}

const body = (over = {}) => ({
  message: 'ok', user: '', password: '', clientId: 'cid', transactionstatus: 'success', operator: 'Mpesa',
  reference: 'AZ_REF', externalreference: 'AZ_EXT', utilityref: 'pay_1.a1', amount: '60000', transid: 'TXN_1',
  msisdn: '255754123456', mnoreference: 'MNO1', signature: 'c2lnbmF0dXJl', ...over,
});

test('client: without the switch, a sandbox callback with no usable key is refused, and the reason says why', async () => {
  const c = createAzamPayClient({ settings: settings(), fetchFn: sandboxWithoutKey().fetchFn });
  assert.deepEqual(await c.checkCallback(body()), { ok: false, signed: false, reason: 'public_key_unavailable' });
  assert.equal(await c.verifyCallback(body()), false);
  assert.deepEqual(await c.checkCallback(body({ signature: '' })), { ok: false, signed: false, reason: 'unsigned' });
  assert.deepEqual(await c.checkCallback(body({ clientId: 'other' })), { ok: false, signed: false, reason: 'client_id_mismatch' });
});

test('client: with the switch, the sandbox lets an unchecked callback through as UNSIGNED; a wrong clientId or callback password is still refused', async () => {
  const c = createAzamPayClient({ settings: settings(), fetchFn: sandboxWithoutKey().fetchFn });
  const allow = { allowUnsigned: true };
  assert.deepEqual(await c.checkCallback(body(), allow), { ok: true, signed: false, reason: 'public_key_unavailable' });
  assert.deepEqual(await c.checkCallback(body({ signature: undefined }), allow), { ok: true, signed: false, reason: 'unsigned' });
  const { clientId, ...noClient } = body();
  void clientId;
  assert.deepEqual(await c.checkCallback(noClient, allow), { ok: true, signed: false, reason: 'client_id_missing' });
  assert.deepEqual(await c.checkCallback(body({ clientId: 'other' }), allow), { ok: false, signed: false, reason: 'client_id_mismatch' });
  const strict = createAzamPayClient({ settings: settings({ callbackPassword: 'pw' }), fetchFn: sandboxWithoutKey().fetchFn });
  assert.equal((await strict.checkCallback(body({ password: 'nope' }), allow)).reason, 'callback_auth_mismatch');
});

test('client: the switch never applies to live', async () => {
  const c = createAzamPayClient({ settings: settings({ environment: 'live' }), fetchFn: sandboxWithoutKey().fetchFn });
  assert.deepEqual(await c.checkCallback(body(), { allowUnsigned: true }), { ok: false, signed: false, reason: 'public_key_unavailable' });
  const { clientId, ...noClient } = body();
  void clientId;
  assert.equal((await c.checkCallback(noClient, { allowUnsigned: true })).ok, false);
});

test('client: a failed call to AzamPay is logged with its status and message, never the token or the secret', async () => {
  const lines = [];
  const warn = console.warn;
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    const c = createAzamPayClient({ settings: settings(), fetchFn: sandboxWithoutKey().fetchFn });
    await c.checkCallback(body());
  } finally { console.warn = warn; }
  const line = lines.find((l) => l.includes('call_failed'));
  assert.ok(line, 'a call_failed line');
  assert.match(line, /"what":"public_key"/);
  assert.match(line, /"status":404/);
  for (const secret of ['tok', 'secret-value', 'c2lnbmF0dXJl']) assert.ok(!line.includes(secret), `no ${secret}`);
});

// ── the service: an unsigned callback must name the open attempt ──────────────

function memStore(rows = []) {
  return {
    rows,
    async filterAsync(fn) { return rows.filter(fn); },
    async findAsync(fn) { return rows.find(fn) || null; },
    async findByIdAsync(id) { return rows.find((r) => r.id === id) || null; },
    async allAsync() { return [...rows]; },
    async insertAsync(row) { rows.push(row); return row; },
    async updateByIdAsync(id, patch) {
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows[i] = { ...rows[i], ...patch };
      return rows[i] || null;
    },
    async updateByIdWhereAsync(id, where, patch) {
      const i = rows.findIndex((r) => r.id === id);
      if (i < 0) return null;
      for (const [column, expected] of Object.entries(where || {})) {
        const current = rows[i][column] ?? null;
        if (Array.isArray(expected) ? !expected.includes(current) : current !== expected) return null;
      }
      rows[i] = { ...rows[i], ...patch };
      return rows[i];
    },
  };
}

function world() {
  const now = Date.now();
  const subscriptions = memStore([{ id: 'sub_1', memberId: 'm1', type: 'platform_pass', tier: 'basic', status: 'payment_pending', startedAt: new Date(now).toISOString(), expiresAt: new Date(now + 30 * 86_400_000).toISOString() }]);
  const paymentRequests = memStore([{ id: 'pay_1', memberId: 'm1', subscriptionId: 'sub_1', tier: 'basic', amountTzs: 60_000, status: 'pending', provider: 'admin_approved', reference: null, note: null, requestedAt: new Date(now).toISOString() }]);
  const audit = [];
  const auditLog = { async insertAsync(e) { audit.push(e); } };
  const adminPaymentService = createAdminPaymentService({ paymentRequests, subscriptions, users: memStore(), auditLog });
  let n = 0;
  const client = {
    environment: 'sandbox', confirmsByCallback: true, parseCallback,
    async initiatePayment() { n += 1; return { transactionId: `TXN_${n}` }; },
  };
  const service = createMobileMoneyService({ paymentRequests, subscriptions, adminPaymentService, auditLog, client, enabled: () => true, canSettle: () => true });
  return { service, audit, clientRef: client, req: () => paymentRequests.rows[0], sub: () => subscriptions.rows[0] };
}
const PAY = { memberId: 'm1', paymentRequestId: 'pay_1', phone: '0754123456' };

test('service: an unsigned success that names the open attempt and its transaction, with the exact amount, settles it once', async () => {
  const w = world();
  await w.service.pay(PAY);
  const out = await w.service.handleCallback(body({ utilityref: 'pay_1.a1', transid: 'TXN_1' }), { signed: false });
  assert.deepEqual([out.status, out.state], [200, 'completed']);
  assert.deepEqual([w.req().status, w.sub().status], ['approved', 'active']);
});

test('service: an unsigned callback that does not name the open attempt changes nothing (403)', async () => {
  const w = world();
  // no prompt out yet
  assert.deepEqual([(await w.service.handleCallback(body(), { signed: false })).status], [403]);
  await w.service.pay(PAY);
  for (const over of [
    { transid: 'TXN_9', reference: 'X', externalreference: 'Y' },   // a transaction we never sent
    { utilityref: 'pay_404.a1' },                                   // a request that does not exist
  ]) {
    const out = await w.service.handleCallback(body(over), { signed: false });
    assert.deepEqual([out.status, out.error], [403, 'unsigned_unmatched'], JSON.stringify(over));
  }
  assert.deepEqual([w.req().status, w.sub().status], ['pending', 'payment_pending']);
  assert.ok(w.audit.some((a) => a.action === 'payment_mobile_money_unsigned_refused'));
});

test('service: an unsigned success for the open attempt with the wrong amount is held, not approved', async () => {
  const w = world();
  await w.service.pay(PAY);
  const out = await w.service.handleCallback(body({ amount: '100' }), { signed: false });
  assert.deepEqual([out.state, out.reason], ['held', 'amount_mismatch']);
  assert.equal(w.req().status, 'pending');
});

test('service: once settled, an unsigned repeat is refused and activates nothing twice', async () => {
  const w = world();
  await w.service.pay(PAY);
  await w.service.handleCallback(body(), { signed: false });
  const again = await w.service.handleCallback(body(), { signed: false });
  assert.equal(again.status, 403);
  assert.equal(w.req().status, 'approved');
});

// ── AzamPay's sandbox calls back before its checkout call answers (2026-11-25) ──

/** A world whose AzamPay delivers `early` callbacks (unsigned) while the checkout call is still under way. */
function earlyWorld(early, { transactionId = 'TXN_1' } = {}) {
  const w = world();
  const seen = [];
  const svc = w.service;
  // Reach the client the service holds: its initiatePayment is the hook point.
  return {
    ...w, seen,
    async pay() {
      const original = w.clientRef.initiatePayment;
      w.clientRef.initiatePayment = async (...a) => {
        for (const cb of early) seen.push(await svc.handleCallback(cb, { signed: false }));
        return { transactionId };
      };
      try { return await svc.pay(PAY); } finally { w.clientRef.initiatePayment = original; }
    },
  };
}

test('service: an unsigned success that arrives BEFORE the checkout answer is kept, then settles once the answer names it', async () => {
  const w = earlyWorld([body({ utilityref: 'pay_1.a1', transid: 'TXN_1', reference: 'TXN_1', externalreference: 'TXN_1' })]);
  const lines = [];
  const info = console.info;
  console.info = (...a) => lines.push(a.join(' '));
  let out;
  try { out = await w.pay(); } finally { console.info = info; }
  assert.deepEqual(w.seen.map((s) => [s.status, s.state]), [[200, 'parked']]);
  assert.deepEqual([out.status, out.state], [200, 'completed']);
  assert.deepEqual([w.req().status, w.sub().status], ['approved', 'active']);
  assert.ok(w.audit.some((a) => a.action === 'payment_mobile_money_unsigned_parked'));
  assert.ok(lines.some((l) => l.includes('[azampay] early_callback') && l.includes('"outcome":"completed"')));
  // A repeat afterwards activates nothing twice.
  assert.equal((await w.service.handleCallback(body({ transid: 'TXN_1' }), { signed: false })).status, 403);
});

test('service: a kept early callback for ANOTHER transaction, or with the wrong amount, approves nothing', async () => {
  const other = earlyWorld([body({ transid: 'TXN_X', reference: 'TXN_X', externalreference: 'TXN_X' })]);
  const a = await other.pay();
  assert.deepEqual([a.status, a.state], [202, 'in_progress']);
  assert.deepEqual([other.req().status, other.sub().status], ['pending', 'payment_pending']);

  const short = earlyWorld([body({ transid: 'TXN_1', amount: '100' })]);
  const b = await short.pay();
  assert.equal(b.state, 'in_progress');
  assert.equal(short.req().status, 'pending');
  assert.ok(short.audit.some((e) => e.action === 'payment_mobile_money_amount_mismatch'));
});

test('service: early callbacks are bounded per request (5); the rest are refused as before', async () => {
  const flood = Array.from({ length: 8 }, (_, i) => body({ transid: `TXN_F${i}`, reference: `R${i}`, externalreference: `E${i}` }));
  const w = earlyWorld(flood);
  await w.pay();
  assert.deepEqual(w.seen.map((s) => s.state ?? s.error), [...Array(5).fill('parked'), ...Array(3).fill('unsigned_unmatched')]);
  assert.equal(w.req().status, 'pending');
});
