// Marathon & running events · S5 — the endpoint URL guard for outbound webhooks (spec §7.2). SSRF defence.
// OWNER REVIEW (D35): this is the only code that decides where FitFlex's servers may dial on an organizer's say-so.
//
//   checkWebhookUrl(raw, { resolve })  at registration AND at every delivery: shape rules, host denylist, then DNS —
//                                      EVERY returned address must be public, or the URL is refused.
//   sendPinned({ url, addresses, … })  dials one of the addresses that were just validated (a custom `lookup`, so the
//                                      socket cannot go to another IP than the one checked), with SNI and Host set to
//                                      the original name and normal certificate validation. Redirects are never
//                                      followed, the response body is read up to 4 KB and dropped, no proxy, no cookies.
//
// There is no environment switch that allows private addresses. The resolver and the sender are injectable so specs
// run without a network; production passes nothing and gets `dns.lookup` and node:https.
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import https from 'node:https';

export const URL_REASONS = Object.freeze(['not_https', 'credentials_in_url', 'bad_port', 'ip_literal', 'blocked_host', 'blocked_address', 'unresolvable', 'too_long']);
const MAX_URL = 2000;
const BODY_CAP = 4096;

// ── Addresses ───────────────────────────────────────────────────────────────

const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function v4ToInt(text) {
  const parts = String(text).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n;
}
const inV4 = (n, [base, bits]) => { const b = v4ToInt(base); const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0; return ((n & mask) >>> 0) === ((b & mask) >>> 0); };
const v4Blocked = n => V4_BLOCKED.some(c => inV4(n, c));

/** An IPv6 literal (no brackets, no zone) → BigInt of its 128 bits, or null when it is not valid. */
function v6ToBig(text) {
  let s = String(text);
  if (s.includes('%') || !s.includes(':')) return null;
  // A dotted IPv4 tail (::ffff:1.2.3.4) becomes two hex groups.
  const dotted = s.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const n = v4ToInt(dotted[2]);
    if (n === null) return null;
    s = `${dotted[1]}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && head.length + tail.length > 7) return null;
  const groups = halves.length === 2 ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail] : head;
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}
const inV6 = (n, base, bits) => (n >> BigInt(128 - bits)) === (base >> BigInt(128 - bits));
const V6 = text => v6ToBig(text);
const embeddedV4 = (n, shift) => Number((n >> BigInt(shift)) & 0xffffffffn);

/** Is this address NOT a public unicast address (so a webhook must never be sent to it)? Unparseable → blocked. */
export function isBlockedAddress(address) {
  const text = String(address ?? '').trim();
  if (isIP(text) === 4) { const n = v4ToInt(text); return n === null || v4Blocked(n); }
  if (isIP(text) !== 6) return true;
  const n = v6ToBig(text);
  if (n === null) return true;
  if (n === 0n || n === 1n) return true;                                  // ::/128 and ::1/128
  if (inV6(n, 0n, 96)) return true;                                       // ::/96 (IPv4-compatible, deprecated): refuse outright
  if (inV6(n, V6('::ffff:0:0'), 96)) return v4Blocked(embeddedV4(n, 0));  // IPv4-mapped: judge the embedded IPv4
  if (inV6(n, V6('64:ff9b::'), 96)) return v4Blocked(embeddedV4(n, 0));   // NAT64: the embedded IPv4
  if (inV6(n, V6('64:ff9b:1::'), 48)) return true;                        // local-use NAT64
  if (inV6(n, V6('100::'), 64)) return true;                              // discard-only
  if (inV6(n, V6('2001::'), 32)) return true;                             // Teredo
  if (inV6(n, V6('2001:db8::'), 32)) return true;                         // documentation
  if (inV6(n, V6('2002::'), 16)) return v4Blocked(embeddedV4(n, 80));     // 6to4: the embedded IPv4
  if (inV6(n, V6('fc00::'), 7)) return true;                              // unique local
  if (inV6(n, V6('fe80::'), 10)) return true;                             // link local
  if (inV6(n, V6('ff00::'), 8)) return true;                              // multicast
  return false;
}

// ── The URL itself ──────────────────────────────────────────────────────────

const BLOCKED_NAMES = new Set(['localhost', 'metadata.google.internal']);
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];

/** Shape rules only (no network): { ok: true, url, host } or { ok: false, reason }. The returned `url` has no fragment. */
export function parseWebhookUrl(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'not_https' };
  const text = raw.trim();
  if (text.length > MAX_URL) return { ok: false, reason: 'too_long' };
  let u;
  try { u = new URL(text); } catch { return { ok: false, reason: 'not_https' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'not_https' };
  if (u.username || u.password) return { ok: false, reason: 'credentials_in_url' };
  if (u.port !== '') return { ok: false, reason: 'bad_port' };            // WHATWG drops the default 443, so any port left is not 443
  const host = u.hostname.replace(/\.$/, '').toLowerCase();
  // WHATWG normalises decimal / octal / hex IPv4 forms to dotted quads and brackets IPv6, so one test covers all of them.
  if (isIP(host) || host.startsWith('[') || /^[0-9.]+$/.test(host)) return { ok: false, reason: 'ip_literal' };
  if (!host.includes('.') || BLOCKED_NAMES.has(host) || BLOCKED_SUFFIXES.some(s => host.endsWith(s))) return { ok: false, reason: 'blocked_host' };
  u.hash = '';
  u.hostname = host;
  return { ok: true, url: u.toString(), host };
}

/** The production resolver: every A and AAAA record of the name. */
export async function defaultResolve(host) {
  return dnsLookup(host, { all: true, verbatim: true });
}

/**
 * Full check: shape, then DNS. → { ok: true, url, host, addresses: [{ address, family }] } or { ok: false, reason }.
 * Run at registration and again before EVERY delivery with a fresh resolution.
 */
export async function checkWebhookUrl(raw, { resolve = defaultResolve } = {}) {
  const parsed = parseWebhookUrl(raw);
  if (!parsed.ok) return parsed;
  let found;
  try { found = await resolve(parsed.host); } catch { return { ok: false, reason: 'unresolvable' }; }
  const addresses = (Array.isArray(found) ? found : []).map(a => (typeof a === 'string' ? { address: a, family: isIP(a) } : { address: a?.address, family: a?.family ?? isIP(a?.address) }))
    .filter(a => typeof a.address === 'string');
  if (!addresses.length) return { ok: false, reason: 'unresolvable' };
  // ONE private address among the answers refuses the whole URL: a name that can point inside cannot be trusted.
  if (addresses.some(a => isBlockedAddress(a.address))) return { ok: false, reason: 'blocked_address' };
  return { ok: true, url: parsed.url, host: parsed.host, addresses };
}

// ── Sending to a pinned address ─────────────────────────────────────────────

/** A `lookup` that can only answer with the validated address (works with and without `all`). */
export const pinnedLookup = ({ address, family }) => (_host, options, callback) => {
  const cb = typeof options === 'function' ? options : callback;
  const opts = typeof options === 'object' && options ? options : {};
  if (opts.all) cb(null, [{ address, family: family || isIP(address) }]);
  else cb(null, address, family || isIP(address));
};

/**
 * POST `body` to `url`, dialling `address` only. Resolves { status, headers, snippet } (snippet = up to 4 KB of the
 * body, as text) or rejects with an error whose `code` is one of: timeout | tls_error | network_error.
 * `tls` ({ ca }) exists for specs that stand up their own HTTPS server; production never passes it.
 */
export function sendPinned({ url, address, family, headers, body, timeoutMs = 10_000, tls = {} }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    let settled = false;
    const done = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const fail = (code, cause) => { const e = new Error(code); e.code = code; e.cause = cause; return e; };
    const req = https.request({
      host: u.hostname, port: 443, path: `${u.pathname}${u.search}`, method: 'POST', servername: u.hostname,
      lookup: pinnedLookup({ address, family }), agent: false, headers: { ...headers, Host: u.host, 'Content-Length': Buffer.byteLength(body) },
      rejectUnauthorized: true, ...(tls.ca ? { ca: tls.ca } : {}),
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        if (size < BODY_CAP) { chunks.push(c); size += c.length; }
        if (size >= BODY_CAP) { res.destroy(); }
      });
      const finish = () => done(resolve, { status: res.statusCode, headers: res.headers, snippet: Buffer.concat(chunks).subarray(0, BODY_CAP).toString('utf8') });
      res.on('end', finish);
      res.on('close', finish);
      res.on('error', finish);
    });
    const timer = setTimeout(() => { req.destroy(); done(reject, fail('timeout')); }, timeoutMs);
    req.on('error', (err) => {
      const code = String(err?.code ?? '');
      const tlsFailure = /CERT|SSL|TLS|ERR_TLS|UNABLE_TO_VERIFY|DEPTH_ZERO|SELF_SIGNED|HOSTNAME_MISMATCH|ERR_SSL/i.test(code) || /certificate|tls|ssl/i.test(String(err?.message ?? ''));
      done(reject, fail(tlsFailure ? 'tls_error' : 'network_error', code));
    });
    req.end(body);
  });
}
