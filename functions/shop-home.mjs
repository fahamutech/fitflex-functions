// Shop home — one call for the landing page of the shop: role-aware sections
// over the existing catalogue. Additive: /shop/products, /discover/products,
// cart and checkout are unchanged. Dormant unless SHOP_HOME_V2 is set.
// Contract: docs/shop-home-api.md.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { isTokenSession } from '../src/auth/promotion-token.mjs';
import { shopHomeService } from '../src/bootstrap/services.mjs';
import { shopHomeV2On, shopNearYouOn } from '../src/shared/feature-flags.mjs';

/**
 * Slice 3: the viewer's area is location-derived and must never be logged. The app sends it in the
 * `X-FF-Area` header (review M3; headers are not in the request log line). `?areaId=` still works for
 * one release, so the in-process request logger (morgan in bfast-function), which writes
 * req.originalUrl when the response finishes, gets a URL without it: every parameter whose key,
 * percent-decoded and with any [..] suffix removed, is `areaid` (any case) is dropped before anything
 * else runs. Routing and req.query read req.url, which is left alone. Platform / ingress logs (BFast)
 * are outside this repo.
 */
const keyOf = (pair) => {
  const raw = pair.split('=')[0].replace(/\+/g, ' ');
  let key = raw;
  // Decode repeatedly (a key encoded twice stays encoded once after Express); a bad escape is matched raw.
  for (let i = 0; i < 3; i += 1) { try { const next = decodeURIComponent(key); if (next === key) break; key = next; } catch { break; } }
  return key.trim().toLowerCase().replace(/\[.*$/, '');
};
const isAreaKey = pair => keyOf(pair) === 'areaid';
export function withoutAreaId(url) {
  if (typeof url !== 'string') return url;
  const at = url.indexOf('?');
  if (at < 0) return url;
  const hash = url.indexOf('#', at);
  const query = url.slice(at + 1, hash < 0 ? undefined : hash);
  const pairs = query.split('&');
  if (!pairs.some(p => p && isAreaKey(p))) return url;
  const kept = pairs.filter(p => p && !isAreaKey(p));
  return kept.length ? `${url.slice(0, at)}?${kept.join('&')}` : url.slice(0, at);
}
export function redactAreaId(req) {
  if (req && typeof req.originalUrl === 'string') req.originalUrl = withoutAreaId(req.originalUrl);
}
/** The viewer's area: the X-FF-Area header first, else ?areaId= (one more release). Never logged. */
export function areaFromRequest(req) {
  const h = req?.headers?.['x-ff-area'] ?? (typeof req?.get === 'function' ? req.get('x-ff-area') : undefined);
  if (typeof h === 'string' && h.trim()) return h.trim();
  const q = req?.query?.areaId;
  return typeof q === 'string' ? q : undefined;
}
const redacting = guard => (req, res, next) => { redactAreaId(req); return guard(req, res, next); };

const created = new Date().toISOString();

// Requests per signed-in user per minute. In memory per server (the same approach as POST /events in
// promotion-events.mjs, which keeps its limiter private): with several servers the real allowance is the
// number of servers times this. The page is cached, so this is about abuse, not load from normal use.
export const SHOP_HOME_LIMIT = Object.freeze({ perMinute: 60, maxTracked: 5000 });
const windows = new Map(); // userId → { count, resetAt }
export function allowShopHome(userId, nowMs = Date.now()) {
  let w = windows.get(userId);
  if (!w || w.resetAt <= nowMs) {
    // Forget finished windows before the map can grow without bound.
    if (windows.size >= SHOP_HOME_LIMIT.maxTracked) for (const [k, v] of windows) if (v.resetAt <= nowMs) windows.delete(k);
    w = { count: 0, resetAt: nowMs + 60_000 };
    windows.set(userId, w);
  }
  if (w.count >= SHOP_HOME_LIMIT.perMinute) return false;
  w.count += 1;
  return true;
}
export const resetShopHomeLimits = () => windows.clear();

export const shopHome = {
  created, method: 'get', path: '/shop/home',
  description: 'Any signed-in user (SHOP_HOME_V2): the shop landing page. Query: ?mode=member|trainer|owner|vendor_personal (a role this account holds; default = the signed-in role; otherwise 403 mode_not_allowed), ?recent=<comma ids, most recent first, max 20; never stored>, ?session=<promotion session id: Featured cards then carry promotion.token>. → { serverNow, currency, mode, personalised, signalsUsed, categories:[{key,en,sw,count}], sections:[{key,title{en,sw},reason{en,sw},reasonCodes,viewAll{path,query},productIds,hasMore}], products:{ id: product as in GET /shop/products } }. Out of stock and the viewer\'s own products never appear; a product is in one section at most; sections with fewer than SHOP_HOME_MIN_ITEMS (4) products are left out. Flag off: 404 feature_disabled. More than 60 calls a minute per user: 429 rate_limited. With SHOP_BANNERS on the body also has banners: [{ id, image{url1x,url2x,urlWide,focal}, imageAlt, headlineLead, headlineAccent, subline, ctaLabel, target{type,value}, origin, vendorName?, endsAt }] (live now for this mode; docs/shop-banners-api.md); with it off there is no banners key. With SHOP_PERSONALISATION on the body also has personalisation: { available, enabled }, personalised is true only when purchase history or (member mode, adults) gender/age actually changed the page, signalsUsed may hold purchase_history / profile_gender / profile_age, and sections may carry reasonCodes bought_category / bought_product / profile_gender / profile_age with reasonParams { category } | { productName } (docs/shop-personalisation-api.md); with it off the body is unchanged. With SHOP_NEAR_YOU on (docs/shop-near-you-api.md): the viewer area in the X-FF-Area header (preferred; ?areaId= also accepted for one release) = <GeoArea id worked out on the device; region, city or district; never stored or logged; ignored unless personalisation is available and switched on; unknown, inactive, country or too small (radiusKm below 2 km district / 5 km city or region) → ignored>; the body also has nearYou: { available, areaId?, areaName{en,sw}? }, may have a popular_near_you section (reasonCodes popular_in_area / delivers_to_area / seller_in_area, reasonParams { areaName{en,sw} }) and product rows may carry deliversToViewerArea: true; signalsUsed may hold location. With it off the body is unchanged and areaId is ignored.',
  responseSample: {
    serverNow: '2026-10-19T08:00:00.000Z', currency: 'TZS', mode: 'member', personalised: false, signalsUsed: ['role'],
    categories: [{ key: 'equipment', en: 'Gym & fitness equipment', sw: 'Vifaa vya gym na mazoezi', count: 12 }],
    sections: [{ key: 'best_sellers', title: { en: 'Best sellers', sw: 'Zinazouzwa zaidi' }, reason: { en: 'The most bought on FitFlex in the last 30 days.', sw: 'Zilizonunuliwa zaidi kwenye FitFlex katika siku 30 zilizopita.' }, reasonCodes: ['best_sellers_30d'], viewAll: { path: '/shop/products', query: { sort: 'popularity' } }, productIds: ['prd_1'], hasMore: false }],
    products: { prd_1: { id: 'prd_1', name: 'Whey Protein 1kg', priceTzs: 85000 } },
  },
  // Redact first, so even a 401 / 404 / 429 log line has no areaId.
  onGuard: redacting(requireAuth()),
  onRequest: async (req, res) => {
    redactAreaId(req);
    if (!shopHomeV2On()) return res.status(404).json({ error: 'feature_disabled' });
    if (!allowShopHome(req.user.sub)) return res.status(429).json({ error: 'rate_limited' });
    const q = req.query || {};
    const out = await shopHomeService.home({
      claims: req.user,
      query: { mode: q.mode, recent: q.recent, session: isTokenSession(q.session) ? q.session : undefined, areaId: areaFromRequest(req) },
    });
    if (out.error) return res.status(out.status).json({ error: out.error });
    return res.json(out.body);
  },
};

export const shopAreas = {
  created, method: 'get', path: '/shop/areas',
  description: 'Any signed-in user (SHOP_NEAR_YOU): the usable areas (GeoArea: active, with every parent active) for the device-side "near you" mapping and the vendor "Where you sell" pickers → { areas: [{ id, level: country|region|city|district, name, names{en,sw}, parentId, lat, lng, radiusKm }] }, by level then name. Non-personal: Cache-Control private, max-age=3600. Flag off: 404 feature_disabled. Contract: docs/shop-near-you-api.md.',
  responseSample: { areas: [{ id: 'tz-dar-city', level: 'city', name: 'Dar es Salaam', names: { en: 'Dar es Salaam', sw: 'Dar es Salaam' }, parentId: 'tz-dar', lat: -6.792, lng: 39.208, radiusKm: 25 }] },
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    if (!shopNearYouOn()) return res.status(404).json({ error: 'feature_disabled' });
    const areas = await shopHomeService.areas();
    if (typeof res.set === 'function') res.set('Cache-Control', 'private, max-age=3600');
    return res.json({ areas });
  },
};
