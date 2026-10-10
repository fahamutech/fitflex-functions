// Hardening fixes found in review, at service level (no database): disclosure,
// four-eyes on ranking, searching before paging, stable ordering, input bounds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, promoBody, approved, iso, HOUR, DAY } from './support/promotion-fixtures.mjs';
import { disclosureLabel, validatePromotionInput, normaliseGeoScope } from '../src/shared/promotion-rules.mjs';
import { textRelevance } from '../src/shared/discovery-scoring.mjs';
import { createDiscoveryService } from '../src/services/discovery-service.mjs';
import { createModerationGate } from '../src/services/moderation-gate.mjs';

const ok = out => { assert.equal(out.error, undefined, JSON.stringify(out)); return out; };
const err = (out, code, status) => { assert.equal(out.error, code, JSON.stringify(out)); if (status) assert.equal(out.status, status); return out; };

// ── Disclosure ──────────────────────────────────────────────────────────────

test('a paid placement always says so, whatever wording was chosen', () => {
  assert.equal(disclosureLabel({ type: 'featured', isCommercial: false }), 'Featured');
  assert.equal(disclosureLabel({ type: 'featured', isCommercial: true }), 'Featured · Sponsored');
  assert.equal(disclosureLabel({ type: 'promoted', isCommercial: true }), 'Promoted · Sponsored');
  assert.equal(disclosureLabel({ type: 'sponsored', isCommercial: true }), 'Sponsored');                     // already says it
  assert.equal(disclosureLabel({ type: 'featured', isCommercial: true, disclosureLabel: 'Top pick' }), 'Top pick · Sponsored');
  assert.equal(disclosureLabel({ type: 'featured', isCommercial: true, disclosureLabel: 'Sponsored pick' }), 'Sponsored pick');
  assert.equal(disclosureLabel({ type: 'featured', isCommercial: true, disclosureLabel: 'Advertisement' }), 'Advertisement');
  assert.equal(disclosureLabel({ type: 'featured', isCommercial: false, disclosureLabel: 'Top pick' }), 'Top pick');   // editorial wording is free
  assert.equal(disclosureLabel({ type: 'recommended', isCommercial: false }), 'Recommended by FitFlex');
});

// ── Ranking changes are the approver's ──────────────────────────────────────

test('changing how strongly an approved promotion ranks needs the approver; other live edits do not', async () => {
  const w = makeWorld();
  const p = await approved(w, { priority: 5 });
  err(await w.promotionService.update({ id: p.id, body: { priority: 1 }, actorId: 'maker', canRank: false }), 'ranking_change_requires_approver', 403);
  err(await w.promotionService.update({ id: p.id, body: { boostWeight: 1 }, actorId: 'maker', canRank: false }), 'ranking_change_requires_approver', 403);
  ok(await w.promotionService.update({ id: p.id, body: { notes: 'client call 4 Oct' }, actorId: 'maker', canRank: false }));
  ok(await w.promotionService.update({ id: p.id, body: { priority: 2 }, actorId: 'approver', canRank: true }));
  // A draft is the maker's to shape.
  const d = ok(await w.promotionService.create({ body: promoBody(w.clock), actorId: 'maker' }));
  ok(await w.promotionService.update({ id: d.promotion.id, body: { priority: 1 }, actorId: 'maker', canRank: false }));
});

// ── Searching a list ────────────────────────────────────────────────────────

test('a search in the promotion list is applied before paging: totals and pages are those of the matches', async () => {
  const w = makeWorld();
  w.stores.gyms.rows.splice(0, w.stores.gyms.rows.length, ...Array.from({ length: 30 }, (_, i) => ({ id: `g${i}`, name: i % 10 === 0 ? `Zanzibar Iron ${i}` : `Plain Gym ${i}`, status: 'active', homepageVisible: true })));
  for (let i = 0; i < 30; i += 1) ok(await w.promotionService.create({ body: promoBody(w.clock, { entityId: `g${i}`, priority: 5 }), actorId: 'm' }));
  const all = ok(await w.promotionService.list({ limit: 10 }));
  assert.equal(all.total, 30);
  const hit = ok(await w.promotionService.list({ q: 'zanzibar', limit: 2 }));
  assert.equal(hit.total, 3);                                                                            // not "3 of the first 2"
  assert.equal(hit.items.length, 2);
  assert.equal(hit.nextCursor, 2);
  const next = ok(await w.promotionService.list({ q: 'zanzibar', limit: 2, cursor: hit.nextCursor }));
  assert.equal(next.items.length, 1);
  assert.deepEqual([...hit.items, ...next.items].map(i => i.entity.name).sort(), ['Zanzibar Iron 0', 'Zanzibar Iron 10', 'Zanzibar Iron 20']);
});

// ── Limits keep what was set ────────────────────────────────────────────────

test('changing a slot limit does not quietly reset its boost cap; saying null clears it', async () => {
  const w = makeWorld();
  const set = body => w.promotionService.setLimit({ placement: 'home', promotionType: 'promoted', actorId: 'a', ...body });
  ok(await set({ maxSlots: 4, maxBoostFraction: 0.1 }));
  assert.equal(ok(await set({ maxSlots: 6 })).limit.maxBoostFraction, 0.1);
  assert.equal(ok(await set({ maxSlots: 6, maxBoostFraction: null })).limit.maxBoostFraction, null);
});

// ── Inputs ──────────────────────────────────────────────────────────────────

test('input bounds: boost weight, audience, categories and areas', () => {
  const base = { entityType: 'gym', entityId: 'g', type: 'featured', placements: ['gym_discovery'], startsAt: '2030-01-01T00:00:00Z', endsAt: '2030-01-02T00:00:00Z' };
  const v = over => validatePromotionInput({ ...base, ...over });
  assert.equal(v({ boostWeight: null }).error, 'invalid_boost_weight');
  assert.equal(v({ boostWeight: '' }).error, 'invalid_boost_weight');
  assert.equal(v({ boostWeight: true }).error, 'invalid_boost_weight');
  assert.equal(v({ boostWeight: 0 }).error, undefined);
  assert.equal(v({ audience: { blob: 'x'.repeat(3000) } }).error, 'audience_too_large');
  assert.equal(v({ audience: [1, 2] }).value.audience && Object.keys(v({ audience: [1, 2] }).value.audience).length, 0);   // an array is not an audience
  assert.equal(v({ categories: Array.from({ length: 25 }, (_, i) => `c${i}`) }).error, 'too_many_categories');
  assert.equal(normaliseGeoScope({ areaIds: Array.from({ length: 60 }, (_, i) => `a${i}`) }).error, 'too_many_areas');
});

test('areas need real coordinates', async () => {
  const w = makeWorld();
  const add = body => w.promotionService.createArea({ body: { level: 'city', name: 'Moshi', parentId: 'tz-znz', ...body }, actorId: 'a' });
  err(await add({ lat: 95, lng: 0 }), 'invalid_coordinates', 422);
  err(await add({ lat: 0, lng: 200 }), 'invalid_coordinates', 422);
  err(await add({ lat: 0, lng: 0, radiusKm: 0 }), 'invalid_coordinates', 422);
  ok(await add({ lat: -3.3, lng: 37.3, radiusKm: 10 }));
});

// ── Moderation queue ────────────────────────────────────────────────────────

test('the moderation queue lists what needs a decision first', async () => {
  const w = makeWorld();
  await w.moderationService.decide({ entityType: 'gym', entityId: 'gym_c', action: 'require_review', reason: 'x', actorId: 'm' });
  await w.moderationService.decide({ entityType: 'gym', entityId: 'gym_b', action: 'suspend', reason: 'x', actorId: 'm' });
  const all = ok(await w.moderationService.list({ entityType: 'gym' }));
  assert.deepEqual(all.items.slice(0, 2).map(i => i.moderationStatus), ['pending', 'suspended']);
});

// ── Search ──────────────────────────────────────────────────────────────────

test('a search with nothing to match on matches nothing, not everything', () => {
  for (const q of ['!!!', '-', '   ', '健身', '???']) assert.equal(textRelevance(q, 'Iron Paradise', ['boxing']), 0, JSON.stringify(q));
  assert.ok(textRelevance('iron', 'Iron Paradise') > 0);
});

// ── Stable paging ───────────────────────────────────────────────────────────

function discoveryOver(w) {
  return createDiscoveryService({
    gymService: { listActiveAsync: async () => w.stores.gyms.rows.filter(g => g.status === 'active').map(g => ({ ...g })) },
    trainerService: { listPublic: async () => [] }, shopService: { listProducts: async () => [] }, partnerGate: { badgeGyms: async r => r },
    moderationGate: createModerationGate({ states: w.stores.moderationStates }), promotionService: w.promotionService, configs: w.stores.configs,
    geoAreas: w.stores.geoAreas, now: w.clock.now,
  });
}

test('paging is stable: equal results keep their order across pages, even when the hour turns between them', async () => {
  const w = makeWorld();
  // Twenty identical gyms (all scores tie), five of them with equal Featured promotions.
  w.stores.gyms.rows.splice(0, w.stores.gyms.rows.length, ...Array.from({ length: 20 }, (_, i) => ({ id: `g${String(i).padStart(2, '0')}`, name: `Same Gym ${i}`, status: 'active', homepageVisible: true, rating: 4, reviewCount: 5 })));
  for (let i = 0; i < 5; i += 1) {
    const p = await approved(w, { entityId: `g${String(i).padStart(2, '0')}`, priority: 5, startsAt: iso(w.clock, -HOUR), endsAt: iso(w.clock, 7 * DAY) });
    ok(await w.promotionService.activate({ id: p.id, actorId: 'c' }));
  }
  ok(await w.promotionService.setLimit({ placement: 'gym_discovery', promotionType: 'featured', maxSlots: 2, actorId: 'a' }));   // lowering a limit leaves the five running; the section shows two
  const d = discoveryOver(w);
  const first = ok(await d.discover({ entityType: 'gym', limit: 6 }));
  assert.equal(first.featured.length, 2);
  w.clock.advance(HOUR + 1000);                                                                                  // the rotation turns before page two
  const second = ok(await d.discover({ entityType: 'gym', limit: 6, cursor: first.nextCursor, rotation: first.rotation }));
  w.clock.advance(HOUR);
  const third = ok(await d.discover({ entityType: 'gym', limit: 6, cursor: second.nextCursor, rotation: first.rotation }));
  const seen = [...first.items, ...second.items, ...third.items].map(g => g.id);
  assert.equal(new Set(seen).size, seen.length, 'no result twice');
  const featured = new Set(first.featured.map(g => g.id));
  assert.equal(seen.length, 20 - featured.size, 'no result skipped');
  assert.ok(seen.every(id => !featured.has(id)));
  // Without sending the rotation back, the same request is reproducible within the same hour.
  const again = ok(await d.discover({ entityType: 'gym', limit: 6 }));
  assert.deepEqual(again.items.map(g => g.id), ok(await d.discover({ entityType: 'gym', limit: 6 })).items.map(g => g.id));
});

test('explicit sorts have a stable order for equal values', async () => {
  const w = makeWorld();
  w.stores.gyms.rows.splice(0, w.stores.gyms.rows.length, ...['d', 'b', 'a', 'c'].map(k => ({ id: `g_${k}`, name: 'Same Name', status: 'active', homepageVisible: true, rating: 4, reviewCount: 1 })));
  const d = discoveryOver(w);
  for (const sort of ['rating', 'name', 'popularity']) assert.deepEqual(ok(await d.discover({ entityType: 'gym', sort })).items.map(g => g.id), ['g_a', 'g_b', 'g_c', 'g_d'], sort);
});
