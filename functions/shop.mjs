// D1 — Shop / vendor e-commerce REST surface (phase 1: catalogue + orders).
import { PRODUCT_CATEGORIES } from '../src/shared/product-categories.mjs';
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { shopService, vendorSettlementService, shopReconciliationService, productStatsRecomputeService, vendorCustomerService, vendorDocumentService, vendorTaxService } from '../src/bootstrap/services.mjs';
import { buyerOrderView } from '../src/services/shop-service.mjs';
import { identityFlag, vendorStockLedgerOn, vendorToolsOptions, vendorPortalOn, vendorCustomersOn, vendorDocumentsOn } from '../src/shared/feature-flags.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';

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

/**
 * vendor_staff holding ANY of these permissions (read from the stored staff record). The 403 keeps
 * `requiredPermission` (the first one) for older clients and lists every accepted permission.
 */
function requireAnyVendorPermission(...permissions) {
  return async (req, res, next) => {
    if (req.user?.userType !== 'vendor_staff') return next();
    try {
      for (const permission of permissions) if (await shopService.authorizeStaff(req.user, permission)) return next();
    } catch (error) {
      console.error('[marketplace] staff authorization lookup failed', { staffId: req.user.sub, error: error.message });
      return res.status(503).json({ error: 'authorization_unavailable' });
    }
    return res.status(403).json({ error: 'vendor_permission_forbidden', requiredPermission: permissions[0], acceptedPermissions: permissions });
  };
}

// An administrator acts on marketplace orders only with the `shop` scope (a super-admin has all).
const requireAdminShopScope = (req, res, next) => (req.user?.userType === 'admin' ? requireAcl('shop')(req, res, next) : next());

// vendor_staff reads vendor-wide context (e.g. the business profile) only while an active staff
// member of the vendor named in their token; no particular permission is needed to read.
async function requireActiveVendorStaff(req, res, next) {
  if (req.user?.userType !== 'vendor_staff') return next();
  try {
    if (await shopService.isActiveStaff(req.user)) return next();
  } catch (error) {
    console.error('[marketplace] staff lookup failed', { staffId: req.user.sub, error: error.message });
    return res.status(503).json({ error: 'authorization_unavailable' });
  }
  return res.status(403).json({ error: 'vendor_staff_inactive' });
}

// Every guard below is wrapped in routeGuard(method, ...): bfast-function mounts guards with
// app.use(path, guard), which ignores the method and matches sub-paths, so without it one route's
// guard also ran on every other method of the path and on every route below it.

// ── catalogue ────────────────────────────────────────────────────────────────

export const listShopProducts = {
  created, method: 'get', path: '/shop/products',
  description: 'Any signed-in user: browse the shop catalogue. Query: ?category=&search=&vendorId= …. Each row is the product plus vendorName (the seller\'s business name, else the vendor account\'s display name; null if neither).',
  onGuard: routeGuard('get', requireAuth()),
  onRequest: async (req, res) => {
    const { category, search, brand, vendorId, minPrice, maxPrice, minRating, maxDistanceKm, delivery, promotions, sort } = req.query || {};
    res.json(await shopService.listProducts({ category, search, brand, vendorId, minPrice, maxPrice, minRating, maxDistanceKm, delivery, promotions, sort }));
  }
};

export const getShopProduct = {
  created, method: 'get', path: '/shop/products/:id',
  description: 'Buyer: product details (with vendorName), vendor, reviews and similar products (rows as in GET /shop/products).',
  onGuard: routeGuard('get', requireAuth()),
  onRequest: async (req, res) => {
    const product = await shopService.getProduct(req.params.id);
    if (!product) return res.status(404).json({ error: 'product_not_found' });
    res.json(product);
  },
};

export const getVendorStore = {
  created, method: 'get', path: '/shop/vendors/:id',
  description: 'Buyer: public vendor storefront.', onGuard: routeGuard('get', requireAuth()),
  onRequest: async (req, res) => {
    const store = await shopService.getVendorStore(req.params.id);
    if (!store) return res.status(404).json({ error: 'vendor_not_found' });
    res.json(store);
  },
};

export const vendorMyProducts = {
  created, method: 'get', path: '/vendor/products',
  description: 'Vendor / staff with `products` OR `sales` (S3: the POS loads the products to sell; read only — every write and stock route still needs `products`): list own products (including archived). Staff with neither → 403 vendor_permission_forbidden { requiredPermission: products, acceptedPermissions: [products, sales] }. With VENDOR_TOOLS + VENDOR_STOCK_LEDGER on, each product also carries its private costTzs and reorderLevel (null when not set), and each variant { name, stock|null, costTzs|null, reorderLevel|null, effectiveCostTzs|null, effectiveReorderLevel|null } — effective = the variant\'s own value, else the product\'s. costTzs / effectiveCostTzs are left out (product and variants) unless the caller is the vendor account, vendor_staff with vendorRole admin, or a FitFlex admin (scope `shop`).',
  onGuard: routeGuard('get', [requireAuth('vendor', 'vendor_staff', 'admin'), requireAnyVendorPermission('products', 'sales'), requireAdminShopScope]),
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
  description: 'Vendor / vendor staff: which vendor tools this server has switched on (VENDOR_TOOLS umbrella + one flag per tool; all off unless set). The apps show a tool only when its value is true (fiscal: off | manual | vfd). canSeeCost: this caller may see and set cost prices (the vendor account, vendor_staff with vendorRole admin, or a FitFlex admin with scope `shop`). merch.banners: SHOP_BANNERS is on (vendors may propose shop home banners: /vendor/shop-banners). merch.productTargets: SHOP_PERSONALISATION is on (show the product form "Who it is for" fields: targetGender, targetAgeBands). vatInForce (S5): true only when VENDOR_TOOLS + VENDOR_VAT are on and the VAT registration of my vendor is in force now (verified, registered, certificate still standing) — show the product VAT code field then; no other tax detail is given here (always false for a FitFlex admin). Staff no longer active, or of another vendor → 403 vendor_staff_inactive.',
  responseSample: { canSeeCost: true, stockLedger: false, portal: false, buyerContact: false, walkInSales: false, customers: false, documents: false, vat: false, vatInForce: false, reports: false, refunds: false, barcodes: false, purchases: false, fiscal: 'off', merch: { banners: false, productTargets: false } },
  onGuard: routeGuard('get', [requireAuth('vendor', 'vendor_staff', 'admin'), requireActiveVendorStaff]),
  onRequest: async (req, res) => {
    const vendorId = req.user.userType === 'vendor' ? req.user.sub : req.user.userType === 'vendor_staff' ? req.user.vendorId : null;
    res.json({ ...vendorToolsOptions(), canSeeCost: await shopService.canSeeCost(req.user), vatInForce: await vendorTaxService.vatInForce(vendorId) });
  },
};

export const vendorMeRoute = {
  created, method: 'get', path: '/vendor/me',
  description: 'Vendor / vendor staff (VENDOR_TOOLS + VENDOR_PORTAL; off → 404 feature_disabled): who I am in my business, for the web portal. → { vendorId, businessName|null, userType: vendor|vendor_staff, vendorRole|null (staff only), permissions: [products|orders|sales|customers|reports|payments|staff] (the vendor account: all; staff: what the server lets them do, read from the stored staff record), approvalStatus|null, accountStatus|null (of the vendor account), tools: same object as GET /vendor/tools/options incl. canSeeCost and vatInForce }. Staff no longer active, or of another vendor → 403 vendor_staff_inactive (a staff account that is suspended may get 403 account_suspended first, from the sign-in check).',
  responseSample: { vendorId: 'usr_vendor_1', businessName: 'Dar Fitness Gear', userType: 'vendor_staff', vendorRole: 'orders_manager', permissions: ['orders'], approvalStatus: 'approved', accountStatus: 'active', tools: { canSeeCost: false, stockLedger: false, portal: true, buyerContact: false, walkInSales: false, customers: false, documents: false, vat: false, reports: false, refunds: false, barcodes: false, purchases: false, fiscal: 'off', merch: { banners: false, productTargets: false } } },
  onGuard: routeGuard('get', [requireAuth('vendor', 'vendor_staff'), requireActiveVendorStaff]),
  onRequest: async (req, res) => {
    const me = await shopService.vendorMe(req.user);
    if (!me) return res.status(403).json({ error: 'vendor_staff_inactive' });
    if (!vendorPortalOn()) return res.status(404).json({ error: 'feature_disabled' });
    // Same object as GET /vendor/tools/options, including S5 vatInForce.
    res.json({ ...me, tools: { ...me.tools, vatInForce: await vendorTaxService.vatInForce(me.vendorId) } });
  },
};

export const vendorStockAdjustment = {
  created, method: 'post', path: '/vendor/products/:id/stock-adjustments',
  description: 'Vendor / staff with `products` (VENDOR_STOCK_LEDGER): change a product\'s (or a variant\'s) stock with a reason. Body { variant?, reason: count|damaged|expired|lost|found|returned|restock|other, quantity, expectedStock? (count: the stock the vendor saw), direction? (other: in|out), note? (≤200; required for other), clientRef (8–100 chars, reuse it on retries) }. count sets the stock to `quantity`; the others add or remove `quantity`. → 201 { movement, product }; a replayed clientRef → 200 with the same movement. 409 stock_changed { currentStock } (count, stale expectedStock), 409 insufficient_stock { currentStock }, 409 client_ref_reused, 400 invalid_reason | invalid_quantity | note_too_long | note_required | invalid_direction | expected_stock_required | invalid_client_ref | variant_required { variants }, 404 product_not_found | variant_not_found, 403 not_your_product. Flag off: 404 feature_disabled.',
  requestSample: { reason: 'count', quantity: 12, expectedStock: 15, note: 'Shelf count', clientRef: '3b0c8f6e-2c1a-4c55-9a51-7c1f3b2d9e10' },
  onGuard: routeGuard('post', [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('products'), requireAdminShopScope]),
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
  description: 'Vendor / staff with `products` (VENDOR_STOCK_LEDGER): one product\'s stock history, newest first. Query: from, to (EAT days YYYY-MM-DD, inclusive; optional), variant (optional), limit (1–200, default 50), cursor. → { productId, variant, openingStock, closingStock, rows:[{ id, productId, variant, reason, kind, delta, stockBefore, stockAfter, note, actor:{id,name}|null, orderId, document:{type:\'order\',id,number:null,shortRef (last 6 characters of the order id, uppercase — as on Orders)} | {type:\'sale\',id,number (receipt R-000001)} (reasons sale / sale_void, S3) | null, createdAt }], nextCursor }. Flag off: 404 feature_disabled.',
  onGuard: routeGuard('get', [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('products'), requireAdminShopScope]),
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
  onGuard: routeGuard('get', [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('products'), requireAdminShopScope]),
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
  description: 'Vendor: create a product. Tags left out start as targetGender null and targetAgeBands []. Optional "who it is for" tags (docs/shop-personalisation-api.md): targetGender = women | men | null (everyone) and targetAgeBands = a list of 18_29, 30_44, 45_59, 60_plus ([] or all four = all ages; stored as []). Anything else → 400 invalid_field { field: targetGender | targetAgeBands, allowed }. They are not reviewed (never send the product back to pending) and are never on buyer-facing rows.',
  requestSample: { name: 'Whey Protein 1kg', category: 'supplements', priceTzs: 85000, stock: 20, targetGender: null, targetAgeBands: ['18_29', '30_44'] },
  onGuard: routeGuard('post', [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('products'), requireAdminShopScope]),
  onRequest: async (req, res) => {
    const result = await shopService.upsertProduct({ vendorId: req.user.vendorId || req.user.sub, actorId: req.user.sub, body: req.body || {}, costAllowed: await shopService.canSeeCost(req.user) });
    if (result.error) return sendError(res, result);
    res.status(201).json(result.product);
  }
};

export const vendorUpdateProduct = {
  created, method: 'put', path: '/vendor/products/:id',
  description: 'Vendor: update own product (price, stock, status...). The product goes back to review only when a reviewed field (name, description, category, brand, price, discount, images, variant names) actually changes. `variants` are merged by name: a variant sent without `stock` keeps its stored stock. With VENDOR_STOCK_LEDGER on: a `stock` that differs is recorded as a `count` adjustment (note product_form); costTzs / reorderLevel (product and per variant; null clears) are stored privately; when variants keep stock, every variant must (400 variant_stock_mixed), the body `stock` is ignored and the product stock moves only by what variant counts moved (each recorded); optional `stockSeen` (product) / `variants[].stockSeen` = the count the form showed → 409 stock_changed { currentStock, variant? } if it has moved; dropping a variant that still has stock → 409 variant_has_stock { variant, stock }, or that an open order holds units of → 409 variant_has_reservations { variant }; duplicate names → 400 duplicate_variant. costTzs (product or variant) may be sent only by the vendor account or vendor_staff with vendorRole admin, else 403 cost_forbidden; leaving it out keeps the stored cost. Also with the ledger on, checkout of a product whose variants keep stock requires `variant` (400 variant_required { variants }). Tags left out keep their stored values; targetGender null clears it, targetAgeBands [] clears the bands. Optional "who it is for" tags (docs/shop-personalisation-api.md): targetGender = women | men | null (everyone) and targetAgeBands = a list of 18_29, 30_44, 45_59, 60_plus ([] or all four = all ages; stored as []). Anything else → 400 invalid_field { field: targetGender | targetAgeBands, allowed }. They are not reviewed (never send the product back to pending) and are never on buyer-facing rows.',
  onGuard: routeGuard('put', [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('products'), requireAdminShopScope]),
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
  onGuard: routeGuard('post', [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('products'), requireAdminShopScope]),
  onRequest: async (req, res) => {
    const result = await shopService.duplicateProduct({ vendorId: req.user.vendorId || req.user.sub, productId: req.params.id });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(201).json(result.product);
  },
};

export const vendorDeleteProduct = {
  created, method: 'delete', path: '/vendor/products/:id',
  description: 'Vendor: soft-delete an owned product.',
  onGuard: routeGuard('delete', [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('products'), requireAdminShopScope]),
  onRequest: async (req, res) => {
    const result = await shopService.deleteProduct({ vendorId: req.user.vendorId || req.user.sub, productId: req.params.id });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  },
};

export const vendorProfile = {
  created, method: 'get', path: '/vendor/profile', description: 'Vendor, or any active staff member of the vendor (read-only, no permission needed): view the business profile. Staff without `payments` (and not vendorRole admin) get it without settlementAccount and commissionPct. Staff no longer active → 403 vendor_staff_inactive.',
  onGuard: routeGuard('get', [requireAuth('vendor', 'vendor_staff', 'admin'), requireActiveVendorStaff]),
  onRequest: async (req, res) => res.json(await shopService.vendorProfileFor(req.user) || {}),
};
export const vendorSaveProfile = {
  created, method: 'put', path: '/vendor/profile', description: 'Vendor (account holder) or admin only: create, edit or publish business profile. vendor_staff → 403.',
  onGuard: routeGuard('put', requireAuth('vendor', 'admin')),
  onRequest: async (req, res) => {
    const result = await shopService.saveVendorProfile({ vendorId: req.user.sub, body: req.body || {} });
    if (result.error) return res.status(result.status).json({ error: result.error, missing: result.missing, allowed: result.allowed });
    res.json(result.profile);
  },
};

export const adminListProducts = {
  created, method: 'get', path: '/admin/products',
  description: 'Admin: list every product with homepage visibility and priority controls. With VENDOR_TOOLS + VENDOR_STOCK_LEDGER on, each product also carries the vendor\'s private costTzs and reorderLevel (null when not set) and each variant { name, stock|null, costTzs|null, reorderLevel|null, effectiveCostTzs|null, effectiveReorderLevel|null } — the same shape as GET /vendor/products for the vendor account. Never on /shop/*. Portal: show cost/reorder fields only when they are present (flag off → absent). Every row carries the vendor\'s optional tags targetGender (women | men | null) and targetAgeBands ([] = all ages), read-only here; filters ?targetGender=women|men|everyone and ?targetAgeBand=18_29|30_44|45_59|60_plus|all (bad value → 400 invalid_filter { field, allowed }).',
  onGuard: routeGuard('get', [requireAuth('admin'), requireAcl('shop')]),
  onRequest: async (req, res) => {
    const q = req.query || {};
    const result = await shopService.adminListProducts({ targetGender: q.targetGender, targetAgeBand: q.targetAgeBand });
    if (result.error) return sendError(res, result);
    res.json(result);
  },
};

export const adminCreateProduct = {
  created, method: 'post', path: '/admin/products',
  description: 'Admin: create a product for a selected vendor. With VENDOR_STOCK_LEDGER on, costTzs / reorderLevel (product and per variant) are accepted and stored privately, the admin is the actor of the opening stock rows and the audit entry, and the response carries the private fields as GET /admin/products does.',
  onGuard: routeGuard('post', [requireAuth('admin'), requireAcl('shop')]),
  onRequest: async (req, res) => {
    const result = await shopService.adminCreateProduct({ body: req.body || {}, actorId: req.user.sub });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(201).json(result.product);
  },
};

export const adminUpdateProductListing = {
  created, method: 'put', path: '/admin/products/:id/listing',
  description: 'Admin: control whether a product is listed and its homepage priority. With VENDOR_STOCK_LEDGER on, also optional costTzs, reorderLevel and variants: [{ name, costTzs?, reorderLevel? }] (null clears; other variant keys are ignored; 400 invalid_field { field }, 400 duplicate_variant { variant }, 404 variant_not_found { variant, variants }); listing fields, private fields and audit rows are written in one transaction; recorded in the audit log with the admin as actor (admin_product_private_updated). A reorder level raised to or above the stock sends the vendor one low-stock alert. The response carries the private fields as GET /admin/products does.',
  onGuard: routeGuard('put', [requireAuth('admin'), requireAcl('shop')]),
  onRequest: async (req, res) => {
    const result = await shopService.adminUpdateProductListing({
      productId: req.params.id,
      body: req.body || {},
      actorId: req.user.sub,
    });
    if (result.error) return sendError(res, result);
    res.json(result.product);
  },
};

export const adminListVendors = {
  created, method: 'get', path: '/admin/vendors',
  description: 'Admin: list and review marketplace vendors.',
  onGuard: routeGuard('get', [requireAuth('admin'), requireAcl('shop')]),
  onRequest: async (_req, res) => res.json(await shopService.adminListVendors()),
};

export const adminUpdateVendor = {
  created, method: 'put', path: '/admin/vendors/:id',
  description: 'Admin: approve, verify, suspend or reactivate a marketplace vendor, or set the commission FitFlex takes on their sales (commissionPct, 0–30; applies from their next order).',
  onGuard: routeGuard('put', [requireAuth('admin'), requireAcl('shop')]),
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
  onGuard: routeGuard('get', [requireAuth('admin'), requireAcl('shop', 'payments')]),
  onRequest: async (_req, res) => res.json(await shopReconciliationService.report()),
};

export const adminMarketplaceRaiseRefund = {
  created, method: 'post', path: '/admin/marketplace/orders/:id/raise-refund',
  description: 'Admin (payments scope): retry the refund of an order that is owed money (paymentStatus refund_pending) and has none raised. Safe to repeat: one live refund per order.',
  onGuard: routeGuard('post', [requireAuth('admin'), requireAcl('payments')]),
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
  onGuard: routeGuard('post', [requireAuth('admin'), requireAcl('payments')]),
  onRequest: async (req, res) => {
    const result = await shopService.repairOrderPayment({ orderId: req.params.id, actorId: req.user.sub });
    if (result.error) {
      const { error, status, ...extra } = result;
      return res.status(status).json({ error, ...extra });
    }
    res.json(result.order);
  },
};

export const adminRecomputeProductStats = {
  created, method: 'post', path: '/admin/shop/product-stats/recompute',
  description: 'Admin (scope `shop`, as /admin/products): recompute each product\'s rating, reviewCount and soldCount from the records, as the server keeps them — rating = plain average of its ProductReview rows (stored to 2 decimals), reviewCount = number of those rows (none → 0 / 0), soldCount = sum of line qty over orders still holding their stock (stockState reserved: paid or unpaid, any fulfilment status; cancelled/expired orders that gave stock back do not count). Nothing else on the product is touched. Body { apply?: boolean (default false = dry run, writes nothing), productIds?: string[] (optional subset, 1–1000) }. → 200 { dryRun, checked, changed: [{ productId, name, vendorId, before: { rating, reviewCount, soldCount }, after: { … } }], unchanged, appliedAt?, runId? } (appliedAt/runId only when applied; runId = the AuditLog id, action admin_product_stats_recomputed). Apply is one transaction; a second apply while one runs → 409 recompute_in_progress. 400 invalid_apply | invalid_product_ids | too_many_product_ids. Vendors, members, everyone else → 403.',
  requestSample: { apply: false },
  onGuard: routeGuard('post', [requireAuth('admin'), requireAcl('shop')]),
  onRequest: async (req, res) => {
    const body = req.body || {};
    if (body.apply !== undefined && typeof body.apply !== 'boolean') return res.status(400).json({ error: 'invalid_apply' });
    const result = await productStatsRecomputeService.recompute({ apply: body.apply === true, productIds: body.productIds, actorId: req.user.sub });
    if (result.error) {
      const { error, status, ...extra } = result;
      return res.status(status).json({ error, ...extra });
    }
    res.json(result);
  },
};

// ── orders ───────────────────────────────────────────────────────────────────

export const createShopOrder = {
  created, method: 'post', path: '/me/shop-orders',
  description: 'Any signed-in user: place a shop order. Stock is validated and reserved atomically. Send an Idempotency-Key header (8–100 chars) so a retry returns the original order instead of a second one; the order is unpaid (paymentStatus pending) until FitFlex confirms the payment.',
  requestSample: { items: [{ productId: 'prd_x', qty: 2 }], deliveryMethod: 'gym_pickup', pickupGymId: 'gym_x', paymentMethod: 'mpesa', paymentOutcome: 'success' },
  onGuard: routeGuard('post', requireAuth()),
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
  onGuard: routeGuard('get', requireAuth()),
  onRequest: async (req, res) => res.json(await shopService.myOrders(req.user.sub))
};

export const vendorOrders = {
  created, method: 'get', path: '/vendor/orders',
  description: 'Vendor / staff with `orders`: my orders, newest first (createdAt desc, id desc). Without paging params the response is the whole list as a JSON array (as before; older app builds). With `limit` and/or `cursor` it is one page: { orders: [...], nextCursor: string|null, counts: { open, delivered, cancelled, all, waitingAccept } } — counts are over ALL my orders (not the page), by my own part: cancelled = my part cancelled, or the order cancelled, or paymentStatus refund_pending|refunded; delivered = my part delivered (legacy fulfilled) and not cancelled; open = paid and neither; waitingAccept = open and my part still pending; all = every order with a line of mine (unpaid ones are only in all) — limit 1–200 (default 50; above 200 is capped at 200), cursor = the previous page\'s nextCursor (opaque); null nextCursor = last page. 400 invalid_limit (not a whole number ≥ 1) | invalid_cursor. Each order is exactly { id, shortRef (last 6 characters of id, uppercase), createdAt, status (this vendor\'s own fulfilment status), orderStatus (combined, customer-facing), nextStatuses[] (empty unless paid and not cancelled), timeline[{ status, at, reason? }] (own), items[{ productId, name, variant|null, qty, priceTzs, image|null, commissionTzs?, vendorPayoutTzs? }] (own lines only; lines without a vendorId are never shown), totalTzs (own subtotal), paymentStatus, paymentMethod, deliveryMethod, note|null, pickupGymId|null (kept for older app builds), pickupGym { id, name|null }|null, buyer { customerId (vendor-scoped, stable; null for a buyer whose account was deleted), displayName|null, customerLinked (S4: true only when VENDOR_TOOLS + VENDOR_CUSTOMERS are on and a vendor customer record exists for this buyer — show the customer link only then), forgotten (the buyer deleted their FitFlex account: displayName and customerId are null — show "Deleted member"), phone?, contactVisibleUntil? }, deliveryAddress? }. commissionTzs / vendorPayoutTzs only for the vendor account, vendor admins, staff with `payments` and FitFlex admins. deliveryAddress (home delivery) while this vendor\'s part is open and the order paid, and until the end of the 7th EAT day after they delivered it; buyer.phone and buyer.contactVisibleUntil (null while open; else that day 23:59:59+03:00) in the same window and only with VENDOR_TOOLS + VENDOR_ORDER_BUYER_CONTACT. Never: buyerId, buyerRole, email, paymentReference, other vendors\' lines or totals, internals. S4 (VENDOR_TOOLS + VENDOR_CUSTOMERS; off → 404 feature_disabled): `customerId` (a customer id of mine, = buyer.customerId) → only that customer\'s orders, always in the paged shape { orders, nextCursor, counts } (counts over that customer\'s orders); a walk-in (manual) customer → no orders; another vendor\'s or unknown id → 404 customer_not_found.',
  onGuard: routeGuard('get', [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('orders')]),
  onRequest: async (req, res) => {
    const vendorId = req.user.vendorId || req.user.sub;
    const seesMoney = await shopService.canSeeOrderMoney(req.user);
    const { limit, cursor, customerId } = req.query || {};
    if (customerId !== undefined && customerId !== '') {
      if (!vendorCustomersOn()) return res.status(404).json({ error: 'feature_disabled' });
      const who = await vendorCustomerService.buyerOf(vendorId, String(customerId));
      if (!who) return res.status(404).json({ error: 'customer_not_found' });
      if (!who.buyerUserId) return res.json({ orders: [], nextCursor: null, counts: { open: 0, delivered: 0, cancelled: 0, all: 0, waitingAccept: 0 } });
      const page = await shopService.vendorOrdersPage(vendorId, { limit, cursor, seesMoney, buyerId: who.buyerUserId });
      if (page.error) return sendError(res, page);
      return res.json(page);
    }
    // Older app builds send no paging params and read a plain array: they keep getting the whole list.
    if (limit === undefined && cursor === undefined) return res.json(await shopService.vendorOrders(vendorId, { seesMoney }));
    const page = await shopService.vendorOrdersPage(vendorId, { limit, cursor, seesMoney });
    if (page.error) return sendError(res, page);
    res.json(page);
  },
};

export const vendorOrderDetail = {
  created, method: 'get', path: '/vendor/orders/:id',
  description: 'Vendor / staff with `orders`: one of my orders, in the same shape as GET /vendor/orders. An order with no line of mine (another vendor\'s, or unknown) → 404 order_not_found.',
  onGuard: routeGuard('get', [requireAuth('vendor', 'vendor_staff'), requireVendorPermission('orders')]),
  onRequest: async (req, res) => {
    const result = await shopService.vendorOrder(req.user.vendorId || req.user.sub, req.params.id, { seesMoney: await shopService.canSeeOrderMoney(req.user) });
    if (result.error) return sendError(res, result);
    res.json(result.order);
  },
};

export const vendorUpdateOrderStatus = {
  created, method: 'post', path: '/vendor/orders/:id/status',
  description: 'Vendor/admin: move this vendor\'s part of an order forward: pending → accepted → [processing] → [packed] → dispatched | ready_for_pickup → delivered, or cancelled until delivered. Steps cannot be skipped except processing/packed; repeating the current status changes nothing. A vendor moves only their own lines; an admin (scope `shop`) names `vendorId` when the order has several vendors. Optional `reason` is kept in the audit trail. Legacy: confirmed = accepted, fulfilled = delivered. Cancelling restocks items and refunds a paid order. 409 invalid_transition lists the `allowed` next statuses. A vendor or their staff get the order back in the GET /vendor/orders shape (allowlisted); an admin gets the stored order. A vendor or their staff may act only on an order with a line that names them: otherwise (another vendor\'s order, older lines without a vendorId, unknown id) → 404 order_not_found. An admin keeps 404 order_not_found / 404 vendor_not_in_order / 400 vendor_required.',
  requestSample: { status: 'accepted', vendorId: 'usr_vendor_1', reason: 'optional' },
  onGuard: routeGuard('post', [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('orders'), requireAdminShopScope]),
  onRequest: async (req, res) => {
    const result = await shopService.updateOrderStatus({
      orderId: req.params.id,
      status: req.body?.status,
      actorId: req.user.vendorId || req.user.sub,
      actorRole: req.user.userType,
      vendorId: req.user.userType === 'admin' ? req.body?.vendorId || null : null,
      reason: req.body?.reason || null,
      seesMoney: await shopService.canSeeOrderMoney(req.user),
    });
    if (result.error) {
      const { error, status, ...extra } = result;
      return res.status(status).json({ error, ...extra });
    }
    res.json(result.order);
  }
};

export const vendorPayments = {
  created, method: 'get', path: '/vendor/payments', description: 'Vendor: sales and settlement dashboard. todaySalesTzs = my lines of orders placed today (EAT day) that are paid (not cancelled, refunded or unpaid), whatever their delivery status; weekly / monthly / pending / settled figures count delivered, paid orders.',
  onGuard: routeGuard('get', [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('payments')]),
  onRequest: async (req, res) => res.json(await shopService.vendorPayments(req.user.vendorId || req.user.sub)),
};
export const vendorStatement = {
  created, method: 'get', path: '/vendor/payments/statement', description: 'Vendor: download CSV statement.',
  onGuard: routeGuard('get', [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('reports')]),
  onRequest: async (req, res) => { res.type('text/csv').send(await shopService.vendorStatement(req.user.vendorId || req.user.sub)); },
};

export const vendorStatements = {
  created, method: 'get', path: '/vendor/statements',
  description: 'Vendor: my weekly payout statements (from the moment they are sent for approval), and whether my payout account is ready.',
  onGuard: routeGuard('get', [requireAuth('vendor', 'vendor_staff'), requireVendorPermission('payments')]),
  onRequest: async (req, res) => res.json(await vendorSettlementService.listMine({ vendorId: req.user.vendorId || req.user.sub })),
};
export const vendorPayoutStatement = {
  created, method: 'get', path: '/vendor/statements/:id',
  description: 'Vendor: one of my payout statements with the delivered orders it pays for.',
  onGuard: routeGuard('get', [requireAuth('vendor', 'vendor_staff'), requireVendorPermission('payments')]),
  onRequest: async (req, res) => {
    const result = await vendorSettlementService.getMine({ vendorId: req.user.vendorId || req.user.sub, id: req.params.id });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  },
};

export const sendMarketplaceEnquiry = {
  created, method: 'post', path: '/me/marketplace-enquiries', description: 'Buyer: ask a vendor a product or delivery question.',
  onGuard: routeGuard('post', requireAuth()),
  onRequest: async (req, res) => {
    const result = await shopService.sendEnquiry({ buyerId: req.user.sub, body: req.body || {} });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(201).json(result.enquiry);
  },
};
export const vendorEnquiries = {
  created, method: 'get', path: '/vendor/enquiries', description: 'Vendor: search customer conversations.',
  onGuard: routeGuard('get', [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('customers')]),
  onRequest: async (req, res) => res.json(await shopService.vendorEnquiries({ vendorId: req.user.vendorId || req.user.sub, search: req.query?.search })),
};
export const vendorReplyEnquiry = {
  created, method: 'post', path: '/vendor/enquiries/:id/reply', description: 'Vendor: reply to a customer.',
  onGuard: routeGuard('post', [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('customers')]),
  onRequest: async (req, res) => {
    const result = await shopService.replyEnquiry({ vendorId: req.user.vendorId || req.user.sub, enquiryId: req.params.id, message: req.body?.message });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.enquiry);
  },
};
export const vendorResolveEnquiry = {
  created, method: 'post', path: '/vendor/enquiries/:id/resolve', description: 'Vendor: resolve a conversation.',
  onGuard: routeGuard('post', [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('customers')]),
  onRequest: async (req, res) => {
    const result = await shopService.resolveEnquiry({ vendorId: req.user.vendorId || req.user.sub, enquiryId: req.params.id });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.enquiry);
  },
};

export const vendorStaff = {
  created, method: 'get', path: '/vendor/staff', description: 'Vendor / staff with `staff`: list staff. Each entry is exactly { id, displayName, email, phone, vendorRole, vendorPermissions, accountStatus, createdAt } (missing → null).',
  onGuard: routeGuard('get', [requireAuth('vendor', 'vendor_staff', 'admin'), requireVendorPermission('staff')]),
  onRequest: async (req, res) => res.json(await shopService.listVendorStaff(req.user.vendorId || req.user.sub)),
};
export const vendorCreateStaff = {
  created, method: 'post', path: '/vendor/staff', description: 'Vendor: create permission-scoped staff.',
  onGuard: routeGuard('post', requireAuth('vendor', 'admin')),
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
  onGuard: routeGuard('post', requireAuth('vendor', 'admin')),
  onRequest: async (req, res) => {
    const result = await shopService.disableVendorStaff({ vendorId: req.user.sub, staffId: req.params.id });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.staff);
  },
};

export const reviewMarketplaceProduct = {
  created, method: 'post', path: '/me/shop-orders/:orderId/reviews', description: 'Buyer: review a delivered product.',
  onGuard: routeGuard('post', requireAuth()),
  onRequest: async (req, res) => {
    const result = await shopService.reviewProduct({ buyerId: req.user.sub, orderId: req.params.orderId, productId: req.body?.productId, rating: req.body?.rating, comment: req.body?.comment });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(201).json(result.review);
  },
};
export const marketplaceInvoice = {
  created, method: 'get', path: '/me/shop-orders/:id/invoice',
  description: 'Buyer: download an invoice or receipt. Without `format` (or format=text): plain text, exactly as before. Vendor tools · S5 (VENDOR_TOOLS + VENDOR_DOCUMENTS; off → 404 feature_disabled for json/html/pdf): one invoice PER SELLER (the vendor is the seller of record, O-11), numbered INV-… in that vendor\'s series when the order was paid. format=json → { invoices: [document JSON (as GET /vendor/documents/:docType/:docId) + vendorId] } (only my own order; each invoice has only that vendor\'s lines, "Seller: {business}. Sold through the FitFlex app.", never commission or payout); format=html → one page with every invoice; format=pdf → one vendor\'s PDF (&vendorId= required when the order has several sellers → else 400 vendor_required { vendors }; 404 vendor_not_in_order). lang = en | sw, paper = a4 | 80mm. 404 order_not_found (not mine) | invoice_not_ready (not paid yet), 400 invalid_format | invalid_paper, 503 pdf_unavailable (format=pdf while the PDF library cannot be loaded).',
  onGuard: routeGuard('get', requireAuth()),
  onRequest: async (req, res) => {
    const format = req.query?.format == null || req.query.format === '' || req.query.format === 'text' ? null : String(req.query.format);
    if (format) {
      if (!['json', 'html', 'pdf'].includes(format)) return res.status(400).json({ error: 'invalid_format', allowed: ['text', 'json', 'html', 'pdf'] });
      if (!vendorDocumentsOn()) return res.status(404).json({ error: 'feature_disabled' });
      let result;
      try {
        result = await vendorDocumentService.buyerInvoices({ buyerId: req.user.sub, orderId: req.params.id, query: req.query || {} });
      } catch (error) {
        if (error.code === 'pdf_unavailable') return res.status(503).json({ error: 'pdf_unavailable' });
        throw error;
      }
      if (result.error) return sendError(res, result);
      res.set?.('Cache-Control', 'no-store, private');
      if (result.html) {
        res.set?.('Content-Type', 'text/html; charset=utf-8');
        res.set?.('Content-Security-Policy', "default-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
        res.set?.('X-Content-Type-Options', 'nosniff');
        res.set?.('Referrer-Policy', 'no-referrer');
        return res.status(200).send(result.html);
      }
      if (result.pdf) {
        res.set?.('Content-Type', 'application/pdf');
        res.set?.('Content-Disposition', `attachment; filename="${String(result.fileName).replace(/[^A-Za-z0-9._-]/g, '_')}"`);
        res.set?.('X-Content-Type-Options', 'nosniff');
        return res.status(200).send(result.pdf);
      }
      return res.json(result);
    }
    const invoice = await shopService.orderInvoice({ buyerId: req.user.sub, orderId: req.params.id });
    if (!invoice) return res.status(404).json({ error: 'order_not_found' });
    res.type('text/plain').send(invoice);
  },
};
export const marketplaceReorder = {
  created, method: 'post', path: '/me/shop-orders/:id/reorder', description: 'Buyer: return a prior order as a cart payload → { items: [{ productId, variant|null, qty }] }.',
  onGuard: routeGuard('post', requireAuth()),
  onRequest: async (req, res) => {
    const result = await shopService.reorder({ buyerId: req.user.sub, orderId: req.params.id });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  },
};
export const marketplaceNotifications = {
  created, method: 'get', path: '/me/marketplace-notifications', description: 'User: marketplace notifications.',
  onGuard: routeGuard('get', requireAuth()), onRequest: async (req, res) => res.json(await shopService.notifications(req.user.sub)),
};
