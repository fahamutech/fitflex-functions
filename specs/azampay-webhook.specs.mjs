// POST /webhooks/azampay is closed without AzamPay credentials or a valid signature;
// with AZAMPAY_PAYMENTS off the payment routes behave exactly as before. Uses the
// route handlers themselves.
import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.AZAMPAY_PAYMENTS;
delete process.env.AZAMPAY_APP_NAME;
delete process.env.AZAMPAY_CLIENT_ID;
delete process.env.AZAMPAY_CLIENT_SECRET;
delete process.env.TUNZAA_PAYMENTS;

const { azampayWebhook } = await import('../functions/webhooks.mjs');
const { payByMobileMoney, paymentOptions } = await import('../functions/mobile-money.mjs');
const { mobileMoneyTrainerProductsOn } = await import('../src/shared/feature-flags.mjs');

const res = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });

test('without AzamPay configured the callback route is closed', async () => {
  const out = res();
  await azampayWebhook.onRequest({ headers: {}, body: { utilityref: 'pay_x.k', transactionstatus: 'success', signature: 'x' } }, out);
  assert.equal(out.statusCode, 403);
  assert.deepEqual(out.body, { error: 'forbidden' });
});

test('with AzamPay off, paying is 404 and the options are Tunzaa\'s, as before', async () => {
  const out = res();
  await payByMobileMoney.onRequest({ user: { sub: 'm1' }, params: { id: 'pay_x' }, body: { phone: '0712345678', network: 'Mpesa' } }, out);
  assert.equal(out.statusCode, 404);
  assert.equal(out.body.error, 'feature_disabled');
  const opts = res();
  await paymentOptions.onRequest({}, opts);
  assert.deepEqual([opts.body.enabled, opts.body.provider], [false, 'tunzaa']);
});

test('trainer products follow the provider that takes new payments', () => {
  const saved = { ...process.env };
  try {
    process.env.TUNZAA_PAYMENTS = 'on'; process.env.TUNZAA_TRAINER_PRODUCTS = 'on';
    assert.equal(mobileMoneyTrainerProductsOn(), true);
    process.env.AZAMPAY_PAYMENTS = 'on';
    assert.equal(mobileMoneyTrainerProductsOn(), false, 'AzamPay on replaces Tunzaa; its own flag decides');
    process.env.AZAMPAY_TRAINER_PRODUCTS = 'on';
    assert.equal(mobileMoneyTrainerProductsOn(), true);
  } finally {
    for (const k of ['TUNZAA_PAYMENTS', 'TUNZAA_TRAINER_PRODUCTS', 'AZAMPAY_PAYMENTS', 'AZAMPAY_TRAINER_PRODUCTS']) {
      if (k in saved) process.env[k] = saved[k]; else delete process.env[k];
    }
  }
});
