// Discovery against in-memory stores: the rules a customer can rely on.
//   - a promotion never adds a result that does not match the search or filters
//   - the boost is bounded, so relevance still decides
//   - Featured is a labelled section of results that passed the filters
//   - an explicit sort turns promotion off
//   - hidden and suspended listings never appear, promoted or not
//   - expired, paused and out-of-area promotions do nothing
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, promoBody, approved, iso, HOUR, DAY } from './support/promotion-fixtures.mjs';
import { createDiscoveryService } from '../src/services/discovery-service.mjs';
import { createModerationGate } from '../src/services/moderation-gate.mjs';

const ok = out => { assert.equal(out.error, undefined, JSON.stringify(out)); return out; };
const ids = list => list.map(x => x.id);

/** A world with a set of gyms, trainers and products and a discovery service over them. */
function discoveryWorld({ gyms = [], trainers = [], products = [] } = {}) {
  const w = makeWorld();
  w.stores.gyms.rows.splice(0, w.stores.gyms.rows.length, ...gyms.map(g => ({ status: 'active', homepageVisible: true, tier: 'standard', ...g })));
  w.stores.trainers.rows.splice(0, w.stores.trainers.rows.length, ...trainers.map(t => ({ status: 'active', approvalStatus: 'approved', userId: `u_${t.id}`, specialties: [], gyms: [], ...t })));
  w.stores.products.rows.splice(0, w.stores.products.rows.length, ...products.map(p => ({ status: 'active', approvalStatus: 'approved', visibility: 'visible', vendorId: 'usr_v1', ...p })));
  const moderationGate = createModerationGate({ states: w.stores.moderationStates });
  const discovery = createDiscoveryService({
    gymService: { listActiveAsync: async () => w.stores.gyms.rows.filter(g => g.status === 'active' && g.homepageVisible !== false).map(g => ({ ...g })) },
    trainerService: { listPublic: async () => w.stores.trainers.rows.filter(t => t.status === 'active').map(t => ({ ...t })) },
    shopService: { listProducts: async f => w.stores.products.rows.filter(p => !f.category || p.category === f.category).map(p => ({ ...p })) },
    partnerGate: { badgeGyms: async rows => rows },
    moderationGate, promotionService: w.promotionService, configs: w.stores.configs, geoAreas: w.stores.geoAreas, now: w.clock.now,
  });
  /** Approve and make a promotion live now. */
  const live = async (over, who = {}) => {
    const p = await approved(w, { startsAt: iso(w.clock, -HOUR), endsAt: iso(w.clock, 7 * DAY), ...over }, who);
    ok(await w.promotionService.activate({ id: p.id, actorId: 'checker' }));
    return p;
  };
  return { ...w, discovery, live, d: args => discovery.discover(args) };
}

const BOXING = { id: 'g_box', name: 'Knockout Boxing Gym', location: 'Dar es Salaam', amenities: ['boxing'], rating: 4.8, reviewCount: 40, homepagePriority: 5 };
const WEAK_BOX = { id: 'g_weak', name: 'Corner Boxing', location: 'Dar es Salaam', amenities: ['boxing'], rating: 2.5, reviewCount: 2, homepagePriority: 0 };
const YOGA = { id: 'g_yoga', name: 'Calm Yoga Studio', location: 'Zanzibar', amenities: ['yoga'], rating: 4.0, reviewCount: 10, homepagePriority: 0 };

// ── Relevance protection ────────────────────────────────────────────────────

test('a promoted gym that does not match the search is not inserted, and is not Featured either', async () => {
  const w = discoveryWorld({ gyms: [BOXING, WEAK_BOX, YOGA] });
  await w.live({ entityId: 'g_yoga', type: 'promoted', placements: ['search_results'] });
  await w.live({ entityId: 'g_yoga', type: 'featured', placements: ['search_results'], priority: 1 });
  const out = ok(await w.d({ entityType: 'gym', q: 'boxing' }));
  assert.deepEqual(ids(out.items).sort(), ['g_box', 'g_weak']);
  assert.deepEqual(out.featured, []);                                                    // a Featured gym that does not match does not appear
  assert.equal(out.placement, 'search_results');
});

test('the same promoted gym does appear, labelled, once the search fits it', async () => {
  const w = discoveryWorld({ gyms: [BOXING, WEAK_BOX, YOGA] });
  await w.live({ entityId: 'g_yoga', type: 'featured', placements: ['search_results'] });
  const out = ok(await w.d({ entityType: 'gym', q: 'yoga' }));
  assert.deepEqual(ids(out.featured), ['g_yoga']);
  assert.equal(out.featured[0].promotion.label, 'Featured');
  assert.deepEqual(ids(out.items), []);                                                  // not repeated in the list below
});

test('a boost cannot lift a weak match over a strong one, but can settle a close call', async () => {
  const w = discoveryWorld({ gyms: [BOXING, WEAK_BOX] });
  await w.live({ entityId: 'g_weak', type: 'promoted', placements: ['search_results'], priority: 1 });
  let out = ok(await w.d({ entityType: 'gym', q: 'boxing', explain: true }));
  assert.deepEqual(ids(out.items), ['g_box', 'g_weak']);                                 // strong organic result stays first
  const weak = out.items.find(i => i.id === 'g_weak');
  assert.equal(weak.promotion.type, 'promoted');
  assert.ok(weak.ranking.boost > 0 && weak.ranking.boost <= 25);                         // bounded by the 25% default cap
  assert.equal(out.items.find(i => i.id === 'g_box').promotion, undefined);

  // Two near-equal results: the promotion decides.
  const close = discoveryWorld({ gyms: [{ ...BOXING, id: 'a', name: 'A Boxing' }, { ...BOXING, id: 'b', name: 'B Boxing' }] });
  const before = ids(ok(await close.d({ entityType: 'gym', q: 'boxing' })).items);
  const target = before[1];
  await close.live({ entityId: target, type: 'promoted', placements: ['search_results'] });
  assert.equal(ids(ok(await close.d({ entityType: 'gym', q: 'boxing' })).items)[0], target);
});

test('with no promotions at all the order is exactly the organic order', async () => {
  const w = discoveryWorld({ gyms: [BOXING, WEAK_BOX, YOGA] });
  const out = ok(await w.d({ entityType: 'gym' }));
  assert.deepEqual(out.featured, []);
  assert.ok(out.items.every(i => i.promotion === undefined));
  assert.equal(out.promotionsApplied, true);
  assert.equal(out.total, 3);
});

// ── Featured ────────────────────────────────────────────────────────────────

test('Featured fills its own section above the list, and each gym appears once', async () => {
  const w = discoveryWorld({ gyms: [BOXING, WEAK_BOX, YOGA] });
  await w.live({ entityId: 'g_weak', type: 'featured', placements: ['gym_discovery'] });
  const out = ok(await w.d({ entityType: 'gym' }));
  assert.equal(out.placement, 'gym_discovery');
  assert.deepEqual(ids(out.featured), ['g_weak']);
  assert.deepEqual(ids(out.items).sort(), ['g_box', 'g_yoga']);
});

test('Featured respects the customer\'s filters: a Featured gym that fails a filter is not shown', async () => {
  const w = discoveryWorld({ gyms: [{ ...BOXING, tier: 'premium' }, WEAK_BOX] });
  await w.live({ entityId: 'g_weak', type: 'featured', placements: ['gym_discovery'] });                 // a standard gym
  const filtered = ok(await w.d({ entityType: 'gym', filters: { tier: 'premium' } }));
  assert.deepEqual(filtered.featured, []);
  assert.deepEqual(ids(filtered.items), ['g_box']);
  assert.equal(filtered.placement, 'gym_discovery');                                                     // filters alone are still browsing
  const unfiltered = ok(await w.d({ entityType: 'gym' }));
  assert.deepEqual(ids(unfiltered.featured), ['g_weak']);                                                // and it is shown when it passes
});

test('Featured is limited to the placement\'s slots, strongest first, and rotates among equals', async () => {
  const gyms = ['a', 'b', 'c', 'd', 'e'].map(k => ({ id: `g_${k}`, name: `Gym ${k}`, rating: 4, reviewCount: 5 }));
  const w = discoveryWorld({ gyms });
  ok(await w.promotionService.setLimit({ placement: 'gym_discovery', promotionType: 'featured', maxSlots: 2, actorId: 'admin' }));
  ok(await w.promotionService.setLimit({ placement: 'gym_discovery', promotionType: 'featured', maxSlots: 5, actorId: 'admin' }));
  for (const g of gyms) await w.live({ entityId: g.id, type: 'featured', placements: ['gym_discovery'], priority: 5 });
  ok(await w.promotionService.setLimit({ placement: 'gym_discovery', promotionType: 'featured', maxSlots: 2, actorId: 'admin' }));   // lowering does not remove them; the section shows 2
  const seen = new Set();
  const lengths = new Set();
  for (let h = 0; h < 12; h += 1) {
    w.clock.advance(HOUR);
    const out = ok(await w.d({ entityType: 'gym' }));
    lengths.add(out.featured.length);
    out.featured.forEach(f => seen.add(f.id));
  }
  assert.deepEqual([...lengths], [2]);
  assert.ok(seen.size > 2, 'equal promotions take turns');
});

test('Featured is only on the first page, and is not repeated on the next', async () => {
  const gyms = Array.from({ length: 6 }, (_, i) => ({ id: `g${i}`, name: `Gym ${i}`, rating: 4, reviewCount: 3 }));
  const w = discoveryWorld({ gyms });
  await w.live({ entityId: 'g0', type: 'featured', placements: ['gym_discovery'] });
  const p1 = ok(await w.d({ entityType: 'gym', limit: 2 }));
  assert.equal(p1.featured.length, 1);
  assert.equal(p1.total, 5);
  assert.equal(p1.nextCursor, 2);
  const p2 = ok(await w.d({ entityType: 'gym', limit: 2, cursor: p1.nextCursor }));
  assert.deepEqual(p2.featured, []);
  const p3 = ok(await w.d({ entityType: 'gym', limit: 2, cursor: p2.nextCursor }));
  assert.equal(p3.nextCursor, null);
  const all = [...p1.items, ...p2.items, ...p3.items].map(i => i.id);
  assert.equal(new Set(all).size, 5);
  assert.ok(!all.includes('g0'));
});

// ── Labels ──────────────────────────────────────────────────────────────────

test('a commercial placement is labelled so, and a FitFlex recommendation says so', async () => {
  const w = discoveryWorld({ gyms: [BOXING, WEAK_BOX, YOGA] });
  await w.live({ entityId: 'g_weak', type: 'sponsored', placements: ['search_results'], relationshipType: 'paid_advertising', commercialRef: 'C1' });
  await w.live({ entityId: 'g_yoga', type: 'recommended', placements: ['search_results'], relationshipType: 'editorial' });
  const out = ok(await w.d({ entityType: 'gym', q: 'o' }));
  const byId = Object.fromEntries(out.items.map(i => [i.id, i]));
  assert.deepEqual([byId.g_weak.promotion.label, byId.g_weak.promotion.commercial], ['Sponsored', true]);
  assert.deepEqual([byId.g_yoga.promotion.label, byId.g_yoga.promotion.commercial], ['Recommended by FitFlex', false]);
  assert.equal(byId.g_box.promotion, undefined);
});

// ── Sort turns promotion off ────────────────────────────────────────────────

test('an explicit sort is honoured exactly: no boost, no Featured, no labels', async () => {
  const w = discoveryWorld({ gyms: [BOXING, WEAK_BOX, YOGA] });
  await w.live({ entityId: 'g_weak', type: 'featured', placements: ['gym_discovery'] });
  await w.live({ entityId: 'g_weak', type: 'promoted', placements: ['gym_discovery'], priority: 1 });
  const out = ok(await w.d({ entityType: 'gym', sort: 'rating' }));
  assert.deepEqual(ids(out.items), ['g_box', 'g_yoga', 'g_weak']);                       // by rating, whatever is promoted
  assert.deepEqual(out.featured, []);
  assert.ok(out.items.every(i => i.promotion === undefined));
  assert.equal(out.promotionsApplied, false);
  assert.deepEqual(ids(ok(await w.d({ entityType: 'gym', sort: 'name' })).items), ['g_weak', 'g_yoga', 'g_box'].sort((a, b) => ({ g_box: 'Knockout', g_weak: 'Corner', g_yoga: 'Calm' }[a]).localeCompare({ g_box: 'Knockout', g_weak: 'Corner', g_yoga: 'Calm' }[b])));
});

// ── Time, status and place ──────────────────────────────────────────────────

test('expired and paused promotions do nothing, even before the job has run', async () => {
  const w = discoveryWorld({ gyms: [BOXING, WEAK_BOX] });
  const p = await w.live({ entityId: 'g_weak', type: 'featured', placements: ['gym_discovery'] });
  assert.equal(ok(await w.d({ entityType: 'gym' })).featured.length, 1);
  ok(await w.promotionService.pause({ id: p.id, actorId: 'c', reason: 'dispute' }));
  assert.equal(ok(await w.d({ entityType: 'gym' })).featured.length, 0);
  ok(await w.promotionService.resume({ id: p.id, actorId: 'c' }));
  assert.equal(ok(await w.d({ entityType: 'gym' })).featured.length, 1);
  w.clock.advance(8 * DAY);                                                              // stored status is still "active"
  assert.equal(ok(await w.d({ entityType: 'gym' })).featured.length, 0);
});

test('a promotion scoped to Zanzibar is only for viewers in Zanzibar', async () => {
  const w = discoveryWorld({ gyms: [BOXING, YOGA] });
  await w.live({ entityId: 'g_yoga', type: 'featured', placements: ['gym_discovery'], geoScope: { areaIds: ['tz-znz'] } });
  assert.equal(ok(await w.d({ entityType: 'gym', areaId: 'tz-znz-stone-town' })).featured.length, 1);
  assert.equal(ok(await w.d({ entityType: 'gym', areaId: 'tz-dar-city' })).featured.length, 0);
  assert.equal(ok(await w.d({ entityType: 'gym' })).featured.length, 0);                 // no location known: a local promotion is not shown
});

test('a viewer\'s position is turned into their area for local promotions', async () => {
  const w = discoveryWorld({ gyms: [YOGA] });
  w.stores.geoAreas.rows.push({ id: 'tz-znz-stone-town-geo', level: 'district', name: 'x', parentId: 'tz-znz-city', lat: -6.163, lng: 39.189, radiusKm: 3 });
  w.stores.geoAreas.rows.find(a => a.id === 'tz-znz').lat = -6.165; w.stores.geoAreas.rows.find(a => a.id === 'tz-znz').lng = 39.2; w.stores.geoAreas.rows.find(a => a.id === 'tz-znz').radiusKm = 60;
  assert.deepEqual(await w.discovery.viewerAreas({ lat: -6.163, lng: 39.189 }), ['tz-znz-stone-town-geo']);   // most specific
  assert.deepEqual(await w.discovery.viewerAreas({ lat: -6.0, lng: 39.2 }), ['tz-znz']);
  assert.deepEqual(await w.discovery.viewerAreas({ lat: -3.4, lng: 36.7 }), []);
  assert.deepEqual(await w.discovery.viewerAreas({ areaId: 'nowhere' }), []);
  await w.live({ entityId: 'g_yoga', type: 'featured', placements: ['gym_discovery'], geoScope: { areaIds: ['tz-znz'] } });
  assert.equal(ok(await w.d({ entityType: 'gym', lat: -6.163, lng: 39.189 })).featured.length, 1);
});

// ── Moderation ──────────────────────────────────────────────────────────────

test('hidden, suspended, rejected and pending listings are never shown, promoted or not', async () => {
  const w = discoveryWorld({ gyms: [BOXING, WEAK_BOX, YOGA], trainers: [{ id: 'tr_a', displayName: 'Ann Boxer', specialties: ['boxing'] }, { id: 'tr_b', displayName: 'Bo Boxer', specialties: ['boxing'] }] });
  await w.live({ entityId: 'g_weak', type: 'featured', placements: ['gym_discovery'] });
  const mod = (type, id, action, reason) => w.moderationService.decide({ entityType: type, entityId: id, action, reason, actorId: 'm' });
  assert.equal(ok(await w.d({ entityType: 'gym' })).featured.length, 1);
  await mod('gym', 'g_weak', 'hide', 'x');
  await mod('gym', 'g_box', 'require_review', 'x');
  await mod('gym', 'g_yoga', 'suspend', 'x');
  const out = ok(await w.d({ entityType: 'gym' }));
  assert.deepEqual([out.items.length, out.featured.length, out.total], [0, 0, 0]);
  await mod('trainer', 'tr_a', 'suspend', 'x');
  assert.deepEqual(ids(ok(await w.d({ entityType: 'trainer', q: 'boxer' })).items), ['tr_b']);
  await mod('gym', 'g_yoga', 'restore');
  assert.deepEqual(ids(ok(await w.d({ entityType: 'gym' })).items), ['g_yoga']);       // restored: back, with no promotion
});

// ── Distance and filters ────────────────────────────────────────────────────

test('nearness orders browsing, and a distance limit needs a position and drops gyms with none', async () => {
  const gyms = [
    { id: 'g_near', name: 'Near', coordinates: { lat: -6.80, lng: 39.20 }, rating: 3, reviewCount: 3 },
    { id: 'g_mid', name: 'Mid', coordinates: { lat: -6.90, lng: 39.25 }, rating: 3, reviewCount: 3 },
    { id: 'g_far', name: 'Far', coordinates: { lat: -3.40, lng: 36.70 }, rating: 3, reviewCount: 3 },
    { id: 'g_nopos', name: 'Nowhere', rating: 3, reviewCount: 3 },
  ];
  const w = discoveryWorld({ gyms });
  const here = { lat: -6.80, lng: 39.20 };
  assert.deepEqual(ids(ok(await w.d({ entityType: 'gym', ...here })).items).slice(0, 2), ['g_near', 'g_mid']);
  assert.deepEqual(ids(ok(await w.d({ entityType: 'gym', ...here, sort: 'distance' })).items), ['g_near', 'g_mid', 'g_far', 'g_nopos']);
  assert.deepEqual(ids(ok(await w.d({ entityType: 'gym', ...here, filters: { maxDistanceKm: 30 } })).items).sort(), ['g_mid', 'g_near']);
  assert.equal(ok(await w.d({ entityType: 'gym', filters: { maxDistanceKm: 30 } })).total, 4);   // no position: the limit cannot be applied
});

test('trainers: specialty and verified filters; a trainer\'s distance comes from the gyms they work at', async () => {
  const trainers = [
    { id: 't1', displayName: 'Ann', specialties: ['boxing'], verified: true, gyms: [{ coordinates: { lat: -6.80, lng: 39.20 } }] },
    { id: 't2', displayName: 'Bo', specialties: ['yoga'], verified: false, gyms: [] },
    { id: 't3', displayName: 'Cy', specialties: ['boxing'], verified: false, gyms: [{ coordinates: { lat: -3.4, lng: 36.7 } }] },
  ];
  const w = discoveryWorld({ trainers });
  assert.deepEqual(ids(ok(await w.d({ entityType: 'trainer', filters: { specialty: 'boxing' } })).items).sort(), ['t1', 't3']);
  assert.deepEqual(ids(ok(await w.d({ entityType: 'trainer', filters: { verified: 'true' } })).items), ['t1']);
  assert.deepEqual(ids(ok(await w.d({ entityType: 'trainer', lat: -6.8, lng: 39.2, sort: 'distance' })).items).slice(0, 2), ['t1', 't3']);
});

test('products: promotion applies in the marketplace placement, with the same protection', async () => {
  const products = [
    { id: 'p1', name: 'Whey Protein', category: 'supplements', rating: 4.5, reviewCount: 20, soldCount: 50, priceTzs: 85000 },
    { id: 'p2', name: 'Yoga Mat', category: 'gear', rating: 4.0, reviewCount: 8, soldCount: 5, priceTzs: 30000 },
  ];
  const w = discoveryWorld({ products });
  await w.live({ entityType: 'product', entityId: 'p2', type: 'featured', placements: ['marketplace'] });
  const browse = ok(await w.d({ entityType: 'product' }));
  assert.equal(browse.placement, 'marketplace');
  assert.deepEqual(ids(browse.featured), ['p2']);
  const search = ok(await w.d({ entityType: 'product', q: 'whey' }));
  assert.deepEqual([ids(search.items), search.featured.length], [['p1'], 0]);          // the featured mat does not match "whey"
  assert.deepEqual(ids(ok(await w.d({ entityType: 'product', sort: 'price_asc' })).items), ['p2', 'p1']);
  // A filter alone is still browsing: the Featured mat passes "gear", so it is in the section; the other does not.
  const filtered = ok(await w.d({ entityType: 'product', filters: { category: 'gear' } }));
  assert.deepEqual([ids(filtered.featured), ids(filtered.items), filtered.placement], [['p2'], [], 'marketplace']);
});

// ── Inputs and views ────────────────────────────────────────────────────────

test('bad inputs are refused', async () => {
  const w = discoveryWorld({ gyms: [BOXING] });
  assert.equal((await w.d({ entityType: 'vendor' })).error, 'invalid_entity_type');
  assert.equal((await w.d({ entityType: 'gym', sort: 'cheapest' })).error, 'invalid_sort');
  assert.equal((await w.d({ entityType: 'gym', placement: 'trainer_discovery' })).error, 'invalid_placement');
  assert.equal((await w.d({ entityType: 'gym', placement: 'nowhere' })).error, 'invalid_placement');
  assert.equal(ok(await w.d({ entityType: 'gym', limit: 9999 })).items.length, 1);
});

test('the viewer shape is applied to every card, including Featured', async () => {
  const w = discoveryWorld({ gyms: [{ ...BOXING, trainerPass: { price: 1 } }, { ...WEAK_BOX, trainerPass: { price: 2 } }] });
  await w.live({ entityId: 'g_weak', type: 'featured', placements: ['gym_discovery'] });
  const out = ok(await w.d({ entityType: 'gym', shape: ({ trainerPass, ...rest }) => rest }));
  assert.ok([...out.items, ...out.featured].every(g => g.trainerPass === undefined));
  assert.equal(out.items.length + out.featured.length, 2);
});

test('explain details are only given when asked for', async () => {
  const w = discoveryWorld({ gyms: [BOXING] });
  assert.equal(ok(await w.d({ entityType: 'gym' })).items[0].ranking, undefined);
  const r = ok(await w.d({ entityType: 'gym', explain: true })).items[0].ranking;
  assert.deepEqual(Object.keys(r).sort(), ['baseScore', 'boost', 'placement']);
});
