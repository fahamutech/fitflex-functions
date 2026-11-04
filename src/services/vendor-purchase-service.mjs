// Suppliers, receiving stock (GRN) and payables with instalments (vendor business tools · S9; design spec
// docs/design/vendor-purchases-s9.md, approved 2026-11-04 with Q-1..Q-7 as recommended). RULE 6 AREA: money
// records, cost-price writes, shared product rows.
//
// FitFlex moves no money for payables: a purchase payment records what the vendor says they paid a supplier.
// No PaymentRequest, no commission, never part of settlement. Persistence: src/infra/vendor-purchase-store-pg.mjs.
// The routes check the flags (VENDOR_TOOLS + VENDOR_STOCK_LEDGER + VENDOR_PURCHASES) and `purchases` first.
//
// M2 (who may void): the vendor account and vendorRole admin staff (`voidsAny`, from the stored staff record)
// may void any purchase or payment; other `purchases` staff only a record THEY made, on the EAT day they made
// it (createdAt) → 403 void_not_allowed { reason: not_own | too_old }. A void by staff notifies the vendor account.
import {
  parseSupplier, parseReceive, purchaseFingerprint, parsePurchasePayment, purchasePaymentFingerprint, parsePurchaseReason,
  parseSchedule, validClientRef, SUPPLIER_FILTERS, SUPPLIER_SORTS, PAYABLES_SORTS, PURCHASE_STATUSES, PURCHASE_PAYMENT_FILTERS,
  PURCHASES_PAGE_DEFAULT, PURCHASES_PAGE_MAX, MAX_LAST_COST_PRODUCTS,
} from '../shared/vendor-purchase.mjs';
import { eatToday, validDay, decodeOffset, pageLimit, AGING_BUCKETS } from '../shared/vendor-customer.mjs';
import { eatDate } from '../shared/vendor-order-view.mjs';

const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const blank = v => v == null || v === '';

export function createVendorPurchaseService({
  store,
  afterStockMoved = async () => {},
  notifyVendor = async () => {},
  now = () => new Date(),
}) {
  const today = () => eatToday(now());
  async function lowStockCheck(productIds) {
    if (!productIds?.length) return;
    try { await afterStockMoved(productIds); } catch (err) { console.warn('[vendor-purchases] low-stock check failed:', err?.message); }
  }
  async function tell(vendorId, actorId, type, data) {
    if (actorId === vendorId) return;
    try { await notifyVendor(vendorId, type, data); } catch (err) { console.warn(`[vendor-purchases] ${type} notification failed:`, err?.message); }
  }
  const m2 = (voidsAny, actorId, by, at) => {
    if (voidsAny) return null;
    if (by !== actorId) return { error: 'void_not_allowed', status: 403, reason: 'not_own' };
    if (eatDate(at) !== eatDate(now())) return { error: 'void_not_allowed', status: 403, reason: 'too_old' };
    return null;
  };
  const offsetOf = (cursor) => {
    if (blank(cursor)) return 0;
    const o = decodeOffset(cursor);
    return o == null ? fail('invalid_cursor', 400) : o;
  };

  // ── suppliers ─────────────────────────────────────────────────────────────

  async function createSupplier({ vendorId, actorId, body }) {
    const parsed = parseSupplier(body || {});
    if (parsed.error) return parsed;
    const out = await store.createSupplier({ vendorId, actorId, fields: parsed.fields });
    return out.error ? out : { supplier: out.supplier, status: 201 };
  }

  async function updateSupplier({ vendorId, actorId, supplierId, body }) {
    const parsed = parseSupplier(body || {}, { partial: true });
    if (parsed.error) return parsed;
    return store.updateSupplier({ vendorId, actorId, supplierId, fields: parsed.fields, archived: parsed.archived });
  }

  async function listSuppliers({ vendorId, query = {} }) {
    const filter = blank(query.filter) ? 'active' : String(query.filter);
    if (!SUPPLIER_FILTERS.includes(filter)) return fail('invalid_filter', 400, { allowed: SUPPLIER_FILTERS });
    const sort = blank(query.sort) ? 'name' : String(query.sort);
    if (!SUPPLIER_SORTS.includes(sort)) return fail('invalid_sort', 400, { allowed: SUPPLIER_SORTS });
    const limit = pageLimit(query.limit, { def: PURCHASES_PAGE_DEFAULT, max: PURCHASES_PAGE_MAX });
    if (limit?.error) return limit;
    const offset = offsetOf(query.cursor);
    if (offset?.error) return offset;
    const q = typeof query.q === 'string' && query.q.trim().length >= 2 ? query.q.trim().slice(0, 80) : null;
    return store.listSuppliers({ vendorId, today: today(), q, filter, sort, limit, offset });
  }

  async function getSupplier({ vendorId, supplierId }) {
    const out = await store.supplierProfile({ vendorId, supplierId, today: today() });
    return out || fail('supplier_not_found', 404);
  }

  // ── receive ───────────────────────────────────────────────────────────────

  /** POST /vendor/purchases → { purchase, costChanges, status: 201 | 200 (replay) } or { error, status, ... }. */
  async function receive({ vendorId, actorId, body, canSeeCost = false }) {
    const day = today();
    const fingerprint = purchaseFingerprint(body);
    const parsed = parseReceive(body || {}, { today: day });
    // Replay first (spec §2.3 order): a well-formed body reaches the store, whose first step is the replay; a
    // body that no longer parses (its receivedOn left the 30-day window, say) is still answered as a replay.
    if (parsed.error) {
      if (validClientRef(body?.clientRef)) {
        const earlier = await store.replayPurchase({ vendorId, clientRef: body.clientRef, fingerprint, canSeeCost, today: day });
        if (earlier) return earlier.error ? earlier : { purchase: earlier.purchase, costChanges: earlier.costChanges, status: 200 };
      }
      return parsed;
    }
    const out = await store.receive({ vendorId, actorId, parsed, fingerprint, canSeeCost, today: day });
    if (out.error) return out;
    if (!out.replayed) await lowStockCheck(out.productIds);
    return { purchase: out.purchase, costChanges: out.costChanges, status: out.replayed ? 200 : 201 };
  }

  /** POST /vendor/purchases/:id/void { reason }. */
  async function voidPurchase({ vendorId, actorId, purchaseId, body, voidsAny = false, canSeeCost = false }) {
    const parsed = parsePurchaseReason(body?.reason);
    if (parsed.error) return parsed;
    const out = await store.voidPurchase({
      vendorId, purchaseId, actorId, reason: parsed.reason, canSeeCost, today: today(),
      canVoid: row => m2(voidsAny, actorId, row.createdBy, row.createdAt),
    });
    if (out.error) return out;
    await lowStockCheck(out.productIds);
    await tell(vendorId, actorId, 'vendor_purchase_voided', {
      purchaseId: out.purchase.id, number: out.purchase.number, totalTzs: out.purchase.totalTzs,
      byName: out.purchase.voidedBy?.name ?? null, reason: parsed.reason,
    });
    return { purchase: out.purchase, costRestored: out.costRestored, costKept: out.costKept, paymentsVoided: out.paymentsVoided };
  }

  // ── payments and the plan ─────────────────────────────────────────────────

  async function recordPayment({ vendorId, actorId, purchaseId, body, canSeeCost = false }) {
    const day = today();
    const fingerprint = purchasePaymentFingerprint(purchaseId, body);
    const parsed = parsePurchasePayment(body || {}, { today: day });
    if (parsed.error) {
      if (validClientRef(body?.clientRef)) {
        const earlier = await store.replayPayment({ vendorId, purchaseId, clientRef: body.clientRef, fingerprint, canSeeCost, today: day });
        if (earlier) return earlier.error ? earlier : { ...earlier, status: 200 };
      }
      return parsed;
    }
    const out = await store.recordPayment({ vendorId, purchaseId, actorId, parsed, fingerprint, canSeeCost, today: day });
    if (out.error) return out;
    return { purchase: out.purchase, payment: out.payment, covered: out.covered, status: out.replayed ? 200 : 201 };
  }

  async function voidPayment({ vendorId, actorId, purchaseId, paymentId, body, voidsAny = false, canSeeCost = false }) {
    const parsed = parsePurchaseReason(body?.reason);
    if (parsed.error) return parsed;
    const out = await store.voidPayment({
      vendorId, purchaseId, paymentId, actorId, reason: parsed.reason, canSeeCost, today: today(),
      canVoid: row => m2(voidsAny, actorId, row.recordedBy, row.createdAt),
    });
    if (out.error) return out;
    await tell(vendorId, actorId, 'vendor_purchase_payment_voided', {
      purchaseId, number: out.number, amountTzs: out.row.amountTzs, byName: out.payment?.voidedBy?.name ?? null, reason: parsed.reason,
    });
    return { purchase: out.purchase };
  }

  async function changePlan({ vendorId, actorId, purchaseId, body, canSeeCost = false }) {
    // Shape only here (count, amounts, real dates); the date range and the sum are checked on the locked purchase.
    const shape = parseSchedule(body?.schedule, { earliest: '0000-01-01', latest: '9999-12-31' });
    if (shape.error) return shape;
    return store.changePlan({ vendorId, purchaseId, actorId, schedule: body.schedule, canSeeCost, today: today() });
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  async function getPurchase({ vendorId, purchaseId, canSeeCost = false }) {
    const purchase = await store.getPurchase({ vendorId, purchaseId, canSeeCost, today: today() });
    return purchase ? { purchase } : fail('purchase_not_found', 404);
  }

  /** GET /vendor/purchases query → store arguments or a 400. */
  function listQuery({ actorId, query = {} }) {
    const from = blank(query.from) ? null : validDay(String(query.from));
    if (!blank(query.from) && !from) return fail('invalid_date', 400, { field: 'from' });
    const to = blank(query.to) ? null : validDay(String(query.to));
    if (!blank(query.to) && !to) return fail('invalid_date', 400, { field: 'to' });
    if (from && to && from > to) return fail('invalid_date', 400, { field: 'to' });
    const status = blank(query.status) || query.status === 'all' ? null : String(query.status);
    if (status && !PURCHASE_STATUSES.includes(status)) return fail('invalid_status', 400, { allowed: PURCHASE_STATUSES });
    const payment = blank(query.payment) || query.payment === 'all' ? null : String(query.payment);
    if (payment && !PURCHASE_PAYMENT_FILTERS.includes(payment)) return fail('invalid_payment_filter', 400, { allowed: PURCHASE_PAYMENT_FILTERS });
    if (!blank(query.createdBy) && query.createdBy !== 'me') return fail('invalid_created_by', 400);
    const supplierId = blank(query.supplierId) ? null : String(query.supplierId);
    return { from, to, status, payment, supplierId, createdBy: query.createdBy === 'me' ? actorId : null };
  }

  async function listPurchases({ vendorId, actorId, query = {}, all = false, maxRows = null }) {
    const args = listQuery({ actorId, query });
    if (args.error) return args;
    let limit = all ? maxRows : pageLimit(query.limit, { def: PURCHASES_PAGE_DEFAULT, max: PURCHASES_PAGE_MAX });
    if (limit?.error) return limit;
    return store.listPurchases({ vendorId, today: today(), ...args, limit, cursor: all ? null : query.cursor || null });
  }

  async function lastCosts({ vendorId, query = {} }) {
    const ids = [...new Set(String(query.productIds ?? '').split(',').map(s => s.trim()).filter(Boolean))];
    if (ids.length > MAX_LAST_COST_PRODUCTS) return fail('too_many_products', 400, { max: MAX_LAST_COST_PRODUCTS });
    if (ids.some(id => id.length > 100)) return fail('invalid_product_ids', 400);
    return store.lastCosts({ vendorId, productIds: ids });
  }

  async function aging({ vendorId, query = {}, all = false, maxRows = null }) {
    const bucket = blank(query.bucket) || query.bucket === 'all' ? null : String(query.bucket);
    if (bucket && !AGING_BUCKETS.includes(bucket)) return fail('invalid_bucket', 400, { allowed: AGING_BUCKETS });
    const sort = blank(query.sort) ? 'overdue' : String(query.sort);
    if (!PAYABLES_SORTS.includes(sort)) return fail('invalid_sort', 400, { allowed: PAYABLES_SORTS });
    const limit = all ? maxRows : pageLimit(query.limit, { def: PURCHASES_PAGE_DEFAULT, max: PURCHASES_PAGE_MAX });
    if (limit?.error) return limit;
    const offset = all ? 0 : offsetOf(query.cursor);
    if (offset?.error) return offset;
    return store.aging({ vendorId, today: today(), bucket, sort, limit, offset });
  }

  return {
    createSupplier, updateSupplier, listSuppliers, getSupplier,
    receive, voidPurchase, recordPayment, voidPayment, changePlan, getPurchase, listPurchases, lastCosts, aging,
  };
}
