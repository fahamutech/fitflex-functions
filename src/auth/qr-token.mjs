// Dynamic member QR token: HMAC-signed, 60-second TTL (BL-012 anti-screenshot).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { QR_ROTATION_SECONDS } from '../shared/constants.mjs';

const SECRET = process.env.QR_HMAC_SECRET || 'fitflex-qr-dev-secret';
if (!process.env.QR_HMAC_SECRET && process.env.NODE_ENV === 'production') {
  // Not fatal (that would take every endpoint down), but with the public dev
  // secret anyone can mint valid member and gym QR codes.
  console.error('[qr] QR_HMAC_SECRET is not set — QR codes are signed with the development secret. Set it.');
}

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

// ── Static gym QR (member-scans-gym check-in mode) ─────────────────────────
// Printed at the gym entrance, so it cannot rotate. The signature stops
// anyone minting a QR for a gym from its id; the member's own session proves
// who is checking in.
const GYM_PREFIX = 'fitflex:gym:';

function gymSig(gymId) {
  return createHmac('sha256', SECRET).update(`gym.${gymId}`).digest('base64url').slice(0, 22);
}

export function issueGymQr(gymId) {
  return `${GYM_PREFIX}${gymId}:${gymSig(gymId)}`;
}

/** @returns {{ gymId: string } | null} */
export function verifyGymQr(payload) {
  if (typeof payload !== 'string' || !payload.startsWith(GYM_PREFIX)) return null;
  const rest = payload.slice(GYM_PREFIX.length);
  const i = rest.lastIndexOf(':');
  if (i <= 0) return null;
  const gymId = rest.slice(0, i);
  const sig = rest.slice(i + 1);
  const expected = gymSig(gymId);
  if (sig.length !== expected.length) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return timingSafeEqual(a, b) ? { gymId } : null;
}
