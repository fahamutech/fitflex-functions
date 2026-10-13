// The shop's order-store port, implemented over the plain collections the
// service already receives. It is used by unit specs and wherever no
// database-backed store is injected.
//
// It follows the same rules as the Postgres store (src/infra/shop-order-store-pg.mjs),
// but it is NOT atomic across concurrent requests: it exists so the service's
// logic can be tested without a database. Production wiring passes the
// Postgres store; the concurrency guarantees are tested against that one.
//
// Port:
//   placeOrder({ order, lines, paymentRequest, idempotency })
//     → { order, paymentRequest, replayed } | { error, status, productId? }
//   findReplay({ buyerId, key, fingerprint }) → { order, paymentRequest, replayed } | { error, status } | null
//   cancelAndRelease(orderId, { patch, fromStatuses, paymentStatuses })
//     → { order, changed, released?, reason? } | { error, status }
//   markPaid(orderId, { patch }) → { outcome: 'paid'|'already_paid'|'cancelled'|'missing', order }
//   markLatePayment(orderId) → { marked, order }
//   findExpired({ before, limit }) → orders

export function createMemoryShopOrderStore({ products, shopOrders, paymentRequests = null, now = () => new Date() }) {
  const nowIso = () => now().toISOString();

  async function findReplay({ buyerId, key, fingerprint }) {
    const earlier = await shopOrders.findAsync(row => row.buyerId === buyerId && row.idempotencyKey === key);
    if (!earlier) return null;
    if (earlier.idempotencyFingerprint && fingerprint && earlier.idempotencyFingerprint !== fingerprint) {
      return { error: 'idempotency_key_reused', status: 409 };
    }
    const request = paymentRequests ? await paymentRequests.findAsync(row => row.orderId === earlier.id) : null;
    return { order: earlier, paymentRequest: request, replayed: true };
  }

  async function placeOrder({ order, lines, paymentRequest = null, idempotency = null }) {
    if (idempotency?.key) {
      const earlier = await findReplay({ buyerId: order.buyerId, key: idempotency.key, fingerprint: idempotency.fingerprint });
      if (earlier) return earlier;
    }
    // Check every line before touching any, so a failure leaves nothing changed.
    const current = [];
    for (const line of lines) {
      const product = await products.findByIdAsync(line.productId);
      const sellable = product && !product.deletedAt && product.status === 'active' && !['pending', 'rejected'].includes(product.approvalStatus);
      if (!sellable) return { error: 'product_not_found', status: 404, productId: line.productId };
      if (Number(product.stock) < line.qty) return { error: 'insufficient_stock', status: 409, productId: line.productId };
      if (Number(product.priceTzs || 0) !== line.priceTzs || Number(product.discountPriceTzs || 0) !== Number(line.discountPriceTzs || 0)) {
        return { error: 'price_changed', status: 409, productId: line.productId };
      }
      current.push({ product, line });
    }
    for (const { product, line } of current) {
      await products.updateByIdAsync(product.id, { stock: Number(product.stock) - line.qty, soldCount: Number(product.soldCount || 0) + line.qty, updatedAt: nowIso() });
    }
    const saved = await shopOrders.insertAsync({
      ...order,
      idempotencyKey: idempotency?.key || null,
      idempotencyFingerprint: idempotency?.key ? idempotency.fingerprint || null : null,
      stockState: 'reserved',
    });
    if (paymentRequest && paymentRequests) await paymentRequests.insertAsync(paymentRequest);
    return { order: saved, paymentRequest, replayed: false };
  }

  async function cancelAndRelease(orderId, { patch = {}, fromStatuses = null, paymentStatuses = null } = {}) {
    const current = await shopOrders.findByIdAsync(orderId);
    if (!current) return { error: 'order_not_found', status: 404 };
    if (current.status === 'cancelled') return { order: current, changed: false, reason: 'already_cancelled' };
    if (fromStatuses && !fromStatuses.includes(current.status)) return { order: current, changed: false, reason: 'status_changed' };
    if (paymentStatuses && !paymentStatuses.includes(current.paymentStatus)) return { order: current, changed: false, reason: 'payment_changed' };
    let released = false;
    // Orders written before stock states existed have none; they are treated as holding their stock.
    if ((current.stockState || 'reserved') === 'reserved') {
      for (const item of current.items || []) {
        const product = await products.findByIdAsync(item.productId);
        if (product) {
          await products.updateByIdAsync(product.id, {
            stock: Number(product.stock) + Number(item.qty || 0),
            soldCount: Math.max(0, Number(product.soldCount || 0) - Number(item.qty || 0)),
            updatedAt: nowIso(),
          });
        }
      }
      released = true;
    }
    const order = await shopOrders.updateByIdAsync(orderId, { ...patch, status: 'cancelled', stockState: released ? 'released' : current.stockState, updatedAt: patch.updatedAt || nowIso() });
    return { order, changed: true, released };
  }

  async function markPaid(orderId, { patch = {} } = {}) {
    const order = await shopOrders.findByIdAsync(orderId);
    if (!order) return { outcome: 'missing' };
    if (order.status === 'cancelled') return { outcome: 'cancelled', order };
    if (order.paymentStatus === 'paid') return { outcome: 'already_paid', order };
    const updated = await shopOrders.updateByIdAsync(orderId, { ...patch, paymentStatus: 'paid', reservationExpiresAt: null, updatedAt: nowIso() });
    return { outcome: 'paid', order: updated };
  }

  async function markLatePayment(orderId) {
    const order = await shopOrders.findByIdAsync(orderId);
    if (!order || order.status !== 'cancelled' || !['pending', 'cancelled', 'failed'].includes(order.paymentStatus)) return { marked: false, order };
    return { marked: true, order: await shopOrders.updateByIdAsync(orderId, { paymentStatus: 'refund_pending', updatedAt: nowIso() }) };
  }

  async function findExpired({ before = now(), limit = 100 } = {}) {
    const cutoff = +new Date(before);
    return (await shopOrders.filterAsync(order => order.status === 'pending' && order.paymentStatus === 'pending'
      && (order.stockState || 'reserved') === 'reserved' && order.reservationExpiresAt && +new Date(order.reservationExpiresAt) <= cutoff)).slice(0, limit);
  }

  return { placeOrder, findReplay, cancelAndRelease, markPaid, markLatePayment, findExpired };
}
