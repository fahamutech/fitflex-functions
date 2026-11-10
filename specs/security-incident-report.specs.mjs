// Security incident reports (S4b) against the CI database: the member reports a web check-in they did not make
// (POST /me/security-activity/:eventId/report), staff work it (/admin/security-incidents*). Dormant behind
// SECURITY_INCIDENT_REPORTS. A report never voids the check-in or touches visits.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { users } from '../src/bootstrap/collections.mjs';
import { pinAuthService, opsService, securityIncidentService, securityEventService } from '../src/bootstrap/services.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { createB2BWatchService } from '../src/services/b2b-watch-service.mjs';
import { createSecurityIncidentService, resolutionText, notificationIdFor } from '../src/services/security-incident-service.mjs';
import { PORTAL_ACL_SCOPES } from '../src/services/portal-user-service.mjs';
import { securityIncidentReportsOn, securityReportMaxPerDay } from '../src/shared/feature-flags.mjs';
import * as fn from '../functions/security-activity.mjs';
import * as jobs from '../functions/jobs.mjs';
import { deleteMyAccount } from '../functions/subscriptions.mjs';

assert.match(String(process.env.DATABASE_URL_CI || ''), /fitflex_ci/, 'specs run against the CI database only');

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const FLAGS = ['WEB_QR_CHECKIN', 'SECURITY_INCIDENT_REPORTS', 'SECURITY_REPORT_MAX_PER_DAY', 'WEB_CHECKIN_ALERTS'];
const envBefore = Object.fromEntries(FLAGS.map(k => [k, process.env[k]]));
const made = { users: [], events: [] };
beforeEach(() => {
  process.env.WEB_QR_CHECKIN = '1';
  process.env.SECURITY_INCIDENT_REPORTS = '1';
  delete process.env.SECURITY_REPORT_MAX_PER_DAY;
});
after(async () => {
  for (const [k, v] of Object.entries(envBefore)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const ids = made.users;
  if (ids.length) {
    const inc = await db('SecurityIncident').whereIn('userId', ids).pluck('id');
    if (inc.length) await db('SecurityIncident').whereIn('id', inc).del();
    await db('OpsException').whereIn('entityId', inc).del();
    await db('Notification').whereIn('userId', ids).del();
    await db('SecurityEvent').whereIn('userId', ids).del();
    await db('User').whereIn('id', ids).del();
  }
  await db.destroy();
});

async function makeUser({ pin = '4821', userType = 'member', locale = null } = {}) {
  const id = uid('usr_sinc');
  await users.upsertAsync(u => u.id === id, { id, userType, displayName: 'Report Member', accountStatus: 'active', approvalStatus: 'approved', createdAt: new Date().toISOString() });
  made.users.push(id);
  const row = await db('User').where({ id }).first();
  if (pin && row.personId) await pinAuthService.setPin(row.personId, pin);
  if (locale) await db('CommunicationPreference').insert({ id, locale, updatedAt: new Date() }).onConflict('id').merge();
  return { id, personId: row.personId, pin };
}
async function makeEvent(userId, { hoursAgo = 1, gymName = 'Report Gym' } = {}) {
  const id = uid('sev');
  await db('SecurityEvent').insert({
    id, userId, kind: 'web_checkin', checkinId: uid('chk'), gymId: uid('gym'), occurredAt: new Date(Date.now() - hoursAgo * 3_600_000),
    channel: 'web', notifyState: 'none', details: JSON.stringify({ gymName }),
  });
  return id;
}
const bearer = (id, extra = {}) => sign({ sub: id, userType: 'member', ...extra });
function res() {
  return { statusCode: 200, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, set(k, v) { this.headers[k] = v; return this; } };
}
async function run(route, { token = null, body = {}, query = {}, params = {} } = {}) {
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {}, body, params, query };
  const out = res();
  let passed = true;
  for (const g of [route.onGuard].flat().filter(Boolean)) {
    let ok = false;
    await g(req, out, () => { ok = true; });
    if (!ok) { passed = false; break; }
  }
  if (passed) await route.onRequest(req, out);
  return out;
}
const report = (userId, eventId, body = {}) => run(fn.reportSecurityEvent, { token: bearer(userId), params: { eventId }, body });
const person = id => db('Person').where({ id }).first();

async function makeAdmin(scopes) {
  const id = uid('usr_sadm');
  await users.upsertAsync(u => u.id === id, { id, userType: 'admin', email: `${id}@example.com`, displayName: id, accountStatus: 'active', createdAt: new Date().toISOString() });
  made.users.push(id);
  return { id, token: sign(scopes ? { sub: id, userType: 'admin', portalUser: true, aclPermissions: scopes } : { sub: id, userType: 'admin' }) };
}

test('flag helpers: report needs WEB_QR_CHECKIN and SECURITY_INCIDENT_REPORTS; cap default 3', () => {
  assert.equal(securityIncidentReportsOn(), true);
  delete process.env.WEB_QR_CHECKIN;
  assert.equal(securityIncidentReportsOn(), false);
  process.env.WEB_QR_CHECKIN = '1'; delete process.env.SECURITY_INCIDENT_REPORTS;
  assert.equal(securityIncidentReportsOn(), false);
  assert.equal(securityReportMaxPerDay(), 3);
  process.env.SECURITY_REPORT_MAX_PER_DAY = '5';
  assert.equal(securityReportMaxPerDay(), 5);
  process.env.SECURITY_REPORT_MAX_PER_DAY = 'x';
  assert.equal(securityReportMaxPerDay(), 3);
});

test('flag off: the report route is 404 not_found and writes nothing', async () => {
  const m = await makeUser(); const ev = await makeEvent(m.id);
  delete process.env.SECURITY_INCIDENT_REPORTS;
  const out = await report(m.id, ev);
  assert.equal(out.statusCode, 404);
  assert.deepEqual(out.body, { error: 'not_found' });
  assert.equal((await db('SecurityIncident').where({ userId: m.id })).length, 0);
  process.env.SECURITY_INCIDENT_REPORTS = '1'; delete process.env.WEB_QR_CHECKIN;
  assert.equal((await report(m.id, ev)).statusCode, 404);
});

test('flag off: admin routes are 404 feature_disabled, list has reportEnabled false and no report data', async () => {
  const m = await makeUser(); const ev = await makeEvent(m.id);
  process.env.SECURITY_INCIDENT_REPORTS = '1';
  assert.equal((await report(m.id, ev)).statusCode, 200);
  const admin = await makeAdmin(null);
  delete process.env.SECURITY_INCIDENT_REPORTS;
  const out = await run(fn.adminSecurityIncidents, { token: admin.token });
  assert.equal(out.statusCode, 404);
  assert.equal(out.body.error, 'feature_disabled');
  const list = await run(fn.securityActivity, { token: bearer(m.id) });
  assert.equal(list.statusCode, 200);
  assert.equal(list.body.reportEnabled, false);
  assert.equal(list.body.events[0].report, null);
});

test('unauthenticated report is refused', async () => {
  const out = await run(fn.reportSecurityEvent, { params: { eventId: 'sev_x' } });
  assert.equal(out.statusCode, 401);
});

test('happy path: report and secure ends sessions, requires a PIN reset, signs out, alerts staff, check-in untouched', async () => {
  const m = await makeUser(); const ev = await makeEvent(m.id, { gymName: 'Masaki Fit' });
  assert.equal((await person(m.personId)).sessionsValidAfter, null);
  const out = await report(m.id, ev, { secureAccount: true });
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  assert.equal(out.headers['Cache-Control'], 'no-store');
  assert.equal(out.body.ok, true);
  assert.equal(out.body.idempotent, false);
  assert.equal(out.body.incident.status, 'open');
  assert.match(out.body.incident.id, /^sin_/);
  assert.ok(Date.parse(out.body.incident.reportedAt));
  assert.deepEqual(out.body.protection, { requested: true, sessionsEnded: true, pinResetRequired: true });
  assert.equal(out.body.signedOut, true);

  const after = await person(m.personId);
  assert.ok(after.sessionsValidAfter, 'sessions ended');
  assert.ok(after.pinFailedCount >= 10, 'PIN switched off until reset');
  const verify = await pinAuthService.verifyPin({ personId: m.personId, pin: m.pin });
  assert.equal(verify.error, 'pin_reset_required');
  assert.equal(verify.status, 403);

  const row = await db('SecurityIncident').where({ id: out.body.incident.id }).first();
  assert.equal(row.userId, m.id);
  assert.equal(row.eventId, ev);
  assert.equal(row.snapshot.gymName, 'Masaki Fit');
  assert.equal(row.protection.applied, true);
  const trail = await db('SecurityIncidentEvent').where({ incidentId: row.id }).orderBy('createdAt');
  assert.deepEqual(trail.map(t => t.kind).sort(), ['protection', 'reported']);
  // The event itself is untouched.
  assert.ok(await db('SecurityEvent').where({ id: ev }).first());
  // Staff alert: high severity, ids and gym name only.
  const ex = await db('OpsException').where({ dedupeKey: `security_incident:${row.id}` }).first();
  assert.equal(ex.severity, 'high');
  assert.equal(ex.status, 'open');
  assert.equal(row.opsExceptionId, ex.id);
  assert.match(ex.title, /Masaki Fit/);
  assert.match(ex.title, new RegExp(row.id));
  const stored = JSON.stringify(ex) + JSON.stringify(row);
  assert.doesNotMatch(stored, /4821|Report Member|userAgent|ipHash/);
  const forbidden = /"?(pin|token|ip|ua|userAgent|intentId|authSessionId|clientMeta)"?\s*:/i;
  assert.doesNotMatch(JSON.stringify(out.body), forbidden);
});

test('report only: nothing is locked, no sign-out', async () => {
  const m = await makeUser(); const ev = await makeEvent(m.id);
  const out = await report(m.id, ev, { secureAccount: false });
  assert.equal(out.statusCode, 200);
  assert.deepEqual(out.body.protection, { requested: false, sessionsEnded: false, pinResetRequired: false });
  assert.equal(out.body.signedOut, false);
  const p = await person(m.personId);
  assert.equal(p.sessionsValidAfter, null);
  assert.equal(p.pinFailedCount, 0);
  assert.equal((await pinAuthService.verifyPin({ personId: m.personId, pin: m.pin })).ok, true);
});

test('empty body defaults to secure; non-boolean secureAccount is 400', async () => {
  const m = await makeUser(); const ev = await makeEvent(m.id);
  const bad = await report(m.id, ev, { secureAccount: 'yes' });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.body.error, 'invalid_secure_account');
  assert.equal((await db('SecurityIncident').where({ userId: m.id })).length, 0);
  const out = await run(fn.reportSecurityEvent, { token: bearer(m.id), params: { eventId: ev }, body: undefined });
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.protection.requested, true);
  assert.equal(out.body.protection.sessionsEnded, true);
});

test('account with no PIN held by FitFlex: sessions end, pinResetRequired is not_applicable', async () => {
  const m = await makeUser({ pin: null }); const ev = await makeEvent(m.id);
  const out = await report(m.id, ev);
  assert.equal(out.statusCode, 200);
  assert.deepEqual(out.body.protection, { requested: true, sessionsEnded: true, pinResetRequired: 'not_applicable' });
  assert.equal((await person(m.personId)).pinFailedCount, 0);
});

test('requirePinReset: false for a person with no PIN, true and audited otherwise', async () => {
  const none = await makeUser({ pin: null });
  assert.equal(await pinAuthService.requirePinReset(none.personId), false);
  const some = await makeUser();
  assert.equal(await pinAuthService.requirePinReset(some.personId, some.id), true);
  assert.ok((await person(some.personId)).pinFailedCount >= 10);
  assert.equal((await db('AuditLog').where({ action: 'pin_reset_required', target: some.personId })).length, 1);
});

test('idempotent: the same event again returns the same incident, no second incident, no second lockout', async () => {
  const m = await makeUser(); const ev = await makeEvent(m.id);
  const a = await report(m.id, ev);
  const b = await report(m.id, ev, { secureAccount: false });
  assert.equal(b.statusCode, 200);
  assert.equal(b.body.idempotent, true);
  assert.equal(b.body.incident.id, a.body.incident.id);
  assert.deepEqual(b.body.protection, a.body.protection);
  assert.equal((await db('SecurityIncident').where({ userId: m.id })).length, 1);
  assert.equal((await db('OpsException').where({ entityId: a.body.incident.id })).length, 1);
});

test('concurrent reports of the same event make one incident', async () => {
  const m = await makeUser(); const ev = await makeEvent(m.id);
  const outs = await Promise.all([report(m.id, ev), report(m.id, ev), report(m.id, ev)]);
  assert.ok(outs.every(o => o.statusCode === 200));
  assert.equal(new Set(outs.map(o => o.body.incident.id)).size, 1);
  assert.equal((await db('SecurityIncident').where({ userId: m.id })).length, 1);
});

test('another member\'s event, an unknown event and an empty id are all 404', async () => {
  const a = await makeUser(); const b = await makeUser(); const evA = await makeEvent(a.id);
  for (const id of [evA, 'sev_nope', '']) {
    const out = await report(b.id, id);
    assert.equal(out.statusCode, 404, id);
    assert.deepEqual(out.body, { error: 'not_found' });
  }
  assert.equal((await db('SecurityIncident').where({ eventId: evA })).length, 0);
  assert.equal((await person(b.personId)).sessionsValidAfter, null, 'nobody was locked out');
});

test('cap: SECURITY_REPORT_MAX_PER_DAY (default 3) new incidents per 24h, then 429; a repeat of an existing one still works', async () => {
  const m = await makeUser(); const evs = [];
  for (let i = 0; i < 4; i++) evs.push(await makeEvent(m.id, { hoursAgo: i + 1 }));
  for (let i = 0; i < 3; i++) assert.equal((await report(m.id, evs[i], { secureAccount: false })).statusCode, 200);
  const over = await report(m.id, evs[3], { secureAccount: false });
  assert.equal(over.statusCode, 429);
  assert.equal(over.body.error, 'report_limit_reached');
  assert.equal((await db('SecurityIncident').where({ userId: m.id })).length, 3);
  assert.equal((await report(m.id, evs[0])).body.idempotent, true);
  process.env.SECURITY_REPORT_MAX_PER_DAY = '4';
  assert.equal((await report(m.id, evs[3], { secureAccount: false })).statusCode, 200);
  // Incidents older than 24h do not count.
  await db('SecurityIncident').where({ userId: m.id }).update({ reportedAt: new Date(Date.now() - 25 * 3_600_000) });
  const fresh = await makeEvent(m.id);
  assert.equal((await report(m.id, fresh, { secureAccount: false })).statusCode, 200);
});

test('after 2 secure actions in 24h the next report is recorded without further lockout (no 429)', async () => {
  const m = await makeUser(); const evs = [];
  for (let i = 0; i < 3; i++) evs.push(await makeEvent(m.id, { hoursAgo: i + 1 }));
  assert.equal((await report(m.id, evs[0])).body.protection.sessionsEnded, true);
  assert.equal((await report(m.id, evs[1])).body.protection.sessionsEnded, true);
  const stamp = (await person(m.personId)).sessionsValidAfter;
  const third = await report(m.id, evs[2]);
  assert.equal(third.statusCode, 200);
  assert.equal(third.body.idempotent, false);
  assert.deepEqual(third.body.protection, { requested: true, sessionsEnded: false, pinResetRequired: false, limited: true });
  assert.equal(third.body.signedOut, false);
  assert.equal(+(await person(m.personId)).sessionsValidAfter, +stamp, 'sessions were not ended again');
  const row = await db('SecurityIncident').where({ id: third.body.incident.id }).first();
  assert.equal(row.status, 'open');
  assert.ok(row.opsExceptionId, 'staff are still told');
});

test('a failing protection step still leaves the incident recorded', async () => {
  const m = await makeUser(); const ev = await makeEvent(m.id);
  const svc = createSecurityIncidentService({ db, pinAuth: { requirePinReset: async () => { throw new Error('boom'); }, endSessions: async () => {} }, logger: { warn() {} }, reportsOn: () => true });
  const out = await svc.report({ userId: m.id, eventId: ev });
  assert.equal(out.ok, true);
  assert.equal(out.protection.sessionsEnded, false);
  const row = await db('SecurityIncident').where({ userId: m.id }).first();
  assert.equal(row.protection.failed, true);
});

test('a failing staff alert still leaves the report successful', async () => {
  const m = await makeUser(); const ev = await makeEvent(m.id);
  const svc = createSecurityIncidentService({ db, pinAuth: pinAuthService, ops: { raise: async () => { throw new Error('ops down'); } }, logger: { warn() {} } });
  const out = await svc.report({ userId: m.id, eventId: ev, secureAccount: false });
  assert.equal(out.ok, true);
  assert.equal((await db('SecurityIncident').where({ userId: m.id }).first()).opsExceptionId, null);
});

test('GET /me/security-activity: reportEnabled true and per-event report field', async () => {
  const m = await makeUser(); const e1 = await makeEvent(m.id, { hoursAgo: 2 }); const e2 = await makeEvent(m.id, { hoursAgo: 1 });
  const r = await report(m.id, e1, { secureAccount: false });
  const list = await run(fn.securityActivity, { token: bearer(m.id) });
  assert.equal(list.body.reportEnabled, true);
  const by = Object.fromEntries(list.body.events.map(e => [e.id, e]));
  assert.equal(by[e2].report, null);
  assert.deepEqual(by[e1].report, { incidentId: r.body.incident.id, status: 'open', reportedAt: r.body.incident.reportedAt });
  assert.equal(by[e1].status, 'recorded', 'existing status values unchanged');
});

test('staff: ACL denial, scope is grantable, super-admin allowed, member token refused', async () => {
  assert.ok(PORTAL_ACL_SCOPES.includes('security_incidents'));
  const denied = await makeAdmin(['gyms', 'audit']);
  for (const ep of [fn.adminSecurityIncidents, fn.adminSecurityIncident, fn.adminAcknowledgeSecurityIncident, fn.adminResolveSecurityIncident]) {
    const out = await run(ep, { token: denied.token, params: { id: 'sin_x' } });
    assert.equal(out.statusCode, 403, ep.path);
    assert.equal(out.body.error, 'acl_forbidden');
    assert.equal(out.body.requiredScope, 'security_incidents');
  }
  const ok = await makeAdmin(['security_incidents']);
  assert.equal((await run(fn.adminSecurityIncidents, { token: ok.token })).statusCode, 200);
  const sup = await makeAdmin(null);
  assert.equal((await run(fn.adminSecurityIncidents, { token: sup.token })).statusCode, 200);
  const m = await makeUser();
  assert.equal((await run(fn.adminSecurityIncidents, { token: bearer(m.id) })).statusCode, 403);
});

test('staff: list filters and pages, get shows the trail, acknowledge then resolve are audited, member told neutrally', async () => {
  const admin = await makeAdmin(['security_incidents']);
  const m = await makeUser({ locale: 'sw' }); const ev = await makeEvent(m.id, { gymName: 'Kariakoo Gym' });
  const r = await report(m.id, ev);
  const id = r.body.incident.id;

  const open = await run(fn.adminSecurityIncidents, { token: admin.token, query: { limit: '100' } });
  assert.ok(open.body.incidents.some(i => i.id === id));
  const one = open.body.incidents.find(i => i.id === id);
  assert.equal(one.userId, m.id);
  assert.equal(one.snapshot.gymName, 'Kariakoo Gym');
  assert.equal((await run(fn.adminSecurityIncidents, { token: admin.token, query: { status: 'bogus' } })).statusCode, 400);
  assert.equal((await run(fn.adminSecurityIncidents, { token: admin.token, query: { status: 'resolved', limit: '100' } })).body.incidents.some(i => i.id === id), false);
  const paged = await run(fn.adminSecurityIncidents, { token: admin.token, query: { status: 'all', limit: '1' } });
  assert.equal(paged.body.incidents.length, 1);
  assert.ok(paged.body.next);
  assert.equal((await run(fn.adminSecurityIncidents, { token: admin.token, query: { before: paged.body.next, status: 'all', limit: '1' } })).statusCode, 200);
  assert.equal((await run(fn.adminSecurityIncidents, { token: admin.token, query: { before: 'junk' } })).statusCode, 400);

  const ack = await run(fn.adminAcknowledgeSecurityIncident, { token: admin.token, params: { id } });
  assert.equal(ack.statusCode, 200, JSON.stringify(ack.body));
  assert.equal(ack.body.incident.status, 'acknowledged');
  assert.equal(ack.body.incident.acknowledgedBy, admin.id);
  assert.equal((await run(fn.adminAcknowledgeSecurityIncident, { token: admin.token, params: { id } })).statusCode, 409);

  const res1 = await run(fn.adminResolveSecurityIncident, { token: admin.token, params: { id }, body: { outcome: 'unauthorised_confirmed', reason: 'Called the member and the gym; not them.' } });
  assert.equal(res1.statusCode, 200, JSON.stringify(res1.body));
  assert.equal(res1.body.incident.status, 'resolved');
  assert.equal(res1.body.incident.outcome, 'unauthorised_confirmed');
  assert.equal(res1.body.incident.resolvedBy, admin.id);
  assert.deepEqual(res1.body.events.map(e => e.kind), ['reported', 'protection', 'acknowledged', 'resolved']);
  assert.equal((await run(fn.adminResolveSecurityIncident, { token: admin.token, params: { id }, body: { outcome: 'inconclusive', reason: 'Second attempt here ok.' } })).statusCode, 409);
  assert.equal((await run(fn.adminAcknowledgeSecurityIncident, { token: admin.token, params: { id } })).statusCode, 409);

  const audits = await db('AuditLog').where({ target: id }).orderBy('at');
  assert.deepEqual(audits.map(a => a.action), ['security_incident_acknowledged', 'security_incident_resolved']);
  assert.ok(audits.every(a => a.actor === admin.id));
  assert.doesNotMatch(JSON.stringify(audits), /Called the member/, 'free text stays off the audit trail');
  const ex = await db('OpsException').where({ dedupeKey: `security_incident:${id}` }).first();
  assert.equal(ex.status, 'resolved');

  // Neutral message to the member, in their language, the same whatever the outcome.
  const note = await db('Notification').where({ id: notificationIdFor(id) }).first();
  assert.ok(note, 'resolution message written');
  assert.equal(note.type, 'security_report_resolved');
  assert.equal(note.title, resolutionText({ gymName: 'Kariakoo Gym', when: new Date() }).sw.title);
  assert.doesNotMatch(JSON.stringify(note), /unauthorised|confirmed|not them|fraud/i);
  assert.ok(note.data.titleEn && note.data.titleSw && note.data.bodySw);

  // The list now shows it resolved, without the outcome.
  const list = await run(fn.securityActivity, { token: bearer(m.id) });
  assert.equal(list.body.events.find(e => e.id === ev).report.status, 'resolved');
  assert.equal(JSON.stringify(list.body).includes('unauthorised_confirmed'), false);
});

test('resolution text is identical in shape for every outcome (no accusation) and has Swahili', () => {
  const t = resolutionText({ gymName: 'G', when: new Date() });
  for (const l of ['en', 'sw']) { assert.ok(t[l].title && t[l].body); assert.doesNotMatch(t[l].body, /unauthori|fraud|hack|kosa|udanganyifu/i); }
});

test('resolve validation: outcome enum, reason 10..500, unknown id 404, can resolve straight from open', async () => {
  const admin = await makeAdmin(['security_incidents']);
  const m = await makeUser(); const ev = await makeEvent(m.id);
  const id = (await report(m.id, ev, { secureAccount: false })).body.incident.id;
  const go = body => run(fn.adminResolveSecurityIncident, { token: admin.token, params: { id }, body });
  assert.equal((await go({ outcome: 'nope', reason: 'long enough reason' })).body.error, 'invalid_outcome');
  assert.equal((await go({ reason: 'long enough reason' })).statusCode, 400);
  assert.equal((await go({ outcome: 'inconclusive' })).body.error, 'invalid_reason');
  assert.equal((await go({ outcome: 'inconclusive', reason: 'too short' })).body.error, 'invalid_reason');
  assert.equal((await go({ outcome: 'inconclusive', reason: '         short         ' })).body.error, 'invalid_reason', 'trimmed');
  assert.equal((await go({ outcome: 'inconclusive', reason: 'x'.repeat(501) })).body.error, 'invalid_reason');
  assert.equal((await run(fn.adminResolveSecurityIncident, { token: admin.token, params: { id: 'sin_none' }, body: { outcome: 'inconclusive', reason: 'long enough reason' } })).statusCode, 404);
  assert.equal((await run(fn.adminSecurityIncident, { token: admin.token, params: { id: 'sin_none' } })).statusCode, 404);
  assert.equal((await db('SecurityIncident').where({ id }).first()).status, 'open');
  const ok = await go({ outcome: 'authorised_by_member', reason: 'x'.repeat(500) });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.incident.outcome, 'authorised_by_member');
});

test('DB: resolved needs an outcome; the unique index allows one incident per (user, event)', async () => {
  const m = await makeUser(); const ev = await makeEvent(m.id);
  const id = (await report(m.id, ev, { secureAccount: false })).body.incident.id;
  await assert.rejects(db('SecurityIncident').where({ id }).update({ status: 'resolved' }), /security_incident_resolved_ck/);
  await assert.rejects(db('SecurityIncident').where({ id }).update({ outcome: 'bad', status: 'resolved' }), /security_incident_outcome_ck/);
  await assert.rejects(db('SecurityIncident').insert({ id: uid('sin'), userId: m.id, eventId: ev }), /security_incident_user_event_uq/);
});

test('SecurityIncidentEvent is append-only: update and delete are refused; deleting the incident cascades', async () => {
  const m = await makeUser(); const ev = await makeEvent(m.id);
  const id = (await report(m.id, ev, { secureAccount: false })).body.incident.id;
  const [row] = await db('SecurityIncidentEvent').where({ incidentId: id });
  await assert.rejects(db('SecurityIncidentEvent').where({ id: row.id }).update({ kind: 'tampered' }), /append-only/);
  await assert.rejects(db('SecurityIncidentEvent').where({ id: row.id }).del(), /append-only/);
  assert.equal((await db('SecurityIncidentEvent').where({ incidentId: id })).length >= 1, true);
  await db('SecurityIncident').where({ id }).del();
  assert.equal((await db('SecurityIncidentEvent').where({ incidentId: id })).length, 0);
});

test('retention: resolved incidents older than 24 months are purged (with trail), recent and unresolved stay; job is scheduled', async () => {
  const m = await makeUser(); const [e1, e2, e3] = [await makeEvent(m.id), await makeEvent(m.id), await makeEvent(m.id)];
  process.env.SECURITY_REPORT_MAX_PER_DAY = '10';
  const ids = [];
  for (const e of [e1, e2, e3]) ids.push((await report(m.id, e, { secureAccount: false })).body.incident.id);
  const old = new Date(); old.setUTCMonth(old.getUTCMonth() - 25);
  await db('SecurityIncident').whereIn('id', [ids[0], ids[1]]).update({ reportedAt: old });
  await db('SecurityIncident').where({ id: ids[0] }).update({ status: 'resolved', outcome: 'inconclusive', resolvedAt: old });
  const n = await securityIncidentService.purgeExpired();
  assert.ok(n >= 1);
  assert.equal((await db('SecurityIncident').where({ id: ids[0] })).length, 0);
  assert.equal((await db('SecurityIncidentEvent').where({ incidentId: ids[0] })).length, 0);
  assert.equal((await db('SecurityIncident').where({ id: ids[1] })).length, 1, 'unresolved old incident is kept');
  assert.equal((await db('SecurityIncident').where({ id: ids[2] })).length, 1);
  assert.equal(fn.securityIncidentRetention.rule, '05 3 * * *');
});

test('account deletion: the incident stays as an anonymised record (reason cleared), the SecurityEvent goes, the check-in is not touched', async () => {
  const admin = await makeAdmin(['security_incidents']);
  const m = await makeUser(); const ev = await makeEvent(m.id);
  const id = (await report(m.id, ev, { secureAccount: false })).body.incident.id;
  await run(fn.adminResolveSecurityIncident, { token: admin.token, params: { id }, body: { outcome: 'inconclusive', reason: 'Spoke to Report Member on the phone.' } });
  assert.ok((await db('SecurityIncident').where({ id }).first()).resolutionReason);
  const del = await run(deleteMyAccount, { token: bearer(m.id) });
  assert.equal(del.statusCode, 200, JSON.stringify(del.body));
  assert.equal((await db('SecurityEvent').where({ id: ev })).length, 0);
  const kept = await db('SecurityIncident').where({ id }).first();
  assert.ok(kept, 'incident kept for its retention period');
  assert.equal(kept.resolutionReason, null);
  assert.equal(kept.outcome, 'inconclusive');
  assert.equal(kept.snapshot.gymName, 'Report Gym');
  assert.ok((await db('SecurityIncidentEvent').where({ incidentId: id })).length >= 2, 'trail intact');
});

test('staff alert email: ops-alerts job is registered without any B2B flag; email has ids and gym name only', async () => {
  assert.ok(opsService.jobNames().includes('ops-alerts'));
  assert.equal(typeof jobs.opsAlerts.onJob, 'function');
  const m = await makeUser(); const ev = await makeEvent(m.id, { gymName: 'Mikocheni Gym' });
  const id = (await report(m.id, ev)).body.incident.id;
  const sent = [];
  const watch = createB2BWatchService({
    db, emailSender: () => ({ configured: true, send: async (to, mail) => { sent.push({ to, ...mail }); return { ok: true }; } }),
    recipients: () => ['owner@example.test', 'support@example.test'],
  });
  const stats = await watch.sendAlerts();
  assert.ok(stats.sent >= 1, JSON.stringify(stats));
  assert.deepEqual([...new Set(sent.map(s => s.to))].sort(), ['owner@example.test', 'support@example.test']);
  const text = sent.map(s => `${s.subject}\n${s.text}`).join('\n');
  assert.match(text, new RegExp(id));
  assert.match(text, /Mikocheni Gym/);
  assert.doesNotMatch(text, new RegExp(`${m.id}|Report Member|4821|${m.personId}`));
  assert.equal((await db('OpsException').where({ dedupeKey: `security_incident:${id}` }).first()).severity, 'high');
});

test('web check-in security event service still lists with the old shape when reports are off', async () => {
  const m = await makeUser(); await makeEvent(m.id);
  delete process.env.SECURITY_INCIDENT_REPORTS;
  const out = await securityEventService.list({ userId: m.id });
  assert.equal(out.reportEnabled, false);
  assert.equal(out.events[0].report, null);
});
