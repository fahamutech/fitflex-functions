// Vendor business tools · S1 — stock history with reasons, per-variant stock, cost price, low stock.
// Against the CI database: the guarantees (no oversell, one ledger row per change, a retried
// adjustment applied once) are the database's, so they are tested against the database.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { ensureInit } from '../functions/index.mjs';
import { users, gyms, partnerGate, trainers, shopService, adminPaymentService } from '../src/bootstrap/services.mjs';
import { partnerSettlementAccounts } from '../src/bootstrap/collections.mjs';
import { createPayoutEligibility } from '../src/services/payout-eligibility.mjs';
import { createVendorSettlementService } from '../src/services/vendor-settlement-service.mjs';
import { vendorShareOfOrder } from '../src/shared/marketplace-pricing.mjs';
import {
  vendorToolsOptionsRoute, vendorStockAdjustment, vendorStockMovements, vendorLowStock, vendorMyProducts,
  vendorCreateProduct, vendorUpdateProduct, listShopProducts, getShopProduct, getVendorStore, createShopOrder,
} from '../functions/shop.mjs';
import { shopHome, resetShopHomeLimits } from '../functions/shop-home.mjs';

await ensureInit();

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], products: [], orders: [] };
const FLAGS = ['VENDOR_TOOLS', 'VENDOR_STOCK_LEDGER', 'SHOP_HOME_V2', 'VENDOR_FISCAL', 'VENDOR_FISCAL_MODE', 'VENDOR_REPORTS'];
const ledgerOn = () => { process.env.VENDOR_TOOLS = '1'; process.env.VENDOR_STOCK_LEDGER = '1'; };
const ledgerOff = () => { delete process.env.VENDOR_TOOLS; delete process.env.VENDOR_STOCK_LEDGER; };
afterEach(() => { for (const f of FLAGS) delete process.env[f]; });

function res() {
  return {
    statusCode: 200, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    set(k, v) { this.headers[k] = v; return this; },
    type() { return this; },
    send(b) { this.body = b; return this; },
  };
}
async function call(route, claims, { params = {}, query = {}, body = {}, headers = {} } = {}) {
  const all = { authorization: `Bearer ${sign(claims)}`, ...headers };
  const req = { headers: all, params, query, body, get: name => all[String(name).toLowerCase()] ?? null };
  const out = res();
  for (const guard of [route.onGuard].flat().filter(Boolean)) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return { status: out.statusCode, body: out.body };
  }
  await route.onRequest(req, out);
  return { status: out.statusCode, body: out.body, headers: out.headers };
}

async function user(userType, extra = {}) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `Stock ${userType}`, updatedAt: new Date(), ...extra });
  made.users.push(id);
  return id;
}
/** A vendor who may sell: created before KYC enforcement, with approved KYC and a verified payout account. */
async function vendor() {
  const id = await user('vendor', { createdAt: new Date('2026-01-01T00:00:00Z'), vendorProfile: JSON.stringify({ businessName: 'Stock Shop', status: 'published' }) });
  const caseId = uid('kyc');
  await db('PartnerKycCase').insert({ id: caseId, partnerType: 'vendor', userId: id, status: 'approved', tier: 3, updatedAt: new Date() });
  await db('PartnerSettlementAccount').insert({
    id: uid('psa'), caseId, method: 'bank', provider: 'CRDB', accountName: 'Stock Shop', accountNumber: '0150009876',
    status: 'verified', isPrimary: true, verifiedAt: new Date('2026-09-01T00:00:00Z'), cooldownUntil: new Date('2026-09-03T00:00:00Z'), updatedAt: new Date(),
  });
  return id;
}
const as = id => ({ sub: id, userType: 'vendor' });

/** A product listed for sale (created through the vendor endpoint, then approved). */
async function listed(vendorId, body = {}) {
  const out = await call(vendorCreateProduct, as(vendorId), { body: { name: 'Whey', category: 'supplements_nutrition', priceTzs: 20_000, stock: 10, ...body } });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  made.products.push(out.body.id);
  await shopService.adminUpdateProductListing({ productId: out.body.id, body: { approvalStatus: 'approved' }, actorId: 'adm_stock' });
  return out.body;
}
const row = id => db('Product').where({ id }).first();
const ledgerOf = productId => db('ShopStockMovement').where({ productId }).orderBy([{ column: 'createdAt' }, { column: 'id' }]);
const sumOf = rows => rows.reduce((s, r) => s + Number(r.delta), 0);
const adjust = (vendorId, productId, body, claims = as(vendorId)) => call(vendorStockAdjustment, claims, { params: { id: productId }, body: { clientRef: randomUUID(), ...body } });
const lowAlerts = vendorId => db('MarketplaceNotification').where({ userId: vendorId, type: 'vendor_low_stock' });
const cart = items => ({ items, deliveryMethod: 'home_delivery', deliveryAddress: 'Mikocheni', paymentMethod: 'mpesa' });
async function place(buyerId, items) {
  const out = await call(createShopOrder, { sub: buyerId, userType: 'member' }, { body: cart(items) });
  if (out.body?.id) made.orders.push(out.body.id);
  return out;
}

after(async () => {
  await db('VendorSettlementLine').whereIn('orderId', made.orders).del();
  await db('VendorSettlement').whereIn('vendorId', made.users).whereIn('status', ['draft']).del();
  await db('ShopOrderLineCost').whereIn('orderId', made.orders).del();
  await db('ShopStockMovement').whereIn('productId', made.products).del();
  await db('MarketplaceNotification').whereIn('userId', made.users).del();
  await db('Notification').whereIn('userId', made.users).del();
  await db('PaymentRequest').whereIn('orderId', made.orders).del();
  await db('AuditLog').whereIn('target', [...made.orders, ...made.products]).del();
  await db('ShopOrder').whereIn('id', made.orders).del();
  await db('Product').whereIn('id', made.products).del(); // ProductPrivate goes with it (ON DELETE CASCADE)
  await db('PartnerSettlementAccount').whereIn('caseId', db('PartnerKycCase').whereIn('userId', made.users).select('id')).del();
  await db('PartnerKycCase').whereIn('userId', made.users).del();
  await db('User').whereIn('id', made.users).del().catch(() => {});
  await db.destroy();
});

// ── flags and discovery ──────────────────────────────────────────────────────

test('GET /vendor/tools/options: everything off by default; a tool needs the umbrella and its own flag', async () => {
  const v = await vendor();
  const off = await call(vendorToolsOptionsRoute, as(v));
  assert.equal(off.status, 200);
  assert.deepEqual(off.body, {
    stockLedger: false, portal: false, buyerContact: false, walkInSales: false, customers: false, documents: false,
    vat: false, reports: false, refunds: false, barcodes: false, purchases: false, fiscal: 'off',
  });
  process.env.VENDOR_STOCK_LEDGER = '1';
  assert.equal((await call(vendorToolsOptionsRoute, as(v))).body.stockLedger, false, 'no umbrella, no tool');
  process.env.VENDOR_TOOLS = '1';
  process.env.VENDOR_FISCAL = '1';
  process.env.VENDOR_FISCAL_MODE = 'sandbox';
  const on = (await call(vendorToolsOptionsRoute, as(v))).body;
  assert.equal(on.stockLedger, true);
  assert.equal(on.reports, false);
  assert.equal(on.fiscal, 'vfd');
  assert.equal((await call(vendorToolsOptionsRoute, { sub: uid('usr'), userType: 'member' })).status, 403);
});

test('ledger off: the new endpoints answer 404 feature_disabled and GET /vendor/products is unchanged', async () => {
  const v = await vendor();
  const p = await listed(v);
  const off = await adjust(v, p.id, { reason: 'restock', quantity: 1 });
  assert.deepEqual([off.status, off.body], [404, { error: 'feature_disabled' }]);
  assert.equal((await call(vendorStockMovements, as(v), { params: { id: p.id } })).body.error, 'feature_disabled');
  assert.equal((await call(vendorLowStock, as(v))).body.error, 'feature_disabled');
  const mine = (await call(vendorMyProducts, as(v))).body.find(x => x.id === p.id);
  assert.equal('costTzs' in mine, false);
  assert.equal((await ledgerOf(p.id)).length, 0, 'flag off: a new product writes no ledger row');
});

// ── adjustments ──────────────────────────────────────────────────────────────

test('adjustments: reasons move stock, each with one ledger row; responses carry before/after, actor and the product', async () => {
  ledgerOn();
  const v = await vendor();
  const p = await listed(v, { stock: 10 });
  const restock = await adjust(v, p.id, { reason: 'restock', quantity: 5, note: 'Delivery from supplier' });
  assert.equal(restock.status, 201, JSON.stringify(restock.body));
  assert.deepEqual(
    { ...restock.body.movement, id: undefined, createdAt: undefined },
    { id: undefined, productId: p.id, variant: null, reason: 'restock', kind: 'adjustment', delta: 5, stockBefore: 10, stockAfter: 15, note: 'Delivery from supplier', actor: { id: v, name: 'Stock vendor' }, orderId: null, document: null, createdAt: undefined },
  );
  assert.deepEqual(restock.body.product, { id: p.id, stock: 15, variants: [] });
  assert.equal((await adjust(v, p.id, { reason: 'damaged', quantity: 2 })).body.movement.stockAfter, 13);
  const other = await adjust(v, p.id, { reason: 'other', direction: 'out', quantity: 1, note: 'Sample for a trainer' });
  assert.equal(other.body.movement.delta, -1);
  const counted = await adjust(v, p.id, { reason: 'count', quantity: 9, expectedStock: 12 });
  assert.equal(counted.status, 201);
  assert.equal(counted.body.movement.delta, -3);
  assert.equal((await row(p.id)).stock, 9);
  const rows = await ledgerOf(p.id);
  assert.deepEqual(rows.map(r => [r.reason, r.delta, r.kind]), [['count', 10, 'adjustment'], ['restock', 5, 'adjustment'], ['damaged', -2, 'adjustment'], ['other', -1, 'adjustment'], ['count', -3, 'adjustment']]);
  assert.equal(rows[0].note, 'product_created');
  assert.equal(sumOf(rows), 9, 'the ledger adds up to the stock');
  assert.ok(rows.every(r => r.vendorId === v && r.orderId === null));
});

test('adjustments: validation errors', async () => {
  ledgerOn();
  const v = await vendor();
  const p = await listed(v, { stock: 3 });
  const err = async (body, error, status = 400) => {
    const out = await adjust(v, p.id, body);
    assert.equal(out.status, status, `${JSON.stringify(body)} → ${JSON.stringify(out.body)}`);
    assert.equal(out.body.error, error);
    return out.body;
  };
  await err({ reason: 'sale', quantity: 1 }, 'invalid_reason');
  await err({ reason: 'restock', quantity: 0 }, 'invalid_quantity');
  await err({ reason: 'restock', quantity: 1.5 }, 'invalid_quantity');
  await err({ reason: 'restock', quantity: 1, note: 'x'.repeat(201) }, 'note_too_long');
  await err({ reason: 'other', direction: 'in', quantity: 1 }, 'note_required');
  await err({ reason: 'other', quantity: 1, note: 'why' }, 'invalid_direction');
  await err({ reason: 'count', quantity: 1 }, 'expected_stock_required');
  await err({ reason: 'restock', quantity: 1, clientRef: 'short' }, 'invalid_client_ref');
  assert.equal((await err({ reason: 'lost', quantity: 4 }, 'insufficient_stock', 409)).currentStock, 3);
  assert.equal((await err({ reason: 'restock', quantity: 1, variant: 'XL' }, 'variant_not_found', 404)).error, 'variant_not_found');
  assert.equal((await row(p.id)).stock, 3, 'nothing moved');
});

test('a count made against a stale number is refused with the current stock (409 stock_changed)', async () => {
  ledgerOn();
  const v = await vendor();
  const p = await listed(v, { stock: 8 });
  const stale = await adjust(v, p.id, { reason: 'count', quantity: 5, expectedStock: 9 });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body, { error: 'stock_changed', currentStock: 8 });
  // Two people count the same shelf at once: one wins, the other is told to count again.
  const both = await Promise.all([
    adjust(v, p.id, { reason: 'count', quantity: 6, expectedStock: 8 }),
    adjust(v, p.id, { reason: 'count', quantity: 7, expectedStock: 8 }),
  ]);
  assert.deepEqual(both.map(b => b.status).sort(), [201, 409]);
  const lost = both.find(b => b.status === 409);
  assert.equal(lost.body.error, 'stock_changed');
  const won = both.find(b => b.status === 201);
  assert.equal(lost.body.currentStock, won.body.movement.stockAfter);
  assert.equal((await row(p.id)).stock, won.body.movement.stockAfter);
});

test('clientRef: a retried adjustment is applied once and answers 200 with the same movement', async () => {
  ledgerOn();
  const v = await vendor();
  const p = await listed(v, { stock: 4 });
  const clientRef = randomUUID();
  const first = await adjust(v, p.id, { reason: 'restock', quantity: 3, clientRef });
  const again = await adjust(v, p.id, { reason: 'restock', quantity: 3, clientRef });
  assert.equal(first.status, 201);
  assert.equal(again.status, 200);
  assert.equal(again.body.movement.id, first.body.movement.id);
  assert.equal((await row(p.id)).stock, 7);
  // Five copies at once (a flaky network): still once.
  const ref2 = randomUUID();
  const burst = await Promise.all(Array.from({ length: 5 }, () => adjust(v, p.id, { reason: 'damaged', quantity: 1, clientRef: ref2 })));
  assert.equal(burst.filter(b => b.status === 201).length, 1);
  assert.equal(burst.filter(b => b.status === 200).length, 4);
  assert.equal(new Set(burst.map(b => b.body.movement.id)).size, 1);
  assert.equal((await row(p.id)).stock, 6);
  // The same key for a different product is a client bug, not a replay.
  const q = await listed(v, { stock: 1 });
  assert.deepEqual((await adjust(v, q.id, { reason: 'restock', quantity: 1, clientRef })).body, { error: 'client_ref_reused' });
});

test('concurrent adjustment and checkouts never oversell, and the ledger matches the stock', async () => {
  ledgerOn();
  const v = await vendor();
  const p = await listed(v, { stock: 5 });
  const buyers = await Promise.all(Array.from({ length: 5 }, () => user('member')));
  const [adj, ...orders] = await Promise.all([
    adjust(v, p.id, { reason: 'damaged', quantity: 3 }),
    ...buyers.map(b => place(b, [{ productId: p.id, qty: 1 }])),
  ]);
  const sold = orders.filter(o => o.status === 201).length;
  const removed = adj.status === 201 ? 3 : 0;
  assert.ok(sold + removed <= 5, `sold ${sold} + removed ${removed}`);
  if (adj.status !== 201) assert.equal(adj.body.error, 'insufficient_stock');
  for (const o of orders.filter(x => x.status !== 201)) assert.equal(o.body.error, 'insufficient_stock');
  const stock = (await row(p.id)).stock;
  assert.equal(stock, 5 - sold - removed);
  assert.ok(stock >= 0);
  assert.equal(sumOf(await ledgerOf(p.id)), stock, 'initial count + reserves + adjustment = stock');
});

test('permissions and tenancy: staff need `products`; another vendor gets 403 not_your_product', async () => {
  ledgerOn();
  const v = await vendor();
  const p = await listed(v, { stock: 2 });
  const staff = await user('vendor_staff', { vendorId: v, vendorRole: 'orders_manager', vendorPermissions: ['orders'], accountStatus: 'active' });
  const denied = await adjust(v, p.id, { reason: 'restock', quantity: 1 }, { sub: staff, userType: 'vendor_staff', vendorId: v });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, 'vendor_permission_forbidden');
  const stocker = await user('vendor_staff', { vendorId: v, vendorRole: 'inventory_manager', vendorPermissions: ['products'], accountStatus: 'active', displayName: 'Asha (stock)' });
  const ok = await adjust(v, p.id, { reason: 'restock', quantity: 1 }, { sub: stocker, userType: 'vendor_staff', vendorId: v });
  assert.equal(ok.status, 201);
  assert.deepEqual(ok.body.movement.actor, { id: stocker, name: 'Asha (stock)' });
  const other = await vendor();
  assert.equal((await adjust(other, p.id, { reason: 'restock', quantity: 1 })).body.error, 'not_your_product');
  assert.equal((await call(vendorStockMovements, as(other), { params: { id: p.id } })).body.error, 'not_your_product');
  assert.equal((await call(vendorLowStock, as(other))).body.some(x => x.productId === p.id), false);
});

// ── history ──────────────────────────────────────────────────────────────────

test('GET stock-movements: newest first, opening/closing stock, pages, EAT date range, order rows link their order', async () => {
  ledgerOn();
  const v = await vendor();
  const p = await listed(v, { stock: 10 });
  await adjust(v, p.id, { reason: 'restock', quantity: 5 });
  await adjust(v, p.id, { reason: 'damaged', quantity: 2 });
  const buyer = await user('member');
  const order = await place(buyer, [{ productId: p.id, qty: 1 }]);
  assert.equal(order.status, 201);
  const all = await call(vendorStockMovements, as(v), { params: { id: p.id } });
  assert.equal(all.status, 200);
  assert.equal(all.body.closingStock, 12);
  assert.equal(all.body.openingStock, 0);
  assert.deepEqual(all.body.rows.map(r => r.reason), ['reserve', 'damaged', 'restock', 'count']);
  assert.deepEqual(all.body.rows[0].document, { type: 'order', id: order.body.id, number: null });
  assert.deepEqual([all.body.rows[0].stockBefore, all.body.rows[0].stockAfter, all.body.rows[0].actor], [13, 12, null]);
  assert.equal(all.body.nextCursor, null);

  const page1 = await call(vendorStockMovements, as(v), { params: { id: p.id }, query: { limit: '3' } });
  assert.equal(page1.body.rows.length, 3);
  assert.ok(page1.body.nextCursor);
  const page2 = await call(vendorStockMovements, as(v), { params: { id: p.id }, query: { limit: '3', cursor: page1.body.nextCursor } });
  assert.deepEqual(page2.body.rows.map(r => r.reason), ['count']);
  assert.equal(page2.body.nextCursor, null);

  const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 27 * 3600_000).toISOString().slice(0, 10);
  const inToday = await call(vendorStockMovements, as(v), { params: { id: p.id }, query: { from: today, to: today } });
  assert.equal(inToday.body.rows.length, 4);
  const future = await call(vendorStockMovements, as(v), { params: { id: p.id }, query: { from: tomorrow, to: tomorrow } });
  assert.deepEqual([future.body.rows.length, future.body.openingStock, future.body.closingStock], [0, 12, 12]);
  assert.equal((await call(vendorStockMovements, as(v), { params: { id: p.id }, query: { from: '2026-13-01' } })).body.error, 'invalid_date');
  assert.equal((await call(vendorStockMovements, as(v), { params: { id: p.id }, query: { cursor: 'nonsense' } })).body.error, 'invalid_cursor');
  assert.equal((await call(vendorStockMovements, as(v), { params: { id: p.id }, query: { limit: '500' } })).body.error, 'invalid_limit');
});

// ── variants (O-1, Q-1, Q-2, Q-6, F3) ───────────────────────────────────────

test('variants: product stock is the sum of variant stocks; adjust a variant; merge by name; remove only when empty; no mixing', async () => {
  ledgerOn();
  const v = await vendor();
  const mixed = await call(vendorCreateProduct, as(v), { body: { name: 'Tee', priceTzs: 15_000, variants: [{ name: 'S', stock: 1 }, { name: 'M' }] } });
  assert.deepEqual([mixed.status, mixed.body.error], [400, 'variant_stock_mixed']);
  const dup = await call(vendorCreateProduct, as(v), { body: { name: 'Tee', priceTzs: 15_000, variants: [{ name: 'S', stock: 1 }, { name: 's', stock: 1 }] } });
  assert.deepEqual([dup.status, dup.body.error], [400, 'duplicate_variant']);

  const p = await listed(v, {
    name: 'Tee', priceTzs: 15_000, stock: 99, costTzs: 9_000, reorderLevel: 2,
    variants: [{ name: 'S', stock: 2, costTzs: 10_000 }, { name: 'M', stock: 3, reorderLevel: 1 }],
  });
  assert.equal(p.stock, 5, 'the sum of the variants, not the 99 sent');
  assert.deepEqual(p.variants, [
    { name: 'S', stock: 2, costTzs: 10_000, reorderLevel: null, effectiveCostTzs: 10_000, effectiveReorderLevel: 2 },
    { name: 'M', stock: 3, costTzs: null, reorderLevel: 1, effectiveCostTzs: 9_000, effectiveReorderLevel: 1 },
  ]);
  assert.deepEqual([p.costTzs, p.reorderLevel], [9_000, 2]);
  assert.deepEqual((await row(p.id)).variants, [{ name: 'S', stock: 2 }, { name: 'M', stock: 3 }], 'private fields never on the Product row');

  assert.equal((await adjust(v, p.id, { reason: 'restock', quantity: 1 })).body.error, 'variant_required');
  const s = await adjust(v, p.id, { reason: 'restock', quantity: 4, variant: 'S' });
  assert.deepEqual(s.body.product, { id: p.id, stock: 9, variants: [{ name: 'S', stock: 6 }, { name: 'M', stock: 3 }] });
  assert.deepEqual([s.body.movement.stockBefore, s.body.movement.stockAfter, s.body.movement.variant], [2, 6, 'S']);

  // The old app sends names only: stored counts stay; a new variant starts at 0.
  const oldApp = await call(vendorUpdateProduct, as(v), { params: { id: p.id }, body: { name: 'Tee', stock: 5, variants: [{ name: 'S' }, { name: 'M' }, { name: 'L' }] } });
  assert.equal(oldApp.status, 200, JSON.stringify(oldApp.body));
  assert.deepEqual((await row(p.id)).variants, [{ name: 'S', stock: 6 }, { name: 'M', stock: 3 }, { name: 'L', stock: 0 }]);
  assert.equal((await row(p.id)).stock, 9, 'the stale product stock in the body is ignored when variants keep stock');

  const drop = await call(vendorUpdateProduct, as(v), { params: { id: p.id }, body: { variants: [{ name: 'S' }, { name: 'L' }] } });
  assert.deepEqual([drop.status, drop.body], [409, { error: 'variant_has_stock', variant: 'M', stock: 3 }]);
  await adjust(v, p.id, { reason: 'count', variant: 'M', quantity: 0, expectedStock: 3 });
  const dropped = await call(vendorUpdateProduct, as(v), { params: { id: p.id }, body: { variants: [{ name: 'S' }, { name: 'L' }] } });
  assert.equal(dropped.status, 200);
  assert.deepEqual((await row(p.id)).variants, [{ name: 'S', stock: 6 }, { name: 'L', stock: 0 }]);
  assert.equal((await row(p.id)).stock, 6);
  assert.equal(await db('ProductPrivate').where({ productId: p.id, variant: 'M' }).first(), undefined);

  const sOnly = await call(vendorStockMovements, as(v), { params: { id: p.id }, query: { variant: 'S' } });
  assert.deepEqual([sOnly.body.openingStock, sOnly.body.closingStock], [0, 6]);
  assert.ok(sOnly.body.rows.every(r => r.variant === 'S'));
  assert.equal((await call(vendorStockMovements, as(v), { params: { id: p.id }, query: { variant: 'M' } })).body.error, 'variant_not_found');
  assert.equal(sumOf(await ledgerOf(p.id)), 6, 'the ledger adds up to the product stock');

  // Q-1: L has no level of its own and inherits the product's (2): stock 0 is low.
  const low = (await call(vendorLowStock, as(v))).body.filter(x => x.productId === p.id);
  assert.deepEqual(low, [{ productId: p.id, name: 'Tee', variant: 'L', stock: 0, reorderLevel: 2 }]);
});

test('F3 (unflagged): a variant sent without stock keeps its stored stock; cost never reaches the Product row', async () => {
  ledgerOff();
  const v = await vendor();
  const p = await listed(v, { variants: [{ name: 'Vanilla', stock: 4 }, { name: 'Choc', stock: 2 }] });
  const saved = await call(vendorUpdateProduct, as(v), { params: { id: p.id }, body: { variants: [{ name: 'Vanilla', costTzs: 5 }, { name: 'Choc' }] } });
  assert.equal(saved.status, 200);
  assert.deepEqual((await row(p.id)).variants, [{ name: 'Vanilla', stock: 4 }, { name: 'Choc', stock: 2 }]);
  // Flag off, the product's own stock is still written as sent, with no ledger row.
  await call(vendorUpdateProduct, as(v), { params: { id: p.id }, body: { stock: 3 } });
  assert.equal((await row(p.id)).stock, 3);
  assert.equal((await ledgerOf(p.id)).length, 0);
});

// ── PUT /vendor/products/:id ─────────────────────────────────────────────────

for (const mode of ['off', 'on']) {
  test(`F1 (ledger ${mode}): an approved product goes back to review only when a reviewed value actually changes`, async () => {
    if (mode === 'on') ledgerOn();
    const v = await vendor();
    const p = await listed(v, { description: 'Tasty', brand: 'FF', images: ['a.webp'], variants: [{ name: 'Vanilla' }] });
    const formAsSent = { name: 'Whey', description: 'Tasty', category: 'supplements_nutrition', brand: 'FF', priceTzs: 20_000, discountPriceTzs: null, images: ['a.webp'], variants: [{ name: 'Vanilla' }] };
    const status = async () => (await row(p.id)).approvalStatus;
    assert.equal((await call(vendorUpdateProduct, as(v), { params: { id: p.id }, body: formAsSent })).status, 200);
    assert.equal(await status(), 'approved', 'saving the form unchanged keeps it listed');
    await call(vendorUpdateProduct, as(v), { params: { id: p.id }, body: { ...formAsSent, stock: 4, status: 'active', sku: 'W-1' } });
    assert.equal(await status(), 'approved', 'stock, status and SKU are not reviewed');
    if (mode === 'on') {
      await call(vendorUpdateProduct, as(v), { params: { id: p.id }, body: { ...formAsSent, costTzs: 12_000, reorderLevel: 3, variants: [{ name: 'Vanilla', costTzs: 11_000 }] } });
      assert.equal(await status(), 'approved', 'cost price and reorder level are private, not reviewed');
    }
    assert.equal((await call(listShopProducts, { sub: uid('usr'), userType: 'member' }, { query: { vendorId: v } })).body.some(x => x.id === p.id), true);
    await call(vendorUpdateProduct, as(v), { params: { id: p.id }, body: { ...formAsSent, name: 'Whey  ' } });
    assert.equal(await status(), 'approved', 'surrounding spaces are not a change');
    await call(vendorUpdateProduct, as(v), { params: { id: p.id }, body: { ...formAsSent, priceTzs: 21_000 } });
    assert.equal(await status(), 'pending', 'a new price is reviewed');
  });
}

test('an old app build PUTting `stock` with the ledger on records a count adjustment (note product_form)', async () => {
  ledgerOn();
  const v = await vendor();
  const p = await listed(v, { stock: 10 });
  const out = await call(vendorUpdateProduct, as(v), { params: { id: p.id }, body: { name: 'Whey', priceTzs: 20_000, stock: 7, variants: [] } });
  assert.equal(out.status, 200);
  assert.equal(out.body.stock, 7);
  assert.equal(out.body.approvalStatus, 'approved');
  const last = (await ledgerOf(p.id)).at(-1);
  assert.deepEqual([last.reason, last.delta, last.stockAfter, last.note, last.actorId, last.kind], ['count', -3, 7, 'product_form', v, 'adjustment']);
  // Unchanged stock: no row.
  await call(vendorUpdateProduct, as(v), { params: { id: p.id }, body: { stock: 7 } });
  assert.equal((await ledgerOf(p.id)).length, 2);
  // Cost and reorder level come back on GET /vendor/products, for the vendor only.
  await call(vendorUpdateProduct, as(v), { params: { id: p.id }, body: { costTzs: 14_000, reorderLevel: 2 } });
  const mine = (await call(vendorMyProducts, as(v))).body.find(x => x.id === p.id);
  assert.deepEqual([mine.costTzs, mine.reorderLevel], [14_000, 2]);
  const bad = await call(vendorUpdateProduct, as(v), { params: { id: p.id }, body: { costTzs: -1 } });
  assert.deepEqual([bad.status, bad.body.error, bad.body.field], [400, 'invalid_field', 'costTzs']);
});

// ── privacy ──────────────────────────────────────────────────────────────────

test('cost price and reorder level never appear in /shop/products, /shop/products/:id, /shop/vendors/:id or /shop/home', async () => {
  ledgerOn();
  process.env.SHOP_HOME_V2 = '1';
  resetShopHomeLimits();
  const v = await vendor();
  const p = await listed(v, { name: 'Private cost whey', stock: 50, costTzs: 7_777, reorderLevel: 5, variants: [{ name: 'Big', stock: 50, costTzs: 8_888, reorderLevel: 4 }] });
  for (let i = 0; i < 4; i += 1) await listed(v, { name: `Cost item ${i}`, stock: 20, costTzs: 1_000 + i, reorderLevel: 1 });
  const member = { sub: await user('member'), userType: 'member' };
  const leaks = body => ['costTzs', 'reorderLevel', 'effectiveCostTzs', 'effectiveReorderLevel', 'lowStockAlertedAt', '7777', '8888'].filter(k => JSON.stringify(body).includes(k));
  const list = await call(listShopProducts, member, { query: { vendorId: v } });
  assert.equal(list.body.some(x => x.id === p.id), true, 'the product is listed (not a vacuous check)');
  assert.deepEqual(leaks(list.body), []);
  const detail = await call(getShopProduct, member, { params: { id: p.id } });
  assert.equal(detail.status, 200);
  assert.deepEqual(leaks(detail.body), []);
  const store = await call(getVendorStore, member, { params: { id: v } });
  assert.equal(store.status, 200, JSON.stringify(store.body));
  assert.equal(store.body.products.some(x => x.id === p.id), true);
  assert.deepEqual(leaks(store.body), []);
  const home = await call(shopHome, member);
  assert.equal(home.status, 200, JSON.stringify(home.body));
  assert.deepEqual(leaks(home.body), []);
  // The vendor does see them.
  assert.deepEqual(leaks((await call(vendorMyProducts, as(v))).body).sort(), ['7777', '8888', 'costTzs', 'effectiveCostTzs', 'effectiveReorderLevel', 'reorderLevel'].sort());
});

// ── low stock ────────────────────────────────────────────────────────────────

test('low stock: vendor_low_stock fires once per crossing (adjustments and checkout), in English with Swahili, and only with the ledger on', async () => {
  ledgerOn();
  const v = await vendor();
  const p = await listed(v, { name: 'Creatine', stock: 5, reorderLevel: 3 });
  await adjust(v, p.id, { reason: 'damaged', quantity: 2 }); // 5 → 3: crosses
  assert.equal((await lowAlerts(v)).length, 1);
  await adjust(v, p.id, { reason: 'lost', quantity: 1 }); // 3 → 2: still low, no second alert
  assert.equal((await lowAlerts(v)).length, 1);
  assert.deepEqual((await call(vendorLowStock, as(v))).body, [{ productId: p.id, name: 'Creatine', variant: null, stock: 2, reorderLevel: 3 }]);
  await adjust(v, p.id, { reason: 'restock', quantity: 5 }); // 2 → 7: back above, re-armed
  assert.equal((await call(vendorLowStock, as(v))).body.length, 0);
  const buyer = await user('member');
  assert.equal((await place(buyer, [{ productId: p.id, qty: 4 }])).status, 201); // 7 → 3 at checkout: crosses again
  const alerts = await lowAlerts(v);
  assert.equal(alerts.length, 2);
  assert.deepEqual(alerts.at(-1).data, { productId: p.id, productName: 'Creatine', variant: null, stock: 3, reorderLevel: 3 });
  const inbox = await db('Notification').where({ userId: v, type: 'vendor_low_stock' }).orderBy('createdAt');
  assert.equal(inbox.length, 2);
  assert.equal(inbox[0].title, 'Low stock: Creatine');
  assert.equal(inbox[0].body, 'Only 3 left. Time to restock.');
  assert.equal(inbox[0].data.titleSw, 'Stock inakaribia kuisha: Creatine');
  assert.equal(inbox[0].data.bodySw, 'Zimebaki 3 tu. Ni wakati wa kuongeza Stock.');
  assert.equal(inbox[0].data.productId, p.id);

  // Q-3: with the ledger off, stock that crosses the level tells nobody.
  ledgerOn();
  await adjust(v, p.id, { reason: 'restock', quantity: 10 }); // 3 → 13, re-armed
  ledgerOff();
  assert.equal((await place(buyer, [{ productId: p.id, qty: 11 }])).status, 201); // 13 → 2
  assert.equal((await lowAlerts(v)).length, 2);
});

// ── cost snapshot and settlement ─────────────────────────────────────────────

test('a paid order snapshots line costs (variant, else product, else null); order, commission and VendorSettlement output are unchanged', async () => {
  ledgerOn();
  const v = await vendor();
  const tee = await listed(v, { name: 'Tee', priceTzs: 15_000, costTzs: 9_000, variants: [{ name: 'S', stock: 5, costTzs: 10_000 }, { name: 'M', stock: 5 }] });
  const plain = await listed(v, { name: 'Plain bar', priceTzs: 5_000, stock: 5 });
  const buyer = await user('member');
  const placed = await shopService.createOrder({ buyerId: buyer, body: cart([{ productId: tee.id, variant: 'S', qty: 1 }, { productId: tee.id, variant: 'M', qty: 2 }, { productId: plain.id, qty: 1 }]) });
  assert.equal(placed.status, 202, JSON.stringify(placed));
  made.orders.push(placed.order.id);
  const itemsBefore = (await db('ShopOrder').where({ id: placed.order.id }).first()).items;
  const paid = await adminPaymentService.decide({ id: placed.paymentRequest.id, decision: 'approve', reference: `MP-${randomUUID().slice(0, 8)}`, amountTzs: placed.order.totalTzs, actorId: uid('adm') });
  assert.equal(paid.paymentRequest.status, 'approved');
  const costs = await db('ShopOrderLineCost').where({ orderId: placed.order.id }).orderBy(['productId', 'variant']);
  const byKey = Object.fromEntries(costs.map(c => [`${c.productId === tee.id ? 'tee' : 'plain'}:${c.variant}`, [c.qty, c.unitCostTzs, c.vendorId]]));
  assert.deepEqual(byKey, { 'tee:S': [1, 10_000, v], 'tee:M': [2, 9_000, v], 'plain:': [1, null, v] });
  // Bookkeeping only: the order is exactly as before.
  const after1 = await db('ShopOrder').where({ id: placed.order.id }).first();
  assert.deepEqual(after1.items, itemsBefore);
  assert.equal(JSON.stringify(after1).includes('Cost'), false);

  for (const status of ['accepted', 'dispatched', 'delivered']) {
    assert.equal((await shopService.updateOrderStatus({ orderId: placed.order.id, status, actorId: v })).order.status, status);
  }
  const clock = new Date(Date.now() + 7 * 86_400_000);
  const settlements = createVendorSettlementService({ users, payoutEligibility: createPayoutEligibility({ users, gyms, partnerGate, partnerSettlementAccounts, trainers }), now: () => clock });
  const statementOf = async () => {
    const lines = await db('VendorSettlementLine').where({ orderId: placed.order.id, voided: false });
    assert.equal(lines.length, 1);
    const s = await db('VendorSettlement').where({ id: lines[0].vendorSettlementId }).first();
    const pick = ({ vendorId, orderId, itemCount, salesTzs, commissionTzs, payoutTzs, deliveredOn }) => ({ vendorId, orderId, itemCount, salesTzs, commissionTzs, payoutTzs, deliveredOn });
    return { totals: [s.vendorId, s.orderCount, s.salesTzs, s.commissionTzs, s.finalNetTzs], line: pick(lines[0]) };
  };
  assert.equal((await settlements.prepare({ actorId: 'adm_stock' })).error, undefined);
  const before = await statementOf();
  assert.deepEqual(before.totals, [v, 1, 50_000, 5_000, 45_000], 'sales and 10% commission from the order lines');
  const share = vendorShareOfOrder({ ...after1, items: after1.items }, v);
  assert.deepEqual([share.salesTzs, share.commissionTzs, share.payoutTzs], [50_000, 5_000, 45_000]);

  // Costs change after the sale; the statement, rebuilt, is the same.
  await call(vendorUpdateProduct, as(v), { params: { id: tee.id }, body: { costTzs: 14_000, variants: [{ name: 'S', costTzs: 14_500 }, { name: 'M', costTzs: 13_000 }] } });
  await call(vendorUpdateProduct, as(v), { params: { id: plain.id }, body: { costTzs: 4_000 } });
  assert.equal((await settlements.prepare({ actorId: 'adm_stock' })).error, undefined);
  assert.deepEqual(await statementOf(), before);
  // And the snapshot keeps the cost at the time of payment.
  assert.equal((await db('ShopOrderLineCost').where({ orderId: placed.order.id, productId: plain.id }).first()).unitCostTzs, null);
});

// ── schema ───────────────────────────────────────────────────────────────────

test('schema: reason and kind are checked, adjustments need no order, an order line is released once, D-5 is validated', async () => {
  const v = await vendor();
  const p = await listed(v, { stock: 2 });
  const base = { productId: p.id, variant: '', cycle: 1, delta: 1, vendorId: v, createdAt: new Date() };
  await assert.rejects(db('ShopStockMovement').insert({ ...base, id: uid('stk'), reason: 'bogus' }), /shopstockmovement_reason_check/);
  await assert.rejects(db('ShopStockMovement').insert({ ...base, id: uid('stk'), reason: 'count', kind: 'gift' }), /shopstockmovement_kind_check/);
  await assert.rejects(db('ShopStockMovement').insert({ ...base, id: uid('stk'), reason: 'other', note: 'x'.repeat(201) }), /shopstockmovement_note_length/);
  await db('ShopStockMovement').insert({ ...base, id: uid('stk'), reason: 'found', kind: 'adjustment' });
  const orderId = uid('ord');
  await db('ShopStockMovement').insert({ ...base, id: uid('stk'), orderId, reason: 'release' });
  await assert.rejects(db('ShopStockMovement').insert({ ...base, id: uid('stk'), orderId, reason: 'release' }), /shopstockmovement_order_line_unique/);
  await db('ShopStockMovement').insert({ ...base, id: uid('stk'), reason: 'restock', kind: 'adjustment', clientRef: 'ref-unique-1' });
  await assert.rejects(db('ShopStockMovement').insert({ ...base, id: uid('stk'), reason: 'restock', kind: 'adjustment', clientRef: 'ref-unique-1' }), /shopstockmovement_vendor_client_ref_unique/);
  const d5 = (await db.raw(`SELECT convalidated FROM pg_constraint WHERE conname = 'product_stock_non_negative'`)).rows[0];
  assert.equal(d5.convalidated, true);
});
