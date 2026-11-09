// Audit M2: Selcom webhook hardening (token header/query + redaction, replay, server confirm).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createWebhookService } from '../src/services/webhook-service.mjs';
import { createNotConfiguredSelcomClient } from '../src/integrations/payments/selcom-confirm.mjs';
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
  assert.equal(req.originalUrl, '/webhooks/selcom?a=1&b=2');
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

test('flag on + default (not configured) client: the service refuses to be built (boot guard)', () => {
  process.env.SELCOM_WEBHOOK_SERVER_CONFIRM = 'on';
  const origErr = console.error; console.error = () => {};
  try {
    assert.throws(() => setup(), /selcom_server_confirm_requires_client/);
    assert.throws(() => createWebhookService({ subscriptions: store(), webhookSeen: store(), confirmClient: createNotConfiguredSelcomClient() }), /selcom_server_confirm_requires_client/);
  } finally { console.error = origErr; }
});

test('flag off + default (not configured) client: builds and activates as before', async () => {
  const { svc, subscriptions } = setup();
  assert.deepEqual(await call(svc), { ok: true });
  assert.equal(subscriptions.rows[0].status, 'active');
});

test('flag flipped on after boot with the not-configured client still fails closed (503, nothing consumed)', async () => {
  const { svc, subscriptions, webhookSeen } = setup();
  process.env.SELCOM_WEBHOOK_SERVER_CONFIRM = 'on';
  const r = await call(svc);
  assert.deepEqual([r.error, r.status], ['confirmation_unavailable', 503]);
  assert.equal(subscriptions.rows[0].status, 'payment_pending');
  assert.equal(webhookSeen.rows.length, 0);
});

// --- server confirm: an amount we require
test('flag on + no open request and no numeric amount: 409, client never asked, nothing consumed', async () => {
  process.env.SELCOM_WEBHOOK_SERVER_CONFIRM = 'on';
  let asked = 0;
  const subscriptions = store([{ id: 's1', status: 'payment_pending' }]);
  const webhookSeen = store();
  const svc = createWebhookService({ subscriptions, webhookSeen, paymentRequests: store(), confirmClient: { confirm: async () => { asked++; return { confirmed: true, amount: 999 }; } } });
  for (const amount of [undefined, null, '', 'abc']) {
    const r = await svc.handleSelcom({ payment_id: 'p9', status: 'success', subscription_id: 's1', amount });
    assert.deepEqual([r.error, r.status], ['confirmation_requires_amount', 409]);
  }
  assert.equal(asked, 0);
  assert.equal(subscriptions.rows[0].status, 'payment_pending');
  assert.equal(webhookSeen.rows.length, 0);
});

// --- query form can be switched off
test('SELCOM_WEBHOOK_QUERY_TOKEN_OFF rejects ?token= but keeps the header', () => {
  process.env.SELCOM_WEBHOOK_SECRET = SECRET;
  process.env.SELCOM_WEBHOOK_QUERY_TOKEN_OFF = 'on';
  try {
    assert.equal(hasWebhookToken({ headers: {}, query: { token: SECRET } }), false);
    assert.equal(hasWebhookToken({ headers: { 'x-selcom-webhook-token': SECRET }, query: {} }), true);
  } finally { delete process.env.SELCOM_WEBHOOK_QUERY_TOKEN_OFF; }
});

test('empty token and empty/unset secret never match', () => {
  process.env.SELCOM_WEBHOOK_SECRET = SECRET;
  assert.equal(hasWebhookToken({ headers: { 'x-selcom-webhook-token': '' }, query: { token: '' } }), false);
  assert.equal(hasWebhookToken({ headers: {}, query: { token: ['x', SECRET] } }), false);
  process.env.SELCOM_WEBHOOK_SECRET = '';
  assert.equal(hasWebhookToken({ headers: { 'x-selcom-webhook-token': '' }, query: { token: '' } }), false);
});

// --- redaction on a real Express request, over real HTTP
test('real Express app over HTTP: a logger placed after the gate cannot see the token (header and query)', async () => {
  const { default: express } = await import('express');
  process.env.SELCOM_WEBHOOK_SECRET = SECRET;
  const seen = [];
  const app = express();
  app.use(express.json());
  app.post('/webhooks/selcom', (req, res) => {
    const ok = hasWebhookToken(req);
    redactWebhookToken(req);
    // a "logger" that runs after the handler started: logs everything it can reach
    res.on('finish', () => seen.push(JSON.stringify({
      originalUrl: req.originalUrl, url: req.url, query: req.query, headers: req.headers, rawHeaders: req.rawHeaders,
      p1: req._parsedUrl, p2: req._parsedOriginalUrl,
    })));
    seen.push(JSON.stringify({ originalUrl: req.originalUrl, query: req.query, headers: req.headers, rawHeaders: req.rawHeaders }));
    res.status(ok ? 200 : 403).json({ ok });
  });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/webhooks/selcom`;
  try {
    const viaHeader = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', 'x-selcom-webhook-token': SECRET }, body: '{}' });
    const viaQuery = await fetch(`${base}?a=1&token=${SECRET}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const wrong = await fetch(`${base}?token=nope`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.deepEqual([viaHeader.status, viaQuery.status, wrong.status], [200, 200, 403]);
    await new Promise(r => setTimeout(r, 50));
    assert.ok(seen.length >= 6);
    for (const line of seen) assert.equal(line.includes(SECRET), false, line);
  } finally { server.close(); }
});

test('encoded, mixed-case, repeated and array token keys authenticate or not, but never survive redaction (real HTTP)', async () => {
  const { default: express } = await import('express');
  process.env.SELCOM_WEBHOOK_SECRET = SECRET;
  const seen = [];
  const app = express();
  app.post('/w', (req, res) => {
    const ok = hasWebhookToken(req);
    redactWebhookToken(req);
    seen.push(JSON.stringify({ o: req.originalUrl, u: req.url, q: req.query, p1: req._parsedUrl, p2: req._parsedOriginalUrl }));
    res.status(ok ? 200 : 403).json({ ok });
  });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/w`;
  try {
    const forms = [`?%74oken=${SECRET}`, `?a=1&%54OKEN=${SECRET}&b=2`, `?Token=${SECRET}`, `?token=x&token=${SECRET}`, `?token[]=${SECRET}`, `?%74oken%5B0%5D=${SECRET}&c=3`, `?t%6Fken=${SECRET}#f`];
    for (const f of forms) {
      const r = await fetch(base + f, { method: 'POST' });
      assert.ok([200, 403].includes(r.status));
    }
    // the plainly encoded key really does authenticate (Express decodes it), which is why it must be scrubbed
    assert.equal((await fetch(`${base}?%74oken=${SECRET}`, { method: 'POST' })).status, 200);
    for (const line of seen) assert.equal(line.includes(SECRET), false, line);
    assert.equal(JSON.parse(seen[1]).o, '/w?a=1&b=2');
  } finally { server.close(); }
});
