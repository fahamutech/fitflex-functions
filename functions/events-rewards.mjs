// Marathon & running events · S6 — medal templates (organizer) and medals, achievements, ledger, wallet and redemption (member)
// (spec §7, §8.1, §8.3). Every route answers 404 feature_disabled unless EVENTS_MODULE, EVENTS_REGISTRATION, EVENTS_RESULTS and
// EVENTS_REWARDS are on. There are NO points and NO money here: the wallet lists rewards (units per reward), never a balance of points.
// `GET /me/rewards` (challenge rewards) is a different system and is not touched.
import { randomUUID } from 'node:crypto';
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { requireActiveOrganizer, requireOpenOrganizer, organizerOf } from '../src/auth/events-authz.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { requireEventsRewards } from '../src/shared/feature-flags.mjs';
import { eventsMedalService as medals, eventsRewardService as rewards } from '../src/bootstrap/services.mjs';
import { createVendorLimiter, limitOrNull } from '../src/shared/vendor-rate-limit.mjs';

const created = new Date().toISOString();
const ORGANIZER_TYPES = ['event_organizer', 'organizer_staff'];
const writeLimiter = createVendorLimiter({ perMinute: 60 });
const claimLimiter = createVendorLimiter({ perMinute: 20 });
export const resetEventsRewardsLimits = () => { writeLimiter.reset(); claimLimiter.reset(); };
const staffActor = req => ({ kind: 'staff', userId: req.user.sub, role: organizerOf(req).role, requestId: req.requestId });
const send = (req, res, result, okStatus = 200) => {
  res.set?.('X-Request-Id', req.requestId);
  if (result?.error) { const { error, status, ...extra } = result; if (extra.retryAfterSeconds) res.set?.('Retry-After', String(extra.retryAfterSeconds)); return res.status(status || 400).json({ error, ...extra }); }
  const { status, replayed, ...body } = result ?? {};
  if (replayed) res.set?.('Idempotent-Replayed', 'true');
  return res.status(Number.isInteger(status) ? status : okStatus).json(body);
};
const stamped = fn => async (req, res) => {
  req.requestId = `req_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  try { return await fn(req, res); } catch (err) { console.error(`[events-rewards] ${req.requestId} ${err?.message}`); return res.status(500).json({ error: 'internal_error', requestId: req.requestId }); }
};
const base = '/organizer/events/:id';
const writers = (method, ...roles) => routeGuard(method, [requireEventsRewards, requireAuth(...ORGANIZER_TYPES), requireActiveOrganizer(...roles)]);
const readers = (method, ...roles) => routeGuard(method, [requireEventsRewards, requireAuth(...ORGANIZER_TYPES), requireOpenOrganizer(...roles)]);
const member = method => routeGuard(method, [requireEventsRewards, requireAuth('member')]);
const ctxOf = req => ({ actor: staffActor(req), organizerId: organizerOf(req).organizer.id, eventId: req.params.id });

const TEMPLATE = 'MedalTemplate { id, eventId, categoryId | null, name { en, sw }, description { en, sw }, tier: finisher | gold | silver | bronze | time | other, rule { type: finish } | { type: placing, scope: category | overall, top: 1–10 } | { type: time_under, maxElapsedMs }, ruleSummary { en, sw }, sortOrder, status: active | inactive, art { source: builtin | custom, artId | null, revision | null, artKey, altText | null }, awardedCount, locked }';

export const organizerMedalTemplates = {
  created, method: 'get', path: `${base}/medal-templates`,
  description: `Organizer owner / admin / timing (EVENTS_REWARDS): the event's medal templates → { items [${TEMPLATE}], builtInArt [8 keys], artConfirmation? (with EVENTS_MEDAL_ART: { version, status, en, sw }) }.`,
  onGuard: readers('get', 'owner', 'admin', 'timing'),
  onRequest: stamped(async (req, res) => send(req, res, await medals.list(ctxOf(req)))),
};
export const organizerCreateMedalTemplate = {
  created, method: 'post', path: `${base}/medal-templates`,
  description: `Organizer owner / admin (EVENTS_REWARDS): add a medal. Idempotency-Key REQUIRED. Body { name { en, sw? } (≤60), description? { en, sw } (≤140), tier?, rule? (default finish), categoryId? (null = all), sortOrder?, status?, artKey? (one of the 8 built-in designs) }; unknown keys (an imageUrl included) are refused. → 201 { template: ${TEMPLATE} }. On a scope that already has official results the medal is awarded retroactively by the engine.`,
  onGuard: writers('post', 'owner', 'admin'),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(writeLimiter, `m:${req.user.sub}`, res)) return undefined;
    return send(req, res, await medals.create({ ...ctxOf(req), key: req.headers?.['idempotency-key'], body: req.body || {} }), 201);
  }),
};
export const organizerPatchMedalTemplate = {
  created, method: 'patch', path: `${base}/medal-templates/:templateId`,
  description: 'Organizer owner / admin (EVENTS_REWARDS): change a medal. Idempotency-Key REQUIRED. rule and categoryId are LOCKED once the scope has an official release (409 template_locked); name, description, tier, sortOrder, status (inactive stops new awards, never revokes) and artKey stay editable → { template }.',
  onGuard: writers('patch', 'owner', 'admin'),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(writeLimiter, `m:${req.user.sub}`, res)) return undefined;
    return send(req, res, await medals.patch({ ...ctxOf(req), templateId: req.params.templateId, key: req.headers?.['idempotency-key'], body: req.body || {} }));
  }),
};
export const organizerPreviewMedalTemplate = {
  created, method: 'get', path: `${base}/medal-templates/:templateId/preview`,
  description: 'Organizer owner / admin / timing (EVENTS_REWARDS): "About N people would get this" → { wouldReceive, released }.',
  onGuard: readers('get', 'owner', 'admin', 'timing'),
  onRequest: stamped(async (req, res) => send(req, res, await medals.preview({ ...ctxOf(req), templateId: req.params.templateId }))),
};

export const myAchievements = {
  created, method: 'get', path: '/me/achievements',
  description: 'Member (EVENTS_REWARDS): my medals and achievements → { medals [MedalAward { id, eventId, eventTitle, categoryName, templateId, tier, name, description, art { source, artId, revision, artKey, altText }, status, awardedAt, revokedAt, reasonCode, resultSummary { rank, elapsedMs } }] (awarded only), achievements [{ id | null, key, title { en, sw }, status: awarded | locked, awardedAt, progress { current, target } }], removed [{ kind: medal | achievement, id, title, reasonCode, revokedAt }] }.',
  onGuard: member('get'),
  onRequest: stamped(async (req, res) => send(req, res, await medals.achievements({ userId: req.user.sub }))),
};
export const myRewardLedger = {
  created, method: 'get', path: '/me/reward-ledger',
  description: 'Member (EVENTS_REWARDS): my own entitlement history, newest first. ?cursor&limit → { items [{ id, entryType: earn | redeem | expire | reverse, rewardDefinitionId, titleOf { en, sw }, units (+1 / -1), sourceType, sourceLabelCode, occurredAt, reverses | null }], nextCursor }. There is no balance and no field called points.',
  onGuard: member('get'),
  onRequest: stamped(async (req, res) => send(req, res, await rewards.myLedger({ userId: req.user.sub, query: req.query || {} }))),
};
export const myEventRewards = {
  created, method: 'get', path: '/me/event-rewards',
  description: 'Member (EVENTS_REWARDS): the wallet → { available [{ definitionId, title, terms, units, nextExpiry, redeemMode: certificate | perk, canClaim }], redemptions [{ id, definitionId, title, status: reserved | redeemed | cancelled | expired, redeemMode, code (FFR-XXXXXXXX, only while a perk is reserved), expiresAt, redeemedAt }], expired [{ definitionId, title, expiredAt }] }. Named so it cannot be confused with GET /me/rewards.',
  onGuard: member('get'),
  onRequest: stamped(async (req, res) => { res.set?.('Cache-Control', 'private, no-store'); return send(req, res, await rewards.wallet({ userId: req.user.sub })); }),
};
export const claimEventReward = {
  created, method: 'post', path: '/me/reward-redemptions',
  description: 'Member (EVENTS_REWARDS): claim one unit. Idempotency-Key REQUIRED. Body { rewardDefinitionId } → 201 { redemption { id, definitionId, status, code (perk, while reserved), expiresAt, redeemedAt, certificate? { title, terms } } }. A certificate is redeemed at once; a perk is reserved for 14 days with a code FitFlex staff verify. Two parallel claims of one unit: exactly one wins (409 not_enough_units). 409 reward_unavailable | idempotency_key_reused; 503 rewards_unavailable (no code key).',
  onGuard: member('post'),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(claimLimiter, `c:${req.user.sub}`, res)) return undefined;
    res.set?.('Cache-Control', 'private, no-store');
    return send(req, res, await rewards.claim({ userId: req.user.sub, key: req.headers?.['idempotency-key'], body: req.body || {} }), 201);
  }),
};
export const getEventRewardRedemption = {
  created, method: 'get', path: '/me/reward-redemptions/:id',
  description: 'Member (EVENTS_REWARDS): one of my redemptions; the code is shown again while it is reserved → { redemption }. 404 not_found.',
  onGuard: member('get'),
  onRequest: stamped(async (req, res) => { res.set?.('Cache-Control', 'private, no-store'); return send(req, res, await rewards.getRedemption({ userId: req.user.sub, id: req.params.id })); }),
};
