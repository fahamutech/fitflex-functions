// Dynamic member QR token: HMAC-signed, 60-second TTL (BL-012 anti-screenshot).
import { createHmac } from 'node:crypto';
import { QR_ROTATION_SECONDS } from '../shared/constants.mjs';

const SECRET = process.env.QR_HMAC_SECRET || 'fitflex-qr-dev-secret';

function bucket(now = Date.now()) {
  return Math.floor(now / 1000 / QR_ROTATION_SECONDS);
}

export function issue(userId, now = Date.now()) {
  const b = bucket(now);
  const payload = `${userId}.${b}`;
  const sig = createHmac('sha256', SECRET).update(payload).digest('base64url').slice(0, 16);
  return {
    token: `${payload}.${sig}`,
    expiresAt: new Date((b + 1) * QR_ROTATION_SECONDS * 1000).toISOString(),
    rotatesEverySeconds: QR_ROTATION_SECONDS
  };
}

/** Validates a member QR token. Allows current bucket and previous (clock skew tolerance). */
export function verify(token, now = Date.now()) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, bStr, sig] = parts;
  const b = Number(bStr);
  if (!Number.isFinite(b)) return null;
  const cur = bucket(now);
  if (b !== cur && b !== cur - 1) return null;
  const expected = createHmac('sha256', SECRET).update(`${userId}.${b}`).digest('base64url').slice(0, 16);
  if (expected !== sig) return null;
  return { userId };
}
