// Marathon & running events · S5 — authentication of ORGANIZER API CLIENTS (rule 6: new code under src/auth/*; D35: the owner reviews it).
//
// The scheme, in one paragraph. An organizer owner/admin creates an API client in the portal and is shown a client secret ONCE
// (`ffs_live_…` / `ffs_test_…`, 256 random bits); only sha256(secret) is stored. The integration exchanges the secret for a
// 15-minute bearer token at ONE route, POST /v1/organizer/token (OAuth-style client credentials). The token is the existing
// short-lived purpose token (`signPurpose('organizer_api', …)`, jwt.mjs is NOT edited), so `requireAuth` can never accept it as a
// session and `verifyPurpose` can never accept a session as an API token. The token carries only { sub: ApiClient.id, cid, sv }:
// scopes, event restriction, status, expiry, secret version and the organizer's standing are read FROM THE DATABASE ROW on every
// call, so a revoke, rotation, scope change, expiry or organizer suspension bites on the next request.
//
// What lives here and nowhere else: secret generation and comparison, the token exchange, the request guard. The store (SQL) and
// the routes are elsewhere; this file has no SQL and no route.
//
// Failure behaviour (the one-answer rule): every failed token request is the SAME `401 { error: 'invalid_client' }` — unknown id,
// wrong secret, revoked, expired, malformed body. The real reason goes to the audit log, never the response. The only different
// answers are 429 (rate limited) and 403 organizer_suspended | api_access_not_enabled, given only to a caller who already
// presented the right secret.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { signPurpose, verifyPurpose, bearerFrom } from './jwt.mjs';
import { createCounterWindow } from '../shared/events-rate-limits.mjs';

export const API_PURPOSE = 'organizer_api';
export const CLIENT_ID_RE = /^ffc_[0-9a-f]{16}$/;
export const SECRET_RE = /^ffs_(live|test)_[A-Za-z0-9_-]{43}$/;

export const newClientId = () => `ffc_${randomBytes(8).toString('hex')}`;
/** `ffs_live_` / `ffs_test_` + 43 base64url characters (256 bits). The prefix lets secret scanners find a leak. */
export const newClientSecret = environment => `ffs_${environment === 'sandbox' ? 'test' : 'live'}_${randomBytes(32).toString('base64url')}`;
export const hashSecret = secret => createHash('sha256').update(String(secret)).digest('hex');

const DUMMY_HASH = hashSecret('ffs_dummy_never_issued');
/** Constant-time compare of two equal-length sha256 hex digests. */
const sameDigest = (a, b) => { const x = Buffer.from(String(a ?? ''), 'utf8'); const y = Buffer.from(String(b ?? ''), 'utf8'); return x.length === y.length && timingSafeEqual(x, y); };

/** Does `secret` match the client's current secret, or its previous one while the rotation grace is open? → 'current' | 'previous' | null */
export function matchSecret(client, secret, at = new Date()) {
  const given = hashSecret(secret);
  const current = sameDigest(given, client?.secretHash ?? DUMMY_HASH);
  const prevLive = Boolean(client?.previousSecretHash) && client.previousSecretExpiresAt && +new Date(client.previousSecretExpiresAt) > +at;
  const previous = sameDigest(given, prevLive ? client.previousSecretHash : DUMMY_HASH);   // always computed: equal work either way
  if (current && client) return 'current';
  if (previous && prevLive) return 'previous';
  return null;
}

// ── Where the client row comes from ─────────────────────────────────────────

let store = null;
/** Register the SQL side at bootstrap (like registerOrganizerLookup): findById(id), findByClientId(clientId), touch(id). */
export function registerApiClientStore(impl) { store = impl; }

// Failure limiters (in memory per server). Only FAILED exchanges are counted: a caller with valid credentials is never blocked by them, so a
// shared or unknown source address (the platform's X-Forwarded-For behaviour is UNVERIFIED) cannot lock every integration out.
const IP_FAILURES = createCounterWindow({ limit: 20, maxTracked: 20_000 });
const CLIENT_FAILURES = createCounterWindow({ limit: 10, maxTracked: 20_000 });
/** For specs. */
export const resetApiAuthLimits = () => { IP_FAILURES.reset(); CLIENT_FAILURES.reset(); RATE.clear(); touched.clear(); };

const INVALID_CLIENT = { status: 401, body: { error: 'invalid_client' } };

/**
 * POST /v1/organizer/token. `input` = { clientId, clientSecret, ip }. → { ok: true, accessToken, expiresIn, client } or
 * { ok: false, status, body, reason, client? } where `reason` is for the AUDIT LOG only.
 * There is NO lock-out of a client (a stranger who knows a client id must not be able to deny it): wrong secrets are only rate-limited per source
 * address and per client_id (also for ids that do not exist: no oracle), and reported (audit + owner notice) by the integrations service.
 */
export async function exchangeClientCredentials({ clientId, clientSecret, ip, ttlSeconds = 900, at = new Date() }) {
  const shapeOk = typeof clientId === 'string' && CLIENT_ID_RE.test(clientId) && typeof clientSecret === 'string' && clientSecret.length <= 120;
  const client = shapeOk ? await store.findByClientId(clientId) : null;
  const matched = matchSecret(client, shapeOk ? clientSecret : '', at);   // runs for unknown clients too (equal work)
  const fail = (reason) => {
    const ipKey = `ip:${ip ?? 'anon'}`;
    const clientKey = `cid:${String(clientId).slice(0, 40)}`;
    const blocked = IP_FAILURES.blocked(ipKey) ?? CLIENT_FAILURES.blocked(clientKey);
    IP_FAILURES.hit(ipKey); CLIENT_FAILURES.hit(clientKey);
    if (blocked) return { ok: false, status: 429, body: { error: 'rate_limited', retryAfterSeconds: blocked.retryAfterSeconds }, reason: 'failure_rate_limited', client, retryAfterSeconds: blocked.retryAfterSeconds, underlying: reason };
    return { ok: false, ...INVALID_CLIENT, reason, client };
  };
  if (!client) return fail(shapeOk ? 'unknown_client' : 'malformed');
  if (!matched) return fail('wrong_secret');
  if (client.status !== 'active') return fail('revoked');
  if (client.expiresAt && +new Date(client.expiresAt) <= +at) return fail('expired');
  // From here the caller holds a valid secret, so they may be told why they are refused.
  if (client.organizerStatus === 'suspended') return { ok: false, status: 403, body: { error: 'organizer_suspended' }, reason: 'organizer_suspended', client };
  if (client.organizerStatus !== 'active') return { ok: false, status: 403, body: { error: 'organizer_not_active' }, reason: 'organizer_not_active', client };
  if (!client.apiAccessEnabled) return { ok: false, status: 403, body: { error: 'api_access_not_enabled' }, reason: 'api_access_not_enabled', client };
  // A token minted from the PREVIOUS secret carries the previous version, so it dies when the grace window ends.
  const sv = matched === 'previous' ? client.secretVersion - 1 : client.secretVersion;
  const accessToken = signPurpose(API_PURPOSE, { sub: client.id, cid: client.clientId, sv }, `${ttlSeconds}s`);
  return { ok: true, accessToken, expiresIn: ttlSeconds, client, secretUsed: matched };
}

// ── Per-client request limit (fixed 60 s window, in memory per server; the real allowance is servers × limit) ──

const RATE = new Map();
function rateWindow(client, at) {
  let w = RATE.get(client.id);
  if (!w || w.resetAt <= at) {
    if (RATE.size >= 5000) for (const [k, v] of RATE) if (v.resetAt <= at) RATE.delete(k);
    if (RATE.size >= 5000) RATE.delete(RATE.keys().next().value);
    w = { count: 0, resetAt: at + 60_000 };
    RATE.set(client.id, w);
  }
  w.count += 1;
  const limit = client.rateLimitPerMinute ?? 120;
  return { limit, remaining: Math.max(limit - w.count, 0), ok: w.count <= limit, retryAfterSeconds: Math.max(1, Math.ceil((w.resetAt - at) / 1000)) };
}

const touched = new Map();

/**
 * The guard of every /v1/organizer route except token and openapi.json. Always wrap in routeGuard(method, …).
 * `requireApiClient('kit:write')` → 403 insufficient_scope { requiredScope } for a client without it; no scope = any valid client.
 * Puts { id, clientId, organizerId, scopes, eventIds, environment, rateLimitPerMinute } on req.apiClient.
 */
export function requireApiClient(...requiredScopes) {
  return async (req, res, next) => {
    const reject = (status, body) => res.status(status).json(body);
    const bearer = bearerFrom(req);
    const claims = bearer ? verifyPurpose(bearer, API_PURPOSE) : null;
    if (!claims) {
      const peek = bearer ? jwt.decode(bearer) : null;
      const expired = peek?.purpose === API_PURPOSE && Number(peek.exp) * 1000 < Date.now();
      return reject(401, { error: expired ? 'token_expired' : 'invalid_token' });
    }
    if (!store || typeof claims.sub !== 'string' || !Number.isInteger(claims.sv)) return reject(401, { error: 'invalid_token' });
    const client = await store.findById(claims.sub);
    const at = Date.now();
    const versionOk = client && (claims.sv === client.secretVersion
      || (claims.sv === client.secretVersion - 1 && client.previousSecretExpiresAt && +new Date(client.previousSecretExpiresAt) > at));
    if (!client || client.clientId !== claims.cid || client.status !== 'active' || !versionOk) return reject(401, { error: 'invalid_token' });
    if (client.expiresAt && +new Date(client.expiresAt) <= at) return reject(403, { error: 'client_expired' });
    if (client.organizerStatus === 'suspended') return reject(403, { error: 'organizer_suspended' });
    if (client.organizerStatus !== 'active') return reject(403, { error: 'organizer_not_active' });
    if (!client.apiAccessEnabled) return reject(403, { error: 'api_access_not_enabled' });
    const w = rateWindow(client, at);
    res.set?.('X-RateLimit-Limit', String(w.limit));
    res.set?.('X-RateLimit-Remaining', String(w.remaining));
    if (!w.ok) {
      res.set?.('Retry-After', String(w.retryAfterSeconds));
      req.apiClientRateLimited = client.id;
      return reject(429, { error: 'rate_limited', retryAfterSeconds: w.retryAfterSeconds });
    }
    const scopes = Array.isArray(client.scopes) ? client.scopes : [];
    const missing = requiredScopes.find(s => !scopes.includes(s));
    if (missing) return reject(403, { error: 'insufficient_scope', requiredScope: missing });
    req.apiClient = { id: client.id, clientId: client.clientId, organizerId: client.ownerId, scopes, eventIds: Array.isArray(client.eventIds) ? client.eventIds : null, environment: client.environment, rateLimitPerMinute: client.rateLimitPerMinute };
    // The last-used stamp is awaited (one UPDATE per client per minute at most) so it has landed when the call returns; a failure never blocks the call.
    if (at - (touched.get(client.id) ?? 0) > 60_000) { touched.set(client.id, at); if (touched.size > 5000) touched.clear(); await store.touch(client.id).catch(() => {}); }
    return next();
  };
}
