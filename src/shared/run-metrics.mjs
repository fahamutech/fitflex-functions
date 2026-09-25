// Run metrics from a recorded GPS track. The app shows the same numbers
// live (lib/shared/activity/run_metrics.dart) — keep the two in step.
//
// A track is a list of segments (a new one starts after each pause), each a
// list of points [lat, lng, altitudeM | null, timeMs, accuracyM | null].
// Nothing is invented: points the phone wasn't sure about are dropped, and
// time and distance only count inside segments (never across a pause).

export const MAX_ACCURACY_M = 30;
// Faster than this between two points is a GPS jump, not running (~43 km/h).
export const MAX_POINT_SPEED_MS = 12;
// Climbs smaller than this are GPS altitude noise.
export const CLIMB_THRESHOLD_M = 3;
const SMOOTH_WINDOW = 3;
const EARTH_M = 6_371_000;

export function haversineM(a, b) {
  const rad = d => (d * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Drops unsure and impossible points; keeps each segment's order. */
export function cleanTrack(segments) {
  const out = [];
  for (const seg of segments) {
    const kept = [];
    for (const p of seg) {
      if (!Array.isArray(p) || p.length < 4) continue;
      const [lat, lng, , t, acc] = p;
      if (![lat, lng, t].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
      if (Number.isFinite(acc) && acc > MAX_ACCURACY_M) continue;
      const prev = kept[kept.length - 1];
      if (prev) {
        const dt = (t - prev[3]) / 1000;
        if (dt <= 0) continue;
        if (haversineM(prev, p) / dt > MAX_POINT_SPEED_MS) continue;
      }
      kept.push([lat, lng, Number.isFinite(p[2]) ? p[2] : null, t, Number.isFinite(acc) ? acc : null]);
    }
    if (kept.length) out.push(kept);
  }
  return out;
}

/** Total climb, with smoothing and a threshold so noise doesn't add up. */
export function elevationGainM(points) {
  const alts = points.map(p => p[2]).filter(Number.isFinite);
  if (alts.length < 2) return 0;
  const smooth = alts.map((_, i) => {
    const w = alts.slice(Math.max(0, i - (SMOOTH_WINDOW >> 1)), i + (SMOOTH_WINDOW >> 1) + 1);
    return w.reduce((n, a) => n + a, 0) / w.length;
  });
  let gain = 0;
  let low = smooth[0];
  for (const a of smooth) {
    if (a < low) low = a;
    else if (a - low >= CLIMB_THRESHOLD_M) { gain += a - low; low = a; }
  }
  return gain;
}

/**
 * Distance (km), moving time (s), elevation gain (m) and per-km split times
 * (s) from a cleaned track.
 */
export function trackMetrics(segments) {
  let meters = 0, moving = 0, gain = 0;
  const splits = [];
  let nextKm = 1000, splitStart = 0;
  for (const seg of segments) {
    gain += elevationGainM(seg);
    for (let i = 1; i < seg.length; i++) {
      const d = haversineM(seg[i - 1], seg[i]);
      const dt = (seg[i][3] - seg[i - 1][3]) / 1000;
      // Time at which this stretch crosses each whole km.
      while (meters + d >= nextKm && d > 0) {
        const at = moving + dt * ((nextKm - meters) / d);
        splits.push(Math.round(at - splitStart));
        splitStart = at;
        nextKm += 1000;
      }
      meters += d;
      moving += dt;
    }
  }
  return {
    distanceKm: Math.round(meters / 10) / 100,
    movingSeconds: Math.round(moving),
    elevationGainM: Math.round(gain),
    splits,
  };
}

/**
 * Estimated calories for a run: ACSM equations (running above 8 km/h,
 * walking below), from average moving speed, time and body weight. No
 * weight, no estimate.
 */
export function runCalories({ distanceKm, movingSeconds, weightKg }) {
  const w = Number(weightKg);
  if (!Number.isFinite(w) || w < 25 || w > 300 || movingSeconds <= 0) return null;
  const minutes = movingSeconds / 60;
  const mPerMin = (distanceKm * 1000) / minutes;
  const vo2 = mPerMin >= 134 ? 0.2 * mPerMin + 3.5 : 0.1 * mPerMin + 3.5; // ml/kg/min
  return Math.round((vo2 * w / 1000) * 5 * minutes);
}
