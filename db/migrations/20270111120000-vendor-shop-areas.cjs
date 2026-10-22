// Shop home Phase 2 · slice 3 ("Popular near you") — vendor areas. Contract: docs/shop-near-you-api.md.
//
// The vendor profile lives in User.vendorProfile (jsonb), so the new fields live there too, next to
// the free-text `address` and `deliveryRegions` (kept for display):
//   cityId           "Based in": a GeoArea id of level city or district
//   regionId         the region of that city (or a region on its own)
//   deliveryAreaIds  "Delivers to": GeoArea ids of any level; the country id = nationwide
//   areasSource      vendor | admin | backfill — who set them last
// No schema change: the User table is not altered (identity work runs in parallel on it), and the
// fields are validated against GeoArea by the service on every write.
//
// Up: a best-effort backfill from the free text. It never overwrites a field that is already set,
// guesses nothing when the text is ambiguous, and prints how many vendors matched.
// Down: removes the area fields from vendors still marked `backfill` (vendor/admin choices stay).

const NATIONWIDE = new Set(['tanzania', 'nationwide', 'all of tanzania', 'all tanzania', 'tanzania nzima', 'nchi nzima', 'all regions', 'mikoa yote']);
const LEVEL_PREFERENCE = ['region', 'city', 'district'];

const norm = s => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordIn = (text, name) => Boolean(name) && new RegExp(`(^|[^a-z0-9])${escape(name)}([^a-z0-9]|$)`).test(text);

/** Areas active all the way up. */
function usableAreas(rows) {
  const byId = new Map(rows.map(a => [a.id, a]));
  const ok = (a) => {
    for (let cur = a, i = 0; cur && i < 8; i += 1) {
      if (cur.active === false) return false;
      if (!cur.parentId) return true;
      cur = byId.get(cur.parentId);
      if (!cur) return false;
    }
    return false;
  };
  return { byId, usable: rows.filter(ok) };
}

const textOf = (value) => {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return Object.values(value).filter(v => typeof v === 'string').join(', ');
  return String(value);
};

/**
 * What the free text says, as area ids. Pure. Only the fields that are absent from `profile` are returned.
 * → { cityId?, regionId?, deliveryAreaIds? }
 */
function matchVendorAreas(profile, areaRows) {
  const { byId, usable } = usableAreas(areaRows || []);
  const p = profile || {};
  const out = {};
  const regionOf = (id) => {
    for (let cur = byId.get(id), i = 0; cur && i < 8; i += 1) {
      if (cur.level === 'region') return cur.id;
      cur = cur.parentId ? byId.get(cur.parentId) : null;
    }
    return null;
  };
  const cityOf = (a) => (a.level === 'district' ? byId.get(a.parentId) : a);

  const address = norm(textOf(p.address));
  if (address && (p.cityId == null || p.regionId == null)) {
    const places = usable.filter(a => (a.level === 'city' || a.level === 'district') && wordIn(address, norm(a.name)));
    const cities = [...new Set(places.map(cityOf).filter(c => c && c.level === 'city').map(c => c.id))];
    let regionId = null;
    if (cities.length === 1) {
      if (p.cityId == null) out.cityId = cities[0];
      regionId = regionOf(cities[0]);
    } else if (cities.length === 0) {
      const regions = [...new Set(usable.filter(a => a.level === 'region' && wordIn(address, norm(a.name))).map(a => a.id))];
      if (regions.length === 1) regionId = regions[0];
    }
    if (regionId && p.regionId == null && (p.cityId == null || regionOf(p.cityId) === regionId)) out.regionId = regionId;
  }

  if (p.deliveryAreaIds == null && p.deliveryRegions != null) {
    const entries = (Array.isArray(p.deliveryRegions) ? p.deliveryRegions : String(p.deliveryRegions).split(/[,;\n]/))
      .map(e => norm(textOf(e))).filter(Boolean);
    const ids = [];
    for (const entry of entries) {
      if (NATIONWIDE.has(entry)) {
        const countries = usable.filter(a => a.level === 'country');
        if (countries.length === 1) ids.push(countries[0].id);
        continue;
      }
      const country = usable.filter(a => a.level === 'country' && norm(a.name) === entry);
      if (country.length === 1) { ids.push(country[0].id); continue; }
      for (const level of LEVEL_PREFERENCE) {
        const hits = usable.filter(a => a.level === level && norm(a.name) === entry);
        if (hits.length === 1) { ids.push(hits[0].id); break; }
        if (hits.length > 1) break; // ambiguous: no guess
      }
    }
    const unique = [...new Set(ids)];
    if (unique.length) out.deliveryAreaIds = unique;
  }
  return out;
}

/** Fill absent area fields from the free text. `vendorIds` limits it (specs). → counts */
async function backfill(knex, { vendorIds = null } = {}) {
  const counts = { vendors: 0, city: 0, region: 0, delivery: 0, none: 0 };
  if (!(await knex.schema.hasTable('GeoArea')) || !(await knex.schema.hasColumn('User', 'vendorProfile'))) return counts;
  const areas = await knex('GeoArea').select('id', 'level', 'name', 'parentId', 'active');
  let q = knex('User').where({ userType: 'vendor' }).whereNotNull('vendorProfile').select('id', 'vendorProfile');
  if (vendorIds) q = q.whereIn('id', vendorIds);
  const rows = await q;
  for (const row of rows) {
    counts.vendors += 1;
    const profile = typeof row.vendorProfile === 'string' ? JSON.parse(row.vendorProfile) : row.vendorProfile;
    const found = matchVendorAreas(profile, areas);
    if (!Object.keys(found).length) { counts.none += 1; continue; }
    const patch = { ...found, ...(profile?.areasSource == null ? { areasSource: 'backfill' } : {}) };
    // Merge into the stored JSON (other keys untouched). Each filled key must still be absent or null
    // at write time, so a vendor who saved in between is never overwritten.
    const keys = Object.keys(found);
    const updated = await knex('User').where({ id: row.id })
      .whereRaw(keys.map(() => `coalesce(jsonb_typeof("vendorProfile" -> ?), 'null') = 'null'`).join(' AND '), keys)
      .update({ vendorProfile: knex.raw('"vendorProfile" || ?::jsonb', [JSON.stringify(patch)]) });
    if (!updated) { counts.none += 1; continue; }
    if (found.cityId) counts.city += 1;
    if (found.regionId) counts.region += 1;
    if (found.deliveryAreaIds) counts.delivery += 1;
  }
  return counts;
}

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const c = await backfill(knex);
  console.log(`[vendor-shop-areas] backfill: vendors=${c.vendors}, city=${c.city}, region=${c.region}, delivery=${c.delivery}, none=${c.none}`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (!(await knex.schema.hasColumn('User', 'vendorProfile'))) return;
  await knex.raw(`UPDATE "User" SET "vendorProfile" = "vendorProfile" - 'cityId' - 'regionId' - 'deliveryAreaIds' - 'areasSource'
    WHERE "vendorProfile"->>'areasSource' = 'backfill'`);
};

exports.matchVendorAreas = matchVendorAreas;
exports.backfill = backfill;
