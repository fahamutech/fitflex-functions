// Marathon & running events · S5 — kit handover (spec §4.2, scenario 11: QR screenshot replay / repeated collection; scenario 12 primitives).
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ensureInit } from '../functions/index.mjs';
import { organizerCollectKit, organizerCorrectKit, organizerKitHistory, organizerKitSummary, organizerKitLookup, resetEventsOpsLimits } from '../functions/events-ops.mjs';
import { harness, s5On, s5Off, db, uid, eventually } from './fixtures/events-s5.mjs';

await ensureInit();
const h = harness();
const { call } = h;
afterEach(() => { resetEventsOpsLimits(); });
after(async () => { await h.cleanup(); await db.destroy(); });

const key = () => `kit_${uid('').slice(1)}`;
const collect = (claims, f, body, k = key()) => call(organizerCollectKit, claims, { params: { id: f.event.id }, headers: k === null ? {} : { 'Idempotency-Key': k }, body: { method: 'scan', collectionPointId: f.points[0].id, ...body } });
const rowsOf = id => db('EventKitCollection').where({ registrationId: id }).orderBy('createdAt');

test('scan handover: 201 with the card; one collected row; kitStatus, outbox, audit and the participant notice follow', async () => {
  s5On();
  const f = await h.kitEvent({ n: 1 });
  const r = await collect(f.organizer.ops, f, { payload: f.regs[0].payload });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.collection.status, r.body.collection.collectionPointId, r.body.card.kit.state], ['collected', f.points[0].id, 'collected']);
  const rows = await rowsOf(f.regs[0].id);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].status, rows[0].method, rows[0].offlineBatchId, rows[0].apiClientId], ['collected', 'scan', null, null]);
  assert.equal((await db('EventRegistration').where({ id: f.regs[0].id }).first()).kitStatus, 'collected');
  const out = await db('OutboxEvent').where({ eventId: f.event.id, type: 'kit.collected' });
  assert.equal(out.length, 1);
  assert.deepEqual(Object.keys(out[0].payload).sort(), ['collectedAt', 'collectionPointId', 'registrationId']);
  assert.equal((await db('AuditLog').where({ action: 'events.kit_collected', target: f.event.id })).length, 1);
  const note = await eventually(() => db('Notification').where({ userId: f.regs[0].userId, type: 'event_kit_collected' }));   // sent after the response, not awaited
  assert.equal(note.length, 1);
  assert.equal(note[0].data.titleSw, 'Vifaa vimechukuliwa');
  assert.ok(note[0].data.route.endsWith('/ticket'));
});

test('SCENARIO 11 — screenshot replay: the same payload again (same or another desk) is 409 already_collected with time, point and first name; no second row; ops cannot override', async () => {
  s5On();
  const f = await h.kitEvent({ n: 1 });
  assert.equal((await collect(f.organizer.ops, f, { payload: f.regs[0].payload })).status, 201);
  const again = await collect(f.organizer.admin, f, { payload: f.regs[0].payload });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'already_collected');
  assert.ok(again.body.collectedAt && again.body.collectionPointName === f.points[0].name);
  assert.equal(again.body.canOverride, true);
  assert.equal((await collect(f.organizer.ops, f, { payload: f.regs[0].payload })).body.canOverride, false);
  assert.equal((await rowsOf(f.regs[0].id)).length, 1);
  assert.equal((await db('OutboxEvent').where({ eventId: f.event.id, type: 'kit.collected' })).length, 1);
});

test('SCENARIO 11 — two desks scan the same ticket AT ONCE with different keys: exactly one collected row, the other 409 (never a 500)', async () => {
  s5On();
  const f = await h.kitEvent({ n: 1 });
  const [a, b, c] = await Promise.all([collect(f.organizer.ops, f, { payload: f.regs[0].payload }), collect(f.organizer.admin, f, { payload: f.regs[0].payload }), collect(f.organizer.owner, f, { payload: f.regs[0].payload })]);
  assert.deepEqual([a.status, b.status, c.status].sort(), [201, 409, 409]);
  assert.equal((await rowsOf(f.regs[0].id)).filter(r => r.status === 'collected').length, 1);
});

test('idempotency: same key and body → the original answer (200 + replayed); same key other body → 409 idempotency_key_reused; no key → 400; a validation error does not burn the key', async () => {
  s5On();
  const f = await h.kitEvent({ n: 2 });
  const k = key();
  const first = await collect(f.organizer.ops, f, { payload: f.regs[0].payload }, k);
  assert.equal(first.status, 201);
  const replay = await collect(f.organizer.ops, f, { payload: f.regs[0].payload }, k);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body.collection, first.body.collection);
  assert.equal((await rowsOf(f.regs[0].id)).length, 1, 'a replay never writes');
  assert.deepEqual((await collect(f.organizer.ops, f, { payload: f.regs[1].payload }, k)).body, { error: 'idempotency_key_reused' });
  assert.deepEqual((await collect(f.organizer.ops, f, { payload: f.regs[1].payload }, null)).body, { error: 'idempotency_key_required' });
  assert.deepEqual((await collect(f.organizer.ops, f, { payload: f.regs[1].payload }, 'short')).body, { error: 'invalid_idempotency_key' });
  const k2 = key();
  assert.equal((await collect(f.organizer.ops, f, { payload: f.regs[1].payload, status: 'exception' }, k2)).body.error, 'note_required');
  assert.equal((await collect(f.organizer.ops, f, { payload: f.regs[1].payload }, k2)).status, 201, 'the failed request left the key reusable');
});

test('manual handover: needs a reason code, an unpaid place is refused, a revoked ticket is refused; audited as events.kit_manual_collected', async () => {
  s5On();
  const f = await h.kitEvent({ n: 2 });
  const noReason = await collect(f.organizer.ops, f, { method: 'manual', registrationId: f.regs[0].id });
  assert.deepEqual([noReason.status, noReason.body.error], [422, 'manual_reason_required']);
  const ok = await collect(f.organizer.ops, f, { method: 'manual', registrationId: f.regs[0].id, manualReason: 'phone_lost' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual((await rowsOf(f.regs[0].id))[0].manualReason, 'phone_lost');
  assert.equal((await db('AuditLog').where({ action: 'events.kit_manual_collected', target: f.event.id })).length, 1);
  await db('EventRegistration').where({ id: f.regs[1].id }).update({ status: 'reserved' });
  assert.equal((await collect(f.organizer.ops, f, { method: 'manual', registrationId: f.regs[1].id, manualReason: 'no_signal' })).body.error, 'registration_unpaid');
  await db('EventRegistration').where({ id: f.regs[1].id }).update({ status: 'confirmed' });
  await db('EventTicket').where({ id: f.regs[1].ticketId }).update({ status: 'revoked', revokedAt: new Date(), revokeReason: 'cancelled' });
  const revoked = await collect(f.organizer.ops, f, { method: 'manual', registrationId: f.regs[1].id, manualReason: 'no_signal' });
  assert.deepEqual([revoked.status, revoked.body.error, revoked.body.reason], [409, 'ticket_revoked', 'cancelled']);
  assert.equal((await collect(f.organizer.ops, f, { method: 'manual', registrationId: 'ereg_missing', manualReason: 'other' })).body.error, 'registration_not_found');
});

test('a revoked or cancelled ticket cannot be collected on a scan either (ticket_revoked); a registration cancelled AFTER collection reads revoked at verify', async () => {
  s5On();
  const f = await h.kitEvent({ n: 2 });
  await db('EventTicket').where({ id: f.regs[0].ticketId }).update({ status: 'revoked', revokedAt: new Date(), revokeReason: 'refunded' });
  const r = await collect(f.organizer.ops, f, { payload: f.regs[0].payload });
  assert.deepEqual([r.status, r.body.error, r.body.reason], [409, 'ticket_revoked', 'refunded']);
  assert.equal((await rowsOf(f.regs[0].id)).length, 0);
  assert.equal((await collect(f.organizer.ops, f, { payload: 'FFEV1:garbage' })).body.error, 'not_event_ticket');
  assert.equal((await collect(f.organizer.ops, f, { payload: f.regs[1].payload })).status, 201);
});

test('collection point rules: required when the event has points, must belong to the event; the wrong event\'s ticket is not found; event states', async () => {
  s5On();
  const f = await h.kitEvent({ n: 1 });
  const other = await h.kitEvent({ organizer: f.organizer, n: 1 });
  assert.equal((await call(organizerCollectKit, f.organizer.ops, { params: { id: f.event.id }, headers: { 'Idempotency-Key': key() }, body: { method: 'scan', payload: f.regs[0].payload } })).body.error, 'collection_point_required');
  assert.equal((await collect(f.organizer.ops, f, { payload: f.regs[0].payload, collectionPointId: other.points[0].id })).body.error, 'collection_point_invalid');
  assert.equal((await collect(f.organizer.ops, f, { payload: other.regs[0].payload })).body.error, 'registration_not_found', 'a ticket of another event of mine is not found here');
  await db('Event').where({ id: f.event.id }).update({ status: 'completed' });
  assert.deepEqual((await collect(f.organizer.ops, f, { payload: f.regs[0].payload })).body.error, 'event_not_open');
  await db('Event').where({ id: f.event.id }).update({ status: 'cancelled', cancelledAt: new Date() });
  assert.deepEqual((await collect(f.organizer.ops, f, { payload: f.regs[0].payload })).body.error, 'event_cancelled');
});

test('corrections: ops cannot (403); owner void → corrected row + superseded row exception + kitStatus ready, no kit.collected re-sent; recollect → new collected row; reason ≥ 10; double correction refused', async () => {
  s5On();
  const f = await h.kitEvent({ n: 2 });
  const first = await collect(f.organizer.ops, f, { payload: f.regs[0].payload });
  const id = first.body.collection.id;
  const fix = (claims, body, k = key()) => call(organizerCorrectKit, claims, { params: { id: f.event.id, collectionId: id }, headers: { 'Idempotency-Key': k }, body });
  assert.deepEqual([(await fix(f.organizer.ops, { action: 'void', reason: 'wrong person collected it' })).status, (await fix(f.organizer.ops, { action: 'void', reason: 'wrong person collected it' })).body.error], [403, 'forbidden_role']);
  assert.deepEqual([(await fix(f.organizer.admin, { action: 'void', reason: 'short' })).status, (await fix(f.organizer.admin, { action: 'void', reason: 'short' })).body.error], [422, 'reason_required']);
  assert.equal((await fix(f.organizer.admin, { action: 'delete', reason: 'long enough reason' })).status, 422);
  const voided = await fix(f.organizer.admin, { action: 'void', reason: 'collected by the wrong person' });
  assert.equal(voided.status, 200, JSON.stringify(voided.body));
  const rows = await rowsOf(f.regs[0].id);
  assert.deepEqual(rows.map(r => r.status).sort(), ['corrected', 'exception']);
  assert.equal(rows.find(r => r.status === 'corrected').supersedesId, id);
  assert.equal((await db('EventRegistration').where({ id: f.regs[0].id }).first()).kitStatus, 'ready');
  assert.equal((await db('OutboxEvent').where({ eventId: f.event.id, type: 'kit.collected' })).length, 1, 'void does not re-send kit.collected');
  assert.equal((await db('OutboxEvent').where({ eventId: f.event.id, type: 'registration.updated' })).length, 1);
  assert.equal((await fix(f.organizer.admin, { action: 'void', reason: 'collected by the wrong person' })).body.error, 'already_corrected');
  // after a void the place can be handed over again
  const again = await collect(f.organizer.ops, f, { payload: f.regs[0].payload });
  assert.equal(again.status, 201);
  const id2 = again.body.collection.id;
  const re = await call(organizerCorrectKit, f.organizer.owner, { params: { id: f.event.id, collectionId: id2 }, headers: { 'Idempotency-Key': key() }, body: { action: 'recollect', reason: 'kit was lost, issuing a replacement' } });
  assert.equal(re.status, 200, JSON.stringify(re.body));
  assert.ok(re.body.corrected.newCollectionId);
  const live = (await rowsOf(f.regs[0].id)).filter(r => r.status === 'collected');
  assert.equal(live.length, 1);
  assert.equal(live[0].id, re.body.corrected.newCollectionId);
  assert.equal((await db('EventRegistration').where({ id: f.regs[0].id }).first()).kitStatus, 'collected');
  assert.equal((await db('AuditLog').where({ action: 'events.kit_corrected', target: f.event.id })).length, 2);
  // a collection of another event is not found
  const g = await h.kitEvent({ n: 1 });
  assert.equal((await call(organizerCorrectKit, g.organizer.owner, { params: { id: g.event.id, collectionId: id }, headers: { 'Idempotency-Key': key() }, body: { action: 'void', reason: 'not my collection at all' } })).body.error, 'collection_not_found');
});

test('exception handover needs a note and does not use up the one collected slot; history, summary and masked lookup', async () => {
  s5On();
  const f = await h.kitEvent({ n: 3 });
  const exc = await collect(f.organizer.ops, f, { payload: f.regs[0].payload, status: 'exception', note: 'bag torn, ask the organizer' });
  assert.equal(exc.status, 201);
  assert.equal((await db('EventRegistration').where({ id: f.regs[0].id }).first()).kitStatus, 'exception');
  assert.equal((await collect(f.organizer.ops, f, { payload: f.regs[0].payload })).status, 201, 'an exception does not block the real handover');
  assert.equal((await collect(f.organizer.ops, f, { payload: f.regs[1].payload, collectionPointId: f.points[1].id })).status, 201);
  const hist = await call(organizerKitHistory, f.organizer.ops, { params: { id: f.event.id }, query: { status: 'collected' } });
  assert.equal(hist.body.items.length, 2);
  assert.ok(hist.body.items.every(i => /^\S+ \S\.$/.test(i.displayName)));
  assert.deepEqual(Object.keys(hist.body.items[0]).sort().filter(k => /phone|email/i.test(k)), []);
  const sum = await call(organizerKitSummary, f.organizer.ops, { params: { id: f.event.id } });
  assert.deepEqual([sum.body.confirmed, sum.body.collected, sum.body.remaining], [3, 2, 1]);
  assert.equal(sum.body.byCollectionPoint.length, 2);
  const look = await call(organizerKitLookup, f.organizer.ops, { params: { id: f.event.id }, query: { q: f.regs[2].firstName.slice(0, 4) } });
  assert.equal(look.status, 200);
  assert.ok(look.body.items.length >= 1 && look.body.items.length <= 10);
  assert.ok(!JSON.stringify(look.body).includes(f.regs[2].lastName), 'masked: first name and last initial only');
  assert.equal((await call(organizerKitLookup, f.organizer.ops, { params: { id: f.event.id }, query: { q: 'ab' } })).body.error, 'query_too_short');
  assert.equal((await call(organizerKitLookup, f.organizer.timing, { params: { id: f.event.id }, query: { q: 'amina' } })).status, 403);
  const byCode = await call(organizerKitLookup, f.organizer.ops, { params: { id: f.event.id }, query: { q: f.regs[2].displayCode } });
  assert.equal(byCode.body.items[0].registrationId, f.regs[2].id);
  const byId = await call(organizerKitLookup, f.organizer.ops, { params: { id: f.event.id }, query: { q: f.regs[2].id } });
  assert.equal(byId.body.items[0].card.payment, 'paid');
  // an unpaid place appears only for its exact id, never in a name search
  await db('EventRegistration').where({ id: f.regs[2].id }).update({ status: 'reserved' });
  assert.equal((await call(organizerKitLookup, f.organizer.ops, { params: { id: f.event.id }, query: { q: f.regs[2].id } })).body.items[0].card.payment, 'unpaid');
  assert.equal((await call(organizerKitLookup, f.organizer.ops, { params: { id: f.event.id }, query: { q: f.regs[2].firstName.slice(0, 5) } })).body.items.some(i => i.registrationId === f.regs[2].id), false);
});

test('SCENARIO 12 (primitives for S7): a second collected insert fails on the partial unique; offlineBatchId stays null; the duplicate answer carries the first collection', async () => {
  s5On();
  const f = await h.kitEvent({ n: 1 });
  const first = await collect(f.organizer.ops, f, { payload: f.regs[0].payload });
  await assert.rejects(db('EventKitCollection').insert({ id: uid('ekc'), registrationId: f.regs[0].id, eventId: f.event.id, status: 'collected', collectedAt: new Date() }), err => err.code === '23505' && /collected_unique/.test(err.constraint));
  const dup = await collect(f.organizer.admin, f, { payload: f.regs[0].payload });
  assert.equal(dup.body.collectedAt, first.body.collection.collectedAt);
  assert.equal(dup.body.collectionPointName, f.points[0].name);
  assert.equal((await rowsOf(f.regs[0].id))[0].offlineBatchId, null);
});
