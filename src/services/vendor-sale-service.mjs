// Vendor walk-in sales (vendor business tools · S3): record, list, read, void.
//
// Owner decision 2026-10-19: walk-in sales are the vendor's own business — recorded with NO
// commission, NO ShopOrder, NO PaymentRequest and never part of vendor settlement. Money never
// passes through FitFlex. They share the stock pool with app orders.
//
// Persistence is the Postgres store (src/infra/vendor-sale-store-pg.mjs). The routes check the
// flag (VENDOR_TOOLS + VENDOR_WALKIN_SALES) and the `sales` permission before calling in here.
import { parseSale, saleFingerprint, soldAtOutOfRange, clampSoldAt, parseVoid, SALES_PAGE_DEFAULT, SALES_PAGE_MAX } from '../shared/vendor-sale.mjs';
import { eatDayStart } from '../shared/vendor-stock.mjs';
import { eatDate } from '../shared/vendor-order-view.mjs';

const DAY_MS = 86_400_000;
const STATUSES = new Set(['completed', 'voided']);

export function createVendorSaleService({
  store,
  // Stock moved for these products: tell the vendor about any that just went low (S1, best effort).
  afterStockMoved = async () => {},
  // Tell the vendor account something (shopService.notifyVendor: shop list + push). Best effort.
  notifyVendor = async () => {},
  now = () => new Date(),
}) {
  async function lowStockCheck(productIds) {
    try { await afterStockMoved(productIds); } catch (err) { console.warn('[vendor-sales] low-stock check failed:', err?.message); }
  }

  /** POST /vendor/sales → { sale, status: 201 | 200 (replay) } or { error, status, ... }. */
  async function recordSale({ vendorId, actorId, body }) {
    const sale = parseSale(body || {});
    if (sale.error) return sale;
    const fingerprint = saleFingerprint(sale);
    // A retry of a sale already recorded gets that sale, even if it is now older than the window.
    const earlier = await store.replayOf(vendorId, sale.clientRef, fingerprint);
    if (earlier?.error) return earlier;
    if (earlier) return { sale: earlier.sale, status: 200 };
    const at = now();
    sale.soldAt ||= at;
    const outOfRange = soldAtOutOfRange(sale.soldAt, at);
    if (outOfRange) return outOfRange;
    Object.assign(sale, clampSoldAt(sale.soldAt, at));
    const out = await store.record({ vendorId, actorId, sale, fingerprint });
    if (out.error) return out;
    if (!out.replayed) await lowStockCheck(out.productIds);
    return { sale: out.sale, status: out.replayed ? 200 : 201 };
  }

  /** GET /vendor/sales?from&to&status&createdBy=me&limit&cursor (from/to: EAT days, inclusive). */
  async function listSales({ vendorId, actorId, query = {} }) {
    const from = query.from ? eatDayStart(query.from) : null;
    if (query.from && !from) return { error: 'invalid_date', status: 400, field: 'from' };
    const toDay = query.to ? eatDayStart(query.to) : null;
    if (query.to && !toDay) return { error: 'invalid_date', status: 400, field: 'to' };
    const to = toDay ? new Date(+toDay + DAY_MS) : null;
    if (from && to && from >= to) return { error: 'invalid_date', status: 400, field: 'to' };
    const status = query.status == null || query.status === '' || query.status === 'all' ? null : String(query.status);
    if (status && !STATUSES.has(status)) return { error: 'invalid_status', status: 400, allowed: ['completed', 'voided', 'all'] };
    let createdBy = null;
    if (query.createdBy != null && query.createdBy !== '') {
      if (query.createdBy !== 'me') return { error: 'invalid_created_by', status: 400, allowed: ['me'] };
      createdBy = actorId;
    }
    const limit = query.limit == null || query.limit === '' ? SALES_PAGE_DEFAULT : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1) return { error: 'invalid_limit', status: 400, max: SALES_PAGE_MAX };
    return store.list({ vendorId, from, to, status, createdBy, limit: Math.min(limit, SALES_PAGE_MAX), cursor: query.cursor || null });
  }

  /** GET /vendor/sales/:id. Another vendor's sale → 404 (not found). */
  async function getSale({ vendorId, saleId }) {
    const sale = await store.get(vendorId, saleId);
    return sale ? { sale } : { error: 'sale_not_found', status: 404 };
  }

  /**
   * POST /vendor/sales/:id/void { reason } → { sale } or { error, status }.
   * Security review M2: `voidsAny` (the vendor account, staff with vendorRole admin) may void any sale;
   * other `sales` staff only a sale they recorded, on the EAT day it was sold → else 403 void_not_allowed
   * { reason: not_own | too_old }. A void by staff is reported to the vendor account (after commit).
   */
  async function voidSale({ vendorId, actorId, saleId, body, voidsAny = false }) {
    const parsed = parseVoid(body || {});
    if (parsed.error) return parsed;
    const canVoid = (sale) => {
      if (voidsAny) return null;
      if (sale.createdBy !== actorId) return { error: 'void_not_allowed', status: 403, reason: 'not_own' };
      if (eatDate(sale.soldAt) !== eatDate(now())) return { error: 'void_not_allowed', status: 403, reason: 'too_old' };
      return null;
    };
    const out = await store.voidSale({ vendorId, saleId, actorId, reason: parsed.reason, canVoid });
    if (out.error) return out;
    await lowStockCheck(out.productIds);
    if (actorId !== vendorId) {
      try {
        await notifyVendor(vendorId, 'vendor_sale_voided', {
          saleId: out.sale.id, number: out.sale.number, totalTzs: out.sale.totalTzs,
          voidedByName: out.sale.voidedBy?.name ?? null, reason: out.sale.voidReason,
        });
      } catch (err) { console.warn('[vendor-sales] void notification failed:', err?.message); }
    }
    return { sale: out.sale };
  }

  return { recordSale, listSales, getSale, voidSale };
}
