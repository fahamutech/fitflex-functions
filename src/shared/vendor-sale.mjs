// Vendor walk-in sales (vendor business tools · S3). Pure functions: no storage.
//
// Decided 2026-10-19 (design spec docs/design/vendor-walkin-sales-s3.md §11):
// - Walk-in price = the product's discount price when set (and below the price), else its price;
//   decided by the server (listPriceTzs). Staff with `sales` may charge another price (O-14).
// - A line's discountTzs is the discount for the whole line (not per unit); subtotalTzs is
//   Σ qty × unit price, before any discount; the sale discount comes off after line discounts.
// - Payment references are required for mobile money and bank, optional for card and other.
// - A sale whose total is 0 is allowed, with no payments. Only cash may exceed its share
//   (it gives change); Σ payments below the total → 409 payment_short (a cash sale; S4 pay later is kind credit).
// - soldAt from 7 days in the past (offline sales sync late) to 24 hours in the future: a device clock
//   that runs ahead is clamped to the server's now and the device's value kept as clientSoldAt (contract check #214).
// - S4 (2026-10-20): kind credit = pay later. A credit sale names a customer and a due date, is paid
//   less than its total (possibly nothing), never gives change; balanceTzs = total − paid.
import { createHash } from 'node:crypto';

export const PAYMENT_METHODS = ['cash', 'mpesa', 'airtel_money', 'mixx', 'halopesa', 'card', 'bank', 'other'];
export const REFERENCE_REQUIRED = new Set(['mpesa', 'airtel_money', 'mixx', 'halopesa', 'bank']);
export const MAX_LINES = 100;
export const MAX_PAYMENTS = 10;
export const MAX_QTY_PER_LINE = 1000;
export const MAX_SALE_TZS = 100_000_000;
/** Change may be at most the total plus this (security review L2): a typo of extra zeros is refused. */
export const MAX_CHANGE_OVER_TOTAL_TZS = 1_000_000;
/** A sale reached FitFlex this long after it was made: "recorded late" (offline, or back-dated). */
export const LATE_RECORDED_MS = 5 * 60_000;
export const MAX_NOTE = 200;
export const MAX_REFERENCE = 100;
export const VOID_REASON = { min: 3, max: 200 };
export const SOLD_AT_PAST_MS = 7 * 86_400_000;
export const SOLD_AT_FUTURE_MS = 24 * 3_600_000;
export const SALES_PAGE_DEFAULT = 50;
export const SALES_PAGE_MAX = 200;
const CLIENT_REF = /^[A-Za-z0-9._:-]{8,100}$/;

const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const isMoney = (v, { min = 0 } = {}) => Number.isInteger(v) && v >= min && v <= MAX_SALE_TZS;

/** The walk-in price of a product (Q-3): its discount price when set and below its price, else its price. */
export function walkInPrice(product) {
  const price = Number(product?.priceTzs || 0);
  const discount = Number(product?.discountPriceTzs || 0);
  return discount > 0 && discount < price ? discount : price;
}

/** Receipt numbers: R-000001, continuous per vendor (O-6). */
export const RECEIPT_DOC_TYPE = 'receipt';
export const receiptNumber = seq => `R-${String(seq).padStart(6, '0')}`;

/**
 * Validate POST /vendor/sales. Prices and stock are checked later against the product rows; here
 * only the shape. → { error, status, ... } or
 * { clientRef, soldAtInput, soldAt (Date|null = now), lines:[{ productId, variant, qty, unitPriceTzs|null, discountTzs }],
 *   discountTzs, payments:[{ method, amountTzs, reference }], note }
 */
export function parseSale(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid_body', 400);
  const { clientRef } = body;
  if (typeof clientRef !== 'string' || !CLIENT_REF.test(clientRef)) return fail('invalid_client_ref', 400);

  let soldAt = null;
  const soldAtInput = body.soldAt == null || body.soldAt === '' ? null : body.soldAt;
  if (soldAtInput != null) {
    if (typeof soldAtInput !== 'string' || Number.isNaN(Date.parse(soldAtInput))) return fail('invalid_field', 400, { field: 'soldAt' });
    soldAt = new Date(soldAtInput);
  }

  if (!Array.isArray(body.lines) || !body.lines.length) return fail('lines_required', 400);
  if (body.lines.length > MAX_LINES) return fail('too_many_lines', 400, { max: MAX_LINES });
  const lines = [];
  for (const [index, raw] of body.lines.entries()) {
    if (!raw || typeof raw !== 'object') return fail('invalid_line', 400, { index });
    if (typeof raw.productId !== 'string' || !raw.productId.trim() || raw.productId.length > 100) return fail('invalid_line', 400, { index, field: 'productId' });
    if (raw.variant != null && (typeof raw.variant !== 'string' || raw.variant.length > 60)) return fail('invalid_line', 400, { index, field: 'variant' });
    if (!Number.isInteger(raw.qty) || raw.qty < 1 || raw.qty > MAX_QTY_PER_LINE) return fail('invalid_quantity', 400, { index, max: MAX_QTY_PER_LINE });
    let unitPriceTzs = null;
    if (raw.unitPriceTzs != null) {
      if (!isMoney(raw.unitPriceTzs, { min: 1 })) return fail('invalid_price', 400, { index });
      unitPriceTzs = raw.unitPriceTzs;
    }
    let discountTzs = 0;
    if (raw.discountTzs != null) {
      if (!isMoney(raw.discountTzs)) return fail('invalid_discount', 400, { index });
      discountTzs = raw.discountTzs;
    }
    const variant = typeof raw.variant === 'string' && raw.variant.trim() ? raw.variant.trim() : null;
    lines.push({ productId: raw.productId.trim(), variant, qty: raw.qty, unitPriceTzs, discountTzs });
  }

  let discountTzs = 0;
  if (body.discountTzs != null) {
    if (!isMoney(body.discountTzs)) return fail('invalid_discount', 400);
    discountTzs = body.discountTzs;
  }

  const rawPayments = body.payments == null ? [] : body.payments;
  if (!Array.isArray(rawPayments)) return fail('invalid_payment', 400);
  if (rawPayments.length > MAX_PAYMENTS) return fail('invalid_payment', 400, { reason: 'too_many', max: MAX_PAYMENTS });
  const payments = [];
  for (const [index, raw] of rawPayments.entries()) {
    if (!raw || typeof raw !== 'object' || !PAYMENT_METHODS.includes(raw.method)) return fail('invalid_payment', 400, { index, field: 'method', allowed: PAYMENT_METHODS });
    if (!isMoney(raw.amountTzs, { min: 1 })) return fail('invalid_payment', 400, { index, field: 'amountTzs' });
    // Cash has no reference: anything sent with it is ignored.
    if (raw.method !== 'cash' && raw.reference != null && typeof raw.reference !== 'string') return fail('invalid_payment', 400, { index, field: 'reference' });
    const reference = raw.method !== 'cash' && typeof raw.reference === 'string' && raw.reference.trim() ? raw.reference.trim() : null;
    if (reference && reference.length > MAX_REFERENCE) return fail('invalid_payment', 400, { index, field: 'reference', max: MAX_REFERENCE });
    if (REFERENCE_REQUIRED.has(raw.method) && !reference) return fail('reference_required', 400, { index, method: raw.method });
    payments.push({ method: raw.method, amountTzs: raw.amountTzs, reference });
  }

  if (body.note != null && typeof body.note !== 'string') return fail('invalid_field', 400, { field: 'note' });
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;
  if (note && note.length > MAX_NOTE) return fail('note_too_long', 400, { max: MAX_NOTE });

  const credit = parseCreditFields(body);
  if (credit.error) return credit;

  return { clientRef, soldAtInput, soldAt, lines, discountTzs, payments, note, ...credit };
}

/**
 * S4 pay-later fields: kind cash (default) | credit; customerId (required for credit); dueDate
 * YYYY-MM-DD, credit only (default: the sale's EAT day + 7, set by the service).
 */
function parseCreditFields(body) {
  const kind = body.kind == null || body.kind === '' ? 'cash' : body.kind;
  if (!['cash', 'credit'].includes(kind)) return fail('invalid_field', 400, { field: 'kind', allowed: ['cash', 'credit'] });
  let customerId = null;
  if (body.customerId != null && body.customerId !== '') {
    if (typeof body.customerId !== 'string' || body.customerId.length > 100) return fail('invalid_field', 400, { field: 'customerId' });
    customerId = body.customerId;
  }
  let dueDate = null;
  if (body.dueDate != null && body.dueDate !== '') {
    if (kind !== 'credit') return fail('invalid_field', 400, { field: 'dueDate', reason: 'credit_only' });
    const t = typeof body.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.dueDate) ? Date.parse(`${body.dueDate}T00:00:00Z`) : NaN;
    if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== body.dueDate) return fail('invalid_field', 400, { field: 'dueDate' });
    dueDate = body.dueDate;
  }
  if (kind === 'credit' && !customerId) return fail('customer_required', 400);
  return { kind, customerId, dueDate };
}

/** What makes two requests with the same clientRef "the same sale" (a retry, not a reuse). */
export function saleFingerprint(sale) {
  return createHash('sha256').update(JSON.stringify({
    soldAt: sale.soldAtInput == null ? null : new Date(sale.soldAtInput).toISOString(),
    lines: sale.lines.map(l => [l.productId, l.variant || null, l.qty, l.unitPriceTzs ?? null, l.discountTzs || 0]),
    discountTzs: sale.discountTzs || 0,
    payments: sale.payments.map(p => [p.method, p.amountTzs, p.reference || null]),
    note: sale.note || null,
    // S4 fields only when used, so fingerprints of S3 sales (and their retries) do not change.
    ...(sale.kind === 'credit' || sale.customerId ? { kind: sale.kind, customerId: sale.customerId, dueDate: sale.dueDate || null } : {}),
  })).digest('hex');
}

/** soldAt must lie between 7 days ago and 24 hours from now (a future one is then clamped to now). null when fine. */
/** A soldAt ahead of the server (a fast device clock) becomes the server's now; the device's value is kept. */
export function clampSoldAt(soldAt, now) {
  return +soldAt > +now ? { soldAt: new Date(+now), clientSoldAt: new Date(+soldAt) } : { soldAt, clientSoldAt: null };
}

export function soldAtOutOfRange(soldAt, now) {
  const t = +soldAt;
  const earliest = +now - SOLD_AT_PAST_MS;
  const latest = +now + SOLD_AT_FUTURE_MS;
  if (t >= earliest && t <= latest) return null;
  return fail('sold_at_out_of_range', 400, { earliest: new Date(earliest).toISOString(), latest: new Date(latest).toISOString() });
}

/**
 * Price the sale. `priced` = parsed lines, each with listPriceTzs (from the product row).
 * → { error, status, ... } or { lines (with unitPriceTzs, lineTotalTzs, saleDiscountShareTzs), subtotalTzs,
 *   lineDiscountTzs, discountTzs, totalTzs, paidTzs, changeTzs }.
 */
export function priceSale(priced, discountTzs, payments, { credit = false } = {}) {
  const lines = priced.map((l) => {
    const unitPriceTzs = l.unitPriceTzs ?? l.listPriceTzs;
    return { ...l, unitPriceTzs, gross: l.qty * unitPriceTzs };
  });
  for (const l of lines) {
    // A product listed at 0 cannot be sold at 0: the seller must name a price.
    if (!(l.unitPriceTzs > 0)) return fail('invalid_price', 400, { productId: l.productId, variant: l.variant || null });
    if (l.discountTzs > l.gross) return fail('discount_exceeds_price', 400, { productId: l.productId, variant: l.variant || null, maxTzs: l.gross });
  }
  const subtotalTzs = lines.reduce((s, l) => s + l.gross, 0);
  const lineDiscountTzs = lines.reduce((s, l) => s + l.discountTzs, 0);
  if (subtotalTzs > MAX_SALE_TZS) return fail('total_too_large', 400, { max: MAX_SALE_TZS });
  const afterLines = subtotalTzs - lineDiscountTzs;
  if (discountTzs > afterLines) return fail('discount_exceeds_price', 400, { maxTzs: afterLines });
  const totalTzs = afterLines - discountTzs;

  const shares = allocate(discountTzs, lines.map(l => l.gross - l.discountTzs));
  const out = lines.map(({ gross, ...l }, i) => ({ ...l, lineTotalTzs: gross - l.discountTzs, saleDiscountShareTzs: shares[i] }));

  const paidTzs = payments.reduce((s, p) => s + p.amountTzs, 0);
  if (credit) {
    // Pay later (S4): something must be left owing, and nothing is given back as change.
    if (paidTzs > totalTzs) return fail('change_not_allowed', 400, { totalTzs, paidTzs });
    if (paidTzs === totalTzs) return fail('credit_fully_paid', 400, { totalTzs, paidTzs });
    return { lines: out, subtotalTzs, lineDiscountTzs, discountTzs, totalTzs, paidTzs, changeTzs: 0, balanceTzs: totalTzs - paidTzs };
  }
  if (totalTzs === 0 && payments.length) return fail('invalid_payment', 400, { reason: 'nothing_to_pay' });
  if (paidTzs > MAX_SALE_TZS) return fail('invalid_payment', 400, { reason: 'paid_too_large', max: MAX_SALE_TZS });
  if (paidTzs < totalTzs) return fail('payment_short', 409, { totalTzs, paidTzs, shortTzs: totalTzs - paidTzs });
  const changeTzs = paidTzs - totalTzs;
  const cashTzs = payments.filter(p => p.method === 'cash').reduce((s, p) => s + p.amountTzs, 0);
  // Only cash gives change: the other methods together may not pay more than the total.
  if (changeTzs > cashTzs) return fail('invalid_payment', 400, { reason: 'non_cash_over_total', totalTzs, nonCashTzs: paidTzs - cashTzs });
  if (changeTzs > totalTzs + MAX_CHANGE_OVER_TOTAL_TZS) return fail('invalid_payment', 400, { reason: 'change_too_large', maxChangeTzs: totalTzs + MAX_CHANGE_OVER_TOTAL_TZS });
  return { lines: out, subtotalTzs, lineDiscountTzs, discountTzs, totalTzs, paidTzs, changeTzs, balanceTzs: 0 };
}

/**
 * Split `amount` over `weights` in proportion, in whole TZS, summing exactly to `amount`
 * (largest remainders first; ties to the earlier line). No share exceeds its weight.
 */
export function allocate(amount, weights) {
  const total = weights.reduce((s, w) => s + w, 0);
  if (!amount || !total) return weights.map(() => 0);
  const raw = weights.map(w => (amount * w) / total);
  const shares = raw.map(Math.floor);
  let left = amount - shares.reduce((s, x) => s + x, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (!left) break;
    if (shares[i] < weights[i]) { shares[i] += 1; left -= 1; }
  }
  return shares;
}

/** POST /vendor/sales/:id/void body → { reason } or an error. */
export function parseVoid(body = {}) {
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < VOID_REASON.min) return fail('reason_required', 400, { min: VOID_REASON.min });
  if (reason.length > VOID_REASON.max) return fail('reason_too_long', 400, { max: VOID_REASON.max });
  return { reason };
}
