// FitFlex Marketplace domain service. All persistence is dependency-injected.
import { formatTsh } from '../shared/money-display.mjs';
import { PRODUCT_CATEGORY_KEYS, PRODUCT_CATEGORIES } from '../shared/product-categories.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { createMemoryShopOrderStore } from './shop-order-store-memory.mjs';
import { updateIf } from '../shared/conditional-update.mjs';
import { decideTransition, combinedStatus, fulfilmentsOf, anyAtLeast, canonicalStatus, nextStatuses, STATUSES, LEGACY_INPUTS } from '../shared/order-lifecycle.mjs';
import { VENDOR_COMMISSION_PCT, vendorCommissionPct, priceOrderLine } from '../shared/marketplace-pricing.mjs';
import { hashPassword } from '../auth/password-credentials.mjs';
import { OPEN_GATE } from './partner-gate.mjs';
import { OPEN_PUBLIC_GATE } from './moderation-gate.mjs';
import { vendorStockLedgerOn } from '../shared/feature-flags.mjs';
import { planStock, reviewChanged, stripPrivate, invalidPrivateField, parseAdjustment, variantsOf, isTracked, eatDayStart } from '../shared/vendor-stock.mjs';

const PRODUCT_STATUSES = new Set(['active', 'paused', 'archived']);
const ORDER_STATUSES = new Set([...STATUSES, ...LEGACY_INPUTS]);
const PAYMENT_METHODS = new Set(['mpesa', 'airtel_money', 'mixx', 'card', 'bank']);
// Email and delivery regions are not mandatory (11 Oct 2026); they are still stored and shown when given.
const PROFILE_REQUIRED = ['businessName', 'logo', 'banner', 'description', 'businessCategory', 'contactNumber', 'address', 'businessHours', 'settlementAccount'];
// Optional profile fields. Partner KYC reads productCategories and returnsPolicy
// for the vendor's marketplace requirements. Anything else in the body is ignored.
const PROFILE_OPTIONAL = ['productCategories', 'returnsPolicy', 'email', 'deliveryRegions'];
const PROFILE_FIELDS = new Set([...PROFILE_REQUIRED, ...PROFILE_OPTIONAL]);
export const STAFF_ROLES = new Set(['admin', 'inventory_manager', 'orders_manager', 'sales', 'customer_care']);
export const STAFF_PERMISSIONS = new Set(['products', 'orders', 'customers', 'reports', 'payments', 'staff']);
const PRODUCT_REVIEW_FIELDS = new Set(['name', 'description', 'category', 'brand', 'priceTzs', 'discountPriceTzs', 'images', 'variants']);
const PUBLIC_PROFILE_FIELDS = ['vendorId', 'businessName', 'logo', 'banner', 'description', 'businessCategory', 'contactNumber', 'email', 'address', 'deliveryRegions', 'businessHours', 'status'];
const publicProfile = profile => profile?.status === 'published'
  ? Object.fromEntries(PUBLIC_PROFILE_FIELDS.filter(key => profile[key] !== undefined).map(key => [key, profile[key]]))
  : null;

const makeId = prefix => `${prefix}_${randomUUID().slice(0, 8)}`;
const nowIso = () => new Date().toISOString();
const MAX_TEXT = { deliveryAddress: 300, note: 500, paymentReference: 100, pickupGymId: 100 };
const MAX_QTY_PER_LINE = 1000;
const MAX_ORDER_TOTAL_TZS = 100_000_000; // far above any real basket, far below the integer column's limit
const MAX_UNPAID_ORDERS = Number(process.env.SHOP_MAX_UNPAID_ORDERS) > 0 ? Number(process.env.SHOP_MAX_UNPAID_ORDERS) : 5;
const isMoneyInt = (v, { allowZero = false } = {}) => Number.isInteger(Number(v)) && (allowZero ? Number(v) >= 0 : Number(v) > 0) && Number(v) <= MAX_ORDER_TOTAL_TZS;

/** What the buyer, the public or a vendor may see of a stored order: not the commission, payouts or internals. */
const INTERNAL_ORDER_FIELDS = ['idempotencyKey', 'idempotencyFingerprint', 'stockState', 'reservationCycle', 'reservationExpiresAt', 'fulfilments', 'settlementStatus'];
const INTERNAL_ITEM_FIELDS = ['commissionPct', 'commissionTzs', 'vendorPayoutTzs', 'variantStockReserved'];
export function buyerOrderView(order) {
  if (!order) return order;
  const view = { ...order, items: (order.items || []).map((item) => {
    const copy = { ...item };
    for (const f of INTERNAL_ITEM_FIELDS) delete copy[f];
    return copy;
  }) };
  for (const f of INTERNAL_ORDER_FIELDS) delete view[f];
  return view;
}
/** A review as the public sees it: no buyer or order identifiers. */
export const publicReview = ({ id, productId, rating, comment, createdAt }) => ({ id, productId, rating, comment, createdAt });
const bool = value => value === true || value === 'true' || value === '1' ? true : value === false || value === 'false' || value === '0' ? false : undefined;
const priceOf = product => Number(product.discountPriceTzs || 0) > 0 && Number(product.discountPriceTzs) < Number(product.priceTzs || 0) ? Number(product.discountPriceTzs) : Number(product.priceTzs || 0);
const csv = value => /[,"\n]/.test(String(value ?? '')) ? `"${String(value ?? '').replaceAll('"', '""')}"` : String(value ?? '');

export function createShopService({ products, shopOrders, users, auditLog, marketplaceEnquiries, marketplaceNotifications, productReviews, paymentRequests = null, partnerGate = OPEN_GATE, partnerKycCases = null,
  // Moderation: pending, rejected, suspended and hidden products and vendors are not shown to buyers.
  publicGate = OPEN_PUBLIC_GATE,
  // A paid order was cancelled and the money is owed back: ({ order, amountTzs, reasonCode, actorId, role }) → refund.
  // Returns the refund; throws if it could not be raised (the failure is recorded). null = nothing configured.
  onRefundDue = async () => null,
  // A paid order, for promotion analytics: (order) → void. Never allowed to fail the order.
  onOrderPaid = async () => null,
  // A cancelled order, for promotion analytics: (order) → void; takes back what the paid order was credited for.
  onOrderCancelled = async () => null,
  // Something the vendor should hear about now, not only find in their list: (vendorUserId, event, data) → void.
  onVendorEvent = async () => null,
  // The order store: reserves stock and writes orders atomically. Production passes the Postgres
  // store; without one the service uses the collections directly (unit specs).
  orderStore = null,
  // How long an unpaid order holds its stock. Orders carry their own expiry from the moment they are placed.
  reservationTtlMinutes = 48 * 60,
  // Off while the app does not yet let a buyer pick a variant: an order that names none reserves
  // product stock only. Switch on (SHOP_REQUIRE_VARIANT=on) once the app sends `variant`.
  requireVariantChoice = false,
  // Vendor tools · S1: the stock ledger store (src/infra/vendor-stock-store-pg.mjs). Without one (unit specs)
  // there is no ledger: products save as before. Its bookkeeping (cost snapshots) runs whenever it is given;
  // what vendors see of it runs only while `stockLedgerOn()` (VENDOR_TOOLS + VENDOR_STOCK_LEDGER).
  stockLedger = null,
  stockLedgerOn = vendorStockLedgerOn,
  now = () => new Date() }) {
  orderStore ||= createMemoryShopOrderStore({ products, shopOrders, paymentRequests, now });
  marketplaceEnquiries ||= { filterAsync: async () => [], findByIdAsync: async () => null };
  marketplaceNotifications ||= { insertAsync: async row => row, filterAsync: async () => [] };
  productReviews ||= { insertAsync: async row => row, filterAsync: async () => [], findAsync: async () => null };

  async function notify(userId, type, data = {}) {
    return marketplaceNotifications.insertAsync({ id: makeId('ntf'), userId, type, data, read: false, createdAt: nowIso() });
  }

  /** For the vendor: in their shop list as before, and pushed to their phone. A failed push never fails the sale. */
  async function notifyVendor(vendorId, type, data = {}) {
    const row = await notify(vendorId, type, data);
    try { await onVendorEvent(vendorId, type, data); } catch { /* best effort */ }
    return row;
  }

  async function getVendorProfile(vendorId) {
    return (await users.findByIdAsync(vendorId))?.vendorProfile || null;
  }

  async function saveVendorProfile({ vendorId, body }) {
    const current = await users.findByIdAsync(vendorId);
    const prior = current?.vendorProfile || {};
    const publish = body?.publish === true;
    if (body?.productCategories !== undefined) {
      const picked = Array.isArray(body.productCategories) ? body.productCategories : [];
      const unknown = picked.filter(key => !PRODUCT_CATEGORY_KEYS.has(key));
      if (unknown.length || !Array.isArray(body.productCategories)) {
        return { error: 'invalid_product_category', status: 400, allowed: PRODUCT_CATEGORIES.map(c => c.key) };
      }
    }
    const profile = { ...prior, ...Object.fromEntries(Object.entries(body || {}).filter(([key]) => PROFILE_FIELDS.has(key))), vendorId, status: publish ? 'published' : prior.status || 'draft', updatedAt: nowIso() };
    const missing = PROFILE_REQUIRED.filter(key => {
      const value = profile[key];
      if (Array.isArray(value)) return !value.length;
      if (value && typeof value === 'object') return !Object.keys(value).length;
      return value == null || String(value).trim() === '';
    });
    if (publish && missing.length) return { error: 'mandatory_profile_fields_missing', status: 400, missing };
    await users.upsertAsync(row => row.id === vendorId, {
      ...(current || { id: vendorId, userType: 'vendor', accountStatus: 'active', approvalStatus: 'approved', createdAt: nowIso() }),
      vendorProfile: profile, onboardingCompleted: publish || current?.onboardingCompleted || false, updatedAt: nowIso(),
    });
    return { profile };
  }

  /**
   * Of these vendor ids, those an admin has suspended on their account (User.accountStatus).
   * Separate from moderation suspension (publicGate): either one takes a vendor off sale.
   */
  async function accountSuspendedVendorIds(vendorIds) {
    const ids = [...new Set((vendorIds || []).filter(Boolean))];
    if (!ids.length) return new Set();
    const rows = users.filterByColumnInAsync ? await users.filterByColumnInAsync('id', ids) : await users.filterAsync(user => ids.includes(user.id));
    return new Set(rows.filter(user => user.accountStatus === 'suspended').map(user => user.id));
  }

  async function getVendorStore(vendorId) {
    if (!(await partnerGate.isOperational(vendorId))) return null;
    if ((await accountSuspendedVendorIds([vendorId])).has(vendorId)) return null;
    if (await publicGate.isBlocked('vendor', vendorId)) return null;
    const profile = publicProfile(await getVendorProfile(vendorId));
    if (!profile) return null;
    const storeProducts = await listProducts({ vendorId });
    const reviews = (await productReviews.filterAsync(review => storeProducts.some(product => product.id === review.productId))).map(publicReview);
    const rating = reviews.length ? reviews.reduce((sum, review) => sum + Number(review.rating || 0), 0) / reviews.length : 0;
    return { ...profile, rating, reviewCount: reviews.length, products: storeProducts, reviews };
  }

  async function listProducts({ category, search, vendorId, includeArchived = false, brand, minPrice, maxPrice, minRating, maxDistanceKm, delivery, promotions, sort } = {}) {
    let rows = await products.filterAsync(product => {
      if (product.deletedAt) return false;
      if (includeArchived) return true;
      return product.status === 'active' && !['pending', 'rejected'].includes(product.approvalStatus) && product.visibility !== 'hidden' && product.homepageVisible !== false;
    });
    if (vendorId) rows = rows.filter(product => product.vendorId === vendorId);
    // Buyers only see products from vendors who may sell (new vendors: once verified), and never
    // from a vendor suspended in moderation or on their account.
    if (!includeArchived) {
      const vendorIds = rows.map(product => product.vendorId);
      const [ok, blockedProducts, blockedVendors, suspendedVendors] = await Promise.all([
        partnerGate.operationalUserIds(vendorIds), publicGate.blocked('product'), publicGate.blocked('vendor'), accountSuspendedVendorIds(vendorIds),
      ]);
      rows = rows.filter(product => ok.has(product.vendorId) && !blockedProducts.has(product.id) && !blockedVendors.has(product.vendorId) && !suspendedVendors.has(product.vendorId));
    }
    if (category) rows = rows.filter(product => String(product.category || '').toLowerCase() === String(category).toLowerCase());
    if (brand) rows = rows.filter(product => String(product.brand || '').toLowerCase() === String(brand).toLowerCase());
    const deliveryFlag = bool(delivery);
    if (deliveryFlag !== undefined) rows = rows.filter(product => Boolean(product.deliveryAvailable) === deliveryFlag);
    if (minRating !== undefined) rows = rows.filter(product => Number(product.rating || 0) >= Number(minRating));
    if (maxDistanceKm !== undefined) rows = rows.filter(product => Number(product.distanceKm ?? Number.POSITIVE_INFINITY) <= Number(maxDistanceKm));
    if (minPrice !== undefined) rows = rows.filter(product => priceOf(product) >= Number(minPrice));
    if (maxPrice !== undefined) rows = rows.filter(product => priceOf(product) <= Number(maxPrice));
    if (bool(promotions) === true) rows = rows.filter(product => Number(product.discountPriceTzs || 0) > 0 && Number(product.discountPriceTzs) < Number(product.priceTzs || 0));
    const query = String(search || '').trim().toLowerCase();
    if (query) rows = rows.filter(product => [product.name, product.description, product.category, product.brand, product.sku].some(value => String(value || '').toLowerCase().includes(query)));
    if (sort === 'popularity') return rows.sort((a, b) => Number(b.soldCount || 0) - Number(a.soldCount || 0));
    if (sort === 'price_asc') return rows.sort((a, b) => priceOf(a) - priceOf(b));
    if (sort === 'price_desc') return rows.sort((a, b) => priceOf(b) - priceOf(a));
    if (sort === 'rating') return rows.sort((a, b) => Number(b.rating || 0) - Number(a.rating || 0));
    return rows.sort((a, b) => Number(b.homepagePriority || 0) - Number(a.homepagePriority || 0) || +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0));
  }

  async function getProduct(productId, { includeUnlisted = false } = {}) {
    const product = await products.findByIdAsync(productId);
    if (!product || product.deletedAt) return null;
    if (!includeUnlisted && !(await listProducts({})).some(row => row.id === productId)) return null;
    const reviews = (await productReviews.filterAsync(review => review.productId === productId)).map(publicReview);
    return { ...product, vendor: publicProfile(await getVendorProfile(product.vendorId)), reviews, similarProducts: (await listProducts({ category: product.category })).filter(row => row.id !== productId).slice(0, 6) };
  }

  /** Shape and size limits on what a vendor may store; null when fine. */
  function validateProductInput(input) {
    const text = (field, max) => (input[field] != null && (typeof input[field] !== 'string' || input[field].length > max) ? { error: 'invalid_field', status: 400, field } : null);
    for (const [field, max] of [['name', 200], ['description', 5000], ['brand', 100], ['sku', 100], ['category', 100]]) {
      const problem = text(field, max);
      if (problem) return problem;
    }
    for (const field of ['priceTzs', 'discountPriceTzs']) {
      if (input[field] != null && !isMoneyInt(input[field], { allowZero: field === 'discountPriceTzs' })) return { error: field === 'priceTzs' ? 'priceTzs_required' : 'invalid_field', status: 400, field };
    }
    if (input.stock != null && (!Number.isInteger(Number(input.stock)) || Number(input.stock) < 0 || Number(input.stock) > 1_000_000)) return { error: 'invalid_stock', status: 400 };
    if (input.images != null && (!Array.isArray(input.images) || input.images.length > 10 || input.images.some(i => typeof i !== 'string' || i.length > 500))) return { error: 'invalid_field', status: 400, field: 'images' };
    if (input.variants != null) {
      const v = input.variants;
      const ok = Array.isArray(v) && v.length <= 30 && v.every(x => x && typeof x === 'object' && typeof x.name === 'string' && x.name.trim() && x.name.length <= 60
        && (x.stock == null || (Number.isInteger(x.stock) && x.stock >= 0 && x.stock <= 1_000_000)) && !invalidPrivateField(x));
      if (!ok) return { error: 'invalid_field', status: 400, field: 'variants' };
    }
    const privateField = invalidPrivateField(input);
    if (privateField) return { error: 'invalid_field', status: 400, field: privateField };
    return null;
  }

  const ledgerOn = () => Boolean(stockLedger) && stockLedgerOn();
  /** Cost price and reorder level in the body: [{ variant, costTzs?, reorderLevel? }] ('' = the product). */
  function privatesFrom(input) {
    const out = [];
    if (input.costTzs !== undefined || input.reorderLevel !== undefined) out.push({ variant: '', costTzs: input.costTzs, reorderLevel: input.reorderLevel });
    for (const v of Array.isArray(input.variants) ? input.variants : []) {
      if (v.costTzs !== undefined || v.reorderLevel !== undefined) out.push({ variant: String(v.name).trim(), costTzs: v.costTzs, reorderLevel: v.reorderLevel });
    }
    return out;
  }

  async function upsertProduct({ vendorId, body, productId, keepCategory = false, actorId = vendorId }) {
    const input = body || {};
    const bad = validateProductInput(input);
    if (bad) return bad;
    if (productId) {
      const prior = await products.findByIdAsync(productId);
      if (!prior || prior.deletedAt) return { error: 'product_not_found', status: 404 };
      if (prior.vendorId !== vendorId) return { error: 'not_your_product', status: 403 };
      if (input.name !== undefined && !String(input.name).trim()) return { error: 'name_required', status: 400 };
      if (input.priceTzs !== undefined && Number(input.priceTzs) <= 0) return { error: 'priceTzs_required', status: 400 };
      if (input.stock !== undefined && Number(input.stock) < 0) return { error: 'invalid_stock', status: 400 };
      // A category must come from the list when it is changed; an existing free-text one is left alone.
      if (input.category && input.category !== prior.category && !PRODUCT_CATEGORY_KEYS.has(input.category)) {
        return { error: 'invalid_category', status: 400, allowed: PRODUCT_CATEGORIES.map(c => c.key) };
      }
      const patch = { updatedAt: nowIso() };
      if (input.name !== undefined) patch.name = String(input.name).trim();
      for (const field of ['description', 'category', 'brand', 'sku', 'visibility', 'deliveryAvailable']) if (input[field] !== undefined) patch[field] = input[field];
      for (const field of ['priceTzs', 'discountPriceTzs', 'weightKg', 'distanceKm']) if (input[field] !== undefined) patch[field] = input[field] === null ? null : Number(input[field]);
      if (Array.isArray(input.images)) patch.images = input.images;
      if (input.status && PRODUCT_STATUSES.has(input.status)) patch.status = input.status;
      const needsReview = (current, variants) => current.approvalStatus === 'approved'
        && Object.keys(input).some(field => PRODUCT_REVIEW_FIELDS.has(field)) && reviewChanged(current, input, variants);
      if (ledgerOn()) {
        // Stock moves only with a ledger row: a changed count from the form (old app builds send `stock`
        // on every save) is recorded as a `count`, decided under the product's row lock.
        // Fields, approval status, stock and ledger rows are written together, in one transaction.
        const saved = await stockLedger.applyProductForm({
          productId, vendorId, actorId,
          decide: (current) => {
            const plan = planStock(current, input, { ledger: true });
            if (plan.error) return plan;
            const fields = needsReview(current, plan.variants || null) ? { ...patch, approvalStatus: 'pending' } : patch;
            return { ...plan, fields, privates: privatesFrom(input) };
          },
        });
        if (saved.error) return saved;
        await afterStockMoved([productId]);
        return { product: (await vendorProductsView(vendorId, [saved.product]))[0] };
      }
      // Variants are merged by name and keep their stored stock when the body leaves it out (F3).
      const plan = planStock(prior, input, { ledger: false });
      if (plan.variants) patch.variants = plan.variants;
      if (plan.stock !== undefined) patch.stock = plan.stock;
      // Back to review only when something FitFlex reviews actually changed (F1).
      if (needsReview(prior, plan.variants || null)) patch.approvalStatus = 'pending';
      return { product: await products.updateByIdAsync(productId, patch) };
    }
    if (!input.name?.trim()) return { error: 'name_required', status: 400 };
    if (input.category && !keepCategory && !PRODUCT_CATEGORY_KEYS.has(input.category)) {
      return { error: 'invalid_category', status: 400, allowed: PRODUCT_CATEGORIES.map(c => c.key) };
    }
    if (input.priceTzs == null || Number(input.priceTzs) <= 0) return { error: 'priceTzs_required', status: 400 };
    if (Number(input.stock ?? 0) < 0) return { error: 'invalid_stock', status: 400 };
    const ledger = ledgerOn();
    const plan = ledger ? planStock(null, input, { ledger: true }) : null;
    if (plan?.error) return plan;
    const at = nowIso();
    const row = {
      id: makeId('prd'), vendorId, name: input.name.trim(), description: input.description || null, category: input.category || null,
      brand: input.brand || null, priceTzs: Number(input.priceTzs), discountPriceTzs: input.discountPriceTzs == null ? null : Number(input.discountPriceTzs),
      stock: plan ? plan.stock : Number(input.stock ?? 0), sku: input.sku || null, weightKg: input.weightKg == null ? null : Number(input.weightKg), distanceKm: input.distanceKm == null ? null : Number(input.distanceKm),
      // Cost price and reorder level never go on the public row.
      variants: plan?.variants ?? (Array.isArray(input.variants) ? input.variants.map(stripPrivate) : []), images: Array.isArray(input.images) ? input.images : [], visibility: input.visibility || 'visible',
      // Rating, review count and sold count are the server's: reviewProduct recomputes the first two from real
      // reviews and the order store keeps soldCount. Whatever a vendor (or admin) sends for them is ignored.
      deliveryAvailable: input.deliveryAvailable !== false, status: 'active', approvalStatus: 'pending', rating: 0, reviewCount: 0, soldCount: 0,
      homepageVisible: true, homepagePriority: 0, createdAt: at, updatedAt: at,
    };
    if (ledger) {
      // The product and the first rows of its stock history are written together, in one transaction.
      const product = await stockLedger.createProduct({ product: row, actorId, movements: plan.movements, privates: privatesFrom(input) });
      await afterStockMoved([product.id]);
      return { product: (await vendorProductsView(vendorId, [product]))[0], created: true };
    }
    const product = await products.insertAsync(row);
    return { product, created: true };
  }

  /**
   * What the vendor sees of their own products: with the ledger on, the private fields too —
   * costTzs / reorderLevel (the product's own, '' row), and per variant its own costTzs / reorderLevel
   * plus the effective ones (own, else the product's: Q-1). Never used for public views.
   */
  async function vendorProductsView(vendorId, rows) {
    if (!ledgerOn() || !rows.length) return rows;
    const privates = await stockLedger.privatesOf(vendorId, rows.map(p => p.id));
    return rows.map((p) => {
      const own = privates.get(p.id);
      const base = own?.get('') || null;
      return {
        ...p,
        costTzs: base?.costTzs ?? null,
        reorderLevel: base?.reorderLevel ?? null,
        variants: variantsOf(p).map((v) => {
          const mine = own?.get(v.name) || null;
          return {
            ...v, stock: isTracked(v) ? v.stock : null,
            costTzs: mine?.costTzs ?? null, reorderLevel: mine?.reorderLevel ?? null,
            effectiveCostTzs: mine?.costTzs ?? base?.costTzs ?? null,
            effectiveReorderLevel: mine?.reorderLevel ?? base?.reorderLevel ?? null,
          };
        }),
      };
    });
  }

  /** GET /vendor/products: own products, including archived (private fields with the ledger on). */
  async function vendorListProducts(vendorId) {
    return vendorProductsView(vendorId, await listProducts({ vendorId, includeArchived: true }));
  }

  /**
   * Stock moved for these products: tell the vendor about each unit that has just gone to or below its
   * reorder level — once per crossing. Ledger on only (Q-3). Never fails the change that moved the stock.
   */
  async function afterStockMoved(productIds) {
    if (!ledgerOn()) return;
    for (const productId of new Set(productIds.filter(Boolean))) {
      try {
        for (const unit of await stockLedger.checkLow(productId)) {
          await notifyVendor(unit.vendorId, 'vendor_low_stock', {
            productId: unit.productId, productName: unit.name, variant: unit.variant, stock: unit.stock, reorderLevel: unit.reorderLevel,
          });
        }
      } catch (err) {
        console.warn('[shop] low-stock check failed:', productId, err?.message);
      }
    }
  }
  const productIdsOf = order => (order?.items || []).map(item => item.productId);

  /** POST /vendor/products/:id/stock-adjustments. */
  async function adjustStock({ vendorId, actorId, productId, body }) {
    const adj = parseAdjustment(body || {});
    if (adj.error) return adj;
    const out = await stockLedger.adjust({ vendorId, actorId, productId, adj });
    if (out.error) return out;
    if (!out.replayed) await afterStockMoved([productId]);
    return { movement: out.movement, product: out.product, status: out.replayed ? 200 : 201 };
  }

  /** GET /vendor/products/:id/stock-movements?from&to&variant&limit&cursor (from/to: EAT days, inclusive). */
  async function stockMovements({ vendorId, productId, query = {} }) {
    const from = query.from ? eatDayStart(query.from) : null;
    if (query.from && !from) return { error: 'invalid_date', status: 400, field: 'from' };
    const toDay = query.to ? eatDayStart(query.to) : null;
    if (query.to && !toDay) return { error: 'invalid_date', status: 400, field: 'to' };
    const to = toDay ? new Date(+toDay + 86_400_000) : null;
    if (from && to && from >= to) return { error: 'invalid_date', status: 400, field: 'to' };
    const limit = query.limit == null || query.limit === '' ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return { error: 'invalid_limit', status: 400, max: 200 };
    const variant = typeof query.variant === 'string' && query.variant.trim() ? query.variant.trim() : null;
    return stockLedger.movements({ vendorId, productId, variant, from, to, limit, cursor: query.cursor || null });
  }

  /** GET /vendor/stock/low. */
  async function lowStock(vendorId) {
    return stockLedger.lowStock(vendorId);
  }

  async function duplicateProduct({ vendorId, productId }) {
    const prior = await products.findByIdAsync(productId);
    if (!prior) return { error: 'product_not_found', status: 404 };
    if (prior.vendorId !== vendorId) return { error: 'not_your_product', status: 403 };
    return upsertProduct({ vendorId, body: { ...prior, name: `${prior.name} Copy`, sku: null }, keepCategory: true });
  }
  async function deleteProduct({ vendorId, productId }) {
    const prior = await products.findByIdAsync(productId);
    if (!prior) return { error: 'product_not_found', status: 404 };
    if (prior.vendorId !== vendorId) return { error: 'not_your_product', status: 403 };
    await products.updateByIdAsync(productId, { deletedAt: nowIso(), status: 'archived', updatedAt: nowIso() });
    return { deleted: true };
  }
  async function adminListProducts() {
    return (await products.filterAsync(product => !product.deletedAt)).sort((a, b) => Number(b.homepagePriority || 0) - Number(a.homepagePriority || 0) || String(a.name || '').localeCompare(String(b.name || '')));
  }
  async function adminCreateProduct({ body, actorId }) {
    const vendorId = String(body?.vendorId || '').trim();
    if (!vendorId) return { error: 'vendor_required', status: 400 };
    const vendor = await users.findByIdAsync(vendorId);
    if (!vendor || vendor.userType !== 'vendor') return { error: 'vendor_not_found', status: 404 };
    if (vendor.accountStatus === 'suspended') return { error: 'vendor_suspended', status: 409 };
    const created = await upsertProduct({ vendorId, body, actorId });
    if (created.error) return created;
    const requestedApproval = ['pending', 'approved', 'rejected'].includes(body?.approvalStatus)
      ? body.approvalStatus
      : 'pending';
    const product = await products.updateByIdAsync(created.product.id, {
      approvalStatus: requestedApproval,
      homepageVisible: body?.homepageVisible === true,
      homepagePriority: Number(body?.homepagePriority || 0),
      updatedAt: nowIso(),
    });
    await auditLog.insertAsync({
      id: randomUUID(), at: nowIso(), actor: actorId, action: 'admin_product_created',
      target: product.id, before: null, after: { vendorId, approvalStatus: requestedApproval },
    });
    if (requestedApproval !== 'pending') await notifyVendor(vendorId, `product_${requestedApproval}`, { productId: product.id });
    return { product, status: 201 };
  }
  async function adminUpdateProductListing({ productId, body, actorId }) {
    const prior = await products.findByIdAsync(productId);
    if (!prior) return { error: 'product_not_found', status: 404 };
    const patch = { ...(typeof body?.homepageVisible === 'boolean' ? { homepageVisible: body.homepageVisible } : {}), ...(body?.homepagePriority !== undefined ? { homepagePriority: Number(body.homepagePriority) || 0 } : {}), ...(['approved', 'pending', 'rejected'].includes(body?.approvalStatus) ? { approvalStatus: body.approvalStatus } : {}), updatedAt: nowIso() };
    const product = await products.updateByIdAsync(productId, patch);
    await auditLog.insertAsync({ id: randomUUID(), at: nowIso(), actor: actorId, action: 'product_listing_updated', target: productId, before: { homepageVisible: prior.homepageVisible ?? true, homepagePriority: Number(prior.homepagePriority || 0), approvalStatus: prior.approvalStatus || 'pending' }, after: patch });
    if (patch.approvalStatus) await notifyVendor(prior.vendorId, `product_${patch.approvalStatus}`, { productId });
    return { product };
  }

  async function adminListVendors() {
    const vendors = await users.filterAsync(user => user.userType === 'vendor');
    const allProducts = await products.filterAsync(product => !product.deletedAt);
    // "Verified" for a vendor is their KYC outcome, not a manual flag.
    const cases = partnerKycCases && vendors.length
      ? await partnerKycCases.filterByColumnInAsync('userId', vendors.map(v => v.id))
      : [];
    const kycStatus = new Map(cases.filter(c => c.partnerType === 'vendor').map(c => [c.userId, c.status]));
    return vendors
      .map(({ passwordHash, firebaseUid, ...vendor }) => ({
        ...vendor,
        vendorProfile: vendor.vendorProfile || null,
        kycStatus: kycStatus.get(vendor.id) || null,
        commissionPct: vendorCommissionPct(vendor),
        kycExempt: partnerGate.exempt(vendor),
        productCount: allProducts.filter(product => product.vendorId === vendor.id).length,
        pendingProductCount: allProducts.filter(product => product.vendorId === vendor.id && (product.approvalStatus || 'pending') === 'pending').length,
      }))
      .sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0));
  }

  async function adminUpdateVendor({ vendorId, body, actorId }) {
    const vendor = await users.findByIdAsync(vendorId);
    if (!vendor || vendor.userType !== 'vendor') return { error: 'vendor_not_found', status: 404 };
    const patch = { updatedAt: nowIso() };
    if (['pending_approval', 'approved', 'rejected'].includes(body?.approvalStatus)) {
      // New vendors are approved through their KYC case.
      if (!partnerGate.exempt(vendor)) return { error: 'use_kyc_review', status: 409 };
      patch.approvalStatus = body.approvalStatus;
      patch.approvalNote = body.approvalNote == null ? vendor.approvalNote || null : String(body.approvalNote).trim() || null;
    }
    if (['active', 'suspended'].includes(body?.accountStatus)) patch.accountStatus = body.accountStatus;
    // The marketplace commission FitFlex takes on this vendor's sales, from their next order on.
    if (body?.commissionPct != null) {
      const pct = Number(body.commissionPct);
      if (!Number.isFinite(pct) || pct < VENDOR_COMMISSION_PCT.min || pct > VENDOR_COMMISSION_PCT.max) {
        return { error: 'invalid_commission', status: 400, min: VENDOR_COMMISSION_PCT.min, max: VENDOR_COMMISSION_PCT.max };
      }
      patch.vendorProfile = { ...(vendor.vendorProfile || {}), vendorId, commissionPct: pct };
    }
    const updated = await users.updateByIdAsync(vendorId, patch);
    await auditLog.insertAsync({
      id: randomUUID(), at: nowIso(), actor: actorId, action: 'vendor_management_updated',
      target: vendorId,
      before: { approvalStatus: vendor.approvalStatus, accountStatus: vendor.accountStatus, commissionPct: vendorCommissionPct(vendor) },
      after: { ...patch, ...(patch.vendorProfile ? { vendorProfile: undefined, commissionPct: patch.vendorProfile.commissionPct } : {}) },
    });
    if (patch.approvalStatus) await notifyVendor(vendorId, `vendor_${patch.approvalStatus}`, { approvalNote: patch.approvalNote });
    return { vendor: updated };
  }

  const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,100}$/;
  const MAX_ORDER_LINES = 50;
  const fingerprintOf = (lines, body, deliveryMethod, paymentMethod) => createHash('sha256').update(JSON.stringify({
    lines: lines.map(({ productId, variant, qty }) => [productId, variant || null, qty]), deliveryMethod, paymentMethod,
    pickupGymId: deliveryMethod === 'gym_pickup' ? body.pickupGymId : null,
    deliveryAddress: deliveryMethod === 'home_delivery' ? body.deliveryAddress : null,
  })).digest('hex');

  /**
   * Place an order. Prices come from the product rows, never from the request.
   * Stock is reserved, the order written and its payment request created in one
   * atomic step; a retry with the same idempotencyKey returns the original order.
   */
  async function createOrder({ buyerId, buyerRole = 'member', body, idempotencyKey = null }) {
    const items = Array.isArray(body?.items) ? body.items : [];
    if (!items.length) return { error: 'items_required', status: 400 };
    if (items.length > MAX_ORDER_LINES) return { error: 'too_many_items', status: 400 };
    const key = idempotencyKey ?? body?.idempotencyKey ?? null;
    if (key != null && !IDEMPOTENCY_KEY.test(String(key))) return { error: 'invalid_idempotency_key', status: 400 };
    const deliveryMethod = body?.deliveryMethod || 'home_delivery';
    if (!['home_delivery', 'gym_pickup'].includes(deliveryMethod)) return { error: 'invalid_delivery_method', status: 400 };
    if (deliveryMethod === 'gym_pickup' && !body?.pickupGymId) return { error: 'pickup_gym_required', status: 400 };
    if (deliveryMethod === 'home_delivery' && !body?.deliveryAddress) return { error: 'delivery_address_required', status: 400 };
    const paymentMethod = body?.paymentMethod || 'mpesa';
    if (!PAYMENT_METHODS.has(paymentMethod)) return { error: 'invalid_payment_method', status: 400 };
    for (const [field, max] of Object.entries(MAX_TEXT)) {
      const value = body?.[field];
      if (value != null && (typeof value !== 'string' || value.length > max)) return { error: 'invalid_field', status: 400, field };
    }
    if (body?.note != null && typeof body.note !== 'string') return { error: 'invalid_field', status: 400, field: 'note' };
    // The app's own payment result is never trusted: an order is paid only
    // once FitFlex confirms the payment (admin approval of its payment request).
    if (body?.paymentOutcome === 'failed') return { error: 'payment_failed', status: 402 };
    // The same product (and variant) on two lines is one line: stock is checked and reserved for the total.
    const wanted = new Map();
    for (const item of items) {
      const qty = Number(item?.qty || 0);
      if (!Number.isSafeInteger(qty) || qty <= 0 || qty > MAX_QTY_PER_LINE) return { error: 'invalid_quantity', status: 400 };
      if (typeof item.productId !== 'string' || !item.productId) return { error: 'product_not_found', status: 404, productId: item?.productId };
      const variant = item.variant == null || item.variant === '' ? null : String(item.variant).trim();
      if (item.variant != null && typeof item.variant !== 'string') return { error: 'invalid_variant', status: 400, productId: item.productId };
      const lineKey = `${item.productId}\u0000${variant || ''}`;
      const line = wanted.get(lineKey) || { productId: item.productId, variant, qty: 0 };
      line.qty += qty;
      wanted.set(lineKey, line);
    }
    const lines = [...wanted.values()].sort((a, b) => (a.productId + (a.variant || '') < b.productId + (b.variant || '') ? -1 : 1));
    const fingerprint = fingerprintOf(lines, body, deliveryMethod, paymentMethod);
    // A retry gets the order it already made, even if stock or the listing has changed since.
    if (key) {
      const earlier = await orderStore.findReplay({ buyerId, key: String(key), fingerprint });
      if (earlier?.error) return { error: earlier.error, status: earlier.status };
      if (earlier) return earlier.order.paymentStatus === 'paid' ? { order: earlier.order, status: 201, replayed: true } : { order: earlier.order, paymentRequest: earlier.paymentRequest, status: 202, replayed: true };
    }
    // Reserving stock costs other customers: an unpaid order holds it until paid or expired, so one
    // buyer may not hold an unbounded number of them.
    if (paymentRequests) {
      const open = await shopOrders.filterAsync(o => o.buyerId === buyerId && o.status === 'pending' && o.paymentStatus === 'pending');
      if (open.length >= MAX_UNPAID_ORDERS) return { error: 'too_many_unpaid_orders', status: 429, limit: MAX_UNPAID_ORDERS };
    }
    const resolved = [];
    // Product stock is always the limit; a variant that keeps its own stock is a second limit on its units.
    const productStock = new Map();
    for (const { productId, variant, qty } of lines) {
      const product = await products.findByIdAsync(productId);
      if (!product || product.deletedAt || product.status !== 'active' || ['pending', 'rejected'].includes(product.approvalStatus)) return { error: 'product_not_found', status: 404, productId };
      // The vendor has hidden it: it is not sold, even by id.
      if ((product.visibility || 'visible') === 'hidden') return { error: 'product_not_found', status: 404, productId };
      if (!(await partnerGate.isOperational(product.vendorId))) return { error: 'product_not_found', status: 404, productId };
      // Hidden or suspended in moderation: it is not sold, even to someone with an old link.
      if (await publicGate.isBlocked('product', product.id) || await publicGate.isBlocked('vendor', product.vendorId)) return { error: 'product_not_found', status: 404, productId };
      // The vendor's account is suspended by an admin: refused with its own code so the app can say why.
      // Orders placed before the suspension are left as they are (see updateOrderStatus).
      if ((await accountSuspendedVendorIds([product.vendorId])).has(product.vendorId)) return { error: 'vendor_unavailable', status: 409, productId };
      const variants = Array.isArray(product.variants) ? product.variants.filter(v => v && typeof v === 'object') : [];
      const chosen = variant ? variants.find(v => v.name === variant) : null;
      if (variant && !chosen) return { error: 'variant_not_found', status: 404, productId };
      // Variants that keep their own stock must be chosen once the app can choose; plain labels (no stock) are optional.
      // With the stock ledger on, a product whose variants keep stock is always sold by variant: units taken
      // from the product alone would leave its count and its variants' counts apart (security review H1).
      if ((requireVariantChoice || ledgerOn()) && !variant && variants.some(v => typeof v.stock === 'number')) return { error: 'variant_required', status: 400, productId, variants: variants.map(v => v.name) };
      const variantTracked = Boolean(chosen && typeof chosen.stock === 'number');
      if (variantTracked && chosen.stock < qty) return { error: 'insufficient_stock', status: 409, productId };
      productStock.set(productId, (productStock.get(productId) || 0) + qty);
      if (Number(product.stock) < productStock.get(productId)) return { error: 'insufficient_stock', status: 409, productId: product.id };
      resolved.push({ product, qty, variant, variantTracked });
    }
    // Each line carries the commission at its vendor's rate today, so a later rate change never alters this order.
    const rates = new Map();
    for (const vendorId of new Set(resolved.map(({ product }) => product.vendorId).filter(Boolean))) {
      rates.set(vendorId, vendorCommissionPct(await users.findByIdAsync(vendorId)));
    }
    const orderItems = resolved.map(({ product, qty, variant, variantTracked }) => {
      const priceTzs = priceOf(product);
      const { commissionPct, commissionTzs, vendorPayoutTzs } = priceOrderLine({ priceTzs, qty, commissionPct: rates.get(product.vendorId) ?? VENDOR_COMMISSION_PCT.default });
      return {
        productId: product.id, vendorId: product.vendorId, name: product.name, qty, priceTzs, image: product.images?.[0] || null, commissionPct, commissionTzs, vendorPayoutTzs,
        ...(variant ? { variant, ...(variantTracked ? { variantStockReserved: true } : {}) } : {}),
      };
    });
    const totalTzs = orderItems.reduce((sum, item) => sum + item.priceTzs * item.qty, 0);
    if (totalTzs > MAX_ORDER_TOTAL_TZS) return { error: 'order_too_large', status: 400, maxTzs: MAX_ORDER_TOTAL_TZS };
    const placedAt = now();
    const at = placedAt.toISOString();
    const free = totalTzs === 0 || !paymentRequests;
    const orderId = makeId('ord');
    const order = {
      id: orderId, buyerId, buyerRole, items: orderItems, totalTzs, status: 'pending', deliveryMethod,
      pickupGymId: deliveryMethod === 'gym_pickup' ? body.pickupGymId : null,
      deliveryAddress: deliveryMethod === 'home_delivery' ? body.deliveryAddress : null,
      paymentMethod, paymentStatus: free ? 'paid' : 'pending', paymentReference: body.paymentReference || null,
      timeline: [{ status: 'pending', at }], note: body?.note || null, settlementStatus: 'pending',
      // One fulfilment per vendor: each vendor moves only their own.
      fulfilments: [...new Set(orderItems.map(item => item.vendorId).filter(Boolean))].map(vendorId => ({ vendorId, status: 'pending', timeline: [{ status: 'pending', at }], updatedAt: at })),
      reservationExpiresAt: free ? null : new Date(+placedAt + reservationTtlMinutes * 60_000).toISOString(),
      createdAt: at, updatedAt: at,
    };
    // Stock stays reserved while the payment is confirmed.
    const paymentRequest = free ? null : {
      id: makeId('pay'), memberId: buyerId, orderId, amountTzs: totalTzs, currency: 'TZS',
      status: 'pending', provider: 'admin_approved', reference: body.paymentReference || null,
      requestedAt: at, decidedAt: null, decidedBy: null, note: null,
    };
    const placed = await orderStore.placeOrder({
      order,
      lines: resolved.map(({ product, qty, variant, variantTracked }) => ({ productId: product.id, variant, variantTracked, qty, priceTzs: Number(product.priceTzs || 0), discountPriceTzs: Number(product.discountPriceTzs || 0) })),
      paymentRequest,
      idempotency: key ? { key: String(key), fingerprint } : null,
    });
    if (placed.error) return { error: placed.error, status: placed.status, productId: placed.productId };
    if (placed.replayed) return placed.order.paymentStatus === 'paid' ? { order: placed.order, status: 201, replayed: true } : { order: placed.order, paymentRequest: placed.paymentRequest, status: 202, replayed: true };
    await afterStockMoved(lines.map(l => l.productId));
    if (free) {
      await orderPaid(placed.order);
      return { order: placed.order, status: 201 };
    }
    return { order: placed.order, paymentRequest: placed.paymentRequest, status: 202 };
  }

  async function orderPaid(order) {
    // Bookkeeping for vendor profit reports: each line's cost as it is now. A side table only;
    // the order, its prices, commission and settlement are untouched. Never fails the payment.
    if (stockLedger) {
      try { await stockLedger.snapshotOrderCosts(order); } catch (err) { console.warn('[shop] order line costs not recorded:', order?.id, err?.message); }
    }
    try { await onOrderPaid(order); } catch (err) { console.warn('[shop] order not credited to a promotion:', err?.message); }
    for (const vendorId of new Set((order.items || []).map(item => item.vendorId))) await notifyVendor(vendorId, 'new_order', { orderId: order.id });
    await notify(order.buyerId, 'payment_received', { orderId: order.id, totalTzs: order.totalTzs });
  }

  /**
   * Raise the refund for money held for an order. It is never more than was confirmed. A failure is
   * recorded (audit `shop_refund_not_raised`), never only logged: the order stays `refund_pending`,
   * which the reconciliation report lists and `raiseMissingRefund` retries.
   */
  async function raiseRefund(order, { reasonCode, actorId, role }) {
    const fail = async (error) => {
      console.error('[shop] refund not raised:', order.id, error);
      try {
        await auditLog.insertAsync({ id: randomUUID(), at: nowIso(), actor: actorId || 'system', action: 'shop_refund_not_raised', target: order.id, before: null, after: { reasonCode, error: String(error).slice(0, 300) } });
      } catch (auditErr) { console.error('[shop] refund failure not recorded:', auditErr?.message); }
      return null;
    };
    try {
      let amountTzs = Number(order.totalTzs);
      if (paymentRequests) {
        const confirmed = (await paymentRequests.filterAsync(p => p.orderId === order.id && p.status === 'approved')).reduce((sum, p) => sum + Number(p.amountTzs || 0), 0);
        if (confirmed > 0 && confirmed < amountTzs) {
          await auditLog.insertAsync({ id: randomUUID(), at: nowIso(), actor: 'system', action: 'shop_refund_amount_capped', target: order.id, before: { totalTzs: amountTzs }, after: { confirmedTzs: confirmed } });
          amountTzs = confirmed;
        }
      }
      return await onRefundDue({ order, amountTzs, reasonCode, actorId, role });
    } catch (err) {
      return fail(err?.message || err);
    }
  }

  /** Staff: retry the refund of an order that is owed money and has none raised. Safe to repeat. */
  async function raiseMissingRefund({ orderId, actorId }) {
    const order = await shopOrders.findByIdAsync(orderId);
    if (!order) return { error: 'order_not_found', status: 404 };
    if (order.paymentStatus !== 'refund_pending') return { error: 'no_refund_owed', status: 409, paymentStatus: order.paymentStatus };
    const refund = await raiseRefund(order, { reasonCode: 'payment_error', actorId, role: 'admin' });
    if (!refund) return { error: 'refund_not_raised', status: 502 };
    await auditLog.insertAsync({ id: randomUUID(), at: nowIso(), actor: actorId, action: 'shop_refund_retried', target: orderId, before: null, after: { refundId: refund.id } });
    return { refund };
  }

  /**
   * Staff: an order whose payment was confirmed but which was never marked paid (the confirmation
   * was recorded and the system stopped before the order was updated). Re-applies it; safe to repeat.
   */
  async function repairOrderPayment({ orderId, actorId }) {
    const order = await shopOrders.findByIdAsync(orderId);
    if (!order) return { error: 'order_not_found', status: 404 };
    if (order.paymentStatus === 'paid') return { order, unchanged: true };
    const approved = paymentRequests ? await paymentRequests.filterAsync(p => p.orderId === orderId && p.status === 'approved') : [];
    if (!approved.length) return { error: 'no_confirmed_payment', status: 409 };
    await applyPaymentToOrder(orderId, 'approved');
    await auditLog.insertAsync({ id: randomUUID(), at: nowIso(), actor: actorId, action: 'shop_order_payment_repaired', target: orderId, before: { paymentStatus: order.paymentStatus, status: order.status }, after: null });
    return { order: await shopOrders.findByIdAsync(orderId) };
  }

  /** Before a shop order's payment is confirmed: is this payment for this order, in this amount? */
  async function checkOrderPayment(request, { amountTzs = null } = {}) {
    const order = await shopOrders.findByIdAsync(request.orderId);
    if (!order) return { error: 'order_not_found', status: 409 };
    if (order.buyerId !== request.memberId) return { error: 'order_buyer_mismatch', status: 409 };
    if ((request.currency || 'TZS') !== 'TZS') return { error: 'currency_mismatch', status: 409 };
    if (Number(request.amountTzs) !== Number(order.totalTzs)) return { error: 'order_amount_mismatch', status: 409, expectedTzs: Number(order.totalTzs) };
    if (amountTzs != null && Number(amountTzs) !== Number(request.amountTzs)) return { error: 'amount_mismatch', status: 409, expectedTzs: Number(request.amountTzs) };
    return null;
  }

  /**
   * The patch that cancels an order as it stands (locked): its own timeline entry, every vendor's part
   * cancelled with the same entry. `extra` carries the payment status the cancellation leaves behind.
   */
  const cancellationPatch = (entry, at, extra = {}, actorId = null) => (current) => {
    const own = fulfilmentsOf(current);
    return {
      ...extra,
      timeline: [...(Array.isArray(current.timeline) ? current.timeline : []), entry],
      ...(own.length ? { fulfilments: own.map(f => ({ ...f, status: 'cancelled', timeline: [...(f.timeline || []), { ...entry, ...(actorId ? { actorId } : {}) }], updatedAt: at })) } : {}),
      updatedAt: at,
    };
  };

  /**
   * An order's payment was decided (admin approval of its payment request).
   * Approved: the order is paid and the vendors hear about it. Rejected or
   * cancelled: the order is cancelled and its stock released.
   */
  async function applyPaymentToOrder(orderId, status) {
    const order = await shopOrders.findByIdAsync(orderId);
    if (!order || order.paymentStatus === 'paid') return;
    const at = nowIso();
    if (status === 'approved') {
      const paid = await orderStore.markPaid(orderId);
      if (paid.outcome === 'paid') { await orderPaid(paid.order); return; }
      if (paid.outcome !== 'cancelled') return;
      // The money arrived after the order was cancelled or its reservation lapsed. If it lapsed on its
      // own (expiry or an unconfirmed payment) the order is revived when its stock can be taken again;
      // if a person cancelled it, or the stock has gone, the payment is owed back, once.
      const entries = Array.isArray(paid.order.timeline) ? paid.order.timeline : [];
      const cancelledBy = [...entries].reverse().find(e => e.status === 'cancelled')?.by;
      const byPerson = ['buyer', 'vendor', 'admin'].includes(cancelledBy);
      let revivedReason = byPerson ? 'cancelled_by_person' : null;
      if (!byPerson) {
        const entry = { status: 'pending', at, by: 'system', reason: 'revived_after_late_payment' };
        const revived = await orderStore.reviveOrder(orderId, {
          // Every vendor's part starts again from the beginning.
          patch: (current) => ({
            timeline: [...(Array.isArray(current.timeline) ? current.timeline : []), entry],
            ...(fulfilmentsOf(current).length ? { fulfilments: fulfilmentsOf(current).map(f => ({ ...f, status: 'pending', timeline: [...(f.timeline || []), entry], updatedAt: at })) } : {}),
          }),
        });
        if (revived.revived) {
          await auditLog.insertAsync({ id: randomUUID(), at, actor: 'system', action: 'shop_order_revived_after_late_payment', target: orderId, before: { status: 'cancelled', paymentStatus: paid.order.paymentStatus }, after: { status: 'pending', paymentStatus: 'paid' } });
          await afterStockMoved(productIdsOf(revived.order));
          await orderPaid(revived.order);
          return;
        }
        revivedReason = revived.reason;
        if (revived.reason === 'not_revivable' && revived.order?.status !== 'cancelled') return; // someone else handled it
      }
      const late = await orderStore.markLatePayment(orderId);
      if (!late.marked) return;
      await auditLog.insertAsync({ id: randomUUID(), at, actor: 'system', action: 'shop_order_payment_after_cancellation', target: orderId, before: { status: 'cancelled', paymentStatus: paid.order.paymentStatus }, after: { paymentStatus: 'refund_pending', amountTzs: order.totalTzs, reason: revivedReason } });
      await raiseRefund(late.order, { reasonCode: 'payment_error', actorId: 'system', role: 'system' });
      await notify(order.buyerId, 'order_payment_refund_due', { orderId, totalTzs: order.totalTzs });
      return;
    }
    if (!['rejected', 'cancelled'].includes(status)) return;
    const out = await orderStore.cancelAndRelease(orderId, {
      patch: cancellationPatch({ status: 'cancelled', at, by: 'system', reason: 'payment_not_confirmed' }, at, { paymentStatus: 'failed' }),
      paymentStatuses: ['pending', 'failed', 'cancelled', null],
    });
    if (!out.changed) return;
    if (out.released) await afterStockMoved(productIdsOf(order));
    await notify(order.buyerId, 'order_cancelled', { orderId, reason: 'payment_not_confirmed' });
  }

  /**
   * Cancel unpaid orders whose reservation has lapsed and give their stock back.
   * Safe to run repeatedly and from several servers: each order is cancelled once.
   * A payment that arrives later is handled as a late payment (refund owed).
   */
  async function expireStaleReservations({ limit = 100 } = {}) {
    const due = await orderStore.findExpired({ before: now(), limit });
    let expired = 0;
    for (const order of due) {
      const at = nowIso();
      const out = await orderStore.cancelAndRelease(order.id, {
        patch: cancellationPatch({ status: 'cancelled', at, by: 'system', reason: 'reservation_expired' }, at, { paymentStatus: 'failed' }),
        fromStatuses: ['pending'], paymentStatuses: ['pending'],
      });
      if (!out.changed) continue;
      expired += 1;
      if (out.released) await afterStockMoved(productIdsOf(order));
      if (paymentRequests) {
        for (const r of await paymentRequests.filterAsync(p => p.orderId === order.id && p.status === 'pending')) {
          await paymentRequests.updateByIdAsync(r.id, { status: 'cancelled', decidedAt: at, decidedBy: 'system' });
        }
      }
      await auditLog.insertAsync({ id: randomUUID(), at, actor: 'system', action: 'shop_order_reservation_expired', target: order.id, before: { status: 'pending', paymentStatus: 'pending' }, after: { status: 'cancelled', paymentStatus: 'failed' } });
      await notify(order.buyerId, 'order_cancelled', { orderId: order.id, reason: 'reservation_expired' });
    }
    return { due: due.length, expired };
  }
  async function myOrders(buyerId) {
    return (await shopOrders.filterAsync(order => order.buyerId === buyerId))
      .sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0))
      // Whether the buyer can still cancel it themselves (before it is on its way).
      .map(order => ({ ...buyerOrderView(order), canCancel: CANCELLABLE.has(order.status) }));
  }
  /** Every order with a line of this vendor's (lines carry the vendor; older rows fall back to product ownership). */
  async function ordersOfVendor(vendorId) {
    const direct = await shopOrders.filterAsync(order => (order.items || []).some(item => item.vendorId === vendorId));
    if (direct.length) return direct.sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0));
    const ids = new Set((await products.filterAsync(product => product.vendorId === vendorId)).map(product => product.id));
    return (await shopOrders.filterAsync(order => (order.items || []).some(item => ids.has(item.productId)))).sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0));
  }

  /** The vendors an order has lines from; lines without a vendor are resolved through their product. */
  async function vendorsOfOrder(order) {
    const ids = new Set();
    for (const item of order.items || []) {
      if (item.vendorId) { ids.add(item.vendorId); continue; }
      const product = item.productId ? await products.findByIdAsync(item.productId) : null;
      if (product?.vendorId) ids.add(product.vendorId);
    }
    return [...ids];
  }

  /**
   * What a vendor may see of an order: their own lines, their own subtotal, and their own fulfilment's
   * status (so their app offers the right next step). Other vendors' lines, commissions and statuses
   * are not shown; `orderStatus` is the customer-facing combined status.
   */
  function vendorView(order, vendorId) {
    const mine = (order.items || []).filter(item => item.vendorId === vendorId || item.vendorId == null);
    const own = fulfilmentsOf(order).find(f => f.vendorId === vendorId);
    const { fulfilments, idempotencyKey, idempotencyFingerprint, stockState, reservationCycle, reservationExpiresAt, ...rest } = order;
    const status = own?.status || order.status;
    return {
      ...rest, items: mine, totalTzs: mine.reduce((sum, item) => sum + Number(item.priceTzs || 0) * Number(item.qty || 0), 0),
      status, orderStatus: order.status, timeline: own?.timeline?.length ? own.timeline : rest.timeline,
      nextStatuses: order.status === 'cancelled' || order.paymentStatus !== 'paid' ? [] : nextStatuses(status, order.deliveryMethod),
    };
  }
  async function vendorOrders(vendorId) {
    return (await ordersOfVendor(vendorId)).map(order => vendorView(order, vendorId));
  }

  /**
   * Move one vendor's fulfilment of an order to `status`.
   * - A vendor (or their staff) moves only their own fulfilment, and never while suspended.
   *   Suspending a vendor's account does not cancel their open orders: an unpaid one keeps its
   *   reservation until it is paid or expires, a paid one waits; an admin may move or cancel either
   *   (cancelling a paid one raises the refund as usual).
   * - An admin (FitFlex) names the vendor when the order has several; every move follows the same matrix.
   * - The move is decided under the order's row lock, so two requests cannot both win.
   */
  async function updateOrderStatus({ orderId, status, actorId, actorRole = 'vendor', vendorId = null, reason = null }) {
    if (!ORDER_STATUSES.has(status)) return { error: 'invalid_status', status: 400 };
    const order = await shopOrders.findByIdAsync(orderId);
    if (!order) return { error: 'order_not_found', status: 404 };
    const isAdmin = actorRole === 'admin';
    const vendors = await vendorsOfOrder(order);
    let target;
    if (!isAdmin) {
      if (!vendors.includes(actorId)) return { error: 'order_not_owned_by_vendor', status: 403 };
      const vendor = await users.findByIdAsync(actorId);
      if (vendor?.accountStatus === 'suspended') return { error: 'vendor_suspended', status: 403 };
      target = actorId;
    } else if (vendorId) {
      if (!vendors.includes(vendorId)) return { error: 'vendor_not_in_order', status: 404 };
      target = vendorId;
    } else if (vendors.length === 1) {
      target = vendors[0];
    } else if (status !== 'cancelled') {
      return { error: 'vendor_required', status: 400, vendors };
    }
    // Vendors fulfil paid orders only; an unpaid order can only be cancelled.
    if (order.paymentStatus && order.paymentStatus !== 'paid' && status !== 'cancelled') return { error: 'order_not_paid', status: 409 };
    if (status === 'cancelled') {
      // Several vendors: cancelling one vendor's part would need a partial refund, which is a financial
      // decision of its own. A vendor cannot do it alone; FitFlex cancels the whole order.
      if (!isAdmin && vendors.length > 1) return { error: 'multi_vendor_cancel_requires_admin', status: 409 };
      return cancelOrder(order, { actorId, role: isAdmin ? 'admin' : 'vendor', reasonCode: isAdmin ? 'cancelled_by_fitflex' : 'vendor_cancelled', note: reason });
    }
    if (order.status === 'cancelled') return { error: 'order_cancelled', status: 409 };
    const at = nowIso();
    const result = await orderStore.updateWithLock(orderId, (current) => {
      if (current.status === 'cancelled') return { error: 'order_cancelled', status: 409 };
      if (current.paymentStatus && current.paymentStatus !== 'paid') return { error: 'order_not_paid', status: 409 };
      const all = fulfilmentsOf(current, vendors);
      const mine = all.find(f => f.vendorId === target);
      if (!mine) return { error: 'order_not_owned_by_vendor', status: 403 };
      const decision = decideTransition({ from: mine.status, to: status, deliveryMethod: current.deliveryMethod });
      if (!decision.ok) {
        return { error: decision.error === 'status_is_final' ? 'order_status_final' : 'invalid_transition', status: 409, from: canonicalStatus(mine.status), to: status, allowed: decision.allowed };
      }
      if (decision.noop) return { value: { noop: true, from: mine.status, to: mine.status } };
      const entry = { status: decision.store, at, by: isAdmin ? 'admin' : 'vendor', actorId, ...(reason ? { reason: String(reason).slice(0, 300) } : {}) };
      const nextAll = all.map(f => (f.vendorId === target ? { ...f, status: decision.store, timeline: [...(f.timeline || []), entry], updatedAt: at } : f));
      return {
        patch: {
          fulfilments: nextAll,
          status: combinedStatus(nextAll),
          // The order's own timeline keeps one entry per move, with the vendor it concerns.
          timeline: [...(Array.isArray(current.timeline) ? current.timeline : []), { status: decision.store, at, vendorId: target }],
          updatedAt: at,
        },
        value: { from: mine.status, to: decision.store },
      };
    });
    if (result.error) return result;
    if (result.value?.noop) return { order: isAdmin ? result.order : vendorView(result.order, target), unchanged: true };
    const { from, to } = result.value;
    await auditLog.insertAsync({
      id: randomUUID(), at, actor: actorId, action: `shop_order_${to}`, target: orderId,
      before: { status: from, vendorId: target }, after: { status: to, vendorId: target, actorRole: isAdmin ? 'admin' : 'vendor', ...(reason ? { reason: String(reason).slice(0, 300) } : {}) },
    });
    await notify(order.buyerId, `order_${to}`, { orderId, vendorId: target });
    return { order: isAdmin ? result.order : vendorView(result.order, target) };
  }

  // An order can be cancelled until it is on its way: once dispatched, ready
  // for pickup or delivered it is a return, handled under the vendor's policy.
  const CANCELLABLE = new Set(['pending', 'confirmed', 'accepted', 'processing', 'packed']);

  /**
   * Cancel an order: release its stock, withdraw a payment still waiting, and
   * raise a refund when it was already paid.
   */
  async function cancelOrder(order, { actorId, role, reasonCode, note = null }) {
    if (order.status === 'cancelled') return { order };
    if (['delivered', 'fulfilled'].includes(order.status)) return { error: 'order_already_delivered', status: 409 };
    if (role === 'buyer' && !CANCELLABLE.has(order.status)) return { error: 'order_already_dispatched', status: 409 };
    const at = nowIso();
    const reason = note ? String(note).slice(0, 300) : null;
    // The state change and the stock release are one atomic step; only the request that wins it carries on.
    const wasPaid = order.paymentStatus === 'paid' && Number(order.totalTzs) > 0;
    const result = await orderStore.cancelAndRelease(order.id, {
      patch: cancellationPatch(
        { status: 'cancelled', at, by: role, ...(reason ? { reason } : {}) }, at,
        { paymentStatus: wasPaid ? 'refund_pending' : order.paymentStatus === 'pending' ? 'cancelled' : order.paymentStatus }, actorId,
      ),
      // Judged on the order as it is when locked, not as it was read: a vendor may have dispatched meanwhile.
      refuseIf: (current) => {
        if (['delivered', 'fulfilled'].includes(current.status)) return { error: 'order_already_delivered', status: 409 };
        const own = fulfilmentsOf(current);
        // One vendor's part is already with the customer: a whole-order cancel and refund would be wrong.
        if (anyAtLeast(own, 'delivered')) return { error: 'order_partly_delivered', status: 409 };
        if (role === 'buyer' && (!CANCELLABLE.has(current.status) || anyAtLeast(own, 'dispatched'))) return { error: 'order_already_dispatched', status: 409 };
        return null;
      },
      paymentStatuses: [order.paymentStatus ?? null],
    });
    if (result.error) return result;
    if (!result.changed) {
      if (result.reason === 'already_cancelled') return { order: result.order };
      return { error: 'order_changed', status: 409 };
    }
    const updated = result.order;
    if (result.released) await afterStockMoved(productIdsOf(order));
    if (order.paymentStatus === 'pending' && paymentRequests) {
      for (const r of await paymentRequests.filterAsync(p => p.orderId === order.id && p.status === 'pending')) {
        await paymentRequests.updateByIdAsync(r.id, { status: 'cancelled', decidedAt: at, decidedBy: actorId });
      }
    }
    const paymentStatus = updated.paymentStatus;
    try { await onOrderCancelled(order); } catch (err) { console.warn('[shop] cancelled order not taken back from a promotion:', err?.message); }
    await auditLog.insertAsync({ id: randomUUID(), at, actor: actorId, action: `shop_order_cancelled_by_${role}`, target: order.id, before: { status: order.status, paymentStatus: order.paymentStatus }, after: { status: 'cancelled', paymentStatus } });
    let refund = null;
    if (wasPaid) refund = await raiseRefund(updated, { reasonCode, actorId, role });
    if (role === 'buyer') {
      for (const vendorId of new Set((order.items || []).map(item => item.vendorId).filter(Boolean))) await notifyVendor(vendorId, 'order_cancelled', { orderId: order.id, by: 'buyer' });
    } else {
      await notify(order.buyerId, 'order_cancelled', { orderId: order.id, by: role });
    }
    return { order: updated, refund };
  }

  /** Buyer: cancel my order before it is dispatched or ready for pickup. A paid one is refunded in full. */
  async function buyerCancelOrder({ buyerId, orderId }) {
    const order = await shopOrders.findByIdAsync(orderId);
    if (!order || order.buyerId !== buyerId) return { error: 'order_not_found', status: 404 };
    if (order.status === 'cancelled') return { error: 'order_cancelled', status: 409 };
    const result = await cancelOrder(order, { actorId: buyerId, role: 'buyer', reasonCode: 'member_cancelled' });
    return result.order ? { ...result, order: buyerOrderView(result.order) } : result;
  }

  /** The refund for a cancelled order was sent. Only an order that was owed it becomes refunded. */
  async function markOrderRefunded(orderId) {
    const order = await shopOrders.findByIdAsync(orderId);
    if (!order) return null;
    if (order.paymentStatus === 'refunded') return order;
    const done = await updateIf(shopOrders, orderId, { paymentStatus: 'refund_pending' }, { paymentStatus: 'refunded', updatedAt: nowIso() });
    if (done) return done;
    // A refund was paid for an order that was not waiting for one: keep the books as they are and say so.
    await auditLog.insertAsync({ id: randomUUID(), at: nowIso(), actor: 'system', action: 'shop_refund_paid_unexpected_state', target: orderId, before: { paymentStatus: order.paymentStatus, status: order.status }, after: null });
    return order;
  }

  async function vendorPayments(vendorId) {
    const orders = await ordersOfVendor(vendorId);
    const delivered = orders.filter(order => order.paymentStatus === 'paid' && ['delivered', 'fulfilled'].includes(order.status));
    const value = order => (order.items || []).filter(item => item.vendorId === vendorId || item.vendorId == null).reduce((sum, item) => sum + Number(item.priceTzs || 0) * Number(item.qty || 0), 0);
    const current = new Date(), day = current.toISOString().slice(0, 10), week = +current - 7 * 86400000, month = +current - 30 * 86400000;
    const total = rows => rows.reduce((sum, order) => sum + value(order), 0);
    return { todaySalesTzs: total(delivered.filter(order => String(order.updatedAt || order.createdAt).slice(0, 10) === day)), weeklySalesTzs: total(delivered.filter(order => +new Date(order.updatedAt || order.createdAt) >= week)), monthlySalesTzs: total(delivered.filter(order => +new Date(order.updatedAt || order.createdAt) >= month)), pendingSettlementTzs: total(delivered.filter(order => order.settlementStatus !== 'settled')), settledPaymentsTzs: total(delivered.filter(order => order.settlementStatus === 'settled')), settlements: delivered.map(order => ({ orderId: order.id, amountTzs: value(order), status: order.settlementStatus || 'pending', at: order.updatedAt || order.createdAt })) };
  }
  async function vendorStatement(vendorId) {
    const lines = ['order_id,amount_tzs,order_status,payment_status,settlement_status,date'];
    for (const order of await ordersOfVendor(vendorId)) {
      const amount = (order.items || []).filter(item => item.vendorId === vendorId || item.vendorId == null).reduce((sum, item) => sum + Number(item.priceTzs || 0) * Number(item.qty || 0), 0);
      lines.push([order.id, amount, order.status, order.paymentStatus || 'unknown', order.settlementStatus || 'pending', order.updatedAt || order.createdAt].map(csv).join(','));
    }
    return `${lines.join('\n')}\n`;
  }

  async function sendEnquiry({ buyerId, body }) {
    const product = body?.productId ? await products.findByIdAsync(body.productId) : null;
    const vendorId = body?.vendorId || product?.vendorId;
    if (!vendorId) return { error: 'vendor_required', status: 400 };
    if (!String(body?.message || '').trim()) return { error: 'message_required', status: 400 };
    const at = nowIso();
    const enquiry = await marketplaceEnquiries.insertAsync({ id: makeId('enq'), buyerId, vendorId, productId: body.productId || null, subject: body.subject || null, status: 'open', messages: [{ senderId: buyerId, senderRole: 'customer', message: body.message.trim(), at }], createdAt: at, updatedAt: at });
    await notifyVendor(vendorId, 'new_customer_enquiry', { enquiryId: enquiry.id });
    return { enquiry, status: 201 };
  }
  async function vendorEnquiries({ vendorId, search }) {
    let rows = await marketplaceEnquiries.filterAsync(enquiry => enquiry.vendorId === vendorId);
    const query = String(search || '').trim().toLowerCase();
    if (query) rows = rows.filter(enquiry => [enquiry.subject, ...(enquiry.messages || []).map(item => item.message)].some(value => String(value || '').toLowerCase().includes(query)));
    return rows.sort((a, b) => +new Date(b.updatedAt || 0) - +new Date(a.updatedAt || 0));
  }
  async function replyEnquiry({ vendorId, enquiryId, message }) {
    const enquiry = await marketplaceEnquiries.findByIdAsync(enquiryId);
    if (!enquiry) return { error: 'enquiry_not_found', status: 404 };
    if (enquiry.vendorId !== vendorId) return { error: 'not_your_enquiry', status: 403 };
    if (!String(message || '').trim()) return { error: 'message_required', status: 400 };
    const messages = [...(enquiry.messages || []), { senderId: vendorId, senderRole: 'vendor', message: message.trim(), at: nowIso() }];
    const updated = await marketplaceEnquiries.updateByIdAsync(enquiryId, { messages, status: 'open', updatedAt: nowIso() });
    await notify(enquiry.buyerId, 'vendor_enquiry_reply', { enquiryId });
    return { enquiry: updated };
  }
  async function resolveEnquiry({ vendorId, enquiryId }) {
    const enquiry = await marketplaceEnquiries.findByIdAsync(enquiryId);
    if (!enquiry) return { error: 'enquiry_not_found', status: 404 };
    if (enquiry.vendorId !== vendorId) return { error: 'not_your_enquiry', status: 403 };
    return { enquiry: await marketplaceEnquiries.updateByIdAsync(enquiryId, { status: 'resolved', updatedAt: nowIso() }) };
  }

  async function createVendorStaff({ vendorId, body }) {
    const missing = ['name', 'email', 'phone', 'password', 'role'].filter(field => !String(body?.[field] || '').trim());
    if (missing.length) return { error: 'staff_fields_missing', status: 400, missing };
    if (!STAFF_ROLES.has(body.role)) return { error: 'invalid_staff_role', status: 400 };
    if (await users.findAsync(user => user.userType === 'vendor_staff' && user.email === body.email && user.vendorId === vendorId)) return { error: 'duplicate_staff_email', status: 409 };
    const permissions = body.role === 'admin' ? [...STAFF_PERMISSIONS] : (Array.isArray(body.permissions) ? body.permissions : []).filter(value => STAFF_PERMISSIONS.has(value));
    const at = nowIso();
    const staff = await users.insertAsync({ id: makeId('usr'), userType: 'vendor_staff', vendorId, displayName: body.name.trim(), email: body.email.trim().toLowerCase(), phone: body.phone.trim(), passwordHash: await hashPassword(body.password), vendorRole: body.role, vendorPermissions: permissions, accountStatus: 'active', approvalStatus: 'approved', onboardingCompleted: true, createdAt: at, updatedAt: at });
    return { staff: staffView(staff), status: 201 };
  }
  const canStaff = (staff, permission) => staff?.userType === 'vendor' || staff?.userType === 'vendor_staff' && staff.accountStatus !== 'suspended' && Array.isArray(staff.vendorPermissions) && staff.vendorPermissions.includes(permission);
  async function authorizeStaff(claims, permission) {
    const staff = await users.findByIdAsync(claims.sub);
    return staff?.userType === 'vendor_staff' && staff.vendorId === claims.vendorId &&
      staff.accountStatus === 'active' && canStaff(staff, permission);
  }
  const staffView = ({ passwordHash, ...staff }) => staff;
  const listVendorStaff = async vendorId => (await users.filterAsync(user => user.userType === 'vendor_staff' && user.vendorId === vendorId)).map(staffView);
  async function disableVendorStaff({ vendorId, staffId }) {
    const staff = await users.findByIdAsync(staffId);
    if (!staff) return { error: 'staff_not_found', status: 404 };
    if (staff.vendorId !== vendorId) return { error: 'not_your_staff', status: 403 };
    return { staff: staffView(await users.updateByIdAsync(staffId, { accountStatus: 'suspended', updatedAt: nowIso() })) };
  }

  async function reviewProduct({ buyerId, orderId, productId, rating, comment }) {
    const score = Number(rating);
    if (!Number.isInteger(score) || score < 1 || score > 5) return { error: 'invalid_rating', status: 400 };
    const order = await shopOrders.findByIdAsync(orderId);
    if (!order || order.buyerId !== buyerId || !['delivered', 'fulfilled'].includes(order.status) || !(order.items || []).some(item => item.productId === productId)) return { error: 'review_not_allowed', status: 403 };
    if (await productReviews.findAsync(review => review.buyerId === buyerId && review.orderId === orderId && review.productId === productId)) return { error: 'review_already_exists', status: 409 };
    const review = await productReviews.insertAsync({ id: makeId('rev'), buyerId, orderId, productId, rating: score, comment: String(comment || '').trim() || null, createdAt: nowIso() });
    const reviews = await productReviews.filterAsync(item => item.productId === productId);
    await products.updateByIdAsync(productId, { rating: reviews.reduce((sum, item) => sum + Number(item.rating), 0) / reviews.length, reviewCount: reviews.length, updatedAt: nowIso() });
    return { review, status: 201 };
  }
  async function orderInvoice({ buyerId, orderId }) {
    const order = await shopOrders.findByIdAsync(orderId);
    if (!order || order.buyerId !== buyerId) return null;
    return `${['FitFlex Marketplace Invoice', `Order: ${order.id}`, `Date: ${order.createdAt}`, ...order.items.map(item => `${item.qty} x ${item.name} @ ${formatTsh(item.priceTzs)}`), `Total: ${formatTsh(order.totalTzs)}`, `Payment: ${order.paymentStatus} (${order.paymentMethod})`].join('\n')}\n`;
  }
  async function reorder({ buyerId, orderId }) {
    const order = await shopOrders.findByIdAsync(orderId);
    if (!order || order.buyerId !== buyerId) return { error: 'order_not_found', status: 404 };
    return { items: (order.items || []).map(item => ({ productId: item.productId, qty: item.qty })) };
  }
  async function notifications(userId) {
    return (await marketplaceNotifications.filterAsync(notification => notification.userId === userId)).sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0));
  }

  return { vendorListProducts, adjustStock, stockMovements, lowStock, getVendorProfile, saveVendorProfile, getVendorStore, listProducts, getProduct, upsertProduct, duplicateProduct, deleteProduct, adminListProducts, adminCreateProduct, adminUpdateProductListing, adminListVendors, adminUpdateVendor, createOrder, applyPaymentToOrder, expireStaleReservations, buyerCancelOrder, markOrderRefunded, raiseMissingRefund, repairOrderPayment, checkOrderPayment, myOrders, vendorOrders, updateOrderStatus, vendorPayments, vendorStatement, sendEnquiry, vendorEnquiries, replyEnquiry, resolveEnquiry, createVendorStaff, listVendorStaff, disableVendorStaff, canStaff, authorizeStaff, reviewProduct, orderInvoice, reorder, notifications };
}
