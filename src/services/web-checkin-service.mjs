// Browser gym QR check-in (S2). A member opens the printed gym QR in the phone browser, signs in, previews and
// confirms. Every rule is the in-app scan's: this file only mints and checks the intent, applies the S1 gym
// gates, and calls the check-in service (probe for the preview, perform for the visit). Authentication alone
// never records anything: a visit needs a valid intent token AND confirm === true.
//
// Privacy: no raw IP, user-agent string, PIN, QR payload or token is stored or logged. clientMeta is
// { channel: 'web', uaFamily, ipHash } where ipHash = sha256(address + a salt that changes every UTC day), and it
// is cleared after RETENTION_DAYS (purgeClientMeta), together with the intent id. authSessionId stays null until
// the portal session carries a real session id (S5); the column is kept for that.
// idempotencyKey is validated but NOT stored: replay safety comes from the intent (Checkin.intentId, unique) and the
// one-visit-per-member-per-gym-per-day index.
import { createHash, createHmac } from 'node:crypto';
import { signIntent, verifyIntent } from '../shared/web-checkin-intent.mjs';
import { extractQrPayload, publicRefFor } from './web-gym-profile-service.mjs';
import { CHECKIN_SOURCE } from '../shared/checkin-status.mjs';

export const RETENTION_DAYS = 30;
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;

/** Browser family only; never the user-agent string. */
export function uaFamilyOf(userAgent) {
  const ua = typeof userAgent === 'string' ? userAgent : '';
  if (/SamsungBrowser/i.test(ua)) return 'samsung';
  if (/Edg(e|A|iOS)?\//i.test(ua)) return 'edge';
  if (/OPR\/|Opera/i.test(ua)) return 'opera';
  if (/Firefox|FxiOS/i.test(ua)) return 'firefox';
  if (/Chrome|CriOS/i.test(ua)) return 'chrome';
  if (/Safari/i.test(ua)) return 'safari';
  return 'other';
}

/** sha256(address + a salt derived from QR_HMAC_SECRET and the UTC date): comparable within a day, not across days. */
export function ipHashOf(address, nowMs = Date.now()) {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const salt = createHmac('sha256', process.env.QR_HMAC_SECRET || '').update(`web-checkin-ip-salt:${day}`).digest('hex');
  return createHash('sha256').update(`${String(address || 'unknown')}|${salt}`).digest('hex').slice(0, 32);
}

export function createWebCheckinService({ gyms, checkInService, webGymProfile, db = null, now = () => Date.now() }) {
  /** → { intentToken, expiresAt, gym: { publicRef, name } } or null (one answer for every kind of miss). */
  async function createIntent({ q }) {
    const payload = extractQrPayload(q);
    const gym = payload ? await webGymProfile.lookup(payload) : (await webGymProfile.lookupById(null), null);
    if (!gym) return null;
    const publicRef = publicRefFor(gym.id);
    const { token, expiresAt } = signIntent({ gymRef: publicRef, now: now() });
    return { intentToken: token, expiresAt, gym: { publicRef, name: gym.name } };
  }

  /** The token's gym, through the same gates as S1 → { gym, claims } | { failure }. */
  async function gymFromIntent(intentToken) {
    const v = verifyIntent(intentToken, { now: now() });
    if (!v.ok) return { failure: v.failure };
    const candidate = gyms.filter(g => g.status === 'active' && publicRefFor(g.id) === v.claims.gymRef)[0];
    const gym = candidate ? await webGymProfile.lookupById(candidate.id) : null;
    return gym ? { gym, claims: v.claims } : { failure: 'gym_not_found' };
  }

  const refusal = failure => ({ status: 409, body: { ok: false, failure } });

  /** Read-only: creates nothing, consumes nothing. */
  async function preview({ userId, intentToken }) {
    const g = await gymFromIntent(intentToken);
    if (g.failure) return refusal(g.failure);
    const p = await checkInService.probe({ memberId: userId, gymId: g.gym.id, now: new Date(now()) });
    const gym = { name: g.gym.name };
    if (!p.ok) return { status: 200, body: { eligible: false, reason: p.failure, alreadyCheckedIn: false, gym } };
    return {
      status: 200,
      body: {
        eligible: true, alreadyCheckedIn: p.alreadyCheckedIn === true, gym,
        ...(Number.isFinite(p.visitsLeft) ? { visitsLeft: p.visitsLeft } : {}),
      },
    };
  }

  /** Records the visit (or returns the one already recorded: idempotent). */
  async function confirm({ userId, intentToken, confirm: confirmed, idempotencyKey, authSessionId = null, clientMeta = null }) {
    if (confirmed !== true) return { status: 400, body: { ok: false, error: 'confirmation_required' } };
    if (typeof idempotencyKey !== 'string' || !KEY_PATTERN.test(idempotencyKey)) return { status: 400, body: { ok: false, error: 'invalid_idempotency_key' } };
    const g = await gymFromIntent(intentToken);
    if (g.failure) return refusal(g.failure);
    const result = await checkInService.perform({
      memberId: userId, gymId: g.gym.id, method: 'web_scanned', now: new Date(now()),
      // One intent, one member: the same link used by someone else is that person's own visit.
      meta: { intentId: `${g.claims.jti}:${userId}`, authSessionId, clientMeta },
    });
    if (!result.ok) return refusal(result.failure);
    const c = result.checkin;
    return {
      status: 200,
      body: {
        ok: true,
        idempotent: result.idempotent === true,
        checkin: { id: c.id, timestamp: c.timestamp, gym: { name: g.gym.name } },
        ...(Number.isFinite(result.visitNumberInCycle) ? { visitNumberInCycle: result.visitNumberInCycle } : {}),
      },
    };
  }

  /** Retention: clear the client metadata, session id and intent id of web check-ins older than RETENTION_DAYS. → rows changed. */
  async function purgeClientMeta({ days = RETENTION_DAYS } = {}) {
    if (!db) return 0;
    const cutoff = new Date(now() - days * 86_400_000);
    return db('Checkin').where({ source: CHECKIN_SOURCE.WEB_GYM_QR_BY_MEMBER }).where('timestamp', '<', cutoff)
      .where(b => b.whereNotNull('clientMeta').orWhereNotNull('authSessionId').orWhereNotNull('intentId'))
      .update({ clientMeta: null, authSessionId: null, intentId: null });
  }

  return { createIntent, preview, confirm, purgeClientMeta, gymFromIntent };
}
