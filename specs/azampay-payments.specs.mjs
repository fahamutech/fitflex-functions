// Pay by mobile money through AzamPay: settings, the client (against a fake
// AzamPay), the RSA callback signature, and settling a payment request from a
// verified callback (AzamPay has no status query for collections).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign, privateDecrypt, constants as cryptoConstants, createHash } from 'node:crypto';
import {
  azampaySettings, AZAMPAY_SANDBOX_HOSTS, toMsisdn, networkFor, amountToTzs, callbackSignedText,
  verifyCallbackSignature, parseCallback, disburseChecksum, createAzamPayClient, AzamPayError, maybeSent,
  azampayConfigProblem, callbackIsSigned, KEY_REFETCH_MIN_MS,
} from '../src/integrations/payments/azampay.mjs';
import { createMobileMoneyService } from '../src/services/mobile-money-service.mjs';
import { createAdminPaymentService } from '../src/services/admin-payment-service.mjs';
import { mobileMoneyInFlight } from '../src/shared/mobile-money-claim.mjs';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUB = publicKey.export({ type: 'spki', format: 'pem' });
const signCallback = (p, key = privateKey) => {
  const s = createSign('SHA256');
  s.update(callbackSignedText(p), 'utf8');
  return s.sign(key, 'base64');
};
const callback = (over = {}) => {
  const p = {
    message: 'Transaction completed successfully', user: 'u', password: 'p', clientId: 'cid',
    transactionstatus: 'success', operator: 'Mpesa', reference: 'AZ_REF', externalreference: 'AZ_EXT',
    utilityref: 'pay_1.k1', amount: '60000', transid: 'TXN_1', msisdn: '255754000000', mnoreference: 'MNO1', ...over,
  };
  return { ...p, signature: over.signature ?? signCallback(p) };
};

// ── settings ───────────────────────────────────────────────────────────────

test('settings: all three credentials needed; sandbox unless live AND the live hosts are given', () => {
  assert.equal(azampaySettings({}), null);
  assert.equal(azampaySettings({ AZAMPAY_APP_NAME: 'a', AZAMPAY_CLIENT_ID: 'c' }), null);
  const base = { AZAMPAY_APP_NAME: 'FitFlex', AZAMPAY_CLIENT_ID: ' "cid" ', AZAMPAY_CLIENT_SECRET: 's' };
  const s = azampaySettings(base);
  assert.deepEqual([s.appName, s.clientId, s.environment], ['FitFlex', 'cid', 'sandbox']);
  assert.deepEqual(s.hosts, AZAMPAY_SANDBOX_HOSTS);
  // live without AzamPay's live hosts is CLOSED (no settings, no client): never quietly the sandbox
  assert.equal(azampaySettings({ ...base, AZAMPAY_ENV: 'live' }), null);
  const live = azampaySettings({ ...base, AZAMPAY_ENV: 'live', AZAMPAY_AUTH_URL: 'https://a.live/', AZAMPAY_CHECKOUT_URL: 'https://c.live', AZAMPAY_DISBURSE_URL: 'https://d.live' });
  assert.equal(live.environment, 'live');
  assert.equal(live.hosts.auth, 'https://a.live');
  assert.equal(azampaySettings({ ...base, AZAMPAY_ENV: 'Liv', AZAMPAY_AUTH_URL: 'x', AZAMPAY_CHECKOUT_URL: 'y', AZAMPAY_DISBURSE_URL: 'z' }).environment, 'sandbox');
  // a sandbox server cannot be pointed at a mock in production
  assert.equal(azampaySettings({ ...base, AZAMPAY_CHECKOUT_URL: 'https://mock.test', NODE_ENV: 'production' }).hosts.checkout, AZAMPAY_SANDBOX_HOSTS.checkout);
  assert.equal(azampaySettings({ ...base, AZAMPAY_CHECKOUT_URL: 'https://mock.test' }).hosts.checkout, 'https://mock.test');
  assert.equal(azampaySettings(base).disbursePublicKey, null);
});

test('AZAMPAY_ENV=live fails closed: incomplete or non-https live hosts give no settings and a named problem; the disbursement host is optional', () => {
  const base = { AZAMPAY_APP_NAME: 'FitFlex', AZAMPAY_CLIENT_ID: 'cid', AZAMPAY_CLIENT_SECRET: 's', AZAMPAY_ENV: 'live' };
  const A = { AZAMPAY_AUTH_URL: 'https://auth.live' }; const C = { AZAMPAY_CHECKOUT_URL: 'https://checkout.live' };
  for (const env of [base, { ...base, ...A }, { ...base, ...C }, { ...base, ...A, AZAMPAY_DISBURSE_URL: 'https://d.live' }]) {
    assert.equal(azampayConfigProblem(env), 'live_hosts_missing', JSON.stringify(env));
    assert.equal(azampaySettings(env), null, 'no settings → no client, nothing settles');
  }
  for (const env of [
    { ...base, AZAMPAY_AUTH_URL: 'http://auth.live', ...C }, { ...base, ...A, AZAMPAY_CHECKOUT_URL: 'http://checkout.live' },
    { ...base, ...A, AZAMPAY_CHECKOUT_URL: 'checkout.live' }, { ...base, ...A, ...C, AZAMPAY_DISBURSE_URL: 'http://d.live' },
  ]) {
    assert.equal(azampayConfigProblem(env), 'live_hosts_not_https', JSON.stringify(env));
    assert.equal(azampaySettings(env), null);
  }
  // collections need only the auth and checkout hosts; payouts stay closed without the disbursement host
  const live = azampaySettings({ ...base, ...A, ...C, AZAMPAY_DISBURSE_PUBLIC_KEY: PUB });
  assert.equal(azampayConfigProblem({ ...base, ...A, ...C }), null);
  assert.deepEqual([live.environment, live.hosts.auth, live.hosts.checkout, live.hosts.disburse], ['live', 'https://auth.live', 'https://checkout.live', null]);
  assert.equal(createAzamPayClient({ settings: live }).payoutsConfigured(), false);
  // the sandbox is unaffected, and a typo is still the sandbox (never live)
  assert.equal(azampayConfigProblem({ ...base, AZAMPAY_ENV: 'sandbox' }), null);
  assert.equal(azampayConfigProblem({ ...base, AZAMPAY_ENV: 'Liv' }), null);
  assert.equal(azampayConfigProblem({}), null);
});

test('payouts without the disbursement host are refused before any call', async () => {
  const live = azampaySettings({ AZAMPAY_APP_NAME: 'F', AZAMPAY_CLIENT_ID: 'cid', AZAMPAY_CLIENT_SECRET: 's', AZAMPAY_ENV: 'live', AZAMPAY_AUTH_URL: 'https://a.live', AZAMPAY_CHECKOUT_URL: 'https://c.live', AZAMPAY_DISBURSE_PUBLIC_KEY: PUB });
  let calls = 0;
  const c = createAzamPayClient({ settings: live, fetchFn: async () => { calls += 1; throw new Error('must not be called'); } });
  await assert.rejects(c.disburse({ source: {}, destination: {}, amountTzs: 1000, externalReferenceId: 'p1', checksumText: 'x' }), (e) => e.code === 'payouts_not_configured');
  await assert.rejects(c.nameLookup({ bankName: 'Tigo', accountNumber: '1', checksumText: 'x' }), (e) => e.code === 'payouts_not_configured');
  await assert.rejects(c.payoutStatus({ pgReferenceId: 'pg', bankName: 'Tigo' }), (e) => e.code === 'payouts_not_configured');
  assert.equal(calls, 0);
});

test('phone numbers and networks: the member\'s choice wins, else the prefix; AzamPesa only when chosen', () => {
  assert.equal(toMsisdn('0754 123 456'), '255754123456');
  assert.equal(toMsisdn('0812345678'), null);
  assert.equal(networkFor('255754123456'), 'Mpesa');
  assert.equal(networkFor('255712345678'), 'Tigo');
  assert.equal(networkFor('255684123456'), 'Airtel');
  assert.equal(networkFor('255621234567'), 'Halopesa');
  assert.equal(networkFor('255731234567'), null);
  assert.equal(networkFor('255754123456', 'azampesa'), 'Azampesa');
  assert.equal(networkFor('255754123456', 'M-Pesa'), 'Mpesa');
  assert.equal(networkFor('255754123456', 'mixx'), 'Tigo');
  assert.equal(networkFor('255754123456', 'bitcoin'), null);
  assert.equal(amountToTzs('60000.00'), 60000);
  // an amount with cents is never rounded into the price asked: unreadable, so the payment is held
  for (const bad of ['59999.5', '59999.99', '60000.4', '6e4.5', '', ' ', 'abc', '-60000', '0', null, undefined, 'Infinity']) assert.equal(amountToTzs(bad), null, String(bad));
  assert.deepEqual([amountToTzs('60,000'), amountToTzs(60000), amountToTzs(' 60000 ')], [60000, 60000, 60000]);
  assert.equal(amountToTzs('0'), null);
});

// ── callback signature ─────────────────────────────────────────────────────

test('callback signature: RSA-SHA256 over utilityref+externalreference+status+operator', () => {
  const p = callback();
  assert.equal(verifyCallbackSignature(p, PUB), true);
  // any signed field changed → refused
  for (const change of [{ transactionstatus: 'failure' }, { utilityref: 'pay_2.k1' }, { operator: 'Tigo' }, { externalreference: 'X' }]) {
    assert.equal(verifyCallbackSignature({ ...p, ...change }, PUB), false, JSON.stringify(change));
  }
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  assert.equal(verifyCallbackSignature(callback({ signature: undefined, ...{} }), PUB), true);
  assert.equal(verifyCallbackSignature({ ...p, signature: signCallback(p, other) }, PUB), false);
  assert.equal(verifyCallbackSignature({ ...p, signature: '' }, PUB), false);
  assert.equal(verifyCallbackSignature({ ...p, signature: 'not base64 !!' }, PUB), false);
  assert.equal(verifyCallbackSignature(p, ''), false);
  assert.equal(verifyCallbackSignature(null, PUB), false);
});

test('parseCallback: our reference, every transaction id, the status, nothing secret kept', () => {
  const out = parseCallback(callback());
  assert.equal(out.referenceId, 'pay_1.k1');
  assert.deepEqual(out.transactionIds, ['TXN_1', 'AZ_REF', 'AZ_EXT']);
  assert.deepEqual([out.confirmed.status, out.confirmed.amountTzs], ['COMPLETED', 60000]);
  assert.equal(parseCallback(callback({ transactionstatus: 'failure' })).confirmed.status, 'FAILED');
  assert.equal(parseCallback(callback({ transactionstatus: 'weird' })).confirmed.status, 'UNKNOWN');
  for (const k of ['password', 'user', 'signature', 'msisdn', 'clientId']) assert.equal(k in out.confirmed.raw, false, k);
});

test('disbursement checksum: Base64(RSA-PKCS1(SHA512 hex)) under the given key', () => {
  const c = disburseChecksum('abc', PUB);
  const plain = privateDecrypt({ key: privateKey, padding: cryptoConstants.RSA_PKCS1_PADDING }, Buffer.from(c, 'base64')).toString('utf8');
  assert.equal(plain, createHash('sha512').update('abc').digest('hex'));
});

// ── the client, against a fake AzamPay ─────────────────────────────────────

function fakeAzamPay({ onCheckout, keyPem = PUB } = {}) {
  const calls = [];
  let tokens = 0;
  let keys = 0;
  const reply = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ host: u.host, path: u.pathname, method: init.method, headers: init.headers, body });
    if (u.pathname === '/AppRegistration/GenerateToken') { tokens += 1; return reply(200, { data: { accessToken: `tok${tokens}`, expire: new Date(Date.now() + 3600_000).toISOString() }, success: true }); }
    if (u.pathname === '/azampay/mno/checkout') return onCheckout ? onCheckout(body, reply) : reply(200, { transactionId: 'TXN_1', message: 'ok', success: true });
    if (u.pathname === '/azampay/v1/public-key') { keys += 1; return reply(200, { success: true, format: 'Pem', publicKey: typeof keyPem === 'function' ? keyPem(keys) : keyPem }); }
    if (u.pathname === '/api/v1/azampay/disburse') return reply(200, { pgReferenceId: 'pg1', message: 'Your transaction is in process', success: true });
    return reply(404, {});
  };
  return { fetchFn, calls, get tokens() { return tokens; }, get keys() { return keys; } };
}
const settings = (over = {}) => ({ ...azampaySettings({ AZAMPAY_APP_NAME: 'FitFlex', AZAMPAY_CLIENT_ID: 'cid', AZAMPAY_CLIENT_SECRET: 's', AZAMPAY_API_KEY: 'ak' }), ...over });

test('client: one token, checkout body as AzamPay documents it, network from the number', async () => {
  const f = fakeAzamPay();
  const c = createAzamPayClient({ settings: settings(), fetchFn: f.fetchFn });
  const out = await c.initiatePayment({ msisdn: '255754123456', amountTzs: 60000, reference: 'pay_1.k1' });
  assert.deepEqual(out, { transactionId: 'TXN_1', network: 'Mpesa' });
  await c.initiatePayment({ msisdn: '255712345678', amountTzs: 1, reference: 'pay_2.k1', network: 'Azampesa' });
  assert.equal(f.tokens, 1);
  const tok = f.calls.find((x) => x.path === '/AppRegistration/GenerateToken');
  assert.equal(tok.host, 'authenticator-sandbox.azampay.co.tz');
  assert.deepEqual(tok.body, { appName: 'FitFlex', clientId: 'cid', clientSecret: 's' });
  const [first, second] = f.calls.filter((x) => x.path === '/azampay/mno/checkout');
  assert.equal(first.host, 'sandbox.azampay.co.tz');
  assert.deepEqual(first.body, { accountNumber: '255754123456', amount: '60000', currency: 'TZS', externalId: 'pay_1.k1', provider: 'Mpesa' });
  assert.equal(first.headers.Authorization, 'Bearer tok1');
  assert.equal(first.headers['X-API-Key'], 'ak');
  assert.equal(second.body.provider, 'Azampesa');
});

test('client: unknown network, a declined checkout and an unreachable AzamPay are errors', async () => {
  const c = createAzamPayClient({ settings: settings(), fetchFn: fakeAzamPay().fetchFn });
  await assert.rejects(c.initiatePayment({ msisdn: '255731234567', amountTzs: 1, reference: 'r' }), (e) => e.code === 'unknown_network');
  const declined = createAzamPayClient({ settings: settings(), fetchFn: fakeAzamPay({ onCheckout: (_b, reply) => reply(200, { success: false, message: 'Invalid', transactionId: null }) }).fetchFn });
  await assert.rejects(declined.initiatePayment({ msisdn: '255754123456', amountTzs: 1, reference: 'r' }), (e) => e instanceof AzamPayError && e.code === 'rejected');
  const down = createAzamPayClient({ settings: settings(), fetchFn: async () => { throw new Error('ECONNRESET'); } });
  await assert.rejects(down.initiatePayment({ msisdn: '255754123456', amountTzs: 1, reference: 'r' }), (e) => maybeSent(e));
  const five = createAzamPayClient({ settings: settings(), fetchFn: fakeAzamPay({ onCheckout: (_b, reply) => reply(503, {}) }).fetchFn });
  await assert.rejects(five.initiatePayment({ msisdn: '255754123456', amountTzs: 1, reference: 'r' }), (e) => maybeSent(e));
});

test('client: verifyCallback checks the signature with AzamPay\'s key, refetching once if the key rotated', async () => {
  const f = fakeAzamPay();
  const c = createAzamPayClient({ settings: settings(), fetchFn: f.fetchFn });
  assert.equal(await c.verifyCallback(callback()), true);
  assert.equal(await c.verifyCallback(callback()), true);
  assert.equal(f.keys, 1, 'key cached');
  assert.equal(await c.verifyCallback({ ...callback(), transactionstatus: 'failure' }), false);
  assert.equal(await c.verifyCallback(callback({ clientId: 'someone-else' })), false, 'not our app');
  // rotated: an old key cached, the new one fetched once
  const old = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' });
  const r = fakeAzamPay({ keyPem: (n) => (n === 1 ? old : PUB) });
  const rc = createAzamPayClient({ settings: settings(), fetchFn: r.fetchFn });
  assert.equal(await rc.verifyCallback(callback()), true);
  assert.equal(r.keys, 2);
  // configured callback credentials must match
  const strict = createAzamPayClient({ settings: settings({ callbackUser: 'u', callbackPassword: 'right' }), fetchFn: fakeAzamPay().fetchFn });
  assert.equal(await strict.verifyCallback(callback()), false);
  assert.equal(await strict.verifyCallback(callback({ password: 'right' })), true);
  // no key from AzamPay → nothing is believed
  const nokey = createAzamPayClient({ settings: settings(), fetchFn: fakeAzamPay({ keyPem: '' }).fetchFn });
  assert.equal(await nokey.verifyCallback(callback()), false);
});

test('client: clientId must be PRESENT and ours — a callback without it is refused, whatever its signature', async () => {
  const f = fakeAzamPay();
  const c = createAzamPayClient({ settings: settings(), fetchFn: f.fetchFn });
  const { clientId, ...without } = callback();
  void clientId;
  assert.equal(verifyCallbackSignature(without, PUB), true, 'the signature itself is good (clientId is not signed)');
  for (const body of [without, { ...without, clientId: null }, { ...without, clientId: '' }, { ...without, clientId: 'CID' }, { ...without, clientId: ['cid'] }]) {
    assert.equal(await c.verifyCallback(body), false, JSON.stringify(body.clientId));
  }
  assert.equal(f.calls.length, 0, 'refused before AzamPay is asked for anything');
  assert.equal(await c.verifyCallback({ ...without, clientId: 'cid' }), true);
});

test('client: an unverifiable body cannot make the server call AzamPay at will — no fetch without a signature and the signed fields; a forced key refetch at most once per window', async () => {
  let t = 1_800_000_000_000;
  const f = fakeAzamPay();
  const c = createAzamPayClient({ settings: settings(), fetchFn: f.fetchFn, now: () => t });
  // nothing to verify → nothing fetched (not even the key)
  for (const junk of [{ clientId: 'cid' }, { ...callback(), signature: '' }, { ...callback(), signature: '   ' }, { ...callback(), signature: 123 }, { ...callback(), utilityref: '' }, { ...callback(), transactionstatus: null }]) {
    assert.equal(callbackIsSigned(junk), false);
    assert.equal(await c.verifyCallback(junk), false);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(await c.verifyCallback(callback()), true);
  assert.equal(f.keys, 1);
  // forged bodies: the first one forces one refetch, the next ones in the window none
  const forged = () => ({ ...callback(), transactionstatus: 'failure' });
  for (let i = 0; i < 25; i += 1) assert.equal(await c.verifyCallback(forged()), false);
  assert.equal(f.keys, 2, 'one forced refetch, not twenty-five');
  assert.equal(await c.verifyCallback(callback()), true, 'genuine callbacks still verify meanwhile');
  t += KEY_REFETCH_MIN_MS - 1000;
  await c.verifyCallback(forged());
  assert.equal(f.keys, 2);
  t += 2000;
  await c.verifyCallback(forged());
  assert.equal(f.keys, 3, 'allowed again after the window');
});

test('client: the callback user and password are compared whole (constant time): a prefix, a longer or an empty value is refused', async () => {
  const strict = createAzamPayClient({ settings: settings({ callbackUser: 'azam-user', callbackPassword: 'right-secret' }), fetchFn: fakeAzamPay().fetchFn });
  const ok = { user: 'azam-user', password: 'right-secret' };
  assert.equal(await strict.verifyCallback(callback(ok)), true);
  for (const over of [{ password: 'right-secre' }, { password: 'right-secret ' }, { password: 'right-secretX' }, { password: '' }, { password: null }, { password: 'RIGHT-SECRET' }, { user: 'azam-use' }, { user: '' }, { user: 'someone-else' }]) {
    assert.equal(await strict.verifyCallback(callback({ ...ok, ...over })), false, JSON.stringify(over));
  }
});

test('client: payouts stay closed without AzamPay\'s disbursement key; with it the checksum is sent', async () => {
  const f = fakeAzamPay();
  const c = createAzamPayClient({ settings: settings(), fetchFn: f.fetchFn });
  assert.equal(c.payoutsConfigured(), false);
  await assert.rejects(c.disburse({ source: {}, destination: {}, amountTzs: 1000, externalReferenceId: 'po_1', checksumText: 'x' }), (e) => e.code === 'payouts_not_configured');
  const k = createAzamPayClient({ settings: settings({ disbursePublicKey: PUB }), fetchFn: f.fetchFn });
  await assert.rejects(k.disburse({ source: {}, destination: {}, amountTzs: 1000, externalReferenceId: 'x'.repeat(31), checksumText: 'x' }), (e) => e.code === 'invalid_reference');
  const out = await k.disburse({ source: { bankName: 'Azampesa' }, destination: { bankName: 'Mpesa', accountNumber: '255754123456' }, amountTzs: 1000, externalReferenceId: 'po_1', checksumText: 'po_1|1000' });
  assert.equal(out.pgReferenceId, 'pg1');
  const sent = f.calls.find((x) => x.path === '/api/v1/azampay/disburse');
  assert.equal(sent.host, 'api-disbursement-sandbox.azampay.co.tz');
  assert.equal(sent.body.transferDetails.amount, 1000);
  assert.ok(sent.body.checksum.length > 100);
});

// ── settling a request from AzamPay's verified callback ────────────────────

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
  };
}
const DAY = 86_400_000;

function world({ enabled = true, canSettle = true, subs, requests } = {}) {
  const subscriptions = memStore(subs ?? [{ id: 'sub_new', memberId: 'm1', type: 'platform_pass', tier: 'basic', status: 'payment_pending', startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * DAY).toISOString() }]);
  const paymentRequests = memStore(requests ?? [{ id: 'pay_1', memberId: 'm1', subscriptionId: 'sub_new', tier: 'basic', amountTzs: 60_000, status: 'pending', provider: 'admin_approved', reference: null, note: null, requestedAt: new Date().toISOString() }]);
  const audit = [];
  const auditLog = { async insertAsync(e) { audit.push(e); } };
  const adminPaymentService = createAdminPaymentService({ paymentRequests, subscriptions, users: memStore(), auditLog });
  const remote = { initiated: [], failInitiate: null };
  const clock = { t: 1_800_000_000_000 };
  // The AzamPay client's shape as the service sees it (no checkStatus: AzamPay has none).
  const client = {
    environment: 'sandbox',
    confirmsByCallback: true,
    parseCallback,
    async initiatePayment(args) {
      if (remote.failInitiate) throw new AzamPayError('no', { code: remote.failInitiate, status: remote.failInitiate === 'provider_error' ? 500 : 400 });
      remote.initiated.push(args);
      return { transactionId: `TXN_${remote.initiated.length}` };
    },
  };
  const service = createMobileMoneyService({
    paymentRequests, subscriptions, adminPaymentService, auditLog, client, provider: 'azampay',
    enabled: () => enabled, canSettle: () => canSettle, now: () => clock.t,
  });
  return { subscriptions, paymentRequests, audit, service, remote, clock };
}
const PAY = { memberId: 'm1', paymentRequestId: 'pay_1', phone: '0754123456' };

test('options name AzamPay; pay sends the request\'s own amount, our reference and the chosen wallet', async () => {
  const w = world();
  assert.deepEqual(w.service.options(), { enabled: true, provider: 'azampay', environment: 'sandbox', methods: ['mobile_money'] });
  assert.deepEqual(world({ canSettle: false }).service.options(), { enabled: false, provider: 'azampay', environment: null, methods: [] });
  const out = await w.service.pay({ ...PAY, network: 'Azampesa' });
  assert.equal(out.status, 202);
  const sent = w.remote.initiated[0];
  assert.deepEqual([sent.msisdn, sent.amountTzs, sent.network], ['255754123456', 60_000, 'Azampesa']);
  assert.match(sent.reference, /^pay_1\.[a-z0-9]+$/);
  const row = w.paymentRequests.rows[0];
  assert.deepEqual([row.provider, row.reference], ['azampay', 'TXN_1']);
  assert.equal(mobileMoneyInFlight(row, w.clock.t), true, 'an AzamPay prompt counts as in flight everywhere');
  assert.equal(w.audit.at(-1).actor, 'azampay');
});

test('a number whose network is unknown is refused before anything is claimed', async () => {
  const w = world();
  w.remote.failInitiate = 'unknown_network';
  assert.equal((await w.service.pay(PAY)).error, 'network_required');
  assert.deepEqual([w.paymentRequests.rows[0].provider, w.paymentRequests.rows[0].reference], ['admin_approved', null]);
});

test('success: the verified callback approves the request and activates the pass; repeats are harmless', async () => {
  const w = world();
  await w.service.pay(PAY);
  const out = await w.service.handleCallback(callback({ transid: 'TXN_1' }));
  assert.deepEqual([out.status, out.state], [200, 'completed']);
  const row = w.paymentRequests.rows[0];
  assert.deepEqual([row.status, row.reference, row.decidedBy], ['approved', 'TXN_1', 'azampay']);
  assert.equal(w.subscriptions.rows[0].status, 'active');
  assert.equal((await w.service.handleCallback(callback({ transid: 'TXN_1' }))).state, 'completed');
});

test('the transaction is matched whichever AzamPay id the checkout returned', async () => {
  const w = world();
  await w.service.pay(PAY); // request records TXN_1
  // the callback names TXN_1 as `reference`, with a different transid
  const out = await w.service.handleCallback(callback({ transid: 'MNO_99', reference: 'TXN_1' }));
  assert.equal(out.state, 'completed');
  assert.equal(w.paymentRequests.rows[0].reference, 'TXN_1');
});

test('the wrong amount, or an amount AzamPay does not report, is held for staff', async () => {
  for (const amount of ['1000', '']) {
    const w = world();
    await w.service.pay(PAY);
    const out = await w.service.handleCallback(callback({ transid: 'TXN_1', amount }));
    assert.equal(out.state, 'held');
    assert.equal(w.paymentRequests.rows[0].status, 'pending');
    assert.ok(w.audit.some((a) => a.action === 'payment_mobile_money_amount_mismatch'));
  }
});

test('a success for a different transaction than the one on the phone is held, not approved', async () => {
  const w = world();
  await w.service.pay(PAY);
  const out = await w.service.handleCallback(callback({ transid: 'OTHER', reference: 'OTHER2', externalreference: 'OTHER3' }));
  assert.deepEqual([out.state], ['held']);
  assert.equal(w.paymentRequests.rows[0].status, 'pending');
});

test('one transaction confirms one payment', async () => {
  const w = world({
    requests: [
      { id: 'pay_1', memberId: 'm1', subscriptionId: 'sub_new', tier: 'basic', amountTzs: 60_000, status: 'pending', provider: 'admin_approved', reference: null, note: null, requestedAt: new Date().toISOString() },
      { id: 'pay_old', memberId: 'm2', subscriptionId: 'sub_x', tier: 'basic', amountTzs: 60_000, status: 'approved', provider: 'azampay', reference: 'TXN_USED', note: null, requestedAt: new Date().toISOString() },
    ],
  });
  w.remote.failInitiate = 'unreachable'; // claim kept, no transaction id recorded
  await w.service.pay(PAY);
  const out = await w.service.handleCallback(callback({ transid: 'TXN_USED', reference: null, externalreference: null }));
  assert.equal(out.state, 'held');
  assert.equal(w.paymentRequests.rows[0].status, 'pending');
});

test('failure: the request is released so the member can try again', async () => {
  const w = world();
  await w.service.pay(PAY);
  const out = await w.service.handleCallback(callback({ transid: 'TXN_1', transactionstatus: 'failure' }));
  assert.equal(out.state, 'failed');
  assert.deepEqual([w.paymentRequests.rows[0].provider, w.paymentRequests.rows[0].reference], ['admin_approved', null]);
  assert.equal((await w.service.pay(PAY)).status, 202);
});

test('refresh before the callback keeps waiting (nothing to ask AzamPay); after it, completed', async () => {
  const w = world();
  await w.service.pay(PAY);
  assert.equal((await w.service.refresh({ memberId: 'm1', paymentRequestId: 'pay_1' })).state, 'in_progress');
  await w.service.handleCallback(callback({ transid: 'TXN_1' }));
  assert.equal((await w.service.refresh({ memberId: 'm1', paymentRequestId: 'pay_1' })).state, 'completed');
  assert.equal((await w.service.refresh({ memberId: 'someone', paymentRequestId: 'pay_1' })).error, 'not_found');
});

test('a callback for an unknown request is acknowledged; a malformed one is 400', async () => {
  const w = world();
  assert.deepEqual(await w.service.handleCallback(callback({ utilityref: 'pay_nope.k1' })), { status: 200, ok: true, ignored: 'unknown_reference' });
  assert.equal((await w.service.handleCallback({ transactionstatus: 'success' })).error, 'invalid_payload');
});

test('against the sandbox without opting in, a confirmed payment is held, not settled', async () => {
  const w = world();
  await w.service.pay(PAY);
  const held = createMobileMoneyService({
    paymentRequests: w.paymentRequests, subscriptions: w.subscriptions, auditLog: { async insertAsync() {} },
    adminPaymentService: null, client: { environment: 'sandbox', confirmsByCallback: true, parseCallback }, provider: 'azampay',
    enabled: () => true, canSettle: () => false, now: () => w.clock.t,
  });
  const out = await held.handleCallback(callback({ transid: 'TXN_1' }));
  assert.deepEqual([out.state], ['held']);
  assert.equal(w.paymentRequests.rows[0].status, 'pending');
});
