// Marathon & running events · S4 — manual payment at the route level against the CI database (spec §3.4–§3.10, §3.19):
// options, initiation (idempotency, validators, duplicate IDs, hold rules), admin confirmation with the typed amount
// received, maker-checker, rejection, one ticket set per approval, the late-payment rehold and its refund, repair and
// sweep, and the PaymentRequest regressions for the other products.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ensureInit } from '../functions/index.mjs';
import { eventStore, eventsPaymentsService, adminPaymentService, paymentRequests } from '../src/bootstrap/services.mjs';
import { createEventOrder, quoteEventOrder, getMyEventOrder, cancelMyEventOrder, resetEventsRegistrationLimits } from '../functions/events-registration.mjs';
import { payForEventOrder, eventOrderPaymentStatus, resetEventsPaymentLimits } from '../functions/events-payments.mjs';
import { eventsOptions } from '../functions/events-public.mjs';
import { adminPaymentRequests, adminDecidePaymentRequest, adminVerifyPaymentRequest, adminRequestPaymentChange, adminConfirmPaymentChange, adminUpdatePaymentRequest } from '../functions/admin-payments.mjs';
import { adminRepairEventPayment } from '../functions/events-admin.mjs';
import { harness, s4On, s4Off, saveManualDetails, clearManualDetails, txId, uid, phone, D, H, TICKET_SECRET } from './fixtures/events-s4.mjs';

await ensureInit();
const h = harness();
const { db } = h;
const call = h.call;
afterEach(() => { s4Off(); resetEventsRegistrationLimits(); resetEventsPaymentLimits(); });
after(async () => { await clearManualDetails(); await h.cleanup(); await db.destroy(); });

const CONSENT = '2026-10-draft';
const key = () => `s4_${uid('').slice(1)}`;
const buyer = async () => { const p = phone(); const sub = await h.user({ phone: p }); return { claims: h.claimsOf(sub), sub, phone: p }; };
const orderBody = (eventId, ticketTypeId, b, n = 1) => ({
  eventId, lines: [{ ticketTypeId, quantity: n }], acceptedTerms: true, consentTextVersion: CONSENT,
  participants: Array.from({ length: n }, (_, i) => (i === 0
    ? { ticketTypeId, firstName: 'Neema', lastName: 'Abdallah', phone: b.phone, consentBasis: 'self' }
    : { ticketTypeId, firstName: 'Zawadi', lastName: 'Mollel', phone: phone(), consentBasis: 'purchaser_authorised' })),
});
/** Place an unpaid order for `n` places of the event's first ticket. */
async function place(f, b, n = 1) {
  const body = orderBody(f.event.id, f.ticket.id, b, n);
  const q = await call(quoteEventOrder, b.claims, { body });
  const r = await call(createEventOrder, b.claims, { headers: { 'Idempotency-Key': key() }, body: { ...body, expectedTotalTzs: q.body.quote.totalTzs } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
const pay = (b, orderId, body, k = key()) => call(payForEventOrder, b.claims, { params: { id: orderId }, headers: { 'Idempotency-Key': k }, body });
async function admins() {
  return { a: h.claimsOf(await h.user({ userType: 'admin' }), 'admin'), b: h.claimsOf(await h.user({ userType: 'admin' }), 'admin') };
}
const decide = (admin, requestId, body) => call(adminDecidePaymentRequest, admin, { params: { id: requestId }, body });
const setup = async (opts = {}) => {
  s4On(opts);
  await saveManualDetails();
  const f = await h.sellingEvent({ categories: [{ name: '10K', distanceMeters: 10000, tickets: [{ name: 'Early', priceTzs: 20000, capacity: 5 }] }] });
  const b = await buyer();
  return { f, b };
};

test('scenario: pay by Lipa Namba and be confirmed — one payment, ticket per place, outbox, notices, hold extended', async () => {
  const { f, b } = await setup();
  const o = await place(f, b, 2);
  const orderId = o.order.id;
  assert.equal(o.next.payment, 'manual');
  assert.equal(o.next.instructions.lipaNamba, '5123456');
  assert.equal(o.next.instructions.amountTzs, 40000);
  const ref = txId();
  const p = await pay(b, orderId, { reference: ref, payerPhone: b.phone });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  assert.equal(p.body.payment.state, 'submitted');
  assert.equal(p.body.payment.reference, ref);
  assert.equal(p.body.payment.amountTzs, 40000);
  const row = await db('EventPayment').where({ orderId }).first();
  assert.equal(row.status, 'pending'); assert.equal(row.method, 'manual'); assert.equal(row.amountTzs, 40000);
  const order = await db('EventOrder').where({ id: orderId }).first();
  assert.equal(order.holdExtensions, 1);
  assert.ok(+new Date(order.holdExpiresAt) > Date.now() + 23 * H, 'hold extended by ~24h');
  const { a, b: second } = await admins();
  const reqRow = await db('PaymentRequest').where({ eventOrderId: orderId }).first();
  assert.equal(reqRow.status, 'pending');
  const approve = await decide(a, reqRow.id, { decision: 'approve', amountTzs: 40000 });
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  assert.equal(approve.body.event.outcome, 'confirmed');
  assert.equal(approve.body.event.ticketsIssued, 2);
  assert.equal(approve.body.paymentRequest.status, 'approved');
  assert.equal(approve.body.status, 'approved');
  const after_ = await db('EventOrder').where({ id: orderId }).first();
  assert.deepEqual([after_.status, after_.holdExpiresAt, after_.organizerId, after_.commissionPctSnapshot, after_.paymentMethod], ['confirmed', null, f.organizer.id, 10, 'manual']);
  assert.deepEqual(await h.counters(f.ticket.id), { sold: 2, held: 0, capacity: 5 });
  const regs = await db('EventRegistration').where({ orderId }).orderBy('id');
  assert.deepEqual(regs.map(r => r.status), ['confirmed', 'confirmed']);
  assert.equal(regs.reduce((n, r) => n + r.paidAmountTzs, 0), 40000);
  const tickets = await db('EventTicket').whereIn('registrationId', regs.map(r => r.id));
  assert.equal(tickets.length, 2);
  assert.ok(tickets.every(t => t.status === 'active' && t.tokenHash.length === 64 && t.displayCode));
  const types = (await h.outbox(f.event.id)).map(x => x.type).sort();
  assert.deepEqual(types, ['payment.succeeded', 'registration.created', 'registration.created', 'registration.paid', 'registration.paid', 'ticket.issued', 'ticket.issued']);
  assert.equal((await h.notifications(b.sub, 'event_payment_submitted')).length, 1);
  assert.equal((await h.notifications(b.sub, 'event_payment_confirmed')).length, 1);
  void second;
});

// ── Options, flags, fail closed ──────────────────────────────────────────

test('options.payment: none until the flag, the Lipa Namba and a ticket secret are all there; the S4 keys appear with EVENTS_REGISTRATION', async () => {
  const optionsNow = async () => (await call(eventsOptions, null)).body;
  s4On();
  await clearManualDetails();
  let o = await optionsNow();
  assert.equal(o.payment, 'none', 'manual flag on but no Lipa Namba saved');
  assert.deepEqual(o.hold, { manualExtendHours: 24, manualMaxHours: 48, providerExtendMinutes: 10, lateGraceHours: 24 });
  assert.deepEqual(o.tickets, { qr: true, scanning: false });
  assert.equal(o.refundDays, 5);
  assert.ok(!('manualConfirmHours' in o));
  await saveManualDetails();
  o = await optionsNow();
  assert.equal(o.payment, 'manual'); assert.equal(o.manualConfirmHours, 24);
  delete process.env.EVENT_TICKET_SECRET;
  assert.equal((await optionsNow()).payment, 'none', 'no ticket secret: nothing is taken');
  process.env.EVENT_TICKET_SECRET = 'too-short';
  assert.equal((await optionsNow()).payment, 'none', 'a secret under 32 characters is no secret');
  process.env.EVENT_TICKET_SECRET = TICKET_SECRET;
  delete process.env.EVENTS_PAYMENTS_MANUAL;
  assert.equal((await optionsNow()).payment, 'none', 'payments flag off');
  // EVENTS_MODULE alone: no S3/S4 keys at all
  s4Off(); process.env.EVENTS_MODULE = '1';
  o = await optionsNow();
  for (const k of ['payment', 'hold', 'tickets', 'refundDays', 'manualConfirmHours']) assert.ok(!(k in o), k);
});

test('initiation without a ticket secret answers 503 tickets_unavailable and writes nothing; with the payments flags off every intake route is 404', async () => {
  const { f, b } = await setup();
  const o = await place(f, b);
  delete process.env.EVENT_TICKET_SECRET;
  const r = await pay(b, o.order.id, { reference: txId(), payerPhone: b.phone });
  assert.deepEqual([r.status, r.body.error], [503, 'tickets_unavailable']);
  assert.equal((await db('EventPayment').where({ orderId: o.order.id })).length, 0);
  process.env.EVENT_TICKET_SECRET = TICKET_SECRET;
  delete process.env.EVENTS_PAYMENTS_MANUAL;
  const off = await pay(b, o.order.id, { reference: txId(), payerPhone: b.phone });
  assert.deepEqual([off.status, off.body], [404, { error: 'feature_disabled' }]);
  // reads still work with intake off: a member who already paid keeps access
  const status = await call(eventOrderPaymentStatus, b.claims, { params: { id: o.order.id } });
  assert.equal(status.status, 200); assert.equal(status.body.payment, null);
  const detail = await call(getMyEventOrder, b.claims, { params: { id: o.order.id } });
  assert.deepEqual(detail.body.next, { payment: 'none', instructions: null });
  assert.deepEqual(detail.body.allowedActions, ['cancel']);
});

// ── Initiation ───────────────────────────────────────────────────────────

test('initiation: amount and currency come from the order; the body\'s amount, currency and provider are ignored; a foreign user gets 404', async () => {
  const { f, b } = await setup();
  const o = await place(f, b);
  const other = await buyer();
  assert.deepEqual((await pay(other, o.order.id, { reference: txId(), payerPhone: other.phone })).body, { error: 'order_not_found' });
  const noKey = await call(payForEventOrder, b.claims, { params: { id: o.order.id }, body: { reference: txId(), payerPhone: b.phone } });
  assert.deepEqual([noKey.status, noKey.body.error], [400, 'idempotency_key_required']);
  const r = await pay(b, o.order.id, { reference: txId(), payerPhone: b.phone, amountTzs: 1, currency: 'USD', provider: 'free', status: 'succeeded', orderId: 'x' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.payment.amountTzs, 20000); assert.equal(r.body.payment.currency, 'TZS'); assert.equal(r.body.payment.method, 'manual');
  const req = await db('PaymentRequest').where({ eventOrderId: o.order.id }).first();
  assert.deepEqual([req.amountTzs, req.currency, req.provider, req.status, req.memberId], [20000, 'TZS', 'admin_approved', 'pending', b.sub]);
  assert.equal(req.note, `event_order:${o.order.reference}`);
  assert.equal(req.payerPhone, b.phone);
  assert.equal(r.body.order.status, 'awaiting_payment');
  assert.deepEqual(r.body.next, { payment: 'manual', paymentRequestId: req.id, instructions: null });
});

test('initiation validators: transaction ID and payer phone; a body that disagrees with the mode is 409 payment_mode_mismatch', async () => {
  const { f, b } = await setup();
  const o = await place(f, b);
  const id = o.order.id;
  assert.equal((await pay(b, id, { reference: 'x', payerPhone: b.phone })).body.error, 'payment_reference_invalid');
  assert.equal((await pay(b, id, { reference: txId() })).body.error, 'payer_phone_required');
  assert.equal((await pay(b, id, { reference: txId(), payerPhone: '12345' })).body.error, 'payer_phone_invalid');
  assert.equal((await pay(b, id, { payerPhone: b.phone })).body.error, 'payment_reference_required');
  const mismatch = await pay(b, id, {});
  assert.deepEqual([mismatch.status, mismatch.body], [409, { error: 'payment_mode_mismatch', mode: 'manual' }]);
  assert.equal((await db('EventPayment').where({ orderId: id })).length, 0, 'nothing written by any refusal');
});

test('idempotency: the same key and body replays the first answer; the same key with another body is 409; a new key while one is live is 409 payment_in_progress', async () => {
  const { f, b } = await setup();
  const o = await place(f, b);
  const id = o.order.id;
  const k = key(); const ref = txId();
  const first = await pay(b, id, { reference: ref, payerPhone: b.phone }, k);
  assert.equal(first.status, 201);
  const again = await pay(b, id, { reference: ref, payerPhone: b.phone, amountTzs: 99 }, k);
  assert.deepEqual([again.status, again.body.replayed, again.body.payment.id], [200, true, first.body.payment.id]);
  const reused = await pay(b, id, { reference: txId(), payerPhone: b.phone }, k);
  assert.deepEqual([reused.status, reused.body.error], [409, 'idempotency_key_reused']);
  const second = await pay(b, id, { reference: txId(), payerPhone: b.phone });
  assert.deepEqual([second.status, second.body.error], [409, 'payment_in_progress']);
  assert.equal(second.body.payment.id, first.body.payment.id);
  assert.equal((await db('EventPayment').where({ orderId: id })).length, 1);
  assert.equal((await db('PaymentRequest').where({ eventOrderId: id })).length, 1);
  // the replay survives the decision: the original answer, even once decided
  const { a } = await admins();
  const reqRow = await db('PaymentRequest').where({ eventOrderId: id }).first();
  assert.equal((await decide(a, reqRow.id, { decision: 'approve', amountTzs: 20000 })).status, 200);
  const replayed = await pay(b, id, { reference: ref, payerPhone: b.phone }, k);
  assert.deepEqual([replayed.status, replayed.body.replayed, replayed.body.payment.state], [200, true, 'confirmed']);
});

test('a transaction ID confirms one payment across every product; the sixth refused duplicate in an hour is 429', async () => {
  const { f, b } = await setup();
  const ref = txId();
  // the ID is already on a pass payment of someone else
  const other = await buyer();
  await db('PaymentRequest').insert({ id: `pay_${uid('').slice(1, 9)}`, memberId: other.sub, amountTzs: 50000, currency: 'TZS', status: 'pending', provider: 'admin_approved', tier: 'basic', memberReference: ref, memberReferenceKey: ref.replace(/[^A-Z0-9]/g, ''), payerPhone: other.phone });
  const o = await place(f, b);
  for (let i = 0; i < 5; i += 1) {
    const r = await pay(b, o.order.id, { reference: ref, payerPhone: b.phone });
    assert.deepEqual([r.status, r.body.error], [409, 'payment_reference_duplicate'], `refusal ${i + 1}`);
  }
  const sixth = await pay(b, o.order.id, { reference: ref, payerPhone: b.phone });
  assert.deepEqual([sixth.status, sixth.body.error], [429, 'too_many_attempts']);
  assert.equal((await db('EventPayment').where({ orderId: o.order.id })).length, 0);
  await db('PaymentRequest').where({ memberReferenceKey: ref.replace(/[^A-Z0-9]/g, '') }).del();
  await db('AuditLog').where({ actor: b.sub, action: 'payment_reference_duplicate' }).del();
});

// ── Hold rules ───────────────────────────────────────────────────────────

test('hold: a manual submission extends to min(cap, start, now + 24 h); rejections never push past the cap; the retry window; expiry does not cancel the pending request; the member cannot cancel while it is checked', async () => {
  const { f, b } = await setup();
  const o = await place(f, b);
  const id = o.order.id;
  const created = new Date((await db('EventOrder').where({ id }).first()).createdAt);
  const r = await pay(b, id, { reference: txId(), payerPhone: b.phone });
  assert.equal(r.status, 201);
  let order = await db('EventOrder').where({ id }).first();
  assert.equal(+new Date(order.holdCapAt), +created + 48 * H, 'cap = created + 48h');
  assert.ok(Math.abs(+new Date(order.holdExpiresAt) - (Date.now() + 24 * H)) < 60_000);
  // the member cannot cancel the unpaid order or a place while the payment is being checked
  const cancel = await call(cancelMyEventOrder, b.claims, { params: { id }, body: { reason: 'other' } });
  assert.deepEqual([cancel.status, cancel.body.error], [409, 'payment_submitted']);
  // rejected: the member may correct the ID until min(cap, now + 60 min) — never past the cap
  const { a } = await admins();
  const reqRow = await db('PaymentRequest').where({ eventOrderId: id }).first();
  const noCode = await decide(a, reqRow.id, { decision: 'reject' });
  assert.deepEqual([noCode.status, noCode.body.error], [400, 'reason_code_required']);
  assert.equal((await decide(a, reqRow.id, { decision: 'reject', reasonCode: 'other' })).body.error, 'note_required');
  const rej = await decide(a, reqRow.id, { decision: 'reject', reasonCode: 'reference_not_found', memberNote: 'Check the ID on the SMS', note: 'internal text' });
  assert.equal(rej.status, 200, JSON.stringify(rej.body));
  order = await db('EventOrder').where({ id }).first();
  assert.ok(+new Date(order.holdExpiresAt) <= +new Date(order.holdCapAt));
  const view = (await call(eventOrderPaymentStatus, b.claims, { params: { id } })).body;
  assert.deepEqual([view.payment.state, view.payment.rejectCode, view.payment.memberNote, view.payment.canRetry], ['rejected', 'reference_not_found', 'Check the ID on the SMS', true]);
  assert.ok(!JSON.stringify(view).includes('internal text'), 'the internal decision note is never returned');
  assert.equal((await h.notifications(b.sub, 'event_payment_rejected')).length, 1);
  // the member corrects the ID: a new attempt, the old request stays rejected; the hold extends again, never past the cap
  const retry = await pay(b, id, { reference: txId(), payerPhone: b.phone });
  assert.equal(retry.status, 201, JSON.stringify(retry.body));
  order = await db('EventOrder').where({ id }).first();
  assert.ok(+new Date(order.holdExpiresAt) <= +created + 48 * H + 1000);
  assert.equal(order.holdExtensions, 2);
  // the expiry job leaves the pending request alone
  await eventStore.expireHolds({ at: new Date(Date.now() + 3 * D) });
  const expired = await db('EventOrder').where({ id }).first();
  assert.equal(expired.status, 'expired');
  const live = await db('PaymentRequest').where({ eventOrderId: id, status: 'pending' });
  assert.equal(live.length, 1, 'the request stays pending for staff');
});

// ── Admin confirmation ───────────────────────────────────────────────────

/** An order with a manual payment submitted; returns { o, orderId, request, ref }. */
async function submitted(f, b, n = 1) {
  const o = await place(f, b, n);
  const ref = txId();
  const r = await pay(b, o.order.id, { reference: ref, payerPhone: b.phone });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const request = await db('PaymentRequest').where({ eventOrderId: o.order.id }).first();
  return { o, orderId: o.order.id, request, ref };
}
const snapshotOf = async (orderId, ticketTypeId) => ({
  order: (await db('EventOrder').where({ id: orderId }).first()).status,
  payment: (await db('EventPayment').where({ orderId }).orderBy('createdAt', 'desc').first()).status,
  request: (await db('PaymentRequest').where({ eventOrderId: orderId }).orderBy('requestedAt', 'desc').first()).status,
  tickets: Number((await db('EventTicket as t').join('EventRegistration as r', 'r.id', 't.registrationId').where('r.orderId', orderId).count({ n: '*' }))[0].n),
  counters: await h.counters(ticketTypeId),
});

test('scenario 8, amount mismatch: the amount received is mandatory and must equal the order; a refusal writes NOTHING', async () => {
  const { f, b } = await setup();
  const { orderId, request } = await submitted(f, b);
  const { a } = await admins();
  const before = await snapshotOf(orderId, f.ticket.id);
  const missing = await decide(a, request.id, { decision: 'approve' });
  assert.deepEqual([missing.status, missing.body.error], [400, 'amount_required']);
  const wrong = await decide(a, request.id, { decision: 'approve', amountTzs: 19000 });
  assert.deepEqual([wrong.status, wrong.body.error, wrong.body.expectedTzs], [409, 'amount_mismatch', 20000]);
  assert.deepEqual(await snapshotOf(orderId, f.ticket.id), before);
  // a tampered request amount no longer agrees with the order or the payment row
  await db('PaymentRequest').where({ id: request.id }).update({ amountTzs: 25000 });
  const tampered = await decide(a, request.id, { decision: 'approve', amountTzs: 25000 });
  assert.deepEqual([tampered.status, tampered.body.error, tampered.body.expectedTzs], [409, 'order_amount_mismatch', 20000]);
  await db('PaymentRequest').where({ id: request.id }).update({ amountTzs: 20000 });
  await db('PaymentRequest').where({ id: request.id }).update({ currency: 'USD' });
  assert.equal((await decide(a, request.id, { decision: 'approve', amountTzs: 20000 })).body.error, 'currency_mismatch');
  await db('PaymentRequest').where({ id: request.id }).update({ currency: 'TZS' });
  // the payment row must agree too
  await db('EventPayment').where({ orderId }).update({ amountTzs: 21000 });
  assert.equal((await decide(a, request.id, { decision: 'approve', amountTzs: 20000 })).body.error, 'payment_row_mismatch');
  await db('EventPayment').where({ orderId }).update({ amountTzs: 20000 });
  assert.deepEqual(await snapshotOf(orderId, f.ticket.id), before);
  const ok = await decide(a, request.id, { decision: 'approve', amountTzs: 20000 });
  assert.equal(ok.body.event.outcome, 'confirmed');
});

test('scenario 6, double approval: two clicks make one payment, one order commit, one ticket per place, one set of outbox rows and notices', async () => {
  const { f, b } = await setup();
  const { orderId, request } = await submitted(f, b, 2);
  const { a, b: second } = await admins();
  const [x, y] = await Promise.all([
    decide(a, request.id, { decision: 'approve', amountTzs: 40000 }),
    decide(second, request.id, { decision: 'approve', amountTzs: 40000 }),
  ]);
  const codes = [x, y].map(r => r.status).sort();
  assert.deepEqual(codes, [200, 409], JSON.stringify([x.body, y.body]));
  assert.equal([x, y].find(r => r.status === 409).body.error, 'already_decided');
  const third = await decide(a, request.id, { decision: 'approve', amountTzs: 40000 });
  assert.deepEqual([third.status, third.body.error], [409, 'already_decided']);
  assert.equal((await db('EventPayment').where({ orderId, status: 'succeeded' })).length, 1);
  assert.equal(Number((await db('EventTicket as t').join('EventRegistration as r', 'r.id', 't.registrationId').where('r.orderId', orderId).count({ n: '*' }))[0].n), 2);
  assert.deepEqual(await h.counters(f.ticket.id), { sold: 2, held: 0, capacity: 5 });
  assert.equal((await h.outbox(f.event.id, 'payment.succeeded')).length, 1);
  assert.equal((await h.outbox(f.event.id, 'registration.paid')).length, 2);
  assert.equal((await h.notifications(b.sub, 'event_payment_confirmed')).length, 1);
  assert.deepEqual((await h.movements(orderId)).map(m => [m.kind, m.quantity]), [['hold', 2], ['commit', 2]]);
  // the repair route and the sweep are no-ops now
  const rep = await call(adminRepairEventPayment, a, { params: { id: f.event.id, orderId } });
  assert.deepEqual([rep.status, rep.body.repaired], [200, false]);
});

test('one transaction ID confirms one payment: a reference already approved elsewhere is refused', async () => {
  const { f, b } = await setup();
  const one = await submitted(f, b);
  const b2 = await buyer();
  const two = await submitted(f, b2);
  const { a } = await admins();
  assert.equal((await decide(a, one.request.id, { decision: 'approve', amountTzs: 20000 })).status, 200);
  // the second request is approved with the first one's reference typed by the admin
  const clash = await decide(a, two.request.id, { decision: 'approve', amountTzs: 20000, reference: one.ref });
  assert.deepEqual([clash.status, clash.body.error], [409, 'reference_already_used']);
  assert.equal((await db('EventOrder').where({ id: two.orderId }).first()).status, 'awaiting_payment');
});

test('maker-checker (MONEY_SECOND_APPROVER): the verifier cannot approve; a different admin does with the amount received; event approvals are not exempt', async () => {
  const { f, b } = await setup({ secondApprover: true });
  const { orderId, request } = await submitted(f, b);
  const { a, b: second } = await admins();
  assert.equal((await decide(a, request.id, { decision: 'approve', amountTzs: 20000 })).body.error, 'verification_required');
  const verified = await call(adminVerifyPaymentRequest, a, { params: { id: request.id }, body: {} });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  assert.equal((await decide(a, request.id, { decision: 'approve', amountTzs: 20000 })).body.error, 'cannot_approve_own_verification');
  const listed = (await call(adminPaymentRequests, a, { query: { productType: 'EVENT_ORDER' } })).body;
  const row = listed.find(r => r.id === request.id);
  assert.deepEqual([row.productType, row.approvalStage, row.approveNotBy], ['EVENT_ORDER', 'awaiting_second_approval', a.sub]);
  assert.equal((await db('EventOrder').where({ id: orderId }).first()).status, 'awaiting_payment');
  const done = await decide(second, request.id, { decision: 'approve', amountTzs: 20000 });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.event.outcome, 'confirmed');
});

test('admin list: ?productType=EVENT_ORDER returns only event rows with the eventOrder projection; the unfiltered list is unchanged; EVENT_ORDER is not a pass product', async () => {
  const { f, b } = await setup();
  const { orderId, request } = await submitted(f, b);
  const { a } = await admins();
  const filtered = (await call(adminPaymentRequests, a, { query: { productType: 'EVENT_ORDER', limit: '500' } })).body;
  assert.ok(filtered.length >= 1 && filtered.every(r => r.productType === 'EVENT_ORDER'));
  const row = filtered.find(r => r.id === request.id);
  assert.equal(row.eventOrder.orderId, orderId);
  assert.deepEqual([row.eventOrder.expectedTzs, row.eventOrder.placesCount, row.eventOrder.lateOutcome, row.eventOrder.eventTitle], [20000, 1, 'none', 'Dar Half Marathon']);
  const all = (await call(adminPaymentRequests, a, {})).body;
  assert.ok(all.some(r => r.id === request.id) && all.length >= filtered.length);
  assert.ok(all.filter(r => r.productType !== 'EVENT_ORDER').every(r => !('eventOrder' in r)), 'no event key on other products');
  const none = (await call(adminPaymentRequests, a, { query: { productType: 'SHOP_ORDER', limit: '1' } })).body;
  assert.ok(none.length <= 1 && none.every(r => r.productType === 'SHOP_ORDER'));
});

test('rejected by mistake: a second admin changes it to approved (EventPayment failed → succeeded); an approved payment cannot be edited back', async () => {
  const { f, b } = await setup({ secondApprover: true });
  const { orderId, request } = await submitted(f, b);
  const { a, b: second } = await admins();
  assert.equal((await decide(a, request.id, { decision: 'reject', reasonCode: 'wrong_account' })).status, 200);
  assert.equal((await db('EventPayment').where({ orderId }).first()).status, 'failed');
  const ask = await call(adminRequestPaymentChange, a, { params: { id: request.id }, body: { status: 'approved', reason: 'The money is on the statement' } });
  assert.equal(ask.status, 200, JSON.stringify(ask.body));
  const noAmount = await call(adminConfirmPaymentChange, second, { params: { id: request.id }, body: {} });
  assert.deepEqual([noAmount.status, noAmount.body.error], [400, 'amount_required']);
  const self = await call(adminConfirmPaymentChange, a, { params: { id: request.id }, body: { amountTzs: 20000 } });
  assert.equal(self.body.error, 'cannot_confirm_own_request');
  const done = await call(adminConfirmPaymentChange, second, { params: { id: request.id }, body: { amountTzs: 20000 } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.event.outcome, 'confirmed');
  assert.equal((await db('EventPayment').where({ orderId }).first()).status, 'succeeded');
  assert.equal((await db('EventOrder').where({ id: orderId }).first()).status, 'confirmed');
  // approved → anything: payment_already_confirmed in every path
  assert.equal((await call(adminRequestPaymentChange, a, { params: { id: request.id }, body: { status: 'rejected', reason: 'oops' } })).body.error, 'payment_already_confirmed');
  s4Off(); s4On();   // single-admin mode: update() is open, but not to take a confirmed payment back
  assert.equal((await call(adminUpdatePaymentRequest, a, { params: { id: request.id }, body: { status: 'pending' } })).body.error, 'payment_already_confirmed');
  assert.equal((await call(adminUpdatePaymentRequest, a, { params: { id: request.id }, body: { status: 'cancelled' } })).body.error, 'payment_already_confirmed');
});

test('a note-only edit and a pending → cancelled change touch the request; an event payment never goes back to pending', async () => {
  const { f, b } = await setup();
  const { orderId, request } = await submitted(f, b);
  const { a } = await admins();
  const edited = await call(adminUpdatePaymentRequest, a, { params: { id: request.id }, body: { note: 'looking into it' } });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal((await db('EventPayment').where({ orderId }).first()).status, 'pending');
  const rejectWithoutCode = await call(adminUpdatePaymentRequest, a, { params: { id: request.id }, body: { status: 'rejected' } });
  assert.equal(rejectWithoutCode.body.error, 'reason_code_required');
  const cancelled = await call(adminUpdatePaymentRequest, a, { params: { id: request.id }, body: { status: 'cancelled' } });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal((await db('EventPayment').where({ orderId }).first()).status, 'cancelled');
  const back = await call(adminUpdatePaymentRequest, a, { params: { id: request.id }, body: { status: 'pending' } });
  assert.deepEqual([back.status, back.body.error], [409, 'event_payment_change_not_allowed']);
});

// ── Scenario 9: the order expires while the payment is unknown ───────────

/** The hold lapses (the expiry job runs in the future); the pending request stays for staff. */
const lapse = async (orderIds) => {
  const out = await eventStore.expireHolds({ at: new Date(Date.now() + 3 * D) });
  for (const id of orderIds) assert.equal((await db('EventOrder').where({ id }).first()).status, 'expired', `${id} expired`);
  return out;
};
/** Inventory invariants: sold + held <= capacity and the ledger balances. */
async function ledgerBalances(ticketTypeId) {
  const t = await db('EventTicketType').where({ id: ticketTypeId }).first();
  assert.ok(t.sold + t.held <= t.capacity, `sold ${t.sold} + held ${t.held} <= ${t.capacity}`);
  const sums = Object.fromEntries((await db('EventInventoryMovement').where({ ticketTypeId }).groupBy('kind').select('kind').sum({ q: 'quantity' })).map(r => [r.kind, Number(r.q)]));
  const s = k => sums[k] ?? 0;
  assert.equal(s('hold') - s('release') - s('commit'), t.held, 'Σhold − Σrelease − Σcommit = held');
  assert.equal(s('commit') - s('uncommit'), t.sold, 'Σcommit − Σuncommit = sold');
}

test('scenario 9a, late payment and the places are still free: approving re-holds (cycle + 1), commits, revives the places and issues tickets; the ledger balances', async () => {
  const { f, b } = await setup();
  const { orderId, request } = await submitted(f, b, 2);
  await lapse([orderId]);
  assert.deepEqual(await h.counters(f.ticket.id), { sold: 0, held: 0, capacity: 5 });
  const view = (await call(eventOrderPaymentStatus, b.claims, { params: { id: orderId } })).body;
  assert.equal(view.payment.state, 'submitted'); assert.equal(view.order.status, 'expired');
  const { a } = await admins();
  const preview = (await call(adminPaymentRequests, a, { query: { productType: 'EVENT_ORDER' } })).body.find(r => r.id === request.id);
  assert.equal(preview.eventOrder.lateOutcome, 'would_rehold');
  const done = await decide(a, request.id, { decision: 'approve', amountTzs: 40000 });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual([done.body.event.outcome, done.body.event.ticketsIssued], ['reheld', 2]);
  const order = await db('EventOrder').where({ id: orderId }).first();
  assert.deepEqual([order.status, order.holdCycle, order.closeReason, order.closedAt], ['confirmed', 2, null, null]);
  assert.deepEqual(await h.counters(f.ticket.id), { sold: 2, held: 0, capacity: 5 });
  const moves = (await h.movements(orderId)).map(m => `${m.kind}@${m.cycle}`);
  assert.deepEqual(moves, ['hold@1', 'release@1', 'hold@2', 'commit@2']);
  assert.deepEqual((await db('EventRegistration').where({ orderId }).orderBy('id')).map(r => [r.status, r.cancelReason]), [['confirmed', null], ['confirmed', null]]);
  assert.equal((await db('EventTicket as t').join('EventRegistration as r', 'r.id', 't.registrationId').where('r.orderId', orderId)).length, 2);
  assert.equal((await db('AuditLog').where({ action: 'events.order_reheld', target: orderId })).length, 1);
  await ledgerBalances(f.ticket.id);
});

test('scenario 9b, late payment and the places are gone: nothing is oversold, an unfulfilled-payment refund is approved by policy in the same transaction, an ops exception is raised and the admin is told', async () => {
  const { f, b } = await setup();
  const f1 = await h.sellingEvent({ categories: [{ name: '5K', distanceMeters: 5000, tickets: [{ name: 'Only', priceTzs: 10000, capacity: 1 }] }] });
  const { orderId, request } = await submitted(f1, b);
  await lapse([orderId]);
  // someone else buys the last place meanwhile
  const other = await buyer();
  const taken = await place(f1, other);
  assert.deepEqual(await h.counters(f1.ticket.id), { sold: 0, held: 1, capacity: 1 });
  const { a } = await admins();
  assert.equal((await call(adminPaymentRequests, a, { query: { productType: 'EVENT_ORDER' } })).body.find(r => r.id === request.id).eventOrder.lateOutcome, 'would_refund');
  const done = await decide(a, request.id, { decision: 'approve', amountTzs: 10000 });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual([done.body.event.outcome, done.body.event.reason], ['refund_raised', 'capacity_unavailable']);
  assert.deepEqual(await h.counters(f1.ticket.id), { sold: 0, held: 1, capacity: 1 }, 'not oversold');
  assert.equal(done.body.paymentRequest.status, 'approved', 'the money did arrive (PAY-010)');
  const pay_ = await db('EventPayment').where({ orderId }).first();
  assert.deepEqual([pay_.status, pay_.failureReason, pay_.lateOrder], ['reconciliation_required', 'capacity_unavailable', true]);
  const refund = await db('Refund').where({ id: pay_.refundId }).first();
  assert.deepEqual([refund.kind, refund.scope, refund.status, refund.amountTzs, refund.decidedBy, refund.requestedRole, refund.reasonCode, refund.eventPaymentId], ['event_order', 'unfulfilled_payment', 'approved', 10000, 'policy', 'system', 'payment_error', pay_.id]);
  assert.equal((await db('EventOrder').where({ id: orderId }).first()).status, 'expired');
  assert.equal((await db('EventTicket as t').join('EventRegistration as r', 'r.id', 't.registrationId').where('r.orderId', orderId)).length, 0);
  const view = (await call(eventOrderPaymentStatus, b.claims, { params: { id: orderId } })).body;
  assert.equal(view.payment.state, 'needs_attention'); assert.equal(view.refund.status, 'approved'); assert.equal(view.refund.amountTzs, 10000);
  assert.equal((await h.notifications(b.sub, 'event_payment_refund_due')).length, 1);
  const ex = await db('OpsException').where({ dedupeKey: `evpay:${pay_.id}` }).first();
  assert.ok(ex && ex.severity === 'high' && ex.type === 'events_payment_reconciliation');
  await db('OpsException').where({ id: ex.id }).del();
  await ledgerBalances(f1.ticket.id);
  void taken; void f;
});

test('a person-cancelled order is never revived: its late payment takes the refund path', async () => {
  const { f, b } = await setup();
  const o = await place(f, b);
  const id = o.order.id;
  // the payment is submitted, then the admin cancels the order (the pending payment is cancelled with it) — here the money still arrives via a second path:
  const sub = await pay(b, id, { reference: txId(), payerPhone: b.phone });
  assert.equal(sub.status, 201);
  const { a } = await admins();
  const request = await db('PaymentRequest').where({ eventOrderId: id }).first();
  // cancel the order underneath the pending payment (an admin decided the places go back)
  await eventStore.releaseOrder(id, 'admin', { cancelReason: 'admin' });
  const done = await decide(a, request.id, { decision: 'approve', amountTzs: 20000 });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual([done.body.event.outcome, done.body.event.reason], ['refund_raised', 'order_cancelled']);
  assert.equal((await db('EventOrder').where({ id }).first()).status, 'cancelled');
  assert.deepEqual(await h.counters(f.ticket.id), { sold: 0, held: 0, capacity: 5 });
  await db('OpsException').where('dedupeKey', 'like', 'evpay:%').del();
});

test('two late approvals race for the last place: one is re-held, the other is refunded; never oversold', async () => {
  const { b } = await setup();
  const f1 = await h.sellingEvent({ categories: [{ name: '5K', distanceMeters: 5000, tickets: [{ name: 'Only', priceTzs: 10000, capacity: 1 }] }] });
  const b1 = await buyer(); const b2 = await buyer();
  const one = await submitted(f1, b1);
  await lapse([one.orderId]);
  const two = await submitted(f1, b2);
  await lapse([two.orderId]);
  const { a, b: second } = await admins();
  const [x, y] = await Promise.all([
    decide(a, one.request.id, { decision: 'approve', amountTzs: 10000 }),
    decide(second, two.request.id, { decision: 'approve', amountTzs: 10000 }),
  ]);
  const outcomes = [x, y].map(r => r.body.event?.outcome).sort();
  assert.deepEqual(outcomes, ['refund_raised', 'reheld'], JSON.stringify([x.body, y.body]));
  assert.deepEqual(await h.counters(f1.ticket.id), { sold: 1, held: 0, capacity: 1 });
  await ledgerBalances(f1.ticket.id);
  await db('OpsException').where('dedupeKey', 'like', 'evpay:%').del();
  void b;
});

// ── Repair, sweep, free orders ───────────────────────────────────────────

test('repair: an approved request whose order is not confirmed is completed by the route and by the sweep; an unapproved payment is never confirmed', async () => {
  const { f, b } = await setup();
  const { orderId, request } = await submitted(f, b);
  const { a } = await admins();
  const nothing = await call(adminRepairEventPayment, a, { params: { id: f.event.id, orderId } });
  assert.deepEqual([nothing.status, nothing.body.error], [409, 'nothing_to_repair'], 'a pending payment cannot be confirmed by repair');
  assert.equal((await db('EventOrder').where({ id: orderId }).first()).status, 'awaiting_payment');
  // simulate a crash between the request write and the confirmation (the legacy two-step shape)
  await db('PaymentRequest').where({ id: request.id }).update({ status: 'approved', decidedAt: new Date(), decidedBy: a.sub, reference: 'REPAIR1' });
  const list = (await call(adminPaymentRequests, a, { query: { productType: 'EVENT_ORDER' } })).body.find(r => r.id === request.id);
  assert.equal(list.eventOrder.repairable, true);
  const sweep = await eventsPaymentsService.sweep();
  assert.ok(sweep.repaired >= 1, JSON.stringify(sweep));
  assert.equal((await db('EventOrder').where({ id: orderId }).first()).status, 'confirmed');
  assert.equal((await db('EventPayment').where({ orderId }).first()).status, 'succeeded');
  assert.equal((await h.outbox(f.event.id, 'payment.succeeded')).length, 1);
  // a second order repaired through the route, with an audit row
  const b2 = await buyer();
  const two = await submitted(f, b2);
  await db('PaymentRequest').where({ id: two.request.id }).update({ status: 'approved', decidedAt: new Date(), decidedBy: a.sub, reference: 'REPAIR2' });
  const rep = await call(adminRepairEventPayment, a, { params: { id: f.event.id, orderId: two.orderId } });
  assert.deepEqual([rep.status, rep.body.repaired, rep.body.outcome], [200, true, 'confirmed']);
  assert.equal((await db('AuditLog').where({ action: 'events.order_repaired', target: two.orderId })).length, 1);
  assert.deepEqual((await call(adminRepairEventPayment, a, { params: { id: 'other-event', orderId: two.orderId } })).body, { error: 'order_not_found' });
  const again = await call(adminRepairEventPayment, a, { params: { id: f.event.id, orderId: two.orderId } });
  assert.equal(again.body.repaired, false);
});

test('free order (total 0): one POST confirms it with no PaymentRequest; the ticket is issued', async () => {
  s4On(); await saveManualDetails();
  const f = await h.sellingEvent({ categories: [{ name: 'Kids', distanceMeters: 1000, tickets: [{ name: 'Free', priceTzs: 0, capacity: 5 }] }] });
  const b = await buyer();
  const o = await place(f, b);
  assert.equal(o.order.totalTzs, 0);
  const r = await pay(b, o.order.id, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.payment.state, r.body.payment.method, r.body.next.payment], ['confirmed', 'free', 'none']);
  assert.equal((await db('PaymentRequest').where({ eventOrderId: o.order.id })).length, 0);
  assert.equal((await db('EventOrder').where({ id: o.order.id }).first()).status, 'confirmed');
  assert.equal((await db('EventTicket as t').join('EventRegistration as r2', 'r2.id', 't.registrationId').where('r2.orderId', o.order.id)).length, 1);
  assert.deepEqual(await h.counters(f.ticket.id), { sold: 1, held: 0, capacity: 5 });
});

// ── Status, collection field list, other products ────────────────────────

test('payment-status never returns staff fields, change data, approval stages or provider payloads', async () => {
  const { f, b } = await setup({ secondApprover: true });
  const { orderId, request } = await submitted(f, b);
  const { a } = await admins();
  await call(adminVerifyPaymentRequest, a, { params: { id: request.id }, body: { note: 'staff only' } });
  const body = (await call(eventOrderPaymentStatus, b.claims, { params: { id: orderId } })).body;
  const text = JSON.stringify(body);
  for (const secret of ['verifiedBy', 'decidedBy', 'changeRequested', 'approvalStage', 'rawRedacted', 'staff only', a.sub]) assert.ok(!text.includes(secret), secret);
  assert.deepEqual(Object.keys(body).sort(), ['order', 'payment', 'refund']);
  assert.equal(body.payment.payerPhoneMasked.includes('•'), true);
  assert.ok(!text.includes(b.phone.slice(-9)), 'the payer phone is masked');
  // another member gets 404
  const other = await buyer();
  assert.equal((await call(eventOrderPaymentStatus, other.claims, { params: { id: orderId } })).status, 404);
});

test('PaymentRequest written through the collection API keeps eventOrderId (knex-store field list)', async () => {
  const { f, b } = await setup();
  const o = await place(f, b);
  const id = `pay_${uid('').slice(1, 9)}`;
  await paymentRequests.insertAsync({ id, memberId: b.sub, amountTzs: 20000, currency: 'TZS', status: 'pending', provider: 'admin_approved', eventOrderId: o.order.id, requestedAt: new Date().toISOString() });
  assert.equal((await paymentRequests.findByIdAsync(id)).eventOrderId, o.order.id);
  assert.equal((await db('PaymentRequest').where({ id }).first()).eventOrderId, o.order.id);
  await db('PaymentRequest').where({ id }).del();
});

test('regression: a pass / plan payment request is decided exactly as before — no event key, no event hook, productType unchanged', async () => {
  s4On();
  const member = await h.user({});
  const id = `pay_${uid('').slice(1, 9)}`;
  await db('PaymentRequest').insert({ id, memberId: member, amountTzs: 50000, currency: 'TZS', status: 'pending', provider: 'admin_approved', tier: 'basic', note: 'pass' });
  const { a } = await admins();
  const out = await decide(a, id, { decision: 'approve' });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.status, 'approved');
  assert.ok(!('event' in out.body) && !('paymentRequest' in out.body), 'the response is the plain payment request');
  const listed = (await call(adminPaymentRequests, a, {})).body.find(r => r.id === id);
  assert.equal(listed.productType, 'FITFLEX_PASS');
  assert.ok(!('eventOrder' in listed));
  await db('PaymentRequest').where({ id }).del();
});

test('GET /me: an open event payment is listed as EVENT_ORDER with its event and order reference, and never holds the pass / plan slot', async () => {
  const { f, b } = await setup();
  const { request, o } = await submitted(f, b);
  const { subscriptionService, users } = await import('../src/bootstrap/services.mjs');
  const me = await subscriptionService.me(await users.findByIdAsync(b.sub));
  assert.equal(me.pendingPayment, null, 'an event payment is not a pass payment');
  const row = me.pendingPayments.find(p => p.id === request.id);
  assert.deepEqual([row.productType, row.eventTitle, row.eventOrderReference, row.eventOrderId], ['EVENT_ORDER', 'Dar Half Marathon', o.order.reference, o.order.id]);
  // a pass request keeps the slot beside it
  const pid = `pay_${uid('').slice(1, 9)}`;
  await db('PaymentRequest').insert({ id: pid, memberId: b.sub, amountTzs: 50000, currency: 'TZS', status: 'pending', provider: 'admin_approved', tier: 'basic' });
  const both = await subscriptionService.me(await users.findByIdAsync(b.sub));
  assert.equal(both.pendingPayment.id, pid);
  assert.ok(both.pendingPayments.some(p => p.id === request.id));
  assert.ok(!('eventTitle' in both.pendingPayments.find(p => p.id === pid)));
  await db('PaymentRequest').where({ id: pid }).del();
});

test('an order in a currency other than TZS is refused at initiation (409 unsupported_currency), and an organisation order cannot be paid by prompt', async () => {
  const { f, b } = await setup();
  const o = await place(f, b);
  await db('EventOrder').where({ id: o.order.id }).update({ currency: 'USD' });
  const r = await pay(b, o.order.id, { reference: txId(), payerPhone: b.phone });
  assert.deepEqual([r.status, r.body.error], [409, 'unsupported_currency']);
  assert.equal((await db('EventPayment').where({ orderId: o.order.id })).length, 0);
});

test('the order page: awaiting_payment carries next.instructions and allowedActions pay + cancel; once submitted: no cancel, no pay', async () => {
  const { f, b } = await setup();
  const o = await place(f, b, 2);
  const before = (await call(getMyEventOrder, b.claims, { params: { id: o.order.id } })).body;
  assert.deepEqual(before.allowedActions, ['pay', 'cancel']);
  assert.deepEqual([before.next.payment, before.next.instructions.accountName, before.next.instructions.reference, before.next.instructions.amountTzs, before.next.instructions.referenceRequired], ['manual', 'FitFlex Africa Ltd', o.order.reference, 40000, true]);
  assert.equal(before.payment, null); assert.deepEqual(before.refunds, []);
  await pay(b, o.order.id, { reference: txId(), payerPhone: b.phone });
  const after_ = (await call(getMyEventOrder, b.claims, { params: { id: o.order.id } })).body;
  assert.deepEqual(after_.allowedActions, []);
  assert.deepEqual([after_.payment.state, after_.payment.canRetry], ['submitted', false]);
  assert.ok(after_.payment.confirmTargetAt);
});
