// Marathon & running events · S7 (B3) — analytics counters, the roll-up, the launch dashboard and the alert rules
// (docs/design/events-s7-hardening-and-pilot.md §5, D77, D78). Everything is dormant behind EVENTS_ANALYTICS.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureInit } from '../functions/index.mjs';
import { postEventsAnalytics, resetEventsAnalyticsLimits } from '../functions/events-analytics.mjs';
import { adminEventsHealth, adminGetEvent } from '../functions/events-admin.mjs';
import { eventsOptions } from '../functions/events-public.mjs';
import { harness, s7On, s7Off, db } from './fixtures/events-s7.mjs';
import { eventsAnalyticsService, opsService } from '../src/bootstrap/services.mjs';
import { createEventsAnalyticsService } from '../src/services/events-analytics-service.mjs';
import { shapeEvent, counterFromAudit, darDay, ANALYTICS_EVENTS } from '../src/shared/events-analytics-rules.mjs';
import { noteApiError } from '../src/shared/events-api-error.mjs';
import { fakeOutbox } from '../src/infra/verification-senders.mjs';

await ensureInit();
const h = harness();
const { call } = h;
afterEach(async () => { resetEventsAnalyticsLimits(); s7Off(); await db('EventAnalyticsDaily').del(); await db('AnalyticsRollupCursor').del(); await db('AuditLog').where('action', 'like', 'analytics.%').del(); });
after(async () => { await h.cleanup(); await db.destroy(); });

const member = async () => h.claimsOf(await h.user({ phone: `+2557${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}` }));
const rows = (where = {}) => db('EventAnalyticsDaily').where(where).orderBy(['name', 'dimsKey']);
const total = async (name, eventId = null) => Number((await db('EventAnalyticsDaily').where({ name }).modify(q => { if (eventId) q.where({ eventId }); }).sum({ n: 'count' }).first()).n || 0);
const post = (claims, events, over = {}) => call(postEventsAnalytics, claims, { body: { events }, ...over });

test('flag off: the endpoint and the health tab answer 404, track() writes nothing, options says disabled', async () => {
  s7On({ analytics: false });
  const f = await h.kitEvent({ n: 1 });
  assert.equal((await post(await member(), [{ name: 'event_list_viewed', props: {} }])).status, 404);
  assert.equal((await call(adminEventsHealth, await h.superAdmin(), { query: {} })).status, 404);
  assert.equal(await eventsAnalyticsService.track('order_created', { mode: 'member' }, { eventId: f.event.id }), false);
  assert.equal((await rows()).length, 0);
  const opts = await call(eventsOptions, null, {});
  assert.equal(opts.body.analytics.enabled, false);
});

test('flag on: options says enabled; an anonymous caller is refused by the member guard', async () => {
  s7On({ analytics: true });
  assert.equal((await call(eventsOptions, null, {})).body.analytics.enabled, true);
  assert.equal((await post(null, [{ name: 'event_list_viewed', props: {} }])).status, 401);
});

test('the allowlist: unknown names and keys are dropped, values outside a closed set become "other", counts are bucketed, PII-like props never reach a row', async () => {
  s7On({ analytics: true });
  const f = await h.kitEvent({ n: 1 });
  const evt = f.event.id;
  const out = await post(await member(), [
    { name: 'event_list_viewed', props: { filters: 5, results: 12, platform: 'android', phone: '+255712000111', email: 'a@b.c' } },
    { name: 'checkout_quote_created', props: { eventId: evt, mode: 'group', places: 4, totalTzs: 20000, orderId: 'eor_x', placesCount: 4 } },
    { name: 'checkout_quote_created', props: { eventId: evt, mode: '<script>', places: 99 } },
    { name: 'payment_state_seen', props: { eventId: evt, state: 'confirmed', method: 'manual', late: false, reference: 'QGH12345' } },
    { name: 'order_created', props: { eventId: evt } },                 // a SERVER name: refused from the app
    { name: 'totally_unknown', props: {} },
    { name: 'event_detail_viewed', props: { eventId: 'no-such-event', availability: 'open', platform: 'web' } },
  ]);
  assert.equal(out.status, 202, JSON.stringify(out.body));
  assert.deepEqual(out.body, { accepted: 4, dropped: 3 });
  const all = await rows();
  const flat = JSON.stringify(all);
  for (const leak of ['255712000111', 'a@b.c', 'QGH12345', 'eor_x', '20000', 'script']) assert.ok(!flat.includes(leak), `${leak} must not be stored`);
  const list = all.find(r => r.name === 'event_list_viewed');
  assert.deepEqual(list.dims, { filters: '2+', results: '6-20', platform: 'android' });
  const quotes = all.filter(r => r.name === 'checkout_quote_created');
  assert.deepEqual(quotes.map(q => q.dims).sort((a, b) => a.mode.localeCompare(b.mode)), [{ mode: 'group', places: '2-5' }, { mode: 'other', places: '6+' }]);
  assert.ok(quotes.every(q => q.eventId === evt));
  // The table has no column that could identify the caller.
  const cols = (await db.raw(`select column_name from information_schema.columns where table_name = 'EventAnalyticsDaily'`)).rows.map(r => r.column_name);
  assert.deepEqual(cols.sort(), ['count', 'day', 'dims', 'dimsKey', 'eventId', 'id', 'name', 'updatedAt']);
});

test('the same counter is incremented, not duplicated; the day is the Dar es Salaam day', async () => {
  s7On({ analytics: true });
  const claims = await member();
  for (let i = 0; i < 3; i += 1) await post(claims, [{ name: 'event_list_viewed', props: { filters: 0, results: 0, platform: 'ios' } }]);
  const r = await rows({ name: 'event_list_viewed' });
  assert.equal(r.length, 1);
  assert.equal(Number(r[0].count), 3);
  assert.equal(darDay('2026-11-01T21:30:00Z'), '2026-11-02');   // 00:30 EAT on the 2nd
  assert.equal(darDay('2026-11-01T20:59:00Z'), '2026-11-01');
});

test('limits: more than 20 events is 413, props above 8 keys drops the event, a body above 4 KB is 413, 60 requests a minute', async () => {
  s7On({ analytics: true });
  const claims = await member();
  const twentyOne = Array.from({ length: 21 }, () => ({ name: 'ticket_opened', props: {} }));
  assert.equal((await post(claims, twentyOne)).status, 413);
  const fat = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 1]));
  const dropped = await post(claims, [{ name: 'event_list_viewed', props: fat }]);
  assert.deepEqual(dropped.body, { accepted: 0, dropped: 1 });
  const big = await post(claims, [{ name: 'event_list_viewed', props: { platform: 'x'.repeat(5000) } }]);
  assert.equal(big.status, 413);
  assert.equal((await call(postEventsAnalytics, claims, { body: { events: 'nope' } })).status, 400);
  let last;
  for (let i = 0; i < 62; i += 1) last = await post(claims, [{ name: 'ticket_opened', props: {} }].map(e => ({ ...e, props: {} })));
  assert.equal(last.status, 429);
});

test('track(): server-side increments obey the allowlist and the increment n; an unknown name is refused', async () => {
  s7On({ analytics: true });
  const f = await h.kitEvent({ n: 1 });
  assert.equal(await eventsAnalyticsService.track('kit_offline_bib_exception', { reason: 'taken', secret: 'x' }, { eventId: f.event.id, n: 3 }), true);
  assert.equal(await eventsAnalyticsService.track('kit_offline_bib_exception', { reason: 'weird' }, { eventId: f.event.id }), true);
  assert.equal(await eventsAnalyticsService.track('nope', {}), false);
  assert.equal(await total('kit_offline_bib_exception', f.event.id), 4);
  const r = await rows({ name: 'kit_offline_bib_exception' });
  assert.deepEqual(r.map(x => x.dims.reason).sort(), ['other', 'taken']);
  assert.ok(!JSON.stringify(r).includes('secret'));
});

test('the rules module: audit rows map to counters; ids, amounts and place counts are dropped; ticket_issued counts tickets', () => {
  const c = counterFromAudit('analytics.payment_confirmed', { orderId: 'eor_1', eventId: 'evt_abcd', method: 'provider', source: 'admin', rehold: false });
  assert.deepEqual(c, { name: 'payment_confirmed', eventId: 'evt_abcd', dims: { method: 'mobile_money' }, n: 1 });
  assert.deepEqual(counterFromAudit('analytics.ticket_issued', { eventId: 'evt_abcd', count: 3 }).n, 3);
  assert.equal(counterFromAudit('analytics.order_created', { eventId: 'evt_abcd', orderId: 'eor_1', placesCount: 2, totalTzs: 10, mode: 'corporate', team: false }).dims.mode, 'corporate');
  assert.equal(counterFromAudit('analytics.no_such_thing', {}), null);
  assert.equal(counterFromAudit('analytics.event_list_viewed', {}), null);   // app names are not rolled up from audit rows
  assert.equal(shapeEvent({ name: 'event_detail_viewed', props: { availability: 'open' } }, { from: 'app' }), null, 'an app event without an event id is dropped');
  assert.ok(Object.keys(ANALYTICS_EVENTS).includes('kit_offline_invalid_burst'));
});

test('roll-up: audit rows become counters EXACTLY ONCE across reruns; the cursor survives; rows with nothing to count still advance it', async () => {
  s7On({ analytics: true });
  const f = await h.kitEvent({ n: 1 });
  const minutesAgo = m => new Date(Date.now() - m * 60_000);
  let when = minutesAgo(10);
  const mk = (name, after) => ({ id: `aud_${randomUUID().slice(0, 12)}`, at: when, actor: 'system', action: `analytics.${name}`, target: f.event.id, before: null, after: JSON.stringify(after) });
  await db('AuditLog').insert([
    mk('order_created', { eventId: f.event.id, orderId: 'eor_a', placesCount: 1, totalTzs: 20000, mode: 'member', team: false }),
    mk('order_created', { eventId: f.event.id, orderId: 'eor_b', placesCount: 2, totalTzs: 40000, mode: 'member', team: false }),
    mk('payment_confirmed', { eventId: f.event.id, orderId: 'eor_a', method: 'manual', source: 'admin', rehold: false }),
    mk('ticket_issued', { eventId: f.event.id, count: 2 }),
    mk('something_unmapped', { eventId: f.event.id }),
  ]);
  const first = await eventsAnalyticsService.rollup();
  assert.ok(first.rows >= 5);
  const second = await eventsAnalyticsService.rollup();
  assert.equal(second.rows, 0, 'a rerun reads nothing new');
  assert.equal(await total('order_created', f.event.id), 2);
  assert.equal(await total('payment_confirmed', f.event.id), 1);
  assert.equal(await total('ticket_issued', f.event.id), 2);
  // New rows after the cursor are counted once more, the old ones are not counted again.
  when = minutesAgo(5);
  await db('AuditLog').insert([mk('order_created', { eventId: f.event.id, orderId: 'eor_c', mode: 'member' })]);
  await eventsAnalyticsService.rollup();
  await eventsAnalyticsService.rollup();
  assert.equal(await total('order_created', f.event.id), 3);
  // Two overlapping roll-ups cannot double count (the cursor row is locked).
  when = minutesAgo(4);
  await db('AuditLog').insert([mk('order_created', { eventId: f.event.id, orderId: 'eor_d', mode: 'member' })]);
  await Promise.all([eventsAnalyticsService.rollup(), eventsAnalyticsService.rollup()]);
  assert.equal(await total('order_created', f.event.id), 4);
});

test('roll-up leaves rows younger than the lag for the next run (a row is stamped before it commits)', async () => {
  s7On({ analytics: true });
  const f = await h.kitEvent({ n: 1 });
  await db('AuditLog').insert({ id: `aud_${randomUUID().slice(0, 12)}`, at: new Date(), actor: 'system', action: 'analytics.order_created', target: f.event.id, before: null, after: JSON.stringify({ eventId: f.event.id, mode: 'member' }) });
  await eventsAnalyticsService.rollup();
  assert.equal(await total('order_created', f.event.id), 0, 'a row from this very second is not read yet');
  await eventsAnalyticsService.rollup({ lagSeconds: 0 });
  assert.equal(await total('order_created', f.event.id), 1);
});

test('purge deletes counters older than the keep days and keeps the rest', async () => {
  s7On({ analytics: true });
  process.env.EVENTS_ANALYTICS_KEEP_DAYS = '30';
  const old = darDay(new Date(Date.now() - 40 * 86_400_000));
  await db('EventAnalyticsDaily').insert([
    { id: 'ead_old', day: old, name: 'event_list_viewed', dimsKey: '', dims: '{}', count: 1 },
    { id: 'ead_new', day: darDay(new Date()), name: 'event_list_viewed', dimsKey: 'x=1', dims: '{}', count: 1 },
  ]);
  const svc = createEventsAnalyticsService({ db, keepDays: () => 30 });
  assert.deepEqual(await svc.purge(), { deleted: 1 });
  assert.deepEqual((await rows()).map(r => r.id), ['ead_new']);
});

test('health: shape, per-group isolation, payments only with the payments scope, 404 for an unknown event, 400 for a bad period', async () => {
  s7On({ analytics: true });
  const f = await h.kitEvent({ n: 2 });
  await eventsAnalyticsService.track('event_list_viewed', { filters: 0, results: 3, platform: 'web' });
  await eventsAnalyticsService.track('event_list_viewed', { filters: 0, results: 3, platform: 'web' });
  await eventsAnalyticsService.track('order_created', { mode: 'member' }, { eventId: f.event.id });
  const admin = await h.superAdmin();
  const ok = await call(adminEventsHealth, admin, { query: { days: '7' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  for (const key of ['generatedAt', 'setup', 'funnel', 'payments', 'refunds', 'webhooks', 'kit', 'results', 'rewards', 'waitlist', 'jobs', 'errors', 'alerts']) assert.ok(key in ok.body, key);
  assert.equal(ok.body.funnel.find(x => x.name === 'event_list_viewed').count, 2);
  assert.equal(ok.body.funnel.find(x => x.name === 'order_created').count, 1);
  assert.equal(ok.body.kit.confirmed >= 2, true);
  assert.equal(ok.body.setup.flags.analytics, true);
  assert.equal(ok.body.setup.alertsConfigured, false);
  assert.ok(ok.body.jobs.some(j => j.name === 'event-analytics-rollup'));
  const eventsOnly = await call(adminEventsHealth, { sub: admin.sub, userType: 'admin', portalUser: true, aclPermissions: ['events'] }, { query: {} });
  assert.equal(eventsOnly.status, 200);
  assert.ok(!('payments' in eventsOnly.body), 'payments block needs the payments scope');
  const noScope = await call(adminEventsHealth, { sub: admin.sub, userType: 'admin', portalUser: true, aclPermissions: ['users'] }, { query: {} });
  assert.equal(noScope.status, 403);
  assert.equal((await call(adminEventsHealth, admin, { query: { eventId: 'evt_nothere' } })).status, 404);
  assert.equal((await call(adminEventsHealth, admin, { query: { days: '3' } })).status, 400);
  assert.equal((await call(adminGetEvent, admin, { params: { id: f.event.id } })).status, 200, 'the fixed path did not break /admin/events/:id');
});

test('health: one group failing does not take the others down', async () => {
  const svc = createEventsAnalyticsService({ db: new Proxy(db, { apply: (t, th, a) => { if (a[0] === 'Refund') throw new Error('boom'); return t(...a); } }), enabled: () => true });
  const out = await svc.health({ days: 1, scopes: [] });
  assert.deepEqual(out.refunds, { error: 'unavailable' });
  assert.ok(Array.isArray(out.funnel));
});

test('alert A1 (manual payment overdue): fires from the table, is shown on the Health tab even with no recipients, and sends nothing without OPS_ALERT_EMAILS', async () => {
  s7On({ analytics: true });
  const f = await h.kitEvent({ n: 1 });
  const orderId = f.regs[0].orderId;
  await db('EventPayment').insert({
    id: `epy_${randomUUID().slice(0, 12)}`, orderId, provider: 'manual', merchantReference: `mr_${randomUUID().slice(0, 10)}`, amountTzs: 20000, currency: 'TZS', status: 'pending', method: 'manual',
    submittedAt: new Date(Date.now() - 30 * 3_600_000), eventId: f.event.id, organizerId: f.organizer.id, idempotencyKey: `k_${randomUUID()}`, createdAt: new Date(), updatedAt: new Date(),
  });
  const list = await eventsAnalyticsService.evaluateAlerts();
  const a1 = list.find(a => a.rule === 'A1' && a.subject === f.event.id);
  assert.ok(a1, JSON.stringify(list));
  assert.deepEqual(a1.counts, { waiting: 1, thresholdHours: 24 });
  const health = await call(adminEventsHealth, await h.superAdmin(), { query: {} });
  assert.ok(health.body.alerts.some(a => a.rule === 'A1'));
  const run = await eventsAnalyticsService.runAlerts();
  assert.equal(run.sent, 0);
  assert.equal(run.reason, 'no_recipients');
  await db('EventPayment').where({ orderId }).del();
});

test('alerts email once per (rule, subject) per 6 hours, ids and counts only', async () => {
  const sent = [];
  const at = { t: Date.now() };
  const svc = createEventsAnalyticsService({
    db, now: () => new Date(at.t), enabled: () => true, recipients: () => ['ops@example.test'], emailSender: () => ({ configured: true, send: async (to, m) => { sent.push({ to, ...m }); return { ok: true }; } }),
    jobStatus: async () => [{ name: 'event-hold-expiry', schedule: { type: 'every', minutes: 5 }, lastSuccessAt: new Date(at.t - 60 * 60_000), paused: false }],
    jobFlags: { 'event-hold-expiry': () => true },
  });
  const first = await svc.runAlerts();
  assert.ok(first.sent >= 1, JSON.stringify(first));
  const a5 = sent.find(m => m.subject.includes('A5'));
  assert.ok(a5, JSON.stringify(sent));
  assert.ok(a5.subject.startsWith('[FitFlex events]'));
  assert.ok(/runbook R1/.test(a5.text));
  const n = sent.length;
  await svc.runAlerts();
  assert.equal(sent.length, n, 'no repeat inside 6 hours');
  at.t += 7 * 3_600_000;
  await svc.runAlerts();
  assert.ok(sent.length > n, 'sent again after 6 hours');
  await db('AuditLog').where({ action: 'events.alerts_sent' }).del();
});

test('alert A5 ignores a job whose flag is off, and a paused job', async () => {
  const svc = createEventsAnalyticsService({
    db, enabled: () => true,
    jobStatus: async () => [
      { name: 'event-waitlist-promote', schedule: { type: 'every', minutes: 1 }, lastSuccessAt: null, paused: false },
      { name: 'event-lifecycle', schedule: { type: 'every', minutes: 5 }, lastSuccessAt: null, paused: true },
    ],
    jobFlags: { 'event-waitlist-promote': () => false, 'event-lifecycle': () => true },
  });
  assert.deepEqual((await svc.evaluateAlerts()).filter(a => a.rule === 'A5'), []);
});

test('api_error: a 5xx or 429 answer is counted by group and class; a 404 is not; flag off counts nothing', async () => {
  s7On({ analytics: true });
  noteApiError('kit', 500);
  noteApiError('kit', 429);
  noteApiError('kit', 404);
  noteApiError('payment', 503);
  await new Promise(r => setTimeout(r, 200));
  const r = await rows({ name: 'api_error' });
  assert.deepEqual(r.map(x => `${x.dims.group}:${x.dims.class}:${x.count}`).sort(), ['kit:429:1', 'kit:5xx:1', 'payment:5xx:1']);
  s7Off(); s7On({ analytics: false });
  noteApiError('kit', 500);
  await new Promise(r2 => setTimeout(r2, 100));
  assert.equal((await rows({ name: 'api_error' })).length, 3);
});

test('jobs: the two S7 jobs return at once with the flag off, run with it on, and event jobs are hidden from the job list while EVENTS_MODULE is off (H15)', async () => {
  s7Off();
  const off = await opsService.runJob('event-analytics-rollup', { trigger: 'manual', actorId: 'spec' });
  assert.equal(off.stats.skipped, 'flag_off');
  assert.equal((await opsService.runJob('event-health-alert', { trigger: 'manual', actorId: 'spec' })).stats.skipped, 'flag_off');
  assert.ok(!(await opsService.jobStatus()).some(j => j.name.startsWith('event-')), 'no event job is listed while the module is off');
  s7On({ analytics: true });
  const on = await opsService.runJob('event-analytics-rollup', { trigger: 'manual', actorId: 'spec' });
  assert.equal(on.stats.skipped, undefined);
  const listed = (await opsService.jobStatus()).find(j => j.name === 'event-analytics-rollup');
  assert.ok(listed, 'listed once the module is on');
  assert.ok(listed.lastSuccessAt, 'a quiet job with nothing to do still leaves a heartbeat, so alert A5 does not fire for it');
  await db('JobControl').where({ job: 'event-analytics-rollup' }).del();
  void fakeOutbox;
});
