// Audit M2: Selcom webhook hardening (token header/query + redaction, replay, server confirm).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createWebhookService } from '../src/services/webhook-service.mjs';
import { hasWebhookToken, redactWebhookToken } from '../src/integrations/payments/selcom-token.mjs';

const SECRET = 'whsec_test_123';
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
function setup(confirmClient) {
  const subscriptions = store([{ id: 's1', status: 'payment_pending' }]);
  const webhookSeen = store();
  const paymentRequests = store([{ id: 'r1', subscriptionId: 's1', status: 'pending', amountTzs: 30000 }]);
  const args = { subscriptions, webhookSeen, paymentRequests };
  if (confirmClient) args.confirmClient = confirmClient;
  return { subscriptions, webhookSeen, paymentRequests, svc: createWebhookService(args) };
}
const call = (svc, extra = {}) => svc.handleSelcom({ payment_id: 'p1', status: 'success', subscription_id: 's1', amount: 30000, ...extra });

afterEach(() => {
  delete process.env.SELCOM_WEBHOOK_SECRET;
  delete process.env.SELCOM_WEBHOOK_SERVER_CONFIRM;
});

// --- token
test('token via header works; via query still works; wrong/absent/unconfigured is refused', () => {
  process.env.SELCOM_WEBHOOK_SECRET = SECRET;
  assert.equal(hasWebhookToken({ headers: { 'x-selcom-webhook-token': SECRET }, query: {} }), true);
  assert.equal(hasWebhookToken({ headers: {}, query: { token: SECRET } }), true);
  assert.equal(hasWebhookToken({ headers: { 'x-selcom-webhook-token': 'nope' }, query: { token: SECRET } }), true);
  assert.equal(hasWebhookToken({ headers: { 'x-selcom-webhook-token': 'nope' }, query: { token: 'nope' } }), false);
  assert.equal(hasWebhookToken({ headers: {}, query: {} }), false);
  delete process.env.SELCOM_WEBHOOK_SECRET;
  assert.equal(hasWebhookToken({ headers: { 'x-selcom-webhook-token': SECRET }, query: {} }), false);
});

test('the token is absent from everything a logger could print after redaction', () => {
  const req = {
    originalUrl: `/webhooks/selcom?a=1&token=${SECRET}&b=2`, url: `/webhooks/selcom?token=${SECRET}`,
    query: { token: SECRET }, headers: { 'x-selcom-webhook-token': SECRET },
  };
  redactWebhookToken(req);
  assert.equal(JSON.stringify(req).includes(SECRET), false);
  assert.equal(req.originalUrl, '/webhooks/selcom?a=1&token=[redacted]&b=2');
});

// --- replay
test('replay of the same payment_id is a no-op (no second activation, no second claim)', async () => {
  const { svc, subscriptions, webhookSeen, paymentRequests } = setup();
  assert.deepEqual(await call(svc), { ok: true });
  subscriptions.rows[0].status = 'payment_pending'; // even if something reset it, the id is spent
  const again = await call(svc);
  assert.deepEqual(again, { ok: true, idempotent: true });
  assert.equal(subscriptions.rows[0].status, 'payment_pending');
  assert.equal(webhookSeen.rows.length, 1);
  assert.equal(paymentRequests.rows[0].status, 'approved');
});

// --- server confirm
test('flag off (default): confirm client is never asked and activation is unchanged', async () => {
  let asked = 0;
  const { svc, subscriptions } = setup({ confirm: async () => { asked++; return { confirmed: false }; } });
  assert.deepEqual(await call(svc), { ok: true });
  assert.equal(asked, 0);
  assert.equal(subscriptions.rows[0].status, 'active');
});

test('flag on + confirmed: activates and the client got payment, subscription and amount', async () => {
  process.env.SELCOM_WEBHOOK_SERVER_CONFIRM = 'on';
  let seen;
  const { svc, subscriptions } = setup({ confirm: async a => { seen = a; return { confirmed: true, amount: '30000' }; } });
  assert.deepEqual(await call(svc), { ok: true });
  assert.deepEqual(seen, { paymentId: 'p1', subscriptionId: 's1', amount: 30000 });
  assert.equal(subscriptions.rows[0].status, 'active');
});

test('flag on + not confirmed or amount mismatch: 409, nothing activates, payment_id not consumed', async () => {
  process.env.SELCOM_WEBHOOK_SERVER_CONFIRM = 'on';
  for (const answer of [{ confirmed: false }, { confirmed: true, amount: 1 }, { confirmed: true }, null]) {
    const { svc, subscriptions, webhookSeen, paymentRequests } = setup({ confirm: async () => answer });
    const r = await call(svc);
    assert.equal(r.error, 'confirmation_failed');
    assert.equal(r.status, 409);
    assert.equal(subscriptions.rows[0].status, 'payment_pending');
    assert.equal(webhookSeen.rows.length, 0);
    assert.equal(paymentRequests.rows[0].status, 'pending');
  }
});

test('flag on + client throws: 503, nothing activates, claim not consumed', async () => {
  process.env.SELCOM_WEBHOOK_SERVER_CONFIRM = 'on';
  const { svc, subscriptions, webhookSeen } = setup({ confirm: async () => { throw new Error('timeout'); } });
  const r = await call(svc);
  assert.deepEqual([r.error, r.status], ['confirmation_unavailable', 503]);
  assert.equal(subscriptions.rows[0].status, 'payment_pending');
  assert.equal(webhookSeen.rows.length, 0);
});

test('flag on + default (not configured) client fails closed', async () => {
  process.env.SELCOM_WEBHOOK_SERVER_CONFIRM = 'on';
  const { svc, subscriptions, webhookSeen } = setup();
  const r = await call(svc);
  assert.deepEqual([r.error, r.status], ['confirmation_unavailable', 503]);
  assert.equal(subscriptions.rows[0].status, 'payment_pending');
  assert.equal(webhookSeen.rows.length, 0);
});
