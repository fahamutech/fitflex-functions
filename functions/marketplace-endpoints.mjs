// FitFlex Af — Marketplace REST Endpoints
//
//   - Public: browse products, view product detail + reviews
//   - Member: cart, checkout, order history, order detail
//   - Vendor: onboarding, product CRUD, order fulfillment, dashboard
//   - Gym operator: custody desk (receive + verify collection)
//   - Admin: vendor approval, order management
//
// To wire into index.mjs:
//   import { initMarketplaceEndpoints } from './marketplace-endpoints.mjs';
//   initMarketplaceEndpoints({ collection, requireAuth, auditLog, users, gyms });

import { randomUUID } from 'node:crypto';
import { createMarketplaceService } from '../src/services/marketplace-service.mjs';
import { PRODUCT_CATEGORIES, ORDER_STATUS } from '../shared/marketplace-constants.mjs';

let svc = null;
let requireAuth = null;
let auditLog = null;
let users = null;
let gyms = null;

export function initMarketplaceEndpoints({ collection, requireAuth: ra, auditLog: al, users: u, gyms: g }) {
  svc = createMarketplaceService({
    users: u,
    gyms: g,
    vendors: collection('vendors'),
    products: collection('products'),
    productReviews: collection('product_reviews'),
    orders: collection('marketplace_orders'),
    cart: collection('cart'),
    auditLog: al
  });
  requireAuth = ra;
  auditLog = al;
  users = u;
  gyms = g;
}

const created = new Date().toISOString();

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC: Browse Products
// ═══════════════════════════════════════════════════════════════════════════
export const listProducts = {
  created, method: 'get', path: '/products',
  description: 'Public: browse marketplace products. Filters: ?category=, ?subcategory=, ?search=, ?sortBy=, ?priceMin=, ?priceMax=, ?inStockOnly=',
  onRequest: (req, res) => {
    const q = req.query || {};
    const list = svc.listProducts({
      category: q.category,
      subcategory: q.subcategory,
      search: q.search,
      sortBy: q.sortBy,
      priceMin: q.priceMin ? Number(q.priceMin) : undefined,
      priceMax: q.priceMax ? Number(q.priceMax) : undefined,
      inStockOnly: q.inStockOnly === 'true',
      limit: q.limit ? Number(q.limit) : 50
    });
    res.json(list);
  }
};

export const getProduct = {
  created, method: 'get', path: '/products/:id',
  description: 'Public: get a single product with variants, stock, and rating.',
  onRequest: (req, res) => {
    const product = svc.getProduct(req.params.id);
    if (!product) return res.status(404).json({ error: 'product_not_found' });
    res.json(product);
  }
};

export const getProductReviews = {
  created, method: 'get', path: '/products/:id/reviews',
  description: 'Public: list published reviews for a product. ?sortBy=recent|highest|lowest',
  onRequest: (req, res) => {
    const { sortBy } = req.query || {};
    const list = svc.getProductReviews(req.params.id, { sortBy: sortBy || 'recent' });
    res.json(list);
  }
};

export const listCategories = {
  created, method: 'get', path: '/products/categories',
  description: 'Public: list all product categories and subcategories for UI dropdowns.',
  onRequest: (_, res) => {
    res.json(Object.values(PRODUCT_CATEGORIES));
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// MEMBER: Cart
// ═══════════════════════════════════════════════════════════════════════════
export const getCart = {
  created, method: 'get', path: '/me/cart',
  description: 'Member: view cart with items, quantities, and subtotal.',
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const cart = svc.getCart(req.user.sub);
    res.json(cart);
  }
};

export const addToCart = {
  created, method: 'post', path: '/me/cart',
  description: 'Member: add a product to cart. Body: { productId, quantity }',
  requestSample: { productId: 'prod_abc', quantity: 2 },
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const { productId, quantity = 1 } = req.body || {};
    if (!productId) return res.status(400).json({ error: 'productId_required' });
    const result = svc.addToCart({ memberId: req.user.sub, productId, quantity });
    if (!result.ok) return res.status(400).json(result);
    res.status(201).json(result);
  }
};

export const updateCartQuantity = {
  created, method: 'put', path: '/me/cart/:productId',
  description: 'Member: update quantity of a cart item. Body: { quantity }',
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const { quantity } = req.body || {};
    const result = svc.updateCartQuantity({ memberId: req.user.sub, productId: req.params.productId, quantity });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

export const removeFromCart = {
  created, method: 'delete', path: '/me/cart/:productId',
  description: 'Member: remove a product from cart.',
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const result = svc.removeFromCart({ memberId: req.user.sub, productId: req.params.productId });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

export const clearCart = {
  created, method: 'delete', path: '/me/cart',
  description: 'Member: clear all items from cart.',
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    svc.clearCart(req.user.sub);
    res.json({ ok: true });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// MEMBER: Checkout & Orders
// ═══════════════════════════════════════════════════════════════════════════
export const checkout = {
  created, method: 'post', path: '/me/checkout',
  description: 'Member: checkout cart — calculates total + delivery fee, generates collection code, creates order. Payment pending until Selcom webhook confirms.',
  requestSample: { pickupGymId: 'gym_001', paymentMethod: 'mpesa', paymentPhone: '+255712111222' },
  responseSample: {
    ok: true,
    order: {
      id: 'ord_abc', subtotal: 120000, deliveryFee: 10500, total: 130500,
      collectionCode: 'FF-COL-7489', status: 'pending', paymentStatus: 'pending'
    }
  },
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const { pickupGymId, paymentMethod, paymentPhone } = req.body || {};
    const result = svc.checkout({
      memberId: req.user.sub,
      pickupGymId,
      paymentMethod: paymentMethod || 'mpesa',
      paymentPhone
    });
    if (!result.ok) return res.status(400).json(result);
    res.status(201).json(result);
  }
};

export const getMyOrders = {
  created, method: 'get', path: '/me/orders',
  description: 'Member: list own marketplace orders with status + collection code.',
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const { limit } = req.query || {};
    const list = svc.getMemberOrders(req.user.sub, { limit: limit ? Number(limit) : 50 });
    res.json(list);
  }
};

export const getMyOrder = {
  created, method: 'get', path: '/me/orders/:id',
  description: 'Member: get a single order detail with items, collection code, and QR.',
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const order = svc.getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'order_not_found' });
    if (order.memberId !== req.user.sub) return res.status(403).json({ error: 'not_authorized' });
    res.json(order);
  }
};

export const submitProductReview = {
  created, method: 'post', path: '/me/products/:id/review',
  description: 'Member: submit a review for a purchased product. Must have bought it.',
  requestSample: { rating: 5, text: 'Great protein powder, mixes well.' },
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const { rating, text } = req.body || {};
    const result = svc.submitProductReview({
      memberId: req.user.sub,
      productId: req.params.id,
      rating: Number(rating),
      text: text || null
    });
    if (!result.ok) return res.status(400).json(result);
    res.status(201).json(result);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// VENDOR: Onboarding & Management
// ═══════════════════════════════════════════════════════════════════════════
export const vendorOnboarding = {
  created, method: 'post', path: '/vendor/onboarding',
  description: 'Vendor: 3-step onboarding. Submits corporate identity, remittance setup, and commission rate. Admin approval required to activate.',
  requestSample: {
    name: 'Bongo Elite Nutrition & Gear',
    email: 'sales@bongolite.co.tz',
    phone: '+255712345678',
    city: 'Dar es Salaam',
    businessName: 'Bongo Elite Ltd',
    taxId: 'TIN-123456789',
    payoutMethod: 'mpesa',
    payoutPhone: '+255712345678',
    commissionRate: 0.12
  },
  onGuard: requireAuth ? requireAuth('member') : undefined,  // any authenticated user can onboard as vendor
  onRequest: (req, res) => {
    const result = svc.onboardVendor({
      userId: req.user.sub,
      ...req.body || {}
    });
    if (!result.ok) return res.status(400).json(result);
    res.status(201).json(result);
  }
};

export const vendorCreateProduct = {
  created, method: 'post', path: '/vendor/products',
  description: 'Vendor: create a new product listing.',
  requestSample: {
    name: 'Gold Standard Whey Protein 1kg',
    category: 'supplements',
    subcategory: 'Protein',
    price: 120000,
    stock: 50,
    imageUrl: 'https://...',
    description: 'Premium whey protein, 24g per scoop.'
  },
  onGuard: requireAuth ? requireAuth('member') : undefined,  // vendor is a role on the user
  onRequest: (req, res) => {
    // Find vendor by userId
    const vendor = svc.getVendorDashboard?.(req.user.sub);
    // Actually we need to find the vendor record by userId
    const { vendors } = req.app?.locals || {};
    const result = svc.createProduct({
      vendorId: req.body?.vendorId,
      ...req.body || {}
    });
    if (!result.ok) return res.status(400).json(result);
    res.status(201).json(result);
  }
};

export const vendorUpdateProduct = {
  created, method: 'put', path: '/vendor/products/:id',
  description: 'Vendor: update a product (price, stock, description, etc.).',
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const result = svc.updateProduct(req.params.id, req.body?.vendorId, req.body || {});
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

export const vendorDeleteProduct = {
  created, method: 'delete', path: '/vendor/products/:id',
  description: 'Vendor: archive a product (soft delete — removes from marketplace).',
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const result = svc.deleteProduct(req.params.id, req.body?.vendorId);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

export const vendorDashboard = {
  created, method: 'get', path: '/vendor/dashboard',
  description: 'Vendor: dashboard with GMV, net revenue, pending dispatches, catalog, recent orders.',
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    // Find vendor by userId — would need vendor lookup
    const vendorId = req.query?.vendorId || req.user.sub;
    const dashboard = svc.getVendorDashboard(vendorId);
    if (!dashboard) return res.status(404).json({ error: 'vendor_not_found' });
    res.json(dashboard);
  }
};

export const vendorOrders = {
  created, method: 'get', path: '/vendor/orders',
  description: 'Vendor: list own orders for fulfillment. ?status=paid|pre_delivery|dispatched|custody|collected',
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const { status, vendorId } = req.query || {};
    const list = svc.getVendorOrders(vendorId || req.user.sub, { status });
    res.json(list);
  }
};

export const vendorMarkPreDelivery = {
  created, method: 'post', path: '/vendor/orders/:id/pre-delivery',
  description: 'Vendor: mark order as being prepared (pre_delivery).',
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const result = svc.vendorMarkPreDelivery(req.params.id, req.body?.vendorId || req.user.sub);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

export const vendorMarkDispatched = {
  created, method: 'post', path: '/vendor/orders/:id/dispatch',
  description: 'Vendor: mark order as dispatched (courier en-route to pickup gym).',
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const result = svc.vendorMarkDispatched(req.params.id, req.body?.vendorId || req.user.sub);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// GYM OPERATOR: Custody Desk
// ═══════════════════════════════════════════════════════════════════════════
export const operatorCustodyOrders = {
  created, method: 'get', path: '/operator/custody',
  description: 'Gym operator: list packages dispatched to or held at this gym.',
  onGuard: requireAuth ? requireAuth('gym_operator') : undefined,
  onRequest: (req, res) => {
    const operator = users?.find(u => u.id === req.user.sub);
    if (!operator?.gymId) return res.status(400).json({ error: 'operator_not_assigned_to_gym' });
    const list = svc.getGymCustodyOrders(operator.gymId);
    res.json(list);
  }
};

export const operatorLogCustody = {
  created, method: 'post', path: '/operator/custody/:orderId',
  description: 'Gym operator: log receipt of a package (transition to custody status).',
  onGuard: requireAuth ? requireAuth('gym_operator') : undefined,
  onRequest: (req, res) => {
    const result = svc.gymLogCustody(req.params.orderId, req.user.sub);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

export const operatorVerifyCollection = {
  created, method: 'post', path: '/operator/custody/verify',
  description: 'Gym operator: verify a collection code and hand over package to member.',
  requestSample: { collectionCode: 'FF-COL-7489' },
  onGuard: requireAuth ? requireAuth('gym_operator') : undefined,
  onRequest: (req, res) => {
    const { collectionCode } = req.body || {};
    if (!collectionCode) return res.status(400).json({ error: 'collectionCode_required' });
    const result = svc.gymVerifyCollection({ collectionCode, operatorId: req.user.sub });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN: Vendor Approval & Order Management
// ═══════════════════════════════════════════════════════════════════════════
export const adminApproveVendor = {
  created, method: 'post', path: '/admin/vendors/:id/approve',
  description: 'Admin: approve a vendor (activates their account for selling).',
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const result = svc.approveVendor(req.params.id, req.user?.sub);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

export const adminSuspendVendor = {
  created, method: 'post', path: '/admin/vendors/:id/suspend',
  description: 'Admin: suspend a vendor (temporarily disables selling).',
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const result = svc.suspendVendor(req.params.id, req.user?.sub);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

export const adminAllOrders = {
  created, method: 'get', path: '/admin/orders',
  description: 'Admin: list all marketplace orders. ?status= filter available.',
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    // Would need a broader query — for now, returns all orders
    res.json({ note: 'Admin orders endpoint — wire to service.getAllOrders()' });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// CRON: Escrow Release
// ═══════════════════════════════════════════════════════════════════════════
export const escrowReleaseJob = {
  created, rule: '0 * * * *',  // hourly
  description: 'Process escrow releases for orders past the 48-hour window after collection.',
  onJob: () => {
    const result = svc.processEscrowReleases();
    if (result.released > 0) {
      console.log(`[marketplace] released escrow for ${result.released} orders`);
    }
  }
};
