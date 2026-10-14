// Marketplace go-live regression and hardening, against a real Postgres and the
// production wiring: the whole life of an order (listing → moderation → purchase
// → payment → fulfilment → statement → payout → settled) with every
// reconciliation check clean, plus the abuse and exposure limits.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { users, gyms, partnerGate, trainers, shopService, adminPaymentService, shopReconciliationService } from '../src/bootstrap/services.mjs';
import { partnerSettlementAccounts } from '../src/bootstrap/collections.mjs';
import { ensureInit } from '../functions/index.mjs';
import { createPayoutEligibility } from '../src/services/payout-eligibility.mjs';
import { createVendorSettlementService } from '../src/services/vendor-settlement-service.mjs';
import { buyerOrderView } from '../src/services/shop-service.mjs';

await ensureInit();

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], products: [], orders: [] };
const clock = { now: new Date(Date.now() + 7 * 86_400_000) }; // a week on: this week's deliveries are in the last ended week
const eligibility = createPayoutEligibility({ users, gyms, partnerGate, partnerSettlementAccounts, trainers });
const settlements = createVendorSettlementService({ users, payoutEligibility: eligibility, now: () => clock.now });

async function user(userType, extra = {}) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `H ${userType}`, updatedAt: new Date(), ...extra });
  made.users.push(id);
  return id;
}
/** A vendor created before KYC enforcement (exempt from the gate) that also has approved KYC and a verified payout account. */
async function vendor() {
  const id = await user('vendor', { createdAt: new Date('2026-01-01T00:00:00Z'), vendorProfile: JSON.stringify({ businessName: 'Shop', status: 'published' }) });
  const caseId = uid('kyc');
  await db('PartnerKycCase').insert({ id: caseId, partnerType: 'vendor', userId: id, status: 'approved', tier: 3, updatedAt: new Date() });
  await db('PartnerSettlementAccount').insert({
    id: uid('psa'), caseId, method: 'bank', provider: 'CRDB', accountName: 'Shop', accountNumber: '0150001234',
    status: 'verified', isPrimary: true, verifiedAt: new Date('2026-09-01T00:00:00Z'), cooldownUntil: new Date('2026-09-03T00:00:00Z'), updatedAt: new Date(),
  });
  return id;
}
async function listedProduct(vendorId, body = {}) {
  const out = await shopService.upsertProduct({ vendorId, body: { name: 'Whey', category: 'supplements_nutrition', priceTzs: 20_000, stock: 10, ...body } });
  assert.ok(!out.error, JSON.stringify(out));
  made.products.push(out.product.id);
  await shopService.adminUpdateProductListing({ productId: out.product.id, body: { approvalStatus: 'approved' }, actorId: 'adm_h' });
  return out.product;
}
const cartOf = (lines, extra = {}) => ({ items: lines, deliveryMethod: 'home_delivery', deliveryAddress: 'Mikocheni', paymentMethod: 'mpesa', ...extra });
async function place(buyerId, lines, extra) {
  const out = await shopService.createOrder({ buyerId, body: cartOf(lines, extra) });
  if (out.order) made.orders.push(out.order.id);
  return out;
}
const order = (id) => db('ShopOrder').where({ id }).first();
const open = async () => (await shopReconciliationService.report());

after(async () => {
  const ids = made.orders;
  await db('VendorSettlementLine').whereIn('orderId', ids).del();
  await db('VendorSettlement').whereIn('vendorId', made.users).where({ status: 'draft' }).del();
  await db('MarketplaceNotification').whereIn('userId', made.users).del();
  await db('Refund').whereIn('orderId', ids).del();
  await db('ShopStockMovement').whereIn('orderId', ids).del();
  await db('PaymentRequest').whereIn('orderId', ids).del();
  await db('AuditLog').whereIn('target', ids).del();
  await db('ShopOrder').whereIn('id', ids).del();
  await db('Product').whereIn('id', made.products).del();
  // Paid statements are final by design; everything that pointed at them goes with the users that own them.
  await db('PartnerSettlementAccount').whereIn('caseId', db('PartnerKycCase').whereIn('userId', made.users).select('id')).del();
  await db('PartnerKycCase').whereIn('userId', made.users).del();
  await db('User').whereIn('id', made.users).del().catch(() => {});
  await db.destroy();
});

// ── the whole life of an order ───────────────────────────────────────────────

test('listing → moderation → purchase → payment → fulfilment → statement → payout → settled, books clean', async () => {
  const vendorId = await vendor();
  const buyer = await user('member');
  const maker = uid('adm'); const checker = uid('adm');

  // A new listing is not for sale until FitFlex approves it.
  const created = await shopService.upsertProduct({ vendorId, body: { name: 'Creatine', category: 'supplements_nutrition', priceTzs: 30_000, stock: 5 } });
  made.products.push(created.product.id);
  assert.equal(created.product.approvalStatus, 'pending');
  assert.equal((await place(buyer, [{ productId: created.product.id, qty: 1 }])).error, 'product_not_found');
  assert.equal((await shopService.listProducts({})).some(p => p.id === created.product.id), false);
  await shopService.adminUpdateProductListing({ productId: created.product.id, body: { approvalStatus: 'approved' }, actorId: 'adm_h' });
  assert.equal((await shopService.listProducts({})).some(p => p.id === created.product.id), true);

  // Purchase: priced by the server, stock reserved, payment awaited.
  const placed = await place(buyer, [{ productId: created.product.id, qty: 2 }]);
  assert.equal(placed.status, 202);
  assert.equal(placed.order.totalTzs, 60_000);
  assert.equal((await db('Product').where({ id: created.product.id }).first()).stock, 3);
  // Nothing can be fulfilled before payment.
  assert.equal((await shopService.updateOrderStatus({ orderId: placed.order.id, status: 'accepted', actorId: vendorId })).error, 'order_not_paid');

  // Staff confirm the payment; it is checked against the order.
  const paid = await adminPaymentService.decide({ id: placed.paymentRequest.id, decision: 'approve', reference: `MP-${randomUUID().slice(0, 8)}`, amountTzs: 60_000, actorId: maker });
  assert.equal(paid.paymentRequest.status, 'approved');
  assert.equal((await order(placed.order.id)).paymentStatus, 'paid');

  // Fulfilment follows the state machine.
  for (const status of ['accepted', 'dispatched', 'delivered']) {
    assert.equal((await shopService.updateOrderStatus({ orderId: placed.order.id, status, actorId: vendorId })).order.status, status);
  }
  assert.equal((await shopService.updateOrderStatus({ orderId: placed.order.id, status: 'cancelled', actorId: vendorId })).error, 'order_already_delivered');

  // The weekly statement: one live share per order, however often it is prepared.
  const first = await settlements.prepare({ actorId: maker });
  const again = await settlements.prepare({ actorId: maker });
  assert.equal(first.error, undefined, JSON.stringify(first));
  const live = await db('VendorSettlementLine').where({ orderId: placed.order.id, voided: false });
  assert.equal(live.length, 1, 'prepared twice, still one line');
  assert.equal(again.statements.filter(s => s.vendorId === vendorId).length, 1);
  const statement = await db('VendorSettlement').where({ id: live[0].vendorSettlementId }).first();
  assert.deepEqual([statement.salesTzs, statement.commissionTzs, statement.finalNetTzs], [60_000, 6_000, 54_000], '10% commission, fixed on the order line');

  // Two people, a verified payout account, a reference: then it is paid, once.
  await settlements.submit({ id: statement.id, actorId: maker });
  assert.equal((await settlements.approve({ id: statement.id, actorId: maker })).error, 'cannot_approve_own_submission');
  await settlements.approve({ id: statement.id, actorId: checker });
  await settlements.markPayable({ id: statement.id, actorId: checker });
  const [p1, p2] = await Promise.all([
    settlements.pay({ id: statement.id, paymentReference: 'CRDB-GOLIVE', actorId: checker }),
    settlements.pay({ id: statement.id, paymentReference: 'CRDB-GOLIVE-2', actorId: checker }),
  ]);
  assert.equal([p1, p2].filter(r => r.statement).length, 1, 'a statement is paid once');
  assert.equal((await order(placed.order.id)).settlementStatus, 'settled');

  // And the books agree: nothing this order touched is flagged.
  const report = await open();
  for (const check of report.checks.filter(c => c.severity !== 'P2')) {
    assert.equal(check.sample.some(f => [f.id, f.orderId].includes(placed.order.id)), false, check.id);
  }
});

test('a cancelled order never reaches a statement and its refund is raised once', async () => {
  const vendorId = await vendor();
  const buyer = await user('member');
  const product = await listedProduct(vendorId);
  const placed = await place(buyer, [{ productId: product.id, qty: 1 }]);
  await adminPaymentService.decide({ id: placed.paymentRequest.id, decision: 'approve', reference: `MP-${randomUUID().slice(0, 8)}`, actorId: 'adm_a' });
  const cancelled = await shopService.buyerCancelOrder({ buyerId: buyer, orderId: placed.order.id });
  assert.equal(cancelled.order.paymentStatus, 'refund_pending');
  assert.equal(cancelled.refund.amountTzs, 20_000);
  await settlements.prepare({ actorId: 'adm_a' });
  assert.equal((await db('VendorSettlementLine').where({ orderId: placed.order.id })).length, 0);
  assert.equal((await db('Product').where({ id: product.id }).first()).stock, 10);
});

// ── what the public and customers may see ────────────────────────────────────

test('a customer never sees commission, payouts or internal order fields; the public never sees reviewer ids', async () => {
  const vendorId = await vendor();
  const buyer = await user('member');
  const product = await listedProduct(vendorId);
  const placed = await place(buyer, [{ productId: product.id, qty: 1 }]);
  await adminPaymentService.decide({ id: placed.paymentRequest.id, decision: 'approve', reference: `MP-${randomUUID().slice(0, 8)}`, actorId: 'adm_a' });
  for (const status of ['accepted', 'dispatched', 'delivered']) await shopService.updateOrderStatus({ orderId: placed.order.id, status, actorId: vendorId });

  const mine = (await shopService.myOrders(buyer)).find(o => o.id === placed.order.id);
  const text = JSON.stringify(mine);
  for (const secret of ['commissionPct', 'commissionTzs', 'vendorPayoutTzs', 'idempotencyKey', 'stockState', 'fulfilments', 'settlementStatus']) {
    assert.equal(text.includes(secret), false, `buyer view leaks ${secret}`);
  }
  assert.equal(mine.items[0].priceTzs, 20_000);
  assert.equal(buyerOrderView(null), null);

  await shopService.reviewProduct({ buyerId: buyer, orderId: placed.order.id, productId: product.id, rating: 5, comment: 'Good' });
  const detail = await shopService.getProduct(product.id);
  assert.equal(detail.reviews.length, 1);
  assert.deepEqual(Object.keys(detail.reviews[0]).sort(), ['comment', 'createdAt', 'id', 'productId', 'rating']);
  assert.equal(JSON.stringify(detail).includes(buyer), false, 'the reviewer is not identifiable from the product page');
});

// ── abuse and size limits ────────────────────────────────────────────────────

test('one buyer cannot hold stock with an unlimited number of unpaid orders', async () => {
  const vendorId = await vendor();
  const buyer = await user('member');
  const product = await listedProduct(vendorId, { stock: 100 });
  const results = [];
  for (let i = 0; i < 7; i += 1) results.push(await place(buyer, [{ productId: product.id, qty: 1 }]));
  assert.equal(results.filter(r => r.order).length, 5);
  assert.equal(results[5].error, 'too_many_unpaid_orders');
  assert.equal(results[5].status, 429);
  assert.equal((await db('Product').where({ id: product.id }).first()).stock, 95, 'refused orders reserved nothing');
  // Paying or cancelling one frees a place.
  await shopService.buyerCancelOrder({ buyerId: buyer, orderId: results[0].order.id });
  assert.ok((await place(buyer, [{ productId: product.id, qty: 1 }])).order);
});

test('oversized or malformed order input is refused before anything is reserved', async () => {
  const vendorId = await vendor();
  const buyer = await user('member');
  const product = await listedProduct(vendorId, { stock: 5_000, priceTzs: 90_000_000 });
  const cases = [
    [{ deliveryAddress: 'x'.repeat(301) }, 'invalid_field'],
    [{ note: 'x'.repeat(501) }, 'invalid_field'],
    [{ note: { a: 1 } }, 'invalid_field'],
    [{ paymentReference: 'x'.repeat(101) }, 'invalid_field'],
  ];
  for (const [extra, error] of cases) {
    assert.equal((await place(buyer, [{ productId: product.id, qty: 1 }], extra)).error, error, JSON.stringify(extra).slice(0, 40));
  }
  assert.equal((await place(buyer, [{ productId: product.id, qty: 1001 }])).error, 'invalid_quantity');
  assert.equal((await place(buyer, [{ productId: product.id, qty: 2 }])).error, 'order_too_large');
  assert.equal((await place(buyer, Array.from({ length: 51 }, () => ({ productId: product.id, qty: 1 })))).error, 'too_many_items');
  assert.equal((await db('Product').where({ id: product.id }).first()).stock, 5_000);
});

test('product input is bounded: sizes, integers, option lists', async () => {
  const vendorId = await vendor();
  const base = { name: 'Bar', category: 'supplements_nutrition', priceTzs: 3_000, stock: 5 };
  const bad = async (patch, field) => {
    const out = await shopService.upsertProduct({ vendorId, body: { ...base, ...patch } });
    if (out.product) made.products.push(out.product.id);
    assert.ok(out.error, `${JSON.stringify(patch).slice(0, 50)} should be refused`);
    if (field) assert.equal(out.field, field);
  };
  await bad({ name: 'n'.repeat(201) }, 'name');
  await bad({ description: 'd'.repeat(5001) }, 'description');
  await bad({ priceTzs: 1.5 });
  await bad({ priceTzs: -5 });
  await bad({ priceTzs: 10 ** 12 });
  await bad({ stock: 2.5 });
  await bad({ stock: 10 ** 7 });
  await bad({ images: Array.from({ length: 11 }, (_, i) => `i${i}.webp`) }, 'images');
  await bad({ variants: Array.from({ length: 31 }, (_, i) => ({ name: `v${i}` })) }, 'variants');
  await bad({ variants: [{ name: '' }] }, 'variants');
  await bad({ variants: [{ name: 'S', stock: -1 }] }, 'variants');
  const ok = await shopService.upsertProduct({ vendorId, body: { ...base, variants: [{ name: 'Vanilla', stock: 3 }, { name: 'Choc' }], images: ['a.webp'] } });
  made.products.push(ok.product.id);
  assert.ok(ok.product);
});

// ── reconciliation of settlement itself ──────────────────────────────────────

test('the database refuses a share on two live statements; reconciliation still catches a wrong total and a wrong settled order', async () => {
  const vendorId = await vendor();
  const buyer = await user('member');
  const product = await listedProduct(vendorId);
  const placed = await place(buyer, [{ productId: product.id, qty: 1 }]);
  const st = [uid('vst'), uid('vst')];
  for (const [i, id] of st.entries()) {
    await db('VendorSettlement').insert({ id, vendorId, periodStartDate: `2026-01-0${i + 1}`, periodEndDate: `2026-01-1${i}`, status: 'draft', finalNetTzs: i === 0 ? 999 : 500 });
  }
  await db('VendorSettlementLine').insert({ id: uid('vsl'), vendorSettlementId: st[0], vendorId, orderId: placed.order.id, deliveredOn: '2026-01-05', payoutTzs: 500 });
  // Paid twice is impossible by construction: the same order and vendor cannot be on a second live statement.
  await assert.rejects(
    () => db('VendorSettlementLine').insert({ id: uid('vsl'), vendorSettlementId: st[1], vendorId, orderId: placed.order.id, deliveredOn: '2026-01-05', payoutTzs: 500 }),
    /vendor_settlement_line_order_ux/,
  );
  await db('ShopOrder').where({ id: placed.order.id }).update({ settlementStatus: 'settled' });
  try {
    const report = await open();
    const sample = (id) => report.checks.find(c => c.id === id).sample;
    assert.ok(sample('vendor_statement_total_mismatch').some(f => f.statementId === st[0]));
    assert.ok(sample('settled_order_not_delivered_and_paid').some(f => f.id === placed.order.id));
    assert.ok(report.checks.some(c => c.id === 'order_share_on_two_live_statements'), 'kept as a tripwire for the index being dropped');
    assert.equal(report.ok, false);
  } finally {
    await db('VendorSettlementLine').whereIn('vendorSettlementId', st).del();
    await db('VendorSettlement').whereIn('id', st).del();
  }
});
