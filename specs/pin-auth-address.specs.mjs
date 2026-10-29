// PIN sign-in address handling (S2 hardening): the per-address limit counts X-Forwarded-For from the RIGHT by
// PUBLIC_DOCS_TRUSTED_PROXY_HOPS, so a client cannot dodge it by writing the left-most entry. Response shapes are
// unchanged. Callers sending X-FitFlex-Channel: web-checkin also get a lower per-address cap on sign-ins.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pinLogin, resetWebCheckinLoginLimits, WEB_CHECKIN_LOGIN_PER_MINUTE } from '../functions/pin-auth.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { clientAddress } from '../src/shared/client-address.mjs';

assert.match(String(process.env.DATABASE_URL_CI || ''), /fitflex_ci/, 'specs run against the CI database only');

const NAMES = ['IDENTITY_V2', 'V2_PIN_LOGIN', 'PIN_PEPPER', 'PUBLIC_DOCS_TRUSTED_PROXY_HOPS', 'PIN_FAILURES_PER_ADDRESS'];
const saved = Object.fromEntries(NAMES.map(n => [n, process.env[n]]));
const seen = new Set();
const randomPhone = () => `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

beforeEach(() => {
  Object.assign(process.env, { IDENTITY_V2: 'true', V2_PIN_LOGIN: 'true', PIN_PEPPER: 'address-spec-pepper' });
  delete process.env.PUBLIC_DOCS_TRUSTED_PROXY_HOPS;
  delete process.env.PIN_FAILURES_PER_ADDRESS;
  resetWebCheckinLoginLimits();
});
after(async () => {
  for (const n of NAMES) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
  if (seen.size) await db('AuthAttempt').whereIn('ip', [...seen]).del();
  await db.destroy();
});

function res() {
  return {
    statusCode: 200, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    set(k, v) { this.headers[k] = v; return this; },
  };
}
async function login({ xff, socket, headers = {} }) {
  const out = res();
  const req = { headers: { ...(xff ? { 'x-forwarded-for': xff } : {}), ...headers }, body: { phone: randomPhone(), pin: '4821' }, socket: socket ? { remoteAddress: socket } : undefined };
  await pinLogin.onRequest(req, out);
  return out;
}
const attemptsFrom = async ip => { seen.add(ip); return (await db('AuthAttempt').where({ ip })).length; };
const uniqueIp = () => `10.201.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

test('clientAddress counts from the right by hops (default 1) and ignores the spoofable left-most entry', () => {
  const req = (xff, socket = '127.0.0.9') => ({ headers: { 'x-forwarded-for': xff }, socket: { remoteAddress: socket } });
  assert.equal(clientAddress(req('6.6.6.6, 10.0.0.1')), '10.0.0.1');
  assert.equal(clientAddress(req('1.1.1.1, 2.2.2.2, 3.3.3.3')), '3.3.3.3');
  process.env.PUBLIC_DOCS_TRUSTED_PROXY_HOPS = '2';
  assert.equal(clientAddress(req('1.1.1.1, 2.2.2.2, 3.3.3.3')), '2.2.2.2');
  assert.equal(clientAddress(req('3.3.3.3')), '3.3.3.3', 'a chain shorter than the hops uses its first entry');
  process.env.PUBLIC_DOCS_TRUSTED_PROXY_HOPS = '0';
  assert.equal(clientAddress(req('1.1.1.1, 2.2.2.2')), '127.0.0.9', 'no trusted proxy: the socket address');
  delete process.env.PUBLIC_DOCS_TRUSTED_PROXY_HOPS;
  assert.equal(clientAddress({ headers: {}, socket: { remoteAddress: '127.0.0.9' } }), '127.0.0.9');
});

test('sign-in records the proxy-appended address, not the client-written first entry', async () => {
  const real = uniqueIp(); const spoof = uniqueIp();
  const out = await login({ xff: `${spoof}, ${real}` });
  assert.equal(out.statusCode, 401);
  assert.equal(await attemptsFrom(real), 1);
  assert.equal(await attemptsFrom(spoof), 0, 'the spoofed entry is never used');
});

test('the failure lockout per address cannot be dodged by varying the left-most entry', async () => {
  process.env.PIN_FAILURES_PER_ADDRESS = '3';
  const real = uniqueIp();
  for (let i = 0; i < 3; i += 1) assert.equal((await login({ xff: `${uniqueIp()}, ${real}` })).statusCode, 401);
  const blocked = await login({ xff: `${uniqueIp()}, ${real}` });
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.body.error, 'too_many_attempts');
  assert.ok(Number.isFinite(blocked.body.retryAfterSeconds));
  await attemptsFrom(real);
});

test('response shapes are unchanged: unknown credentials 401 with the same body, flag off 404', async () => {
  const out = await login({ xff: uniqueIp() });
  assert.equal(out.statusCode, 401);
  assert.ok(typeof out.body.error === 'string');
  process.env.V2_PIN_LOGIN = 'false';
  const off = await login({ xff: uniqueIp() });
  assert.equal(off.statusCode, 404);
  assert.deepEqual(off.body, { error: 'not_found' });
});

test('X-FitFlex-Channel: web-checkin gets a lower per-address cap; ordinary callers do not', async () => {
  const web = uniqueIp();
  const h = { 'x-fitflex-channel': 'web-checkin' };
  for (let i = 0; i < WEB_CHECKIN_LOGIN_PER_MINUTE; i += 1) assert.equal((await login({ xff: web, headers: h })).statusCode, 401);
  const over = await login({ xff: web, headers: h });
  assert.equal(over.statusCode, 429);
  assert.equal(over.body.error, 'rate_limited');
  assert.ok(over.headers['Retry-After']);
  // Same address without the header is not capped by this limiter; another address with it is fine.
  assert.equal((await login({ xff: web })).statusCode, 401);
  assert.equal((await login({ xff: uniqueIp(), headers: h })).statusCode, 401);
  await attemptsFrom(web);
});
