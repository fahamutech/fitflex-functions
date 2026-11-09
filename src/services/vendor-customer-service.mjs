// Vendor customers, customer payments, balances and aging (vendor business tools · S4).
//
// Decisions 2026-10-20 (design spec docs/design/vendor-customers-s4.md, all recommendations applied):
// - A-02: a marketplace customer is only buyerUserId (never returned) + a name snapshot. No phone,
//   email or address in any customer response, payment or statement data.
// - O-8: over-payment refused. Q-2: a credit sale with live payment allocations cannot be voided.
// - Q-3: only `customers` records/voids payments. Staff with only `sales` get the POS picker (names,
//   last 3 phone digits, no money) and may quick-add a walk-in customer (name + phone).
// - Q-4: receivedOn ≤ 30 days back. Q-5: no credit limit. Q-6: app customers are created on a paid
//   order (backfilled at deploy) and their name is refreshed on each paid order. Q-7: duplicate phone
//   warns. Q-8: archive only. Q-9: daily overdue digest to the vendor + staff with `customers`.
//
// The routes check the flag (VENDOR_TOOLS + VENDOR_CUSTOMERS) and the permissions before calling in here.
import {
  parseCustomer, parsePayment, paymentFingerprint, parsePaymentVoid, eatToday, pageLimit, decodeOffset, parseClientRef, customerFingerprint,
  CUSTOMER_FILTERS, CUSTOMER_SORTS, AGING_SORTS, AGING_BUCKETS, validDay,
} from '../shared/vendor-customer.mjs';
import { customerView, pickerView } from '../infra/vendor-customer-store-pg.mjs';
import { encodeOrderCursor, decodeOrderCursor } from '../shared/vendor-order-view.mjs';
import { vendorCustomersOn } from '../shared/feature-flags.mjs';

const MAX_QUERY = 80;
const PICKER_FIELDS = ['name', 'phone'];
const forbidden = extra => ({ error: 'vendor_permission_forbidden', status: 403, requiredPermission: 'customers', ...extra });

export function createVendorCustomerService({
  store,
  // S3 sale store (src/infra/vendor-sale-store-pg.mjs) and sale service: a customer's shop sales.
  saleStore,
  saleService,
  // Tell the vendor account something (shopService.notifyVendor). Best effort.
  notifyVendor = async () => {},
  // Push + inbox to one person (partnerNotifier.vendorEvent). Best effort.
  notifyPerson = async () => {},
  customersOn = vendorCustomersOn,
  now = () => new Date(),
}) {
  const today = () => eatToday(now());

  /** The list row for staff with `customers`: no buyerUserId; phone only on walk-in customers. */
  const listRow = r => ({
    id: r.id, source: r.source, name: r.name ?? null, phone: r.source === 'manual' ? r.phone ?? null : null,
    archived: r.archivedAt != null, forgotten: r.forgottenAt != null, lastPurchaseAt: r.lastPurchaseAt,
    owedTzs: r.owedTzs, overdueTzs: r.overdueTzs, oldestDueDate: r.oldestDueDate, maxDaysOverdue: r.maxDaysOverdue, aging: r.aging,
  });

  /**
   * GET /vendor/customers. `access.customers` false (staff with `sales` only) → picker mode: names and
   * phone endings, no money, no archived customers; filters/sorts about money → 403.
   */
  async function listCustomers({ vendorId, access, query = {} }) {
    const q = typeof query.q === 'string' ? query.q.trim() : '';
    if (q.length > MAX_QUERY) return { error: 'invalid_query', status: 400, max: MAX_QUERY };
    const filter = query.filter == null || query.filter === '' ? 'all' : String(query.filter);
    if (!CUSTOMER_FILTERS.includes(filter)) return { error: 'invalid_filter', status: 400, allowed: CUSTOMER_FILTERS };
    const sort = query.sort == null || query.sort === '' ? 'name' : String(query.sort);
    if (!CUSTOMER_SORTS.includes(sort)) return { error: 'invalid_sort', status: 400, allowed: CUSTOMER_SORTS };
    const bucket = query.bucket == null || query.bucket === '' ? null : String(query.bucket);
    if (bucket && !AGING_BUCKETS.includes(bucket)) return { error: 'invalid_bucket', status: 400, allowed: AGING_BUCKETS };
    const limit = pageLimit(query.limit);
    if (limit.error) return limit;
    const offset = query.cursor ? decodeOffset(query.cursor) : 0;
    if (offset == null) return { error: 'invalid_cursor', status: 400 };
    if (!access.customers) {
      // POS picker (staff with `sales` only): never money, never archived customers.
      if (!['all', 'manual', 'marketplace'].includes(filter) || bucket) return forbidden({ field: bucket ? 'bucket' : 'filter' });
      if (!['name', 'recent'].includes(sort)) return forbidden({ field: 'sort' });
      // Phone search: the start of the number, ≥ 7 digits (review #224 L7).
      const out = await store.list({ vendorId, today: today(), q: q || null, filter, sort, limit, offset, phoneSearch: 'prefix7' });
      return { customers: out.rows.map(pickerView), nextCursor: out.nextCursor };
    }
    const out = await store.list({ vendorId, today: today(), q: q || null, filter, bucket, sort, limit, offset });
    return { customers: out.rows.map(listRow), nextCursor: out.nextCursor, asOf: today() };
  }

  /**
   * POST /vendor/customers: a walk-in customer. Staff with `sales` only: name + phone; answer in picker
   * shape. Optional clientRef: a retry returns the customer already created (status 200).
   */
  async function createCustomer({ vendorId, actorId, access, body }) {
    const { clientRef, ...rest } = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const ref = parseClientRef(clientRef);
    if (ref.error) return ref;
    const parsed = parseCustomer(rest, { fields: access.customers ? null : PICKER_FIELDS });
    if (parsed.error) return parsed;
    const out = await store.create({ vendorId, actorId, fields: parsed.fields, clientRef: ref.clientRef, fingerprint: customerFingerprint(parsed.fields) });
    if (out.error) return out;
    return {
      status: out.replayed ? 200 : 201,
      customer: access.customers ? customerView(out.customer) : pickerView(out.customer),
      phoneDuplicate: out.phoneDuplicate,
    };
  }

  /** GET /vendor/customers/:id → the profile. Another vendor's customer → 404. */
  async function getCustomer({ vendorId, customerId }) {
    const asOf = today();
    const p = await store.profile(vendorId, customerId, asOf);
    if (!p) return { error: 'customer_not_found', status: 404 };
    return {
      customer: {
        ...customerView(p.customer),
        lastPurchaseAt: p.totals.lastPurchaseAt,
        totals: p.totals,
        owedTzs: p.money.owedTzs, overdueTzs: p.money.overdueTzs, oldestDueDate: p.money.oldestDueDate, maxDaysOverdue: p.money.maxDaysOverdue,
        aging: p.money.aging, asOf, openSales: p.openSales,
      },
    };
  }

  /** PUT /vendor/customers/:id. App customers: only note and archived. */
  async function updateCustomer({ vendorId, customerId, actorId, body }) {
    const row = await store.get(vendorId, customerId);
    if (!row) return { error: 'customer_not_found', status: 404 };
    const parsed = parseCustomer(body || {}, { partial: true, source: row.source });
    if (parsed.error) return parsed;
    const out = await store.update({
      vendorId, customerId, actorId, fields: parsed.fields, archived: parsed.archived, expectUpdatedAt: parsed.expectUpdatedAt, today: today(),
    });
    if (out.error) return out;
    return { customer: customerView(out.customer), phoneDuplicate: out.phoneDuplicate };
  }

  const exists = async (vendorId, customerId) => !!(await store.get(vendorId, customerId));

  /** GET /vendor/customers/:id/sales: the S3 sales list, of this customer only. */
  async function customerSales({ vendorId, actorId, customerId, query = {} }) {
    if (!(await exists(vendorId, customerId))) return { error: 'customer_not_found', status: 404 };
    return saleService.listSales({ vendorId, actorId, query: { ...query, customerId } });
  }
  /** GET /vendor/customers/:id/sales/:saleId: one sale of this customer (full S3 sale view). */
  async function customerSale({ vendorId, customerId, saleId }) {
    if (!(await exists(vendorId, customerId))) return { error: 'customer_not_found', status: 404 };
    const sale = await saleStore.get(vendorId, saleId, { customerId });
    return sale ? { sale } : { error: 'sale_not_found', status: 404 };
  }

  /** GET /vendor/customers/:id/orders: paid app orders of this customer with this vendor (own part, no contact details). */
  async function customerOrders({ vendorId, customerId, query = {} }) {
    const limit = pageLimit(query.limit);
    if (limit.error) return limit;
    let after = null;
    if (query.cursor) {
      after = decodeOrderCursor(query.cursor);
      if (!after) return { error: 'invalid_cursor', status: 400 };
    }
    const out = await store.ordersOf(vendorId, customerId, { limit, after });
    if (!out) return { error: 'customer_not_found', status: 404 };
    return { orders: out.orders, nextCursor: out.more ? encodeOrderCursor(out.last) : null };
  }

  /** The buyer behind ?customerId= on GET /vendor/orders. null → 404 customer_not_found. */
  const buyerOf = (vendorId, customerId) => store.buyerOf(vendorId, customerId);

  // ── payments ──────────────────────────────────────────────────────────────

  async function listPayments({ vendorId, customerId, query = {} }) {
    if (!(await exists(vendorId, customerId))) return { error: 'customer_not_found', status: 404 };
    const limit = pageLimit(query.limit);
    if (limit.error) return limit;
    let from = null;
    if (query.from != null && query.from !== '') {
      from = validDay(String(query.from));
      if (!from) return { error: 'invalid_date', status: 400, field: 'from' };
    }
    let beforeSeq = null;
    if (query.cursor) {
      beforeSeq = Number(Buffer.from(String(query.cursor), 'base64url').toString('utf8'));
      if (!Number.isInteger(beforeSeq) || beforeSeq < 1) return { error: 'invalid_cursor', status: 400 };
    }
    const out = await store.listPayments({ vendorId, customerId, from, limit, beforeSeq });
    return { payments: out.payments, nextCursor: out.more ? Buffer.from(String(out.lastSeq)).toString('base64url') : null };
  }

  async function getPayment({ vendorId, customerId, paymentId }) {
    const payment = await store.getPayment(vendorId, customerId, paymentId);
    return payment ? { payment } : { error: 'payment_not_found', status: 404 };
  }

  /** POST /vendor/customers/:id/payments → { payment, customer: { owedTzs, overdueTzs, aging, … }, status: 201 | 200 replay }. */
  async function recordPayment({ vendorId, customerId, actorId, body }) {
    const asOf = today();
    const payment = parsePayment(body || {}, { today: asOf });
    if (payment.error) return payment;
    const fingerprint = paymentFingerprint(customerId, payment);
    const out = await store.recordPayment({ vendorId, customerId, actorId, payment, fingerprint, today: asOf });
    if (out.error) return out;
    if (out.payment.customerId !== customerId) return { error: 'client_ref_reused', status: 409 };
    return { payment: out.payment, customer: { ...out.customer, asOf }, status: out.replayed ? 200 : 201 };
  }

  /**
   * POST /vendor/customers/:id/payments/:paymentId/void { reason }. Review #224 M2 (the S3 sale rule):
   * `voidsAny` (the vendor account, staff with vendorRole admin) may void any payment; other `customers`
   * staff only a payment they recorded, on the EAT day of its receivedOn → else 403 void_not_allowed
   * { reason: not_own | too_old }. A void by staff is reported to the vendor account.
   */
  async function voidPayment({ vendorId, customerId, paymentId, actorId, body, voidsAny = false }) {
    const parsed = parsePaymentVoid(body || {});
    if (parsed.error) return parsed;
    const asOf = today();
    const canVoid = (p) => {
      if (voidsAny) return null;
      if (p.recordedBy !== actorId) return { error: 'void_not_allowed', status: 403, reason: 'not_own' };
      if (p.receivedOn !== asOf) return { error: 'void_not_allowed', status: 403, reason: 'too_old' };
      return null;
    };
    const out = await store.voidPayment({ vendorId, customerId, paymentId, actorId, reason: parsed.reason, today: asOf, canVoid });
    if (out.error) return out;
    if (actorId !== vendorId) {
      try {
        await notifyVendor(vendorId, 'vendor_customer_payment_voided', {
          customerId, paymentId: out.payment.id, number: out.payment.number, amountTzs: out.payment.amountTzs,
          voidedByName: out.payment.voidedBy?.name ?? null, reason: out.payment.voidReason,
        });
      } catch (err) { console.warn('[vendor-customers] payment void notification failed:', err?.message); }
    }
    return { payment: out.payment, customer: { ...out.customer, asOf } };
  }

  /** GET /vendor/receivables/aging?bucket&sort&limit&cursor. */
  async function aging({ vendorId, query = {} }) {
    const bucket = query.bucket == null || query.bucket === '' ? null : String(query.bucket);
    if (bucket && !AGING_BUCKETS.includes(bucket)) return { error: 'invalid_bucket', status: 400, allowed: AGING_BUCKETS };
    const sort = query.sort == null || query.sort === '' ? 'overdue' : String(query.sort);
    if (!AGING_SORTS.includes(sort)) return { error: 'invalid_sort', status: 400, allowed: AGING_SORTS };
    const limit = pageLimit(query.limit);
    if (limit.error) return limit;
    const offset = query.cursor ? decodeOffset(query.cursor) : 0;
    if (offset == null) return { error: 'invalid_cursor', status: 400 };
    const asOf = today();
    return { asOf, ...(await store.aging({ vendorId, today: asOf, bucket, sort, limit, offset })) };
  }

  /** The buyer deleted their FitFlex account (account deletion, review #224 H1). A failure fails the deletion: it rolls back and can be retried. */
  async function forgetBuyer(userId, options = {}) {
    try { return await store.forgetBuyer(userId, options); } catch (err) {
      console.warn('[vendor-customers] deleted buyer not forgotten', { error: err?.message });
      throw err;
    }
  }

  /** A paid app order (shop service hook): make or refresh the app customer at each vendor. Never fails the order. */
  async function marketplaceOrderPaid(order) {
    try { return await store.marketplaceOrderPaid(order); } catch (err) {
      console.warn('[vendor-customers] app customer not recorded for order', order?.id, err?.message);
      return { customers: 0, error: err?.message };
    }
  }

  /**
   * Daily 09:00 EAT (Q-9): to each vendor with pay-later sales that became overdue today (due yesterday),
   * once per vendor per EAT day, to the vendor account and active staff with `customers`. Never to customers.
   * Off (sends nothing, claims nothing) unless VENDOR_TOOLS + VENDOR_CUSTOMERS.
   */
  async function sendOverdueDigests() {
    if (!customersOn()) return { skipped: 'feature_disabled', vendors: 0, sent: 0 };
    const day = today();
    let sent = 0;
    const claimed = await store.claimOverdueDigests(day);
    for (const d of claimed) {
      const recipients = await store.digestRecipients(d.vendorId);
      for (const userId of recipients) {
        try {
          await notifyPerson(userId, 'vendor_customers_overdue', { count: d.count, totalTzs: d.totalTzs, day });
          sent += 1;
        } catch (err) { console.warn('[vendor-customers] overdue digest not sent', { vendorId: d.vendorId, userId, error: err?.message }); }
      }
      await store.markDigestSent(d.vendorId, day, recipients.length);
    }
    return { day, vendors: claimed.length, sent };
  }

  return {
    listCustomers, createCustomer, getCustomer, updateCustomer, customerSales, customerSale, customerOrders, buyerOf,
    listPayments, getPayment, recordPayment, voidPayment, aging, marketplaceOrderPaid, forgetBuyer, sendOverdueDigests,
  };
}
