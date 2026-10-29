// Marathon & running events · S5 — organizer API authentication (spec §5.2). OWNER REVIEW (D35): the token exchange, the one-answer rule,
// brute-force controls, token isolation in both directions, row-level revocation / scope / suspension, rate limits.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { ensureInit } from '../functions/index.mjs';
import { apiToken, apiListEvents, apiListRegistrations, apiCollectKit } from '../functions/events-organizer-api.mjs';
import { organizerListApiClients, organizerRevokeApiClient, resetEventsIntegrationsLimits } from '../functions/events-integrations.mjs';
import { organizerListRegistrations } from '../functions/events-organizer.mjs';
import { harness, s5On, s5Off, db } from './fixtures/events-s5.mjs';
import { sign, signPurpose, verify, verifyPurpose, requireAuth } from '../src/auth/jwt.mjs';
import { resetApiAuthLimits, API_PURPOSE } from '../src/auth/organizer-api-auth.mjs';

await ensureInit();
const h = harness();
const { call } = h;
afterEach(() => { resetApiAuthLimits(); resetEventsIntegrationsLimits(); s5Off(); });
after(async () => { await h.cleanup(); await db.destroy(); });

const exchange = (body, { headers = {}, ip = '10.8.0.1' } = {}) => call(apiToken, null, { body, headers, ip });
const creds = c => ({ grant_type: 'client_credentials', client_id: c.client.clientId, client_secret: c.secret });
const bearer = t => ({ authorization: `Bearer ${t}` });

test('exchange: 200 { access_token, token_type, expires_in: 900 } no-store; the token is a purpose token with ONLY sub, cid, sv (no scopes, no organizer)', async () => {
  s5On();
  const o = await h.org();
  const c = await h.apiClient(o, { scopes: ['registrations:read', 'kit:write'] });
  const r = await exchange(creds(c));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.token_type, r.body.expires_in, Object.keys(r.body).sort()], ['Bearer', 900, ['access_token', 'expires_in', 'token_type']]);
  const claims = verifyPurpose(r.body.access_token, API_PURPOSE);
  assert.ok(claims);
  assert.deepEqual([claims.sub, claims.cid, claims.sv, claims.purpose], [c.client.id, c.client.clientId, 1, 'organizer_api']);
  assert.ok(!('scopes' in claims) && !('organizerId' in claims) && !('userType' in claims));
  assert.ok(claims.exp - claims.iat === 900);
  // Basic auth works too
  const basic = await exchange({ grant_type: 'client_credentials' }, { headers: { authorization: `Basic ${Buffer.from(`${c.client.clientId}:${c.secret}`).toString('base64')}` } });
  assert.equal(basic.status, 200);
  // the response and the headers: no-store
  const res = { headers: {}, statusCode: 200, status(c2) { this.statusCode = c2; return this; }, json(b) { this.body = b; return this; }, set(k, v) { this.headers[k] = v; return this; } };
  await apiToken.onRequest({ method: 'POST', headers: {}, body: creds(c), ip: '10.8.9.9' }, res);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  // a bad grant_type is a request error (400), not a credential verdict
  assert.deepEqual([(await exchange({ ...creds(c), grant_type: 'password' })).status, (await exchange({ client_id: c.client.clientId, client_secret: c.secret })).body.error], [400, 'invalid_request']);
  // the last-used stamp follows a call, not an exchange
  assert.equal((await call(apiListEvents, null, { headers: bearer(r.body.access_token) })).status, 200);
  assert.ok((await db('ApiClient').where({ id: c.client.id }).first()).lastUsedAt);
});

test('THE ONE-ANSWER RULE: unknown id, wrong secret, revoked, expired, malformed and empty credentials are byte-identical 401 invalid_client', async () => {
  s5On();
  const o = await h.org();
  const live = await h.apiClient(o, {});
  const revoked = await h.apiClient(o, {});
  await call(organizerRevokeApiClient, o.owner, { params: { id: revoked.client.id }, body: {} });
  const expired = await h.apiClient(o, {});
  await db('ApiClient').where({ id: expired.client.id }).update({ expiresAt: new Date(Date.now() - 1000) });
  const attempts = [
    { ...creds(live), client_id: 'ffc_0000000000000000' },
    { ...creds(live), client_secret: `ffs_live_${'A'.repeat(43)}` },
    creds(revoked), creds(expired),
    { grant_type: 'client_credentials', client_id: 'nonsense', client_secret: 'nonsense' },
    { grant_type: 'client_credentials', client_id: '', client_secret: '' },
    { grant_type: 'client_credentials', client_id: live.client.clientId },
    { grant_type: 'client_credentials', client_id: { $ne: null }, client_secret: { $ne: null } },
    { grant_type: 'client_credentials', client_id: live.client.clientId, client_secret: 'x'.repeat(5000) },
  ];
  const answers = [];
  for (const [i, a] of attempts.entries()) answers.push(await exchange(a, { ip: `10.7.0.${i + 1}` }));
  for (const a of answers) assert.deepEqual([a.status, a.body], [401, { error: 'invalid_client' }]);
  // the real reason is in the audit log, never in the answer
  const reasons = (await db('AuditLog').where({ action: 'events.api_token_failed' }).whereIn('target', [live.client.id, revoked.client.id, expired.client.id])).map(r => r.after.reason).sort();
  assert.deepEqual(reasons, ['expired', 'revoked', 'wrong_secret']);
  assert.ok(!JSON.stringify(await db('AuditLog').where({ action: 'events.api_token_failed' }).select('*')).includes(live.secret));
});

test('a caller holding the RIGHT secret is told why: suspended organizer 403, organizer not enabled 403; nobody else learns it', async () => {
  s5On();
  const o = await h.org();
  const c = await h.apiClient(o, {});
  await db('EventOrganizer').where({ id: o.id }).update({ status: 'suspended', statusReason: 'spec' });
  assert.deepEqual([(await exchange(creds(c))).status, (await exchange(creds(c))).body], [403, { error: 'organizer_suspended' }]);
  assert.deepEqual((await exchange({ ...creds(c), client_secret: `ffs_live_${'B'.repeat(43)}` }, { ip: '10.7.1.1' })).body, { error: 'invalid_client' }, 'a wrong secret never learns the organizer is suspended');
  await db('EventOrganizer').where({ id: o.id }).update({ status: 'active', statusReason: null, apiAccessEnabledAt: null });
  assert.deepEqual((await exchange(creds(c), { ip: '10.7.1.2' })).body, { error: 'api_access_not_enabled' });
});

test('failures only: 10 wrong secrets a minute per client_id and 20 per source address → 429 + Retry-After (also for ids that do not exist); the RIGHT secret is never blocked; NO lock-out; heavy failure is reported (audit + owner notice), not enforced', async () => {
  s5On();
  const o = await h.org();
  const c = await h.apiClient(o, {});
  const wrong = { ...creds(c), client_secret: `ffs_live_${'C'.repeat(43)}` };
  for (let i = 0; i < 10; i += 1) assert.equal((await exchange(wrong, { ip: `10.6.0.${i}` })).status, 401);
  const limited = await exchange(wrong, { ip: '10.6.1.1' });
  assert.deepEqual([limited.status, limited.body.error], [429, 'rate_limited']);
  assert.ok(limited.body.retryAfterSeconds >= 1);
  // the right secret still passes while wrong ones are being limited (valid credentials are not counted)
  assert.equal((await exchange(creds(c), { ip: '10.6.1.2' })).status, 200);
  // an unknown id is limited the same way (no oracle)
  const ghost = { grant_type: 'client_credentials', client_id: 'ffc_aaaaaaaaaaaaaaaa', client_secret: wrong.client_secret };
  for (let i = 0; i < 10; i += 1) assert.equal((await exchange(ghost, { ip: `10.6.2.${i}` })).status, 401);
  assert.equal((await exchange(ghost, { ip: '10.6.3.1' })).status, 429);
  // NO LOCK: 25 failures spread over time never lock the client; the right secret works throughout; the columns are untouched
  resetApiAuthLimits();
  for (let batch = 0; batch < 3; batch += 1) { for (let i = 0; i < 9; i += 1) await exchange(wrong, { ip: `10.5.${batch}.${i}` }); resetApiAuthLimits(); }
  const row = await db('ApiClient').where({ id: c.client.id }).first();
  assert.deepEqual([row.failedAttempts, row.lockedUntil], [0, null], 'nothing is counted against the client row');
  assert.equal((await exchange(creds(c), { ip: '10.5.9.9' })).status, 200);
  // reporting: more than 20 failures within an hour → ONE audit row and ONE owner notice, no blocking
  assert.equal((await db('AuditLog').where({ action: 'events.api_token_failures_high', target: c.client.id })).length, 1);
  const note = await db('Notification').where({ userId: o.ownerUserId, type: 'organizer_api_client_failures' });
  assert.equal(note.length, 1);
  assert.ok(note[0].data.titleSw && !note[0].data.bodySw.includes('kushindwa'));
  assert.equal((await db('Notification').where({ type: 'organizer_api_client_locked' })).length, 0, 'there is no lock notice any more');
  // per source address: only FAILURES count — 30 valid exchanges from one address are all fine, then wrong ones are limited
  resetApiAuthLimits();
  for (let i = 0; i < 30; i += 1) assert.equal((await exchange(creds(c), { ip: '10.4.0.1' })).status, 200);
  for (let i = 0; i < 20; i += 1) assert.equal((await exchange({ grant_type: 'client_credentials', client_id: `ffc_${String(i).padStart(16, '0')}`, client_secret: 'x' }, { ip: '10.4.0.1' })).status, 401);
  assert.equal((await exchange({ grant_type: 'client_credentials', client_id: 'ffc_9999999999999999', client_secret: 'x' }, { ip: '10.4.0.1' })).status, 429);
  assert.equal((await exchange(creds(c), { ip: '10.4.0.1' })).status, 200, 'a shared / unknown address cannot lock out valid callers');
});

test('TOKEN ISOLATION, both directions: a staff JWT on /v1 is 401 invalid_token; an API token on /organizer/* is 401 unauthenticated; a session is not an API token; other purposes and forged tokens are refused', async () => {
  s5On();
  const f = await h.kitEvent({ n: 1 });
  const c = await h.apiClient(f.organizer, { scopes: ['registrations:read'] });
  const apiToken_ = await c.token();
  // staff JWT on /v1
  for (const claims of [f.organizer.owner, f.organizer.ops]) assert.deepEqual((await call(apiListEvents, null, { headers: bearer(sign(claims)) })).body, { error: 'invalid_token' });
  assert.deepEqual([(await call(apiListEvents, null, { headers: bearer(sign(f.organizer.owner)) })).status], [401]);
  // API token on a JWT route and through requireAuth directly
  const r = await call(organizerListRegistrations, null, { params: { id: f.event.id }, headers: bearer(apiToken_) });
  assert.deepEqual([r.status, r.body], [401, { error: 'unauthenticated' }]);
  assert.equal((await call(organizerListApiClients, null, { headers: bearer(apiToken_) })).status, 401);
  const res = { statusCode: 200, status(c2) { this.statusCode = c2; return this; }, json(b) { this.body = b; return this; } };
  let passed = false;
  await requireAuth()({ headers: bearer(apiToken_) }, res, () => { passed = true; });
  assert.equal(passed, false);
  assert.equal(verify(apiToken_).purpose, 'organizer_api');
  // other purposes, no header, a bare scheme, tampering, alg none
  const other = signPurpose('pin_reset', { sub: c.client.id, cid: c.client.clientId, sv: 1 });
  const tampered = `${apiToken_.slice(0, -3)}${apiToken_.endsWith('AAA') ? 'BBB' : 'AAA'}`;
  const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: c.client.id, cid: c.client.clientId, sv: 1, purpose: 'organizer_api' })).toString('base64url')}.`;
  const foreign = jwt.sign({ sub: c.client.id, cid: c.client.clientId, sv: 1, purpose: 'organizer_api' }, 'some-other-secret', { issuer: 'fitflex', expiresIn: '5m' });
  for (const t of [other, tampered, none, foreign, 'garbage', '']) assert.equal((await call(apiListEvents, null, { headers: t ? bearer(t) : {} })).status, 401, t.slice(0, 12));
  assert.equal((await call(apiListEvents, null, { headers: { authorization: 'Token abc' } })).status, 401);
  // an expired API token says so
  const expired = jwt.sign({ sub: c.client.id, cid: c.client.clientId, sv: 1, purpose: 'organizer_api' }, process.env.JWT_SECRET || 'fitflex-dev-secret-change-me', { issuer: 'fitflex', expiresIn: -10 });
  assert.deepEqual((await call(apiListEvents, null, { headers: bearer(expired) })).body, { error: 'token_expired' });
  // a token of client X with the cid of client Y
  const d = await h.apiClient(f.organizer, {});
  const mismatched = signPurpose(API_PURPOSE, { sub: c.client.id, cid: d.client.clientId, sv: 1 }, '5m');
  assert.equal((await call(apiListEvents, null, { headers: bearer(mismatched) })).status, 401);
});

test('the ROW decides on every call: revoke, expiry, organizer suspension, scope change and a secret rotation take effect on the very next request with the same unexpired token', async () => {
  s5On();
  const f = await h.kitEvent({ n: 1 });
  const c = await h.apiClient(f.organizer, { scopes: ['registrations:read'] });
  const t = bearer(await c.token());
  const list = () => call(apiListRegistrations, null, { params: { eventId: f.event.id }, headers: t });
  assert.equal((await list()).status, 200);
  // scope: no kit:write → 403 with the scope name; granting it (row change) opens it at once
  const kit = () => call(apiCollectKit, null, { params: { eventId: f.event.id }, headers: { ...t, 'idempotency-key': 'scope-check-1' }, body: { method: 'scan', payload: f.regs[0].payload, collectionPointId: f.points[0].id } });
  assert.deepEqual([(await kit()).status, (await kit()).body], [403, { error: 'insufficient_scope', requiredScope: 'kit:write' }]);
  await db('ApiClient').where({ id: c.client.id }).update({ scopes: JSON.stringify(['registrations:read', 'kit:write']) });
  assert.equal((await kit()).status, 201);
  await db('ApiClient').where({ id: c.client.id }).update({ scopes: JSON.stringify(['kit:write']) });
  assert.deepEqual((await list()).body, { error: 'insufficient_scope', requiredScope: 'registrations:read' });
  await db('ApiClient').where({ id: c.client.id }).update({ scopes: JSON.stringify(['registrations:read']) });
  // suspension and un-suspension of the organizer
  await db('EventOrganizer').where({ id: f.organizer.id }).update({ status: 'suspended', statusReason: 'spec' });
  assert.deepEqual([(await list()).status, (await list()).body.error], [403, 'organizer_suspended']);
  await db('EventOrganizer').where({ id: f.organizer.id }).update({ status: 'active', statusReason: null });
  assert.equal((await list()).status, 200);
  // expiry
  await db('ApiClient').where({ id: c.client.id }).update({ expiresAt: new Date(Date.now() - 1000) });
  assert.deepEqual([(await list()).status, (await list()).body.error], [403, 'client_expired']);
  await db('ApiClient').where({ id: c.client.id }).update({ expiresAt: new Date(Date.now() + 86_400_000) });
  assert.equal((await list()).status, 200);
  // rotation WITHOUT grace kills tokens minted from the old secret (the token carries the secret version)
  await db('ApiClient').where({ id: c.client.id }).update({ secretVersion: 2 });
  assert.deepEqual([(await list()).status, (await list()).body.error], [401, 'invalid_token']);
  // WITH grace: sv-1 is accepted until the window closes
  await db('ApiClient').where({ id: c.client.id }).update({ previousSecretHash: 'a'.repeat(64), previousSecretExpiresAt: new Date(Date.now() + 3_600_000) });
  assert.equal((await list()).status, 200);
  await db('ApiClient').where({ id: c.client.id }).update({ previousSecretExpiresAt: new Date(Date.now() - 1000) });
  assert.equal((await list()).status, 401);
});

test('per-client rate limit: 429 with Retry-After, retryAfterSeconds and X-RateLimit headers; the budget is per client; X-Request-Id on every response', async () => {
  s5On();
  const f = await h.kitEvent({ n: 0 });
  const c = await h.apiClient(f.organizer, {});
  const other = await h.apiClient(f.organizer, {});
  await db('ApiClient').where({ id: c.client.id }).update({ rateLimitPerMinute: 3 });
  const t = bearer(await c.token());
  const send = async () => {
    const res = { headers: {}, statusCode: 200, status(x) { this.statusCode = x; return this; }, json(b) { this.body = b; return this; }, set(k, v) { this.headers[k] = v; return this; } };
    const req = { method: 'GET', headers: { ...t, 'x-request-id': 'caller-req-1234' }, params: {}, query: {}, body: {}, ip: '10.1.1.1', get: () => null };
    for (const g of [apiListEvents.onGuard].flat()) { let ok = false; await g(req, res, () => { ok = true; }); if (!ok) return res; }
    await apiListEvents.onRequest(req, res);
    return res;
  };
  const ok = [await send(), await send(), await send()];
  assert.ok(ok.every(r => r.statusCode === 200));
  assert.deepEqual([ok[0].headers['X-RateLimit-Limit'], ok[0].headers['X-RateLimit-Remaining'], ok[2].headers['X-RateLimit-Remaining']], ['3', '2', '0']);
  assert.equal(ok[0].headers['X-Request-Id'], 'caller-req-1234', 'a safe caller id is echoed');
  const limited = await send();
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.body.error, 'rate_limited');
  assert.ok(limited.body.retryAfterSeconds >= 1 && Number(limited.headers['Retry-After']) >= 1);
  assert.equal((await call(apiListEvents, null, { headers: bearer(await other.token()) })).status, 200, 'another client is unaffected');
  await new Promise(r => setTimeout(r, 30));
  const day = await db('ApiClientUsageDay').where({ apiClientId: c.client.id }).first();
  assert.ok(day.requests >= 4 && day.rateLimited >= 1);
  const gen = await call(apiListEvents, null, { headers: bearer(await other.token()) });
  assert.ok(gen.status === 200);
});

test('NOTHING is logged: across creation, exchange, failures, calls, errors and rotation the console never sees a client secret, an access token or a request body', async () => {
  s5On();
  const f = await h.kitEvent({ n: 1 });
  const captured = [];
  const originals = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) { originals[level] = console[level]; console[level] = (...args) => { captured.push(args.map(a => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); }; }
  let secrets;
  try {
    const c = await h.apiClient(f.organizer, { scopes: ['registrations:read', 'kit:write'] });
    const bad = { ...creds(c), client_secret: `ffs_live_${'Z'.repeat(43)}` };
    await exchange(bad, { ip: '10.9.1.1' });
    await exchange({ grant_type: 'client_credentials', client_id: { x: 1 }, client_secret: [1] }, { ip: '10.9.1.2' });
    const t = await c.token();
    await call(apiListRegistrations, null, { params: { eventId: f.event.id }, headers: bearer(t) });
    await call(apiCollectKit, null, { params: { eventId: f.event.id }, headers: { ...bearer(t), 'idempotency-key': 'nolog-key-0001' }, body: { method: 'scan', payload: f.regs[0].payload, collectionPointId: f.points[0].id } });
    await call(apiListEvents, null, { headers: bearer('not.a.token') });
    // a handler that throws
    const res = { statusCode: 200, status(x) { this.statusCode = x; return this; }, json(b) { this.body = b; return this; }, set() { return this; } };
    const req = { method: 'GET', headers: bearer(t), params: {}, query: { limit: { toString() { throw new Error('boom'); } } }, body: {}, ip: '10.9.1.3', get: () => null };
    for (const g of [apiListEvents.onGuard].flat()) await g(req, res, () => {});
    await apiListEvents.onRequest(req, res);
    secrets = [c.secret, bad.client_secret, t, f.regs[0].payload, f.regs[0].token];
  } finally { Object.assign(console, originals); }
  const text = captured.join('\n');
  for (const secret of secrets) assert.ok(!text.includes(secret), `a secret reached the console: ${secret.slice(0, 14)}…`);
});
