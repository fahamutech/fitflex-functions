// Vendor business tools · S9 — suppliers, receiving stock (goods received notes, GRN-000001…) and payables with
// instalments (design spec docs/design/vendor-purchases-s9.md, approved 2026-11-04). RULE 6 AREA: new money
// records, cost-price writes, a new staff permission.
// Every route needs VENDOR_TOOLS + VENDOR_STOCK_LEDGER + VENDOR_PURCHASES — checked FIRST (off → 404
// feature_disabled, before any token check or staff lookup; data is kept and comes back when the flag is on).
// Permission `purchases` (stored staff record; staff of a suspended vendor → 403 vendor_suspended).
// FitFlex moves no money for payables: they are records of what the vendor owes a supplier and what they say they
// paid. No PaymentRequest, no commission, never part of vendor settlement.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { shopService, vendorPurchaseService, users } from '../src/bootstrap/services.mjs';
import { vendorPurchasesOn } from '../src/shared/feature-flags.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { createVendorLimiter, limitOrNull } from '../src/shared/vendor-rate-limit.mjs';
import { voidsAny } from './vendor-sales.mjs';
import { csvDocument } from '../src/shared/csv-export.mjs';
import { reportFileName } from '../src/shared/vendor-reports.mjs';
import { purchasesCsv, payablesCsv, PURCHASES_CSV_MAX_ROWS } from '../src/shared/vendor-purchase.mjs';
import { eatToday } from '../src/shared/vendor-customer.mjs';

const created = new Date().toISOString();

/** The flag first: with any of the three off every request (with or without a token) gets 404 feature_disabled. */
function requirePurchasesOn(req, res, next) {
  if (!vendorPurchasesOn()) return res.status(404).json({ error: 'feature_disabled' });
  return next();
}

/**
 * vendor_staff need `purchases`, read from their stored staff record (active, of the vendor in their token), and
 * their vendor account must not be suspended (S3 pattern, security review M1: fail closed → 403 vendor_suspended).
 * The vendor account itself is already refused while suspended (requireAuth → 403 account_suspended).
 */
export async function requirePurchasesPermission(req, res, next) {
  if (req.user?.userType !== 'vendor_staff') return next();
  let ok;
  let vendor;
  try {
    ok = await shopService.authorizeStaff(req.user, 'purchases');
    vendor = ok ? await users.findByIdAsync(req.user.vendorId) : null;
  } catch (error) {
    console.error('[vendor-purchases] staff authorization lookup failed', { staffId: req.user.sub, error: error.message });
    return res.status(503).json({ error: 'authorization_unavailable' });
  }
  if (!ok) return res.status(403).json({ error: 'vendor_permission_forbidden', requiredPermission: 'purchases' });
  if (!vendor || vendor.userType !== 'vendor' || vendor.accountStatus === 'suspended') return res.status(403).json({ error: 'vendor_suspended' });
  return next();
}

// Writes share one per-vendor limit (spec §2): 120 a minute, in memory per server (S3–S7 pattern). CSV exports
// have their own, tighter limit (S6 pattern).
export const VENDOR_PURCHASES_LIMITS = Object.freeze({ writesPerMinute: 120, exportsPerMinute: 10 });
const writeLimiter = createVendorLimiter({ perMinute: VENDOR_PURCHASES_LIMITS.writesPerMinute });
const exportLimiter = createVendorLimiter({ perMinute: VENDOR_PURCHASES_LIMITS.exportsPerMinute });
export const resetVendorPurchaseLimits = () => { writeLimiter.reset(); exportLimiter.reset(); };

const vendorOf = user => (user.userType === 'vendor_staff' ? user.vendorId : user.sub);
const guards = method => routeGuard(method, [requirePurchasesOn, requireAuth('vendor', 'vendor_staff'), requirePurchasesPermission]);
const send = (res, result) => {
  const { error, status, ...extra } = result;
  return res.status(status).json({ error, ...extra });
};
const limited = (req, res) => limitOrNull(writeLimiter, vendorOf(req.user), res);
const costOf = req => shopService.canSeeCost(req.user);
const setHeader = (res, key, value) => (typeof res.setHeader === 'function' ? res.setHeader(key, value) : res.set?.(key, value));
async function sendCsv(req, res, section, table) {
  const vendor = await users.findByIdAsync(vendorOf(req.user));
  const day = eatToday();
  const file = csvDocument(table.header, table.rows);
  setHeader(res, 'Content-Type', 'text/csv; charset=utf-8');
  setHeader(res, 'Content-Disposition', `attachment; filename="${reportFileName(vendor?.vendorProfile?.businessName, section, day, day, 'csv').replace(/[^A-Za-z0-9._-]/g, '_')}"`);
  setHeader(res, 'Access-Control-Expose-Headers', 'Content-Disposition');
  setHeader(res, 'Cache-Control', 'no-store, private');
  setHeader(res, 'X-Content-Type-Options', 'nosniff');
  return res.status(200).send(file);
}
const csvWanted = req => String(req.query?.format || 'json') === 'csv';
const langOf = req => (req.query?.lang === 'sw' ? 'sw' : 'en');

const FLAGS = 'VENDOR_TOOLS + VENDOR_STOCK_LEDGER + VENDOR_PURCHASES; any off → 404 feature_disabled (checked before sign-in)';
const STAFF = 'Staff without `purchases` → 403 vendor_permission_forbidden { requiredPermission: purchases }; staff of a suspended vendor → 403 vendor_suspended.';
const MONEY = 'FitFlex moves no money: payables are records only (no PaymentRequest, no settlement).';
const RATE = '429 rate_limited { retryAfterSeconds } (writes share 120/min/vendor; Retry-After; nothing changed — retry).';
export const PURCHASE_SHAPE = '{ id, number (GRN-000001, continuous per vendor), status: received|voided, supplier { id, name, archived }|null, receivedOn (YYYY-MM-DD EAT), recordedAt (ISO; when stock moved), supplierInvoiceRef|null, note|null, createdBy { id, name }, totalTzs, paidTzs, balanceTzs (paidTzs + balanceTzs = totalTzs), overdueTzs (0 when voided), paymentState: paid|part_paid|unpaid, nextDue { dueDate, openTzs, daysOverdue }|null, lines:[{ id, productId, variant|null, nameSnapshot, qty, unitCostTzs, lineTotalTzs (qty × unitCostTzs), costUpdated, free (unit cost 0: cost price unchanged), previousCostTzs|null (ONLY for canSeeCost callers: vendor account, vendorRole admin), costRestoredOnVoid: true|false|null }], instalments:[{ id, seq (1-based position in the plan), dueDate, amountTzs, coveredTzs, openTzs, state: paid|part_paid|due|overdue, daysOverdue }] (active plan, in the order payments cover it: oldest due first; after a plan change the paid rows come first), payments:[{ id, amountTzs, paidOn, method, reference|null, note|null, atReceipt, recordedBy { id, name }, recordedAt, status: recorded|voided, voidedBy|null, voidedAt|null, voidReason|null, voidedWithPurchase }] (oldest first), voidedBy { id, name }|null, voidedAt|null, voidReason|null }. Never fingerprint, clientRef or costSourceId.';

// ── suppliers ─────────────────────────────────────────────────────────────────

export const vendorListSuppliers = {
  created, method: 'get', path: '/vendor/suppliers',
  description: `Vendor / staff with \`purchases\` (${FLAGS}): my suppliers. Query: q (≥ 2 chars; matches name, contact person, phone digits), filter active (default) | owing | overdue | archived, sort name (default) | owed | recent, limit (default 50, ≤ 200), cursor. → { suppliers:[{ id, name, phone|null, contactPerson|null, owedTzs, overdueTzs, nextDueDate|null, lastReceivedOn|null, archived }], nextCursor|null }. 400 invalid_filter | invalid_sort | invalid_limit | invalid_cursor. ${STAFF}`,
  onGuard: guards('get'),
  onRequest: async (req, res) => {
    const result = await vendorPurchaseService.listSuppliers({ vendorId: vendorOf(req.user), query: req.query || {} });
    if (result.error) return send(res, result);
    res.json(result);
  },
};

export const vendorCreateSupplier = {
  created, method: 'post', path: '/vendor/suppliers',
  description: `Vendor / staff with \`purchases\` (${FLAGS}): add a supplier. Body { name (2–120), phone? (a Tanzanian number is stored as +255…; another country's as digits, ≤ 20), email?, contactPerson? (≤ 120), address? (≤ 300), tin? (≤ 20), note? (≤ 500) }. → 201 { supplier { id, name, phone, email, contactPerson, address, tin, note, archived, archivedAt, createdAt, updatedAt } }. 400 name_required { min } | name_too_long { max } | invalid_phone | invalid_email | field_too_long { field, max } | invalid_field { field }; 409 duplicate_supplier { supplierId } (an active supplier with that name, case-insensitive). Audited. ${RATE} ${STAFF}`,
  requestSample: { name: 'Juma Supplies', phone: '0712 345 678', contactPerson: 'Juma' },
  onGuard: guards('post'),
  onRequest: async (req, res) => {
    if (limited(req, res)) return undefined;
    const result = await vendorPurchaseService.createSupplier({ vendorId: vendorOf(req.user), actorId: req.user.sub, body: req.body || {} });
    if (result.error) return send(res, result);
    res.status(201).json({ supplier: result.supplier });
  },
};

export const vendorGetSupplier = {
  created, method: 'get', path: '/vendor/suppliers/:id',
  description: `Vendor / staff with \`purchases\` (${FLAGS}): a supplier's profile → { supplier, totals { purchasedTzs, purchaseCount, paidTzs, lastReceivedOn|null } (received purchases only), owedTzs, overdueTzs, aging { current, d1_30, d31_60, d61_90, d90plus }, asOf (EAT day), openInstalments:[{ purchaseId, number, seq, dueDate, openTzs, daysOverdue }] (oldest due first) }. 404 supplier_not_found (unknown or another vendor's). ${STAFF}`,
  onGuard: guards('get'),
  onRequest: async (req, res) => {
    const result = await vendorPurchaseService.getSupplier({ vendorId: vendorOf(req.user), supplierId: req.params.id });
    if (result.error) return send(res, result);
    res.json(result);
  },
};

export const vendorUpdateSupplier = {
  created, method: 'put', path: '/vendor/suppliers/:id',
  description: `Vendor / staff with \`purchases\` (${FLAGS}): edit a supplier (partial: only the fields sent change; null clears an optional field; name cannot be null) and/or archived: true | false. Archiving is refused while the supplier is owed anything → 409 supplier_has_balance { owedTzs }; restoring (or renaming) onto an active supplier's name → 409 duplicate_supplier { supplierId }. → { supplier }. Same 400s as POST; 404 supplier_not_found. Audited (vendor_supplier_updated / _archived / _restored). ${RATE} ${STAFF}`,
  requestSample: { phone: '+255712345678', archived: false },
  onGuard: guards('put'),
  onRequest: async (req, res) => {
    if (limited(req, res)) return undefined;
    const result = await vendorPurchaseService.updateSupplier({ vendorId: vendorOf(req.user), actorId: req.user.sub, supplierId: req.params.id, body: req.body || {} });
    if (result.error) return send(res, result);
    res.json({ supplier: result.supplier });
  },
};

// ── purchases ─────────────────────────────────────────────────────────────────

export const vendorReceiveStock = {
  created, method: 'post', path: '/vendor/purchases',
  description: `Vendor / staff with \`purchases\` (${FLAGS}): receive stock from a supplier (a goods received note). RULE 6: stock rises, the cost price becomes the unit cost (O-9), a payable is recorded. Body { clientRef (8–100 chars [A-Za-z0-9._:-]; reuse it on every retry), supplierId? (required when anything is left owing), receivedOn? (YYYY-MM-DD; default today EAT; up to 30 days back, never future), supplierInvoiceRef? (≤ 60), note? (≤ 200), lines:[{ productId, variant? (required when the product's variants keep stock), qty (1–100000), unitCostTzs (0–100,000,000; 0 = free: stock only, cost price unchanged) }] (1–200, one line per product + variant), paidNow? { amountTzs (0 = nothing paid; ≤ total), method (cash|mpesa|airtel_money|mixx|halopesa|card|bank|other), reference? (≤ 100; required for mpesa, airtel_money, mixx, halopesa, bank) }, dueDate? (one instalment for the rest; default receivedOn + 30) | schedule? [{ dueDate, amountTzs ≥ 1 }] (1–12, adding up to total − paidNow; due dates receivedOn … +365) — not both; both ignored when nothing is left owing }. The server computes every total. Any product of mine that is not deleted or archived (paused / pending / rejected listings too). A line with a unit cost different from the current cost price sets it: the variant's own cost for a variant line, else the product's. → 201 { purchase, costChanges:[{ productId, variant|null, name, fromTzs? (canSeeCost only; null = there was none), toTzs }] } purchase = ${PURCHASE_SHAPE} A replay of the same clientRef with the same body → 200 with the same purchase (answered first). Errors: 400 invalid_client_ref | lines_required | too_many_lines { max } | invalid_line { index, field } | invalid_quantity { index, max } | invalid_cost { index, max } | duplicate_line { productId, variant } | received_on_out_of_range { earliest, latest } | supplier_invoice_ref_too_long { max } | note_too_long { max } | total_too_large { max } | invalid_payment { field } | invalid_method | reference_required { method } | reference_too_long { max } | invalid_field { field } | invalid_schedule { reason: count|amount|date } | due_date_out_of_range { earliest, latest }; 404 supplier_not_found; 409 supplier_archived { supplierId }; 404 product_not_found { productId } (unknown, deleted, another vendor's); 400 product_unavailable { productId } (archived) | variant_required { productId, variants }; 404 variant_not_found { productId, variant, variants }; 400 overpayment { totalTzs } | supplier_required | schedule_mismatch { expectedTzs, scheduledTzs }; 409 client_ref_reused. ${RATE} ${MONEY} ${STAFF}`,
  requestSample: {
    clientRef: '7a1c2b9e-5a1d-4e0b-9a51-7c1f3b2d9e10', supplierId: 'vsp_0123456789abcdef', receivedOn: '2026-11-03', supplierInvoiceRef: 'INV-4471',
    lines: [{ productId: 'prd_x', variant: 'Chocolate', qty: 10, unitCostTzs: 9500 }],
    paidNow: { amountTzs: 45000, method: 'cash' }, schedule: [{ dueDate: '2026-12-03', amountTzs: 50000 }],
  },
  onGuard: guards('post'),
  onRequest: async (req, res) => {
    if (limited(req, res)) return undefined;
    const result = await vendorPurchaseService.receive({ vendorId: vendorOf(req.user), actorId: req.user.sub, body: req.body || {}, canSeeCost: await costOf(req) });
    if (result.error) return send(res, result);
    if (result.status === 200) res.set?.('Idempotent-Replay', 'true');
    res.status(result.status).json({ purchase: result.purchase, costChanges: result.costChanges });
  },
};

export const vendorListPurchases = {
  created, method: 'get', path: '/vendor/purchases',
  description: `Vendor / staff with \`purchases\` (${FLAGS}): my purchases (GRNs), newest first (receivedOn desc, number desc). Query: from, to (EAT days on receivedOn, inclusive), supplierId, status received | voided | all (default all), payment open | overdue | paid | all (open / overdue / paid are received purchases only), createdBy=me, limit (default 50, ≤ 200), cursor, format json | csv (csv: every row up to ${PURCHASES_CSV_MAX_ROWS}, headers in lang en|sw, money "(TZS)", formula-injection safe; 10 exports a minute per vendor). → { purchases:[{ id, number, status, receivedOn, recordedAt, supplier { id, name }|null, totalTzs, paidTzs, balanceTzs, overdueTzs, paymentState, nextDueDate|null, lineCount, units, createdBy { id, name } }], nextCursor|null, summary { count, totalTzs, paidTzs, balanceTzs, units } (received purchases over the whole filter, not the page or the status filter) }. 400 invalid_date { field } | invalid_status | invalid_payment_filter | invalid_created_by | invalid_limit | invalid_cursor. ${STAFF}`,
  onGuard: guards('get'),
  onRequest: async (req, res) => {
    if (csvWanted(req)) {
      if (limitOrNull(exportLimiter, vendorOf(req.user), res)) return undefined;
      const result = await vendorPurchaseService.listPurchases({ vendorId: vendorOf(req.user), actorId: req.user.sub, query: req.query || {}, all: true, maxRows: PURCHASES_CSV_MAX_ROWS });
      if (result.error) return send(res, result);
      return sendCsv(req, res, 'purchases', purchasesCsv(result.purchases, langOf(req)));
    }
    const result = await vendorPurchaseService.listPurchases({ vendorId: vendorOf(req.user), actorId: req.user.sub, query: req.query || {} });
    if (result.error) return send(res, result);
    res.json(result);
  },
};

const lastCostsHandler = async (req, res) => {
  const result = await vendorPurchaseService.lastCosts({ vendorId: vendorOf(req.user), query: req.query || {} });
  if (result.error) return send(res, result);
  return res.json(result);
};

export const vendorPurchaseLastCosts = {
  created, method: 'get', path: '/vendor/purchases/last-costs',
  description: `Vendor / staff with \`purchases\` (${FLAGS}): the last purchase cost per product + variant (Receive stock prefill and hint; Q-1: visible to \`purchases\`). Query productIds=a,b (≤ 100). → { rows:[{ productId, variant|null, unitCostTzs, receivedOn, supplierName|null, number }] } — the latest non-voided, non-free line of each. 400 too_many_products { max }. ${STAFF}`,
  onGuard: guards('get'),
  onRequest: lastCostsHandler,
};

export const vendorGetPurchase = {
  created, method: 'get', path: '/vendor/purchases/:id',
  description: `Vendor / staff with \`purchases\` (${FLAGS}): one purchase → { purchase } ${PURCHASE_SHAPE} 404 purchase_not_found (unknown or another vendor's). ${STAFF}`,
  onGuard: guards('get'),
  // If this route is matched before /last-costs, answer it here (same guard, same answer).
  onRequest: async (req, res) => {
    if (req.params.id === 'last-costs') return lastCostsHandler(req, res);
    const result = await vendorPurchaseService.getPurchase({ vendorId: vendorOf(req.user), purchaseId: req.params.id, canSeeCost: await costOf(req) });
    if (result.error) return send(res, result);
    return res.json(result);
  },
};

export const vendorVoidPurchase = {
  created, method: 'post', path: '/vendor/purchases/:id/void',
  description: `Vendor / staff with \`purchases\` (${FLAGS}): void a whole purchase. RULE 6. Body { reason (3–200) }. All or nothing: every line's units must still be in stock (stock >= qty, and the variant's own), else 409 insufficient_stock { lines:[{ productId, variant|null, name, receivedQty, available }] } (every short line; nothing changes). Units leave once (ledger stock_in_void). A cost price this purchase set is put back where nothing changed it since (else kept). Its payments are voided with it (get any money back from the supplier yourself). The GRN number is kept; nothing counts as owed. → { purchase, costRestored:[{ productId, variant|null, name }], costKept:[…], paymentsVoided }. 404 purchase_not_found; 403 void_not_allowed { reason: not_own | too_old } (staff who are not vendorRole admin: only a purchase they recorded, on the EAT day they recorded it; checked first); 409 void_not_allowed { reason: has_others_payments } (those staff also cannot void a purchase carrying recorded payments that someone else recorded — the void would take them along; security review #327 L-2); 409 already_voided { voidedAt } (a retry of a void that went through: treat as done); 400 reason_required { min } | reason_too_long { max }. A void by staff notifies the vendor account (vendor_purchase_voided). ${RATE} ${STAFF}`,
  requestSample: { reason: 'Wrong delivery recorded' },
  onGuard: guards('post'),
  onRequest: async (req, res) => {
    if (limited(req, res)) return undefined;
    const result = await vendorPurchaseService.voidPurchase({
      vendorId: vendorOf(req.user), actorId: req.user.sub, purchaseId: req.params.id, body: req.body || {}, voidsAny: await voidsAny(req.user), canSeeCost: await costOf(req),
    });
    if (result.error) return send(res, result);
    res.json(result);
  },
};

export const vendorRecordPurchasePayment = {
  created, method: 'post', path: '/vendor/purchases/:id/payments',
  description: `Vendor / staff with \`purchases\` (${FLAGS}): record a payment I made to the supplier. RULE 6. Body { clientRef (8–100 chars [A-Za-z0-9._:-], not ending in ':paid' — reserved for the payment at receipt → 400 invalid_client_ref), amountTzs (≥ 1, ≤ balance), paidOn? (YYYY-MM-DD; receivedOn … today EAT; default today), method, reference? (required for mpesa, airtel_money, mixx, halopesa, bank), note? (≤ 200) }. Covers instalments oldest due first. → 201 { purchase, payment, covered:[{ seq, dueDate, amountTzs }] } (replay of the same clientRef → 200). 404 purchase_not_found; 409 purchase_voided | nothing_owed | overpayment { balanceTzs } | client_ref_reused; 400 invalid_amount | invalid_method | reference_required { method } | reference_too_long { max } | note_too_long { max } | paid_on_out_of_range { earliest, latest } | invalid_client_ref. ${RATE} ${MONEY} ${STAFF}`,
  requestSample: { clientRef: '8b2d3c0f-6b2e-4f1c-8b62-8d2a4c3e0f21', amountTzs: 70000, method: 'mpesa', reference: 'QK12AB34' },
  onGuard: guards('post'),
  onRequest: async (req, res) => {
    if (limited(req, res)) return undefined;
    const result = await vendorPurchaseService.recordPayment({ vendorId: vendorOf(req.user), actorId: req.user.sub, purchaseId: req.params.id, body: req.body || {}, canSeeCost: await costOf(req) });
    if (result.error) return send(res, result);
    if (result.status === 200) res.set?.('Idempotent-Replay', 'true');
    res.status(result.status).json({ purchase: result.purchase, payment: result.payment, covered: result.covered });
  },
};

export const vendorVoidPurchasePayment = {
  created, method: 'post', path: '/vendor/purchases/:id/payments/:paymentId/void',
  description: `Vendor / staff with \`purchases\` (${FLAGS}): void a supplier payment recorded by mistake. RULE 6. Body { reason (3–200) }. The amount is owed again; the earliest instalments reopen first, with their own due dates. → { purchase }. 404 payment_not_found; 403 void_not_allowed { reason: not_own | too_old } (on the payment's recordedBy / its EAT day; checked first); 409 already_voided { voidedAt } | purchase_voided | supplier_required (a purchase without a supplier cannot be left owing: void the whole purchase) | supplier_archived { supplierId } (restore the supplier first: an archived supplier is owed nothing); 400 reason_required | reason_too_long. A void by staff notifies the vendor account (vendor_purchase_payment_voided). ${RATE} ${STAFF}`,
  requestSample: { reason: 'Recorded twice' },
  onGuard: guards('post'),
  onRequest: async (req, res) => {
    if (limited(req, res)) return undefined;
    const result = await vendorPurchaseService.voidPayment({
      vendorId: vendorOf(req.user), actorId: req.user.sub, purchaseId: req.params.id, paymentId: req.params.paymentId, body: req.body || {},
      voidsAny: await voidsAny(req.user), canSeeCost: await costOf(req),
    });
    if (result.error) return send(res, result);
    res.json(result);
  },
};

export const vendorChangePurchasePlan = {
  created, method: 'put', path: '/vendor/purchases/:id/instalments',
  description: `Vendor / staff with \`purchases\` (${FLAGS}): change the instalment plan for what is still owed (no money moves; audited vendor_purchase_plan_changed). Body { schedule:[{ dueDate, amountTzs ≥ 1 }] (1–12; adding up to balanceTzs; due dates today EAT … receivedOn + 365) }. Paid instalments stay; a partly paid one keeps its paid part (same due date); the rest is replaced (kept as history). → { purchase }. 404 purchase_not_found; 409 purchase_voided | nothing_owed; 400 invalid_schedule { reason: count|amount|date } | schedule_mismatch { expectedTzs (= balanceTzs), scheduledTzs } | due_date_out_of_range { earliest, latest }. ${RATE} ${STAFF}`,
  requestSample: { schedule: [{ dueDate: '2026-12-15', amountTzs: 75000 }, { dueDate: '2027-01-15', amountTzs: 75000 }] },
  onGuard: guards('put'),
  onRequest: async (req, res) => {
    if (limited(req, res)) return undefined;
    const result = await vendorPurchaseService.changePlan({ vendorId: vendorOf(req.user), actorId: req.user.sub, purchaseId: req.params.id, body: req.body || {}, canSeeCost: await costOf(req) });
    if (result.error) return send(res, result);
    res.json(result);
  },
};

// ── payables ──────────────────────────────────────────────────────────────────

export const vendorPayablesAging = {
  created, method: 'get', path: '/vendor/payables/aging',
  description: `Vendor / staff with \`purchases\` (${FLAGS}): what I owe suppliers, by age. Per open instalment of a received purchase: daysOverdue = EAT today − dueDate; ≤ 0 not due yet (due today = not due yet), 1–30, 31–60, 61–90, ≥ 91. Query: bucket current|d1_30|d31_60|d61_90|d90plus (rows owing in it), sort overdue (default: most overdue first) | owed | name, limit, cursor, format json | csv (lang en|sw). → { asOf, totals { owedTzs, overdueTzs, supplierCount, overdueSupplierCount, dueIn7DaysTzs, current, d1_30, d31_60, d61_90, d90plus } (all suppliers, not the filter or page), rows:[{ supplierId, name, owedTzs, overdueTzs, oldestDueDate, maxDaysOverdue, current, d1_30, d31_60, d61_90, d90plus }], nextCursor|null }. 400 invalid_bucket | invalid_sort | invalid_limit | invalid_cursor. ${MONEY} ${STAFF}`,
  onGuard: guards('get'),
  onRequest: async (req, res) => {
    if (csvWanted(req)) {
      if (limitOrNull(exportLimiter, vendorOf(req.user), res)) return undefined;
      const result = await vendorPurchaseService.aging({ vendorId: vendorOf(req.user), query: req.query || {}, all: true, maxRows: PURCHASES_CSV_MAX_ROWS });
      if (result.error) return send(res, result);
      return sendCsv(req, res, 'payables', payablesCsv(result, langOf(req)));
    }
    const result = await vendorPurchaseService.aging({ vendorId: vendorOf(req.user), query: req.query || {} });
    if (result.error) return send(res, result);
    res.json(result);
  },
};
