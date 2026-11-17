// AzamPay bank checkout and hosted payment page through the REAL routes, bootstrap and client, against a LOCAL fake
// AzamPay (AZAMPAY_*_URL, non-production only) and the CI database: both are dormant behind their flags; ownership;
// the OTP reaches AzamPay and is kept nowhere (no row, no audit, no ops exception, no log line); the page's redirect
// addresses are the server's own whatever the client sends; the return page settles nothing; AzamPay's signed
// callback settles; a verified success for a reference we cannot place raises an ops exception.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync, createSign, randomUUID } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUB = publicKey.export({ type: 'spki', format: 'pem' });
const CLIENT_ID = 'spec-client';
const VENDOR_ID = 'e9b57fab-1850-44d4-8499-71fd15c845a0';
const seen = { bank: [], page: [] };
let bankAnswer = null;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
    if (req.url.startsWith('/AppRegistration/GenerateToken')) return send(200, { data: { accessToken: 'tok', expire: new Date(Date.now() + 3600_000).toISOString() }, success: true });
    if (req.url.startsWith('/azampay/v1/public-key')) return send(200, { success: true, format: 'Pem', publicKey: PUB });
    if (req.url.startsWith('/azampay/bank/checkout')) {
      const b = JSON.parse(body || '{}');
      seen.bank.push(b);
      if (bankAnswer) return send(bankAnswer.code, bankAnswer.body);
      return send(200, { transactionId: `SPECBANK_${seen.bank.length}_${Date.now()}`, message: 'ok', success: true });
    }
    if (req.url.startsWith('/api/v1/Partner/PostCheckout')) {
      const b = JSON.parse(body || '{}');
      seen.page.push(b);
      return send(200, JSON.stringify(`http://127.0.0.1:${server.address().port}/pay/${b.externalId}`));
    }
    return send(404, {});
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const HOST = `http://127.0.0.1:${server.address().port}`;
Object.assign(process.env, {
  AZAMPAY_APP_NAME: 'spec-app', AZAMPAY_CLIENT_ID: CLIENT_ID, AZAMPAY_CLIENT_SECRET: 'spec-secret',
  AZAMPAY_AUTH_URL: HOST, AZAMPAY_CHECKOUT_URL: HOST, AZAMPAY_DISBURSE_URL: HOST,
  AZAMPAY_VENDOR_ID: VENDOR_ID, AZAMPAY_VENDOR_NAME: 'FitFlex Africa',
});
delete process.env.AZAMPAY_ENV;
delete process.env.NODE_ENV;
const SAVED = { PUBLIC_API_URL: process.env.PUBLIC_API_URL, PORTAL_PUBLIC_URL: process.env.PORTAL_PUBLIC_URL };
process.env.PUBLIC_API_URL = 'https://api.fitflex.test';
process.env.PORTAL_PUBLIC_URL = 'https://portal.fitflex.test';

const { ensureInit } = await import('../functions/index.mjs');
await ensureInit();
const { db } = await import('../src/infra/knex-store.mjs');
const { payByMobileMoney, payByBank, payByCheckoutPage, refreshPayment, refreshMobileMoneyPayment, paymentOptions, azampayReturn } = await import('../functions/mobile-money.mjs');
const { azampayWebhook } = await import('../functions/webhooks.mjs');
const { callbackSignedText } = await import('../src/integrations/payments/azampay.mjs');
const { parsePageReference } = await import('../src/shared/mobile-money-claim.mjs');
const { sign: signJwt } = await import('../src/auth/jwt.mjs');

const FLAGS = ['AZAMPAY_PAYMENTS', 'AZAMPAY_SANDBOX_SETTLES', 'AZAMPAY_BANK_CHECKOUT', 'AZAMPAY_CHECKOUT_PAGE', 'AZAMPAY_TRAINER_PRODUCTS'];
const on = (...flags) => { for (const k of FLAGS) delete process.env[k]; for (const k of ['AZAMPAY_PAYMENTS', 'AZAMPAY_SANDBOX_SETTLES', ...flags]) process.env[k] = '1'; };
const made = { subs: [], pays: [], users: [] };
afterEach(() => { for (const k of FLAGS) delete process.env[k]; bankAnswer = null; });
after(async () => {
  await db('OpsException').where('dedupeKey', 'like', 'azampay_%').whereIn('entityId', made.pays).del().catch(() => {});
  await db('OpsException').where('dedupeKey', 'like', 'azampay_unmatched:SPECX_%').del().catch(() => {});
  if (made.pays.length) { await db('AuditLog').whereIn('target', made.pays).del(); await db('PaymentRequest').whereIn('id', made.pays).del(); }
  await db('AuditLog').where('target', 'like', 'SPECX-%').del();
  if (made.subs.length) await db('Subscription').whereIn('id', made.subs).del();
  if (made.users.length) await db('User').whereIn('id', made.users).del();
  for (const [k, v] of Object.entries(SAVED)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  server.close(); await db.destroy();
});

const hex = (n) => randomUUID().replace(/-/g, '').slice(0, n);
let phoneSeq = Math.floor(Math.random() * 500000) + 100000;
const phone = () => `0712${String(phoneSeq += 1).padStart(6, '0')}`;
async function member() {
  const id = `usr_${hex(12)}`;
  await db('User').insert({ id, userType: 'member', displayName: 'Spec member', createdAt: new Date(), updatedAt: new Date() });
  made.users.push(id);
  return id;
}
/** A member with a pending gym-plan payment request (80,000). */
async function pending(amountTzs = 80000) {
  const memberId = await member();
  const subId = `sub_${hex(12)}`; const payId = `pay_${hex(8)}`; const day = 24 * 3600_000;
  await db('Subscription').insert({ id: subId, memberId, type: 'direct_sub', status: 'payment_pending', homeGymId: `gym_${hex(8)}`, startedAt: new Date(), cycleStartedAt: new Date(), renewsAt: new Date(Date.now() + 30 * day), expiresAt: new Date(Date.now() + 30 * day) });
  await db('PaymentRequest').insert({ id: payId, memberId, subscriptionId: subId, amountTzs, status: 'pending', provider: 'admin_approved', requestedAt: new Date(), plan: 'monthly', gymId: `gym_${hex(8)}` });
  made.subs.push(subId); made.pays.push(payId);
  return { memberId, subId, payId };
}
const res = () => ({ statusCode: 200, body: null, headers: {}, contentType: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, type(t) { this.contentType = t; return this; }, set(k, v) { this.headers[k] = v; return this; }, send(b) { this.body = b; return this; } });
const call = async (route, memberId, { id, body = {}, query = {} } = {}) => { const out = res(); await route.onRequest({ user: { sub: memberId, userType: 'member' }, params: { id }, body, query }, out); return out; };
const signed = (p) => { const s = createSign('SHA256'); s.update(callbackSignedText(p), 'utf8'); return { ...p, signature: s.sign(privateKey, 'base64') }; };
const callback = async (p) => { const out = res(); await azampayWebhook.onRequest({ headers: {}, body: signed({ message: 'ok', user: '', password: '', clientId: CLIENT_ID, transactionstatus: 'success', operator: 'CRDB', reference: null, externalreference: `EXT_${hex(8)}`, mnoreference: null, ...p }) }, out); return out; };
const rowOf = (id) => db('PaymentRequest').where({ id }).first();
/** Everything the database keeps about a payment request: its row, its audit rows, its ops exceptions. */
async function kept(payId) {
  const row = await rowOf(payId);
  const audit = await db('AuditLog').where({ target: payId });
  const ops = await db('OpsException').where({ entityId: payId });
  return JSON.stringify({ row, audit, ops });
}
/** Run `fn` and return every line written to the console while it ran. */
async function logged(fn) {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(saved)) console[k] = (...a) => { lines.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
  try { await fn(); } finally { Object.assign(console, saved); }
  return lines.join('\n');
}
const OTP = '739105';
const ACCOUNT = '0150-4433-2211';

test('dormant: with the flags off both routes are 404 feature_disabled and options lists only mobile_money; AZAMPAY_PAYMENTS off closes everything', async () => {
  const p = await pending();
  on();
  const opts = (await call(paymentOptions, p.memberId)).body;
  assert.deepEqual(opts, { enabled: true, provider: 'azampay', environment: 'sandbox', methods: ['mobile_money'] });
  for (const [route, body] of [[payByBank, { bank: 'CRDB', accountNumber: ACCOUNT, phone: phone(), otp: OTP }], [payByCheckoutPage, {}]]) {
    const out = await call(route, p.memberId, { id: p.payId, body });
    assert.deepEqual([out.statusCode, out.body], [404, { error: 'feature_disabled' }]);
  }
  // each flag opens only its own method, and needs AZAMPAY_PAYMENTS
  on('AZAMPAY_BANK_CHECKOUT');
  assert.deepEqual((await call(paymentOptions, p.memberId)).body.methods, ['mobile_money', 'bank']);
  assert.equal((await call(payByCheckoutPage, p.memberId, { id: p.payId })).statusCode, 404);
  on('AZAMPAY_CHECKOUT_PAGE');
  assert.deepEqual((await call(paymentOptions, p.memberId)).body.methods, ['mobile_money', 'page']);
  for (const k of FLAGS) delete process.env[k];
  process.env.AZAMPAY_BANK_CHECKOUT = '1'; process.env.AZAMPAY_CHECKOUT_PAGE = '1';
  assert.deepEqual((await call(paymentOptions, p.memberId)).body, { enabled: false, provider: 'azampay', environment: null, methods: [] });
  assert.equal((await call(payByBank, p.memberId, { id: p.payId, body: { bank: 'CRDB', accountNumber: ACCOUNT, phone: phone(), otp: OTP } })).statusCode, 404);
  assert.deepEqual([seen.bank.length, seen.page.length], [0, 0]);
  assert.deepEqual([(await rowOf(p.payId)).provider, (await rowOf(p.payId)).reference], ['admin_approved', null]);
});

test('guards: the new routes admit the same roles as paying by mobile money (members; other roles 403); the return page is public', async () => {
  on('AZAMPAY_BANK_CHECKOUT', 'AZAMPAY_CHECKOUT_PAGE');
  const guard = async (route, userType) => {
    const token = signJwt({ sub: `spec_${userType}_${hex(6)}`, userType });
    const out = res(); let passed = false;
    await route.onGuard({ method: 'POST', headers: { authorization: `Bearer ${token}` } }, out, () => { passed = true; });
    return passed ? 'next' : out.statusCode;
  };
  for (const route of [payByBank, payByCheckoutPage]) {
    assert.equal(await guard(route, 'member'), 'next');
    for (const role of ['trainer', 'vendor', 'owner', 'admin']) assert.equal(await guard(route, role), 403, role);
    const anonymous = res(); let passed = false;
    await route.onGuard({ method: 'POST', headers: {} }, anonymous, () => { passed = true; });
    assert.deepEqual([passed, anonymous.statusCode], [false, 401]);
  }
  assert.equal(await guard(refreshPayment, 'member'), 'next');
  assert.equal(await guard(refreshPayment, 'vendor'), 403);
  assert.equal(azampayReturn.onGuard, undefined);
});

test('bank checkout through the routes: someone else\'s request is 404; the OTP reaches AzamPay and is kept in no row, audit, ops exception or log line; the signed callback settles once', async () => {
  on('AZAMPAY_BANK_CHECKOUT');
  const p = await pending();
  const other = await member();
  const body = { bank: 'CRDB', accountNumber: ACCOUNT, phone: phone(), otp: OTP };
  const foreign = await call(payByBank, other, { id: p.payId, body });
  assert.deepEqual([foreign.statusCode, foreign.body], [404, { error: 'not_found' }]);
  assert.equal(seen.bank.length, 0);
  // a wrong OTP: AzamPay refuses, the request is free again, nothing about the OTP is written down
  bankAnswer = { code: 200, body: { success: false, message: 'Invalid OTP' } };
  let refused;
  const refusedLog = await logged(async () => { refused = await call(payByBank, p.memberId, { id: p.payId, body: { ...body, otp: '000111' } }); });
  assert.deepEqual([refused.statusCode, refused.body], [422, { error: 'provider_rejected' }]);
  assert.deepEqual([(await rowOf(p.payId)).provider, (await rowOf(p.payId)).reference], ['admin_approved', null]);
  assert.ok(!refusedLog.includes('000111') && !(await kept(p.payId)).includes('000111'));
  bankAnswer = null;
  let out;
  const log = await logged(async () => { out = await call(payByBank, p.memberId, { id: p.payId, body: { ...body, amountTzs: 1, amount: 1, referenceId: 'evil' } }); });
  assert.equal(out.statusCode, 202, JSON.stringify(out.body));
  assert.deepEqual([out.body.state, out.body.method, out.body.paymentRequest.amountTzs, out.body.paymentRequest.provider], ['in_progress', 'bank', 80000, 'azampay']);
  const sent = seen.bank.at(-1);
  assert.deepEqual([sent.amount, sent.currencyCode, sent.merchantAccountNumber, sent.otp, sent.provider, sent.merchantName], [80000, 'TZS', ACCOUNT, OTP, 'CRDB', null]);
  assert.match(sent.merchantMobileNumber, /^2557\d{8}$/);
  assert.equal(sent.referenceId.split('.')[0], p.payId);
  // kept nowhere: the response, the row, the audit, the logs
  const everything = await kept(p.payId);
  for (const secret of [OTP, ACCOUNT, sent.merchantMobileNumber]) {
    assert.ok(!everything.includes(secret), `the database does not hold ${secret === OTP ? 'the OTP' : 'the payer details'}`);
    assert.ok(!JSON.stringify(out.body).includes(secret));
    assert.ok(!log.includes(secret), 'not in a log line');
  }
  assert.deepEqual(Object.keys(await rowOf(p.payId)).filter(k => /otp/i.test(k)), [], 'there is no column for it');
  const requested = await db('AuditLog').where({ target: p.payId, action: 'payment_mobile_money_requested' }).first();
  assert.deepEqual([requested.actor, requested.after.method, requested.after.bank], ['azampay', 'bank', 'CRDB']);
  // refresh (both paths) reports, settles nothing
  for (const route of [refreshPayment, refreshMobileMoneyPayment]) assert.equal((await call(route, p.memberId, { id: p.payId })).body.state, 'in_progress');
  assert.equal((await call(refreshPayment, other, { id: p.payId })).statusCode, 404);
  // less than asked is held and raised for staff; the right amount settles, once
  const txn = (await rowOf(p.payId)).reference;
  await callback({ utilityref: sent.referenceId, transid: txn, amount: '70000' });
  assert.equal((await rowOf(p.payId)).status, 'pending');
  assert.ok(await db('OpsException').where({ dedupeKey: `azampay_held:${p.payId}:${txn}` }).first());
  for (let i = 0; i < 2; i += 1) assert.equal((await callback({ utilityref: sent.referenceId, transid: txn, amount: '80000' })).statusCode, 200);
  assert.deepEqual([(await rowOf(p.payId)).status, (await rowOf(p.payId)).decidedBy, (await db('Subscription').where({ id: p.subId }).first()).status], ['approved', 'azampay', 'active']);
  assert.equal((await call(refreshPayment, p.memberId, { id: p.payId })).body.state, 'completed');
  assert.ok(!(await kept(p.payId)).includes(OTP));
});

test('checkout page through the routes: the client cannot influence the redirect; the return page settles nothing; the signed callback for our 30-character reference settles once', async () => {
  on('AZAMPAY_CHECKOUT_PAGE');
  const p = await pending();
  const other = await member();
  assert.deepEqual((await call(paymentOptions, p.memberId)).body.page, { returnTo: ['app', 'web'], languages: ['en', 'sw'] });
  assert.equal((await call(payByCheckoutPage, other, { id: p.payId })).statusCode, 404);
  const hostile = { returnTo: 'https://evil.test/steal', redirectSuccessURL: 'https://evil.test/ok', redirectFailURL: 'https://evil.test/no', requestOrigin: 'https://evil.test' };
  const refused = await call(payByCheckoutPage, p.memberId, { id: p.payId, body: hostile });
  assert.deepEqual([refused.statusCode, refused.body], [400, { error: 'invalid_return_to', allowed: ['app', 'web'] }]);
  assert.equal(seen.page.length, 0);
  const out = await call(payByCheckoutPage, p.memberId, { id: p.payId, body: { ...hostile, returnTo: 'web', language: 'sw', externalId: 'x'.repeat(30), amount: '1', vendorId: 'evil', appName: 'evil', clientId: 'evil' } });
  assert.equal(out.statusCode, 202, JSON.stringify(out.body));
  const sent = seen.page.at(-1);
  assert.deepEqual(sent, {
    appName: 'spec-app', clientId: CLIENT_ID, vendorId: VENDOR_ID, vendorName: 'FitFlex Africa', language: 'sw', currency: 'TZS', externalId: sent.externalId,
    requestOrigin: 'https://portal.fitflex.test',
    redirectFailURL: `https://portal.fitflex.test/m/payment-return?paymentRequestId=${p.payId}&result=failed`,
    redirectSuccessURL: `https://portal.fitflex.test/m/payment-return?paymentRequestId=${p.payId}&result=success`,
    amount: '80000', cart: { items: [{ name: 'FitFlex' }] },
  });
  assert.ok(!JSON.stringify(sent).includes('evil'));
  assert.equal(sent.externalId.length, 30);
  assert.equal(parsePageReference(sent.externalId).requestId, p.payId);
  assert.deepEqual([out.body.state, out.body.method, out.body.checkoutUrl], ['in_progress', 'page', `${HOST}/pay/${sent.externalId}`]);
  const row = await rowOf(p.payId);
  assert.deepEqual([row.provider, row.reference, row.checkoutUrl, Boolean(row.promptedAt)], ['azampay', sent.externalId, out.body.checkoutUrl, true]);
  // the same page again (not a second attempt), also from a refresh; never for someone else
  const again = await call(payByCheckoutPage, p.memberId, { id: p.payId, body: { returnTo: 'app' } });
  assert.deepEqual([again.statusCode, again.body.alreadyRequested, again.body.checkoutUrl, seen.page.length], [200, true, out.body.checkoutUrl, 1]);
  assert.equal((await call(payByMobileMoney, p.memberId, { id: p.payId, body: { phone: phone() } })).body.alreadyRequested, true, 'no phone prompt beside an open page');
  // the payer comes back through the return page: it is static, and NOTHING is settled by it
  for (const result of ['success', 'failed', '<script>alert(1)</script>']) {
    const page = await call(azampayReturn, null, { query: { result, paymentRequestId: p.payId, status: 'approved' } });
    assert.deepEqual([page.statusCode, page.contentType], [200, 'text/html; charset=utf-8']);
    assert.ok(!page.body.includes('<script') && !page.body.includes(p.payId));
  }
  const back = await call(refreshPayment, p.memberId, { id: p.payId });
  assert.deepEqual([back.body.state, back.body.checkoutUrl], ['in_progress', out.body.checkoutUrl]);
  assert.deepEqual([(await rowOf(p.payId)).status, (await db('Subscription').where({ id: p.subId }).first()).status], ['pending', 'payment_pending']);
  // AzamPay's callback: our reference comes back as utilityref; its own transaction id is what is recorded
  const txn = `SPECPAGE_${hex(10)}`;
  for (let i = 0; i < 2; i += 1) assert.equal((await callback({ utilityref: sent.externalId, transid: txn, amount: '80000', operator: 'Mpesa' })).statusCode, 200);
  const settled = await rowOf(p.payId);
  assert.deepEqual([settled.status, settled.reference, settled.decidedBy, (await db('Subscription').where({ id: p.subId }).first()).status], ['approved', txn, 'azampay', 'active']);
  const done = await call(refreshPayment, p.memberId, { id: p.payId });
  assert.deepEqual([done.body.state, done.body.checkoutUrl], ['completed', undefined]);
});

test('a verified success for a reference we cannot place (should AzamPay not echo ours for a bank or page payment) raises an ops exception instead of vanishing', async () => {
  on('AZAMPAY_BANK_CHECKOUT', 'AZAMPAY_CHECKOUT_PAGE');
  const txn = `SPECX_${hex(10)}`;
  const out = await callback({ utilityref: `SPECX-${hex(12)}`, transid: txn, amount: '80000' });
  assert.deepEqual([out.statusCode, out.body], [200, { ok: true }]);
  const ex = await db('OpsException').where({ dedupeKey: `azampay_unmatched:${txn}` }).first();
  assert.ok(ex, 'staff are told');
  assert.deepEqual([ex.type, ex.severity, ex.status], ['payment_conflict', 'high', 'open']);
  const detail = typeof ex.detail === 'string' ? JSON.parse(ex.detail) : ex.detail;
  assert.deepEqual([detail.transactionId, detail.amountTzs], [txn, 80000]);
});
