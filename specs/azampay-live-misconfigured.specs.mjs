// AZAMPAY_ENV=live with incomplete live hosts fails CLOSED (security review of functions#360): it is never quietly
// the sandbox. Even with AZAMPAY_PAYMENTS and AZAMPAY_SANDBOX_SETTLES on there is no client, nothing is offered,
// the callback route is closed, and the server says so once at boot. Uses the real bootstrap and route handlers.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const KEYS = ['AZAMPAY_APP_NAME', 'AZAMPAY_CLIENT_ID', 'AZAMPAY_CLIENT_SECRET', 'AZAMPAY_ENV', 'AZAMPAY_AUTH_URL', 'AZAMPAY_CHECKOUT_URL', 'AZAMPAY_DISBURSE_URL', 'AZAMPAY_PAYMENTS', 'AZAMPAY_SANDBOX_SETTLES'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
Object.assign(process.env, { AZAMPAY_APP_NAME: 'spec-app', AZAMPAY_CLIENT_ID: 'spec-client', AZAMPAY_CLIENT_SECRET: 'spec-secret', AZAMPAY_ENV: 'live', AZAMPAY_PAYMENTS: 'on', AZAMPAY_SANDBOX_SETTLES: 'on' });
// live, but AzamPay's checkout host was never set
process.env.AZAMPAY_AUTH_URL = 'https://auth.live.example';
delete process.env.AZAMPAY_CHECKOUT_URL;
delete process.env.AZAMPAY_DISBURSE_URL;

const errors = [];
const realError = console.error;
console.error = (...args) => { errors.push(args.join(' ')); };
const { azampayClient, mobileMoneyService } = await import('../src/bootstrap/services.mjs');
const { azampayWebhook } = await import('../functions/webhooks.mjs');
const { payByMobileMoney, paymentOptions } = await import('../functions/mobile-money.mjs');
console.error = realError;

after(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
const res = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });

test('the server says at boot, once and distinctly, that AzamPay is closed', () => {
  const lines = errors.filter((e) => e.includes('[azampay] MISCONFIGURED'));
  assert.equal(lines.length, 1, errors.join('\n'));
  assert.match(lines[0], /live_hosts_missing/);
  assert.match(lines[0], /CLOSED/);
  assert.ok(!lines[0].includes('spec-secret'), 'no credential in the log');
});

test('there is no client: nothing is offered, paying is 404, the callback route is 403, a callback settles nothing', async () => {
  assert.equal(azampayClient, null);
  assert.deepEqual(mobileMoneyService.options(), { enabled: false, provider: 'azampay', environment: null });
  assert.deepEqual(mobileMoneyService.payableProducts('member'), []);
  const opts = res();
  await paymentOptions.onRequest({ user: { userType: 'member' } }, opts);
  assert.deepEqual(opts.body, { enabled: false, provider: 'azampay', environment: null });
  const pay = res();
  await payByMobileMoney.onRequest({ user: { sub: 'm1' }, params: { id: 'pay_x' }, body: { phone: '0754123456' } }, pay);
  assert.deepEqual([pay.statusCode, pay.body.error], [404, 'feature_disabled']);
  const hook = res();
  await azampayWebhook.onRequest({ headers: {}, body: { clientId: 'spec-client', utilityref: 'pay_x.a', transactionstatus: 'success', operator: 'Mpesa', amount: '60000', transid: 'T', signature: 'x' } }, hook);
  assert.deepEqual([hook.statusCode, hook.body], [403, { error: 'forbidden' }]);
  assert.deepEqual(await mobileMoneyService.handleCallback({ utilityref: 'pay_x.a', transid: 'T', transactionstatus: 'success' }), { error: 'feature_disabled', status: 404 });
});
