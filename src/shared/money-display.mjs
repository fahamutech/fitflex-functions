// How money reads in text people see: notifications (push, SMS, WhatsApp,
// email), statements, invoices, receipts, notices and alerts.
//
// Owner decision D-8 (2026-10-19): displayed amounts use "TSh" in English and
// Swahili ("TSh 279,000"). "TZS" stays only as the ISO 4217 code in data, API
// fields (currency: 'TZS'), the database, payment-provider payloads and
// exports that need ISO codes. Never parse this text; use the numeric *Tzs
// fields instead.

/** The label shown before an amount, in every language. */
export const CURRENCY_DISPLAY_LABEL = 'TSh';

/** The ISO 4217 code kept in data and APIs. */
export const CURRENCY_ISO_CODE = 'TZS';

/**
 * An amount in whole shillings as people read it: "TSh 1,234".
 * A missing amount reads as "TSh 0", as the old per-service helpers did.
 * @param {number|string|null|undefined} amount
 * @returns {string}
 */
export function formatTsh(amount) {
  return `${CURRENCY_DISPLAY_LABEL} ${Number(amount || 0).toLocaleString('en-US')}`;
}
