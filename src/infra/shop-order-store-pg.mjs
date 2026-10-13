// Postgres implementation of the shop's order store: every change that must hold
// together (reserve stock + create the order + create its payment request; or
// cancel the order + give its stock back) runs in ONE transaction, and every
// stock or state change is a conditional UPDATE so that concurrent requests
// cannot oversell or release twice.
//
// The service never sees knex; it talks to the port described in
// src/services/shop-order-store-memory.mjs (which is also the contract).
import { randomUUID } from 'node:crypto';

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

const plain = (row) => (row ? JSON.parse(JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? Number(v) : v))) : null);
const json = (value) => (value === undefined || value === null || typeof value === 'string' ? value : JSON.stringify(value));
const at = (value) => (value ? new Date(value) : null);

const ORDER_JSON = ['items', 'timeline'];
const ORDER_DATES = ['createdAt', 'updatedAt', 'reservationExpiresAt'];
const ORDER_COLUMNS = new Set([
  'id', 'buyerId', 'buyerRole', 'items', 'totalTzs', 'status', 'deliveryMethod', 'pickupGymId', 'deliveryAddress',
  'paymentMethod', 'paymentStatus', 'paymentReference', 'timeline', 'settlementStatus', 'note', 'createdAt', 'updatedAt',
  'idempotencyKey', 'idempotencyFingerprint', 'stockState', 'reservationExpiresAt',
]);
const PAYMENT_COLUMNS = new Set([
  'id', 'memberId', 'orderId', 'amountTzs', 'currency', 'status', 'provider', 'reference', 'requestedAt', 'decidedAt', 'decidedBy', 'note',
]);

function orderRow(order) {
  const row = {};
  for (const [key, value] of Object.entries(order)) {
    if (!ORDER_COLUMNS.has(key) || value === undefined) continue;
    row[key] = ORDER_JSON.includes(key) ? json(value) : ORDER_DATES.includes(key) ? at(value) : value;
  }
  return row;
}
function paymentRow(request) {
  const row = {};
  for (const [key, value] of Object.entries(request)) {
    if (!PAYMENT_COLUMNS.has(key) || value === undefined) continue;
    row[key] = ['requestedAt', 'decidedAt'].includes(key) ? at(value) : value;
  }
  return row;
}

export function createPgShopOrderStore({ db, now = () => new Date() }) {
  const out = plain;

  async function findByKey(trxOrDb, buyerId, key) {
    return out(await trxOrDb('ShopOrder').where({ buyerId, idempotencyKey: key }).first());
  }

  async function replay(buyerId, key, fingerprint) {
    const existing = await findByKey(db, buyerId, key);
    if (!existing) return null;
    if (existing.idempotencyFingerprint && fingerprint && existing.idempotencyFingerprint !== fingerprint) {
      return { error: 'idempotency_key_reused', status: 409 };
    }
    const paymentRequest = out(await db('PaymentRequest').where({ orderId: existing.id }).orderBy('requestedAt', 'desc').first());
    return { order: existing, paymentRequest, replayed: true };
  }

  /**
   * Reserve stock, create the order and its payment request — all or nothing.
   * lines: [{ productId, qty, priceTzs, discountPriceTzs }] — the prices the order was priced at;
   * if the product's price moved in between, nothing is reserved and the buyer is asked to retry.
   */
  async function placeOrder({ order, lines, paymentRequest = null, idempotency = null }) {
    if (idempotency?.key) {
      const earlier = await replay(order.buyerId, idempotency.key, idempotency.fingerprint);
      if (earlier) return earlier;
    }
    const atTime = now();
    try {
      return await db.transaction(async (trx) => {
        // Always in the same order, so two checkouts never wait on each other in a circle.
        for (const line of [...lines].sort((a, b) => (a.productId < b.productId ? -1 : 1))) {
          const updated = await trx('Product')
            .where({ id: line.productId, status: 'active' })
            .whereNull('deletedAt')
            .where((q) => q.whereNull('approvalStatus').orWhereNotIn('approvalStatus', ['pending', 'rejected']))
            .where('stock', '>=', line.qty)
            .where('priceTzs', line.priceTzs)
            .whereRaw('COALESCE("discountPriceTzs", 0) = ?', [Number(line.discountPriceTzs || 0)])
            .update({
              stock: trx.raw('stock - ?', [line.qty]),
              soldCount: trx.raw('COALESCE("soldCount", 0) + ?', [line.qty]),
              updatedAt: atTime,
            })
            .returning(['id', 'stock']);
          if (!updated.length) {
            // Why it failed, for a useful answer. Still inside the transaction, which is about to roll back.
            const product = await trx('Product').where({ id: line.productId }).first();
            const sellable = product && !product.deletedAt && product.status === 'active'
              && !['pending', 'rejected'].includes(product.approvalStatus);
            if (!sellable) { const e = new Error('product_not_found'); e.shop = { error: 'product_not_found', status: 404, productId: line.productId }; throw e; }
            if (Number(product.stock) < line.qty) { const e = new Error('insufficient_stock'); e.shop = { error: 'insufficient_stock', status: 409, productId: line.productId }; throw e; }
            const e = new Error('price_changed'); e.shop = { error: 'price_changed', status: 409, productId: line.productId }; throw e;
          }
          await trx('ShopStockMovement').insert({
            id: `stk_${randomUUID().slice(0, 12)}`, orderId: order.id, productId: line.productId,
            delta: -line.qty, reason: 'reserve', stockAfter: updated[0].stock, createdAt: atTime,
          });
        }
        await trx('ShopOrder').insert(orderRow({
          ...order,
          idempotencyKey: idempotency?.key || null,
          idempotencyFingerprint: idempotency?.key ? idempotency.fingerprint || null : null,
          stockState: 'reserved',
        }));
        if (paymentRequest) await trx('PaymentRequest').insert(paymentRow(paymentRequest));
        return { order: out(await trx('ShopOrder').where({ id: order.id }).first()), paymentRequest, replayed: false };
      });
    } catch (err) {
      if (err.shop) return err.shop;
      // The same key arrived twice at once: the other request won; this one rolled back whole.
      if (err.code === UNIQUE_VIOLATION && idempotency?.key) {
        const earlier = await replay(order.buyerId, idempotency.key, idempotency.fingerprint);
        if (earlier) return earlier;
      }
      // The table constraint is the last line of defence.
      if (err.code === CHECK_VIOLATION && /product_stock_non_negative/.test(err.constraint || err.message)) {
        return { error: 'insufficient_stock', status: 409 };
      }
      throw err;
    }
  }

  /**
   * Move an order to `cancelled` and give its reserved stock back — once.
   * `patch` is applied with the cancellation (status itself is forced to 'cancelled').
   * Refuses (changed:false) when the order is already cancelled or is no longer in a
   * state the caller expected, so two concurrent cancels cannot both win.
   *   fromStatuses / paymentStatuses: optional lists the order must currently be in.
   */
  async function cancelAndRelease(orderId, { patch = {}, fromStatuses = null, paymentStatuses = null } = {}) {
    return db.transaction(async (trx) => {
      const current = out(await trx('ShopOrder').where({ id: orderId }).forUpdate().first());
      if (!current) return { error: 'order_not_found', status: 404 };
      if (current.status === 'cancelled') return { order: current, changed: false, reason: 'already_cancelled' };
      if (fromStatuses && !fromStatuses.includes(current.status)) return { order: current, changed: false, reason: 'status_changed' };
      if (paymentStatuses && !paymentStatuses.includes(current.paymentStatus)) return { order: current, changed: false, reason: 'payment_changed' };
      const atTime = now();
      let released = false;
      if (current.stockState === 'reserved') {
        for (const item of [...(current.items || [])].sort((a, b) => (a.productId < b.productId ? -1 : 1))) {
          const qty = Number(item.qty || 0);
          if (qty <= 0) continue;
          // The ledger's unique key means a second release of the same order and product cannot be written.
          const inserted = await trx('ShopStockMovement')
            .insert({ id: `stk_${randomUUID().slice(0, 12)}`, orderId, productId: item.productId, delta: qty, reason: 'release', createdAt: atTime })
            .onConflict(['orderId', 'productId', 'reason']).ignore()
            .returning('id');
          if (!inserted.length) continue;
          const restocked = await trx('Product').where({ id: item.productId }).update({
            stock: trx.raw('stock + ?', [qty]),
            soldCount: trx.raw('GREATEST(COALESCE("soldCount", 0) - ?, 0)', [qty]),
            updatedAt: atTime,
          }).returning('stock');
          if (restocked.length) await trx('ShopStockMovement').where({ orderId, productId: item.productId, reason: 'release' }).update({ stockAfter: restocked[0].stock });
        }
        released = true;
      }
      const update = orderRow({ ...patch, status: 'cancelled', stockState: released ? 'released' : current.stockState, updatedAt: patch.updatedAt || atTime });
      delete update.id;
      await trx('ShopOrder').where({ id: orderId }).update(update);
      return { order: out(await trx('ShopOrder').where({ id: orderId }).first()), changed: true, released };
    });
  }

  /** The payment was confirmed. Only an order that is not cancelled and not already paid becomes paid. */
  async function markPaid(orderId, { patch = {} } = {}) {
    const rows = await db('ShopOrder')
      .where({ id: orderId }).whereNot({ status: 'cancelled' })
      .where((q) => q.whereNull('paymentStatus').orWhereNot('paymentStatus', 'paid'))
      .update(orderRow({ ...patch, paymentStatus: 'paid', reservationExpiresAt: null, updatedAt: now() }))
      .returning('*');
    if (rows.length) return { outcome: 'paid', order: out(rows[0]) };
    const order = out(await db('ShopOrder').where({ id: orderId }).first());
    if (!order) return { outcome: 'missing' };
    if (order.status === 'cancelled') return { outcome: 'cancelled', order };
    return { outcome: 'already_paid', order };
  }

  /** Money arrived for an order that was already cancelled or had expired: it is owed back. Once. */
  async function markLatePayment(orderId) {
    const rows = await db('ShopOrder')
      .where({ id: orderId, status: 'cancelled' })
      .whereIn('paymentStatus', ['pending', 'cancelled', 'failed'])
      .update({ paymentStatus: 'refund_pending', updatedAt: now() })
      .returning('*');
    return rows.length ? { marked: true, order: out(rows[0]) } : { marked: false, order: out(await db('ShopOrder').where({ id: orderId }).first()) };
  }

  /** Unpaid orders whose reservation has lapsed. */
  async function findExpired({ before = now(), limit = 100 } = {}) {
    const rows = await db('ShopOrder')
      .where({ status: 'pending', paymentStatus: 'pending', stockState: 'reserved' })
      .where('reservationExpiresAt', '<=', before)
      .orderBy('reservationExpiresAt').limit(limit);
    return rows.map(out);
  }

  return { placeOrder, findReplay: ({ buyerId, key, fingerprint }) => replay(buyerId, key, fingerprint), cancelAndRelease, markPaid, markLatePayment, findExpired };
}
