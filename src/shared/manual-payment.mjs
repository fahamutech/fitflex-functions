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
  };
}

/**
 * A member-typed transaction ID in canonical form (trimmed, upper case), or an
 * error. 6–40 characters: letters, digits and . _ - (first one a letter or
 * digit), with at least one digit; mobile-money IDs such as M-Pesa's
 * "QGH7XK2L9P" always have one.
 */
export function normalizePaymentReference(raw) {
  if (raw == null || (typeof raw === 'string' && !raw.trim())) return { error: 'payment_reference_required' };
  if (typeof raw !== 'string' && typeof raw !== 'number') return { error: 'payment_reference_invalid' };
  const ref = String(raw).trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{5,39}$/.test(ref) || !/\d/.test(ref)) return { error: 'payment_reference_invalid' };
  return { reference: ref };
}

/** Payment-request statuses in which a member reference counts as taken. */
export const REFERENCE_HOLDING_STATUSES = Object.freeze(['pending', 'approved']);
