// Vendor walk-in refunds (vendor business tools · S7). Pure functions: no storage.
//
// Decided in the design spec docs/design/vendor-refunds-s7.md §1 (approved 2026-11-03, Q-1..Q-6 accepted):
// - M-1 a line gives back at most what was paid for it: lineNet = lineTotalTzs − saleDiscountShareTzs.
// - M-2 amounts are computed by the server, cumulatively from the ACTIVE refunds, rounding down; the last
//   unit takes whatever is left, so refunding everything returns exactly lineNet and never more.
// - M-3 the same rule on the line's stored vatTzs (VAT inside the price), so full refunds reverse it exactly.
// - M-4 on a pay-later sale the refund first comes off the balance still owed; the rest is paid back.
// - M-6 one method per refund, required only when money is paid back; reference rules as S3.
// - Q-2 no amount-only refunds: the client never sends money amounts.
// Walk-in money never passes through FitFlex: these figures are what the vendor gave back.
import { createHash } from 'node:crypto';
import { PAYMENT_METHODS, REFERENCE_REQUIRED, MAX_QTY_PER_LINE, MAX_LINES, MAX_REFERENCE } from './vendor-sale.mjs';

export const CREDIT_NOTE_DOC_TYPE = 'credit_note';
export const creditNoteNumber = seq => `CN-${String(seq).padStart(6, '0')}`;
export const REFUND_REASON = { min: 3, max: 200 };
export const REFUNDS_PAGE_DEFAULT = 50;
export const REFUNDS_PAGE_MAX = 200;
const CLIENT_REF = /^[A-Za-z0-9._:-]{8,100}$/;

const fail = (error, status, extra = {}) => ({ error, status, ...extra });

/** What a sale line can give back in total (M-1). */
export const lineNetOf = line => Number(line.lineTotalTzs) - Number(line.saleDiscountShareTzs || 0);

/**
 * M-2 (and M-3 with the line's VAT as `total`): what refunding `q` more units gives back, when `a` units and
 * `A` of `total` have already been given back by ACTIVE refunds, out of `Q` sold. Rounds down; the last unit
 * takes the rest; never below 0, never above what is left.
 */
export function cumulativeShare({ total, Q, a, A, q }) {
  if (a + q === Q) return total - A;
  return Math.max(0, Math.min(total - A, Math.floor((total * (a + q)) / Q) - A));
}

/** M-2 + M-3 for one sale line. → { amountTzs, vatTzs } */
export function refundLineAmounts(line, q) {
  const Q = Number(line.qty);
  const a = Number(line.refundedQty || 0);
  const amountTzs = cumulativeShare({ total: lineNetOf(line), Q, a, A: Number(line.refundedTzs || 0), q });
  const vat = cumulativeShare({ total: Number(line.vatTzs || 0), Q, a, A: Number(line.refundedVatTzs || 0), q });
  // VAT is inside the amount; the CHECK (vatTzs ≤ amountTzs) is the backstop.
  return { amountTzs, vatTzs: Math.min(vat, amountTzs) };
}

/** M-4: a pay-later sale's balance comes off first; the rest is money the vendor gives back. */
export function splitRefund(amountTzs, sale) {
  const balanceReducedTzs = sale.kind === 'credit' ? Math.min(amountTzs, Math.max(0, Number(sale.balanceTzs || 0))) : 0;
  return { balanceReducedTzs, paidOutTzs: amountTzs - balanceReducedTzs };
}

const textOf = v => (typeof v === 'string' ? v.trim() : '');

/**
 * What makes two requests with the same clientRef "the same refund" (a retry, not a reuse). Built from the
 * body as sent (normalised), so a replay is answered before any other check (spec §2.2 order of checks).
 */
export function refundFingerprint(saleId, body = {}) {
  const lines = Array.isArray(body?.lines)
    ? body.lines.map(l => [typeof l?.saleLineId === 'string' ? l.saleLineId : null, l?.qty ?? null, l?.restock !== false]).sort((x, y) => String(x[0]).localeCompare(String(y[0])))
    : null;
  return createHash('sha256').update(JSON.stringify({
    saleId: String(saleId || ''), lines, reason: textOf(body?.reason),
    method: typeof body?.method === 'string' ? body.method : null, reference: textOf(body?.reference) || null,
  })).digest('hex');
}

export const validClientRef = ref => typeof ref === 'string' && CLIENT_REF.test(ref);

/**
 * POST /vendor/sales/:id/refunds body → { clientRef, lines:[{ saleLineId, qty, restock }], reason, method, reference }
 * or a 400. The method and reference are judged later against the server's paidOutTzs (M-6).
 */
export function parseRefund(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid_body', 400);
  if (!validClientRef(body.clientRef)) return fail('invalid_client_ref', 400);
  if (!Array.isArray(body.lines) || !body.lines.length) return fail('lines_required', 400);
  if (body.lines.length > MAX_LINES) return fail('too_many_lines', 400, { max: MAX_LINES });
  const lines = [];
  const seen = new Set();
  for (const [index, raw] of body.lines.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_line', 400, { index });
    if (typeof raw.saleLineId !== 'string' || !raw.saleLineId || raw.saleLineId.length > 100) return fail('invalid_line', 400, { index, field: 'saleLineId' });
    if (!Number.isInteger(raw.qty) || raw.qty < 1 || raw.qty > MAX_QTY_PER_LINE) return fail('invalid_quantity', 400, { index, max: MAX_QTY_PER_LINE });
    if (raw.restock != null && typeof raw.restock !== 'boolean') return fail('invalid_line', 400, { index, field: 'restock' });
    if (seen.has(raw.saleLineId)) return fail('duplicate_line', 400, { saleLineId: raw.saleLineId });
    seen.add(raw.saleLineId);
    lines.push({ saleLineId: raw.saleLineId, qty: raw.qty, restock: raw.restock !== false });
  }
  const reason = parseReason(body.reason);
  if (reason.error) return reason;
  if (body.method != null && typeof body.method !== 'string') return fail('invalid_method', 400, { allowed: PAYMENT_METHODS });
  if (body.reference != null && typeof body.reference !== 'string') return fail('invalid_field', 400, { field: 'reference' });
  return {
    clientRef: body.clientRef, lines, reason: reason.reason,
    method: typeof body.method === 'string' && body.method ? body.method : null,
    reference: textOf(body.reference) || null,
  };
}

/** A refund / undo reason: 3–200 characters after trimming. */
export function parseReason(value) {
  const reason = textOf(value);
  if (reason.length < REFUND_REASON.min) return fail('reason_required', 400, { min: REFUND_REASON.min });
  if (reason.length > REFUND_REASON.max) return fail('reason_too_long', 400, { max: REFUND_REASON.max });
  return { reason };
}

/**
 * M-6, judged on the server's paidOutTzs: nothing paid back → method and reference are ignored (null);
 * otherwise a method from the S3 list, and a reference (≤ 100) for mobile money and bank.
 * → { method, reference } or a 400.
 */
export function refundMethod({ method, reference }, paidOutTzs) {
  if (!(paidOutTzs > 0)) return { method: null, reference: null };
  if (!method) return fail('method_required', 400);
  if (!PAYMENT_METHODS.includes(method)) return fail('invalid_method', 400, { allowed: PAYMENT_METHODS });
  const ref = method === 'cash' ? null : reference;
  if (ref && ref.length > MAX_REFERENCE) return fail('reference_too_long', 400, { max: MAX_REFERENCE });
  if (REFERENCE_REQUIRED.has(method) && !ref) return fail('reference_required', 400, { method });
  return { method, reference: ref || null };
}

/** refundState of a sale from its lines' active counters: none | partial | full (every unit refunded). */
export function refundStateOf(lines) {
  const any = lines.some(l => Number(l.refundedQty || 0) > 0);
  if (!any) return 'none';
  return lines.every(l => Number(l.refundedQty || 0) === Number(l.qty)) ? 'full' : 'partial';
}
