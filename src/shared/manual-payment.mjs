// Manual mobile-money payment (slice A3): the member pays the FitFlex Lipa
// Namba / till from their phone, then types the transaction ID the network
// sent them. An admin matches that ID against the till statement and approves
// the payment request as before. Pure helpers: no I/O.

/** Platform-settings fields and their maximum lengths. */
const LIMITS = Object.freeze({ accountName: 160, network: 60, instructions: 1000 });

const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/**
 * Validate the admin's `manualPayment` settings. `null` clears them.
 * Returns { value } or { error, field }.
 *   lipaNamba     required, digits (spaces/dashes dropped), 4–20 digits
 *   accountName   required, 2–160 characters
 *   network       optional, up to 60 characters (e.g. "M-Pesa")
 *   instructions  optional { en, sw }, each up to 1000 characters
 */
export function validateManualPaymentSettings(input) {
  if (input === null) return { value: null };
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'manual_payment_invalid', field: 'manualPayment' };
  const lipaNamba = typeof input.lipaNamba === 'string' || typeof input.lipaNamba === 'number'
    ? String(input.lipaNamba).replace(/[\s-]/g, '') : '';
  if (!/^\d{4,20}$/.test(lipaNamba)) return { error: 'manual_payment_invalid', field: 'lipaNamba' };
  const accountName = typeof input.accountName === 'string' ? input.accountName.trim() : '';
  if (accountName.length < 2 || accountName.length > LIMITS.accountName) return { error: 'manual_payment_invalid', field: 'accountName' };
  if (input.network != null && (typeof input.network !== 'string' || input.network.trim().length > LIMITS.network)) {
    return { error: 'manual_payment_invalid', field: 'network' };
  }
  let instructions = null;
  if (input.instructions != null) {
    const i = input.instructions;
    if (typeof i !== 'object' || Array.isArray(i)) return { error: 'manual_payment_invalid', field: 'instructions' };
    for (const lang of ['en', 'sw']) {
      if (i[lang] != null && (typeof i[lang] !== 'string' || i[lang].trim().length > LIMITS.instructions)) {
        return { error: 'manual_payment_invalid', field: `instructions.${lang}` };
      }
    }
    const en = text(i.en, LIMITS.instructions);
    const sw = text(i.sw, LIMITS.instructions);
    instructions = en || sw ? { en, sw } : null;
  }
  return { value: { lipaNamba, accountName, network: text(input.network, LIMITS.network), instructions } };
}

/** True when the settings hold what a member needs to pay: a Lipa Namba and the account name. */
export const manualPaymentConfigured = (s) => Boolean(s && s.lipaNamba && s.accountName);

/**
 * The `manual` block of GET /payments/options. `enabled` only when the flag is
 * on AND the details are configured; the details are shown only then.
 */
export function manualPaymentOptions(settings, flagOn) {
  const enabled = Boolean(flagOn && manualPaymentConfigured(settings));
  return {
    enabled,
    lipaNamba: enabled ? settings.lipaNamba : null,
    accountName: enabled ? settings.accountName : null,
    network: enabled ? settings.network ?? null : null,
    instructions: enabled ? settings.instructions ?? null : null,
    referenceRequired: enabled,
    payerPhoneRequired: enabled,
  };
}

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
