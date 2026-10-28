// Marathon & running events · S4 — small pure helpers shared by the payment and refund services (spec §3.5).

export const iso = v => (v ? new Date(v).toISOString() : null);

/** "+255712345678" → "+255 7•• ••• 678" (what the member sees of the number they paid from). null stays null. */
export function maskPayerPhone(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length < 9) return null;
  const last3 = digits.slice(-3);
  const first = digits.slice(-9, -8);
  return `+255 ${first}•• ••• ${last3}`;
}

/** Payout destination as shown to the member: the last three digits only. */
export function maskPaidTo(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const digits = text.replace(/\D/g, '');
  return digits.length >= 6 ? `••• ${digits.slice(-3)}` : null;
}

/**
 * RefundView (§3.5): what a member sees of a refund. The payout reference only once it is paid, the rejection
 * note only when it was refused (it is the member-visible note); no staff identity, no policy internals.
 */
export function refundView(r) {
  if (!r) return null;
  return {
    id: r.id, status: r.status, scope: r.scope ?? null, amountTzs: Number(r.amountTzs), currency: r.currency ?? 'TZS',
    requestedAt: iso(r.createdAt), decidedAt: iso(r.decidedAt), paidAt: iso(r.paidAt),
    paidTo: r.status === 'paid' ? maskPaidTo(r.paidTo) : null,
    paymentReference: r.status === 'paid' ? (r.paymentReference ?? null) : null,
    rejectionNote: r.status === 'rejected' ? (r.decisionNote ?? null) : null,
  };
}

export const REJECT_CODES = Object.freeze(['reference_not_found', 'amount_mismatch', 'wrong_account', 'duplicate_reference', 'other']);
export const MEMBER_NOTE_MAX = 140;

/** The PaymentView `state` of an EventPayment row (the server derives it; the apps never infer money state). */
export function paymentStateOf(payment) {
  if (!payment) return 'none';
  switch (payment.status) {
    case 'succeeded': return 'confirmed';
    case 'pending': return payment.method === 'provider' || payment.provider === 'tunzaa' ? 'processing' : 'submitted';
    case 'created': return 'none';
    case 'expired': return 'expired';
    case 'reconciliation_required': return 'needs_attention';
    case 'cancelled': return 'failed';
    case 'failed':
      if (payment.failureReason === 'refunded_after_late_payment') return 'needs_attention';
      return payment.rejectCode || String(payment.failureReason ?? '').startsWith('rejected:') ? 'rejected' : 'failed';
    default: return 'none';
  }
}
