// Browser gym QR check-in (S2) against the CI database: dormant behind WEB_QR_CHECKIN, fail-closed without
// QR_HMAC_SECRET, signing in alone and previewing record nothing, a confirmed intent records exactly one
// web_gym_qr_by_member visit under the in-app scan's rules, races and repeats are idempotent.
import { test, after, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { gyms, users, subscriptions, checkins, platformSettings } from '../src/bootstrap/collections.mjs';
import { settingsService, gymService, trainerService, moderationGate, partnerGate } from '../src/bootstrap/services.mjs';
import { sign, signPurpose } from '../src/auth/jwt.mjs';
import { issueGymQr } from '../src/auth/qr-token.mjs';
import { createCheckInService } from '../src/services/check-in-service.mjs';
import { createWebGymProfileService } from '../src/services/web-gym-profile-service.mjs';
import { createWebCheckinService } from '../src/services/web-checkin-service.mjs';
import { signIntent } from '../src/shared/web-checkin-intent.mjs';
import { publicRefFor } from '../src/services/web-gym-profile-service.mjs';
import { myQr } from '../functions/checkins.mjs';
import {
  webCheckinIntent, webCheckinSession, webCheckinPreview, webCheckinConfirm, resetWebCheckinLimits,
  WEB_CHECKIN_INTENT_RATE_PER_MINUTE,
} from '../functions/web-checkin.mjs';

assert.match(String(process.env.DATABASE_URL_CI || ''), /fitflex_ci/, 'specs run against the CI database only');

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const now = () => new Date().toISOString();
const made = { gyms: [], users: [] };
const envBefore = Object.fromEntries(['WEB_QR_CHECKIN', 'QR_HMAC_SECRET', 'PUBLIC_DOCS_TRUSTED_PROXY_HOPS'].map(k => [k, process.env[k]]));
let tiersBefore;

before(async () => {
  tiersBefore = settingsService.adminGet().subscriptionTiers.map(t => ({ ...t }));
  await platformSettings.updateAsync(s => s.id === 'platform', {
    subscriptionTiers: [
      { key: 'basic', label: 'Basic', monthlyPrice: 60_000, visits: 1, gymAccess: 'standard' },
      { key: 'pro', label: 'Pro', monthlyPrice: 120_000, visits: 30, gymAccess: 'midtier' },
    ],
  });
});
beforeEach(() => {
  process.env.WEB_QR_CHECKIN = '1';
  process.env.QR_HMAC_SECRET = 'flow-spec-secret';
  delete process.env.PUBLIC_DOCS_TRUSTED_PROXY_HOPS;
  resetWebCheckinLimits();
});
after(async () => {
  await platformSettings.updateAsync(s => s.id === 'platform', { subscriptionTiers: tiersBefore });
  for (const [k, v] of Object.entries(envBefore)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  if (made.users.length) await db('User').whereIn('id', made.users).del();   // cascades check-ins and subscriptions
  for (const id of made.users) await users.removeAsync(u => u.id === id);
  await db('ModerationState').whereIn('entityId', made.gyms).del();
  for (const id of made.gyms) await gyms.removeAsync(g => g.id === id);
  if (made.gyms.length) await db('Gym').whereIn('id', made.gyms).del();
  await db.destroy();
});

async function makeGym(extra = {}) {
  await gyms.ready;
  const id = uid('gym');
  await gyms.insertAsync({
    id, name: `Web Checkin Gym ${id.slice(-4)}`, tier: 'midtier', location: 'Masaki', status: 'active', venueType: 'physical',
    accessMode: 'paid_visit', homepageVisible: true, ratePerDay: 8000, createdAt: now(), updatedAt: now(), ...extra,
  });
  made.gyms.push(id);
  return id;
}
async function makeUser(userType = 'member', extra = {}) {
  const id = uid('usr');
  await users.insertAsync({ id, userType, displayName: `Web Checkin ${userType}`, accountStatus: 'active', createdAt: now(), updatedAt: now(), ...extra });
  made.users.push(id);
  return id;
}
async function makePass(memberId, { tier = 'pro', status = 'active', type = 'platform_pass' } = {}) {
  const id = uid('sub');
  const start = new Date(Date.now() - 10 * 86_400_000).toISOString();
  await subscriptions.insertAsync({ id, memberId, type, tier, status, startedAt: start, cycleStartedAt: start, renewsAt: new Date(Date.now() + 20 * 86_400_000).toISOString(), expiresAt: new Date(Date.now() + 20 * 86_400_000).toISOString() });
  return id;
}
const rowsFor = memberId => db('Checkin').where({ memberId });
const bearer = (id, userType = 'member') => sign({ sub: id, userType });

function res() {
  return {
    statusCode: 200, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    set(k, v) { this.headers[k] = v; return this; },
  };
}
async function run(route, { token = null, body = {}, ip = '203.0.113.7', headers = {} } = {}) {
  const req = { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-forwarded-for': ip, 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/126.0 Mobile Safari/537.36', ...headers }, body, params: {}, query: {} };
  const out = res();
  let passed = !route.onGuard;
  if (route.onGuard) await route.onGuard(req, out, () => { passed = true; });
  if (passed) await route.onRequest(req, out);
  return out;
}
async function intentFor(gymId) {
  const out = await run(webCheckinIntent, { body: { q: issueGymQr(gymId) } });
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  return out.body.intentToken;
}
const confirmBody = (intentToken, extra = {}) => ({ intentToken, confirm: true, idempotencyKey: uid('key'), ...extra });

test('flag off: every new route is a 404 not_found, with or without a valid QR or session', async () => {
  const gymId = await makeGym();
  const memberId = await makeUser();
  delete process.env.WEB_QR_CHECKIN;
  const token = bearer(memberId);
  for (const [route, body] of [[webCheckinIntent, { q: issueGymQr(gymId) }], [webCheckinSession, {}], [webCheckinPreview, { intentToken: 'x' }], [webCheckinConfirm, confirmBody('x')]]) {
    for (const t of [null, token]) {
      const out = await run(route, { token: t, body });
      assert.equal(out.statusCode, 404, route.path);
      assert.deepEqual(out.body, { error: 'not_found' });
      assert.equal(out.headers['Cache-Control'], 'no-store');
    }
  }
  assert.equal((await rowsFor(memberId)).length, 0);
});

test('fail closed: flag on but QR_HMAC_SECRET unset is a 404 on every route', async () => {
  const gymId = await makeGym();
  const memberId = await makeUser();
  const q = issueGymQr(gymId);
  delete process.env.QR_HMAC_SECRET;
  for (const [route, body] of [[webCheckinIntent, { q }], [webCheckinSession, {}], [webCheckinPreview, { intentToken: 'x' }], [webCheckinConfirm, confirmBody('x')]]) {
    const out = await run(route, { token: bearer(memberId), body });
    assert.equal(out.statusCode, 404, route.path);
  }
});

test('intent: public, opaque (no gym id anywhere), no-store + Vary, one 404 for every miss, rate limited', async () => {
  const gymId = await makeGym();
  const out = await run(webCheckinIntent, { body: { q: `https://portal.example.test/g/?q=${encodeURIComponent(issueGymQr(gymId))}` } });
  assert.equal(out.statusCode, 200);
  assert.deepEqual(Object.keys(out.body).sort(), ['expiresAt', 'gym', 'intentToken']);
  assert.deepEqual(out.body.gym, { publicRef: publicRefFor(gymId), name: out.body.gym.name });
  const payload = Buffer.from(out.body.intentToken.split('.')[0], 'base64url').toString();
  assert.ok(!JSON.stringify(out.body).includes(gymId) && !payload.includes(gymId), 'the gym id never leaves the server');
  assert.equal(out.headers['Cache-Control'], 'no-store');
  assert.equal(out.headers.Vary, 'Origin');
  assert.ok(new Date(out.body.expiresAt) > new Date());

  const misses = [{ q: 'fitflex:gym:nope:sig' }, { q: issueGymQr('gym_does_not_exist') }, { q: 42 }, {}, { q: `${issueGymQr(gymId)}x` }];
  const inactive = await makeGym({ status: 'inactive' });
  const unlisted = await makeGym({ homepageVisible: false });
  misses.push({ q: issueGymQr(inactive) }, { q: issueGymQr(unlisted) });
  for (const body of misses) {
    const miss = await run(webCheckinIntent, { body });
    assert.equal(miss.statusCode, 404);
    assert.deepEqual(miss.body, { error: 'not_found' });
  }
  resetWebCheckinLimits();
  for (let i = 0; i < WEB_CHECKIN_INTENT_RATE_PER_MINUTE; i += 1) assert.equal((await run(webCheckinIntent, { body: { q: issueGymQr(gymId) }, ip: '198.51.100.9' })).statusCode, 200);
  assert.equal((await run(webCheckinIntent, { body: { q: issueGymQr(gymId) }, ip: '198.51.100.9' })).statusCode, 429);
});

test('authentication alone creates no visit: sign-in token, session mint and preview write nothing', async () => {
  const gymId = await makeGym();
  const memberId = await makeUser();
  await makePass(memberId);
  const intentToken = await intentFor(gymId);
  const session = await run(webCheckinSession, { token: bearer(memberId) });
  assert.equal(session.statusCode, 200);
  assert.equal((await rowsFor(memberId)).length, 0, 'minting the web session records nothing');
  const preview = await run(webCheckinPreview, { token: session.body.token, body: { intentToken } });
  assert.equal(preview.statusCode, 200);
  assert.deepEqual(preview.body, { eligible: true, alreadyCheckedIn: false, gym: { name: preview.body.gym.name }, visitsLeft: 30 });
  assert.equal((await rowsFor(memberId)).length, 0, 'preview consumes nothing');
  const again = await run(webCheckinPreview, { token: session.body.token, body: { intentToken } });
  assert.equal(again.body.visitsLeft, 30);
});

test('session token: works on the two web check-in routes only, member/trainer only, 15 minutes, never a general session', async () => {
  const memberId = await makeUser();
  const gymId = await makeGym();
  await makePass(memberId);
  const intentToken = await intentFor(gymId);
  const session = await run(webCheckinSession, { token: bearer(memberId) });
  assert.deepEqual(Object.keys(session.body).sort(), ['expiresAt', 'token']);
  const ttl = new Date(session.body.expiresAt) - Date.now();
  assert.ok(ttl > 14 * 60_000 && ttl <= 15 * 60_000 + 1000);
  // Not a session anywhere else, including minting another one and the member QR.
  assert.equal((await run(webCheckinSession, { token: session.body.token })).statusCode, 401);
  assert.equal((await run(myQr, { token: session.body.token })).statusCode, 401);
  // A different purpose token is not accepted either.
  const other = signPurpose('pin_reset', { sub: memberId, userType: 'member' }, '15m');
  assert.equal((await run(webCheckinPreview, { token: other, body: { intentToken } })).statusCode, 401);
  // No token at all.
  assert.equal((await run(webCheckinPreview, { body: { intentToken } })).statusCode, 401);
  assert.equal((await run(webCheckinConfirm, { body: confirmBody(intentToken) })).statusCode, 401);
  // Valid on both routes.
  assert.equal((await run(webCheckinPreview, { token: session.body.token, body: { intentToken } })).statusCode, 200);
  assert.equal((await run(webCheckinConfirm, { token: session.body.token, body: confirmBody(intentToken) })).statusCode, 200);
  // A normal session also works here.
  assert.equal((await run(webCheckinPreview, { token: bearer(memberId), body: { intentToken } })).statusCode, 200);
});

test('session token ends with the account: suspended member is refused, a later PIN change ends it', async () => {
  const gymId = await makeGym();
  const memberId = await makeUser();
  await makePass(memberId);
  const intentToken = await intentFor(gymId);
  const session = await run(webCheckinSession, { token: bearer(memberId) });
  const { invalidateAccountStatus } = await import('../src/auth/jwt.mjs');
  await users.updateByIdAsync?.(memberId, { sessionsValidAfter: new Date(Date.now() + 60_000).toISOString() })
    ?? await users.updateAsync(u => u.id === memberId, { sessionsValidAfter: new Date(Date.now() + 60_000).toISOString() });
  invalidateAccountStatus(memberId);
  const ended = await run(webCheckinPreview, { token: session.body.token, body: { intentToken } });
  assert.equal(ended.statusCode, 401);
  assert.equal(ended.body.error, 'session_ended');
  const suspended = await makeUser('member', { accountStatus: 'suspended' });
  const s = await run(webCheckinSession, { token: bearer(suspended) });
  assert.equal(s.statusCode, 403);
  assert.equal(s.body.error, 'account_suspended');
});

test('admin and gym operator are refused on every route; a trainer is allowed', async () => {
  const gymId = await makeGym();
  const intentToken = await intentFor(gymId);
  for (const userType of ['admin', 'gym_operator', 'gym_staff']) {
    const id = await makeUser(userType);
    for (const [route, body] of [[webCheckinSession, {}], [webCheckinPreview, { intentToken }], [webCheckinConfirm, confirmBody(intentToken)]]) {
      const out = await run(route, { token: bearer(id, userType), body });
      assert.equal(out.statusCode, 403, `${userType} ${route.path}`);
    }
    assert.equal((await rowsFor(id)).length, 0);
  }
  const trainer = await makeUser('trainer');
  await makePass(trainer);
  const session = await run(webCheckinSession, { token: bearer(trainer, 'trainer') });
  assert.equal(session.statusCode, 200);
  const done = await run(webCheckinConfirm, { token: session.body.token, body: confirmBody(intentToken) });
  assert.equal(done.statusCode, 200);
  assert.equal((await rowsFor(trainer)).length, 1);
});

test('confirm records exactly one web_gym_qr_by_member visit with minimal metadata and the contract response', async () => {
  const gymId = await makeGym();
  const memberId = await makeUser();
  const subId = await makePass(memberId);
  const intentToken = await intentFor(gymId);
  const session = await run(webCheckinSession, { token: bearer(memberId) });
  const out = await run(webCheckinConfirm, { token: session.body.token, body: confirmBody(intentToken), ip: '192.0.2.55' });
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  assert.equal(out.body.ok, true);
  assert.equal(out.body.idempotent, false);
  assert.deepEqual(Object.keys(out.body.checkin).sort(), ['gym', 'id', 'timestamp']);
  assert.equal(out.body.visitNumberInCycle, 1);
  assert.equal(out.headers['Cache-Control'], 'no-store');
  const rows = await rowsFor(memberId);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.source, 'web_gym_qr_by_member');
  assert.equal(row.method, 'web_scanned');
  assert.equal(row.gymId, gymId);
  assert.equal(row.subscriptionId, subId);
  assert.equal(row.visitConsumed, true);
  assert.equal(row.status, 'valid');
  assert.deepEqual(Object.keys(row.clientMeta).sort(), ['channel', 'ipHash', 'uaFamily']);
  assert.equal(row.clientMeta.channel, 'web');
  assert.equal(row.clientMeta.uaFamily, 'chrome');
  assert.match(row.clientMeta.ipHash, /^[0-9a-f]{32}$/);
  assert.ok(row.authSessionId && row.intentId);
  const dump = JSON.stringify(row);
  assert.ok(!dump.includes('192.0.2.55') && !dump.includes('Mozilla') && !dump.includes(intentToken), 'no raw address, user-agent string or token is stored');
});

test('ipHash changes with the day (daily salt) and is not the plain address hash', async () => {
  const { ipHashOf } = await import('../src/services/web-checkin-service.mjs');
  const { createHash } = await import('node:crypto');
  const d1 = Date.UTC(2027, 0, 29, 12), d2 = Date.UTC(2027, 0, 30, 12);
  assert.equal(ipHashOf('192.0.2.1', d1), ipHashOf('192.0.2.1', d1 + 3600_000));
  assert.notEqual(ipHashOf('192.0.2.1', d1), ipHashOf('192.0.2.1', d2));
  assert.notEqual(ipHashOf('192.0.2.1', d1), ipHashOf('192.0.2.2', d1));
  assert.notEqual(ipHashOf('192.0.2.1', d1), createHash('sha256').update('192.0.2.1').digest('hex').slice(0, 32));
});

test('confirm needs confirm === true and a sane idempotencyKey; neither writes', async () => {
  const gymId = await makeGym();
  const memberId = await makeUser();
  await makePass(memberId);
  const intentToken = await intentFor(gymId);
  const token = bearer(memberId);
  for (const body of [{ intentToken, idempotencyKey: 'abcdefgh1' }, { intentToken, confirm: 'true', idempotencyKey: 'abcdefgh1' }, { intentToken, confirm: false, idempotencyKey: 'abcdefgh1' }, { intentToken, confirm: 1, idempotencyKey: 'abcdefgh1' }]) {
    const out = await run(webCheckinConfirm, { token, body });
    assert.equal(out.statusCode, 400);
    assert.equal(out.body.error, 'confirmation_required');
  }
  for (const idempotencyKey of [undefined, '', 'short', 'x'.repeat(101), 'has space here', 42]) {
    const out = await run(webCheckinConfirm, { token, body: { intentToken, confirm: true, idempotencyKey } });
    assert.equal(out.statusCode, 400);
    assert.equal(out.body.error, 'invalid_idempotency_key');
  }
  assert.equal((await rowsFor(memberId)).length, 0);
});

test('concurrent double confirm records one visit; the loser returns it as idempotent', async () => {
  const gymId = await makeGym();
  const memberId = await makeUser();
  await makePass(memberId);
  const intentToken = await intentFor(gymId);
  const token = bearer(memberId);
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => run(webCheckinConfirm, { token, body: confirmBody(intentToken) })));
  for (const o of [a, b, c]) assert.equal(o.statusCode, 200, JSON.stringify(o.body));
  assert.equal((await rowsFor(memberId)).length, 1);
  assert.equal(new Set([a, b, c].map(o => o.body.checkin.id)).size, 1);
  assert.equal([a, b, c].filter(o => o.body.idempotent === false).length, 1);
});

test('already checked in today: confirm is idempotent success, preview says alreadyCheckedIn, no second visit used', async () => {
  const gymId = await makeGym();
  const memberId = await makeUser();
  await makePass(memberId);
  const token = bearer(memberId);
  const first = await run(webCheckinConfirm, { token, body: confirmBody(await intentFor(gymId)) });
  assert.equal(first.body.idempotent, false);
  const intent2 = await intentFor(gymId);
  const preview = await run(webCheckinPreview, { token, body: { intentToken: intent2 } });
  assert.equal(preview.body.eligible, true);
  assert.equal(preview.body.alreadyCheckedIn, true);
  const second = await run(webCheckinConfirm, { token, body: confirmBody(intent2) });
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.idempotent, true);
  assert.equal(second.body.checkin.id, first.body.checkin.id);
  assert.equal((await rowsFor(memberId)).length, 1);
});

test('refusals are 409 { ok: false, failure } with the in-app codes: no pass, tier not covered, visits exhausted, suspended, closed', async () => {
  const mid = await makeGym();
  const standard = await makeGym({ tier: 'standard' });
  const standard2 = await makeGym({ tier: 'standard' });
  const closed = await makeGym({ operatingHours: { default: { open: '00:00', close: '00:01' } } });
  const refused = async (memberId, gymId) => {
    const token = bearer(memberId);
    const intentToken = await intentFor(gymId);
    const preview = await run(webCheckinPreview, { token, body: { intentToken } });
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.body.eligible, false);
    const out = await run(webCheckinConfirm, { token, body: confirmBody(intentToken) });
    assert.equal(out.statusCode, 409);
    assert.equal(out.body.ok, false);
    assert.equal(out.body.failure, preview.body.reason, 'preview and confirm give the same reason');
    assert.equal((await rowsFor(memberId)).length, memberId === usedUp ? 1 : 0);
    return out.body.failure;
  };
  let usedUp = null;
  assert.equal(await refused(await makeUser(), mid), 'subscription_inactive');
  const basic = await makeUser(); await makePass(basic, { tier: 'basic' });
  assert.equal(await refused(basic, mid), 'tier_not_covered');
  const susp = await makeUser(); await makePass(susp, { status: 'suspended' });
  assert.equal(await refused(susp, mid), 'subscription_inactive');
  // basic has 1 visit and it was used two days ago (not through the web): a visit at a standard gym is refused.
  usedUp = await makeUser();
  const usedSub = await makePass(usedUp, { tier: 'basic' });
  await checkins.insertAsync({
    id: uid('chk'), memberId: usedUp, gymId: standard, timestamp: new Date(Date.now() - 2 * 86_400_000).toISOString(), method: 'gym_scanned',
    subscriptionType: 'platform_pass', passTier: 'basic', visitNumberInCycle: 1, gymTier: 'standard', creditsDeductedTzs: 0, visitConsumed: true,
    status: 'valid', subscriptionId: usedSub, businessDate: new Date(Date.now() - 2 * 86_400_000 + 3 * 3_600_000).toISOString().slice(0, 10), source: 'gym_qr_by_member',
  });
  assert.equal(await refused(usedUp, standard2), 'visits_exhausted');
  const late = await makeUser(); await makePass(late);
  assert.equal(await refused(late, closed), 'gym_closed');
});

test('gym gates apply at confirm time: a gym deactivated after the intent was minted is gym_not_found', async () => {
  const gymId = await makeGym();
  const memberId = await makeUser();
  await makePass(memberId);
  const intentToken = await intentFor(gymId);
  await gyms.updateAsync(g => g.id === gymId, { status: 'inactive' });
  const out = await run(webCheckinConfirm, { token: bearer(memberId), body: confirmBody(intentToken) });
  assert.equal(out.statusCode, 409);
  assert.equal(out.body.failure, 'gym_not_found');
  assert.equal((await rowsFor(memberId)).length, 0);
});

test('bad, tampered and expired intents are 409 invalid_intent / intent_expired and write nothing', async () => {
  const gymId = await makeGym();
  const memberId = await makeUser();
  await makePass(memberId);
  const token = bearer(memberId);
  const good = await intentFor(gymId);
  const [part, sig] = good.split('.');
  for (const bad of [undefined, '', 'nonsense', `${part}.${sig.slice(0, -3)}abc`, 'a.b.c']) {
    for (const route of [webCheckinPreview, webCheckinConfirm]) {
      const out = await run(route, { token, body: route === webCheckinConfirm ? confirmBody(bad) : { intentToken: bad } });
      assert.equal(out.statusCode, 409);
      assert.deepEqual(out.body, { ok: false, failure: 'invalid_intent' });
    }
  }
  const expired = signIntent({ gymRef: publicRefFor(gymId), now: Date.now() - 11 * 60_000 }).token;
  for (const route of [webCheckinPreview, webCheckinConfirm]) {
    const out = await run(route, { token, body: route === webCheckinConfirm ? confirmBody(expired) : { intentToken: expired } });
    assert.deepEqual(out.body, { ok: false, failure: 'intent_expired' });
  }
  assert.equal((await rowsFor(memberId)).length, 0);
});

test('cross-gym: an intent for gym A records at gym A only; one re-pointed at gym B is invalid', async () => {
  const gymA = await makeGym();
  const gymB = await makeGym();
  const memberId = await makeUser();
  await makePass(memberId);
  const token = bearer(memberId);
  const tokenA = await intentFor(gymA);
  const tokenB = await intentFor(gymB);
  // Splice A's claims onto B's signature (and the reverse): neither verifies.
  const forged = `${tokenA.split('.')[0]}.${tokenB.split('.')[1]}`;
  assert.equal((await run(webCheckinConfirm, { token, body: confirmBody(forged) })).body.failure, 'invalid_intent');
  const ok = await run(webCheckinConfirm, { token, body: confirmBody(tokenA) });
  assert.equal(ok.statusCode, 200);
  const rows = await rowsFor(memberId);
  assert.deepEqual(rows.map(r => r.gymId), [gymA]);
});

test('the same intent used by two members is two separate visits (an intent is not a ticket for the link holder)', async () => {
  const gymId = await makeGym();
  const m1 = await makeUser(); const m2 = await makeUser();
  await makePass(m1); await makePass(m2);
  const intentToken = await intentFor(gymId);
  assert.equal((await run(webCheckinConfirm, { token: bearer(m1), body: confirmBody(intentToken) })).statusCode, 200);
  const second = await run(webCheckinConfirm, { token: bearer(m2), body: confirmBody(intentToken) });
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.idempotent, false);
  assert.equal((await rowsFor(m1)).length + (await rowsFor(m2)).length, 2);
});

test('service level: a B2B-funded visit is previewed as eligible and recorded as a web visit with the same meta; intent replay is idempotent', async () => {
  const gymId = await makeGym();
  const memberId = await makeUser();
  const held = [];
  const b2bFunding = {
    wouldCoverGymVisit: async () => true,
    holdGymVisit: async () => { held.push(1); return { consumption: { id: uid('cons'), grossTzs: 8000, sponsorTzs: 8000, beneficiaryTzs: 0 }, organization: { id: 'o' } }; },
    confirm: async () => {}, cancel: async () => {},
  };
  const checkInService = createCheckInService({ users, gyms, subscriptions, checkins, getTierConfig: settingsService.getTierConfig, b2bFunding });
  const webGymProfile = createWebGymProfileService({ gymService, settingsService, trainerService, moderationGate, partnerGate });
  const svc = createWebCheckinService({ gyms, checkInService, webGymProfile, db });
  const { intentToken } = await svc.createIntent({ q: issueGymQr(gymId) });
  const preview = await svc.preview({ userId: memberId, intentToken });
  assert.deepEqual(preview.body.eligible, true);
  assert.equal(held.length, 0, 'preview never holds sponsor allowance');
  assert.equal((await rowsFor(memberId)).length, 0);
  const done = await svc.confirm({ userId: memberId, intentToken, confirm: true, idempotencyKey: 'key-12345678', authSessionId: 'sid1', clientMeta: { channel: 'web', uaFamily: 'safari', ipHash: 'abc' } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const [row] = await rowsFor(memberId);
  assert.equal(row.subscriptionType, 'b2b_benefit');
  assert.equal(row.source, 'web_gym_qr_by_member');
  assert.equal(row.visitConsumed, false);
  assert.equal(row.authSessionId, 'sid1');
  assert.equal(row.clientMeta.uaFamily, 'safari');
  const replay = await svc.confirm({ userId: memberId, intentToken, confirm: true, idempotencyKey: 'key-12345678' });
  assert.equal(replay.body.idempotent, true);
  assert.equal(held.length, 1);
  assert.equal((await rowsFor(memberId)).length, 1);
});

test('service level: an expired intent is refused by the injected clock; retention clears metadata after 30 days only', async () => {
  const gymId = await makeGym();
  const memberId = await makeUser();
  await makePass(memberId);
  let clock = Date.now();
  const checkInService = createCheckInService({ users, gyms, subscriptions, checkins, getTierConfig: settingsService.getTierConfig });
  const webGymProfile = createWebGymProfileService({ gymService, settingsService, trainerService, moderationGate, partnerGate });
  const svc = createWebCheckinService({ gyms, checkInService, webGymProfile, db, now: () => clock });
  const { intentToken } = await svc.createIntent({ q: issueGymQr(gymId) });
  clock += 601_000;
  assert.equal((await svc.confirm({ userId: memberId, intentToken, confirm: true, idempotencyKey: 'key-12345678' })).body.failure, 'intent_expired');
  clock = Date.now();
  const fresh = await svc.createIntent({ q: issueGymQr(gymId) });
  await svc.confirm({ userId: memberId, intentToken: fresh.intentToken, confirm: true, idempotencyKey: 'key-12345678', authSessionId: 's', clientMeta: { channel: 'web' } });
  assert.equal(await svc.purgeClientMeta(), 0, 'a fresh visit keeps its metadata');
  await db('Checkin').where({ memberId }).update({ timestamp: new Date(Date.now() - 31 * 86_400_000) });
  assert.equal(await svc.purgeClientMeta(), 1);
  const [row] = await rowsFor(memberId);
  assert.equal(row.clientMeta, null);
  assert.equal(row.authSessionId, null);
  assert.equal(row.source, 'web_gym_qr_by_member', 'the visit itself is kept');
});
