// POST /webhooks/azampay is closed without AzamPay credentials or a valid signature;
// with AZAMPAY_PAYMENTS off the payment routes behave exactly as before. Uses the
// route handlers themselves.
import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.AZAMPAY_PAYMENTS;
delete process.env.AZAMPAY_APP_NAME;
delete process.env.AZAMPAY_CLIENT_ID;
delete process.env.AZAMPAY_CLIENT_SECRET;

const { azampayWebhook } = await import('../functions/webhooks.mjs');
const { payByMobileMoney, paymentOptions } = await import('../functions/mobile-money.mjs');
const { azampayTrainerProductsOn, azampayShopOrdersOn, eventsPaymentsAzampayOn } = await import('../src/shared/feature-flags.mjs');
const flags = await import('../src/shared/feature-flags.mjs');

const res = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });

test('without AzamPay configured the callback route is closed', async () => {
  const out = res();
  await azampayWebhook.onRequest({ headers: {}, body: { utilityref: 'pay_x.k', transactionstatus: 'success', signature: 'x' } }, out);
  assert.equal(out.statusCode, 403);
  assert.deepEqual(out.body, { error: 'forbidden' });
});

test('with AzamPay off, paying is 404 and the options say so; there is no manual block and no other provider', async () => {
  const out = res();
  await payByMobileMoney.onRequest({ user: { sub: 'm1' }, params: { id: 'pay_x' }, body: { phone: '0712345678', network: 'Mpesa' } }, out);
  assert.equal(out.statusCode, 404);
  assert.equal(out.body.error, 'feature_disabled');
  const saved = process.env.MANUAL_PAY_INSTRUCTIONS;
  process.env.MANUAL_PAY_INSTRUCTIONS = '1';   // a removed flag: setting it changes nothing
  try {
    const opts = res();
    await paymentOptions.onRequest({ user: { userType: 'member' } }, opts);
    assert.deepEqual(opts.body, { enabled: false, provider: 'azampay', environment: null });
  } finally { if (saved === undefined) delete process.env.MANUAL_PAY_INSTRUCTIONS; else process.env.MANUAL_PAY_INSTRUCTIONS = saved; }
});

test('AzamPay is the only provider: the Tunzaa and Selcom routes, flags and manual-pay flag are gone', async () => {
  const hooks = await import('../functions/webhooks.mjs');
  assert.deepEqual(Object.keys(hooks), ['azampayWebhook']);
  for (const gone of ['tunzaaPaymentsOn', 'tunzaaTrainerProductsOn', 'tunzaaSandboxSettlesOn', 'manualPayInstructionsOn', 'eventsPaymentsTunzaaOn', 'selcomStrictAmountOn', 'selcomWebhookServerConfirmOn', 'selcomWebhookQueryTokenOff', 'mobileMoneyTrainerProductsOn']) {
    assert.equal(gone in flags, false, gone);
  }
});

test('trainer products, shop orders and event orders each need their own switch AND AZAMPAY_PAYMENTS', () => {
  const KEYS = ['AZAMPAY_PAYMENTS', 'AZAMPAY_TRAINER_PRODUCTS', 'AZAMPAY_SHOP_ORDERS', 'EVENTS_PAYMENTS_AZAMPAY', 'EVENTS_MODULE', 'EVENTS_REGISTRATION', 'TUNZAA_PAYMENTS', 'TUNZAA_TRAINER_PRODUCTS'];
  const saved = { ...process.env };
  try {
    for (const k of KEYS) delete process.env[k];
    process.env.TUNZAA_PAYMENTS = 'on'; process.env.TUNZAA_TRAINER_PRODUCTS = 'on';
    assert.equal(azampayTrainerProductsOn(), false, 'the old provider\'s flags mean nothing');
    process.env.AZAMPAY_TRAINER_PRODUCTS = 'on'; process.env.AZAMPAY_SHOP_ORDERS = 'on';
    assert.deepEqual([azampayTrainerProductsOn(), azampayShopOrdersOn()], [false, false]);
    process.env.AZAMPAY_PAYMENTS = 'on';
    assert.deepEqual([azampayTrainerProductsOn(), azampayShopOrdersOn()], [true, true]);
    process.env.EVENTS_PAYMENTS_AZAMPAY = 'on';
    assert.equal(eventsPaymentsAzampayOn(), false, 'needs the events module and registration');
    process.env.EVENTS_MODULE = 'on'; process.env.EVENTS_REGISTRATION = 'on';
    assert.equal(eventsPaymentsAzampayOn(), true);
  } finally {
    for (const k of KEYS) { if (k in saved) process.env[k] = saved[k]; else delete process.env[k]; }
  }
});
