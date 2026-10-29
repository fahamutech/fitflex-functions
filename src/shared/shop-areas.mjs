// Shop "Popular near you" (Phase 2 · slice 3) — pure area rules. No I/O, no clock.
// Contract: docs/shop-near-you-api.md.
//
// Areas are GeoArea rows { id, level: country|region|city|district, name, parentId, lat, lng, radiusKm, active }.
// An area is usable when it and every ancestor are active. "An area covers everything beneath it":
// the country = nationwide, a region covers its cities and districts, a city its districts.
//
// The viewer's area arrives as an id the device worked out; it is never stored or logged. Nothing
// here receives or returns coordinates of a person.

export const AREA_LEVELS = Object.freeze(['country', 'region', 'city', 'district']);
const LEVEL_RANK = Object.freeze({ country: 0, region: 1, city: 2, district: 3 });
export const MAX_DELIVERY_AREAS = 50;

/**
 * Privacy (review M1): an area smaller than this is too precise to stand for "where you are" in the shop.
 * Districts need radiusKm >= SHOP_NEAR_YOU_MIN_RADIUS_KM_DISTRICT (2), cities and regions
 * >= SHOP_NEAR_YOU_MIN_RADIUS_KM_CITY (5). Smaller (or no circle) -> the device is given no circle for it
 * and an areaId for it is ignored. Values below the defaults are not accepted (a floor, not a knob).
 */
export const MIN_RADIUS_KM = Object.freeze({ district: 2, city: 5 });
export function minRadiusFromEnv(env = process.env) {
  const read = (v, floor) => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) && n >= floor ? n : floor; };
  return { district: read(env.SHOP_NEAR_YOU_MIN_RADIUS_KM_DISTRICT, MIN_RADIUS_KM.district), city: read(env.SHOP_NEAR_YOU_MIN_RADIUS_KM_CITY, MIN_RADIUS_KM.city) };
}
const finite = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
/** May this area stand for the viewer's position? A region, city or district with a big enough circle. */
export function locatable(area, min = MIN_RADIUS_KM) {
  if (!area || !['region', 'city', 'district'].includes(area.level)) return false;
  if (!finite(area.radiusKm) || !finite(area.lat) || !finite(area.lng)) return false;
  return Number(area.radiusKm) >= (area.level === 'district' ? min.district : min.city);
}
/** The area's name in both languages: nameSw when set (Swahili place name, native review), else the name. */
export const namesOf = area => ({ en: area.name, sw: typeof area.nameSw === 'string' && area.nameSw.trim() ? area.nameSw.trim() : area.name });
const AREA_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const MAX_DEPTH = 8;

/** Index GeoArea rows. → { byId: Map(id → row), usable: Set(id) } (usable = active all the way up). */
export function indexAreas(rows) {
  const byId = new Map((rows || []).filter(a => a && typeof a.id === 'string').map(a => [a.id, a]));
  const usable = new Set();
  for (const a of byId.values()) {
    let cur = a;
    let ok = true;
    for (let i = 0; cur && i < MAX_DEPTH; i += 1) {
      if (cur.active === false || !AREA_LEVELS.includes(cur.level)) { ok = false; break; }
      if (!cur.parentId) break;
      cur = byId.get(cur.parentId);
      if (!cur) { ok = false; break; }
    }
    if (ok) usable.add(a.id);
  }
  return { byId, usable };
}

/** The area and its ancestors, most specific first: [district?, city?, region?, country?] ids. */
export function chainOf(index, id) {
  const out = [];
  let cur = index.byId.get(id);
  for (let i = 0; cur && i < MAX_DEPTH; i += 1) {
    out.push(cur.id);
    cur = cur.parentId ? index.byId.get(cur.parentId) : null;
  }
  return out;
}

const ancestorOfLevel = (index, id, level) => chainOf(index, id).find(x => index.byId.get(x)?.level === level) || null;

/**
 * GET /shop/areas rows: usable areas, by level then name. `locatable: false` areas (the country, or a
 * circle missing or below the minimum size) carry lat/lng/radiusKm null, so the device never maps a
 * position to them; they stay in the list for the vendor pickers.
 */
export function publicAreas(rows, min = MIN_RADIUS_KM) {
  const index = indexAreas(rows);
  return [...index.usable].map(id => index.byId.get(id))
    .sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || String(a.name).localeCompare(String(b.name)) || (a.id < b.id ? -1 : 1))
    .map((a) => {
      const ok = locatable(a, min);
      return { id: a.id, level: a.level, name: a.name, names: namesOf(a), parentId: a.parentId || null, locatable: ok, lat: ok ? Number(a.lat) : null, lng: ok ? Number(a.lng) : null, radiusKm: ok ? Number(a.radiusKm) : null };
    });
}

/**
 * The viewer's area from the `areaId` query. Unknown, inactive, malformed, country-level or not locatable (circle missing or below the minimum size) → null
 * (ignored silently). A district rolls up to its city for "based in" / "popular in"; delivery checks
 * use the full chain so district-level delivery areas still count.
 * → null | { areaId, name, level, cityId, regionId, chain: [ids, most specific first] }
 */
export function resolveViewerArea(index, areaId, min = MIN_RADIUS_KM) {
  if (typeof areaId !== 'string' || !AREA_ID_RE.test(areaId)) return null;
  if (!index.usable.has(areaId)) return null;
  const area = index.byId.get(areaId);
  // Country, or too small / no circle to stand for a position (M1): ignored.
  if (!area || !locatable(area, min)) return null;
  const cityId = area.level === 'region' ? null : ancestorOfLevel(index, areaId, 'city');
  const regionId = ancestorOfLevel(index, areaId, 'region');
  // QA1: the area a city-level claim is made at ("popular in", "based in"): the city, or the region
  // for a region-level viewer. Never the viewer's district.
  const rankId = cityId || regionId;
  return {
    areaId,
    name: area.name,
    names: namesOf(area),
    level: area.level,
    cityId,
    regionId,
    rankArea: rankId ? { id: rankId, names: namesOf(index.byId.get(rankId)) } : { id: areaId, names: namesOf(area) },
    chain: chainOf(index, areaId),
  };
}

/** A vendor profile's areas, normalised against the index (unusable ids dropped). */
export function vendorAreasOf(profile, index) {
  const p = profile || {};
  const usable = id => typeof id === 'string' && index.usable.has(id);
  const base = usable(p.cityId) ? p.cityId : null;
  const cityId = base ? (index.byId.get(base).level === 'district' ? ancestorOfLevel(index, base, 'city') : base) : null;
  const regionId = usable(p.regionId) ? p.regionId : (base ? ancestorOfLevel(index, base, 'region') : null);
  const delivery = new Set((Array.isArray(p.deliveryAreaIds) ? p.deliveryAreaIds : []).filter(usable));
  return { cityId, regionId, delivery };
}

/** The vendor delivers to the viewer: one of its delivery areas is the viewer's area or above it. */
export const deliversTo = (vendor, viewer) => Boolean(vendor && viewer && viewer.chain.some(id => vendor.delivery.has(id)));
/** The vendor's delivery list names the viewer's own area (a district viewer: that district itself). */
export const deliversExactly = (vendor, viewer) => Boolean(vendor && viewer && vendor.delivery.has(viewer.areaId));

/** The vendor is based in the viewer's city (district → city), or in the viewer's region when the viewer is only known at region level. */
export function basedIn(vendor, viewer) {
  if (!vendor || !viewer) return false;
  if (viewer.cityId) return vendor.cityId === viewer.cityId;
  return Boolean(viewer.regionId) && vendor.regionId === viewer.regionId;
}

/**
 * Validate the vendor area fields of a profile update against usable areas. Fields left out keep
 * their stored value. → { patch: { cityId?, regionId?, deliveryAreaIds? } } | { error: 'invalid_area', field, ids, reason }
 */
export function validateVendorAreas(body, prior, index) {
  const b = body || {};
  const has = k => Object.prototype.hasOwnProperty.call(b, k);
  const patch = {};
  const bad = (field, ids, reason) => ({ error: 'invalid_area', status: 400, field, ids, reason });
  const check = (field, id, levels) => {
    if (typeof id !== 'string' || !AREA_ID_RE.test(id) || !index.byId.has(id)) return bad(field, [String(id)], 'unknown');
    if (!index.usable.has(id)) return bad(field, [id], 'inactive');
    if (!levels.includes(index.byId.get(id).level)) return bad(field, [id], 'wrong_level');
    return null;
  };
  if (has('cityId') && b.cityId !== null) {
    const e = check('cityId', b.cityId, ['city', 'district']);
    if (e) return e;
  }
  if (has('regionId') && b.regionId !== null) {
    const e = check('regionId', b.regionId, ['region']);
    if (e) return e;
  }
  if (has('cityId')) patch.cityId = b.cityId;
  if (has('regionId')) patch.regionId = b.regionId;
  // A city without a region given: the city's region.
  if (has('cityId') && b.cityId !== null && !has('regionId')) patch.regionId = ancestorOfLevel(index, b.cityId, 'region');
  const city = has('cityId') ? patch.cityId : prior?.cityId ?? null;
  const region = has('regionId') || patch.regionId !== undefined ? patch.regionId : prior?.regionId ?? null;
  if ((has('cityId') || has('regionId')) && city && region && index.usable.has(city) && !chainOf(index, city).includes(region)) {
    return bad(has('regionId') ? 'regionId' : 'cityId', [region], 'not_in_region');
  }
  if (has('deliveryAreaIds')) {
    const list = b.deliveryAreaIds;
    if (!Array.isArray(list)) return bad('deliveryAreaIds', [], 'not_a_list');
    const ids = [...new Set(list)];
    if (ids.length > MAX_DELIVERY_AREAS) return bad('deliveryAreaIds', [], 'too_many');
    const unknown = ids.filter(id => typeof id !== 'string' || !AREA_ID_RE.test(id) || !index.byId.has(id));
    if (unknown.length) return bad('deliveryAreaIds', unknown.map(String), 'unknown');
    const inactive = ids.filter(id => !index.usable.has(id));
    if (inactive.length) return bad('deliveryAreaIds', inactive, 'inactive');
    patch.deliveryAreaIds = ids;
  }
  return { patch };
}

/** True when the body touches any vendor area field. */
export const touchesAreas = body => Boolean(body) && ['cityId', 'regionId', 'deliveryAreaIds'].some(k => Object.prototype.hasOwnProperty.call(body, k));
