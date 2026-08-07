// D1 — Shop / vendor e-commerce REST surface (phase 1: catalogue + orders).
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { shopService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

// ── catalogue ────────────────────────────────────────────────────────────────

export const listShopProducts = {
  created, method: 'get', path: '/shop/products',
  description: 'Any signed-in user: browse the shop catalogue. Query: ?category=&search=.',
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    const { category, search } = req.query || {};
    res.json(await shopService.listProducts({ category, search }));
  }
};

export const vendorMyProducts = {
  created, method: 'get', path: '/vendor/products',
  description: 'Vendor: list own products (including archived).',
  onGuard: requireAuth('vendor', 'admin'),
  onRequest: async (req, res) => {
    res.json(await shopService.listProducts({ vendorId: req.user.sub, includeArchived: true }));
  }
};

export const vendorCreateProduct = {
  created, method: 'post', path: '/vendor/products',
  description: 'Vendor: create a product.',
  requestSample: { name: 'Whey Protein 1kg', category: 'supplements', priceTzs: 85000, stock: 20 },
  onGuard: requireAuth('vendor', 'admin'),
  onRequest: async (req, res) => {
    const result = await shopService.upsertProduct({ vendorId: req.user.sub, body: req.body || {} });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(201).json(result.product);
  }
};

export const vendorUpdateProduct = {
  created, method: 'put', path: '/vendor/products/:id',
  description: 'Vendor: update own product (price, stock, status...).',
  onGuard: requireAuth('vendor', 'admin'),
  onRequest: async (req, res) => {
    const result = await shopService.upsertProduct({
      vendorId: req.user.sub, body: req.body || {}, productId: req.params.id,
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.product);
  }
};

// ── orders ───────────────────────────────────────────────────────────────────

export const createShopOrder = {
  created, method: 'post', path: '/me/shop-orders',
  description: 'Any signed-in user: place a shop order. Stock is validated and deducted.',
  requestSample: { items: [{ productId: 'prd_x', qty: 2 }] },
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
  onGuard: requireAuth('vendor', 'admin'),
  onRequest: async (req, res) => res.json(await shopService.vendorOrders(req.user.sub))
};

export const vendorUpdateOrderStatus = {
  created, method: 'post', path: '/vendor/orders/:id/status',
  description: 'Vendor/admin: move an order through its lifecycle (pending → confirmed → fulfilled | cancelled). Cancelling restocks items.',
  requestSample: { status: 'confirmed' },
  onGuard: requireAuth('vendor', 'admin'),
  onRequest: async (req, res) => {
    const result = await shopService.updateOrderStatus({
      orderId: req.params.id, status: req.body?.status, actorId: req.user.sub,
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.order);
  }
};
