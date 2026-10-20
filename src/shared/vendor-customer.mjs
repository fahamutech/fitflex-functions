// Vendor customers, pay-later sales, customer payments and aging (vendor business tools · S4).
// Pure functions: no storage. Decisions 2026-10-20 (design spec docs/design/vendor-customers-s4.md):
// - O-8: a payment larger than what the customer owes is refused (no customer credit balance).
// - Q-3: only `customers` records and voids customer payments. Pay later needs `sales` AND `customers`.
// - Q-4: a payment's receivedOn may be up to 30 EAT days back, never in the future.
// - Q-5: no credit limit. Q-10: default due date = the sale's EAT day + 7.
// - Aging (§10.2): daysOverdue = EAT today − dueDate; ≤ 0 not due yet (due today = not due yet),
//   1–30, 31–60, 61–90, ≥ 91. Day boundary 00:00 EAT (21:00 UTC). Plain YYYY-MM-DD arithmetic, so
//   the result depends only on the EAT day passed in, never on the server's time zone.
import { createHash } from 'node:crypto';
import { PAYMENT_METHODS, REFERENCE_REQUIRED, MAX_REFERENCE, MAX_SALE_TZS, VOID_REASON } from './vendor-sale.mjs';
import { eatDate } from './vendor-order-view.mjs';

export const NAME = { min: 2, max: 80 };
export const MAX_EMAIL = 254;
export const MAX_ADDRESS = 200;
export const MAX_CUSTOMER_NOTE = 500;
export const MAX_PAYMENT_NOTE = 200;
export const MAX_ALLOCATIONS = 100;
export const RECEIVED_ON_BACK_DAYS = 30;
export const DUE_DATE_MAX_DAYS = 365;
export const DEFAULT_DUE_DAYS = 7;
export const CUSTOMERS_PAGE_DEFAULT = 50;
export const CUSTOMERS_PAGE_MAX = 200;
export const STATEMENT_PAYMENT_DAYS = 90;
export const PAYMENT_DOC_TYPE = 'customer_payment';
export const paymentNumber = seq => `PMT-${String(seq).padStart(6, '0')}`;
export const AGING_BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90plus'];
export const CUSTOMER_FILTERS = ['all', 'owes', 'overdue', 'manual', 'marketplace', 'archived'];
export const CUSTOMER_SORTS = ['name', 'owed', 'overdue', 'recent'];
export const AGING_SORTS = ['overdue', 'owed', 'name'];

const CLIENT_REF = /^[A-Za-z0-9._:-]{8,100}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY_MS = 86_400_000;
const fail = (error, status, extra = {}) => ({ error, status, ...extra });

/** A real calendar day YYYY-MM-DD, else null. */
export function validDay(value) {
  if (typeof value !== 'string' || !DAY.test(value)) return null;
  const t = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== value ? null : value;
}
/** day + n days (YYYY-MM-DD). */
export const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
/** a − b in whole days (YYYY-MM-DD each). */
export const daysBetween = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS);
/** The EAT calendar day of an instant (default now). */
export const eatToday = (now = new Date()) => eatDate(now);

/** Aging bucket of an open sale (§10.2). */
export function agingBucket(daysOverdue) {
  if (daysOverdue <= 0) return 'current';
  if (daysOverdue <= 30) return 'd1_30';
  if (daysOverdue <= 60) return 'd31_60';
  if (daysOverdue <= 90) return 'd61_90';
  return 'd90plus';
}

/**
 * Tanzanian phone → +255XXXXXXXXX (mobile: 6… or 7… after the country code). Accepts 07…, 06…,
 * 7…, 6…, 255…, +255…, with spaces, dashes, dots or brackets. Anything else → null.
 */
export function normalisePhone(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/[\s\-().]/g, '');
  let local = null;
  if (/^\+255\d{9}$/.test(s)) local = s.slice(4);
  else if (/^255\d{9}$/.test(s)) local = s.slice(3);
  else if (/^0\d{9}$/.test(s)) local = s.slice(1);
  else if (/^\d{9}$/.test(s)) local = s;
  return local && /^[67]\d{8}$/.test(local) ? `+255${local}` : null;
}
/** The last 3 digits of a stored phone (the POS picker for staff without `customers`). */
export const phoneLast3 = phone => (typeof phone === 'string' && phone.length >= 3 ? phone.slice(-3) : null);

const text = (body, field) => (typeof body[field] === 'string' ? body[field].trim() : body[field]);

/**
 * POST /vendor/customers and PUT /vendor/customers/:id bodies.
 * @param body
 * @param opts.partial  PUT: only the fields sent are changed
 * @param opts.source   'manual' | 'marketplace' (PUT on an app customer: only note and archived)
 * @param opts.fields   the fields this caller may send (staff with only `sales`: name, phone)
 * → { error, status, ... } or { fields: { name?, phone?, email?, address?, note? }, archived?: boolean, expectUpdatedAt?: string }
 */
export function parseCustomer(body, { partial = false, source = 'manual', fields = null } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid_body', 400);
  const editable = source === 'marketplace' ? ['note'] : ['name', 'phone', 'email', 'address', 'note'];
  const out = {};
  for (const field of ['name', 'phone', 'email', 'address', 'note']) {
    if (!(field in body) || (partial && body[field] === undefined)) continue;
    if (!editable.includes(field)) return fail('field_not_editable', 400, { field });
    if (fields && !fields.includes(field) && body[field] != null && body[field] !== '') {
      return fail('vendor_permission_forbidden', 403, { requiredPermission: 'customers', field });
    }
    const value = text(body, field);
    if (value != null && typeof value !== 'string') return fail('invalid_field', 400, { field });
    out[field] = value === '' || value == null ? null : value;
  }
  if (partial && 'archived' in body && typeof body.archived !== 'boolean') return fail('invalid_field', 400, { field: 'archived' });
  if (!partial && 'archived' in body) return fail('invalid_field', 400, { field: 'archived' });

  if (!partial || 'name' in out) {
    if (!out.name || out.name.length < NAME.min || out.name.length > NAME.max) return fail('name_invalid', 400, { min: NAME.min, max: NAME.max });
  }
  if (out.phone != null) {
    const phone = normalisePhone(out.phone);
    if (!phone) return fail('phone_invalid', 400);
    out.phone = phone;
  }
  if (out.email != null && (out.email.length > MAX_EMAIL || !EMAIL.test(out.email))) return fail('email_invalid', 400);
  if (out.email != null) out.email = out.email.toLowerCase();
  if (out.address != null && out.address.length > MAX_ADDRESS) return fail('address_too_long', 400, { max: MAX_ADDRESS });
  if (out.note != null && out.note.length > MAX_CUSTOMER_NOTE) return fail('note_too_long', 400, { max: MAX_CUSTOMER_NOTE });

  let expectUpdatedAt = null;
  if (partial && body.updatedAt != null) {
    if (typeof body.updatedAt !== 'string' || Number.isNaN(Date.parse(body.updatedAt))) return fail('invalid_field', 400, { field: 'updatedAt' });
    expectUpdatedAt = new Date(body.updatedAt).toISOString();
  }
  return { fields: out, ...(partial && typeof body.archived === 'boolean' ? { archived: body.archived } : {}), expectUpdatedAt };
}

/**
 * POST /vendor/customers/:id/payments body. `today` = the EAT day now.
 * → { error, status, ... } or { clientRef, amountTzs, method, reference, receivedOn, note, allocations: [{ saleId, amountTzs }] | null }
 */
export function parsePayment(body, { today }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid_body', 400);
  if (typeof body.clientRef !== 'string' || !CLIENT_REF.test(body.clientRef)) return fail('invalid_client_ref', 400);
  if (!Number.isInteger(body.amountTzs) || body.amountTzs < 1 || body.amountTzs > MAX_SALE_TZS) return fail('invalid_payment', 400, { field: 'amountTzs' });
  if (!PAYMENT_METHODS.includes(body.method)) return fail('invalid_payment', 400, { field: 'method', allowed: PAYMENT_METHODS });
  if (body.method !== 'cash' && body.reference != null && typeof body.reference !== 'string') return fail('invalid_payment', 400, { field: 'reference' });
  const reference = body.method !== 'cash' && typeof body.reference === 'string' && body.reference.trim() ? body.reference.trim() : null;
  if (reference && reference.length > MAX_REFERENCE) return fail('invalid_payment', 400, { field: 'reference', max: MAX_REFERENCE });
  if (REFERENCE_REQUIRED.has(body.method) && !reference) return fail('reference_required', 400, { method: body.method });

  const earliest = addDays(today, -RECEIVED_ON_BACK_DAYS);
  let receivedOn = today;
  // The raw input (null when absent) is what the fingerprint uses, so a retry that crosses 00:00 EAT
  // (its default "today" moved) still replays (review #224 L6).
  const receivedOnInput = body.receivedOn == null || body.receivedOn === '' ? null : body.receivedOn;
  if (body.receivedOn != null && body.receivedOn !== '') {
    receivedOn = validDay(body.receivedOn);
    if (!receivedOn || receivedOn < earliest || receivedOn > today) return fail('received_on_invalid', 400, { earliest, latest: today });
  }

  if (body.note != null && typeof body.note !== 'string') return fail('invalid_field', 400, { field: 'note' });
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;
  if (note && note.length > MAX_PAYMENT_NOTE) return fail('note_too_long', 400, { max: MAX_PAYMENT_NOTE });

  let allocations = null;
  if (body.allocations != null) {
    if (!Array.isArray(body.allocations) || !body.allocations.length || body.allocations.length > MAX_ALLOCATIONS) return fail('invalid_allocation', 400, { max: MAX_ALLOCATIONS });
    const seen = new Set();
    allocations = [];
    for (const [index, raw] of body.allocations.entries()) {
      if (!raw || typeof raw !== 'object' || typeof raw.saleId !== 'string' || !raw.saleId || raw.saleId.length > 100) return fail('invalid_allocation', 400, { index, field: 'saleId' });
      if (!Number.isInteger(raw.amountTzs) || raw.amountTzs < 1) return fail('invalid_allocation', 400, { index, field: 'amountTzs' });
      if (seen.has(raw.saleId)) return fail('invalid_allocation', 400, { index, reason: 'duplicate_sale' });
      seen.add(raw.saleId);
      allocations.push({ saleId: raw.saleId, amountTzs: raw.amountTzs });
    }
    const sum = allocations.reduce((s, a) => s + a.amountTzs, 0);
    if (sum !== body.amountTzs) return fail('allocation_mismatch', 400, { amountTzs: body.amountTzs, allocatedTzs: sum });
  }
  return { clientRef: body.clientRef, amountTzs: body.amountTzs, method: body.method, reference, receivedOn, receivedOnInput, note, allocations };
}

/** Optional clientRef of POST /vendor/customers: absent → null; malformed → error. */
export function parseClientRef(value) {
  if (value == null || value === '') return { clientRef: null };
  if (typeof value !== 'string' || !CLIENT_REF.test(value)) return fail('invalid_client_ref', 400);
  return { clientRef: value };
}
/** What makes two POST /vendor/customers with the same clientRef "the same customer". */
export const customerFingerprint = fields => createHash('sha256').update(JSON.stringify(
  ['name', 'phone', 'email', 'address', 'note'].map(k => fields[k] ?? null),
)).digest('hex');

/** What makes two payment requests with the same clientRef "the same payment". */
export function paymentFingerprint(customerId, p) {
  return createHash('sha256').update(JSON.stringify({
    customerId, amountTzs: p.amountTzs, method: p.method, reference: p.reference || null, receivedOn: p.receivedOnInput ?? null,
    note: p.note || null, allocations: p.allocations ? p.allocations.map(a => [a.saleId, a.amountTzs]) : null,
  })).digest('hex');
}

/**
 * Oldest due first: `open` = the customer's open credit sales already sorted (dueDate, soldAt, id),
 * each { id, balanceTzs }. → [{ saleId, amountTzs }] covering `amount` (amount ≤ Σ balance).
 */
export function allocateOldestFirst(open, amount) {
  const out = [];
  let left = amount;
  for (const sale of open) {
    if (left <= 0) break;
    const take = Math.min(left, sale.balanceTzs);
    if (take > 0) out.push({ saleId: sale.id, amountTzs: take });
    left -= take;
  }
  return out;
}

/** A credit sale's due date: from the sale's EAT day up to 365 days later. null when fine. */
export function dueDateOutOfRange(dueDate, saleDay) {
  const latest = addDays(saleDay, DUE_DATE_MAX_DAYS);
  if (dueDate >= saleDay && dueDate <= latest) return null;
  return fail('due_date_out_of_range', 400, { earliest: saleDay, latest });
}

/** POST …/payments/:id/void body → { reason } or an error (same rule as a sale void). */
export function parsePaymentVoid(body = {}) {
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < VOID_REASON.min) return fail('reason_required', 400, { min: VOID_REASON.min });
  if (reason.length > VOID_REASON.max) return fail('reason_too_long', 400, { max: VOID_REASON.max });
  return { reason };
}

/** Opaque page cursor (an offset: lists sorted by computed money figures). */
export const encodeOffset = offset => Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
export function decodeOffset(cursor) {
  try {
    const { o } = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    return Number.isInteger(o) && o >= 0 ? o : null;
  } catch { return null; }
}
/** limit query value → number or an error. */
export function pageLimit(value, { def = CUSTOMERS_PAGE_DEFAULT, max = CUSTOMERS_PAGE_MAX } = {}) {
  if (value == null || value === '') return def;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return fail('invalid_limit', 400, { max });
  return Math.min(n, max);
}
