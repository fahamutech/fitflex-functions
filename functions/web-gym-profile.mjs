// Browser gym profile (S1) — POST /public/gyms/resolve. Public, no auth, read-only.
// Dormant: 404 not_found unless WEB_GYM_PROFILE is set. Every miss is the same 404 { error: 'not_found' }.
// The body (`q`, a signed gym QR) is never logged.
import '../src/bootstrap/init.mjs';
import { gymService, settingsService, trainerService, moderationGate, partnerGate } from '../src/bootstrap/services.mjs';
import { createWebGymProfileService } from '../src/services/web-gym-profile-service.mjs';
import { webGymProfileOn } from '../src/shared/feature-flags.mjs';
import { createVendorLimiter, limitOrNull } from '../src/shared/vendor-rate-limit.mjs';

const created = new Date().toISOString();

const webGymProfile = createWebGymProfileService({ gymService, settingsService, trainerService, moderationGate, partnerGate });

// Per client address, in memory per server: 30 a minute.
export const WEB_GYM_PROFILE_RATE_PER_MINUTE = 30;
const limiter = createVendorLimiter({ perMinute: WEB_GYM_PROFILE_RATE_PER_MINUTE });
export const resetWebGymProfileLimits = () => { limiter.reset(); webGymProfile.resetCache(); };

/** The client address: X-Forwarded-For counted from the right by PUBLIC_DOCS_TRUSTED_PROXY_HOPS (default 1). */
function clientAddress(req) {
  const raw = process.env.PUBLIC_DOCS_TRUSTED_PROXY_HOPS;
  const n = raw == null || String(raw).trim() === '' ? 1 : Number(raw);
  const hops = Number.isInteger(n) && n >= 0 ? n : 1;
  const direct = req.socket?.remoteAddress || req.ip || 'unknown';
  if (hops === 0) return direct;
  const chain = String(req.headers?.['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return chain.length ? chain[Math.max(0, chain.length - hops)] : direct;
}

// Every answer (200, 404, 429, 500) is private and uncacheable, and varies by Origin in case CORS applies.
const send = (res, status, body) => {
  res.set?.('Cache-Control', 'no-store');
  res.set?.('Vary', 'Origin');
  return res.status(status).json(body);
};
const notFound = res => send(res, 404, { error: 'not_found' });

// Fail closed: without QR_HMAC_SECRET the QR would be signed with the public development secret, so the
// page stays off (404) however WEB_GYM_PROFILE is set. One warning, never the value.
let warnedNoSecret = false;
const secretConfigured = () => {
  if (process.env.QR_HMAC_SECRET) return true;
  if (!warnedNoSecret) { warnedNoSecret = true; console.warn('[web-gym-profile] QR_HMAC_SECRET is not set: the public gym profile stays off.'); }
  return false;
};

export const resolveWebGym = {
  created, method: 'post', path: '/public/gyms/resolve',
  description: 'Public, no auth (WEB_GYM_PROFILE on and QR_HMAC_SECRET set, else 404 not_found): { q, lang?: en|sw } where q is the signed gym QR payload (fitflex:gym:<gymId>:<sig>) or an https URL carrying it as ?q= → { lang, gym { publicRef, name, description, tier, venueType, verified, rating, reviewCount, photos[≤5, data:image or our storage URL, ~1.5 MB total], thumbnail, area, address, lat, lng, directions, facilities[], equipment[], amenities[], services[], operatingHours, classes[{ name, schedule, priceTzs, location }], trainers[≤6]{ name, photoUrl, specialties, rating } }, membership { currency, gymPlans[{ plan, label, period, priceTzs, days }], passTiers[{ key, label, monthlyPriceTzs, visits, visitsLabel }] } }. A bad signature, unknown, inactive, unlisted, held-back or KYC-hidden gym, or malformed q is the same 404 { error: "not_found" }. Over 30 requests a minute from one address → 429 rate_limited { retryAfterSeconds }.',
  requestSample: { q: 'fitflex:gym:gym_001:<sig>', lang: 'sw' },
  onRequest: async (req, res) => {
    if (!webGymProfileOn() || !secretConfigured()) return notFound(res);
    res.set?.('Cache-Control', 'no-store');
    res.set?.('Vary', 'Origin');
    const limited = limitOrNull(limiter, clientAddress(req), res);
    if (limited) return limited;
    try {
      const profile = await webGymProfile.resolve({ q: req.body?.q, lang: req.body?.lang });
      if (!profile) return notFound(res);
      send(res, 200, profile);
    } catch {
      // Nothing about the request is logged.
      send(res, 500, { error: 'server_error' });
    }
  },
};
