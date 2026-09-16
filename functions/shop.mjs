// D1 — Shop / vendor e-commerce REST surface (phase 1: catalogue + orders).
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { shopService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

function requireVendorPermission(permission) {
  return async (req, res, next) => {
    if (req.user?.userType !== 'vendor_staff') return next();
    try {
      if (await shopService.authorizeStaff(req.user, permission)) return next();
    } catch (error) {
      console.error('[marketplace] staff authorization lookup failed', { staffId: req.user.sub, error: error.message });
      return res.status(503).json({ error: 'authorization_unavailable' });
    }
    return res.status(403).json({ error: 'vendor_permission_forbidden', requiredPermission: permission });
  };
}

// ── catalogue ────────────────────────────────────────────────────────────────

export const listShopProducts = {
  created, method: 'get', path: '/shop/products',
  description: 'Any signed-in user: browse the shop catalogue. Query: ?category=&search=.',
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    const { category, search, brand, vendorId, minPrice, maxPrice, minRating, maxDistanceKm, delivery, promotions, sort } = req.query || {};
    res.json(await shopService.listProducts({ category, search, brand, vendorId, minPrice, maxPrice, minRating, maxDistanceKm, delivery, promotions, sort }));
  }
};

export const getShopProduct = {
  created, method: 'get', path: '/shop/products/:id',
  description: 'Buyer: product details, vendor, reviews and similar products.',
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    const product = await shopService.getProduct(req.params.id);
    if (!product) return res.status(404).json({ error: 'product_not_found' });
    res.json(product);
  },
};

export const getVendorStore = {
  created, method: 'get', path: '/shop/vendors/:id',
  description: 'Buyer: public vendor storefront.', onGuard: requireAuth(),
  onRequest: async (req, res) => {
    const store = await shopService.getVendorStore(req.params.id);
    if (!store) return res.status(404).json({ error: 'vendor_not_found' });
    res.json(store);
  },
};

export const vendorMyProducts = {
  created, method: 'get', path: '/vendor/products',
  description: 'Vendor: list own products (including archived).',
  onGuard: [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('products')],
  onRequest: async (req, res) => {
    res.json(await shopService.listProducts({ vendorId: req.user.vendorId || req.user.sub, includeArchived: true }));
  }
};

export const vendorCreateProduct = {
  created, method: 'post', path: '/vendor/products',
  description: 'Vendor: create a product.',
  requestSample: { name: 'Whey Protein 1kg', category: 'supplements', priceTzs: 85000, stock: 20 },
  onGuard: [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('products')],
  onRequest: async (req, res) => {
    const result = await shopService.upsertProduct({ vendorId: req.user.vendorId || req.user.sub, body: req.body || {} });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(201).json(result.product);
  }
};

export const vendorUpdateProduct = {
  created, method: 'put', path: '/vendor/products/:id',
  description: 'Vendor: update own product (price, stock, status...).',
  onGuard: [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('products')],
  onRequest: async (req, res) => {
    const result = await shopService.upsertProduct({
      vendorId: req.user.vendorId || req.user.sub, body: req.body || {}, productId: req.params.id,
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.product);
  }
};

export const vendorDuplicateProduct = {
  created, method: 'post', path: '/vendor/products/:id/duplicate',
  description: 'Vendor: duplicate an owned product as a pending listing.',
  onGuard: [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('products')],
  onRequest: async (req, res) => {
    const result = await shopService.duplicateProduct({ vendorId: req.user.vendorId || req.user.sub, productId: req.params.id });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(201).json(result.product);
  },
};

export const vendorDeleteProduct = {
  created, method: 'delete', path: '/vendor/products/:id',
  description: 'Vendor: soft-delete an owned product.',
  onGuard: [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('products')],
  onRequest: async (req, res) => {
    const result = await shopService.deleteProduct({ vendorId: req.user.vendorId || req.user.sub, productId: req.params.id });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  },
};

export const vendorProfile = {
  created, method: 'get', path: '/vendor/profile', description: 'Vendor: view business profile.',
  onGuard: requireAuth('vendor', 'vendor_staff', 'admin'),
  onRequest: async (req, res) => res.json(await shopService.getVendorProfile(req.user.vendorId || req.user.sub) || {}),
};
export const vendorSaveProfile = {
  created, method: 'put', path: '/vendor/profile', description: 'Vendor: create, edit or publish business profile.',
  onGuard: requireAuth('vendor', 'admin'),
  onRequest: async (req, res) => {
    const result = await shopService.saveVendorProfile({ vendorId: req.user.sub, body: req.body || {} });
    if (result.error) return res.status(result.status).json({ error: result.error, missing: result.missing });
    res.json(result.profile);
  },
};

export const adminListProducts = {
  created, method: 'get', path: '/admin/products',
  description: 'Admin: list every product with homepage visibility and priority controls.',
  onGuard: [requireAuth('admin'), requireAcl('shop')],
  onRequest: async (_req, res) => res.json(await shopService.adminListProducts()),
};

export const adminCreateProduct = {
  created, method: 'post', path: '/admin/products',
  description: 'Admin: create a product for a selected vendor.',
  onGuard: [requireAuth('admin'), requireAcl('shop')],
  onRequest: async (req, res) => {
    const result = await shopService.adminCreateProduct({ body: req.body || {}, actorId: req.user.sub });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(201).json(result.product);
  },
};

export const adminUpdateProductListing = {
  created, method: 'put', path: '/admin/products/:id/listing',
  description: 'Admin: control whether a product is listed and its homepage priority.',
  onGuard: [requireAuth('admin'), requireAcl('shop')],
  onRequest: async (req, res) => {
    const result = await shopService.adminUpdateProductListing({
      productId: req.params.id,
      body: req.body || {},
      actorId: req.user.sub,
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.product);
  },
};

export const adminListVendors = {
  created, method: 'get', path: '/admin/vendors',
  description: 'Admin: list and review marketplace vendors.',
  onGuard: [requireAuth('admin'), requireAcl('shop')],
  onRequest: async (_req, res) => res.json(await shopService.adminListVendors()),
};

export const adminUpdateVendor = {
  created, method: 'put', path: '/admin/vendors/:id',
  description: 'Admin: approve, verify, suspend or reactivate a marketplace vendor.',
  onGuard: [requireAuth('admin'), requireAcl('shop')],
  onRequest: async (req, res) => {
    const result = await shopService.adminUpdateVendor({ vendorId: req.params.id, body: req.body || {}, actorId: req.user.sub });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.vendor);
  },
};

// ── orders ───────────────────────────────────────────────────────────────────

export const createShopOrder = {
  created, method: 'post', path: '/me/shop-orders',
  description: 'Any signed-in user: place a shop order. Stock is validated and deducted.',
  requestSample: { items: [{ productId: 'prd_x', qty: 2 }], deliveryMethod: 'gym_pickup', pickupGymId: 'gym_x', paymentMethod: 'mpesa', paymentOutcome: 'success' },
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    const result = await shopService.createOrder({
      buyerId: req.user.sub, buyerRole: req.user.userType || 'member', body: req.body || {},
    });
    if (result.error) return res.status(result.status).json({ error: result.error, productId: result.productId });
    res.status(201).json(result.order);
  }
};

export const myShopOrders = {
  created, method: 'get', path: '/me/shop-orders',
  description: 'Any signed-in user: list own shop orders.',
  onGuard: requireAuth(),
  onRequest: async (req, res) => res.json(await shopService.myOrders(req.user.sub))
};

export const vendorOrders = {
  created, method: 'get', path: '/vendor/orders',
  description: 'Vendor: list orders containing own products.',
  onGuard: [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('orders')],
  onRequest: async (req, res) => res.json(await shopService.vendorOrders(req.user.vendorId || req.user.sub))
};

export const vendorUpdateOrderStatus = {
  created, method: 'post', path: '/vendor/orders/:id/status',
  description: 'Vendor/admin: move an order through its lifecycle (pending → confirmed → fulfilled | cancelled). Cancelling restocks items.',
  requestSample: { status: 'confirmed' },
  onGuard: [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('orders')],
  onRequest: async (req, res) => {
    const result = await shopService.updateOrderStatus({
      orderId: req.params.id,
      status: req.body?.status,
      actorId: req.user.vendorId || req.user.sub,
      actorRole: req.user.userType,
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.order);
  }
};

export const vendorPayments = {
  created, method: 'get', path: '/vendor/payments', description: 'Vendor: sales and settlement dashboard.',
  onGuard: [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('payments')],
  onRequest: async (req, res) => res.json(await shopService.vendorPayments(req.user.vendorId || req.user.sub)),
};
export const vendorStatement = {
  created, method: 'get', path: '/vendor/payments/statement', description: 'Vendor: download CSV statement.',
  onGuard: [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('reports')],
  onRequest: async (req, res) => { res.type('text/csv').send(await shopService.vendorStatement(req.user.vendorId || req.user.sub)); },
};

export const sendMarketplaceEnquiry = {
  created, method: 'post', path: '/me/marketplace-enquiries', description: 'Buyer: ask a vendor a product or delivery question.',
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    const result = await shopService.sendEnquiry({ buyerId: req.user.sub, body: req.body || {} });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(201).json(result.enquiry);
  },
};
export const vendorEnquiries = {
  created, method: 'get', path: '/vendor/enquiries', description: 'Vendor: search customer conversations.',
  onGuard: [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('customers')],
  onRequest: async (req, res) => res.json(await shopService.vendorEnquiries({ vendorId: req.user.vendorId || req.user.sub, search: req.query?.search })),
};
export const vendorReplyEnquiry = {
  created, method: 'post', path: '/vendor/enquiries/:id/reply', description: 'Vendor: reply to a customer.',
  onGuard: [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('customers')],
  onRequest: async (req, res) => {
    const result = await shopService.replyEnquiry({ vendorId: req.user.vendorId || req.user.sub, enquiryId: req.params.id, message: req.body?.message });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.enquiry);
  },
};
export const vendorResolveEnquiry = {
  created, method: 'post', path: '/vendor/enquiries/:id/resolve', description: 'Vendor: resolve a conversation.',
  onGuard: [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('customers')],
  onRequest: async (req, res) => {
    const result = await shopService.resolveEnquiry({ vendorId: req.user.vendorId || req.user.sub, enquiryId: req.params.id });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.enquiry);
  },
};

export const vendorStaff = {
  created, method: 'get', path: '/vendor/staff', description: 'Vendor: list staff.',
  onGuard: [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('staff')],
  onRequest: async (req, res) => res.json(await shopService.listVendorStaff(req.user.vendorId || req.user.sub)),
};
export const vendorCreateStaff = {
  created, method: 'post', path: '/vendor/staff', description: 'Vendor: create permission-scoped staff.',
  onGuard: requireAuth('vendor', 'admin'),
  onRequest: async (req, res) => {
    const result = await shopService.createVendorStaff({ vendorId: req.user.sub, body: req.body || {} });
    if (result.error) return res.status(result.status).json({ error: result.error, missing: result.missing });
    res.status(201).json(result.staff);
  },
};
export const vendorDisableStaff = {
  created, method: 'post', path: '/vendor/staff/:id/disable', description: 'Vendor: disable staff.',
  onGuard: requireAuth('vendor', 'admin'),
  onRequest: async (req, res) => {
    const result = await shopService.disableVendorStaff({ vendorId: req.user.sub, staffId: req.params.id });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.staff);
  },
};

export const reviewMarketplaceProduct = {
  created, method: 'post', path: '/me/shop-orders/:orderId/reviews', description: 'Buyer: review a delivered product.',
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    const result = await shopService.reviewProduct({ buyerId: req.user.sub, orderId: req.params.orderId, productId: req.body?.productId, rating: req.body?.rating, comment: req.body?.comment });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(201).json(result.review);
  },
};
export const marketplaceInvoice = {
  created, method: 'get', path: '/me/shop-orders/:id/invoice', description: 'Buyer: download an invoice or receipt.',
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    const invoice = await shopService.orderInvoice({ buyerId: req.user.sub, orderId: req.params.id });
    if (!invoice) return res.status(404).json({ error: 'order_not_found' });
    res.type('text/plain').send(invoice);
  },
};
export const marketplaceReorder = {
  created, method: 'post', path: '/me/shop-orders/:id/reorder', description: 'Buyer: return a prior order as a cart payload.',
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    const result = await shopService.reorder({ buyerId: req.user.sub, orderId: req.params.id });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  },
};
export const marketplaceNotifications = {
  created, method: 'get', path: '/me/marketplace-notifications', description: 'User: marketplace notifications.',
  onGuard: requireAuth(), onRequest: async (req, res) => res.json(await shopService.notifications(req.user.sub)),
};
