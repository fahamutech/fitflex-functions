// Marathon & running events · S5 — what the participant sees (spec §4.6), flags-off identity with S4, and the two migrations (up, down, fail-closed).
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ensureInit } from '../functions/index.mjs';
import { getEventTicket, listMyEventTickets, resetEventsPaymentLimits } from '../functions/events-payments.mjs';
import { organizerCollectKit, organizerAssignBib, resetEventsOpsLimits } from '../functions/events-ops.mjs';
import { harness, s5On, s5Off, db, uid } from './fixtures/events-s5.mjs';

const require = createRequire(import.meta.url);
await ensureInit();
const h = harness();
const { call } = h;
afterEach(() => { resetEventsPaymentLimits(); resetEventsOpsLimits(); s5Off(); });
after(async () => { await h.cleanup(); await db.destroy(); });

const ticketOf = (f, i = 0) => call(getEventTicket, h.claimsOf(f.regs[i].userId), { params: { id: f.regs[i].id } });

test('EVENTS_KIT_OPS off: the ticket answer is EXACTLY the S4 one (scanning false, the stored kit state, no bib / collection-point keys)', async () => {
  s5On({ kit: false });
  const f = await h.kitEvent({ n: 1 });
  const r = await ticketOf(f);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.scanning, false);
  assert.deepEqual(r.body.kit, { state: 'not_ready' });
  assert.ok(!('bibNumber' in r.body) && !('collectionPoints' in r.body));
  const list = await call(listMyEventTickets, h.claimsOf(f.regs[0].userId), {});
  assert.deepEqual(list.body.items[0].kit, { state: 'not_ready' });
  assert.ok(!('bibNumber' in list.body.items[0]));
});

test('EVENTS_KIT_OPS on: scanning true while the event hands out a kit and is open; the COMPUTED kit state (ready), where and when to collect (public data only); the bib; collected details after the handover', async () => {
  s5On();
  const f = await h.kitEvent({ n: 1 });
  const r = await ticketOf(f);
  assert.equal(r.body.scanning, true);
  assert.deepEqual(r.body.kit, { state: 'ready' }, 'no backfill: ready is computed from a confirmed place, an active ticket and a kit to hand out');
  assert.equal(r.body.bibNumber, null);
  assert.deepEqual(r.body.collectionPoints.map(p => p.name).sort(), ['Hotel desk', 'Main kit tent']);
  assert.deepEqual(Object.keys(r.body.collectionPoints[0]).sort(), ['address', 'id', 'instructions', 'lat', 'lng', 'name', 'windows']);
  assert.deepEqual(r.body.collectionPoints[0].instructions, { en: 'Bring ID', sw: 'Lete kitambulisho' });
  assert.equal(r.body.collectionPoints[0].windows.length, 1);
  // a bib appears at once, in the same answer and in the list
  assert.equal((await call(organizerAssignBib, f.organizer.ops, { params: { id: f.event.id }, headers: { 'Idempotency-Key': `pb_${uid('').slice(1)}` }, body: { registrationId: f.regs[0].id, bibNumber: '1042' } })).status, 201);
  assert.equal((await ticketOf(f)).body.bibNumber, '1042');
  assert.equal((await call(listMyEventTickets, h.claimsOf(f.regs[0].userId), {})).body.items[0].bibNumber, '1042');
  // handed over: the state, when and where; the code stays
  await call(organizerCollectKit, f.organizer.ops, { params: { id: f.event.id }, headers: { 'Idempotency-Key': `pk_${uid('').slice(1)}` }, body: { method: 'scan', payload: f.regs[0].payload, collectionPointId: f.points[1].id } });
  const after_ = (await ticketOf(f)).body;
  assert.deepEqual([after_.kit.state, after_.kit.collectionPointName, Boolean(after_.kit.collectedAt)], ['collected', 'Hotel desk', true]);
  assert.ok(after_.token && after_.qrPayload, 'the QR stays after collection');
  // a staff-recorded exception reads as "not ready" to the participant (they are told to ask the organizer)
  await db('EventRegistration').where({ id: f.regs[0].id }).update({ kitStatus: 'exception' });
  assert.equal((await ticketOf(f)).body.kit.state, 'not_ready');
});

test('scanning is false when the event has no kit, is not open for it, or is cancelled; the ticket of a place that is not paid has no kit', async () => {
  s5On();
  const noKit = await h.kitEvent({ n: 1, eventOver: { kitProvided: false } });
  const a = await ticketOf(noKit);
  assert.deepEqual([a.body.scanning, a.body.kit.state], [false, 'not_ready']);
  const done = await h.kitEvent({ n: 1 });
  await db('Event').where({ id: done.event.id }).update({ status: 'completed' });
  assert.equal((await ticketOf(done)).body.scanning, false);
  const cancelled = await h.kitEvent({ n: 1 });
  await db('Event').where({ id: cancelled.event.id }).update({ status: 'cancelled', cancelledAt: new Date() });
  assert.equal((await ticketOf(cancelled)).body.scanning, false);
});

test('MIGRATIONS: up → down → up on an empty module restores the S4 shape exactly; every kind of S5 data makes `down` FAIL CLOSED with a reason', async () => {
  const m1 = require('../db/migrations/20270124090000-events-ops-s5.cjs');
  const m2 = require('../db/migrations/20270124090100-events-integrations-s5.cjs');
  const ROLLBACK = Symbol('rollback');
  const inRollback = async fn => { try { await db.transaction(async (trx) => { await fn(trx); throw ROLLBACK; }); } catch (err) { if (err !== ROLLBACK) throw err; } };
  const cols = async (trx, table) => (await trx.raw(`SELECT column_name FROM information_schema.columns WHERE table_name = ? ORDER BY 1`, [table])).rows.map(r => r.column_name);
  await inRollback(async (trx) => {
    for (const t of ['OrganizerIdempotency', 'ApiClientUsageDay', 'WebhookDeliveryAttempt']) assert.equal(await trx.schema.hasTable(t), true);
    // make the module empty INSIDE the transaction (rolled back afterwards)
    for (const t of ['WebhookDeliveryAttempt', 'WebhookDelivery', 'WebhookEndpoint', 'ApiClientUsageDay', 'OrganizerIdempotency', 'EventKitCollection', 'EventBibAssignment']) await trx(t).del();
    await trx('ApiClient').del(); await trx('OutboxEvent').del(); await trx('Event').update({ payoutSchedule: null }); await trx('EventOrganizer').update({ apiAccessEnabledAt: null });
    const before = { ev: await cols(trx, 'Event'), kc: await cols(trx, 'EventKitCollection'), ob: await cols(trx, 'OutboxEvent'), ac: await cols(trx, 'ApiClient'), we: await cols(trx, 'WebhookEndpoint'), wd: await cols(trx, 'WebhookDelivery') };
    await m2.down(trx); await m1.down(trx);
    assert.ok(!(await cols(trx, 'Event')).includes('payoutSchedule') && !(await cols(trx, 'OutboxEvent')).includes('seq') && !(await cols(trx, 'ApiClient')).includes('secretVersion'));
    assert.equal(await trx.schema.hasTable('OrganizerIdempotency'), false);
    assert.equal(await trx.schema.hasTable('WebhookDeliveryAttempt'), false);
    assert.ok(!(await cols(trx, 'EventOrganizer')).includes('apiAccessEnabledAt'));
    await m1.up(trx); await m2.up(trx);
    assert.deepEqual({ ev: await cols(trx, 'Event'), kc: await cols(trx, 'EventKitCollection'), ob: await cols(trx, 'OutboxEvent'), ac: await cols(trx, 'ApiClient'), we: await cols(trx, 'WebhookEndpoint'), wd: await cols(trx, 'WebhookDelivery') }, before);
  });
  // fail closed, one blocker at a time
  s5On();
  const f = await h.kitEvent({ n: 1 });
  const blockers = {
    'a payout schedule is set': trx => trx('Event').where({ id: f.event.id }).update({ payoutSchedule: 'monthly' }),
    'S5 kit collections exist': trx => trx('EventKitCollection').insert({ id: uid('ekc'), registrationId: f.regs[0].id, eventId: f.event.id, status: 'collected', method: 'manual', manualReason: 'other' }),
    'idempotency rows exist': trx => trx('OrganizerIdempotency').insert({ id: uid('oid'), scopeType: 'staff', scopeId: 'u', key: 'blocker-key-1', route: 'r', fingerprint: 'f', state: 'in_progress', expiresAt: new Date() }),
    'published outbox rows exist': trx => trx('OutboxEvent').where({ eventId: f.event.id }).update({ publishedAt: new Date() }),
  };
  for (const [why, plant] of Object.entries(blockers)) {
    await inRollback(async (trx) => {
      await trx('OrganizerIdempotency').del();
      await plant(trx);
      await assert.rejects(trx.transaction(sp => m1.down(sp)), err => err.message.includes('fails closed') && err.message.includes(why), why);
    });
  }
  await inRollback(async (trx) => {
    const c = await h.apiClient(f.organizer, {});
    void c;
    await assert.rejects(trx.transaction(sp => m2.down(sp)), err => err.message.includes('fails closed') && err.message.includes('API clients exist'));
    await trx('EventOrganizer').where({ id: f.organizer.id }).update({ apiAccessEnabledAt: new Date() });
    await trx('ApiClient').del();
    await assert.rejects(trx.transaction(sp => m2.down(sp)), err => err.message.includes('organizers are enabled for the API'));
  });
  // constraints
  await inRollback(async (trx) => {
    await assert.rejects(trx.transaction(sp => sp('EventKitCollection').insert({ id: uid('ekc'), registrationId: f.regs[0].id, eventId: f.event.id, status: 'exception', method: 'telepathy' })), err => err.code === '23514');
    await assert.rejects(trx.transaction(sp => sp('WebhookDeliveryAttempt').insert({ id: uid('wda'), endpointId: 'nope', outcome: 'success' })), err => ['23503', '23514'].includes(err.code));
    await assert.rejects(trx.transaction(sp => sp('ApiClient').insert({ id: uid('acl'), ownerType: 'organizer', ownerId: f.organizer.id, clientId: uid('ffc'), secretHash: 'h', rateLimitPerMinute: 601 })), err => err.code === '23514');
    await assert.rejects(trx.transaction(sp => sp('OrganizerIdempotency').insert({ id: uid('oid'), scopeType: 'staff', scopeId: 'u', key: 'short', route: 'r', fingerprint: 'f', state: 'in_progress', expiresAt: new Date() })), err => err.code === '23514');
  });
});
