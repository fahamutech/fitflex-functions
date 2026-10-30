// Marathon & running events · S6 — what a recorded run says about an event (spec §5.3, §5.4). Pure functions over the cleaned track
// ([[lat, lng, altM, timeMs, accuracyM], …] per segment, one segment per stretch between pauses). Nothing here sees a person.
// The numbers below are tunable constants; a flag only routes a run to a human, it never rejects one.
import { createHash } from 'node:crypto';
import { haversineM } from './run-metrics.mjs';

export const FASTEST_KM_SEC = 140; // 2:20 per km
/** World-record pace (seconds per km) for a distance band; a run more than 5 % faster than this on average is flagged. */
export const RECORD_PACE_SEC_PER_KM = [[5_500, 150], [11_000, 156], [22_000, 163], [43_000, 171], [Infinity, 190]];
export const DROPPED_POINTS_PCT = 15;
export const LONG_GAP_SEC = 600;
export const GRID_M = 50;

const recordPace = meters => RECORD_PACE_SEC_PER_KM.find(([max]) => meters <= max)[1];

/** Cumulative distance (m) and moving time (ms) at every point; pauses between segments add neither. */
export function profile(segments) {
  const pts = [];
  let dist = 0; let ms = 0; let longestGapSec = 0;
  for (const seg of segments) {
    for (let i = 0; i < seg.length; i += 1) {
      if (i > 0) {
        const dt = seg[i][3] - seg[i - 1][3];
        dist += haversineM(seg[i - 1], seg[i]);
        ms += dt;
        longestGapSec = Math.max(longestGapSec, dt / 1000);
      }
      pts.push({ d: dist, t: ms, abs: seg[i][3], lat: seg[i][0], lng: seg[i][1] });
    }
  }
  return { pts, distanceMeters: dist, movingMs: ms, longestGapSec, startedAt: pts[0]?.abs ?? null };
}

/** Moving time (ms) at which the cumulative distance first reaches `meters`, interpolated inside the last step; null when never reached. */
export function timeAtDistance(pts, meters) {
  for (let i = 1; i < pts.length; i += 1) {
    if (pts[i].d >= meters) {
      const span = pts[i].d - pts[i - 1].d;
      const frac = span > 0 ? (meters - pts[i - 1].d) / span : 1;
      return Math.round(pts[i - 1].t + frac * (pts[i].t - pts[i - 1].t));
    }
  }
  return null;
}

/** The fastest 1 km stretch (seconds), or null when the run is shorter than 1 km. */
export function bestKmSec(pts) {
  let best = null; let j = 0;
  for (let i = 0; i < pts.length; i += 1) {
    while (j < pts.length && pts[j].d - pts[i].d < 1000) j += 1;
    if (j >= pts.length) break;
    const span = pts[j].d - pts[i].d;
    const sec = ((pts[j].t - pts[i].t) / 1000) * (1000 / span);
    if (best === null || sec < best) best = sec;
  }
  return best === null ? null : Math.round(best);
}

/** A coarse, direction-sensitive fingerprint: the sequence of distinct 50 m grid cells, hashed. Two copies of one run match; two different runs do not. */
export function routeFingerprint(segments) {
  const first = segments[0]?.[0];
  if (!first) return null;
  const mLat = 111_320;
  const mLng = 111_320 * Math.cos((first[0] * Math.PI) / 180);
  const cells = [];
  for (const seg of segments) for (const p of seg) {
    const c = `${Math.floor((p[0] * mLat) / GRID_M)}:${Math.floor((p[1] * mLng) / GRID_M)}`;
    if (cells[cells.length - 1] !== c) cells.push(c);
  }
  return createHash('sha256').update(cells.join('|')).digest('hex').slice(0, 32);
}

/**
 * → { distanceMeters, movingSeconds, elapsedMs (time to the category distance, null when not reached), startedAt (ms), fingerprint, checks, flags }.
 * `rawPoints` / `cleanPoints` give droppedPointsPct when the caller still has the raw upload (null otherwise).
 */
export function analyseRun(segments, { categoryMeters, startsAtMs = null, rawPoints = null, cleanPoints = null }) {
  const p = profile(segments);
  const avg = p.distanceMeters > 0 ? (p.movingMs / 1000) / (p.distanceMeters / 1000) : null;
  const best = bestKmSec(p.pts);
  const dropped = rawPoints && cleanPoints !== null ? Math.max(0, Math.round(((rawPoints - cleanPoints) / rawPoints) * 100)) : null;
  const flags = [];
  const reference = categoryMeters || p.distanceMeters;
  if ((best !== null && best < FASTEST_KM_SEC) || (avg !== null && avg < recordPace(reference) / 1.05)) flags.push('implausible_pace');
  if (dropped !== null && dropped > DROPPED_POINTS_PCT) flags.push('many_dropped_points');
  if (p.longestGapSec > LONG_GAP_SEC) flags.push('long_gap');
  return {
    distanceMeters: Math.round(p.distanceMeters), movingSeconds: Math.round(p.movingMs / 1000), elapsedMs: categoryMeters ? timeAtDistance(p.pts, categoryMeters) : null,
    startedAt: p.startedAt, fingerprint: routeFingerprint(segments), flags,
    checks: {
      startedAtOffsetMinutes: startsAtMs !== null && p.startedAt !== null ? Math.round((p.startedAt - startsAtMs) / 60_000) : null,
      distanceCoveragePct: categoryMeters ? Math.round((p.distanceMeters / categoryMeters) * 100) : null,
      bestKmPaceSec: best, avgPaceSec: avg === null ? null : Math.round(avg), droppedPointsPct: dropped, longestGapSec: Math.round(p.longestGapSec),
    },
  };
}
