// Browser gym profile (S1): what the open web page behind a printed gym QR may show.
// One explicit whitelist built field by field, never a spread of the gym row. Plans and prices come from
// the same sources the member app uses (the gym's own ratePerDay/Week/Month and the Settings pass tiers);
// nothing is priced here. Every way of not finding a gym (bad signature, unknown, inactive, held back in
// moderation, malformed input) is the same `null`, so the route can answer one identical 404.
import { createHmac } from 'node:crypto';
import { verifyGymQr } from '../auth/qr-token.mjs';
import { gymAccessTiers } from '../shared/check-in-rules.mjs';
import { mediaSrcShapeProblem } from '../shared/media-src.mjs';
import { documentLogoUrl, publicBaseUrl } from '../shared/vendor-documents.mjs';

export const MAX_PHOTOS = 5;
export const MAX_TRAINERS = 6;
export const MAX_LIST = 40;
const MAX_Q_LENGTH = 2048;
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'default'];

// Server-built strings only (the page's own headings live in the portal). Swahili is a draft for native review.
const LABELS = Object.freeze({
  en: {
    daily: 'Daily plan', weekly: 'Weekly plan', monthly: 'Monthly plan',
    perDay: 'per day', perWeek: 'per week', perMonth: 'per month',
    visitsPerMonth: n => `${n} visits per month`, unlimited: 'Unlimited visits',
  },
  sw: {
    daily: 'Mpango wa siku', weekly: 'Mpango wa wiki', monthly: 'Mpango wa mwezi',
    perDay: 'kwa siku', perWeek: 'kwa wiki', perMonth: 'kwa mwezi',
    visitsPerMonth: n => `ziara ${n} kwa mwezi`, unlimited: 'Ziara bila kikomo',
  },
});

export const labelsFor = lang => LABELS[lang === 'sw' ? 'sw' : 'en'];
export const normaliseLang = lang => (String(lang || '').toLowerCase().startsWith('sw') ? 'sw' : 'en');

/**
 * The signed payload from what the browser sent: the payload itself, or an https URL carrying it as ?q=.
 * Anything else → null. Never throws; the input is never logged.
 */
export function extractQrPayload(q) {
  if (typeof q !== 'string') return null;
  const text = q.trim();
  if (!text || text.length > MAX_Q_LENGTH) return null;
  if (text.startsWith('fitflex:gym:')) return text;
  if (!/^https:\/\//i.test(text)) return null;
  try {
    const inner = new URL(text).searchParams.get('q');
    return typeof inner === 'string' && inner.startsWith('fitflex:gym:') && inner.length <= MAX_Q_LENGTH ? inner : null;
  } catch {
    return null;
  }
}

const SECRET = () => process.env.QR_HMAC_SECRET || '';
/** An opaque reference for a gym: stable, keyed from a separate derived key (never the raw QR secret), not the internal id. */
export function publicRefFor(gymId) {
  const key = createHmac('sha256', SECRET()).update('public-ref').digest();
  return createHmac('sha256', key).update(String(gymId)).digest('base64url').slice(0, 16);
}

const text = (v, max = 300) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const strings = (v, max = MAX_LIST) => (Array.isArray(v) ? v.map(x => text(x, 120)).filter(Boolean).slice(0, max) : []);
const num = v => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

function hoursOf(raw) {
  if (typeof raw === 'string') return text(raw, 200);
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const k of DAY_KEYS) {
    const v = raw[k];
    if (typeof v === 'string') out[k] = text(v, 40);
    else if (v && typeof v === 'object') out[k] = { open: text(v.open, 8), close: text(v.close, 8) };
  }
  return Object.keys(out).length ? out : null;
}

// ── images ──────────────────────────────────────────────────────────────────
export const PHOTO_BYTE_BUDGET = 1_500_000;     // decoded bytes across the thumbnail and the gym photos
export const TRAINER_PHOTO_MAX_BYTES = 100_000;
const decodedBytes = uri => Math.floor(((uri.length - uri.indexOf(',') - 1) * 3) / 4);

/**
 * One image as the page may show it: a valid-shaped data:image URI (png/jpeg/webp, no SVG) or one of OUR storage
 * paths made absolute on PUBLIC_API_URL; anything else (any other remote URL, unset base) → null.
 * → { src, bytes } | null. The bytes of a storage URL cost nothing here (the browser fetches it separately).
 */
export function cleanImage(value, { maxBytes = PHOTO_BYTE_BUDGET } = {}) {
  if (typeof value !== 'string' || !value) return null;
  if (value.startsWith('data:')) {
    if (mediaSrcShapeProblem(value, { maxBytes })) return null;
    const bytes = decodedBytes(value);
    return bytes > 0 && bytes <= maxBytes ? { src: value, bytes } : null;
  }
  const url = documentLogoUrl(value, publicBaseUrl());
  return url ? { src: url, bytes: 0 } : null;
}

/** Thumbnail first, then the photos in order, within the cap and one byte budget. */
export function cleanGymImages({ images, thumbnails }, { maxPhotos = MAX_PHOTOS, budget = PHOTO_BYTE_BUDGET } = {}) {
  let left = budget;
  const thumb = cleanImage(Array.isArray(thumbnails) ? thumbnails[0] : null, { maxBytes: left });
  if (thumb) left -= thumb.bytes;
  const photos = [];
  for (const v of Array.isArray(images) ? images : []) {
    if (photos.length >= maxPhotos) break;
    const img = cleanImage(v, { maxBytes: left });
    if (!img || img.bytes > left) continue;
    left -= img.bytes;
    photos.push(img.src);
  }
  return { photos, thumbnail: thumb?.src ?? null };
}

const SCHEDULE_KEYS = ['day', 'days', 'start', 'end', 'from', 'to', 'time', 'open', 'close'];
function scheduleOf(raw) {
  if (typeof raw === 'string') return text(raw, 200);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const k of SCHEDULE_KEYS) if (typeof raw[k] === 'string' && raw[k].trim()) out[k] = raw[k].trim().slice(0, 40);
  return Object.keys(out).length ? out : null;
}

export const BLOCKED_CACHE_MS = 5000;

export function createWebGymProfileService({ gymService, settingsService, trainerService, moderationGate, partnerGate, now = Date.now }) {
  // The moderation set is scanned at most once every few seconds, not once a request.
  let blockedCache = { at: -Infinity, set: new Set() };
  async function blockedGyms() {
    if (now() - blockedCache.at >= BLOCKED_CACHE_MS) blockedCache = { at: now(), set: await moderationGate.blocked('gym') };
    return blockedCache.set;
  }
  const resetCache = () => { blockedCache = { at: -Infinity, set: new Set() }; };

  /** The same gates the member gym list applies: active, listed, not held back in moderation; plus the owner's KYC. */
  async function lookup(payload) {
    const verified = verifyGymQr(payload);
    const blocked = await blockedGyms();      // same work for every miss
    if (!verified || blocked.has(verified.gymId)) return null;
    const gym = gymService.findById(verified.gymId);
    if (!gym || gym.status !== 'active' || gym.homepageVisible === false) return null;
    return (await partnerGate.isGymOperational(gym.id)) ? gym : null;
  }

  function plansOf(gym, L) {
    const defs = [['daily', 'ratePerDay', 1, L.perDay], ['weekly', 'ratePerWeek', 7, L.perWeek], ['monthly', 'ratePerMonth', 30, L.perMonth]];
    return defs
      .filter(([, key]) => (num(gym[key]) ?? 0) > 0)
      .map(([plan, key, days, per]) => ({ plan, label: L[plan], period: per, priceTzs: Number(gym[key]), days }));
  }

  function passTiersFor(gym, L) {
    return settingsService.publicTiers()
      .filter(t => (gymAccessTiers(t.gymAccess) || []).includes(gym.tier))
      .map(t => ({
        key: t.key,
        label: text(t.label, 80) ?? t.key,
        monthlyPriceTzs: num(t.monthlyPrice),
        visits: num(t.visits),
        visitsLabel: num(t.visits) === null ? L.unlimited : L.visitsPerMonth(num(t.visits)),
      }));
  }

  async function trainersOf(gym) {
    const blocked = await moderationGate.blocked('trainer');
    const rows = (await trainerService.listPublic({})).filter(t => t.status === 'active' && t.bookable === true && !blocked.has(t.id)
      && ((t.gymIds || []).includes(gym.id) || (t.gyms || []).some(g => g?.id === gym.id)));
    return rows.slice(0, MAX_TRAINERS).map(t => {
      const p = trainerService.publicTrainer(t);
      const photo = cleanImage(p.photoUrl, { maxBytes: TRAINER_PHOTO_MAX_BYTES });
      return { name: text(p.displayName, 80), photoUrl: photo?.src ?? null, specialties: strings(p.specialties, 6), rating: num(p.rating) };
    });
  }

  /** @returns the public profile or null (one answer for every kind of miss). */
  async function resolve({ q, lang } = {}) {
    const payload = extractQrPayload(q);
    const gym = payload ? await lookup(payload) : (await blockedGyms(), null);
    if (!gym) return null;
    const language = normaliseLang(lang);
    const L = labelsFor(language);
    const [shown] = await partnerGate.badgeGyms([gym]);
    const lat = num(gym.coordinates?.lat);
    const lng = num(gym.coordinates?.lng);
    return {
      lang: language,
      gym: {
        publicRef: publicRefFor(gym.id),
        name: text(gym.name, 120),
        description: text(gym.description, 2000),   // the gym row has no description field today: null until one exists
        tier: gym.tier,
        venueType: gym.venueType ?? 'physical',
        verified: shown?.verified === true,
        rating: num(gym.rating),
        reviewCount: num(gym.reviewCount),
        ...cleanGymImages(gym),
        area: text(gym.location, 200),
        address: text(gym.location, 200),
        lat, lng,
        directions: text(gym.directions, 1000),      // no such field today: null until one exists
        facilities: strings(gym.amenities),
        equipment: strings(gym.equipment),
        amenities: strings(gym.amenities),
        services: strings((Array.isArray(gym.classes) ? gym.classes : []).map(c => c?.name)),
        operatingHours: hoursOf(gym.operatingHours),
        classes: (Array.isArray(gym.classes) ? gym.classes : []).slice(0, MAX_LIST).map(c => ({
          name: text(c?.name, 80),
          schedule: scheduleOf(c?.schedule),
          priceTzs: num(c?.price),
          location: text(c?.location, 120),
        })).filter(c => c.name),
        trainers: await trainersOf(gym),
      },
      membership: {
        currency: 'TZS',
        gymPlans: plansOf(gym, L),
        passTiers: passTiersFor(gym, L),
      },
    };
  }

  return { resolve, extractQrPayload, resetCache };
}
