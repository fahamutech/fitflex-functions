// Vendor business tools · S4 — vendor customers, pay-later balances, customer payments, aging.
// Dormant: VENDOR_TOOLS + VENDOR_CUSTOMERS (off → 404 feature_disabled). Permission `customers`;
// the POS picker and quick-add also accept `sales` (no money in their answers).
// Money never passes through FitFlex: payments recorded here were received by the vendor directly;
// none of it is in vendor settlement, commission or /vendor/payments.
// A-02: an app (marketplace) customer is only a name snapshot here — never phone, email, address or user id.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { shopService, vendorCustomerService, users } from '../src/bootstrap/services.mjs';
import { vendorCustomersOn } from '../src/shared/feature-flags.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';

const created = new Date().toISOString();

/**
 * vendor_staff need one of `permissions` (read from their stored, active staff record of the vendor in
 * their token), and their vendor account must not be suspended (as S3: 403 vendor_suspended).
 * Sets req.vendorAccess = { customers, sales } for the handlers (the vendor account has both).
 */
function requireVendorAccess(...permissions) {
  return async (req, res, next) => {
    if (req.user?.userType !== 'vendor_staff') {
      req.vendorAccess = { customers: true, sales: true };
      return next();
    }
    let access;
    let vendor = null;
    try {
      access = {
        customers: await shopService.authorizeStaff(req.user, 'customers'),
        sales: await shopService.authorizeStaff(req.user, 'sales'),
      };
      if (permissions.some(p => access[p])) vendor = await users.findByIdAsync(req.user.vendorId);
    } catch (error) {
      console.error('[vendor-customers] staff authorization lookup failed', { staffId: req.user.sub, error: error.message });
      return res.status(503).json({ error: 'authorization_unavailable' });
    }
    if (!permissions.some(p => access[p])) {
      return res.status(403).json({ error: 'vendor_permission_forbidden', requiredPermission: permissions[0], ...(permissions.length > 1 ? { acceptedPermissions: permissions } : {}) });
    }
    if (!vendor || vendor.userType !== 'vendor' || vendor.accountStatus === 'suspended') return res.status(403).json({ error: 'vendor_suspended' });
    req.vendorAccess = access;
    return next();
  };
}
const guards = (method, ...permissions) => routeGuard(method, [requireAuth('vendor', 'vendor_staff'), requireVendorAccess(...permissions)]);
const vendorOf = user => (user.userType === 'vendor_staff' ? user.vendorId : user.sub);
const send = (res, result) => {
  const { error, status, ...extra } = result;
  return res.status(status).json({ error, ...extra });
};
const disabled = res => res.status(404).json({ error: 'feature_disabled' });
const FLAG = 'VENDOR_TOOLS + VENDOR_CUSTOMERS; off → 404 feature_disabled';
const STAFF = 'Staff of a suspended vendor → 403 vendor_suspended; staff without the permission → 403 vendor_permission_forbidden.';

const AGING = 'aging { current (not due yet; due today counts here), d1_30, d31_60, d61_90, d90plus } — daysOverdue = EAT today − dueDate (day boundary 00:00 EAT)';
const MONEY = `owedTzs, overdueTzs (balance of sales past their due date), oldestDueDate|null (YYYY-MM-DD), maxDaysOverdue (0 when nothing overdue), ${AGING}`;
const CUSTOMER = '{ id, source: manual (walk-in, owned by the vendor) | marketplace (app buyer), name|null (app customers: their FitFlex name, may be null), phone|null (+255…; walk-in only), email|null (walk-in only), address|null (walk-in only), note|null, archived, archivedAt|null, createdAt, updatedAt } — an app customer never has phone, email, address or user id (A-02)';
const PAYMENT = '{ id, number (PMT-000001, continuous per vendor), customerId, status: recorded|voided, amountTzs, method, reference|null, receivedOn (EAT day), note|null, clientRef, recordedAt, recordedBy {id,name}, allocations:[{ saleId, saleNumber, amountTzs }], voidedAt|null, voidedBy {id,name}|null, voidReason|null }';

export const vendorCustomersList = {
  created, method: 'get', path: '/vendor/customers',
  description: `Vendor / staff with \`customers\`, or staff with \`sales\` only for the POS picker (${FLAG}). Query: q (name, or ≥ 3 phone digits — walk-in customers only; ≤ 80 chars), filter all (not archived; default) | owes | overdue | manual | marketplace | archived, bucket current|d1_30|d31_60|d61_90|d90plus (customers with money in it), sort name (A–Z, default) | owed | overdue (most days overdue first) | recent (last purchase), limit (1–200, default 50), cursor (nextCursor). With \`customers\` → { customers:[{ id, source, name|null, phone|null (walk-in only), archived, lastPurchaseAt|null (latest shop sale or paid app order), ${MONEY} }], nextCursor|null, asOf (EAT day) }. Staff with \`sales\` only → { customers:[{ id, source, name|null, phoneLast3|null }], nextCursor|null } — never amounts, never archived customers; filter only all|manual|marketplace, sort only name|recent, no bucket (else 403 vendor_permission_forbidden { requiredPermission: customers, field }). 400 invalid_query { max } | invalid_filter | invalid_sort | invalid_bucket | invalid_limit | invalid_cursor. ${STAFF}`,
  onGuard: guards('get', 'customers', 'sales'),
  onRequest: async (req, res) => {
    if (!vendorCustomersOn()) return disabled(res);
    const result = await vendorCustomerService.listCustomers({ vendorId: vendorOf(req.user), access: req.vendorAccess, query: req.query || {} });
    if (result.error) return send(res, result);
    res.json(result);
  },
};

export const vendorCustomersCreate = {
  created, method: 'post', path: '/vendor/customers',
  description: `Vendor / staff with \`customers\` or \`sales\` (${FLAG}): add a walk-in customer. Body { name (2–80), phone? (Tanzanian mobile: 07…, 06…, 7…, +255…; stored +255XXXXXXXXX), email?, address? (≤ 200), note? (≤ 500) }. Staff with \`sales\` only: name and phone only (others → 403 vendor_permission_forbidden { requiredPermission: customers, field }). → 201 { customer, phoneDuplicate: { id, name }|null } (customer = ${CUSTOMER}; for \`sales\`-only staff the picker shape { id, source, name, phoneLast3 }). A phone another customer of the vendor already has is saved anyway and reported in phoneDuplicate (Q-7). 400 name_invalid { min, max } | phone_invalid | email_invalid | address_too_long { max } | note_too_long { max } | invalid_field { field } | invalid_body. ${STAFF}`,
  requestSample: { name: 'Juma Mussa', phone: '0712345678', note: 'Buys protein every month' },
  onGuard: guards('post', 'customers', 'sales'),
  onRequest: async (req, res) => {
    if (!vendorCustomersOn()) return disabled(res);
    const result = await vendorCustomerService.createCustomer({ vendorId: vendorOf(req.user), actorId: req.user.sub, access: req.vendorAccess, body: req.body || {} });
    if (result.error) return send(res, result);
    res.status(201).json(result);
  },
};

export const vendorCustomerGet = {
  created, method: 'get', path: '/vendor/customers/:id',
  description: `Vendor / staff with \`customers\` (${FLAG}): one customer's profile → { customer: ${CUSTOMER} + { lastPurchaseAt|null, totals { shopSalesTzs, shopSalesCount (completed walk-in sales, cash and pay later), appOrdersTzs, appOrdersCount (my own lines of paid app orders, not cancelled or refunded), lastPurchaseAt|null }, ${MONEY}, asOf (EAT day), openSales:[{ id, number, soldAt, dueDate, totalTzs, balanceTzs, daysOverdue (0 when not yet due), overdue }] (oldest due first) } }. Another vendor's customer or an unknown id → 404 customer_not_found. ${STAFF}`,
  onGuard: guards('get', 'customers'),
  onRequest: async (req, res) => {
    if (!vendorCustomersOn()) return disabled(res);
    const result = await vendorCustomerService.getCustomer({ vendorId: vendorOf(req.user), customerId: req.params.id });
    if (result.error) return send(res, result);
    res.json(result);
  },
};

export const vendorCustomerUpdate = {
  created, method: 'put', path: '/vendor/customers/:id',
  description: `Vendor / staff with \`customers\` (${FLAG}): edit, archive or restore a customer. Body (only the fields sent change) { name?, phone?, email?, address?, note?, archived?: boolean, updatedAt? (the customer's updatedAt you loaded → 409 customer_changed { updatedAt } when someone else saved first) }. App customers: only note and archived (others → 400 field_not_editable { field }). Archiving a customer who owes money → 409 customer_has_balance { owedTzs }. Nothing is ever deleted (Q-8). → { customer, phoneDuplicate|null }. Same 400s as POST. 404 customer_not_found. ${STAFF}`,
  requestSample: { note: 'Pays at month end', updatedAt: '2026-10-20T08:00:00.000Z' },
  onGuard: guards('put', 'customers'),
  onRequest: async (req, res) => {
    if (!vendorCustomersOn()) return disabled(res);
    const result = await vendorCustomerService.updateCustomer({ vendorId: vendorOf(req.user), customerId: req.params.id, actorId: req.user.sub, body: req.body || {} });
    if (result.error) return send(res, result);
    res.json(result);
  },
};

export const vendorCustomerSales = {
  created, method: 'get', path: '/vendor/customers/:id/sales',
  description: `Vendor / staff with \`customers\` (${FLAG}; works with walk-in sales off too): this customer's walk-in sales, in the GET /vendor/sales shape (same query: from, to, status, kind cash|credit|all, createdBy=me, limit, cursor; rows include kind, balanceTzs, dueDate, customer {id,name}). 404 customer_not_found. ${STAFF}`,
  onGuard: guards('get', 'customers'),
  onRequest: async (req, res) => {
    if (!vendorCustomersOn()) return disabled(res);
    const result = await vendorCustomerService.customerSales({ vendorId: vendorOf(req.user), actorId: req.user.sub, customerId: req.params.id, query: req.query || {} });
    if (result.error) return send(res, result);
    res.json(result);
  },
};

export const vendorCustomerSale = {
  created, method: 'get', path: '/vendor/customers/:id/sales/:saleId',
  description: `Vendor / staff with \`customers\` (${FLAG}): one walk-in sale of this customer → { sale } (the GET /vendor/sales/:id shape). A sale of another customer or vendor → 404 sale_not_found; unknown customer → 404 customer_not_found. ${STAFF}`,
  onGuard: guards('get', 'customers'),
  onRequest: async (req, res) => {
    if (!vendorCustomersOn()) return disabled(res);
    const result = await vendorCustomerService.customerSale({ vendorId: vendorOf(req.user), customerId: req.params.id, saleId: req.params.saleId });
    if (result.error) return send(res, result);
    res.json(result);
  },
};

export const vendorCustomerOrders = {
  created, method: 'get', path: '/vendor/customers/:id/orders',
  description: `Vendor / staff with \`customers\` (${FLAG}): this app customer's paid app orders with me (paid, refund pending or refunded), newest first → { orders:[{ id, shortRef, createdAt, status (my part), orderStatus, tab: open|delivered|cancelled, paymentStatus, totalTzs (my lines), itemCount }], nextCursor|null }. Never contact details, never other vendors' lines. A walk-in customer → { orders: [], nextCursor: null }. Query limit (1–200, default 50), cursor. 404 customer_not_found. ${STAFF}`,
  onGuard: guards('get', 'customers'),
  onRequest: async (req, res) => {
    if (!vendorCustomersOn()) return disabled(res);
    const result = await vendorCustomerService.customerOrders({ vendorId: vendorOf(req.user), customerId: req.params.id, query: req.query || {} });
    if (result.error) return send(res, result);
    res.json(result);
  },
};

export const vendorCustomerPayments = {
  created, method: 'get', path: '/vendor/customers/:id/payments',
  description: `Vendor / staff with \`customers\` (${FLAG}): this customer's payments, newest first (voided ones too) → { payments:[${PAYMENT}], nextCursor|null }. Query from (EAT day: receivedOn ≥ from; the statement uses today − 90), limit (1–200, default 50), cursor. 400 invalid_date | invalid_limit | invalid_cursor; 404 customer_not_found. ${STAFF}`,
  onGuard: guards('get', 'customers'),
  onRequest: async (req, res) => {
    if (!vendorCustomersOn()) return disabled(res);
    const result = await vendorCustomerService.listPayments({ vendorId: vendorOf(req.user), customerId: req.params.id, query: req.query || {} });
    if (result.error) return send(res, result);
    res.json(result);
  },
};

export const vendorCustomerRecordPayment = {
  created, method: 'post', path: '/vendor/customers/:id/payments',
  description: `Vendor / staff with \`customers\` (${FLAG}; \`sales\` alone is not enough — Q-3): record money this customer paid towards pay-later sales. FitFlex never holds it. Body { clientRef (8–100 chars [A-Za-z0-9._:-]; reuse it on every retry), amountTzs (≥ 1, ≤ what is owed), method: cash|mpesa|airtel_money|mixx|halopesa|card|bank|other (one per payment), reference? (≤ 100; required for mpesa, airtel_money, mixx, halopesa, bank; ignored for cash), receivedOn? (EAT day YYYY-MM-DD, today … 30 days back; default today), note? (≤ 200), allocations?: [{ saleId, amountTzs }] (manual; must add up to amountTzs, each ≤ that sale's balance; omitted → oldest due first) }. → 201 { payment: ${PAYMENT}, customer: { ${MONEY}, asOf } }; a replay (same clientRef, same body) → 200 with the same payment. Errors: 409 overpayment { owedTzs } (more than owed; nothing recorded — O-8, no customer credit), 409 allocation_stale { saleId, balanceTzs } (a chosen sale was paid or voided meanwhile), 409 customer_archived, 409 client_ref_reused, 400 allocation_mismatch { amountTzs, allocatedTzs } | invalid_allocation { index?, field?, reason? } | reference_required { method } | invalid_payment { field } | received_on_invalid { earliest, latest } | note_too_long | invalid_client_ref | invalid_body, 404 customer_not_found. ${STAFF}`,
  requestSample: { clientRef: '0b7f4c2e-9a1d-4f6b-8c3e-2d5a7e9f1b20', amountTzs: 25000, method: 'mpesa', reference: 'QK12AB34', receivedOn: '2026-10-20' },
  onGuard: guards('post', 'customers'),
  onRequest: async (req, res) => {
    if (!vendorCustomersOn()) return disabled(res);
    const result = await vendorCustomerService.recordPayment({ vendorId: vendorOf(req.user), customerId: req.params.id, actorId: req.user.sub, body: req.body || {} });
    if (result.error) return send(res, result);
    if (result.status === 200) res.set?.('Idempotent-Replay', 'true');
    res.status(result.status).json({ payment: result.payment, customer: result.customer });
  },
};

export const vendorCustomerPayment = {
  created, method: 'get', path: '/vendor/customers/:id/payments/:paymentId',
  description: `Vendor / staff with \`customers\` (${FLAG}): one payment of this customer → { payment: ${PAYMENT} }. 404 payment_not_found (unknown, another customer's or another vendor's). ${STAFF}`,
  onGuard: guards('get', 'customers'),
  onRequest: async (req, res) => {
    if (!vendorCustomersOn()) return disabled(res);
    const result = await vendorCustomerService.getPayment({ vendorId: vendorOf(req.user), customerId: req.params.id, paymentId: req.params.paymentId });
    if (result.error) return send(res, result);
    res.json(result);
  },
};

export const vendorCustomerVoidPayment = {
  created, method: 'post', path: '/vendor/customers/:id/payments/:paymentId/void',
  description: `Vendor / staff with \`customers\` (${FLAG}): void a payment (audited as vendor_customer_payment_voided). Body { reason (3–200) }. Its allocations are reversed: the sales it paid owe again. The payment stays listed as voided with who, when and why. A void by staff is reported to the vendor account (notification vendor_customer_payment_voided { customerId, paymentId, number }, EN/SW). → { payment, customer: { ${MONEY}, asOf } }. 409 already_voided { voidedAt }, 400 reason_required { min } | reason_too_long { max }, 404 customer_not_found | payment_not_found. ${STAFF}`,
  requestSample: { reason: 'Recorded against the wrong customer' },
  onGuard: guards('post', 'customers'),
  onRequest: async (req, res) => {
    if (!vendorCustomersOn()) return disabled(res);
    const result = await vendorCustomerService.voidPayment({ vendorId: vendorOf(req.user), customerId: req.params.id, paymentId: req.params.paymentId, actorId: req.user.sub, body: req.body || {} });
    if (result.error) return send(res, result);
    res.json(result);
  },
};

export const vendorReceivablesAging = {
  created, method: 'get', path: '/vendor/receivables/aging',
  description: `Vendor / staff with \`customers\` (${FLAG}): "Owed to you" — pay-later sales only (app orders never appear: they are paid through FitFlex). → { asOf (EAT day), totals { owedTzs, overdueTzs, customerCount, overdueCustomerCount, openSaleCount, overdueSaleCount, current, d1_30, d31_60, d61_90, d90plus } (over every customer who owes, not the bucket filter or the page), rows:[{ customerId, name|null, source, owedTzs, overdueTzs, oldestDueDate, maxDaysOverdue, openSaleCount, overdueSaleCount, current, d1_30, d31_60, d61_90, d90plus }], nextCursor|null }. ${AGING}. Query bucket (customers with money in it), sort overdue (default: most days overdue, then most owed) | owed | name, limit (1–200, default 50), cursor. 400 invalid_bucket | invalid_sort | invalid_limit | invalid_cursor. ${STAFF}`,
  onGuard: guards('get', 'customers'),
  onRequest: async (req, res) => {
    if (!vendorCustomersOn()) return disabled(res);
    const result = await vendorCustomerService.aging({ vendorId: vendorOf(req.user), query: req.query || {} });
    if (result.error) return send(res, result);
    res.json(result);
  },
};
