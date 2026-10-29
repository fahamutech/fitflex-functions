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
export const resetWebGymProfileLimits = () => limiter.reset();

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

const notFound = res => res.status(404).json({ error: 'not_found' });

export const resolveWebGym = {
  created, method: 'post', path: '/public/gyms/resolve',
  description: 'Public, no auth (WEB_GYM_PROFILE on, else 404 not_found): { q, lang?: en|sw } where q is the signed gym QR payload (fitflex:gym:<gymId>:<sig>) or an https URL carrying it as ?q= → { lang, labels, gym { publicRef, name, description, tier, venueType, verified, rating, reviewCount, photos[≤5], thumbnail, area, address, lat, lng, directions, facilities[], equipment[], amenities[], services[], operatingHours, classes[], trainers[≤6] }, membership { currency, gymPlans[{ plan, label, period, priceTzs, days }], passTiers[] } }. A bad signature, unknown, inactive or held-back gym, or malformed q is the same 404 { error: "not_found" }. Over 30 requests a minute from one address → 429 rate_limited { retryAfterSeconds }.',
  requestSample: { q: 'fitflex:gym:gym_001:<sig>', lang: 'sw' },
  onRequest: async (req, res) => {
    if (!webGymProfileOn()) return notFound(res);
    const limited = limitOrNull(limiter, clientAddress(req), res);
    if (limited) return limited;
    try {
      const profile = await webGymProfile.resolve({ q: req.body?.q, lang: req.body?.lang });
      if (!profile) return notFound(res);
      res.set?.('Cache-Control', 'no-store');
      res.json(profile);
    } catch {
      // Nothing about the request is logged.
      res.status(500).json({ error: 'server_error' });
    }
  },
};
