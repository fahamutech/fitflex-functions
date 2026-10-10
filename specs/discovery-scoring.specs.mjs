// Discovery scoring — the organic signals, with no promotion in sight.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textRelevance, locationScore, qualityScore, popularityScore, baseScore, minMax, UNKNOWN_LOCATION } from '../src/shared/discovery-scoring.mjs';
import { applyBoosts, boostCap } from '../src/shared/promotion-rules.mjs';

test('relevance: a name match beats a match elsewhere, and exact beats partial', () => {
  const exact = textRelevance('iron gym', 'Iron Gym');
  const prefix = textRelevance('iron', 'Iron Paradise');
  const inName = textRelevance('paradise', 'Iron Paradise');
  const elsewhere = textRelevance('boxing', 'Iron Paradise', ['boxing', 'cardio']);
  assert.equal(exact, 1);
  assert.ok(exact > prefix && prefix > inName && inName > elsewhere && elsewhere > 0, JSON.stringify({ exact, prefix, inName, elsewhere }));
});

test('relevance: every word has to match somewhere, so a generic word does not carry an unrelated result', () => {
  assert.equal(textRelevance('boxing gym', 'Zanzibar Yoga Gym', ['yoga']), 0);
  assert.ok(textRelevance('boxing gym', 'Zanzibar Gym', ['boxing', 'cardio']) > 0);
  assert.equal(textRelevance('', 'Anything'), 0);
  assert.equal(textRelevance('zzz', 'Iron Paradise', ['boxing']), 0);
});

test('relevance: case and accents do not matter', () => {
  assert.equal(textRelevance('CAFÉ', 'Cafe Fit'), textRelevance('cafe', 'Cafe Fit'));
  assert.ok(textRelevance('IRON', 'iron works') > 0);
});

test('location: near is better than far, nothing beyond the near range, unknown is neutral, no viewer is off', () => {
  const v = { lat: -6.8, lng: 39.2 };
  const here = locationScore(v, { lat: -6.8, lng: 39.2 });
  const near = locationScore(v, { lat: -6.81, lng: 39.2 });
  const far = locationScore(v, { lat: -3.4, lng: 36.7 });
  assert.equal(here, 1);
  assert.ok(near < 1 && near > 0.9);
  assert.equal(far, 0);
  assert.equal(locationScore(v, null), UNKNOWN_LOCATION);
  assert.equal(locationScore(null, { lat: 0, lng: 0 }), null);
});

test('quality: rating counts for more with reviews; verified helps a little; always within 0..1', () => {
  const few = qualityScore({ rating: 5, reviewCount: 1 });
  const many = qualityScore({ rating: 5, reviewCount: 50 });
  assert.ok(many > few);
  assert.ok(qualityScore({ rating: 4, reviewCount: 20, verified: true }) > qualityScore({ rating: 4, reviewCount: 20 }));
  assert.equal(qualityScore({ rating: 5, reviewCount: 50, verified: true }), 1);
  assert.equal(qualityScore({}), 0);
  assert.equal(qualityScore({ rating: 99, reviewCount: 99 }), 1);
});

test('popularity: log scaled and bounded', () => {
  assert.equal(popularityScore(0, 100), 0);
  assert.equal(popularityScore(100, 100), 1);
  assert.ok(popularityScore(10, 100) > 0.4);                                              // not 0.1: a handful still counts
  assert.equal(popularityScore(500, 100), 1);
});

test('base score: a signal that is off drops out; it does not count against anything', () => {
  const withLoc = baseScore({ relevance: null, location: 1, quality: 1, popularity: 1, organic: 1 }, 'browse');
  const noLoc = baseScore({ relevance: null, location: null, quality: 1, popularity: 1, organic: 1 }, 'browse');
  assert.equal(withLoc, 100);
  assert.equal(noLoc, 100);                                                               // rescaled, not penalised
  assert.equal(baseScore({ relevance: 0, location: 0, quality: 0, popularity: 0, organic: 0 }, 'browse'), 0);
  assert.ok(baseScore({ relevance: 1, location: null, quality: 0, popularity: 0, organic: 0 }, 'search') > baseScore({ relevance: 0.2, location: null, quality: 0, popularity: 0, organic: 0 }, 'search'));
});

test('minMax: scaled to 0..1; a lone or all-equal list is neutral', () => {
  assert.deepEqual(minMax([0, 5, 10]), [0, 0.5, 1]);
  assert.deepEqual(minMax([3]), [0.5]);
  assert.deepEqual(minMax([2, 2]), [0.5, 0.5]);
});

test('boosts: a cap per promotion type, else the platform default (never another type\'s)', () => {
  const cfg = [{ placement: 'home', promotionType: 'sponsored', maxBoostFraction: 0.05 }, { placement: 'home', promotionType: 'promoted', maxBoostFraction: 0.4 }];
  assert.equal(boostCap(cfg, 'home', 'sponsored'), 0.05);
  assert.equal(boostCap(cfg, 'home', 'promoted'), 0.4);
  assert.equal(boostCap(cfg, 'home', 'campaign'), 0.25);                                  // another type's setting never applies: the platform default
  assert.equal(boostCap(cfg, 'search_results', 'promoted'), 0.25);
  const items = [{ key: 'a', baseScore: 50 }];
  const spread = { min: 0, max: 100 };
  const sponsored = applyBoosts(items, [{ id: 's', entityKey: 'a', priority: 1, boostWeight: 1, type: 'sponsored' }], { scoreRange: spread, cap: p => boostCap(cfg, 'home', p.type) })[0].boost;
  const promoted = applyBoosts(items, [{ id: 'p', entityKey: 'a', priority: 1, boostWeight: 1, type: 'promoted' }], { scoreRange: spread, cap: p => boostCap(cfg, 'home', p.type) })[0].boost;
  assert.ok(sponsored <= 5 + 1e-9 && promoted <= 40 + 1e-9 && promoted > sponsored);
});
