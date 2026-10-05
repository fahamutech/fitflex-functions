// Cancellations and refunds (Member Terms 6, 7 and 10):
//   - a member cancels a paid trainer session up to 24 hours before it, for
//     a full refund; a trainer cancels any time before it starts;
//   - a buyer cancels a shop order before it is dispatched;
//   - a member asks for a pass or plan payment back; FitFlex decides;
//   - every refund is approved, then recorded as paid with its reference.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRefundService } from '../src/services/refund-service.mjs';
import { createTrainerBookingService } from '../src/services/trainer-booking-service.mjs';
import { createShopService } from '../src/services/shop-service.mjs';
import { memberCancellation, MEMBER_CANCEL_NOTICE_HOURS } from '../src/shared/trainer-access.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { refundService as liveRefunds } from '../src/bootstrap/services.mjs';
import { ensureInit } from '../functions/index.mjs';
import { deliveredTo } from './fixtures/notification-language.mjs';

await ensureInit();

function memStore(rows = []) {
  return {
    rows,
    find(fn) { return rows.find(fn) || null; },
    async allAsync() { return rows; },
    async filterAsync(fn) { return rows.filter(fn); },
    async findAsync(fn) { return rows.find(fn) || null; },
    async findByIdAsync(id) { return rows.find(r => r.id === id) || null; },
    async filterByColumnAsync(col, value) { return rows.filter(r => r[col] === value); },
    async filterByColumnInAsync(col, ids) { return rows.filter(r => ids.includes(r[col])); },
    async insertAsync(row) { rows.push(row); return row; },
    async updateByIdAsync(id, patch) {
      const i = rows.findIndex(r => r.id === id);
      if (i >= 0) rows[i] = { ...rows[i], ...patch };
      return rows[i] || null;
    },
  };
}
const audit = () => memStore();
const HOUR = 3_600_000;

/** A date and slot (EAT) `hours` from now. */
function slotIn(hours) {
  const eat = new Date(Date.now() + hours * HOUR + 3 * HOUR);
  return { date: eat.toISOString().slice(0, 10), slot: eat.toISOString().slice(11, 16) };
}

function fixture() {
  const refunds = memStore();
  const paymentRequests = memStore();
  const subscriptions = memStore();
  const users = memStore([{ id: 'm1', displayName: 'Asha M', phone: '0754000001' }, { id: 'tu1', displayName: 'Coach Juma' }]);
  const inbox = [];
  const paidHooks = [];
  const refundService = createRefundService({
    refunds, paymentRequests, subscriptions, users, auditLog: audit(),
    notify: async (userId, message) => { inbox.push({ userId, ...message }); },
    onPaid: async (refund) => { paidHooks.push(refund.id); if (refund.kind === 'shop_order') await shop.markOrderRefunded(refund.orderId); },
  });

  const trainers = memStore([{ id: 'trn1', userId: 'tu1', displayName: 'Coach Juma', status: 'active', gymIds: ['g1'] }]);
  const trainerBookings = memStore();
  const events = [];
  const bookings = createTrainerBookingService({
    trainerBookings, trainerSessions: memStore(), trainers, gyms: memStore([{ id: 'g1', name: 'Gym One' }]), users,
    auditLog: audit(), subscriptions, paymentRequests,
    trainerService: { hydrateTrainer: t => t, findProfileByUser: uid => trainers.rows.find(t => t.userId === uid) || null },
    notify: async (event, payload) => { events.push(event); return payload; },
    onRefundDue: ({ booking, reasonCode, actorId, role }) => refundService.raise({
      memberId: booking.memberId, kind: 'trainer_booking', sourceId: booking.id, paymentRequestId: booking.paymentRequestId,
      amountTzs: booking.amountTzs, reasonCode, requestedBy: actorId, requestedRole: role, approved: true,
    }).then(out => out.refund || null),
  });

  const products = memStore([{ id: 'prd1', vendorId: 'ven1', name: 'Whey', priceTzs: 40000, stock: 5, status: 'active', approvalStatus: 'approved' }]);
  const shopOrders = memStore();
  const shop = createShopService({
    products, shopOrders, users, auditLog: audit(), paymentRequests, marketplaceNotifications: memStore(),
    onRefundDue: ({ order, reasonCode, actorId, role }) => refundService.raise({
      memberId: order.buyerId, kind: 'shop_order', sourceId: order.id, amountTzs: order.totalTzs, reasonCode,
      requestedBy: actorId, requestedRole: role, approved: true,
    }).then(out => out.refund || null),
  });

  let n = 0;
  /** A booking in a group, with the group's payment request when asked for. */
  function booking({ hours, status = 'confirmed', amountTzs = 20000, groupId = 'tbg1', paymentRequestId = 'pay_b1' }) {
    const row = { id: `tbk_${++n}`, groupId, memberId: 'm1', trainerId: 'trn1', gymId: 'g1', ...slotIn(hours), amountTzs, paymentRequestId, status };
    trainerBookings.rows.push(row);
    return row;
  }
  return { refundService, refunds, paymentRequests, subscriptions, inbox, paidHooks, bookings, trainerBookings, events, shop, products, shopOrders, booking };
}

// ── The cancellation rule ───────────────────────────────────────────────────

test('a paid session can be cancelled until 24 hours before it; an unpaid one until it starts', () => {
  assert.equal(MEMBER_CANCEL_NOTICE_HOURS, 24);
  const paid = hours => memberCancellation({ ...slotIn(hours), status: 'confirmed', amountTzs: 20000 });
  assert.deepEqual([paid(30).canCancel, paid(30).refundable], [true, true]);
  assert.equal(paid(23).canCancel, false);
  assert.ok(paid(23).cancelBy, 'the deadline is still reported');
  assert.equal(memberCancellation({ ...slotIn(2), status: 'payment_pending', amountTzs: 20000 }).canCancel, true);
  assert.equal(memberCancellation({ ...slotIn(-1), status: 'confirmed', amountTzs: 20000 }).canCancel, false);
  assert.equal(memberCancellation({ ...slotIn(30), status: 'completed', amountTzs: 20000 }).canCancel, false);
});

// ── Trainer sessions ────────────────────────────────────────────────────────

test('member cancels a paid session in time: the slot is freed and a full refund is approved', async () => {
  const f = fixture();
  const b = f.booking({ hours: 48 });
  const out = await f.bookings.memberCancelBooking({ memberId: 'm1', bookingId: b.id });
  assert.deepEqual([out.booking.status, out.booking.cancelledBy], ['cancelled', 'member']);
  assert.deepEqual([out.refund.kind, out.refund.status, out.refund.amountTzs, out.refund.reasonCode, out.refund.decidedBy],
    ['trainer_booking', 'approved', 20000, 'member_cancelled', 'policy']);
  assert.deepEqual(f.events, ['trainer_booking_cancelled_by_member']);
  assert.equal(f.inbox.at(-1).type, 'refund_approved');
  // The refund notice follows the member's language.
  const sw = await deliveredTo(f.inbox.at(-1), 'sw');
  assert.deepEqual([sw.title, sw.body], ['Marejesho yako yanakuja', 'Marejesho yako ya TZS 20,000 yameidhinishwa. FitFlex itayatuma kwenye akaunti uliyolipia.']);
  const en = await deliveredTo(f.inbox.at(-1), null);
  assert.deepEqual([en.title, en.body], ['Refund on its way', 'Your refund of TZS 20,000 is approved. FitFlex will send it to the account you paid from.']);
  // The member's list tells the app what can still be cancelled.
  const mine = await f.bookings.memberMyBookings('m1');
  assert.equal(mine[0].cancellation.canCancel, false);
});

test('inside 24 hours a paid session stands; someone else\'s booking is not found', async () => {
  const f = fixture();
  const b = f.booking({ hours: 5 });
  const late = await f.bookings.memberCancelBooking({ memberId: 'm1', bookingId: b.id });
  assert.deepEqual([late.error, late.status], ['cancellation_window_passed', 409]);
  assert.ok(late.cancelBy);
  assert.equal(f.trainerBookings.rows[0].status, 'confirmed');
  assert.equal(f.refunds.rows.length, 0);
  assert.equal((await f.bookings.memberCancelBooking({ memberId: 'other', bookingId: b.id })).error, 'booking_not_found');
  const done = f.booking({ hours: 48, status: 'completed' });
  assert.equal((await f.bookings.memberCancelBooking({ memberId: 'm1', bookingId: done.id })).error, 'booking_not_cancellable');
});

test('cancelling before payment: nothing to refund; the payment request shrinks, then is withdrawn', async () => {
  const f = fixture();
  f.paymentRequests.rows.push({ id: 'pay_b1', memberId: 'm1', bookingGroupId: 'tbg1', amountTzs: 40000, status: 'pending' });
  const first = f.booking({ hours: 3, status: 'payment_pending' });
  const second = f.booking({ hours: 50, status: 'payment_pending' });
  const one = await f.bookings.memberCancelBooking({ memberId: 'm1', bookingId: first.id });
  assert.equal(one.refund, null);
  assert.deepEqual([f.paymentRequests.rows[0].status, f.paymentRequests.rows[0].amountTzs], ['pending', 20000]);
  await f.bookings.memberCancelBooking({ memberId: 'm1', bookingId: second.id });
  assert.equal(f.paymentRequests.rows[0].status, 'cancelled');
  assert.equal(f.refunds.rows.length, 0);
});

test('a trainer can cancel late, and the member is refunded in full; a free session has nothing to refund', async () => {
  const f = fixture();
  const b = f.booking({ hours: 2 });
  const out = await f.bookings.trainerCancelBooking({ userId: 'tu1', bookingId: b.id });
  assert.deepEqual([out.booking.status, out.booking.cancelledBy, out.refund.reasonCode, out.refund.status], ['cancelled', 'trainer', 'trainer_cancelled', 'approved']);
  assert.deepEqual(f.events, ['trainer_booking_cancelled_by_trainer']);
  const free = f.booking({ hours: 30, amountTzs: 0 });
  assert.equal((await f.bookings.trainerCancelBooking({ userId: 'tu1', bookingId: free.id })).refund, null);
  const started = f.booking({ hours: -1 });
  assert.equal((await f.bookings.trainerCancelBooking({ userId: 'tu1', bookingId: started.id })).error, 'session_already_started');
  assert.equal((await f.bookings.trainerCancelBooking({ userId: 'nobody', bookingId: b.id })).error, 'trainer_profile_not_found');
});

test('FitFlex cancelling a paid session raises its refund too', async () => {
  const f = fixture();
  const b = f.booking({ hours: 1 });
  const out = await f.bookings.adminUpdateStatus({ id: b.id, status: 'cancelled', actorId: 'adm' });
  assert.deepEqual([out.booking.cancelledBy, out.refund.reasonCode], ['admin', 'cancelled_by_fitflex']);
});

// ── Shop orders ─────────────────────────────────────────────────────────────

const checkout = { items: [{ productId: 'prd1', qty: 2 }], deliveryMethod: 'home_delivery', deliveryAddress: 'Sinza', paymentMethod: 'mpesa' };

test('a buyer cancels a paid order before dispatch: stock returns and the refund is approved, then paid', async () => {
  const f = fixture();
  const placed = await f.shop.createOrder({ buyerId: 'm1', body: checkout });
  await f.shop.applyPaymentToOrder(placed.order.id, 'approved');
  assert.equal((await f.shop.myOrders('m1'))[0].canCancel, true);

  const out = await f.shop.buyerCancelOrder({ buyerId: 'm1', orderId: placed.order.id });
  assert.deepEqual([out.order.status, out.order.paymentStatus], ['cancelled', 'refund_pending']);
  assert.deepEqual([out.refund.kind, out.refund.status, out.refund.amountTzs], ['shop_order', 'approved', 80000]);
  assert.equal(f.products.rows[0].stock, 5);
  assert.equal((await f.shop.buyerCancelOrder({ buyerId: 'm1', orderId: placed.order.id })).error, 'order_cancelled');

  const paid = await f.refundService.markPaid({ id: out.refund.id, body: { paymentReference: 'MPESA-QX12', paidTo: 'M-Pesa 0754000001' }, actorId: 'adm' });
  assert.deepEqual([paid.refund.status, paid.refund.paymentReference, paid.refund.paidBy], ['paid', 'MPESA-QX12', 'adm']);
  assert.equal(f.shopOrders.rows[0].paymentStatus, 'refunded');
  assert.equal(f.inbox.at(-1).type, 'refund_paid');
  assert.match(f.inbox.at(-1).body, /^We sent TZS [\d,]+ back to you\. Reference: MPESA-QX12\.$/);
  const sw = await deliveredTo(f.inbox.at(-1), 'sw');
  assert.equal(sw.title, 'Marejesho yametumwa');
  assert.match(sw.body, /^Tumekurejeshea TZS [\d,]+\. Kumbukumbu: MPESA-QX12\.$/);
});

test('an unpaid order is simply cancelled; a dispatched one can no longer be cancelled by the buyer', async () => {
  const f = fixture();
  const unpaid = await f.shop.createOrder({ buyerId: 'm1', body: checkout });
  const out = await f.shop.buyerCancelOrder({ buyerId: 'm1', orderId: unpaid.order.id });
  assert.deepEqual([out.order.paymentStatus, out.refund], ['cancelled', null]);
  assert.equal(f.paymentRequests.rows[0].status, 'cancelled');

  const second = await f.shop.createOrder({ buyerId: 'm1', body: checkout });
  await f.shop.applyPaymentToOrder(second.order.id, 'approved');
  await f.shop.updateOrderStatus({ orderId: second.order.id, status: 'dispatched', actorId: 'ven1' });
  assert.deepEqual(await f.shop.buyerCancelOrder({ buyerId: 'm1', orderId: second.order.id }), { error: 'order_already_dispatched', status: 409 });
  assert.equal((await f.shop.buyerCancelOrder({ buyerId: 'someone', orderId: second.order.id })).error, 'order_not_found');
  // The vendor can still cancel a dispatched order, which refunds the buyer.
  const byVendor = await f.shop.updateOrderStatus({ orderId: second.order.id, status: 'cancelled', actorId: 'ven1' });
  assert.equal(byVendor.refund.reasonCode, 'vendor_cancelled');
  // A delivered order is a return, not a cancellation.
  const third = await f.shop.createOrder({ buyerId: 'm1', body: checkout });
  await f.shop.applyPaymentToOrder(third.order.id, 'approved');
  await f.shop.updateOrderStatus({ orderId: third.order.id, status: 'delivered', actorId: 'ven1' });
  assert.equal((await f.shop.updateOrderStatus({ orderId: third.order.id, status: 'cancelled', actorId: 'ven1' })).error, 'order_already_delivered');
});

// ── Pass and plan payments ──────────────────────────────────────────────────

function passPayment(f, { status = 'approved' } = {}) {
  f.subscriptions.rows.push({ id: 'sub1', memberId: 'm1', type: 'platform_pass', tier: 'pro', status: 'active', expiresAt: new Date(Date.now() + 20 * 24 * HOUR).toISOString() });
  f.paymentRequests.rows.push({ id: 'pay_s1', memberId: 'm1', subscriptionId: 'sub1', amountTzs: 150000, status, decidedAt: new Date().toISOString() });
}

test('a member asks for a pass payment back; FitFlex approves less, ends the pass, then pays', async () => {
  const f = fixture();
  passPayment(f);
  assert.equal((await f.refundService.requestForPayment({ memberId: 'm1', body: { subscriptionId: 'sub1', reasonCode: 'other' } })).error, 'note_required');
  assert.equal((await f.refundService.requestForPayment({ memberId: 'm1', body: { subscriptionId: 'sub1', reasonCode: 'changed_my_mind' } })).error, 'invalid_reason');
  assert.equal((await f.refundService.requestForPayment({ memberId: 'intruder', body: { subscriptionId: 'sub1', reasonCode: 'charged_twice' } })).error, 'payment_not_found');

  const asked = await f.refundService.requestForPayment({ memberId: 'm1', body: { subscriptionId: 'sub1', reasonCode: 'charged_twice', note: 'Paid twice on 1 Oct' } });
  assert.deepEqual([asked.refund.status, asked.refund.amountTzs, asked.refund.paymentRequestId], ['requested', 150000, 'pay_s1']);
  assert.equal((await f.refundService.requestForPayment({ memberId: 'm1', body: { paymentRequestId: 'pay_s1', reasonCode: 'charged_twice' } })).error, 'refund_already_requested');
  assert.equal((await f.refundService.markPaid({ id: asked.refund.id, body: { paymentReference: 'X' }, actorId: 'adm' })).error, 'refund_not_approved');

  assert.equal((await f.refundService.decide({ id: asked.refund.id, body: { decision: 'approve', amountTzs: 200000 }, actorId: 'adm' })).error, 'invalid_amount');
  const approved = await f.refundService.decide({ id: asked.refund.id, body: { decision: 'approve', amountTzs: 100000, endAccess: true }, actorId: 'adm' });
  assert.deepEqual([approved.refund.status, approved.refund.amountTzs, approved.refund.decidedBy], ['approved', 100000, 'adm']);
  assert.ok(+new Date(f.subscriptions.rows[0].expiresAt) <= Date.now(), 'the pass ends now');
  assert.equal((await f.refundService.decide({ id: asked.refund.id, body: { decision: 'reject', note: 'x' }, actorId: 'adm' })).error, 'already_decided');

  assert.equal((await f.refundService.markPaid({ id: asked.refund.id, body: {}, actorId: 'adm' })).error, 'payment_reference_required');
  const paid = await f.refundService.markPaid({ id: asked.refund.id, body: { paymentReference: 'MPESA-77' }, actorId: 'adm' });
  assert.equal(paid.refund.status, 'paid');
  assert.deepEqual(f.inbox.map(n => n.type), ['refund_requested', 'refund_approved', 'refund_paid']);
  assert.deepEqual((await f.refundService.listMine('m1')).refunds.map(r => r.id), [asked.refund.id]);
});

test('a rejected request tells the member why, and can be asked for again', async () => {
  const f = fixture();
  passPayment(f);
  const asked = await f.refundService.requestForPayment({ memberId: 'm1', body: { paymentRequestId: 'pay_s1', reasonCode: 'not_activated' } });
  assert.equal((await f.refundService.decide({ id: asked.refund.id, body: { decision: 'reject' }, actorId: 'adm' })).error, 'note_required');
  const rejected = await f.refundService.decide({ id: asked.refund.id, body: { decision: 'reject', note: 'Your pass was active from 1 Oct and used on 2 Oct.' }, actorId: 'adm' });
  assert.equal(rejected.refund.status, 'rejected');
  assert.equal(f.inbox.at(-1).body, 'Your pass was active from 1 Oct and used on 2 Oct.');
  const again = await f.refundService.requestForPayment({ memberId: 'm1', body: { paymentRequestId: 'pay_s1', reasonCode: 'other', note: 'Please check again' } });
  assert.equal(again.refund.status, 'requested');
});

test('sessions and orders are refunded by cancelling, not by a refund request; admins can raise a pass refund', async () => {
  const f = fixture();
  passPayment(f);
  f.paymentRequests.rows.push({ id: 'pay_b9', memberId: 'm1', bookingGroupId: 'tbg9', subscriptionId: null, amountTzs: 20000, status: 'approved' });
  assert.equal((await f.refundService.requestForPayment({ memberId: 'm1', body: { paymentRequestId: 'pay_b9', reasonCode: 'charged_twice' } })).error, 'cancel_instead');
  assert.equal((await f.refundService.adminRaise({ body: { paymentRequestId: 'pay_s1', amountTzs: 999999 }, actorId: 'adm' })).error, 'amount_exceeds_payment');
  const raised = await f.refundService.adminRaise({ body: { paymentRequestId: 'pay_s1', amountTzs: 150000, note: 'Charged twice' }, actorId: 'adm' });
  assert.deepEqual([raised.refund.status, raised.refund.reasonCode, raised.refund.requestedRole], ['approved', 'payment_error', 'admin']);
  const list = await f.refundService.adminList({ status: 'approved' });
  assert.equal(list.refunds[0].member.displayName, 'Asha M');
  assert.equal((await f.refundService.adminList({ status: 'nope' })).error, 'invalid_status');
});

// ── The database rules ──────────────────────────────────────────────────────

const createdUsers = [];
after(async () => {
  if (createdUsers.length) {
    await db('AuditLog').whereIn('target', (await db('Refund').whereIn('memberId', createdUsers)).map(r => r.id)).del();
    await db('User').whereIn('id', createdUsers).del(); // refunds go with their member
  }
});

test('the database keeps one live refund per booking and needs a reference to mark one paid', async () => {
  const memberId = `usr_${randomUUID().slice(0, 8)}`;
  createdUsers.push(memberId);
  await db('User').insert({ id: memberId, userType: 'member', displayName: 'Refund Member', updatedAt: new Date() });
  const bookingId = `tbk_${randomUUID().slice(0, 8)}`;
  const raise = () => liveRefunds.raise({ memberId, kind: 'trainer_booking', sourceId: bookingId, amountTzs: 20000, reasonCode: 'member_cancelled', approved: true });

  const first = await raise();
  assert.equal(first.refund.status, 'approved');
  const again = await raise();
  assert.deepEqual([again.existing, again.refund.id], [true, first.refund.id]);
  await assert.rejects(db('Refund').insert({ id: `rfd_${randomUUID().slice(0, 8)}`, memberId, kind: 'trainer_booking', bookingId, amountTzs: 1, reasonCode: 'member_cancelled', status: 'approved', updatedAt: new Date() }), /refund_live_bookingid_ux/);
  await assert.rejects(db('Refund').where('id', first.refund.id).update({ status: 'paid' }), /refund_ck/);
  await assert.rejects(db('Refund').insert({ id: `rfd_${randomUUID().slice(0, 8)}`, memberId, kind: 'shop_order', orderId: 'ord_x', amountTzs: 0, reasonCode: 'member_cancelled', updatedAt: new Date() }), /refund_ck/);

  const paid = await liveRefunds.markPaid({ id: first.refund.id, body: { paymentReference: 'MPESA-DB1' }, actorId: null });
  assert.equal(paid.refund.status, 'paid');
  assert.equal((await liveRefunds.listMine(memberId)).refunds.length, 1);
});
