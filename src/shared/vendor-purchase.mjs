// Vendor suppliers, receiving stock (GRN) and payables with instalments (vendor business tools · S9).
// Pure functions: no storage. Decided in the design spec docs/design/vendor-purchases-s9.md §1 (approved
// 2026-11-04, Q-1..Q-7 accepted). FitFlex moves no money for payables: these are records only.
//
// - P-1 lines { productId, variant, qty 1–100000, unitCostTzs 0–100,000,000 }; lineTotal = qty × unitCost; one
//   line per (product, variant); 1–200 lines; total ≤ 1,000,000,000. The server computes every total.
// - P-3 a supplier is required when anything is left owing.
// - P-4 paid at receipt ≤ total (no supplier credit balance); S3 method and reference rules.
// - P-5 the plan always covers the whole total; payments cover instalments in plan order (oldest due first);
//   an instalment's state is derived from the purchase's paidTzs, never stored.
// - P-13 GRN-000001… per vendor (VendorDocumentSequence docType `purchase`). P-14 receivedOn: today … 30 days back.
import { createHash } from 'node:crypto';
import { PAYMENT_METHODS, REFERENCE_REQUIRED, MAX_REFERENCE } from './vendor-sale.mjs';
import { validDay, addDays, daysBetween, normalisePhone } from './vendor-customer.mjs';

export const PURCHASE_DOC_TYPE = 'purchase';
export const grnNumber = seq => `GRN-${String(seq).padStart(6, '0')}`;

export const MAX_PURCHASE_LINES = 200;
export const MAX_PURCHASE_QTY = 100_000;
export const MAX_UNIT_COST_TZS = 100_000_000;
export const MAX_PURCHASE_TOTAL_TZS = 1_000_000_000;
export const MAX_INSTALMENTS = 12;
export const RECEIVED_ON_BACK_DAYS = 30;
export const DUE_MAX_DAYS = 365;
export const DEFAULT_DUE_DAYS = 30;
export const MAX_INVOICE_REF = 60;
export const MAX_PURCHASE_NOTE = 200;
export const MAX_PAYMENT_NOTE = 200;
export const PURCHASE_VOID_REASON = { min: 3, max: 200 };
export const MAX_LAST_COST_PRODUCTS = 100;
export const PURCHASES_PAGE_DEFAULT = 50;
export const PURCHASES_PAGE_MAX = 200;
export const PURCHASES_CSV_MAX_ROWS = 50_000;
export const SUPPLIER = Object.freeze({
  name: { min: 2, max: 120 }, phone: 20, email: 254, contactPerson: 120, address: 300, tin: 20, note: 500,
});
export const SUPPLIER_FILTERS = ['active', 'owing', 'overdue', 'archived'];
export const SUPPLIER_SORTS = ['name', 'owed', 'recent'];
export const PAYABLES_SORTS = ['overdue', 'owed', 'name'];
export const PURCHASE_STATUSES = ['received', 'voided', 'all'];
export const PURCHASE_PAYMENT_FILTERS = ['open', 'overdue', 'paid', 'all'];

const CLIENT_REF = /^[A-Za-z0-9._:-]{8,100}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const textOf = v => (typeof v === 'string' ? v.trim() : '');
export const validClientRef = ref => typeof ref === 'string' && CLIENT_REF.test(ref);
/** The payment recorded at receipt carries the purchase's clientRef + ':paid' (spec §2.1). */
export const AT_RECEIPT_SUFFIX = ':paid';
export const atReceiptClientRef = clientRef => `${clientRef}${AT_RECEIPT_SUFFIX}`;

// ── suppliers ───────────────────────────────────────────────────────────────

/**
 * A supplier phone: a Tanzanian number is stored as +255…; another country's number (a supplier abroad) is
 * kept as digits with an optional leading + (7–15 digits, ≤ 20 characters). Anything else → null.
 */
export function supplierPhone(raw) {
  if (typeof raw !== 'string') return null;
  const tz = normalisePhone(raw);
  if (tz) return tz;
  const s = raw.trim().replace(/[\s\-().]/g, '');
  return /^\+?\d{7,15}$/.test(s) && s.length <= SUPPLIER.phone ? s : null;
}

const SUPPLIER_FIELDS = ['name', 'phone', 'email', 'contactPerson', 'address', 'tin', 'note'];

/**
 * POST /vendor/suppliers and PUT /vendor/suppliers/:id bodies.
 * PUT (partial): only the fields sent change; null clears an optional field; name cannot be null; archived true|false.
 * → { error, status, ... } or { fields: {...}, archived?: boolean }
 */
export function parseSupplier(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid_body', 400);
  const out = {};
  for (const field of SUPPLIER_FIELDS) {
    if (!(field in body) || body[field] === undefined) continue;
    const raw = body[field];
    if (raw != null && typeof raw !== 'string') return fail('invalid_field', 400, { field });
    const value = textOf(raw);
    out[field] = value === '' ? null : value;
  }
  if ('archived' in body && (!partial || typeof body.archived !== 'boolean')) return fail('invalid_field', 400, { field: 'archived' });
  if (!partial || 'name' in out) {
    if (!out.name || out.name.length < SUPPLIER.name.min) return fail('name_required', 400, { min: SUPPLIER.name.min });
    if (out.name.length > SUPPLIER.name.max) return fail('name_too_long', 400, { max: SUPPLIER.name.max });
  }
  if (out.phone != null) {
    const phone = supplierPhone(out.phone);
    if (!phone) return fail('invalid_phone', 400);
    out.phone = phone;
  }
  if (out.email != null) {
    if (out.email.length > SUPPLIER.email || !EMAIL.test(out.email)) return fail('invalid_email', 400);
    out.email = out.email.toLowerCase();
  }
  for (const field of ['contactPerson', 'address', 'tin', 'note']) {
    if (out[field] != null && out[field].length > SUPPLIER[field]) return fail('field_too_long', 400, { field, max: SUPPLIER[field] });
  }
  return { fields: out, ...(partial && typeof body.archived === 'boolean' ? { archived: body.archived } : {}) };
}

// ── receive ─────────────────────────────────────────────────────────────────

/** What makes two receive requests with the same clientRef "the same purchase": the body as sent (normalised). */
export function purchaseFingerprint(body = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const lines = Array.isArray(b.lines)
    ? b.lines.map(l => [typeof l?.productId === 'string' ? l.productId : null, textOf(l?.variant) || '', l?.qty ?? null, l?.unitCostTzs ?? null])
      .sort((x, y) => `${x[0]}\u0000${x[1]}`.localeCompare(`${y[0]}\u0000${y[1]}`))
    : null;
  const paid = b.paidNow && typeof b.paidNow === 'object'
    ? [b.paidNow.amountTzs ?? null, b.paidNow.method ?? null, b.paidNow.method === 'cash' ? null : textOf(b.paidNow.reference) || null] : null;
  const schedule = Array.isArray(b.schedule) ? b.schedule.map(r => [r?.dueDate ?? null, r?.amountTzs ?? null]) : null;
  return createHash('sha256').update(JSON.stringify({
    supplierId: typeof b.supplierId === 'string' && b.supplierId ? b.supplierId : null,
    receivedOn: b.receivedOn || null, supplierInvoiceRef: textOf(b.supplierInvoiceRef) || null, note: textOf(b.note) || null,
    lines, paid: paid && paid[0] ? paid : null, dueDate: b.dueDate || null, schedule,
  })).digest('hex');
}

/** paidNow / a later payment's method and reference (S3 rules). → { method, reference } or a 400. */
export function methodAndReference(method, reference) {
  if (typeof method !== 'string' || !PAYMENT_METHODS.includes(method)) return fail('invalid_method', 400, { allowed: PAYMENT_METHODS });
  if (reference != null && typeof reference !== 'string') return fail('invalid_field', 400, { field: 'reference' });
  const ref = method === 'cash' ? null : textOf(reference) || null;
  if (ref && ref.length > MAX_REFERENCE) return fail('reference_too_long', 400, { max: MAX_REFERENCE });
  if (REFERENCE_REQUIRED.has(method) && !ref) return fail('reference_required', 400, { method });
  return { method, reference: ref };
}

/** A schedule [{ dueDate, amountTzs }] (1–12) with due dates in [earliest, latest]. → { schedule } or a 400. */
export function parseSchedule(raw, { earliest, latest }) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_INSTALMENTS) return fail('invalid_schedule', 400, { reason: 'count', max: MAX_INSTALMENTS });
  const rows = [];
  for (const [index, r] of raw.entries()) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return fail('invalid_schedule', 400, { reason: 'amount', index });
    if (!Number.isInteger(r.amountTzs) || r.amountTzs < 1 || r.amountTzs > MAX_PURCHASE_TOTAL_TZS) return fail('invalid_schedule', 400, { reason: 'amount', index });
    const day = validDay(r.dueDate);
    if (!day) return fail('invalid_schedule', 400, { reason: 'date', index });
    if (day < earliest || day > latest) return fail('due_date_out_of_range', 400, { earliest, latest });
    rows.push({ dueDate: day, amountTzs: r.amountTzs, index });
  }
  // Sorted by the server: date, then the order given.
  rows.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.index - b.index);
  return { schedule: rows.map(({ dueDate, amountTzs }) => ({ dueDate, amountTzs })) };
}

/**
 * POST /vendor/purchases body. `today` = the EAT day now.
 * → { error, status, ... } or { clientRef, supplierId, receivedOn, supplierInvoiceRef, note, lines, totalTzs,
 *   paidNow: { amountTzs, method, reference } | null, dueDate | null, schedule | null }
 */
export function parseReceive(body, { today }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid_body', 400);
  if (!validClientRef(body.clientRef)) return fail('invalid_client_ref', 400);
  if (body.supplierId != null && (typeof body.supplierId !== 'string' || body.supplierId.length > 100)) return fail('invalid_field', 400, { field: 'supplierId' });
  if (!Array.isArray(body.lines) || !body.lines.length) return fail('lines_required', 400);
  if (body.lines.length > MAX_PURCHASE_LINES) return fail('too_many_lines', 400, { max: MAX_PURCHASE_LINES });
  const lines = [];
  const seen = new Set();
  let totalTzs = 0;
  for (const [index, raw] of body.lines.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_line', 400, { index });
    if (typeof raw.productId !== 'string' || !raw.productId || raw.productId.length > 100) return fail('invalid_line', 400, { index, field: 'productId' });
    if (raw.variant != null && typeof raw.variant !== 'string') return fail('invalid_line', 400, { index, field: 'variant' });
    const variant = textOf(raw.variant);
    if (variant.length > 100) return fail('invalid_line', 400, { index, field: 'variant' });
    if (!Number.isInteger(raw.qty) || raw.qty < 1 || raw.qty > MAX_PURCHASE_QTY) return fail('invalid_quantity', 400, { index, max: MAX_PURCHASE_QTY });
    if (!Number.isInteger(raw.unitCostTzs) || raw.unitCostTzs < 0 || raw.unitCostTzs > MAX_UNIT_COST_TZS) return fail('invalid_cost', 400, { index, max: MAX_UNIT_COST_TZS });
    const key = `${raw.productId}\u0000${variant}`;
    if (seen.has(key)) return fail('duplicate_line', 400, { productId: raw.productId, variant: variant || null });
    seen.add(key);
    const lineTotalTzs = raw.qty * raw.unitCostTzs;
    totalTzs += lineTotalTzs;
    lines.push({ productId: raw.productId, variant, qty: raw.qty, unitCostTzs: raw.unitCostTzs, lineTotalTzs });
  }

  const earliest = addDays(today, -RECEIVED_ON_BACK_DAYS);
  let receivedOn = today;
  if (body.receivedOn != null && body.receivedOn !== '') {
    receivedOn = validDay(body.receivedOn);
    if (!receivedOn || receivedOn < earliest || receivedOn > today) return fail('received_on_out_of_range', 400, { earliest, latest: today });
  }
  if (body.supplierInvoiceRef != null && typeof body.supplierInvoiceRef !== 'string') return fail('invalid_field', 400, { field: 'supplierInvoiceRef' });
  const supplierInvoiceRef = textOf(body.supplierInvoiceRef) || null;
  if (supplierInvoiceRef && supplierInvoiceRef.length > MAX_INVOICE_REF) return fail('supplier_invoice_ref_too_long', 400, { max: MAX_INVOICE_REF });
  if (body.note != null && typeof body.note !== 'string') return fail('invalid_field', 400, { field: 'note' });
  const note = textOf(body.note) || null;
  if (note && note.length > MAX_PURCHASE_NOTE) return fail('note_too_long', 400, { max: MAX_PURCHASE_NOTE });
  if (totalTzs > MAX_PURCHASE_TOTAL_TZS) return fail('total_too_large', 400, { max: MAX_PURCHASE_TOTAL_TZS });

  let paidNow = null;
  if (body.paidNow != null) {
    const p = body.paidNow;
    if (typeof p !== 'object' || Array.isArray(p)) return fail('invalid_payment', 400, { field: 'paidNow' });
    if (!Number.isInteger(p.amountTzs) || p.amountTzs < 0 || p.amountTzs > MAX_PURCHASE_TOTAL_TZS) return fail('invalid_payment', 400, { field: 'amountTzs' });
    if (p.amountTzs > 0) {
      const how = methodAndReference(p.method, p.reference);
      if (how.error) return how;
      paidNow = { amountTzs: p.amountTzs, ...how };
    }
  }

  if (body.dueDate != null && body.schedule != null) return fail('invalid_field', 400, { field: 'schedule' });
  const latestDue = addDays(receivedOn, DUE_MAX_DAYS);
  let dueDate = null;
  let schedule = null;
  // Spec §2.3: dueDate / schedule are ignored (not an error) when nothing is left owing.
  const leftOwing = totalTzs - (paidNow?.amountTzs || 0) > 0;
  if (leftOwing && body.dueDate != null && body.dueDate !== '') {
    dueDate = validDay(body.dueDate);
    if (!dueDate) return fail('invalid_field', 400, { field: 'dueDate' });
    if (dueDate < receivedOn || dueDate > latestDue) return fail('due_date_out_of_range', 400, { earliest: receivedOn, latest: latestDue });
  }
  if (leftOwing && body.schedule != null) {
    const parsed = parseSchedule(body.schedule, { earliest: receivedOn, latest: latestDue });
    if (parsed.error) return parsed;
    schedule = parsed.schedule;
  }
  return {
    clientRef: body.clientRef, supplierId: typeof body.supplierId === 'string' && body.supplierId ? body.supplierId : null,
    receivedOn, supplierInvoiceRef, note, lines, totalTzs, paidNow, dueDate, schedule,
  };
}

/**
 * P-3, P-4, P-5 against the server's total: → { error, status, ... } or
 * { paidNowTzs, balanceTzs, instalments: [{ dueDate, amountTzs }] } (active instalments add up to the total).
 * dueDate / schedule are ignored when nothing is left owing.
 */
export function planPurchaseMoney(parsed, { hasSupplier }) {
  const total = parsed.totalTzs;
  const paidNowTzs = parsed.paidNow?.amountTzs || 0;
  if (paidNowTzs > total) return fail('overpayment', 400, { totalTzs: total });
  const balanceTzs = total - paidNowTzs;
  if (balanceTzs > 0 && !hasSupplier) return fail('supplier_required', 400);
  const instalments = [];
  if (paidNowTzs > 0) instalments.push({ dueDate: parsed.receivedOn, amountTzs: paidNowTzs });
  if (balanceTzs > 0) {
    if (parsed.schedule) {
      const scheduledTzs = parsed.schedule.reduce((s, r) => s + r.amountTzs, 0);
      if (scheduledTzs !== balanceTzs) return fail('schedule_mismatch', 400, { expectedTzs: balanceTzs, scheduledTzs });
      instalments.push(...parsed.schedule);
    } else {
      instalments.push({ dueDate: parsed.dueDate || addDays(parsed.receivedOn, DEFAULT_DUE_DAYS), amountTzs: balanceTzs });
    }
  }
  return { paidNowTzs, balanceTzs, instalments };
}

// ── later payments, voids, plan ─────────────────────────────────────────────

/**
 * POST /vendor/purchases/:id/payments body. `today` EAT (the default paidOn).
 * → { clientRef, amountTzs, paidOn (null = not a real date), paidOnInput, method, reference, note } or a 400.
 */
export function parsePurchasePayment(body, { today }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid_body', 400);
  // Security review #327 L-5: ':paid' ends the clientRef of the payment recorded at receipt; a later payment may
  // not use it (it would collide with, or be answered as, that payment).
  if (!validClientRef(body.clientRef) || body.clientRef.endsWith(AT_RECEIPT_SUFFIX)) return fail('invalid_client_ref', 400);
  if (!Number.isInteger(body.amountTzs) || body.amountTzs < 1 || body.amountTzs > MAX_PURCHASE_TOTAL_TZS) return fail('invalid_amount', 400);
  const how = methodAndReference(body.method, body.reference);
  if (how.error) return how;
  if (body.note != null && typeof body.note !== 'string') return fail('invalid_field', 400, { field: 'note' });
  const note = textOf(body.note) || null;
  if (note && note.length > MAX_PAYMENT_NOTE) return fail('note_too_long', 400, { max: MAX_PAYMENT_NOTE });
  const paidOnInput = body.paidOn == null || body.paidOn === '' ? null : body.paidOn;
  // The range (the purchase's receivedOn … today) is checked against the locked purchase; a malformed date
  // (paidOn null here) is answered there the same way, paid_on_out_of_range { earliest, latest }.
  const paidOn = paidOnInput == null ? today : validDay(paidOnInput);
  return { clientRef: body.clientRef, amountTzs: body.amountTzs, paidOn, paidOnInput, ...how, note };
}

/** What makes two payment requests with the same clientRef "the same payment". */
export function purchasePaymentFingerprint(purchaseId, body = {}) {
  const b = body && typeof body === 'object' ? body : {};
  return createHash('sha256').update(JSON.stringify({
    purchaseId: String(purchaseId || ''), amountTzs: b.amountTzs ?? null, method: b.method ?? null,
    reference: b.method === 'cash' ? null : textOf(b.reference) || null, paidOn: b.paidOn || null, note: textOf(b.note) || null,
  })).digest('hex');
}

/** A void reason: 3–200 characters after trimming. */
export function parsePurchaseReason(value) {
  const reason = textOf(value);
  if (reason.length < PURCHASE_VOID_REASON.min) return fail('reason_required', 400, { min: PURCHASE_VOID_REASON.min });
  if (reason.length > PURCHASE_VOID_REASON.max) return fail('reason_too_long', 400, { max: PURCHASE_VOID_REASON.max });
  return { reason };
}

// ── coverage (P-5) ──────────────────────────────────────────────────────────

/**
 * Which instalments the purchase's payments cover. `instalments` = the ACTIVE rows in plan order (seq);
 * `paidTzs` = Σ recorded payments. Per row: covered = min(amount, max(0, paid − Σ earlier amounts)).
 * → rows + { coveredTzs, openTzs, state: paid | part_paid | due | overdue, daysOverdue } (EAT `today`).
 */
export function coverInstalments(instalments, paidTzs, today) {
  let before = 0;
  return instalments.map((row) => {
    const amount = Number(row.amountTzs);
    const coveredTzs = Math.min(amount, Math.max(0, Number(paidTzs) - before));
    before += amount;
    const openTzs = amount - coveredTzs;
    const late = daysBetween(today, row.dueDate);
    const state = coveredTzs === amount ? 'paid' : coveredTzs > 0 ? 'part_paid' : late >= 1 ? 'overdue' : 'due';
    return { ...row, coveredTzs, openTzs, state, daysOverdue: openTzs > 0 ? Math.max(0, late) : 0 };
  });
}

/** What a payment of `amount` on top of `paidBefore` covers: [{ index, amountTzs }] (oldest first). */
export function coveredBy(instalments, paidBefore, amount) {
  const out = [];
  let before = 0;
  for (const [index, row] of instalments.entries()) {
    const a = Number(row.amountTzs);
    const from = Math.max(before, paidBefore);
    const to = Math.min(before + a, paidBefore + amount);
    if (to > from) out.push({ index, amountTzs: to - from });
    before += a;
  }
  return out;
}

/** paid | part_paid | unpaid from the purchase's figures. */
export const paymentStateOf = p => (Number(p.balanceTzs) === 0 ? 'paid' : Number(p.paidTzs) > 0 ? 'part_paid' : 'unpaid');

/**
 * P-11: the plan after a change. `active` in plan order with coverage (coverInstalments). Fully covered rows are
 * kept; a partly covered row is split (its covered part stays with the same due date); every other row is
 * replaced by `schedule` (which must add up to the balance — checked by the caller).
 * → { keep: [row], splitFrom: row|null, splitCoveredTzs, replace: [row] }
 */
export function planChange(covered) {
  const keep = [];
  const replace = [];
  let splitFrom = null;
  let splitCoveredTzs = 0;
  for (const row of covered) {
    if (row.openTzs === 0) keep.push(row);
    else {
      replace.push(row);
      if (row.coveredTzs > 0 && !splitFrom) { splitFrom = row; splitCoveredTzs = row.coveredTzs; }
    }
  }
  return { keep, splitFrom, splitCoveredTzs, replace };
}

// ── CSV (purchases list, payables aging): headers in the chosen language, money columns "(TZS)", S6 rules ──
// Swahili is a DRAFT for native review (spec §8).
export const PURCHASE_LABELS = {
  en: {
    number: 'Delivery number', receivedOn: 'Received on', recordedAt: 'Recorded at (EAT)', supplier: 'Supplier', status: 'Status', payment: 'Payment',
    total: 'Total', paid: 'Paid', left: 'Left to pay', overdue: 'Overdue', nextDue: 'Next due date', lines: 'Items', units: 'Units', recordedBy: 'Recorded by',
    noSupplier: 'No supplier', owed: 'You owe', oldestDue: 'Oldest due date', daysOverdue: 'Days overdue',
    current: 'Not due yet', d1_30: '1–30 days overdue', d31_60: '31–60 days overdue', d61_90: '61–90 days overdue', d90plus: 'Over 90 days overdue',
    status_received: 'Received', status_voided: 'Voided', state_paid: 'Paid', state_part_paid: 'Part paid', state_unpaid: 'Unpaid',
  },
  sw: {
    number: 'Namba ya mzigo', receivedOn: 'Tarehe ya kupokea', recordedAt: 'Ilirekodiwa (EAT)', supplier: 'Msambazaji', status: 'Hali', payment: 'Malipo',
    total: 'Jumla', paid: 'Imelipwa', left: 'Kiasi kilichobaki', overdue: 'Imechelewa', nextDue: 'Tarehe ijayo ya kulipa', lines: 'Bidhaa', units: 'Idadi', recordedBy: 'Imerekodiwa na',
    noSupplier: 'Hakuna msambazaji', owed: 'Unadaiwa', oldestDue: 'Tarehe ya zamani zaidi ya kulipa', daysOverdue: 'Siku za kuchelewa',
    current: 'Bado muda haujafika', d1_30: 'Siku 1–30 za kuchelewa', d31_60: 'Siku 31–60 za kuchelewa', d61_90: 'Siku 61–90 za kuchelewa', d90plus: 'Zaidi ya siku 90 za kuchelewa',
    status_received: 'Imepokelewa', status_voided: 'Imebatilishwa', state_paid: 'Imelipwa', state_part_paid: 'Imelipwa sehemu', state_unpaid: 'Haijalipwa',
  },
};
const label = (lang, key) => PURCHASE_LABELS[lang === 'sw' ? 'sw' : 'en'][key] ?? PURCHASE_LABELS.en[key] ?? key;
const money = (lang, key) => `${label(lang, key)} (TZS)`;
const eatDateTime = instant => (instant ? new Date(+new Date(instant) + 3 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ') : '');

export function purchasesCsv(purchases, lang) {
  const header = [label(lang, 'number'), label(lang, 'receivedOn'), label(lang, 'recordedAt'), label(lang, 'supplier'), label(lang, 'status'), label(lang, 'payment'),
    money(lang, 'total'), money(lang, 'paid'), money(lang, 'left'), money(lang, 'overdue'), label(lang, 'nextDue'), label(lang, 'lines'), label(lang, 'units'), label(lang, 'recordedBy')];
  const rows = purchases.map(p => [p.number, p.receivedOn, eatDateTime(p.recordedAt), p.supplier?.name ?? label(lang, 'noSupplier'), label(lang, `status_${p.status}`),
    label(lang, `state_${p.paymentState}`), p.totalTzs, p.paidTzs, p.balanceTzs, p.overdueTzs, p.nextDueDate ?? '', p.lineCount, p.units, p.createdBy?.name ?? '']);
  return { header, rows };
}

export function payablesCsv(aging, lang) {
  const header = [label(lang, 'supplier'), money(lang, 'owed'), money(lang, 'overdue'), money(lang, 'current'), money(lang, 'd1_30'), money(lang, 'd31_60'),
    money(lang, 'd61_90'), money(lang, 'd90plus'), label(lang, 'oldestDue'), label(lang, 'daysOverdue')];
  const rows = aging.rows.map(r => [r.name, r.owedTzs, r.overdueTzs, r.current, r.d1_30, r.d31_60, r.d61_90, r.d90plus, r.oldestDueDate ?? '', r.maxDaysOverdue]);
  return { header, rows };
}
