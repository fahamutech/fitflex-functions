// Unit tests for the marketplace service.
// Run with: node --test specs/marketplace.specs.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarketplaceService } from '../src/services/marketplace-service.mjs';
import {
  PRODUCT_CATEGORIES,
  ORDER_STATUS,
  DELIVERY_FEE_BASE_TZS,
  DELIVERY_FEE_PER_KM_TZS,
  VENDOR_COMMISSION_RANGE,
  ESCROW_RELEASE_HOURS,
  MAX_CART_ITEMS,
  MAX_QUANTITY_PER_ITEM,
  calculateDeliveryFee,
  generateCollectionCode
} from '../src/shared/marketplace-constants.mjs';

// ─── Mock store ──────────────────────────────────────────────────────────────
function createStore() {
  const data = { users: [], gyms: [], vendors: [], products: [], product_reviews: [], marketplace_orders: [], cart: [], audit_log: [] };
  function collection(name) {
    return {
      _data: data[name],
      all: () => data[name],
      find: pred => data[name].find(pred),
      filter: pred => data[name].filter(pred),
      some: pred => data[name].some(pred),
      insert: row => { data[name].push(row); return row; },
      update: (pred, patch) => {
        const i = data[name].findIndex(pred);
        if (i >= 0) data[name][i] = { ...data[name][i], ...patch };
        return data[name].find(pred);
      },
      remove: pred => {
        const i = data[name].findIndex(pred);
        if (i >= 0) return data[name].splice(i, 1)[0];
        return null;
      }
    };
  }
  return { data, collection };
}

function setupTestEnv() {
  const { data, collection } = createStore();

  data.users = [{ id: 'usr_member1', displayName: 'Aisha', userType: 'member' }];
  data.gyms = [{ id: 'gym_001', name: 'Power Gym Mikocheni', status: 'active', distance: 5 }];

  // Active vendor
  data.vendors = [{
    id: 'ven_001', userId: 'usr_vendor', name: 'Bongo Elite',
    status: 'active', commissionRate: 0.12
  }];

  // Active products
  data.products = [
    { id: 'prod_001', vendorId: 'ven_001', name: 'Whey Protein 1kg', category: 'supplements', subcategory: 'Protein', price: 120000, stock: 50, isDigital: false, status: 'active', rating: 0, reviewCount: 0 },
    { id: 'prod_002', vendorId: 'ven_001', name: 'Yoga Mat 6mm', category: 'equipment', subcategory: 'Flexibility', price: 45000, stock: 30, isDigital: false, status: 'active', rating: 0, reviewCount: 0 },
    { id: 'prod_003', vendorId: 'ven_001', name: 'Kilimanjaro Marathon Entry', category: 'events', subcategory: 'Marathons & Runs', price: 45000, stock: -1, isDigital: true, status: 'active', rating: 0, reviewCount: 0 }
  ];

  const svc = createMarketplaceService({
    users: collection('users'),
    gyms: collection('gyms'),
    vendors: collection('vendors'),
    products: collection('products'),
    productReviews: collection('product_reviews'),
    orders: collection('marketplace_orders'),
    cart: collection('cart'),
    auditLog: collection('audit_log')
  });

  return { data, svc };
}

// ═══════════════════════════════════════════════════════════════════════════
// DELIVERY FEE TESTS
// ═══════════════════════════════════════════════════════════════════════════
test('Delivery fee: base + per-km for physical items', () => {
  assert.equal(calculateDeliveryFee({ category: 'supplements', distanceKm: 5 }), 3000 + 5 * 1500);
  assert.equal(calculateDeliveryFee({ category: 'equipment', distanceKm: 10 }), 3000 + 10 * 1500);
  assert.equal(calculateDeliveryFee({ category: 'apparel', distanceKm: 0 }), 3000);
});

test('Delivery fee: zero for digital items (events, services)', () => {
  assert.equal(calculateDeliveryFee({ category: 'events', distanceKm: 100 }), 0);
  assert.equal(calculateDeliveryFee({ category: 'services', distanceKm: 50 }), 0);
});

test('Collection code format: FF-COL-XXXX', () => {
  const code = generateCollectionCode();
  assert.match(code, /^FF-COL-[A-Z0-9]{4}$/);
});

// ═══════════════════════════════════════════════════════════════════════════
// PRODUCT TESTS
// ═══════════════════════════════════════════════════════════════════════════
test('List products with category filter', () => {
  const { svc } = setupTestEnv();
  const supplements = svc.listProducts({ category: 'supplements' });
  assert.equal(supplements.length, 1);
  assert.equal(supplements[0].name, 'Whey Protein 1kg');
});

test('List products with search', () => {
  const { svc } = setupTestEnv();
  const results = svc.listProducts({ search: 'yoga' });
  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'Yoga Mat 6mm');
});

test('List products sorted by price low to high', () => {
  const { svc } = setupTestEnv();
  const results = svc.listProducts({ sortBy: 'price_low' });
  assert.equal(results[0].price, 45000);  // Yoga Mat
  assert.equal(results[1].price, 45000);  // Marathon (also 45000)
  assert.equal(results[2].price, 120000); // Whey Protein
});

test('Get product detail', () => {
  const { svc } = setupTestEnv();
  const product = svc.getProduct('prod_001');
  assert.ok(product);
  assert.equal(product.name, 'Whey Protein 1kg');
  assert.equal(product.vendorName, 'Bongo Elite');
});

test('Get non-existent product returns null', () => {
  const { svc } = setupTestEnv();
  assert.equal(svc.getProduct('nonexistent'), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// CART TESTS
// ═══════════════════════════════════════════════════════════════════════════
test('Add to cart', () => {
  const { svc } = setupTestEnv();
  const result = svc.addToCart({ memberId: 'usr_member1', productId: 'prod_001', quantity: 2 });
  assert.ok(result.ok);
  assert.equal(result.cart.items.length, 1);
  assert.equal(result.cart.items[0].quantity, 2);
});

test('Add same product twice increases quantity', () => {
  const { svc } = setupTestEnv();
  svc.addToCart({ memberId: 'usr_member1', productId: 'prod_001', quantity: 1 });
  svc.addToCart({ memberId: 'usr_member1', productId: 'prod_001', quantity: 2 });
  const cart = svc.getCart('usr_member1');
  assert.equal(cart.items.length, 1);
  assert.equal(cart.items[0].quantity, 3);
});

test('Remove from cart', () => {
  const { svc } = setupTestEnv();
  svc.addToCart({ memberId: 'usr_member1', productId: 'prod_001' });
  svc.addToCart({ memberId: 'usr_member1', productId: 'prod_002' });
  svc.removeFromCart({ memberId: 'usr_member1', productId: 'prod_001' });
  const cart = svc.getCart('usr_member1');
  assert.equal(cart.items.length, 1);
  assert.equal(cart.items[0].productId, 'prod_002');
});

test('Cart subtotal is correct', () => {
  const { svc } = setupTestEnv();
  svc.addToCart({ memberId: 'usr_member1', productId: 'prod_001', quantity: 2 });  // 120000 × 2 = 240000
  svc.addToCart({ memberId: 'usr_member1', productId: 'prod_002', quantity: 1 });  // 45000 × 1 = 45000
  const cart = svc.getCart('usr_member1');
  assert.equal(cart.subtotal, 285000);
});

test('Cannot add out-of-stock physical product', () => {
  const { data, svc } = setupTestEnv();
  data.products[0].stock = 0;
  const result = svc.addToCart({ memberId: 'usr_member1', productId: 'prod_001' });
  assert.ok(!result.ok);
  assert.equal(result.error, 'out_of_stock');
});

test('Cannot add non-existent product', () => {
  const { svc } = setupTestEnv();
  const result = svc.addToCart({ memberId: 'usr_member1', productId: 'nonexistent' });
  assert.ok(!result.ok);
  assert.equal(result.error, 'product_not_found');
});

test('Quantity must be 1-99', () => {
  const { svc } = setupTestEnv();
  assert.ok(!svc.addToCart({ memberId: 'usr_member1', productId: 'prod_001', quantity: 0 }).ok);
  assert.ok(!svc.addToCart({ memberId: 'usr_member1', productId: 'prod_001', quantity: 100 }).ok);
  assert.ok(svc.addToCart({ memberId: 'usr_member1', productId: 'prod_002', quantity: 50 }).ok);
});

// ═══════════════════════════════════════════════════════════════════════════
// CHECKOUT & ORDER TESTS
// ═══════════════════════════════════════════════════════════════════════════
test('Checkout with physical items requires pickup gym', () => {
  const { svc } = setupTestEnv();
  svc.addToCart({ memberId: 'usr_member1', productId: 'prod_001', quantity: 1 });
  const result = svc.checkout({ memberId: 'usr_member1' });  // no pickupGymId
  assert.ok(!result.ok);
  assert.equal(result.error, 'pickup_gym_required_for_physical_items');
});

test('Checkout creates order with collection code', () => {
  const { svc } = setupTestEnv();
  svc.addToCart({ memberId: 'usr_member1', productId: 'prod_001', quantity: 2 });  // 240000
  const result = svc.checkout({
    memberId: 'usr_member1',
    pickupGymId: 'gym_001',
    paymentMethod: 'mpesa',
    paymentPhone: '+255712111222'
  });
  assert.ok(result.ok);
  assert.ok(result.order.collectionCode);
  assert.match(result.order.collectionCode, /^FF-COL-/);
  assert.equal(result.order.status, 'pending');
  assert.equal(result.order.paymentStatus, 'pending');
});

test('Checkout calculates delivery fee for physical items', () => {
  const { svc } = setupTestEnv();
  svc.addToCart({ memberId: 'usr_member1', productId: 'prod_001', quantity: 1 });  // 120000
  const result = svc.checkout({ memberId: 'usr_member1', pickupGymId: 'gym_001' });
  // gym distance = 5km → fee = 3000 + 5×1500 = 10500
  assert.equal(result.order.deliveryFee, 10500);
  assert.equal(result.order.subtotal, 120000);
  assert.equal(result.order.total, 130500);
});

test('Checkout digital-only items have no delivery fee and no gym required', () => {
  const { svc } = setupTestEnv();
  svc.addToCart({ memberId: 'usr_member1', productId: 'prod_003', quantity: 1 });  // Marathon ticket (digital)
  const result = svc.checkout({ memberId: 'usr_member1' });  // no gym needed
  assert.ok(result.ok);
  assert.equal(result.order.deliveryFee, 0);
  assert.equal(result.order.isDigitalOnly, true);
  assert.equal(result.order.collectionCode, null);
  assert.equal(result.order.pickupGymId, null);
});

test('Checkout clears cart after order creation', () => {
  const { svc } = setupTestEnv();
  svc.addToCart({ memberId: 'usr_member1', productId: 'prod_001', quantity: 1 });
  svc.checkout({ memberId: 'usr_member1', pickupGymId: 'gym_001' });
  const cart = svc.getCart('usr_member1');
  assert.equal(cart.items.length, 0);
});

test('Cannot checkout empty cart', () => {
  const { svc } = setupTestEnv();
  const result = svc.checkout({ memberId: 'usr_member1', pickupGymId: 'gym_001' });
  assert.ok(!result.ok);
  assert.equal(result.error, 'cart_empty');
});

test('Order has vendor breakdown with commission split', () => {
  const { svc } = setupTestEnv();
  svc.addToCart({ memberId: 'usr_member1', productId: 'prod_001', quantity: 1 });  // 120000
  const result = svc.checkout({ memberId: 'usr_member1', pickupGymId: 'gym_001' });
  const vBreak = result.order.vendorBreakdown[0];
  assert.equal(vBreak.vendorId, 'ven_001');
  assert.equal(vBreak.gross, 120000);
  assert.equal(vBreak.commission, Math.round(120000 * 0.12));  // 14400
  assert.equal(vBreak.payout, 120000 - 14400);  // 105600
});

// ═══════════════════════════════════════════════════════════════════════════
// ORDER STATUS TRANSITION TESTS
// ═══════════════════════════════════════════════════════════════════════════
test('Order transitions: pending → paid → pre_delivery → dispatched → custody → collected', () => {
  const { svc } = setupTestEnv();
  svc.addToCart({ memberId: 'usr_member1', productId: 'prod_001', quantity: 1 });
  const { order } = svc.checkout({ memberId: 'usr_member1', pickupGymId: 'gym_001' });

  // pending → paid
  let r = svc.transitionOrder(order.id, 'paid', 'test');
  assert.ok(r.ok);
  assert.equal(r.order.status, 'paid');

  // paid → pre_delivery
  r = svc.transitionOrder(order.id, 'pre_delivery', 'ven_001');
  assert.ok(r.ok);
  assert.equal(r.order.status, 'pre_delivery');

  // pre_delivery → dispatched
  r = svc.transitionOrder(order.id, 'dispatched', 'ven_001');
  assert.ok(r.ok);
  assert.equal(r.order.status, 'dispatched');

  // dispatched → custody
  r = svc.transitionOrder(order.id, 'custody', 'operator');
  assert.ok(r.ok);
  assert.equal(r.order.status, 'custody');

  // custody → collected
  r = svc.transitionOrder(order.id, 'collected', 'operator');
  assert.ok(r.ok);
  assert.equal(r.order.status, 'collected');
  // Escrow release time should be set (48h from now)
  assert.ok(r.order.escrowReleaseAt);
});

test('Invalid transition is rejected', () => {
  const { svc } = setupTestEnv();
  svc.addToCart({ memberId: 'usr_member1', productId: 'prod_001', quantity: 1 });
  const { order } = svc.checkout({ memberId: 'usr_member1', pickupGymId: 'gym_001' });
  // pending → collected (not allowed — must go through paid first)
  const r = svc.transitionOrder(order.id, 'collected', 'test');
  assert.ok(!r.ok);
});

test('Collection code verification', () => {
  const { svc } = setupTestEnv();
  svc.addToCart({ memberId: 'usr_member1', productId: 'prod_001', quantity: 1 });
  const { order } = svc.checkout({ memberId: 'usr_member1', pickupGymId: 'gym_001' });

  // Move to custody first
  svc.transitionOrder(order.id, 'paid', 'test');
  svc.transitionOrder(order.id, 'pre_delivery', 'ven_001');
  svc.transitionOrder(order.id, 'dispatched', 'ven_001');
  svc.transitionOrder(order.id, 'custody', 'operator');

  // Now verify collection code
  const result = svc.gymVerifyCollection({ collectionCode: order.collectionCode, operatorId: 'operator' });
  assert.ok(result.ok);
  assert.equal(result.order.status, 'collected');
});

test('Invalid collection code is rejected', () => {
  const { svc } = setupTestEnv();
  const result = svc.gymVerifyCollection({ collectionCode: 'FF-COL-XXXX', operatorId: 'operator' });
  assert.ok(!result.ok);
});

// ═══════════════════════════════════════════════════════════════════════════
// VENDOR TESTS
// ═══════════════════════════════════════════════════════════════════════════
test('Vendor onboarding creates pending vendor', () => {
  const { svc, data } = setupTestEnv();
  const result = svc.onboardVendor({
    userId: 'usr_new', name: 'New Vendor', email: 'new@vendor.co.tz',
    phone: '+255700000000', city: 'Arusha', commissionRate: 0.12
  });
  assert.ok(result.ok);
  assert.equal(result.vendor.status, 'pending');
  assert.equal(result.vendor.commissionRate, 0.12);
});

test('Vendor commission must be 10-15%', () => {
  const { svc } = setupTestEnv();
  assert.ok(!svc.onboardVendor({ userId: 'x', commissionRate: 0.05 }).ok);
  assert.ok(!svc.onboardVendor({ userId: 'x', commissionRate: 0.20 }).ok);
  assert.ok(svc.onboardVendor({ userId: 'x', commissionRate: 0.10 }).ok);
  assert.ok(svc.onboardVendor({ userId: 'x', commissionRate: 0.15 }).ok);
});

test('Admin can approve vendor', () => {
  const { svc } = setupTestEnv();
  const { vendor } = svc.onboardVendor({ userId: 'usr_new2', name: 'New2', commissionRate: 0.12 });
  const result = svc.approveVendor(vendor.id, 'admin');
  assert.ok(result.ok);
  assert.equal(result.vendor.status, 'active');
});

test('Vendor dashboard shows correct stats', () => {
  const { svc } = setupTestEnv();
  // Create a completed order
  svc.addToCart({ memberId: 'usr_member1', productId: 'prod_001', quantity: 1 });
  const { order } = svc.checkout({ memberId: 'usr_member1', pickupGymId: 'gym_001' });
  svc.transitionOrder(order.id, 'paid', 'test');
  svc.transitionOrder(order.id, 'pre_delivery', 'ven_001');
  svc.transitionOrder(order.id, 'dispatched', 'ven_001');
  svc.transitionOrder(order.id, 'custody', 'operator');
  svc.transitionOrder(order.id, 'collected', 'operator');

  const dashboard = svc.getVendorDashboard('ven_001');
  assert.ok(dashboard);
  assert.equal(dashboard.stats.gmv, 120000);
  assert.equal(dashboard.stats.netRevenue, 105600);  // 120000 - 12% = 105600
  assert.equal(dashboard.stats.completedOrders, 1);
  assert.equal(dashboard.stats.activeCatalogSize, 3);
});

// ═══════════════════════════════════════════════════════════════════════════
// PRODUCT REVIEW TESTS
// ═══════════════════════════════════════════════════════════════════════════
test('Member can review a purchased product', () => {
  const { svc } = setupTestEnv();
  svc.addToCart({ memberId: 'usr_member1', productId: 'prod_001', quantity: 1 });
  const { order } = svc.checkout({ memberId: 'usr_member1', pickupGymId: 'gym_001' });
  svc.transitionOrder(order.id, 'paid', 'test');

  const result = svc.submitProductReview({
    memberId: 'usr_member1', productId: 'prod_001',
    rating: 5, text: 'Great protein powder!'
  });
  assert.ok(result.ok);
  assert.equal(result.review.rating, 5);
});

test('Cannot review a product without purchasing', () => {
  const { svc } = setupTestEnv();
  const result = svc.submitProductReview({
    memberId: 'usr_member1', productId: 'prod_001',
    rating: 5, text: "Haven't bought but looks good"
  });
  assert.ok(!result.ok);
  assert.equal(result.error, 'must_purchase_to_review');
});

test('Rating must be 1-5 integer', () => {
  const { svc } = setupTestEnv();
  svc.addToCart({ memberId: 'usr_member1', productId: 'prod_001', quantity: 1 });
  const { order } = svc.checkout({ memberId: 'usr_member1', pickupGymId: 'gym_001' });
  svc.transitionOrder(order.id, 'paid', 'test');

  assert.ok(!svc.submitProductReview({ memberId: 'usr_member1', productId: 'prod_001', rating: 0 }).ok);
  assert.ok(!svc.submitProductReview({ memberId: 'usr_member1', productId: 'prod_001', rating: 6 }).ok);
  assert.ok(!svc.submitProductReview({ memberId: 'usr_member1', productId: 'prod_001', rating: 3.5 }).ok);
});

// ═══════════════════════════════════════════════════════════════════════════
// PAYMENT CONFIRMATION TESTS
// ═══════════════════════════════════════════════════════════════════════════
test('Payment confirmation transitions order to paid + decrements stock', () => {
  const { data, svc } = setupTestEnv();
  svc.addToCart({ memberId: 'usr_member1', productId: 'prod_001', quantity: 2 });
  const { order } = svc.checkout({ memberId: 'usr_member1', pickupGymId: 'gym_001' });

  const initialStock = data.products.find(p => p.id === 'prod_001').stock;
  const result = svc.confirmPayment(order.id, 'sel_test_123');
  assert.ok(result.ok);

  const updatedOrder = svc.getOrder(order.id);
  assert.equal(updatedOrder.paymentStatus, 'paid');
  assert.equal(updatedOrder.status, 'paid');

  const updatedStock = data.products.find(p => p.id === 'prod_001').stock;
  assert.equal(updatedStock, initialStock - 2);
});

test('Double payment confirmation is rejected', () => {
  const { svc } = setupTestEnv();
  svc.addToCart({ memberId: 'usr_member1', productId: 'prod_001', quantity: 1 });
  const { order } = svc.checkout({ memberId: 'usr_member1', pickupGymId: 'gym_001' });
  svc.confirmPayment(order.id, 'ref1');
  const result = svc.confirmPayment(order.id, 'ref2');
  assert.ok(!result.ok);
  assert.equal(result.error, 'payment_already_processed');
});

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS TESTS
// ═══════════════════════════════════════════════════════════════════════════
test('Product categories are correct', () => {
  assert.equal(Object.keys(PRODUCT_CATEGORIES).length, 5);
  assert.ok(PRODUCT_CATEGORIES.supplements);
  assert.ok(PRODUCT_CATEGORIES.equipment);
  assert.ok(PRODUCT_CATEGORIES.apparel);
  assert.ok(PRODUCT_CATEGORIES.events);
  assert.ok(PRODUCT_CATEGORIES.services);
});

test('Digital categories have no delivery fee', () => {
  assert.equal(calculateDeliveryFee({ category: 'events', distanceKm: 100 }), 0);
  assert.equal(calculateDeliveryFee({ category: 'services', distanceKm: 100 }), 0);
});

test('Vendor commission range is 10-15%', () => {
  assert.equal(VENDOR_COMMISSION_RANGE.min, 0.10);
  assert.equal(VENDOR_COMMISSION_RANGE.max, 0.15);
  assert.equal(VENDOR_COMMISSION_RANGE.default, 0.12);
});

test('Escrow release window is 48 hours', () => {
  assert.equal(ESCROW_RELEASE_HOURS, 48);
});

test('Cart limits are correct', () => {
  assert.equal(MAX_CART_ITEMS, 50);
  assert.equal(MAX_QUANTITY_PER_ITEM, 99);
});
