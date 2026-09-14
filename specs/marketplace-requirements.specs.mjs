import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShopService } from '../src/services/shop-service.mjs';

function memStore(rows = []) {
  return {
    rows,
    async filterAsync(fn) { return rows.filter(fn); },
    async findAsync(fn) { return rows.find(fn) || null; },
    async findByIdAsync(id) { return rows.find(row => row.id === id) || null; },
    async insertAsync(row) { rows.push(row); return row; },
    async updateByIdAsync(id, patch) {
      const index = rows.findIndex(row => row.id === id);
      if (index < 0) return null;
      rows[index] = { ...rows[index], ...patch };
      return rows[index];
    },
    async removeByIdAsync(id) {
      const index = rows.findIndex(row => row.id === id);
      if (index < 0) return null;
      return rows.splice(index, 1)[0];
    },
    upsert(pred, row) {
      const index = rows.findIndex(pred);
      if (index < 0) rows.push(row);
      else rows[index] = row;
      return row;
    },
    async upsertAsync(pred, row) { return this.upsert(pred, row); },
  };
}

function makeService() {
  const stores = {
    products: memStore(), shopOrders: memStore(), users: memStore(),
    marketplaceEnquiries: memStore(), marketplaceNotifications: memStore(),
    productReviews: memStore(),
  };
  const service = createShopService({
    ...stores,
    auditLog: { insert: () => {} },
  });
  return { service, ...stores };
}

const completeProfile = {
  businessName: 'Fit Fuel Tanzania', logo: 'data:image/png;base64,logo',
  banner: 'data:image/png;base64,banner', description: 'Sports nutrition',
  businessCategory: 'supplements', contactNumber: '+255700000001',
  email: 'sales@fitfuel.test', address: 'Masaki, Dar es Salaam',
  deliveryRegions: ['Dar es Salaam'],
  businessHours: { monday: '08:00-18:00' },
  settlementAccount: { type: 'mobile_money', provider: 'M-Pesa', account: '255700000001' },
};

async function approvedProduct(service, overrides = {}) {
  const created = await service.upsertProduct({
    vendorId: 'vendor-1',
    body: {
      name: 'Whey Protein', description: 'One kilogram tub', category: 'Supplements',
      brand: 'Fit Fuel', priceTzs: 85000, discountPriceTzs: 75000, stock: 10,
      sku: 'FF-WHEY-1', weightKg: 1, variants: [{ name: 'Vanilla', stock: 4 }],
      images: ['one.jpg', 'two.jpg'], visibility: 'visible', deliveryAvailable: true,
      distanceKm: 4.5,
      ...overrides,
    },
  });
  await service.adminUpdateProductListing({
    productId: created.product.id, body: { approvalStatus: 'approved' }, actorId: 'admin-1',
  });
  return created.product.id;
}

test('marketplace: complete business profile is required before publication', async () => {
  const { service } = makeService();
  const incomplete = await service.saveVendorProfile({
    vendorId: 'vendor-1', body: { businessName: 'Fit Fuel', publish: true },
  });
  assert.equal(incomplete.error, 'mandatory_profile_fields_missing');
  assert.ok(incomplete.missing.includes('logo'));

  const saved = await service.saveVendorProfile({
    vendorId: 'vendor-1', body: { ...completeProfile, publish: true },
  });
  assert.equal(saved.profile.status, 'published');
  assert.equal((await service.getVendorStore('vendor-1')).businessName, 'Fit Fuel Tanzania');
});

test('marketplace: public vendor responses exclude settlement data and unpublished profiles', async () => {
  const { service } = makeService();
  await service.saveVendorProfile({ vendorId: 'vendor-1', body: { ...completeProfile, privateNote: 'internal', publish: true } });
  const productId = await approvedProduct(service);
  const store = await service.getVendorStore('vendor-1');
  const detail = await service.getProduct(productId);
  for (const profile of [store, detail.vendor]) {
    assert.equal(profile.settlementAccount, undefined);
    assert.equal(profile.privateNote, undefined);
    assert.equal(profile.businessName, completeProfile.businessName);
  }
  assert.deepEqual((await service.getVendorProfile('vendor-1')).settlementAccount, completeProfile.settlementAccount);
  await service.saveVendorProfile({ vendorId: 'draft-vendor', body: { businessName: 'Draft' } });
  assert.equal(await service.getVendorStore('draft-vendor'), null);
});

test('marketplace: rich products are approval gated, filterable and sortable', async () => {
  const { service } = makeService();
  const productId = await approvedProduct(service);
  await approvedProduct(service, {
    name: 'Yoga Mat', category: 'Equipment', brand: 'Zen', priceTzs: 30000,
    discountPriceTzs: null, soldCount: 50, rating: 4.9,
  });

  const filtered = await service.listProducts({
    category: 'supplements', brand: 'fit fuel', minPrice: 70000, maxPrice: 80000,
    vendorId: 'vendor-1', delivery: true, maxDistanceKm: 5, promotions: true,
  });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, productId);
  assert.equal(filtered[0].images.length, 2);
  assert.equal(filtered[0].sku, 'FF-WHEY-1');

  assert.equal((await service.listProducts({ maxDistanceKm: 4 })).length, 0);
  assert.equal((await service.listProducts({ promotions: true })).length, 1);

  const popular = await service.listProducts({ sort: 'popularity' });
  assert.equal(popular[0].name, 'Yoga Mat');
});

test('marketplace: vendor can duplicate, pause, resume, stock and delete only own products', async () => {
  const { service } = makeService();
  const productId = await approvedProduct(service);
  const copy = await service.duplicateProduct({ vendorId: 'vendor-1', productId });
  assert.match(copy.product.name, /Copy$/);
  assert.equal(copy.product.approvalStatus, 'pending');

  await service.upsertProduct({ vendorId: 'vendor-1', productId, body: { status: 'paused', stock: 22 } });
  assert.equal((await service.getProduct(productId, { includeUnlisted: true })).stock, 22);
  assert.equal((await service.listProducts({})).some(row => row.id === productId), false);
  await service.upsertProduct({ vendorId: 'vendor-1', productId, body: { status: 'active' } });

  assert.equal((await service.deleteProduct({ vendorId: 'vendor-2', productId })).status, 403);
  assert.equal((await service.deleteProduct({ vendorId: 'vendor-1', productId })).deleted, true);
});

test('marketplace: checkout creates paid delivery order and preserves a seven-stage timeline', async () => {
  const { service, products } = makeService();
  const productId = await approvedProduct(service, { stock: 5 });
  const failed = await service.createOrder({
    buyerId: 'member-1', body: {
      items: [{ productId, qty: 2 }], deliveryMethod: 'home_delivery',
      deliveryAddress: 'Mikocheni', paymentMethod: 'mpesa', paymentOutcome: 'failed',
    },
  });
  assert.equal(failed.error, 'payment_failed');
  assert.equal(products.rows.find(row => row.id === productId).stock, 5);

  const placed = await service.createOrder({
    buyerId: 'member-1', buyerRole: 'member', body: {
      items: [{ productId, qty: 2 }], deliveryMethod: 'home_delivery',
      deliveryAddress: 'Mikocheni', paymentMethod: 'mpesa', paymentOutcome: 'success',
    },
  });
  assert.equal(placed.order.paymentStatus, 'paid');
  assert.equal(placed.order.deliveryMethod, 'home_delivery');
  assert.equal(placed.order.timeline[0].status, 'pending');

  for (const status of ['accepted', 'processing', 'packed', 'dispatched', 'delivered']) {
    const result = await service.updateOrderStatus({
      orderId: placed.order.id, status, actorId: 'vendor-1', actorRole: 'vendor',
    });
    assert.equal(result.order.status, status);
  }
  assert.deepEqual(placed.order.timeline.map(entry => entry.status), [
    'pending', 'accepted', 'processing', 'packed', 'dispatched', 'delivered',
  ]);
});

test('marketplace: gym pickup requires a gym and supports ready-for-pickup', async () => {
  const { service } = makeService();
  const productId = await approvedProduct(service);
  const missing = await service.createOrder({
    buyerId: 'trainer-1', buyerRole: 'trainer', body: {
      items: [{ productId, qty: 1 }], deliveryMethod: 'gym_pickup',
      paymentMethod: 'airtel_money', paymentOutcome: 'success',
    },
  });
  assert.equal(missing.error, 'pickup_gym_required');
  const placed = await service.createOrder({
    buyerId: 'trainer-1', buyerRole: 'trainer', body: {
      items: [{ productId, qty: 1 }], deliveryMethod: 'gym_pickup', pickupGymId: 'gym-1',
      paymentMethod: 'airtel_money', paymentOutcome: 'success',
    },
  });
  const ready = await service.updateOrderStatus({
    orderId: placed.order.id, status: 'ready_for_pickup', actorId: 'vendor-1', actorRole: 'vendor',
  });
  assert.equal(ready.order.status, 'ready_for_pickup');
});

test('marketplace: sales dashboard and statement count delivered paid orders only', async () => {
  const { service, shopOrders } = makeService();
  const now = new Date().toISOString();
  shopOrders.rows.push(
    { id: 'paid', items: [{ productId: 'p1', vendorId: 'vendor-1', qty: 1, priceTzs: 9000 }], totalTzs: 9000, paymentStatus: 'paid', status: 'delivered', createdAt: now, updatedAt: now },
    { id: 'pending', items: [{ productId: 'p2', vendorId: 'vendor-1', qty: 1, priceTzs: 5000 }], totalTzs: 5000, paymentStatus: 'paid', status: 'processing', createdAt: now, updatedAt: now },
    { id: 'other', items: [{ productId: 'p3', vendorId: 'vendor-2', qty: 1, priceTzs: 7000 }], totalTzs: 7000, paymentStatus: 'paid', status: 'delivered', createdAt: now, updatedAt: now },
  );
  const dashboard = await service.vendorPayments('vendor-1');
  assert.equal(dashboard.todaySalesTzs, 9000);
  assert.equal(dashboard.pendingSettlementTzs, 9000);
  assert.match(await service.vendorStatement('vendor-1'), /paid,9000,delivered/);
});

test('marketplace: enquiries notify vendor, support reply, search and resolution', async () => {
  const { service, marketplaceNotifications } = makeService();
  const productId = await approvedProduct(service);
  const sent = await service.sendEnquiry({
    buyerId: 'member-1', body: { productId, message: 'Do you deliver to Arusha?' },
  });
  assert.equal(sent.enquiry.status, 'open');
  assert.equal(marketplaceNotifications.rows.at(-1).type, 'new_customer_enquiry');
  await service.replyEnquiry({ vendorId: 'vendor-1', enquiryId: sent.enquiry.id, message: 'Yes.' });
  await service.resolveEnquiry({ vendorId: 'vendor-1', enquiryId: sent.enquiry.id });
  const found = await service.vendorEnquiries({ vendorId: 'vendor-1', search: 'arusha' });
  assert.equal(found[0].status, 'resolved');
  assert.equal(found[0].messages.length, 2);
});

test('marketplace: vendor staff permissions and disabled state are enforced', async () => {
  const { service, users } = makeService();
  const created = await service.createVendorStaff({
    vendorId: 'vendor-1', body: {
      name: 'Asha Stock', email: 'asha@vendor.test', phone: '+255700000002',
      password: 'Secret123', role: 'inventory_manager', permissions: ['products'],
    },
  });
  assert.equal(created.staff.userType, 'vendor_staff');
  assert.equal(created.staff.passwordHash, undefined);
  assert.match(users.rows[0].passwordHash, /^scrypt:/);
  assert.equal((await service.listVendorStaff('vendor-1'))[0].passwordHash, undefined);
  assert.equal(service.canStaff(created.staff, 'products'), true);
  assert.equal(service.canStaff(created.staff, 'payments'), false);
  const claims = { sub: created.staff.id, vendorId: 'vendor-1' };
  assert.equal(await service.authorizeStaff(claims, 'products'), true);
  assert.equal(await service.authorizeStaff({ ...claims, vendorId: 'vendor-2' }, 'products'), false);
  const disabled = await service.disableVendorStaff({ vendorId: 'vendor-1', staffId: created.staff.id });
  assert.equal(disabled.staff.accountStatus, 'suspended');
  assert.equal(await service.authorizeStaff(claims, 'products'), false);
});

test('marketplace: buyer can review delivered products, download invoice data and reorder', async () => {
  const { service } = makeService();
  const productId = await approvedProduct(service, { stock: 8 });
  const placed = await service.createOrder({
    buyerId: 'owner-1', buyerRole: 'gym_operator', body: {
      items: [{ productId, qty: 1 }], deliveryMethod: 'gym_pickup', pickupGymId: 'gym-1',
      paymentMethod: 'card', paymentOutcome: 'success',
    },
  });
  for (const status of ['accepted', 'processing', 'ready_for_pickup', 'delivered']) {
    await service.updateOrderStatus({ orderId: placed.order.id, status, actorId: 'vendor-1' });
  }
  const review = await service.reviewProduct({
    buyerId: 'owner-1', orderId: placed.order.id, productId, rating: 5, comment: 'Excellent',
  });
  assert.equal(review.review.rating, 5);
  assert.match(await service.orderInvoice({ buyerId: 'owner-1', orderId: placed.order.id }), /FitFlex Marketplace Invoice/);
  const reorder = await service.reorder({ buyerId: 'owner-1', orderId: placed.order.id });
  assert.deepEqual(reorder.items, [{ productId, qty: 1 }]);
});
