// Browser check-in intent token (S2): proof that the page saw a genuine, signed gym QR a few minutes ago.
//   token = base64url(JSON {v:1, gymRef, jti, iat, exp}) + '.' + base64url(HMAC-SHA256(key, payload part))
// - key is derived from QR_HMAC_SECRET with its own label, so it can never be confused with a QR signature;
// - gymRef is the opaque public reference of the gym (never the internal id); the server maps it back to a gym
//   and re-applies every gate before it counts;
// - the token is stateless: single use is enforced by the database (Checkin.intentId is unique), and
//   it grants nothing by itself — a visit also needs a signed-in member who confirms.
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

export const INTENT_TTL_SECONDS = 600;
const LABEL = 'web-checkin-intent-v1';

const keyOf = () => {
  const secret = process.env.QR_HMAC_SECRET;
  if (!secret) throw new Error('QR_HMAC_SECRET is not set');
  return createHmac('sha256', secret).update(LABEL).digest();
};
const mac = (key, part) => createHmac('sha256', key).update(part).digest();
const b64 = buf => Buffer.from(buf).toString('base64url');

/** → { token, expiresAt (ISO), jti }. Throws when QR_HMAC_SECRET is unset (callers fail closed first). */
export function signIntent({ gymRef, now = Date.now(), jti = randomUUID() }) {
  const iat = Math.floor(now / 1000);
  const exp = iat + INTENT_TTL_SECONDS;
  const part = b64(JSON.stringify({ v: 1, gymRef, jti, iat, exp }));
  return { token: `${part}.${b64(mac(keyOf(), part))}`, expiresAt: new Date(exp * 1000).toISOString(), jti };
}

/**
 * → { ok: true, claims: { gymRef, jti, iat, exp } } | { ok: false, failure: 'invalid_intent' | 'intent_expired' }
 * `gymRef`, when given, must match the token's (a token minted for one gym cannot be used for another).
 * Never throws on bad input.
 */
export function verifyIntent(token, { now = Date.now(), gymRef = null } = {}) {
  const invalid = { ok: false, failure: 'invalid_intent' };
  if (typeof token !== 'string' || token.length > 1024) return invalid;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return invalid;
  let key;
  try { key = keyOf(); } catch { return invalid; }
  const given = Buffer.from(parts[1], 'base64url');
  const expected = mac(key, parts[0]);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return invalid;
  let c;
  try { c = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { return invalid; }
  if (!c || c.v !== 1 || typeof c.gymRef !== 'string' || typeof c.jti !== 'string' || !Number.isInteger(c.iat) || !Number.isInteger(c.exp)) return invalid;
  if (gymRef !== null && c.gymRef !== gymRef) return invalid;
  if (Math.floor(now / 1000) >= c.exp) return { ok: false, failure: 'intent_expired' };
  return { ok: true, claims: { gymRef: c.gymRef, jti: c.jti, iat: c.iat, exp: c.exp } };
}
