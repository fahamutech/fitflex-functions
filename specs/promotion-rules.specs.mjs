// Moderation & promotion rules — the pure part: transitions, eligibility, time,
// validation, geography, capacity and the bounded boost. No database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planModeration, entityEligibility, effectiveStatus, isLive, canTransition, validatePromotionInput, checkPromotionRules,
  normaliseGeoScope, geoMatches, geoOverlaps, areaChain, distanceKm, capacityCheck, slotLimit, boostCap, applyBoosts,
  rotationTiebreak, rotationSlice, pickFeatured, placementsFor,
} from '../src/shared/promotion-rules.mjs';
import { DEFAULT_PLACEMENT_LIMITS, DEFAULT_MAX_BOOST_FRACTION, PLACEMENTS, PROMOTION_TRANSITIONS } from '../src/shared/promotion-config.mjs';

const NOW = new Date('2026-10-10T09:00:00.000Z');
const at = h => new Date(NOW.getTime() + h * 3_600_000).toISOString();
const areas = new Map([
  ['tz', { parentId: null }], ['tz-znz', { parentId: 'tz' }], ['tz-znz-city', { parentId: 'tz-znz' }],
  ['tz-znz-stone', { parentId: 'tz-znz-city' }], ['tz-dar', { parentId: 'tz' }], ['tz-dar-city', { parentId: 'tz-dar' }],
]);
const base = (over = {}) => ({
  entityType: 'gym', entityId: 'g1', type: 'featured', placements: ['gym_discovery'], startsAt: at(1), endsAt: at(48),
  priority: 3, boostWeight: 1, geoScope: { areaIds: [] }, isCommercial: false, relationshipType: null, ...over,
});

// ── Moderation ──────────────────────────────────────────────────────────────

test('moderation: no row means approved, and each action only works from the right state', () => {
  assert.equal(planModeration(undefined, 'suspend', 'fraud').to, 'suspended');       // implicit approved
  assert.equal(planModeration('pending', 'approve').to, 'approved');
  assert.equal(planModeration('approved', 'approve').error, 'invalid_transition');
  assert.equal(planModeration('suspended', 'restore').to, 'approved');
  assert.equal(planModeration('hidden', 'restore').to, 'approved');
  assert.equal(planModeration('rejected', 'reopen').to, 'pending');
  assert.equal(planModeration('rejected', 'restore').error, 'invalid_transition');
  assert.equal(planModeration('approved', 'explode').error, 'unknown_action');
});

test('moderation: reject, suspend and hide need a reason; approve and restore do not', () => {
  for (const a of ['reject', 'suspend', 'hide', 'require_review']) {
    const from = a === 'reject' ? 'pending' : 'approved';
    assert.equal(planModeration(from, a, '   ').error, 'reason_required', a);
  }
  assert.equal(planModeration('pending', 'approve').error, undefined);
  assert.equal(planModeration('suspended', 'restore').error, undefined);
});

test('moderation: blocking states are the ones that keep an entity out of discovery', () => {
  assert.equal(planModeration('approved', 'hide', 'x').blocking, true);
  assert.equal(planModeration('hidden', 'restore').blocking, false);
});

// ── Eligibility ─────────────────────────────────────────────────────────────

test('eligibility: moderation status gates every entity type', () => {
  const gym = { status: 'active', homepageVisible: true };
  assert.equal(entityEligibility('gym', gym, 'approved').ok, true);
  assert.equal(entityEligibility('gym', gym, undefined).ok, true);                    // no row = approved
  for (const s of ['pending', 'rejected', 'suspended', 'hidden']) {
    const e = entityEligibility('gym', gym, s);
    assert.equal(e.ok, false);
    assert.deepEqual(e.reasons, [`moderation_${s}`]);
  }
});

test('eligibility: an entity must also pass its own listing rules', () => {
  assert.deepEqual(entityEligibility('gym', { status: 'inactive' }, 'approved').reasons, ['gym_not_active']);
  assert.ok(entityEligibility('gym', { status: 'active', homepageVisible: false }, 'approved').reasons.includes('not_visible'));
  assert.ok(entityEligibility('trainer', { status: 'suspended' }, 'approved').reasons.includes('trainer_not_active'));
  assert.ok(entityEligibility('product', { status: 'active', approvalStatus: 'pending' }, 'approved').reasons.includes('product_not_approved'));
  assert.ok(entityEligibility('product', { status: 'active', visibility: 'hidden' }, 'approved').reasons.includes('product_hidden'));
  assert.ok(entityEligibility('product', { status: 'active', deletedAt: '2026-01-01' }, 'approved').reasons.includes('product_deleted'));
  assert.ok(entityEligibility('vendor', { approvalStatus: 'approved', vendorProfile: { status: 'draft' } }, 'approved').reasons.includes('vendor_not_published'));
  assert.ok(entityEligibility('vendor', { approvalStatus: 'approved', accountStatus: 'suspended', vendorProfile: { status: 'published' } }, 'approved').reasons.includes('vendor_suspended'));
});

test('eligibility: a vendor that KYC says is not operational has no promotable products', () => {
  const product = { status: 'active', approvalStatus: 'approved' };
  assert.deepEqual(entityEligibility('product', product, 'approved', { operational: false }).reasons, ['vendor_not_operational']);
  assert.equal(entityEligibility('product', product, 'approved', { operational: true }).ok, true);
  assert.deepEqual(entityEligibility('gym', null, 'approved').reasons, ['entity_not_found']);
});

// ── Time ────────────────────────────────────────────────────────────────────

test('time: a promotion is only live inside its window, whatever the stored status says', () => {
  const p = { status: 'active', startsAt: at(-2), endsAt: at(2) };
  assert.equal(effectiveStatus(p, NOW), 'active');
  assert.equal(isLive(p, NOW), true);
  assert.equal(effectiveStatus(p, new Date(at(3))), 'expired');                       // job is late; it is still expired
  assert.equal(isLive(p, new Date(at(3))), false);
  assert.equal(effectiveStatus({ ...p, endsAt: at(0) }, NOW), 'expired');             // the end instant itself is out
});

test('time: scheduled becomes active at its start; active before its start is only scheduled', () => {
  const s = { status: 'scheduled', startsAt: at(1), endsAt: at(5) };
  assert.equal(effectiveStatus(s, NOW), 'scheduled');
  assert.equal(effectiveStatus(s, new Date(at(1))), 'active');
  assert.equal(effectiveStatus({ ...s, status: 'active' }, NOW), 'scheduled');
});

test('time: a paused promotion has no effect, and an unapproved one never expires into anything', () => {
  assert.equal(isLive({ status: 'paused', startsAt: at(-1), endsAt: at(5) }, NOW), false);
  assert.equal(effectiveStatus({ status: 'paused', startsAt: at(-5), endsAt: at(-1) }, NOW), 'expired');
  assert.equal(effectiveStatus({ status: 'draft', startsAt: at(-5), endsAt: at(-1) }, NOW), 'draft');
  assert.equal(effectiveStatus({ status: 'cancelled', startsAt: at(-5), endsAt: at(-1) }, NOW), 'cancelled');
});

test('lifecycle: only declared transitions are allowed, and finished states stay finished', () => {
  assert.equal(canTransition('draft', 'pending_approval'), true);
  assert.equal(canTransition('draft', 'active'), false);
  assert.equal(canTransition('pending_approval', 'active'), false);
  assert.equal(canTransition('expired', 'active'), false);
  assert.equal(canTransition('completed', 'draft'), false);
  assert.equal(canTransition('cancelled', 'draft'), false);
  assert.deepEqual(PROMOTION_TRANSITIONS.completed, []);
});

// ── Validation ──────────────────────────────────────────────────────────────

test('validation: required fields and their types', () => {
  assert.equal(validatePromotionInput({}).error, 'invalid_entity_type');
  assert.equal(validatePromotionInput({ entityType: 'gym' }).error, 'entity_id_required');
  assert.equal(validatePromotionInput({ entityType: 'gym', entityId: 'g' }).error, 'invalid_promotion_type');
  assert.equal(validatePromotionInput({ entityType: 'gym', entityId: 'g', type: 'featured' }).error, 'placements_required');
  assert.equal(validatePromotionInput({ ...base(), placements: ['nowhere'] }).error, 'invalid_placement');
  assert.equal(validatePromotionInput({ ...base(), startsAt: 'soon' }).error, 'invalid_start');
  assert.equal(validatePromotionInput({ ...base(), endsAt: undefined }).error, 'invalid_end');
  assert.equal(validatePromotionInput({ ...base(), priority: 0 }).error, 'invalid_priority');
  assert.equal(validatePromotionInput({ ...base(), priority: 1.5 }).error, 'invalid_priority');
  assert.equal(validatePromotionInput({ ...base(), priority: 101 }).error, 'invalid_priority');
  assert.equal(validatePromotionInput({ ...base(), boostWeight: 2 }).error, 'invalid_boost_weight');
  assert.equal(validatePromotionInput({ ...base(), relationshipType: 'friend' }).error, 'invalid_relationship_type');
  assert.equal(validatePromotionInput({ ...base(), geoScope: 'zanzibar' }).error, 'invalid_geo_scope');
  const ok = validatePromotionInput(base());
  assert.equal(ok.error, undefined);
  assert.equal(ok.value.priority, 3);
});

test('validation: a partial edit only checks what was sent', () => {
  assert.equal(validatePromotionInput({ priority: 2 }, { partial: true }).value.priority, 2);
  assert.equal(validatePromotionInput({ priority: 0 }, { partial: true }).error, 'invalid_priority');
  assert.deepEqual(Object.keys(validatePromotionInput({ notes: 'hi' }, { partial: true }).value), ['notes']);
});

test('rules: the end must be after the start, and in the future when it is going live', () => {
  assert.equal(checkPromotionRules(base({ startsAt: at(5), endsAt: at(5) })).error, 'end_before_start');
  assert.equal(checkPromotionRules(base({ startsAt: at(5), endsAt: at(2) })).error, 'end_before_start');
  assert.equal(checkPromotionRules(base({ startsAt: at(-10), endsAt: at(-5) }), { now: NOW, requireFuture: true }).error, 'period_in_past');
  assert.deepEqual(checkPromotionRules(base(), { now: NOW, requireFuture: true }), {});
});

test('rules: a placement must suit the entity type', () => {
  assert.equal(checkPromotionRules(base({ placements: ['trainer_discovery'] })).error, 'placement_not_valid_for_entity');
  assert.equal(checkPromotionRules(base({ entityType: 'trainer', placements: ['trainer_discovery', 'search_results'] })).error, undefined);
  assert.equal(checkPromotionRules(base({ entityType: 'product', placements: ['marketplace'] })).error, undefined);
  assert.equal(checkPromotionRules(base({ entityType: 'product', placements: ['gym_discovery'] })).error, 'placement_not_valid_for_entity');
  assert.deepEqual(placementsFor('trainer').sort(), ['campaign_page', 'home', 'search_results', 'trainer_discovery']);
});

test('rules: Sponsored is paid, Recommended is not, and a commercial promotion names its relationship', () => {
  assert.equal(checkPromotionRules(base({ type: 'sponsored', isCommercial: false })).error, 'sponsored_requires_commercial');
  assert.equal(checkPromotionRules(base({ type: 'sponsored', isCommercial: true, relationshipType: 'paid_advertising' })).error, undefined);
  assert.equal(checkPromotionRules(base({ type: 'recommended', isCommercial: true, relationshipType: 'paid_advertising' })).error, 'recommended_cannot_be_commercial');
  assert.equal(checkPromotionRules(base({ type: 'recommended', isCommercial: false, relationshipType: 'editorial' })).error, undefined);
  assert.equal(checkPromotionRules(base({ isCommercial: true })).error, 'relationship_required');
  assert.equal(checkPromotionRules(base({ isCommercial: true, relationshipType: 'editorial' })).error, 'relationship_not_commercial');
  assert.equal(checkPromotionRules(base({ isCommercial: false, relationshipType: 'paid_advertising' })).error, 'relationship_requires_commercial');
});

// ── Geography ───────────────────────────────────────────────────────────────

test('geo: an empty scope reaches everyone; an area reaches everything beneath it', () => {
  assert.equal(geoMatches({ areaIds: [] }, { areaIds: ['tz-dar-city'] }, areas), true);
  assert.equal(geoMatches(null, {}, areas), true);
  const zanzibar = { areaIds: ['tz-znz'] };
  assert.equal(geoMatches(zanzibar, { areaIds: ['tz-znz-stone'] }, areas), true);     // district inside the region
  assert.equal(geoMatches(zanzibar, { areaIds: ['tz-znz'] }, areas), true);
  assert.equal(geoMatches(zanzibar, { areaIds: ['tz-dar-city'] }, areas), false);
  assert.equal(geoMatches(zanzibar, {}, areas), false);                               // viewer with no known area
  assert.equal(geoMatches({ areaIds: ['tz-znz-stone'] }, { areaIds: ['tz-znz'] }, areas), false);  // a region viewer is not "in" the district
});

test('geo: a radius reaches viewers within it, and none without a position', () => {
  const scope = { areaIds: [], radius: { lat: -6.163, lng: 39.189, km: 5 } };
  assert.equal(geoMatches(scope, { coords: { lat: -6.165, lng: 39.2 } }, areas), true);
  assert.equal(geoMatches(scope, { coords: { lat: -6.792, lng: 39.208 } }, areas), false);   // Dar is ~70 km away
  assert.equal(geoMatches(scope, {}, areas), false);
  assert.ok(Math.abs(distanceKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }) - 111.19) < 0.5);
});

test('geo: a scope is normalised and bad ones are refused', () => {
  assert.deepEqual(normaliseGeoScope(undefined).value, { areaIds: [] });
  assert.deepEqual(normaliseGeoScope({ areaIds: ['a', 'a', '', 7] }).value, { areaIds: ['a'] });
  assert.equal(normaliseGeoScope([]).error, 'invalid_geo_scope');
  assert.equal(normaliseGeoScope({ radius: { lat: 100, lng: 0, km: 1 } }).error, 'invalid_geo_radius');
  assert.equal(normaliseGeoScope({ radius: { lat: 0, lng: 0, km: 0 } }).error, 'invalid_geo_radius');
  assert.deepEqual(areaChain('tz-znz-stone', areas), ['tz-znz-stone', 'tz-znz-city', 'tz-znz', 'tz']);
});

test('geo: scopes overlap when they can reach the same viewer', () => {
  const z = { areaIds: ['tz-znz'] }; const d = { areaIds: ['tz-dar'] };
  assert.equal(geoOverlaps(z, d, areas), false);
  assert.equal(geoOverlaps(z, { areaIds: ['tz-znz-stone'] }, areas), true);           // district inside region
  assert.equal(geoOverlaps(z, { areaIds: [] }, areas), true);                          // everywhere overlaps all
  assert.equal(geoOverlaps(z, { areaIds: [], radius: { lat: 0, lng: 0, km: 1 } }, areas), true);   // radius: conservative
});

// ── Capacity ────────────────────────────────────────────────────────────────

const held = (id, over = {}) => ({ id, type: 'featured', status: 'active', placements: ['gym_discovery'], startsAt: at(0), endsAt: at(100), geoScope: { areaIds: [] }, ...over });

test('capacity: the limit is configured, else the default', () => {
  assert.equal(slotLimit([], 'gym_discovery', 'featured'), DEFAULT_PLACEMENT_LIMITS.featured);
  assert.equal(slotLimit([{ placement: 'gym_discovery', promotionType: 'featured', maxSlots: 2 }], 'gym_discovery', 'featured'), 2);
  assert.equal(slotLimit([{ placement: 'gym_discovery', promotionType: 'featured', maxSlots: 0 }], 'gym_discovery', 'featured'), 0);   // zero is a real limit
});

test('capacity: only overlapping, slot-holding promotions of the same type and place count', () => {
  const cfg = [{ placement: 'gym_discovery', promotionType: 'featured', maxSlots: 2 }];
  const mine = held('mine', { status: 'draft' });
  const others = [held('a'), held('b', { status: 'paused' })];
  let c = capacityCheck(mine, others, cfg, areas);
  assert.equal(c.ok, false);                                                           // paused still holds its slot
  assert.deepEqual([c.results[0].used, c.results[0].max, c.results[0].available], [2, 2, 0]);

  const unrelated = [
    held('x', { status: 'cancelled' }), held('y', { status: 'expired' }), held('z', { status: 'draft' }),
    held('t', { type: 'promoted' }), held('p', { placements: ['home'] }),
    held('late', { startsAt: at(200), endsAt: at(300) }),
  ];
  c = capacityCheck(mine, unrelated, cfg, areas);
  assert.equal(c.ok, true);
  assert.equal(c.results[0].used, 0);
});

test('capacity: a promotion in another area does not take this area\'s slot', () => {
  const cfg = [{ placement: 'gym_discovery', promotionType: 'featured', maxSlots: 1 }];
  const mine = held('mine', { status: 'draft', geoScope: { areaIds: ['tz-znz'] } });
  assert.equal(capacityCheck(mine, [held('dar', { geoScope: { areaIds: ['tz-dar'] } })], cfg, areas).ok, true);
  assert.equal(capacityCheck(mine, [held('all')], cfg, areas).ok, false);              // an everywhere promotion does
});

test('capacity: every placement of a promotion is checked and the full one is named', () => {
  const cfg = [{ placement: 'home', promotionType: 'featured', maxSlots: 1 }];
  const mine = held('mine', { status: 'draft', placements: ['gym_discovery', 'home'] });
  const c = capacityCheck(mine, [held('a', { placements: ['home'] })], cfg, areas);
  assert.equal(c.ok, false);
  assert.deepEqual(c.results.filter(r => r.full).map(r => r.placement), ['home']);
});

// ── Ranking ─────────────────────────────────────────────────────────────────

const range = { min: 0, max: 100 };
const promo = (entityKey, over = {}) => ({ id: `p_${entityKey}`, entityKey, priority: 1, boostWeight: 1, ...over });

test('ranking: a promotion never adds an item that was not already a relevant result', () => {
  const items = [{ key: 'gym:relevant', baseScore: 60 }];
  const out = applyBoosts(items, [promo('gym:irrelevant'), promo('gym:relevant')], { scoreRange: range });
  assert.deepEqual(out.map(i => i.key), ['gym:relevant']);                             // the unrelated promoted gym is not injected
});

test('ranking: the boost is bounded, so a weak match cannot jump a strong organic one', () => {
  const items = [{ key: 'a', baseScore: 90 }, { key: 'b', baseScore: 40 }];
  const out = applyBoosts(items, [promo('b', { priority: 1, boostWeight: 1 })], { scoreRange: range, cap: 0.25 });
  assert.equal(out[0].key, 'a');                                                       // 40 + at most 25 < 90
  assert.ok(out.find(i => i.key === 'b').boost <= 25 + 1e-9);
  const close = applyBoosts([{ key: 'a', baseScore: 60 }, { key: 'b', baseScore: 50 }], [promo('b')], { scoreRange: range, cap: 0.25 });
  assert.equal(close[0].key, 'b');                                                     // a close call can be tipped
});

test('ranking: stronger priority and weight boost more; boosts do not stack', () => {
  const items = [{ key: 'a', baseScore: 50 }];
  const boost = (p) => applyBoosts(items, [p], { scoreRange: range, cap: 0.2 })[0].boost;
  assert.ok(boost(promo('a', { priority: 1 })) > boost(promo('a', { priority: 50 })));
  assert.ok(boost(promo('a', { boostWeight: 1 })) > boost(promo('a', { boostWeight: 0.5 })));
  assert.equal(boost(promo('a', { boostWeight: 0 })), 0);
  const both = applyBoosts(items, [promo('a', { id: 'x', priority: 5 }), promo('a', { id: 'y', priority: 2 })], { scoreRange: range, cap: 0.2 })[0];
  assert.equal(both.promotion.id, 'y');                                                // the strongest only
  assert.ok(both.boost <= 20 + 1e-9);
});

test('ranking: with no promotions the order is exactly the organic order', () => {
  const items = [{ key: 'b', baseScore: 10 }, { key: 'a', baseScore: 30 }, { key: 'c', baseScore: 20 }];
  assert.deepEqual(applyBoosts(items, [], { scoreRange: range }).map(i => i.key), ['a', 'c', 'b']);
  assert.deepEqual(applyBoosts(items, undefined, { scoreRange: range }).map(i => i.boost), [0, 0, 0]);
});

test('ranking: the boost is explainable', () => {
  const out = applyBoosts([{ key: 'a', baseScore: 50 }], [promo('a', { id: 'promo_9' })], { scoreRange: range })[0];
  assert.ok(out.reasons.includes('promotion:promo_9'));
  assert.ok(out.reasons.some(r => r.startsWith('boost:')));
  assert.equal(out.finalScore, out.baseScore + out.boost);
});

test('ranking: the cap comes from placement settings, else the default', () => {
  assert.equal(boostCap([], 'home'), DEFAULT_MAX_BOOST_FRACTION);
  assert.equal(boostCap([{ placement: 'home', maxBoostFraction: 0.1 }], 'home'), 0.1);
  assert.equal(boostCap([{ placement: 'home', maxBoostFraction: 0 }], 'home'), 0);
});

test('rotation: ties move with the slice, are reproducible, and respect priority', () => {
  const keys = ['a', 'b', 'c', 'd', 'e'];
  const order = slice => applyBoosts(keys.map(key => ({ key, baseScore: 50 })), [], { scoreRange: range, slice }).map(i => i.key);
  assert.deepEqual(order(7), order(7));
  const orders = new Set([0, 1, 2, 3, 4, 5, 6, 7].map(s => order(s).join('')));
  assert.ok(orders.size > 1, 'the order should change across slices');
  assert.equal(rotationTiebreak('a', 1), rotationTiebreak('a', 1));
  assert.equal(rotationSlice(new Date(60 * 60_000 * 5), 60), 5);
  assert.equal(rotationSlice(new Date(60 * 60_000 * 5 + 59_000), 60), 5);
});

test('featured: only eligible entities qualify, strongest first, capped, and an empty section stays empty', () => {
  const promos = [promo('gym:b', { priority: 2 }), promo('gym:a', { priority: 1 }), promo('gym:far', { priority: 1 }), promo('gym:c', { priority: 3 })];
  const eligible = ['gym:a', 'gym:b', 'gym:c'];                                        // gym:far failed the user's filters
  assert.deepEqual(pickFeatured(promos, eligible, { max: 2 }).map(p => p.entityKey), ['gym:a', 'gym:b']);
  assert.deepEqual(pickFeatured(promos, [], { max: 5 }), []);
  assert.deepEqual(pickFeatured(promos, eligible, { max: 0 }), []);
});

test('featured: equal priority rotates across slices but never drops anyone permanently', () => {
  const promos = ['a', 'b', 'c', 'd', 'e'].map(k => promo(`gym:${k}`, { priority: 1 }));
  const eligible = promos.map(p => p.entityKey);
  const seen = new Set();
  for (let s = 0; s < 50; s += 1) pickFeatured(promos, eligible, { max: 2, slice: s }).forEach(p => seen.add(p.entityKey));
  assert.equal(seen.size, 5);
});

test('config: placements and defaults are what the spec lists', () => {
  assert.deepEqual(Object.keys(PLACEMENTS).sort(), ['campaign_page', 'gym_discovery', 'home', 'marketplace', 'search_results', 'trainer_discovery', 'vendor_discovery']);
  assert.equal(DEFAULT_PLACEMENT_LIMITS.featured, 5);
  assert.equal(DEFAULT_PLACEMENT_LIMITS.promoted, 10);
  assert.equal(DEFAULT_MAX_BOOST_FRACTION, 0.25);
});
