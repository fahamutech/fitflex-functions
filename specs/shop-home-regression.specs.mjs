// Regression: the shop's existing browse, cart, checkout and order endpoints do
// exactly the same with SHOP_HOME_V2 off and on. The same journey is run twice,
// against the CI database, and the two transcripts (ids and times masked) must match.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { ensureInit } from '../functions/index.mjs';
import { listShopProducts, getShopProduct, createShopOrder, myShopOrders, marketplaceReorder, marketplaceInvoice, vendorOrders } from '../functions/shop.mjs';
import { cancelMyShopOrder } from '../functions/refunds.mjs';
import { discoverProducts } from '../functions/discover.mjs';

await ensureInit();

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], products: [], orders: [] };

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
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return { status: out.statusCode, body: out.body, headers: out.headers };
}

/** Ids and timestamps differ between runs; everything else must not. */
function mask(value, ids) {
  if (Array.isArray(value)) return value.map(v => mask(v, ids));
  if (value && typeof value === 'object') {
    // shortRef (S2) is derived from the order id, which differs per journey.
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, k === 'shortRef' ? '<shortRef>' : mask(v, ids)]));
  }
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return '<time>';
    let s = value;
    for (const [real, alias] of ids) s = s.split(real).join(alias);
    return s.replace(/\b(ord|pay|ntf)_[0-9a-f]{8}\b/g, '<$1>').replace(/\bcus_[0-9a-f]{16}\b/g, '<cus>').replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<time>');
  }
  return value;
}

async function journey() {
  const vendor = uid('usr');
  const buyer = uid('usr');
  await db('User').insert([
    { id: vendor, userType: 'vendor', displayName: 'Regression vendor', updatedAt: new Date() },
    { id: buyer, userType: 'member', displayName: 'Regression buyer', updatedAt: new Date() },
  ]);
  made.users.push(vendor, buyer);
  const productId = uid('prd');
  const emptyId = uid('prd');
  await db('Product').insert([
    { id: productId, vendorId: vendor, name: 'Regression whey', category: 'supplements_nutrition', priceTzs: 30_000, discountPriceTzs: 25_000, stock: 5, status: 'active', approvalStatus: 'approved', updatedAt: new Date() },
    { id: emptyId, vendorId: vendor, name: 'Regression empty', category: 'equipment', priceTzs: 10_000, stock: 0, status: 'active', approvalStatus: 'approved', updatedAt: new Date() },
  ]);
  made.products.push(productId, emptyId);
  const ids = [[vendor, '<vendor>'], [buyer, '<buyer>'], [productId, '<product>'], [emptyId, '<empty>']];
  const member = { sub: buyer, userType: 'member' };
  const key = `regr-${randomUUID()}`;
  const steps = {};
  steps.list = await call(listShopProducts, member, { query: { vendorId: vendor } });
  steps.listSale = await call(listShopProducts, member, { query: { vendorId: vendor, promotions: 'true' } });
  steps.detail = await call(getShopProduct, member, { params: { id: productId } });
  steps.discover = await call(discoverProducts, member, { query: { q: 'Regression whey' } });
  steps.outOfStock = await call(createShopOrder, member, { body: { items: [{ productId: emptyId, qty: 1 }], deliveryMethod: 'home_delivery', deliveryAddress: 'Mikocheni', paymentMethod: 'mpesa' } });
  steps.order = await call(createShopOrder, member, { body: { items: [{ productId, qty: 2 }], deliveryMethod: 'home_delivery', deliveryAddress: 'Mikocheni', paymentMethod: 'mpesa' }, headers: { 'idempotency-key': key } });
  const orderId = steps.order.body?.id;
  if (orderId) made.orders.push(orderId);
  steps.stockAfterOrder = (await db('Product').where({ id: productId }).first()).stock;
  steps.retry = await call(createShopOrder, member, { body: { items: [{ productId, qty: 2 }], deliveryMethod: 'home_delivery', deliveryAddress: 'Mikocheni', paymentMethod: 'mpesa' }, headers: { 'idempotency-key': key } });
  steps.sameOrder = steps.retry.body?.id === orderId;
  steps.mine = await call(myShopOrders, member);
  steps.reorder = await call(marketplaceReorder, member, { params: { id: orderId } });
  steps.invoice = await call(marketplaceInvoice, member, { params: { id: orderId } });
  steps.vendorOrders = await call(vendorOrders, { sub: vendor, userType: 'vendor' });
  steps.cancel = await call(cancelMyShopOrder, member, { params: { id: orderId } });
  steps.stockAfterCancel = (await db('Product').where({ id: productId }).first()).stock;
  // Only this journey's rows: other data in the database is not part of the comparison.
  steps.discover.body = { items: (steps.discover.body?.items || []).filter(p => p.id === productId), featured: steps.discover.body?.featured?.filter(p => p.id === productId) };
  steps.detail.body = { ...steps.detail.body, similarProducts: (steps.detail.body?.similarProducts || []).filter(p => p.vendorId === vendor) };
  steps.mine.body = steps.mine.body.filter(o => o.id === orderId);
  steps.vendorOrders.body = steps.vendorOrders.body.filter(o => o.id === orderId);
  return mask(steps, ids);
}

after(async () => {
  delete process.env.SHOP_HOME_V2;
  await db('ShopStockMovement').whereIn('orderId', made.orders).del();
  await db('PaymentRequest').whereIn('orderId', made.orders).del();
  await db('AuditLog').whereIn('target', [...made.orders, ...made.products]).del();
  await db('MarketplaceNotification').whereIn('userId', made.users).del();
  await db('VendorBuyerRef').whereIn('vendorId', made.users).del();
  await db('ShopOrder').whereIn('id', made.orders).del();
  await db('Product').whereIn('id', made.products).del();
  await db('User').whereIn('id', made.users).del();
  await db.destroy();
});

test('browse, checkout, retry, order list, reorder, invoice, vendor orders and cancel are the same with SHOP_HOME_V2 off and on', async () => {
  delete process.env.SHOP_HOME_V2;
  const off = await journey();
  process.env.SHOP_HOME_V2 = '1';
  const on = await journey();
  assert.deepEqual(on, off);

  // And the journey itself is what the shop has always done.
  assert.equal(off.list.status, 200);
  assert.deepEqual(off.list.body.map(p => p.name), ['Regression whey', 'Regression empty']);
  assert.deepEqual(off.listSale.body.map(p => p.name), ['Regression whey']);
  assert.equal(off.detail.status, 200);
  assert.equal(off.discover.body.items.length, 1);
  assert.equal(off.outOfStock.status, 409);
  assert.equal(off.outOfStock.body.error, 'insufficient_stock');
  assert.equal(off.order.status, 201);
  assert.equal(off.order.body.totalTzs, 50_000, 'sale price, from the product row');
  assert.equal(off.order.body.paymentStatus, 'pending');
  assert.equal(off.stockAfterOrder, 3);
  assert.equal(off.sameOrder, true);
  assert.equal(off.retry.headers['Idempotent-Replay'], 'true');
  assert.equal(off.mine.body.length, 1);
  assert.equal(off.mine.body[0].canCancel, true);
  assert.deepEqual(off.reorder.body, { items: [{ productId: '<product>', variant: null, qty: 2 }] });
  assert.match(off.invoice.body, /Total: TSh 50,000/);
  assert.equal(off.vendorOrders.body.length, 1);
  assert.equal(off.cancel.status, 200);
  assert.equal(off.cancel.body.order.status, 'cancelled');
  assert.equal(off.stockAfterCancel, 5);
});
