// FitFlex Marketplace domain service. All persistence is dependency-injected.
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../auth/password-credentials.mjs';
import { OPEN_GATE } from './partner-gate.mjs';
import { OPEN_PUBLIC_GATE } from './moderation-gate.mjs';

const PRODUCT_STATUSES = new Set(['active', 'paused', 'archived']);
const ORDER_STATUSES = new Set(['pending', 'accepted', 'processing', 'packed', 'dispatched', 'ready_for_pickup', 'delivered', 'cancelled', 'confirmed', 'fulfilled']);
const PAYMENT_METHODS = new Set(['mpesa', 'airtel_money', 'mixx', 'card', 'bank']);
const PROFILE_REQUIRED = ['businessName', 'logo', 'banner', 'description', 'businessCategory', 'contactNumber', 'email', 'address', 'deliveryRegions', 'businessHours', 'settlementAccount'];
// Optional profile fields. Partner KYC reads productCategories and returnsPolicy
// for the vendor's marketplace requirements. Anything else in the body is ignored.
const PROFILE_OPTIONAL = ['productCategories', 'returnsPolicy'];
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
const bool = value => value === true || value === 'true' || value === '1' ? true : value === false || value === 'false' || value === '0' ? false : undefined;
const priceOf = product => Number(product.discountPriceTzs || 0) > 0 && Number(product.discountPriceTzs) < Number(product.priceTzs || 0) ? Number(product.discountPriceTzs) : Number(product.priceTzs || 0);
const csv = value => /[,"\n]/.test(String(value ?? '')) ? `"${String(value ?? '').replaceAll('"', '""')}"` : String(value ?? '');

export function createShopService({ products, shopOrders, users, auditLog, marketplaceEnquiries, marketplaceNotifications, productReviews, paymentRequests = null, partnerGate = OPEN_GATE, partnerKycCases = null,
  // Moderation: pending, rejected, suspended and hidden products and vendors are not shown to buyers.
  publicGate = OPEN_PUBLIC_GATE,
  // A paid order was cancelled and the money is owed back: ({ order, reasonCode, actorId, role }) → refund.
  onRefundDue = async () => null,
  // A paid order, for promotion analytics: (order) → void. Never allowed to fail the order.
  onOrderPaid = async () => null,
  // A cancelled order, for promotion analytics: (order) → void; takes back what the paid order was credited for.
  onOrderCancelled = async () => null }) {
  marketplaceEnquiries ||= { filterAsync: async () => [], findByIdAsync: async () => null };
  marketplaceNotifications ||= { insertAsync: async row => row, filterAsync: async () => [] };
  productReviews ||= { insertAsync: async row => row, filterAsync: async () => [], findAsync: async () => null };

  async function notify(userId, type, data = {}) {
    return marketplaceNotifications.insertAsync({ id: makeId('ntf'), userId, type, data, read: false, createdAt: nowIso() });
  }

  async function getVendorProfile(vendorId) {
    return (await users.findByIdAsync(vendorId))?.vendorProfile || null;
  }

  async function saveVendorProfile({ vendorId, body }) {
    const current = await users.findByIdAsync(vendorId);
    const prior = current?.vendorProfile || {};
    const publish = body?.publish === true;
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

  async function getVendorStore(vendorId) {
    if (!(await partnerGate.isOperational(vendorId))) return null;
    if (await publicGate.isBlocked('vendor', vendorId)) return null;
    const profile = publicProfile(await getVendorProfile(vendorId));
    if (!profile) return null;
    const storeProducts = await listProducts({ vendorId });
    const reviews = await productReviews.filterAsync(review => storeProducts.some(product => product.id === review.productId));
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
    // Buyers only see products from vendors who may sell (new vendors: once verified).
    if (!includeArchived) {
      const ok = await partnerGate.operationalUserIds(rows.map(product => product.vendorId));
      const [blockedProducts, blockedVendors] = await Promise.all([publicGate.blocked('product'), publicGate.blocked('vendor')]);
      rows = rows.filter(product => ok.has(product.vendorId) && !blockedProducts.has(product.id) && !blockedVendors.has(product.vendorId));
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
    const reviews = await productReviews.filterAsync(review => review.productId === productId);
    return { ...product, vendor: publicProfile(await getVendorProfile(product.vendorId)), reviews, similarProducts: (await listProducts({ category: product.category })).filter(row => row.id !== productId).slice(0, 6) };
  }

  async function upsertProduct({ vendorId, body, productId }) {
    const input = body || {};
    if (productId) {
      const prior = await products.findByIdAsync(productId);
      if (!prior || prior.deletedAt) return { error: 'product_not_found', status: 404 };
      if (prior.vendorId !== vendorId) return { error: 'not_your_product', status: 403 };
      if (input.name !== undefined && !String(input.name).trim()) return { error: 'name_required', status: 400 };
      if (input.priceTzs !== undefined && Number(input.priceTzs) <= 0) return { error: 'priceTzs_required', status: 400 };
      if (input.stock !== undefined && Number(input.stock) < 0) return { error: 'invalid_stock', status: 400 };
      const patch = { updatedAt: nowIso() };
      if (input.name !== undefined) patch.name = String(input.name).trim();
      for (const field of ['description', 'category', 'brand', 'sku', 'visibility', 'deliveryAvailable']) if (input[field] !== undefined) patch[field] = input[field];
      for (const field of ['priceTzs', 'discountPriceTzs', 'stock', 'weightKg', 'distanceKm']) if (input[field] !== undefined) patch[field] = input[field] === null ? null : Number(input[field]);
      if (Array.isArray(input.images)) patch.images = input.images;
      if (Array.isArray(input.variants)) patch.variants = input.variants;
      if (input.status && PRODUCT_STATUSES.has(input.status)) patch.status = input.status;
      if (prior.approvalStatus === 'approved' && Object.keys(input).some(field => PRODUCT_REVIEW_FIELDS.has(field))) {
        patch.approvalStatus = 'pending';
      }
      return { product: await products.updateByIdAsync(productId, patch) };
    }
    if (!input.name?.trim()) return { error: 'name_required', status: 400 };
    if (input.priceTzs == null || Number(input.priceTzs) <= 0) return { error: 'priceTzs_required', status: 400 };
    if (Number(input.stock ?? 0) < 0) return { error: 'invalid_stock', status: 400 };
    const at = nowIso();
    const product = await products.insertAsync({
      id: makeId('prd'), vendorId, name: input.name.trim(), description: input.description || null, category: input.category || null,
      brand: input.brand || null, priceTzs: Number(input.priceTzs), discountPriceTzs: input.discountPriceTzs == null ? null : Number(input.discountPriceTzs),
      stock: Number(input.stock ?? 0), sku: input.sku || null, weightKg: input.weightKg == null ? null : Number(input.weightKg), distanceKm: input.distanceKm == null ? null : Number(input.distanceKm),
      variants: Array.isArray(input.variants) ? input.variants : [], images: Array.isArray(input.images) ? input.images : [], visibility: input.visibility || 'visible',
      deliveryAvailable: input.deliveryAvailable !== false, status: 'active', approvalStatus: 'pending', rating: Number(input.rating || 0), reviewCount: Number(input.reviewCount || 0), soldCount: Number(input.soldCount || 0),
      homepageVisible: true, homepagePriority: 0, createdAt: at, updatedAt: at,
    });
    return { product, created: true };
  }

  async function duplicateProduct({ vendorId, productId }) {
    const prior = await products.findByIdAsync(productId);
    if (!prior) return { error: 'product_not_found', status: 404 };
    if (prior.vendorId !== vendorId) return { error: 'not_your_product', status: 403 };
    return upsertProduct({ vendorId, body: { ...prior, name: `${prior.name} Copy`, sku: null } });
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
    const created = await upsertProduct({ vendorId, body });
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
    if (requestedApproval !== 'pending') await notify(vendorId, `product_${requestedApproval}`, { productId: product.id });
    return { product, status: 201 };
  }
  async function adminUpdateProductListing({ productId, body, actorId }) {
    const prior = await products.findByIdAsync(productId);
    if (!prior) return { error: 'product_not_found', status: 404 };
    const patch = { ...(typeof body?.homepageVisible === 'boolean' ? { homepageVisible: body.homepageVisible } : {}), ...(body?.homepagePriority !== undefined ? { homepagePriority: Number(body.homepagePriority) || 0 } : {}), ...(['approved', 'pending', 'rejected'].includes(body?.approvalStatus) ? { approvalStatus: body.approvalStatus } : {}), updatedAt: nowIso() };
    const product = await products.updateByIdAsync(productId, patch);
    await auditLog.insertAsync({ id: randomUUID(), at: nowIso(), actor: actorId, action: 'product_listing_updated', target: productId, before: { homepageVisible: prior.homepageVisible ?? true, homepagePriority: Number(prior.homepagePriority || 0), approvalStatus: prior.approvalStatus || 'pending' }, after: patch });
    if (patch.approvalStatus) await notify(prior.vendorId, `product_${patch.approvalStatus}`, { productId });
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
    const updated = await users.updateByIdAsync(vendorId, patch);
    await auditLog.insertAsync({
      id: randomUUID(), at: nowIso(), actor: actorId, action: 'vendor_management_updated',
      target: vendorId,
      before: { approvalStatus: vendor.approvalStatus, accountStatus: vendor.accountStatus },
      after: patch,
    });
    if (patch.approvalStatus) await notify(vendorId, `vendor_${patch.approvalStatus}`, { approvalNote: patch.approvalNote });
    return { vendor: updated };
  }

  async function createOrder({ buyerId, buyerRole = 'member', body }) {
    const items = Array.isArray(body?.items) ? body.items : [];
    if (!items.length) return { error: 'items_required', status: 400 };
    const deliveryMethod = body?.deliveryMethod || 'home_delivery';
    if (!['home_delivery', 'gym_pickup'].includes(deliveryMethod)) return { error: 'invalid_delivery_method', status: 400 };
    if (deliveryMethod === 'gym_pickup' && !body?.pickupGymId) return { error: 'pickup_gym_required', status: 400 };
    if (deliveryMethod === 'home_delivery' && !body?.deliveryAddress) return { error: 'delivery_address_required', status: 400 };
    const paymentMethod = body?.paymentMethod || 'mpesa';
    if (!PAYMENT_METHODS.has(paymentMethod)) return { error: 'invalid_payment_method', status: 400 };
    // The app's own payment result is never trusted: an order is paid only
    // once FitFlex confirms the payment (admin approval of its payment request).
    if (body?.paymentOutcome === 'failed') return { error: 'payment_failed', status: 402 };
    const resolved = [];
    for (const item of items) {
      const qty = Number(item.qty || 0);
      if (qty <= 0) return { error: 'invalid_quantity', status: 400 };
      const product = await products.findByIdAsync(item.productId);
      if (!product || product.deletedAt || product.status !== 'active' || ['pending', 'rejected'].includes(product.approvalStatus)) return { error: 'product_not_found', status: 404, productId: item.productId };
      if (!(await partnerGate.isOperational(product.vendorId))) return { error: 'product_not_found', status: 404, productId: item.productId };
      // Hidden or suspended in moderation: it is not sold, even to someone with an old link.
      if (await publicGate.isBlocked('product', product.id) || await publicGate.isBlocked('vendor', product.vendorId)) return { error: 'product_not_found', status: 404, productId: item.productId };
      if (Number(product.stock) < qty) return { error: 'insufficient_stock', status: 409, productId: product.id };
      resolved.push({ product, qty });
    }
    for (const { product, qty } of resolved) await products.updateByIdAsync(product.id, { stock: Number(product.stock) - qty, soldCount: Number(product.soldCount || 0) + qty, updatedAt: nowIso() });
    const orderItems = resolved.map(({ product, qty }) => ({ productId: product.id, vendorId: product.vendorId, name: product.name, qty, priceTzs: priceOf(product), image: product.images?.[0] || null }));
    const totalTzs = orderItems.reduce((sum, item) => sum + item.priceTzs * item.qty, 0);
    const at = nowIso();
    const free = totalTzs === 0 || !paymentRequests;
    const order = await shopOrders.insertAsync({ id: makeId('ord'), buyerId, buyerRole, items: orderItems, totalTzs, status: 'pending', deliveryMethod, pickupGymId: deliveryMethod === 'gym_pickup' ? body.pickupGymId : null, deliveryAddress: deliveryMethod === 'home_delivery' ? body.deliveryAddress : null, paymentMethod, paymentStatus: free ? 'paid' : 'pending', paymentReference: body.paymentReference || null, timeline: [{ status: 'pending', at }], note: body?.note || null, settlementStatus: 'pending', createdAt: at, updatedAt: at });
    if (free) {
      await orderPaid(order);
      return { order, status: 201 };
    }
    // Stock stays reserved while the payment is confirmed.
    const paymentRequest = await paymentRequests.insertAsync({
      id: makeId('pay'), memberId: buyerId, orderId: order.id, amountTzs: totalTzs, currency: 'TZS',
      status: 'pending', provider: 'admin_approved', reference: body.paymentReference || null,
      requestedAt: at, decidedAt: null, decidedBy: null, note: null,
    });
    return { order, paymentRequest, status: 202 };
  }

  async function orderPaid(order) {
    try { await onOrderPaid(order); } catch (err) { console.warn('[shop] order not credited to a promotion:', err?.message); }
    for (const vendorId of new Set((order.items || []).map(item => item.vendorId))) await notify(vendorId, 'new_order', { orderId: order.id });
    await notify(order.buyerId, 'payment_received', { orderId: order.id, totalTzs: order.totalTzs });
  }

  async function restock(order) {
    for (const item of order.items || []) {
      const product = await products.findByIdAsync(item.productId);
      if (product) await products.updateByIdAsync(product.id, { stock: Number(product.stock) + Number(item.qty || 0), updatedAt: nowIso() });
    }
  }

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
      if (order.status === 'cancelled') return; // cancelled while waiting: FitFlex refunds it
      const updated = await shopOrders.updateByIdAsync(orderId, { paymentStatus: 'paid', updatedAt: at });
      await orderPaid(updated || order);
      return;
    }
    if (!['rejected', 'cancelled'].includes(status) || order.status === 'cancelled') return;
    await restock(order);
    const timeline = [...(Array.isArray(order.timeline) ? order.timeline : []), { status: 'cancelled', at }];
    await shopOrders.updateByIdAsync(orderId, { status: 'cancelled', paymentStatus: 'failed', timeline, updatedAt: at });
    await notify(order.buyerId, 'order_cancelled', { orderId, reason: 'payment_not_confirmed' });
  }
  async function myOrders(buyerId) {
    return (await shopOrders.filterAsync(order => order.buyerId === buyerId))
      .sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0))
      // Whether the buyer can still cancel it themselves (before it is on its way).
      .map(order => ({ ...order, canCancel: CANCELLABLE.has(order.status) }));
  }
  async function vendorOrders(vendorId) {
    const direct = await shopOrders.filterAsync(order => (order.items || []).some(item => item.vendorId === vendorId));
    if (direct.length) return direct.sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0));
    const ids = new Set((await products.filterAsync(product => product.vendorId === vendorId)).map(product => product.id));
    return (await shopOrders.filterAsync(order => (order.items || []).some(item => ids.has(item.productId)))).sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0));
  }
  async function updateOrderStatus({ orderId, status, actorId, actorRole = 'vendor' }) {
    if (!ORDER_STATUSES.has(status)) return { error: 'invalid_status', status: 400 };
    const order = await shopOrders.findByIdAsync(orderId);
    if (!order) return { error: 'order_not_found', status: 404 };
    if (actorRole !== 'admin') {
      const direct = (order.items || []).some(item => item.vendorId === actorId);
      const ids = new Set((await products.filterAsync(product => product.vendorId === actorId)).map(product => product.id));
      if (!direct && !(order.items || []).some(item => ids.has(item.productId))) return { error: 'order_not_owned_by_vendor', status: 403 };
    }
    // Vendors fulfil paid orders only; an unpaid order can only be cancelled.
    if (order.paymentStatus && order.paymentStatus !== 'paid' && status !== 'cancelled') return { error: 'order_not_paid', status: 409 };
    if (status === 'cancelled') return cancelOrder(order, { actorId, role: actorRole === 'admin' ? 'admin' : 'vendor', reasonCode: actorRole === 'admin' ? 'cancelled_by_fitflex' : 'vendor_cancelled' });
    if (order.status === 'cancelled') return { error: 'order_cancelled', status: 409 };
    const at = nowIso();
    const timeline = Array.isArray(order.timeline) ? order.timeline : [];
    timeline.push({ status, at });
    const normalized = status === 'fulfilled' ? 'delivered' : status;
    const updated = await shopOrders.updateByIdAsync(orderId, { status: normalized, timeline, updatedAt: at });
    await auditLog.insertAsync({ id: randomUUID(), at, actor: actorId, action: `shop_order_${normalized}`, target: orderId, before: { status: order.status }, after: { status: normalized } });
    await notify(order.buyerId, `order_${normalized}`, { orderId });
    return { order: updated };
  }

  // An order can be cancelled until it is on its way: once dispatched, ready
  // for pickup or delivered it is a return, handled under the vendor's policy.
  const CANCELLABLE = new Set(['pending', 'confirmed', 'accepted', 'processing', 'packed']);

  /**
   * Cancel an order: release its stock, withdraw a payment still waiting, and
   * raise a refund when it was already paid.
   */
  async function cancelOrder(order, { actorId, role, reasonCode }) {
    if (order.status === 'cancelled') return { order };
    if (['delivered', 'fulfilled'].includes(order.status)) return { error: 'order_already_delivered', status: 409 };
    if (role === 'buyer' && !CANCELLABLE.has(order.status)) return { error: 'order_already_dispatched', status: 409 };
    await restock(order);
    const at = nowIso();
    const wasPaid = order.paymentStatus === 'paid' && Number(order.totalTzs) > 0;
    if (order.paymentStatus === 'pending' && paymentRequests) {
      for (const r of await paymentRequests.filterAsync(p => p.orderId === order.id && p.status === 'pending')) {
        await paymentRequests.updateByIdAsync(r.id, { status: 'cancelled', decidedAt: at, decidedBy: actorId });
      }
    }
    const timeline = [...(Array.isArray(order.timeline) ? order.timeline : []), { status: 'cancelled', at, by: role }];
    const paymentStatus = wasPaid ? 'refund_pending' : order.paymentStatus === 'pending' ? 'cancelled' : order.paymentStatus;
    const updated = await shopOrders.updateByIdAsync(order.id, { status: 'cancelled', paymentStatus, timeline, updatedAt: at });
    try { await onOrderCancelled(order); } catch (err) { console.warn('[shop] cancelled order not taken back from a promotion:', err?.message); }
    await auditLog.insertAsync({ id: randomUUID(), at, actor: actorId, action: `shop_order_cancelled_by_${role}`, target: order.id, before: { status: order.status, paymentStatus: order.paymentStatus }, after: { status: 'cancelled', paymentStatus } });
    let refund = null;
    if (wasPaid) {
      try { refund = await onRefundDue({ order: updated, reasonCode, actorId, role }); } catch (err) { console.warn('[shop] refund not raised:', err?.message); }
    }
    if (role === 'buyer') {
      for (const vendorId of new Set((order.items || []).map(item => item.vendorId).filter(Boolean))) await notify(vendorId, 'order_cancelled', { orderId: order.id, by: 'buyer' });
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
    return cancelOrder(order, { actorId: buyerId, role: 'buyer', reasonCode: 'member_cancelled' });
  }

  /** The refund for a cancelled order was sent. */
  async function markOrderRefunded(orderId) {
    const order = await shopOrders.findByIdAsync(orderId);
    if (!order) return null;
    return shopOrders.updateByIdAsync(orderId, { paymentStatus: 'refunded', updatedAt: nowIso() });
  }

  async function vendorPayments(vendorId) {
    const orders = await vendorOrders(vendorId);
    const delivered = orders.filter(order => order.paymentStatus === 'paid' && ['delivered', 'fulfilled'].includes(order.status));
    const value = order => (order.items || []).filter(item => item.vendorId === vendorId || item.vendorId == null).reduce((sum, item) => sum + Number(item.priceTzs || 0) * Number(item.qty || 0), 0);
    const current = new Date(), day = current.toISOString().slice(0, 10), week = +current - 7 * 86400000, month = +current - 30 * 86400000;
    const total = rows => rows.reduce((sum, order) => sum + value(order), 0);
    return { todaySalesTzs: total(delivered.filter(order => String(order.updatedAt || order.createdAt).slice(0, 10) === day)), weeklySalesTzs: total(delivered.filter(order => +new Date(order.updatedAt || order.createdAt) >= week)), monthlySalesTzs: total(delivered.filter(order => +new Date(order.updatedAt || order.createdAt) >= month)), pendingSettlementTzs: total(delivered.filter(order => order.settlementStatus !== 'settled')), settledPaymentsTzs: total(delivered.filter(order => order.settlementStatus === 'settled')), settlements: delivered.map(order => ({ orderId: order.id, amountTzs: value(order), status: order.settlementStatus || 'pending', at: order.updatedAt || order.createdAt })) };
  }
  async function vendorStatement(vendorId) {
    const lines = ['order_id,amount_tzs,order_status,payment_status,settlement_status,date'];
    for (const order of await vendorOrders(vendorId)) {
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
    await notify(vendorId, 'new_customer_enquiry', { enquiryId: enquiry.id });
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
    return `${['FitFlex Marketplace Invoice', `Order: ${order.id}`, `Date: ${order.createdAt}`, ...order.items.map(item => `${item.qty} x ${item.name} @ TZS ${item.priceTzs}`), `Total: TZS ${order.totalTzs}`, `Payment: ${order.paymentStatus} (${order.paymentMethod})`].join('\n')}\n`;
  }
  async function reorder({ buyerId, orderId }) {
    const order = await shopOrders.findByIdAsync(orderId);
    if (!order || order.buyerId !== buyerId) return { error: 'order_not_found', status: 404 };
    return { items: (order.items || []).map(item => ({ productId: item.productId, qty: item.qty })) };
  }
  async function notifications(userId) {
    return (await marketplaceNotifications.filterAsync(notification => notification.userId === userId)).sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0));
  }

  return { getVendorProfile, saveVendorProfile, getVendorStore, listProducts, getProduct, upsertProduct, duplicateProduct, deleteProduct, adminListProducts, adminCreateProduct, adminUpdateProductListing, adminListVendors, adminUpdateVendor, createOrder, applyPaymentToOrder, buyerCancelOrder, markOrderRefunded, myOrders, vendorOrders, updateOrderStatus, vendorPayments, vendorStatement, sendEnquiry, vendorEnquiries, replyEnquiry, resolveEnquiry, createVendorStaff, listVendorStaff, disableVendorStaff, canStaff, authorizeStaff, reviewProduct, orderInvoice, reorder, notifications };
}
