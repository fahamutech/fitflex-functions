// Admin-portal audit M3: SELCOM_STRICT_AMOUNT (dormant) requires an amount and a matching open request.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createWebhookService } from '../src/services/webhook-service.mjs';

function store(seed = []) {
  const rows = [...seed];
  return {
    rows,
    findAsync: async p => rows.find(p) || null,
    filterAsync: async p => rows.filter(p),
    findByIdAsync: async id => rows.find(r => r.id === id) || null,
    insertAsync: async r => { rows.push(r); return r; },
    updateByIdAsync: async (id, patch) => Object.assign(rows.find(r => r.id === id), patch),
  };
}
function setup({ withRequest = true } = {}) {
  const subscriptions = store([{ id: 's1', status: 'payment_pending' }]);
  const webhookSeen = store();
  const paymentRequests = store(withRequest ? [{ id: 'r1', subscriptionId: 's1', status: 'pending', amountTzs: 30000 }] : []);
  return { subscriptions, webhookSeen, paymentRequests, svc: createWebhookService({ subscriptions, webhookSeen, paymentRequests }) };
}
const call = (svc, extra = {}) => svc.handleSelcom({ payment_id: 'p1', status: 'success', subscription_id: 's1', ...extra });

afterEach(() => { delete process.env.SELCOM_STRICT_AMOUNT; });

test('flag off (default): null amount still activates (old behaviour)', async () => {
  const { svc, subscriptions } = setup();
  assert.deepEqual(await call(svc), { ok: true });
  assert.equal(subscriptions.rows[0].status, 'active');
});

test('flag off: no open request still activates (old behaviour)', async () => {
  const { svc, subscriptions } = setup({ withRequest: false });
  assert.deepEqual(await call(svc, { amount: 1 }), { ok: true });
  assert.equal(subscriptions.rows[0].status, 'active');
});

test('flag on: null/missing amount is refused, nothing activates, payment_id not consumed', async () => {
  process.env.SELCOM_STRICT_AMOUNT = 'on';
  const { svc, subscriptions, webhookSeen } = setup();
  for (const amount of [undefined, null, '']) {
    const r = await call(svc, { amount });
    assert.equal(r.error, 'amount_required');
    assert.equal(r.status, 409);
  }
  assert.equal(subscriptions.rows[0].status, 'payment_pending');
  assert.equal(webhookSeen.rows.length, 0);
  // a corrected redelivery with the same payment_id then works
  assert.deepEqual(await call(svc, { amount: 30000 }), { ok: true });
  assert.equal(subscriptions.rows[0].status, 'active');
});

test('flag on: no open request is refused without consuming the claim', async () => {
  process.env.SELCOM_STRICT_AMOUNT = '1';
  const { svc, subscriptions, webhookSeen } = setup({ withRequest: false });
  const r = await call(svc, { amount: 30000 });
  assert.equal(r.error, 'no_open_request');
  assert.equal(subscriptions.rows[0].status, 'payment_pending');
  assert.equal(webhookSeen.rows.length, 0);
});

test('flag on: wrong amount is refused; exact amount activates and closes the request', async () => {
  process.env.SELCOM_STRICT_AMOUNT = 'true';
  const { svc, subscriptions, paymentRequests, webhookSeen } = setup();
  assert.equal((await call(svc, { amount: 100 })).error, 'amount_mismatch');
  assert.equal(webhookSeen.rows.length, 0);
  assert.deepEqual(await call(svc, { amount: '30000' }), { ok: true });
  assert.equal(subscriptions.rows[0].status, 'active');
  assert.equal(paymentRequests.rows[0].status, 'approved');
});

test('flag on: failed-payment and non-pending paths are unaffected', async () => {
  process.env.SELCOM_STRICT_AMOUNT = 'on';
  const { svc } = setup();
  assert.deepEqual(await svc.handleSelcom({ payment_id: 'pf', status: 'failed', subscription_id: 's1' }), { ok: true });
});
