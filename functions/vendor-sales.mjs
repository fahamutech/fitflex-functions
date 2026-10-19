// Vendor business tools · S3 — walk-in (counter) sales: POS record, history, detail, void.
// Dormant: VENDOR_TOOLS + VENDOR_WALKIN_SALES (off → 404 feature_disabled). Permission `sales`.
// Walk-in money never passes through FitFlex: no commission, no ShopOrder, no PaymentRequest,
// never part of vendor settlement or /vendor/payments.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { shopService, vendorSaleService, users } from '../src/bootstrap/services.mjs';
import { vendorWalkInSalesOn } from '../src/shared/feature-flags.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';

const created = new Date().toISOString();

/**
 * vendor_staff need `sales`, read from their stored staff record (active, of the vendor in their token),
 * and their vendor account must not be suspended (security review M1: fail closed → 403 vendor_suspended).
 * The vendor account itself is already refused while suspended (requireAuth → 403 account_suspended).
 */
async function requireSalesPermission(req, res, next) {
  if (req.user?.userType !== 'vendor_staff') return next();
  let ok;
  let vendor;
  try {
    ok = await shopService.authorizeStaff(req.user, 'sales');
    vendor = ok ? await users.findByIdAsync(req.user.vendorId) : null;
  } catch (error) {
    console.error('[vendor-sales] staff authorization lookup failed', { staffId: req.user.sub, error: error.message });
    return res.status(503).json({ error: 'authorization_unavailable' });
  }
  if (!ok) return res.status(403).json({ error: 'vendor_permission_forbidden', requiredPermission: 'sales' });
  if (!vendor || vendor.userType !== 'vendor' || vendor.accountStatus === 'suspended') return res.status(403).json({ error: 'vendor_suspended' });
  return next();
}

// Security review L5: sales recorded per vendor per minute, in memory per server (the pattern of
// GET /shop/home, functions/shop-home.mjs): with several servers the real allowance is servers × this.
// A device syncing its offline queue sends one sale at a time, far below it.
export const VENDOR_SALES_LIMIT = Object.freeze({ perMinute: 120, maxTracked: 5000 });
const windows = new Map(); // vendorId → { count, resetAt }
export function allowVendorSale(vendorId, nowMs = Date.now()) {
  let w = windows.get(vendorId);
  if (!w || w.resetAt <= nowMs) {
    if (windows.size >= VENDOR_SALES_LIMIT.maxTracked) for (const [k, v] of windows) if (v.resetAt <= nowMs) windows.delete(k);
    w = { count: 0, resetAt: nowMs + 60_000 };
    windows.set(vendorId, w);
  }
  if (w.count >= VENDOR_SALES_LIMIT.perMinute) return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((w.resetAt - nowMs) / 1000)) };
  w.count += 1;
  return { ok: true };
}
export const resetVendorSalesLimits = () => windows.clear();

/** M2: the vendor account and vendorRole admin staff (stored record) may void any sale of the vendor. */
async function voidsAny(user) {
  if (user.userType === 'vendor') return true;
  const staff = await users.findByIdAsync(user.sub);
  return staff?.userType === 'vendor_staff' && staff.vendorId === user.vendorId && staff.accountStatus === 'active' && staff.vendorRole === 'admin';
}
const guards = method => routeGuard(method, [requireAuth('vendor', 'vendor_staff'), requireSalesPermission]);
// The vendor account acts for itself; staff for the vendor their (checked) staff record belongs to.
const vendorOf = user => (user.userType === 'vendor_staff' ? user.vendorId : user.sub);
const send = (res, result) => {
  const { error, status, ...extra } = result;
  return res.status(status).json({ error, ...extra });
};
const disabled = res => res.status(404).json({ error: 'feature_disabled' });

const SALE_SHAPE = '{ id, number (R-000001, continuous per vendor), status: completed|voided, kind: cash, soldAt, clientSoldAt (the soldAt the device sent when it was ahead of the server, else null), recordedAt (when it reached FitFlex), lateRecorded (recordedAt − soldAt > 5 min), clientRef, subtotalTzs (Σ qty × unitPriceTzs, before discounts), lineDiscountTzs (Σ line discounts), discountTzs (sale discount), totalTzs (= subtotal − line discounts − sale discount), paidTzs, changeTzs, note|null, createdBy {id,name}, voidedBy {id,name}|null, voidedAt|null, voidReason|null, lines:[{ id, productId, variant|null, nameSnapshot, qty, listPriceTzs (the shop\'s walk-in price: discount price if set, else price), unitPriceTzs (charged), priceChanged, priceChangedBy {id,name}|null, discountTzs (for the whole line), lineTotalTzs (qty × unitPriceTzs − discountTzs) }], payments:[{ method, amountTzs, reference|null }] }. Never unitCostTzs.';

export const vendorRecordSale = {
  created, method: 'post', path: '/vendor/sales',
  description: `Vendor / staff with \`sales\` (VENDOR_TOOLS + VENDOR_WALKIN_SALES; off → 404 feature_disabled): record a walk-in sale. Body { clientRef (8–100 chars [A-Za-z0-9._:-]; reuse it on every retry), soldAt? (ISO; default now — send it only for a sale recorded offline; 7 days past … 24 hours future; a future value is clamped to the server's now and kept as clientSoldAt), lines:[{ productId, variant? (required when the product's variants keep stock), qty (1–1000), unitPriceTzs? (only when the seller changed the price; ≥ 1), discountTzs? (for the whole line) }] (1–100), discountTzs? (whole sale, after line discounts), payments:[{ method: cash|mpesa|airtel_money|mixx|halopesa|card|bank|other, amountTzs (≥ 1), reference? (≤ 100; required for mpesa, airtel_money, mixx, halopesa, bank) }] (0–10; [] only when the total is 0), note? (≤ 200) }. Any product of the vendor that is not archived may be sold (paused, pending or rejected listings too). Price = the product's discount price when set, else its price, unless unitPriceTzs is sent (audited). Stock leaves the same pool as app orders. → 201 { sale } ${SALE_SHAPE} A replayed clientRef with the same body → 200 with the same sale. Errors: 409 insufficient_stock { productId, variant|null, available } (nothing recorded), 409 payment_short { totalTzs, paidTzs, shortTzs }, 409 client_ref_reused (same clientRef, different body), 400 reference_required { index, method }, 400 invalid_payment { index?, field?, reason?: non_cash_over_total | nothing_to_pay | too_many | paid_too_large { max } | change_too_large { maxChangeTzs = totalTzs + 1,000,000 } }, 400 discount_exceeds_price { productId?, variant?, maxTzs }, 400 product_unavailable { productId } (archived), 400 sold_at_out_of_range { earliest, latest }, 400 variant_required { productId, variants }, 400 invalid_client_ref | lines_required | too_many_lines | invalid_line { index, field? } | invalid_quantity { index } | invalid_price | invalid_discount | invalid_field { field } | note_too_long | total_too_large, 404 product_not_found { productId } (unknown, deleted or another vendor's), 404 variant_not_found { productId, variant, variants }, 403 vendor_permission_forbidden, 403 vendor_suspended (staff of a suspended vendor), 429 rate_limited { retryAfterSeconds } (more than 120 sales a minute for the vendor; header Retry-After; nothing recorded — retry with the same clientRef). No commission, no ShopOrder, no PaymentRequest, not in settlement.`,
  requestSample: {
    clientRef: '3b0c8f6e-2c1a-4c55-9a51-7c1f3b2d9e10', soldAt: '2026-10-19T14:05:00+03:00',
    lines: [{ productId: 'prd_x', variant: 'Chocolate', qty: 2, discountTzs: 5000 }, { productId: 'prd_y', qty: 1 }],
    payments: [{ method: 'cash', amountTzs: 60000 }, { method: 'mpesa', amountTzs: 40000, reference: 'QK12AB34' }],
  },
  onGuard: guards('post'),
  onRequest: async (req, res) => {
    if (!vendorWalkInSalesOn()) return disabled(res);
    const allowed = allowVendorSale(vendorOf(req.user));
    if (!allowed.ok) {
      res.set?.('Retry-After', String(allowed.retryAfterSeconds));
      return res.status(429).json({ error: 'rate_limited', retryAfterSeconds: allowed.retryAfterSeconds });
    }
    const result = await vendorSaleService.recordSale({ vendorId: vendorOf(req.user), actorId: req.user.sub, body: req.body || {} });
    if (result.error) return send(res, result);
    if (result.status === 200) res.set?.('Idempotent-Replay', 'true');
    res.status(result.status).json({ sale: result.sale });
  },
};

export const vendorListSales = {
  created, method: 'get', path: '/vendor/sales',
  description: 'Vendor / staff with `sales` (VENDOR_TOOLS + VENDOR_WALKIN_SALES; off → 404 feature_disabled): every walk-in sale of the vendor (whoever recorded it), newest first (soldAt desc, id desc). Query: from, to (EAT days YYYY-MM-DD, inclusive, on soldAt; optional), status (completed | voided | all; default all), createdBy=me (only sales I recorded), limit (≥ 1, default 50, capped at 200), cursor (the previous page\'s nextCursor). → { sales:[{ id, number, soldAt, recordedAt, lateRecorded, status, totalTzs, discountTzs (line discounts + sale discount), hasOverride (a line sold at another price than the shop\'s), itemCount (Σ qty), methods[] (distinct, in payment order), createdBy {id,name} }], nextCursor|null, summary { count (completed), totalTzs (completed), voidedCount, discountTzs (completed: line + sale discounts), overrideCount (completed sales with a changed price), lateCount (all sales in the range, voided too, recorded > 5 min after soldAt), byMethod:[{ method, amountTzs }] (completed; cash net of change, so the methods add up to totalTzs) } } — the summary covers the whole from/to/createdBy range (not the page, not the status filter). 400 invalid_date { field } | invalid_status | invalid_created_by | invalid_limit | invalid_cursor. Staff of a suspended vendor → 403 vendor_suspended.',
  onGuard: guards('get'),
  onRequest: async (req, res) => {
    if (!vendorWalkInSalesOn()) return disabled(res);
    const result = await vendorSaleService.listSales({ vendorId: vendorOf(req.user), actorId: req.user.sub, query: req.query || {} });
    if (result.error) return send(res, result);
    res.json(result);
  },
};

export const vendorGetSale = {
  created, method: 'get', path: '/vendor/sales/:id',
  description: `Vendor / staff with \`sales\` (VENDOR_TOOLS + VENDOR_WALKIN_SALES; off → 404 feature_disabled): one walk-in sale → { sale } ${SALE_SHAPE} Another vendor's sale or an unknown id → 404 sale_not_found. Staff of a suspended vendor → 403 vendor_suspended.`,
  onGuard: guards('get'),
  onRequest: async (req, res) => {
    if (!vendorWalkInSalesOn()) return disabled(res);
    const result = await vendorSaleService.getSale({ vendorId: vendorOf(req.user), saleId: req.params.id });
    if (result.error) return send(res, result);
    res.json({ sale: result.sale });
  },
};

export const vendorVoidSale = {
  created, method: 'post', path: '/vendor/sales/:id/void',
  description: 'Vendor / staff with `sales` (VENDOR_TOOLS + VENDOR_WALKIN_SALES; off → 404 feature_disabled): void a completed walk-in sale (audited as vendor_sale_voided). The vendor account and staff with vendorRole admin may void any sale; other staff only a sale they recorded, on the EAT day it was sold (soldAt) → else 403 void_not_allowed { reason: not_own | too_old } (checked before already_voided). A void by staff is reported to the vendor account (notification vendor_sale_voided { saleId, number }, EN/SW). Body { reason (3–200 chars) }. Staff of a suspended vendor → 403 vendor_suspended. Every unit goes back to stock exactly once (stock history reason sale_void). FitFlex refunds nothing: the vendor gives any money back. → { sale } (status voided, voidedBy, voidedAt, voidReason). 409 already_voided { voidedAt }, 400 reason_required { min } | reason_too_long { max }, 404 sale_not_found.',
  requestSample: { reason: 'Customer returned the item the same day' },
  onGuard: guards('post'),
  onRequest: async (req, res) => {
    if (!vendorWalkInSalesOn()) return disabled(res);
    const result = await vendorSaleService.voidSale({
      vendorId: vendorOf(req.user), actorId: req.user.sub, saleId: req.params.id, body: req.body || {}, voidsAny: await voidsAny(req.user),
    });
    if (result.error) return send(res, result);
    res.json({ sale: result.sale });
  },
};
