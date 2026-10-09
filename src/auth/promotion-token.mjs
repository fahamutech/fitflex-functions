// Signed "this was served" tokens for promotion analytics.
//
// Anyone can read a promotion id and its listing id from a public discovery
// response, so an event that merely names them proves nothing. When discovery
// serves a promoted card to an app session it also hands back a token: an HMAC,
// made with a key only the server has, over the promotion, the listing, the
// session that asked and the time. An event is trusted only if it brings a
// token that matches all of those, so forging one means asking discovery for it
// (a real, rate-limited request for a real, live promotion) with the session
// the events will use.
//
// Not a login: it carries nothing private and cannot be used for anything but
// reporting that its own card was shown, tapped or acted on.
import { createHmac, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';
export const TOKEN_TTL_MS = 24 * 3_600_000;
/** An event cannot be about a card before it was served; a little slack for clocks. */
export const SERVED_SLACK_MS = 10 * 60_000;
const MAX_TOKEN_LENGTH = 600;
const SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** A session id discovery will bind a token to; anything else gets no token. */
export const isTokenSession = s => typeof s === 'string' && SESSION_RE.test(s);

const b64 = buf => Buffer.from(buf).toString('base64url');

/**
 * Keys are read when used, not at import, so a rotation needs no code change:
 * set PROMOTION_EVENT_SECRET to the new secret and keep the old one in
 * PROMOTION_EVENT_SECRET_PREVIOUS for a day (the token lifetime). With neither
 * set, a key is derived from the login secret, which production already requires.
 */
function keys() {
  const base = process.env.PROMOTION_EVENT_SECRET || process.env.JWT_SECRET || 'fitflex-dev-secret-change-me';
  const derive = secret => createHmac('sha256', secret).update('fitflex:promotion-event-token:v1').digest();
  const out = [derive(base)];
  if (process.env.PROMOTION_EVENT_SECRET_PREVIOUS) out.push(derive(process.env.PROMOTION_EVENT_SECRET_PREVIOUS));
  return out;
}
const mac = (key, body) => createHmac('sha256', key).update(`${VERSION}.${body}`).digest();

/** A token for one promoted card served to one session. */
export function signServedToken({ promotionId, entityType, entityId, sessionId, now = new Date(), ttlMs = TOKEN_TTL_MS }) {
  const t = now.getTime();
  const body = b64(JSON.stringify({ p: promotionId, t: entityType, i: entityId, s: sessionId, iat: t, exp: t + ttlMs }));
  return `${VERSION}.${body}.${b64(mac(keys()[0], body))}`;
}

/**
 * Check a token against what an event claims. `at` is when the event says it
 * happened and `now` is the server's clock. Returns { ok: true } or
 * { ok: false, reason } where reason is malformed | bad_signature | mismatch | expired | early.
 */
export function verifyServedToken(token, { promotionId, entityType, entityId, sessionId, at, now = new Date() }) {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return { ok: false, reason: 'malformed' };
  const [, body, sig] = parts;
  let given;
  try { given = Buffer.from(sig, 'base64url'); } catch { return { ok: false, reason: 'malformed' }; }
  // Constant-time compare against each key in use (the current one, and the previous during a rotation).
  const signed = keys().some((key) => { const want = mac(key, body); return want.length === given.length && timingSafeEqual(want, given); });
  if (!signed) return { ok: false, reason: 'bad_signature' };
  let p;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return { ok: false, reason: 'malformed' }; }
  if (p.p !== promotionId || p.t !== entityType || p.i !== entityId || p.s !== sessionId) return { ok: false, reason: 'mismatch' };
  if (!(now.getTime() <= p.exp)) return { ok: false, reason: 'expired' };
  if (at && at.getTime() < p.iat - SERVED_SLACK_MS) return { ok: false, reason: 'early' };
  return { ok: true, iat: p.iat, exp: p.exp };
}

/** 'required': an event without a token is refused. 'optional' (the default): it is kept but counted as unverified. */
export const tokenMode = () => (process.env.PROMOTION_EVENT_TOKENS === 'required' ? 'required' : 'optional');
