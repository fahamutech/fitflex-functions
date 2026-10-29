// Browser gym profile (S1): what the open web page behind a printed gym QR may show.
// One explicit whitelist built field by field, never a spread of the gym row. Plans and prices come from
// the same sources the member app uses (the gym's own ratePerDay/Week/Month and the Settings pass tiers);
// nothing is priced here. Every way of not finding a gym (bad signature, unknown, inactive, held back in
// moderation, malformed input) is the same `null`, so the route can answer one identical 404.
import { createHmac } from 'node:crypto';
import { verifyGymQr } from '../auth/qr-token.mjs';
import { gymAccessTiers } from '../shared/check-in-rules.mjs';

export const MAX_PHOTOS = 5;
export const MAX_TRAINERS = 6;
export const MAX_LIST = 40;
const MAX_Q_LENGTH = 2048;
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'default'];

const LABELS = Object.freeze({
  en: {
    plans: 'Gym plans', passes: 'FitFlex Pass', hours: 'Opening hours', facilities: 'Facilities', equipment: 'Equipment',
    amenities: 'Amenities', classes: 'Classes', trainers: 'Trainers', directions: 'Directions',
    daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly',
    perDay: 'per day', perWeek: 'per week', perMonth: 'per month', visits: 'visits',
    unlimited: 'Unlimited', verified: 'Verified', online: 'Online',
  },
  sw: {
    plans: 'Mipango ya gym', passes: 'FitFlex Pass', hours: 'Saa za kufungua', facilities: 'Huduma', equipment: 'Vifaa',
    amenities: 'Huduma za ziada', classes: 'Madarasa', trainers: 'Wakufunzi', directions: 'Maelekezo',
    daily: 'Kila siku', weekly: 'Kila wiki', monthly: 'Kila mwezi',
    perDay: 'kwa siku', perWeek: 'kwa wiki', perMonth: 'kwa mwezi', visits: 'ziara',
    unlimited: 'Bila kikomo', verified: 'Imethibitishwa', online: 'Mtandaoni',
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

const SECRET = () => process.env.QR_HMAC_SECRET || 'fitflex-qr-dev-secret';
/** An opaque reference for a gym that is stable but is not the internal id. */
export const publicRefFor = gymId => createHmac('sha256', SECRET()).update(`web-gym-ref.${gymId}`).digest('base64url').slice(0, 16);

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

export function createWebGymProfileService({ gymService, settingsService, trainerService, moderationGate, partnerGate }) {
  async function lookup(payload) {
    const verified = verifyGymQr(payload);
    // Same work either way, so a bad signature is not quicker than an unknown gym.
    const blocked = await moderationGate.isBlocked('gym', verified?.gymId ?? '-');
    if (!verified || blocked) return null;
    const gym = gymService.findById(verified.gymId);
    return gym && gym.status === 'active' ? gym : null;
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
        visitsLabel: num(t.visits) === null ? L.unlimited : `${num(t.visits)} ${L.visits}`,
      }));
  }

  async function trainersOf(gym) {
    const blocked = await moderationGate.blocked('trainer');
    const rows = (await trainerService.listPublic({})).filter(t => !blocked.has(t.id)
      && ((t.gymIds || []).includes(gym.id) || (t.gyms || []).some(g => g?.id === gym.id)));
    return rows.slice(0, MAX_TRAINERS).map(t => {
      const p = trainerService.publicTrainer(t);
      return {
        name: text(p.displayName, 80),
        photoUrl: text(p.photoUrl, 2048),
        specialties: strings(p.specialties, 6),
        rating: num(p.rating),
        reviewCount: num(p.reviewCount),
      };
    });
  }

  /** @returns the public profile or null (one answer for every kind of miss). */
  async function resolve({ q, lang } = {}) {
    const payload = extractQrPayload(q);
    const gym = payload ? await lookup(payload) : (await moderationGate.isBlocked('gym', '-'), null);
    if (!gym) return null;
    const language = normaliseLang(lang);
    const L = labelsFor(language);
    const [shown] = await partnerGate.badgeGyms([gym]);
    const lat = num(gym.coordinates?.lat);
    const lng = num(gym.coordinates?.lng);
    return {
      lang: language,
      labels: L,
      gym: {
        publicRef: publicRefFor(gym.id),
        name: text(gym.name, 120),
        description: text(gym.description, 2000),   // the gym row has no description field today: null until one exists
        tier: gym.tier,
        venueType: gym.venueType ?? 'physical',
        verified: shown?.verified === true,
        rating: num(gym.rating),
        reviewCount: num(gym.reviewCount),
        photos: strings(gym.images, MAX_PHOTOS),
        thumbnail: text(gym.thumbnails?.[0], 2048),
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
          schedule: typeof c?.schedule === 'string' ? text(c.schedule, 200) : (c?.schedule && typeof c.schedule === 'object' ? c.schedule : null),
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

  return { resolve, extractQrPayload };
}
