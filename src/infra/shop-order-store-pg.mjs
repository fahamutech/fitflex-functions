// Postgres implementation of the shop's order store: every change that must hold
// together (reserve stock + create the order + create its payment request; or
// cancel the order + give its stock back) runs in ONE transaction, and every
// stock or state change is a conditional UPDATE so that concurrent requests
// cannot oversell or release twice.
//
// The service never sees knex; it talks to the port described in
// src/services/shop-order-store-memory.mjs (which is also the contract).
import { randomUUID } from 'node:crypto';
import { standingPrice } from '../shared/shop-pricing.mjs';

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

const plain = (row) => (row ? JSON.parse(JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? Number(v) : v))) : null);
const json = (value) => (value === undefined || value === null || typeof value === 'string' ? value : JSON.stringify(value));
const at = (value) => (value ? new Date(value) : null);

const ORDER_JSON = ['items', 'timeline', 'fulfilments'];
const ORDER_DATES = ['createdAt', 'updatedAt', 'reservationExpiresAt', 'paidAt'];
const ORDER_COLUMNS = new Set([
  'id', 'buyerId', 'buyerRole', 'items', 'totalTzs', 'status', 'deliveryMethod', 'pickupGymId', 'deliveryAddress',
  'paymentMethod', 'paymentStatus', 'paymentReference', 'timeline', 'settlementStatus', 'note', 'createdAt', 'updatedAt',
  'idempotencyKey', 'idempotencyFingerprint', 'stockState', 'reservationExpiresAt', 'reservationCycle', 'fulfilments',
  // S6: when the payment was confirmed (vendor reports date app sales by it; settlement never reads it).
  'paidAt',
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

const byLine = (a, b) => (a.productId + (a.variant || '') < b.productId + (b.variant || '') ? -1 : 1);
const shopError = (error, status, productId) => Object.assign(new Error(error), { shop: { error, status, productId } });

// A product's `variants` is a jsonb array of { name, stock? }. Only a variant that carries a numeric
// stock has its own count; its units are reserved in the same statement as the product's.
// Exported for walk-in sales (S3), which take stock from the same pool with the same statement.
export const VARIANT_HAS_STOCK = `EXISTS (SELECT 1 FROM jsonb_array_elements("Product".variants) v
  WHERE v->>'name' = ? AND jsonb_typeof(v->'stock') = 'number' AND (v->>'stock')::numeric >= ?)`;
export const variantStockAdjusted = (sign) => `(SELECT COALESCE(jsonb_agg(CASE WHEN v->>'name' = ? AND jsonb_typeof(v->'stock') = 'number'
  THEN jsonb_set(v, '{stock}', to_jsonb((v->>'stock')::numeric ${sign} ?)) ELSE v END ORDER BY ord), '[]'::jsonb)
  FROM jsonb_array_elements("Product".variants) WITH ORDINALITY AS t(v, ord))`;

export const variantStockOf = (variants, name) => {
  const list = typeof variants === 'string' ? JSON.parse(variants) : variants;
  const found = Array.isArray(list) ? list.find(v => v?.name === name) : null;
  return typeof found?.stock === 'number' ? found.stock : null;
};

export function createPgShopOrderStore({ db, now = () => new Date() }) {
  const out = plain;

  async function replay(buyerId, key, fingerprint) {
    const existing = out(await db('ShopOrder').where({ buyerId, idempotencyKey: key }).first());
    if (!existing) return null;
    if (existing.idempotencyFingerprint && fingerprint && existing.idempotencyFingerprint !== fingerprint) {
      return { error: 'idempotency_key_reused', status: 409 };
    }
    const paymentRequest = out(await db('PaymentRequest').where({ orderId: existing.id }).orderBy('requestedAt', 'desc').first());
    return { order: existing, paymentRequest, replayed: true };
  }

  /**
   * Take `qty` units of a line from stock. Returns { stock, vendorId } — the line's new stock (the
   * variant's own when it keeps one, else the product's) and whose it is — or null if it could not be taken.
   */
  async function reserveLine(trx, line, { requirePrice, atTime }) {
    let query = trx('Product')
      .where({ id: line.productId, status: 'active' })
      .whereNull('deletedAt')
      .whereRaw(`COALESCE("visibility", 'visible') <> 'hidden'`)
      .where((q) => q.whereNull('approvalStatus').orWhereNotIn('approvalStatus', ['pending', 'rejected']))
      .where('stock', '>=', line.qty);
    if (requirePrice) {
      query = query.where('priceTzs', line.priceTzs).whereRaw('COALESCE("discountPriceTzs", 0) = ?', [Number(line.discountPriceTzs || 0)]);
    }
    const update = { stock: trx.raw('stock - ?', [line.qty]), soldCount: trx.raw('COALESCE("soldCount", 0) + ?', [line.qty]), updatedAt: atTime };
    if (line.variantTracked) {
      query = query.whereRaw(VARIANT_HAS_STOCK, [line.variant, line.qty]);
      update.variants = trx.raw(variantStockAdjusted('-'), [line.variant, line.qty]);
    }
    const rows = await query.update(update).returning(['stock', 'vendorId', 'variants']);
    if (!rows.length) return null;
    return { stock: line.variantTracked ? variantStockOf(rows[0].variants, line.variant) ?? rows[0].stock : rows[0].stock, vendorId: rows[0].vendorId };
  }

  async function whyNotReservable(trx, line, requirePrice) {
    const product = await trx('Product').where({ id: line.productId }).first();
    const sellable = product && !product.deletedAt && product.status === 'active'
      && !['pending', 'rejected'].includes(product.approvalStatus) && (product.visibility || 'visible') !== 'hidden';
    if (!sellable) return shopError('product_not_found', 404, line.productId);
    if (Number(product.stock) < line.qty) return shopError('insufficient_stock', 409, line.productId);
    if (line.variantTracked) {
      const variant = (product.variants || []).find(v => v?.name === line.variant);
      if (!variant || typeof variant.stock !== 'number') return shopError('variant_not_found', 404, line.productId);
      if (variant.stock < line.qty) return shopError('insufficient_stock', 409, line.productId);
    }
    return requirePrice ? shopError('price_changed', 409, line.productId) : shopError('insufficient_stock', 409, line.productId);
  }

  // Bookkeeping for the vendor's stock history: whose stock it is, and that an order moved it.
  const ledgerRow = (orderId, line, reason, cycle, delta, atTime, stockAfter = null, vendorId = null) => ({
    id: `stk_${randomUUID().slice(0, 12)}`, orderId, productId: line.productId, variant: line.variant || '',
    cycle, reason, delta, stockAfter, createdAt: atTime, kind: 'order', vendorId: vendorId || line.vendorId || null,
  });


  /**
   * PRICING PATH (flash sales). For each line priced with checkSale, the sale that applies now must be the
   * one it was priced with (flashSaleId, or none): the window may have closed, a sale may have started,
   * or staff may have ended it between pricing and this lock → price_changed (nothing reserved). The rows
   * are read FOR SHARE, so ending or editing a sale waits for this order to commit. A live sale applies
   * only when below the line's standing price (the price and discount are checked unchanged by reserveLine).
   */
  async function recheckSales(trx, lines, atTime) {
    const checked = lines.filter(l => l.checkSale);
    if (!checked.length) return;
    const ids = [...new Set(checked.map(l => l.productId))].sort();
    const live = await trx('FlashSale').whereIn('productId', ids).where({ status: 'approved' })
      .where('startsAt', '<=', atTime).where('endsAt', '>', atTime).orderBy('id').forShare();
    // L1: products an admin took off the shop (homepageVisible false) never get a sale price (shop-pricing.saleLiveFor).
    const offShop = new Set((await trx('Product').whereIn('id', ids).where({ homepageVisible: false }).select('id')).map(r => r.id));
    for (const line of [...checked].sort(byLine)) {
      const standing = standingPrice(line);
      const applies = live.filter(r => r.productId === line.productId && !offShop.has(line.productId) && Number(r.salePriceTzs) > 0 && Number(r.salePriceTzs) < standing)
        .sort((a, b) => Number(a.salePriceTzs) - Number(b.salePriceTzs))[0] || null;
      if ((applies?.id ?? null) !== (line.flashSaleId ?? null)) throw shopError('price_changed', 409, line.productId);
    }
  }

  /**
   * Reserve stock, create the order and its payment request — all or nothing.
   * lines: [{ productId, variant?, variantTracked?, qty, priceTzs, discountPriceTzs }] — the prices the order
   * was priced at; if the product's price moved in between, nothing is reserved and the buyer is asked to retry.
   */
  async function placeOrder({ order, lines, paymentRequest = null, idempotency = null }) {
    if (idempotency?.key) {
      const earlier = await replay(order.buyerId, idempotency.key, idempotency.fingerprint);
      if (earlier) return earlier;
    }
    const atTime = now();
    try {
      return await db.transaction(async (trx) => {
        // Flash sales (SHOP_FLASH_SALES on: lines carry checkSale): re-read the live sales under a share
        // lock, by this server's clock, before any stock moves.
        await recheckSales(trx, lines, atTime);
        // Always in the same order, so two checkouts never wait on each other in a circle.
        for (const line of [...lines].sort(byLine)) {
          const taken = await reserveLine(trx, line, { requirePrice: true, atTime });
          if (taken == null) throw await whyNotReservable(trx, line, true);
          await trx('ShopStockMovement').insert(ledgerRow(order.id, line, 'reserve', 1, -line.qty, atTime, taken.stock, taken.vendorId));
        }
        await trx('ShopOrder').insert(orderRow({
          ...order,
          idempotencyKey: idempotency?.key || null,
          idempotencyFingerprint: idempotency?.key ? idempotency.fingerprint || null : null,
          stockState: 'reserved',
          reservationCycle: 1,
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

  const lineOf = (item) => ({
    productId: item.productId, variant: item.variant || null, variantTracked: Boolean(item.variantStockReserved), qty: Number(item.qty || 0),
    vendorId: item.vendorId || null,
  });

  /**
   * Move an order to `cancelled` and give its reserved stock back — once.
   * `patch` is applied with the cancellation (status itself is forced to 'cancelled').
   * Refuses (changed:false) when the order is already cancelled or is no longer in a
   * state the caller expected, so two concurrent cancels cannot both win.
   *   fromStatuses / paymentStatuses: optional lists the order must currently be in.
   */
  async function cancelAndRelease(orderId, { patch = {}, fromStatuses = null, paymentStatuses = null, refuseIf = null } = {}) {
    return db.transaction(async (trx) => {
      const current = out(await trx('ShopOrder').where({ id: orderId }).forUpdate().first());
      if (!current) return { error: 'order_not_found', status: 404 };
      if (current.status === 'cancelled') return { order: current, changed: false, reason: 'already_cancelled' };
      if (fromStatuses && !fromStatuses.includes(current.status)) return { order: current, changed: false, reason: 'status_changed' };
      if (paymentStatuses && !paymentStatuses.includes(current.paymentStatus)) return { order: current, changed: false, reason: 'payment_changed' };
      // The caller's own rule, judged on the row as it is now that it is locked.
      const refused = refuseIf ? refuseIf(current) : null;
      if (refused) return refused;
      const atTime = now();
      const cycle = current.reservationCycle || 1;
      const applied = typeof patch === 'function' ? patch(current) : patch;
      let released = false;
      if (current.stockState === 'reserved') {
        for (const line of (current.items || []).map(lineOf).filter(l => l.qty > 0).sort(byLine)) {
          // The ledger's unique key means a second release of the same order, product and cycle cannot be written.
          const inserted = await trx('ShopStockMovement')
            .insert(ledgerRow(orderId, line, 'release', cycle, line.qty, atTime))
            .onConflict(['orderId', 'productId', 'variant', 'reason', 'cycle']).ignore()
            .returning('id');
          if (!inserted.length) continue;
          const update = {
            stock: trx.raw('stock + ?', [line.qty]),
            soldCount: trx.raw('GREATEST(COALESCE("soldCount", 0) - ?, 0)', [line.qty]),
            updatedAt: atTime,
          };
          if (line.variantTracked) update.variants = trx.raw(variantStockAdjusted('+'), [line.variant, line.qty]);
          const restocked = await trx('Product').where({ id: line.productId }).update(update).returning(['stock', 'vendorId', 'variants']);
          if (restocked.length) {
            const after = line.variantTracked ? variantStockOf(restocked[0].variants, line.variant) ?? restocked[0].stock : restocked[0].stock;
            await trx('ShopStockMovement')
              .where({ orderId, productId: line.productId, variant: line.variant || '', reason: 'release', cycle })
              .update({ stockAfter: after, vendorId: restocked[0].vendorId });
          }
        }
        released = true;
      }
      const update = orderRow({ ...applied, status: 'cancelled', stockState: released ? 'released' : current.stockState, updatedAt: applied.updatedAt || atTime });
      delete update.id;
      await trx('ShopOrder').where({ id: orderId }).update(update);
      return { order: out(await trx('ShopOrder').where({ id: orderId }).first()), changed: true, released };
    });
  }

  /**
   * Change one order under its row lock. `decide(current)` is pure: it returns
   *   { error, status, ... }            → nothing is written, the error is returned
   *   { patch, value? }                  → patch is written, { order, value } returned
   *   { value }                          → nothing to write (a no-op), { order, value } returned
   * Concurrent changes to the same order run one after the other, each seeing the last one's result.
   */
  async function updateWithLock(orderId, decide) {
    return db.transaction(async (trx) => {
      const current = out(await trx('ShopOrder').where({ id: orderId }).forUpdate().first());
      if (!current) return { error: 'order_not_found', status: 404 };
      const decision = decide(current);
      if (decision.error) return decision;
      if (!decision.patch) return { order: current, value: decision.value };
      const update = orderRow({ ...decision.patch, updatedAt: decision.patch.updatedAt || now() });
      delete update.id;
      await trx('ShopOrder').where({ id: orderId }).update(update);
      return { order: out(await trx('ShopOrder').where({ id: orderId }).first()), value: decision.value };
    });
  }

  /**
   * The payment was confirmed. Only an order that is not cancelled and not already paid becomes paid.
   * S6: paidAt records when (vendor reports date app sales by it).
   */
  async function markPaid(orderId, { patch = {} } = {}) {
    const atTime = now();
    const rows = await db('ShopOrder')
      .where({ id: orderId }).whereNot({ status: 'cancelled' })
      .where((q) => q.whereNull('paymentStatus').orWhereNot('paymentStatus', 'paid'))
      .update(orderRow({ ...patch, paymentStatus: 'paid', reservationExpiresAt: null, paidAt: atTime, updatedAt: atTime }))
      .returning('*');
    if (rows.length) return { outcome: 'paid', order: out(rows[0]) };
    const order = out(await db('ShopOrder').where({ id: orderId }).first());
    if (!order) return { outcome: 'missing' };
    if (order.status === 'cancelled') return { outcome: 'cancelled', order };
    return { outcome: 'already_paid', order };
  }

  /**
   * Payment arrived for an order that had been cancelled or had expired: take its stock again and make it a
   * live, paid order — only if every line can still be reserved (otherwise nothing changes: the caller refunds).
   * Revives once: the order must still be cancelled, with its stock released and its payment unconfirmed.
   */
  async function reviveOrder(orderId, { patch = {} } = {}) {
    try {
      return await db.transaction(async (trx) => {
        const current = out(await trx('ShopOrder').where({ id: orderId }).forUpdate().first());
        if (!current) return { revived: false, reason: 'missing' };
        if (current.status !== 'cancelled' || current.stockState !== 'released' || !['pending', 'cancelled', 'failed'].includes(current.paymentStatus)) {
          return { revived: false, reason: 'not_revivable', order: current };
        }
        const atTime = now();
        const applied = typeof patch === 'function' ? patch(current) : patch;
        const cycle = (current.reservationCycle || 1) + 1;
        for (const line of (current.items || []).map(lineOf).filter(l => l.qty > 0).sort(byLine)) {
          const taken = await reserveLine(trx, line, { requirePrice: false, atTime });
          if (taken == null) throw Object.assign(new Error('not_reservable'), { why: await whyNotReservable(trx, line, false), order: current });
          await trx('ShopStockMovement').insert(ledgerRow(orderId, line, 'reserve', cycle, -line.qty, atTime, taken.stock, taken.vendorId));
        }
        await trx('ShopOrder').where({ id: orderId }).update(orderRow({
          ...applied, status: 'pending', paymentStatus: 'paid', stockState: 'reserved', reservationCycle: cycle, reservationExpiresAt: null, paidAt: atTime, updatedAt: atTime,
        }));
        return { revived: true, order: out(await trx('ShopOrder').where({ id: orderId }).first()) };
      });
    } catch (err) {
      if (err.why) return { revived: false, reason: err.why.shop.error, productId: err.why.shop.productId, order: err.order };
      throw err;
    }
  }

  /** Money arrived for an order that cannot be revived: it is owed back. Once. */
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

  /**
   * Every order with a line of this vendor's, newest first (vendor tools · S2). One parameterised
   * query on the items GIN index (jsonb containment), not a whole-table load. Lines without a
   * vendorId (older rows) never match.
   */
  async function ordersForVendor(vendorId, { limit = null, after = null, buyerId = null } = {}) {
    if (!vendorId) return [];
    const query = db('ShopOrder')
      .whereRaw('"items" @> ?::jsonb', [JSON.stringify([{ vendorId: String(vendorId) }])])
      // S4: one customer's orders (GET /vendor/orders?customerId=, resolved to the buyer by the route).
      .modify(q => { if (buyerId) q.where('buyerId', String(buyerId)); })
      .orderBy([{ column: 'createdAt', order: 'desc' }, { column: 'id', order: 'desc' }]);
    // Keyset: strictly after the cursor's (createdAt, id) in that order.
    if (after) query.whereRaw('("createdAt", "id") < (?::timestamptz, ?)', [after.createdAt, after.id]);
    if (limit) query.limit(limit);
    return (await query).map(out);
  }

  /**
   * Orders-tab counts over ALL of this vendor's orders, in one parameterised aggregate. The rules are
   * orderTab() in src/shared/vendor-order-view.mjs: own status = this vendor's fulfilment status, else the
   * order's status (orders from before fulfilments).
   */
  async function countsForVendor(vendorId, { buyerId = null } = {}) {
    const empty = { open: 0, delivered: 0, cancelled: 0, all: 0, waitingAccept: 0 };
    if (!vendorId) return empty;
    const { rows } = await db.raw(`
      WITH mine AS (
        SELECT o."status" AS order_status, o."paymentStatus" AS pay,
               COALESCE((SELECT f->>'status' FROM jsonb_array_elements(
                          CASE WHEN jsonb_typeof(o."fulfilments") = 'array' THEN o."fulfilments" ELSE '[]'::jsonb END) f
                         WHERE f->>'vendorId' = ? LIMIT 1), o."status") AS own
          FROM "ShopOrder" o
         WHERE o."items" @> ?::jsonb AND (?::text IS NULL OR o."buyerId" = ?::text)
      ), tabbed AS (
        SELECT own, CASE
                 WHEN own = 'cancelled' OR order_status = 'cancelled' OR pay IN ('refund_pending', 'refunded') THEN 'cancelled'
                 WHEN own IN ('delivered', 'fulfilled') THEN 'delivered'
                 WHEN pay = 'paid' THEN 'open'
                 ELSE 'unpaid' END AS tab
          FROM mine
      )
      SELECT count(*) FILTER (WHERE tab = 'open')::int AS "open",
             count(*) FILTER (WHERE tab = 'delivered')::int AS "delivered",
             count(*) FILTER (WHERE tab = 'cancelled')::int AS "cancelled",
             count(*)::int AS "all",
             count(*) FILTER (WHERE tab = 'open' AND own = 'pending')::int AS "waitingAccept"
        FROM tabbed`, [String(vendorId), JSON.stringify([{ vendorId: String(vendorId) }]), buyerId ? String(buyerId) : null, buyerId ? String(buyerId) : null]);
    return { ...empty, ...rows[0] };
  }

  return { placeOrder, findReplay: ({ buyerId, key, fingerprint }) => replay(buyerId, key, fingerprint), cancelAndRelease, updateWithLock, markPaid, reviveOrder, markLatePayment, findExpired, ordersForVendor, countsForVendor };
}
