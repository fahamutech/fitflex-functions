// Vendor business tools · S1 — stock history with reasons, per-variant stock, cost price, low stock.
// Against the CI database: the guarantees (no oversell, one ledger row per change, a retried
// adjustment applied once) are the database's, so they are tested against the database.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { ensureInit } from '../functions/index.mjs';
import { users, gyms, partnerGate, trainers, shopService, adminPaymentService, partnerNotifier } from '../src/bootstrap/services.mjs';
import { partnerSettlementAccounts } from '../src/bootstrap/collections.mjs';
import { createPayoutEligibility } from '../src/services/payout-eligibility.mjs';
import { createVendorSettlementService } from '../src/services/vendor-settlement-service.mjs';
import { vendorShareOfOrder } from '../src/shared/marketplace-pricing.mjs';
import { createPgVendorStockStore } from '../src/infra/vendor-stock-store-pg.mjs';
import {
  vendorToolsOptionsRoute, vendorStockAdjustment, vendorStockMovements, vendorLowStock, vendorMyProducts,
  vendorCreateProduct, vendorUpdateProduct, listShopProducts, getShopProduct, getVendorStore, createShopOrder,
  adminListProducts, adminCreateProduct, adminUpdateProductListing,
} from '../functions/shop.mjs';
import { shopHome, resetShopHomeLimits } from '../functions/shop-home.mjs';
import { findLeaks } from './fixtures/leak-scan.mjs';

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
  await db('CommunicationPreference').whereIn('id', made.users).del();
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
    canSeeCost: true, stockLedger: false, portal: false, buyerContact: false, walkInSales: false, customers: false, documents: false,
    vat: false, reports: false, refunds: false, barcodes: false, purchases: false, fiscal: 'off', merch: { banners: false },
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
  // The same key for a different request is a client bug, not a replay: product, reason, quantity, direction.
  const q = await listed(v, { stock: 1 });
  assert.deepEqual((await adjust(v, q.id, { reason: 'restock', quantity: 3, clientRef })).body, { error: 'client_ref_reused' });
  assert.deepEqual((await adjust(v, p.id, { reason: 'restock', quantity: 2, clientRef })).body, { error: 'client_ref_reused' });
  assert.deepEqual((await adjust(v, p.id, { reason: 'found', quantity: 3, clientRef })).body, { error: 'client_ref_reused' });
  const ref3 = randomUUID();
  await adjust(v, p.id, { reason: 'other', direction: 'in', quantity: 1, note: 'gift', clientRef: ref3 });
  assert.deepEqual((await adjust(v, p.id, { reason: 'other', direction: 'out', quantity: 1, note: 'gift', clientRef: ref3 })).body, { error: 'client_ref_reused' });
  assert.equal((await adjust(v, p.id, { reason: 'other', direction: 'in', quantity: 1, note: 'gift', clientRef: ref3 })).status, 200);
  assert.equal((await row(p.id)).stock, 7);
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
  assert.deepEqual(all.body.rows[0].document, { type: 'order', id: order.body.id, number: null, shortRef: order.body.id.slice(-6).toUpperCase() });
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

test('H1: with the ledger on a product whose variants keep stock is sold by variant, and a form save never resets its stock', async () => {
  ledgerOn();
  const v = await vendor();
  const p = await listed(v, { name: 'Tee', priceTzs: 15_000, variants: [{ name: 'S', stock: 2 }, { name: 'M', stock: 3 }] });
  const buyer = await user('member');
  // An order taken while the ledger was off (SHOP_REQUIRE_VARIANT off): one unit from the product alone.
  ledgerOff();
  const legacy = await place(buyer, [{ productId: p.id, qty: 1 }]);
  assert.equal(legacy.status, 201);
  assert.equal((await row(p.id)).stock, 4);
  ledgerOn();
  const refused = await place(buyer, [{ productId: p.id, qty: 1 }]);
  assert.deepEqual([refused.status, refused.body.error, refused.body.variants], [400, 'variant_required', ['S', 'M']]);
  // The form (old app shape, with its stale product stock) does not undo the reservation.
  const saved = await call(vendorUpdateProduct, as(v), { params: { id: p.id }, body: { name: 'Tee', stock: 5, variants: [{ name: 'S' }, { name: 'M' }] } });
  assert.equal(saved.status, 200);
  assert.equal((await row(p.id)).stock, 4, 'unchanged: no variant count moved');
  const cancelled = await shopService.buyerCancelOrder({ buyerId: buyer, orderId: legacy.body.id });
  assert.equal(cancelled.order.status, 'cancelled');
  const after = await row(p.id);
  assert.equal(after.stock, 5);
  assert.equal(after.stock, after.variants.reduce((sum, x) => sum + x.stock, 0), 'stock is the sum of the variants');
  assert.equal(sumOf(await ledgerOf(p.id)), after.stock, 'the ledger adds up to the stock');
  // A variant count changed by the form moves the product by the same amount, recorded.
  await call(vendorUpdateProduct, as(v), { params: { id: p.id }, body: { variants: [{ name: 'S', stock: 4 }, { name: 'M' }] } });
  assert.equal((await row(p.id)).stock, 7);
  assert.equal(sumOf(await ledgerOf(p.id)), 7);
});

test('M2: stockSeen on PUT — a count that moved since the form opened is refused with the current stock', async () => {
  ledgerOn();
  const v = await vendor();
  const p = await listed(v, { stock: 10 });
  const stale = await call(vendorUpdateProduct, as(v), { params: { id: p.id }, body: { stock: 8, stockSeen: 9 } });
  assert.deepEqual([stale.status, stale.body], [409, { error: 'stock_changed', currentStock: 10 }]);
  assert.equal((await row(p.id)).stock, 10);
  assert.equal((await call(vendorUpdateProduct, as(v), { params: { id: p.id }, body: { stock: 8, stockSeen: 10 } })).body.stock, 8);
  const t = await listed(v, { name: 'Tee', variants: [{ name: 'S', stock: 2 }, { name: 'M', stock: 3 }] });
  const staleVariant = await call(vendorUpdateProduct, as(v), { params: { id: t.id }, body: { variants: [{ name: 'S', stock: 5, stockSeen: 1 }, { name: 'M', stockSeen: 3 }] } });
  assert.deepEqual([staleVariant.status, staleVariant.body], [409, { error: 'stock_changed', variant: 'S', currentStock: 2 }]);
  const ok = await call(vendorUpdateProduct, as(v), { params: { id: t.id }, body: { variants: [{ name: 'S', stock: 5, stockSeen: 2 }, { name: 'M', stockSeen: 3 }] } });
  assert.equal(ok.status, 200);
  assert.deepEqual((await row(t.id)).variants, [{ name: 'S', stock: 5 }, { name: 'M', stock: 3 }], 'stockSeen is never stored');
  const bad = await call(vendorUpdateProduct, as(v), { params: { id: t.id }, body: { stockSeen: -1 } });
  assert.deepEqual([bad.status, bad.body.field], [400, 'stockSeen']);
});

test('M2 with the ledger OFF: stockSeen is honoured too (the new app sends stock + stockSeen on edit)', async () => {
  ledgerOff();
  const v = await vendor();
  const p = await listed(v, { stock: 10, variants: [{ name: 'S', stock: 4 }] });
  const stale = await call(vendorUpdateProduct, as(v), { params: { id: p.id }, body: { stock: 8, stockSeen: 9 } });
  assert.deepEqual([stale.status, stale.body], [409, { error: 'stock_changed', currentStock: 10 }]);
  const staleVariant = await call(vendorUpdateProduct, as(v), { params: { id: p.id }, body: { variants: [{ name: 'S', stockSeen: 3 }] } });
  assert.deepEqual([staleVariant.status, staleVariant.body], [409, { error: 'stock_changed', variant: 'S', currentStock: 4 }]);
  assert.equal((await row(p.id)).stock, 10, 'nothing written');
  const ok = await call(vendorUpdateProduct, as(v), { params: { id: p.id }, body: { stock: 8, stockSeen: 10, variants: [{ name: 'S', stockSeen: 4 }] } });
  assert.equal(ok.status, 200);
  assert.equal((await row(p.id)).stock, 8);
  assert.deepEqual((await row(p.id)).variants, [{ name: 'S', stock: 4 }], 'stockSeen is never stored');
  assert.equal((await ledgerOf(p.id)).length, 0, 'flag off: no ledger rows');
});

test('L4: a variant that an open order still holds units of cannot be removed', async () => {
  ledgerOn();
  const v = await vendor();
  const p = await listed(v, { name: 'Tee', variants: [{ name: 'S', stock: 1 }, { name: 'M', stock: 0 }] });
  const buyer = await user('member');
  const order = await place(buyer, [{ productId: p.id, variant: 'S', qty: 1 }]);
  assert.equal(order.status, 201);
  const held = await call(vendorUpdateProduct, as(v), { params: { id: p.id }, body: { variants: [{ name: 'M' }] } });
  assert.deepEqual([held.status, held.body], [409, { error: 'variant_has_reservations', variant: 'S' }]);
  await shopService.buyerCancelOrder({ buyerId: buyer, orderId: order.body.id });
  assert.deepEqual((await row(p.id)).variants, [{ name: 'S', stock: 1 }, { name: 'M', stock: 0 }], 'the units came back to S');
  assert.equal((await call(vendorUpdateProduct, as(v), { params: { id: p.id }, body: { variants: [{ name: 'M' }] } })).body.error, 'variant_has_stock');
});

test('L2: a product an admin creates records the admin as the actor of its opening stock', async () => {
  ledgerOn();
  const v = await vendor();
  const admin = uid('adm');
  const out = await shopService.adminCreateProduct({ actorId: admin, body: { vendorId: v, name: 'Mat', priceTzs: 30_000, stock: 4 } });
  made.products.push(out.product.id);
  const [first] = await ledgerOf(out.product.id);
  assert.deepEqual([first.reason, first.delta, first.actorId, first.note], ['count', 4, admin, 'product_created']);
});

test('cost price: only the vendor account and admin staff see or set it; other staff with `products` see reorder level only', async () => {
  ledgerOn();
  const v = await vendor();
  const p = await listed(v, { name: 'Tee', costTzs: 9_000, reorderLevel: 2, variants: [{ name: 'S', stock: 2, costTzs: 10_000, reorderLevel: 1 }] });
  const staff = async (vendorRole, permissions) => {
    const id = await user('vendor_staff', { vendorId: v, vendorRole, vendorPermissions: permissions, accountStatus: 'active' });
    return { sub: id, userType: 'vendor_staff', vendorId: v };
  };
  const owner = as(v);
  const adminStaff = await staff('admin', ['products', 'orders', 'customers', 'reports', 'payments', 'staff']);
  const stocker = await staff('inventory_manager', ['products']);
  const mineAs = async claims => (await call(vendorMyProducts, claims)).body.find(x => x.id === p.id);

  for (const claims of [owner, adminStaff]) {
    assert.equal((await call(vendorToolsOptionsRoute, claims)).body.canSeeCost, true);
    const seen = await mineAs(claims);
    assert.deepEqual([seen.costTzs, seen.variants[0].costTzs, seen.variants[0].effectiveCostTzs], [9_000, 10_000, 10_000]);
  }
  const ok = await call(vendorUpdateProduct, adminStaff, { params: { id: p.id }, body: { costTzs: 9_500 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.costTzs, 9_500);

  assert.equal((await call(vendorToolsOptionsRoute, stocker)).body.canSeeCost, false);
  const limited = await mineAs(stocker);
  assert.equal('costTzs' in limited, false);
  assert.equal('costTzs' in limited.variants[0] || 'effectiveCostTzs' in limited.variants[0], false);
  assert.deepEqual([limited.reorderLevel, limited.variants[0].reorderLevel, limited.variants[0].effectiveReorderLevel], [2, 1, 1]);
  assert.equal(JSON.stringify(limited).includes('Cost'), false);
  const refused = await call(vendorUpdateProduct, stocker, { params: { id: p.id }, body: { costTzs: 1 } });
  assert.deepEqual([refused.status, refused.body], [403, { error: 'cost_forbidden' }]);
  const refusedVariant = await call(vendorUpdateProduct, stocker, { params: { id: p.id }, body: { variants: [{ name: 'S', costTzs: 1 }] } });
  assert.deepEqual([refusedVariant.status, refusedVariant.body.error], [403, 'cost_forbidden']);
  const created = await call(vendorCreateProduct, stocker, { body: { name: 'Bar', priceTzs: 2_000, stock: 1, costTzs: 1_000 } });
  assert.deepEqual([created.status, created.body.error], [403, 'cost_forbidden']);
  // Leaving cost out keeps it: the stocker changes the reorder levels only.
  const saved = await call(vendorUpdateProduct, stocker, { params: { id: p.id }, body: { reorderLevel: 3, variants: [{ name: 'S', reorderLevel: 2 }] } });
  assert.equal(saved.status, 200);
  assert.equal('costTzs' in saved.body, false);
  const after = await mineAs(owner);
  assert.deepEqual([after.costTzs, after.variants[0].costTzs, after.reorderLevel, after.variants[0].reorderLevel], [9_500, 10_000, 3, 2]);
  // Stock history carries no cost for anyone.
  const history = await call(vendorStockMovements, stocker, { params: { id: p.id } });
  assert.equal(history.status, 200);
  assert.equal(JSON.stringify(history.body).toLowerCase().includes('cost'), false);
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
  // Key names anywhere in the JSON; the seeded costs as whole values only (a
  // substring search for '7777' trips on random ids and other rows' prices).
  const leaks = body => [
    ...['costTzs', 'reorderLevel', 'effectiveCostTzs', 'effectiveReorderLevel', 'lowStockAlertedAt'].filter(k => JSON.stringify(body).includes(k)),
    ...[7777, 8888].filter(n => findLeaks(body, { numbers: [n] }).length).map(String),
  ];
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

test('low stock: vendor_low_stock fires once per crossing (adjustments and checkout), Swahili by default with English on request, and only with the ledger on', async () => {
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
  // No saved language preference: Swahili, as the SMS reminders (owner 2026-10-19; drafts, for native review).
  assert.equal(inbox[0].title, 'Stock inakaribia kuisha: Creatine');
  assert.equal(inbox[0].body, 'Zimebaki 3 tu. Ni wakati wa kuongeza Stock.');
  assert.equal(inbox[0].data.titleSw, 'Stock inakaribia kuisha: Creatine');
  assert.equal(inbox[0].data.bodySw, 'Zimebaki 3 tu. Ni wakati wa kuongeza Stock.');
  assert.equal(inbox[0].data.productId, p.id);

  // A vendor who chose English gets English; the Swahili text stays in data.
  await db('CommunicationPreference').insert({ id: v, locale: 'en' });
  await adjust(v, p.id, { reason: 'restock', quantity: 10 }); // 3 → 13, re-armed
  await adjust(v, p.id, { reason: 'lost', quantity: 11 }); // 13 → 2, crosses
  const en = (await db('Notification').where({ userId: v, type: 'vendor_low_stock' }).orderBy('createdAt')).at(-1);
  assert.deepEqual([en.title, en.body], ['Low stock: Creatine', 'Only 2 left. Time to restock.']);
  assert.equal(en.data.titleSw, 'Stock inakaribia kuisha: Creatine');

  // Q-3: with the ledger off, stock that crosses the level tells nobody.
  ledgerOn();
  await adjust(v, p.id, { reason: 'restock', quantity: 10 }); // 3 → 13, re-armed
  ledgerOff();
  assert.equal((await place(buyer, [{ productId: p.id, qty: 11 }])).status, 201); // 13 → 2
  assert.equal((await lowAlerts(v)).length, 3);
});

test('vendor_low_stock without a product name: English "A product", Swahili "Bidhaa"; variant in brackets; no preference → Swahili, sw → Swahili, en → English', async () => {
  const none = await vendor();
  await partnerNotifier.vendorEvent(none, 'vendor_low_stock', { productId: 'prd_none', stock: 1 });
  const row0 = await db('Notification').where({ userId: none, type: 'vendor_low_stock' }).first();
  assert.deepEqual([row0.title, row0.body, row0.data.titleSw], ['Stock inakaribia kuisha: Bidhaa', 'Zimebaki 1 tu. Ni wakati wa kuongeza Stock.', 'Stock inakaribia kuisha: Bidhaa']);
  const en = await vendor();
  await db('CommunicationPreference').insert({ id: en, locale: 'en' });
  await partnerNotifier.vendorEvent(en, 'vendor_low_stock', { productId: 'prd_none', stock: 1 });
  const row1 = await db('Notification').where({ userId: en, type: 'vendor_low_stock' }).first();
  assert.deepEqual([row1.title, row1.body, row1.data.titleSw], ['Low stock: A product', 'Only 1 left. Time to restock.', 'Stock inakaribia kuisha: Bidhaa']);
  const sw = await vendor();
  await db('CommunicationPreference').insert({ id: sw, locale: 'sw' });
  await partnerNotifier.vendorEvent(sw, 'vendor_low_stock', { productId: 'prd_none', variant: 'XL', stock: 0 });
  const row2 = await db('Notification').where({ userId: sw, type: 'vendor_low_stock' }).first();
  assert.deepEqual([row2.title, row2.body], ['Stock inakaribia kuisha: Bidhaa (XL)', 'Zimebaki 0 tu. Ni wakati wa kuongeza Stock.']);
  // A preference row with no language set is the same as none.
  const blank = await vendor();
  await db('CommunicationPreference').insert({ id: blank, locale: null });
  await partnerNotifier.vendorEvent(blank, 'vendor_low_stock', { productId: 'prd_none', stock: 2 });
  assert.equal((await db('Notification').where({ userId: blank, type: 'vendor_low_stock' }).first()).title, 'Stock inakaribia kuisha: Bidhaa');
});

// ── FitFlex admins (owner decision 2026-10-19: admins see everything) ───────────

const superAdmin = () => ({ sub: uid('adm'), userType: 'admin' }); // not a portal user: every scope
const shopAdmin = () => ({ sub: uid('adm'), userType: 'admin', portalUser: true, aclPermissions: ['shop'] });
const otherAdmin = () => ({ sub: uid('adm'), userType: 'admin', portalUser: true, aclPermissions: ['payments'] });

test('admins: canSeeCost is true for a super-admin and a shop-scoped admin, false without the shop scope', async () => {
  for (const claims of [superAdmin(), shopAdmin()]) {
    const out = await call(vendorToolsOptionsRoute, claims);
    assert.equal(out.status, 200);
    assert.equal(out.body.canSeeCost, true);
  }
  assert.equal((await call(vendorToolsOptionsRoute, otherAdmin())).body.canSeeCost, false);
  assert.equal(await shopService.canSeeCost(otherAdmin()), false);
  // Vendor staff rule unchanged: a staff member whose token says admin-like things is still read from the account.
  assert.equal(await shopService.canSeeCost({ sub: uid('usr'), userType: 'vendor_staff', vendorId: 'x', portalUser: false }), false);
});

test('GET /admin/products: private fields (cost included) with the ledger on, none with it off; scope `shop` required', async () => {
  ledgerOn();
  const v = await vendor();
  const p = await listed(v, { name: 'Admin view tee', costTzs: 9_000, reorderLevel: 2, variants: [{ name: 'S', stock: 3, costTzs: 10_000 }, { name: 'M', stock: 3, reorderLevel: 1 }] });
  const plainOne = await listed(v, { name: 'Admin view bar', stock: 4 });
  for (const claims of [superAdmin(), shopAdmin()]) {
    const out = await call(adminListProducts, claims);
    assert.equal(out.status, 200);
    const seen = out.body.find(x => x.id === p.id);
    assert.deepEqual([seen.costTzs, seen.reorderLevel], [9_000, 2]);
    assert.deepEqual(seen.variants, [
      { name: 'S', stock: 3, costTzs: 10_000, reorderLevel: null, effectiveCostTzs: 10_000, effectiveReorderLevel: 2 },
      { name: 'M', stock: 3, costTzs: null, reorderLevel: 1, effectiveCostTzs: 9_000, effectiveReorderLevel: 1 },
    ]);
    const bare = out.body.find(x => x.id === plainOne.id);
    assert.deepEqual([bare.costTzs, bare.reorderLevel], [null, null]);
  }
  assert.deepEqual((await call(adminListProducts, otherAdmin())).body, { error: 'acl_forbidden', requiredScope: 'shop' });
  ledgerOff();
  const off = (await call(adminListProducts, superAdmin())).body.find(x => x.id === p.id);
  assert.equal('costTzs' in off || 'reorderLevel' in off, false, 'flag off: the response is as before');
});

test('POST /admin/products: an admin may set cost and reorder level; the admin is the actor; the response carries them', async () => {
  ledgerOn();
  const v = await vendor();
  const admin = shopAdmin();
  const out = await call(adminCreateProduct, admin, { body: { vendorId: v, name: 'Admin made', category: 'supplements_nutrition', priceTzs: 12_000, stock: 6, costTzs: 7_000, reorderLevel: 2, variants: [{ name: 'Red', stock: 6, costTzs: 7_500 }] } });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  made.products.push(out.body.id);
  assert.deepEqual([out.body.costTzs, out.body.reorderLevel, out.body.variants[0].costTzs, out.body.variants[0].effectiveReorderLevel], [7_000, 2, 7_500, 2]);
  const opening = await ledgerOf(out.body.id);
  assert.equal(opening.length > 0, true);
  assert.equal(opening.every(r => r.actorId === admin.sub), true, 'opening stock rows name the admin');
  const audit = await db('AuditLog').where({ target: out.body.id, action: 'admin_product_created' }).first();
  assert.equal(audit.actor, admin.sub);
  assert.deepEqual(audit.after.privates, [{ variant: '', costTzs: 7_000, reorderLevel: 2 }, { variant: 'Red', costTzs: 7_500 }]);
  // The vendor sees what the admin set.
  const mine = (await call(vendorMyProducts, as(v))).body.find(x => x.id === out.body.id);
  assert.deepEqual([mine.costTzs, mine.variants[0].costTzs], [7_000, 7_500]);
});

test('PUT /admin/products/:id/listing: an admin sets cost / reorder level (audited, admin as actor); bad input refused before any write; public shop still clean', async () => {
  ledgerOn();
  const v = await vendor();
  const p = await listed(v, { name: 'Listing tee', stock: 5, costTzs: 1_000, variants: [{ name: 'S', stock: 5 }] });
  const admin = superAdmin();
  const listing = body => call(adminUpdateProductListing, admin, { params: { id: p.id }, body });
  const audits = async () => Number((await db('AuditLog').where({ target: p.id }).whereIn('action', ['product_listing_updated', 'admin_product_private_updated']).count('* as n').first()).n);
  const auditsBefore = await audits(); // listed() approved it: one listing row already

  const bad = await listing({ homepagePriority: 9, costTzs: -1 });
  assert.deepEqual([bad.status, bad.body], [400, { error: 'invalid_field', field: 'costTzs' }]);
  const unknown = await listing({ homepagePriority: 9, variants: [{ name: 'XXL', costTzs: 5 }] });
  assert.deepEqual([unknown.status, unknown.body], [404, { error: 'variant_not_found', variant: 'XXL', variants: ['S'] }]);
  const dup = await listing({ homepagePriority: 9, variants: [{ name: 'S', costTzs: 5 }, { name: ' s ', costTzs: 6 }] });
  assert.deepEqual([dup.status, dup.body], [400, { error: 'duplicate_variant', variant: 's' }]);
  assert.equal(await audits(), auditsBefore, 'no audit rows for refused requests');
  assert.equal(Number((await row(p.id)).homepagePriority || 0), 0, 'nothing written on a refused request');

  const ok = await listing({ costTzs: 4_321, variants: [{ name: 'S', costTzs: 4_400, reorderLevel: 1, stock: 999 }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.costTzs, ok.body.variants[0].costTzs, ok.body.variants[0].reorderLevel, ok.body.variants[0].stock], [4_321, 4_400, 1, 5]);
  assert.equal((await row(p.id)).stock, 5, 'stock is not set through the listing endpoint');
  const audit = await db('AuditLog').where({ target: p.id, action: 'admin_product_private_updated' }).first();
  assert.equal(audit.actor, admin.sub);
  assert.deepEqual(audit.before, [{ variant: '', costTzs: 1_000, reorderLevel: null }, { variant: 'S', costTzs: null, reorderLevel: null }]);
  assert.deepEqual(audit.after, [{ variant: '', costTzs: 4_321 }, { variant: 'S', costTzs: 4_400, reorderLevel: 1 }]);
  assert.equal((await lowAlerts(v)).length, 0, '5 > 1: not low');

  // Raising the reorder level to the stock sends one alert (kept from S1), however often it is saved.
  await listing({ variants: [{ name: 'S', reorderLevel: 5 }] });
  await listing({ variants: [{ name: 'S', reorderLevel: 6 }] });
  assert.equal((await lowAlerts(v)).length, 1);

  // null clears.
  const cleared = await listing({ costTzs: null });
  assert.deepEqual([cleared.body.costTzs, cleared.body.variants[0].effectiveCostTzs], [null, 4_400]);

  // Whatever an admin set, the public shop shows none of it.
  const member = { sub: await user('member'), userType: 'member' };
  const leaks = body => [
    ...['costTzs', 'reorderLevel', 'effectiveCostTzs', 'effectiveReorderLevel'].filter(k => JSON.stringify(body).includes(k)),
    ...[4400, 4321].filter(n => findLeaks(body, { numbers: [n] }).length).map(String),   // whole values, see above
  ];
  const list = await call(listShopProducts, member, { query: { vendorId: v } });
  assert.equal(list.body.some(x => x.id === p.id), true);
  assert.deepEqual(leaks(list.body), []);
  assert.deepEqual(leaks((await call(getShopProduct, member, { params: { id: p.id } })).body), []);
  assert.deepEqual(leaks((await call(getVendorStore, member, { params: { id: v } })).body), []);

  // Flag off: cost keys on the listing endpoint are ignored, as before S1.
  ledgerOff();
  const offOut = await listing({ costTzs: 1, homepagePriority: 2 });
  assert.equal(offOut.status, 200);
  assert.equal('costTzs' in offOut.body, false);
  ledgerOn();
  assert.equal((await call(adminListProducts, admin)).body.find(x => x.id === p.id).variants[0].effectiveCostTzs, 4_400);
});

test('admins on /vendor/* endpoints get cost rights (canSeeCost) like the vendor account', async () => {
  ledgerOn();
  const admin = { ...shopAdmin(), sub: await user('admin') };
  // An admin's own /vendor/products is scoped to their own id (no vendor selection exists); cost is not stripped.
  const created = await call(vendorCreateProduct, admin, { body: { name: 'Admin-owned', priceTzs: 1_000, stock: 1, costTzs: 500 } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  made.products.push(created.body.id);
  assert.equal(created.body.costTzs, 500);
  const mine = (await call(vendorMyProducts, admin)).body.find(x => x.id === created.body.id);
  assert.equal(mine.costTzs, 500);
  // An admin without the shop scope is stopped by the route's own guard (as bfast-function already did,
  // through the GET /vendor/products guard it applied to every /vendor/products request) ...
  const refused = await call(vendorCreateProduct, otherAdmin(), { body: { name: 'No scope', priceTzs: 1_000, stock: 1, costTzs: 500 } });
  assert.deepEqual([refused.status, refused.body.error], [403, 'acl_forbidden']);
  // ... and has no cost rights either, should the service be reached another way.
  const other = otherAdmin();
  assert.equal(await shopService.canSeeCost(other), false);
  const direct = await shopService.upsertProduct({ vendorId: other.sub, actorId: other.sub, body: { name: 'No scope', priceTzs: 1_000, stock: 1, costTzs: 500 }, costAllowed: false });
  assert.deepEqual([direct.status, direct.error], [403, 'cost_forbidden']);
});

test('admin listing update is atomic: a failed private-field write rolls back the listing change and both audit rows', async () => {
  ledgerOn();
  const v = await vendor();
  const p = await listed(v, { name: 'Atomic tee', stock: 5, costTzs: 1_000 });
  const store = createPgVendorStockStore({ db });
  const auditCount = async () => Number((await db('AuditLog').where({ target: p.id }).whereIn('action', ['product_listing_updated', 'admin_product_private_updated']).count('* as n').first()).n);
  const before = await auditCount();
  // costTzs -5 passes no service validation here (decide is called directly) and is refused by the
  // productprivate_cost_non_negative CHECK after the Product update and the listing audit row were written.
  await assert.rejects(store.adminUpdateListing({
    productId: p.id, actorId: 'adm_atomic',
    decide: () => ({ patch: { homepagePriority: 77, updatedAt: new Date().toISOString() }, privates: [{ variant: '', costTzs: -5 }] }),
  }), /productprivate_cost_non_negative/);
  assert.equal(Number((await row(p.id)).homepagePriority || 0), 0, 'listing change rolled back');
  assert.equal(await auditCount(), before, 'no audit rows left behind');
  assert.equal((await db('ProductPrivate').where({ productId: p.id, variant: '' }).first()).costTzs, 1_000);
  // A product that does not exist: 404 from inside the transaction.
  assert.deepEqual(await store.adminUpdateListing({ productId: 'prd_missing', actorId: 'adm_atomic', decide: () => ({ patch: {}, privates: [] }) }), { error: 'product_not_found', status: 404 });
});

test('admins without the shop scope get 403 on /vendor/products, stock-adjustments, stock-movements and stock/low', async () => {
  ledgerOn();
  const v = await vendor();
  const p = await listed(v, { stock: 3 });
  const noScope = otherAdmin();
  for (const [route, opts] of [
    [vendorMyProducts, {}],
    [vendorStockAdjustment, { params: { id: p.id }, body: { reason: 'found', quantity: 1, clientRef: randomUUID() } }],
    [vendorStockMovements, { params: { id: p.id } }],
    [vendorLowStock, {}],
  ]) {
    const out = await call(route, noScope, opts);
    assert.deepEqual([out.status, out.body], [403, { error: 'acl_forbidden', requiredScope: 'shop' }]);
  }
  // A shop-scoped admin and a super-admin pass the guard (scoped to their own id: nothing of this vendor's).
  for (const claims of [shopAdmin(), superAdmin()]) {
    assert.equal((await call(vendorMyProducts, claims)).status, 200);
    assert.equal((await call(vendorLowStock, claims)).status, 200);
    assert.deepEqual((await call(vendorStockMovements, claims, { params: { id: p.id } })).body, { error: 'not_your_product' });
  }
  // Vendors and vendor staff are not affected by the admin guard.
  assert.equal((await call(vendorLowStock, as(v))).status, 200);
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
  await assert.rejects(db('ShopStockMovement').insert({ ...base, id: uid('stk'), orderId, reason: 'release' }), /shopstockmovement_orderid_productid_variant_reason_cycle_unique/);
  await db('ShopStockMovement').insert({ ...base, id: uid('stk'), reason: 'restock', kind: 'adjustment', clientRef: 'ref-unique-1' });
  await assert.rejects(db('ShopStockMovement').insert({ ...base, id: uid('stk'), reason: 'restock', kind: 'adjustment', clientRef: 'ref-unique-1' }), /shopstockmovement_vendor_client_ref_unique/);
  const d5 = (await db.raw(`SELECT convalidated FROM pg_constraint WHERE conname = 'product_stock_non_negative'`)).rows[0];
  assert.equal(d5.convalidated, true);
});

// ── low stock: opening stock is not a crossing (UAT 2026-10-19: a new product at 0 sent "Only 0 left") ──

test('low stock: a product created at or below its reorder level sends no alert; the next downward crossing does', async () => {
  ledgerOn();
  const v = await vendor();
  const empty = await listed(v, { name: 'Empty at start', stock: 0, reorderLevel: 3 });
  const atLevel = await listed(v, { name: 'At level at start', stock: 3, reorderLevel: 3 });
  assert.equal((await lowAlerts(v)).length, 0, 'opening stock at or below the level is not a crossing');
  // Still listed as low: the alert is skipped, the state is not hidden.
  assert.deepEqual((await call(vendorLowStock, as(v))).body.map(x => x.productId).sort(), [empty.id, atLevel.id].sort());
  await adjust(v, atLevel.id, { reason: 'lost', quantity: 1 }); // 3 → 2: still low, never been above since creation
  assert.equal((await lowAlerts(v)).length, 0);
  await adjust(v, empty.id, { reason: 'restock', quantity: 10 }); // 0 → 10: above, re-armed
  await adjust(v, empty.id, { reason: 'damaged', quantity: 8 }); // 10 → 2: a real downward crossing
  const alerts = await lowAlerts(v);
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0].data, { productId: empty.id, productName: 'Empty at start', variant: null, stock: 2, reorderLevel: 3 });
});

test('low stock: variants created at 0 (own or inherited level) and a variant added later at 0 send no alert; an existing variant crossing in the same save does', async () => {
  ledgerOn();
  const v = await vendor();
  const p = await listed(v, { name: 'Gloves', reorderLevel: 2, variants: [{ name: 'S', stock: 0 }, { name: 'M', stock: 5 }, { name: 'L', stock: 1, reorderLevel: 1 }] });
  assert.equal((await lowAlerts(v)).length, 0, 'S (0 ≤ inherited 2) and L (1 ≤ own 1) start low: no alert');
  // One save: M is counted down to 1 (crosses 2) and a new variant XL starts at 0.
  const saved = await call(vendorUpdateProduct, as(v), { params: { id: p.id }, body: { variants: [{ name: 'S', stock: 0 }, { name: 'M', stock: 1 }, { name: 'L', stock: 1 }, { name: 'XL', stock: 0 }] } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const alerts = await lowAlerts(v);
  assert.deepEqual(alerts.map(a => a.data.variant), ['M'], 'only the existing variant that went down alerts');
  assert.deepEqual(alerts[0].data, { productId: p.id, productName: 'Gloves', variant: 'M', stock: 1, reorderLevel: 2 });
  // XL is still listed as low, and alerts after it has been above its level and come down again.
  assert.ok((await call(vendorLowStock, as(v))).body.some(x => x.productId === p.id && x.variant === 'XL'));
  await adjust(v, p.id, { variant: 'XL', reason: 'restock', quantity: 4 }); // 0 → 4
  await adjust(v, p.id, { variant: 'XL', reason: 'damaged', quantity: 3 }); // 4 → 1: crosses
  assert.deepEqual((await lowAlerts(v)).map(a => a.data.variant).sort(), ['M', 'XL']);
});

test('low stock: raising the reorder level to or above the stock still alerts once (owner decision kept), from the vendor form and from the admin listing', async () => {
  ledgerOn();
  const v = await vendor();
  const p = await listed(v, { name: 'Bands', stock: 4, reorderLevel: 2 });
  assert.equal((await lowAlerts(v)).length, 0);
  assert.equal((await call(vendorUpdateProduct, as(v), { params: { id: p.id }, body: { reorderLevel: 5 } })).status, 200);
  assert.equal((await lowAlerts(v)).length, 1, 'level 2 → 5 with 4 in stock: one alert');
  assert.equal((await call(vendorUpdateProduct, as(v), { params: { id: p.id }, body: { reorderLevel: 6 } })).status, 200);
  assert.equal((await lowAlerts(v)).length, 1, 'already reported: raising it again does not repeat');

  // A product created at 0 with no level, then given one: that is a raise, so it alerts.
  const q = await listed(v, { name: 'Mats', stock: 0 });
  assert.equal((await lowAlerts(v)).length, 1);
  assert.equal((await call(vendorUpdateProduct, as(v), { params: { id: q.id }, body: { reorderLevel: 1 } })).status, 200);
  assert.equal((await lowAlerts(v)).length, 2);
  assert.deepEqual((await lowAlerts(v)).find(a => a.data.productId === q.id).data, { productId: q.id, productName: 'Mats', variant: null, stock: 0, reorderLevel: 1 });

  // From the admin listing too.
  const r = await listed(v, { name: 'Rope', stock: 3, reorderLevel: 1 });
  const out = await call(adminUpdateProductListing, shopAdmin(), { params: { id: r.id }, body: { reorderLevel: 3 } });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal((await lowAlerts(v)).filter(a => a.data.productId === r.id).length, 1);
});

test('low stock: an admin-created product at or below its level sends no alert', async () => {
  ledgerOn();
  const v = await vendor();
  const out = await call(adminCreateProduct, shopAdmin(), { body: { vendorId: v, name: 'Admin empty', category: 'supplements_nutrition', priceTzs: 9_000, stock: 0, reorderLevel: 2, variants: [{ name: 'One', stock: 0 }] } });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  made.products.push(out.body.id);
  assert.equal((await lowAlerts(v)).length, 0);
});
