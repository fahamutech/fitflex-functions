// Marathon & running events · S6 — run links for the member app (spec §5, §8.3). Every route answers 404 feature_disabled unless
// EVENTS_MODULE, EVENTS_REGISTRATION, EVENTS_RESULTS and EVENTS_RUNS are on. The GPS route is never returned to an organizer, admin or API client.
import { randomUUID } from 'node:crypto';
import '../src/bootstrap/init.mjs';
import { errorText } from '../src/shared/events-results-copy.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { requireEventsRuns } from '../src/shared/feature-flags.mjs';
import { eventsRunLinkService as svc } from '../src/bootstrap/services.mjs';
import { createVendorLimiter, limitOrNull } from '../src/shared/vendor-rate-limit.mjs';

const created = new Date().toISOString();
const writeLimiter = createVendorLimiter({ perMinute: 20 });
export const resetEventsRunsLimits = () => writeLimiter.reset();
const member = method => routeGuard(method, [requireEventsRuns, requireAuth('member')]);
const send = (req, res, result, okStatus = 200) => {
  res.set?.('X-Request-Id', req.requestId);
  if (result?.error) { const { error, status, ...extra } = result; if (extra.retryAfterSeconds) res.set?.('Retry-After', String(extra.retryAfterSeconds)); return res.status(status || 400).json({ error, ...errorText(error), ...extra }); }
  const { status, replayed, ...body } = result ?? {};
  if (replayed) res.set?.('Idempotent-Replayed', 'true');
  return res.status(Number.isInteger(status) ? status : okStatus).json(body);
};
const stamped = fn => async (req, res) => {
  req.requestId = `req_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  try { return await fn(req, res); } catch (err) { console.error(`[events-runs] ${req.requestId} ${err?.message}`); return res.status(500).json({ error: 'internal_error', requestId: req.requestId }); }
};

export const createEventRun = {
  created, method: 'post', path: '/me/event-registrations/:id/runs',
  description: 'Member (the participant; EVENTS_RUNS): record a run for an event. Body { clientRef (8–100, made at Start and kept with the unsent run), segments, notes?, shareWith? } (the body of POST /me/activities/runs plus clientRef) → 201 { link { id, linkType: evidence | event_run, matchStatus, distanceMeters, movingSeconds, elapsedMs, flags [], activityId, startedAt, canUnlink }, activity, result: null | { id, revision, verificationStatus, finishStatus, elapsedMs } }. The same clientRef again returns the first answer (200 + Idempotent-Replayed: true); a different body is 409 idempotency_key_reused. Refused (nothing recorded): 422 run_outside_window { window } | distance_too_short { measuredMeters, requiredMeters }; 409 run_already_linked | activity_already_linked | evidence_limit | event_cancelled | linking_closed | ticket_revoked | registration_not_confirmed; 429 rate_limited (10 a day). Virtual events: a pending result for the organizer; in-person events: evidence only, never an official time.',
  onGuard: member('post'),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(writeLimiter, `r:${req.user.sub}`, res)) return undefined;
    return send(req, res, await svc.createAndLink({ userId: req.user.sub, registrationId: req.params.id, body: req.body || {} }), 201);
  }),
};

export const linkEventRun = {
  created, method: 'post', path: '/me/event-registrations/:id/run-links',
  description: 'Member (the participant; EVENTS_RUNS): add a run already recorded in the app (source fitflex, type running, with a route, yours). Idempotency-Key REQUIRED. Body { activityId } → 201 { link, result }. 422 activity_not_recorded_in_app | run_outside_window | distance_too_short; 404 activity_not_found; 409 as the create route; the run\'s share setting is not changed.',
  onGuard: member('post'),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(writeLimiter, `r:${req.user.sub}`, res)) return undefined;
    return send(req, res, await svc.linkExisting({ userId: req.user.sub, registrationId: req.params.id, key: req.headers?.['idempotency-key'], body: req.body || {} }), 201);
  }),
};

export const listEventRunLinks = {
  created, method: 'get', path: '/me/event-registrations/:id/run-links',
  description: 'Member (the participant; EVENTS_RUNS): my live run links for one place → { items [link] }.',
  onGuard: member('get'),
  onRequest: stamped(async (req, res) => send(req, res, await svc.list({ userId: req.user.sub, registrationId: req.params.id }))),
};

export const unlinkEventRun = {
  created, method: 'delete', path: '/me/event-registrations/:id/run-links/:linkId',
  description: 'Member (the participant; EVENTS_RUNS): remove a run from the event. Evidence any time; a virtual-event run until the organizer decides (409 link_locked after). The link row stays (audit); a pending result becomes rejected (replaced_by_participant) → { unlinked { id } }.',
  onGuard: member('delete'),
  onRequest: stamped(async (req, res) => send(req, res, await svc.unlink({ userId: req.user.sub, registrationId: req.params.id, linkId: req.params.linkId }))),
};
