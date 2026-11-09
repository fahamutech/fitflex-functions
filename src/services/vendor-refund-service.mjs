// Refunds on walk-in sales (vendor business tools · S7; design spec docs/design/vendor-refunds-s7.md,
// approved 2026-11-03 with Q-1..Q-6 as recommended). RULE 6 AREA: money records.
//
// Walk-in money never passes through FitFlex: a refund records what the vendor gave back (or took off a
// pay-later balance). No commission, no PaymentRequest, never part of settlement. Marketplace orders are out
// of scope (D-6). Persistence: src/infra/vendor-refund-store-pg.mjs. The routes check the flags
// (VENDOR_TOOLS + VENDOR_WALKIN_SALES + VENDOR_REFUNDS for writes) and the `sales` permission first.
//
// Q-1 (who): the vendor account and vendorRole admin staff (`refundsAny`, from the stored staff record) may
// refund any completed sale and undo any refund; other `sales` staff only a sale THEY recorded, on the EAT day
// it was sold, and only their own refund, on the EAT day they made it → 403 refund_not_allowed /
// revert_not_allowed { reason: not_own | too_old }. A refund or undo by staff notifies the vendor account.
import { parseRefund, refundFingerprint, parseReason, validClientRef, REFUNDS_PAGE_DEFAULT, REFUNDS_PAGE_MAX } from '../shared/vendor-refund.mjs';
import { eatDayStart } from '../shared/vendor-stock.mjs';
import { eatDate } from '../shared/vendor-order-view.mjs';

const DAY_MS = 86_400_000;
const STATUSES = new Set(['active', 'reverted']);

export function createVendorRefundService({
  store,
  afterStockMoved = async () => {},
  notifyVendor = async () => {},
  now = () => new Date(),
}) {
  async function lowStockCheck(productIds) {
    if (!productIds?.length) return;
    try { await afterStockMoved(productIds); } catch (err) { console.warn('[vendor-refunds] low-stock check failed:', err?.message); }
  }
  async function tell(vendorId, actorId, type, data) {
    if (actorId === vendorId) return;
    try { await notifyVendor(vendorId, type, data); } catch (err) { console.warn(`[vendor-refunds] ${type} notification failed:`, err?.message); }
  }

  /** POST /vendor/sales/:id/refunds → { refund, sale, status: 201 | 200 (replay) } or { error, status, ... }. */
  async function refundSale({ vendorId, actorId, saleId, body, refundsAny = false }) {
    // A stored refund's body was valid, so a well-formed retry always reaches the store, whose first step is
    // the replay lookup (spec §2.2 order: replay, then everything else). A malformed body can never be a replay.
    if (!validClientRef(body?.clientRef)) return { error: 'invalid_client_ref', status: 400 };
    const fingerprint = refundFingerprint(saleId, body);
    const parsed = parseRefund(body || {});
    if (parsed.error) return parsed;
    const canRefund = (sale) => {
      if (refundsAny) return null;
      if (sale.createdBy !== actorId) return { error: 'refund_not_allowed', status: 403, reason: 'not_own' };
      if (eatDate(sale.soldAt) !== eatDate(now())) return { error: 'refund_not_allowed', status: 403, reason: 'too_old' };
      return null;
    };
    const out = await store.refund({ vendorId, saleId, actorId, parsed, fingerprint, canRefund });
    if (out.error) return out;
    if (!out.replayed) {
      await lowStockCheck(out.productIds);
      await tell(vendorId, actorId, 'vendor_sale_refunded', {
        saleId: out.sale.id, refundId: out.refund.id, number: out.refund.number, saleNumber: out.sale.number,
        amountTzs: out.refund.amountTzs, createdByName: out.refund.createdBy?.name ?? null, reason: out.refund.reason,
      });
    }
    return { refund: out.refund, sale: out.sale, status: out.replayed ? 200 : 201 };
  }

  /** POST /vendor/refunds/:id/revert { reason } → { refund, sale } or { error, status, ... }. */
  async function revertRefund({ vendorId, actorId, refundId, body, refundsAny = false }) {
    const parsed = parseReason(body?.reason);
    if (parsed.error) return parsed;
    const canRevert = (row) => {
      if (refundsAny) return null;
      if (row.createdBy !== actorId) return { error: 'revert_not_allowed', status: 403, reason: 'not_own' };
      if (eatDate(row.createdAt) !== eatDate(now())) return { error: 'revert_not_allowed', status: 403, reason: 'too_old' };
      return null;
    };
    const out = await store.revert({ vendorId, refundId, actorId, reason: parsed.reason, canRevert });
    if (out.error) return out;
    await lowStockCheck(out.productIds);
    await tell(vendorId, actorId, 'vendor_refund_reverted', {
      saleId: out.sale.id, refundId: out.refund.id, number: out.refund.number, amountTzs: out.refund.amountTzs,
      revertedByName: out.refund.revertedBy?.name ?? null, reason: out.refund.revertReason,
    });
    return { refund: out.refund, sale: out.sale };
  }

  /** GET /vendor/refunds/:id. Another vendor's refund → 404. */
  async function getRefund({ vendorId, refundId }) {
    const refund = await store.get(vendorId, refundId);
    return refund ? { refund } : { error: 'refund_not_found', status: 404 };
  }

  /** GET /vendor/refunds?from&to&saleId&status&limit&cursor (from/to: EAT days, inclusive, on the refund date). */
  async function listRefunds({ vendorId, query = {} }) {
    const from = query.from ? eatDayStart(query.from) : null;
    if (query.from && !from) return { error: 'invalid_date', status: 400, field: 'from' };
    const toDay = query.to ? eatDayStart(query.to) : null;
    if (query.to && !toDay) return { error: 'invalid_date', status: 400, field: 'to' };
    const to = toDay ? new Date(+toDay + DAY_MS) : null;
    if (from && to && from >= to) return { error: 'invalid_date', status: 400, field: 'to' };
    const status = query.status == null || query.status === '' || query.status === 'all' ? null : String(query.status);
    if (status && !STATUSES.has(status)) return { error: 'invalid_status', status: 400, allowed: ['active', 'reverted', 'all'] };
    const saleId = query.saleId == null || query.saleId === '' ? null : String(query.saleId);
    const limit = query.limit == null || query.limit === '' ? REFUNDS_PAGE_DEFAULT : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1) return { error: 'invalid_limit', status: 400, max: REFUNDS_PAGE_MAX };
    return store.list({ vendorId, from, to, saleId, status, limit: Math.min(limit, REFUNDS_PAGE_MAX), cursor: query.cursor || null });
  }

  return { refundSale, revertRefund, getRefund, listRefunds };
}
