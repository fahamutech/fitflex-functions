// A vendor whose account an admin has suspended (User.accountStatus = 'suspended')
// is off sale everywhere a buyer looks or buys: listing, search, detail, similar
// products, storefront, discovery and checkout. Moderation suspension is a
// separate switch with the same effect (shop-home.specs covers both on /shop/home).
// Orders placed before the suspension are left alone.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { ensureInit } from '../functions/index.mjs';
import { listShopProducts, getShopProduct, getVendorStore, createShopOrder } from '../functions/shop.mjs';
import { discoveryService } from '../src/bootstrap/services.mjs';
import { createShopService } from '../src/services/shop-service.mjs';

await ensureInit();

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;

// ── the service, in memory ───────────────────────────────────────────────────

function memStore(rows = []) {
  return {
    rows,
    async filterAsync(fn) { return rows.filter(fn); },
    async findAsync(fn) { return rows.find(fn) || null; },
    async findByIdAsync(id) { return rows.find(r => r.id === id) || null; },
    async insertAsync(row) { rows.push(row); return row; },
    async upsertAsync(fn, row) { const i = rows.findIndex(fn); if (i >= 0) rows[i] = row; else rows.push(row); return row; },
    async updateByIdAsync(id, patch) { const i = rows.findIndex(r => r.id === id); if (i >= 0) rows[i] = { ...rows[i], ...patch }; return rows[i] || null; },
  };
}

const PROFILE = { businessName: 'Shop', logo: 'l', banner: 'b', description: 'd', businessCategory: 'supplements_nutrition', contactNumber: '255700000000', address: 'Dar', businessHours: '9-5', settlementAccount: 'acc', status: 'published' };

function setup() {
  const users = memStore([
    { id: 'v_ok', userType: 'vendor', accountStatus: 'active', vendorProfile: { ...PROFILE, vendorId: 'v_ok' } },
    { id: 'v_off', userType: 'vendor', accountStatus: 'active', vendorProfile: { ...PROFILE, vendorId: 'v_off' } },
  ]);
  const products = memStore();
  const shopOrders = memStore();
  const service = createShopService({ products, shopOrders, users, auditLog: { insertAsync: async () => {} } });
  const add = (id, vendorId) => products.rows.push({ id, vendorId, name: `Whey ${id}`, category: 'supplements_nutrition', priceTzs: 10_000, stock: 5, status: 'active', approvalStatus: 'approved', visibility: 'visible', createdAt: new Date().toISOString() });
  add('p_ok', 'v_ok');
  add('p_off', 'v_off');
  const suspend = (status = 'suspended') => service.adminUpdateVendor({ vendorId: 'v_off', body: { accountStatus: status }, actorId: 'admin_1' });
  return { service, users, products, shopOrders, suspend };
}
const cart = items => ({ items, deliveryMethod: 'home_delivery', deliveryAddress: 'Mikocheni', paymentMethod: 'mpesa' });

test('a suspended vendor\'s products leave the listing, search, detail, similar products and storefront', async () => {
  const { service, suspend } = setup();
  assert.deepEqual((await service.listProducts({})).map(p => p.id).sort(), ['p_off', 'p_ok']);
  await suspend();
  assert.deepEqual((await service.listProducts({})).map(p => p.id), ['p_ok']);
  assert.deepEqual((await service.listProducts({ search: 'whey' })).map(p => p.id), ['p_ok']);
  assert.deepEqual(await service.listProducts({ vendorId: 'v_off' }), []);
  assert.equal(await service.getProduct('p_off'), null);
  assert.ok(!(await service.getProduct('p_ok')).similarProducts.some(p => p.id === 'p_off'));
  assert.equal(await service.getVendorStore('v_off'), null);
  assert.ok(await service.getVendorStore('v_ok'));
});

test('the vendor still sees their own products while suspended', async () => {
  const { service, suspend } = setup();
  await suspend();
  assert.deepEqual((await service.listProducts({ vendorId: 'v_off', includeArchived: true })).map(p => p.id), ['p_off']);
});

test('checkout refuses a suspended vendor\'s product with vendor_unavailable and reserves nothing', async () => {
  const { service, products, shopOrders, suspend } = setup();
  await suspend();
  const out = await service.createOrder({ buyerId: 'buyer_1', body: cart([{ productId: 'p_ok', qty: 1 }, { productId: 'p_off', qty: 1 }]) });
  assert.deepEqual({ error: out.error, status: out.status, productId: out.productId }, { error: 'vendor_unavailable', status: 409, productId: 'p_off' });
  assert.equal(shopOrders.rows.length, 0);
  assert.deepEqual(products.rows.map(p => p.stock), [5, 5]);
  assert.ok((await service.createOrder({ buyerId: 'buyer_1', body: cart([{ productId: 'p_ok', qty: 1 }]) })).order, 'other vendors still sell');
});

test('lifting the suspension puts the products back on sale', async () => {
  const { service, suspend } = setup();
  await suspend();
  await suspend('active');
  assert.ok((await service.listProducts({})).some(p => p.id === 'p_off'));
  assert.ok((await service.createOrder({ buyerId: 'buyer_1', body: cart([{ productId: 'p_off', qty: 1 }]) })).order);
});

test('an order placed before the suspension is left as it was: not cancelled, admin can still move it', async () => {
  const { service, shopOrders, suspend } = setup();
  const placed = await service.createOrder({ buyerId: 'buyer_1', body: cart([{ productId: 'p_off', qty: 2 }]) });
  assert.ok(placed.order, JSON.stringify(placed));
  await suspend();
  const kept = shopOrders.rows.find(o => o.id === placed.order.id);
  assert.equal(kept.status, 'pending');
  assert.equal(kept.paymentStatus, placed.order.paymentStatus);
  assert.ok((await service.myOrders('buyer_1')).some(o => o.id === placed.order.id), 'the buyer still sees it');
  const byVendor = await service.updateOrderStatus({ orderId: placed.order.id, status: 'accepted', actorId: 'v_off', actorRole: 'vendor' });
  assert.equal(byVendor.error, 'vendor_suspended');
  const byAdmin = await service.updateOrderStatus({ orderId: placed.order.id, status: 'accepted', actorId: 'admin_1', actorRole: 'admin' });
  assert.ok(!byAdmin.error, JSON.stringify(byAdmin));
});

// ── the routes and discovery, against the CI database ────────────────────────

const made = { users: [], products: [], orders: [] };
after(async () => {
  await db('ShopStockMovement').whereIn('orderId', made.orders).del();
  await db('PaymentRequest').whereIn('orderId', made.orders).del();
  await db('ShopOrder').whereIn('id', made.orders).del();
  await db('AuditLog').whereIn('target', made.products).del();
  await db('Product').whereIn('id', made.products).del();
  await db('User').whereIn('id', made.users).del();
  await db.destroy();
});

function res() {
  return { statusCode: 200, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, set(k, v) { this.headers[k] = v; return this; } };
}
async function call(route, claims, { params = {}, query = {}, body = {} } = {}) {
  const req = { headers: { authorization: `Bearer ${sign(claims)}` }, params, query, body, get: () => null };
  const out = res();
  for (const guard of [route.onGuard].flat().filter(Boolean)) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return out;
}
async function user(userType, extra = {}) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `Suspended spec ${userType}`, updatedAt: new Date(), createdAt: new Date('2026-01-01T00:00:00Z'), ...extra });
  made.users.push(id);
  return id;
}
async function product(vendorId, name) {
  const id = uid('prd');
  await db('Product').insert({ id, vendorId, name, category: 'equipment', priceTzs: 20_000, stock: 4, status: 'active', approvalStatus: 'approved', updatedAt: new Date() });
  made.products.push(id);
  return id;
}

test('routes and discovery: an account-suspended vendor is hidden and refused at checkout', async () => {
  const tag = uid('kettlebell');
  const okVendor = await user('vendor');
  const offVendor = await user('vendor', { accountStatus: 'suspended' });
  const shown = await product(okVendor, `${tag} ok`);
  const hidden = await product(offVendor, `${tag} off`);
  const member = await user('member');
  const claims = { sub: member, userType: 'member' };

  const list = await call(listShopProducts, claims, { query: { search: tag } });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.body.map(p => p.id), [shown]);

  assert.equal((await call(getShopProduct, claims, { params: { id: hidden } })).statusCode, 404);
  assert.equal((await call(getShopProduct, claims, { params: { id: shown } })).statusCode, 200);
  assert.equal((await call(getVendorStore, claims, { params: { id: offVendor } })).statusCode, 404);

  const found = await discoveryService.discover({ entityType: 'product', q: tag, limit: 20 });
  const ids = [...(found.items || []), ...(found.featured || [])].map(card => card.id);
  assert.ok(ids.includes(shown), 'the other vendor is discoverable');
  assert.ok(!ids.includes(hidden), 'the suspended vendor is not');

  const order = await call(createShopOrder, claims, { body: cart([{ productId: hidden, qty: 1 }]) });
  assert.equal(order.statusCode, 409);
  assert.deepEqual(order.body, { error: 'vendor_unavailable', productId: hidden });
  assert.equal((await db('Product').where({ id: hidden }).first()).stock, 4, 'nothing reserved');
  assert.equal((await db('ShopOrder').where({ buyerId: member })).length, 0);
});
