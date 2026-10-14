// Pay by mobile money through Malipo by Tunzaa: the provider client, callback
// signature, and settling a payment request (pass, upgrade, gym plan).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  tunzaaSettings, toMsisdn, sortKeys, verifySignature, amountToTzs, createTunzaaClient, TunzaaError,
} from '../src/integrations/payments/tunzaa.mjs';
import { createMobileMoneyService } from '../src/services/mobile-money-service.mjs';
import { createAdminPaymentService } from '../src/services/admin-payment-service.mjs';
import { createSubscriptionService } from '../src/services/subscription-service.mjs';

// ── pure helpers ──────────────────────────────────────────────────────────

test('settings: sandbox unless exactly live; null without both keys', () => {
  assert.equal(tunzaaSettings({}), null);
  assert.equal(tunzaaSettings({ TUNZAA_API_KEY: 'k' }), null);
  assert.equal(tunzaaSettings({ TUNZAA_API_KEY: 'k', TUNZAA_SECRET_KEY: 's' }).environment, 'sandbox');
  assert.equal(tunzaaSettings({ TUNZAA_API_KEY: 'k', TUNZAA_SECRET_KEY: 's', TUNZAA_ENV: 'Liv' }).environment, 'sandbox');
  assert.equal(tunzaaSettings({ TUNZAA_API_KEY: ' "k" ', TUNZAA_SECRET_KEY: 's', TUNZAA_ENV: 'live' }).environment, 'live');
  assert.equal(tunzaaSettings({ TUNZAA_API_KEY: ' "k" ', TUNZAA_SECRET_KEY: 's' }).apiKey, 'k');
});

test('phone numbers become 255XXXXXXXXX or null', () => {
  for (const ok of ['0712345678', '712345678', '+255712345678', '255 712-345-678', '0654 321 098']) {
    assert.match(toMsisdn(ok), /^255[67]\d{8}$/, ok);
  }
  assert.equal(toMsisdn('0712345678'), '255712345678');
  for (const bad of ['', null, '12345', '0812345678', '+254712345678', 'abc']) assert.equal(toMsisdn(bad), null, String(bad));
});

test('callback signature: sorted keys, compact or spaced JSON, constant-time, wrong secret refused', () => {
  const payload = { status: 'COMPLETED', transaction_id: 'TXN1', amount: '60000.00', reference_id: 'pay_1', invoice_id: null, remark: 'ok: fine, thanks' };
  const secret = 'shh';
  const compact = createHmac('sha256', secret).update(JSON.stringify(sortKeys(payload))).digest('hex');
  assert.equal(verifySignature(payload, compact, secret), true);
  // key order in what arrived does not matter
  assert.equal(verifySignature(JSON.parse(JSON.stringify(payload, Object.keys(payload).reverse())), compact, secret), true);
  const spaced = createHmac('sha256', secret)
    .update('{"amount": "60000.00", "invoice_id": null, "reference_id": "pay_1", "remark": "ok: fine, thanks", "status": "COMPLETED", "transaction_id": "TXN1"}')
    .digest('hex');
  assert.equal(verifySignature(payload, spaced, secret), true);
  assert.equal(verifySignature(payload, compact.toUpperCase(), secret), true);
  assert.equal(verifySignature(payload, compact, 'other'), false);
  assert.equal(verifySignature({ ...payload, amount: '1.00' }, compact, secret), false);
  assert.equal(verifySignature(payload, 'abc', secret), false);
  assert.equal(verifySignature(payload, undefined, secret), false);
  assert.equal(verifySignature(null, compact, secret), false);
  assert.equal(verifySignature(payload, compact, ''), false);
});

test('amounts: "1500.00" → 1500; junk → null', () => {
  assert.equal(amountToTzs('1500.00'), 1500);
  assert.equal(amountToTzs('1,500'), 1500);
  assert.equal(amountToTzs('0'), null);
  assert.equal(amountToTzs('x'), null);
  assert.equal(amountToTzs(undefined), null);
});

// ── the client, against a fake Tunzaa ─────────────────────────────────────

function fakeTunzaa({ onInitiate, onStatus } = {}) {
  const calls = [];
  let tokens = 0;
  const reply = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
  const fetchFn = async (url, init) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, method: init.method, headers: init.headers, body });
    if (path === '/accounts/request/token') { tokens += 1; return reply(200, { access_token: `tok${tokens}`, expires_in: 3600, token_type: 'Bearer' }); }
    if (path === '/payments/initiate-payment') return onInitiate ? onInitiate(body, init, reply) : reply(202, { statusCode: 202, success: true, transactionID: 'TXN_1' });
    if (path.startsWith('/payments/check-status/')) return onStatus ? onStatus(path, reply) : reply(200, { data: { transactionID: 'TXN_1', status: 'PENDING', amount: '60000.00' } });
    return reply(404, {});
  };
  return { fetchFn, calls, get tokens() { return tokens; } };
}
const settings = { apiKey: 'k', secretKey: 's', environment: 'sandbox', baseUrl: 'https://pay.example' };

test('client: one token for many calls; environment header; amount as string; reference passed', async () => {
  const f = fakeTunzaa();
  const c = createTunzaaClient({ settings, fetchFn: f.fetchFn });
  const a = await c.initiatePayment({ msisdn: '255712345678', amountTzs: 60000, reference: 'pay_1' });
  assert.equal(a.transactionId, 'TXN_1');
  await c.checkStatus('TXN_1');
  assert.equal(f.tokens, 1);
  const init = f.calls.find((x) => x.path === '/payments/initiate-payment');
  assert.deepEqual(init.body, { customer_msisdn: '255712345678', amount: '60000', reference: 'pay_1' });
  assert.equal(init.headers['X-Environment'], 'sandbox');
  assert.equal(init.headers.Authorization, 'Bearer tok1');
});

test('client: a refused token is replaced once; a sandbox scenario is sent only in sandbox', async () => {
  let first = true;
  const f = fakeTunzaa({ onInitiate: (_b, _i, reply) => { if (first) { first = false; return reply(401, {}); } return reply(202, { success: true, transactionID: 'TXN_2' }); } });
  const c = createTunzaaClient({ settings, fetchFn: f.fetchFn });
  const out = await c.initiatePayment({ msisdn: '255712345678', amountTzs: 1000, reference: 'r', scenario: 'failure' });
  assert.equal(out.transactionId, 'TXN_2');
  assert.equal(f.tokens, 2);
  assert.equal(f.calls.filter((x) => x.path === '/payments/initiate-payment')[1].headers['X-Sandbox-Scenario'], 'failure');

  const live = fakeTunzaa();
  const lc = createTunzaaClient({ settings: { ...settings, environment: 'live' }, fetchFn: live.fetchFn });
  await lc.initiatePayment({ msisdn: '255712345678', amountTzs: 1000, reference: 'r', scenario: 'failure' });
  const liveCall = live.calls.find((x) => x.path === '/payments/initiate-payment');
  assert.equal(liveCall.headers['X-Sandbox-Scenario'], undefined);
  assert.equal(liveCall.headers['X-Environment'], 'live');
});

test('client: a declined request and an unreachable provider are errors', async () => {
  const f = fakeTunzaa({ onInitiate: (_b, _i, reply) => reply(200, { success: false, message: 'Invalid number' }) });
  const c = createTunzaaClient({ settings, fetchFn: f.fetchFn });
  await assert.rejects(c.initiatePayment({ msisdn: '255712345678', amountTzs: 1, reference: 'r' }), (e) => e instanceof TunzaaError && e.code === 'rejected');
  const down = createTunzaaClient({ settings, fetchFn: async () => { throw new Error('ECONNRESET'); } });
  await assert.rejects(down.checkStatus('T'), (e) => e.code === 'unreachable');
});

test('client: status is read from data', async () => {
  const f = fakeTunzaa({ onStatus: (_p, reply) => reply(200, { success: true, data: { transactionID: 'TXN_9', status: 'completed', amount: '1000.00', remark: 'done' } }) });
  const c = createTunzaaClient({ settings, fetchFn: f.fetchFn });
  const s = await c.checkStatus('TXN_9');
  assert.deepEqual([s.status, s.amountTzs, s.transactionId, s.remark], ['COMPLETED', 1000, 'TXN_9', 'done']);
});

// ── settling payment requests ─────────────────────────────────────────────

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
  };
}
const DAY = 86_400_000;
const PRICES = { basic: 60_000, pro: 120_000 };
const tiers = Object.entries(PRICES).map(([key, monthlyPrice]) => ({ key, label: key, monthlyPrice, visits: 20, gymAccess: 'standard' }));

function world({ enabled = true, canSettle = true, status = {}, subs = [], requests = [] } = {}) {
  const subscriptions = memStore(subs);
  const paymentRequests = memStore(requests);
  const audit = [];
  const auditLog = { async insertAsync(e) { audit.push(e); } };
  const adminPaymentService = createAdminPaymentService({ paymentRequests, subscriptions, users: memStore(), auditLog });
  const remote = { initiated: [], statusOf: { TXN_1: { status: 'PENDING', amount: '60000.00' }, ...status }, failInitiate: null };
  const clock = { t: 1_800_000_000_000 };
  const client = {
    environment: 'sandbox',
    async initiatePayment(args) {
      if (remote.failInitiate) throw new TunzaaError('no', { code: remote.failInitiate, status: remote.failInitiate === 'provider_error' ? 500 : 502 });
      remote.initiated.push(args);
      return { transactionId: `TXN_${remote.initiated.length}` };
    },
    async checkStatus(id) {
      const s = remote.statusOf[id] || { status: 'PENDING', amount: null };
      return { status: s.status, amountTzs: s.amount ? Number(s.amount) : null, transactionId: id, remark: s.remark || null };
    },
  };
  const service = createMobileMoneyService({
    paymentRequests, subscriptions, adminPaymentService, auditLog, client,
    enabled: () => enabled, canSettle: () => canSettle, now: () => clock.t,
  });
  const subscriptionService = createSubscriptionService({
    subscriptions, paymentRequests, checkins: memStore(), gyms: [],
    settingsService: { priceForTier: (t) => PRICES[t] ?? 0, visitCapForTier: () => null, publicTiers: () => tiers },
    publicUserId: async () => 'FF-1',
  });
  return { subscriptions, paymentRequests, audit, service, subscriptionService, remote, adminPaymentService, clock };
}

const pendingPass = (over = {}) => ({
  subs: [{ id: 'sub_new', memberId: 'm1', type: 'platform_pass', tier: 'basic', status: 'payment_pending', startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * DAY).toISOString() }],
  requests: [{ id: 'pay_1', memberId: 'm1', subscriptionId: 'sub_new', tier: 'basic', amountTzs: 60_000, status: 'pending', provider: 'admin_approved', reference: null, note: null, requestedAt: new Date().toISOString() }],
  ...over,
});

test('options say whether paying is on, and in which environment', () => {
  assert.deepEqual(world({ enabled: false }).service.options(), { enabled: false, provider: 'tunzaa', environment: null });
  assert.deepEqual(world().service.options(), { enabled: true, provider: 'tunzaa', environment: 'sandbox' });
  // sandbox payments settle real plans: not offered unless that was asked for
  assert.deepEqual(world({ canSettle: false }).service.options(), { enabled: false, provider: 'tunzaa', environment: null });
});

test('against the sandbox without opting in, paying is closed', async () => {
  const w = world({ ...pendingPass(), canSettle: false });
  assert.equal((await w.service.pay({ memberId: 'm1', paymentRequestId: 'pay_1', phone: '0712345678' })).error, 'feature_disabled');
});

test('pay sends the request\'s own amount and reference, and marks it in flight', async () => {
  const w = world(pendingPass());
  const out = await w.service.pay({ memberId: 'm1', paymentRequestId: 'pay_1', phone: '0712345678' });
  assert.equal(out.status, 202);
  assert.equal(out.state, 'in_progress');
  assert.equal(w.remote.initiated.length, 1);
  const sent = w.remote.initiated[0];
  assert.deepEqual([sent.msisdn, sent.amountTzs, sent.scenario], ['255712345678', 60_000, null]);
  assert.match(sent.reference, /^pay_1\.[a-z0-9]+$/, 'our reference: the request id and an attempt');
  const row = w.paymentRequests.rows[0];
  assert.deepEqual([row.provider, row.reference, row.status], ['tunzaa', 'TXN_1', 'pending']);
});

test('pay is refused when off, for someone else\'s request, a bad phone, a decided or non-pass request', async () => {
  assert.equal((await world({ ...pendingPass(), enabled: false }).service.pay({ memberId: 'm1', paymentRequestId: 'pay_1', phone: '0712345678' })).error, 'feature_disabled');
  const w = world(pendingPass());
  assert.equal((await w.service.pay({ memberId: 'someone', paymentRequestId: 'pay_1', phone: '0712345678' })).error, 'not_found');
  assert.equal((await w.service.pay({ memberId: 'm1', paymentRequestId: 'pay_1', phone: '12' })).error, 'invalid_phone');
  assert.equal((await w.service.pay({ memberId: 'm1', paymentRequestId: 'nope', phone: '0712345678' })).error, 'not_found');
  assert.equal(w.remote.initiated.length, 0);

  const decided = world(pendingPass());
  decided.paymentRequests.rows[0].status = 'approved';
  assert.equal((await decided.service.pay({ memberId: 'm1', paymentRequestId: 'pay_1', phone: '0712345678' })).error, 'payment_not_pending');

  const order = world({ requests: [{ id: 'pay_o', memberId: 'm1', subscriptionId: null, orderId: 'ord_1', amountTzs: 5000, status: 'pending', provider: 'admin_approved', reference: null }] });
  assert.equal((await order.service.pay({ memberId: 'm1', paymentRequestId: 'pay_o', phone: '0712345678' })).error, 'not_payable_this_way');
});

test('a second tap does not send a second prompt', async () => {
  const w = world(pendingPass());
  await w.service.pay({ memberId: 'm1', paymentRequestId: 'pay_1', phone: '0712345678' });
  const again = await w.service.pay({ memberId: 'm1', paymentRequestId: 'pay_1', phone: '0712345678' });
  assert.equal(again.state, 'in_progress');
  assert.equal(again.alreadyRequested, true);
  assert.equal(w.remote.initiated.length, 1);
});

test('a request the provider refused outright is released at once', async () => {
  const w = world(pendingPass());
  w.remote.failInitiate = 'rejected';
  assert.equal((await w.service.pay({ memberId: 'm1', paymentRequestId: 'pay_1', phone: '0712345678' })).error, 'provider_rejected');
  assert.deepEqual([w.paymentRequests.rows[0].provider, w.paymentRequests.rows[0].reference], ['admin_approved', null]);
  w.remote.failInitiate = null;
  assert.equal((await w.service.pay({ memberId: 'm1', paymentRequestId: 'pay_1', phone: '0712345678' })).status, 202);
});

test('a call that may have reached the phone keeps its claim: no second prompt, then it expires', async () => {
  const w = world(pendingPass());
  w.remote.failInitiate = 'unreachable';
  assert.equal((await w.service.pay({ memberId: 'm1', paymentRequestId: 'pay_1', phone: '0712345678' })).error, 'provider_unavailable');
  assert.equal(w.paymentRequests.rows[0].provider, 'tunzaa');
  assert.match(w.paymentRequests.rows[0].reference, /^pending:/);
  w.remote.failInitiate = null;
  const again = await w.service.pay({ memberId: 'm1', paymentRequestId: 'pay_1', phone: '0712345678' });
  assert.equal(again.alreadyRequested, true);
  assert.equal(w.remote.initiated.length, 0);
  // after the claim expires the member can try again
  w.clock.t += 3 * 60_000;
  assert.equal((await w.service.pay({ memberId: 'm1', paymentRequestId: 'pay_1', phone: '0712345678' })).status, 202);
  assert.equal(w.remote.initiated.length, 1);
});

test('a prompt whose answer was lost still settles through its signed callback', async () => {
  const w = world(pendingPass());
  w.remote.failInitiate = 'unreachable';
  await w.service.pay({ memberId: 'm1', paymentRequestId: 'pay_1', phone: '0712345678' });
  w.remote.statusOf.TXN_LOST = { status: 'COMPLETED', amount: '60000.00' };
  const out = await w.service.handleCallback({ transaction_id: 'TXN_LOST', reference_id: 'pay_1.k3j2', status: 'COMPLETED', amount: '60000.00' });
  assert.equal(out.state, 'completed');
  assert.equal(w.paymentRequests.rows[0].status, 'approved');
  assert.equal(w.paymentRequests.rows[0].reference, 'TXN_LOST');
  assert.equal(w.subscriptions.rows[0].status, 'active');
});

test('completed: callback confirms with Tunzaa, approves and activates the pass; repeats are harmless', async () => {
  const w = world(pendingPass());
  await w.service.pay({ memberId: 'm1', paymentRequestId: 'pay_1', phone: '0712345678' });
  w.remote.statusOf.TXN_1 = { status: 'COMPLETED', amount: '60000.00' };
  const out = await w.service.handleCallback({ transaction_id: 'TXN_1', reference_id: 'pay_1', status: 'COMPLETED', amount: '60000.00' });
  assert.deepEqual([out.status, out.state], [200, 'completed']);
  assert.equal(w.paymentRequests.rows[0].status, 'approved');
  assert.equal(w.paymentRequests.rows[0].reference, 'TXN_1');
  assert.equal(w.paymentRequests.rows[0].decidedBy, 'tunzaa');
  assert.equal(w.subscriptions.rows[0].status, 'active');
  const again = await w.service.handleCallback({ transaction_id: 'TXN_1', reference_id: 'pay_1', status: 'COMPLETED', amount: '60000.00' });
  assert.equal(again.state, 'completed');
  assert.equal(w.paymentRequests.rows.length, 1);
});

test('a callback saying COMPLETED is not believed unless Tunzaa says so too', async () => {
  const w = world(pendingPass());
  await w.service.pay({ memberId: 'm1', paymentRequestId: 'pay_1', phone: '0712345678' });
  const out = await w.service.handleCallback({ transaction_id: 'TXN_1', reference_id: 'pay_1', status: 'COMPLETED', amount: '60000.00' });
  assert.equal(out.state, 'in_progress');
  assert.equal(w.paymentRequests.rows[0].status, 'pending');
  assert.equal(w.subscriptions.rows[0].status, 'payment_pending');
});

test('a callback is acted on only as far as Tunzaa confirms it', async () => {
  const w = world(pendingPass());
  await w.service.pay({ memberId: 'm1', paymentRequestId: 'pay_1', phone: '0712345678' });
  // Tunzaa says that transaction is still pending: nothing happens
  w.remote.statusOf.TXN_X = { status: 'PENDING', amount: null };
  assert.equal((await w.service.handleCallback({ transaction_id: 'TXN_X', reference_id: 'pay_1.a', status: 'COMPLETED' })).state, 'in_progress');
  assert.equal(w.paymentRequests.rows[0].status, 'pending');
  assert.equal((await w.service.handleCallback({ transaction_id: 'T', reference_id: 'pay_zzz.a' })).ignored, 'unknown_reference');
  assert.equal((await w.service.handleCallback({ reference_id: 'pay_1' })).error, 'invalid_payload');
});

test('an amount Tunzaa does not report is not good enough', async () => {
  const w = world(pendingPass());
  await w.service.pay({ memberId: 'm1', paymentRequestId: 'pay_1', phone: '0712345678' });
  w.remote.statusOf.TXN_1 = { status: 'COMPLETED', amount: null };
  const out = await w.service.refresh({ memberId: 'm1', paymentRequestId: 'pay_1' });
  assert.deepEqual([out.state, out.reason], ['held', 'amount_mismatch']);
  assert.equal(w.paymentRequests.rows[0].status, 'pending');
});

test('money arriving for a request that was closed meanwhile is audited, not lost', async () => {
  const w = world(pendingPass());
  await w.service.pay({ memberId: 'm1', paymentRequestId: 'pay_1', phone: '0712345678' });
  w.paymentRequests.rows[0].status = 'cancelled';
  w.remote.statusOf.TXN_1 = { status: 'COMPLETED', amount: '60000.00' };
  const out = await w.service.handleCallback({ transaction_id: 'TXN_1', reference_id: 'pay_1.a', status: 'COMPLETED' });
  assert.equal(out.state, 'failed'); // not approved
  assert.equal(w.subscriptions.rows[0].status, 'payment_pending');
  assert.ok(w.audit.some((a) => a.action === 'payment_mobile_money_orphaned' && a.target === 'pay_1'));
});

test('prompts are limited per phone, and a staff-cancelled plan with a live prompt is not cancelled', async () => {
  const w = world(pendingPass());
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await w.service.pay({ memberId: 'm1', paymentRequestId: 'pay_1', phone: '0712345678' })).status, 202);
    w.remote.statusOf[`TXN_${i + 1}`] = { status: 'FAILED', amount: null };
    await w.service.refresh({ memberId: 'm1', paymentRequestId: 'pay_1' });
  }
  assert.equal((await w.service.pay({ memberId: 'm1', paymentRequestId: 'pay_1', phone: '0712345678' })).error, 'too_many_attempts');

  const g = world({
    subs: [{ id: 'sub_g', memberId: 'm1', type: 'direct_sub', plan: 'monthly', homeGymId: 'gym_1', status: 'payment_pending', startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * DAY).toISOString() }],
    requests: [{ id: 'pay_g', memberId: 'm1', subscriptionId: 'sub_g', plan: 'monthly', gymId: 'gym_1', amountTzs: 80_000, status: 'pending', provider: 'admin_approved', reference: null }],
  });
  await g.service.pay({ memberId: 'm1', paymentRequestId: 'pay_g', phone: '0712345678' });
  const cancelled = await g.subscriptionService.cancelTrainerPass({ trainerUserId: 'm1', subscriptionId: 'sub_g' });
  assert.equal(cancelled.error, 'payment_in_progress');
});

test('the wrong amount is held for staff, never approved', async () => {
  const w = world(pendingPass());
  await w.service.pay({ memberId: 'm1', paymentRequestId: 'pay_1', phone: '0712345678' });
  w.remote.statusOf.TXN_1 = { status: 'COMPLETED', amount: '1000.00' };
  const out = await w.service.refresh({ memberId: 'm1', paymentRequestId: 'pay_1' });
  assert.deepEqual([out.state, out.reason], ['held', 'amount_mismatch']);
  assert.equal(w.paymentRequests.rows[0].status, 'pending');
  assert.ok(w.audit.some((a) => a.action === 'payment_mobile_money_amount_mismatch'));
});

test('failed: the request is released so the member can try again', async () => {
  const w = world(pendingPass());
  await w.service.pay({ memberId: 'm1', paymentRequestId: 'pay_1', phone: '0712345678' });
  w.remote.statusOf.TXN_1 = { status: 'FAILED', amount: null, remark: 'Insufficient funds' };
  const out = await w.service.refresh({ memberId: 'm1', paymentRequestId: 'pay_1' });
  assert.equal(out.state, 'failed');
  assert.deepEqual([w.paymentRequests.rows[0].status, w.paymentRequests.rows[0].provider, w.paymentRequests.rows[0].reference], ['pending', 'admin_approved', null]);
  assert.equal(w.subscriptions.rows[0].status, 'payment_pending', 'the plan still waits; nothing was rejected');
  const retry = await w.service.pay({ memberId: 'm1', paymentRequestId: 'pay_1', phone: '0712345678' });
  assert.equal(retry.status, 202);
  assert.equal(w.remote.initiated.length, 2);
});

test('refresh is the member\'s own, and an unconfirmed lookup keeps waiting', async () => {
  const w = world(pendingPass());
  assert.equal((await w.service.refresh({ memberId: 'other', paymentRequestId: 'pay_1' })).error, 'not_found');
  assert.equal((await w.service.refresh({ memberId: 'm1', paymentRequestId: 'pay_1' })).state, 'none');
  await w.service.pay({ memberId: 'm1', paymentRequestId: 'pay_1', phone: '0712345678' });
  assert.equal((await w.service.refresh({ memberId: 'm1', paymentRequestId: 'pay_1' })).state, 'in_progress');
});

test('a pass upgrade paid this way upgrades the plan in place', async () => {
  const start = new Date(Date.now() - 25 * DAY).toISOString();
  const end = new Date(Date.now() + 5 * DAY).toISOString();
  const w = world({ subs: [{ id: 'sub_old', memberId: 'm1', type: 'platform_pass', tier: 'basic', status: 'active', startedAt: start, cycleStartedAt: start, expiresAt: end, renewsAt: end }] });
  const up = await w.subscriptionService.upgradePass({ memberId: 'm1', tier: 'pro' });
  assert.equal(up.paymentRequest.amountTzs, 60_000);
  const paid = await w.service.pay({ memberId: 'm1', paymentRequestId: up.paymentRequest.id, phone: '0712345678' });
  assert.equal(paid.status, 202, 'an upgrade is payable this way');
  w.remote.statusOf.TXN_1 = { status: 'COMPLETED', amount: '60000.00' };
  const done = await w.service.refresh({ memberId: 'm1', paymentRequestId: up.paymentRequest.id });
  assert.equal(done.state, 'completed');
  const sub = w.subscriptions.rows.find((s) => s.id === 'sub_old');
  assert.deepEqual([sub.tier, sub.status, sub.expiresAt, sub.cycleStartedAt], ['pro', 'active', end, start]);
  assert.equal(w.subscriptions.rows.length, 1);
});

test('an upgrade whose plan ended meanwhile is held, not approved', async () => {
  const start = new Date(Date.now() - 25 * DAY).toISOString();
  const w = world({ subs: [{ id: 'sub_old', memberId: 'm1', type: 'platform_pass', tier: 'basic', status: 'active', startedAt: start, cycleStartedAt: start, expiresAt: new Date(Date.now() + DAY).toISOString() }] });
  const up = await w.subscriptionService.upgradePass({ memberId: 'm1', tier: 'pro' });
  await w.service.pay({ memberId: 'm1', paymentRequestId: up.paymentRequest.id, phone: '0712345678' });
  w.subscriptions.rows[0].expiresAt = new Date(Date.now() - DAY).toISOString();
  w.remote.statusOf.TXN_1 = { status: 'COMPLETED', amount: '60000.00' };
  const out = await w.service.refresh({ memberId: 'm1', paymentRequestId: up.paymentRequest.id });
  assert.deepEqual([out.state, out.reason], ['held', 'upgrade_plan_not_active']);
  assert.equal(w.paymentRequests.rows[0].status, 'pending');
  assert.ok(w.audit.some((a) => a.action === 'payment_mobile_money_held'));
});
