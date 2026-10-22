// Postgres store for vendor documents (vendor business tools · S5): share links (hash only), the
// sources a document is built from (walk-in sale, customer payment, statement, a vendor's part of a
// paid app order) and the per-vendor order invoices (INV numbers + VAT snapshot at payment time).
//
// Every query is vendor-scoped and parameterised. Sources return only what the document allowlist
// (src/shared/vendor-documents.mjs) may use: never a customer's phone, email or address, buyerUserId,
// cost, commission, payout, internal note or void reason.
import { randomUUID } from 'node:crypto';
import { dayOf } from './vendor-sale-store-pg.mjs';
import { vatForSale, sellerSnapshotOf } from './vendor-tax-store-pg.mjs';
import { ownLines } from '../shared/vendor-order-view.mjs';
import { INVOICE_DOC_TYPE, invoiceNumber } from '../shared/vendor-documents.mjs';
import { addDays, STATEMENT_PAYMENT_DAYS } from '../shared/vendor-customer.mjs';

const UNIQUE_VIOLATION = '23505';
const PAID_STATES = ['paid', 'refund_pending', 'refunded'];
const plain = row => (row ? JSON.parse(JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? Number(v) : v))) : null);
const iso = v => (v == null ? null : new Date(v).toISOString());
const json = v => (typeof v === 'string' ? JSON.parse(v) : v);
const newId = prefix => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

/** The vendor's part of an order is cancelled: the order, or its money owed back / refunded, or the vendor's own part. */
export function orderCancelledFor(order, vendorId) {
  if (order.status === 'cancelled' || ['refund_pending', 'refunded'].includes(order.paymentStatus)) return true;
  const own = (Array.isArray(json(order.fulfilments)) ? json(order.fulfilments) : []).find(f => f?.vendorId === vendorId);
  return own?.status === 'cancelled';
}
const cancelledAtOf = (order) => {
  const entries = Array.isArray(json(order.timeline)) ? json(order.timeline) : [];
  return [...entries].reverse().find(e => e?.status === 'cancelled')?.at ?? order.updatedAt ?? null;
};

export function createPgVendorDocumentStore({ db, customerStore, vatOn = () => false, now = () => new Date() }) {
  async function namesOf(q, ids) {
    const wanted = [...new Set(ids.filter(Boolean))];
    if (!wanted.length) return new Map();
    const rows = await q('User').whereIn('id', wanted).select('id', 'displayName');
    return new Map(rows.map(r => [r.id, r.displayName ?? null]));
  }
  const customerName = async (q, vendorId, customerId) => {
    if (!customerId) return null;
    const c = await q('VendorCustomer').where({ id: customerId, vendorId }).first('name', 'forgottenAt');
    return c && !c.forgottenAt ? { name: c.name ?? null } : null;
  };
  const vendorExists = async vendorId => Boolean(await db('User').where({ id: vendorId, userType: 'vendor' }).first('id'));

  // ── sources ───────────────────────────────────────────────────────────────

  /** A walk-in sale of this vendor (cash receipt or credit invoice). null = not this vendor's. */
  async function saleSource(vendorId, saleId) {
    if (typeof saleId !== 'string' || !saleId) return null;
    const sale = plain(await db('VendorSale').where({ id: saleId, vendorId }).first());
    if (!sale) return null;
    const [lines, payments, allocations, customer] = await Promise.all([
      db('VendorSaleLine').where({ saleId, vendorId }).select('lineNo', 'productId', 'variant', 'nameSnapshot', 'qty', 'unitPriceTzs', 'discountTzs', 'lineTotalTzs', 'saleDiscountShareTzs', 'vatCode', 'vatRatePct', 'vatTzs'),
      db('VendorSalePayment').where({ saleId, vendorId }).select('position', 'method', 'amountTzs', 'reference'),
      db('VendorPaymentAllocation as a').join('VendorCustomerPayment as p', function joinPayment() { this.on('p.id', 'a.paymentId').andOn('p.vendorId', 'a.vendorId'); })
        .where({ 'a.saleId': saleId, 'a.vendorId': vendorId }).orderBy('p.seq').select('p.number', 'a.amountTzs', 'p.receivedOn', 'a.voidedAt'),
      customerName(db, vendorId, sale.customerId),
    ]);
    const names = await namesOf(db, [sale.createdBy]);
    return {
      sale: { ...sale, dueDate: dayOf(sale.dueDate) },
      lines: lines.map(plain), payments: payments.map(plain),
      allocations: allocations.map(plain).map(a => ({ number: a.number, amountTzs: a.amountTzs, receivedOn: dayOf(a.receivedOn), voided: a.voidedAt != null })),
      customer, servedByName: names.get(sale.createdBy) ?? null,
      seller: json(sale.sellerSnapshot) || await sellerSnapshotOf(db, vendorId),
    };
  }

  /** A customer payment of this vendor (PMT receipt). null = not this vendor's. */
  async function paymentSource(vendorId, paymentId) {
    if (typeof paymentId !== 'string' || !paymentId) return null;
    const payment = plain(await db('VendorCustomerPayment').where({ id: paymentId, vendorId }).first());
    if (!payment) return null;
    const allocations = (await db('VendorPaymentAllocation as a').join('VendorSale as s', function joinSale() { this.on('s.id', 'a.saleId').andOn('s.vendorId', 'a.vendorId'); })
      .where({ 'a.paymentId': paymentId, 'a.vendorId': vendorId }).orderBy('a.position')
      .select('a.saleId', 'a.amountTzs', 's.number', 's.invoiceNumber', 's.balanceTzs', 's.status')).map(plain);
    const names = await namesOf(db, [payment.recordedBy]);
    return {
      payment: { ...payment, receivedOn: dayOf(payment.receivedOn) },
      customer: await customerName(db, vendorId, payment.customerId),
      receivedByName: names.get(payment.recordedBy) ?? null,
      allocations: allocations.map(a => ({ saleId: a.saleId, number: a.invoiceNumber || a.number, amountTzs: a.amountTzs })),
      // "Still owed" on the sales this payment paid towards, now (never the customer's other debts).
      stillOwedTzs: allocations.filter(a => a.status === 'completed').reduce((s, a) => s + a.balanceTzs, 0),
      seller: json(payment.sellerSnapshot) || await sellerSnapshotOf(db, vendorId),
      customerId: payment.customerId,
    };
  }

  /** The statement of a customer as of now (live; a share freezes it into the link). null = not this vendor's. */
  async function statementSource(vendorId, customerId, today) {
    const p = await customerStore.profile(vendorId, customerId, today);
    if (!p) return null;
    const pays = await customerStore.listPayments({ vendorId, customerId, from: addDays(today, -STATEMENT_PAYMENT_DAYS), limit: 200, beforeSeq: null });
    return {
      asOf: now(), today,
      customer: p.customer.forgottenAt ? { name: null } : { name: p.customer.name ?? null },
      openSales: p.openSales,
      payments: pays.payments.filter(x => x.status === 'recorded'),
      owedTzs: p.money.owedTzs,
      aging: p.money.aging,
      seller: await sellerSnapshotOf(db, vendorId),
    };
  }

  // ── order invoices ────────────────────────────────────────────────────────

  /**
   * Issue the vendor's invoice for a paid order, once (unique orderId + vendorId): the next INV number of
   * the vendor's series, the vendor's own lines with their VAT snapshot (when VAT applies now) and the
   * seller snapshot. `late` = issued after the fact (an order paid before S5, or a hook that failed): no
   * VAT is worked out for it. A concurrent second issue rolls back whole, giving its number back.
   * → { invoice, issued } | null (no line of this vendor's, or the order is not paid).
   */
  async function issueOrderInvoice(order, vendorId, { late = false } = {}) {
    const items = Array.isArray(json(order?.items)) ? json(order.items) : [];
    const mine = ownLines({ items }, vendorId);
    if (!mine.length || !PAID_STATES.includes(order.paymentStatus)) return null;
    const existing = await db('VendorOrderInvoice').where({ orderId: order.id, vendorId }).first();
    if (existing) return { invoice: plain(existing), issued: false };
    const at = now();
    try {
      return await db.transaction(async (trx) => {
        const base = mine.map(l => ({ productId: l.productId, netTzs: Number(l.priceTzs) * Number(l.qty) }));
        const vat = await vatForSale(trx, { vendorId, at, lines: base, vatOn: !late && vatOn() });
        const lines = mine.map((l, i) => ({
          productId: l.productId, variant: l.variant || null, name: String(l.name || ''), qty: Number(l.qty), unitPriceTzs: Number(l.priceTzs),
          amountTzs: base[i].netTzs, vatCode: vat.lines[i]?.vatCode ?? null, vatRatePct: vat.lines[i]?.vatRatePct ?? 0, vatTzs: vat.lines[i]?.vatTzs ?? 0,
        }));
        const subtotal = lines.reduce((s, l) => s + l.amountTzs, 0);
        const seller = await sellerSnapshotOf(trx, vendorId, { vat });
        const issued = await trx.raw(`INSERT INTO "VendorDocumentSequence" ("vendorId", "docType", "next", "updatedAt") VALUES (?, ?, 2, ?)
          ON CONFLICT ("vendorId", "docType") DO UPDATE SET "next" = "VendorDocumentSequence"."next" + 1, "updatedAt" = EXCLUDED."updatedAt"
          RETURNING "next" - 1 AS seq`, [vendorId, INVOICE_DOC_TYPE, at]);
        const seq = Number(issued.rows[0].seq);
        const row = {
          id: newId('oin'), vendorId, orderId: order.id, seq, number: invoiceNumber(seq), issuedAt: at, vatApplied: vat.applied, lateIssued: late,
          subtotalTzs: subtotal, totalTzs: subtotal, vatIncludedTzs: lines.reduce((s, l) => s + l.vatTzs, 0),
          lines: JSON.stringify(lines), sellerSnapshot: JSON.stringify(seller), paymentMethod: order.paymentMethod ?? null, createdAt: at,
        };
        await trx('VendorOrderInvoice').insert(row);
        return { invoice: plain(await trx('VendorOrderInvoice').where({ id: row.id }).first()), issued: true };
      });
    } catch (err) {
      if (err.code === UNIQUE_VIOLATION && /orderid|order_id|vendororderinvoice/i.test(`${err.constraint || ''} ${err.message}`)) {
        const row = await db('VendorOrderInvoice').where({ orderId: order.id, vendorId }).first();
        if (row) return { invoice: plain(row), issued: false };
      }
      throw err;
    }
  }

  const vendorsOf = order => [...new Set((Array.isArray(json(order?.items)) ? json(order.items) : []).map(i => i?.vendorId).filter(Boolean).map(String))];

  /**
   * The vendor's invoice for an order, with what the document needs. Issued lazily (late, no VAT) when the
   * order is paid and has none yet. → { invoice, order, buyerName } | { error: order_not_found | invoice_not_ready }.
   */
  async function orderInvoiceSource(vendorId, orderId, { buyerId = null } = {}) {
    if (typeof orderId !== 'string' || !orderId) return { error: 'order_not_found' };
    const order = plain(await db('ShopOrder').where({ id: orderId }).first());
    if (!order || (buyerId && order.buyerId !== buyerId)) return { error: 'order_not_found' };
    if (!ownLines({ items: json(order.items) || [] }, vendorId).length) return { error: 'order_not_found' };
    if (!PAID_STATES.includes(order.paymentStatus)) return { error: 'invoice_not_ready' };
    let row = plain(await db('VendorOrderInvoice').where({ orderId, vendorId }).first());
    if (!row) row = (await issueOrderInvoice(order, vendorId, { late: true }))?.invoice ?? null;
    if (!row) return { error: 'invoice_not_ready' };
    const buyer = order.buyerId ? await db('User').where({ id: order.buyerId }).first('displayName') : null;
    const cancelled = orderCancelledFor(order, vendorId);
    return {
      invoice: { ...row, lines: json(row.lines), sellerSnapshot: json(row.sellerSnapshot) },
      order: { id: order.id, cancelled, cancelledAt: cancelled ? cancelledAtOf(order) : null },
      // A-02: the buyer by display name only; a deleted account shows no name.
      buyerName: typeof buyer?.displayName === 'string' && buyer.displayName.trim() ? buyer.displayName.trim() : null,
    };
  }

  /** Every vendor of a buyer's order, for GET /me/shop-orders/:id/invoice. → { vendorIds } | { error } */
  async function orderVendorsForBuyer(buyerId, orderId) {
    const order = typeof orderId === 'string' && orderId ? plain(await db('ShopOrder').where({ id: orderId }).first('id', 'buyerId', 'items', 'paymentStatus')) : null;
    if (!order || order.buyerId !== buyerId) return { error: 'order_not_found' };
    if (!PAID_STATES.includes(order.paymentStatus)) return { error: 'invoice_not_ready' };
    return { vendorIds: vendorsOf(order) };
  }

  // ── links ─────────────────────────────────────────────────────────────────

  const linkRow = r => plain(r);

  async function createLink({ vendorId, docType, docId, tokenHash, lang, snapshot = null, createdBy }) {
    const row = {
      id: newId('dln'), vendorId, docType, docId, tokenHash, lang, snapshot: snapshot == null ? null : JSON.stringify(snapshot), createdBy, createdAt: now(),
    };
    await db('VendorDocumentLink').insert(row);
    await db('AuditLog').insert({
      id: randomUUID(), at: row.createdAt, actor: createdBy, action: 'vendor_document_link_created', target: row.id,
      before: null, after: JSON.stringify({ vendorId, docType, docId, lang }),
    });
    return linkRow(await db('VendorDocumentLink').where({ id: row.id }).first());
  }

  async function listLinks(vendorId, docTypes, docId) {
    const rows = (await db('VendorDocumentLink').where({ vendorId, docId }).whereIn('docType', docTypes)
      .orderBy([{ column: 'createdAt' }, { column: 'id' }]).select('id', 'docType', 'docId', 'lang', 'createdBy', 'createdAt', 'lastOpenedAt', 'revokedAt', 'revokedBy')).map(plain);
    const names = await namesOf(db, rows.map(r => r.createdBy));
    return rows.map((r, i) => ({ ...r, n: i + 1, createdByName: names.get(r.createdBy) ?? null }));
  }

  /** What a sale of this vendor is shared as: receipt (cash) | invoice (credit) | null (not this vendor's). */
  async function saleDocType(vendorId, saleId) {
    const row = typeof saleId === 'string' && saleId ? await db('VendorSale').where({ id: saleId, vendorId }).first('kind') : null;
    return row ? (row.kind === 'credit' ? 'invoice' : 'receipt') : null;
  }
  const getLink = async (vendorId, linkId) => (typeof linkId === 'string' && linkId
    ? linkRow(await db('VendorDocumentLink').where({ id: linkId, vendorId }).first()) : null);

  /** Turn off links (permanent). `where` narrows to one link or to one document's links. → rows turned off now. */
  async function revoke({ vendorId, actorId, linkId = null, docTypes = null, docId = null }) {
    const at = now();
    const query = db('VendorDocumentLink').where({ vendorId }).whereNull('revokedAt');
    if (linkId) query.where({ id: linkId });
    else query.where({ docId }).whereIn('docType', docTypes);
    const rows = await query.update({ revokedAt: at, revokedBy: actorId }).returning(['id', 'docType', 'docId']);
    for (const r of rows) {
      await db('AuditLog').insert({ id: randomUUID(), at, actor: actorId, action: 'vendor_document_link_revoked', target: r.id, before: null, after: JSON.stringify({ vendorId, docType: r.docType, docId: r.docId }) });
    }
    return rows.map(plain);
  }

  /** The link behind a token hash — only while not revoked and its vendor still exists. */
  async function liveLinkByHash(tokenHash) {
    const row = linkRow(await db('VendorDocumentLink').where({ tokenHash }).whereNull('revokedAt').first());
    if (!row || !(await vendorExists(row.vendorId))) return null;
    return { ...row, snapshot: json(row.snapshot) };
  }
  const touch = linkId => db('VendorDocumentLink').where({ id: linkId }).update({ lastOpenedAt: now() });
  /** The customer behind a statement link deleted their FitFlex account (#229 M1). */
  const customerForgotten = async (vendorId, customerId) => Boolean(await db('VendorCustomer').where({ id: customerId, vendorId }).whereNotNull('forgottenAt').first('id'));

  return {
    saleSource, paymentSource, statementSource, issueOrderInvoice, orderInvoiceSource, orderVendorsForBuyer, vendorsOf,
    createLink, listLinks, getLink, saleDocType, revoke, liveLinkByHash, touch, vendorExists, customerForgotten,
  };
}
