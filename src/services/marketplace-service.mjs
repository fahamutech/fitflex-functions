// FitFlex Af — Marketplace Service (clean architecture + DI)
//
// Capabilities:
//   - Product CRUD (vendor creates, public browses with filters)
//   - Cart management (add, remove, update quantity, clear)
//   - Checkout flow (calculate total + delivery fee, generate collection code)
//   - Order creation with custodial gym pickup assignment
//   - Order status transitions (pending → paid → pre_delivery → dispatched → custody → collected)
//   - Vendor fulfillment pipeline
//   - Gym custody desk (receive packages, verify collection code, handover)
//   - Product reviews (1-5 stars, same pattern as gym/trainer reviews)
//   - Vendor dashboard (GMV, net revenue, pending dispatches, catalog)
//   - Escrow release (48h after collection)
//
// Business rules:
//   - Delivery fee: (base 3000 TZS) + (distance_km × 1500 TZS) for physical items
//   - Digital items (events, services): no delivery fee, no gym pickup
//   - Collection code: FF-COL-XXXX format
//   - Vendor commission: 10-15% per vendor (negotiated at onboarding)
//   - Escrow: vendor payout released 48h after collection
//   - Cart: max 50 items, max 99 quantity per item

import { randomUUID } from 'node:crypto';
import {
  PRODUCT_CATEGORIES,
  ORDER_STATUS,
  ORDER_TRANSITIONS,
  DELIVERY_FEE_BASE_TZS,
  DELIVERY_FEE_PER_KM_TZS,
  DIGITAL_CATEGORIES,
  calculateDeliveryFee,
  generateCollectionCode,
  VENDOR_COMMISSION_RANGE,
  VENDOR_STATUS,
  VENDOR_PAYOUT_CYCLE,
  ESCROW_RELEASE_HOURS,
  MAX_CART_ITEMS,
  MAX_QUANTITY_PER_ITEM,
  MIN_RATING,
  MAX_RATING,
  MIN_REVIEW_TEXT_LENGTH,
  MAX_REVIEW_TEXT_LENGTH,
  REVIEW_STATUS
} from '../shared/marketplace-constants.mjs';

export function createMarketplaceService({
  users, gyms, vendors, products, productReviews,
  orders, cart, auditLog
}) {

  // ─── Validation Helpers ──────────────────────────────────────────────────

  function validateProductData(data) {
    if (!data.name) return { valid: false, error: 'name_required' };
    if (!data.category) return { valid: false, error: 'category_required' };
    if (!PRODUCT_CATEGORIES[data.category])
      return { valid: false, error: 'invalid_category' };
    if (data.subcategory && !PRODUCT_CATEGORIES[data.category].subcategories.includes(data.subcategory))
      return { valid: false, error: 'invalid_subcategory' };
    if (typeof data.price !== 'number' || data.price < 0)
      return { valid: false, error: 'invalid_price' };
    return { valid: true };
  }

  function validateRating(rating) {
    if (typeof rating !== 'number' || !Number.isInteger(rating))
      return { valid: false, error: 'rating_must_be_integer' };
    if (rating < MIN_RATING || rating > MAX_RATING)
      return { valid: false, error: `rating_must_be_between_${MIN_RATING}_and_${MAX_RATING}` };
    return { valid: true };
  }

  function validateText(text) {
    if (!text || text.trim() === '') return { valid: true, text: null };
    if (text.trim().length < MIN_REVIEW_TEXT_LENGTH) return { valid: false, error: 'text_too_short' };
    if (text.length > MAX_REVIEW_TEXT_LENGTH) return { valid: false, error: 'text_too_long' };
    return { valid: true, text: text.trim() };
  }

  function validateCommissionRate(rate) {
    if (typeof rate !== 'number' || rate < VENDOR_COMMISSION_RANGE.min || rate > VENDOR_COMMISSION_RANGE.max)
      return { valid: false, error: `commissionRate must be between ${VENDOR_COMMISSION_RANGE.min} and ${VENDOR_COMMISSION_RANGE.max}` };
    return { valid: true };
  }

  // ─── Product Management ──────────────────────────────────────────────────

  function createProduct({ vendorId, name, category, subcategory, price, currency = 'TZS', imageUrl, stock, description, variants }) {
    const vendor = vendors.find(v => v.id === vendorId && v.status === VENDOR_STATUS.ACTIVE);
    if (!vendor) return { ok: false, error: 'vendor_not_found_or_inactive' };

    const validation = validateProductData({ name, category, subcategory, price });
    if (!validation.valid) return { ok: false, error: validation.error };

    const isDigital = DIGITAL_CATEGORIES.includes(category);
    const product = {
      id: `prod_${randomUUID().slice(0, 8)}`,
      vendorId,
      name: name.trim(),
      category,
      subcategory: subcategory || null,
      price: Math.round(price),
      currency,
      imageUrl: imageUrl || null,
      stock: isDigital ? -1 : (Math.max(0, Number(stock) || 0)),  // -1 = unlimited (digital)
      description: description || null,
      variants: variants || null,   // { sizes: ['S','M','L'], colors: ['red','blue'], flavors: ['chocolate'] }
      isDigital,
      rating: 0,
      reviewCount: 0,
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    products.insert(product);
    return { ok: true, product };
  }

  function updateProduct(productId, vendorId, updates) {
    const product = products.find(p => p.id === productId && p.vendorId === vendorId);
    if (!product) return { ok: false, error: 'product_not_found' };

    const allowed = ['name', 'price', 'stock', 'imageUrl', 'description', 'subcategory', 'variants'];
    const patch = {};
    for (const key of allowed) {
      if (updates[key] !== undefined) patch[key] = updates[key];
    }
    patch.updatedAt = new Date().toISOString();

    const updated = products.update(p => p.id === productId, patch);
    return { ok: true, product: updated };
  }

  function deleteProduct(productId, vendorId) {
    const product = products.find(p => p.id === productId && p.vendorId === vendorId);
    if (!product) return { ok: false, error: 'product_not_found' };
    // Soft delete — set status to archived
    products.update(p => p.id === productId, { status: 'archived', updatedAt: new Date().toISOString() });
    return { ok: true };
  }

  function listProducts({ category, subcategory, search, sortBy, priceMin, priceMax, inStockOnly, limit } = {}) {
    let list = products.filter(p => p.status === 'active');

    if (category) list = list.filter(p => p.category === category);
    if (subcategory) list = list.filter(p => p.subcategory === subcategory);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(p => p.name.toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q));
    }
    if (typeof priceMin === 'number') list = list.filter(p => p.price >= priceMin);
    if (typeof priceMax === 'number') list = list.filter(p => p.price <= priceMax);
    if (inStockOnly) list = list.filter(p => p.isDigital || p.stock > 0);

    if (sortBy === 'price_low') list.sort((a, b) => a.price - b.price);
    else if (sortBy === 'price_high') list.sort((a, b) => b.price - a.price);
    else if (sortBy === 'rating') list.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    else if (sortBy === 'popularity') list.sort((a, b) => (b.reviewCount || 0) - (a.reviewCount || 0));

    // Attach vendor name
    list = list.map(p => {
      const vendor = vendors.find(v => v.id === p.vendorId);
      return { ...p, vendorName: vendor?.name || null };
    });

    if (limit) list = list.slice(0, limit);
    return list;
  }

  function getProduct(productId) {
    const product = products.find(p => p.id === productId && p.status === 'active');
    if (!product) return null;
    const vendor = vendors.find(v => v.id === product.vendorId);
    return { ...product, vendorName: vendor?.name || null };
  }

  // ─── Cart Management ─────────────────────────────────────────────────────

  function addToCart({ memberId, productId, quantity = 1 }) {
    const product = products.find(p => p.id === productId && p.status === 'active');
    if (!product) return { ok: false, error: 'product_not_found' };
    if (!product.isDigital && product.stock <= 0) return { ok: false, error: 'out_of_stock' };
    if (quantity < 1 || quantity > MAX_QUANTITY_PER_ITEM)
      return { ok: false, error: `quantity_must_be_between_1_and_${MAX_QUANTITY_PER_ITEM}` };

    let memberCart = cart.find(c => c.memberId === memberId);
    if (!memberCart) {
      memberCart = { memberId, items: [] };
      cart.insert(memberCart);
    }
    if (memberCart.items.length >= MAX_CART_ITEMS)
      return { ok: false, error: 'cart_full' };

    // Check if product already in cart
    const existing = memberCart.items.find(i => i.productId === productId);
    if (existing) {
      existing.quantity += quantity;
      if (existing.quantity > MAX_QUANTITY_PER_ITEM) existing.quantity = MAX_QUANTITY_PER_ITEM;
    } else {
      memberCart.items.push({ productId, quantity, addedAt: new Date().toISOString() });
    }

    cart.update(c => c.memberId === memberId, { items: memberCart.items });
    return { ok: true, cart: memberCart };
  }

  function removeFromCart({ memberId, productId }) {
    let memberCart = cart.find(c => c.memberId === memberId);
    if (!memberCart) return { ok: false, error: 'cart_empty' };
    memberCart.items = memberCart.items.filter(i => i.productId !== productId);
    cart.update(c => c.memberId === memberId, { items: memberCart.items });
    return { ok: true, cart: memberCart };
  }

  function updateCartQuantity({ memberId, productId, quantity }) {
    if (quantity < 1 || quantity > MAX_QUANTITY_PER_ITEM)
      return { ok: false, error: `quantity_must_be_between_1_and_${MAX_QUANTITY_PER_ITEM}` };

    let memberCart = cart.find(c => c.memberId === memberId);
    if (!memberCart) return { ok: false, error: 'cart_empty' };
    const item = memberCart.items.find(i => i.productId === productId);
    if (!item) return { ok: false, error: 'item_not_in_cart' };
    item.quantity = quantity;
    cart.update(c => c.memberId === memberId, { items: memberCart.items });
    return { ok: true, cart: memberCart };
  }

  function getCart(memberId) {
    const memberCart = cart.find(c => c.memberId === memberId);
    if (!memberCart || memberCart.items.length === 0) return { items: [], subtotal: 0 };
    const items = memberCart.items.map(i => {
      const product = products.find(p => p.id === i.productId);
      return {
        productId: i.productId,
        quantity: i.quantity,
        product: product ? {
          name: product.name,
          price: product.price,
          imageUrl: product.imageUrl,
          category: product.category,
          isDigital: product.isDigital,
          stock: product.stock
        } : null
      };
    }).filter(i => i.product);

    const subtotal = items.reduce((sum, i) => sum + (i.product.price * i.quantity), 0);
    return { items, subtotal };
  }

  function clearCart(memberId) {
    cart.update(c => c.memberId === memberId, { items: [] });
    return { ok: true };
  }

  // ─── Checkout & Order Creation ────────────────────────────────────────────

  function checkout({ memberId, pickupGymId, paymentMethod = 'mpesa', paymentPhone }) {
    const memberCart = getCart(memberId);
    if (memberCart.items.length === 0) return { ok: false, error: 'cart_empty' };

    // Validate pickup gym (required for physical items)
    const hasPhysicalItems = memberCart.items.some(i => !i.product.isDigital);
    if (hasPhysicalItems && !pickupGymId)
      return { ok: false, error: 'pickup_gym_required_for_physical_items' };

    const gym = gyms.find(g => g.id === pickupGymId && g.status === 'active');
    if (hasPhysicalItems && !gym) return { ok: false, error: 'pickup_gym_not_found' };

    // Calculate subtotal
    const subtotal = memberCart.subtotal;

    // Calculate delivery fee based on gym distance from city center
    // (In production, this would use the gym's registered distance from logistics depot)
    const gymDistanceKm = gym?.distance || 5; // default 5km if not set
    const deliveryFee = hasPhysicalItems ? calculateDeliveryFee({
      category: 'equipment',  // use physical category for fee calc
      distanceKm: gymDistanceKm
    }) : 0;

    const total = subtotal + deliveryFee;

    // Generate collection code for physical items
    const collectionCode = hasPhysicalItems ? generateCollectionCode() : null;

    // Build order items with vendor info for payout splitting
    const orderItems = memberCart.items.map(i => {
      const product = products.find(p => p.id === i.productId);
      const vendor = vendors.find(v => v.id === product.vendorId);
      const commissionRate = vendor?.commissionRate || VENDOR_COMMISSION_RANGE.default;
      const itemTotal = product.price * i.quantity;
      const commissionAmount = Math.round(itemTotal * commissionRate);
      const vendorPayout = itemTotal - commissionAmount;

      return {
        productId: i.productId,
        productName: product.name,
        vendorId: product.vendorId,
        quantity: i.quantity,
        unitPrice: product.price,
        itemTotal,
        commissionRate,
        commissionAmount,
        vendorPayout,
        isDigital: product.isDigital
      };
    });

    // Group by vendor for fulfillment
    const vendorBreakdown = {};
    for (const item of orderItems) {
      if (!vendorBreakdown[item.vendorId]) {
        vendorBreakdown[item.vendorId] = { vendorId: item.vendorId, items: [], gross: 0, commission: 0, payout: 0 };
      }
      vendorBreakdown[item.vendorId].items.push(item);
      vendorBreakdown[item.vendorId].gross += item.itemTotal;
      vendorBreakdown[item.vendorId].commission += item.commissionAmount;
      vendorBreakdown[item.vendorId].payout += item.vendorPayout;
    }

    const order = {
      id: `ord_${randomUUID().slice(0, 8)}`,
      memberId,
      items: orderItems,
      vendorBreakdown: Object.values(vendorBreakdown),
      pickupGymId: hasPhysicalItems ? pickupGymId : null,
      collectionCode,
      collectionQr: collectionCode ? `fitflex://collect/${collectionCode}` : null,
      subtotal,
      deliveryFee,
      total,
      paymentMethod,
      paymentPhone: paymentPhone || null,
      paymentStatus: 'pending',  // pending → paid (on Selcom webhook)
      paymentRef: null,
      status: ORDER_STATUS.PENDING,
      isDigitalOnly: !hasPhysicalItems,
      // Escrow release tracking
      escrowReleasedAt: null,
      escrowReleaseAt: null,  // set when order is collected
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    orders.insert(order);

    // Clear cart after successful order creation
    clearCart(memberId);

    return { ok: true, order };
  }

  // ─── Order Status Transitions ──────────────────────────────────────────────

  function transitionOrder(orderId, newStatus, actorId) {
    const order = orders.find(o => o.id === orderId);
    if (!order) return { ok: false, error: 'order_not_found' };

    const allowed = ORDER_TRANSITIONS[order.status] || [];
    if (!allowed.includes(newStatus))
      return { ok: false, error: `cannot_transition_from_${order.status}_to_${newStatus}` };

    const patch = {
      status: newStatus,
      updatedAt: new Date().toISOString()
    };

    // If collected, set escrow release time (48h from now)
    if (newStatus === ORDER_STATUS.COLLECTED) {
      const releaseAt = new Date(Date.now() + ESCROW_RELEASE_HOURS * 60 * 60 * 1000);
      patch.escrowReleaseAt = releaseAt.toISOString();
    }

    const updated = orders.update(o => o.id === orderId, patch);

    auditLog?.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: actorId, action: `order_${newStatus}`,
      target: orderId, before: order, after: updated
    });

    return { ok: true, order: updated };
  }

  // Vendor marks order as pre_delivery (preparing)
  function vendorMarkPreDelivery(orderId, vendorId) {
    const order = orders.find(o => o.id === orderId);
    if (!order) return { ok: false, error: 'order_not_found' };
    // Verify vendor has items in this order
    if (!order.vendorBreakdown.some(v => v.vendorId === vendorId))
      return { ok: false, error: 'vendor_not_in_order' };
    return transitionOrder(orderId, ORDER_STATUS.PRE_DELIVERY, vendorId);
  }

  // Vendor marks order as dispatched (courier en-route)
  function vendorMarkDispatched(orderId, vendorId) {
    const order = orders.find(o => o.id === orderId);
    if (!order) return { ok: false, error: 'order_not_found' };
    if (!order.vendorBreakdown.some(v => v.vendorId === vendorId))
      return { ok: false, error: 'vendor_not_in_order' };
    return transitionOrder(orderId, ORDER_STATUS.DISPATCHED, vendorId);
  }

  // Gym front desk logs receipt of package (custody)
  function gymLogCustody(orderId, operatorId) {
    return transitionOrder(orderId, ORDER_STATUS.CUSTODY, operatorId);
  }

  // Gym front desk verifies collection code and hands over to member
  function gymVerifyCollection({ collectionCode, operatorId }) {
    const order = orders.find(o => o.collectionCode === collectionCode && o.status === ORDER_STATUS.CUSTODY);
    if (!order) return { ok: false, error: 'invalid_collection_code_or_not_in_custody' };
    return transitionOrder(order.id, ORDER_STATUS.COLLECTED, operatorId);
  }

  // ─── Order Retrieval ──────────────────────────────────────────────────────

  function getMemberOrders(memberId, { limit = 50 } = {}) {
    return orders
      .filter(o => o.memberId === memberId)
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
      .slice(0, limit);
  }

  function getOrder(orderId) {
    return orders.find(o => o.id === orderId) || null;
  }

  function getOrderByCollectionCode(code) {
    return orders.find(o => o.collectionCode === code) || null;
  }

  function getVendorOrders(vendorId, { status, limit = 50 } = {}) {
    let list = orders.filter(o => o.vendorBreakdown.some(v => v.vendorId === vendorId));
    if (status) list = list.filter(o => o.status === status);
    return list
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
      .slice(0, limit);
  }

  function getGymCustodyOrders(gymId) {
    return orders
      .filter(o => o.pickupGymId === gymId && [ORDER_STATUS.DISPATCHED, ORDER_STATUS.CUSTODY].includes(o.status))
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  }

  // ─── Vendor Dashboard ────────────────────────────────────────────────────

  function getVendorDashboard(vendorId) {
    const vendor = vendors.find(v => v.id === vendorId);
    if (!vendor) return null;

    const vendorOrders = orders.filter(o => o.vendorBreakdown.some(v => v.vendorId === vendorId));
    const completedOrders = vendorOrders.filter(o => o.status === ORDER_STATUS.COLLECTED);
    const pendingOrders = vendorOrders.filter(o => [ORDER_STATUS.PAID, ORDER_STATUS.PRE_DELIVERY].includes(o.status));
    const activeProducts = products.filter(p => p.vendorId === vendorId && p.status === 'active');

    // Gross Merchandise Volume (total of all orders)
    const gmv = vendorOrders.reduce((sum, o) => {
      const vBreak = o.vendorBreakdown.find(v => v.vendorId === vendorId);
      return sum + (vBreak?.gross || 0);
    }, 0);

    // Net disbursed revenue (completed orders only)
    const netRevenue = completedOrders.reduce((sum, o) => {
      const vBreak = o.vendorBreakdown.find(v => v.vendorId === vendorId);
      return sum + (vBreak?.payout || 0);
    }, 0);

    // Commission paid
    const commissionPaid = completedOrders.reduce((sum, o) => {
      const vBreak = o.vendorBreakdown.find(v => v.vendorId === vendorId);
      return sum + (vBreak?.commission || 0);
    }, 0);

    return {
      vendor,
      stats: {
        gmv,
        netRevenue,
        commissionPaid,
        pendingDispatches: pendingOrders.length,
        activeCatalogSize: activeProducts.length,
        totalOrders: vendorOrders.length,
        completedOrders: completedOrders.length
      },
      recentOrders: vendorOrders.slice(0, 10),
      pendingOrders: pendingOrders.slice(0, 10),
      activeProducts: activeProducts.slice(0, 20)
    };
  }

  // ─── Vendor Onboarding ───────────────────────────────────────────────────

  function onboardVendor({ userId, name, email, phone, city, businessName, taxId, payoutMethod, payoutPhone, payoutBankAccount, commissionRate }) {
    const cr = validateCommissionRate(commissionRate || VENDOR_COMMISSION_RANGE.default);
    if (!cr.valid) return { ok: false, error: cr.error };

    const vendor = {
      id: `ven_${randomUUID().slice(0, 8)}`,
      userId,
      name: name || businessName,
      businessName: businessName || name,
      email,
      phone,
      city,
      taxId: taxId || null,
      payoutMethod: payoutMethod || 'mpesa',  // mpesa | bank
      payoutPhone: payoutPhone || null,
      payoutBankAccount: payoutBankAccount || null,
      commissionRate: Number(commissionRate) || VENDOR_COMMISSION_RANGE.default,
      status: VENDOR_STATUS.PENDING,  // requires admin approval
      createdAt: new Date().toISOString()
    };

    vendors.insert(vendor);
    return { ok: true, vendor };
  }

  function approveVendor(vendorId, adminId) {
    const vendor = vendors.find(v => v.id === vendorId);
    if (!vendor) return { ok: false, error: 'vendor_not_found' };
    const updated = vendors.update(v => v.id === vendorId, {
      status: VENDOR_STATUS.ACTIVE,
      approvedAt: new Date().toISOString(),
      approvedBy: adminId
    });
    auditLog?.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: adminId, action: 'vendor_approved', target: vendorId, before: vendor, after: updated
    });
    return { ok: true, vendor: updated };
  }

  function suspendVendor(vendorId, adminId) {
    const updated = vendors.update(v => v.id === vendorId, { status: VENDOR_STATUS.SUSPENDED });
    auditLog?.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: adminId, action: 'vendor_suspended', target: vendorId, before: null, after: updated
    });
    return { ok: true, vendor: updated };
  }

  // ─── Product Reviews ──────────────────────────────────────────────────────

  function submitProductReview({ memberId, productId, rating, text }) {
    const product = products.find(p => p.id === productId);
    if (!product) return { ok: false, error: 'product_not_found' };

    // Eligibility: must have purchased this product (order with this product)
    const hasPurchase = orders.some(o =>
      o.memberId === memberId &&
      o.items.some(i => i.productId === productId) &&
      o.status !== ORDER_STATUS.CANCELLED
    );
    if (!hasPurchase) return { ok: false, error: 'must_purchase_to_review' };

    const ratingCheck = validateRating(rating);
    if (!ratingCheck.valid) return { ok: false, error: ratingCheck.error };

    const textCheck = validateText(text);
    if (!textCheck.valid) return { ok: false, error: textCheck.error };

    const existing = productReviews.find(r => r.memberId === memberId && r.productId === productId);
    const now = new Date().toISOString();

    let review;
    if (existing) {
      review = productReviews.update(r => r.id === existing.id, {
        rating, text: textCheck.text, status: REVIEW_STATUS.PUBLISHED, updatedAt: now
      });
      review.id = existing.id;
    } else {
      review = {
        id: `prev_${randomUUID().slice(0, 8)}`,
        memberId, productId, rating, text: textCheck.text,
        status: REVIEW_STATUS.PUBLISHED,
        createdAt: now, updatedAt: now
      };
      productReviews.insert(review);
    }

    // Recalculate product rating
    recalculateProductRating(productId);

    return { ok: true, review };
  }

  function recalculateProductRating(productId) {
    const published = productReviews.filter(r => r.productId === productId && r.status === REVIEW_STATUS.PUBLISHED);
    const count = published.length;
    let average = null;
    if (count > 0) {
      const sum = published.reduce((acc, r) => acc + r.rating, 0);
      average = Math.round((sum / count) * 10) / 10;
    }
    products.update(p => p.id === productId, { rating: average, reviewCount: count });
    return { productId, averageRating: average, reviewCount: count };
  }

  function getProductReviews(productId, { sortBy = 'recent', limit = 50 } = {}) {
    let list = productReviews.filter(r => r.productId === productId && r.status === REVIEW_STATUS.PUBLISHED);
    if (sortBy === 'recent') list.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    else if (sortBy === 'highest') list.sort((a, b) => b.rating - a.rating);
    else if (sortBy === 'lowest') list.sort((a, b) => a.rating - b.rating);
    if (limit) list = list.slice(0, limit);
    return list.map(r => {
      const user = users.find(u => u.id === r.memberId);
      return { ...r, memberName: user?.displayName || null };
    });
  }

  // ─── Escrow Release (48h after collection) ──────────────────────────────

  function processEscrowReleases() {
    const now = Date.now();
    const eligible = orders.filter(o =>
      o.status === ORDER_STATUS.COLLECTED &&
      o.escrowReleaseAt &&
      new Date(o.escrowReleaseAt).getTime() <= now &&
      !o.escrowReleasedAt
    );

    for (const order of eligible) {
      // Mark escrow as released
      orders.update(o => o.id === order.id, { escrowReleasedAt: new Date().toISOString() });
      // In production, this would trigger the actual payout to vendor wallets
      console.log(`[escrow] released order ${order.id} — vendor payouts queued`);
    }

    return { released: eligible.length };
  }

  // ─── Payment Confirmation (called by Selcom webhook) ──────────────────────

  function confirmPayment(orderId, paymentRef) {
    const order = orders.find(o => o.id === orderId);
    if (!order) return { ok: false, error: 'order_not_found' };
    if (order.paymentStatus !== 'pending') return { ok: false, error: 'payment_already_processed' };

    orders.update(o => o.id === orderId, {
      paymentStatus: 'paid',
      paymentRef,
      status: ORDER_STATUS.PAID
    });

    // Decrement stock for physical items
    for (const item of order.items) {
      if (!item.isDigital) {
        const product = products.find(p => p.id === item.productId);
        if (product && product.stock > 0) {
          products.update(p => p.id === item.productId, {
            stock: Math.max(0, product.stock - item.quantity)
          });
        }
      }
    }

    return { ok: true, orderId };
  }

  return {
    // Products
    createProduct, updateProduct, deleteProduct, listProducts, getProduct,
    // Cart
    addToCart, removeFromCart, updateCartQuantity, getCart, clearCart,
    // Checkout & Orders
    checkout, getMemberOrders, getOrder, getOrderByCollectionCode,
    getVendorOrders, getGymCustodyOrders,
    // Order transitions
    transitionOrder, vendorMarkPreDelivery, vendorMarkDispatched,
    gymLogCustody, gymVerifyCollection, confirmPayment,
    // Vendor
    onboardVendor, approveVendor, suspendVendor, getVendorDashboard,
    // Reviews
    submitProductReview, getProductReviews, recalculateProductRating,
    // Escrow
    processEscrowReleases,
    // Constants re-export
    _constants: {
      PRODUCT_CATEGORIES, ORDER_STATUS, ORDER_TRANSITIONS,
      DELIVERY_FEE_BASE_TZS, DELIVERY_FEE_PER_KM_TZS, DIGITAL_CATEGORIES,
      VENDOR_COMMISSION_RANGE, VENDOR_STATUS, VENDOR_PAYOUT_CYCLE,
      ESCROW_RELEASE_HOURS, MAX_CART_ITEMS, MAX_QUANTITY_PER_ITEM,
      calculateDeliveryFee, generateCollectionCode
    }
  };
}
