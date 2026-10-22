// Marathon & running events · S1 — the Postgres store against the CI database: the hold primitive under
// concurrency, idempotent order placement, idempotent commit / release, hold expiry, the outbox written
// in the same transaction, compare-and-set edits, and the flag-gated job.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { createPgEventStore, movementKeyOf, referenceOf } from '../src/infra/event-store-pg.mjs';
import { eventStore, opsService } from '../src/bootstrap/services.mjs';
import { eventHoldExpiry } from '../functions/jobs.mjs';

const uid = p => `${p}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
const made = { users: [], organizers: [], events: [] };
const store = createPgEventStore({ db });

after(async () => {
  delete process.env.EVENTS_MODULE;
  // Children first; every event-scoped row hangs off the events made here.
  await db('OutboxEvent').whereIn('eventId', made.events).del();
  const orderIds = (await db('EventOrder').whereIn('eventId', made.events).select('id')).map(r => r.id);
  await db('EventInventoryMovement').whereIn('orderId', orderIds).del();
  await db('EventRegistration').whereIn('orderId', orderIds).del();
  await db('EventOrderLine').whereIn('orderId', orderIds).del();
  await db('EventOrder').whereIn('id', orderIds).del();
  await db('EventTicketType').whereIn('eventId', made.events).del();
  await db('EventCategory').whereIn('eventId', made.events).del();
  await db('Event').whereIn('id', made.events).del();
  await db('EventOrganizer').whereIn('id', made.organizers).del();
  await db('User').whereIn('id', made.users).del();
  await db('JobRun').where({ job: 'event-hold-expiry' }).del();
  await db.destroy();
});

async function user() {
  const id = uid('usr');
  await db('User').insert({ id, userType: 'member', displayName: 'Store runner', updatedAt: new Date() });
  made.users.push(id);
  return id;
}

/** A published event with one category and one active ticket type. */
async function fixture({ capacity = 10, priceTzs = 30000, ticketType = {}, event = {} } = {}) {
  const ownerUserId = await user();
  const organizer = await store.createOrganizer({ ownerUserId, name: 'Dar Runners', status: 'active' });
  made.organizers.push(organizer.id);
  const created = await store.createEvent({
    organizerId: organizer.id, slug: `dar-half-${uid('').slice(1, 9)}`, title: 'Dar Half Marathon', eventType: 'road',
    startsAt: new Date('2027-03-06T04:00:00Z'), endsAt: new Date('2027-03-06T10:00:00Z'), ...event,
  });
  assert.equal(created.error, undefined, JSON.stringify(created));
  made.events.push(created.id);
  if (!event.status) {
    assert.equal((await store.transitionEvent(created.id, 'submitted')).to, 'submitted');
    assert.equal((await store.transitionEvent(created.id, 'published')).to, 'published');
  }
  const category = await store.createCategory({ eventId: created.id, name: '21K', distanceMeters: 21097 });
  assert.equal(category.error, undefined, JSON.stringify(category));
  const tt = await store.createTicketType({ eventId: created.id, categoryId: category.id, name: 'Early bird', priceTzs, capacity, ...ticketType });
  assert.equal(tt.error, undefined, JSON.stringify(tt));
  return { ownerUserId, organizer, event: await store.getEvent(created.id), category, ticketType: tt };
}

const participant = (ticketTypeId, i = 0, extra = {}) => ({ ticketTypeId, firstName: `Runner${i}`, lastName: 'Juma', phone: '+255700000001', consentBasis: 'self', ...extra });
const participants = (ticketTypeId, n) => Array.from({ length: n }, (_, i) => participant(ticketTypeId, i));
const counters = async id => { const r = await db('EventTicketType').where({ id }).first('sold', 'held', 'capacity'); return { sold: r.sold, held: r.held, capacity: r.capacity }; };
const outboxFor = (eventId, type = null) => db('OutboxEvent').where({ eventId }).modify(q => { if (type) q.where({ type }); }).orderBy('createdAt');

test('createOrderWithHolds: holds the places, prices from the snapshot, writes order, lines, registrations and hold movements', async () => {
  const f = await fixture({ capacity: 10, priceTzs: 30000 });
  const buyer = await user();
  const r = await store.createOrderWithHolds({ eventId: f.event.id, purchaserUserId: buyer, lines: [{ ticketTypeId: f.ticketType.id, quantity: 2 }], participants: participants(f.ticketType.id, 2), holdTtlMinutes: 30 });
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(r.replayed, false);
  assert.equal(r.order.status, 'awaiting_payment');
  assert.equal(r.order.holdCycle, 1);
  assert.equal(r.order.reference, referenceOf(r.order.id));
  assert.match(r.order.reference, /^EV-[0-9A-F]{10}$/);
  assert.ok(r.order.holdExpiresAt, 'hold expiry set');
  assert.deepEqual([r.order.subtotalTzs, r.order.discountTzs, r.order.feesTzs, r.order.totalTzs], [60000, 0, 0, 60000]);
  assert.equal(r.order.priceSnapshot.ticketTypes[0].priceTzs, 30000);
  assert.equal(r.lines.length, 1);
  assert.deepEqual([r.lines[0].quantity, r.lines[0].unitPriceTzs, r.lines[0].lineTotalTzs], [2, 30000, 60000]);
  assert.equal(r.registrations.length, 2);
  assert.ok(r.registrations.every(x => x.status === 'reserved' && x.orderLineId === r.lines[0].id && x.categoryId === f.category.id && x.purchaserUserId === buyer));
  assert.deepEqual(await counters(f.ticketType.id), { sold: 0, held: 2, capacity: 10 });
  const movements = await store.movementsOf(r.order.id);
  assert.equal(movements.length, 1);
  assert.deepEqual([movements[0].kind, movements[0].quantity, movements[0].cycle, movements[0].movementKey], ['hold', 2, 1, movementKeyOf(r.order.id, 1, 'hold', f.ticketType.id)]);
  // The live price moving does not touch the order.
  assert.ok(await store.updateTicketType(f.ticketType.id, { priceTzs: 99000 }));
  const again = await store.getOrder(r.order.id);
  assert.equal(again.order.totalTzs, 60000);
  assert.equal(again.order.priceSnapshot.ticketTypes[0].priceTzs, 30000);
  assert.equal((await outboxFor(f.event.id)).length, 0, 'no outbox row until the order is decided');
});

test('createOrderWithHolds: refusals are results — roster mismatch, sale window, per-order limits, unpublished event, unknown ticket type', async () => {
  const f = await fixture({ capacity: 10, ticketType: { minPerOrder: 1, maxPerOrder: 3 } });
  const buyer = await user();
  const place = (over = {}) => store.createOrderWithHolds({ eventId: f.event.id, purchaserUserId: buyer, lines: [{ ticketTypeId: f.ticketType.id, quantity: 2 }], participants: participants(f.ticketType.id, 2), ...over });
  assert.deepEqual(await place({ participants: participants(f.ticketType.id, 1) }), { error: 'participants_mismatch', status: 400, expected: 2, received: 1 });
  assert.equal((await place({ participants: [participant(f.ticketType.id, 0), participant(f.ticketType.id, 1, { consentBasis: 'parent' })] })).error, 'invalid_participant');
  assert.equal((await place({ participants: [participant(f.ticketType.id, 0), participant(f.ticketType.id, 1, { lastName: ' ' })] })).error, 'invalid_participant');
  assert.equal((await place({ lines: [{ ticketTypeId: f.ticketType.id, quantity: 4 }], participants: participants(f.ticketType.id, 4) })).error, 'quantity_out_of_range');
  assert.equal((await place({ lines: [{ ticketTypeId: f.ticketType.id, quantity: 0 }], participants: [] })).error, 'invalid_quantity');
  assert.equal((await place({ lines: [{ ticketTypeId: 'ett_nope', quantity: 1 }], participants: participants('ett_nope', 1) })).error, 'ticket_type_not_found');
  assert.equal((await place({ lines: [], participants: [] })).error, 'invalid_lines');
  assert.equal((await place({ eventId: 'evt_nope' })).error, 'event_not_found');
  assert.ok(await store.updateTicketType(f.ticketType.id, { saleClosesAt: new Date(Date.now() - 60_000) }));
  assert.equal((await place()).error, 'sale_closed');
  assert.ok(await store.updateTicketType(f.ticketType.id, { saleClosesAt: null, saleOpensAt: new Date(Date.now() + 3_600_000) }));
  assert.equal((await place()).error, 'sale_not_open');
  assert.ok(await store.updateTicketType(f.ticketType.id, { saleOpensAt: null, status: 'inactive' }));
  assert.equal((await place()).error, 'ticket_type_inactive');
  assert.ok(await store.updateTicketType(f.ticketType.id, { status: 'active' }, { expectedStatus: 'inactive' }));
  assert.equal(await store.updateTicketType(f.ticketType.id, { status: 'active' }, { expectedStatus: 'inactive' }), null, 'compare-and-set refuses once moved on');
  assert.deepEqual(await counters(f.ticketType.id), { sold: 0, held: 0, capacity: 10 }, 'nothing was held by any refusal');
  const draft = await fixture({ event: { status: 'draft' } });
  assert.deepEqual(await store.createOrderWithHolds({ eventId: draft.event.id, purchaserUserId: buyer, lines: [{ ticketTypeId: draft.ticketType.id, quantity: 1 }], participants: participants(draft.ticketType.id, 1) }), { error: 'event_not_open', status: 409, eventStatus: 'draft' });
});

test('concurrency: two orders for the last place — exactly one succeeds, sold + held never exceeds capacity', async () => {
  const f = await fixture({ capacity: 1 });
  const [a, b] = await Promise.all([user(), user()]);
  const place = buyer => store.createOrderWithHolds({ eventId: f.event.id, purchaserUserId: buyer, lines: [{ ticketTypeId: f.ticketType.id, quantity: 1 }], participants: participants(f.ticketType.id, 1) });
  const results = await Promise.all([place(a), place(b)]);
  const won = results.filter(r => !r.error);
  const lost = results.filter(r => r.error);
  assert.equal(won.length, 1, JSON.stringify(results));
  assert.equal(lost.length, 1);
  assert.deepEqual(lost[0], { error: 'capacity_unavailable', status: 409, ticketTypeId: f.ticketType.id });
  assert.deepEqual(await counters(f.ticketType.id), { sold: 0, held: 1, capacity: 1 });
  assert.equal((await db('EventOrder').where({ eventId: f.event.id }).count({ n: '*' }))[0].n, '1');
  assert.equal((await db('EventInventoryMovement').whereIn('orderId', db('EventOrder').where({ eventId: f.event.id }).select('id')).count({ n: '*' }))[0].n, '1');
  // Ten more at once for a bigger pool: the counters still add up.
  const g = await fixture({ capacity: 4 });
  const buyers = await Promise.all(Array.from({ length: 10 }, user));
  const many = await Promise.all(buyers.map(buyer => store.createOrderWithHolds({ eventId: g.event.id, purchaserUserId: buyer, lines: [{ ticketTypeId: g.ticketType.id, quantity: 1 }], participants: participants(g.ticketType.id, 1) })));
  assert.equal(many.filter(r => !r.error).length, 4);
  assert.equal(many.filter(r => r.error === 'capacity_unavailable').length, 6);
  assert.deepEqual(await counters(g.ticketType.id), { sold: 0, held: 4, capacity: 4 });
});

test('idempotency: same key + same fingerprint replays the order; a different fingerprint is refused; two at once make one order', async () => {
  const f = await fixture({ capacity: 10 });
  const buyer = await user();
  const key = `checkout-${uid('').slice(1, 13)}`;
  const place = (fingerprint, over = {}) => store.createOrderWithHolds({ eventId: f.event.id, purchaserUserId: buyer, lines: [{ ticketTypeId: f.ticketType.id, quantity: 1 }], participants: participants(f.ticketType.id, 1), idempotencyKey: key, fingerprint, ...over });
  const first = await place('fp-1');
  assert.equal(first.error, undefined, JSON.stringify(first));
  const replayed = await place('fp-1');
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.order.id, first.order.id);
  assert.deepEqual(await place('fp-2'), { error: 'idempotency_key_reused', status: 409 });
  assert.deepEqual(await counters(f.ticketType.id), { sold: 0, held: 1, capacity: 10 }, 'a replay holds nothing more');
  assert.deepEqual(await place('fp-1', { idempotencyKey: 'short' }), { error: 'invalid_idempotency_key', status: 400 });
  assert.deepEqual(await place(null, { idempotencyKey: `other-${uid('').slice(1, 9)}` }), { error: 'invalid_idempotency_key', status: 400 });
  // The same key arriving twice at the same moment: one order, both callers see it.
  const key2 = `checkout-${uid('').slice(1, 13)}`;
  const pair = await Promise.all([place('fp-3', { idempotencyKey: key2 }), place('fp-3', { idempotencyKey: key2 })]);
  assert.ok(pair.every(r => !r.error), JSON.stringify(pair));
  assert.equal(pair[0].order.id, pair[1].order.id);
  assert.equal(pair.filter(r => r.replayed).length, 1);
  assert.deepEqual(await counters(f.ticketType.id), { sold: 0, held: 2, capacity: 10 });
  // Without a purchaser the key is not honoured (the unique index is per purchaser): two separate orders.
  const guest = () => store.createOrderWithHolds({ eventId: f.event.id, purchaserUserId: null, lines: [{ ticketTypeId: f.ticketType.id, quantity: 1 }], participants: participants(f.ticketType.id, 1), idempotencyKey: key, fingerprint: 'fp-1' });
  const g1 = await guest();
  const g2 = await guest();
  assert.notEqual(g1.order.id, g2.order.id);
  assert.equal(g1.order.idempotencyKey, null);
});

test('commitOrder: held → sold once, registrations confirmed, one outbox row per registration; a second commit is a no-op', async () => {
  const f = await fixture({ capacity: 5 });
  const buyer = await user();
  const placed = await store.createOrderWithHolds({ eventId: f.event.id, purchaserUserId: buyer, lines: [{ ticketTypeId: f.ticketType.id, quantity: 3 }], participants: participants(f.ticketType.id, 3) });
  assert.equal(placed.error, undefined);
  const committed = await store.commitOrder(placed.order.id);
  assert.equal(committed.error, undefined, JSON.stringify(committed));
  assert.equal(committed.changed, true);
  assert.equal(committed.order.status, 'confirmed');
  assert.equal(committed.order.holdExpiresAt, null);
  assert.ok(committed.order.confirmedAt);
  assert.ok(committed.registrations.every(r => r.status === 'confirmed'));
  assert.deepEqual(await counters(f.ticketType.id), { sold: 3, held: 0, capacity: 5 });
  const outbox = await outboxFor(f.event.id);
  assert.equal(outbox.length, 3);
  assert.ok(outbox.every(o => o.type === 'registration.created' && o.aggregateType === 'registration' && o.organizerId === f.organizer.id && o.publishedAt === null));
  assert.deepEqual(outbox.map(o => o.aggregateId).sort(), committed.registrations.map(r => r.id).sort());
  assert.equal(outbox[0].payload.orderId, placed.order.id);
  const second = await store.commitOrder(placed.order.id);
  assert.equal(second.changed, false);
  assert.equal(second.order.status, 'confirmed');
  const movements = await store.movementsOf(placed.order.id);
  assert.deepEqual(movements.map(m => m.kind), ['hold', 'commit'], 'one commit movement');
  assert.equal((await outboxFor(f.event.id)).length, 3, 'no new outbox rows on the replayed commit');
  assert.deepEqual(await counters(f.ticketType.id), { sold: 3, held: 0, capacity: 5 });
  // Releasing after commit is refused: the places are sold, money goes back through refunds.
  const refused = await store.releaseOrder(placed.order.id, 'cancelled');
  assert.equal(refused.error, 'invalid_transition');
  assert.equal(refused.status, 409);
  assert.deepEqual([refused.from, refused.to, refused.allowed], ['confirmed', 'cancelled', []]);
  assert.deepEqual(await counters(f.ticketType.id), { sold: 3, held: 0, capacity: 5 });
  assert.deepEqual(await store.commitOrder('eor_missing'), { error: 'order_not_found', status: 404 });
});

test('releaseOrder: held given back once, order cancelled, registrations cancelled, outbox written; commit afterwards is refused', async () => {
  const f = await fixture({ capacity: 5 });
  const buyer = await user();
  const placed = await store.createOrderWithHolds({ eventId: f.event.id, purchaserUserId: buyer, lines: [{ ticketTypeId: f.ticketType.id, quantity: 2 }], participants: participants(f.ticketType.id, 2) });
  const released = await store.releaseOrder(placed.order.id, 'purchaser_cancelled');
  assert.equal(released.error, undefined, JSON.stringify(released));
  assert.equal(released.changed, true);
  assert.equal(released.order.status, 'cancelled');
  assert.equal(released.order.closeReason, 'purchaser_cancelled');
  assert.ok(released.registrations.every(r => r.status === 'cancelled' && r.cancelReason === 'purchaser_cancelled'));
  assert.deepEqual(await counters(f.ticketType.id), { sold: 0, held: 0, capacity: 5 });
  const outbox = await outboxFor(f.event.id, 'registration.cancelled');
  assert.equal(outbox.length, 2);
  const again = await store.releaseOrder(placed.order.id, 'purchaser_cancelled');
  assert.equal(again.changed, false);
  assert.deepEqual((await store.movementsOf(placed.order.id)).map(m => m.kind), ['hold', 'release']);
  assert.deepEqual(await counters(f.ticketType.id), { sold: 0, held: 0, capacity: 5 });
  const late = await store.commitOrder(placed.order.id);
  assert.equal(late.error, 'invalid_transition');
  assert.deepEqual([late.from, late.to, late.allowed], ['cancelled', 'confirmed', []]);
  // 'expired' as the reason makes the order expired.
  const other = await store.createOrderWithHolds({ eventId: f.event.id, purchaserUserId: buyer, lines: [{ ticketTypeId: f.ticketType.id, quantity: 1 }], participants: participants(f.ticketType.id, 1) });
  assert.equal((await store.releaseOrder(other.order.id, 'expired')).order.status, 'expired');
});

test('expireHolds: releases only overdue awaiting_payment orders, is idempotent, and skips an order being committed', async () => {
  const f = await fixture({ capacity: 10 });
  const buyer = await user();
  const place = ttl => store.createOrderWithHolds({ eventId: f.event.id, purchaserUserId: buyer, lines: [{ ticketTypeId: f.ticketType.id, quantity: 1 }], participants: participants(f.ticketType.id, 1), holdTtlMinutes: ttl });
  const short1 = await place(1);
  const short2 = await place(1);
  const long = await place(60);
  const paid = await place(1);
  assert.equal((await store.commitOrder(paid.order.id)).changed, true);
  assert.deepEqual(await counters(f.ticketType.id), { sold: 1, held: 3, capacity: 10 });
  const at = new Date(Date.now() + 5 * 60_000);
  const first = await store.expireHolds({ at });
  assert.deepEqual(first, { due: 2, released: 2, skipped: 0 });
  assert.equal((await store.getOrder(short1.order.id)).order.status, 'expired');
  assert.equal((await store.getOrder(short2.order.id)).order.status, 'expired');
  assert.equal((await store.getOrder(long.order.id)).order.status, 'awaiting_payment');
  assert.equal((await store.getOrder(paid.order.id)).order.status, 'confirmed');
  assert.deepEqual(await counters(f.ticketType.id), { sold: 1, held: 1, capacity: 10 });
  assert.deepEqual(await store.expireHolds({ at }), { due: 0, released: 0, skipped: 0 });
  assert.equal((await outboxFor(f.event.id, 'registration.cancelled')).length, 2);
  // An overdue order locked by another transaction is skipped, not waited for.
  const locked = await place(1);
  await db.transaction(async (trx) => {
    await trx('EventOrder').where({ id: locked.order.id }).forUpdate().first();
    assert.deepEqual(await store.expireHolds({ at }), { due: 1, released: 0, skipped: 1 });
  });
  assert.deepEqual(await store.expireHolds({ at }), { due: 1, released: 1, skipped: 0 });
});

test('outbox atomicity: a failure after the inventory moved leaves nothing behind — no movement, no counter change, no outbox row', async () => {
  const f = await fixture({ capacity: 5 });
  const buyer = await user();
  const placed = await store.createOrderWithHolds({ eventId: f.event.id, purchaserUserId: buyer, lines: [{ ticketTypeId: f.ticketType.id, quantity: 2 }], participants: participants(f.ticketType.id, 2) });
  const failing = createPgEventStore({ db, hooks: { afterCommitMovements: async () => { throw new Error('simulated crash before the outbox'); } } });
  await assert.rejects(failing.commitOrder(placed.order.id), /simulated crash/);
  assert.deepEqual(await counters(f.ticketType.id), { sold: 0, held: 2, capacity: 5 });
  assert.deepEqual((await store.movementsOf(placed.order.id)).map(m => m.kind), ['hold']);
  assert.equal((await outboxFor(f.event.id)).length, 0);
  const current = await store.getOrder(placed.order.id);
  assert.equal(current.order.status, 'awaiting_payment');
  assert.ok(current.registrations.every(r => r.status === 'reserved'));
  // The real commit then goes through whole.
  const committed = await store.commitOrder(placed.order.id);
  assert.equal(committed.changed, true);
  assert.deepEqual(await counters(f.ticketType.id), { sold: 2, held: 0, capacity: 5 });
  assert.equal((await outboxFor(f.event.id, 'registration.created')).length, 2);
  // appendOutbox refuses a malformed envelope before any SQL.
  await assert.rejects(db.transaction(trx => store.appendOutbox(trx, { type: 'x.y', aggregateType: 'registration' })), /aggregateId/);
});

test('organizer and event edits: compare-and-set versions and lifecycle refusals', async () => {
  const f = await fixture({ event: { status: 'draft' } });
  assert.equal(f.event.version, 1);
  const edited = await store.updateEvent(f.event.id, { title: 'Dar Half Marathon 2027', venueName: 'Coco Beach' }, { expectedVersion: 1 });
  assert.equal(edited.event.version, 2);
  assert.equal(edited.event.title, 'Dar Half Marathon 2027');
  assert.deepEqual(await store.updateEvent(f.event.id, { title: 'Stale' }, { expectedVersion: 1 }), { error: 'version_conflict', status: 409, eventId: f.event.id });
  assert.deepEqual(await store.updateEvent('evt_nope', { title: 'x' }, { expectedVersion: 1 }), { error: 'event_not_found', status: 404 });
  assert.equal((await store.updateEvent(f.event.id, { title: 'x' }, {})).error, 'expected_version_required');
  // Status is not editable through updateEvent; it moves through transitionEvent along ORG-006.
  const skipped = await store.transitionEvent(f.event.id, 'published');
  assert.deepEqual([skipped.error, skipped.from, skipped.to, skipped.allowed], ['invalid_transition', 'draft', 'published', ['submitted', 'archived']]);
  assert.equal((await store.transitionEvent(f.event.id, 'submitted')).event.status, 'submitted');
  const published = await store.transitionEvent(f.event.id, 'published');
  assert.equal(published.event.status, 'published');
  assert.ok(published.event.publishedAt);
  assert.equal(published.event.version, 4);
  const cancelled = await store.transitionEvent(f.event.id, 'cancelled');
  assert.ok(cancelled.event.cancelledAt);
  assert.equal((await store.transitionEvent(f.event.id, 'published')).error, 'invalid_transition');
  const dup = await store.createEvent({ organizerId: f.organizer.id, slug: f.event.slug, title: 'Dup', eventType: 'road', startsAt: new Date(), endsAt: new Date() });
  assert.deepEqual(dup, { error: 'slug_taken', status: 409, slug: f.event.slug });
  // Organizers along ORG-003.
  const org = await store.createOrganizer({ ownerUserId: f.ownerUserId, name: 'Kili Trails' });
  made.organizers.push(org.id);
  assert.equal(org.status, 'draft');
  assert.equal((await store.transitionOrganizer(org.id, 'active')).error, 'invalid_transition');
  assert.equal((await store.transitionOrganizer(org.id, 'pending_review')).organizer.status, 'pending_review');
  assert.deepEqual(await store.transitionOrganizer(org.id, 'rejected'), { error: 'reason_required', status: 400, to: 'rejected' });
  assert.equal((await store.transitionOrganizer(org.id, 'rejected', { reason: 'Permit missing' })).organizer.statusReason, 'Permit missing');
  assert.equal((await store.updateOrganizer(org.id, { commissionPct: 8 }, { fromStatus: 'active' })), null);
  assert.equal((await store.updateOrganizer(org.id, { commissionPct: 8 }, { fromStatus: 'rejected' })).commissionPct, 8);
  assert.deepEqual(await store.createOrganizer({ ownerUserId: f.ownerUserId }), { error: 'name_required', status: 400 });
  // A category of another event cannot carry this event's ticket type.
  const other = await fixture({ event: { status: 'draft' } });
  assert.equal((await store.createTicketType({ eventId: f.event.id, categoryId: other.category.id, name: 'x', priceTzs: 1, capacity: 1 })).error, 'category_not_in_event');
});

test('eventHoldExpiry job: does nothing while EVENTS_MODULE is off; releases overdue holds through ops-service when on', async () => {
  delete process.env.EVENTS_MODULE;
  const f = await fixture({ capacity: 5 });
  const buyer = await user();
  // A hold that lapsed a minute ago.
  const placed = await store.createOrderWithHolds({ eventId: f.event.id, purchaserUserId: buyer, lines: [{ ticketTypeId: f.ticketType.id, quantity: 1 }], participants: participants(f.ticketType.id, 1) });
  await db('EventOrder').where({ id: placed.order.id }).update({ holdExpiresAt: new Date(Date.now() - 60_000) });
  await db('JobRun').where({ job: 'event-hold-expiry' }).del();
  assert.equal(await eventHoldExpiry.onJob(), undefined);
  assert.equal((await store.getOrder(placed.order.id)).order.status, 'awaiting_payment', 'flag off: untouched');
  assert.equal((await db('JobRun').where({ job: 'event-hold-expiry' }).count({ n: '*' }))[0].n, '0', 'flag off: no run recorded');
  assert.ok(opsService.jobNames().includes('event-hold-expiry'));
  process.env.EVENTS_MODULE = 'on';
  try {
    const run = await opsService.runJob('event-hold-expiry', { trigger: 'manual', actorId: buyer });
    assert.equal(run.status, 'ok', JSON.stringify(run));
    assert.equal(run.stats.released, 1);
    assert.equal((await eventStore.getOrder(placed.order.id)).order.status, 'expired');
    assert.deepEqual(await counters(f.ticketType.id), { sold: 0, held: 0, capacity: 5 });
    await eventHoldExpiry.onJob();   // the cron wrapper runs the same job; nothing left to release
    assert.equal((await db('EventOrder').where({ eventId: f.event.id, status: 'expired' }).count({ n: '*' }))[0].n, '1');
  } finally {
    delete process.env.EVENTS_MODULE;
  }
});
