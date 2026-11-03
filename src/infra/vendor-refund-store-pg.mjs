// Postgres store for refunds on walk-in sales (vendor business tools · S7; design spec
// docs/design/vendor-refunds-s7.md §2, approved 2026-11-03). RULE 6 AREA: money records.
//
// A refund is ONE transaction, locks in the order customer → sale → products (the order of S4 customer
// payments: customer → sales, and of the S3 void: sale → products, so there is no deadlock cycle):
//   1. a pay-later sale's customer FOR UPDATE (read the sale's kind first without a lock);
//   2. the sale FOR UPDATE, re-read; a refund already made under this clientRef is answered as a replay;
//   3. its lines FOR UPDATE; amounts computed from the locked ACTIVE counters (M-2 cumulative rounding,
//      M-3 VAT, M-4 balance first then payout) — the client never sends money;
//   4. restocked units go back per product + variant, in the fixed productId\0variant order (stock + q,
//      the variant's own count while it keeps one, else the product's with note variant_gone; ledger row
//      reason refund_restock, kind refund, sourceId = the refund — the ledger's unique index allows one);
//   5. the CN number from the vendor's row-locked credit_note sequence (a rollback gives it back);
//   6. the refund, its lines, the line counters, the sale (refundedTzs, balanceTzs − balanceReduced,
//      balanceReducedTzs +), the audit row.
// Undo is the same shape: customer → refund (must be active) → sale → lines → products; restocked units are
// taken back with the conditional update stock >= q (else 409 insufficient_stock, nothing changes), ledger
// refund_revert, counters and balance reversed exactly, the refund marked reverted (its number is kept).
//
// Nothing here writes ShopOrder, PaymentRequest, commission or settlement rows. Every query is
// vendor-scoped and parameterised.
import { randomUUID } from 'node:crypto';
import { VARIANT_HAS_STOCK, variantStockAdjusted, variantStockOf } from './shop-order-store-pg.mjs';
import { variantsOf, isTracked } from '../shared/vendor-stock.mjs';
import { sellerSnapshotOf } from './vendor-tax-store-pg.mjs';
import { vatSummary } from '../shared/vendor-vat.mjs';
import { CREDIT_NOTE_DOC_TYPE, creditNoteNumber, refundLineAmounts, splitRefund, refundMethod } from '../shared/vendor-refund.mjs';

const UNIQUE_VIOLATION = '23505';
const plain = row => (row ? JSON.parse(JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? Number(v) : v))) : null);
const fail = (error, status, extra = {}) => ({ error, status, ...extra });
/** Thrown inside a transaction so that it rolls back, then returned to the caller. */
const refusal = (error, status, extra = {}) => Object.assign(new Error(error), { refusal: fail(error, status, extra) });
const newId = prefix => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
const iso = v => (v == null ? null : new Date(v).toISOString());
const person = (id, name) => (id ? { id, name: name ?? null } : null);
const keyOf = (productId, variant) => `${productId}\u0000${variant || ''}`;
const json = v => (typeof v === 'string' ? JSON.parse(v) : v);

export function createPgVendorRefundStore({ db, saleStore, now = () => new Date() }) {
  async function namesOf(q, ids) {
    const wanted = [...new Set(ids.filter(Boolean))];
    if (!wanted.length) return new Map();
    const rows = await q('User').whereIn('id', wanted).select('id', 'displayName');
    return new Map(rows.map(r => [r.id, r.displayName ?? null]));
  }

  // ── views ─────────────────────────────────────────────────────────────────

  /** Refund + its lines + the sale facts it needs, as vendors see it (§2.2). Never cost, fingerprint or seq. */
  async function loadRefund(q, where) {
    const refund = plain(await q('VendorSaleRefund').where(where).first());
    if (!refund) return null;
    const [lines, sale] = await Promise.all([
      q('VendorSaleRefundLine as rl').join('VendorSaleLine as l', 'l.id', 'rl.saleLineId')
        .where({ 'rl.refundId': refund.id, 'rl.vendorId': refund.vendorId }).orderBy('l.lineNo')
        .select('rl.saleLineId', 'rl.qty', 'rl.amountTzs', 'rl.vatTzs', 'rl.restock', 'l.productId', 'l.variant', 'l.variantTracked', 'l.nameSnapshot',
          'l.unitPriceTzs', 'l.vatCode', 'l.vatRatePct', 'l.lineNo'),
      q('VendorSale').where({ id: refund.saleId, vendorId: refund.vendorId })
        .first('id', 'number', 'invoiceNumber', 'kind', 'soldAt', 'customerId', 'status', 'createdBy', 'sellerSnapshot'),
    ]);
    const customer = sale?.customerId
      ? await q('VendorCustomer').where({ id: sale.customerId, vendorId: refund.vendorId }).first('id', 'name', 'forgottenAt') : null;
    const names = await namesOf(q, [refund.createdBy, refund.revertedBy]);
    return { refund, lines: lines.map(plain), sale: plain(sale), customer: plain(customer), names };
  }

  function refundView({ refund: r, lines, sale, customer, names }) {
    return {
      id: r.id, number: r.number, status: r.status, saleId: r.saleId, saleNumber: sale?.number ?? null,
      saleInvoiceNumber: sale?.invoiceNumber ?? null, saleKind: sale?.kind ?? null, refundedAt: iso(r.createdAt),
      createdBy: person(r.createdBy, names.get(r.createdBy)),
      reason: r.reason, method: r.method ?? null, reference: r.reference ?? null,
      amountTzs: r.amountTzs, balanceReducedTzs: r.balanceReducedTzs, paidOutTzs: r.paidOutTzs, vatTzs: r.vatTzs,
      vatSummary: vatSummary(lines.filter(l => l.vatCode).map(l => ({ vatCode: l.vatCode, vatRatePct: Number(l.vatRatePct), vatTzs: l.vatTzs, netTzs: l.amountTzs }))).rows,
      customer: customer ? { id: customer.id, name: customer.forgottenAt ? null : customer.name ?? null, forgotten: customer.forgottenAt != null } : null,
      lines: lines.map(l => ({
        saleLineId: l.saleLineId, productId: l.productId, variant: l.variant || null, nameSnapshot: l.nameSnapshot, qty: l.qty,
        unitPriceTzs: l.unitPriceTzs, amountTzs: l.amountTzs, vatTzs: l.vatTzs, vatCode: l.vatCode ?? null, restock: Boolean(l.restock),
      })),
      revertedBy: person(r.revertedBy, names.get(r.revertedBy)), revertedAt: iso(r.revertedAt), revertReason: r.revertReason ?? null,
    };
  }

  async function get(vendorId, refundId) {
    if (typeof refundId !== 'string' || !refundId) return null;
    const found = await loadRefund(db, { id: refundId, vendorId });
    return found ? refundView(found) : null;
  }

  /** Both views after a write, read inside the transaction. */
  async function answer(q, vendorId, refundId, saleId) {
    const [found, sale] = await Promise.all([loadRefund(q, { id: refundId, vendorId }), saleStore.loadSale(q, { id: saleId, vendorId })]);
    return { refund: refundView(found), sale: sale.view };
  }

  /** A refund already made under this clientRef: the same request → it (200); a different one → 409. */
  async function replayOf(q, vendorId, clientRef, fingerprint) {
    const row = await q('VendorSaleRefund').where({ vendorId, clientRef }).first('id', 'saleId', 'fingerprint');
    if (!row) return null;
    if (row.fingerprint !== fingerprint) return fail('client_ref_reused', 409);
    return { ...(await answer(q, vendorId, row.id, row.saleId)), replayed: true, productIds: [] };
  }

  // ── refund ────────────────────────────────────────────────────────────────

  /**
   * Make a refund. `parsed` from parseRefund; `canRefund(saleRow)` → null or a refusal (M2 rule, judged on
   * the locked row). → { refund, sale, replayed, productIds, refundRow } or { error, status, ... }.
   */
  async function refund({ vendorId, saleId, actorId, parsed, fingerprint, canRefund = () => null }) {
    const earlier = await replayOf(db, vendorId, parsed.clientRef, fingerprint);
    if (earlier) return earlier;
    if (typeof saleId !== 'string' || !saleId) return fail('sale_not_found', 404);
    const at = now();
    const refundId = newId('vrf');
    try {
      return await db.transaction(async (trx) => {
        // 1. The customer of a pay-later sale first (as S4 payments: customer → sales).
        const peek = await trx('VendorSale').where({ id: saleId, vendorId }).first('kind', 'customerId');
        if (!peek) throw refusal('sale_not_found', 404);
        if (peek.kind === 'credit' && peek.customerId) {
          await trx('VendorCustomer').where({ id: peek.customerId, vendorId }).forUpdate().first('id');
        }
        // 2. The sale, locked and re-read.
        const sale = plain(await trx('VendorSale').where({ id: saleId, vendorId }).forUpdate().first());
        if (!sale) throw refusal('sale_not_found', 404);
        // Two identical requests at once: the second waited for the sale lock; the first is now committed.
        const raced = await replayOf(trx, vendorId, parsed.clientRef, fingerprint);
        if (raced) return raced;
        const refused = canRefund(sale);
        if (refused) throw Object.assign(new Error(refused.error), { refusal: refused });
        if (sale.status === 'voided') throw refusal('sale_voided', 409, { voidedAt: iso(sale.voidedAt) });

        // 3. Its lines, locked; amounts from the locked counters.
        const lines = (await trx('VendorSaleLine').where({ saleId, vendorId }).orderBy('lineNo').forUpdate()).map(plain);
        const byId = new Map(lines.map(l => [l.id, l]));
        for (const want of parsed.lines) {
          if (!byId.has(want.saleLineId)) throw refusal('line_not_on_sale', 400, { saleLineId: want.saleLineId });
        }
        const over = parsed.lines.map(w => byId.get(w.saleLineId)).filter((l, i) => parsed.lines[i].qty > l.qty - l.refundedQty);
        if (over.length) {
          throw refusal('refund_exceeds_sold', 409, {
            lines: over.map(l => ({ saleLineId: l.id, soldQty: l.qty, refundedQty: l.refundedQty, refundableQty: l.qty - l.refundedQty })),
          });
        }
        const picked = parsed.lines.map((w) => {
          const line = byId.get(w.saleLineId);
          return { ...w, line, ...refundLineAmounts(line, w.qty) };
        });
        const amountTzs = picked.reduce((s, p) => s + p.amountTzs, 0);
        const vatTzs = picked.reduce((s, p) => s + p.vatTzs, 0);
        const { balanceReducedTzs, paidOutTzs } = splitRefund(amountTzs, sale);

        // 7. Method and reference, judged on what is really paid back (M-6).
        const how = refundMethod(parsed, paidOutTzs);
        if (how.error) throw Object.assign(new Error(how.error), { refusal: how });

        // 8 + 9. Restock: per product + variant, in a fixed order; a removed product cannot take units back.
        const groups = new Map();
        for (const p of picked.filter(x => x.restock)) {
          const key = keyOf(p.line.productId, p.line.variant);
          const g = groups.get(key) || { productId: p.line.productId, variant: p.line.variant || '', variantTracked: p.line.variantTracked, qty: 0, saleLineId: p.line.id };
          g.qty += p.qty;
          groups.set(key, g);
        }
        const ordered = [...groups.values()].sort((a, b) => (keyOf(a.productId, a.variant) < keyOf(b.productId, b.variant) ? -1 : 1));
        const locked = new Map();
        for (const g of ordered) {
          const product = plain(await trx('Product').where({ id: g.productId, vendorId }).forUpdate().first());
          if (!product || product.deletedAt) throw refusal('restock_unavailable', 400, { saleLineId: g.saleLineId, productId: g.productId });
          locked.set(g.productId, product);
        }
        for (const g of ordered) {
          const product = locked.get(g.productId);
          // The variant's own count gets its units back while it still keeps one; otherwise the product's (S3 void rule).
          const stillTracked = g.variantTracked && variantsOf(product).some(v => v.name === g.variant && isTracked(v));
          const update = { stock: trx.raw('stock + ?', [g.qty]), updatedAt: at };
          if (stillTracked) update.variants = trx.raw(variantStockAdjusted('+'), [g.variant, g.qty]);
          const rows = await trx('Product').where({ id: g.productId, vendorId }).update(update).returning(['stock', 'variants']);
          const stockAfter = stillTracked ? variantStockOf(rows[0].variants, g.variant) ?? rows[0].stock : rows[0].stock;
          await trx('ShopStockMovement').insert({
            id: `stk_${randomUUID().slice(0, 12)}`, orderId: null, productId: g.productId, variant: g.variant, cycle: 1,
            delta: g.qty, reason: 'refund_restock', kind: 'refund', stockAfter, vendorId,
            note: g.variantTracked && !stillTracked ? 'variant_gone' : null, actorId, clientRef: null, sourceId: refundId, createdAt: at,
          });
        }

        // 6. The CN number, under the sequence row's lock (released at commit; a rollback gives it back).
        const issued = await trx.raw(`INSERT INTO "VendorDocumentSequence" ("vendorId", "docType", "next", "updatedAt")
          VALUES (?, ?, 2, ?)
          ON CONFLICT ("vendorId", "docType") DO UPDATE SET "next" = "VendorDocumentSequence"."next" + 1, "updatedAt" = EXCLUDED."updatedAt"
          RETURNING "next" - 1 AS seq`, [vendorId, CREDIT_NOTE_DOC_TYPE, at]);
        const seq = Number(issued.rows[0].seq);
        const number = creditNoteNumber(seq);
        // Seller details as now (S5 Q-8); TIN/VRN as on the sale, whose VAT this credit note reverses.
        const current = await sellerSnapshotOf(trx, vendorId);
        const ofSale = json(sale.sellerSnapshot) || {};
        const sellerSnapshot = { ...current, tin: ofSale.tin ?? current.tin ?? null, vrn: ofSale.vrn ?? null };

        // 7. The refund and its lines.
        await trx('VendorSaleRefund').insert({
          id: refundId, vendorId, saleId, seq, number, status: 'active', reason: parsed.reason, method: how.method, reference: how.reference,
          amountTzs, balanceReducedTzs, paidOutTzs, vatTzs, clientRef: parsed.clientRef, fingerprint,
          sellerSnapshot: JSON.stringify(sellerSnapshot), createdBy: actorId, createdAt: at, updatedAt: at,
        });
        await trx('VendorSaleRefundLine').insert(picked.map(p => ({
          id: newId('vrl'), refundId, vendorId, saleLineId: p.line.id, qty: p.qty, amountTzs: p.amountTzs, vatTzs: p.vatTzs, restock: p.restock,
        })));

        // 8. Line counters, then the sale (the CHECKs are the last defence against over-refunding).
        for (const p of picked) {
          await trx('VendorSaleLine').where({ id: p.line.id, saleId, vendorId }).update({
            refundedQty: trx.raw('"refundedQty" + ?', [p.qty]), refundedTzs: trx.raw('"refundedTzs" + ?', [p.amountTzs]),
            refundedVatTzs: trx.raw('"refundedVatTzs" + ?', [p.vatTzs]),
          });
        }
        await trx('VendorSale').where({ id: saleId, vendorId, status: 'completed' }).update({
          refundedTzs: trx.raw('"refundedTzs" + ?', [amountTzs]),
          balanceTzs: trx.raw('"balanceTzs" - ?', [balanceReducedTzs]),
          balanceReducedTzs: trx.raw('"balanceReducedTzs" + ?', [balanceReducedTzs]),
          updatedAt: at,
        });
        await trx('AuditLog').insert({
          id: randomUUID(), at, actor: actorId, action: 'vendor_sale_refunded', target: refundId,
          before: JSON.stringify({ saleNumber: sale.number, saleTotalTzs: sale.totalTzs, refundedTzs: sale.refundedTzs, balanceTzs: sale.balanceTzs }),
          after: JSON.stringify({
            number, amountTzs, balanceReducedTzs, paidOutTzs, method: how.method, reference: how.reference,
            lines: picked.map(p => ({ saleLineId: p.line.id, qty: p.qty, restock: p.restock, amountTzs: p.amountTzs })), reason: parsed.reason, vendorId, saleId,
          }),
        });
        return { ...(await answer(trx, vendorId, refundId, saleId)), replayed: false, productIds: ordered.map(g => g.productId) };
      });
    } catch (err) {
      if (err.refusal) return err.refusal;
      // The same clientRef arrived twice at once and the other one won: answer as its replay.
      if (err.code === UNIQUE_VIOLATION && /client_?ref/i.test(`${err.constraint || ''} ${err.message}`)) {
        const replay = await replayOf(db, vendorId, parsed.clientRef, fingerprint);
        if (replay) return replay;
      }
      throw err;
    }
  }

  // ── undo ──────────────────────────────────────────────────────────────────

  /**
   * Undo (revert) an active refund. `canRevert(refundRow)` → null or a refusal (M2 rule on the refund).
   * → { refund, sale, productIds, refundRow } or { error, status, ... }.
   */
  async function revert({ vendorId, refundId, actorId, reason, canRevert = () => null }) {
    if (typeof refundId !== 'string' || !refundId) return fail('refund_not_found', 404);
    const at = now();
    try {
      return await db.transaction(async (trx) => {
        const peek = await trx('VendorSaleRefund as r').join('VendorSale as s', function joinSale() { this.on('s.id', 'r.saleId').andOn('s.vendorId', 'r.vendorId'); })
          .where({ 'r.id': refundId, 'r.vendorId': vendorId }).first('s.kind', 's.customerId');
        if (!peek) throw refusal('refund_not_found', 404);
        // Customer → refund → sale → lines → products.
        const customer = peek.kind === 'credit' && peek.customerId
          ? plain(await trx('VendorCustomer').where({ id: peek.customerId, vendorId }).forUpdate().first('id', 'archivedAt')) : null;
        const row = plain(await trx('VendorSaleRefund').where({ id: refundId, vendorId }).forUpdate().first());
        if (!row) throw refusal('refund_not_found', 404);
        const refused = canRevert(row);
        if (refused) throw Object.assign(new Error(refused.error), { refusal: refused });
        if (row.status === 'reverted') throw refusal('already_reverted', 409, { revertedAt: iso(row.revertedAt) });
        const sale = plain(await trx('VendorSale').where({ id: row.saleId, vendorId }).forUpdate().first());
        if (!sale || sale.status === 'voided') throw refusal('sale_voided', 409, { voidedAt: iso(sale?.voidedAt) });
        // S4 forbids debt on an archived customer: undoing puts the balance part back.
        if (row.balanceReducedTzs > 0 && customer?.archivedAt) throw refusal('customer_archived', 409, { customerId: customer.id });

        const lines = (await trx('VendorSaleRefundLine as rl').join('VendorSaleLine as l', 'l.id', 'rl.saleLineId')
          .where({ 'rl.refundId': refundId, 'rl.vendorId': vendorId }).select('rl.saleLineId', 'rl.qty', 'rl.amountTzs', 'rl.vatTzs', 'rl.restock', 'l.productId', 'l.variant', 'l.variantTracked')).map(plain);
        await trx('VendorSaleLine').whereIn('id', lines.map(l => l.saleLineId)).where({ saleId: row.saleId, vendorId }).orderBy('lineNo').forUpdate().select('id');

        // Where each restocked group's units went: the refund's own ledger row says (variant_gone → the product).
        const restockRows = (await trx('ShopStockMovement').where({ sourceId: refundId, reason: 'refund_restock' }).select('productId', 'variant', 'note')).map(plain);
        const wentToProduct = new Set(restockRows.filter(m => m.note === 'variant_gone').map(m => keyOf(m.productId, m.variant)));
        const groups = new Map();
        for (const l of lines.filter(x => x.restock)) {
          const key = keyOf(l.productId, l.variant);
          const g = groups.get(key) || { productId: l.productId, variant: l.variant || '', lineTracked: Boolean(l.variantTracked), variantTracked: l.variantTracked && !wentToProduct.has(key), qty: 0 };
          g.qty += l.qty;
          groups.set(key, g);
        }
        const ordered = [...groups.values()].sort((a, b) => (keyOf(a.productId, a.variant) < keyOf(b.productId, b.variant) ? -1 : 1));
        for (const g of ordered) {
          const product = plain(await trx('Product').where({ id: g.productId, vendorId }).forUpdate().first());
          if (!product) throw refusal('insufficient_stock', 409, { productId: g.productId, variant: g.variant || null, available: 0 });
          const fromVariant = g.variantTracked && variantsOf(product).some(v => v.name === g.variant && isTracked(v));
          // The conditional update: units sold since are never taken twice (stock never goes negative).
          let query = trx('Product').where({ id: g.productId, vendorId }).where('stock', '>=', g.qty);
          const update = { stock: trx.raw('stock - ?', [g.qty]), updatedAt: at };
          if (fromVariant) {
            query = query.whereRaw(VARIANT_HAS_STOCK, [g.variant, g.qty]);
            update.variants = trx.raw(variantStockAdjusted('-'), [g.variant, g.qty]);
          }
          const rows = await query.update(update).returning(['stock', 'variants']);
          if (!rows.length) {
            const own = fromVariant ? variantStockOf(product.variants, g.variant) ?? 0 : Number(product.stock || 0);
            throw refusal('insufficient_stock', 409, { productId: g.productId, variant: g.variant || null, available: Math.max(0, Math.min(own, Number(product.stock || 0))) });
          }
          const stockAfter = fromVariant ? variantStockOf(rows[0].variants, g.variant) ?? rows[0].stock : rows[0].stock;
          await trx('ShopStockMovement').insert({
            id: `stk_${randomUUID().slice(0, 12)}`, orderId: null, productId: g.productId, variant: g.variant, cycle: 1,
            delta: -g.qty, reason: 'refund_revert', kind: 'refund_revert', stockAfter, vendorId,
            note: g.lineTracked && !fromVariant ? 'variant_gone' : null, actorId, clientRef: null, sourceId: refundId, createdAt: at,
          });
        }

        for (const l of lines) {
          await trx('VendorSaleLine').where({ id: l.saleLineId, saleId: row.saleId, vendorId }).update({
            refundedQty: trx.raw('"refundedQty" - ?', [l.qty]), refundedTzs: trx.raw('"refundedTzs" - ?', [l.amountTzs]),
            refundedVatTzs: trx.raw('"refundedVatTzs" - ?', [l.vatTzs]),
          });
        }
        await trx('VendorSale').where({ id: row.saleId, vendorId, status: 'completed' }).update({
          refundedTzs: trx.raw('"refundedTzs" - ?', [row.amountTzs]),
          balanceTzs: trx.raw('"balanceTzs" + ?', [row.balanceReducedTzs]),
          balanceReducedTzs: trx.raw('"balanceReducedTzs" - ?', [row.balanceReducedTzs]),
          updatedAt: at,
        });
        await trx('VendorSaleRefund').where({ id: refundId, vendorId, status: 'active' })
          .update({ status: 'reverted', revertedBy: actorId, revertedAt: at, revertReason: reason, updatedAt: at });
        await trx('AuditLog').insert({
          id: randomUUID(), at, actor: actorId, action: 'vendor_sale_refund_reverted', target: refundId,
          before: JSON.stringify({ status: 'active', number: row.number, amountTzs: row.amountTzs, balanceReducedTzs: row.balanceReducedTzs, paidOutTzs: row.paidOutTzs, saleId: row.saleId }),
          after: JSON.stringify({ status: 'reverted', reason, vendorId }),
        });
        return { ...(await answer(trx, vendorId, refundId, row.saleId)), productIds: ordered.map(g => g.productId) };
      });
    } catch (err) {
      if (err.refusal) return err.refusal;
      // The ledger's unique (sourceId, productId, variant, 'refund_revert') is the backstop against a double undo.
      if (err.code === UNIQUE_VIOLATION && /source_unique/.test(`${err.constraint || ''} ${err.message}`)) return fail('already_reverted', 409);
      throw err;
    }
  }

  // ── list ──────────────────────────────────────────────────────────────────

  const encodeCursor = row => Buffer.from(JSON.stringify([iso(row.createdAt), row.id])).toString('base64url');
  function decodeCursor(cursor) {
    try {
      const [t, id] = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
      if (typeof id !== 'string' || typeof t !== 'string' || Number.isNaN(Date.parse(t))) return null;
      return { t: new Date(t), id };
    } catch { return null; }
  }

  /** GET /vendor/refunds: newest first (createdAt desc, id desc). from/to are instants (to exclusive). */
  async function list({ vendorId, from = null, to = null, saleId = null, status = null, limit = 50, cursor = null }) {
    let after = null;
    if (cursor) {
      after = decodeCursor(cursor);
      if (!after) return fail('invalid_cursor', 400);
    }
    let q = db('VendorSaleRefund as r').join('VendorSale as s', function joinSale() { this.on('s.id', 'r.saleId').andOn('s.vendorId', 'r.vendorId'); })
      .where('r.vendorId', vendorId);
    if (from) q = q.where('r.createdAt', '>=', from);
    if (to) q = q.where('r.createdAt', '<', to);
    if (saleId) q = q.where('r.saleId', saleId);
    if (status) q = q.where('r.status', status);
    if (after) q = q.whereRaw('(r."createdAt", r.id) < (?::timestamptz, ?)', [after.t, after.id]);
    const rows = (await q.orderBy([{ column: 'r.createdAt', order: 'desc' }, { column: 'r.id', order: 'desc' }]).limit(limit + 1)
      .select('r.id', 'r.number', 'r.status', 'r.createdAt', 'r.revertedAt', 'r.saleId', 's.number as saleNumber', 'r.amountTzs', 'r.paidOutTzs',
        'r.balanceReducedTzs', 'r.method', 'r.createdBy',
        db.raw(`(SELECT COALESCE(sum(rl.qty), 0)::int FROM "VendorSaleRefundLine" rl WHERE rl."refundId" = r.id AND rl.restock) AS "restockedUnits"`))).map(plain);
    const page = rows.slice(0, limit);
    const names = await namesOf(db, page.map(r => r.createdBy));
    return {
      refunds: page.map(r => ({
        id: r.id, number: r.number, status: r.status, refundedAt: iso(r.createdAt), revertedAt: iso(r.revertedAt), saleId: r.saleId, saleNumber: r.saleNumber,
        amountTzs: r.amountTzs, paidOutTzs: r.paidOutTzs, balanceReducedTzs: r.balanceReducedTzs, method: r.method ?? null, restockedUnits: Number(r.restockedUnits || 0),
        createdBy: person(r.createdBy, names.get(r.createdBy)),
      })),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
    };
  }

  // ── document source (S5 credit note) ──────────────────────────────────────

  /** What the credit-note document is built from. null = not this vendor's refund. Never cost, reason or restock to the document. */
  async function refundSource(vendorId, refundId) {
    if (typeof refundId !== 'string' || !refundId) return null;
    const found = await loadRefund(db, { id: refundId, vendorId });
    if (!found) return null;
    const { refund: r, lines, sale, customer, names } = found;
    return {
      refund: { id: r.id, number: r.number, status: r.status, createdAt: r.createdAt, revertedAt: r.revertedAt, amountTzs: r.amountTzs,
        balanceReducedTzs: r.balanceReducedTzs, paidOutTzs: r.paidOutTzs, vatTzs: r.vatTzs, method: r.method, reference: r.reference },
      lines: lines.map(l => ({ nameSnapshot: l.nameSnapshot, variant: l.variant || null, qty: l.qty, amountTzs: l.amountTzs, vatTzs: l.vatTzs,
        vatCode: l.vatCode ?? null, vatRatePct: Number(l.vatRatePct || 0), lineNo: l.lineNo })),
      sale: { number: sale?.number ?? null, invoiceNumber: sale?.invoiceNumber ?? null, kind: sale?.kind ?? null, soldAt: sale?.soldAt ?? null },
      customer: customer && !customer.forgottenAt && customer.name ? { name: customer.name } : null,
      servedByName: names.get(r.createdBy) ?? null,
      seller: json(r.sellerSnapshot) || await sellerSnapshotOf(db, vendorId),
    };
  }

  /** The active refunds of a sale for its own receipt / invoice (§6.3), oldest first. */
  async function activeRefundsOfSale(vendorId, saleId) {
    return (await db('VendorSaleRefund').where({ vendorId, saleId, status: 'active' }).orderBy([{ column: 'seq' }])
      .select('number', 'createdAt', 'amountTzs')).map(plain).map(r => ({ number: r.number, refundedAt: iso(r.createdAt), amountTzs: r.amountTzs }));
  }

  return { refund, revert, get, list, refundSource, activeRefundsOfSale };
}
