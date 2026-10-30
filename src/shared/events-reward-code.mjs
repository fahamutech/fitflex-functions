// Marathon & running events · S6 — perk codes (spec §7.6). A code is DERIVED, never stored: FFR- + 8 Crockford base32 characters of
// HMAC-SHA256(deriveKey("reward-code-v1", EVENT_TICKET_SECRET), redemptionId). The app can show it again without keeping it; only
// sha256(code) is stored (RewardRedemption.codeHash). A code is not a payment credential and never unlocks money.
import { createHmac, createHash } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_RE = /^FFR-[0-9A-HJKMNP-TV-Z]{8}$/;

const base32 = (buf, len) => {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5 && out.length < len) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
    if (out.length >= len) break;
  }
  return out;
};

/** Domain-separated key from the ticket secret (no new secret to manage). */
export const deriveKey = secret => createHmac('sha256', String(secret)).update('reward-code-v1').digest();

/**
 * → "FFR-XXXXXXXX" for a redemption id; null without a key ring (fail closed). `keyId` is the key the redemption was CLAIMED under (stored on
 * the row): after EVENT_TICKET_SECRET rotates the code is still derived from that key while it sits in EVENT_TICKET_SECRET_PREVIOUS, so a
 * reserved perk is never orphaned. null when that key is gone.
 */
export function codeFor(ring, redemptionId, keyId = null) {
  if (!ring?.secret) return null;
  const secret = !keyId || keyId === ring.keyId ? ring.secret : ring.previous?.[keyId];
  if (!secret) return null;
  return `FFR-${base32(createHmac('sha256', deriveKey(secret)).update(String(redemptionId)).digest(), 8)}`;
}

/** What a person typed → the canonical code, or null. Case, spaces and dashes are forgiven; O → 0, I and L → 1. */
export function normaliseCode(raw) {
  const v = String(raw ?? '').toUpperCase().replace(/[\s-]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  const body = v.startsWith('FFR') ? v.slice(3) : v;
  const code = `FFR-${body}`;
  return CODE_RE.test(code) ? code : null;
}

export const hashCode = code => createHash('sha256').update(code).digest('hex');
