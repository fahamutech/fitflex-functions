// WhatsApp routes: the provider webhook is closed without the shared secret,
// and the old "message any user" routes are gone (audit S2/S3).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as routes from '../functions/whatsapp.mjs';

const saved = process.env.WHATSAPP_WEBHOOK_SECRET;
after(() => { if (saved === undefined) delete process.env.WHATSAPP_WEBHOOK_SECRET; else process.env.WHATSAPP_WEBHOOK_SECRET = saved; });

function res() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
    type() { return this; },
  };
}
const call = async (route, req) => { const r = res(); await route.onRequest({ headers: {}, query: {}, body: {}, ...req }, r); return r; };

test('the webhook is closed with no secret configured, or a wrong one', async () => {
  delete process.env.WHATSAPP_WEBHOOK_SECRET;
  assert.equal((await call(routes.whatsappStatusWebhook, { query: { token: '' } })).statusCode, 403);
  process.env.WHATSAPP_WEBHOOK_SECRET = 'spec-secret-123';
  assert.equal((await call(routes.whatsappStatusWebhook, { query: { token: 'spec-secret-12' } })).statusCode, 403);
  assert.equal((await call(routes.whatsappWebhook, { headers: { 'x-whatsapp-webhook-token': 'nope' } })).statusCode, 403, 'the old address too');
  assert.equal((await call(routes.whatsappWebhookVerify, {})).statusCode, 403);
});

test('with the secret, the webhook is handled (as a header or ?token=)', async () => {
  process.env.WHATSAPP_WEBHOOK_SECRET = 'spec-secret-123';
  const body = { statuses: [{ id: 'spec_unknown_message', status: 'delivered' }], messages: [{ from: '+255700000009', text: 'hello' }] };
  const r = await call(routes.whatsappStatusWebhook, { query: { token: 'spec-secret-123' }, body });
  assert.equal(r.statusCode, 200);
  assert.deepEqual([r.body.ok, r.body.unknown, r.body.ignored], [true, 1, 1]);
  assert.equal((await call(routes.whatsappWebhook, { headers: { 'x-whatsapp-webhook-token': 'spec-secret-123' }, body: {} })).statusCode, 200);
  assert.equal((await call(routes.whatsappWebhookVerify, { query: { token: 'spec-secret-123' } })).statusCode, 200);
});

test('the routes that let anyone WhatsApp any user are gone', () => {
  for (const name of ['sendTrainerMessage', 'sendBookingReminder', 'sendOrderConfirmation', 'sendOrderReady',
    'sendPaymentNotification', 'adminSendBulkReengagement', 'testSendWhatsApp']) {
    assert.equal(routes[name], undefined, name);
  }
  const paths = Object.values(routes).map(r => r.path);
  assert.ok(!paths.some(p => p.startsWith('/trainer/') || p.startsWith('/vendor/') || p.startsWith('/operator/') || p === '/test/whatsapp'));
});
