// POST /webhooks/tunzaa: closed without the secret or a valid signature; with the
// feature off nothing is initiated. Uses the route handler itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SECRET = 'spec-secret';
process.env.MALIPO_API_KEY = 'spec-key';
process.env.MALIPO_API_SECRET = SECRET;
delete process.env.TUNZAA_PAYMENTS;

const { tunzaaWebhook } = await import('../functions/webhooks.mjs');
const { payByMobileMoney, paymentOptions } = await import('../functions/mobile-money.mjs');
const { sortKeys } = await import('../src/integrations/payments/tunzaa.mjs');
const { createHmac } = await import('node:crypto');

const res = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
const sign = (p) => createHmac('sha256', SECRET).update(JSON.stringify(sortKeys(p))).digest('hex');

test('the callback is refused without a valid signature', async () => {
  const body = { transaction_id: 'T', reference_id: 'pay_none', status: 'COMPLETED', amount: '1.00' };
  for (const headers of [{}, { 'x-signature': 'deadbeef' }]) {
    const out = res();
    await tunzaaWebhook.onRequest({ headers, body }, out);
    assert.equal(out.statusCode, 403);
  }
});

test('a signed callback for an unknown reference is acknowledged and does nothing', async () => {
  const body = { transaction_id: 'T', reference_id: 'pay_unknown_spec', status: 'COMPLETED', amount: '1.00' };
  const out = res();
  await tunzaaWebhook.onRequest({ headers: { 'x-signature': sign(body) }, body }, out);
  assert.equal(out.statusCode, 200);
  assert.deepEqual(out.body, { ok: true });
});

test('with the feature off, paying is 404 and the options say disabled', async () => {
  const out = res();
  await payByMobileMoney.onRequest({ user: { sub: 'm1' }, params: { id: 'pay_x' }, body: { phone: '0712345678' } }, out);
  assert.equal(out.statusCode, 404);
  assert.equal(out.body.error, 'feature_disabled');
  const opts = res();
  await paymentOptions.onRequest({}, opts);
  assert.equal(opts.body.enabled, false);
});
