// Vendor business tools · S3 — walk-in (counter) sales: POS record, history, detail, void.
// Dormant: VENDOR_TOOLS + VENDOR_WALKIN_SALES (off → 404 feature_disabled). Permission `sales`.
// Walk-in money never passes through FitFlex: no commission, no ShopOrder, no PaymentRequest,
// never part of vendor settlement or /vendor/payments.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { shopService, vendorSaleService } from '../src/bootstrap/services.mjs';
import { vendorWalkInSalesOn } from '../src/shared/feature-flags.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';

const created = new Date().toISOString();

/** vendor_staff need `sales`, read from their stored staff record (active, of the vendor in their token). */
function requireSalesPermission(req, res, next) {
  if (req.user?.userType !== 'vendor_staff') return next();
  return shopService.authorizeStaff(req.user, 'sales').then(
    ok => (ok ? next() : res.status(403).json({ error: 'vendor_permission_forbidden', requiredPermission: 'sales' })),
    (error) => {
      console.error('[vendor-sales] staff authorization lookup failed', { staffId: req.user.sub, error: error.message });
      return res.status(503).json({ error: 'authorization_unavailable' });
    },
  );
}
const guards = method => routeGuard(method, [requireAuth('vendor', 'vendor_staff'), requireSalesPermission]);
// The vendor account acts for itself; staff for the vendor their (checked) staff record belongs to.
const vendorOf = user => (user.userType === 'vendor_staff' ? user.vendorId : user.sub);
const send = (res, result) => {
  const { error, status, ...extra } = result;
  return res.status(status).json({ error, ...extra });
};
const disabled = res => res.status(404).json({ error: 'feature_disabled' });

const SALE_SHAPE = '{ id, number (R-000001, continuous per vendor), status: completed|voided, kind: cash, soldAt, recordedAt (when it reached FitFlex), clientRef, subtotalTzs (Σ qty × unitPriceTzs, before discounts), lineDiscountTzs (Σ line discounts), discountTzs (sale discount), totalTzs (= subtotal − line discounts − sale discount), paidTzs, changeTzs, note|null, createdBy {id,name}, voidedBy {id,name}|null, voidedAt|null, voidReason|null, lines:[{ id, productId, variant|null, nameSnapshot, qty, listPriceTzs (the shop\'s walk-in price: discount price if set, else price), unitPriceTzs (charged), priceChanged, priceChangedBy {id,name}|null, discountTzs (for the whole line), lineTotalTzs (qty × unitPriceTzs − discountTzs) }], payments:[{ method, amountTzs, reference|null }] }. Never unitCostTzs.';

export const vendorRecordSale = {
  created, method: 'post', path: '/vendor/sales',
  description: `Vendor / staff with \`sales\` (VENDOR_TOOLS + VENDOR_WALKIN_SALES; off → 404 feature_disabled): record a walk-in sale. Body { clientRef (8–100 chars [A-Za-z0-9._:-]; reuse it on every retry), soldAt? (ISO; default now; 7 days past … 5 minutes future), lines:[{ productId, variant? (required when the product's variants keep stock), qty (1–1000), unitPriceTzs? (only when the seller changed the price; ≥ 1), discountTzs? (for the whole line) }] (1–100), discountTzs? (whole sale, after line discounts), payments:[{ method: cash|mpesa|airtel_money|mixx|halopesa|card|bank|other, amountTzs (≥ 1), reference? (≤ 100; required for mpesa, airtel_money, mixx, halopesa, bank) }] (0–10; [] only when the total is 0), note? (≤ 200) }. Any product of the vendor that is not archived may be sold (paused, pending or rejected listings too). Price = the product's discount price when set, else its price, unless unitPriceTzs is sent (audited). Stock leaves the same pool as app orders. → 201 { sale } ${SALE_SHAPE} A replayed clientRef with the same body → 200 with the same sale. Errors: 409 insufficient_stock { productId, variant|null, available } (nothing recorded), 409 payment_short { totalTzs, paidTzs, shortTzs }, 409 client_ref_reused (same clientRef, different body), 400 reference_required { index, method }, 400 invalid_payment { index?, field?, reason?: non_cash_over_total | nothing_to_pay | too_many }, 400 discount_exceeds_price { productId?, variant?, maxTzs }, 400 product_unavailable { productId } (archived), 400 sold_at_out_of_range { earliest, latest }, 400 variant_required { productId, variants }, 400 invalid_client_ref | lines_required | too_many_lines | invalid_line { index, field? } | invalid_quantity { index } | invalid_price | invalid_discount | invalid_field { field } | note_too_long | total_too_large, 404 product_not_found { productId } (unknown, deleted or another vendor's), 404 variant_not_found { productId, variant, variants }, 403 vendor_permission_forbidden. No commission, no ShopOrder, no PaymentRequest, not in settlement.`,
  requestSample: {
    clientRef: '3b0c8f6e-2c1a-4c55-9a51-7c1f3b2d9e10', soldAt: '2026-10-19T14:05:00+03:00',
    lines: [{ productId: 'prd_x', variant: 'Chocolate', qty: 2, discountTzs: 5000 }, { productId: 'prd_y', qty: 1 }],
    payments: [{ method: 'cash', amountTzs: 60000 }, { method: 'mpesa', amountTzs: 40000, reference: 'QK12AB34' }],
  },
  onGuard: guards('post'),
  onRequest: async (req, res) => {
    if (!vendorWalkInSalesOn()) return disabled(res);
    const result = await vendorSaleService.recordSale({ vendorId: vendorOf(req.user), actorId: req.user.sub, body: req.body || {} });
    if (result.error) return send(res, result);
    if (result.status === 200) res.set?.('Idempotent-Replay', 'true');
    res.status(result.status).json({ sale: result.sale });
  },
};

export const vendorListSales = {
  created, method: 'get', path: '/vendor/sales',
  description: 'Vendor / staff with `sales` (VENDOR_TOOLS + VENDOR_WALKIN_SALES; off → 404 feature_disabled): every walk-in sale of the vendor (whoever recorded it), newest first (soldAt desc, id desc). Query: from, to (EAT days YYYY-MM-DD, inclusive, on soldAt; optional), status (completed | voided | all; default all), createdBy=me (only sales I recorded), limit (≥ 1, default 50, capped at 200), cursor (the previous page\'s nextCursor). → { sales:[{ id, number, soldAt, recordedAt, status, totalTzs, itemCount (Σ qty), methods[] (distinct, in payment order), createdBy {id,name} }], nextCursor|null, summary { count (completed), totalTzs (completed), voidedCount, byMethod:[{ method, amountTzs }] (completed; cash net of change, so the methods add up to totalTzs) } } — the summary covers the whole from/to/createdBy range (not the page, not the status filter). 400 invalid_date { field } | invalid_status | invalid_created_by | invalid_limit | invalid_cursor.',
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
  description: `Vendor / staff with \`sales\` (VENDOR_TOOLS + VENDOR_WALKIN_SALES; off → 404 feature_disabled): one walk-in sale → { sale } ${SALE_SHAPE} Another vendor's sale or an unknown id → 404 sale_not_found.`,
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
  description: 'Vendor / staff with `sales` (VENDOR_TOOLS + VENDOR_WALKIN_SALES; off → 404 feature_disabled): void a completed walk-in sale (any sale of the vendor, whoever recorded it; audited as vendor_sale_voided). Body { reason (3–200 chars) }. Every unit goes back to stock exactly once (stock history reason sale_void). FitFlex refunds nothing: the vendor gives any money back. → { sale } (status voided, voidedBy, voidedAt, voidReason). 409 already_voided { voidedAt }, 400 reason_required { min } | reason_too_long { max }, 404 sale_not_found.',
  requestSample: { reason: 'Customer returned the item the same day' },
  onGuard: guards('post'),
  onRequest: async (req, res) => {
    if (!vendorWalkInSalesOn()) return disabled(res);
    const result = await vendorSaleService.voidSale({ vendorId: vendorOf(req.user), actorId: req.user.sub, saleId: req.params.id, body: req.body || {} });
    if (result.error) return send(res, result);
    res.json({ sale: result.sale });
  },
};
