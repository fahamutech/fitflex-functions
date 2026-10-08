// Moderation & Promotion — the rules, as pure functions: validating a promotion,
// what state it is really in right now, whether an entity may be promoted, who
// a geographic scope reaches, how much room a placement has, and how a bounded
// boost is applied. The service decides nothing that is not decided here.
import {
  ENTITY_TYPES, PLACEMENTS, PROMOTION_TYPES, RELATIONSHIP_TYPES, NON_COMMERCIAL_RELATIONSHIPS,
  PROMOTION_STATUSES, PROMOTION_TRANSITIONS, SLOT_HOLDING_STATUSES, MODERATION_ACTIONS,
  BLOCKING_MODERATION_STATUSES, IMPLICIT_MODERATION_STATUS, DEFAULT_PLACEMENT_LIMITS,
  DEFAULT_MAX_BOOST_FRACTION, DEFAULT_ROTATION, MAX_PRIORITY,
} from './promotion-config.mjs';

const ms = v => (v == null ? NaN : new Date(v).getTime());
const isDate = v => Number.isFinite(ms(v));
const text = (v, max = 500) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

// ── Moderation ──────────────────────────────────────────────────────────────

/** What a moderation action does, or why it can't be done. */
export function planModeration(current, action, reason) {
  const rule = MODERATION_ACTIONS[action];
  if (!rule) return { error: 'unknown_action' };
  const status = current || IMPLICIT_MODERATION_STATUS;
  if (!rule.from.includes(status)) return { error: 'invalid_transition', from: status, action };
  if (rule.reason && !text(reason)) return { error: 'reason_required' };
  return { from: status, to: rule.to, blocking: BLOCKING_MODERATION_STATUSES.includes(rule.to) };
}

export const isModerationBlocking = status => BLOCKING_MODERATION_STATUSES.includes(status || IMPLICIT_MODERATION_STATUS);

// ── Eligibility ─────────────────────────────────────────────────────────────

/**
 * Whether an entity may be shown publicly / promoted right now: moderation
 * approved AND it passes its own listing rules. `operational` is the KYC gate's
 * answer for vendors (a vendor that isn't live has no public products).
 * Returns { ok, reasons[] } so the admin can be told why.
 */
export function entityEligibility(entityType, entity, moderationStatus, { operational = true } = {}) {
  const reasons = [];
  if (!entity) return { ok: false, reasons: ['entity_not_found'] };
  const mod = moderationStatus || IMPLICIT_MODERATION_STATUS;
  if (mod !== 'approved') reasons.push(`moderation_${mod}`);
  switch (entityType) {
    case 'gym':
      if (entity.status !== 'active') reasons.push('gym_not_active');
      if (entity.homepageVisible === false) reasons.push('not_visible');
      break;
    case 'trainer':
      if (entity.status !== 'active') reasons.push('trainer_not_active');
      if (entity.homepageVisible === false) reasons.push('not_visible');
      if (entity.approvalStatus && entity.approvalStatus !== 'approved') reasons.push('trainer_not_approved');
      break;
    case 'vendor': {
      if (entity.approvalStatus && entity.approvalStatus !== 'approved') reasons.push('vendor_not_approved');
      if (entity.accountStatus === 'suspended') reasons.push('vendor_suspended');
      if (entity.vendorProfile?.status !== 'published') reasons.push('vendor_not_published');
      if (!operational) reasons.push('vendor_not_operational');
      break;
    }
    case 'product':
      if (entity.status !== 'active') reasons.push('product_not_active');
      if (['pending', 'rejected'].includes(entity.approvalStatus)) reasons.push('product_not_approved');
      if (entity.visibility === 'hidden') reasons.push('product_hidden');
      if (entity.homepageVisible === false) reasons.push('not_visible');
      if (entity.deletedAt) reasons.push('product_deleted');
      if (!operational) reasons.push('vendor_not_operational');
      break;
    default:
      reasons.push('unknown_entity_type');
  }
  return { ok: reasons.length === 0, reasons };
}

// ── Promotion lifecycle ─────────────────────────────────────────────────────

export const canTransition = (from, to) => (PROMOTION_TRANSITIONS[from] || []).includes(to);

/**
 * The state a promotion is really in at `now`. Stored status changes only when
 * the job (or an admin) writes it, so every read goes through this and an
 * expired or not-yet-started promotion can never influence ranking by mistake.
 */
export function effectiveStatus(promotion, now = new Date()) {
  const { status } = promotion;
  const t = now instanceof Date ? now.getTime() : ms(now);
  const start = ms(promotion.startsAt);
  const end = ms(promotion.endsAt);
  if (['approved', 'scheduled', 'active', 'paused'].includes(status) && Number.isFinite(end) && t >= end) return 'expired';
  if (status === 'scheduled' && Number.isFinite(start) && t >= start) return 'active';
  if (status === 'active' && Number.isFinite(start) && t < start) return 'scheduled';
  return status;
}

/** Whether a promotion may influence ranking at `now`. */
export const isLive = (promotion, now = new Date()) => effectiveStatus(promotion, now) === 'active';

// ── Validation ──────────────────────────────────────────────────────────────

/** Valid placements for an entity type. */
export const placementsFor = entityType =>
  Object.entries(PLACEMENTS).filter(([, p]) => p.entityTypes.includes(entityType)).map(([key]) => key);

/**
 * Validate and normalise the fields of a promotion. `partial` skips "required"
 * checks (an edit sends only what changed); `now` is for the past-end check.
 * Returns { value } or { error, field }.
 */
export function validatePromotionInput(input = {}, { partial = false, now = new Date() } = {}) {
  const has = k => input[k] !== undefined;
  const out = {};
  const bad = (error, field) => ({ error, field });

  if (!partial || has('entityType')) {
    if (!ENTITY_TYPES[input.entityType]) return bad('invalid_entity_type', 'entityType');
    out.entityType = input.entityType;
  }
  if (!partial || has('entityId')) {
    if (!text(input.entityId, 120)) return bad('entity_id_required', 'entityId');
    out.entityId = text(input.entityId, 120);
  }
  if (!partial || has('type')) {
    if (!PROMOTION_TYPES[input.type]) return bad('invalid_promotion_type', 'type');
    out.type = input.type;
  }
  if (!partial || has('placements')) {
    if (!Array.isArray(input.placements) || !input.placements.length) return bad('placements_required', 'placements');
    const unique = [...new Set(input.placements)];
    if (unique.some(p => !PLACEMENTS[p])) return bad('invalid_placement', 'placements');
    out.placements = unique;
  }
  if (!partial || has('startsAt') || has('endsAt')) {
    const startsAt = has('startsAt') ? input.startsAt : null;
    const endsAt = has('endsAt') ? input.endsAt : null;
    if (!partial) {
      if (!isDate(startsAt)) return bad('invalid_start', 'startsAt');
      if (!isDate(endsAt)) return bad('invalid_end', 'endsAt');
    }
    if (has('startsAt')) { if (!isDate(startsAt)) return bad('invalid_start', 'startsAt'); out.startsAt = new Date(startsAt).toISOString(); }
    if (has('endsAt')) { if (!isDate(endsAt)) return bad('invalid_end', 'endsAt'); out.endsAt = new Date(endsAt).toISOString(); }
  }
  if (has('priority') || !partial) {
    const p = input.priority === undefined ? 10 : Number(input.priority);
    if (!Number.isInteger(p) || p < 1 || p > MAX_PRIORITY) return bad('invalid_priority', 'priority');
    out.priority = p;
  }
  if (has('boostWeight')) {
    const w = Number(input.boostWeight);
    if (!Number.isFinite(w) || w < 0 || w > 1) return bad('invalid_boost_weight', 'boostWeight');
    out.boostWeight = w;
  } else if (!partial) out.boostWeight = 1;

  if (has('geoScope') || !partial) {
    const g = normaliseGeoScope(input.geoScope);
    if (g.error) return bad(g.error, 'geoScope');
    out.geoScope = g.value;
  }
  if (has('audience')) out.audience = input.audience && typeof input.audience === 'object' ? input.audience : {};
  else if (!partial) out.audience = {};
  if (has('categories')) {
    if (!Array.isArray(input.categories)) return bad('invalid_categories', 'categories');
    out.categories = [...new Set(input.categories.map(c => text(c, 60)).filter(Boolean))];
  } else if (!partial) out.categories = [];

  if (has('campaignId')) out.campaignId = text(input.campaignId, 120);
  if (has('partnerRef')) out.partnerRef = text(input.partnerRef, 120);
  if (has('commercialRef')) out.commercialRef = text(input.commercialRef, 200);
  if (has('notes')) out.notes = text(input.notes, 1000);
  if (has('disclosureLabel')) out.disclosureLabel = text(input.disclosureLabel, 60);
  if (has('relationshipType')) {
    if (input.relationshipType !== null && !RELATIONSHIP_TYPES[input.relationshipType]) return bad('invalid_relationship_type', 'relationshipType');
    out.relationshipType = input.relationshipType ?? null;
  }
  if (has('isCommercial')) out.isCommercial = input.isCommercial === true;
  return { value: out };
}

/**
 * Rules that need the whole promotion (not just the changed fields): the period,
 * the placement for the entity, and what Sponsored / Recommended mean.
 */
export function checkPromotionRules(p, { now = new Date(), requireFuture = false } = {}) {
  if (!ENTITY_TYPES[p.entityType]) return { error: 'invalid_entity_type', field: 'entityType' };
  if (!(ms(p.endsAt) > ms(p.startsAt))) return { error: 'end_before_start', field: 'endsAt' };
  if (requireFuture && !(ms(p.endsAt) > (now instanceof Date ? now.getTime() : ms(now)))) return { error: 'period_in_past', field: 'endsAt' };
  const invalid = (p.placements || []).filter(k => !PLACEMENTS[k]?.entityTypes.includes(p.entityType));
  if (invalid.length) return { error: 'placement_not_valid_for_entity', field: 'placements', placements: invalid };
  const rule = PROMOTION_TYPES[p.type]?.commercial;
  const commercial = p.isCommercial === true;
  if (rule === 'required' && !commercial) return { error: 'sponsored_requires_commercial', field: 'isCommercial' };
  if (rule === 'forbidden' && commercial) return { error: 'recommended_cannot_be_commercial', field: 'isCommercial' };
  if (commercial && NON_COMMERCIAL_RELATIONSHIPS.includes(p.relationshipType)) return { error: 'relationship_not_commercial', field: 'relationshipType' };
  if (commercial && !p.relationshipType) return { error: 'relationship_required', field: 'relationshipType' };
  if (!commercial && p.relationshipType && !NON_COMMERCIAL_RELATIONSHIPS.includes(p.relationshipType)) return { error: 'relationship_requires_commercial', field: 'relationshipType' };
  return {};
}

/** The label shown to users. A commercially influenced placement is always labelled. */
export function disclosureLabel(p) {
  if (p.disclosureLabel) return p.disclosureLabel;
  const base = PROMOTION_TYPES[p.type]?.disclosure || 'Promoted';
  // Paid featured/promoted placements say "Sponsored" only if no explicit label is set; the type label otherwise.
  return base;
}

// ── Geography ───────────────────────────────────────────────────────────────
// A scope is { areaIds: [GeoArea ids], radius?: { lat, lng, km } }. Empty = everywhere.
// An area covers itself and everything beneath it (a region covers its cities).

export function normaliseGeoScope(scope) {
  if (scope == null) return { value: { areaIds: [] } };
  if (typeof scope !== 'object' || Array.isArray(scope)) return { error: 'invalid_geo_scope' };
  const areaIds = Array.isArray(scope.areaIds) ? [...new Set(scope.areaIds.filter(a => typeof a === 'string' && a))] : [];
  const value = { areaIds };
  if (scope.radius != null) {
    const { lat, lng, km } = scope.radius;
    if (![lat, lng, km].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || km <= 0) return { error: 'invalid_geo_radius' };
    value.radius = { lat, lng, km };
  }
  return { value };
}

/** Ids of an area and all its ancestors, given an id -> { parentId } map. */
export function areaChain(areaId, areasById) {
  const chain = [];
  const seen = new Set();
  let id = areaId;
  while (id && areasById.has(id) && !seen.has(id)) { seen.add(id); chain.push(id); id = areasById.get(id).parentId; }
  return chain;
}

const toRad = d => (d * Math.PI) / 180;
export function distanceKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/**
 * Whether a promotion's scope reaches a viewer. `viewer` is { areaIds: [leaf
 * area id], coords?: {lat,lng} }; ancestors are resolved from `areasById`.
 * An unscoped promotion reaches everyone. With only a radius, a viewer with no
 * position is not reached.
 */
export function geoMatches(scope, viewer = {}, areasById = new Map()) {
  const s = scope || { areaIds: [] };
  const hasAreas = (s.areaIds || []).length > 0;
  if (!hasAreas && !s.radius) return true;
  if (hasAreas) {
    const viewerChain = new Set((viewer.areaIds || []).flatMap(id => areaChain(id, areasById)));
    if (s.areaIds.some(id => viewerChain.has(id))) return true;
  }
  if (s.radius && viewer.coords && Number.isFinite(viewer.coords.lat) && Number.isFinite(viewer.coords.lng)) {
    if (distanceKm(s.radius, viewer.coords) <= s.radius.km) return true;
  }
  return false;
}

/** Whether two scopes can reach the same viewer (for counting slots). Radius is treated conservatively as overlapping. */
export function geoOverlaps(a, b, areasById = new Map()) {
  const A = a || { areaIds: [] };
  const B = b || { areaIds: [] };
  const aAll = !(A.areaIds || []).length && !A.radius;
  const bAll = !(B.areaIds || []).length && !B.radius;
  if (aAll || bAll || A.radius || B.radius) return true;
  const under = ids => new Set(ids.flatMap(id => areaChain(id, areasById)));
  // Overlap if one's area is the other's area or an ancestor of it.
  const aUp = under(A.areaIds);
  const bUp = under(B.areaIds);
  return B.areaIds.some(id => aUp.has(id)) || A.areaIds.some(id => bUp.has(id));
}

// ── Capacity ────────────────────────────────────────────────────────────────

export const periodsOverlap = (a, b) => ms(a.startsAt) < ms(b.endsAt) && ms(b.startsAt) < ms(a.endsAt);

/** The slot limit for a placement and promotion type: a configured row, else the default. */
export function slotLimit(configs, placement, type) {
  const row = (configs || []).find(c => c.placement === placement && c.promotionType === type);
  return row?.maxSlots ?? DEFAULT_PLACEMENT_LIMITS[type] ?? 0;
}

/**
 * How many slots a promotion would use in each of its placements, against the
 * limit. `others` are the other promotions (any status; non-holders are ignored).
 */
export function capacityCheck(promotion, others, configs, areasById = new Map()) {
  const results = (promotion.placements || []).map((placement) => {
    const max = slotLimit(configs, placement, promotion.type);
    const used = others.filter(o =>
      o.id !== promotion.id
      && o.type === promotion.type
      && SLOT_HOLDING_STATUSES.includes(o.status)
      && (o.placements || []).includes(placement)
      && periodsOverlap(o, promotion)
      && geoOverlaps(o.geoScope, promotion.geoScope, areasById),
    ).length;
    return { placement, type: promotion.type, max, used, available: Math.max(max - used, 0), full: used >= max };
  });
  return { ok: results.every(r => !r.full), results };
}

// ── Ranking: a bounded, explainable boost (used by discovery in a later phase) ──

/** Per-placement caps: a configured row, else the default share of the score range. */
export function boostCap(configs, placement) {
  const row = (configs || []).find(c => c.placement === placement && c.maxBoostFraction != null);
  return row ? Number(row.maxBoostFraction) : DEFAULT_MAX_BOOST_FRACTION;
}

/**
 * Apply promotions to ALREADY RELEVANT, ALREADY ELIGIBLE results. Promotions are
 * only ever looked up by an item that is in `items`; nothing is added, and
 * nothing is exempt from the filters that produced `items`.
 *
 *   items       [{ key, baseScore }]  results that passed search, filters and eligibility
 *   promotions  live promotions (see isLive) with { entityKey, priority, boostWeight }
 *   scoreRange  { min, max } of base scores, so the cap is a share of the spread
 *   cap         max boost as a fraction of that spread (0..1)
 *   slice       an integer (e.g. the hour) so ties rotate fairly and tests are reproducible
 *
 * Returns items with { finalScore, boost, promotion, reasons[] }, best first.
 */
export function applyBoosts(items, promotions, { scoreRange, cap = DEFAULT_MAX_BOOST_FRACTION, slice = 0 } = {}) {
  const spread = Math.max((scoreRange?.max ?? 0) - (scoreRange?.min ?? 0), 0) || 1;
  const byKey = new Map();
  for (const p of promotions || []) {
    const cur = byKey.get(p.entityKey);
    if (!cur || p.priority < cur.priority) byKey.set(p.entityKey, p); // best (lowest-number) priority wins; boosts never stack
  }
  const maxPriority = MAX_PRIORITY;
  const scored = items.map((item) => {
    const promo = byKey.get(item.key);
    let boost = 0;
    const reasons = [`base:${item.baseScore}`];
    if (promo) {
      // Priority 1 gets the full cap, MAX_PRIORITY almost none; boostWeight scales it down further.
      const priorityShare = (maxPriority - promo.priority + 1) / maxPriority;
      boost = Math.min(cap, cap * priorityShare * (promo.boostWeight ?? 1)) * spread;
      reasons.push(`promotion:${promo.id}`, `boost:${boost.toFixed(4)}`);
    }
    return { ...item, boost, promotion: promo || null, finalScore: item.baseScore + boost, reasons };
  });
  return scored.sort((a, b) =>
    b.finalScore - a.finalScore
    || (a.promotion?.priority ?? Infinity) - (b.promotion?.priority ?? Infinity)
    || rotationTiebreak(a.key, slice) - rotationTiebreak(b.key, slice)
    || String(a.key).localeCompare(String(b.key)));
}

/** A stable pseudo-random number per key and slice: ties move around as the slice changes, but are reproducible. */
export function rotationTiebreak(key, slice) {
  let h = 2166136261 ^ Number(slice);
  for (const ch of String(key)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967295;
}

/** The current rotation slice (an integer) for a window length in minutes. */
export function rotationSlice(now = new Date(), windowMinutes = DEFAULT_ROTATION.windowMinutes) {
  return Math.floor((now instanceof Date ? now.getTime() : ms(now)) / (Math.max(windowMinutes, 1) * 60_000));
}

/**
 * Featured section: pick up to `max` promotions, strongest priority first, with
 * promotions of equal priority rotated by slice. Only entities that are in
 * `eligibleKeys` (they passed the user's filters) can appear; if none do, the
 * section is empty, and the caller hides it.
 */
export function pickFeatured(promotions, eligibleKeys, { max, slice = 0 }) {
  const ok = new Set(eligibleKeys);
  return (promotions || [])
    .filter(p => ok.has(p.entityKey))
    .sort((a, b) => a.priority - b.priority
      || rotationTiebreak(a.entityKey, slice) - rotationTiebreak(b.entityKey, slice)
      || String(a.entityKey).localeCompare(String(b.entityKey)))
    .slice(0, Math.max(max, 0));
}

export { PROMOTION_STATUSES };
