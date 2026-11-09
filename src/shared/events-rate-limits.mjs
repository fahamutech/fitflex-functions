// Marathon & running events · S5 — a counter window that can be PEEKED, for limits that count only some outcomes
// (spec §4.1: failed ticket verifications, 30 a minute per staff user). In memory per server like every other limiter
// (createVendorLimiter), so with N servers the real allowance is up to N times the figure.
export function createCounterWindow({ limit, windowMs = 60_000, maxTracked = 5000 }) {
  const windows = new Map();
  const live = (key, at) => { const w = windows.get(key); return w && w.resetAt > at ? w : null; };
  return {
    /** Has this key used up its allowance? → null | { retryAfterSeconds } */
    blocked(key, at = Date.now()) {
      const w = live(key, at);
      return w && w.count >= limit ? { retryAfterSeconds: Math.max(1, Math.ceil((w.resetAt - at) / 1000)) } : null;
    },
    hit(key, at = Date.now()) {
      let w = live(key, at);
      if (!w) {
        windows.delete(key);
        if (windows.size >= maxTracked) for (const [k, v] of windows) if (v.resetAt <= at) windows.delete(k);
        while (windows.size >= maxTracked) windows.delete(windows.keys().next().value);
        w = { count: 0, resetAt: at + windowMs };
        windows.set(key, w);
      }
      w.count += 1;
    },
    reset: () => windows.clear(),
    limit,
  };
}
