// Vendor-scoped fulfilment and the status route, against a real Postgres:
// one vendor moves only their own part of an order, concurrent changes cannot
// both win, and the people who may not act cannot.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { products, shopOrders, users, auditLog, paymentRequests } from '../src/bootstrap/collections.mjs';
import { ensureInit } from '../functions/index.mjs';
import { createShopService } from '../src/services/shop-service.mjs';
import { createPgShopOrderStore } from '../src/infra/shop-order-store-pg.mjs';
import { vendorUpdateOrderStatus } from '../functions/shop.mjs';

await ensureInit();

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], products: [], orders: [] };
const refunds = [];
const orderStore = createPgShopOrderStore({ db });
const service = createShopService({
  products, shopOrders, users, auditLog, paymentRequests, orderStore,
  onRefundDue: async ({ order, reasonCode }) => { const r = { orderId: order.id, reasonCode }; refunds.push(r); return r; },
});

async function user(userType = 'member', extra = {}) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `T ${userType}`, updatedAt: new Date(), ...extra });
  made.users.push(id);
  return id;
}
async function product(vendorId, { stock = 10, priceTzs = 10_000 } = {}) {
  const id = uid('prd');
  await db('Product').insert({ id, vendorId, name: 'Item', priceTzs, stock, status: 'active', approvalStatus: 'approved', updatedAt: new Date() });
  made.products.push(id);
  return id;
}
/** A paid order for `lines` ([{ productId, qty }]). */
async function paidOrder(buyerId, lines, extra = {}) {
  const placed = await service.createOrder({ buyerId, body: { items: lines, deliveryMethod: 'home_delivery', deliveryAddress: 'Mikocheni', paymentMethod: 'mpesa', ...extra } });
  assert.ok(placed.order, JSON.stringify(placed));
  made.orders.push(placed.order.id);
  await service.applyPaymentToOrder(placed.order.id, 'approved');
  return placed.order.id;
}
const row = (id) => db('ShopOrder').where({ id }).first();
const move = (orderId, status, actorId, extra = {}) => service.updateOrderStatus({ orderId, status, actorId, actorRole: 'vendor', ...extra });
const adminMove = (orderId, status, extra = {}) => service.updateOrderStatus({ orderId, status, actorId: 'adm_1', actorRole: 'admin', ...extra });
const fulfilmentOf = async (orderId, vendorId) => (await row(orderId)).fulfilments.find(f => f.vendorId === vendorId);
const stockOf = async (id) => (await db('Product').where({ id }).first()).stock;

/** Two vendors, one paid order with a line from each. */
async function twoVendorOrder() {
  const [a, b, buyer] = await Promise.all([user('vendor'), user('vendor'), user()]);
  const [pa, pb] = await Promise.all([product(a), product(b)]);
  const orderId = await paidOrder(buyer, [{ productId: pa, qty: 1 }, { productId: pb, qty: 2 }]);
  return { a, b, buyer, pa, pb, orderId };
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

// ── isolation between vendors ────────────────────────────────────────────────

test('each vendor moves only their own part; the order shows the least advanced part', async () => {
  const { a, b, orderId } = await twoVendorOrder();
  assert.deepEqual((await row(orderId)).fulfilments.map(f => f.status), ['pending', 'pending']);

  for (const status of ['accepted', 'packed', 'dispatched']) assert.equal((await move(orderId, status, a)).order.status, status);
  assert.equal((await fulfilmentOf(orderId, a)).status, 'dispatched');
  assert.equal((await fulfilmentOf(orderId, b)).status, 'pending', 'the other vendor\'s part is untouched');
  assert.equal((await row(orderId)).status, 'pending', 'the customer still waits on vendor B');

  // Vendor A cannot deliver "the order" — they can only deliver their own part, and B's is not theirs.
  assert.equal((await move(orderId, 'delivered', a)).order.status, 'delivered');
  assert.equal((await fulfilmentOf(orderId, b)).status, 'pending');
  assert.equal((await row(orderId)).status, 'pending');

  for (const status of ['accepted', 'dispatched', 'delivered']) await move(orderId, status, b);
  assert.equal((await row(orderId)).status, 'delivered');
});

test('a vendor with no line in the order cannot touch it, whoever they are', async () => {
  const { orderId } = await twoVendorOrder();
  const stranger = await user('vendor');
  const out = await move(orderId, 'accepted', stranger);
  // S2: an order with no line of theirs looks absent to a vendor (as on GET /vendor/orders/:id).
  assert.equal(out.error, 'order_not_found');
  assert.equal(out.status, 404);
  assert.deepEqual((await row(orderId)).fulfilments.map(f => f.status), ['pending', 'pending']);
  assert.equal((await service.vendorOrders(stranger)).length, 0);
});

test('a vendor sees only their own lines, subtotal and status; never another vendor\'s lines or commission', async () => {
  const { a, b, pa, orderId } = await twoVendorOrder();
  await move(orderId, 'accepted', a);
  const [viewA] = await service.vendorOrders(a);
  assert.equal(viewA.id, orderId);
  assert.equal(viewA.items.length, 1);
  assert.deepEqual(viewA.items.map(i => i.productId), [pa]);
  assert.equal(viewA.totalTzs, 10_000);
  assert.equal(viewA.status, 'accepted');
  assert.equal(viewA.orderStatus, 'pending');
  assert.deepEqual(viewA.nextStatuses, ['processing', 'packed', 'dispatched']);
  assert.equal(viewA.fulfilments, undefined);
  const [viewB] = await service.vendorOrders(b);
  assert.equal(viewB.status, 'pending');
  assert.equal(viewB.totalTzs, 20_000);
  assert.deepEqual(viewB.nextStatuses, ['accepted']);
  assert.equal(JSON.stringify(viewB).includes(a), false, 'vendor A\'s id is not in vendor B\'s view');
});

test('a vendor cannot cancel their part of a multi-vendor order; FitFlex cancels the whole', async () => {
  const { a, b, buyer, pa, pb, orderId } = await twoVendorOrder();
  const out = await move(orderId, 'cancelled', a);
  assert.equal(out.error, 'multi_vendor_cancel_requires_admin');
  assert.equal((await row(orderId)).status, 'pending');
  refunds.length = 0;
  const done = await adminMove(orderId, 'cancelled', { reason: 'customer called' });
  assert.equal(done.order.status, 'cancelled');
  assert.deepEqual((await row(orderId)).fulfilments.map(f => f.status), ['cancelled', 'cancelled']);
  assert.equal(refunds.filter(r => r.orderId === orderId).length, 1);
  assert.equal(await stockOf(pa), 10);
  assert.equal(await stockOf(pb), 10);
  const note = (await row(orderId)).timeline.at(-1);
  assert.equal(note.reason, 'customer called');
  assert.equal(b && buyer && true, true);
});

test('once one vendor has delivered, the whole order can no longer be cancelled or refunded', async () => {
  const { a, buyer, orderId } = await twoVendorOrder();
  for (const status of ['accepted', 'dispatched', 'delivered']) await move(orderId, status, a);
  refunds.length = 0;
  assert.equal((await adminMove(orderId, 'cancelled')).error, 'order_partly_delivered');
  assert.equal((await service.buyerCancelOrder({ buyerId: buyer, orderId })).error, 'order_partly_delivered');
  assert.equal((await row(orderId)).status, 'pending');
  assert.equal(refunds.length, 0);
});

test('the buyer cannot cancel once any vendor has dispatched, even if the order still reads pending', async () => {
  const { a, buyer, orderId } = await twoVendorOrder();
  await move(orderId, 'accepted', a);
  await move(orderId, 'dispatched', a);
  assert.equal((await row(orderId)).status, 'pending');
  assert.deepEqual(await service.buyerCancelOrder({ buyerId: buyer, orderId }), { error: 'order_already_dispatched', status: 409 });
});

// ── suspension, staff, admin ─────────────────────────────────────────────────

test('a suspended vendor cannot move an order', async () => {
  const vendor = await user('vendor');
  const buyer = await user();
  const orderId = await paidOrder(buyer, [{ productId: await product(vendor), qty: 1 }]);
  await db('User').where({ id: vendor }).update({ accountStatus: 'suspended' });
  const out = await move(orderId, 'accepted', vendor);
  assert.equal(out.error, 'vendor_suspended');
  assert.equal((await row(orderId)).status, 'pending');
  await db('User').where({ id: vendor }).update({ accountStatus: 'active' });
  assert.equal((await move(orderId, 'accepted', vendor)).order.status, 'accepted');
});

test('the route: staff need the orders permission and act only for their own vendor', async () => {
  const [vendor, other] = await Promise.all([user('vendor'), user('vendor')]);
  const buyer = await user();
  const orderId = await paidOrder(buyer, [{ productId: await product(vendor), qty: 1 }]);
  const staffOf = (vendorId, permissions) => user('vendor_staff', { vendorId, vendorPermissions: permissions, accountStatus: 'active' });
  const withOrders = await staffOf(vendor, ['orders']);
  const withoutOrders = await staffOf(vendor, ['products']);
  const otherStaff = await staffOf(other, ['orders']);

  const guard = vendorUpdateOrderStatus.onGuard[1]; // vendor-staff permission
  const run = async (g, claims) => {
    let outcome = 'next';
    await g({ user: claims }, { status(c) { outcome = c; return this; }, json() { return this; } }, () => {});
    return outcome;
  };
  assert.equal(await run(guard, { sub: withOrders, userType: 'vendor_staff', vendorId: vendor }), 'next');
  assert.equal(await run(guard, { sub: withoutOrders, userType: 'vendor_staff', vendorId: vendor }), 403);
  // A staff member of another vendor passes the permission check but has no line in this order.
  assert.equal(await run(guard, { sub: otherStaff, userType: 'vendor_staff', vendorId: other }), 'next');

  const call = async (claims, body) => {
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await vendorUpdateOrderStatus.onRequest({ params: { id: orderId }, body, user: claims }, res);
    return res;
  };
  const foreign = await call({ sub: otherStaff, userType: 'vendor_staff', vendorId: other }, { status: 'accepted' });
  assert.equal(foreign.code, 404);
  assert.equal(foreign.body.error, 'order_not_found');
  const own = await call({ sub: withOrders, userType: 'vendor_staff', vendorId: vendor }, { status: 'accepted' });
  assert.equal(own.code, 200);
  assert.equal(own.body.status, 'accepted');
  const bad = await call({ sub: withOrders, userType: 'vendor_staff', vendorId: vendor }, { status: 'delivered' });
  assert.equal(bad.code, 409);
  assert.equal(bad.body.error, 'invalid_transition');
  assert.deepEqual(bad.body.allowed, ['processing', 'packed', 'dispatched']);
});

test('the route: an admin needs the shop scope; a vendorId is required for a multi-vendor order', async () => {
  const guard = vendorUpdateOrderStatus.onGuard[2];
  const run = async (claims) => {
    let outcome = 'next';
    await guard({ user: claims }, { status(c) { outcome = c; return this; }, json() { return this; } }, () => {});
    return outcome;
  };
  assert.equal(await run({ userType: 'admin', portalUser: true, aclPermissions: ['users'] }), 403);
  assert.equal(await run({ userType: 'admin', portalUser: true, aclPermissions: ['shop'] }), 'next');
  assert.equal(await run({ userType: 'admin' }), 'next', 'a super-admin is unrestricted');
  assert.equal(await run({ userType: 'vendor', sub: 'v' }), 'next', 'the scope applies to administrators only');

  const { a, b, orderId } = await twoVendorOrder();
  const unclear = await adminMove(orderId, 'accepted');
  assert.equal(unclear.error, 'vendor_required');
  assert.deepEqual(unclear.vendors.sort(), [a, b].sort());
  assert.equal((await adminMove(orderId, 'accepted', { vendorId: 'nobody' })).error, 'vendor_not_in_order');
  const ok = await adminMove(orderId, 'accepted', { vendorId: b, reason: 'vendor phoned in' });
  assert.equal((await fulfilmentOf(orderId, b)).status, 'accepted');
  assert.equal((await fulfilmentOf(orderId, a)).status, 'pending');
  const entry = (await fulfilmentOf(orderId, b)).timeline.at(-1);
  assert.deepEqual([entry.status, entry.by, entry.actorId, entry.reason], ['accepted', 'admin', 'adm_1', 'vendor phoned in']);
  assert.equal(ok.order.fulfilments.length, 2, 'an admin sees the whole order');
  // And every move is audited with who, from, to and why.
  const audit = await db('AuditLog').where({ target: orderId, action: 'shop_order_accepted' });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor, 'adm_1');
  assert.equal(audit[0].after.reason, 'vendor phoned in');
  assert.equal(audit[0].before.status, 'pending');
});

// ── the matrix through the service ───────────────────────────────────────────

test('skipped, backward and final moves are refused with what is allowed; repeating is a no-op', async () => {
  const vendor = await user('vendor');
  const buyer = await user();
  const orderId = await paidOrder(buyer, [{ productId: await product(vendor), qty: 1 }]);
  const skip = await move(orderId, 'delivered', vendor);
  assert.equal(skip.error, 'invalid_transition');
  assert.equal(skip.status, 409);
  assert.deepEqual([skip.from, skip.to, skip.allowed], ['pending', 'delivered', ['accepted']]);
  assert.equal((await move(orderId, 'dispatched', vendor)).error, 'invalid_transition');
  await move(orderId, 'accepted', vendor);
  const again = await move(orderId, 'accepted', vendor);
  assert.equal(again.unchanged, true);
  assert.equal((await db('AuditLog').where({ target: orderId, action: 'shop_order_accepted' })).length, 1, 'repeating writes nothing');
  assert.equal((await row(orderId)).timeline.filter(t => t.status === 'accepted').length, 1);
  assert.equal((await move(orderId, 'pending', vendor)).error, 'invalid_transition');
  await move(orderId, 'dispatched', vendor);
  await move(orderId, 'delivered', vendor);
  const final = await move(orderId, 'accepted', vendor);
  assert.equal(final.error, 'order_status_final');
  assert.equal((await move(orderId, 'cancelled', vendor)).error, 'order_already_delivered');
  assert.equal((await row(orderId)).status, 'delivered');
});

test('an unpaid order cannot be fulfilled, and a gym pickup order is handed over via ready_for_pickup', async () => {
  const vendor = await user('vendor');
  const buyer = await user();
  const productId = await product(vendor);
  const placed = await service.createOrder({ buyerId: buyer, body: { items: [{ productId, qty: 1 }], deliveryMethod: 'gym_pickup', pickupGymId: 'gym_1', paymentMethod: 'mpesa' } });
  made.orders.push(placed.order.id);
  assert.equal((await move(placed.order.id, 'accepted', vendor)).error, 'order_not_paid');
  await service.applyPaymentToOrder(placed.order.id, 'approved');
  await move(placed.order.id, 'accepted', vendor);
  await move(placed.order.id, 'packed', vendor);
  assert.equal((await move(placed.order.id, 'delivered', vendor)).error, 'invalid_transition');
  await move(placed.order.id, 'ready_for_pickup', vendor);
  assert.equal((await move(placed.order.id, 'delivered', vendor)).order.status, 'delivered');
});

test('a home delivery order cannot be marked ready for pickup', async () => {
  const vendor = await user('vendor');
  const buyer = await user();
  const orderId = await paidOrder(buyer, [{ productId: await product(vendor), qty: 1 }]);
  await move(orderId, 'accepted', vendor);
  const out = await move(orderId, 'ready_for_pickup', vendor);
  assert.equal(out.error, 'invalid_transition');
  assert.deepEqual(out.allowed, ['processing', 'packed', 'dispatched']);
});

// ── concurrency ──────────────────────────────────────────────────────────────

test('the same move sent five times at once changes the order once', async () => {
  const vendor = await user('vendor');
  const buyer = await user();
  const orderId = await paidOrder(buyer, [{ productId: await product(vendor), qty: 1 }]);
  const results = await Promise.all(Array.from({ length: 5 }, () => move(orderId, 'accepted', vendor)));
  assert.ok(results.every(r => r.order && !r.error));
  assert.equal(results.filter(r => !r.unchanged).length, 1);
  assert.equal((await row(orderId)).timeline.filter(t => t.status === 'accepted').length, 1);
  assert.equal((await db('AuditLog').where({ target: orderId, action: 'shop_order_accepted' })).length, 1);
});

test('delivered and cancelled sent at once: exactly one wins and the books agree', async () => {
  for (let round = 0; round < 4; round += 1) {
    const vendor = await user('vendor');
    const buyer = await user();
    const productId = await product(vendor, { stock: 5 });
    const orderId = await paidOrder(buyer, [{ productId, qty: 2 }]);
    await move(orderId, 'accepted', vendor);
    await move(orderId, 'dispatched', vendor);
    refunds.length = 0;
    const [delivered, cancelled] = await Promise.all([move(orderId, 'delivered', vendor), move(orderId, 'cancelled', vendor)]);
    const final = await row(orderId);
    if (final.status === 'delivered') {
      assert.equal(cancelled.error, 'order_already_delivered', `round ${round}`);
      assert.equal(await stockOf(productId), 3, 'delivered goods stay out of stock');
      assert.equal(refunds.length, 0, 'no refund for a delivered order');
    } else {
      assert.equal(final.status, 'cancelled', `round ${round}`);
      assert.ok(delivered.error, 'delivery was refused once cancelled');
      assert.equal(await stockOf(productId), 5);
      assert.equal(refunds.filter(r => r.orderId === orderId).length, 1);
    }
  }
});

test('two vendors moving their own parts at once both succeed and the order reflects both', async () => {
  const { a, b, orderId } = await twoVendorOrder();
  const results = await Promise.all([move(orderId, 'accepted', a), move(orderId, 'accepted', b)]);
  assert.ok(results.every(r => r.order?.status === 'accepted'));
  const stored = await row(orderId);
  assert.deepEqual(stored.fulfilments.map(f => f.status), ['accepted', 'accepted']);
  assert.equal(stored.status, 'accepted');
  assert.equal(stored.timeline.filter(t => t.status === 'accepted').length, 2);
});

// ── older orders and revival ─────────────────────────────────────────────────

test('an order made before fulfilments existed (legacy status, no vendor on its lines): FitFlex moves it; a vendor cannot see or move it (S2)', async () => {
  const vendor = await user('vendor');
  const buyer = await user();
  const productId = await product(vendor);
  const id = uid('ord');
  made.orders.push(id);
  await db('ShopOrder').insert({
    id, buyerId: buyer, items: JSON.stringify([{ productId, name: 'Old', qty: 1, priceTzs: 10_000 }]), totalTzs: 10_000,
    status: 'confirmed', paymentStatus: 'paid', deliveryMethod: 'home_delivery', timeline: JSON.stringify([{ status: 'confirmed' }]), stockState: 'reserved',
  });
  // S2 privacy rule (plan §3): lines without a vendorId are never shown to a vendor, so the order is not listed.
  assert.equal((await service.vendorOrders(vendor)).some(o => o.id === id), false);
  // S2 (security review of #200): a vendor acts only on orders they can see.
  assert.deepEqual(await move(id, 'accepted', vendor), { error: 'order_not_found', status: 404 });
  // FitFlex still resolves the line's vendor through the product and moves it; legacy statuses still read right.
  assert.equal((await adminMove(id, 'accepted')).unchanged, true, 'confirmed already is accepted');
  assert.equal((await adminMove(id, 'dispatched')).order.status, 'dispatched');
  assert.equal((await adminMove(id, 'fulfilled')).order.status, 'delivered');
  const stored = await row(id);
  assert.equal(stored.status, 'delivered');
  assert.deepEqual(stored.fulfilments.map(f => f.vendorId), [vendor]);
  const stranger = await user('vendor');
  assert.equal((await move(id, 'accepted', stranger)).error, 'order_not_found');
});

test('an order revived by a late payment starts every vendor\'s part again', async () => {
  const clock = { now: new Date('2026-10-14T09:00:00Z') };
  const timed = createShopService({
    products, shopOrders, users, auditLog, paymentRequests, orderStore: createPgShopOrderStore({ db, now: () => clock.now }),
    now: () => clock.now, reservationTtlMinutes: 60, onRefundDue: async () => null,
  });
  const vendor = await user('vendor');
  const buyer = await user();
  const placed = await timed.createOrder({ buyerId: buyer, body: { items: [{ productId: await product(vendor), qty: 1 }], deliveryMethod: 'home_delivery', deliveryAddress: 'x', paymentMethod: 'mpesa' } });
  made.orders.push(placed.order.id);
  clock.now = new Date(+clock.now + 61 * 60_000);
  await timed.expireStaleReservations({});
  assert.deepEqual((await row(placed.order.id)).fulfilments.map(f => f.status), ['cancelled']);
  await timed.applyPaymentToOrder(placed.order.id, 'approved');
  const revived = await row(placed.order.id);
  assert.equal(revived.status, 'pending');
  assert.deepEqual(revived.fulfilments.map(f => f.status), ['pending']);
  assert.equal((await timed.updateOrderStatus({ orderId: placed.order.id, status: 'accepted', actorId: vendor })).order.status, 'accepted');
});
