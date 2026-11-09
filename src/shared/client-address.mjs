// The client address behind the proxy, counted from the RIGHT of X-Forwarded-For (the entries nearest our own
// proxies are the ones they appended; the left-most entry is whatever the client wrote and can be spoofed).
// PUBLIC_DOCS_TRUSTED_PROXY_HOPS = how many trusted proxies sit in front (default 1; 0 = use the socket address).

export function trustedProxyHops(env = process.env) {
  const raw = env.PUBLIC_DOCS_TRUSTED_PROXY_HOPS;
  const n = raw == null || String(raw).trim() === '' ? 1 : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 1;
}

export function clientAddress(req) {
  const hops = trustedProxyHops();
  const direct = req.socket?.remoteAddress || req.ip || 'unknown';
  if (hops === 0) return direct;
  const chain = String(req.headers?.['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return chain.length ? chain[Math.max(0, chain.length - hops)] : direct;
}
