// Marathon & running events · S4 — the only code allowed to produce EventPayment.rawRedacted (spec §3.15, follow-ups S4).
// An ALLOWLIST per provider: unknown keys are dropped, not masked. The signature header, tokens, MSISDN and
// merchant secrets are never in an allowlist. Values must be strings or finite numbers (objects, arrays, null and
// booleans are dropped). A string of 9 or more digits, or starting +255 / 255 / 0 followed by 9 digits, is replaced
// by its last three digits. The result is serialised at most 2 KB or dropped entirely. manual and free write null.

export const ALLOWLISTS = Object.freeze({
  tunzaa: Object.freeze(['transaction_id', 'reference_id', 'status', 'amount', 'payment_date', 'timestamp', 'remark']),
});
const MAX_BYTES = 2048;
const REMARK_MAX = 200;
// Phone numbers as people write them (+255 712 345 678, 0712-345-678) and any run of 9 or more digits.
const SPACED_PHONE = /(?<![\d])(?:\+?255|0)[\s-]?\d{2,3}[\s-]?\d{3}[\s-]?\d{3,4}(?![\d])/g;
const LONG_DIGITS = /\d{9,}/g;

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const last3 = run => `***${run.replace(/\D/g, '').slice(-3)}`;

function scrub(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  return value.replace(SPACED_PHONE, last3).replace(LONG_DIGITS, last3);
}

/** → a plain object that is safe to store, or null. */
export function redactProviderPayload(provider, payload) {
  const allow = ALLOWLISTS[provider];
  if (!allow || !payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  // Tunzaa's status read spells the id `transactionID`; the callback spells it `transaction_id`. Same field, one name.
  if (provider === 'tunzaa' && !own(payload, 'transaction_id') && own(payload, 'transactionID')) payload = { ...payload, transaction_id: payload.transactionID };
  const out = { provider };
  for (const key of allow) {
    if (!own(payload, key)) continue;
    let v = scrub(payload[key]);
    if (v === undefined) continue;
    if (key === 'remark' && typeof v === 'string') v = v.trim().slice(0, REMARK_MAX);
    out[key] = v;
  }
  if (Object.keys(out).length <= 1) return null;
  return Buffer.byteLength(JSON.stringify(out)) <= MAX_BYTES ? out : null;
}
