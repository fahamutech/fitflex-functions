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
//   cancelAndRelease(orderId, { patch (object | current→object), fromStatuses, paymentStatuses, refuseIf(current)→null|{error,status} })
//     → { order, changed, released?, reason? } | { error, status }
//   reviveOrder(orderId, { patch }) → { revived, order?, reason?, productId? }   (re-reserves a released order; all lines or none)
//   updateWithLock(orderId, decide(current) → { error } | { patch, value? } | { value }) → { order, value } | { error, status }
//   markPaid(orderId, { patch }) → { outcome: 'paid'|'already_paid'|'cancelled'|'missing', order }
//   markLatePayment(orderId) → { marked, order }
//   findExpired({ before, limit }) → orders
//   ordersForVendor(vendorId) → orders with a line naming this vendor, newest first

export function createMemoryShopOrderStore({ products, shopOrders, paymentRequests = null, now = () => new Date() }) {
  const nowIso = () => now().toISOString();

  const isSellable = (product) => Boolean(product && !product.deletedAt && product.status === 'active'
    && !['pending', 'rejected'].includes(product.approvalStatus) && (product.visibility || 'visible') !== 'hidden');
  const variantCheck = (product, line) => {
    if (!line.variantTracked) return null;
    const variant = (product.variants || []).find(v => v?.name === line.variant);
    if (!variant || typeof variant.stock !== 'number') return 'variant_not_found';
    return variant.stock < line.qty ? 'insufficient_stock' : null;
  };
  const withVariantStock = (product, line, sign) => (product.variants || []).map(v => (
    line.variantTracked && v?.name === line.variant && typeof v.stock === 'number' ? { ...v, stock: v.stock + sign * line.qty } : v));
  const lineOf = (item) => ({ productId: item.productId, variant: item.variant || null, variantTracked: Boolean(item.variantStockReserved), qty: Number(item.qty || 0) });

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
      if (!isSellable(product)) return { error: 'product_not_found', status: 404, productId: line.productId };
      if (Number(product.stock) < line.qty) return { error: 'insufficient_stock', status: 409, productId: line.productId };
      const variantProblem = variantCheck(product, line);
      if (variantProblem) return { error: variantProblem, status: variantProblem === 'variant_not_found' ? 404 : 409, productId: line.productId };
      if (Number(product.priceTzs || 0) !== line.priceTzs || Number(product.discountPriceTzs || 0) !== Number(line.discountPriceTzs || 0)) {
        return { error: 'price_changed', status: 409, productId: line.productId };
      }
      current.push({ product, line });
    }
    for (const { product, line } of current) {
      const fresh = await products.findByIdAsync(product.id);
      await products.updateByIdAsync(product.id, { stock: Number(fresh.stock) - line.qty, soldCount: Number(fresh.soldCount || 0) + line.qty, variants: withVariantStock(fresh, line, -1), updatedAt: nowIso() });
    }
    const saved = await shopOrders.insertAsync({
      ...order,
      idempotencyKey: idempotency?.key || null,
      idempotencyFingerprint: idempotency?.key ? idempotency.fingerprint || null : null,
      stockState: 'reserved',
      reservationCycle: 1,
    });
    if (paymentRequest && paymentRequests) await paymentRequests.insertAsync(paymentRequest);
    return { order: saved, paymentRequest, replayed: false };
  }

  async function cancelAndRelease(orderId, { patch = {}, fromStatuses = null, paymentStatuses = null, refuseIf = null } = {}) {
    const current = await shopOrders.findByIdAsync(orderId);
    if (!current) return { error: 'order_not_found', status: 404 };
    if (current.status === 'cancelled') return { order: current, changed: false, reason: 'already_cancelled' };
    if (fromStatuses && !fromStatuses.includes(current.status)) return { order: current, changed: false, reason: 'status_changed' };
    if (paymentStatuses && !paymentStatuses.includes(current.paymentStatus)) return { order: current, changed: false, reason: 'payment_changed' };
    const refused = refuseIf ? refuseIf(current) : null;
    if (refused) return refused;
    const applied = typeof patch === 'function' ? patch(current) : patch;
    let released = false;
    // Orders written before stock states existed have none; they are treated as holding their stock.
    if ((current.stockState || 'reserved') === 'reserved') {
      for (const line of (current.items || []).map(lineOf)) {
        const product = await products.findByIdAsync(line.productId);
        if (product) {
          await products.updateByIdAsync(product.id, {
            stock: Number(product.stock) + line.qty,
            soldCount: Math.max(0, Number(product.soldCount || 0) - line.qty),
            variants: withVariantStock(product, line, +1),
            updatedAt: nowIso(),
          });
        }
      }
      released = true;
    }
    const order = await shopOrders.updateByIdAsync(orderId, { ...applied, status: 'cancelled', stockState: released ? 'released' : current.stockState, updatedAt: applied.updatedAt || nowIso() });
    return { order, changed: true, released };
  }

  // Not a lock: the memory store is for unit specs, which are sequential.
  async function updateWithLock(orderId, decide) {
    const current = await shopOrders.findByIdAsync(orderId);
    if (!current) return { error: 'order_not_found', status: 404 };
    const decision = decide(current);
    if (decision.error) return decision;
    if (!decision.patch) return { order: current, value: decision.value };
    const order = await shopOrders.updateByIdAsync(orderId, { ...decision.patch, updatedAt: decision.patch.updatedAt || nowIso() });
    return { order, value: decision.value };
  }

  async function markPaid(orderId, { patch = {} } = {}) {
    const order = await shopOrders.findByIdAsync(orderId);
    if (!order) return { outcome: 'missing' };
    if (order.status === 'cancelled') return { outcome: 'cancelled', order };
    if (order.paymentStatus === 'paid') return { outcome: 'already_paid', order };
    const updated = await shopOrders.updateByIdAsync(orderId, { ...patch, paymentStatus: 'paid', reservationExpiresAt: null, updatedAt: nowIso() });
    return { outcome: 'paid', order: updated };
  }

  async function reviveOrder(orderId, { patch = {} } = {}) {
    const order = await shopOrders.findByIdAsync(orderId);
    if (!order) return { revived: false, reason: 'missing' };
    if (order.status !== 'cancelled' || order.stockState !== 'released' || !['pending', 'cancelled', 'failed'].includes(order.paymentStatus)) {
      return { revived: false, reason: 'not_revivable', order };
    }
    const applied = typeof patch === 'function' ? patch(order) : patch;
    const lines = (order.items || []).map(lineOf).filter(l => l.qty > 0);
    const found = [];
    for (const line of lines) {
      const product = await products.findByIdAsync(line.productId);
      if (!isSellable(product)) return { revived: false, reason: 'product_not_found', productId: line.productId, order };
      if (Number(product.stock) < line.qty) return { revived: false, reason: 'insufficient_stock', productId: line.productId, order };
      const problem = variantCheck(product, line);
      if (problem) return { revived: false, reason: problem, productId: line.productId, order };
      found.push({ product, line });
    }
    for (const { product, line } of found) {
      await products.updateByIdAsync(product.id, { stock: Number(product.stock) - line.qty, soldCount: Number(product.soldCount || 0) + line.qty, variants: withVariantStock(product, line, -1), updatedAt: nowIso() });
    }
    const updated = await shopOrders.updateByIdAsync(orderId, {
      ...applied, status: 'pending', paymentStatus: 'paid', stockState: 'reserved',
      reservationCycle: (order.reservationCycle || 1) + 1, reservationExpiresAt: null, updatedAt: nowIso(),
    });
    return { revived: true, order: updated };
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

  async function ordersForVendor(vendorId) {
    if (!vendorId) return [];
    return (await shopOrders.filterAsync(order => (order.items || []).some(item => item?.vendorId != null && item.vendorId === vendorId)))
      .sort((a, b) => (+new Date(b.createdAt || 0) - +new Date(a.createdAt || 0)) || (String(b.id) < String(a.id) ? -1 : 1));
  }

  return { placeOrder, findReplay, cancelAndRelease, updateWithLock, markPaid, reviveOrder, markLatePayment, findExpired, ordersForVendor };
}
