// Shop near-you (Phase 2 · slice 3): reading the viewer's area from a request, and keeping it out of
// the request log. Contract: docs/shop-near-you-api.md.
//
/**
 * The viewer's area is location-derived and must never be logged. The app sends it in the
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
/** The viewer's area from the X-FF-Area header only (GET /shop/products, /shop/products/:id). */
export function areaHeaderOf(req) {
  const h = req?.headers?.['x-ff-area'] ?? (typeof req?.get === 'function' ? req.get('x-ff-area') : undefined);
  return typeof h === 'string' && h.trim() ? h.trim() : undefined;
}
/** A guard that only redacts (put it first, so even a 401 log line has no areaId). */
export const areaRedactGuard = (req, _res, next) => { redactAreaId(req); return next(); };
