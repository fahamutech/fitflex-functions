// FitFlex Marketplace domain service. All persistence is dependency-injected.
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../auth/password-credentials.mjs';

const PRODUCT_STATUSES = new Set(['active', 'paused', 'archived']);
const ORDER_STATUSES = new Set(['pending', 'accepted', 'processing', 'packed', 'dispatched', 'ready_for_pickup', 'delivered', 'cancelled', 'confirmed', 'fulfilled']);
const PAYMENT_METHODS = new Set(['mpesa', 'airtel_money', 'mixx', 'card', 'bank']);
const PROFILE_REQUIRED = ['businessName', 'logo', 'banner', 'description', 'businessCategory', 'contactNumber', 'email', 'address', 'deliveryRegions', 'businessHours', 'settlementAccount'];
// Optional profile fields. Partner KYC reads productCategories and returnsPolicy
// for the vendor's marketplace requirements. Anything else in the body is ignored.
const PROFILE_OPTIONAL = ['productCategories', 'returnsPolicy'];
const PROFILE_FIELDS = new Set([...PROFILE_REQUIRED, ...PROFILE_OPTIONAL]);
const STAFF_ROLES = new Set(['admin', 'inventory_manager', 'orders_manager', 'sales', 'customer_care']);
const STAFF_PERMISSIONS = new Set(['products', 'orders', 'customers', 'reports', 'payments', 'staff']);
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

export function createShopService({ products, shopOrders, users, auditLog, marketplaceEnquiries, marketplaceNotifications, productReviews }) {
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
    return vendors
      .map(({ passwordHash, firebaseUid, ...vendor }) => ({
        ...vendor,
        vendorProfile: vendor.vendorProfile || null,
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
      patch.approvalStatus = body.approvalStatus;
      patch.approvalNote = body.approvalNote == null ? vendor.approvalNote || null : String(body.approvalNote).trim() || null;
      patch.approvedAt = body.approvalStatus === 'approved' ? nowIso() : null;
      patch.approvedBy = body.approvalStatus === 'approved' ? actorId : null;
    }
    if (['active', 'suspended'].includes(body?.accountStatus)) patch.accountStatus = body.accountStatus;
    if (typeof body?.verified === 'boolean') patch.verified = body.verified;
    const updated = await users.updateByIdAsync(vendorId, patch);
    await auditLog.insertAsync({
      id: randomUUID(), at: nowIso(), actor: actorId, action: 'vendor_management_updated',
      target: vendorId,
      before: { approvalStatus: vendor.approvalStatus, accountStatus: vendor.accountStatus, verified: vendor.verified },
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
    if (body?.paymentOutcome === 'failed') return { error: 'payment_failed', status: 402 };
    if (body?.paymentOutcome !== 'success') return { error: 'payment_confirmation_required', status: 402 };
    const resolved = [];
    for (const item of items) {
      const qty = Number(item.qty || 0);
      if (qty <= 0) return { error: 'invalid_quantity', status: 400 };
      const product = await products.findByIdAsync(item.productId);
      if (!product || product.deletedAt || product.status !== 'active' || ['pending', 'rejected'].includes(product.approvalStatus)) return { error: 'product_not_found', status: 404, productId: item.productId };
      if (Number(product.stock) < qty) return { error: 'insufficient_stock', status: 409, productId: product.id };
      resolved.push({ product, qty });
    }
    for (const { product, qty } of resolved) await products.updateByIdAsync(product.id, { stock: Number(product.stock) - qty, soldCount: Number(product.soldCount || 0) + qty, updatedAt: nowIso() });
    const orderItems = resolved.map(({ product, qty }) => ({ productId: product.id, vendorId: product.vendorId, name: product.name, qty, priceTzs: priceOf(product), image: product.images?.[0] || null }));
    const totalTzs = orderItems.reduce((sum, item) => sum + item.priceTzs * item.qty, 0);
    const at = nowIso();
    const order = await shopOrders.insertAsync({ id: makeId('ord'), buyerId, buyerRole, items: orderItems, totalTzs, status: 'pending', deliveryMethod, pickupGymId: deliveryMethod === 'gym_pickup' ? body.pickupGymId : null, deliveryAddress: deliveryMethod === 'home_delivery' ? body.deliveryAddress : null, paymentMethod, paymentStatus: 'paid', paymentReference: body.paymentReference || makeId('pay'), timeline: [{ status: 'pending', at }], note: body?.note || null, settlementStatus: 'pending', createdAt: at, updatedAt: at });
    for (const vendorId of new Set(orderItems.map(item => item.vendorId))) await notify(vendorId, 'new_order', { orderId: order.id });
    await notify(buyerId, 'payment_received', { orderId: order.id, totalTzs });
    return { order, status: 201 };
  }
  async function myOrders(buyerId) {
    return (await shopOrders.filterAsync(order => order.buyerId === buyerId)).sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0));
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
    if (status === 'cancelled' && order.status !== 'cancelled') for (const item of order.items || []) {
      const product = await products.findByIdAsync(item.productId);
      if (product) await products.updateByIdAsync(product.id, { stock: Number(product.stock) + Number(item.qty || 0), updatedAt: nowIso() });
    }
    const at = nowIso();
    const timeline = Array.isArray(order.timeline) ? order.timeline : [];
    timeline.push({ status, at });
    const normalized = status === 'fulfilled' ? 'delivered' : status;
    const updated = await shopOrders.updateByIdAsync(orderId, { status: normalized, timeline, updatedAt: at });
    await auditLog.insertAsync({ id: randomUUID(), at, actor: actorId, action: `shop_order_${normalized}`, target: orderId, before: { status: order.status }, after: { status: normalized } });
    await notify(order.buyerId, `order_${normalized}`, { orderId });
    return { order: updated };
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

  return { getVendorProfile, saveVendorProfile, getVendorStore, listProducts, getProduct, upsertProduct, duplicateProduct, deleteProduct, adminListProducts, adminCreateProduct, adminUpdateProductListing, adminListVendors, adminUpdateVendor, createOrder, myOrders, vendorOrders, updateOrderStatus, vendorPayments, vendorStatement, sendEnquiry, vendorEnquiries, replyEnquiry, resolveEnquiry, createVendorStaff, listVendorStaff, disableVendorStaff, canStaff, authorizeStaff, reviewProduct, orderInvoice, reorder, notifications };
}
