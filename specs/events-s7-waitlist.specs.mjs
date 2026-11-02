// Marathon & running events · S7 (B2) — the waitlist: joining, the queue gate, the promoter, offers as real orders, reconciliation, abuse limits,
// organizer and admin controls (docs/design/events-s7-hardening-and-pilot.md §4, D70 to D76). Dormant behind EVENTS_WAITLIST.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { ensureInit } from '../functions/index.mjs';
import {
  joinEventWaitlist, listMyEventWaitlist, leaveMyEventWaitlist, reconfirmMyEventWaitlist, organizerWaitlistCounts, organizerWaitlistToggle, organizerWaitlistClose,
  adminEventWaitlist, adminRemoveWaitlistEntry, resetEventsWaitlistLimits,
} from '../functions/events-waitlist.mjs';
import { createEventOrder, listMyEventOrders, resetEventsRegistrationLimits } from '../functions/events-registration.mjs';
import { eventDetail, eventsOptions } from '../functions/events-public.mjs';
import { harness, s7On, s7Off, db, uid, eventually, H } from './fixtures/events-s7.mjs';
import { saveManualDetails, clearManualDetails } from './fixtures/events-s4.mjs';
import { eventsWaitlistService, eventStore, opsService } from '../src/bootstrap/services.mjs';
import { eventsConsentTextVersion } from '../src/shared/events-config.mjs';

await ensureInit();
const h = harness();
const { call } = h;
before(async () => { await saveManualDetails(); });
afterEach(() => { resetEventsWaitlistLimits(); resetEventsRegistrationLimits(); s7Off(); });
after(async () => { await clearManualDetails(); await h.cleanup(); await db.destroy(); });

const NAMES = [['Asha', 'Mollel'], ['Baraka', 'Juma'], ['Cosmas', 'Nyerere'], ['Dotto', 'Kweka'], ['Eva', 'Abdallah'], ['Fatma', 'Mushi'], ['Gabo', 'Lyimo']];
let seq = 0;
async function member({ verified = true } = {}) {
  const phone = `+25575${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
  const [firstName, lastName] = NAMES[seq++ % NAMES.length];
  const id = await h.user({ phone, verified, name: `${firstName} ${lastName}` });
  return { id, claims: h.claimsOf(id), phone, firstName, lastName };
}
const self = m => ({ firstName: m.firstName, lastName: m.lastName, phone: m.phone, consentBasis: 'self' });
/** A published event whose only ticket type is full (capacity `capacity`, all sold). */
async function soldOutEvent({ capacity = 1, price = 20000, over = {} } = {}) {
  const f = await h.kitEvent({ n: 0, categories: [{ name: '10K', distanceMeters: 10000, tickets: [{ name: 'Early', priceTzs: price, capacity }] }], ...over });
  const regs = await h.addRegistrations({ eventId: f.event.id, ticketType: f.ticket, n: capacity });
  return { ...f, filler: regs };
}
const joinBody = (f, m, over = {}) => ({ ticketTypeId: f.ticket.id, participants: [self(m)], consent: { accepted: true, textVersion: eventsConsentTextVersion() }, ...over });
const join = (f, m, over = {}) => call(joinEventWaitlist, m.claims, { params: { id: f.event.id }, body: joinBody(f, m, over) });
const entryOf = id => db('EventWaitlistEntry').where({ id }).first();
const free = async (f, n = 1) => db('EventTicketType').where({ id: f.ticket.id }).update({ capacity: db.raw('capacity + ?', [n]) });
const ttRow = f => db('EventTicketType').where({ id: f.ticket.id }).first();
const orderBody = (f, m, over = {}) => ({
  eventId: f.event.id, lines: [{ ticketTypeId: f.ticket.id, quantity: 1 }], participants: [{ ticketTypeId: f.ticket.id, ...self(m) }],
  acceptedTerms: true, consentTextVersion: eventsConsentTextVersion(), expectedTotalTzs: 20000, ...over,
});
const buy = (f, m, over = {}) => call(createEventOrder, m.claims, { headers: { 'Idempotency-Key': `buy_${uid('').slice(1)}` }, body: orderBody(f, m, over) });

test('flag off: every waitlist route is 404 feature_disabled; ticket types carry no waitlist key; nothing gates a purchase; options says disabled', async () => {
  s7On({ waitlist: false });
  const f = await soldOutEvent({ capacity: 2 });
  const m = await member();
  for (const [route, params] of [[joinEventWaitlist, { id: f.event.id }], [listMyEventWaitlist, {}], [leaveMyEventWaitlist, { id: 'x' }], [organizerWaitlistCounts, { id: f.event.id }]]) {
    assert.equal((await call(route, route === organizerWaitlistCounts ? f.organizer.owner : m.claims, { params, body: {} })).status, 404, route.path);
  }
  const detail = await call(eventDetail, null, { params: { idOrSlug: f.event.id } });
  assert.ok(!('waitlist' in detail.body));
  assert.ok(detail.body.categories[0].ticketTypes.every(t => !('waitlist' in t)));
  assert.equal((await call(eventsOptions, null, {})).body.waitlist.enabled, false);
  await free(f);
  await db('EventWaitlistEntry').count(); // table exists, empty
  const bought = await buy(f, m);
  assert.equal(bought.status, 201, JSON.stringify(bought.body));
});

test('join: 201 with the position; the second member is second; the detail shows the state "open" and old builds see "sold_out"; the joined notice is in-app only', async () => {
  s7On({ waitlist: true });
  const f = await soldOutEvent();
  const a = await member(); const b = await member();
  const ja = await join(f, a);
  assert.equal(ja.status, 201, JSON.stringify(ja.body));
  assert.deepEqual([ja.body.entry.status, ja.body.entry.position, ja.body.entry.priceTzs, ja.body.entry.ticketTypeName], ['waiting', 1, 20000, 'Early']);
  const jb = await join(f, b);
  assert.equal(jb.body.entry.position, 2);
  const detail = await call(eventDetail, null, { params: { idOrSlug: f.event.id } });
  assert.deepEqual(detail.body.waitlist, { enabled: true });
  assert.equal(detail.body.categories[0].ticketTypes[0].waitlist.state, 'open');
  assert.equal(detail.body.categories[0].ticketTypes[0].availability, 'sold_out');
  assert.equal(detail.body.availability, 'sold_out');
  const mine = await call(listMyEventWaitlist, a.claims, {});
  assert.equal(mine.body.items.length, 1);
  assert.deepEqual([mine.body.items[0].status, mine.body.items[0].position, mine.body.items[0].eventTitle], ['waiting', 1, 'Dar Half Marathon']);
  assert.deepEqual([mine.body.items[0].ticketTypeId, mine.body.items[0].priceTzs, mine.body.items[0].currency, mine.body.items[0].utcOffsetMinutes, mine.body.items[0].timezoneAbbr], [f.ticket.id, 20000, 'TZS', 180, 'EAT']);
  assert.ok(mine.body.serverTime);
  assert.ok(!JSON.stringify(mine.body).includes('queueLength'));
  const note = await eventually(() => db('Notification').where({ userId: a.id, type: 'event_waitlist_joined' }));
  assert.equal(note.length, 1);
  assert.match(note[0].data.titleSw, /orodha ya kusubiri/);
  assert.equal((await call(eventsOptions, null, {})).body.waitlist.enabled, true);
  assert.equal((await db('EventWaitlistEntry').where({ id: ja.body.entry.id }).first()).quantity, 1);
});

test('join refusals, in the spec order: not sold out, unavailable (closed / payments off), verification, consent, validation, already registered, limits', async () => {
  s7On({ waitlist: true });
  const open = await h.kitEvent({ n: 0 });
  const m = await member();
  assert.deepEqual([(await join(open, m)).body.error], ['not_sold_out']);
  const f = await soldOutEvent();
  assert.equal((await call(joinEventWaitlist, m.claims, { params: { id: 'evt_nothere' }, body: joinBody(f, m) })).status, 404);
  assert.equal((await call(joinEventWaitlist, m.claims, { params: { id: f.event.id }, body: { ...joinBody(f, m), ticketTypeId: undefined } })).status, 422);
  const unverified = await member({ verified: false });
  assert.deepEqual([(await join(f, unverified)).status, (await join(f, unverified)).body.error], [403, 'verification_required']);
  assert.deepEqual([(await join(f, m, { consent: { accepted: true, textVersion: 'old' } })).body.error], ['consent_required']);
  assert.deepEqual([(await join(f, m, { consent: { accepted: false, textVersion: eventsConsentTextVersion() } })).body.error], ['consent_required']);
  assert.equal((await join(f, m, { participants: [self(m), self(m)] })).status, 422);
  assert.equal((await join(f, m, { participants: [{ ...self(m), consentBasis: 'purchaser_authorised' }] })).status, 422);
  assert.equal((await join(f, m, { participants: [{ ...self(m), phone: '+255700000001' }] })).status, 422, 'a contact that is not the member\'s own verified one');
  assert.equal((await join(f, m)).status, 201);
  assert.equal((await join(f, m)).body.error, 'already_registered', 'a second entry for the same member');
  const twin = await member();
  assert.equal((await join(f, { ...twin, phone: m.phone, claims: twin.claims, firstName: 'Zed', lastName: 'Zulu' })).status, 422, 'another account cannot use the same contact (it is not verified for them)');
  // a member who already holds a place
  const holder = await member();
  const reg = await h.addRegistrations({ eventId: f.event.id, ticketType: f.ticket, n: 0 });
  void reg;
  // waitlist off for new sign-ups, then closed
  await db('Event').where({ id: f.event.id }).update({ waitlistEnabled: false });
  const off = await join(f, holder);
  assert.deepEqual([off.status, off.body.error, off.body.reason], [409, 'waitlist_unavailable', 'waitlist_closed']);
  const detail = await call(eventDetail, null, { params: { idOrSlug: f.event.id } });
  assert.equal(detail.body.categories[0].ticketTypes[0].waitlist.state, 'closed');
  await db('Event').where({ id: f.event.id }).update({ waitlistEnabled: true });
  // priced ticket while payments are off
  delete process.env.MANUAL_PAY_INSTRUCTIONS;
  const noPay = await join(f, holder);
  assert.deepEqual([noPay.body.error, noPay.body.reason], ['waitlist_unavailable', 'payments_unavailable']);
  assert.equal((await call(eventDetail, null, { params: { idOrSlug: f.event.id } })).body.categories[0].ticketTypes[0].waitlist.state, 'none');
  process.env.MANUAL_PAY_INSTRUCTIONS = '1';
  // registration closed
  await db('Event').where({ id: f.event.id }).update({ registrationClosesAt: new Date(Date.now() - 1000) });
  assert.equal((await join(f, holder)).body.reason, 'registration_closed');
});

test('limits: 5 live entries per member, 500 per ticket type, two lapses end joining for that event, 10 joins an hour', async () => {
  s7On({ waitlist: true });
  process.env.EVENTS_WAITLIST_MAX_ACTIVE_PER_USER = '2';
  const a = await soldOutEvent(); const b = await soldOutEvent(); const c = await soldOutEvent();
  const m = await member();
  assert.equal((await join(a, m)).status, 201);
  assert.equal((await join(b, m)).status, 201);
  const third = await join(c, m);
  assert.deepEqual([third.status, third.body.error, third.body.max], [409, 'waitlist_limit_reached', 2]);
  delete process.env.EVENTS_WAITLIST_MAX_ACTIVE_PER_USER;
  process.env.EVENTS_WAITLIST_MAX_QUEUE = '1';
  const x = await member(); const y = await member();
  assert.equal((await join(c, x)).status, 201);
  assert.equal((await join(c, y)).body.error, 'waitlist_full');
  delete process.env.EVENTS_WAITLIST_MAX_QUEUE;
  // lapses
  const z = await member();
  const d = await soldOutEvent();
  for (let i = 0; i < 2; i += 1) {
    const j = await join(d, z);
    assert.equal(j.status, 201);
    await db('EventWaitlistEntry').where({ id: j.body.entry.id }).update({ status: 'expired', endedAt: new Date(), endedReason: 'offer_expired' });
  }
  assert.equal((await join(d, z)).body.error, 'waitlist_lapse_limit');
  // rate limit
  resetEventsWaitlistLimits();
  const r = await member();
  let last;
  for (let i = 0; i < 11; i += 1) last = await join(await soldOutEvent(), r);
  assert.equal(last.status, 429);
});

test('the queue gate: while anyone waits, nobody else can create an order for that ticket type even with a free place; availability reads sold_out; it lifts when the line empties', async () => {
  s7On({ waitlist: true });
  const f = await soldOutEvent();
  const waiter = await member(); const buyer = await member();
  assert.equal((await join(f, waiter)).status, 201);
  await free(f);                                              // a place opens, the promoter has not run yet
  const detail = await call(eventDetail, null, { params: { idOrSlug: f.event.id } });
  assert.equal(detail.body.categories[0].ticketTypes[0].availability, 'sold_out', 'an old app build shows Sold out, not an error');
  const blocked = await buy(f, buyer);
  assert.deepEqual([blocked.status, blocked.body.error, blocked.body.ticketTypeId], [409, 'waitlist_active', f.ticket.id]);
  assert.deepEqual(await db('EventOrder').where({ purchaserUserId: buyer.id }), [], 'no order, no hold');
  assert.equal((await ttRow(f)).held, 0);
  await db('EventWaitlistEntry').where({ ticketTypeId: f.ticket.id }).update({ status: 'left', endedAt: new Date(), endedReason: 'left' });
  assert.equal((await buy(f, buyer)).status, 201, 'the gate lifts when nobody waits');
});

test('the gate is race-safe: a buyer and a joiner at once never leave a queued ticket type with a stranger holding its free place', async () => {
  s7On({ waitlist: true });
  const f = await soldOutEvent();
  await free(f);
  const a = await member(); const buyer = await member();
  // with a free place and no queue, joining says not_sold_out; a purchase wins
  const [j, b] = await Promise.all([join(f, a), buy(f, buyer)]);
  // Either order is legal, but a live entry may only exist next to an order when that order filled the type (the buyer came first).
  const orders = await db('EventOrder').where({ purchaserUserId: buyer.id });
  const live = await db('EventWaitlistEntry').where({ ticketTypeId: f.ticket.id }).whereIn('status', ['waiting', 'offered']);
  const tt = await ttRow(f);
  if (orders.length && live.length) assert.ok(Number(tt.sold) + Number(tt.held) >= Number(tt.capacity), 'an entry next to a stranger\'s order means the type was full again');
  assert.ok(j.status === 201 || j.body.error === 'not_sold_out', JSON.stringify(j.body));
  assert.ok(b.status === 201 || b.body.error === 'waitlist_active', JSON.stringify(b.body));
});

test('the promoter offers a freed place to the head of the line as a REAL order: held inventory, offer window as the hold, entry offered, the order is marked from the waitlist', async () => {
  s7On({ waitlist: true });
  const f = await soldOutEvent();
  const a = await member(); const b = await member();
  const ea = (await join(f, a)).body.entry.id;
  const eb = (await join(f, b)).body.entry.id;
  const none = await eventsWaitlistService.promote();
  assert.equal(none.offered, 0, 'no free place, no offer');
  await free(f);
  const r = await eventsWaitlistService.promote();
  assert.equal(r.offered, 1);
  const entry = await entryOf(ea);
  assert.equal(entry.status, 'offered');
  assert.equal((await entryOf(eb)).status, 'waiting', 'strictly first in, first offered');
  const order = await db('EventOrder').where({ id: entry.orderId }).first();
  assert.deepEqual([order.status, order.purchaserUserId, order.idempotencyKey], ['awaiting_payment', a.id, `wl:${ea}`]);
  const hours = (+new Date(order.holdExpiresAt) - Date.now()) / H;
  assert.ok(hours > 11.8 && hours <= 12.01, `the hold is the 12 h offer window, got ${hours}`);
  assert.equal(+new Date(entry.offerExpiresAt), +new Date(order.holdExpiresAt));
  assert.equal((await ttRow(f)).held, 1);
  assert.equal((await db('EventInventoryMovement').where({ orderId: order.id, kind: 'hold' })).length, 1);
  const reg = await db('EventRegistration').where({ orderId: order.id }).first();
  assert.deepEqual([reg.status, reg.firstName, reg.consentBasis, reg.participantUserId], ['reserved', a.firstName, 'self', a.id]);
  const orders = await call(listMyEventOrders, a.claims, {});
  assert.equal(orders.body.items.find(o => o.id === order.id).source, 'waitlist');
  assert.equal((await call(listMyEventOrders, b.claims, {})).body.items.length, 0);
  const note = await eventually(() => db('Notification').where({ userId: a.id, type: 'event_waitlist_offer' }));
  assert.equal(note.length, 1);
  assert.equal(note[0].data.route, `/member/events/orders/${order.id}`);
  assert.match(note[0].data.bodySw, /Lipa kabla ya/);
  assert.equal((await db('Notification').where({ userId: a.id, type: 'event_order_created' })).length, 0, 'the offer has its own notice');
  const again = await eventsWaitlistService.promote();
  assert.equal(again.offered, 0, 'running again offers nothing more and creates no second order');
  assert.equal((await db('EventOrder').where({ purchaserUserId: a.id })).length, 1);
  const mine = await call(listMyEventWaitlist, a.claims, {});
  assert.equal(mine.body.items[0].offer.orderId, order.id);
  assert.equal(mine.body.items[0].offer.amountTzs, 20000);
  // the stored details stay until the entry ends, and the gate lets only the promoter through
  await free(f);
  assert.equal((await buy(f, await member())).body.error, 'waitlist_active', 'a free place is still not for strangers while the line exists');
});

test('two promoters at once create ONE order per entry (idempotency key and the compare-and-set on the entry)', async () => {
  s7On({ waitlist: true });
  const f = await soldOutEvent();
  const ms = [await member(), await member()];
  for (const m of ms) await join(f, m);
  await free(f, 2);
  await Promise.all([eventsWaitlistService.promote(), eventsWaitlistService.promote(), eventsWaitlistService.promote()]);
  const orders = await db('EventOrder').where({ eventId: f.event.id }).whereNotNull('purchaserUserId').whereLike('idempotencyKey', 'wl:%');
  assert.equal(orders.length, 2);
  assert.equal(new Set(orders.map(o => o.purchaserUserId)).size, 2);
  assert.equal((await ttRow(f)).held, 2);
  assert.deepEqual((await db('EventWaitlistEntry').where({ ticketTypeId: f.ticket.id }).select('status')).map(e => e.status), ['offered', 'offered']);
});

test('reconciliation: a confirmed order converts the entry; an unpaid one that lapses expires it, tells the member and offers the place to the next person at once', async () => {
  s7On({ waitlist: true });
  const f = await soldOutEvent();
  const a = await member(); const b = await member(); const c = await member();
  const ea = (await join(f, a)).body.entry.id; const eb = (await join(f, b)).body.entry.id; const ec = (await join(f, c)).body.entry.id;
  await free(f, 2);
  await eventsWaitlistService.promote();
  const [oa, ob] = [await entryOf(ea), await entryOf(eb)];
  assert.deepEqual([oa.status, ob.status, (await entryOf(ec)).status], ['offered', 'offered', 'waiting']);
  // a pays and is confirmed (the money flow itself is S4 and untouched)
  const committed = await eventStore.commitOrder(oa.orderId);
  assert.equal(committed.error, undefined, JSON.stringify(committed));
  // b's hold lapses
  await db('EventOrder').where({ id: ob.orderId }).update({ holdExpiresAt: new Date(Date.now() - 1000) });
  const released = await eventStore.expireHolds();
  assert.ok(released.released >= 1);
  await eventually(async () => (await entryOf(eb)).status, { until: s => s === 'expired' });
  const rec = await eventsWaitlistService.reconcile();
  void rec;
  assert.equal((await entryOf(ea)).status, 'converted');
  assert.equal((await entryOf(ea)).endedReason, 'paid');
  const eb2 = await entryOf(eb);
  assert.deepEqual([eb2.status, eb2.endedReason], ['expired', 'offer_expired']);
  const note = await eventually(() => db('Notification').where({ userId: b.id, type: 'event_waitlist_offer_expired' }));
  assert.match(note[0].data.bodyEn, /refund you/);
  // the nudge (or the next job run) offers the freed place to c
  await eventually(async () => (await entryOf(ec)).status, { until: s => s === 'offered' });
  await eventsWaitlistService.promote();
  assert.equal((await entryOf(ec)).status, 'offered');
  // a late payment that re-reserved b's place turns the expired entry into a converted one, only through reconciliation
  await db('EventOrder').where({ id: ob.orderId }).update({ confirmedAt: new Date() });
  await eventsWaitlistService.reconcile();
  assert.equal((await entryOf(eb)).status, 'converted');
  // a cancelled unpaid order is a decline, not a lapse
  const ecRow = await entryOf(ec);
  await db('EventOrder').where({ id: ecRow.orderId }).update({ status: 'cancelled', closedAt: new Date(), closeReason: 'cancelled' });
  await eventsWaitlistService.reconcile();
  assert.equal((await entryOf(ec)).status, 'declined');
});

test('one hour before the offer ends a single reminder goes out', async () => {
  s7On({ waitlist: true });
  const f = await soldOutEvent();
  const a = await member();
  const e = (await join(f, a)).body.entry.id;
  await free(f);
  await eventsWaitlistService.promote();
  const entry = await entryOf(e);
  await db('EventOrder').where({ id: entry.orderId }).update({ holdExpiresAt: new Date(Date.now() + 50 * 60_000) });
  await eventsWaitlistService.reconcile();
  await eventsWaitlistService.reconcile();
  const note = await eventually(() => db('Notification').where({ userId: a.id, type: 'event_waitlist_offer_reminder' }));
  assert.equal(note.length, 1);
  assert.match(note[0].data.titleSw, /Saa 1/);
});

test('ineligible head of line: an inactive account ends its entry and the next person is offered; a changed consent text blocks an entry (it keeps its place) until it is reconfirmed', async () => {
  s7On({ waitlist: true });
  const f = await soldOutEvent();
  const a = await member(); const b = await member(); const c = await member();
  const ea = (await join(f, a)).body.entry.id; const eb = (await join(f, b)).body.entry.id; const ec = (await join(f, c)).body.entry.id;
  await db('User').where({ id: a.id }).update({ accountStatus: 'suspended' });
  process.env.EVENTS_CONSENT_TEXT_VERSION = 'v-new';
  await free(f);
  const r = await eventsWaitlistService.promote();
  assert.equal((await entryOf(ea)).status, 'closed');
  assert.equal((await entryOf(ea)).endedReason, 'not_eligible');
  assert.equal((await entryOf(eb)).blockedReason, 'reconsent');
  assert.equal((await entryOf(ec)).blockedReason, 'reconsent');
  assert.equal(r.offered, 0, 'everyone left is blocked until they reconfirm');
  const mine = await call(listMyEventWaitlist, b.claims, {});
  assert.equal(mine.body.items[0].blockedReason, 'reconsent');
  assert.equal((await call(reconfirmMyEventWaitlist, b.claims, { params: { id: eb }, body: { consent: { accepted: true, textVersion: 'old' } } })).body.error, 'consent_required');
  const ok = await call(reconfirmMyEventWaitlist, b.claims, { params: { id: eb }, body: { consent: { accepted: true, textVersion: 'v-new' } } });
  assert.equal(ok.status, 200);
  assert.equal((await call(reconfirmMyEventWaitlist, b.claims, { params: { id: eb }, body: { consent: { accepted: true, textVersion: 'v-new' } } })).body.error, 'not_blocked');
  await eventsWaitlistService.promote();
  assert.equal((await entryOf(eb)).status, 'offered', 'b kept its place ahead of c');
  assert.equal((await entryOf(ec)).status, 'waiting');
});

test('M3: a member\'s own limit (an unpaid order elsewhere) DEFERS the entry: it keeps its place, is not counted toward the skips, is told once, and gets the next place when the limit lifts', async () => {
  s7On({ waitlist: true });
  const f = await soldOutEvent();
  const a = await member(); const b = await member();
  const ea = (await join(f, a)).body.entry.id; const eb = (await join(f, b)).body.entry.id;
  const other = await h.kitEvent({ n: 0, categories: [{ name: '5K', distanceMeters: 5000, tickets: [{ name: 'Fun', priceTzs: 10000, capacity: 50, maxPerOrder: 10 }] }] });
  process.env.EVENTS_MAX_UNPAID_PLACES_PER_USER = '1';
  const held = await call(createEventOrder, a.claims, { headers: { 'Idempotency-Key': `buy_${uid('').slice(1)}` }, body: { eventId: other.event.id, lines: [{ ticketTypeId: other.ticket.id, quantity: 1 }], participants: [{ ticketTypeId: other.ticket.id, ...self(a) }], acceptedTerms: true, consentTextVersion: eventsConsentTextVersion(), expectedTotalTzs: 10000 } });
  assert.equal(held.status, 201, JSON.stringify(held.body));
  await free(f, 3);
  for (let i = 0; i < 4; i += 1) await eventsWaitlistService.promote();
  const row = await entryOf(ea);
  assert.deepEqual([row.status, row.skipCount], ['waiting', 0], 'four runs later it is still waiting and never counted as a skip');
  assert.equal((await entryOf(eb)).status, 'offered', 'the next person gets the place; a keeps its seq');
  const notes = await eventually(() => db('Notification').where({ userId: a.id, type: 'event_waitlist_deferred' }));
  assert.equal(notes.length, 1, 'told exactly once');
  assert.match(notes[0].data.bodySw, /Namba yako kwenye orodha inabaki/);
  // the limit lifts: pay or cancel the other order
  await db('EventOrder').where({ purchaserUserId: a.id }).update({ status: 'cancelled', closedAt: new Date(), closeReason: 'cancelled' });
  await db('EventRegistration').where({ purchaserUserId: a.id }).update({ status: 'cancelled', cancelledAt: new Date() });
  await eventsWaitlistService.promote();
  assert.equal((await entryOf(ea)).status, 'offered');
  assert.equal(await db('EventWaitlistEntry').where({ id: ea, skipCount: 0 }).count().then(r => Number(r[0].count)), 1);
  // a failure that is not the member's limit still counts: three of them end the entry
  const c = await member();
  const ec = (await join(f, c)).body.entry.id;
  await db('EventWaitlistEntry').where({ id: ec }).update({ skipCount: 2 });
  await free(f);
  const real = eventsWaitlistService.internals.classify;
  assert.equal(real({ error: 'hold_limit_reached' }).act, 'defer');
  assert.equal(real({ error: 'unpaid_places_limit' }).act, 'defer');
  assert.equal(real({ error: 'something_else' }).act, 'skip');
  assert.equal(real({ error: 'event_not_open' }).act, 'stop_type', 'a pause is not a close');
  assert.equal(real({ error: 'registration_closed' }).act, 'close_all');
});

test('M4: a pause by FitFlex or a ticket type switched off leaves the line waiting and stops promotion; only a cancelled event or a passed close time ends it; resume restores', async () => {
  s7On({ waitlist: true });
  const f = await soldOutEvent();
  const a = await member();
  const e = (await join(f, a)).body.entry.id;
  await free(f);
  await db('Event').where({ id: f.event.id }).update({ status: 'registration_closed' });   // an admin pause: the close time is still in the future
  await eventsWaitlistService.promote();   // other tests' entries may be in the table: judge this line by its own rows
  assert.equal((await entryOf(e)).status, 'waiting');
  await db('Event').where({ id: f.event.id }).update({ status: 'published' });
  await db('EventTicketType').where({ id: f.ticket.id }).update({ status: 'inactive' });   // an organizer switched the ticket off for now
  await eventsWaitlistService.promote();
  assert.equal((await entryOf(e)).status, 'waiting');
  await db('EventTicketType').where({ id: f.ticket.id }).update({ status: 'active' });
  await db('EventCategory').where({ id: f.categories[0].id }).update({ status: 'inactive' });
  await eventsWaitlistService.promote();
  assert.equal((await entryOf(e)).status, 'waiting');
  await db('EventCategory').where({ id: f.categories[0].id }).update({ status: 'active' });
  await eventsWaitlistService.promote();
  assert.equal((await entryOf(e)).status, 'offered', 'resumed: the first in line is offered');
  // terminal reasons still end it
  const g = await soldOutEvent();
  const b = await member();
  const eb = (await join(g, b)).body.entry.id;
  await db('Event').where({ id: g.event.id }).update({ status: 'in_progress' });
  await eventsWaitlistService.promote();
  assert.deepEqual([(await entryOf(eb)).status, (await entryOf(eb)).endedReason], ['closed', 'sale_closed']);
});

test('quiet hours hold the offers back; "off" releases them; too little time before registration closes means no offer', async () => {
  s7On({ waitlist: true });
  const f = await soldOutEvent();
  const a = await member();
  const e = (await join(f, a)).body.entry.id;
  await free(f);
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Dar_es_Salaam', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  process.env.EVENTS_WAITLIST_QUIET_HOURS = `${hour}-${(hour + 2) % 24}`;
  assert.equal((await eventsWaitlistService.promote()).offered, 0);
  assert.equal((await entryOf(e)).status, 'waiting');
  process.env.EVENTS_WAITLIST_QUIET_HOURS = 'off';
  await db('Event').where({ id: f.event.id }).update({ registrationClosesAt: new Date(Date.now() + 90 * 60_000) });
  assert.equal((await eventsWaitlistService.promote()).offered, 0, 'under 120 minutes before registration closes');
  await db('Event').where({ id: f.event.id }).update({ registrationClosesAt: new Date(Date.now() + 6 * H) });
  assert.equal((await eventsWaitlistService.promote()).offered, 1);
  const order = await db('EventOrder').where({ id: (await entryOf(e)).orderId }).first();
  const hrs = (+new Date(order.holdExpiresAt) - Date.now()) / H;
  assert.ok(hrs > 1.9 && hrs < 2.1, `a quarter of 6 h is 1.5 h, raised to the 2 h minimum, got ${hrs}`);
  const { offerMinutes } = eventsWaitlistService.internals;
  assert.equal(offerMinutes(48 * H), 12 * 60);
  assert.equal(offerMinutes(8 * H), 120);
  assert.equal(offerMinutes(30 * 60_000), 30, 'never past the close');
});

test('a closed sale ends the line: registration closed or the event cancelled close every waiting entry and tell the members; payments off pauses promotion', async () => {
  s7On({ waitlist: true });
  const f = await soldOutEvent(); const g = await soldOutEvent();
  const a = await member(); const b = await member();
  const ea = (await join(f, a)).body.entry.id; const eb = (await join(g, b)).body.entry.id;
  await free(f);
  delete process.env.MANUAL_PAY_INSTRUCTIONS;
  assert.equal((await eventsWaitlistService.promote()).offered, 0, 'priced ticket, payments off: entries wait');
  process.env.MANUAL_PAY_INSTRUCTIONS = '1';
  await db('Event').where({ id: f.event.id }).update({ registrationClosesAt: new Date(Date.now() - 1000) });
  await db('Event').where({ id: g.event.id }).update({ status: 'cancelled', cancelledAt: new Date() });
  await eventsWaitlistService.promote();
  assert.deepEqual([(await entryOf(ea)).status, (await entryOf(ea)).endedReason], ['closed', 'sale_closed']);
  assert.deepEqual([(await entryOf(eb)).status, (await entryOf(eb)).endedReason], ['closed', 'event_cancelled']);
  assert.equal((await eventually(() => db('Notification').where({ userId: a.id, type: 'event_waitlist_closed' }))).length, 1);
  await db('Event').where({ id: g.event.id }).update({ status: 'published', cancelledAt: null });
});

test('leaving: a waiting entry becomes left; an offered one cancels its held order (declined) and frees the place; a payment waiting for a decision blocks it', async () => {
  s7On({ waitlist: true });
  const f = await soldOutEvent();
  const a = await member(); const b = await member(); const c = await member();
  const ea = (await join(f, a)).body.entry.id; const eb = (await join(f, b)).body.entry.id;
  const left = await call(leaveMyEventWaitlist, b.claims, { params: { id: eb } });
  assert.deepEqual([left.status, left.body.entry.status], [200, 'left']);
  assert.equal((await call(leaveMyEventWaitlist, b.claims, { params: { id: eb } })).body.error, 'already_ended');
  assert.equal((await call(leaveMyEventWaitlist, c.claims, { params: { id: ea } })).status, 404, 'not someone else\'s entry');
  await free(f);
  await eventsWaitlistService.promote();
  const offered = await entryOf(ea);
  await db('EventPayment').insert({ id: uid('epy'), orderId: offered.orderId, provider: 'manual', merchantReference: uid('mr'), amountTzs: 20000, currency: 'TZS', status: 'pending', method: 'manual', submittedAt: new Date(), eventId: f.event.id, organizerId: f.organizer.id, idempotencyKey: uid('k'), createdAt: new Date(), updatedAt: new Date() });
  assert.equal((await call(leaveMyEventWaitlist, a.claims, { params: { id: ea } })).body.error, 'payment_pending');
  await db('EventPayment').where({ orderId: offered.orderId }).del();
  const out = await call(leaveMyEventWaitlist, a.claims, { params: { id: ea } });
  assert.deepEqual([out.status, out.body.entry.status], [200, 'declined']);
  assert.equal((await db('EventOrder').where({ id: offered.orderId }).first()).status, 'cancelled');
  assert.equal((await ttRow(f)).held, 0);
});

test('organizer: counts only (no names or positions); ops and finance read, only owner and admin write; stop new sign-ups; close ends the line, tells everyone and cannot be undone', async () => {
  s7On({ waitlist: true });
  const f = await soldOutEvent();
  const a = await member(); const b = await member();
  await join(f, a); await join(f, b);
  const counts = await call(organizerWaitlistCounts, f.organizer.ops, { params: { id: f.event.id } });
  assert.equal(counts.status, 200);
  assert.deepEqual(counts.body.totals, { waiting: 2, offered: 0, converted: 0, expired: 0, left: 0 });
  assert.equal(counts.body.byTicketType[0].waiting, 2);
  const json = JSON.stringify(counts.body);
  assert.ok(!/position|firstName|name":"Asha|userId|seq/.test(json.replace('"name":"Early"', '')), json);
  assert.equal((await call(organizerWaitlistCounts, f.organizer.finance, { params: { id: f.event.id } })).status, 200);
  assert.equal((await call(organizerWaitlistCounts, f.organizer.timing, { params: { id: f.event.id } })).status, 403);
  assert.equal((await call(organizerWaitlistToggle, f.organizer.ops, { params: { id: f.event.id }, body: { enabled: false } })).status, 403);
  assert.equal((await call(organizerWaitlistToggle, f.organizer.admin, { params: { id: f.event.id }, body: { enabled: 'no' } })).status, 422);
  const stop = await call(organizerWaitlistToggle, f.organizer.admin, { params: { id: f.event.id }, body: { enabled: false } });
  assert.deepEqual(stop.body, { enabled: false, closedAt: null });
  assert.equal((await join(f, await member())).body.reason, 'waitlist_closed');
  assert.equal((await call(organizerWaitlistToggle, f.organizer.admin, { params: { id: f.event.id }, body: { enabled: true } })).status, 200);
  assert.equal((await call(organizerWaitlistClose, f.organizer.ops, { params: { id: f.event.id }, body: {} })).status, 403);
  const close = await call(organizerWaitlistClose, f.organizer.owner, { params: { id: f.event.id }, body: {} });
  assert.equal(close.body.closed, 2);
  assert.equal((await db('EventWaitlistEntry').where({ eventId: f.event.id, status: 'closed', endedReason: 'organizer_closed' })).length, 2);
  assert.equal((await eventually(() => db('Notification').where({ userId: b.id, type: 'event_waitlist_closed' }))).length, 1);
  const again = await call(organizerWaitlistClose, f.organizer.owner, { params: { id: f.event.id }, body: {} });
  assert.equal(again.body.closed, 0);
  assert.equal((await call(organizerWaitlistToggle, f.organizer.owner, { params: { id: f.event.id }, body: { enabled: true } })).body.error, 'waitlist_closed');
  assert.equal((await db('AuditLog').where({ action: 'events.waitlist_closed', target: f.event.id })).length, 1);
  const stranger = await h.kitEvent({ n: 0 });
  assert.equal((await call(organizerWaitlistCounts, stranger.organizer.owner, { params: { id: f.event.id } })).status, 404);
  await db('EventOrganizer').where({ id: f.organizer.id }).update({ status: 'suspended', statusReason: 'spec' });
  assert.equal((await call(organizerWaitlistCounts, f.organizer.owner, { params: { id: f.event.id } })).status, 200, 'a suspended organizer may read');
  assert.equal((await call(organizerWaitlistClose, f.organizer.owner, { params: { id: f.event.id }, body: {} })).status, 403);
  await db('EventOrganizer').where({ id: f.organizer.id }).update({ status: 'active', statusReason: null });
});

test('admin: a masked list in line order (no contact data); remove with a reason (Swahili fallback marked), an offered entry cancels its held order', async () => {
  s7On({ waitlist: true });
  const f = await soldOutEvent();
  const a = await member(); const b = await member();
  const ea = (await join(f, a)).body.entry.id; const eb = (await join(f, b)).body.entry.id;
  const admin = await h.superAdmin();
  const list = await call(adminEventWaitlist, admin, { params: { id: f.event.id } });
  assert.deepEqual(list.body.items.map(i => [i.id, i.name]), [[ea, `${a.firstName} ${a.lastName[0]}.`], [eb, `${b.firstName} ${b.lastName[0]}.`]]);
  assert.ok(!/phone|email|userId|\+255/.test(JSON.stringify(list.body)));
  assert.equal((await call(adminEventWaitlist, { sub: admin.sub, userType: 'admin', portalUser: true, aclPermissions: ['users'] }, { params: { id: f.event.id } })).status, 403);
  assert.equal((await call(adminRemoveWaitlistEntry, admin, { params: { id: f.event.id, entryId: ea }, body: { reason: 'short' } })).body.error, 'reason_required');
  const rm = await call(adminRemoveWaitlistEntry, admin, { params: { id: f.event.id, entryId: ea }, body: { reason: 'Duplicate account of another entrant' } });
  assert.deepEqual([rm.status, rm.body.entry.status], [200, 'removed']);
  const note = await eventually(() => db('Notification').where({ userId: a.id, type: 'event_waitlist_removed' }));
  assert.match(note[0].data.bodySw, /\(kwa Kiingereza\) Duplicate account/);
  assert.equal((await call(adminRemoveWaitlistEntry, admin, { params: { id: f.event.id, entryId: ea }, body: { reason: 'Duplicate account of another entrant' } })).body.error, 'already_ended');
  await free(f);
  await eventsWaitlistService.promote();
  const offered = await entryOf(eb);
  const rm2 = await call(adminRemoveWaitlistEntry, admin, { params: { id: f.event.id, entryId: eb }, body: { reason: 'Abuse of the queue found', reasonSw: 'Matumizi mabaya ya foleni yamegunduliwa' } });
  assert.equal(rm2.status, 200, JSON.stringify(rm2.body));
  assert.equal((await db('EventOrder').where({ id: offered.orderId }).first()).status, 'cancelled');
  assert.equal((await ttRow(f)).held, 0);
  assert.equal((await db('AuditLog').where({ action: 'events.waitlist_removed', target: f.event.id })).length, 2);
});

test('purge: stored details go 24 h after an entry ends, ended entries go after the keep days; the account deletion path cascades the row', async () => {
  s7On({ waitlist: true });
  const f = await soldOutEvent();
  const a = await member(); const b = await member();
  const ea = (await join(f, a)).body.entry.id; const eb = (await join(f, b)).body.entry.id;
  await db('EventWaitlistEntry').where({ id: ea }).update({ status: 'left', endedAt: new Date(Date.now() - 25 * H), endedReason: 'left' });
  await db('EventWaitlistEntry').where({ id: eb }).update({ status: 'left', endedAt: new Date(Date.now() - 2 * H), endedReason: 'left' });
  const r = await eventsWaitlistService.purge();
  assert.equal(r.cleared, 1);
  assert.equal((await entryOf(ea)).intent, null);
  assert.notEqual((await entryOf(eb)).intent, null, 'not yet 24 h');
  await db('EventWaitlistEntry').where({ id: ea }).update({ endedAt: new Date(Date.now() - 100 * 86_400_000) });
  assert.equal((await eventsWaitlistService.purge()).deleted, 1);
  const fk = await db.raw(`select confdeltype from pg_constraint where conrelid = '"EventWaitlistEntry"'::regclass and confrelid = '"User"'::regclass`);
  assert.equal(fk.rows[0].confdeltype, 'c', 'ON DELETE CASCADE from User');
  const job = await opsService.runJob('event-waitlist-purge', { trigger: 'manual', actorId: 'spec' });
  assert.equal(job.stats.skipped, undefined);
  s7Off();
  assert.equal((await opsService.runJob('event-waitlist-promote', { trigger: 'manual', actorId: 'spec' })).stats.skipped, 'flag_off');
  s7On({ waitlist: true });
  assert.equal((await opsService.runJob('event-waitlist-promote', { trigger: 'manual', actorId: 'spec' })).stats.skipped, undefined);
});

test('H5: a second concurrent unpaid order must fit under the cap with what the member already holds; a first order of any allowed size is not limited', async () => {
  s7On({ waitlist: false });
  const big = await h.kitEvent({ n: 0, categories: [{ name: '10K', distanceMeters: 10000, tickets: [{ name: 'T', priceTzs: 20000, capacity: 50, maxPerOrder: 10 }] }] });
  const second = await h.kitEvent({ n: 0, categories: [{ name: '5K', distanceMeters: 5000, tickets: [{ name: 'T', priceTzs: 20000, capacity: 50, maxPerOrder: 10 }] }] });
  const m = await member();
  const group = (f, n) => ({
    eventId: f.event.id, lines: [{ ticketTypeId: f.ticket.id, quantity: n }],
    participants: Array.from({ length: n }, (_, i) => (i === 0 ? { ticketTypeId: f.ticket.id, ...self(m) } : { ticketTypeId: f.ticket.id, firstName: ['Anna', 'Bede', 'Caro', 'Dani', 'Elia', 'Fumo', 'Gina', 'Hamu', 'Idi', 'Juma'][i], lastName: 'Runner', phone: `+25576${String(1000000 + i).slice(1)}0`, consentBasis: 'purchaser_authorised' })),
    acceptedTerms: true, consentTextVersion: eventsConsentTextVersion(), expectedTotalTzs: 20000 * n,
  });
  const place = (f, n) => call(createEventOrder, m.claims, { headers: { 'Idempotency-Key': `buy_${uid('').slice(1)}` }, body: group(f, n) });
  const first = await place(big, 6);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const refused = await place(second, 1);
  assert.deepEqual([refused.status, refused.body.error, refused.body.limit], [409, 'unpaid_places_limit', 4]);
  assert.equal((await db('EventOrder').where({ purchaserUserId: m.id })).length, 1);
  assert.equal((await ttRowOf(second)).held, 0);
  // once the first order is gone the member can hold again
  await db('EventOrder').where({ purchaserUserId: m.id }).update({ holdExpiresAt: new Date(Date.now() - 1000) });
  assert.equal((await place(second, 4)).status, 201);
  process.env.EVENTS_MAX_UNPAID_PLACES_PER_USER = '10';
});
const ttRowOf = f => db('EventTicketType').where({ id: f.ticket.id }).first();

test('migration down fails closed once waitlist entries exist', async () => {
  s7On({ waitlist: true });
  const f = await soldOutEvent();
  await join(f, await member());
  const migration = createRequire(import.meta.url)('../db/migrations/20270202090200-events-waitlist-s7.cjs');
  await assert.rejects(() => migration.down(db), /fails closed/);
  assert.notEqual((await db.raw(`select to_regclass('public."EventWaitlistEntry"') as t`)).rows[0].t, null);
  void randomUUID;
});
