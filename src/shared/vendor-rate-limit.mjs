// Per-vendor request limits, in memory per server (the pattern of GET /shop/home and S3 POST /vendor/sales,
// security review #214 L5). With several servers the real allowance is servers × perMinute.
// Each limiter keeps its own window per key: { count, resetAt }.

/**
 * → { allow(key, nowMs?) → { ok } | { ok: false, retryAfterSeconds }, reset(), size() }
 * `windowMs` (default one minute): S5's public document page also limits per token per hour.
 * `maxTracked` is a TRUE cap (security review #229 M2): when the map is full, expired windows are dropped
 * first, then the oldest windows (least recently started) are evicted, so memory never grows past it.
 */
export function createVendorLimiter({ perMinute, maxTracked = 5000, windowMs = 60_000 }) {
  const windows = new Map();
  function allow(key, nowMs = Date.now()) {
    let w = windows.get(key);
    if (!w || w.resetAt <= nowMs) {
      windows.delete(key); // a new window goes to the end (insertion order = age)
      if (windows.size >= maxTracked) for (const [k, v] of windows) if (v.resetAt <= nowMs) windows.delete(k);
      while (windows.size >= maxTracked) windows.delete(windows.keys().next().value);
      w = { count: 0, resetAt: nowMs + windowMs };
      windows.set(key, w);
    }
    if (w.count >= perMinute) return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((w.resetAt - nowMs) / 1000)) };
    w.count += 1;
    return { ok: true };
  }
  return { allow, reset: () => windows.clear(), size: () => windows.size, perMinute };
}

/** 429 rate_limited { retryAfterSeconds } + Retry-After, or null when allowed. */
export function limitOrNull(limiter, key, res) {
  const allowed = limiter.allow(key);
  if (allowed.ok) return null;
  res.set?.('Retry-After', String(allowed.retryAfterSeconds));
  return res.status(429).json({ error: 'rate_limited', retryAfterSeconds: allowed.retryAfterSeconds });
}
