// Marketplace checkout integrity, against a real Postgres: stock is never
// oversold, a checkout is all-or-nothing, a retry never makes a second order,
// and reserved stock is given back exactly once. These guarantees are the
// database's, so they are tested against the database, not against fakes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { products, shopOrders, users, auditLog, paymentRequests } from '../src/bootstrap/collections.mjs';
import { ensureInit } from '../functions/index.mjs';
import { createShopService } from '../src/services/shop-service.mjs';
import { createPgShopOrderStore } from '../src/infra/shop-order-store-pg.mjs';
import { createShopOrder } from '../functions/shop.mjs';

await ensureInit();

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], products: [], orders: [] };
let clock = new Date('2026-10-14T09:00:00Z');
const refunds = [];

const orderStore = createPgShopOrderStore({ db, now: () => clock });
const service = createShopService({
  products, shopOrders, users, auditLog, paymentRequests, orderStore, now: () => clock, reservationTtlMinutes: 60,
  onRefundDue: async ({ order, reasonCode }) => { const r = { orderId: order.id, reasonCode, amountTzs: order.totalTzs }; refunds.push(r); return r; },
});

async function user(userType = 'member') {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `Shop ${userType}`, updatedAt: new Date() });
  made.users.push(id);
  return id;
}
async function product({ stock = 5, priceTzs = 10_000, vendorId, ...extra } = {}) {
  const id = uid('prd');
  vendorId ||= await user('vendor');
  await db('Product').insert({
    id, vendorId, name: 'Whey', priceTzs, stock, status: 'active', approvalStatus: 'approved',
    soldCount: 0, updatedAt: new Date(), ...extra,
  });
  made.products.push(id);
  return id;
}
const stockOf = async (id) => (await db('Product').where({ id }).first()).stock;
const soldOf = async (id) => (await db('Product').where({ id }).first()).soldCount;
const ledger = (orderId, productId) => db('ShopStockMovement').where({ orderId, productId });
const cart = (items, extra = {}) => ({ items, deliveryMethod: 'home_delivery', deliveryAddress: 'Mikocheni', paymentMethod: 'mpesa', ...extra });
async function place(buyerId, items, opts = {}) {
  const out = await service.createOrder({ buyerId, body: cart(items), ...opts });
  if (out.order) made.orders.push(out.order.id);
  return out;
}

after(async () => {
  await db('ShopStockMovement').whereIn('orderId', made.orders).del();
  await db('PaymentRequest').whereIn('orderId', made.orders).del();
  await db('AuditLog').whereIn('target', made.orders).del();
  await db('ShopOrder').whereIn('id', made.orders).del();
  await db('Product').whereIn('id', made.products).del();
  await db('User').whereIn('id', made.users).del();
  await db.destroy();
});

// ── overselling ──────────────────────────────────────────────────────────────

test('ten buyers race for the last unit: exactly one gets it', async () => {
  const productId = await product({ stock: 1 });
  const buyers = await Promise.all(Array.from({ length: 10 }, () => user()));
  const results = await Promise.all(buyers.map(b => place(b, [{ productId, qty: 1 }])));
  const won = results.filter(r => r.order);
  assert.equal(won.length, 1);
  assert.deepEqual([...new Set(results.filter(r => r.error).map(r => r.error))], ['insufficient_stock']);
  assert.equal(await stockOf(productId), 0);
  assert.equal(await soldOf(productId), 1);
  assert.equal((await db('ShopOrder').whereIn('buyerId', buyers)).length, 1);
});

test('stock 5, twelve single-unit orders: five succeed and stock never goes below zero', async () => {
  const productId = await product({ stock: 5 });
  const buyers = await Promise.all(Array.from({ length: 12 }, () => user()));
  const results = await Promise.all(buyers.map(b => place(b, [{ productId, qty: 1 }])));
  assert.equal(results.filter(r => r.order).length, 5);
  assert.equal(await stockOf(productId), 0);
});

test('the same product on two lines is checked and reserved as a total', async () => {
  const productId = await product({ stock: 3 });
  const buyer = await user();
  const over = await place(buyer, [{ productId, qty: 2 }, { productId, qty: 2 }]);
  assert.equal(over.error, 'insufficient_stock');
  assert.equal(await stockOf(productId), 3);
  const ok = await place(buyer, [{ productId, qty: 2 }, { productId, qty: 1 }]);
  assert.equal(ok.order.items.length, 1);
  assert.equal(ok.order.items[0].qty, 3);
  assert.equal(await stockOf(productId), 0);
});

test('quantities must be whole numbers', async () => {
  const productId = await product();
  const buyer = await user();
  for (const qty of [1.5, 0, -1, 'x', null]) {
    assert.equal((await place(buyer, [{ productId, qty }])).error, 'invalid_quantity', String(qty));
  }
});

test('the database itself refuses negative stock', async () => {
  const productId = await product({ stock: 1 });
  await assert.rejects(() => db('Product').where({ id: productId }).update({ stock: -1 }), /product_stock_non_negative/);
});

// ── atomicity ────────────────────────────────────────────────────────────────

test('a multi-item order that fails on one line reserves nothing and writes no order', async () => {
  const a = await product({ stock: 5 });
  const b = await product({ stock: 0 });
  const buyer = await user();
  const orderId = uid('ord');
  made.orders.push(orderId);
  const lines = [{ productId: a, qty: 2, priceTzs: 10_000, discountPriceTzs: 0 }, { productId: b, qty: 1, priceTzs: 10_000, discountPriceTzs: 0 }];
  const out = await orderStore.placeOrder({
    order: { id: orderId, buyerId: buyer, buyerRole: 'member', items: [], totalTzs: 30_000, status: 'pending', paymentStatus: 'pending', timeline: [], createdAt: clock.toISOString(), updatedAt: clock.toISOString() },
    lines,
  });
  assert.equal(out.error, 'insufficient_stock');
  assert.equal(out.productId, b);
  assert.equal(await stockOf(a), 5);
  assert.equal(await db('ShopOrder').where({ id: orderId }).first(), undefined);
  assert.equal((await ledger(orderId, a)).length, 0);
});

test('an order and its payment request are written together, with a ledger row per reservation', async () => {
  const productId = await product({ stock: 4, priceTzs: 8_000 });
  const buyer = await user();
  const out = await place(buyer, [{ productId, qty: 2 }]);
  assert.equal(out.status, 202);
  assert.equal(out.order.totalTzs, 16_000);
  assert.equal(out.order.paymentStatus, 'pending');
  assert.equal(out.order.stockState, 'reserved');
  assert.ok(out.order.reservationExpiresAt);
  const requests = await db('PaymentRequest').where({ orderId: out.order.id });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].amountTzs, 16_000);
  const rows = await ledger(out.order.id, productId);
  assert.deepEqual(rows.map(r => [r.reason, r.delta, r.stockAfter]), [['reserve', -2, 2]]);
});

test('the price is the product row\'s, never the request\'s, and a price that moved is refused', async () => {
  const productId = await product({ stock: 5, priceTzs: 10_000 });
  const buyer = await user();
  const out = await service.createOrder({ buyerId: buyer, body: { ...cart([{ productId, qty: 1, priceTzs: 1 }]), totalTzs: 1, discountTzs: 9_999 } });
  made.orders.push(out.order.id);
  assert.equal(out.order.totalTzs, 10_000);
  // The vendor changes the price after the order was priced but before stock was reserved.
  const orderId = uid('ord');
  made.orders.push(orderId);
  await db('Product').where({ id: productId }).update({ priceTzs: 12_000 });
  const stale = await orderStore.placeOrder({
    order: { id: orderId, buyerId: buyer, buyerRole: 'member', items: [], totalTzs: 10_000, status: 'pending', paymentStatus: 'pending', timeline: [], createdAt: clock.toISOString(), updatedAt: clock.toISOString() },
    lines: [{ productId, qty: 1, priceTzs: 10_000, discountPriceTzs: 0 }],
  });
  assert.equal(stale.error, 'price_changed');
  assert.equal(await stockOf(productId), 4);
});

// ── idempotency ──────────────────────────────────────────────────────────────

test('a retried checkout returns the original order and reserves stock once', async () => {
  const productId = await product({ stock: 5 });
  const buyer = await user();
  const key = `chk-${randomUUID()}`;
  const first = await place(buyer, [{ productId, qty: 2 }], { idempotencyKey: key });
  const second = await place(buyer, [{ productId, qty: 2 }], { idempotencyKey: key });
  assert.equal(second.order.id, first.order.id);
  assert.equal(second.replayed, true);
  assert.equal(second.paymentRequest?.id, first.paymentRequest.id);
  assert.equal(await stockOf(productId), 3);
  assert.equal((await db('ShopOrder').where({ buyerId: buyer })).length, 1);
  assert.equal((await db('PaymentRequest').where({ orderId: first.order.id })).length, 1);
});

test('five identical requests at once make one order', async () => {
  const productId = await product({ stock: 10 });
  const buyer = await user();
  const key = `chk-${randomUUID()}`;
  const results = await Promise.all(Array.from({ length: 5 }, () => place(buyer, [{ productId, qty: 3 }], { idempotencyKey: key })));
  assert.equal(new Set(results.map(r => r.order.id)).size, 1);
  assert.equal(await stockOf(productId), 7);
  assert.equal((await db('ShopOrder').where({ buyerId: buyer })).length, 1);
});

test('a retry still finds its order after the stock has gone', async () => {
  const productId = await product({ stock: 1 });
  const buyer = await user();
  const key = `chk-${randomUUID()}`;
  const first = await place(buyer, [{ productId, qty: 1 }], { idempotencyKey: key });
  const again = await place(buyer, [{ productId, qty: 1 }], { idempotencyKey: key });
  assert.equal(again.order.id, first.order.id);
});

test('a key reused for a different cart is refused, and keys are per buyer', async () => {
  const productId = await product({ stock: 10 });
  const [buyer, other] = await Promise.all([user(), user()]);
  const key = `chk-${randomUUID()}`;
  await place(buyer, [{ productId, qty: 1 }], { idempotencyKey: key });
  const different = await place(buyer, [{ productId, qty: 2 }], { idempotencyKey: key });
  assert.equal(different.error, 'idempotency_key_reused');
  assert.equal(different.status, 409);
  const theirs = await place(other, [{ productId, qty: 1 }], { idempotencyKey: key });
  assert.ok(theirs.order, 'another buyer may use the same key');
  assert.equal(await stockOf(productId), 8);
});

test('malformed idempotency keys are rejected', async () => {
  const productId = await product();
  const buyer = await user();
  assert.equal((await place(buyer, [{ productId, qty: 1 }], { idempotencyKey: 'short' })).error, 'invalid_idempotency_key');
});

// ── release, exactly once ────────────────────────────────────────────────────

test('cancelling twice at once gives the stock back once', async () => {
  const productId = await product({ stock: 5 });
  const buyer = await user();
  const { order } = await place(buyer, [{ productId, qty: 2 }]);
  assert.equal(await stockOf(productId), 3);
  const results = await Promise.all([
    service.buyerCancelOrder({ buyerId: buyer, orderId: order.id }),
    service.buyerCancelOrder({ buyerId: buyer, orderId: order.id }),
    service.buyerCancelOrder({ buyerId: buyer, orderId: order.id }),
  ]);
  assert.ok(results.every(r => r.order?.status === 'cancelled' || r.error === 'order_cancelled'), JSON.stringify(results.map(r => r.error)));
  assert.equal(await stockOf(productId), 5);
  assert.equal(await soldOf(productId), 0);
  assert.deepEqual((await ledger(order.id, productId)).map(r => r.reason).sort(), ['release', 'reserve']);
  assert.equal((await db('ShopOrder').where({ id: order.id }).first()).stockState, 'released');
  // The unpaid request is withdrawn too.
  assert.deepEqual((await db('PaymentRequest').where({ orderId: order.id })).map(r => r.status), ['cancelled']);
});

test('a paid order cancelled twice at once raises one refund and restocks once', async () => {
  const productId = await product({ stock: 5 });
  const buyer = await user();
  const { order } = await place(buyer, [{ productId, qty: 1 }]);
  await service.applyPaymentToOrder(order.id, 'approved');
  refunds.length = 0;
  await Promise.all([
    service.buyerCancelOrder({ buyerId: buyer, orderId: order.id }),
    service.buyerCancelOrder({ buyerId: buyer, orderId: order.id }),
  ]);
  assert.equal(refunds.filter(r => r.orderId === order.id).length, 1);
  assert.equal(await stockOf(productId), 5);
  assert.equal((await db('ShopOrder').where({ id: order.id }).first()).paymentStatus, 'refund_pending');
});

test('a rejected payment releases the stock once, even when decided twice', async () => {
  const productId = await product({ stock: 5 });
  const buyer = await user();
  const { order } = await place(buyer, [{ productId, qty: 3 }]);
  await Promise.all([service.applyPaymentToOrder(order.id, 'rejected'), service.applyPaymentToOrder(order.id, 'rejected')]);
  await service.applyPaymentToOrder(order.id, 'cancelled');
  assert.equal(await stockOf(productId), 5);
  const row = await db('ShopOrder').where({ id: order.id }).first();
  assert.equal(row.status, 'cancelled');
  assert.equal(row.paymentStatus, 'failed');
});

test('a paid, delivered order cannot be cancelled or restocked', async () => {
  const productId = await product({ stock: 5 });
  const buyer = await user();
  const { order } = await place(buyer, [{ productId, qty: 1 }]);
  await service.applyPaymentToOrder(order.id, 'approved');
  await db('ShopOrder').where({ id: order.id }).update({ status: 'delivered' });
  const out = await service.buyerCancelOrder({ buyerId: buyer, orderId: order.id });
  assert.ok(out.error);
  assert.equal(await stockOf(productId), 4);
});

// ── expiry and late payment ──────────────────────────────────────────────────

test('an unpaid order expires and its stock is released once; a paid order is left alone', async () => {
  const productId = await product({ stock: 5 });
  const [b1, b2] = await Promise.all([user(), user()]);
  const unpaid = (await place(b1, [{ productId, qty: 2 }])).order;
  const paid = (await place(b2, [{ productId, qty: 1 }])).order;
  await service.applyPaymentToOrder(paid.id, 'approved');
  assert.equal(await stockOf(productId), 2);

  assert.deepEqual(await service.expireStaleReservations({}), { due: 0, expired: 0 }, 'not yet');
  clock = new Date(+clock + 61 * 60_000);
  // Two sweeps at once (two servers): the sweep covers every lapsed order, so assert on this order.
  await Promise.all([service.expireStaleReservations({}), service.expireStaleReservations({})]);
  assert.equal(await stockOf(productId), 4);
  assert.deepEqual((await ledger(unpaid.id, productId)).map(r => r.reason).sort(), ['release', 'reserve']);
  const row = await db('ShopOrder').where({ id: unpaid.id }).first();
  assert.equal(row.status, 'cancelled');
  assert.equal(row.paymentStatus, 'failed');
  assert.equal((await db('ShopOrder').where({ id: paid.id }).first()).status, 'pending');
  assert.deepEqual((await db('PaymentRequest').where({ orderId: unpaid.id })).map(r => r.status), ['cancelled']);
  assert.equal((await service.expireStaleReservations({})).expired, 0);
});

test('payment arriving after the reservation expired is not fulfilled and is queued for refund once', async () => {
  const productId = await product({ stock: 5 });
  const buyer = await user();
  const { order } = await place(buyer, [{ productId, qty: 2 }]);
  clock = new Date(+clock + 61 * 60_000);
  await service.expireStaleReservations({});
  assert.equal(await stockOf(productId), 5);
  refunds.length = 0;
  await Promise.all([service.applyPaymentToOrder(order.id, 'approved'), service.applyPaymentToOrder(order.id, 'approved')]);
  const row = await db('ShopOrder').where({ id: order.id }).first();
  assert.equal(row.status, 'cancelled', 'the order is not revived');
  assert.equal(row.paymentStatus, 'refund_pending');
  assert.equal(await stockOf(productId), 5, 'stock is not taken again');
  assert.equal(refunds.filter(r => r.orderId === order.id).length, 1);
  const audit = await db('AuditLog').where({ target: order.id, action: 'shop_order_payment_after_cancellation' });
  assert.equal(audit.length, 1);
});

test('a refund that cannot be raised is recorded, not just logged', async () => {
  const productId = await product({ stock: 5 });
  const buyer = await user();
  const failing = createShopService({
    products, shopOrders, users, auditLog, paymentRequests, orderStore, now: () => clock,
    onRefundDue: async () => { throw new Error('refund service down'); },
  });
  const { order } = await place(buyer, [{ productId, qty: 1 }]);
  await failing.applyPaymentToOrder(order.id, 'approved');
  const out = await failing.buyerCancelOrder({ buyerId: buyer, orderId: order.id });
  assert.equal(out.order.status, 'cancelled');
  assert.equal(out.order.paymentStatus, 'refund_pending', 'stays visibly owed');
  const audit = await db('AuditLog').where({ target: order.id, action: 'shop_refund_not_raised' });
  assert.equal(audit.length, 1);
});

// ── the route ────────────────────────────────────────────────────────────────

test('POST /me/shop-orders reads the Idempotency-Key header, keeps its 201 + order body, and flags a replay', async () => {
  // The route uses the real partner gate; vendors created before KYC enforcement are exempt from it.
  const vendorId = uid('usr');
  await db('User').insert({ id: vendorId, userType: 'vendor', displayName: 'Legacy vendor', createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date() });
  made.users.push(vendorId);
  const productId = await product({ stock: 5, vendorId });
  const buyer = await user();
  const call = async (headers) => {
    const res = { code: null, body: null, headers: {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, set(k, v) { this.headers[k] = v; } };
    const req = { user: { sub: buyer, userType: 'member' }, body: cart([{ productId, qty: 1 }]), headers, get: (h) => headers[h.toLowerCase()] };
    await createShopOrder.onRequest(req, res);
    if (res.body?.id) made.orders.push(res.body.id);
    return res;
  };
  const key = `chk-${randomUUID()}`;
  const first = await call({ 'idempotency-key': key });
  const second = await call({ 'idempotency-key': key });
  assert.equal(first.code, 201);
  assert.equal(first.body.paymentStatus, 'pending');
  assert.equal(second.code, 201);
  assert.equal(second.body.id, first.body.id);
  assert.equal(second.headers['Idempotent-Replay'], 'true');
  assert.equal(first.headers['Idempotent-Replay'], undefined);
  assert.equal(await stockOf(productId), 4);
  const bad = await call({ 'idempotency-key': 'x' });
  assert.equal(bad.code, 400);
});
