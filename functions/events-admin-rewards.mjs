// Marathon & running events · S6 — the FitFlex reward desk (spec §8.2, §9.4). Portal ACL scope `events` (no new scope). Every route answers
// 404 feature_disabled unless EVENTS_RESULTS and EVENTS_REWARDS are on. Rewards are digital and FitFlex-funded: a definition with a value
// in shillings is refused (422 value_not_allowed_yet) and only FitFlex can issue (422 issuer_not_allowed). Every action is audited.
import { randomUUID } from 'node:crypto';
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { requireEventsRewards } from '../src/shared/feature-flags.mjs';
import { eventsRewardService as svc } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();
const admin = method => routeGuard(method, [requireEventsRewards, requireAuth('admin'), requireAcl('events')]);
const send = (req, res, result, okStatus = 200) => {
  res.set?.('X-Request-Id', req.requestId);
  if (result?.error) { const { error, status, ...extra } = result; if (extra.retryAfterSeconds) res.set?.('Retry-After', String(extra.retryAfterSeconds)); return res.status(status || 400).json({ error, ...extra }); }
  const { status, ...body } = result ?? {};
  return res.status(Number.isInteger(status) ? status : okStatus).json(body);
};
const stamped = fn => async (req, res) => {
  req.requestId = `req_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  try { return await fn(req, res); } catch (err) { console.error(`[events-admin-rewards] ${req.requestId} ${err?.message}`); return res.status(500).json({ error: 'internal_error', requestId: req.requestId }); }
};
const actor = req => ({ userId: req.user.sub });

const DEF = 'RewardDefinition { id, title { en, sw }, triggerType: event_finish | medal | achievement, triggerEventId, triggerRef, redeemMode: certificate | perk, terms { en, sw }, startsAt, endsAt, capTotal, capPerUser, eligibility { categoryIds? }, expiryDays, reversalPolicy: revoke_unredeemed | revoke_all, perUserCooldownDays, fundingNote, valueTzs (always null), issuerType: fitflex, status: draft | active | paused | ended, capUsed? }';

export const adminListRewardDefinitions = {
  created, method: 'get', path: '/admin/reward-definitions',
  description: `Admin (scope events; EVENTS_REWARDS): all reward definitions → { items [${DEF}] }.`,
  onGuard: admin('get'), onRequest: stamped(async (req, res) => send(req, res, await svc.listDefinitions())),
};
export const adminCreateRewardDefinition = {
  created, method: 'post', path: '/admin/reward-definitions',
  description: `Admin (scope events; EVENTS_REWARDS): create a reward. Body { title { en, sw }, terms { en, sw }, fundingNote (who pays: "FitFlex"), triggerType, triggerEventId? | triggerRef (medal template id | achievement key), redeemMode?, startsAt?, endsAt?, capTotal?, capPerUser? (default 1), eligibility?, expiryDays?, reversalPolicy?, perUserCooldownDays?, status?: draft | active }. English AND Swahili are required. 422 value_not_allowed_yet (any valueTzs) | issuer_not_allowed | validation_failed → 201 { definition: ${DEF} }.`,
  onGuard: admin('post'), onRequest: stamped(async (req, res) => send(req, res, await svc.createDefinition({ actor: actor(req), body: req.body || {} }), 201)),
};
export const adminUpdateRewardDefinition = {
  created, method: 'patch', path: '/admin/reward-definitions/:id',
  description: 'Admin (scope events; EVENTS_REWARDS): change text, caps, window, expiry, policy. The trigger and redeem mode are locked once the ledger has an entry for it (409 definition_locked) → { definition }.',
  onGuard: admin('patch'), onRequest: stamped(async (req, res) => send(req, res, await svc.updateDefinition({ actor: actor(req), id: req.params.id, body: req.body || {} }))),
};
export const adminActivateRewardDefinition = {
  created, method: 'post', path: '/admin/reward-definitions/:id/activate',
  description: 'Admin (scope events; EVENTS_REWARDS): draft or paused → active; the engine then earns it retroactively for the event it names → { definition }.',
  onGuard: admin('post'), onRequest: stamped(async (req, res) => send(req, res, await svc.activate({ actor: actor(req), id: req.params.id }))),
};
export const adminPauseRewardDefinition = {
  created, method: 'post', path: '/admin/reward-definitions/:id/pause',
  description: 'Admin (scope events; EVENTS_REWARDS): active → paused (no new earns, no new claims) → { definition }.',
  onGuard: admin('post'), onRequest: stamped(async (req, res) => send(req, res, await svc.pause({ actor: actor(req), id: req.params.id }))),
};
export const adminEndRewardDefinition = {
  created, method: 'post', path: '/admin/reward-definitions/:id/end',
  description: 'Admin (scope events; EVENTS_REWARDS): end a reward for good → { definition }.',
  onGuard: admin('post'), onRequest: stamped(async (req, res) => send(req, res, await svc.end({ actor: actor(req), id: req.params.id }))),
};
export const adminRewardLedger = {
  created, method: 'get', path: '/admin/reward-ledger',
  description: 'Admin (scope events; EVENTS_REWARDS): ledger rows, read only. ?userId&definitionId&entryType&cursor&limit → { items [{ id, userId | null (anonymised), member (first name + last initial), anonymised, entryType, definitionId, units, sourceType, reverses, occurredAt }], nextCursor }. No contact data.',
  onGuard: admin('get'), onRequest: stamped(async (req, res) => send(req, res, await svc.adminLedger({ query: req.query || {} }))),
};
export const adminRewardSummary = {
  created, method: 'get', path: '/admin/reward-summary',
  description: 'Admin (scope events; EVENTS_REWARDS): per definition { definitionId, earned, redeemed, expired, reversed, capUsed, needsReview } and mostEarnedThisWeek [{ userId, count }] for farming review.',
  onGuard: admin('get'), onRequest: stamped(async (req, res) => send(req, res, await svc.adminSummary())),
};
export const adminLookupRewardCode = {
  created, method: 'post', path: '/admin/reward-redemptions/lookup',
  description: 'Admin (scope events; EVENTS_REWARDS): look up a perk code. Body { code } → { redemption { id, definitionId, title, member (masked), status, expiresAt, redeemedAt, needsReview } }. 404 code_not_found; 429 rate_limited (30 a minute; 10 failures an hour, audited).',
  onGuard: admin('post'), onRequest: stamped(async (req, res) => send(req, res, await svc.lookup({ admin: req.user.sub, body: req.body || {} }))),
};
export const adminRedeemReward = {
  created, method: 'post', path: '/admin/reward-redemptions/:id/redeem',
  description: 'Admin (scope events; EVENTS_REWARDS): mark a reserved perk as used. Body { note? (≤200) } → { redemption }. 409 invalid_transition | redemption_expired.',
  onGuard: admin('post'), onRequest: stamped(async (req, res) => send(req, res, await svc.adminRedeem({ admin: req.user.sub, id: req.params.id, body: req.body || {} }))),
};
export const adminCancelReward = {
  created, method: 'post', path: '/admin/reward-redemptions/:id/cancel',
  description: 'Admin (scope events; EVENTS_REWARDS): cancel a reserved perk; the unit returns to the member → { redemption }.',
  onGuard: admin('post'), onRequest: stamped(async (req, res) => send(req, res, await svc.adminCancel({ admin: req.user.sub, id: req.params.id, body: req.body || {} }))),
};
export const adminAwardTasks = {
  created, method: 'get', path: '/admin/event-award-tasks',
  description: 'Admin (scope events; EVENTS_REWARDS): award tasks by state (default failed) → { items [{ id, eventId, registrationId, reason, state, attempts, lastError, createdAt }] }.',
  onGuard: admin('get'), onRequest: stamped(async (req, res) => send(req, res, await svc.listTasks({ query: req.query || {} }))),
};
export const adminRetryAwardTask = {
  created, method: 'post', path: '/admin/event-award-tasks/:id/retry',
  description: 'Admin (scope events; EVENTS_REWARDS): put a failed award task back in the queue → { task { id, state: pending } }.',
  onGuard: admin('post'), onRequest: stamped(async (req, res) => send(req, res, await svc.retryTask({ admin: req.user.sub, id: req.params.id }))),
};
