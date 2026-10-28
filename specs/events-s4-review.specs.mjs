// Marathon & running events · S4 — the review fixes of PR #270 (security H1, M1–M6, L1–L9; rulings a–c; contract 3–15; Swahili).
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ensureInit } from '../functions/index.mjs';
import { createEventOrder, quoteEventOrder, cancelMyEventOrder, getMyEventRegistration, resetEventsRegistrationLimits } from '../functions/events-registration.mjs';
import { payForEventOrder, eventOrderPaymentStatus, getEventTicket, rotateEventTicket, resetEventsPaymentLimits } from '../functions/events-payments.mjs';
import { adminDecidePaymentRequest, adminUpdatePaymentRequest } from '../functions/admin-payments.mjs';
import { adminDecideRefund, adminMarkRefundPaid, adminRaiseRefund, myRefunds } from '../functions/refunds.mjs';
import { adminCancelEventOrder, adminCancelEvent, adminRepairEventPayment, adminEventOrderCancelPreview, adminRunEventRefundBatch, resetEventsAdminLimits } from '../functions/events-admin.mjs';
import { createB2BEventOrder, getB2BEventOrder, payB2BEventOrder, resetEventsCorporateLimits } from '../functions/events-corporate.mjs';
import { eventStore, eventsPaymentsService, eventsRefundsService, financeService, paymentRequests, opsService } from '../src/bootstrap/services.mjs';
import { describePolicy } from '../src/shared/events-refund-policy.mjs';
import { harness, s4On, s4Off, saveManualDetails, clearManualDetails, txId, uid, phone, D, H } from './fixtures/events-s4.mjs';

await ensureInit();
const h = harness();
const { db, call } = h;
afterEach(() => { s4Off(); resetEventsRegistrationLimits(); resetEventsPaymentLimits(); resetEventsAdminLimits(); resetEventsCorporateLimits(); });
after(async () => { await clearManualDetails(); await h.cleanup(); await db.destroy(); });

const key = () => `rv_${uid('').slice(1)}`;
const member = async () => { const p = phone(); const sub = await h.user({ phone: p }); return { claims: h.claimsOf(sub), sub, phone: p }; };
const admin = async () => h.claimsOf(await h.user({ userType: 'admin' }), 'admin');
const scoped = async scopes => ({ ...(await admin()), portalUser: true, aclPermissions: scopes });
const POLICY = { until_close: { preset: 'refund_until_close' }, custom: { preset: 'custom', text: { en: 'Contact us', sw: 'Wasiliana nasi' } } };

async function eventWith(policy, { price = 20000, capacity = 10 } = {}) {
  const startsAt = new Date(Date.now() + 40 * D);
  const f = await h.sellingEvent({ event: { startsAt, endsAt: new Date(+startsAt + 6 * H), registrationClosesAt: new Date(+startsAt - D) }, categories: [{ name: '10K', distanceMeters: 10000, tickets: [{ name: 'Early', priceTzs: price, capacity }] }] });
  await db('Event').where({ id: f.event.id }).update({ refundPolicySnapshot: JSON.stringify(policy) });
  return f;
}
const setup = async (policy = POLICY.until_close, opts) => { s4On(); await saveManualDetails(); return { f: await eventWith(policy, opts), b: await member() }; };
async function place(f, b, n = 1) {
  const participants = Array.from({ length: n }, (_, i) => (i === 0
    ? { ticketTypeId: f.ticket.id, firstName: 'Neema', lastName: 'Abdallah', phone: b.phone, consentBasis: 'self' }
    : { ticketTypeId: f.ticket.id, firstName: 'Zawadi', lastName: 'Mollel', phone: phone(), consentBasis: 'purchaser_authorised' }));
  const body = { eventId: f.event.id, lines: [{ ticketTypeId: f.ticket.id, quantity: n }], acceptedTerms: true, consentTextVersion: '2026-10-draft', participants };
  const q = await call(quoteEventOrder, b.claims, { body });
  const r = await call(createEventOrder, b.claims, { headers: { 'Idempotency-Key': key() }, body: { ...body, expectedTotalTzs: q.body.quote.totalTzs } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
const submit = async (b, orderId) => {
  const r = await call(payForEventOrder, b.claims, { params: { id: orderId }, headers: { 'Idempotency-Key': key() }, body: { reference: txId(), payerPhone: b.phone } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return db('PaymentRequest').where({ eventOrderId: orderId }).first();
};
async function paid(f, b, n = 1) {
  const o = await place(f, b, n);
  const request = await submit(b, o.order.id);
  const done = await call(adminDecidePaymentRequest, await admin(), { params: { id: request.id }, body: { decision: 'approve', amountTzs: 20000 * n } });
  assert.equal(done.body.event?.outcome, 'confirmed', JSON.stringify(done.body));
  return { orderId: o.order.id, request, regs: await db('EventRegistration').where({ orderId: o.order.id }).orderBy('id'), o };
}
const lapse = () => eventStore.expireHolds({ at: new Date(Date.now() + 3 * D) });

// ── H1 ───────────────────────────────────────────────────────────────────

test('H1: a late payment that was refunded is never confirmed again — not by the sweep (no alert loop), not by the repair route, not by an approval of the old request', async () => {
  const { b } = await setup();
  const f1 = await eventWith(POLICY.until_close, { price: 10000, capacity: 1 });
  const o = await place(f1, b);
  const request = await submit(b, o.order.id);
  await lapse();
  const taker = await member();
  const taken = await place(f1, taker);   // the last place goes to someone else
  const a = await admin();
  const done = await call(adminDecidePaymentRequest, a, { params: { id: request.id }, body: { decision: 'approve', amountTzs: 10000 } });
  assert.equal(done.body.event.outcome, 'refund_raised');
  const pay = await db('EventPayment').where({ orderId: o.order.id }).first();
  assert.equal((await call(adminMarkRefundPaid, await admin(), { params: { id: pay.refundId }, body: { paymentReference: 'OUT-1' } })).status, 200);
  assert.deepEqual([(await db('EventPayment').where({ id: pay.id }).first()).status, (await db('EventPayment').where({ id: pay.id }).first()).failureReason], ['failed', 'refunded_after_late_payment']);
  await db('OpsException').where('dedupeKey', 'like', 'ev%').del();
  // the other holder lets go: capacity is free again, which is exactly when a naive repair would "fix" the order
  await call(cancelMyEventOrder, taker.claims, { params: { id: taken.order.id }, body: { reason: 'other' } });
  const sweep = await eventsPaymentsService.sweep();
  assert.deepEqual([sweep.repaired, sweep.failed], [0, 0], JSON.stringify(sweep));
  assert.equal((await db('EventOrder').where({ id: o.order.id }).first()).status, 'expired');
  assert.equal((await db('EventTicket as t').join('EventRegistration as r', 'r.id', 't.registrationId').where('r.orderId', o.order.id)).length, 0);
  assert.equal((await db('OpsException').where('dedupeKey', 'like', `evord:${o.order.id}`)).length, 0, 'no alert');
  const rep = await call(adminRepairEventPayment, a, { params: { id: f1.event.id, orderId: o.order.id } });
  assert.deepEqual([rep.status, rep.body.error], [409, 'payment_refunded_or_closed']);
  // the request is approved already: a second decision is already_decided; a change request cannot revive it either
  assert.equal((await call(adminDecidePaymentRequest, a, { params: { id: request.id }, body: { decision: 'approve', amountTzs: 10000 } })).body.error, 'already_decided');
});

test('H1: a rejected payment revived by a second admin only inside confirmChange; a refunded one cannot be revived', async () => {
  const { f, b } = await setup(POLICY.until_close, {});
  s4On({ secondApprover: true });
  const o = await place(f, b);
  const request = await submit(b, o.order.id);
  const a = await admin();
  assert.equal((await call(adminDecidePaymentRequest, a, { params: { id: request.id }, body: { decision: 'reject', reasonCode: 'wrong_account' } })).status, 200);
  const pay = await db('EventPayment').where({ orderId: o.order.id }).first();
  // the sweep never touches a failed payment even if its request were approved
  await db('PaymentRequest').where({ id: request.id }).update({ status: 'approved' });
  assert.equal((await eventsPaymentsService.sweep()).repaired, 0);
  assert.equal((await db('EventPayment').where({ id: pay.id }).first()).status, 'failed');
  await db('PaymentRequest').where({ id: request.id }).update({ status: 'rejected' });
  // a refund already attached: the change cannot revive it
  await db('EventPayment').where({ id: pay.id }).update({ refundId: 'rfd_x' });
  const ask = await call((await import('../functions/admin-payments.mjs')).adminRequestPaymentChange, a, { params: { id: request.id }, body: { status: 'approved', reason: 'mistake' } });
  assert.equal(ask.status, 200);
  const second = await admin();
  const out = await call((await import('../functions/admin-payments.mjs')).adminConfirmPaymentChange, second, { params: { id: request.id }, body: { amountTzs: 20000 } });
  assert.deepEqual([out.status, out.body.error], [409, 'payment_refunded_or_closed']);
  await db('EventPayment').where({ id: pay.id }).update({ refundId: null });
});

// ── M1 ───────────────────────────────────────────────────────────────────

test('M1: an admin refund for an event payment is only for money that is held; never over an existing refund, never on a succeeded payment', async () => {
  const { f, b } = await setup();
  const ok = await paid(f, b);
  const okPay = await db('EventPayment').where({ orderId: ok.orderId }).first();
  const a = await admin();
  assert.equal((await call(adminRaiseRefund, a, { body: { eventPaymentId: okPay.id, reasonCode: 'payment_error' } })).body.error, 'payment_not_unfulfilled');
  assert.equal((await db('EventPayment').where({ id: okPay.id }).first()).refundId, null, 'a succeeded payment is never touched');
  const u = await member();
  const o2 = await place(f, u);
  const req2 = await submit(u, o2.order.id);
  await db('PaymentRequest').where({ id: req2.id }).update({ status: 'approved', decidedAt: new Date(), reference: 'MM-1' });
  await eventStore.releaseOrder(o2.order.id, 'admin');
  const p2 = await db('EventPayment').where({ orderId: o2.order.id }).first();
  await db('EventPayment').where({ id: p2.id }).update({ status: 'reconciliation_required', failureReason: 'order_cancelled' });
  const first = await call(adminRaiseRefund, a, { body: { eventPaymentId: p2.id, amountTzs: 5000, reasonCode: 'payment_error' } });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  // another refund already exists for this order (the payment now carries it)
  assert.deepEqual([(await call(adminRaiseRefund, a, { body: { eventPaymentId: p2.id, reasonCode: 'payment_error' } })).status], [409]);
  await db('EventPayment').where({ id: p2.id }).update({ refundId: null });
  assert.equal((await call(adminRaiseRefund, a, { body: { eventPaymentId: p2.id, amountTzs: 16000, reasonCode: 'payment_error' } })).body.error, 'refund_already_exists');
});

// ── M2 ───────────────────────────────────────────────────────────────────

test('M2: an approved or paid manual-review refund cancels the places it holds — at pay time, and by the sweep; markPaid does not leave a confirmed place behind', async () => {
  const { f, b } = await setup(POLICY.custom);
  const { orderId, regs } = await paid(f, b, 1);
  const { cancelMyEventRegistration } = await import('../functions/events-registration.mjs');
  const r = await call(cancelMyEventRegistration, b.claims, { params: { id: regs[0].id }, body: { reason: 'other', expectedRefundTzs: 20000 } });
  assert.equal(r.body.requested, true);
  const refund = await db('Refund').where({ eventOrderId: orderId }).first();
  // the approval's cancel step "failed": the row says approved, the place is still confirmed
  await db('Refund').where({ id: refund.id }).update({ status: 'approved', decidedBy: 'someone', decidedAt: new Date() });
  assert.equal((await db('EventRegistration').where({ id: regs[0].id }).first()).status, 'confirmed');
  const stats = await eventsPaymentsService.sweep({ refunds: eventsRefundsService });
  assert.ok(stats.refundsApplied >= 0);
  assert.equal((await db('EventRegistration').where({ id: regs[0].id }).first()).status, 'cancelled', 'the sweep cancelled it');
  // second order: markPaid cancels first, so a paid refund never leaves a ticket behind
  const two = await paid(f, b, 1);
  await call(cancelMyEventRegistration, b.claims, { params: { id: two.regs[0].id }, body: { reason: 'other', expectedRefundTzs: 20000 } });
  const rf = await db('Refund').where({ eventOrderId: two.orderId }).first();
  await db('Refund').where({ id: rf.id }).update({ status: 'approved', decidedBy: 'someone', decidedAt: new Date() });
  const done = await call(adminMarkRefundPaid, await admin(), { params: { id: rf.id }, body: { paymentReference: 'OUT-2' } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual((await db('EventRegistration').where({ orderId: two.orderId })).map(x => x.status), ['refunded']);
  assert.equal((await db('EventTicket').where({ registrationId: two.regs[0].id }).first()).status, 'revoked');
  // a refund that was paid straight in the table: the sweep re-applies it
  const three = await paid(f, b, 1);
  await call(cancelMyEventRegistration, b.claims, { params: { id: three.regs[0].id }, body: { reason: 'other', expectedRefundTzs: 20000 } });
  const r3 = await db('Refund').where({ eventOrderId: three.orderId }).first();
  await db('Refund').where({ id: r3.id }).update({ status: 'paid', paidAt: new Date(), paymentReference: 'X', decidedBy: 'someone' });
  await eventsPaymentsService.sweep({ refunds: eventsRefundsService });
  assert.deepEqual((await db('EventRegistration').where({ orderId: three.orderId })).map(x => x.status), ['refunded']);
});

// ── M3 ───────────────────────────────────────────────────────────────────

test('M3: event ticket money is not subscription income in the books', async () => {
  const { f, b } = await setup();
  const { request } = await paid(f, b, 1);
  const entries = await financeService.bookKeeping({ paymentRequests });
  assert.ok(!entries.some(e => e.id === request.id), 'the event payment is not an income entry');
  assert.ok(!JSON.stringify(entries).includes(request.id));
});

// ── M4 ───────────────────────────────────────────────────────────────────

test('M4: with one approver (no MONEY_SECOND_APPROVER) the mode is none and nothing is taken, unless EVENTS_ALLOW_SINGLE_APPROVER=1', async () => {
  const { f, b } = await setup();
  const o = await place(f, b);
  delete process.env.EVENTS_ALLOW_SINGLE_APPROVER;
  assert.equal(eventsPaymentsService.mode(), 'none');
  assert.equal(eventsPaymentsService.optionsBlock().payment, 'none');
  const r = await call(payForEventOrder, b.claims, { params: { id: o.order.id }, headers: { 'Idempotency-Key': key() }, body: { reference: txId(), payerPhone: b.phone } });
  assert.deepEqual([r.status, r.body.error, r.body.mode], [409, 'payment_mode_mismatch', 'none']);
  assert.equal((await db('EventPayment').where({ orderId: o.order.id })).length, 0);
  process.env.MONEY_SECOND_APPROVER = '1';
  assert.equal(eventsPaymentsService.mode(), 'manual');
  delete process.env.MONEY_SECOND_APPROVER;
  process.env.EVENTS_ALLOW_SINGLE_APPROVER = '1';
  assert.equal(eventsPaymentsService.mode(), 'manual');
});

// ── M5 + ruling (a) ──────────────────────────────────────────────────────

test('M5: an events-only admin cannot cancel a paid order with no refund (403 payments_scope_required); full and policy only create requests', async () => {
  const { f, b } = await setup();
  const eventsOnly = await scoped(['events']);
  const one = await paid(f, b);
  const none = await call(adminCancelEventOrder, eventsOnly, { params: { id: f.event.id, orderId: one.orderId }, body: { note: 'by mistake', refundMode: 'none' } });
  assert.deepEqual([none.status, none.body.error], [403, 'payments_scope_required']);
  assert.equal((await db('EventOrder').where({ id: one.orderId }).first()).status, 'confirmed');
  const full = await call(adminCancelEventOrder, eventsOnly, { params: { id: f.event.id, orderId: one.orderId }, body: { note: 'organizer asked', refundMode: 'full' } });
  assert.equal(full.status, 200, JSON.stringify(full.body));
  assert.equal(full.body.refund.status, 'requested');
  const two = await paid(f, b);
  const withScope = await scoped(['events', 'payments']);
  assert.equal((await call(adminCancelEventOrder, withScope, { params: { id: f.event.id, orderId: two.orderId }, body: { note: 'goodwill no refund', refundMode: 'none' } })).status, 200);
});

test('ruling (a): an admin `policy` refund on a custom preset is 409 policy_not_evaluable (full or none instead); the admin preview says so', async () => {
  const { f, b } = await setup(POLICY.custom);
  const one = await paid(f, b);
  const a = await admin();
  const prev = await call(adminEventOrderCancelPreview, a, { params: { id: f.event.id, orderId: one.orderId } });
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  assert.deepEqual([prev.body.modes.full.refundTzs, prev.body.modes.none.refundTzs, prev.body.modes.policy.evaluable, prev.body.modes.policy.error], [20000, 0, false, 'policy_not_evaluable']);
  const r = await call(adminCancelEventOrder, a, { params: { id: f.event.id, orderId: one.orderId }, body: { note: 'by policy', refundMode: 'policy' } });
  assert.deepEqual([r.status, r.body.error], [409, 'policy_not_evaluable']);
  assert.equal((await db('EventOrder').where({ id: one.orderId }).first()).status, 'confirmed');
  // evaluable preset: the preview shows the amounts per mode
  const g = await eventWith(POLICY.until_close);
  const two = await paid(g, b);
  const p2 = (await call(adminEventOrderCancelPreview, a, { params: { id: g.event.id, orderId: two.orderId } })).body;
  assert.deepEqual([p2.modes.policy.evaluable, p2.modes.policy.refundTzs, p2.modes.policy.percent, p2.policy.generated.en.length > 5], [true, 20000, 100, true]);
  assert.equal((await call(adminEventOrderCancelPreview, a, { params: { id: g.event.id, orderId: 'nope' } })).status, 404);
});

// ── M6 + ruling (c) ──────────────────────────────────────────────────────

test('M6: the refund batch is resumed by the sweep; an order with one held place still refunds its other places; cancel surfaces a batch error; the expected money is required when paid orders exist', async () => {
  const { f, b } = await setup(POLICY.custom);
  const one = await paid(f, b, 2);
  // one of the two places has a manual-review request (it holds its own refund)
  const { cancelMyEventRegistration } = await import('../functions/events-registration.mjs');
  await call(cancelMyEventRegistration, b.claims, { params: { id: one.regs[0].id }, body: { reason: 'other', expectedRefundTzs: 20000 } });
  const a = await admin();
  // ruling c: required when paid orders exist
  const missing = await call(adminCancelEvent, a, { params: { id: f.event.id }, body: { reason: 'weather' } });
  assert.deepEqual([missing.status, missing.body.error, missing.body.refundableTzs], [400, 'expected_refundable_required', 20000]);
  // a batch that fails: the event is cancelled, the admin is told, nothing is swallowed
  const real = eventsRefundsService.runEventBatch;
  eventsRefundsService.runEventBatch = async () => ({ error: 'boom', status: 500 });
  const failed = await call(adminCancelEvent, a, { params: { id: f.event.id }, body: { reason: 'weather', expectedRefundableTzs: 20000 } });
  eventsRefundsService.runEventBatch = real;
  assert.equal(failed.status, 200);
  assert.equal(failed.body.status, 'cancelled'); assert.equal(failed.body.batch.error, 'boom');
  assert.match(failed.body.batch.resumeWith, /refund-batch$/);
  assert.equal((await db('Refund').where({ eventId: f.event.id, scope: 'event_cancelled' })).length, 0);
  // the sweep resumes it: the held place keeps its own request, the other place is refunded
  const stats = await eventsPaymentsService.sweep({ refunds: eventsRefundsService });
  assert.ok(stats.batchesResumed >= 1, JSON.stringify(stats));
  const refunds = await db('Refund').where({ eventOrderId: one.orderId }).orderBy('amountTzs');
  assert.deepEqual(refunds.map(r => [r.scope, r.amountTzs]).sort(), [['event_cancelled', 20000], ['registration', 20000]].sort());
  const regs = await db('EventRegistration').where({ orderId: one.orderId }).orderBy('id');
  assert.deepEqual(regs.map(r => r.status).sort(), ['cancelled', 'confirmed']);
  assert.equal((await eventsPaymentsService.sweep({ refunds: eventsRefundsService })).batchesResumed, 0, 'nothing left to resume');
  const again = await call(adminRunEventRefundBatch, a, { params: { id: f.event.id }, body: {} });
  assert.equal(again.status, 200); assert.equal(again.body.created, 0);
});

// ── Ruling (b): organisation refunds ─────────────────────────────────────

test('ruling (b): an organisation refund reaches only a coordinator who still holds a billing role; otherwise the billing contacts; never listed for someone who left; a missing coordinator does not break the refund', async () => {
  s4On(); await saveManualDetails();
  const f = await eventWith(POLICY.until_close);
  const org = await h.organization();
  const finance = await org.member('finance');
  const owner = await org.member('owner');
  const body = { eventId: f.event.id, rows: [{ firstName: 'Asha', lastName: 'Mollel', phone: phone(), category: '10K' }], acceptedTerms: true, consentTextVersion: '2026-10-draft', expectedTotalTzs: 20000 };
  const placed = await call(createB2BEventOrder, finance, { params: { id: org.id }, headers: { 'Idempotency-Key': key() }, body });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  const orderId = placed.body.order.id;
  const sent = await call(payB2BEventOrder, finance, { params: { id: org.id, orderId }, headers: { 'Idempotency-Key': key() }, body: { method: 'bank_transfer', reference: 'CRDB-TRF-1001', paidOn: new Date(Date.now() + 3 * H).toISOString().slice(0, 10) } });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  const req = await db('PaymentRequest').where({ eventOrderId: orderId }).first();
  assert.equal((await call(adminDecidePaymentRequest, await admin(), { params: { id: req.id }, body: { decision: 'approve', amountTzs: 20000 } })).body.event.outcome, 'confirmed');
  // the coordinator leaves the organisation before the event is cancelled
  await db('B2BOrganizationUser').where({ organizationId: org.id, userId: finance.sub }).update({ status: 'removed', removedAt: new Date() });
  const a = await admin();
  const cancelled = await call(adminCancelEvent, a, { params: { id: f.event.id }, body: { reason: 'weather', expectedRefundableTzs: 20000 } });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  const refund = await db('Refund').where({ eventOrderId: orderId }).first();
  assert.equal(refund.organizationId, org.id);
  assert.equal(refund.memberId, owner.sub, 'addressed to a current billing contact, not the person who left');
  assert.equal((await h.notifications(finance.sub, 'event_cancelled_refund')).length, 0);
  assert.equal((await h.notifications(owner.sub, 'event_cancelled_refund')).length, 1);
  // /me/refunds: the leaver sees nothing; the owner sees it
  assert.deepEqual((await call(myRefunds, finance, {})).body.refunds.filter(r => r.eventOrderId === orderId), []);
  assert.equal((await call(myRefunds, owner, {})).body.refunds.filter(r => r.eventOrderId === orderId).length, 1);
  // the payout destination is never the coordinator's phone (no payer phone on an organisation order)
  const listed = (await call((await import('../functions/refunds.mjs')).adminListRefunds, a, { query: {} })).body.refunds.find(r => r.id === refund.id);
  assert.equal(listed.payerPhone, null);
  assert.equal(listed.organizationName != null, true);
  void getB2BEventOrder;
});

// ── L1–L9 ────────────────────────────────────────────────────────────────

test('L1: /me/refunds returns the member RefundView for event rows — no note, requestedBy, decidedBy, decisionNote, policySnapshot', async () => {
  const { f, b } = await setup();
  const { orderId } = await paid(f, b, 1);
  await call(cancelMyEventOrder, b.claims, { params: { id: orderId }, body: { reason: 'other', expectedRefundTzs: 20000 } });
  const row = (await call(myRefunds, b.claims, {})).body.refunds.find(r => r.eventOrderId === orderId);
  for (const k of ['note', 'requestedBy', 'decidedBy', 'decisionNote', 'policySnapshot', 'memberId', 'paidBy', 'organizerId']) assert.ok(!(k in row), k);
  assert.deepEqual([row.kind, row.status, row.scope, row.amountTzs, row.orderReference.startsWith('EV-')], ['event_order', 'approved', 'order', 20000, true]);
});

test('L2: a throw after the commit cannot turn a confirmation into a 500', async () => {
  await assert.doesNotReject(() => eventsPaymentsService.internals.afterDecision({ outcome: 'confirmed', changed: true, order: { id: 'eor_x', eventId: 'evt_missing' }, payment: {}, tickets: null }));
});

test('L4 + L5: a confirmed event payment keeps its reference; a held amount / transaction mismatch cannot be approved', async () => {
  const { f, b } = await setup();
  const { request } = await paid(f, b, 1);
  const a = await admin();
  const edit = await call(adminUpdatePaymentRequest, a, { params: { id: request.id }, body: { reference: 'OTHERREF99' } });
  assert.deepEqual([edit.status, edit.body.error], [409, 'payment_already_confirmed']);
  const u = await member();
  const o2 = await place(f, u);
  const req2 = await submit(u, o2.order.id);
  await db('EventPayment').where({ orderId: o2.order.id }).update({ status: 'reconciliation_required', failureReason: 'amount_mismatch' });
  const out = await call(adminDecidePaymentRequest, a, { params: { id: req2.id }, body: { decision: 'approve', amountTzs: 20000 } });
  assert.deepEqual([out.status, out.body.error, out.body.failureReason], [409, 'payment_held_mismatch', 'amount_mismatch']);
});

test('L7 + L8: a failed rotation on claim raises an ops alert; a ticket whose key is gone answers 409 rotate_required and a rotate heals it', async () => {
  const { f, b } = await setup();
  const { regs } = await paid(f, b, 1);
  const reg = regs[0];
  process.env.EVENT_TICKET_SECRET_PREVIOUS = '';
  // make the ticket "older key": mark it as made under k0 which is not in the ring
  await db('EventTicket').where({ registrationId: reg.id }).update({ tokenKeyId: 'k0' });
  const gone = await call(getEventTicket, b.claims, { params: { id: reg.id } });
  assert.deepEqual([gone.status, gone.body.error], [409, 'rotate_required']);
  const healed = await call(rotateEventTicket, b.claims, { params: { id: reg.id } });
  assert.equal(healed.status, 200, JSON.stringify(healed.body));
  assert.equal((await call(getEventTicket, b.claims, { params: { id: reg.id } })).status, 200);
  // L7: no secret at claim time → the purchaser may still hold the old code → alert
  const saved = process.env.EVENT_TICKET_SECRET;
  delete process.env.EVENT_TICKET_SECRET;
  await eventsPaymentsService.onClaimed({ id: reg.id });
  process.env.EVENT_TICKET_SECRET = saved;
  const ex = await db('OpsException').where({ dedupeKey: `evrot:${reg.id}` }).first();
  assert.ok(ex && ex.severity === 'high');
  await db('OpsException').where({ id: ex.id }).del();
  void opsService;
});

// ── Contract ─────────────────────────────────────────────────────────────

test('contract: flat claim fields, refunds[] on the registration, ticketType on the ticket, payerMethod / paidOn on the PaymentView, 240 polls an hour per order', async () => {
  const { f, b } = await setup();
  const { orderId, regs } = await paid(f, b, 2);
  const { getMyEventOrder } = await import('../functions/events-registration.mjs');
  const detail = (await call(getMyEventOrder, b.claims, { params: { id: orderId } })).body;
  for (const r of detail.registrations) assert.ok('claimInvitedAt' in r && 'claimInviteCount' in r && 'invitation' in r, 'both shapes');
  assert.equal(detail.payment.payerMethod, null); assert.ok('paidOn' in detail.payment);
  assert.equal(detail.payment.state, 'confirmed');
  // refunds[] on the place
  const { cancelMyEventRegistration } = await import('../functions/events-registration.mjs');
  assert.deepEqual((await call(getMyEventRegistration, b.claims, { params: { id: regs[0].id } })).body.refunds, []);
  await call(cancelMyEventRegistration, b.claims, { params: { id: regs[1].id }, body: { reason: 'other', expectedRefundTzs: 20000 } });
  const reg = (await call(getMyEventRegistration, b.claims, { params: { id: regs[1].id } })).body;
  assert.deepEqual([reg.refunds.length, reg.refunds[0].scope, reg.refunds[0].amountTzs], [1, 'registration', 20000]);
  const t = await call(getEventTicket, b.claims, { params: { id: regs[0].id } });
  assert.deepEqual([t.body.ticketType.name, t.body.ticketType.id], ['Early', f.ticket.id]);
  // the status limit is per order and fits a 30-second poll (not per user)
  for (let i = 0; i < 130; i += 1) { const r = await call(eventOrderPaymentStatus, b.claims, { params: { id: orderId } }); assert.equal(r.status, 200, `poll ${i}`); }
  const other = await place(f, b, 1).catch(() => null);
  if (other) assert.equal((await call(eventOrderPaymentStatus, b.claims, { params: { id: other.order.id } })).status, 200, 'another order has its own allowance');
});

// ── Swahili ──────────────────────────────────────────────────────────────

test('Swahili: tiered line grammar, plurals, the date when a hold runs past today, labelled admin notes, every reject code in both languages, refund wording', async () => {
  assert.equal(describePolicy({ preset: 'tiered', tiers: [{ daysBefore: 7, percent: 50 }] }).sw, 'Marejesho ya asilimia 50 hadi siku 7 kabla ya tukio, kisha hakuna marejesho.');
  assert.equal(describePolicy({ preset: 'tiered', tiers: [{ daysBefore: 30, percent: 100 }, { daysBefore: 14, percent: 50 }] }).sw, 'Marejesho ya asilimia 100 hadi siku 30 kabla ya tukio, kisha asilimia 50 hadi siku 14 kabla ya tukio, kisha hakuna marejesho.');
  const { f, b } = await setup();
  // submitted: the hold now runs to tomorrow — the message says "kesho" / "tomorrow"; 1-hour plural
  process.env.EVENTS_MANUAL_CONFIRM_SLA_HOURS = '1';
  const o = await place(f, b);
  await submit(b, o.order.id);
  const n = (await h.notifications(b.sub, 'event_payment_submitted'))[0];
  assert.match(n.data.bodyEn, /within 1 hour\. /);
  assert.match(n.data.bodyEn, /held until tomorrow \d{2}:\d{2}\./);
  assert.match(n.data.bodySw, /saa 1\. .*hadi kesho \d{1,2}:\d{2}/);
  delete process.env.EVENTS_MANUAL_CONFIRM_SLA_HOURS;
  // rejection: every code has en + sw text; admin notes are labelled in Swahili unless a Swahili note was sent
  const a = await admin();
  const request = await db('PaymentRequest').where({ eventOrderId: o.order.id }).first();
  const rej = await call(adminDecidePaymentRequest, a, { params: { id: request.id }, body: { decision: 'reject', reasonCode: 'other', memberNote: 'Please resend the SMS', memberNoteSw: 'Tafadhali tuma SMS tena' } });
  assert.equal(rej.status, 200, JSON.stringify(rej.body));
  const view = (await call(eventOrderPaymentStatus, b.claims, { params: { id: o.order.id } })).body.payment;
  assert.deepEqual([view.memberNote, view.memberNoteSw], ['Please resend the SMS', 'Tafadhali tuma SMS tena']);
  const rn = (await h.notifications(b.sub, 'event_payment_rejected'))[0];
  assert.match(rn.data.bodySw, /^Hatukuweza kuthibitisha malipo yako\. Tafadhali tuma SMS tena/);
  assert.match(rn.data.bodyEn, /^We couldn't confirm your payment\. Please resend the SMS/);
  const u = await member();
  const o2 = await place(f, u);
  const r2 = await submit(u, o2.order.id);
  await call(adminDecidePaymentRequest, a, { params: { id: r2.id }, body: { decision: 'reject', reasonCode: 'wrong_account', memberNote: 'Wrong till' } });
  const rn2 = (await h.notifications(u.sub, 'event_payment_rejected'))[0];
  assert.match(rn2.data.bodySw, /Maelezo kutoka FitFlex \(kwa Kiingereza\): Wrong till/);
  for (const code of ['reference_not_found', 'amount_mismatch', 'wrong_account', 'duplicate_reference', 'other']) {
    const x = await member(); const ox = await place(f, x); const rx = await submit(x, ox.order.id);
    await call(adminDecidePaymentRequest, a, { params: { id: rx.id }, body: { decision: 'reject', reasonCode: code, memberNote: 'n' } });
    const nx = (await h.notifications(x.sub, 'event_payment_rejected'))[0];
    assert.ok(nx.data.bodyEn.length > 20 && nx.data.bodySw.length > 20, code);
    assert.ok(!/[A-Z]{3,}|undefined/.test(nx.data.bodySw.replace(/FitFlex|Maelezo kutoka FitFlex \(kwa Kiingereza\): n/g, '')), code);
  }
  // refunds: paid body says "Namba ya muamala"; rejected title "yamekataliwa" with the labelled English note; no 'the event' in Swahili
  const g = await eventWith(POLICY.custom);
  const mk = async () => { const x = await member(); return x; };
  let c = await mk();
  const op = await place(g, c); const rq = await submit(c, op.order.id);
  await call(adminDecidePaymentRequest, a, { params: { id: rq.id }, body: { decision: 'approve', amountTzs: 20000 } });
  const { cancelMyEventOrder: cancel } = await import('../functions/events-registration.mjs');
  await call(cancel, c.claims, { params: { id: op.order.id }, body: { reason: 'other', expectedRefundTzs: 20000 } });
  const refund = await db('Refund').where({ eventOrderId: op.order.id }).first();
  assert.equal((await call(adminDecideRefund, a, { params: { id: refund.id }, body: { decision: 'reject', note: 'Outside our policy' } })).status, 200);
  const rejN = (await h.notifications(c.sub, 'event_refund_rejected'))[0];
  assert.equal(rejN.data.titleSw, 'Marejesho yamekataliwa');
  assert.equal(rejN.data.bodySw, 'Maelezo kutoka FitFlex (kwa Kiingereza): Outside our policy');
  c = await mk();
  const refund2 = (await (async () => { const o3 = await place(g, c); const r3 = await submit(c, o3.order.id); await call(adminDecidePaymentRequest, a, { params: { id: r3.id }, body: { decision: 'approve', amountTzs: 20000 } }); await call(cancel, c.claims, { params: { id: o3.order.id }, body: { reason: 'other', expectedRefundTzs: 20000 } }); return db('Refund').where({ eventOrderId: o3.order.id }).first(); })());
  const rjSw = await call(adminDecideRefund, a, { params: { id: refund2.id }, body: { decision: 'reject', note: 'Not allowed', noteSw: 'Hairuhusiwi' } });
  assert.equal(rjSw.status, 200);
  assert.equal((await h.notifications(c.sub, 'event_refund_rejected')).find(x => x.data.bodyEn === 'Not allowed').data.bodySw, 'Hairuhusiwi');
  c = await mk();
  const refund3 = await (async () => { const o4 = await place(g, c); const r4 = await submit(c, o4.order.id); await call(adminDecidePaymentRequest, a, { params: { id: r4.id }, body: { decision: 'approve', amountTzs: 20000 } }); await call(cancel, c.claims, { params: { id: o4.order.id }, body: { reason: 'other', expectedRefundTzs: 20000 } }); return db('Refund').where({ eventOrderId: o4.order.id }).first(); })();
  await call(adminDecideRefund, a, { params: { id: refund3.id }, body: { decision: 'approve' } });
  assert.equal((await call(adminMarkRefundPaid, await admin(), { params: { id: refund3.id }, body: { paymentReference: 'MP123' } })).status, 200);
  const paidN = (await h.notifications(c.sub, 'event_refund_paid')).find(x => x.data.bodyEn.includes('MP123'));
  assert.match(paidN.data.bodySw, /Namba ya muamala: MP123/);
});

test('Swahili: an unfulfilled payment says "Malipo yatarejeshwa"; the cancelled-event email subject says cancelled in both languages; no English fallback in a Swahili sentence', async () => {
  const { b } = await setup();
  const f1 = await eventWith(POLICY.until_close, { price: 10000, capacity: 1 });
  const o = await place(f1, b);
  const request = await submit(b, o.order.id);
  await lapse();
  await place(f1, await member());
  const dd = await call(adminDecidePaymentRequest, await admin(), { params: { id: request.id }, body: { decision: 'approve', amountTzs: 10000 } });
  assert.equal(dd.body.event?.outcome, 'refund_raised', JSON.stringify(dd.body));
  const n = (await h.notifications(b.sub, 'event_payment_refund_due'))[0];
  assert.match(n.data.bodySw, /Malipo yatarejeshwa kikamilifu\./);
  assert.ok(!/refund|the event/i.test(n.data.bodySw));
  await db('OpsException').where('dedupeKey', 'like', 'evpay:%').del();
  // the cancelled-event notice to an unclaimed place with only an email
  const sent = [];
  const { createEventsRefundService } = await import('../src/services/events-refund-service.mjs');
  const { eventMoneyStore, eventsRegistrationService } = await import('../src/bootstrap/services.mjs');
  const svc = createEventsRefundService({ db, eventStore, money: eventMoneyStore, registration: eventsRegistrationService, senders: { sms: () => ({ configured: false }), email: () => ({ configured: true, send: async (to, m) => { sent.push(m); return { ok: true }; } }) } });
  void svc;
  // exercise through the batch with a stubbed email sender
  const g = await eventWith(POLICY.until_close);
  const buyer = await member();
  const participants = [{ ticketTypeId: g.ticket.id, firstName: 'Neema', lastName: 'Abdallah', phone: buyer.phone, consentBasis: 'self' }, { ticketTypeId: g.ticket.id, firstName: 'Zawadi', lastName: 'Mollel', phone: phone(), email: 'zawadi@example.test', consentBasis: 'purchaser_authorised' }];
  const body = { eventId: g.event.id, lines: [{ ticketTypeId: g.ticket.id, quantity: 2 }], acceptedTerms: true, consentTextVersion: '2026-10-draft', participants };
  const q = await call(quoteEventOrder, buyer.claims, { body });
  const ord = (await call(createEventOrder, buyer.claims, { headers: { 'Idempotency-Key': key() }, body: { ...body, expectedTotalTzs: q.body.quote.totalTzs } })).body;
  const rq = await submit(buyer, ord.order.id);
  await call(adminDecidePaymentRequest, await admin(), { params: { id: rq.id }, body: { decision: 'approve', amountTzs: 40000 } });
  await db('Event').where({ id: g.event.id }).update({ status: 'cancelled', cancelledAt: new Date() });
  const svc2 = createEventsRefundService({ db, eventStore, money: eventMoneyStore, registration: eventsRegistrationService, senders: { sms: () => ({ configured: false }), email: () => ({ configured: true, send: async (to, m) => { sent.push({ to, ...m }); return { ok: true }; } }) } });
  const out = await svc2.runEventBatch({ eventId: g.event.id, actorId: 'spec' });
  assert.equal(out.created, 1, JSON.stringify(out));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, 'Dar Half Marathon imeghairiwa / Dar Half Marathon cancelled');
});

// ── Final contract re-check ──────────────────────────────────────────────

test('(4) a corporate order shows next.payment "none" while the launch gate is closed, "manual" once it opens', async () => {
  s4On(); await saveManualDetails();
  const f = await eventWith(POLICY.until_close);
  const org = await h.organization();
  const finance = await org.member('finance');
  const body = { eventId: f.event.id, rows: [{ firstName: 'Asha', lastName: 'Mollel', phone: phone(), category: '10K' }], acceptedTerms: true, consentTextVersion: '2026-10-draft', expectedTotalTzs: 20000 };
  const placed = await call(createB2BEventOrder, finance, { params: { id: org.id }, headers: { 'Idempotency-Key': key() }, body });
  assert.equal(placed.body.next.payment, 'manual');
  delete process.env.EVENTS_ALLOW_SINGLE_APPROVER;
  const closed = (await call(getB2BEventOrder, finance, { params: { id: org.id, orderId: placed.body.order.id } })).body;
  assert.deepEqual([closed.next.payment, closed.next.instructions, closed.allowedActions.includes('pay')], ['none', null, false]);
  process.env.MONEY_SECOND_APPROVER = '1';
  assert.equal((await call(getB2BEventOrder, finance, { params: { id: org.id, orderId: placed.body.order.id } })).body.next.payment, 'manual');
});

test('(9) repairable is false for an approved request whose payment carries a refund, in the Payments row and in paymentPanel; true for an open one', async () => {
  const { f, b } = await setup();
  const o = await place(f, b);
  const request = await submit(b, o.order.id);
  const a = await admin();
  const rowOf = async () => (await call((await import('../functions/admin-payments.mjs')).adminPaymentRequests, a, { query: { productType: 'EVENT_ORDER' } })).body.find(r => r.id === request.id);
  const panel = async () => (await call((await import('../functions/events-admin.mjs')).adminGetEventOrder, a, { params: { id: f.event.id, orderId: o.order.id } })).body.paymentPanel.payments[0];
  await db('PaymentRequest').where({ id: request.id }).update({ status: 'approved', decidedAt: new Date(), reference: 'RP1' });
  assert.deepEqual([(await rowOf()).eventOrder.repairable, (await panel()).repairable], [true, true]);
  await db('EventPayment').where({ orderId: o.order.id }).update({ status: 'failed', refundId: 'rfd_late', failureReason: 'refunded_after_late_payment' });
  assert.deepEqual([(await rowOf()).eventOrder.repairable, (await panel()).repairable], [false, false]);
  await db('EventPayment').where({ orderId: o.order.id }).update({ status: 'failed', refundId: 'rfd_late', failureReason: null });
  assert.equal((await rowOf()).eventOrder.repairable, false, 'any refundId');
  await db('EventPayment').where({ orderId: o.order.id }).update({ status: 'reconciliation_required', refundId: 'rfd_late' });
  assert.equal((await panel()).repairable, false);
});
