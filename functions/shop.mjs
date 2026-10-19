// D1 — Shop / vendor e-commerce REST surface (phase 1: catalogue + orders).
import { PRODUCT_CATEGORIES } from '../src/shared/product-categories.mjs';
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { shopService, vendorSettlementService, shopReconciliationService } from '../src/bootstrap/services.mjs';
import { buyerOrderView } from '../src/services/shop-service.mjs';
import { identityFlag, vendorStockLedgerOn, vendorToolsOptions } from '../src/shared/feature-flags.mjs';

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

// An administrator acts on marketplace orders only with the `shop` scope (a super-admin has all).
const requireAdminShopScope = (req, res, next) => (req.user?.userType === 'admin' ? requireAcl('shop')(req, res, next) : next());

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
  description: 'Vendor: list own products (including archived). With VENDOR_TOOLS + VENDOR_STOCK_LEDGER on, each product also carries its private costTzs and reorderLevel (null when not set), and each variant { name, stock|null, costTzs|null, reorderLevel|null, effectiveCostTzs|null, effectiveReorderLevel|null } — effective = the variant\'s own value, else the product\'s. costTzs / effectiveCostTzs are left out (product and variants) unless the caller is the vendor account or vendor_staff with vendorRole admin.',
  onGuard: [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('products')],
  onRequest: async (req, res) => {
    res.json(await shopService.vendorListProducts(req.user.vendorId || req.user.sub, { costAllowed: await shopService.canSeeCost(req.user) }));
  }
};

// ── vendor tools · S1: stock ledger ──────────────────────────────────────────

const sendError = (res, result) => {
  const { error, status, ...extra } = result;
  return res.status(status).json({ error, ...extra });
};
const ledgerDisabled = res => res.status(404).json({ error: 'feature_disabled' });

export const vendorToolsOptionsRoute = {
  created, method: 'get', path: '/vendor/tools/options',
  description: 'Vendor / vendor staff: which vendor tools this server has switched on (VENDOR_TOOLS umbrella + one flag per tool; all off unless set). The apps show a tool only when its value is true (fiscal: off | manual | vfd). canSeeCost: this caller may see and set cost prices (the vendor account, or vendor_staff with vendorRole admin).',
  responseSample: { canSeeCost: true, stockLedger: false, portal: false, buyerContact: false, walkInSales: false, customers: false, documents: false, vat: false, reports: false, refunds: false, barcodes: false, purchases: false, fiscal: 'off' },
  onGuard: requireAuth('vendor', 'vendor_staff', 'admin'),
  onRequest: async (req, res) => res.json({ ...vendorToolsOptions(), canSeeCost: await shopService.canSeeCost(req.user) }),
};

export const vendorStockAdjustment = {
  created, method: 'post', path: '/vendor/products/:id/stock-adjustments',
  description: 'Vendor / staff with `products` (VENDOR_STOCK_LEDGER): change a product\'s (or a variant\'s) stock with a reason. Body { variant?, reason: count|damaged|expired|lost|found|returned|restock|other, quantity, expectedStock? (count: the stock the vendor saw), direction? (other: in|out), note? (≤200; required for other), clientRef (8–100 chars, reuse it on retries) }. count sets the stock to `quantity`; the others add or remove `quantity`. → 201 { movement, product }; a replayed clientRef → 200 with the same movement. 409 stock_changed { currentStock } (count, stale expectedStock), 409 insufficient_stock { currentStock }, 409 client_ref_reused, 400 invalid_reason | invalid_quantity | note_too_long | note_required | invalid_direction | expected_stock_required | invalid_client_ref | variant_required { variants }, 404 product_not_found | variant_not_found, 403 not_your_product. Flag off: 404 feature_disabled.',
  requestSample: { reason: 'count', quantity: 12, expectedStock: 15, note: 'Shelf count', clientRef: '3b0c8f6e-2c1a-4c55-9a51-7c1f3b2d9e10' },
  onGuard: [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('products')],
  onRequest: async (req, res) => {
    if (!vendorStockLedgerOn()) return ledgerDisabled(res);
    const result = await shopService.adjustStock({
      vendorId: req.user.vendorId || req.user.sub, actorId: req.user.sub, productId: req.params.id, body: req.body || {},
    });
    if (result.error) return sendError(res, result);
    res.status(result.status).json({ movement: result.movement, product: result.product });
  },
};

export const vendorStockMovements = {
  created, method: 'get', path: '/vendor/products/:id/stock-movements',
  description: 'Vendor / staff with `products` (VENDOR_STOCK_LEDGER): one product\'s stock history, newest first. Query: from, to (EAT days YYYY-MM-DD, inclusive; optional), variant (optional), limit (1–200, default 50), cursor. → { productId, variant, openingStock, closingStock, rows:[{ id, productId, variant, reason, kind, delta, stockBefore, stockAfter, note, actor:{id,name}|null, orderId, document:{type:\'order\',id,number:null}|null, createdAt }], nextCursor }. Flag off: 404 feature_disabled.',
  onGuard: [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('products')],
  onRequest: async (req, res) => {
    if (!vendorStockLedgerOn()) return ledgerDisabled(res);
    const result = await shopService.stockMovements({ vendorId: req.user.vendorId || req.user.sub, productId: req.params.id, query: req.query || {} });
    if (result.error) return sendError(res, result);
    res.json(result);
  },
};

export const vendorLowStock = {
  created, method: 'get', path: '/vendor/stock/low',
  description: 'Vendor / staff with `products` (VENDOR_STOCK_LEDGER): products and variants at or below their reorder level (a variant without its own level uses the product\'s). → [{ productId, name, variant|null, stock, reorderLevel }]. Flag off: 404 feature_disabled.',
  onGuard: [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('products')],
  onRequest: async (req, res) => {
    if (!vendorStockLedgerOn()) return ledgerDisabled(res);
    res.json(await shopService.lowStock(req.user.vendorId || req.user.sub));
  },
};

export const shopCategories = {
  created, method: 'get', path: '/shop/categories',
  description: 'The product categories a vendor chooses from (for the business and for each product), with English and Swahili names.',
  responseSample: { categories: [{ key: 'supplements_nutrition', en: 'Supplements & nutrition', sw: 'Virutubisho na lishe' }] },
  onRequest: async (_req, res) => res.json({ categories: PRODUCT_CATEGORIES }),
};

export const vendorCreateProduct = {
  created, method: 'post', path: '/vendor/products',
  description: 'Vendor: create a product.',
  requestSample: { name: 'Whey Protein 1kg', category: 'supplements', priceTzs: 85000, stock: 20 },
  onGuard: [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('products')],
  onRequest: async (req, res) => {
    const result = await shopService.upsertProduct({ vendorId: req.user.vendorId || req.user.sub, actorId: req.user.sub, body: req.body || {}, costAllowed: await shopService.canSeeCost(req.user) });
    if (result.error) return sendError(res, result);
    res.status(201).json(result.product);
  }
};

export const vendorUpdateProduct = {
  created, method: 'put', path: '/vendor/products/:id',
  description: 'Vendor: update own product (price, stock, status...). The product goes back to review only when a reviewed field (name, description, category, brand, price, discount, images, variant names) actually changes. `variants` are merged by name: a variant sent without `stock` keeps its stored stock. With VENDOR_STOCK_LEDGER on: a `stock` that differs is recorded as a `count` adjustment (note product_form); costTzs / reorderLevel (product and per variant; null clears) are stored privately; when variants keep stock, every variant must (400 variant_stock_mixed), the body `stock` is ignored and the product stock moves only by what variant counts moved (each recorded); optional `stockSeen` (product) / `variants[].stockSeen` = the count the form showed → 409 stock_changed { currentStock, variant? } if it has moved; dropping a variant that still has stock → 409 variant_has_stock { variant, stock }, or that an open order holds units of → 409 variant_has_reservations { variant }; duplicate names → 400 duplicate_variant. costTzs (product or variant) may be sent only by the vendor account or vendor_staff with vendorRole admin, else 403 cost_forbidden; leaving it out keeps the stored cost. Also with the ledger on, checkout of a product whose variants keep stock requires `variant` (400 variant_required { variants }).',
  onGuard: [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('products')],
  onRequest: async (req, res) => {
    const result = await shopService.upsertProduct({
      vendorId: req.user.vendorId || req.user.sub, actorId: req.user.sub, body: req.body || {}, productId: req.params.id,
      costAllowed: await shopService.canSeeCost(req.user),
    });
    if (result.error) return sendError(res, result);
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
    if (result.error) return res.status(result.status).json({ error: result.error, missing: result.missing, allowed: result.allowed });
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
  description: 'Admin: approve, verify, suspend or reactivate a marketplace vendor, or set the commission FitFlex takes on their sales (commissionPct, 0–30; applies from their next order).',
  onGuard: [requireAuth('admin'), requireAcl('shop')],
  onRequest: async (req, res) => {
    const result = await shopService.adminUpdateVendor({ vendorId: req.params.id, body: req.body || {}, actorId: req.user.sub });
    if (result.error) {
      const { error, status, ...extra } = result;
      return res.status(status).json({ error, ...extra });
    }
    res.json(result.vendor);
  },
};

// ── marketplace operations: books that do not add up, and the ways to put them right ──────────

export const adminMarketplaceReconciliation = {
  created, method: 'get', path: '/admin/marketplace/reconciliation',
  description: 'Admin (shop or payments scope): reconcile marketplace orders, confirmed payments, refunds, stock and vendor statements against each other. Read-only. → { ok, open: ["P0 …"], checks: [{ id, severity, description, count, sample }] }. `ok` is false while any P0/P1 finding is open.',
  onGuard: [requireAuth('admin'), requireAcl('shop', 'payments')],
  onRequest: async (_req, res) => res.json(await shopReconciliationService.report()),
};

export const adminMarketplaceRaiseRefund = {
  created, method: 'post', path: '/admin/marketplace/orders/:id/raise-refund',
  description: 'Admin (payments scope): retry the refund of an order that is owed money (paymentStatus refund_pending) and has none raised. Safe to repeat: one live refund per order.',
  onGuard: [requireAuth('admin'), requireAcl('payments')],
  onRequest: async (req, res) => {
    const result = await shopService.raiseMissingRefund({ orderId: req.params.id, actorId: req.user.sub });
    if (result.error) {
      const { error, status, ...extra } = result;
      return res.status(status).json({ error, ...extra });
    }
    res.json(result);
  },
};

export const adminMarketplaceRepairPayment = {
  created, method: 'post', path: '/admin/marketplace/orders/:id/repair-payment',
  description: 'Admin (payments scope): an order whose payment was confirmed but which is not marked paid — apply the confirmed payment to it. Safe to repeat.',
  onGuard: [requireAuth('admin'), requireAcl('payments')],
  onRequest: async (req, res) => {
    const result = await shopService.repairOrderPayment({ orderId: req.params.id, actorId: req.user.sub });
    if (result.error) {
      const { error, status, ...extra } = result;
      return res.status(status).json({ error, ...extra });
    }
    res.json(result.order);
  },
};

// ── orders ───────────────────────────────────────────────────────────────────

export const createShopOrder = {
  created, method: 'post', path: '/me/shop-orders',
  description: 'Any signed-in user: place a shop order. Stock is validated and reserved atomically. Send an Idempotency-Key header (8–100 chars) so a retry returns the original order instead of a second one; the order is unpaid (paymentStatus pending) until FitFlex confirms the payment.',
  requestSample: { items: [{ productId: 'prd_x', qty: 2 }], deliveryMethod: 'gym_pickup', pickupGymId: 'gym_x', paymentMethod: 'mpesa', paymentOutcome: 'success' },
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    const result = await shopService.createOrder({
      buyerId: req.user.sub, buyerRole: req.user.userType || 'member', body: req.body || {},
      // A retried request carries the same key and gets the order it already made.
      idempotencyKey: req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'] || null,
    });
    if (result.error) return res.status(result.status).json({ error: result.error, productId: result.productId, ...(result.field ? { field: result.field } : {}), ...(result.limit ? { limit: result.limit } : {}), ...(result.variants ? { variants: result.variants } : {}) });
    if (result.replayed) res.set?.('Idempotent-Replay', 'true');
    res.status(201).json(buyerOrderView(result.order));
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
  description: 'Vendor/admin: move this vendor\'s part of an order forward: pending → accepted → [processing] → [packed] → dispatched | ready_for_pickup → delivered, or cancelled until delivered. Steps cannot be skipped except processing/packed; repeating the current status changes nothing. A vendor moves only their own lines; an admin (scope `shop`) names `vendorId` when the order has several vendors. Optional `reason` is kept in the audit trail. Legacy: confirmed = accepted, fulfilled = delivered. Cancelling restocks items and refunds a paid order. 409 invalid_transition lists the `allowed` next statuses.',
  requestSample: { status: 'accepted', vendorId: 'usr_vendor_1', reason: 'optional' },
  onGuard: [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('orders'), requireAdminShopScope],
  onRequest: async (req, res) => {
    const result = await shopService.updateOrderStatus({
      orderId: req.params.id,
      status: req.body?.status,
      actorId: req.user.vendorId || req.user.sub,
      actorRole: req.user.userType,
      vendorId: req.user.userType === 'admin' ? req.body?.vendorId || null : null,
      reason: req.body?.reason || null,
    });
    if (result.error) {
      const { error, status, ...extra } = result;
      return res.status(status).json({ error, ...extra });
    }
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

export const vendorStatements = {
  created, method: 'get', path: '/vendor/statements',
  description: 'Vendor: my weekly payout statements (from the moment they are sent for approval), and whether my payout account is ready.',
  onGuard: [requireAuth('vendor', 'vendor_staff'), requireVendorPermission('payments')],
  onRequest: async (req, res) => res.json(await vendorSettlementService.listMine({ vendorId: req.user.vendorId || req.user.sub })),
};
export const vendorPayoutStatement = {
  created, method: 'get', path: '/vendor/statements/:id',
  description: 'Vendor: one of my payout statements with the delivered orders it pays for.',
  onGuard: [requireAuth('vendor', 'vendor_staff'), requireVendorPermission('payments')],
  onRequest: async (req, res) => {
    const result = await vendorSettlementService.getMine({ vendorId: req.user.vendorId || req.user.sub, id: req.params.id });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  },
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
    // Identity V2 · I6: with invitations on, a vendor no longer sets a password for someone else.
    if (identityFlag('V2_INVITES')) {
      return res.status(400).json({
        error: 'credentials_not_accepted',
        message: 'Staff are now invited instead of being given a password. Update the app and use Invite.',
        use: 'POST /orgs/vendor/:vendorId/invitations',
      });
    }
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
  created, method: 'post', path: '/me/shop-orders/:id/reorder', description: 'Buyer: return a prior order as a cart payload → { items: [{ productId, variant|null, qty }] }.',
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
