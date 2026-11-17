// Transaction IDs typed by a person: an organisation's payment notice for an
// event order (bank transfer or mobile money, checked by FitFlex finance) and
// the reference an admin records on an approval. Members no longer pay by hand
// and type an ID (owner decision 2026-11-17: AzamPay is the only payment
// method); requests made that way before keep their `memberReference`.
// Pure helpers: no I/O.

/**
 * The duplicate-detection key of any reference: upper case, letters and digits
 * only. "qgh7-xk2l9p." and "QGH7XK2L9P" are one transaction; "QGH7XK2L9P_1"
 * (an extra digit) is another. The database computes the same key from
 * `reference` with regexp_replace(upper(reference), '[^A-Z0-9]', '', 'g').
 */
export const referenceKey = (raw) => (raw == null ? '' : String(raw).toUpperCase().replace(/[^A-Z0-9]/g, ''));

/**
 * A member-typed transaction ID in canonical form (trimmed, upper case) plus
 * its key, or an error. 6–40 characters: letters, digits and . _ - (first one
 * a letter or digit), with at least one digit, and at least 6 letters/digits
 * once the punctuation is dropped. Mobile-money IDs such as M-Pesa's
 * "QGH7XK2L9P" always have a digit.
 */
export function normalizePaymentReference(raw) {
  if (raw == null || (typeof raw === 'string' && !raw.trim())) return { error: 'payment_reference_required' };
  if (typeof raw !== 'string' && typeof raw !== 'number') return { error: 'payment_reference_invalid' };
  const ref = String(raw).trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{5,39}$/.test(ref) || !/\d/.test(ref)) return { error: 'payment_reference_invalid' };
  const key = referenceKey(ref);
  if (key.length < 6) return { error: 'payment_reference_invalid' };
  return { reference: ref, key };
}

/**
 * The mobile-money number the member paid from (owner decision 2026-10-19), in
 * E.164: +255 then a Tanzanian mobile number (6x / 7x, 9 digits). Accepts
 * 0XXXXXXXXX, 255XXXXXXXXX and +255XXXXXXXXX, with spaces, dashes, dots or
 * brackets; anything else is invalid.
 */
export function normalizePayerPhone(raw) {
  if (raw == null || (typeof raw === 'string' && !raw.trim())) return { error: 'payer_phone_required' };
  if (typeof raw !== 'string' && typeof raw !== 'number') return { error: 'payer_phone_invalid' };
  const compact = String(raw).trim().replace(/[\s().-]/g, '');
  const m = /^(?:\+255|255|0)([67]\d{8})$/.exec(compact);
  return m ? { phone: `+255${m[1]}` } : { error: 'payer_phone_invalid' };
}

/** Payment-request statuses in which a reference counts as taken. */
export const REFERENCE_HOLDING_STATUSES = Object.freeze(['pending', 'approved']);

/** Audit action written for every refused duplicate transaction ID. */
export const DUPLICATE_ATTEMPT_ACTION = 'payment_reference_duplicate';
/** At most this many refused duplicates per member per window; then 429 too_many_attempts. */
export const DUPLICATE_ATTEMPT_LIMIT = Object.freeze({ max: 5, windowMs: 60 * 60_000 });

/**
 * Reference lookups over plain collections (unit specs, and a fallback). The
 * database version is src/infra/payment-reference-store.mjs.
 */
export function memoryReferenceStore({ paymentRequests, auditLog = null }) {
  return {
    /** Other pending/approved requests whose member key or reference key equals `key`. */
    async holders(key, { excludeId = null } = {}) {
      const rows = await paymentRequests.filterAsync(r => r.id !== excludeId
        && REFERENCE_HOLDING_STATUSES.includes(r.status)
        && ((r.memberReferenceKey ?? referenceKey(r.memberReference)) === key || (r.reference != null && referenceKey(r.reference) === key)));
      return rows.map(r => ({ id: r.id, status: r.status, memberId: r.memberId }));
    },
    /** Refused duplicates this member made since `since` (from the audit log). */
    async duplicateAttemptsSince(memberId, since) {
      if (!auditLog?.filterAsync) return 0;
      const rows = await auditLog.filterAsync(a => a.actor === memberId && a.action === DUPLICATE_ATTEMPT_ACTION && +new Date(a.at) >= +since);
      return rows.length;
    },
  };
}
