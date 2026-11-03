// Vendor business tools · S7 — partial and revertible refunds on walk-in sales (design spec
// docs/design/vendor-refunds-s7.md, approved 2026-11-03). RULE 6 AREA: money records.
// Writes (refund, undo; share is in vendor-documents.mjs) need VENDOR_TOOLS + VENDOR_WALKIN_SALES + VENDOR_REFUNDS
// (off → 404 feature_disabled). Reads of refunds already made need only VENDOR_TOOLS + VENDOR_WALKIN_SALES: they are
// bookkeeping facts of the sale and stay visible read-only when VENDOR_REFUNDS goes off (spec §0.2, §3.1, AC-2).
// Permission `sales` (stored staff record; staff of a suspended vendor → 403 vendor_suspended).
// Walk-in money never passes through FitFlex: a refund records what the vendor gave back. No commission, no
// PaymentRequest, never part of vendor settlement. Marketplace orders are out of scope (D-6).
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { vendorRefundService } from '../src/bootstrap/services.mjs';
import { vendorWalkInSalesOn, vendorRefundsOn } from '../src/shared/feature-flags.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { requireSalesPermission, voidsAny, seesCustomers, forCaller, allowVendorSale } from './vendor-sales.mjs';

const created = new Date().toISOString();
const guards = method => routeGuard(method, [requireAuth('vendor', 'vendor_staff'), requireSalesPermission]);
const vendorOf = user => (user.userType === 'vendor_staff' ? user.vendorId : user.sub);
const send = (res, result) => {
  const { error, status, ...extra } = result;
  return res.status(status).json({ error, ...extra });
};
const disabled = res => res.status(404).json({ error: 'feature_disabled' });

const FLAGS = 'VENDOR_TOOLS + VENDOR_WALKIN_SALES + VENDOR_REFUNDS; any off → 404 feature_disabled';
const READ_FLAGS = 'VENDOR_TOOLS + VENDOR_WALKIN_SALES; off → 404 feature_disabled. Works with VENDOR_REFUNDS off (refunds already made stay readable)';
const STAFF = 'Staff without `sales` → 403 vendor_permission_forbidden { requiredPermission: sales }; staff of a suspended vendor → 403 vendor_suspended.';
export const REFUND_SHAPE = '{ id, number (CN-000001, continuous per vendor), status: active|reverted, saleId, saleNumber (R-…), saleInvoiceNumber (INV-… for a pay-later sale)|null, saleKind: cash|credit, refundedAt, createdBy { id, name }, reason, method|null, reference|null, amountTzs (= balanceReducedTzs + paidOutTzs; computed by the server), balanceReducedTzs (taken off a pay-later balance; 0 for cash), paidOutTzs (money the vendor gave back), vatTzs (VAT given back, inside amountTzs), vatSummary:[{ code, ratePct|null, netTzs, vatTzs }], customer { id, name|null, forgotten }|null, lines:[{ saleLineId, productId, variant|null, nameSnapshot, qty, unitPriceTzs, amountTzs, vatTzs, vatCode|null, restock }], revertedBy { id, name }|null, revertedAt|null, revertReason|null }. Never cost or internals.';

/** M2 / Q-1: the caller may refund any sale and undo any refund (vendor account, vendorRole admin staff). */
const refundsAny = user => voidsAny(user);
const sale = async (req, s) => forCaller(s, await seesCustomers(req.user));

export const vendorRefundSale = {
  created, method: 'post', path: '/vendor/sales/:id/refunds',
  description: `Vendor / staff with \`sales\` (${FLAGS}): refund some or all units of lines of a completed walk-in sale (cash or pay later). Body { clientRef (8–100 chars [A-Za-z0-9._:-]; reuse it on every retry), lines:[{ saleLineId, qty (1–1000), restock? (default true: the units go back to stock; false: damaged / not returned) }] (1–100, each saleLineId once), reason (3–200), method? (cash|mpesa|airtel_money|mixx|halopesa|card|bank|other; required only when money is paid back), reference? (≤ 100; required for mpesa, airtel_money, mixx, halopesa, bank when money is paid back) }. The client sends NO amounts: per line the server gives back floor(lineNet × (refunded + q) / sold) − already given back, the last unit taking the rest (lineNet = lineTotal − its share of the sale discount), never more than was paid; VAT the same way. A pay-later sale's balance comes off first (balanceReducedTzs), the rest is paid back (paidOutTzs). Method and reference sent when nothing is paid back are ignored. → 201 { refund, sale } refund = ${REFUND_SHAPE} sale = the GET /vendor/sales/:id view. A replay of the same clientRef with the same body → 200 with the same refund (answered first). Order: replay; 400s; 404 sale_not_found; 403 refund_not_allowed { reason: not_own | too_old } (staff who are not vendorRole admin: only a sale they recorded, on its EAT sale day); 409 sale_voided { voidedAt }; 400 line_not_on_sale { saleLineId }; 409 refund_exceeds_sold { lines:[{ saleLineId, soldQty, refundedQty, refundableQty }] } (nothing written); 400 method_required | invalid_method | reference_required { method } | reference_too_long { max }; 400 restock_unavailable { saleLineId, productId } (product deleted: send restock false). Other errors: 409 client_ref_reused, 400 invalid_client_ref | lines_required | too_many_lines | invalid_line { index, field } | duplicate_line { saleLineId } | invalid_quantity { index } | reason_required { min } | reason_too_long { max }, 429 rate_limited { retryAfterSeconds } (shares the 120/min/vendor sales limit). A refund by staff notifies the vendor account (vendor_sale_refunded). FitFlex moves no money. ${STAFF}`,
  requestSample: { clientRef: '6f1c2b9e-5a1d-4e0b-9a51-7c1f3b2d9e10', lines: [{ saleLineId: 'sln_0123456789abcdef', qty: 1, restock: true }], reason: 'Customer returned it', method: 'cash' },
  onGuard: guards('post'),
  onRequest: async (req, res) => {
    if (!vendorRefundsOn()) return disabled(res);
    const allowed = allowVendorSale(vendorOf(req.user));
    if (!allowed.ok) {
      res.set?.('Retry-After', String(allowed.retryAfterSeconds));
      return res.status(429).json({ error: 'rate_limited', retryAfterSeconds: allowed.retryAfterSeconds });
    }
    const result = await vendorRefundService.refundSale({
      vendorId: vendorOf(req.user), actorId: req.user.sub, saleId: req.params.id, body: req.body || {}, refundsAny: await refundsAny(req.user),
    });
    if (result.error) return send(res, result);
    if (result.status === 200) res.set?.('Idempotent-Replay', 'true');
    res.status(result.status).json({ refund: result.refund, sale: await sale(req, result.sale) });
  },
};

export const vendorRevertRefund = {
  created, method: 'post', path: '/vendor/refunds/:id/revert',
  description: `Vendor / staff with \`sales\` (${FLAGS}): undo a refund made by mistake. Body { reason (3–200) }. Exactly reverses it: restocked units are taken out of stock again, the quantities and amounts count as sold again, a pay-later sale's balance gets balanceReducedTzs back (any money paid back is for the customer to return). The CN number is kept; the credit note reads Cancelled. → 200 { refund (status reverted, revertedBy, revertedAt, revertReason), sale }. 404 refund_not_found, 403 revert_not_allowed { reason: not_own | too_old } (staff who are not vendorRole admin: only their own refund, on the EAT day they made it), 409 already_reverted { revertedAt }, 409 sale_voided, 409 customer_archived { customerId } (restore the customer first), 409 insufficient_stock { productId, variant|null, available } (restocked units sold since; nothing changes), 400 reason_required { min } | reason_too_long { max }. An undo by staff notifies the vendor account (vendor_refund_reverted). ${STAFF}`,
  requestSample: { reason: 'Refunded the wrong sale' },
  onGuard: guards('post'),
  onRequest: async (req, res) => {
    if (!vendorRefundsOn()) return disabled(res);
    const result = await vendorRefundService.revertRefund({
      vendorId: vendorOf(req.user), actorId: req.user.sub, refundId: req.params.id, body: req.body || {}, refundsAny: await refundsAny(req.user),
    });
    if (result.error) return send(res, result);
    res.json({ refund: result.refund, sale: await sale(req, result.sale) });
  },
};

export const vendorListRefunds = {
  created, method: 'get', path: '/vendor/refunds',
  description: `Vendor / staff with \`sales\` (${READ_FLAGS}): refunds of my walk-in sales, newest first (refund time desc, id desc). Query: from, to (EAT days YYYY-MM-DD, inclusive, on the refund time), saleId, status (active | reverted | all; default all), limit (default 50, capped at 200), cursor. → { refunds:[{ id, number, status, refundedAt, revertedAt|null, saleId, saleNumber, amountTzs, paidOutTzs, balanceReducedTzs, method|null, restockedUnits, createdBy { id, name } }], nextCursor|null }. 400 invalid_date { field } | invalid_status | invalid_limit | invalid_cursor. ${STAFF}`,
  onGuard: guards('get'),
  onRequest: async (req, res) => {
    if (!vendorWalkInSalesOn()) return disabled(res);
    const result = await vendorRefundService.listRefunds({ vendorId: vendorOf(req.user), query: req.query || {} });
    if (result.error) return send(res, result);
    res.json(result);
  },
};

export const vendorGetRefund = {
  created, method: 'get', path: '/vendor/refunds/:id',
  description: `Vendor / staff with \`sales\` (${READ_FLAGS}): one refund → { refund } ${REFUND_SHAPE} 404 refund_not_found (unknown or another vendor's). ${STAFF}`,
  onGuard: guards('get'),
  onRequest: async (req, res) => {
    if (!vendorWalkInSalesOn()) return disabled(res);
    const result = await vendorRefundService.getRefund({ vendorId: vendorOf(req.user), refundId: req.params.id });
    if (result.error) return send(res, result);
    res.json(result);
  },
};
