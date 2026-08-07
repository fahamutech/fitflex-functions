// D1 — Shop / vendor e-commerce (FitFlex App Issues 25.07.2026).
// Phase 1: product catalogue CRUD (vendor-scoped) + order lifecycle with stock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShopService } from '../src/services/shop-service.mjs';

function memStore(rows = []) {
  return {
    rows,
    async filterAsync(fn) { return rows.filter(fn); },
    async findAsync(fn) { return rows.find(fn) || null; },
    async findByIdAsync(id) { return rows.find((r) => r.id === id) || null; },
    async insertAsync(row) { rows.push(row); return row; },
    async updateByIdAsync(id, patch) {
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows[i] = { ...rows[i], ...patch };
      return rows[i] || null;
    },
  };
}

function makeService() {
  const products = memStore();
  const shopOrders = memStore();
  const service = createShopService({
    products,
    shopOrders,
    users: memStore(),
    auditLog: { insert: () => {} },
  });
  return { service, products, shopOrders };
}

async function seedProduct(service, { name = 'Whey Protein', priceTzs = 85000, stock = 10 } = {}) {
  const out = await service.upsertProduct({
    vendorId: 'usr_vendor_1',
    body: { name, category: 'supplements', priceTzs, stock },
  });
  assert.ok(!out.error, JSON.stringify(out));
  return out.product;
}

// ── catalogue ──────────────────────────────────────────────

test('D1: vendor creates a product visible in the catalogue', async () => {
  const { service } = makeService();
  const product = await seedProduct(service);
  const listed = await service.listProducts({});
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, product.id);
  assert.equal(listed[0].status, 'active');
});

test('D1: product requires name and positive price', async () => {
  const { service } = makeService();
  const noName = await service.upsertProduct({ vendorId: 'v', body: { priceTzs: 100 } });
  assert.equal(noName.error, 'name_required');
  const noPrice = await service.upsertProduct({ vendorId: 'v', body: { name: 'X', priceTzs: 0 } });
  assert.equal(noPrice.error, 'priceTzs_required');
});

test('D1: only the owning vendor can update a product', async () => {
  const { service } = makeService();
  const product = await seedProduct(service);
  const out = await service.upsertProduct({
    vendorId: 'usr_other_vendor', productId: product.id, body: { priceTzs: 1 },
  });
  assert.equal(out.status, 403);
  assert.equal(out.error, 'not_your_product');
});

test('D1: archived products are hidden from the public catalogue', async () => {
  const { service } = makeService();
  const product = await seedProduct(service);
  await service.upsertProduct({
    vendorId: 'usr_vendor_1', productId: product.id, body: { status: 'archived' },
  });
  assert.equal((await service.listProducts({})).length, 0);
  const mine = await service.listProducts({ vendorId: 'usr_vendor_1', includeArchived: true });
  assert.equal(mine.length, 1);
});

test('D1: catalogue search matches name/description', async () => {
  const { service } = makeService();
  await seedProduct(service, { name: 'Yoga Mat' });
  await seedProduct(service, { name: 'Whey Protein' });
  const out = await service.listProducts({ search: 'yoga' });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Yoga Mat');
});

// ── orders ─────────────────────────────────────────────────

test('D1: placing an order deducts stock and totals correctly', async () => {
  const { service, products } = makeService();
  const product = await seedProduct(service, { priceTzs: 5000, stock: 10 });
  const out = await service.createOrder({
    buyerId: 'usr_m1',
    body: { items: [{ productId: product.id, qty: 3 }] },
  });
  assert.ok(!out.error, JSON.stringify(out));
  assert.equal(out.order.totalTzs, 15000);
  assert.equal(out.order.status, 'pending');
  assert.equal(products.rows[0].stock, 7);
});

test('D1: insufficient stock rejects the order', async () => {
  const { service, products } = makeService();
  const product = await seedProduct(service, { stock: 2 });
  const out = await service.createOrder({
    buyerId: 'usr_m1',
    body: { items: [{ productId: product.id, qty: 5 }] },
  });
  assert.equal(out.status, 409);
  assert.equal(out.error, 'insufficient_stock');
  assert.equal(products.rows[0].stock, 2, 'stock untouched on failure');
});

test('D1: empty order is rejected', async () => {
  const { service } = makeService();
  const out = await service.createOrder({ buyerId: 'usr_m1', body: { items: [] } });
  assert.equal(out.error, 'items_required');
});

test('D1: cancelling an order restocks the items', async () => {
  const { service, products } = makeService();
  const product = await seedProduct(service, { stock: 10 });
  const placed = await service.createOrder({
    buyerId: 'usr_m1',
    body: { items: [{ productId: product.id, qty: 4 }] },
  });
  assert.equal(products.rows[0].stock, 6);
  const cancelled = await service.updateOrderStatus({
    orderId: placed.order.id, status: 'cancelled', actorId: 'usr_vendor_1',
  });
  assert.ok(!cancelled.error);
  assert.equal(products.rows[0].stock, 10);
});

test('D1: order lifecycle pending → confirmed → fulfilled', async () => {
  const { service } = makeService();
  const product = await seedProduct(service);
  const placed = await service.createOrder({
    buyerId: 'usr_m1',
    body: { items: [{ productId: product.id, qty: 1 }] },
  });
  const confirmed = await service.updateOrderStatus({ orderId: placed.order.id, status: 'confirmed', actorId: 'v' });
  assert.equal(confirmed.order.status, 'confirmed');
  const fulfilled = await service.updateOrderStatus({ orderId: placed.order.id, status: 'fulfilled', actorId: 'v' });
  assert.equal(fulfilled.order.status, 'fulfilled');
  const invalid = await service.updateOrderStatus({ orderId: placed.order.id, status: 'nonsense', actorId: 'v' });
  assert.equal(invalid.error, 'invalid_status');
});

test('D1: vendor sees only orders containing their products', async () => {
  const { service } = makeService();
  const mine = await seedProduct(service);
  const other = await service.upsertProduct({
    vendorId: 'usr_vendor_2', body: { name: 'Other Product', priceTzs: 1000, stock: 5 },
  });
  await service.createOrder({ buyerId: 'usr_m1', body: { items: [{ productId: mine.id, qty: 1 }] } });
  await service.createOrder({ buyerId: 'usr_m2', body: { items: [{ productId: other.product.id, qty: 1 }] } });

  const vendorView = await service.vendorOrders('usr_vendor_1');
  assert.equal(vendorView.length, 1);
  const buyerView = await service.myOrders('usr_m1');
  assert.equal(buyerView.length, 1);
});
