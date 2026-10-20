// Shop home banners — pure rules (no I/O). Contract: docs/shop-banners-api.md.
//
// Owner decisions 2026-10-20:
//   - banner text is required in English AND Swahili (missing_translation);
//   - banner text may not carry prices, percentages or amounts (price_claim_in_text): deals go
//     through flash sales, which the server prices;
//   - no maximum run length and no per-audience cap; SHOP_BANNER_MAX_LIVE only limits how many
//     the shop home shows (0 = no limit);
//   - undecided proposals expire after SHOP_PROPOSAL_EXPIRY_DAYS (14) or at their start, whichever
//     comes first.
import { PRODUCT_CATEGORY_KEYS } from './product-categories.mjs';

export const BANNER_STATUSES = Object.freeze(['draft', 'pending_approval', 'approved', 'ended', 'rejected', 'withdrawn', 'expired']);
/** What clients see: the stored status, except approved → live inside its window, and time-lapsed states. */
export const BANNER_EFFECTIVE_STATUSES = Object.freeze(['draft', 'pending_approval', 'approved', 'live', 'ended', 'rejected', 'withdrawn', 'expired']);
export const BANNER_ORIGINS = Object.freeze(['vendor', 'staff']);
export const BANNER_AUDIENCES = Object.freeze(['member', 'trainer', 'owner']);
export const VENDOR_TARGET_TYPES = Object.freeze(['product', 'vendor_store']);
export const STAFF_TARGET_TYPES = Object.freeze(['product', 'vendor_store', 'category', 'results']);
export const BANNER_PEOPLE = Object.freeze(['none', 'product_models']);
export const RESULTS_QUERY_KEYS = Object.freeze(['category', 'search', 'brand', 'vendorId', 'promotions', 'sort', 'delivery']);
export const REVIEW_CHECKS = Object.freeze(['people', 'text', 'languages']);
export const REJECT_CODES = Object.freeze(['image', 'people', 'text', 'claim', 'link', 'other']);

// Design spec §5.2.3 / P1 §6.3: lead + accent ≤ 32 (EN) / 42 (SW); subline ≤ 70 / 90.
export const TEXT_LIMITS = Object.freeze({
  headline: { en: 32, sw: 42 },
  subline: { en: 70, sw: 90 },
  ctaLabel: { en: 24, sw: 30 },
  imageAlt: { en: 160, sw: 200 },
});
export const REASON_MAX = 500;
/** A proposal must start at least this far ahead when it is sent (spec §5.2.3). */
export const MIN_LEAD_MS = 60 * 60 * 1000;
export const DEFAULT_PROPOSAL_EXPIRY_DAYS = 14;
export const BANNER_IMAGE_LIMITS = Object.freeze({ maxBytes: 5 * 1024 * 1024, minWidth: 1600, minHeight: 1000, formats: ['jpeg', 'png', 'webp'] });

/**
 * Button texts come from a fixed list (spec DD-P2-1): vendors pick a `ctaKey` (or leave it out),
 * never free text; FitFlex staff may also write their own `ctaLabel`. ("See the sale" arrives
 * with flash sales, slice 4.)
 */
export const CTA_LABELS = Object.freeze({
  view_product: Object.freeze({ en: 'View product', sw: 'Tazama bidhaa' }),
  visit_store: Object.freeze({ en: 'Visit store', sw: 'Tembelea duka' }),
  shop_now: Object.freeze({ en: 'Shop now', sw: 'Nunua sasa' }),
  view_all: Object.freeze({ en: 'View all', sw: 'Tazama zote' }),
});
/** The key used when none is given, by target; for vendors it is also the only key allowed. */
export const DEFAULT_CTA_KEY = Object.freeze({ product: 'view_product', vendor_store: 'visit_store', category: 'shop_now', results: 'view_all' });
/** Button text when the proposer gives none: by target (kept for callers of slice 1). */
export const DEFAULT_CTA = Object.freeze(Object.fromEntries(Object.entries(DEFAULT_CTA_KEY).map(([t, k]) => [t, CTA_LABELS[k]])));

/**
 * What the uploader confirms, versioned: the version accepted is stored on the photo. DRAFT
 * wording pending Tanzanian counsel (and Swahili native review); a new version makes clients that
 * send an old one get 400 confirmation_version_mismatch, so they show the current text.
 */
export const BANNER_CONFIRMATION = Object.freeze({
  version: '2026-10-20.draft1',
  status: 'draft_pending_counsel',
  rights: Object.freeze({
    en: 'I have the right to use this image, and FitFlex may show it in its apps and portal.',
    sw: 'Nina haki ya kutumia picha hii, na FitFlex inaweza kuionyesha kwenye app na portal zake.',
  }),
  models: Object.freeze({
    en: 'The people are models showing the product. The banner does not present them as FitFlex members, trainers or partners, and has no names or quotes from them. I hold their consent (model release) and give its reference.',
    sw: 'Watu hawa ni wanamitindo wanaoonyesha bidhaa. Bango haliwaonyeshi kama wanachama, ma-trainer au washirika wa FitFlex, na halina majina wala maneno yao. Nina ridhaa yao (model release) na ninatoa kumbukumbu yake.',
  }),
});

const DAY_MS = 86_400_000;
const positiveInt = (v, fallback) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : fallback);
const nonNegativeInt = (v, fallback) => (v != null && v !== '' && Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : fallback);

export const DEFAULT_MAX_OPEN_PROPOSALS = 10;

/**
 * SHOP_PROPOSAL_EXPIRY_DAYS (default 14), SHOP_BANNER_MAX_LIVE (display limit, default 0 = no
 * limit) and SHOP_BANNER_MAX_OPEN (a vendor's drafts + pending proposals at once, default 10).
 */
export function bannerConfigFromEnv(env = process.env) {
  return {
    proposalExpiryDays: positiveInt(env.SHOP_PROPOSAL_EXPIRY_DAYS, DEFAULT_PROPOSAL_EXPIRY_DAYS),
    maxLive: nonNegativeInt(env.SHOP_BANNER_MAX_LIVE, 0),
    maxOpenProposals: positiveInt(env.SHOP_BANNER_MAX_OPEN, DEFAULT_MAX_OPEN_PROPOSALS),
  };
}

const ms = v => (v == null ? NaN : new Date(v).getTime());

/** When a proposal sent at `submittedAt` expires if nobody decides: the earlier of +N days and its start. */
export function proposalExpiry(submittedAt, startsAt, days = DEFAULT_PROPOSAL_EXPIRY_DAYS) {
  const byDays = ms(submittedAt) + days * DAY_MS;
  const start = ms(startsAt);
  return new Date(Number.isFinite(start) ? Math.min(byDays, start) : byDays);
}

/** The state at `now`: time moves pending → expired and approved → live → ended without a write. */
export function effectiveStatus(b, now = new Date()) {
  const t = ms(now);
  if (b.status === 'pending_approval') return Number.isFinite(ms(b.expiresAt)) && t >= ms(b.expiresAt) ? 'expired' : 'pending_approval';
  if (b.status === 'approved') {
    if (t >= ms(b.endsAt)) return 'ended';
    if (t >= ms(b.startsAt)) return 'live';
    return 'approved';
  }
  return b.status;
}

// ── Text rules ──────────────────────────────────────────────────────────────

/**
 * The form every text is checked and stored in: NFKC (fullwidth ％ → %, fullwidth digits → ASCII,
 * ligatures split), format characters removed (zero-width spaces/joiners, bidi controls, soft
 * hyphens: \p{Cf}), whitespace collapsed. Checking the cleaned text closes "2​0%"-style bypasses.
 */
export const normaliseText = v => (typeof v === 'string'
  ? v.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim()
  : v);

// Prices, percentages and amounts (owner: none in banner text, either language). Kept deliberately
// strict: a false positive costs the proposer one rewrite; a stale price painted into a banner
// cannot be enforced at checkout. \p{Nd} = any decimal digit (Arabic-Indic too).
const NOT_LETTER_BEFORE = '(?<![\\p{L}])';
const NOT_LETTER_AFTER = '(?![\\p{L}])';
const PRICE_PATTERNS = [
  /[%٪﹪]/u,                                                     // any percent sign: 20% · % off · punguzo la %
  /\/=/u,                                                        // 5,000/=
  /\p{Nd}\s*\/-/u,                                               // 5000/-
  new RegExp(`${NOT_LETTER_BEFORE}(?:tsh|tshs|tzs|ksh|kshs|shs?|sh)\\.?\\s*\\p{Nd}`, 'iu'),          // TSh 50,000 · Sh. 500
  new RegExp(`\\p{Nd}[\\p{Nd},.\\s]*\\s*(?:tsh|tshs|tzs|ksh|shs?|shilingi|bob)${NOT_LETTER_AFTER}`, 'iu'), // 500 shilingi
  new RegExp(`${NOT_LETTER_BEFORE}(?:shilingi|asilimia|percent|per\\s*cent|pct|elfu|laki|milioni|million|punguzo|bure|nusu\\s*bei|half\\s*price|discount)${NOT_LETTER_AFTER}`, 'iu'),
  new RegExp(`${NOT_LETTER_BEFORE}(?:bei|price)\\s*:?\\s*\\p{Nd}`, 'iu'),                              // bei 5000 · price: 5000
  /\p{Nd}{1,3}(?:[,.]\p{Nd}{3})+/u,                              // 50,000 · 1.200.000
  /\p{Nd}{4,}/u,                                                 // a bare amount of 4+ digits (also blocks years: "Since 2019")
  // "50k" is not blocked: "5K run" is an event name, not a price.
];
// Links, handles and phone numbers (spec banner_text_has_contact): the banner's button is the only way out.
const TLDS = 'com|net|org|info|biz|shop|store|app|io|me|co|tz|ke|ug|rw|bi|africa|online|site|website|xyz|link|ly|tv|club|fit|fitness';
const CONTACT_PATTERNS = [
  /https?:\/\//iu,
  /www\./iu,
  new RegExp(`[\\p{L}\\p{Nd}-]+\\.(?:${TLDS})(?![\\p{L}\\p{Nd}-])`, 'iu'),                         // shop.co.tz · x.app · y.co.ke
  new RegExp(`${NOT_LETTER_BEFORE}(?:dot|nukta)\\s*(?:${TLDS})${NOT_LETTER_AFTER}`, 'iu'),          // "dot com"
  /(?:^|[^\p{L}\p{Nd}])@[\p{L}\p{Nd}_.]{2,}/u,                   // @handle
  /\+?\s*25[45][\s-]?\p{Nd}{2,3}[\s-]?\p{Nd}{3}[\s-]?\p{Nd}{3}/u, // +255 / +254 numbers
  /(?<!\p{Nd})0[167]\p{Nd}{2}[\s-]?\p{Nd}{3}[\s-]?\p{Nd}{3}(?!\p{Nd})/u,
  /\p{Nd}(?:[\s-]?\p{Nd}){8,}/u,                                 // any 9+ digit run
];

export const hasPriceClaim = s => typeof s === 'string' && PRICE_PATTERNS.some(re => re.test(normaliseText(s)));
export const hasContact = s => typeof s === 'string' && CONTACT_PATTERNS.some(re => re.test(normaliseText(s)));

const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const clean = normaliseText;

/**
 * One { en, sw } text from a request. undefined = not sent; null = cleared (optional fields only).
 * → { value } or { error }.
 */
function pair(field, raw, { optional = false } = {}) {
  if (raw === undefined) return { value: undefined };
  if (raw === null || (optional && raw && typeof raw === 'object' && !clean(raw.en) && !clean(raw.sw))) {
    return optional ? { value: null } : fail('missing_translation', 422, { field, missing: ['en', 'sw'] });
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_field', 400, { field });
  const unknown = Object.keys(raw).filter(k => !['en', 'sw'].includes(k));
  if (unknown.length) return fail('invalid_field', 400, { field, unknown });
  const en = clean(raw.en); const sw = clean(raw.sw);
  for (const [lang, v] of [['en', en], ['sw', sw]]) if (v != null && typeof v !== 'string') return fail('invalid_field', 400, { field: `${field}.${lang}` });
  const missing = [['en', en], ['sw', sw]].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return fail('missing_translation', 422, { field: `${field}.${missing[0]}`, missing });
  // Contacts first: a phone number is also a run of digits, and "remove the number" is the better message.
  for (const [lang, v] of [['en', en], ['sw', sw]]) if (hasContact(v)) return fail('contact_in_text', 422, { field: `${field}.${lang}` });
  for (const [lang, v] of [['en', en], ['sw', sw]]) if (hasPriceClaim(v)) return fail('price_claim_in_text', 422, { field: `${field}.${lang}` });
  return { value: { en, sw } };
}

function checkLength(field, value, limits) {
  if (!value) return null;
  for (const lang of ['en', 'sw']) {
    if (value[lang].length > limits[lang]) return fail('text_too_long', 422, { field: `${field}.${lang}`, max: limits[lang] });
  }
  return null;
}

function parseTarget(raw, { origin, vendorId }) {
  if (raw === undefined) return { value: undefined };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_target', 400, { field: 'target' });
  const allowed = origin === 'vendor' ? VENDOR_TARGET_TYPES : STAFF_TARGET_TYPES;
  if (!STAFF_TARGET_TYPES.includes(raw.type)) return fail('invalid_target', 400, { field: 'target.type', allowed });
  if (!allowed.includes(raw.type)) return fail('target_type_not_allowed', 403, { field: 'target.type', allowed });
  switch (raw.type) {
    case 'product':
      if (typeof raw.value !== 'string' || !raw.value.trim() || raw.value.length > 100) return fail('invalid_target', 400, { field: 'target.value' });
      return { value: { type: 'product', value: raw.value.trim() } };
    case 'vendor_store': {
      // A vendor may leave the value out: it is their own store.
      const v = raw.value == null || raw.value === '' ? (origin === 'vendor' ? vendorId : null) : raw.value;
      if (typeof v !== 'string' || !v.trim() || v.length > 100) return fail('invalid_target', 400, { field: 'target.value' });
      return { value: { type: 'vendor_store', value: v.trim() } };
    }
    case 'category':
      if (!PRODUCT_CATEGORY_KEYS.has(raw.value)) return fail('invalid_target', 400, { field: 'target.value', allowed: [...PRODUCT_CATEGORY_KEYS] });
      return { value: { type: 'category', value: raw.value } };
    case 'results': {
      const q = raw.value ?? {};
      if (typeof q !== 'object' || Array.isArray(q)) return fail('invalid_target', 400, { field: 'target.value' });
      const unknown = Object.keys(q).filter(k => !RESULTS_QUERY_KEYS.includes(k));
      if (unknown.length) return fail('invalid_target', 400, { field: 'target.value', unknown, allowed: RESULTS_QUERY_KEYS });
      const out = {};
      for (const [k, v] of Object.entries(q)) {
        if (v == null || v === '') continue;
        if (!['string', 'boolean'].includes(typeof v) || String(v).length > 100) return fail('invalid_target', 400, { field: `target.value.${k}` });
        out[k] = typeof v === 'string' ? v.trim() : v;
      }
      if (out.category && !PRODUCT_CATEGORY_KEYS.has(out.category)) return fail('invalid_target', 400, { field: 'target.value.category' });
      return { value: { type: 'results', value: out } };
    }
    default:
      return fail('invalid_target', 400, { field: 'target.type' });
  }
}

function parseAudience(raw) {
  if (raw === undefined) return { value: undefined };
  if (!Array.isArray(raw) || !raw.length) return fail('audience_required', 422, { field: 'audienceRoles', allowed: BANNER_AUDIENCES });
  const unknown = raw.filter(r => !BANNER_AUDIENCES.includes(r));
  if (unknown.length) return fail('invalid_audience', 400, { field: 'audienceRoles', unknown, allowed: BANNER_AUDIENCES });
  return { value: BANNER_AUDIENCES.filter(r => raw.includes(r)) };
}

function parseDate(field, raw) {
  if (raw === undefined) return { value: undefined };
  if (raw === null) return { value: null };
  const t = ms(raw);
  if (typeof raw !== 'string' || !Number.isFinite(t)) return fail('invalid_date', 400, { field });
  return { value: new Date(t).toISOString() };
}

export const VENDOR_CTA_KEYS = Object.freeze(['view_product', 'visit_store']);
export const EDITABLE_FIELDS = Object.freeze(['headlineLead', 'headlineAccent', 'subline', 'ctaKey', 'ctaLabel', 'imageAlt', 'target', 'audienceRoles', 'startsAt', 'endsAt']);

/**
 * The fields of a create or PATCH body, checked for shape and the text rules (not completeness:
 * a draft may be partial; submit checks that everything needed is there).
 * → { value: patch } or { error, status, field? }.
 */
export function parseBannerInput(body = {}, { origin, vendorId }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid_body', 400);
  const unknown = Object.keys(body).filter(k => !EDITABLE_FIELDS.includes(k));
  if (unknown.length) return fail('unknown_field', 400, { fields: unknown });
  const out = {};
  // Vendors choose the button from the fixed list; only FitFlex staff write their own text.
  if (origin === 'vendor' && body.ctaLabel !== undefined && body.ctaLabel !== null) {
    return fail('cta_label_not_allowed', 422, { field: 'ctaLabel', allowed: VENDOR_CTA_KEYS });
  }
  if (body.ctaKey !== undefined) {
    if (body.ctaKey === null) out.ctaKey = null;
    else if (!Object.hasOwn(CTA_LABELS, body.ctaKey) || (origin === 'vendor' && !VENDOR_CTA_KEYS.includes(body.ctaKey))) {
      return fail('invalid_cta_key', 422, { field: 'ctaKey', allowed: origin === 'vendor' ? VENDOR_CTA_KEYS : Object.keys(CTA_LABELS) });
    } else out.ctaKey = body.ctaKey;
  }
  for (const [field, optional] of [['headlineLead', false], ['headlineAccent', false], ['subline', true], ['ctaLabel', true], ['imageAlt', false]]) {
    const r = pair(field, body[field], { optional });
    if (r.error) return r;
    if (r.value !== undefined) out[field] = r.value;
  }
  for (const [field, limits] of [['subline', TEXT_LIMITS.subline], ['ctaLabel', TEXT_LIMITS.ctaLabel], ['imageAlt', TEXT_LIMITS.imageAlt]]) {
    const e = checkLength(field, out[field], limits);
    if (e) return e;
  }
  const target = parseTarget(body.target, { origin, vendorId });
  if (target.error) return target;
  if (target.value !== undefined) out.target = target.value;
  const audience = parseAudience(body.audienceRoles);
  if (audience.error) return audience;
  if (audience.value !== undefined) out.audienceRoles = audience.value;
  for (const field of ['startsAt', 'endsAt']) {
    const d = parseDate(field, body[field]);
    if (d.error) return d;
    if (d.value !== undefined) out[field] = d.value;
  }
  return { value: out };
}

/** Lead + accent together (each language) fit the headline limit. */
export function headlineError(b) {
  if (!b.headlineLead || !b.headlineAccent) return null;
  for (const lang of ['en', 'sw']) {
    const n = `${b.headlineLead[lang]} ${b.headlineAccent[lang]}`.length;
    if (n > TEXT_LIMITS.headline[lang]) return fail('headline_too_long', 422, { field: `headlineAccent.${lang}`, max: TEXT_LIMITS.headline[lang], length: n });
  }
  return null;
}

/** The window of a (merged) banner: end after start. */
export function windowError(b) {
  if (b.startsAt && b.endsAt && ms(b.endsAt) <= ms(b.startsAt)) return fail('end_before_start', 422, { field: 'endsAt' });
  return null;
}

/**
 * Everything a banner needs before it can be sent for approval (and again before it is approved):
 * all texts in both languages and within the rules, target, audience, a window starting at least an
 * hour from now (only checked when sending), and a photo. → null or { error, status, field? }.
 */
export function completenessError(b, { now = new Date(), checkStart = true } = {}) {
  // A vendor's button must be the one for its target ("View product" / "Visit store").
  if (b.origin === 'vendor' && b.ctaKey && b.target && b.ctaKey !== DEFAULT_CTA_KEY[b.target.type]) {
    return fail('invalid_cta_key', 422, { field: 'ctaKey', allowed: [DEFAULT_CTA_KEY[b.target.type]] });
  }
  for (const field of ['headlineLead', 'headlineAccent', 'imageAlt']) {
    if (!b[field]) return fail('missing_translation', 422, { field: `${field}.en`, missing: ['en', 'sw'] });
  }
  // Stored rows are re-checked too, in case the rules tightened since they were written.
  for (const field of ['headlineLead', 'headlineAccent', 'subline', 'ctaLabel', 'imageAlt']) {
    if (!b[field]) continue;
    const r = pair(field, b[field]);
    if (r.error) return r;
  }
  const h = headlineError(b);
  if (h) return h;
  if (!b.target) return fail('target_required', 422, { field: 'target' });
  if (!Array.isArray(b.audienceRoles) || !b.audienceRoles.length) return fail('audience_required', 422, { field: 'audienceRoles', allowed: BANNER_AUDIENCES });
  if (!b.startsAt) return fail('start_required', 422, { field: 'startsAt' });
  if (!b.endsAt) return fail('end_required', 422, { field: 'endsAt' });
  const w = windowError(b);
  if (w) return w;
  if (checkStart && ms(b.startsAt) < ms(now) + MIN_LEAD_MS) return fail('start_too_soon', 422, { field: 'startsAt', earliestStart: new Date(ms(now) + MIN_LEAD_MS).toISOString() });
  if (!b.imageId) return fail('image_required', 422, { field: 'image' });
  return null;
}

/** The CTA a banner shows: its own, else the default for its target. */
export const ctaFor = b => b.ctaLabel || CTA_LABELS[b.ctaKey] || CTA_LABELS[DEFAULT_CTA_KEY[b.target?.type]] || CTA_LABELS.view_all;
/** The key of the button in effect (null when staff wrote their own text). */
export const ctaKeyFor = b => (b.ctaLabel ? null : b.ctaKey || DEFAULT_CTA_KEY[b.target?.type] || 'view_all');
