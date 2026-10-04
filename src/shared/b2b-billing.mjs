// B2B billing rules that need no database (Phase 5).
//
// Money is whole TZS and VAT-inclusive. Days are EAT calendar days
// "YYYY-MM-DD"; a due date is a day, and an invoice is overdue from the day
// after it.
import { addDays } from './member-progress.mjs';

export const PAYMENT_METHODS = Object.freeze(['bank_transfer', 'mobile_money', 'lipa_namba', 'cheque', 'cash', 'card', 'other']);
/** Terms used when an organisation has no agreement in force (decided 4 Oct 2026). */
export const DEFAULT_TERMS = Object.freeze({ prepaidTermsDays: 0, usageTermsDays: 14, platformFeeTzs: null, vatRateBps: null });
/** Invoices raised before the service is given are due on the advance terms; the rest on the usage terms. */
export const ADVANCE_KINDS = Object.freeze(['prepaid', 'fee']);
export const NOTE_KINDS = Object.freeze(['credit_note', 'debit_note']);
export const OPEN_STATUSES = Object.freeze(['issued', 'partially_paid']);
export const BILLED_STATUSES = Object.freeze(['issued', 'partially_paid', 'paid']);
export const DOCUMENT_SERIES = Object.freeze({ prepaid: 'INV', usage: 'INV', fee: 'INV', debit_note: 'DN', credit_note: 'CN' });
export const AGING_BUCKETS = Object.freeze(['current', 'days1to30', 'days31to60', 'days61to90', 'over90']);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const fail = (error, extra = {}) => ({ error, status: 400, ...extra });
const whole = v => Number.isInteger(v) && v >= 0;
export const isDay = v => typeof v === 'string' && DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

/** "FF-INV-2026-000123" */
export const documentNumber = (series, year, n) => `FF-${series}-${year}-${String(n).padStart(6, '0')}`;

/** The day an invoice issued on `issuedDay` falls due. */
export function dueDateFor({ kind, issuedDay, terms = DEFAULT_TERMS }) {
  const days = ADVANCE_KINDS.includes(kind) ? terms.prepaidTermsDays : terms.usageTermsDays;
  return addDays(issuedDay, Number.isInteger(days) ? days : 0);
}

/** What is still owed on an invoice (for a credit, what is still to be applied; negative). */
export function outstandingTzs(invoice) {
  if (!OPEN_STATUSES.includes(invoice.status)) return 0;
  const left = Math.abs(invoice.totalTzs) - (invoice.amountPaidTzs || 0);
  return invoice.totalTzs < 0 ? -left : left;
}

/** Days past due on `today` (0 when not yet due, or when there is no due date). */
export function daysOverdue(dueDate, today) {
  if (!dueDate || dueDate >= today) return 0;
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86_400_000);
}

export function agingBucket(dueDate, today) {
  const d = daysOverdue(dueDate, today);
  if (d <= 0) return 'current';
  if (d <= 30) return 'days1to30';
  if (d <= 60) return 'days31to60';
  if (d <= 90) return 'days61to90';
  return 'over90';
}

export const emptyAging = () => Object.fromEntries(AGING_BUCKETS.map(b => [b, 0]));

/** Validate a commercial agreement (create, or an update merged over the stored draft). */
export function readAgreement(body = {}) {
  if (!isDay(body.effectiveFrom)) return fail('invalid_effective_from');
  if (body.effectiveTo != null && (!isDay(body.effectiveTo) || body.effectiveTo < body.effectiveFrom)) return fail('invalid_effective_to');
  const days = (v, fallback) => (v === undefined || v === null ? fallback : v);
  const prepaidTermsDays = days(body.prepaidTermsDays, DEFAULT_TERMS.prepaidTermsDays);
  const usageTermsDays = days(body.usageTermsDays, DEFAULT_TERMS.usageTermsDays);
  for (const [k, v] of [['prepaidTermsDays', prepaidTermsDays], ['usageTermsDays', usageTermsDays]]) {
    if (!whole(v) || v > 365) return fail('invalid_payment_terms', { field: k, min: 0, max: 365 });
  }
  const fee = body.platformFeeTzs ?? null;
  if (fee !== null && !whole(fee)) return fail('invalid_platform_fee');
  const vat = body.vatRateBps ?? null;
  if (vat !== null && (!whole(vat) || vat > 10000)) return fail('invalid_vat_rate', { hint: 'basis points, e.g. 1800 for 18%' });
  if (body.billingCycle != null && body.billingCycle !== 'monthly') return fail('unsupported_billing_cycle', { allowed: ['monthly'] });
  if (body.currency != null && body.currency !== 'TZS') return fail('unsupported_currency', { allowed: ['TZS'] });
  const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  return {
    patch: {
      effectiveFrom: body.effectiveFrom, effectiveTo: body.effectiveTo ?? null, billingCycle: 'monthly', currency: 'TZS',
      prepaidTermsDays, usageTermsDays, platformFeeTzs: fee || null, vatRateBps: vat,
      contractReference: text(body.contractReference, 120), notes: text(body.notes, 2000),
    },
  };
}

/** The terms an invoice is issued under, kept on the invoice. */
export function termsSnapshot(agreement) {
  if (!agreement) return { agreementId: null, source: 'default', ...DEFAULT_TERMS };
  return {
    agreementId: agreement.id, reference: agreement.reference, source: 'agreement',
    prepaidTermsDays: agreement.prepaidTermsDays, usageTermsDays: agreement.usageTermsDays,
    platformFeeTzs: agreement.platformFeeTzs ?? null, vatRateBps: agreement.vatRateBps ?? null,
  };
}

/** Validate a payment being recorded. */
export function readPayment(body = {}) {
  if (!Number.isInteger(body.amountTzs) || body.amountTzs <= 0) return fail('invalid_amount', { hint: 'whole TZS, more than zero' });
  if (!PAYMENT_METHODS.includes(body.method)) return fail('invalid_payment_method', { allowed: PAYMENT_METHODS });
  const reference = typeof body.reference === 'string' ? body.reference.trim().slice(0, 200) : '';
  if (!reference) return fail('payment_reference_required');
  const receivedAt = body.receivedAt ? new Date(body.receivedAt) : null;
  if (body.receivedAt && Number.isNaN(+receivedAt)) return fail('invalid_received_at');
  return {
    patch: {
      amountTzs: body.amountTzs, method: body.method, reference, receivedAt,
      note: typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 1000) : null,
    },
  };
}
