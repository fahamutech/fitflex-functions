// Phone numbers as WhatsApp and SMS providers want them: E.164 ("+2557…").
// Members type numbers many ways — "0712 345 678", "255712345678",
// "+255 712 345 678" — and a local number without a country code is taken
// as Tanzanian.

export const DEFAULT_COUNTRY_CODE = '255';

/** E.164 form of `phone`, or null if it can't be a phone number. */
export function toE164(phone, countryCode = DEFAULT_COUNTRY_CODE) {
  if (typeof phone !== 'string' && typeof phone !== 'number') return null;
  const raw = String(phone).trim();
  if (!raw) return null;
  let digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+')) {
    // already international
  } else if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (digits.startsWith('0')) {
    digits = countryCode + digits.slice(1);
  } else if (digits.length === 9) {
    // "712345678": a local number with the leading 0 dropped
    digits = countryCode + digits;
  }
  return /^[1-9]\d{9,14}$/.test(digits) ? `+${digits}` : null;
}

/**
 * The ways the same number might be stored, as bare digits — to find a
 * member from an incoming WhatsApp number whatever format they typed.
 */
export function storedDigitVariants(e164, countryCode = DEFAULT_COUNTRY_CODE) {
  const digits = String(e164 || '').replace(/\D/g, '');
  if (!digits) return [];
  const variants = new Set([digits]);
  if (digits.startsWith(countryCode)) {
    const local = digits.slice(countryCode.length);
    variants.add(`0${local}`);
    variants.add(local);
  }
  return [...variants];
}

/** "+255712345678" → "+255 7•• ••• 678", for logs and admin screens. */
export function maskPhone(e164) {
  if (!e164) return '';
  const s = String(e164);
  return s.length <= 7 ? '•••' : `${s.slice(0, 5)}•• ••• ${s.slice(-3)}`;
}
