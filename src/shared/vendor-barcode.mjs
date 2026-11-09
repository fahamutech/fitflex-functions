// Vendor business tools · S8 — barcode rules (design docs/design/vendor-barcodes-s8.md §1). Pure functions.
// The same rules run in the app (lib/screens/vendor/barcodes/barcode_rules.dart) and the portal
// (src/lib/barcode-rules.ts); specs/fixtures/barcode-vectors.json holds the shared test vectors.
//
// B-1 a code is 4–48 printable ASCII characters (0x21–0x7E) after trimming: no spaces, no control characters.
// B-2 codeKey: all digits, 12 long (UPC-A) → '0' + code; all digits, 14 long starting with 0 → drop that 0;
//     other all-digit codes unchanged (8 digits are never expanded); anything with a letter or symbol → upper case.
// B-3 all-digit codes 12, 13 or 14 long must pass the GTIN mod-10 check (Q-2). 8-digit codes are not checked.
// B-4 one codeKey per vendor; the same code twice in one body → duplicate_barcode.
// B-5 at most 20 codes per product (all variants included).

export const BARCODE_MIN = 4;
export const BARCODE_MAX = 48;
export const MAX_BARCODES_PER_PRODUCT = 20;
export const LOOKUP_CODE_MAX = 100;
export const VARIANT_NAME_MAX = 60;
export const MAX_SKU_MATCHES = 10;

// SWAHILI IS DRAFT: every `sw` text below is marked for native-speaker review. Terms: barcode = msimbopau
// (plural misimbopau, new to the glossary), variant = chaguo. The apps translate by `error`; the server also returns
// `message: { en, sw }` on the S8 errors.
export const SWAHILI_REVIEW_STATUS = 'draft_for_native_review';
const M = (en, sw) => Object.freeze({ en, sw });
export const BARCODE_MESSAGES = Object.freeze({
  'invalid_barcode.too_short': M('A barcode has at least 4 characters.', 'Msimbopau una angalau herufi 4.'),
  'invalid_barcode.too_long': M('A barcode has at most 48 characters.', 'Msimbopau hauzidi herufi 48.'),
  'invalid_barcode.bad_characters': M('Use letters, numbers and symbols only, with no spaces.', 'Tumia herufi, namba na alama tu, bila nafasi.'),
  invalid_check_digit: M('This number doesn\'t look right. Check the last digit.', 'Namba hii haionekani sahihi. Hakiki tarakimu ya mwisho.'),
  duplicate_barcode: M('This barcode is already in the list.', 'Msimbopau huu tayari upo kwenye orodha.'),
  barcode_in_use: M('Already on {name}.', 'Tayari upo kwenye {name}.'),
  too_many_barcodes: M('A product can have up to {max} barcodes.', 'Bidhaa inaweza kuwa na misimbopau hadi {max}.'),
  barcode_variant_not_found: M('The option {variant} no longer exists. Choose again.', 'Chaguo {variant} halipo tena. Chagua tena.'),
  barcodes_conflict: M('Send either the full list of barcodes or the barcodes to add, not both.', 'Tuma orodha kamili ya misimbopau au misimbopau ya kuongeza, si zote mbili.'),
  invalid_field: M('This list of barcodes is not valid.', 'Orodha hii ya misimbopau si sahihi.'),
  code_required: M('Enter or scan a code.', 'Andika au skani msimbo.'),
  'invalid_code.too_long': M('This code is too long.', 'Msimbo huu ni mrefu mno.'),
  'invalid_code.bad_characters': M('Use letters, numbers and symbols only, with no spaces.', 'Tumia herufi, namba na alama tu, bila nafasi.'),
});

const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (all, k) => (vars[k] != null ? String(vars[k]) : all));
/** `message: { en, sw }` for an S8 error (by `error`, and `reason` where the error has one). */
export function barcodeMessage(error, vars = {}) {
  const m = BARCODE_MESSAGES[vars.reason ? `${error}.${vars.reason}` : error] || BARCODE_MESSAGES[error];
  return m ? { en: fill(m.en, vars), sw: fill(m.sw, vars) } : undefined;
}
const fail = (error, status, extra = {}) => ({ error, status, ...extra, message: barcodeMessage(error, extra) });
export const barcodeError = fail;

const PRINTABLE = /^[\x21-\x7E]+$/;
const DIGITS = /^\d+$/;

/** GTIN mod-10 check (EAN-8/12/13/14): weights 3,1,3,… from the digit left of the check digit. */
export function checkGtin(digits) {
  if (typeof digits !== 'string' || !DIGITS.test(digits) || digits.length < 2) return false;
  let sum = 0;
  for (let i = digits.length - 2, w = 3; i >= 0; i -= 1, w = w === 3 ? 1 : 3) sum += Number(digits[i]) * w;
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

/** B-2: the key codes are compared by. Total (never throws) for any string; the input is trimmed. */
export function codeKey(raw) {
  const code = String(raw ?? '').trim();
  if (DIGITS.test(code)) {
    if (code.length === 12) return `0${code}`;
    if (code.length === 14 && code[0] === '0') return code.slice(1);
    return code;
  }
  return code.toUpperCase();
}

/** B-1 + B-3 on one code. → { code, codeKey } or { error, status, code, reason? }. */
export function validateBarcode(raw) {
  const code = String(raw ?? '').trim();
  if (code.length < BARCODE_MIN) return fail('invalid_barcode', 400, { code, reason: 'too_short' });
  if (code.length > BARCODE_MAX) return fail('invalid_barcode', 400, { code, reason: 'too_long' });
  if (!PRINTABLE.test(code)) return fail('invalid_barcode', 400, { code, reason: 'bad_characters' });
  if (DIGITS.test(code) && [12, 13, 14].includes(code.length) && !checkGtin(code)) return fail('invalid_check_digit', 400, { code });
  return { code, codeKey: codeKey(code) };
}

/**
 * The barcode fields of a product save body (§2.3). Run before anything is written.
 * → null (neither field sent) | { error, status, ... } | { mode: 'replace' | 'add', items: [{ code, codeKey, variant }] }
 * variant: '' = the whole product (left out, null or '' in the body).
 */
export function parseBarcodeFields(body = {}) {
  const hasSet = body.barcodes !== undefined;
  const hasAdd = body.addBarcodes !== undefined;
  if (!hasSet && !hasAdd) return null;
  if (hasSet && hasAdd) return fail('barcodes_conflict', 400);
  const field = hasSet ? 'barcodes' : 'addBarcodes';
  const list = body[field];
  if (!Array.isArray(list) || list.some(x => !x || typeof x !== 'object' || Array.isArray(x) || typeof x.code !== 'string'
    || (x.variant != null && (typeof x.variant !== 'string' || x.variant.trim().length > VARIANT_NAME_MAX)))) {
    return fail('invalid_field', 400, { field });
  }
  // B-5 (AC-7: "a 21st code → too_many_barcodes"): checked on the body before any code is read.
  if (list.length > MAX_BARCODES_PER_PRODUCT) return fail('too_many_barcodes', 400, { max: MAX_BARCODES_PER_PRODUCT });
  const seen = new Set();
  const items = [];
  for (const x of list) {
    const ok = validateBarcode(x.code);
    if (ok.error) return ok;
    if (seen.has(ok.codeKey)) return fail('duplicate_barcode', 400, { code: ok.code });
    seen.add(ok.codeKey);
    items.push({ code: ok.code, codeKey: ok.codeKey, variant: typeof x.variant === 'string' ? x.variant.trim() : '' });
  }
  return { mode: hasSet ? 'replace' : 'add', items };
}

/** A variant object in the body may not carry codes (they would be stored on the public row): true when one does. */
export const variantCarriesBarcodes = variants => Array.isArray(variants)
  && variants.some(v => v && typeof v === 'object' && (v.barcodes !== undefined || v.addBarcodes !== undefined));

/**
 * GET /vendor/products/lookup?code= (§2.4): 1–100 printable ASCII after trimming, so short SKUs can be found.
 * → { code, codeKey, barcode: boolean (passes B-1/B-3, so it can match a ProductCode) } | { error, status, reason? }.
 */
export function parseLookupCode(raw) {
  const code = typeof raw === 'string' ? raw.trim() : '';
  if (!code) return fail('code_required', 400);
  if (code.length > LOOKUP_CODE_MAX) return fail('invalid_code', 400, { reason: 'too_long' });
  if (!PRINTABLE.test(code)) return fail('invalid_code', 400, { reason: 'bad_characters' });
  return { code, codeKey: codeKey(code), barcode: !validateBarcode(code).error };
}
