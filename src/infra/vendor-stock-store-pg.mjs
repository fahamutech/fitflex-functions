// Postgres store for the vendor stock ledger (vendor business tools · S1).
//
// Every stock change is one transaction: the Product row is locked (FOR UPDATE), the change is a
// conditional UPDATE of stock (and the variant's stock in the same statement), and a ledger row
// is written with it. Queries are vendor- or product-scoped and parameterised; nothing loads a
// whole table.
import { randomUUID } from 'node:crypto';
import { variantsOf, isTracked, effectiveLevel } from '../shared/vendor-stock.mjs';

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const plain = row => (row ? JSON.parse(JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? Number(v) : v))) : null);
const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const stockId = () => `stk_${randomUUID().slice(0, 12)}`;

/** A product as the stock endpoints return it: its count and its variants' counts (no private fields). */
export const stockView = product => ({
  id: product.id,
  stock: Number(product.stock || 0),
  variants: variantsOf(product).map(v => ({ name: v.name, stock: isTracked(v) ? v.stock : null })),
});

export function createPgVendorStockStore({ db, now = () => new Date() }) {
  // ── ledger rows ────────────────────────────────────────────────────────────

  function movementView(row, actorName = null) {
    const r = plain(row);
    const after = r.stockAfter == null ? null : Number(r.stockAfter);
    return {
      id: r.id, productId: r.productId, variant: r.variant || null, reason: r.reason, kind: r.kind || 'order',
      delta: Number(r.delta), stockBefore: after == null ? null : after - Number(r.delta), stockAfter: after,
      note: r.note ?? null, actor: r.actorId ? { id: r.actorId, name: actorName ?? r.actorName ?? null } : null,
      orderId: r.orderId ?? null,
      // Q-4: an order-linked row points at its order. Orders have no human reference number yet.
      document: r.orderId ? { type: 'order', id: r.orderId, number: null } : null,
      createdAt: r.createdAt,
    };
  }

  const ledgerRow = ({ productId, vendorId, variant, delta, reason, stockAfter, note, actorId, clientRef = null, kind = 'adjustment', at }) => ({
    id: stockId(), orderId: null, productId, variant: variant || '', cycle: 1, delta, reason, stockAfter,
    kind, vendorId, note: note ?? null, actorId: actorId ?? null, clientRef, sourceId: null, createdAt: at,
  });

  async function actorName(q, actorId) {
    if (!actorId) return null;
    return (await q('User').where({ id: actorId }).first('displayName'))?.displayName ?? null;
  }

  /** Is this stored adjustment the same request as `adj` (product, variant, reason, quantity, direction)? */
  function sameRequest(row, productId, adj) {
    if (row.productId !== productId || (row.variant || '') !== (adj.variant || '') || row.reason !== adj.reason) return false;
    const delta = Number(row.delta);
    if (adj.kind === 'count') return Number(row.stockAfter) === adj.quantity;
    return Math.abs(delta) === adj.quantity && (adj.kind === 'in' ? delta > 0 : delta < 0);
  }

  async function replayOf(vendorId, productId, adj) {
    const row = await db('ShopStockMovement').where({ vendorId, clientRef: adj.clientRef }).first();
    if (!row) return null;
    // The same key with a different request is a client bug, not a retry.
    if (!sameRequest(row, productId, adj)) return fail('client_ref_reused', 409);
    const product = await db('Product').where({ id: productId }).first();
    return { movement: movementView(row, await actorName(db, row.actorId)), product: product ? stockView(product) : null, replayed: true };
  }

  /**
   * Apply one vendor adjustment. `adj` comes from parseAdjustment: { reason, variant, kind, quantity, expectedStock, note, clientRef }.
   * → { movement, product, replayed } or { error, status, currentStock? }.
   */
  async function adjust({ vendorId, actorId, productId, adj }) {
    const earlier = await replayOf(vendorId, productId, adj);
    if (earlier) return earlier;
    const at = now();
    try {
      return await db.transaction(async (trx) => {
        const product = await trx('Product').where({ id: productId }).forUpdate().first();
        if (!product || product.deletedAt) return fail('product_not_found', 404);
        if (product.vendorId !== vendorId) return fail('not_your_product', 403);
        const variants = variantsOf(product);
        const tracked = variants.filter(isTracked);
        let target = null;
        if (adj.variant) {
          target = tracked.find(v => v.name === adj.variant);
          if (!target) return fail('variant_not_found', 404, { variants: tracked.map(v => v.name) });
        } else if (tracked.length) {
          return fail('variant_required', 400, { variants: tracked.map(v => v.name) });
        }
        const before = target ? target.stock : Number(product.stock);
        let delta;
        if (adj.kind === 'count') {
          if (adj.expectedStock !== before) return fail('stock_changed', 409, { currentStock: before });
          delta = adj.quantity - before;
        } else {
          delta = adj.kind === 'in' ? adj.quantity : -adj.quantity;
        }
        const after = before + delta;
        if (after < 0 || Number(product.stock) + delta < 0) return fail('insufficient_stock', 409, { currentStock: before });
        let current = product;
        if (delta !== 0) {
          const update = { stock: trx.raw('stock + ?', [delta]), updatedAt: at };
          if (target) update.variants = JSON.stringify(variants.map(v => (v.name === target.name ? { ...v, stock: v.stock + delta } : v)));
          // Conditional on the count that was read under the lock: the database refuses anything else.
          const rows = await trx('Product').where({ id: productId, stock: product.stock }).where('stock', '>=', -delta).update(update).returning('*');
          if (!rows.length) return fail('stock_changed', 409, { currentStock: before });
          current = rows[0];
        }
        const [row] = await trx('ShopStockMovement').insert(ledgerRow({
          productId, vendorId, variant: target?.name, delta, reason: adj.reason, stockAfter: after, note: adj.note, actorId, clientRef: adj.clientRef, at,
        })).returning('*');
        return { movement: movementView(row, await actorName(trx, actorId)), product: stockView(current), replayed: false, vendorId };
      });
    } catch (err) {
      // The same clientRef arrived twice at once: the other request won.
      if (err.code === UNIQUE_VIOLATION && /client_ref/.test(err.constraint || err.message)) {
        const replay = await replayOf(vendorId, productId, adj);
        if (replay) return replay;
      }
      if (err.code === CHECK_VIOLATION && /product_stock_non_negative/.test(err.constraint || err.message)) return fail('insufficient_stock', 409);
      throw err;
    }
  }

  // ── product form (PUT /vendor/products/:id with the ledger on) ─────────────

  // Product columns, read once: a form's fields are written only where they are real columns.
  let productColumns = null;
  async function columnsOf(q) {
    productColumns ||= new Set(Object.keys(await q('Product').columnInfo()));
    return productColumns;
  }
  async function productRow(q, fields) {
    const columns = await columnsOf(q);
    const out = {};
    for (const [key, value] of Object.entries(fields)) {
      if (!columns.has(key) || value === undefined) continue;
      out[key] = key === 'variants' ? JSON.stringify(value) : value;
    }
    return out;
  }

  /** Variants (by name) that unpaid or unfulfilled orders still hold units of: their stock must come back to them. */
  async function reservedVariants(q, productId, names) {
    if (!names.length) return [];
    const held = [];
    for (const name of names) {
      // Still holding the units and still able to give them back (a delivered order never does).
      const open = await q('ShopOrder').where({ stockState: 'reserved' }).whereNotIn('status', ['cancelled', 'delivered', 'fulfilled'])
        .whereRaw('items @> ?::jsonb', [JSON.stringify([{ productId, variant: name, variantStockReserved: true }])]).first('id');
      if (open) held.push(name);
    }
    return held;
  }

  /**
   * Save a product form under the product's row lock — fields, approval status, stock and the ledger in one transaction.
   * decide(current) → { error, status, ... } | { fields, stock?, variants?, movements, removed, privates, value }
   * Writes the fields, stock/variants, one `count` ledger row per changed count, and the private fields — all or nothing.
   * A variant that open orders still hold units of cannot be removed (409 variant_has_reservations).
   */
  async function applyProductForm({ productId, vendorId, actorId, decide }) {
    const at = now();
    try {
      return await db.transaction(async (trx) => {
        const current = plain(await trx('Product').where({ id: productId }).forUpdate().first());
        if (!current || current.deletedAt) return fail('product_not_found', 404);
        if (current.vendorId !== vendorId) return fail('not_your_product', 403);
        const plan = decide(current);
        if (plan.error) return plan;
        const trackedRemoved = variantsOf(current).filter(v => isTracked(v) && (plan.removed || []).includes(v.name)).map(v => v.name);
        const held = await reservedVariants(trx, productId, trackedRemoved);
        if (held.length) return fail('variant_has_reservations', 409, { variant: held[0] });
        const update = await productRow(trx, { ...(plan.fields || {}), stock: plan.stock, variants: plan.variants });
        if (Object.keys(update).length) {
          update.updatedAt = at;
          await trx('Product').where({ id: productId }).update(update);
        }
        if (plan.movements?.length) {
          await trx('ShopStockMovement').insert(plan.movements.map(m => ledgerRow({
            productId, vendorId, variant: m.variant, delta: m.delta, reason: 'count', stockAfter: m.stockAfter, note: m.note, actorId, at,
          })));
        }
        if (plan.removed?.length) await trx('ProductPrivate').where({ productId }).whereIn('variant', plan.removed).del();
        await writePrivates(trx, productId, vendorId, plan.privates || [], at);
        return { product: plain(await trx('Product').where({ id: productId }).first()), value: plan.value };
      });
    } catch (err) {
      if (err.code === CHECK_VIOLATION && /product_stock_non_negative/.test(err.constraint || err.message)) return fail('insufficient_stock', 409);
      throw err;
    }
  }

  /** Create a product with its starting counts as the first rows of its history, and its private fields — one transaction. */
  async function createProduct({ product, actorId, movements, privates = [] }) {
    const at = now();
    const productId = product.id;
    const vendorId = product.vendorId;
    return db.transaction(async (trx) => {
      await trx('Product').insert(await productRow(trx, product));
      if (movements.length) {
        await trx('ShopStockMovement').insert(movements.map(m => ledgerRow({
          productId, vendorId, variant: m.variant, delta: m.delta, reason: 'count', stockAfter: m.stockAfter, note: m.note, actorId, at,
        })));
      }
      await writePrivates(trx, productId, vendorId, privates, at);
      return plain(await trx('Product').where({ id: productId }).first());
    });
  }

  /** privates: [{ variant, costTzs?, reorderLevel? }] — only the keys present are written (null clears). */
  async function writePrivates(q, productId, vendorId, privates, at) {
    for (const p of privates) {
      const set = {};
      if (p.costTzs !== undefined) set.costTzs = p.costTzs;
      if (p.reorderLevel !== undefined) set.reorderLevel = p.reorderLevel;
      if (!Object.keys(set).length) continue;
      await q('ProductPrivate')
        .insert({ productId, variant: p.variant || '', vendorId, ...set, updatedAt: at })
        .onConflict(['productId', 'variant']).merge({ ...set, updatedAt: at });
    }
  }

  /** The vendor's private fields, by product id: Map(productId → Map(variant → row)). */
  async function privatesOf(vendorId, productIds = null) {
    let q = db('ProductPrivate').where({ vendorId });
    if (productIds) q = q.whereIn('productId', productIds);
    const out = new Map();
    for (const row of await q) {
      if (!out.has(row.productId)) out.set(row.productId, new Map());
      out.get(row.productId).set(row.variant, plain(row));
    }
    return out;
  }

  // ── history ────────────────────────────────────────────────────────────────

  const encodeCursor = row => Buffer.from(JSON.stringify([new Date(row.createdAt).toISOString(), row.id])).toString('base64url');
  function decodeCursor(cursor) {
    try {
      const [t, id] = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
      if (typeof id !== 'string' || Number.isNaN(+new Date(t))) return null;
      return { t: new Date(t), id };
    } catch { return null; }
  }

  /**
   * One product's stock history, newest first. from/to are instants (to exclusive), either may be null.
   * openingStock / closingStock are the count at the start and end of the period, worked back from the
   * current count through the ledger.
   */
  async function movements({ vendorId, productId, variant = null, from = null, to = null, limit = 50, cursor = null }) {
    const product = plain(await db('Product').where({ id: productId }).first());
    if (!product || product.deletedAt) return fail('product_not_found', 404);
    if (product.vendorId !== vendorId) return fail('not_your_product', 403);
    let current = Number(product.stock || 0);
    if (variant) {
      const v = variantsOf(product).find(x => x.name === variant && isTracked(x));
      if (!v) return fail('variant_not_found', 404);
      current = v.stock;
    }
    let after = null;
    if (cursor) {
      after = decodeCursor(cursor);
      if (!after) return fail('invalid_cursor', 400);
    }
    const scope = (q) => {
      q.where('m.productId', productId);
      if (variant) q.where('m.variant', variant);
      return q;
    };
    const sum = async (apply) => Number((await apply(scope(db('ShopStockMovement as m'))).sum({ s: 'm.delta' }).first())?.s || 0);
    const laterThanPeriod = to ? await sum(q => q.where('m.createdAt', '>=', to)) : 0;
    const closingStock = current - laterThanPeriod;
    const inPeriod = await sum((q) => {
      if (from) q.where('m.createdAt', '>=', from);
      if (to) q.where('m.createdAt', '<', to);
      return q;
    });
    let q = scope(db('ShopStockMovement as m').leftJoin('User as u', 'u.id', 'm.actorId').select('m.*', 'u.displayName as actorName'));
    if (from) q = q.where('m.createdAt', '>=', from);
    if (to) q = q.where('m.createdAt', '<', to);
    if (after) q = q.where(w => w.where('m.createdAt', '<', after.t).orWhere(x => x.where('m.createdAt', '=', after.t).andWhere('m.id', '<', after.id)));
    const rows = await q.orderBy([{ column: 'm.createdAt', order: 'desc' }, { column: 'm.id', order: 'desc' }]).limit(limit + 1);
    const page = rows.slice(0, limit);
    return {
      productId, variant, openingStock: closingStock - inPeriod, closingStock,
      rows: page.map(r => movementView(r)),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
    };
  }

  // ── low stock ──────────────────────────────────────────────────────────────

  /** The units of a product that are counted for low stock: each tracked variant, else the product itself. */
  function unitsOf(product, privates) {
    const own = privates?.get('') || null;
    const tracked = variantsOf(product).filter(isTracked);
    if (tracked.length) {
      return tracked.map(v => ({ variant: v.name, stock: v.stock, reorderLevel: effectiveLevel(privates?.get(v.name)?.reorderLevel, own?.reorderLevel) }));
    }
    return [{ variant: '', stock: Number(product.stock || 0), reorderLevel: own?.reorderLevel ?? null }];
  }

  /** GET /vendor/stock/low: every unit at or below its reorder level. */
  async function lowStock(vendorId) {
    const products = await db('Product').where({ vendorId }).whereNull('deletedAt').whereNot('status', 'archived').select('id', 'name', 'stock', 'variants');
    const privates = await privatesOf(vendorId);
    const out = [];
    for (const p of products) {
      for (const unit of unitsOf(p, privates.get(p.id))) {
        if (unit.reorderLevel != null && unit.stock <= unit.reorderLevel) {
          out.push({ productId: p.id, name: p.name, variant: unit.variant || null, stock: unit.stock, reorderLevel: unit.reorderLevel });
        }
      }
    }
    return out.sort((a, b) => String(a.name).localeCompare(String(b.name)) || String(a.variant || '').localeCompare(String(b.variant || '')));
  }

  /**
   * After stock moved: which units of this product just became low (to notify, once per crossing)?
   * A unit that is low is marked (lowStockAlertedAt) with a conditional write, so only one caller
   * reports it; a unit back above its level is unmarked, so the next crossing is reported again.
   */
  async function checkLow(productId) {
    const product = plain(await db('Product').where({ id: productId }).first());
    if (!product || product.deletedAt) return [];
    const privates = (await privatesOf(product.vendorId, [productId])).get(productId);
    const crossed = [];
    const at = now();
    for (const unit of unitsOf(product, privates)) {
      const low = unit.reorderLevel != null && unit.stock <= unit.reorderLevel;
      if (low) {
        const marked = await db.raw(`INSERT INTO "ProductPrivate" ("productId", "variant", "vendorId", "lowStockAlertedAt", "updatedAt")
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT ("productId", "variant") DO UPDATE SET "lowStockAlertedAt" = EXCLUDED."lowStockAlertedAt"
          WHERE "ProductPrivate"."lowStockAlertedAt" IS NULL
          RETURNING "productId"`, [productId, unit.variant, product.vendorId, at, at]);
        if (marked.rows.length) crossed.push({ vendorId: product.vendorId, productId, name: product.name, variant: unit.variant || null, stock: unit.stock, reorderLevel: unit.reorderLevel });
      } else {
        await db('ProductPrivate').where({ productId, variant: unit.variant }).whereNotNull('lowStockAlertedAt').update({ lowStockAlertedAt: null });
      }
    }
    return crossed;
  }

  // ── cost snapshot ──────────────────────────────────────────────────────────

  /** A paid order: keep each line's unit cost as it is now (null when unknown). Safe to repeat. */
  async function snapshotOrderCosts(order) {
    const lines = new Map();
    for (const item of order?.items || []) {
      if (!item?.productId || !(Number(item.qty) > 0)) continue;
      const key = `${item.productId}\u0000${item.variant || ''}`;
      const line = lines.get(key) || { productId: item.productId, variant: item.variant || '', vendorId: item.vendorId || null, qty: 0 };
      line.qty += Number(item.qty);
      lines.set(key, line);
    }
    if (!lines.size) return 0;
    const ids = [...new Set([...lines.values()].map(l => l.productId))];
    const rows = await db('ProductPrivate').whereIn('productId', ids);
    const cost = (productId, variant) => {
      const own = rows.find(r => r.productId === productId && r.variant === variant)?.costTzs;
      const base = rows.find(r => r.productId === productId && r.variant === '')?.costTzs;
      return own ?? base ?? null;
    };
    const at = now();
    const inserted = await db('ShopOrderLineCost')
      .insert([...lines.values()].map(l => ({ orderId: order.id, ...l, unitCostTzs: cost(l.productId, l.variant), createdAt: at })))
      .onConflict(['orderId', 'productId', 'variant']).ignore()
      .returning('orderId');
    return inserted.length;
  }

  return { adjust, applyProductForm, createProduct, privatesOf, movements, lowStock, checkLow, snapshotOrderCosts };
}
