// Marathon & running events · S4 — the ticket token (spec §3.8.3, KIT-001). Pure helpers: the secret is passed in.
//
// The token is DERIVED, never stored in plaintext:
//   mac   = base64url(HMAC_SHA256(secret, "fitflex.event.ticket.v1|" + ticketId + "|" + tokenVersion + "|" + registrationId + "|" + eventId)), first 22 chars
//   token = "ev1." + keyId + "." + ticketId + "." + tokenVersion + "." + mac          (no personal data in it)
//   QR payload = "FFEV1:" + token                                                      (the prefix tells the S5 scanner it is not a gym QR)
// The row keeps sha256hex(token) (EventTicket.tokenHash, unique) as the lookup key and the integrity check.
// Static (not time-bucketed): kit collection at a venue must work from a cached code; replay is stopped by the S5
// "one collected kit per registration" rule, not by expiry. Rotation bumps tokenVersion; the old token then
// matches no hash. Secret rotation changes keyId; older keys stay in EVENT_TICKET_SECRET_PREVIOUS.
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const TICKET_CONTEXT = 'fitflex.event.ticket.v1';
export const QR_PREFIX = 'FFEV1:';
export const MIN_SECRET_LENGTH = 32;
const MAC_LENGTH = 22;
const TOKEN_RE = /^ev1\.([A-Za-z0-9_-]{1,16})\.(etk_[0-9a-f]{16})\.([1-9][0-9]{0,5})\.([A-Za-z0-9_-]{22})$/;

export const sha256hex = value => createHash('sha256').update(String(value)).digest('hex');
export const newTicketId = () => `etk_${randomBytes(8).toString('hex')}`;

/**
 * The key ring from the environment, or null when there is no usable secret (fail closed):
 * { keyId, secret, previous: { [keyId]: secret } }. EVENT_TICKET_SECRET must be at least 32 characters.
 */
export function ticketKeyRing(env = process.env) {
  const secret = String(env.EVENT_TICKET_SECRET ?? '').trim();
  if (secret.length < MIN_SECRET_LENGTH) return null;
  const keyId = String(env.EVENT_TICKET_KEY_ID ?? '').trim() || 'k1';
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(keyId)) return null;
  let previous = {};
  const raw = String(env.EVENT_TICKET_SECRET_PREVIOUS ?? '').trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string' && v.length >= MIN_SECRET_LENGTH && /^[A-Za-z0-9_-]{1,16}$/.test(k) && k !== keyId) previous[k] = v;
      }
    } catch { previous = {}; }
  }
  return { keyId, secret, previous };
}

const macOf = (secret, { ticketId, tokenVersion, registrationId, eventId }) => createHmac('sha256', secret)
  .update(`${TICKET_CONTEXT}|${ticketId}|${tokenVersion}|${registrationId}|${eventId}`).digest('base64url').slice(0, MAC_LENGTH);

const secretFor = (ring, keyId) => (keyId === ring.keyId ? ring.secret : ring.previous[keyId] ?? null);

/** The token for a ticket under a key (default: the current one). */
export function deriveToken(ring, { ticketId, tokenVersion, registrationId, eventId, keyId = null }) {
  const id = keyId ?? ring.keyId;
  const secret = secretFor(ring, id);
  if (!secret) return null;
  return `ev1.${id}.${ticketId}.${tokenVersion}.${macOf(secret, { ticketId, tokenVersion, registrationId, eventId })}`;
}

export const qrPayloadOf = token => `${QR_PREFIX}${token}`;

/** The parts of a token (or a QR payload) without checking the MAC; null when it is not a ticket token. */
export function parseToken(raw) {
  const text = String(raw ?? '').trim();
  const m = TOKEN_RE.exec(text.startsWith(QR_PREFIX) ? text.slice(QR_PREFIX.length) : text);
  return m ? { keyId: m[1], ticketId: m[2], tokenVersion: Number(m[3]) } : null;
}

/** Does this token carry the right MAC for this ticket and registration (constant time)? */
export function verifyToken(ring, raw, { registrationId, eventId }) {
  const parts = parseToken(raw);
  if (!parts) return false;
  const expected = deriveToken(ring, { ...parts, registrationId, eventId });
  if (!expected) return false;
  const a = Buffer.from(String(raw).trim().replace(QR_PREFIX, ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A short code people can read out to support. A support aid, not a key. */
export function displayCodeOf(ticketId, registrationId) {
  const h = sha256hex(`${ticketId}|${registrationId}`).toUpperCase().replace(/[01OI]/g, 'X');
  return `${h.slice(0, 4)}-${h.slice(4, 8)}`;
}
