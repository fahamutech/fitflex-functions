// Browser check-in security alert (S3) against the CI database: a web check-in writes a SecurityEvent and (flag
// WEB_CHECKIN_ALERTS) one inbox message + push in the member's language with gym and Tanzania time; in-app scans
// never do; the handler is idempotent and never throws; /me/security-activity is the caller's own rows only.
import { test, after, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { gyms, users, subscriptions, platformSettings, deviceTokens, notifications, communicationPreferences } from '../src/bootstrap/collections.mjs';
import { settingsService, securityEventService as wired } from '../src/bootstrap/services.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { issueGymQr } from '../src/auth/qr-token.mjs';
import { createNotificationService } from '../src/services/notification-service.mjs';
import { createSecurityEventService, eventIdFor, notificationIdFor } from '../src/services/security-event-service.mjs';
import { createPartnerNotifier } from '../src/services/partner-notifier.mjs';
import { webCheckinIntent, webCheckinConfirm, resetWebCheckinLimits } from '../functions/web-checkin.mjs';
import { securityActivity, securityEventRetention } from '../functions/security-activity.mjs';
import { checkInService } from '../src/bootstrap/services.mjs';
import { deleteMyAccount } from '../functions/subscriptions.mjs';

assert.match(String(process.env.DATABASE_URL_CI || ''), /fitflex_ci/, 'specs run against the CI database only');

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const now = () => new Date().toISOString();
const made = { gyms: [], users: [] };
const FLAGS = ['WEB_QR_CHECKIN', 'WEB_CHECKIN_ALERTS', 'QR_HMAC_SECRET'];
const envBefore = Object.fromEntries(FLAGS.map(k => [k, process.env[k]]));
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
  process.env.WEB_CHECKIN_ALERTS = '1';
  process.env.QR_HMAC_SECRET = 'alerts-spec-secret';
  resetWebCheckinLimits();
});
after(async () => {
  await platformSettings.updateAsync(s => s.id === 'platform', { subscriptionTiers: tiersBefore });
  for (const [k, v] of Object.entries(envBefore)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  if (made.users.length) await db('User').whereIn('id', made.users).del();
  for (const id of made.users) await users.removeAsync(u => u.id === id);
  for (const id of made.gyms) await gyms.removeAsync(g => g.id === id);
  if (made.gyms.length) await db('Gym').whereIn('id', made.gyms).del();
  await db.destroy();
});

async function makeGym(extra = {}) {
  await gyms.ready;
  const id = uid('gym');
  await gyms.insertAsync({
    id, name: `Alert Gym ${id.slice(-4)}`, tier: 'midtier', location: 'Masaki', status: 'active', venueType: 'physical',
    accessMode: 'paid_visit', homepageVisible: true, ratePerDay: 8000, createdAt: now(), updatedAt: now(), ...extra,
  });
  made.gyms.push(id);
  return id;
}
async function makeUser({ withDevice = true, locale = null } = {}) {
  const id = uid('usr');
  await users.insertAsync({ id, userType: 'member', displayName: 'Alert Member', accountStatus: 'active', createdAt: now(), updatedAt: now() });
  made.users.push(id);
  const start = new Date(Date.now() - 10 * 86_400_000).toISOString();
  await subscriptions.insertAsync({ id: uid('sub'), memberId: id, type: 'platform_pass', tier: 'pro', status: 'active', startedAt: start, cycleStartedAt: start, renewsAt: new Date(Date.now() + 20 * 86_400_000).toISOString(), expiresAt: new Date(Date.now() + 20 * 86_400_000).toISOString() });
  if (withDevice) await deviceTokens.insertAsync({ id: uid('dvt'), userId: id, token: uid('tok'), platform: 'android', createdAt: now(), lastSeenAt: now() });
  if (locale) await communicationPreferences.insertAsync({ id, locale, updatedAt: now() });
  return id;
}
const bearer = id => sign({ sub: id, userType: 'member' });
function res() {
  return { statusCode: 200, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, set(k, v) { this.headers[k] = v; return this; } };
}
async function run(route, { token = null, body = {}, query = {} } = {}) {
  const req = { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-forwarded-for': '203.0.113.9', 'user-agent': 'Mozilla/5.0 Chrome/126 Mobile Safari/537.36' }, body, params: {}, query };
  const out = res();
  let passed = !route.onGuard;
  if (route.onGuard) await route.onGuard(req, out, () => { passed = true; });
  if (passed) await route.onRequest(req, out);
  return out;
}
async function confirmWeb(memberId, gymId, intentToken = null) {
  if (!intentToken) {
    const i = await run(webCheckinIntent, { body: { q: issueGymQr(gymId) } });
    assert.equal(i.statusCode, 200, JSON.stringify(i.body));
    intentToken = i.body.intentToken;
  }
  return { out: await run(webCheckinConfirm, { token: bearer(memberId), body: { intentToken, confirm: true, idempotencyKey: uid('key') } }), intentToken };
}
/** The hook is fire-and-forget after the response: wait for its effect. */
async function eventsOf(memberId, { expect = 1, ms = 3000 } = {}) {
  const until = Date.now() + ms;
  let rows;
  do {
    rows = await db('SecurityEvent').where({ userId: memberId });
    if (rows.length >= expect) break;
    await new Promise(r => setTimeout(r, 25));
  } while (Date.now() < until);
  return rows;
}
async function inboxOf(memberId, { expect = 1, ms = 3000 } = {}) {
  const until = Date.now() + ms;
  let rows;
  do {
    rows = await db('Notification').where({ userId: memberId, type: 'web_checkin_recorded' });
    if (rows.length >= expect) break;
    await new Promise(r => setTimeout(r, 25));
  } while (Date.now() < until);
  return rows;
}
const settle = () => new Promise(r => setTimeout(r, 300));
const FORBIDDEN = /"?(pin|token|ip|ua|userAgent|intentId|authSessionId|clientMeta|ipHash|uaFamily)"?\s*:/i;

test('new web check-in with alerts on: one event and one inbox row with gym name and Dar time (EN default); alertQueued true', async () => {
  const gymId = await makeGym();
  const memberId = await makeUser();
  const { out } = await confirmWeb(memberId, gymId);
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  assert.equal(out.body.idempotent, false);
  assert.equal(out.body.alertQueued, true);
  const [event] = await eventsOf(memberId);
  assert.equal(event.kind, 'web_checkin');
  assert.equal(event.checkinId, out.body.checkin.id);
  assert.equal(event.channel, 'web');
  assert.deepEqual(event.details, { gymName: (await gyms.findByIdAsync(gymId)).name });
  const rows = await inboxOf(memberId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, notificationIdFor(out.body.checkin.id));
  assert.equal(rows[0].title, 'Gym check-in from a web browser');
  const gymName = (await gyms.findByIdAsync(gymId)).name;
  assert.match(rows[0].body, new RegExp(`^You checked in at ${gymName} on \\d{2}/\\d{2}/\\d{4} \\d{2}:\\d{2} \\(Dar es Salaam time\\) using a web browser\\. Not you\\? Open to review\\.$`));
  assert.equal(rows[0].data.locale, 'en');
  assert.equal(rows[0].data.open, 'security_activity');
  assert.equal(rows[0].data.eventId, event.id);
  assert.ok(rows[0].data.titleSw && rows[0].data.bodySw.includes(gymName));
  const until = Date.now() + 10000;   // notifiedAt is set just after the message is written
  while (Date.now() < until && !(await db('SecurityEvent').where({ id: event.id }).first()).notifiedAt) await new Promise(r => setTimeout(r, 25));
  assert.ok((await db('SecurityEvent').where({ id: event.id }).first()).notifiedAt, 'notifiedAt set');
});

test('repeat confirm with the same intent, and a same-day repeat at the same gym: no second event or message, alertQueued false', async () => {
  const gymId = await makeGym();
  const memberId = await makeUser();
  const first = await confirmWeb(memberId, gymId);
  assert.equal(first.out.body.alertQueued, true);
  await inboxOf(memberId);
  const again = await confirmWeb(memberId, gymId, first.intentToken);
  assert.equal(again.out.statusCode, 200);
  assert.equal(again.out.body.idempotent, true);
  assert.equal(again.out.body.alertQueued, false);
  const sameDay = await confirmWeb(memberId, gymId);   // a fresh intent, same member, same gym, same day
  assert.equal(sameDay.out.body.idempotent, true);
  assert.equal(sameDay.out.body.alertQueued, false);
  await settle();
  assert.equal((await db('SecurityEvent').where({ userId: memberId })).length, 1);
  assert.equal((await db('Notification').where({ userId: memberId, type: 'web_checkin_recorded' })).length, 1);
});

test('in-app scans (member_scanned / gym_scanned) create no security event', async () => {
  const gymId = await makeGym();
  const memberId = await makeUser();
  const r = await checkInService.perform({ memberId, gymId, method: 'member_scanned', now: new Date() });
  assert.equal(r.ok, true, JSON.stringify(r));
  const other = await makeUser();
  const r2 = await checkInService.perform({ memberId: other, gymId, method: 'gym_scanned', now: new Date() });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  await settle();
  assert.equal((await db('SecurityEvent').whereIn('userId', [memberId, other])).length, 0);
  assert.equal((await db('Notification').whereIn('userId', [memberId, other]).where({ type: 'web_checkin_recorded' })).length, 0);
});

test('alerts flag off: event is written (notifyState none), no message, alertQueued false', async () => {
  delete process.env.WEB_CHECKIN_ALERTS;
  const gymId = await makeGym();
  const memberId = await makeUser();
  const { out } = await confirmWeb(memberId, gymId);
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.alertQueued, false);
  const [event] = await eventsOf(memberId);
  assert.equal(event.notifyState, 'none');
  assert.equal(event.notifiedAt, null);
  await settle();
  assert.equal((await db('Notification').where({ userId: memberId, type: 'web_checkin_recorded' })).length, 0);
});

test('member with no registered device: alertQueued false (inbox message still written)', async () => {
  const gymId = await makeGym();
  const memberId = await makeUser({ withDevice: false });
  const { out } = await confirmWeb(memberId, gymId);
  assert.equal(out.body.alertQueued, false);
  assert.equal((await inboxOf(memberId)).length, 1);
});

test('locale: sw gives Swahili text; unset gives English; both languages are kept in data', async () => {
  const gymId = await makeGym();
  const sw = await makeUser({ locale: 'sw' });
  const en = await makeUser();
  const a = await confirmWeb(sw, gymId); const b = await confirmWeb(en, gymId);
  assert.equal(a.out.statusCode, 200); assert.equal(b.out.statusCode, 200);
  const [rs] = await inboxOf(sw); const [re] = await inboxOf(en);
  const gymName = (await gyms.findByIdAsync(gymId)).name;
  assert.equal(rs.title, 'Umejiandikisha gym kupitia kivinjari');
  assert.match(rs.body, new RegExp(`^Umejiandikisha ${gymName} tarehe \\d{2}/\\d{2}/\\d{4} \\d{1,2}:\\d{2} (asubuhi|mchana|jioni|usiku) \\(saa za Dar es Salaam\\) kupitia kivinjari\\. Si wewe\\? Fungua kukagua\\.$`));
  assert.equal(rs.data.locale, 'sw');
  assert.equal(re.title, 'Gym check-in from a web browser');
  assert.equal(re.data.locale, 'en');
  assert.equal(re.data.titleEn, 'Gym check-in from a web browser');
});

// A service wired like production but with a stub phone-push so the payload can be seen.
function harness({ messaging = null } = {}) {
  const sent = [];
  const notificationService = createNotificationService({
    users, deviceTokens, notifications, logger: { warn() {} },
    getMessaging: messaging === 'off' ? null : () => messaging || { sendEachForMulticast: async (m) => { sent.push(m); return { successCount: m.tokens.length, failureCount: 0, responses: m.tokens.map(() => ({ success: true, messageId: 'm' })) }; } },
    localeOf: async userId => (await communicationPreferences.findByIdAsync(userId))?.locale ?? null,
  });
  const svc = createSecurityEventService({ db, gyms, deviceTokens, notify: (u, m) => notificationService.notify(u, m), localeOf: async userId => (await communicationPreferences.findByIdAsync(userId))?.locale ?? null, alertsOn: () => true, logger: { warn() {} } });
  return { svc, sent };
}
const webRow = (memberId, gymId, extra = {}) => ({ id: uid('chk'), memberId, gymId, source: 'web_gym_qr_by_member', timestamp: new Date().toISOString(), businessDate: '2027-01-01', ...extra });

test('push payload carries only type, notificationId, eventId, gymId, open; nothing sensitive anywhere', async () => {
  const gymId = await makeGym(); const memberId = await makeUser();
  const { svc, sent } = harness();
  const row = webRow(memberId, gymId, { intentId: 'jti-secret:x', authSessionId: 'sess-secret', clientMeta: { ipHash: 'h', uaFamily: 'chrome' } });
  const r = await svc.handleCheckin(row);
  assert.equal(r.notified, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(sent[0].data).sort(), ['eventId', 'gymId', 'notificationId', 'open', 'type']);
  assert.equal(sent[0].data.type, 'web_checkin_recorded');
  assert.equal(sent[0].data.open, 'security_activity');
  const everything = JSON.stringify([sent[0], await db('Notification').where({ userId: memberId }), await db('SecurityEvent').where({ userId: memberId })]);
  for (const secret of ['jti-secret', 'sess-secret', 'uaFamily', 'ipHash', 'clientMeta', 'intentId', 'authSessionId']) assert.ok(!everything.includes(secret), secret);
  assert.ok(!FORBIDDEN.test(JSON.stringify(sent[0].data)));
});

test('hook idempotency: handling the same check-in twice leaves one event and one message (and one push)', async () => {
  const gymId = await makeGym(); const memberId = await makeUser();
  const { svc, sent } = harness();
  const row = webRow(memberId, gymId);
  await svc.handleCheckin(row); await svc.handleCheckin(row); await Promise.all([svc.handleCheckin(row), svc.handleCheckin(row)]);
  assert.equal((await db('SecurityEvent').where({ userId: memberId })).length, 1);
  assert.equal((await db('Notification').where({ userId: memberId })).length, 1);
  assert.equal(sent.length, 1);
  assert.equal((await db('SecurityEvent').where({ userId: memberId }).first()).id, eventIdFor(row.id));
});

test('push disabled: inbox row exists; push throwing: handler does not throw and the event and inbox row exist', async () => {
  const gymId = await makeGym();
  const a = await makeUser(); const b = await makeUser();
  const off = harness({ messaging: 'off' }).svc;
  assert.equal((await off.handleCheckin(webRow(a, gymId))).notified, true);
  assert.equal((await db('Notification').where({ userId: a, type: 'web_checkin_recorded' })).length, 1);
  const boom = harness({ messaging: { sendEachForMulticast: async () => { throw new Error('fcm down'); } } }).svc;
  assert.equal((await boom.handleCheckin(webRow(b, gymId))).notified, true);
  assert.equal((await db('SecurityEvent').where({ userId: b })).length, 1);
  assert.equal((await db('Notification').where({ userId: b, type: 'web_checkin_recorded' })).length, 1);
});

test('handler never throws: database or notify failure is swallowed; non-web or malformed rows are skipped', async () => {
  const gymId = await makeGym(); const memberId = await makeUser();
  const failing = createSecurityEventService({ db, gyms, deviceTokens, notify: async () => { throw new Error('boom'); }, alertsOn: () => true, logger: { warn() {} } });
  const r = await failing.handleCheckin(webRow(memberId, gymId));
  assert.equal(r.error, true);
  assert.equal((await db('SecurityEvent').where({ userId: memberId })).length, 1, 'the event survives a failed message');
  const broken = createSecurityEventService({ db: () => { throw new Error('db down'); }, gyms, deviceTokens, notify: async () => {}, alertsOn: () => true, logger: { warn() {} } });
  assert.deepEqual(await broken.handleCheckin(webRow(memberId, gymId)), { error: true });
  const ok = harness().svc;
  assert.equal((await ok.handleCheckin(webRow(memberId, gymId, { source: 'gym_qr_by_member' }))).skipped, true);
  assert.equal((await ok.handleCheckin(null)).skipped, true);
  assert.equal((await ok.handleCheckin(webRow(memberId, gymId, { timestamp: 'nonsense' }))).skipped, true);
});

test('a failed first message is retried by the next call: still one message, notifiedAt set', async () => {
  const gymId = await makeGym(); const memberId = await makeUser();
  let fail = true;
  const real = harness();
  const flaky = createSecurityEventService({ db, gyms, deviceTokens, notify: async (u, m) => { if (fail) throw new Error('once'); return real.svc && (await createNotificationService({ users, deviceTokens, notifications, getMessaging: null, logger: { warn() {} } }).notify(u, m)); }, alertsOn: () => true, logger: { warn() {} } });
  const row = webRow(memberId, gymId);
  await flaky.handleCheckin(row);
  assert.equal((await db('SecurityEvent').where({ userId: memberId }).first()).notifiedAt, null);
  fail = false;
  await flaky.handleCheckin(row); await flaky.handleCheckin(row);
  assert.equal((await db('Notification').where({ userId: memberId })).length, 1);
  assert.ok((await db('SecurityEvent').where({ userId: memberId }).first()).notifiedAt);
});

test('Tanzania time comes from the check-in instant, not businessDate (23:59:30 and 00:00:30 EAT)', async () => {
  const gymId = await makeGym(); const memberId = await makeUser(); const m2 = await makeUser();
  const { svc } = harness();
  // 20:59:30Z = 23:59:30 EAT on 10 March; 21:00:30Z = 00:00:30 EAT on 11 March. businessDate deliberately wrong.
  await svc.handleCheckin(webRow(memberId, gymId, { timestamp: '2027-03-10T20:59:30.000Z', businessDate: '2027-03-11' }));
  await svc.handleCheckin(webRow(m2, gymId, { timestamp: '2027-03-10T21:00:30.000Z', businessDate: '2027-03-10' }));
  const [a] = await db('Notification').where({ userId: memberId }); const [b] = await db('Notification').where({ userId: m2 });
  assert.match(a.body, / on 10\/03\/2027 23:59 \(Dar es Salaam time\)/);
  assert.match(b.body, / on 11\/03\/2027 00:00 \(Dar es Salaam time\)/);
  assert.match(a.data.bodySw, /tarehe 10\/03\/2027 11:59 usiku/);
  assert.match(b.data.bodySw, /tarehe 11\/03\/2027 12:00 usiku/);
});

test('gym-owner push (gymCheckin) still fires for web check-ins and in-app scans, independent of the security handler', async () => {
  const gymId = await makeGym(); const memberId = await makeUser();
  const ownerId = uid('usr');
  await users.insertAsync({ id: ownerId, userType: 'gym_operator', displayName: 'Owner', accountStatus: 'active', gymIds: [gymId], gymId, createdAt: now(), updatedAt: now() });
  made.users.push(ownerId);
  const { out } = await confirmWeb(memberId, gymId);
  assert.equal(out.statusCode, 200);
  const until = Date.now() + 3000;
  let rows;
  do { rows = await db('Notification').where({ userId: ownerId, type: 'gym_checkin' }); if (rows.length) break; await new Promise(r => setTimeout(r, 25)); } while (Date.now() < until);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id.startsWith('ntf_chk_'), true);
  const m2 = await makeUser();
  await checkInService.perform({ memberId: m2, gymId, method: 'member_scanned', now: new Date() });
  const until2 = Date.now() + 3000;
  do { rows = await db('Notification').where({ userId: ownerId, type: 'gym_checkin' }); if (rows.length >= 2) break; await new Promise(r => setTimeout(r, 25)); } while (Date.now() < until2);
  assert.equal(rows.length, 2);
});

test('a gym push that throws does not stop the security event, and the reverse (Promise.allSettled wiring)', async () => {
  const gymId = await makeGym(); const memberId = await makeUser();
  const { svc } = harness();
  const notifier = createPartnerNotifier({ users, gyms, notify: async () => { throw new Error('gym push down'); }, logger: { warn() {} } });
  const row = webRow(memberId, gymId);
  const results = await Promise.allSettled([notifier.gymCheckin(row), svc.handleCheckin(row)]);
  assert.equal(results.every(x => x.status === 'fulfilled'), true);
  assert.equal((await db('SecurityEvent').where({ userId: memberId })).length, 1);
});

test('/me/security-activity: dormant 404; own rows only; shape; limit clamp; paging; no-store', async () => {
  const gymA = await makeGym(); const gymB = await makeGym();
  const me = await makeUser(); const other = await makeUser();
  const { svc } = harness();
  const base = Date.parse('2027-02-01T08:00:00.000Z');
  for (let i = 0; i < 5; i++) await svc.handleCheckin(webRow(me, i % 2 ? gymA : gymB, { timestamp: new Date(base + i * 60_000).toISOString() }));
  await svc.handleCheckin(webRow(other, gymA));
  delete process.env.WEB_QR_CHECKIN;
  const off = await run(securityActivity, { token: bearer(me) });
  assert.equal(off.statusCode, 404); assert.deepEqual(off.body, { error: 'not_found' });
  process.env.WEB_QR_CHECKIN = '1';
  const anon = await run(securityActivity, {});
  assert.equal(anon.statusCode, 401);
  const p1 = await run(securityActivity, { token: bearer(me), query: { limit: '2' } });
  assert.equal(p1.statusCode, 200);
  assert.equal(p1.headers['Cache-Control'], 'no-store');
  assert.equal(p1.body.events.length, 2);
  const e = p1.body.events[0];
  assert.deepEqual(Object.keys(e).sort(), ['channel', 'gym', 'id', 'kind', 'occurredAt', 'status']);
  assert.equal(e.kind, 'web_checkin'); assert.equal(e.channel, 'web'); assert.equal(e.status, 'notified');
  assert.equal(e.occurredAt, new Date(base + 4 * 60_000).toISOString());
  assert.equal(e.gym.id, gymB);
  assert.equal(e.gym.name, (await gyms.findByIdAsync(gymB)).name);
  assert.ok(p1.body.next);
  const p2 = await run(securityActivity, { token: bearer(me), query: { limit: '2', before: p1.body.next } });
  assert.equal(p2.body.events.length, 2);
  const p3 = await run(securityActivity, { token: bearer(me), query: { limit: '2', before: p2.body.next } });
  assert.equal(p3.body.events.length, 1); assert.equal(p3.body.next, undefined);
  const all = await run(securityActivity, { token: bearer(me), query: { limit: '9999' } });
  assert.equal(all.body.events.length, 5);
  assert.ok(!all.body.events.some(x => x.id === eventIdFor('x')));
  const theirs = await run(securityActivity, { token: bearer(other) });
  assert.equal(theirs.body.events.length, 1);
  assert.ok(!JSON.stringify(all.body).includes(other));
  assert.ok(!FORBIDDEN.test(JSON.stringify(all.body)));
  const bad = await run(securityActivity, { token: bearer(me), query: { before: 'not-a-date' } });
  assert.equal(bad.statusCode, 400);
  assert.equal(wired.list.length, 1);
});

test('cross-member isolation: member B confirming sees no trace of A; the same shared intent is B\'s own visit', async () => {
  const gymId = await makeGym();
  const a = await makeUser(); const b = await makeUser({ withDevice: false });
  const { out: oa, intentToken } = await confirmWeb(a, gymId);
  const { out: ob } = await confirmWeb(b, gymId, intentToken);
  assert.equal(oa.body.alertQueued, true);
  assert.equal(ob.body.alertQueued, false);
  assert.ok(!JSON.stringify(ob.body).includes(a));
  assert.equal((await eventsOf(a)).length, 1);
  assert.equal((await eventsOf(b)).length, 1);
  assert.equal((await db('SecurityEvent').where({ userId: b }).first()).checkinId, ob.body.checkin.id);
  const listB = await run(securityActivity, { token: bearer(b) });
  assert.equal(listB.body.events.length, 1);
  assert.equal(listB.body.events[0].id, eventIdFor(ob.body.checkin.id));
});

test('retention: events older than 13 months are deleted, newer kept; job is a no-op while WEB_QR_CHECKIN is off', async () => {
  const memberId = await makeUser();
  const old = { id: uid('sev'), userId: memberId, kind: 'web_checkin', checkinId: uid('chk'), occurredAt: new Date(Date.now() - 14 * 31 * 86_400_000), notifyState: 'none' };
  const fresh = { id: uid('sev'), userId: memberId, kind: 'web_checkin', checkinId: uid('chk'), occurredAt: new Date(Date.now() - 12 * 28 * 86_400_000), notifyState: 'none' };
  await db('SecurityEvent').insert([old, fresh]);
  delete process.env.WEB_QR_CHECKIN;
  await securityEventRetention.onJob();
  assert.equal((await db('SecurityEvent').where({ userId: memberId })).length, 2);
  process.env.WEB_QR_CHECKIN = '1';
  await securityEventRetention.onJob();
  const left = await db('SecurityEvent').where({ userId: memberId });
  assert.deepEqual(left.map(r => r.id), [fresh.id]);
  assert.equal(securityEventRetention.rule, '55 2 * * *');
});

test('account deletion removes the member\'s security events', async () => {
  const gymId = await makeGym(); const memberId = await makeUser();
  await harness().svc.handleCheckin(webRow(memberId, gymId));
  assert.equal((await db('SecurityEvent').where({ userId: memberId })).length, 1);
  const del = await run(deleteMyAccount, { token: bearer(memberId) });
  assert.equal(del.statusCode, 200, JSON.stringify(del.body));
  assert.equal((await db('SecurityEvent').where({ userId: memberId })).length, 0);
});
