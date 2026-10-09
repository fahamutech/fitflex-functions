// Discovery — one ranked, filtered, promotion-aware list per kind of listing.
//
// The order of work is what keeps promotion honest:
//   1. start from what is already publicly listable (the existing listing rules,
//      KYC badges, and moderation: nothing hidden or suspended gets this far);
//   2. apply the customer's search and filters; anything that fails is gone;
//   3. score what is left organically (match, nearness, quality, popularity);
//   4. only then look at promotions, and only for results still in the list:
//      Featured goes in its own section (and only if it passed step 2), the
//      other types add a bounded boost to the score.
// Choosing an explicit sort (price, rating, distance…) turns promotion off, and
// the answer says so. Nothing here changes a stored status or an existing list.
import { PLACEMENTS } from '../shared/promotion-config.mjs';
import { boostCap, applyBoosts, pickFeatured, slotLimit, rotationSlice, distanceKm, entityEligibility } from '../shared/promotion-rules.mjs';
import { DEFAULT_ROTATION } from '../shared/promotion-config.mjs';
import { textRelevance, qualityScore, popularityScore, baseScore, minMax, DEFAULT_NEAR_KM, UNKNOWN_LOCATION } from '../shared/discovery-scoring.mjs';

const DISCOVERABLE = ['gym', 'trainer', 'product'];
const SORTS = ['relevance', 'distance', 'rating', 'popularity', 'price_asc', 'price_desc', 'name'];
const FILTER_KEYS = ['tier', 'verified', 'specialty', 'category', 'brand', 'minPrice', 'maxPrice', 'minRating', 'delivery', 'maxDistanceKm'];

const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const bool = v => (v === true || v === 'true' || v === '1' ? true : v === false || v === 'false' || v === '0' ? false : undefined);
const num = v => (v === undefined || v === null || v === '' ? undefined : Number.isFinite(Number(v)) ? Number(v) : undefined);
const priceOf = p => Number(p.discountPriceTzs || 0) > 0 && Number(p.discountPriceTzs) < Number(p.priceTzs || 0) ? Number(p.discountPriceTzs) : Number(p.priceTzs || 0);
const pointOf = g => {
  const c = g?.coordinates || {};
  const lat = Number(c.lat ?? g?.lat ?? g?.latitude);
  const lng = Number(c.lng ?? g?.lng ?? g?.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0) ? { lat, lng } : null;
};
/** Nearness 0..1 from a distance in km; no known distance scores neutral. */
const nearScore = km => (km === null ? UNKNOWN_LOCATION : Math.max(0, 1 - km / DEFAULT_NEAR_KM));
const nearest = (viewer, points) => {
  const ds = points.filter(Boolean).map(p => distanceKm(viewer, p));
  return ds.length ? Math.min(...ds) : null;
};

export function createDiscoveryService({
  gymService, trainerService, shopService, partnerGate, moderationGate, promotionService, configs, geoAreas,
  // (promotion, entityType, entityId, sessionId) => signed proof that this card was served to that session.
  signToken = null,
  now = () => new Date(),
}) {
  /** What the signals need from each kind of listing. `load` returns what is publicly listable already. */
  const sources = {
    gym: {
      load: async () => {
        const blocked = await moderationGate.blocked('gym');
        const rows = await partnerGate.badgeGyms((await gymService.listActiveAsync()).filter(g => !blocked.has(g.id)));
        return rows;
      },
      id: g => g.id,
      fields: g => ({ name: g.name, secondary: [g.location, g.tier, ...(g.amenities || []), ...(g.equipment || []), ...(g.classes ? (Array.isArray(g.classes) ? g.classes.map(c => c?.name ?? c) : []) : [])].filter(x => typeof x === 'string') }),
      points: g => [pointOf(g)],
      rating: g => ({ rating: g.rating, reviewCount: g.reviewCount, verified: g.verified }),
      popularity: g => Number(g.reviewCount || 0),
    },
    trainer: {
      load: async () => {
        const blocked = await moderationGate.blocked('trainer');
        return (await trainerService.listPublic({})).filter(t => !blocked.has(t.id));
      },
      id: t => t.id,
      fields: t => ({ name: t.displayName, secondary: [...(t.specialties || []), t.bio].filter(Boolean) }),
      points: t => (t.gyms || []).map(pointOf),
      rating: t => ({ rating: t.rating, reviewCount: t.reviewCount, verified: t.verified }),
      popularity: t => Number(t.reviewCount || 0),
    },
    product: {
      load: filters => shopService.listProducts({
        category: filters.category, brand: filters.brand, minPrice: filters.minPrice, maxPrice: filters.maxPrice,
        minRating: filters.minRating, delivery: filters.delivery, maxDistanceKm: filters.maxDistanceKm,
      }),
      id: p => p.id,
      fields: p => ({ name: p.name, secondary: [p.category, p.brand, p.description, p.sku].filter(Boolean) }),
      points: () => [],
      rating: p => ({ rating: p.rating, reviewCount: p.reviewCount, verified: false }),
      popularity: p => Number(p.soldCount || 0),
    },
  };

  /** The areas a viewer is in: the one they named, else the most specific whose circle holds their position. */
  async function viewerAreas({ areaId, lat, lng }) {
    const all = await geoAreas.allAsync();
    if (areaId) return all.some(a => a.id === areaId) ? [areaId] : [];
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
    const rank = { district: 3, city: 2, region: 1, country: 0 };
    const inside = all.filter(a => Number.isFinite(a.lat) && Number.isFinite(a.lng) && Number.isFinite(a.radiusKm) && distanceKm({ lat, lng }, { lat: a.lat, lng: a.lng }) <= a.radiusKm);
    const best = inside.sort((a, b) => (rank[b.level] ?? 0) - (rank[a.level] ?? 0))[0];
    return best ? [best.id] : [];
  }

  function applyFilters(entityType, rows, f, viewer) {
    let out = rows;
    if (entityType === 'gym') {
      const tiers = f.tier ? String(f.tier).split(',').map(s => s.trim()).filter(Boolean) : [];
      if (tiers.length) out = out.filter(g => tiers.includes(g.tier));
      if (f.verified === true) out = out.filter(g => g.verified === true);
    }
    if (entityType === 'trainer') {
      if (f.specialty) out = out.filter(t => (t.specialties || []).some(s => String(s).toLowerCase().includes(String(f.specialty).toLowerCase())));
      if (f.verified === true) out = out.filter(t => t.verified === true);
    }
    if (f.maxDistanceKm !== undefined && entityType !== 'product') {
      // A distance limit needs the viewer's position, and drops results with no known position.
      out = viewer ? out.filter(r => {
        const d = nearest(viewer, sources[entityType].points(r));
        return d !== null && d <= f.maxDistanceKm;
      }) : out;
    }
    return out;
  }

  const compare = {
    distance: (a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity),
    rating: (a, b) => Number(b.row.rating || 0) - Number(a.row.rating || 0),
    popularity: (a, b) => b.pop - a.pop,
    price_asc: (a, b) => priceOf(a.row) - priceOf(b.row),
    price_desc: (a, b) => priceOf(b.row) - priceOf(a.row),
    name: (a, b) => String(a.name).localeCompare(String(b.name)),
  };

  /**
   * One page of ranked results. `shape(row)` lets the caller trim a row for the
   * viewer (a gym's trainer-pass pricing is for trainers only).
   */
  async function discover({ entityType, q, filters = {}, lat, lng, areaId, sort = 'relevance', placement, limit, cursor, rotation, session, explain = false, shape = r => r }) {
    if (!DISCOVERABLE.includes(entityType)) return fail('invalid_entity_type', 400);
    if (!SORTS.includes(sort)) return fail('invalid_sort', 400);
    if (placement !== undefined && !(PLACEMENTS[placement]?.entityTypes || []).includes(entityType)) return fail('invalid_placement', 400);
    if (sort === 'price_asc' && entityType !== 'product') sort = 'relevance';
    if (sort === 'price_desc' && entityType !== 'product') sort = 'relevance';

    const f = {
      tier: filters.tier, verified: bool(filters.verified), specialty: filters.specialty, category: filters.category, brand: filters.brand,
      minPrice: num(filters.minPrice), maxPrice: num(filters.maxPrice), minRating: num(filters.minRating), delivery: bool(filters.delivery), maxDistanceKm: num(filters.maxDistanceKm),
    };
    const query = typeof q === 'string' ? q.trim().slice(0, 100) : '';
    const viewer = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
    const src = sources[entityType];

    // 1–2: what is listable, then the search and filters.
    let rows = applyFilters(entityType, await src.load(f), f, viewer);
    const scored = [];
    for (const row of rows) {
      const fields = src.fields(row);
      const relevance = query ? textRelevance(query, fields.name, fields.secondary) : 0;
      if (query && relevance === 0) continue;                                          // does not match the search: out, promoted or not
      scored.push({ row, key: `${entityType}:${src.id(row)}`, name: fields.name, relevance });
    }

    // 3: organic score.
    const maxPop = Math.max(0, ...scored.map(s => src.popularity(s.row)));
    const organic = minMax(scored.map(s => s.row.homepagePriority));
    const mode = query ? 'search' : 'browse';
    scored.forEach((s, i) => {
      const d = viewer ? nearest(viewer, src.points(s.row)) : null;
      s.distanceKm = d;
      s.pop = src.popularity(s.row);
      const signals = {
        relevance: query ? s.relevance : null,
        location: !viewer ? null : nearScore(entityType === 'product' ? (Number.isFinite(Number(s.row.distanceKm)) ? Number(s.row.distanceKm) : null) : d),
        quality: qualityScore(src.rating(s.row)),
        popularity: popularityScore(s.pop, maxPop),
        organic: organic[i],
      };
      s.baseScore = baseScore(signals, mode);
    });

    // What the card says about its promotion; with a session, also the proof that it was served to that session.
    const tagOf = p => ({
      id: p.id, type: p.type, label: p.label, commercial: p.commercial,
      ...(signToken && session ? { token: signToken({ promotionId: p.id, entityType: p.entityType, entityId: p.entityId, sessionId: session, now: now() }) } : {}),
    });
    const pageSize = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
    const offset = Math.max(parseInt(cursor, 10) || 0, 0);
    // A typed search reads the search placement; filters alone still browse the discovery placement (and still decide who may be Featured).
    const placementUsed = placement ?? (query ? 'search_results' : (entityType === 'gym' ? 'gym_discovery' : entityType === 'trainer' ? 'trainer_discovery' : 'marketplace'));
    const cards = [];
    let featuredCards = [];
    let ordered;
    let promotionsApplied = false;
    let rotationUsed = 0;

    if (sort === 'relevance') {
      // 4: promotions, by place and viewer, only for results still in the list.
      const areaIds = await viewerAreas({ areaId, lat, lng });
      const byKey = new Map(scored.map(s => [s.key, s]));
      // The listings are already in hand (publicly listable, past the search and filters), so promotions are
      // matched to them directly instead of fetching each one again; a promoted listing must still be eligible.
      const live = (await promotionService.listLive({ placement: placementUsed, entityType, viewer: { areaIds, coords: viewer }, checkEntities: false }))
        .filter(p => { const s = byKey.get(p.entityKey); return !!s && entityEligibility(entityType, s.row, 'approved').ok; });
      const cfg = await configs.allAsync();
      const featuredRow = cfg.find(c => c.placement === placementUsed && c.promotionType === 'featured');
      // A later page sends back the rotation turn it was given, so ties are not shuffled between pages.
      const slice = Number.isInteger(rotation) ? rotation : (featuredRow?.rotationMode === 'none' ? 0 : rotationSlice(now(), featuredRow?.rotationWindowMinutes ?? DEFAULT_ROTATION.windowMinutes));
      rotationUsed = slice;
      const featured = pickFeatured(live.filter(p => p.type === 'featured'), scored.map(s => s.key), { max: slotLimit(cfg, placementUsed, 'featured'), slice });
      const featuredKeys = new Set(featured.map(p => p.entityKey));
      featuredCards = featured.map(p => {
        const s = byKey.get(p.entityKey);
        return { ...shape(s.row), promotion: tagOf(p), ...(explain ? { ranking: { baseScore: s.baseScore, boost: 0, placement: placementUsed } } : {}) };
      });
      const rest = scored.filter(s => !featuredKeys.has(s.key));
      const ranked = applyBoosts(rest.map(s => ({ key: s.key, baseScore: s.baseScore, _s: s })), live.filter(p => p.type !== 'featured'),
        { scoreRange: { min: 0, max: 100 }, cap: p => boostCap(cfg, placementUsed, p.type), slice });
      ordered = ranked.map(r => ({ ...r._s, boost: r.boost, promo: r.boost > 0 ? r.promotion : null }));
      promotionsApplied = true;
    } else {
      // The key is the last tie-break of every sort, so the same request always gives the same order.
      ordered = [...scored].sort((a, b) => (compare[sort] ? compare[sort](a, b) : 0) || String(a.key).localeCompare(String(b.key))).map(s => ({ ...s, boost: 0, promo: null }));
    }

    const total = ordered.length;
    for (const s of ordered.slice(offset, offset + pageSize)) {
      cards.push({
        ...shape(s.row),
        ...(s.promo ? { promotion: tagOf(s.promo) } : {}),
        ...(explain ? { ranking: { baseScore: s.baseScore, boost: Math.round(s.boost * 100) / 100, placement: placementUsed } } : {}),
      });
    }
    return {
      items: cards,
      // The Featured section is only on the first page; it is never repeated in the list below it.
      featured: offset === 0 ? featuredCards : [],
      total, nextCursor: offset + pageSize < total ? offset + pageSize : null,
      placement: placementUsed, sort, promotionsApplied, rotation: rotationUsed,
      filters: Object.fromEntries(Object.entries({ q: query || undefined, ...f }).filter(([, v]) => v !== undefined)),
    };
  }

  return { discover, viewerAreas, FILTER_KEYS, SORTS };
}
