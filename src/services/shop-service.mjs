// D1 — Shop / vendor e-commerce service (phase 1: catalogue + orders).
// Pure DI: receives store collections via the factory.
import { randomUUID } from 'node:crypto';

const ORDER_STATUSES = ['pending', 'confirmed', 'fulfilled', 'cancelled'];

export function createShopService({ products, shopOrders, users, auditLog }) {
  // ── catalogue ────────────────────────────────────────────────────────────

  async function listProducts({ category, search, vendorId, includeArchived = false } = {}) {
    let rows = await products.filterAsync(p => includeArchived || p.status === 'active');
    if (vendorId) rows = rows.filter(p => p.vendorId === vendorId);
    if (category) rows = rows.filter(p => (p.category || '').toLowerCase() === String(category).toLowerCase());
    const q = String(search || '').trim().toLowerCase();
    if (q) {
      rows = rows.filter(p =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q));
    }
    return rows.sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0));
  }

  async function upsertProduct({ vendorId, body, productId }) {
    const { name, description, category, priceTzs, stock, images, status } = body || {};
    if (productId) {
      const prior = await products.findByIdAsync(productId);
      if (!prior) return { error: 'product_not_found', status: 404 };
      if (prior.vendorId !== vendorId) return { error: 'not_your_product', status: 403 };
      const patch = {
        ...(name !== undefined ? { name: String(name).trim() } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(category !== undefined ? { category } : {}),
        ...(priceTzs !== undefined ? { priceTzs: Number(priceTzs) } : {}),
        ...(stock !== undefined ? { stock: Number(stock) } : {}),
        ...(Array.isArray(images) ? { images } : {}),
        ...(status && ['active', 'archived'].includes(status) ? { status } : {}),
        updatedAt: new Date().toISOString(),
      };
      const updated = await products.updateByIdAsync(productId, patch);
      return { product: updated };
    }

    if (!name?.trim()) return { error: 'name_required', status: 400 };
    if (priceTzs == null || Number(priceTzs) <= 0) return { error: 'priceTzs_required', status: 400 };
    const nowIso = new Date().toISOString();
    const product = await products.insertAsync({
      id: `prd_${randomUUID().slice(0, 8)}`,
      vendorId,
      name: name.trim(),
      description: description || null,
      category: category || null,
      priceTzs: Number(priceTzs),
      stock: Number(stock ?? 0),
      images: Array.isArray(images) ? images : [],
      status: 'active',
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    return { product, created: true };
  }

  // ── orders ───────────────────────────────────────────────────────────────

  async function createOrder({ buyerId, buyerRole = 'member', body }) {
    const items = Array.isArray(body?.items) ? body.items : [];
    if (items.length === 0) return { error: 'items_required', status: 400 };

    const resolved = [];
    for (const item of items) {
      const qty = Number(item.qty || 0);
      if (qty <= 0) return { error: 'invalid_quantity', status: 400 };
      const product = await products.findByIdAsync(item.productId);
      if (!product || product.status !== 'active') return { error: 'product_not_found', status: 404, productId: item.productId };
      if (product.stock < qty) return { error: 'insufficient_stock', status: 409, productId: product.id };
      resolved.push({ product, qty });
    }

    // Deduct stock only after every line validated.
    for (const { product, qty } of resolved) {
      await products.updateByIdAsync(product.id, { stock: product.stock - qty, updatedAt: new Date().toISOString() });
    }

    const orderItems = resolved.map(({ product, qty }) => ({
      productId: product.id,
      name: product.name,
      qty,
      priceTzs: product.priceTzs,
    }));
    const totalTzs = orderItems.reduce((sum, i) => sum + i.priceTzs * i.qty, 0);
    const nowIso = new Date().toISOString();
    const order = await shopOrders.insertAsync({
      id: `ord_${randomUUID().slice(0, 8)}`,
      buyerId,
      buyerRole,
      items: orderItems,
      totalTzs,
      status: 'pending',
      note: body?.note || null,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    return { order, status: 201 };
  }

  async function myOrders(buyerId) {
    const rows = await shopOrders.filterAsync(o => o.buyerId === buyerId);
    return rows.sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0));
  }

  async function vendorOrders(vendorId) {
    const vendorProducts = await products.filterAsync(p => p.vendorId === vendorId);
    const ids = new Set(vendorProducts.map(p => p.id));
    const all = await shopOrders.filterAsync(() => true);
    return all
      .filter(o => (o.items || []).some(i => ids.has(i.productId)))
      .sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0));
  }

  async function updateOrderStatus({ orderId, status, actorId }) {
    if (!ORDER_STATUSES.includes(status)) return { error: 'invalid_status', status: 400 };
    const order = await shopOrders.findByIdAsync(orderId);
    if (!order) return { error: 'order_not_found', status: 404 };
    // Cancelling restocks the items.
    if (status === 'cancelled' && order.status !== 'cancelled') {
      for (const item of order.items || []) {
        const product = await products.findByIdAsync(item.productId);
        if (product) {
          await products.updateByIdAsync(product.id, { stock: product.stock + Number(item.qty || 0) });
        }
      }
    }
    const updated = await shopOrders.updateByIdAsync(orderId, { status, updatedAt: new Date().toISOString() });
    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: actorId, action: `shop_order_${status}`,
      target: orderId, before: { status: order.status }, after: { status },
    });
    return { order: updated };
  }

  return { listProducts, upsertProduct, createOrder, myOrders, vendorOrders, updateOrderStatus };
}
