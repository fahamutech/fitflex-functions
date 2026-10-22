// Phase B · B6a, the routes: who gets past the mobile-money guards under each flag
// combination, and the additive `mobileMoney.products` on GET /payments/options.
// Route handlers and guards as exported; no Tunzaa call is ever made (sandbox
// credentials are fake and no request reaches the provider: unknown request ids).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.MALIPO_API_KEY = 'spec-key';
process.env.MALIPO_API_SECRET = 'spec-secret';
delete process.env.MALIPO_ENV; // sandbox
const FLAGS = ['TUNZAA_PAYMENTS', 'TUNZAA_TRAINER_PRODUCTS', 'TUNZAA_SANDBOX_SETTLES'];
const saved = Object.fromEntries(FLAGS.map((k) => [k, process.env[k]]));
for (const k of FLAGS) delete process.env[k];

const { payByMobileMoney, refreshMobileMoneyPayment, paymentOptions } = await import('../functions/mobile-money.mjs');
const { sign } = await import('../src/auth/jwt.mjs');

after(() => {
  for (const k of FLAGS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const setFlags = (flags) => { for (const k of FLAGS) { if (flags[k]) process.env[k] = '1'; else delete process.env[k]; } };
const res = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });

/** Run a route's guard for a session of this role: 'next' when let through, else the response. */
async function guard(route, userType) {
  const token = sign({ sub: `spec_b6_${userType}_${Date.now()}`, userType });
  const out = res();
  let passed = false;
  await route.onGuard({ method: 'POST', headers: { authorization: `Bearer ${token}` } }, out, () => { passed = true; });
  return passed ? 'next' : { status: out.statusCode, body: out.body };
}

const FORBIDDEN_MEMBER_ONLY = { status: 403, body: { error: 'forbidden', requiredRoles: ['member'] } };

test('guards: flags off → paying is members only, exactly as before; refresh lets trainers reach the service', async () => {
  for (const flags of [{}, { TUNZAA_PAYMENTS: 1 }, { TUNZAA_TRAINER_PRODUCTS: 1 }]) {
    setFlags(flags);
    assert.equal(await guard(payByMobileMoney, 'member'), 'next', JSON.stringify(flags));
    assert.deepEqual(await guard(payByMobileMoney, 'trainer'), FORBIDDEN_MEMBER_ONLY, JSON.stringify(flags));
    assert.deepEqual(await guard(payByMobileMoney, 'vendor'), FORBIDDEN_MEMBER_ONLY);
    // A trainer's own live prompt may be refreshed after the flag goes off (the service decides).
    assert.equal(await guard(refreshMobileMoneyPayment, 'member'), 'next');
    assert.equal(await guard(refreshMobileMoneyPayment, 'trainer'), 'next');
    assert.equal((await guard(refreshMobileMoneyPayment, 'vendor')).status, 403);
  }
});

test('guards are scoped to their own route: the pay guard does not run on /refresh under the prefix mount', async () => {
  setFlags({});
  const token = sign({ sub: 'spec_b6_scoped', userType: 'trainer' });
  let passed = false;
  const out = res();
  // As Express presents /me/payments/x/mobile-money/refresh to a guard mounted on /me/payments/:id/mobile-money.
  await payByMobileMoney.onGuard({ method: 'POST', baseUrl: '/me/payments/x/mobile-money', path: '/refresh', headers: { authorization: `Bearer ${token}` } }, out, () => { passed = true; });
  assert.equal(passed, true);
});

test('guards: both flags on → members and trainers; every other role still refused', async () => {
  setFlags({ TUNZAA_PAYMENTS: 1, TUNZAA_TRAINER_PRODUCTS: 1 });
  for (const route of [payByMobileMoney, refreshMobileMoneyPayment]) {
    assert.equal(await guard(route, 'member'), 'next');
    assert.equal(await guard(route, 'trainer'), 'next');
    for (const role of ['vendor', 'owner', 'admin']) {
      const out = await guard(route, role);
      assert.equal(out.status, 403, role);
      assert.equal(out.body.error, 'forbidden');
    }
  }
});

test('options: no mobileMoney key while trainer products are off; products per caller when on', async () => {
  setFlags({ TUNZAA_PAYMENTS: 1 });
  const legacy = res();
  await paymentOptions.onRequest({ user: { sub: 'm1', userType: 'member' } }, legacy);
  assert.equal('mobileMoney' in legacy.body, false, 'flag off: response unchanged');

  // Effective only with TUNZAA_PAYMENTS.
  setFlags({ TUNZAA_TRAINER_PRODUCTS: 1 });
  const notEffective = res();
  await paymentOptions.onRequest({ user: { sub: 'm1', userType: 'member' } }, notEffective);
  assert.equal('mobileMoney' in notEffective.body, false);
  assert.equal(notEffective.body.enabled, false);

  // On against the sandbox without TUNZAA_SANDBOX_SETTLES: paying is not offered, so nothing is payable.
  setFlags({ TUNZAA_PAYMENTS: 1, TUNZAA_TRAINER_PRODUCTS: 1 });
  const closed = res();
  await paymentOptions.onRequest({ user: { sub: 't1', userType: 'trainer' } }, closed);
  assert.deepEqual([closed.body.enabled, closed.body.mobileMoney], [false, { products: [] }]);

  setFlags({ TUNZAA_PAYMENTS: 1, TUNZAA_TRAINER_PRODUCTS: 1, TUNZAA_SANDBOX_SETTLES: 1 });
  const as = async (userType) => {
    const out = res();
    await paymentOptions.onRequest({ user: { sub: 'x', userType } }, out);
    return out.body;
  };
  const member = await as('member');
  assert.deepEqual([member.enabled, member.environment, member.provider], [true, 'sandbox', 'tunzaa']);
  assert.deepEqual(member.mobileMoney, { products: ['FITFLEX_PASS', 'GYM_SUBSCRIPTION', 'TRAINER_SERVICE'] });
  assert.deepEqual((await as('trainer')).mobileMoney, { products: ['TRAINER_GYM_PASS'] });
  assert.deepEqual((await as('vendor')).mobileMoney, { products: [] });
  // No session details at all (as the older spec calls it): nothing payable.
  const anon = res();
  await paymentOptions.onRequest({}, anon);
  assert.deepEqual(anon.body.mobileMoney, { products: [] });
});

test('handlers: a trainer session is told feature_disabled while trainer products are off; unknown requests are 404', async () => {
  setFlags({ TUNZAA_PAYMENTS: 1, TUNZAA_SANDBOX_SETTLES: 1 });
  const off = res();
  await payByMobileMoney.onRequest({ user: { sub: 't1', userType: 'trainer' }, params: { id: 'pay_b6_none' }, body: { phone: '0712345678' } }, off);
  assert.deepEqual([off.statusCode, off.body], [404, { error: 'feature_disabled' }]);
  // Refresh with nothing live: the same 403 the member-only guard gave before.
  const refreshOff = res();
  await refreshMobileMoneyPayment.onRequest({ user: { sub: 't1', userType: 'trainer' }, params: { id: 'pay_b6_none' } }, refreshOff);
  assert.deepEqual([refreshOff.statusCode, refreshOff.body], [403, { error: 'forbidden', requiredRoles: ['member'] }]);

  setFlags({ TUNZAA_PAYMENTS: 1, TUNZAA_TRAINER_PRODUCTS: 1, TUNZAA_SANDBOX_SETTLES: 1 });
  for (const route of [payByMobileMoney, refreshMobileMoneyPayment]) {
    const out = res();
    await route.onRequest({ user: { sub: 't1', userType: 'trainer' }, params: { id: 'pay_b6_none' }, body: { phone: '0712345678' } }, out);
    assert.deepEqual([out.statusCode, out.body], [404, { error: 'not_found' }]);
  }
});
