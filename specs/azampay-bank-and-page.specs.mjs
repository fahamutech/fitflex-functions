// AzamPay bank checkout (AZAMPAY_BANK_CHECKOUT) and hosted payment page (AZAMPAY_CHECKOUT_PAGE): the client calls
// as AzamPay documents them, the 30-character page reference, the server-built return addresses, and both methods
// through the shared payment service on in-memory stores with the real admin payment service. Both are settled
// ONLY by AzamPay's verified callback — the page's redirect proves nothing — with the same claim, single-use,
// amount, hold and expiry rules as a phone prompt. The OTP is handed to AzamPay and kept nowhere.
// The routes against the real wiring are in azampay-methods-routes.specs.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  azampaySettings, createAzamPayClient, parseCallback, AzamPayError, bankFor, toBankAccount, toOtp, pageUrlOf,
  AZAMPAY_BANKS, AZAMPAY_BANK_MAX_TZS,
} from '../src/integrations/payments/azampay.mjs';
import { createMobileMoneyService, requestIdOf, BANK_REJECTIONS_MAX, accountTail } from '../src/services/mobile-money-service.mjs';
import { createAdminPaymentService } from '../src/services/admin-payment-service.mjs';
import {
  pageReferenceFor, parsePageReference, mobileMoneyInFlight, PROMPT_TTL_MS, PAGE_TTL_MS,
} from '../src/shared/mobile-money-claim.mjs';
import { pageReturnTargets, pageReturnUrls, appReturnPage } from '../src/shared/azampay-return.mjs';

const OTP = '847291';
const ACCOUNT = '0150-9988-7766';
const T0 = 1_800_000_000_000;
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

// ── pure rules ──────────────────────────────────────────────────────────────

test('bank inputs are checked for shape only: bank CRDB | NMB, an account of 5–30 letters/digits, an OTP of 4–12 letters/digits', () => {
  assert.deepEqual([bankFor('crdb'), bankFor(' NMB '), bankFor('NBC'), bankFor(null), bankFor(['CRDB', 'x'])], ['CRDB', 'NMB', null, null, null]);
  assert.deepEqual(AZAMPAY_BANKS, ['CRDB', 'NMB']);
  for (const ok of ['01501234567', '1292-123', '0150 1234 5678', 'AB/12345', 12345678]) assert.equal(toBankAccount(ok), String(ok).trim(), String(ok));
  for (const bad of ['', '1234', 'x'.repeat(31), '-12345', '12345;drop', '<script>', null, undefined, {}, ['12345678']]) assert.equal(toBankAccount(bad), null, String(bad));
  for (const ok of ['1234', '847291', 'A1B2C3', 123456]) assert.equal(toOtp(ok), String(ok), String(ok));
  for (const bad of ['', '123', '1'.repeat(13), '12 34', '12-34', '12.34', null, undefined, {}, ['1234']]) assert.equal(toOtp(bad), null, JSON.stringify(bad));
});

test('the account tail is the last four letters/digits only', () => {
  assert.deepEqual([accountTail('0150-9988-7766'), accountTail('12 34'), accountTail('AB/12345'), accountTail(''), accountTail(null)], ['…7766', '…1234', '…2345', '…', '…']);
});

test('the page reference is exactly 30 lower-case letters/digits and parses back to one request and one attempt', () => {
  for (const id of ['pay_1a2b3c4d', 'pay_0123456789ab', 'pay_a', 'pay_abcdefghij012345678']) {
    const ref = pageReferenceFor(id, T0);
    assert.match(ref, /^[0-9a-z]{30}$/, id);
    assert.deepEqual(parsePageReference(ref), { requestId: id, attempt: T0 }, id);
    assert.equal(requestIdOf(ref), id);
    assert.equal(requestIdOf(ref.toUpperCase()), id, 'AzamPay may change the case');
    assert.notEqual(pageReferenceFor(id, T0 + 1), ref, 'another attempt, another reference');
  }
  // two requests whose ids share a prefix never collide
  assert.notEqual(pageReferenceFor('pay_abc', T0), pageReferenceFor('pay_abcd', T0));
  assert.equal(parsePageReference(pageReferenceFor('pay_abc', T0)).requestId, 'pay_abc');
  // an id that does not fit has no page reference (the request cannot be paid on the page)
  for (const id of ['pay_', 'pay_ABCDEF12', 'pay_ent_123_m1', `pay_${'a'.repeat(20)}`, 'sub_1a2b3c4d', '', null]) assert.equal(pageReferenceFor(id, T0), null, String(id));
  // the other references are not page references
  for (const other of ['pay_1a2b3c4d.lq2x', 'TXN_1', 'pending:1800000000000', 'f'.repeat(29), 'g' + '0'.repeat(29), 'f0' + 'a'.repeat(28), 'fz' + 'a'.repeat(28), null, 12]) assert.equal(parsePageReference(other), null, String(other));
  assert.equal(requestIdOf('pay_1a2b3c4d.lq2x'), 'pay_1a2b3c4d');
});

test('return addresses come from the server\'s configuration only: app → this server\'s return page, web → the member portal; nothing else', () => {
  const env = { PUBLIC_API_URL: 'https://api.fitflex.test/', PORTAL_PUBLIC_URL: 'https://portal.fitflex.test' };
  assert.deepEqual(pageReturnTargets(env), ['app', 'web']);
  assert.deepEqual(pageReturnUrls('app', { id: 'pay_1a2b3c4d' }, env), {
    origin: 'https://api.fitflex.test',
    successUrl: 'https://api.fitflex.test/payments/azampay/return?result=success',
    failUrl: 'https://api.fitflex.test/payments/azampay/return?result=failed',
  });
  assert.deepEqual(pageReturnUrls('web', { id: 'pay_1a2b3c4d' }, env), {
    origin: 'https://portal.fitflex.test',
    successUrl: 'https://portal.fitflex.test/m/payment-return/?paymentRequestId=pay_1a2b3c4d&result=success',
    failUrl: 'https://portal.fitflex.test/m/payment-return/?paymentRequestId=pay_1a2b3c4d&result=failed',
  });
  // not configured, or not https: the target does not exist
  assert.deepEqual(pageReturnTargets({}), []);
  assert.deepEqual(pageReturnTargets({ PUBLIC_API_URL: 'http://api.fitflex.test', PORTAL_PUBLIC_URL: 'javascript:alert(1)' }), []);
  assert.deepEqual(pageReturnTargets({ PUBLIC_API_URL: 'https://api.fitflex.test' }), ['app']);
  assert.equal(pageReturnUrls('web', { id: 'pay_1' }, { PUBLIC_API_URL: 'https://api.fitflex.test' }), null);
  for (const target of ['https://evil.test', '//evil.test', 'App', '', null, undefined]) assert.equal(pageReturnUrls(target, { id: 'pay_1' }, env), null, String(target));
  // a hostile id cannot leave the query string
  const odd = pageReturnUrls('web', { id: 'pay_1&next=https://evil.test/#' }, env);
  assert.equal(new URL(odd.successUrl).origin, 'https://portal.fitflex.test');
  assert.equal(new URL(odd.successUrl).searchParams.get('paymentRequestId'), 'pay_1&next=https://evil.test/#');
  assert.equal(new URL(odd.successUrl).searchParams.get('next'), null);
});

test('the app return page is static: two fixed sentences in English with a marked Swahili placeholder, nothing from the address', () => {
  const ok = appReturnPage('success'); const no = appReturnPage('failed');
  assert.match(ok, /Go back to the FitFlex app: your payment will show there once AzamPay confirms it\./);
  assert.match(no, /The payment was not completed\./);
  for (const html of [ok, no]) { assert.match(html, /lang="sw">\[SW-PENDING\]/); assert.ok(!html.includes('<script')); }
  assert.equal(appReturnPage('<script>alert(1)</script>'), no, 'anything but "success" is the failed page');
});

test('pageUrlOf: only an https address on AzamPay\'s domain (or a listed host), with no user part, is handed to a client', () => {
  assert.equal(pageUrlOf('"https://payments.azampay.co.tz/?id=abc"'), 'https://payments.azampay.co.tz/?id=abc');
  assert.equal(pageUrlOf(' https://azampay.co.tz/x \n'), 'https://azampay.co.tz/x');
  assert.equal(pageUrlOf('{"data":"https://p.sandbox.azampay.co.tz/y"}'), 'https://p.sandbox.azampay.co.tz/y');
  assert.equal(pageUrlOf('https://PAYMENTS.AzamPay.co.tz/z'), 'https://payments.azampay.co.tz/z');
  // another host only when it is listed (exact name), e.g. a local fake in a non-production sandbox
  assert.equal(pageUrlOf('http://127.0.0.1:9/p', { httpsOnly: false, extraHosts: ['127.0.0.1'] }), 'http://127.0.0.1:9/p');
  assert.equal(pageUrlOf('https://pay.partner.test/p', { extraHosts: [' Pay.Partner.Test '] }), 'https://pay.partner.test/p');
  assert.equal(pageUrlOf('http://127.0.0.1:9/p', { httpsOnly: true, extraHosts: ['127.0.0.1'] }), null, 'https wherever it is required');
  assert.equal(pageUrlOf('http://payments.azampay.co.tz/x'), null, 'plain http is refused by default');
  assert.equal(pageUrlOf('http://payments.azampay.co.tz/x', { httpsOnly: false }), 'http://payments.azampay.co.tz/x');
  for (const bad of [
    'https://evil.test/pay', 'https://azampay.co.tz.evil.test/pay', 'https://evilazampay.co.tz/pay', 'https://azampay.co.tz@evil.test/pay',
    'https://user:pass@payments.azampay.co.tz/pay', 'https://user@payments.azampay.co.tz/pay', 'https://sub.partner.test/p',
    'javascript:alert(1)', 'data:text/html,x', '/relative', 'payments.azampay.co.tz', '', '   ', 'https://a.azampay.co.tz https://b.azampay.co.tz', '{"success":false}', 'null', null, undefined,
  ]) {
    assert.equal(pageUrlOf(bad, { extraHosts: ['partner.test'] }), null, String(bad));
  }
});

test('settings: a page address must be https in live and on any production server; extra hosts come from AZAMPAY_PAGE_HOSTS', () => {
  const base = { AZAMPAY_APP_NAME: 'FitFlex', AZAMPAY_CLIENT_ID: 'cid', AZAMPAY_CLIENT_SECRET: 's' };
  assert.deepEqual([azampaySettings(base).pageHttpsOnly, azampaySettings(base).pageHosts], [false, []]);
  assert.equal(azampaySettings({ ...base, NODE_ENV: 'production' }).pageHttpsOnly, true, 'the sandbox on a production server too');
  assert.deepEqual(azampaySettings({ ...base, AZAMPAY_PAGE_HOSTS: ' 127.0.0.1 , Pay.Partner.Test ,' }).pageHosts, ['127.0.0.1', 'pay.partner.test']);
});

// ── the client, against a fake AzamPay ─────────────────────────────────────

function fakeAzamPay({ bank, page, partners } = {}) {
  const calls = [];
  const reply = (status, body) => ({ ok: status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path: u.pathname, method: init.method, headers: init.headers, body });
    if (u.pathname === '/AppRegistration/GenerateToken') return reply(200, { data: { accessToken: 'tok', expire: iso(Date.now() + 3600_000) }, success: true });
    if (u.pathname === '/azampay/bank/checkout') return bank ? bank(body, reply) : reply(200, { transactionId: 'BANK_1', message: 'ok', success: true });
    if (u.pathname === '/api/v1/Partner/PostCheckout') return page ? page(body, reply) : reply(200, '"https://payments.azampay.co.tz/pay?id=abc"');
    if (u.pathname === '/api/v1/Partner/GetPaymentPartners') return reply(200, partners ?? [{ logoUrl: 'https://x/l.png', partnerName: 'Azampesa', provider: 5, vendorName: 'FitFlex Africa', paymentVendorId: 'e9b57fab-1850-44d4-8499-71fd15c845a0', paymentPartnerId: '11111111-1111-1111-1111-111111111111', currency: 'TZS' }]);
    return reply(404, {});
  };
  return { fetchFn, calls };
}
const BASE = { AZAMPAY_APP_NAME: 'FitFlex', AZAMPAY_CLIENT_ID: 'cid', AZAMPAY_CLIENT_SECRET: 's' };
const VENDOR = { AZAMPAY_VENDOR_ID: 'e9b57fab-1850-44d4-8499-71fd15c845a0', AZAMPAY_VENDOR_NAME: 'FitFlex Africa' };

test('client: bank checkout sends the body AzamPay documents, with the bearer token; a refusal is an error that never carries what was sent', async () => {
  const f = fakeAzamPay();
  const c = createAzamPayClient({ settings: azampaySettings(BASE), fetchFn: f.fetchFn });
  const out = await c.initiateBankPayment({ bank: 'crdb', accountNumber: ACCOUNT, msisdn: '255712345678', otp: OTP, amountTzs: 60_000, reference: 'pay_1.k1' });
  assert.deepEqual(out, { transactionId: 'BANK_1', bank: 'CRDB' });
  const call = f.calls.find((x) => x.path === '/azampay/bank/checkout');
  assert.deepEqual(call.body, { amount: 60_000, currencyCode: 'TZS', merchantAccountNumber: ACCOUNT, merchantMobileNumber: '255712345678', merchantName: null, otp: OTP, provider: 'CRDB', referenceId: 'pay_1.k1' });
  assert.equal(call.headers.Authorization, 'Bearer tok');
  await assert.rejects(c.initiateBankPayment({ bank: 'NBC', accountNumber: ACCOUNT, msisdn: '255712345678', otp: OTP, amountTzs: 1, reference: 'r' }), (e) => e.code === 'unknown_bank');
  for (const refuse of [(b, reply) => reply(200, { success: false, message: 'Invalid OTP' }), (b, reply) => reply(400, { message: 'bad', echo: b }), (b, reply) => reply(500, {})]) {
    const r = createAzamPayClient({ settings: azampaySettings(BASE), fetchFn: fakeAzamPay({ bank: refuse }).fetchFn });
    const err = await r.initiateBankPayment({ bank: 'NMB', accountNumber: ACCOUNT, msisdn: '255712345678', otp: OTP, amountTzs: 60_000, reference: 'pay_1.k2' }).catch((e) => e);
    assert.ok(err instanceof AzamPayError);
    assert.ok(!String(err.message).includes(OTP) && !String(err.message).includes(ACCOUNT), 'the message names neither the OTP nor the account');
  }
});

test('client: the checkout page needs the vendor; sends every documented field with a 30-character externalId; answers only a real page address', async () => {
  const none = createAzamPayClient({ settings: azampaySettings(BASE), fetchFn: fakeAzamPay().fetchFn });
  assert.equal(none.pageConfigured(), false);
  await assert.rejects(none.createCheckoutPage({ amountTzs: 1, externalId: 'x'.repeat(30) }), (e) => e.code === 'page_not_configured');
  const f = fakeAzamPay();
  const c = createAzamPayClient({ settings: azampaySettings({ ...BASE, ...VENDOR }), fetchFn: f.fetchFn });
  assert.equal(c.pageConfigured(), true);
  const externalId = pageReferenceFor('pay_1a2b3c4d', T0);
  const args = { amountTzs: 60_000, externalId, language: 'sw', itemName: 'FitFlex', requestOrigin: 'https://api.fitflex.test', redirectSuccessUrl: 'https://api.fitflex.test/ok', redirectFailUrl: 'https://api.fitflex.test/no' };
  assert.deepEqual(await c.createCheckoutPage(args), { url: 'https://payments.azampay.co.tz/pay?id=abc' });
  const call = f.calls.find((x) => x.path === '/api/v1/Partner/PostCheckout');
  assert.deepEqual(call.body, {
    appName: 'FitFlex', clientId: 'cid', vendorId: VENDOR.AZAMPAY_VENDOR_ID, vendorName: 'FitFlex Africa', language: 'sw', currency: 'TZS',
    externalId, requestOrigin: 'https://api.fitflex.test', redirectFailURL: 'https://api.fitflex.test/no', redirectSuccessURL: 'https://api.fitflex.test/ok',
    amount: '60000', cart: { items: [{ name: 'FitFlex' }] },
  });
  assert.equal(call.body.externalId.length, 30);
  await assert.rejects(c.createCheckoutPage({ ...args, externalId: 'short' }), (e) => e.code === 'invalid_reference');
  for (const answer of ['"javascript:alert(1)"', '', '{"success":false,"message":"no"}', '"/relative"', '"https://evil.test/pay"', '"https://azampay.co.tz@evil.test/pay"', '"http://payments.azampay.co.tz/pay"']) {
    const bad = createAzamPayClient({ settings: azampaySettings({ ...BASE, ...VENDOR, NODE_ENV: 'production' }), fetchFn: fakeAzamPay({ page: (b, reply) => reply(200, answer) }).fetchFn });
    await assert.rejects(bad.createCheckoutPage(args), (e) => e.code === 'rejected', answer);
  }
  // partners: where vendorId / vendorName come from (no logo address is passed on)
  assert.deepEqual(await c.paymentPartners(), [{ partnerName: 'Azampesa', provider: 5, vendorName: 'FitFlex Africa', paymentVendorId: VENDOR.AZAMPAY_VENDOR_ID, paymentPartnerId: '11111111-1111-1111-1111-111111111111', currency: 'TZS' }]);
});

// ── both methods through the payment service ───────────────────────────────

function memStore(rows = []) {
  return {
    rows,
    async filterAsync(fn) { return rows.filter(fn); },
    async findAsync(fn) { return rows.find(fn) || null; },
    async findByIdAsync(id) { return rows.find((r) => r.id === id) || null; },
    async allAsync() { return [...rows]; },
    async insertAsync(row) { rows.push(row); return row; },
    async updateByIdAsync(id, patch) {
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows[i] = { ...rows[i], ...patch };
      return rows[i] || null;
    },
    async updateByIdWhereAsync(id, where, patch) {
      const i = rows.findIndex((r) => r.id === id);
      if (i < 0) return null;
      for (const [column, expected] of Object.entries(where || {})) {
        const current = rows[i][column] ?? null;
        if (Array.isArray(expected) ? !expected.includes(current) : current !== expected) return null;
      }
      rows[i] = { ...rows[i], ...patch };
      return rows[i];
    },
  };
}

const ENV = { PUBLIC_API_URL: 'https://api.fitflex.test', PORTAL_PUBLIC_URL: 'https://portal.fitflex.test' };

function world({ bank = true, page = true, vendor = true, env = ENV, requests, subs } = {}) {
  const subscriptions = memStore(subs ?? [
    { id: 'sub_1', memberId: 'm1', type: 'platform_pass', tier: 'basic', status: 'payment_pending', startedAt: iso(Date.now()), expiresAt: iso(Date.now() + 30 * DAY) },
    { id: 'sub_2', memberId: 'm2', type: 'platform_pass', tier: 'basic', status: 'payment_pending', startedAt: iso(Date.now()), expiresAt: iso(Date.now() + 30 * DAY) },
  ]);
  const paymentRequests = memStore(requests ?? [
    { id: 'pay_1a2b3c4d', memberId: 'm1', subscriptionId: 'sub_1', tier: 'basic', amountTzs: 60_000, status: 'pending', provider: 'admin_approved', reference: null, note: null, requestedAt: iso(Date.now()) },
    { id: 'pay_9f8e7d6c', memberId: 'm2', subscriptionId: 'sub_2', tier: 'basic', amountTzs: 60_000, status: 'pending', provider: 'admin_approved', reference: null, note: null, requestedAt: iso(Date.now()) },
  ]);
  const audit = [];
  const auditLog = { async insertAsync(e) { audit.push(e); } };
  const events = [];
  const adminPaymentService = createAdminPaymentService({ paymentRequests, subscriptions, users: memStore(), auditLog, onSubscriptionActivated: async (s) => { events.push(s.id); } });
  const remote = { bank: [], pages: [], fail: null, pageUrl: (n) => `https://payments.azampay.test/pay?id=${n}` };
  const clock = { t: T0 };
  const flags = { bank, page };
  const client = {
    environment: 'sandbox', confirmsByCallback: true, parseCallback,
    async initiatePayment() { return { transactionId: `MNO_${clock.t}` }; },
    async initiateBankPayment(args) {
      if (remote.fail) throw new AzamPayError('no', { code: remote.fail, status: remote.fail === 'provider_error' ? 500 : 422 });
      remote.bank.push(args);
      return { transactionId: `BANK_${remote.bank.length}` };
    },
    pageConfigured: () => vendor,
    async createCheckoutPage(args) {
      if (remote.fail) throw new AzamPayError('no', { code: remote.fail, status: remote.fail === 'provider_error' ? 500 : 422 });
      remote.pages.push(args);
      return { url: remote.pageUrl(remote.pages.length) };
    },
  };
  const held = []; const unmatched = [];
  const service = createMobileMoneyService({
    paymentRequests, subscriptions, adminPaymentService, auditLog, client,
    enabled: () => true, now: () => clock.t,
    bankCheckout: () => flags.bank, checkoutPage: () => flags.page,
    pageReturn: { targets: () => pageReturnTargets(env), urls: (target, request) => pageReturnUrls(target, request, env) },
    onHeld: async (request, reason, detail) => { held.push([request.id, reason, detail.transactionId]); },
    onUnmatched: async (detail) => { unmatched.push(detail); },
  });
  const req = (id = 'pay_1a2b3c4d') => paymentRequests.rows.find((r) => r.id === id);
  const sub = (id = 'sub_1') => subscriptions.rows.find((s) => s.id === id);
  const audited = (action) => audit.filter((a) => a.action === action);
  /** Everything this world keeps: rows, audit, what staff were told. The OTP must be in none of it. */
  const everythingKept = () => JSON.stringify({ rows: paymentRequests.rows, subs: subscriptions.rows, audit, held, unmatched });
  return { paymentRequests, subscriptions, audit, audited, events, service, remote, clock, flags, held, unmatched, req, sub, everythingKept };
}
const ID = 'pay_1a2b3c4d';
const BANK = { memberId: 'm1', paymentRequestId: ID, bank: 'CRDB', accountNumber: ACCOUNT, phone: '0712345678', otp: OTP };
const PAGE = { memberId: 'm1', paymentRequestId: ID };
/** AzamPay's callback as the route hands it over once the signature is verified. */
const cb = (over = {}) => ({ message: 'ok', clientId: 'cid', transactionstatus: 'success', operator: 'CRDB', reference: null, externalreference: 'AZ_EXT_1', utilityref: `${ID}.a1`, amount: '60000', transid: 'BANK_1', mnoreference: null, ...over });

test('options: `methods` lists what is switched on and configured; bank and page say what they need; the old fields are untouched', () => {
  const all = world().service.options();
  assert.deepEqual(all, {
    enabled: true, provider: 'azampay', environment: 'sandbox', methods: ['mobile_money', 'bank', 'page'],
    bank: { providers: ['CRDB', 'NMB'], maxAmountTzs: AZAMPAY_BANK_MAX_TZS }, page: { returnTo: ['app', 'web'], languages: ['en', 'sw'] },
  });
  assert.deepEqual(world({ bank: false, page: false }).service.options(), { enabled: true, provider: 'azampay', environment: 'sandbox', methods: ['mobile_money'] });
  // the page needs the vendor AND somewhere to come back to
  assert.deepEqual(world({ vendor: false }).service.options().methods, ['mobile_money', 'bank']);
  assert.deepEqual(world({ env: {} }).service.options().methods, ['mobile_money', 'bank']);
  assert.deepEqual(world({ env: { PUBLIC_API_URL: 'https://api.fitflex.test' } }).service.options().page, { returnTo: ['app'], languages: ['en', 'sw'] });
});

test('flags off: bank and page are 404 feature_disabled (before anything is read), and paying by mobile money is unchanged', async () => {
  const w = world({ bank: false, page: false });
  assert.deepEqual(await w.service.payByBank(BANK), { error: 'feature_disabled', status: 404 });
  assert.deepEqual(await w.service.payByPage(PAGE), { error: 'feature_disabled', status: 404 });
  assert.deepEqual(await w.service.payByBank({ ...BANK, paymentRequestId: 'pay_nope' }), { error: 'feature_disabled', status: 404 }, 'no oracle for ids');
  assert.deepEqual([w.remote.bank.length, w.remote.pages.length, w.req().provider], [0, 0, 'admin_approved']);
  assert.equal((await w.service.pay({ memberId: 'm1', paymentRequestId: ID, phone: '0754123456' })).status, 202);
  // the page without its vendor or a return address is off too
  assert.equal((await world({ vendor: false }).service.payByPage(PAGE)).error, 'feature_disabled');
  assert.equal((await world({ env: {} }).service.payByPage(PAGE)).error, 'feature_disabled');
});

test('another member\'s request is 404 for both methods, and nothing is sent or changed', async () => {
  const w = world();
  for (const out of [await w.service.payByBank({ ...BANK, memberId: 'm2' }), await w.service.payByPage({ ...PAGE, memberId: 'm2' }), await w.service.payByBank({ ...BANK, paymentRequestId: 'pay_nope' }), await w.service.payByPage({ ...PAGE, paymentRequestId: 'pay_nope' })]) {
    assert.deepEqual(out, { error: 'not_found', status: 404 });
  }
  assert.deepEqual(await w.service.refresh({ memberId: 'm2', paymentRequestId: ID }), { error: 'not_found', status: 404 });
  assert.deepEqual([w.remote.bank.length, w.remote.pages.length, w.req().provider, w.req().reference], [0, 0, 'admin_approved', null]);
});

test('bank checkout: validation refuses before anything is claimed; the same product, role and state gates as a phone prompt', async () => {
  const w = world();
  for (const [over, error] of [[{ bank: 'NBC' }, 'invalid_bank'], [{ bank: null }, 'invalid_bank'], [{ accountNumber: '12' }, 'invalid_account_number'], [{ accountNumber: null }, 'invalid_account_number'],
    [{ phone: '12345' }, 'invalid_phone'], [{ otp: '12' }, 'invalid_otp'], [{ otp: '12 34 56' }, 'invalid_otp'], [{ otp: undefined }, 'invalid_otp'], [{ otp: { $ne: 1 } }, 'invalid_otp']]) {
    const out = await w.service.payByBank({ ...BANK, ...over });
    assert.deepEqual([out.status, out.error], [400, error], JSON.stringify(over));
  }
  assert.deepEqual((await w.service.payByBank({ ...BANK, bank: 'x' })).allowed, ['CRDB', 'NMB']);
  assert.deepEqual([w.remote.bank.length, w.req().provider, w.audit.length], [0, 'admin_approved', 0]);
  // more than AzamPay's bank limit
  const big = world({ requests: [{ id: ID, memberId: 'm1', subscriptionId: 'sub_1', tier: 'basic', amountTzs: AZAMPAY_BANK_MAX_TZS + 1, status: 'pending', provider: 'admin_approved', reference: null }] });
  assert.deepEqual(await big.service.payByBank(BANK), { error: 'amount_over_bank_limit', status: 409, maxTzs: AZAMPAY_BANK_MAX_TZS });
  // the shared gates
  const decided = world(); decided.req().status = 'approved';
  assert.equal((await decided.service.payByBank(BANK)).error, 'payment_not_pending');
  const byHand = world(); byHand.req().memberReference = 'QGH7XK2L9P';
  assert.equal((await byHand.service.payByBank(BANK)).error, 'manual_payment_submitted');
  const shop = world({ requests: [{ id: ID, memberId: 'm1', orderId: 'ord_1', amountTzs: 60_000, status: 'pending', provider: 'admin_approved', reference: null }] });
  assert.equal((await shop.service.payByBank(BANK)).error, 'not_payable_this_way');
  assert.equal((await shop.service.payByPage(PAGE)).error, 'not_payable_this_way');
  assert.equal((await world().service.payByBank({ ...BANK, role: 'trainer' })).error, 'feature_disabled', 'a trainer only with trainer products on');
});

test('bank checkout, success: the request\'s own amount and our reference go to AzamPay; the callback approves it once; the OTP is kept nowhere', async () => {
  const w = world();
  const out = await w.service.payByBank({ ...BANK, bank: 'nmb', amountTzs: 1, amount: 1 });
  assert.deepEqual([out.status, out.state, out.method], [202, 'in_progress', 'bank']);
  assert.deepEqual(out.paymentRequest, { id: ID, status: 'pending', amountTzs: 60_000, provider: 'azampay', reference: 'BANK_1', productType: 'FITFLEX_PASS' });
  const sent = w.remote.bank[0];
  assert.deepEqual([sent.bank, sent.accountNumber, sent.msisdn, sent.otp, sent.amountTzs], ['NMB', ACCOUNT, '255712345678', OTP, 60_000]);
  assert.match(sent.reference, /^pay_1a2b3c4d\.[a-z0-9]+$/);
  assert.equal(mobileMoneyInFlight(w.req(), w.clock.t), true);
  const requested = w.audited('payment_mobile_money_requested')[0];
  assert.deepEqual(requested.after, { transactionId: 'BANK_1', amountTzs: 60_000, method: 'bank', bank: 'NMB', account: '…7766' }, 'the bank and the last four of the account, for a dispute — never the number or the OTP');
  // a refresh settles nothing; the callback does, once
  assert.equal((await w.service.refresh({ memberId: 'm1', paymentRequestId: ID })).state, 'in_progress');
  assert.equal((await w.service.handleCallback(cb({ utilityref: sent.reference }))).state, 'completed');
  assert.deepEqual([w.req().status, w.req().reference, w.req().decidedBy, w.sub().status], ['approved', 'BANK_1', 'azampay', 'active']);
  await w.service.handleCallback(cb({ utilityref: sent.reference }));
  assert.deepEqual(w.events, ['sub_1'], 'activated once');
  assert.equal((await w.service.refresh({ memberId: 'm1', paymentRequestId: ID })).state, 'completed');
  // the OTP and the account number: not on any row, not in the audit, not in what staff are told
  assert.ok(!w.everythingKept().includes(OTP), 'the OTP is kept nowhere');
  assert.ok(!w.everythingKept().includes(ACCOUNT), 'nor is the account number');
  assert.ok(!w.everythingKept().includes('255712345678'), 'nor the phone');
});

test('bank checkout, failure and refusal: a refused OTP frees the request at once (422); a failure callback releases it; the OTP is in no audit row', async () => {
  const w = world();
  w.remote.fail = 'rejected';
  assert.deepEqual(await w.service.payByBank(BANK), { error: 'provider_rejected', status: 422 });
  assert.deepEqual([w.req().provider, w.req().reference], ['admin_approved', null]);
  assert.deepEqual(w.audited('payment_mobile_money_failed_to_start')[0].after, { code: 'rejected', method: 'bank', bankRejections: 1 });
  // a call that may have reached AzamPay keeps its claim (no second charge), then expires
  w.remote.fail = 'unreachable';
  assert.equal((await w.service.payByBank(BANK)).error, 'provider_unavailable');
  assert.match(w.req().reference, /^pending:/);
  w.remote.fail = null;
  assert.equal((await w.service.payByBank(BANK)).alreadyRequested, true);
  w.clock.t += 3 * 60_000;
  assert.equal((await w.service.payByBank(BANK)).status, 202);
  const failed = await w.service.handleCallback(cb({ utilityref: w.remote.bank[0].reference, transactionstatus: 'failure', message: 'Insufficient funds' }));
  assert.equal(failed.state, 'failed');
  assert.deepEqual([w.req().status, w.req().provider, w.req().reference, w.sub().status], ['pending', 'admin_approved', null, 'payment_pending']);
  assert.ok(!w.everythingKept().includes(OTP));
});

test('bank checkout: OTP attempts are limited like prompts (5 per member, 3 per phone in 10 minutes)', async () => {
  const w = world();
  w.remote.fail = 'rejected';                                   // each try is refused by the bank (a wrong OTP)
  for (let i = 0; i < 3; i += 1) assert.equal((await w.service.payByBank(BANK)).error, 'provider_rejected');
  assert.deepEqual(await w.service.payByBank(BANK), { error: 'too_many_attempts', status: 429 }, 'per phone');
  for (let i = 0; i < 1; i += 1) assert.equal((await w.service.payByBank({ ...BANK, phone: '0754000111' })).error, 'provider_rejected');
  assert.deepEqual(await w.service.payByBank({ ...BANK, phone: '0754000222' }), { error: 'too_many_attempts', status: 429 }, 'per member');
  w.clock.t += 11 * 60_000;
  assert.equal((await w.service.payByBank(BANK)).error, 'provider_rejected', 'the window passed');
});

test('bank checkout: the wrong amount, a late and a duplicate callback, an expired attempt — the same holds as a phone prompt', async () => {
  // less and more than asked, and an unreadable amount
  for (const amount of ['59999', '60001', '', '59999.5']) {
    const w = world();
    await w.service.payByBank(BANK);
    const out = await w.service.handleCallback(cb({ utilityref: w.remote.bank[0].reference, amount }));
    assert.deepEqual([out.state, out.reason, w.req().status, w.sub().status], ['held', 'amount_mismatch', 'pending', 'payment_pending'], amount);
    assert.deepEqual(w.held, [[ID, 'amount_mismatch', 'BANK_1']]);
  }
  // expired: after the window a new attempt may start; the old one's late success is held, the new one settles once
  const w = world();
  await w.service.payByBank(BANK);
  w.clock.t += PROMPT_TTL_MS - 1000;
  assert.equal((await w.service.payByBank(BANK)).alreadyRequested, true);
  assert.equal((await w.service.payByPage(PAGE)).alreadyRequested, true, 'one attempt at a time, whatever the method');
  w.clock.t += 2000;
  assert.equal((await w.service.payByBank(BANK)).status, 202);
  assert.deepEqual([w.req().reference, w.req().supersededReferences], ['BANK_2', ['BANK_1']]);
  const late = await w.service.handleCallback(cb({ utilityref: w.remote.bank[0].reference, transid: 'BANK_1' }));
  assert.deepEqual([late.state, late.reason], ['held', 'transaction_mismatch']);
  assert.equal((await w.service.handleCallback(cb({ utilityref: w.remote.bank[1].reference, transid: 'BANK_2' }))).state, 'completed');
  assert.deepEqual(w.events, ['sub_1']);
  // a second, different payment on the settled request is recorded, not applied
  await w.service.handleCallback(cb({ utilityref: w.remote.bank[0].reference, transid: 'BANK_1' }));
  assert.equal(w.audited('payment_mobile_money_orphaned')[0].after.error, 'already_settled');
  assert.deepEqual(w.events, ['sub_1']);
  // refresh after the window gives the request back; a success after that is held
  const r = world();
  await r.service.payByBank(BANK);
  r.clock.t += PROMPT_TTL_MS + 1000;
  assert.equal((await r.service.refresh({ memberId: 'm1', paymentRequestId: ID })).state, 'none');
  const orphan = await r.service.handleCallback(cb({ utilityref: r.remote.bank[0].reference }));
  assert.deepEqual([orphan.state, orphan.reason, r.sub().status], ['held', 'no_open_attempt', 'payment_pending']);
});

test('checkout page: the address a client sends is never used — returnTo is a name, and the redirect addresses are the server\'s own', async () => {
  const w = world();
  const hostile = { returnTo: 'app', redirectSuccessURL: 'https://evil.test/ok', redirectSuccessUrl: 'https://evil.test/ok', redirectFailURL: 'https://evil.test/no', successUrl: 'https://evil.test', requestOrigin: 'https://evil.test', origin: 'https://evil.test', urls: { successUrl: 'https://evil.test' }, externalId: 'x'.repeat(30), amountTzs: 1, amount: '1', vendorId: 'evil', itemName: 'evil' };
  const out = await w.service.payByPage({ ...PAGE, ...hostile });
  assert.equal(out.status, 202);
  const sent = w.remote.pages[0];
  assert.deepEqual([sent.requestOrigin, sent.redirectSuccessUrl, sent.redirectFailUrl], ['https://api.fitflex.test', 'https://api.fitflex.test/payments/azampay/return?result=success', 'https://api.fitflex.test/payments/azampay/return?result=failed']);
  assert.deepEqual([sent.amountTzs, sent.itemName, sent.language, sent.externalId.length], [60_000, 'FitFlex', 'en', 30]);
  assert.ok(!JSON.stringify(sent).includes('evil'));
  // an address, or any name that is not a configured target, is refused; so is an unknown language
  for (const returnTo of ['https://evil.test', '//evil.test', 'APP', 'web ', 'ios']) {
    const bad = await world().service.payByPage({ ...PAGE, returnTo });
    assert.deepEqual([bad.status, bad.error, bad.allowed], [400, 'invalid_return_to', ['app', 'web']], returnTo);
  }
  assert.deepEqual((await world({ env: { PUBLIC_API_URL: 'https://api.fitflex.test' } }).service.payByPage({ ...PAGE, returnTo: 'web' })).allowed, ['app'], 'web is not offered while the portal address is not set');
  assert.equal((await world().service.payByPage({ ...PAGE, language: 'fr' })).error, 'invalid_language');
  // web: the member portal, with the request id (encoded) and nothing else
  const web = world();
  await web.service.payByPage({ ...PAGE, returnTo: 'web', language: 'SW' });
  assert.deepEqual([web.remote.pages[0].redirectSuccessUrl, web.remote.pages[0].requestOrigin, web.remote.pages[0].language], ['https://portal.fitflex.test/m/payment-return/?paymentRequestId=pay_1a2b3c4d&result=success', 'https://portal.fitflex.test', 'sw']);
});

test('checkout page, success: the page address is returned; coming back proves nothing; the callback for OUR reference approves it once and AzamPay\'s transaction is recorded', async () => {
  const w = world();
  const out = await w.service.payByPage(PAGE);
  const ref = w.remote.pages[0].externalId;
  assert.deepEqual([out.status, out.state, out.method, out.checkoutUrl], [202, 'in_progress', 'page', 'https://payments.azampay.test/pay?id=1']);
  assert.deepEqual(parsePageReference(ref), { requestId: ID, attempt: T0 });
  assert.deepEqual([w.req().provider, w.req().reference, w.req().checkoutUrl, w.req().promptedAt], ['azampay', ref, out.checkoutUrl, iso(T0)]);
  assert.deepEqual(w.audited('payment_mobile_money_requested')[0].after, { transactionId: ref, amountTzs: 60_000, method: 'page' });
  // the member closed the page: the same call (and a refresh) hand back the SAME page, no second one
  const again = await w.service.payByPage(PAGE);
  assert.deepEqual([again.status, again.alreadyRequested, again.checkoutUrl, w.remote.pages.length], [200, true, out.checkoutUrl, 1]);
  // the member is back from the page (the redirect): a refresh settles NOTHING, whatever the address said
  const back = await w.service.refresh({ memberId: 'm1', paymentRequestId: ID });
  assert.deepEqual([back.state, back.checkoutUrl, w.req().status, w.sub().status], ['in_progress', out.checkoutUrl, 'pending', 'payment_pending']);
  // AzamPay's signed callback names our reference (in any case) and its own transaction
  const done = await w.service.handleCallback(cb({ utilityref: ref.toUpperCase(), transid: 'AZ_PAGE_TXN_1', operator: 'Mpesa' }));
  assert.equal(done.state, 'completed');
  assert.deepEqual([w.req().status, w.req().reference, w.req().decidedBy, w.sub().status], ['approved', 'AZ_PAGE_TXN_1', 'azampay', 'active']);
  for (let i = 0; i < 2; i += 1) assert.equal((await w.service.handleCallback(cb({ utilityref: ref, transid: 'AZ_PAGE_TXN_1' }))).state, 'completed');
  assert.deepEqual(w.events, ['sub_1'], 'activated once');
  assert.equal(w.audited('payment_mobile_money_orphaned').length, 0);
  const after = await w.service.refresh({ memberId: 'm1', paymentRequestId: ID });
  assert.deepEqual([after.state, after.checkoutUrl], ['completed', undefined]);
});

test('checkout page: failure, the wrong amount, one transaction for two requests, and a request that cannot have a page reference', async () => {
  // A failed try on the page does NOT give the request back while the page is open: the payer can try again on it,
  // and that success must find its attempt (not be charged and then held).
  const f = world();
  const started = await f.service.payByPage(PAGE);
  const ref = f.remote.pages[0].externalId;
  const failed = await f.service.handleCallback(cb({ utilityref: ref, transid: 'AZ_TRY_1', transactionstatus: 'failure', message: 'Insufficient funds' }));
  assert.equal(failed.state, 'in_progress');
  assert.deepEqual([f.req().status, f.req().provider, f.req().reference, f.req().checkoutUrl, f.req().supersededReferences], ['pending', 'azampay', ref, started.checkoutUrl, undefined]);
  assert.deepEqual(f.audited('payment_mobile_money_page_try_failed')[0].after, { why: 'Insufficient funds', transactionId: 'AZ_TRY_1' });
  assert.equal(f.audited('payment_mobile_money_failed').length, 0, 'not released');
  assert.equal((await f.service.payByPage(PAGE)).checkoutUrl, started.checkoutUrl, 'the same page is still handed back');
  // the retry on the same page succeeds: settled, once
  assert.equal((await f.service.handleCallback(cb({ utilityref: ref, transid: 'AZ_TRY_2' }))).state, 'completed');
  assert.deepEqual([f.req().status, f.req().reference, f.sub().status, f.events], ['approved', 'AZ_TRY_2', 'active', ['sub_1']]);
  // once the page's window has passed, a failure does give the request back; a success after that is held
  const g = world();
  await g.service.payByPage(PAGE);
  const old = g.remote.pages[0].externalId;
  g.clock.t += PAGE_TTL_MS + 1000;
  assert.equal((await g.service.handleCallback(cb({ utilityref: old, transid: 'AZ_1', transactionstatus: 'failure' }))).state, 'failed');
  assert.deepEqual([g.req().status, g.req().provider, g.req().reference, g.req().checkoutUrl, g.req().supersededReferences], ['pending', 'admin_approved', null, null, [old]]);
  const late = await g.service.handleCallback(cb({ utilityref: old, transid: 'AZ_1' }));
  assert.deepEqual([late.state, late.reason, g.sub().status], ['held', 'no_open_attempt', 'payment_pending']);
  // a bank checkout or a phone prompt that fails is still released at once (nothing stays open for a retry)
  const b = world();
  await b.service.payByBank(BANK);
  assert.equal((await b.service.handleCallback(cb({ utilityref: b.remote.bank[0].reference, transactionstatus: 'failure' }))).state, 'failed');
  assert.equal(b.req().provider, 'admin_approved');
  for (const amount of ['1000', '120000', 'abc']) {
    const w = world();
    await w.service.payByPage(PAGE);
    const out = await w.service.handleCallback(cb({ utilityref: w.remote.pages[0].externalId, transid: 'AZ_2', amount }));
    assert.deepEqual([out.state, out.reason, w.req().status], ['held', 'amount_mismatch', 'pending'], amount);
  }
  // the transaction that settled m1's request cannot settle m2's
  const w = world();
  await w.service.payByPage(PAGE);
  await w.service.handleCallback(cb({ utilityref: w.remote.pages[0].externalId, transid: 'AZ_SAME' }));
  await w.service.payByPage({ memberId: 'm2', paymentRequestId: 'pay_9f8e7d6c' });
  const dup = await w.service.handleCallback(cb({ utilityref: w.remote.pages[1].externalId, transid: 'AZ_SAME' }));
  assert.deepEqual([dup.state, dup.reason, w.req('pay_9f8e7d6c').status, w.sub('sub_2').status], ['held', 'reference_already_used', 'pending', 'payment_pending']);
  // an id that does not fit the 30 characters: not payable on the page (bank and mobile money still are)
  const odd = world({ requests: [{ id: 'pay_ent_123_m1', memberId: 'm1', subscriptionId: 'sub_1', tier: 'basic', amountTzs: 60_000, status: 'pending', provider: 'admin_approved', reference: null }] });
  assert.deepEqual(await odd.service.payByPage({ memberId: 'm1', paymentRequestId: 'pay_ent_123_m1' }), { error: 'not_payable_this_way', status: 409 });
  assert.equal((await odd.service.payByBank({ ...BANK, paymentRequestId: 'pay_ent_123_m1' })).status, 202);
  // AzamPay refusing to make a page frees the request at once (nothing can have been paid)
  for (const code of ['rejected', 'unreachable', 'provider_error']) {
    const r = world(); r.remote.fail = code;
    const out = await r.service.payByPage(PAGE);
    assert.deepEqual([out.error, r.req().provider, r.req().reference], [code === 'rejected' ? 'provider_rejected' : 'provider_unavailable', 'admin_approved', null], code);
  }
});

test('checkout page: it stays open for PAGE_TTL_MS (longer than a prompt); after that a new page is a new attempt and the old page\'s late payment is held', async () => {
  const w = world();
  await w.service.payByPage(PAGE);
  const first = w.remote.pages[0].externalId;
  w.clock.t += PROMPT_TTL_MS + 60_000;
  assert.equal(mobileMoneyInFlight(w.req(), w.clock.t), true, 'a page is not given up after the prompt window');
  assert.equal((await w.service.refresh({ memberId: 'm1', paymentRequestId: ID })).state, 'in_progress');
  w.clock.t = T0 + PAGE_TTL_MS + 1000;
  assert.equal(mobileMoneyInFlight(w.req(), w.clock.t), false);
  const out = await w.service.payByPage(PAGE);
  const second = w.remote.pages[1].externalId;
  assert.deepEqual([out.status, out.checkoutUrl, w.req().reference, w.req().supersededReferences], [202, 'https://payments.azampay.test/pay?id=2', second, [first]]);
  assert.notEqual(first, second);
  // paid on the OLD page: found by its own reference, held, the new page untouched
  const late = await w.service.handleCallback(cb({ utilityref: first, transid: 'AZ_OLD' }));
  assert.deepEqual([late.state, late.reason, w.req().status, w.req().reference, w.req().checkoutUrl], ['held', 'transaction_mismatch', 'pending', second, out.checkoutUrl]);
  assert.deepEqual(w.held, [[ID, 'transaction_mismatch', first]]);
  assert.equal((await w.service.handleCallback(cb({ utilityref: second, transid: 'AZ_NEW' }))).state, 'completed');
  assert.deepEqual([w.req().reference, w.events], ['AZ_NEW', ['sub_1']]);
  // a refresh after the window, with no retry, gives the request back; the page's late payment is then held
  const r = world();
  await r.service.payByPage(PAGE);
  r.clock.t += PAGE_TTL_MS + 1000;
  const back = await r.service.refresh({ memberId: 'm1', paymentRequestId: ID });
  assert.deepEqual([back.state, back.checkoutUrl, r.req().checkoutUrl], ['none', undefined, null]);
  const orphan = await r.service.handleCallback(cb({ utilityref: r.remote.pages[0].externalId, transid: 'AZ_LATE' }));
  assert.deepEqual([orphan.state, orphan.reason], ['held', 'no_open_attempt']);
});

test('a verified success whose reference matches no request is never dropped quietly: audited and raised for staff, keyed on the SIGNED fields so a replay cannot flood', async () => {
  const w = world();
  const out = await w.service.handleCallback(cb({ utilityref: 'AZAMPAY-OWN-REF-0001', externalreference: 'PG-REF-1', transid: 'AZ_X', amount: '60000' }));
  assert.deepEqual(out, { status: 200, ok: true, ignored: 'unknown_reference' });
  assert.deepEqual(w.unmatched, [{ reference: 'AZAMPAY-OWN-REF-0001', externalReference: 'PG-REF-1', transactionId: 'AZ_X', amountTzs: 60_000 }]);
  assert.deepEqual(w.audited('payment_mobile_money_unmatched')[0].after, { externalReference: 'PG-REF-1', transactionId: 'AZ_X', amountTzs: 60_000 });
  // a failure for an unknown reference is nothing to report
  await w.service.handleCallback(cb({ utilityref: 'AZAMPAY-OWN-REF-0002', transid: 'AZ_Y', transactionstatus: 'failure' }));
  assert.equal(w.unmatched.length, 1);
  // the hook says "already raised" (isNew false) for a repeat: counted there, no further audit row
  const audit = [];
  const raised = new Map();
  const service = createMobileMoneyService({
    paymentRequests: memStore(), subscriptions: memStore(), adminPaymentService: null, auditLog: { async insertAsync(e) { audit.push(e); } },
    client: { environment: 'sandbox', confirmsByCallback: true, parseCallback }, enabled: () => true,
    onUnmatched: async (d) => { const key = `${d.reference}:${d.externalReference}`; const isNew = !raised.has(key); raised.set(key, (raised.get(key) ?? 0) + 1); return { isNew }; },
  });
  // the same signed callback replayed 40 times with a different (unsigned) transid and amount each time
  for (let i = 0; i < 40; i += 1) await service.handleCallback(cb({ utilityref: 'AZAMPAY-OWN-REF-0003', externalreference: 'PG-REF-3', transid: `FORGED_${i}`, amount: String(1000 + i) }));
  assert.deepEqual([...raised.entries()], [['AZAMPAY-OWN-REF-0003:PG-REF-3', 40]], 'one exception, counted');
  assert.equal(audit.filter((a) => a.action === 'payment_mobile_money_unmatched').length, 1, 'one audit row');
});

test('OTP guessing: after 5 bank refusals the bank method is closed for that request (409), whatever the phone or the wait; the other methods and other requests are not', async () => {
  const w = world();
  w.remote.fail = 'rejected';
  for (let i = 0; i < BANK_REJECTIONS_MAX; i += 1) {
    const out = await w.service.payByBank({ ...BANK, phone: `07540001${String(i).padStart(2, '0')}`, otp: String(100000 + i) });
    assert.equal(out.error, 'provider_rejected', `refusal ${i + 1}`);
    assert.equal(w.req().bankRejections, i + 1);
    w.clock.t += 11 * 60_000;                                     // outside the per-member / per-phone window each time
  }
  w.remote.fail = null;                                           // even the right OTP is not sent any more
  assert.deepEqual(await w.service.payByBank(BANK), { error: 'bank_attempts_exhausted', status: 409, max: BANK_REJECTIONS_MAX });
  w.clock.t += 30 * DAY;
  assert.equal((await w.service.payByBank(BANK)).error, 'bank_attempts_exhausted', 'waiting does not reopen it');
  assert.equal(w.remote.bank.length, 0, 'nothing reached the bank after the cap');
  // the request can still be paid another way, and another request by bank
  assert.equal((await w.service.payByPage(PAGE)).status, 202);
  assert.equal((await w.service.payByBank({ ...BANK, memberId: 'm2', paymentRequestId: 'pay_9f8e7d6c', phone: '0754000999' })).status, 202);
  // only a refusal by the bank counts: an unreachable AzamPay or a bad shape does not
  const u = world();
  u.remote.fail = 'unreachable';
  await u.service.payByBank(BANK);
  await u.service.payByBank({ ...BANK, otp: '1' });
  assert.equal(u.req().bankRejections, undefined);
  assert.ok(!w.everythingKept().includes('100003'), 'the refused OTPs are kept nowhere either');
});

test('a decided request keeps no payment page: approved by the callback, rejected or approved by staff, or changed afterwards, checkoutUrl is cleared', async () => {
  const viaCallback = world();
  await viaCallback.service.payByPage(PAGE);
  assert.ok(viaCallback.req().checkoutUrl);
  await viaCallback.service.handleCallback(cb({ utilityref: viaCallback.remote.pages[0].externalId, transid: 'AZ_OK' }));
  assert.deepEqual([viaCallback.req().status, viaCallback.req().checkoutUrl], ['approved', null]);
  for (const decision of ['reject', 'approve']) {
    const w = world();
    await w.service.payByPage(PAGE);
    const admin = createAdminPaymentService({ paymentRequests: w.paymentRequests, subscriptions: w.subscriptions, users: memStore(), auditLog: { async insertAsync() {} } });
    const out = await admin.decide({ id: ID, decision, actorId: 'admin_1', reference: 'BANK_STATEMENT_1', amountTzs: 60_000 });
    assert.equal(out.error, undefined, decision);
    assert.deepEqual([w.req().status, w.req().checkoutUrl], [decision === 'approve' ? 'approved' : 'rejected', null], decision);
    const after = await w.service.refresh({ memberId: 'm1', paymentRequestId: ID });
    assert.equal(after.checkoutUrl, undefined, 'and it is never handed out for a decided request');
    assert.equal((await w.service.payByPage(PAGE)).error, 'payment_not_pending');
  }
  // a request with no page is written exactly as before (no new key)
  const plain = world();
  const admin = createAdminPaymentService({ paymentRequests: plain.paymentRequests, subscriptions: plain.subscriptions, users: memStore(), auditLog: { async insertAsync() {} } });
  await admin.decide({ id: ID, decision: 'reject', actorId: 'admin_1' });
  assert.equal('checkoutUrl' in plain.req(), false);
});
