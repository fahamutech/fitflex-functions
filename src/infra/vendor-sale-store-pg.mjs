// Postgres store for vendor walk-in sales (vendor business tools · S3).
//
// Recording a sale is ONE transaction: each product row is locked (FOR UPDATE, in a fixed order),
// stock leaves through the same conditional UPDATE app orders use (stock >= qty, and the variant's
// own stock in the same statement), one ledger row per product/variant (reason `sale`, sourceId =
// the sale), the unit cost is snapshotted from ProductPrivate, the receipt number is issued from
// the vendor's row-locked sequence, then the sale, its lines and its payments are written. Any
// refusal rolls everything back — including the number, so numbers stay continuous.
//
// Voiding is ONE transaction too: the sale row is locked, completed → voided, and each
// product/variant gets its units back once (reason `sale_void`; the ledger's unique
// (sourceId, productId, variant, reason) refuses a second row).
//
// Nothing here writes ShopOrder, PaymentRequest, commission or settlement rows.
// Every query is vendor-scoped and parameterised.
import { randomUUID } from 'node:crypto';
import { VARIANT_HAS_STOCK, variantStockAdjusted, variantStockOf } from './shop-order-store-pg.mjs';
import { variantsOf, isTracked } from '../shared/vendor-stock.mjs';
import { walkInPrice, priceSale, receiptNumber, RECEIPT_DOC_TYPE, PAYMENT_METHODS, LATE_RECORDED_MS } from '../shared/vendor-sale.mjs';

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const plain = row => (row ? JSON.parse(JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? Number(v) : v))) : null);
const fail = (error, status, extra = {}) => ({ error, status, ...extra });
/** Thrown inside a transaction so that it rolls back, then returned to the caller. */
const refusal = (error, status, extra = {}) => Object.assign(new Error(error), { refusal: fail(error, status, extra) });
const newId = prefix => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
const iso = v => (v == null ? null : new Date(v).toISOString());
const person = (id, name) => (id ? { id, name: name ?? null } : null);
const keyOf = (productId, variant) => `${productId}\u0000${variant || ''}`;
/** Reached FitFlex more than 5 minutes after it was made (security review L4). */
const lateRecorded = s => +new Date(s.createdAt) - +new Date(s.soldAt) > LATE_RECORDED_MS;

export function createPgVendorSaleStore({ db, now = () => new Date() }) {
  // ── views ─────────────────────────────────────────────────────────────────

  async function namesOf(q, ids) {
    const wanted = [...new Set(ids.filter(Boolean))];
    if (!wanted.length) return new Map();
    const rows = await q('User').whereIn('id', wanted).select('id', 'displayName');
    return new Map(rows.map(r => [r.id, r.displayName ?? null]));
  }

  /** The sale as vendors see it. Never the unit cost (S6), never internals (fingerprint, seq). */
  function saleView(sale, lines, payments, names) {
    const s = plain(sale);
    return {
      id: s.id, number: s.number, status: s.status, kind: s.kind,
      soldAt: iso(s.soldAt), recordedAt: iso(s.createdAt), lateRecorded: lateRecorded(s), clientRef: s.clientRef,
      subtotalTzs: s.subtotalTzs, lineDiscountTzs: s.lineDiscountTzs, discountTzs: s.discountTzs,
      totalTzs: s.totalTzs, paidTzs: s.paidTzs, changeTzs: s.changeTzs,
      note: s.note ?? null,
      createdBy: person(s.createdBy, names.get(s.createdBy)),
      voidedBy: person(s.voidedBy, names.get(s.voidedBy)), voidedAt: iso(s.voidedAt), voidReason: s.voidReason ?? null,
      lines: lines.map(plain).sort((a, b) => a.lineNo - b.lineNo).map(l => ({
        id: l.id, productId: l.productId, variant: l.variant || null, nameSnapshot: l.nameSnapshot, qty: l.qty,
        listPriceTzs: l.listPriceTzs, unitPriceTzs: l.unitPriceTzs, priceChanged: l.unitPriceTzs !== l.listPriceTzs,
        priceChangedBy: person(l.priceChangedBy, names.get(l.priceChangedBy)),
        discountTzs: l.discountTzs, lineTotalTzs: l.lineTotalTzs,
      })),
      payments: payments.map(plain).sort((a, b) => a.position - b.position).map(p => ({
        method: p.method, amountTzs: p.amountTzs, reference: p.reference ?? null,
      })),
    };
  }

  async function load(q, where) {
    const sale = await q('VendorSale').where(where).first();
    if (!sale) return null;
    const [lines, payments] = await Promise.all([
      q('VendorSaleLine').where({ saleId: sale.id }),
      q('VendorSalePayment').where({ saleId: sale.id }),
    ]);
    const names = await namesOf(q, [sale.createdBy, sale.voidedBy, ...lines.map(l => l.priceChangedBy)]);
    return { row: plain(sale), view: saleView(sale, lines, payments, names), lines: lines.map(plain) };
  }

  /** A sale of this vendor by id; another vendor's sale is not found. */
  async function get(vendorId, saleId) {
    if (typeof saleId !== 'string' || !saleId) return null;
    return (await load(db, { id: saleId, vendorId }))?.view ?? null;
  }

  /** A sale already recorded under this clientRef: the same request → it; a different one → 409. */
  async function replayOf(vendorId, clientRef, fingerprint) {
    const found = await load(db, { vendorId, clientRef });
    if (!found) return null;
    if (found.row.fingerprint !== fingerprint) return fail('client_ref_reused', 409);
    return { sale: found.view, replayed: true, productIds: [] };
  }

  // ── record ────────────────────────────────────────────────────────────────

  /** Check one line against its (locked) product. → { listPriceTzs, name, variantTracked } or throws a refusal. */
  function checkLine(product, line) {
    if (!product || product.deletedAt) throw refusal('product_not_found', 404, { productId: line.productId });
    if (product.status === 'archived') throw refusal('product_unavailable', 400, { productId: line.productId });
    const variants = variantsOf(product);
    const tracked = variants.filter(isTracked);
    let variantTracked = false;
    if (line.variant) {
      const found = variants.find(v => v.name === line.variant);
      if (!found) throw refusal('variant_not_found', 404, { productId: line.productId, variant: line.variant, variants: variants.map(v => v.name) });
      variantTracked = isTracked(found);
    } else if (tracked.length) {
      throw refusal('variant_required', 400, { productId: line.productId, variants: tracked.map(v => v.name) });
    }
    return { listPriceTzs: walkInPrice(product), name: String(product.name || ''), variantTracked };
  }

  /**
   * Record a sale. `sale` comes from parseSale (+ soldAt resolved). → { sale, replayed, productIds } or { error, status, ... }.
   * insufficient_stock { productId, variant, available } when the units are not there (nothing is written).
   */
  async function record({ vendorId, actorId, sale, fingerprint }) {
    const earlier = await replayOf(vendorId, sale.clientRef, fingerprint);
    if (earlier) return earlier;
    const at = now();
    const saleId = newId('sal');
    try {
      return await db.transaction(async (trx) => {
        // Lock every product once, in id order (app orders take rows in the same order).
        const productIds = [...new Set(sale.lines.map(l => l.productId))].sort();
        const products = new Map();
        for (const id of productIds) {
          // Only this vendor's row is locked; another vendor's product is "not found" (L3).
          products.set(id, plain(await trx('Product').where({ id, vendorId }).forUpdate().first()) || null);
        }
        const priced = sale.lines.map((line) => {
          const facts = checkLine(products.get(line.productId), line);
          return { ...line, ...facts };
        });
        const totals = priceSale(priced, sale.discountTzs, sale.payments);
        if (totals.error) throw Object.assign(new Error(totals.error), { refusal: totals });

        // Units per product/variant, taken in a fixed order.
        const groups = new Map();
        for (const l of totals.lines) {
          const key = keyOf(l.productId, l.variant);
          const g = groups.get(key) || { productId: l.productId, variant: l.variant || null, variantTracked: l.variantTracked, qty: 0 };
          g.qty += l.qty;
          groups.set(key, g);
        }
        const ordered = [...groups.values()].sort((a, b) => (keyOf(a.productId, a.variant) < keyOf(b.productId, b.variant) ? -1 : 1));
        for (const g of ordered) {
          // The same conditional update as an app order's reservation: the database refuses an oversell.
          let query = trx('Product').where({ id: g.productId, vendorId }).whereNull('deletedAt').where('stock', '>=', g.qty);
          const update = { stock: trx.raw('stock - ?', [g.qty]), updatedAt: at };
          if (g.variantTracked) {
            query = query.whereRaw(VARIANT_HAS_STOCK, [g.variant, g.qty]);
            update.variants = trx.raw(variantStockAdjusted('-'), [g.variant, g.qty]);
          }
          const rows = await query.update(update).returning(['stock', 'variants']);
          if (!rows.length) {
            const current = plain(await trx('Product').where({ id: g.productId }).first());
            const productStock = Number(current?.stock || 0);
            const own = g.variantTracked ? variantStockOf(current?.variants, g.variant) ?? 0 : productStock;
            throw refusal('insufficient_stock', 409, { productId: g.productId, variant: g.variant, available: Math.max(0, Math.min(own, productStock)) });
          }
          const stockAfter = g.variantTracked ? variantStockOf(rows[0].variants, g.variant) ?? rows[0].stock : rows[0].stock;
          await trx('ShopStockMovement').insert({
            id: `stk_${randomUUID().slice(0, 12)}`, orderId: null, productId: g.productId, variant: g.variant || '', cycle: 1,
            delta: -g.qty, reason: 'sale', kind: 'sale', stockAfter, vendorId, note: null, actorId, clientRef: null, sourceId: saleId, createdAt: at,
          });
        }

        // Unit cost as it is now: the variant's own, else the product's; null when not known.
        const privates = await trx('ProductPrivate').where({ vendorId }).whereIn('productId', productIds);
        const costOf = (productId, variant) => {
          const own = privates.find(r => r.productId === productId && r.variant === (variant || ''))?.costTzs;
          const base = privates.find(r => r.productId === productId && r.variant === '')?.costTzs;
          return own ?? base ?? null;
        };

        // The next receipt number, under the sequence row's lock (released at commit; a rollback gives it back).
        const issued = await trx.raw(`INSERT INTO "VendorDocumentSequence" ("vendorId", "docType", "next", "updatedAt")
          VALUES (?, ?, 2, ?)
          ON CONFLICT ("vendorId", "docType") DO UPDATE SET "next" = "VendorDocumentSequence"."next" + 1, "updatedAt" = EXCLUDED."updatedAt"
          RETURNING "next" - 1 AS seq`, [vendorId, RECEIPT_DOC_TYPE, at]);
        const seq = Number(issued.rows[0].seq);

        await trx('VendorSale').insert({
          id: saleId, vendorId, seq, number: receiptNumber(seq), kind: 'cash', status: 'completed', customerId: null,
          soldAt: sale.soldAt, subtotalTzs: totals.subtotalTzs, lineDiscountTzs: totals.lineDiscountTzs, discountTzs: totals.discountTzs,
          vatTzs: 0, totalTzs: totals.totalTzs, paidTzs: totals.paidTzs, changeTzs: totals.changeTzs, balanceTzs: 0,
          clientRef: sale.clientRef, fingerprint, note: sale.note, createdBy: actorId, createdAt: at, updatedAt: at,
        });
        await trx('VendorSaleLine').insert(totals.lines.map((l, i) => ({
          id: newId('sln'), saleId, vendorId, lineNo: i + 1, productId: l.productId, variant: l.variant || '', variantTracked: l.variantTracked,
          nameSnapshot: l.name, qty: l.qty, listPriceTzs: l.listPriceTzs, unitPriceTzs: l.unitPriceTzs, discountTzs: l.discountTzs,
          saleDiscountShareTzs: l.saleDiscountShareTzs, lineTotalTzs: l.lineTotalTzs, unitCostTzs: costOf(l.productId, l.variant),
          priceChangedBy: l.unitPriceTzs !== l.listPriceTzs ? actorId : null, discountBy: l.discountTzs > 0 ? actorId : null, createdAt: at,
        })));
        if (sale.payments.length) {
          await trx('VendorSalePayment').insert(sale.payments.map((p, i) => ({
            id: newId('spm'), saleId, vendorId, position: i + 1, method: p.method, amountTzs: p.amountTzs, reference: p.reference,
            paidAt: sale.soldAt, recordedBy: actorId, createdAt: at,
          })));
        }

        // O-14: price changes and discounts need no approval, but they are on the record.
        const changed = totals.lines.filter(l => l.unitPriceTzs !== l.listPriceTzs || l.discountTzs > 0);
        if (changed.length || totals.discountTzs > 0) {
          await trx('AuditLog').insert({
            id: randomUUID(), at, actor: actorId, action: 'vendor_sale_price_override', target: saleId,
            before: JSON.stringify(changed.map(l => ({ productId: l.productId, variant: l.variant || null, listPriceTzs: l.listPriceTzs }))),
            after: JSON.stringify({
              vendorId, number: receiptNumber(seq),
              lines: changed.map(l => ({ productId: l.productId, variant: l.variant || null, qty: l.qty, unitPriceTzs: l.unitPriceTzs, discountTzs: l.discountTzs })),
              saleDiscountTzs: totals.discountTzs,
            }),
          });
        }
        const saved = await load(trx, { id: saleId });
        return { sale: saved.view, replayed: false, productIds };
      });
    } catch (err) {
      if (err.refusal) return err.refusal;
      // The same clientRef arrived twice at once: the other request won, this one rolled back whole.
      if (err.code === UNIQUE_VIOLATION && /client_?ref/i.test(`${err.constraint || ''} ${err.message}`)) {
        const replay = await replayOf(vendorId, sale.clientRef, fingerprint);
        if (replay) return replay;
      }
      if (err.code === CHECK_VIOLATION && /product_stock_non_negative/.test(err.constraint || err.message)) return fail('insufficient_stock', 409);
      throw err;
    }
  }

  // ── void ──────────────────────────────────────────────────────────────────

  /**
   * Void a completed sale: its units go back to stock once. `canVoid(sale)` → null or a refusal, judged on
   * the locked row (M2: who may void which sale). → { sale, productIds } or { error, status }.
   */
  async function voidSale({ vendorId, saleId, actorId, reason, canVoid = () => null }) {
    if (typeof saleId !== 'string' || !saleId) return fail('sale_not_found', 404);
    try {
      return await db.transaction(async (trx) => {
        const sale = plain(await trx('VendorSale').where({ id: saleId, vendorId }).forUpdate().first());
        if (!sale) throw refusal('sale_not_found', 404);
        const refused = canVoid(sale);
        if (refused) throw Object.assign(new Error(refused.error), { refusal: refused });
        if (sale.status === 'voided') throw refusal('already_voided', 409, { voidedAt: iso(sale.voidedAt) });
        const at = now();
        const lines = await trx('VendorSaleLine').where({ saleId });
        const groups = new Map();
        for (const l of lines) {
          const key = keyOf(l.productId, l.variant);
          const g = groups.get(key) || { productId: l.productId, variant: l.variant || '', variantTracked: l.variantTracked, qty: 0 };
          g.qty += Number(l.qty);
          groups.set(key, g);
        }
        const ordered = [...groups.values()].sort((a, b) => (keyOf(a.productId, a.variant) < keyOf(b.productId, b.variant) ? -1 : 1));
        for (const g of ordered) {
          const product = plain(await trx('Product').where({ id: g.productId, vendorId }).forUpdate().first());
          if (!product) {
            // Never expected (products are soft-deleted and keep their vendor); the units cannot go back.
            console.warn('[vendor-sales] void: product not found for restock', { saleId, productId: g.productId });
            continue;
          }
          // The variant's own count gets its units back while it still keeps one; otherwise the product's.
          const stillTracked = g.variantTracked && variantsOf(product).some(v => v.name === g.variant && isTracked(v));
          const update = { stock: trx.raw('stock + ?', [g.qty]), updatedAt: at };
          if (stillTracked) update.variants = trx.raw(variantStockAdjusted('+'), [g.variant, g.qty]);
          const rows = await trx('Product').where({ id: g.productId, vendorId }).update(update).returning(['stock', 'variants']);
          const stockAfter = stillTracked ? variantStockOf(rows[0].variants, g.variant) ?? rows[0].stock : rows[0].stock;
          // Unique (sourceId, productId, variant, reason): a second give-back of this sale cannot be written.
          await trx('ShopStockMovement').insert({
            id: `stk_${randomUUID().slice(0, 12)}`, orderId: null, productId: g.productId, variant: g.variant, cycle: 1,
            delta: g.qty, reason: 'sale_void', kind: 'sale_void', stockAfter, vendorId: product.vendorId,
            note: g.variantTracked && !stillTracked ? 'variant_gone' : null, actorId, clientRef: null, sourceId: saleId, createdAt: at,
          });
        }
        await trx('VendorSale').where({ id: saleId, status: 'completed' })
          .update({ status: 'voided', voidedBy: actorId, voidedAt: at, voidReason: reason, updatedAt: at });
        await trx('AuditLog').insert({
          id: randomUUID(), at, actor: actorId, action: 'vendor_sale_voided', target: saleId,
          before: JSON.stringify({ status: 'completed', number: sale.number, totalTzs: sale.totalTzs }),
          after: JSON.stringify({ status: 'voided', vendorId, reason }),
        });
        const saved = await load(trx, { id: saleId });
        return { sale: saved.view, productIds: ordered.map(g => g.productId), voided: sale };
      });
    } catch (err) {
      if (err.refusal) return err.refusal;
      if (err.code === UNIQUE_VIOLATION && /source_unique/.test(`${err.constraint || ''} ${err.message}`)) return fail('already_voided', 409);
      throw err;
    }
  }

  // ── history ───────────────────────────────────────────────────────────────

  const encodeCursor = row => Buffer.from(JSON.stringify([iso(row.soldAt), row.id])).toString('base64url');
  function decodeCursor(cursor) {
    try {
      const [t, id] = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
      if (typeof id !== 'string' || typeof t !== 'string' || Number.isNaN(Date.parse(t))) return null;
      return { t: new Date(t), id };
    } catch { return null; }
  }

  /**
   * GET /vendor/sales: newest sale first (soldAt desc, id desc), one page, plus the summary of the
   * whole range (completed sales; status filter not applied to it). from/to are instants (to exclusive).
   */
  async function list({ vendorId, from = null, to = null, status = null, createdBy = null, limit = 50, cursor = null }) {
    let after = null;
    if (cursor) {
      after = decodeCursor(cursor);
      if (!after) return fail('invalid_cursor', 400);
    }
    const scope = (q, alias = 'VendorSale') => {
      q.where(`${alias}.vendorId`, vendorId);
      if (from) q.where(`${alias}.soldAt`, '>=', from);
      if (to) q.where(`${alias}.soldAt`, '<', to);
      if (createdBy) q.where(`${alias}.createdBy`, createdBy);
      return q;
    };
    let q = scope(db('VendorSale'));
    if (status) q = q.where('VendorSale.status', status);
    if (after) q = q.whereRaw('("VendorSale"."soldAt", "VendorSale"."id") < (?::timestamptz, ?)', [after.t, after.id]);
    const rows = (await q.orderBy([{ column: 'soldAt', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(limit + 1)).map(plain);
    const page = rows.slice(0, limit);
    const ids = page.map(r => r.id);

    const [items, overridden, pays, names] = await Promise.all([
      ids.length ? db('VendorSaleLine').whereIn('saleId', ids).groupBy('saleId').select('saleId').sum({ n: 'qty' }) : [],
      ids.length ? db('VendorSaleLine').whereIn('saleId', ids).whereRaw('"unitPriceTzs" <> "listPriceTzs"').distinct('saleId') : [],
      ids.length ? db('VendorSalePayment').whereIn('saleId', ids).orderBy(['saleId', 'position']).select('saleId', 'method') : [],
      namesOf(db, page.map(r => r.createdBy)),
    ]);
    const itemCount = new Map(items.map(r => [r.saleId, Number(r.n)]));
    const withOverride = new Set(overridden.map(r => r.saleId));
    const methods = new Map();
    for (const p of pays) {
      const m = methods.get(p.saleId) || [];
      if (!m.includes(p.method)) m.push(p.method);
      methods.set(p.saleId, m);
    }

    const totals = await scope(db('VendorSale')).first(
      db.raw(`count(*) FILTER (WHERE status = 'completed')::int AS count`),
      db.raw(`COALESCE(sum("totalTzs") FILTER (WHERE status = 'completed'), 0)::bigint AS "totalTzs"`),
      db.raw(`COALESCE(sum("changeTzs") FILTER (WHERE status = 'completed'), 0)::bigint AS "changeTzs"`),
      db.raw(`count(*) FILTER (WHERE status = 'voided')::int AS "voidedCount"`),
      db.raw(`COALESCE(sum("lineDiscountTzs" + "discountTzs") FILTER (WHERE status = 'completed'), 0)::bigint AS "discountTzs"`),
      db.raw(`count(*) FILTER (WHERE status = 'completed' AND EXISTS (SELECT 1 FROM "VendorSaleLine" l
        WHERE l."saleId" = "VendorSale".id AND l."unitPriceTzs" <> l."listPriceTzs"))::int AS "overrideCount"`),
      db.raw(`count(*) FILTER (WHERE "createdAt" - "soldAt" > make_interval(secs => ?))::int AS "lateCount"`, [LATE_RECORDED_MS / 1000]),
    );
    const byMethodRows = await scope(db('VendorSalePayment as p').join('VendorSale as s', 's.id', 'p.saleId'), 's')
      .where('s.status', 'completed').groupBy('p.method').select('p.method').sum({ amount: 'p.amountTzs' });
    const amounts = new Map(byMethodRows.map(r => [r.method, Number(r.amount)]));
    // Cash is shown net of the change given back, so the methods add up to the total.
    if (amounts.has('cash')) amounts.set('cash', amounts.get('cash') - Number(totals.changeTzs));
    const byMethod = PAYMENT_METHODS.filter(m => amounts.has(m)).map(m => ({ method: m, amountTzs: amounts.get(m) }));

    return {
      sales: page.map(r => ({
        id: r.id, number: r.number, soldAt: iso(r.soldAt), recordedAt: iso(r.createdAt), status: r.status,
        totalTzs: r.totalTzs, discountTzs: r.lineDiscountTzs + r.discountTzs, hasOverride: withOverride.has(r.id), lateRecorded: lateRecorded(r),
        itemCount: itemCount.get(r.id) || 0, methods: methods.get(r.id) || [],
        createdBy: person(r.createdBy, names.get(r.createdBy)),
      })),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
      summary: {
        count: Number(totals.count), totalTzs: Number(totals.totalTzs), voidedCount: Number(totals.voidedCount),
        discountTzs: Number(totals.discountTzs), overrideCount: Number(totals.overrideCount), lateCount: Number(totals.lateCount), byMethod,
      },
    };
  }

  return { record, replayOf, get, list, voidSale };
}
