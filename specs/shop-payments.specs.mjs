// Marketplace payment confirmation, refunds and reconciliation, against a real
// Postgres and the real payment-request and refund services. There is no payment
// provider to call (payments are confirmed by staff, refunds are sent by staff),
// so these tests are about what must hold regardless of who confirms: one
// decision wins, amounts and references are checked, a half-finished
// confirmation or refund is visible and repairable, and the books reconcile.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { products, shopOrders, users, auditLog, paymentRequests, refunds, subscriptions, marketplaceNotifications } from '../src/bootstrap/collections.mjs';
import { ensureInit } from '../functions/index.mjs';
import { createShopService } from '../src/services/shop-service.mjs';
import { createPgShopOrderStore } from '../src/infra/shop-order-store-pg.mjs';
import { createAdminPaymentService } from '../src/services/admin-payment-service.mjs';
import { createRefundService } from '../src/services/refund-service.mjs';
import { createShopReconciliationService } from '../src/services/shop-reconciliation-service.mjs';

await ensureInit();

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], products: [], orders: [] };
const inbox = [];
const orderStore = createPgShopOrderStore({ db });
const reconciliation = createShopReconciliationService({ db, sampleSize: 5000 });

/** The shop, payment and refund services wired as in production; `faults` lets a test break one seam. */
function wire(faults = {}) {
  const shopRef = {};
  const refundService = createRefundService({
    refunds, paymentRequests, subscriptions, users, auditLog,
    notify: async (userId, message) => { inbox.push({ userId, ...message }); },
    onPaid: async (refund) => {
      if (faults.onPaid) throw new Error('order service down');
      return refund.kind === 'shop_order' ? shopRef.shop.markOrderRefunded(refund.orderId) : null;
    },
  });
  const shop = createShopService({
    products, shopOrders, users, auditLog, paymentRequests, orderStore, marketplaceNotifications,
    onRefundDue: async ({ order, amountTzs, reasonCode, actorId, role }) => {
      if (faults.refund) throw new Error('refund service down');
      const out = await refundService.raise({ memberId: order.buyerId, kind: 'shop_order', sourceId: order.id, amountTzs, reasonCode, requestedBy: actorId, requestedRole: role, approved: true });
      if (out.error) throw new Error(`refund_${out.error}`);
      return out.refund;
    },
    onVendorEvent: async () => {},
  });
  shopRef.shop = shop;
  const payments = createAdminPaymentService({
    paymentRequests, subscriptions, users, auditLog,
    onOrderPayment: (orderId, status) => (faults.applyPayment ? Promise.reject(new Error('stopped')) : shop.applyPaymentToOrder(orderId, status)),
    beforeOrderPayment: (request, opts) => shop.checkOrderPayment(request, opts),
  });
  return { shop, payments, refundService };
}

async function user(userType = 'member') {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `P ${userType}`, updatedAt: new Date() });
  made.users.push(id);
  return id;
}
async function newOrder(svc, { qty = 1, priceTzs = 10_000, stock = 10, reference = null } = {}) {
  const vendor = await user('vendor');
  const buyer = await user();
  const productId = uid('prd');
  await db('Product').insert({ id: productId, vendorId: vendor, name: 'Item', priceTzs, stock, status: 'active', approvalStatus: 'approved', updatedAt: new Date() });
  made.products.push(productId);
  const placed = await svc.createOrder({ buyerId: buyer, body: { items: [{ productId, qty }], deliveryMethod: 'home_delivery', deliveryAddress: 'x', paymentMethod: 'mpesa', paymentReference: reference } });
  assert.ok(placed.order, JSON.stringify(placed));
  made.orders.push(placed.order.id);
  return { orderId: placed.order.id, buyer, vendor, productId, requestId: placed.paymentRequest.id };
}
const order = (id) => db('ShopOrder').where({ id }).first();
const request = (id) => db('PaymentRequest').where({ id }).first();
const findings = async (checkId) => (await reconciliation.report()).checks.find(c => c.id === checkId).sample;
const audits = (target, action) => db('AuditLog').where({ target, action });

after(async () => {
  await db('MarketplaceNotification').whereIn('userId', made.users).del();
  await db('Refund').whereIn('orderId', made.orders).del();
  await db('ShopStockMovement').whereIn('orderId', made.orders).del();
  await db('PaymentRequest').whereIn('orderId', made.orders).del();
  await db('AuditLog').whereIn('target', made.orders).del();
  await db('ShopOrder').whereIn('id', made.orders).del();
  await db('Product').whereIn('id', made.products).del();
  await db('User').whereIn('id', made.users).del();
  await db.destroy();
});

// ── confirming a payment ─────────────────────────────────────────────────────

test('two staff members approving at once: one decision wins, the order is paid once', async () => {
  const { shop, payments } = wire();
  const o = await newOrder(shop);
  const results = await Promise.all([
    payments.decide({ id: o.requestId, decision: 'approve', reference: 'MP-RACE-1', actorId: 'adm_a' }),
    payments.decide({ id: o.requestId, decision: 'approve', reference: 'MP-RACE-1', actorId: 'adm_b' }),
  ]);
  assert.equal(results.filter(r => r.paymentRequest).length, 1);
  assert.equal(results.find(r => r.error).error, 'already_decided');
  assert.equal((await order(o.orderId)).paymentStatus, 'paid');
  assert.equal((await audits(o.requestId, 'payment_approved')).length, 1);
  assert.equal((await request(o.requestId)).status, 'approved');
});

test('an amount that is not the order total is refused and nothing is confirmed', async () => {
  const { shop, payments } = wire();
  const o = await newOrder(shop, { priceTzs: 10_000, qty: 2 });
  const short = await payments.decide({ id: o.requestId, decision: 'approve', amountTzs: 15_000, actorId: 'adm' });
  assert.equal(short.error, 'amount_mismatch');
  assert.equal(short.expectedTzs, 20_000);
  assert.equal((await request(o.requestId)).status, 'pending');
  assert.equal((await order(o.orderId)).paymentStatus, 'pending');
  // The right amount confirms it.
  const ok = await payments.decide({ id: o.requestId, decision: 'approve', amountTzs: 20_000, actorId: 'adm' });
  assert.equal(ok.paymentRequest.status, 'approved');
});

test('a payment request that no longer matches its order cannot be confirmed', async () => {
  const { shop, payments } = wire();
  const o = await newOrder(shop);
  await db('PaymentRequest').where({ id: o.requestId }).update({ amountTzs: 1 });
  assert.equal((await payments.decide({ id: o.requestId, decision: 'approve', actorId: 'adm' })).error, 'order_amount_mismatch');
  await db('PaymentRequest').where({ id: o.requestId }).update({ amountTzs: 10_000, memberId: await user() });
  assert.equal((await payments.decide({ id: o.requestId, decision: 'approve', actorId: 'adm' })).error, 'order_buyer_mismatch');
  await db('PaymentRequest').where({ id: o.requestId }).update({ memberId: o.buyer, currency: 'USD' });
  assert.equal((await payments.decide({ id: o.requestId, decision: 'approve', actorId: 'adm' })).error, 'currency_mismatch');
  assert.equal((await order(o.orderId)).paymentStatus, 'pending');
});

test('one transaction reference confirms one order only', async () => {
  const { shop, payments } = wire();
  const ref = `MP-${randomUUID().slice(0, 8)}`;
  const [a, b] = [await newOrder(shop), await newOrder(shop)];
  assert.ok((await payments.decide({ id: a.requestId, decision: 'approve', reference: ref, actorId: 'adm' })).paymentRequest);
  const reuse = await payments.decide({ id: b.requestId, decision: 'approve', reference: ref, actorId: 'adm' });
  assert.equal(reuse.error, 'reference_already_used');
  assert.equal((await order(b.orderId)).paymentStatus, 'pending');
  // Through the other edit route too, and the database refuses it if the checks are bypassed.
  assert.equal((await payments.update({ id: b.requestId, status: 'approved', reference: ref, actorId: 'adm' })).error, 'reference_already_used');
  await assert.rejects(() => db('PaymentRequest').where({ id: b.requestId }).update({ status: 'approved', reference: ref }), /paymentrequest_order_reference_confirmed_unique/);
  // A different reference is fine.
  assert.ok((await payments.decide({ id: b.requestId, decision: 'approve', reference: `${ref}-b`, actorId: 'adm' })).paymentRequest);
});

test('a confirmed order payment cannot be edited back to rejected, pending or cancelled', async () => {
  const { shop, payments } = wire();
  const o = await newOrder(shop);
  await payments.decide({ id: o.requestId, decision: 'approve', actorId: 'adm' });
  for (const status of ['rejected', 'pending', 'cancelled']) {
    assert.equal((await payments.update({ id: o.requestId, status, actorId: 'adm' })).error, 'payment_already_confirmed', status);
  }
  assert.equal((await request(o.requestId)).status, 'approved');
  assert.equal((await order(o.orderId)).paymentStatus, 'paid');
  // Repeating "approved" is harmless.
  assert.ok((await payments.update({ id: o.requestId, status: 'approved', actorId: 'adm' })).paymentRequest);
});

test('rejecting then confirming later: the order is revived once, not paid twice', async () => {
  const { shop, payments } = wire();
  const o = await newOrder(shop, { stock: 5, qty: 2 });
  await payments.decide({ id: o.requestId, decision: 'reject', actorId: 'adm' });
  assert.equal((await order(o.orderId)).status, 'cancelled');
  assert.equal((await db('Product').where({ id: o.productId }).first()).stock, 5);
  await Promise.all([
    payments.update({ id: o.requestId, status: 'approved', actorId: 'adm' }),
    payments.update({ id: o.requestId, status: 'approved', actorId: 'adm2' }),
  ]);
  const row = await order(o.orderId);
  assert.deepEqual([row.status, row.paymentStatus], ['pending', 'paid']);
  assert.equal((await db('Product').where({ id: o.productId }).first()).stock, 3);
});

// ── a confirmation that stopped half-way ─────────────────────────────────────

test('confirmed but the order was never updated: reconciliation finds it and repair completes it once', async () => {
  const { shop, payments } = wire({ applyPayment: true });
  const o = await newOrder(shop);
  await assert.rejects(() => payments.decide({ id: o.requestId, decision: 'approve', reference: 'MP-HALF', actorId: 'adm' }), /stopped/);
  assert.equal((await request(o.requestId)).status, 'approved', 'the confirmation was recorded');
  assert.equal((await order(o.orderId)).paymentStatus, 'pending', 'but the order was not updated');
  assert.ok((await findings('confirmed_payment_order_not_paid')).some(f => f.id === o.orderId));

  const healthy = wire();
  const [first, second] = await Promise.all([
    healthy.shop.repairOrderPayment({ orderId: o.orderId, actorId: 'adm' }),
    healthy.shop.repairOrderPayment({ orderId: o.orderId, actorId: 'adm' }),
  ]);
  assert.equal((await order(o.orderId)).paymentStatus, 'paid');
  assert.ok(first.order && second.order);
  assert.equal((await db('MarketplaceNotification').where({ userId: o.buyer, type: 'payment_received' })).length, 1);
  assert.equal((await findings('confirmed_payment_order_not_paid')).some(f => f.id === o.orderId), false);
  // Nothing to repair when there is no confirmed payment.
  const bare = await newOrder(healthy.shop);
  assert.equal((await healthy.shop.repairOrderPayment({ orderId: bare.orderId, actorId: 'adm' })).error, 'no_confirmed_payment');
});

// ── refunds ──────────────────────────────────────────────────────────────────

async function paidAndCancelled(svc, payments, opts) {
  const o = await newOrder(svc, opts);
  await payments.decide({ id: o.requestId, decision: 'approve', reference: `MP-${randomUUID().slice(0, 8)}`, actorId: 'adm' });
  const out = await svc.buyerCancelOrder({ buyerId: o.buyer, orderId: o.orderId });
  return { ...o, cancel: out };
}

test('a paid order cancelled gets one refund; recording it paid twice at once records one payment', async () => {
  const { shop, payments, refundService } = wire();
  const o = await paidAndCancelled(shop, payments);
  assert.equal(o.cancel.refund.status, 'approved');
  assert.equal(o.cancel.refund.amountTzs, 10_000);
  const refundId = o.cancel.refund.id;
  const [a, b] = await Promise.all([
    refundService.markPaid({ id: refundId, body: { paymentReference: 'OUT-1' }, actorId: 'adm_a' }),
    refundService.markPaid({ id: refundId, body: { paymentReference: 'OUT-2' }, actorId: 'adm_b' }),
  ]);
  assert.equal([a, b].filter(r => r.refund).length, 1);
  assert.equal([a, b].find(r => r.error).error, 'already_paid');
  assert.equal((await audits(refundId, 'refund_paid')).length, 1);
  assert.equal(inbox.filter(m => m.type === 'refund_paid' && m.data?.refundId === refundId).length, 1);
  assert.equal((await order(o.orderId)).paymentStatus, 'refunded');
  // Deciding twice is refused the same way.
  const again = await refundService.markPaid({ id: refundId, body: { paymentReference: 'OUT-3' }, actorId: 'adm_c' });
  assert.equal(again.error, 'already_paid');
});

test('refund service down at cancellation: the order stays owed, it is on the report, and a retry raises it once', async () => {
  const broken = wire({ refund: true });
  const o = await paidAndCancelled(broken.shop, broken.payments);
  assert.equal(o.cancel.order.paymentStatus, 'refund_pending');
  assert.equal(o.cancel.refund, null);
  assert.equal((await audits(o.orderId, 'shop_refund_not_raised')).length, 1);
  assert.equal((await db('Refund').where({ orderId: o.orderId })).length, 0);
  assert.ok((await findings('refund_owed_none_raised')).some(f => f.id === o.orderId));

  const healthy = wire();
  const [x, y] = await Promise.all([
    healthy.shop.raiseMissingRefund({ orderId: o.orderId, actorId: 'adm' }),
    healthy.shop.raiseMissingRefund({ orderId: o.orderId, actorId: 'adm' }),
  ]);
  assert.equal(x.refund.id, y.refund.id, 'the same refund, not two');
  assert.equal((await db('Refund').where({ orderId: o.orderId })).length, 1);
  assert.equal((await findings('refund_owed_none_raised')).some(f => f.id === o.orderId), false);
  assert.equal((await healthy.shop.raiseMissingRefund({ orderId: (await newOrder(healthy.shop)).orderId, actorId: 'adm' })).error, 'no_refund_owed');
});

test('a refund paid while the order could not be updated is recorded and found', async () => {
  const broken = wire({ onPaid: true });
  const o = await paidAndCancelled(broken.shop, broken.payments);
  const paid = await broken.refundService.markPaid({ id: o.cancel.refund.id, body: { paymentReference: 'OUT-9' }, actorId: 'adm' });
  assert.equal(paid.refund.status, 'paid', 'the refund itself is recorded');
  assert.equal((await audits(o.cancel.refund.id, 'refund_paid_source_not_updated')).length, 1);
  assert.equal((await order(o.orderId)).paymentStatus, 'refund_pending');
  assert.ok((await findings('refund_paid_order_not_refunded')).some(f => f.id === o.orderId));
});

test('a refund is never more than was confirmed', async () => {
  const { shop, payments } = wire();
  const o = await newOrder(shop, { priceTzs: 10_000, qty: 2 });
  await payments.decide({ id: o.requestId, decision: 'approve', reference: `MP-${randomUUID().slice(0, 8)}`, actorId: 'adm' });
  await db('PaymentRequest').where({ id: o.requestId }).update({ amountTzs: 12_000 }); // what was really received
  const out = await shop.buyerCancelOrder({ buyerId: o.buyer, orderId: o.orderId });
  assert.equal(out.refund.amountTzs, 12_000);
  assert.equal((await audits(o.orderId, 'shop_refund_amount_capped')).length, 1);
  assert.ok((await findings('confirmed_payment_amount_differs')).some(f => f.id === o.orderId));
});

test('a refund paid for an order that was not owed one changes nothing and is recorded', async () => {
  const { shop } = wire();
  const o = await newOrder(shop);
  const result = await shop.markOrderRefunded(o.orderId);
  assert.equal(result.paymentStatus, 'pending');
  assert.equal((await audits(o.orderId, 'shop_refund_paid_unexpected_state')).length, 1);
});

// ── the books ────────────────────────────────────────────────────────────────

test('reconciliation: a clean marketplace reports no P0/P1 finding for its own orders', async () => {
  const { shop, payments, refundService } = wire();
  const o = await paidAndCancelled(shop, payments);
  await refundService.markPaid({ id: o.cancel.refund.id, body: { paymentReference: 'OUT-CLEAN' }, actorId: 'adm' });
  const report = await reconciliation.report();
  const mine = new Set([o.orderId]);
  for (const check of report.checks.filter(c => c.severity !== 'P2')) {
    assert.equal(check.sample.some(f => mine.has(f.id) || mine.has(f.orderId)), false, check.id);
  }
});

test('reconciliation finds an order paid with no confirmed payment, and stock that disagrees with the order', async () => {
  const { shop } = wire();
  const o = await newOrder(shop);
  await db('ShopOrder').where({ id: o.orderId }).update({ paymentStatus: 'paid' });
  assert.ok((await findings('paid_without_confirmed_payment')).some(f => f.id === o.orderId));
  await db('ShopOrder').where({ id: o.orderId }).update({ stockState: 'released' });
  assert.ok((await findings('stock_state_inconsistent')).some(f => f.id === o.orderId));
  const report = await reconciliation.report();
  assert.equal(report.ok, false);
  assert.ok(report.open.some(x => x === 'P0 paid_without_confirmed_payment'));
});

test('reconciliation finds a cancelled order still on a vendor statement', async () => {
  const { shop, payments } = wire();
  const o = await paidAndCancelled(shop, payments);
  const statementId = uid('vst');
  await db('VendorSettlement').insert({ id: statementId, vendorId: o.vendor, periodStartDate: '2026-10-05', periodEndDate: '2026-10-11', status: 'draft' });
  const lineId = uid('vsl');
  await db('VendorSettlementLine').insert({ id: lineId, vendorSettlementId: statementId, vendorId: o.vendor, orderId: o.orderId, deliveredOn: '2026-10-08', payoutTzs: 9_000 });
  try {
    const found = (await findings('refunded_order_in_vendor_statement')).find(f => f.orderId === o.orderId);
    assert.ok(found);
    assert.equal(found.statementId, statementId);
    await db('VendorSettlementLine').where({ id: lineId }).update({ voided: true });
    assert.equal((await findings('refunded_order_in_vendor_statement')).some(f => f.orderId === o.orderId), false);
  } finally {
    await db('VendorSettlementLine').where({ id: lineId }).del();
    await db('VendorSettlement').where({ id: statementId }).del();
  }
});
