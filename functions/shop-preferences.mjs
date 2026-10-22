// "Personalised shop" switch (Shop home Phase 2 · slice 2). Contract: docs/shop-personalisation-api.md.
// GET always answers (available: false while SHOP_PERSONALISATION is off); PUT is 404
// feature_disabled while it is off. The setting belongs to the Person: all their roles share it.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { shopPreferenceService } from '../src/bootstrap/services.mjs';
import { shopPersonalisationOn } from '../src/shared/feature-flags.mjs';

const created = new Date().toISOString();

// Saves per signed-in user per minute. In memory per server (as GET /shop/home's limiter).
export const SHOP_PREFERENCE_LIMIT = Object.freeze({ perMinute: 30, maxTracked: 5000 });
const windows = new Map(); // userId → { count, resetAt }
export function allowPreferenceSave(userId, nowMs = Date.now()) {
  let w = windows.get(userId);
  if (!w || w.resetAt <= nowMs) {
    if (windows.size >= SHOP_PREFERENCE_LIMIT.maxTracked) for (const [k, v] of windows) if (v.resetAt <= nowMs) windows.delete(k);
    w = { count: 0, resetAt: nowMs + 60_000 };
    windows.set(userId, w);
  }
  if (w.count >= SHOP_PREFERENCE_LIMIT.perMinute) return false;
  w.count += 1;
  return true;
}
export const resetPreferenceLimits = () => windows.clear();

const send = (res, out) => {
  if (out.error) {
    const { error, status, ...extra } = out;
    return res.status(status).json({ error, ...extra });
  }
  return res.json(out.body);
};

export const getShopPreferences = {
  created, method: 'get', path: '/shop/preferences',
  description: 'Any signed-in user: the "Personalised shop" switch → { personalised, available }. personalised: the stored choice (no row = true; one setting per Person, shared by all their roles). available: SHOP_PERSONALISATION is on and the person holds a member persona that is not under 18 (from the declared date of birth). Always 200, also with the flag off (available false).',
  responseSample: { personalised: true, available: true },
  onGuard: requireAuth(),
  onRequest: async (req, res) => send(res, await shopPreferenceService.get({ claims: req.user })),
};

export const putShopPreferences = {
  created, method: 'put', path: '/shop/preferences',
  description: 'Any signed-in user (SHOP_PERSONALISATION): save the "Personalised shop" switch. Body { personalised: boolean, source: privacy_page | why_sheet } → { personalised, available }. 400 invalid_field { field, allowed? }. Each change is audited (shop_preference_changed); saving the same value writes nothing. Flag off: 404 feature_disabled. More than 30 saves a minute per user: 429 rate_limited.',
  requestSample: { personalised: false, source: 'why_sheet' },
  responseSample: { personalised: false, available: true },
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    if (!shopPersonalisationOn()) return res.status(404).json({ error: 'feature_disabled' });
    if (!allowPreferenceSave(req.user.sub)) return res.status(429).json({ error: 'rate_limited' });
    return send(res, await shopPreferenceService.set({ claims: req.user, body: req.body || {} }));
  },
};
