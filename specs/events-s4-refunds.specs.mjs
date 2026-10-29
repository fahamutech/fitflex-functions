// Marathon & running events · S4 — refunds at the route level against the CI database (spec §3.12, §3.13, §3.19 items 9–10):
// member cancellation of a paid place or order under each preset, the refund row in the SAME transaction as the
// cancellation, ticket revocation and inventory (`uncommit`) rules, manual review, partial cancellation, idempotency and
// races (member vs admin vs event), the admin paid-order cancel, the refund batch of a cancelled event (scenario 10),
// refund approval by a second admin, what a paid refund does to places, order and payment, and the finance totals.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ensureInit } from '../functions/index.mjs';
import { createEventOrder, quoteEventOrder, cancelMyEventOrder, cancelMyEventRegistration, getMyEventOrder, getMyEventRegistration, resetEventsRegistrationLimits } from '../functions/events-registration.mjs';
import { payForEventOrder, eventOrderCancelPreview, eventRegistrationCancelPreview, getEventTicket, eventOrderPaymentStatus, resetEventsPaymentLimits } from '../functions/events-payments.mjs';
import { adminDecidePaymentRequest, adminVerifyPaymentRequest } from '../functions/admin-payments.mjs';
import { adminDecideRefund, adminMarkRefundPaid, adminListRefunds, adminRaiseRefund, myRefunds, adminDecideRefundBatch, adminMarkRefundBatchPaid } from '../functions/refunds.mjs';
import { adminCancelEventOrder, adminCancelEvent, adminEventCancelPreview, adminRunEventRefundBatch, adminEventFinance, adminGetEventOrder, resetEventsAdminLimits } from '../functions/events-admin.mjs';
import { organizerEventFinance, organizerCancelEvent, resetEventsOrganizerLimits } from '../functions/events-organizer.mjs';
import { eventStore } from '../src/bootstrap/services.mjs';
import { harness, s4On, s4Off, saveManualDetails, clearManualDetails, txId, uid, phone, D, H } from './fixtures/events-s4.mjs';

await ensureInit();
const h = harness();
const { db, call } = h;
afterEach(() => { s4Off(); resetEventsRegistrationLimits(); resetEventsPaymentLimits(); resetEventsAdminLimits(); resetEventsOrganizerLimits(); });
after(async () => { await clearManualDetails(); await h.cleanup(); await db.destroy(); });

const key = () => `rf_${uid('').slice(1)}`;
const member = async () => { const p = phone(); const sub = await h.user({ phone: p }); return { claims: h.claimsOf(sub), sub, phone: p }; };
const admin = async () => h.claimsOf(await h.user({ userType: 'admin' }), 'admin');
const POLICY = {
  no_refund: { preset: 'no_refund' },
  until_close: { preset: 'refund_until_close' },
  days: days => ({ preset: 'full_until_days', days }),
  tiered: { preset: 'tiered', tiers: [{ daysBefore: 30, percent: 100 }, { daysBefore: 14, percent: 50 }] },
  custom: { preset: 'custom', text: { en: 'Contact us', sw: 'Wasiliana nasi' } },
};
const R = n => ({ eventId: null, n }); void R;

/** A published event with a refund policy, priced `price` per place. */
async function eventWith(policy, { price = 20000, capacity = 10, startsInDays = 40, ...ev } = {}) {
  const startsAt = new Date(Date.now() + startsInDays * D);
  const f = await h.sellingEvent({ event: { startsAt, endsAt: new Date(+startsAt + 6 * H), registrationClosesAt: new Date(+startsAt - D), ...ev }, categories: [{ name: '10K', distanceMeters: 10000, tickets: [{ name: 'Early', priceTzs: price, capacity }] }] });
  await db('Event').where({ id: f.event.id }).update({ refundPolicySnapshot: JSON.stringify(policy) });
  return f;
}
/** Place and pay (and have approved) an order of `n` places; resolves with the ids. */
async function paid(f, b, n = 1, { admins = null } = {}) {
  const participants = Array.from({ length: n }, (_, i) => (i === 0
    ? { ticketTypeId: f.ticket.id, firstName: 'Neema', lastName: 'Abdallah', phone: b.phone, consentBasis: 'self' }
    : { ticketTypeId: f.ticket.id, firstName: 'Zawadi', lastName: 'Mollel', phone: phone(), consentBasis: 'purchaser_authorised' }));
  const body = { eventId: f.event.id, lines: [{ ticketTypeId: f.ticket.id, quantity: n }], acceptedTerms: true, consentTextVersion: '2026-10-draft', participants };
  const q = await call(quoteEventOrder, b.claims, { body });
  const o = await call(createEventOrder, b.claims, { headers: { 'Idempotency-Key': key() }, body: { ...body, expectedTotalTzs: q.body.quote.totalTzs } });
  assert.equal(o.status, 201, JSON.stringify(o.body));
  const p = await call(payForEventOrder, b.claims, { params: { id: o.body.order.id }, headers: { 'Idempotency-Key': key() }, body: { reference: txId(), payerPhone: b.phone } });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const a = admins ?? await admin();
  const request = await db('PaymentRequest').where({ eventOrderId: o.body.order.id }).first();
  let approver = a;
  // MONEY_SECOND_APPROVER: one admin verifies, a different one approves
  if (process.env.MONEY_SECOND_APPROVER) {
    assert.equal((await call(adminVerifyPaymentRequest, a, { params: { id: request.id }, body: {} })).status, 200);
    approver = await admin();
  }
  const done = await call(adminDecidePaymentRequest, approver, { params: { id: request.id }, body: { decision: 'approve', amountTzs: q.body.quote.totalTzs } });
  assert.equal(done.body.event?.outcome, 'confirmed', JSON.stringify(done.body));
  const regs = await db('EventRegistration').where({ orderId: o.body.order.id }).orderBy('id');
  return { orderId: o.body.order.id, regs, total: q.body.quote.totalTzs };
}
const setup = async (policy, opts = {}) => {
  s4On(opts.env); await saveManualDetails();
  const f = await eventWith(policy, opts);
  return { f, b: await member() };
};
async function ledgerBalances(ticketTypeId) {
  const t = await db('EventTicketType').where({ id: ticketTypeId }).first();
  assert.ok(t.sold + t.held <= t.capacity);
  const sums = Object.fromEntries((await db('EventInventoryMovement').where({ ticketTypeId }).groupBy('kind').select('kind').sum({ q: 'quantity' })).map(r => [r.kind, Number(r.q)]));
  const s = k => sums[k] ?? 0;
  assert.equal(s('hold') - s('release') - s('commit'), t.held);
  assert.equal(s('commit') - s('uncommit'), t.sold);
}
const refundRows = orderId => db('Refund').where({ eventOrderId: orderId }).orderBy('createdAt');
const cancelBody = (reason, expectedRefundTzs) => ({ reason, ...(expectedRefundTzs === undefined ? {} : { expectedRefundTzs }) });

test('refund_until_close: cancelling a paid order before close refunds 100% — cancellation, tickets revoked, `uncommit`, and the refund row (approved by policy) in one go; the preview says the same', async () => {
  const { f, b } = await setup(POLICY.until_close);
  const { orderId, regs } = await paid(f, b, 2);
  const preview = await call(eventOrderCancelPreview, b.claims, { params: { id: orderId } });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual([preview.body.eligible, preview.body.mode, preview.body.percent, preview.body.paidTzs, preview.body.refundTzs, preview.body.releaseInventory, preview.body.blocked], [true, 'auto', 100, 40000, 40000, true, null]);
  assert.equal(preview.body.policy.preset, 'refund_until_close');
  assert.equal(preview.body.places.length, 2);
  assert.deepEqual(await h.counters(f.ticket.id), { sold: 2, held: 0, capacity: 10 });
  // expectedRefundTzs is required for a paid order, and only an equality check
  assert.deepEqual((await call(cancelMyEventOrder, b.claims, { params: { id: orderId }, body: cancelBody('changed_mind') })).body.error, 'expected_refund_required');
  const wrong = await call(cancelMyEventOrder, b.claims, { params: { id: orderId }, body: cancelBody('changed_mind', 99999) });
  assert.deepEqual([wrong.status, wrong.body.error, wrong.body.refundTzs], [409, 'refund_changed', 40000]);
  assert.equal((await db('EventOrder').where({ id: orderId }).first()).status, 'confirmed');
  const r = await call(cancelMyEventOrder, b.claims, { params: { id: orderId }, body: cancelBody('changed_mind', 40000) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.order.status, r.body.refund.status, r.body.refund.amountTzs, r.body.refund.scope, r.body.changed], ['refund_pending', 'approved', 40000, 'order', true]);
  const refund = (await refundRows(orderId))[0];
  assert.deepEqual([refund.kind, refund.status, refund.decidedBy, refund.requestedRole, refund.reasonCode, refund.memberId, refund.eventId, refund.organizerId], ['event_order', 'approved', 'policy', 'member', 'member_cancelled', b.sub, f.event.id, f.organizer.id]);
  const after_ = await db('EventRegistration').where({ orderId }).orderBy('id');
  assert.deepEqual(after_.map(x => [x.status, x.cancelReason, x.refundId]), [['cancelled', 'changed_mind', refund.id], ['cancelled', 'changed_mind', refund.id]]);
  const tickets = await db('EventTicket').whereIn('registrationId', regs.map(x => x.id));
  assert.ok(tickets.every(t => t.status === 'revoked' && t.revokeReason === 'refunded' && t.revokedAt));
  assert.deepEqual(await h.counters(f.ticket.id), { sold: 0, held: 0, capacity: 10 }, 'the places can be sold again');
  assert.deepEqual((await h.movements(orderId)).map(m => `${m.kind}${m.quantity}`), ['hold2', 'commit2', 'uncommit1', 'uncommit1']);
  await ledgerBalances(f.ticket.id);
  assert.equal((await h.outbox(f.event.id, 'ticket.revoked')).length, 2);
  assert.equal((await h.outbox(f.event.id, 'registration.cancelled')).length, 2);
  // the tickets say why
  assert.deepEqual([(await call(getEventTicket, b.claims, { params: { id: regs[0].id } })).body.error, (await call(getEventTicket, b.claims, { params: { id: regs[0].id } })).body.reason], ['ticket_revoked', 'refunded']);
  // double cancel finds it cancelled and returns the first result
  const again = await call(cancelMyEventOrder, b.claims, { params: { id: orderId }, body: cancelBody('changed_mind', 40000) });
  assert.deepEqual([again.status, again.body.changed, again.body.refund.id], [200, false, refund.id]);
  assert.equal((await refundRows(orderId)).length, 1);
  // the member sees it on the order and in /me/refunds, bilingually notified
  const detail = (await call(getMyEventOrder, b.claims, { params: { id: orderId } })).body;
  assert.equal(detail.refunds.length, 1); assert.equal(detail.refunds[0].paymentReference, null);
  assert.deepEqual(detail.allowedActions, []);
  const mine = (await call(myRefunds, b.claims, {})).body.refunds;
  assert.equal(mine.length, 1); assert.equal(mine[0].orderReference.startsWith('EV-'), true); assert.ok(!('policySnapshot' in mine[0]));
  const n = (await h.notifications(b.sub, 'event_refund_approved'))[0];
  assert.ok(n.data.titleSw && n.data.bodySw.includes('TSh 40,000'));
});

test('partial cancellation of a multi-place order: one place refunded, the order is partially_cancelled; the other place keeps its ticket; one live refund per place', async () => {
  const { f, b } = await setup(POLICY.until_close);
  const { orderId, regs } = await paid(f, b, 2);
  const two = regs[1];
  const prev = await call(eventRegistrationCancelPreview, b.claims, { params: { id: two.id } });
  assert.deepEqual([prev.body.paidTzs, prev.body.refundTzs, prev.body.places.length], [20000, 20000, 1]);
  const r = await call(cancelMyEventRegistration, b.claims, { params: { id: two.id }, body: cancelBody('wrong_details', 20000) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.order.status, 'partially_cancelled');
  assert.deepEqual([r.body.refund.scope, r.body.refund.amountTzs], ['registration', 20000]);
  assert.equal(r.body.registration.status, 'cancelled');
  const rows = await db('EventRegistration').where({ orderId }).orderBy('id');
  assert.deepEqual(rows.map(x => x.status), regs.map(x => (x.id === two.id ? 'cancelled' : 'confirmed')));
  const tix = await db('EventTicket').whereIn('registrationId', regs.map(x => x.id)).orderBy('registrationId');
  assert.deepEqual(tix.map(t => t.status).sort(), ['active', 'revoked']);
  assert.deepEqual(await h.counters(f.ticket.id), { sold: 1, held: 0, capacity: 10 });
  await ledgerBalances(f.ticket.id);
  // the rest of the order can still be cancelled: its own refund; two refunds in total, one per place
  const rest = await call(cancelMyEventOrder, b.claims, { params: { id: orderId }, body: cancelBody('other', 20000) });
  assert.equal(rest.status, 200, JSON.stringify(rest.body));
  assert.equal(rest.body.order.status, 'refund_pending');
  const refunds = await refundRows(orderId);
  assert.deepEqual(refunds.map(x => [x.scope, x.amountTzs]).sort(), [['order', 20000], ['registration', 20000]]);
  assert.equal(new Set((await db('EventRegistration').where({ orderId })).map(x => x.refundId)).size, 2);
});

test('refund_until_close after the deadline, no_refund: the place is cancelled with NO refund row (the preview said so); refunds the tiered and days presets pay at the tier boundaries', async () => {
  // refund_until_close with the event's close in the past of "now": the policy gives nothing, the cancel still works
  const { f, b } = await setup(POLICY.until_close);
  const { orderId } = await paid(f, b, 1);
  await db('Event').where({ id: f.event.id }).update({ registrationClosesAt: new Date(Date.now() - H) });
  await db('EventCategory').where({ eventId: f.event.id }).update({ registrationClosesAt: new Date(Date.now() - H) });
  const prev = (await call(eventOrderCancelPreview, b.claims, { params: { id: orderId } })).body;
  assert.deepEqual([prev.mode, prev.percent, prev.refundTzs, prev.releaseInventory], ['none', 0, 0, false]);
  const r = await call(cancelMyEventOrder, b.claims, { params: { id: orderId }, body: cancelBody('changed_mind', 0) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.order.status, r.body.refund], ['cancelled', null]);
  assert.equal((await refundRows(orderId)).length, 0);
  assert.deepEqual(await h.counters(f.ticket.id), { sold: 1, held: 0, capacity: 10 }, 'the place cannot be resold: sold stays');
  assert.equal((await db('EventTicket as t').join('EventRegistration as r', 'r.id', 't.registrationId').where('r.orderId', orderId).first('t.status')).status, 'revoked');
  await ledgerBalances(f.ticket.id);
  // tiered: 20 days before → 50% of 20000 per place
  const t = await setup(POLICY.tiered, { startsInDays: 20 });
  const two = await paid(t.f, t.b, 1);
  const tp = (await call(eventOrderCancelPreview, t.b.claims, { params: { id: two.orderId } })).body;
  assert.deepEqual([tp.mode, tp.percent, tp.refundTzs], ['auto', 50, 10000]);
  // full_until_days: 10 days before an event 15 days away → full; with days=20 the deadline passed → none
  const d1 = await setup(POLICY.days(10), { startsInDays: 15 });
  const p1 = await paid(d1.f, d1.b, 1);
  assert.equal((await call(eventOrderCancelPreview, d1.b.claims, { params: { id: p1.orderId } })).body.refundTzs, 20000);
  await db('Event').where({ id: d1.f.event.id }).update({ refundPolicySnapshot: JSON.stringify(POLICY.days(20)) });
  const after20 = (await call(eventOrderCancelPreview, d1.b.claims, { params: { id: p1.orderId } })).body;
  assert.deepEqual([after20.mode, after20.refundTzs], ['none', 0]);
});

test('refund_changed: the percent tier moved while the member read the screen — nothing is cancelled, the new amount is returned', async () => {
  const { f, b } = await setup(POLICY.tiered, { startsInDays: 20 });
  const { orderId } = await paid(f, b, 1);
  const prev = (await call(eventOrderCancelPreview, b.claims, { params: { id: orderId } })).body;
  assert.equal(prev.refundTzs, 10000);
  // the clock passes the 14-day tier boundary: the event now starts in 10 days
  await db('Event').where({ id: f.event.id }).update({ startsAt: new Date(Date.now() + 10 * D), endsAt: new Date(Date.now() + 10 * D + 6 * H) });
  const r = await call(cancelMyEventOrder, b.claims, { params: { id: orderId }, body: cancelBody('changed_mind', prev.refundTzs) });
  assert.deepEqual([r.status, r.body.error, r.body.refundTzs], [409, 'refund_changed', 0]);
  assert.equal((await db('EventOrder').where({ id: orderId }).first()).status, 'confirmed');
  assert.equal((await refundRows(orderId)).length, 0);
  assert.equal(Number((await db('EventTicket').where({ status: 'active' }).count({ n: '*' }))[0].n) >= 1, true);
});

test('custom policy (manual review): the member\'s cancel only REQUESTS; approving cancels the places with the approved amount, rejecting changes nothing', async () => {
  const { f, b } = await setup(POLICY.custom, { env: { secondApprover: true } });
  const { orderId, regs } = await paid(f, b, 1);
  const prev = (await call(eventRegistrationCancelPreview, b.claims, { params: { id: regs[0].id } })).body;
  assert.deepEqual([prev.mode, prev.refundTzs, prev.eligible], ['manual_review', 20000, true]);
  const r = await call(cancelMyEventRegistration, b.claims, { params: { id: regs[0].id }, body: cancelBody('other', 20000) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.requested, r.body.refund.status, r.body.registration.status], [true, 'requested', 'confirmed']);
  assert.equal((await db('EventTicket').where({ registrationId: regs[0].id }).first()).status, 'active', 'the ticket stays until staff decide');
  // a second request for the same place is refused
  const dup = await call(cancelMyEventRegistration, b.claims, { params: { id: regs[0].id }, body: cancelBody('other', 20000) });
  assert.deepEqual([dup.status, dup.body.error], [409, 'refund_in_progress']);
  assert.equal((await refundRows(orderId)).length, 1);
  const refund = (await refundRows(orderId))[0];
  const a = await admin();
  const approved = await call(adminDecideRefund, a, { params: { id: refund.id }, body: { decision: 'approve', amountTzs: 15000 } });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.refund.amountTzs, 15000);
  const reg = await db('EventRegistration').where({ id: regs[0].id }).first();
  assert.deepEqual([reg.status, reg.cancelReason, reg.refundId], ['cancelled', 'member_review_approved', refund.id]);
  assert.equal((await db('EventTicket').where({ registrationId: regs[0].id }).first()).status, 'revoked');
  assert.equal((await db('EventOrder').where({ id: orderId }).first()).status, 'refund_pending');
  // another purchase, rejected: nothing changes, the places are free for another refund
  const two = await paid(f, b, 1);
  const r2 = await call(cancelMyEventOrder, b.claims, { params: { id: two.orderId }, body: cancelBody('other', 20000) });
  assert.equal(r2.body.requested, true);
  const rf = (await refundRows(two.orderId))[0];
  const rejected = await call(adminDecideRefund, a, { params: { id: rf.id }, body: { decision: 'reject', note: 'Please contact the organizer' } });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  assert.equal((await db('EventOrder').where({ id: two.orderId }).first()).status, 'confirmed');
  assert.deepEqual((await db('EventRegistration').where({ orderId: two.orderId })).map(x => [x.status, x.refundId]), [['confirmed', null]]);
  const view = (await call(getMyEventOrder, b.claims, { params: { id: two.orderId } })).body;
  assert.deepEqual([view.refunds[0].status, view.refunds[0].rejectionNote], ['rejected', 'Please contact the organizer']);
});

test('blocked: a claimed participant gets 403 purchaser_only; after the start the window is closed (409); a place with a refund in progress is refused; a cancelled event is refused', async () => {
  const { f, b } = await setup(POLICY.until_close);
  const { orderId, regs } = await paid(f, b, 2);
  const friend = regs.find(r => r.consentBasis !== 'self');
  const friendSub = await h.user({ phone: friend.phone });
  const { claimEventRegistration } = await import('../functions/events-registration.mjs');
  assert.equal((await call(claimEventRegistration, h.claimsOf(friendSub), { params: { id: friend.id }, body: {} })).status, 200);
  const asFriend = await call(cancelMyEventRegistration, h.claimsOf(friendSub), { params: { id: friend.id }, body: cancelBody('other', 20000) });
  assert.deepEqual([asFriend.status, asFriend.body.error], [403, 'purchaser_only']);
  // the purchaser's preview of a claimed place is a masked 404 (not theirs any more)
  // after the start
  await db('Event').where({ id: f.event.id }).update({ startsAt: new Date(Date.now() - H), endsAt: new Date(Date.now() + 5 * H) });
  const closed = await call(cancelMyEventOrder, b.claims, { params: { id: orderId }, body: cancelBody('other', 0) });
  assert.deepEqual([closed.status, closed.body.error], [409, 'cancellation_window_closed']);
  const pv = (await call(eventOrderCancelPreview, b.claims, { params: { id: orderId } })).body;
  assert.deepEqual([pv.eligible, pv.mode, pv.blocked, pv.refundTzs], [false, 'closed', 'cancellation_window_closed', 0]);
  // an event FitFlex cancelled: the batch handles refunds
  await db('Event').where({ id: f.event.id }).update({ startsAt: new Date(Date.now() + 30 * D), endsAt: new Date(Date.now() + 30 * D + 6 * H), status: 'cancelled', cancelledAt: new Date() });
  const gone = await call(cancelMyEventOrder, b.claims, { params: { id: orderId }, body: cancelBody('other', 40000) });
  assert.deepEqual([gone.status, gone.body.error], [409, 'event_cancelled']);
  await db('Event').where({ id: f.event.id }).update({ status: 'published', cancelledAt: null });
  // a refund in progress covers the place
  const own = regs.find(r => r.consentBasis === 'self');
  await db('EventRegistration').where({ id: own.id }).update({ refundId: 'rfd_other' });
  const busy = await call(cancelMyEventRegistration, b.claims, { params: { id: own.id }, body: cancelBody('other', 20000) });
  assert.deepEqual([busy.status, busy.body.error], [409, 'refund_in_progress']);
  await db('EventRegistration').where({ id: own.id }).update({ refundId: null });
});

test('races: a member cancel and an admin cancel of the same order make ONE refund; every place is covered once', async () => {
  const { f, b } = await setup(POLICY.until_close);
  const { orderId } = await paid(f, b, 2);
  const a = await admin();
  const [m, ad] = await Promise.all([
    call(cancelMyEventOrder, b.claims, { params: { id: orderId }, body: cancelBody('other', 40000) }),
    call(adminCancelEventOrder, a, { params: { id: f.event.id, orderId }, body: { note: 'duplicate order', refundMode: 'full' } }),
  ]);
  assert.ok([m, ad].every(r => r.status === 200), JSON.stringify([m.body, ad.body]));
  assert.equal((await refundRows(orderId)).filter(r => r.status !== 'rejected').length, 1);
  const regs = await db('EventRegistration').where({ orderId });
  assert.ok(regs.every(r => r.status === 'cancelled' && r.refundId));
  assert.equal(new Set(regs.map(r => r.refundId)).size, 1);
  await ledgerBalances(f.ticket.id);
});

test('admin cancels a paid order: refundMode full | policy | none; a note is required; the refund is REQUESTED for a second admin (MONEY_SECOND_APPROVER) who approves; a third records the payout', async () => {
  const { f, b } = await setup(POLICY.no_refund, { env: { secondApprover: true } });
  const { orderId } = await paid(f, b, 1);
  const a = await admin(); const second = await admin(); const third = await admin();
  assert.equal((await call(adminCancelEventOrder, a, { params: { id: f.event.id, orderId }, body: { refundMode: 'full' } })).body.error, 'note_required');
  assert.equal((await call(adminCancelEventOrder, a, { params: { id: f.event.id, orderId }, body: { note: 'organizer asked us to' } })).body.error, 'refund_mode_required');
  const r = await call(adminCancelEventOrder, a, { params: { id: f.event.id, orderId }, body: { note: 'organizer asked us to', refundMode: 'full' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.order.status, r.body.refund.status, r.body.refund.amountTzs], ['refund_pending', 'requested', 20000], 'full = everything paid whatever the preset');
  const refund = (await refundRows(orderId))[0];
  assert.deepEqual([refund.requestedRole, refund.requestedBy, refund.reasonCode, refund.status], ['admin', a.sub, 'cancelled_by_fitflex', 'requested']);
  assert.equal((await db('AuditLog').where({ action: 'events.order_cancelled', target: orderId })).length, 1);
  assert.equal((await call(adminDecideRefund, a, { params: { id: refund.id }, body: { decision: 'approve' } })).body.error, 'cannot_approve_own_request');
  assert.equal((await call(adminDecideRefund, second, { params: { id: refund.id }, body: { decision: 'approve' } })).status, 200);
  assert.equal((await call(adminMarkRefundPaid, second, { params: { id: refund.id }, body: { paymentReference: 'BANK-1' } })).body.error, 'cannot_pay_own_approval');
  const paidOut = await call(adminMarkRefundPaid, third, { params: { id: refund.id }, body: { paymentReference: 'BANK-1', paidTo: '+255712000111' } });
  assert.equal(paidOut.status, 200, JSON.stringify(paidOut.body));
  // what a paid refund does
  assert.deepEqual((await db('EventRegistration').where({ orderId })).map(r => [r.status, r.refundedTzs]), [['refunded', 20000]]);
  const order = await db('EventOrder').where({ id: orderId }).first();
  assert.deepEqual([order.status, order.refundedTzs], ['refunded', 20000]);
  const view = (await call(getMyEventOrder, b.claims, { params: { id: orderId } })).body;
  assert.deepEqual([view.refunds[0].status, view.refunds[0].paymentReference, view.refunds[0].paidTo], ['paid', 'BANK-1', '••• 111']);
  assert.equal((await h.notifications(b.sub, 'event_refund_paid')).length, 1);
  assert.equal((await h.outbox(f.event.id, 'refund.paid')).length, 1);
  // idempotent: the effect is not applied twice
  const { eventsRefundsService } = await import('../src/bootstrap/services.mjs');
  await eventsRefundsService.onPaid({ ...(await db('Refund').where({ id: refund.id }).first()) });
  assert.equal((await h.outbox(f.event.id, 'refund.paid')).length, 1);
  assert.equal((await db('EventOrder').where({ id: orderId }).first()).refundedTzs, 20000);
  // admin list rows carry the event fields; policy admin cancel with `policy` mode on no_refund gives nothing
  const listed = (await call(adminListRefunds, a, { query: { status: 'paid' } })).body.refunds.find(x => x.id === refund.id);
  assert.deepEqual([listed.scope, listed.event.title, listed.orderReference.startsWith('EV-'), listed.payerPhone], ['order', 'Dar Half Marathon', true, b.phone]);
  const two = await paid(f, b, 1);
  const noRefund = await call(adminCancelEventOrder, a, { params: { id: f.event.id, orderId: two.orderId }, body: { note: 'by policy', refundMode: 'policy' } });
  assert.deepEqual([noRefund.body.order.status, noRefund.body.refund], ['cancelled', null]);
});

test('scenario 10: an event with 3 paid orders and 2 unpaid is cancelled — unpaid released, paid places cancelled and tickets revoked, one refund per order with the right sums, batch id shared, re-run adds nothing; second admin approves the batch; payouts recorded; participants hear once', async () => {
  const { f } = await setup(POLICY.tiered, { env: { secondApprover: true } });
  const buyers = [await member(), await member(), await member()];
  const [o1, o2, o3] = [await paid(f, buyers[0], 1), await paid(f, buyers[1], 2), await paid(f, buyers[2], 1)];
  // two unpaid orders: one with a payment waiting for staff
  const waiting = await member(); const idle = await member();
  const mk = async (u) => {
    const body = { eventId: f.event.id, lines: [{ ticketTypeId: f.ticket.id, quantity: 1 }], acceptedTerms: true, consentTextVersion: '2026-10-draft', participants: [{ ticketTypeId: f.ticket.id, firstName: 'Neema', lastName: 'Abdallah', phone: u.phone, consentBasis: 'self' }] };
    const q = await call(quoteEventOrder, u.claims, { body });
    return (await call(createEventOrder, u.claims, { headers: { 'Idempotency-Key': key() }, body: { ...body, expectedTotalTzs: q.body.quote.totalTzs } })).body;
  };
  const w = await mk(waiting); const i = await mk(idle);
  await call(payForEventOrder, waiting.claims, { params: { id: w.order.id }, headers: { 'Idempotency-Key': key() }, body: { reference: txId(), payerPhone: waiting.phone } });
  const a = await admin(); const second = await admin();
  const preview = (await call(adminEventCancelPreview, a, { params: { id: f.event.id } })).body;
  assert.deepEqual(preview, { awaitingOrders: 2, awaitingWithSubmittedPayment: 1, paidOrders: 3, paidPlaces: 4, totalPaidTzs: 80000, alreadyRefundedTzs: 0, refundableTzs: 80000, openRefunds: 0 });
  // a stale dialog: nothing happens
  const stale = await call(adminCancelEvent, a, { params: { id: f.event.id }, body: { reason: 'weather', expectedRefundableTzs: 60000 } });
  assert.deepEqual([stale.status, stale.body.error, stale.body.refundableTzs], [409, 'refundable_changed', 80000]);
  assert.equal((await db('Event').where({ id: f.event.id }).first()).status, 'published');
  const cancelled = await call(adminCancelEvent, a, { params: { id: f.event.id }, body: { reason: 'weather', expectedRefundableTzs: 80000 } });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.deepEqual([cancelled.body.status, cancelled.body.batch.created, cancelled.body.batch.existing, cancelled.body.batch.remaining, cancelled.body.batch.amountTzs, cancelled.body.batch.released], ['cancelled', 3, 0, 0, 80000, 2]);
  const batchId = cancelled.body.batch.batchId;
  // unpaid released (the pending payment stays for staff), paid places cancelled, tickets revoked, sold unchanged
  for (const id of [w.order.id, i.order.id]) assert.equal((await db('EventOrder').where({ id }).first()).status, 'cancelled');
  assert.equal((await db('PaymentRequest').where({ eventOrderId: w.order.id }).first()).status, 'pending');
  const regs = await db('EventRegistration').whereIn('orderId', [o1.orderId, o2.orderId, o3.orderId]);
  assert.ok(regs.every(r => r.status === 'cancelled' && r.cancelReason === 'event_cancelled'));
  const tickets = await db('EventTicket').whereIn('registrationId', regs.map(r => r.id));
  assert.ok(tickets.length === 4 && tickets.every(t => t.status === 'revoked' && t.revokeReason === 'event_cancelled'));
  assert.deepEqual(await h.counters(f.ticket.id), { sold: 4, held: 0, capacity: 10 }, 'sold is unchanged: the places cannot be resold');
  const refunds = await db('Refund').where({ eventId: f.event.id, kind: 'event_order' }).orderBy('amountTzs');
  assert.deepEqual(refunds.map(r => [r.scope, r.amountTzs, r.status, r.batchId, r.requestedRole, r.reasonCode]), [
    ['event_cancelled', 20000, 'requested', batchId, 'admin', 'cancelled_by_fitflex'], ['event_cancelled', 20000, 'requested', batchId, 'admin', 'cancelled_by_fitflex'], ['event_cancelled', 40000, 'requested', batchId, 'admin', 'cancelled_by_fitflex'],
  ]);
  for (const o of [o1, o2, o3]) assert.equal((await db('EventOrder').where({ id: o.orderId }).first()).status, 'refund_pending');
  // the full amount whatever the preset (tiered would give a percentage)
  assert.equal(refunds.reduce((n, r) => n + r.amountTzs, 0), 80000);
  // re-running creates nothing new
  const rerun = await call(adminRunEventRefundBatch, a, { params: { id: f.event.id }, body: { expectedRefundableTzs: 0 } });
  assert.equal(rerun.status, 200, JSON.stringify(rerun.body));
  assert.deepEqual([rerun.body.created, rerun.body.existing, rerun.body.batchId], [0, 0, batchId]);
  assert.equal((await db('Refund').where({ eventId: f.event.id, kind: 'event_order' })).length, 3);
  // notifications: purchasers once each
  for (const bu of buyers) assert.equal((await h.notifications(bu.sub, 'event_cancelled_refund')).length, 1);
  assert.equal((await h.notifications(waiting.sub, 'event_cancelled_refund')).length, 0 + (await h.notifications(waiting.sub, 'event_cancelled_refund')).length);
  // batch-decision under the second-approver rule
  const own = await call(adminDecideRefundBatch, a, { body: { batchId, decision: 'approve', expectedTotalTzs: 80000, expectedCount: 3 } });
  assert.deepEqual([own.status, own.body.error], [403, 'cannot_approve_own_request']);
  assert.equal((await call(adminDecideRefundBatch, second, { body: { batchId, decision: 'approve', expectedTotalTzs: 1, expectedCount: 3 } })).body.error, 'batch_changed');
  const ok = await call(adminDecideRefundBatch, second, { body: { batchId, decision: 'approve', expectedTotalTzs: 80000, expectedCount: 3 } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.approved, ok.body.failed], [3, 0]);
  // payouts: rows recorded by someone else; a partial failure is reported per item
  const third = await admin();
  const items = [...refunds.map(r => ({ refundId: r.id, paymentReference: `PAY-${r.id.slice(-4)}`, paidTo: '+255712000222' })), { refundId: 'rfd_missing', paymentReference: 'X' }];
  const paidOut = await call(adminMarkRefundBatchPaid, third, { body: { batchId, items } });
  assert.equal(paidOut.status, 200, JSON.stringify(paidOut.body));
  assert.deepEqual([paidOut.body.paid, paidOut.body.failed], [3, 1]);
  assert.deepEqual(paidOut.body.results.filter(r => !r.ok).map(r => r.error), ['refund_not_found']);
  for (const o of [o1, o2, o3]) {
    const order = await db('EventOrder').where({ id: o.orderId }).first();
    assert.equal(order.status, 'refunded'); assert.equal(order.refundedTzs, o.total);
  }
  assert.ok((await db('EventRegistration').whereIn('orderId', [o1.orderId, o2.orderId, o3.orderId])).every(r => r.status === 'refunded' && r.refundedTzs === 20000));
  for (const bu of buyers) assert.equal((await h.notifications(bu.sub, 'event_refund_paid')).length >= 1, true);
  // the organizer cannot cancel once confirmed registrations exist (D12); the admin could
  const own2 = await call(organizerCancelEvent, f.organizer.claims, { params: { id: f.event.id }, body: { reason: 'weather' } });
  assert.ok([409, 403].includes(own2.status));
});

test('unfulfilled-payment refunds: admin raises one for an approved payment whose order is not confirmed (409 payment_not_unfulfilled for a confirmed one); paying it ends the payment as failed', async () => {
  const { f, b } = await setup(POLICY.until_close);
  const a = await admin(); const second = await admin();
  const ok = await paid(f, b, 1);
  const okPay = await db('EventPayment').where({ orderId: ok.orderId }).first();
  assert.equal((await call(adminRaiseRefund, a, { body: { eventPaymentId: okPay.id, reasonCode: 'payment_error' } })).body.error, 'payment_not_unfulfilled');
  // an approved payment whose order was cancelled underneath
  const u = await member();
  const body = { eventId: f.event.id, lines: [{ ticketTypeId: f.ticket.id, quantity: 1 }], acceptedTerms: true, consentTextVersion: '2026-10-draft', participants: [{ ticketTypeId: f.ticket.id, firstName: 'Neema', lastName: 'Abdallah', phone: u.phone, consentBasis: 'self' }] };
  const q = await call(quoteEventOrder, u.claims, { body });
  const o = (await call(createEventOrder, u.claims, { headers: { 'Idempotency-Key': key() }, body: { ...body, expectedTotalTzs: q.body.quote.totalTzs } })).body;
  await call(payForEventOrder, u.claims, { params: { id: o.order.id }, headers: { 'Idempotency-Key': key() }, body: { reference: txId(), payerPhone: u.phone } });
  await eventStore.releaseOrder(o.order.id, 'admin');
  const request = await db('PaymentRequest').where({ eventOrderId: o.order.id }).first();
  const done = await call(adminDecideRefund.onRequest ? adminDecidePaymentRequest : adminDecidePaymentRequest, a, { params: { id: request.id }, body: { decision: 'approve', amountTzs: 20000 } });
  assert.equal(done.body.event.outcome, 'refund_raised');
  const pay_ = await db('EventPayment').where({ orderId: o.order.id }).first();
  const refund = await db('Refund').where({ id: pay_.refundId }).first();
  assert.equal(refund.status, 'approved');
  await db('OpsException').where('dedupeKey', 'like', 'evpay:%').del();
  const paidOut = await call(adminMarkRefundPaid, second, { params: { id: refund.id }, body: { paymentReference: 'MM-77' } });
  assert.equal(paidOut.status, 200, JSON.stringify(paidOut.body));
  const after_ = await db('EventPayment').where({ id: pay_.id }).first();
  assert.deepEqual([after_.status, after_.failureReason], ['failed', 'refunded_after_late_payment']);
  assert.equal((await db('EventOrder').where({ id: o.order.id }).first()).refundedTzs, 0, 'never the organizer\'s money');
  // and the admin-raised variant (money in, order cancelled)
  const u2 = await member();
  const body2 = { ...body, participants: [{ ...body.participants[0], phone: u2.phone }] };
  const o2 = (await call(createEventOrder, u2.claims, { headers: { 'Idempotency-Key': key() }, body: { ...body2, expectedTotalTzs: 20000 } })).body;
  await call(payForEventOrder, u2.claims, { params: { id: o2.order.id }, headers: { 'Idempotency-Key': key() }, body: { reference: txId(), payerPhone: u2.phone } });
  const req2 = await db('PaymentRequest').where({ eventOrderId: o2.order.id }).first();
  await db('PaymentRequest').where({ id: req2.id }).update({ status: 'approved', decidedAt: new Date(), reference: 'MM-88' });
  await eventStore.releaseOrder(o2.order.id, 'admin');
  const p2 = await db('EventPayment').where({ orderId: o2.order.id }).first();
  // a still-pending payment is not "money held": the sweep / approval decides it (M1)
  assert.deepEqual([(await call(adminRaiseRefund, a, { body: { eventPaymentId: p2.id, reasonCode: 'payment_error' } })).body.error], ['payment_not_unfulfilled']);
  await db('EventPayment').where({ id: p2.id }).update({ status: 'reconciliation_required', failureReason: 'order_cancelled' });
  assert.equal((await call(adminRaiseRefund, a, { body: { eventPaymentId: p2.id, amountTzs: 99999, reasonCode: 'payment_error' } })).body.error, 'amount_exceeds_payment');
  const raised = await call(adminRaiseRefund, a, { body: { eventPaymentId: p2.id, amountTzs: 15000, reasonCode: 'payment_error', note: 'order was cancelled' } });
  assert.equal(raised.status, 201, JSON.stringify(raised.body));
  assert.deepEqual([raised.body.refund.scope, raised.body.refund.kind, raised.body.refund.amountTzs], ['unfulfilled_payment', 'event_order', 15000]);
  assert.equal((await call(adminRaiseRefund, a, { body: { eventPaymentId: p2.id, reasonCode: 'payment_error' } })).status, 409, 'one live refund per unfulfilled payment');
  void adminListRefunds; void adminGetEventOrder; void eventOrderPaymentStatus; void getMyEventRegistration;
});

test('the sweep re-applies a refund that was marked paid but whose places were not updated (a crash between the two writes); participants hear when the purchaser cancels their place', async () => {
  const { f, b } = await setup(POLICY.until_close);
  const { orderId, regs } = await paid(f, b, 2);
  const friend = regs.find(r => r.consentBasis !== 'self');
  const friendSub = await h.user({ phone: friend.phone });
  const { claimEventRegistration } = await import('../functions/events-registration.mjs');
  assert.equal((await call(claimEventRegistration, h.claimsOf(friendSub), { params: { id: friend.id }, body: {} })).status, 200);
  // the purchaser cancels the whole order: the friend (a claimed participant) is told once
  const r = await call(cancelMyEventOrder, b.claims, { params: { id: orderId }, body: cancelBody('other', 40000) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await h.notifications(friendSub, 'event_place_cancelled_by_purchaser')).length, 1);
  assert.equal((await h.notifications(b.sub, 'event_place_cancelled_by_purchaser')).length, 0);
  // simulate the crash: the refund row says paid, the places were never moved
  const refund = (await refundRows(orderId))[0];
  await db('Refund').where({ id: refund.id }).update({ status: 'paid', paidAt: new Date(), paymentReference: 'CRASH-1', paidBy: 'spec' });
  assert.deepEqual((await db('EventRegistration').where({ orderId })).map(x => x.status), ['cancelled', 'cancelled']);
  const { eventsPaymentsService, eventsRefundsService } = await import('../src/bootstrap/services.mjs');
  const stats = await eventsPaymentsService.sweep({ refunds: eventsRefundsService });
  assert.ok(stats.refundsApplied >= 1, JSON.stringify(stats));
  assert.deepEqual((await db('EventRegistration').where({ orderId })).map(x => x.status), ['refunded', 'refunded']);
  assert.deepEqual([(await db('EventOrder').where({ id: orderId }).first()).status, (await db('EventOrder').where({ id: orderId }).first()).refundedTzs], ['refunded', 40000]);
  assert.equal((await eventsPaymentsService.sweep({ refunds: eventsRefundsService })).refundsApplied, 0, 'and once only');
});
