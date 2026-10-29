// Partner hero photo and logo: limits, server-sent texts, reason codes (design spec
// photo-hero-screens.md §44.3, §44.4; owner decisions 2026-10-29). Dormant behind PARTNER_MEDIA.
//
// Every text a partner or admin confirms is versioned and stamped draft_pending_counsel: the
// legal wording waits for Tanzanian counsel. Swahili is a DRAFT for native review.

export const SUBJECT_TYPES = Object.freeze(['gym', 'trainer', 'vendor']);
export const MEDIA_KINDS = Object.freeze(['hero', 'logo']);
export const MEDIA_STATUSES = Object.freeze(['live', 'replaced', 'removed', 'taken_down']);
export const PLATE_CHOICES = Object.freeze(['auto', 'light', 'dark']);

/** Which userType acts for which kind of partner. */
export const SUBJECT_TYPE_OF_ROLE = Object.freeze({
  gym_operator: 'gym', gym_staff: 'gym', trainer: 'trainer', vendor: 'vendor', vendor_staff: 'vendor',
});
export const PARTNER_ROLES = Object.freeze(Object.keys(SUBJECT_TYPE_OF_ROLE));

/** Files per kind: what GET /partner/media/:id/file?variant= may serve (never the master). */
export const SERVED_VARIANTS = Object.freeze({ hero: Object.freeze(['x2', 'x1']), logo: Object.freeze(['logo256', 'logo128']) });
export const DEFAULT_VARIANT = Object.freeze({ hero: 'x2', logo: 'logo256' });
export const PREVIEW_WIDTHS = Object.freeze([240, 480, 960]);

export const PARTNER_MEDIA_LIMITS = Object.freeze({
  hero: Object.freeze({
    minWidth: 1080,
    maxBytes: 15 * 1024 * 1024,
    // The decoder's limit (HERO_LIMITS.maxPixels in hero-image-file.mjs): width × height before rotation.
    maxPixels: 50_000_000,
    types: Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']),
  }),
  logo: Object.freeze({
    minSide: 256,
    maxSide: 4000,
    maxBytes: 2 * 1024 * 1024,
    types: Object.freeze(['image/png', 'image/jpeg', 'image/webp']),
  }),
});

/**
 * Upload caps.
 * - O-P5 (owner 2026-10-29), per partner (subject), both kinds together: 10 a minute, and 20
 *   SUCCESSFUL uploads a day (re-review R5: refused or failed attempts never use these 20, so a
 *   teammate's failures cannot lock the owner out).
 * - Attempts per partner, whatever their outcome: 60 a day (their own cap, R5).
 * - Per person, checked before the request body is read (security review M3): 10 attempts a minute
 *   and 40 a day across every gym the person runs.
 */
export const UPLOAD_RATE = Object.freeze({ perMinute: 10, perDay: 20, perDayAttempts: 60, perUserMinute: 10, perUserDay: 40 });
/** Previews (review M3): made once at upload; the routes only read them. Per person per minute. */
export const PREVIEW_VARIANT_OF_WIDTH = Object.freeze({ 240: 'p240', 480: 'p480', 960: 'p960' });
export const PREVIEW_RATE = Object.freeze({ partnerPerMinute: 120, adminPerMinute: 300 });
/** Review M3: at most this many partner images are decoded at once in one server process; more waiting → 503. */
export const IMAGE_JOBS = Object.freeze({ concurrent: 2, maxWaiting: 20 });
/** GET /admin/partner-media/subjects: the partner picker. */
export const SUBJECT_SEARCH = Object.freeze({ minQuery: 2, maxQuery: 100, defaultLimit: 10, maxLimit: 25 });
/** A FitFlex reason for putting back a file taken down at a person's request (review L2). */
export const OVERRIDE_REASON_MAX = 500;

// §44.3 (partner). The app renders these verbatim and sends `version` back with the upload.
export const PARTNER_CONFIRMATION = Object.freeze({
  version: '2026-10-29.draft1',
  status: 'draft_pending_counsel',
  rights: Object.freeze({
    en: 'I took this photo or have the right to use it, and FitFlex may show it on my home in the FitFlex app.',
    sw: 'Nilipiga picha hii au nina haki ya kuitumia, na FitFlex inaweza kuionyesha kwenye ukurasa wangu wa mwanzo kwenye app ya FitFlex.',
  }),
  ownLogo: Object.freeze({
    en: "This is my own business's logo, not another brand's.",
    sw: 'Hii ni nembo ya biashara yangu mwenyewe, si ya chapa nyingine.',
  }),
});

// §44.3 (admin, brand_media "Set photo for this partner").
export const ADMIN_CONFIRMATION = Object.freeze({
  version: '2026-10-29.draft1',
  status: 'draft_pending_counsel',
  rights: Object.freeze({
    en: "FitFlex has the right to use this image, and it may show on this partner's home in the app.",
    sw: 'FitFlex ina haki ya kutumia picha hii, na inaweza kuonyeshwa kwenye ukurasa wa mwanzo wa mshirika huyu kwenye app.',
  }),
  partnerLogo: Object.freeze({
    en: "This is this partner's own logo, and they have agreed to its use.",
    sw: 'Hii ni nembo ya mshirika huyu mwenyewe, na amekubali itumike.',
  }),
});

/** §43.3: takedown reason codes and the kinds each applies to. `other` needs a note. */
export const TAKEDOWN_REASONS = Object.freeze({
  inappropriate: Object.freeze(['hero', 'logo']),
  rights: Object.freeze(['hero', 'logo']),
  other_brand: Object.freeze(['hero']),
  not_own_logo: Object.freeze(['logo']),
  person_request: Object.freeze(['hero']),
  quality: Object.freeze(['hero', 'logo']),
  other: Object.freeze(['hero', 'logo']),
});
export const NOTE_MAX = 500;

/** §44.1 partner-facing reason lines (used in the takedown push; the note never is). */
export const REASON_TEXT = Object.freeze({
  inappropriate: { en: "It isn't suitable, for example nudity, violence or offensive content.", sw: 'Haifai, kwa mfano uchi, vurugu au maudhui ya kuudhi.' },
  rights: { en: 'It looks like you may not have the right to use it.', sw: 'Inaonekana huenda huna haki ya kuitumia.' },
  other_brand: { en: "It shows another brand's logo or sign.", sw: 'Inaonyesha nembo au bango la chapa nyingine.' },
  not_own_logo: { en: "It doesn't look like your business's own logo.", sw: 'Haionekani kuwa nembo ya biashara yako.' },
  person_request: { en: 'Someone in the photo asked for it to be removed.', sw: 'Mtu aliye kwenye picha aliomba iondolewe.' },
  quality: { en: "It's blurred, stretched or hard to make out.", sw: 'Haiko wazi, imenyooshwa au ni vigumu kuitambua.' },
  other: { en: 'Another reason (see the note).', sw: 'Sababu nyingine (tazama ujumbe).' },
});

/** §44.3 push / inbox texts for partner_media.taken_down. */
export function takenDownMessage(kind, reason) {
  const line = REASON_TEXT[reason] || REASON_TEXT.other;
  const logo = kind === 'logo';
  return {
    en: { title: logo ? 'Your logo was taken down' : 'Your home photo was taken down', body: `${line.en} Tap to upload another.` },
    sw: { title: logo ? 'Nembo yako imeondolewa' : 'Picha yako ya mwanzo imeondolewa', body: `${line.sw} Gusa kupakia nyingine.` },
  };
}

/** The app route a notification opens (§44.3 deep links). */
export function settingsRoute(subjectType, subjectId) {
  if (subjectType === 'gym') return `/owner/brand-media?gymId=${encodeURIComponent(subjectId)}`;
  return subjectType === 'trainer' ? '/trainer/brand-media' : '/vendor/brand-media';
}

/** A focal coordinate from a form field: absent → 0 (centre); otherwise a number in -1..1. */
export function parseFocal(v) {
  if (v === undefined || v === null || v === '') return { value: 0 };
  const n = Number(v);
  if (!Number.isFinite(n) || n < -1 || n > 1) return { invalid: true };
  return { value: Math.round(n * 1000) / 1000 };
}

/** A ticked confirmation box: exactly true or "true" (as the banner upload). */
export const confirmed = v => v === true || v === 'true';
