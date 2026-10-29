// Browser gym QR check-in (S2). Dormant: every route here answers 404 { error: 'not_found' } unless
// WEB_QR_CHECKIN is set AND QR_HMAC_SECRET is set (without it the QR would be signed with the public development secret).
// Flow: POST /public/web-checkin/intent (the page proves it saw the QR) → sign in with the PIN →
// POST /auth/web-checkin/session (short-lived token for these routes only) → POST /me/web-checkins/preview →
// POST /me/web-checkins (confirm). Signing in alone never records a visit.
// Never logged: q, intent tokens, session tokens, PINs, addresses, user-agent strings.
import '../src/bootstrap/init.mjs';
import { randomUUID } from 'node:crypto';
import { requireAuth, bearerFrom, verifyPurpose, signPurpose, sign } from '../src/auth/jwt.mjs';
import { gyms, users } from '../src/bootstrap/collections.mjs';
import { gymService, settingsService, trainerService, moderationGate, partnerGate, checkInService } from '../src/bootstrap/services.mjs';
import { createWebGymProfileService } from '../src/services/web-gym-profile-service.mjs';
import { createWebCheckinService, uaFamilyOf, ipHashOf } from '../src/services/web-checkin-service.mjs';
import { webQrCheckinOn } from '../src/shared/feature-flags.mjs';
import { createVendorLimiter, limitOrNull } from '../src/shared/vendor-rate-limit.mjs';
import { clientAddress } from '../src/shared/client-address.mjs';
import { db } from '../src/infra/knex-store.mjs';

const created = new Date().toISOString();

const webGymProfile = createWebGymProfileService({ gymService, settingsService, trainerService, moderationGate, partnerGate });
const webCheckin = createWebCheckinService({ gyms, checkInService, webGymProfile, db });

export const WEB_CHECKIN_PURPOSE = 'web_checkin';
export const WEB_CHECKIN_SESSION_TTL = '15m';
export const WEB_CHECKIN_INTENT_RATE_PER_MINUTE = 30;
export const WEB_CHECKIN_USER_RATE_PER_MINUTE = 20;
const intentLimiter = createVendorLimiter({ perMinute: WEB_CHECKIN_INTENT_RATE_PER_MINUTE });
const userLimiter = createVendorLimiter({ perMinute: WEB_CHECKIN_USER_RATE_PER_MINUTE });
export const resetWebCheckinLimits = () => { intentLimiter.reset(); userLimiter.reset(); webGymProfile.resetCache(); };

// Every answer is private and uncacheable, and varies by Origin in case CORS applies.
const send = (res, status, body) => {
  res.set?.('Cache-Control', 'no-store');
  res.set?.('Vary', 'Origin');
  return res.status(status).json(body);
};
const notFound = res => send(res, 404, { error: 'not_found' });

let warnedNoSecret = false;
const enabled = () => {
  if (!webQrCheckinOn()) return false;
  if (process.env.QR_HMAC_SECRET) return true;
  if (!warnedNoSecret) { warnedNoSecret = true; console.warn('[web-checkin] QR_HMAC_SECRET is not set: browser check-in stays off.'); }
  return false;
};

/**
 * Guard for /me/web-checkins*: 404 while dormant, then a member or trainer session. Besides a normal session it
 * accepts the short-lived web check-in token (and only here: requireAuth everywhere else rejects any token that
 * carries a purpose). The purpose token is converted for THIS request into the session it stands for (same
 * subject, role and issue time) and handed to the unchanged requireAuth, so suspension, ended sessions and role
 * checks are the standard ones and req.user has the usual shape.
 */
const sessionGuard = requireAuth('member', 'trainer');
function webCheckinGuard(req, res, next) {
  if (!enabled()) return notFound(res);
  const claims = verifyPurpose(bearerFrom(req), WEB_CHECKIN_PURPOSE);
  if (claims) {
    req.webCheckinSid = claims.sid ?? null;
    req.headers.authorization = `Bearer ${sign({ sub: claims.sub, userType: claims.userType, iat: claims.iat })}`;
  }
  return sessionGuard(req, res, next);
}

/** Dormant gate for the session-mint route: 404 first, then the normal member/trainer session check. */
function sessionMintGuard(req, res, next) {
  if (!enabled()) return notFound(res);
  return sessionGuard(req, res, next);
}

const clientMetaOf = req => ({
  channel: 'web',
  uaFamily: uaFamilyOf(req.headers?.['user-agent']),
  ipHash: ipHashOf(clientAddress(req)),
});

export const webCheckinIntent = {
  created, method: 'post', path: '/public/web-checkin/intent',
  description: 'Public, no auth (WEB_QR_CHECKIN on and QR_HMAC_SECRET set, else 404 not_found): { q } where q is the signed gym QR payload or the https URL carrying it as ?q= → { intentToken, expiresAt, gym { publicRef, name } }. The token lasts 10 minutes, is bound to that gym and records nothing. A bad, unknown, inactive, unlisted, held-back or KYC-hidden gym is the same 404 { error: "not_found" }. Over 30 requests a minute from one address → 429 rate_limited.',
  requestSample: { q: 'https://<host>/g/?q=fitflex:gym:<gymId>:<sig>' },
  responseSample: { intentToken: '<token>', expiresAt: '2027-01-29T08:10:00.000Z', gym: { publicRef: 'abc123', name: 'Example Gym' } },
  onRequest: async (req, res) => {
    if (!enabled()) return notFound(res);
    res.set?.('Cache-Control', 'no-store');
    res.set?.('Vary', 'Origin');
    const limited = limitOrNull(intentLimiter, clientAddress(req), res);
    if (limited) return limited;
    try {
      const intent = await webCheckin.createIntent({ q: req.body?.q });
      if (!intent) return notFound(res);
      send(res, 200, intent);
    } catch {
      send(res, 500, { error: 'server_error' });
    }
  },
};

export const webCheckinSession = {
  created, method: 'post', path: '/auth/web-checkin/session',
  description: 'Member or trainer with a normal session (from PIN sign-in): exchange it for a short-lived token that works only on the web check-in routes (/me/web-checkins/preview and /me/web-checkins) → { token, expiresAt } (15 minutes). 404 while WEB_QR_CHECKIN is off. Admin, operator and other roles are refused (403).',
  responseSample: { token: '<token>', expiresAt: '2027-01-29T08:15:00.000Z' },
  onGuard: sessionMintGuard,
  onRequest: async (req, res) => {
    const limited = limitOrNull(userLimiter, `session:${req.user.sub}`, res);
    if (limited) return limited;
    const sid = randomUUID();
    const token = signPurpose(WEB_CHECKIN_PURPOSE, { sub: req.user.sub, userType: req.user.userType, sid }, WEB_CHECKIN_SESSION_TTL);
    send(res, 200, { token, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() });
  },
};

export const webCheckinPreview = {
  created, method: 'post', path: '/me/web-checkins/preview',
  description: 'Member or trainer (normal session or the web check-in token): { intentToken } → 200 { eligible, reason?, visitsLeft?, alreadyCheckedIn, gym { name } }. Read-only: records nothing and uses no visit. reason is a check-in refusal code (subscription_inactive, wrong_gym, tier_not_covered, tier_not_configured, basic_daily_limit, visits_exhausted, gym_closed, gym_not_verified, member_not_found). A bad or expired token → 409 { ok: false, failure: invalid_intent | intent_expired }.',
  requestSample: { intentToken: '<token>' },
  onGuard: webCheckinGuard,
  onRequest: async (req, res) => {
    const limited = limitOrNull(userLimiter, `me:${req.user.sub}`, res);
    if (limited) return limited;
    try {
      const out = await webCheckin.preview({ userId: req.user.sub, intentToken: req.body?.intentToken });
      send(res, out.status, out.body);
    } catch {
      send(res, 500, { error: 'server_error' });
    }
  },
};

export const webCheckinConfirm = {
  created, method: 'post', path: '/me/web-checkins',
  description: 'Member or trainer (normal session or the web check-in token): { intentToken, confirm: true, idempotencyKey } → 200 { ok: true, idempotent, checkin { id, timestamp, gym { name } }, visitNumberInCycle? }. Same rules as the in-app scan; a repeat the same day (or a replayed intent) returns the existing visit with idempotent: true. Refusals are 409 { ok: false, failure } with the check-in codes plus invalid_intent, intent_expired, intent_used, gym_not_found. confirm other than true → 400 confirmation_required; idempotencyKey must be 8-100 characters of A-Z a-z 0-9 _ - → else 400 invalid_idempotency_key.',
  requestSample: { intentToken: '<token>', confirm: true, idempotencyKey: 'c0ffee00-1234' },
  onGuard: webCheckinGuard,
  onRequest: async (req, res) => {
    const limited = limitOrNull(userLimiter, `me:${req.user.sub}`, res);
    if (limited) return limited;
    try {
      const { intentToken, confirm, idempotencyKey } = req.body || {};
      const out = await webCheckin.confirm({
        userId: req.user.sub, intentToken, confirm, idempotencyKey,
        authSessionId: req.webCheckinSid ?? null, clientMeta: clientMetaOf(req),
      });
      send(res, out.status, out.body);
    } catch {
      send(res, 500, { error: 'server_error' });
    }
  },
};

export const webCheckinRetention = {
  created, rule: '50 2 * * *', // every day 02:50 UTC
  description: 'Browser check-in: clear the client metadata (browser family, daily-salted address hash) and session id of web check-ins older than 30 days. The visit itself is kept. Does nothing unless WEB_QR_CHECKIN is on. Idempotent.',
  onJob: async () => {
    if (!webQrCheckinOn()) return;
    const n = await webCheckin.purgeClientMeta();
    if (n) console.log(`[web-checkin] retention: cleared metadata on ${n} check-in(s)`);
  },
};
