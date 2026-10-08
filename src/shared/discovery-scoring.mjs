// Discovery — the organic part of ranking: how well a result matches a search,
// how near it is, how good it is and how popular. Everything is a 0..1 signal,
// combined into one 0..100 base score. Promotions are applied on top of this
// score by promotion-rules.applyBoosts and can only move a result that is
// already here; nothing in this file knows a promotion exists.
import { distanceKm } from './promotion-rules.mjs';

/** Weights (they are normalised, so only their proportions matter). */
export const WEIGHTS = Object.freeze({
  search: Object.freeze({ relevance: 0.45, location: 0.20, quality: 0.15, popularity: 0.10, organic: 0.10 }),
  browse: Object.freeze({ relevance: 0, location: 0.35, quality: 0.25, popularity: 0.15, organic: 0.25 }),
});
export const DEFAULT_NEAR_KM = 25;
/** What a result with no known position scores for location: neither near nor far. */
export const UNKNOWN_LOCATION = 0.3;

const norm = v => String(v ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').trim();
const words = v => norm(v).split(/[^a-z0-9]+/).filter(Boolean);

/**
 * How well the text fields match a search, 0..1, or 0 for no match at all.
 * `primary` is the name; `secondary` are other fields (specialties, category…).
 * Every word of the search must match somewhere, so "boxing gym" does not
 * match a yoga studio just because it is a gym.
 */
export function textRelevance(query, primary, secondary = []) {
  const q = norm(query);
  if (!q) return 0;
  const name = norm(primary);
  const tokens = words(q);
  // A search with nothing to match on (only punctuation or symbols) matches nothing, rather than everything.
  if (!tokens.length) return 0;
  const others = secondary.map(norm).filter(Boolean);
  const nameWords = words(name);
  const hay = [name, ...others];
  if (!tokens.every(t => hay.some(h => h.includes(t)))) return 0;
  if (name === q) return 1;
  if (name.startsWith(q)) return 0.85;
  let best = 0.35;                                                            // matched only in other fields
  if (nameWords.some(w => w.startsWith(tokens[0])) && tokens.every(t => name.includes(t))) best = 0.7;
  if (name.includes(q)) best = Math.max(best, 0.6);
  else if (tokens.every(t => name.includes(t))) best = Math.max(best, 0.55);
  // A match in the name AND another field is slightly stronger than the name alone.
  if (best >= 0.55 && others.some(o => o.includes(tokens[0]))) best = Math.min(best + 0.05, 0.9);
  return best;
}

/** Nearness, 0..1: 1 at the viewer, 0 at `nearKm` or beyond; unknown position = UNKNOWN_LOCATION. */
export function locationScore(viewer, point, nearKm = DEFAULT_NEAR_KM) {
  if (!viewer || !Number.isFinite(viewer.lat) || !Number.isFinite(viewer.lng)) return null;   // no viewer position: the signal is off
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return UNKNOWN_LOCATION;
  return Math.max(0, 1 - distanceKm(viewer, point) / nearKm);
}

/** Quality, 0..1: the rating, trusted more as reviews accumulate; a small bonus for being verified. */
export function qualityScore({ rating, reviewCount, verified }) {
  const r = Math.max(0, Math.min(Number(rating) || 0, 5)) / 5;
  const confidence = 0.6 + 0.4 * Math.min((Number(reviewCount) || 0) / 10, 1);
  return Math.min(1, r * confidence + (verified === true ? 0.1 : 0));
}

/** Popularity, 0..1, on a log scale so a few very popular results do not flatten the rest. */
export function popularityScore(count, max) {
  const c = Math.max(Number(count) || 0, 0);
  const m = Math.max(Number(max) || 0, 1);
  return Math.min(Math.log1p(c) / Math.log1p(m), 1);
}

/**
 * Combine signals into a 0..100 base score. A signal that is off (null: no
 * viewer position) drops out and the others are rescaled, so a missing signal
 * never penalises a result.
 */
export function baseScore(signals, mode) {
  const w = WEIGHTS[mode];
  let sum = 0;
  let total = 0;
  for (const [name, weight] of Object.entries(w)) {
    const v = signals[name];
    if (v == null || weight === 0) continue;
    sum += weight * v;
    total += weight;
  }
  return total ? Math.round((sum / total) * 10000) / 100 : 0;
}

/** Normalise a list of numbers to 0..1 by min and max (a lone value, or all equal, gives 0.5). */
export function minMax(values) {
  const nums = values.map(v => Number(v) || 0);
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  return nums.map(v => (hi === lo ? 0.5 : (v - lo) / (hi - lo)));
}
