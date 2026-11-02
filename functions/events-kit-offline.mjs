// Marathon & running events · S7 — the offline kit desk for a signed-in organizer user (docs/design/events-s7-hardening-and-pilot.md §3.13).
// RULE 6 AREA (owner reviews, D35): a second writer of event kit handovers and bib numbers. Every route answers 404 feature_disabled unless
// EVENTS_MODULE, EVENTS_REGISTRATION, EVENTS_KIT_OPS and EVENTS_KIT_OFFLINE are on. A desk is a registry row, not a credential: the
// staff member's normal portal sign-in is used on every call (nothing under src/auth is touched). Another organizer's event is always
// 404 event_not_found. Sync is allowed for a suspended organizer (data already collected is not stranded); the service then files every
// item for review. No request body is logged: the sync body carries ticket token text. Everything is `Cache-Control: no-store`.
import { randomUUID } from 'node:crypto';
import '../src/bootstrap/init.mjs';
import { noteApiError } from '../src/shared/events-api-error.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { requireActiveOrganizer, requireOpenOrganizer, organizerOf } from '../src/auth/events-authz.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { requireEventsKitOffline } from '../src/shared/feature-flags.mjs';
import { eventsKitOfflineService as svc } from '../src/bootstrap/services.mjs';
import { createVendorLimiter, limitOrNull } from '../src/shared/vendor-rate-limit.mjs';

const created = new Date().toISOString();
const ORGANIZER_TYPES = ['event_organizer', 'organizer_staff'];
const HOUR = 3_600_000;
const syncLimiter = createVendorLimiter({ perMinute: 30 });
const heartbeatLimiter = createVendorLimiter({ perMinute: 120 });
const writeLimiter = createVendorLimiter({ perMinute: 60 });
const fullLimiter = createVendorLimiter({ perMinute: 6, windowMs: HOUR });
const deltaLimiter = createVendorLimiter({ perMinute: 60, windowMs: HOUR });
/** For specs: clear every window of this file. */
export const resetEventsKitOfflineLimits = () => { for (const l of [syncLimiter, heartbeatLimiter, writeLimiter, fullLimiter, deltaLimiter]) l.reset(); };

const requestIdOf = (req) => {
  const given = String(req.headers?.['x-request-id'] ?? '');
  return /^[A-Za-z0-9._-]{8,64}$/.test(given) ? given : `req_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
};
const staffActor = req => ({ kind: 'staff', userId: req.user.sub, role: organizerOf(req).role, requestId: req.requestId });
const idemKey = req => req.headers?.['idempotency-key'];

function send(res, result, okStatus = 200) {
  if (result?.error) {
    noteApiError('kit', result.status || 400);
    const { error, status, ...extra } = result;
    return res.status(status || 400).json({ error, ...extra });
  }
  const { status, replayed, ...body } = result ?? {};
  if (replayed) res.set?.('Idempotent-Replayed', 'true');
  return res.status(Number.isInteger(status) ? status : okStatus).json(body);
}
const stamped = handler => async (req, res) => {
  req.requestId = requestIdOf(req);
  res.set?.('X-Request-Id', req.requestId);
  res.set?.('Cache-Control', 'no-store');
  return handler(req, res);
};
const writers = (method, ...roles) => routeGuard(method, [requireEventsKitOffline, requireAuth(...ORGANIZER_TYPES), requireActiveOrganizer(...roles)]);
const readers = (method, ...roles) => routeGuard(method, [requireEventsKitOffline, requireAuth(...ORGANIZER_TYPES), requireOpenOrganizer(...roles)]);
const base = '/organizer/events/:id/kit-offline';
const ctx = req => ({ actor: staffActor(req), organizerId: organizerOf(req).organizer.id, eventId: req.params.id });

export const organizerPrepareOfflineDesk = {
  created, method: 'post', path: `${base}/devices`,
  description: 'Organizer owner / admin / ops (EVENTS_KIT_OFFLINE): register an offline desk for ONE event. Idempotency-Key required. Body { label (1-40), clientKind: "web", deskBuild, bibRange?: { prefix? (0-4 of A-Z 0-9 -), padTo? (0-6), start, end } } (bibRange: owner / admin only, immutable, blocks of one event never overlap, including removed ones) → 201 { device { id, label, status, issuedAt, expiresAt (36 h, at most 24 h after the event end), bibRange | null }, warnings? [{ code: range_contains_assigned, count }], limits { sessionHours, maxPending, clockToleranceSeconds, syncBatch }, serverTime }. 409 device_limit_reached { limit: event | user } | bib_range_overlap { with } | event_not_open | kit_not_provided; 422 bib_range_invalid { reason } | validation_failed; 403 forbidden_role; 426 desk_update_required { minBuild }. A desk is a registry entry, not a credential.',
  onGuard: writers('post', 'owner', 'admin', 'ops'),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(writeLimiter, `w:${req.user.sub}`, res)) return undefined;
    return send(res, await svc.prepareDevice({ ...ctx(req), key: idemKey(req), body: req.body || {} }), 201);
  }),
};

export const organizerListOfflineDesks = {
  created, method: 'get', path: `${base}/devices`,
  description: 'Organizer owner / admin (all desks) / ops (own desks) (EVENTS_KIT_OFFLINE; a suspended organizer may read). ?status=active|revoked|expired → { items [{ id, label, status, bibRange | null, bibsRecorded, bibExceptions, staffFirstName, issuedAt, expiresAt, lastSyncAt, lastHeartbeatAt, pendingReported, discardedReported, snapshotRows, snapshotSeq, deskBuild }] }.',
  onGuard: readers('get', 'owner', 'admin', 'ops'),
  onRequest: stamped(async (req, res) => send(res, await svc.listDevices({ ...ctx(req), query: req.query || {} }))),
};

export const organizerRevokeOfflineDesk = {
  created, method: 'post', path: `${base}/devices/:deviceId/revoke`,
  description: 'Organizer owner / admin (any desk) / ops (a desk they created themselves, else 403 forbidden_role) (EVENTS_KIT_OFFLINE): remove a desk (a lost or stolen phone, or one that must start over). Idempotency-Key required. Body { reason (10-300), reasonSw? (10-300) } → 200 { device }. Takes effect at the desk\'s next contact: it may still SEND its unsent scans, but everything received after the removal is filed for a person (after_revoke), judged by the server\'s receipt time, then it wipes its list. The staff member is told. 404 device_not_found; 409 already_ended; 422 reason_required.',
  onGuard: writers('post', 'owner', 'admin', 'ops'),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(writeLimiter, `w:${req.user.sub}`, res)) return undefined;
    return send(res, await svc.revokeDevice({ ...ctx(req), deviceId: req.params.deviceId, key: idemKey(req), body: req.body || {} }));
  }),
};

export const organizerOfflineSnapshot = {
  created, method: 'get', path: `${base}/snapshot`,
  description: 'Organizer owner / admin / ops (EVENTS_KIT_OFFLINE; own desk only): the ticket list for one desk. ?deviceId&cursor&limit (≤1000)&sinceSeq&categoryId&deskBuild → { header { snapshotSeq, takenAt, serverTime, validUntil, sinceSeq? (delta), event { status, timezone, kitProvided }, collectionPoints [{ id, name }], categories [{ id, name }], rowCount }, rows [{ registrationId, tokenHash (sha256 hex), ticketCode, name ("Amina M."), categoryId, bibNumber, kitSize, ticket: active | revoked, revokeReason?, kit: collected | not_collected, collectedAt?, collectionPointName? }], removed [registrationId], nextCursor }. NEVER a token, a MAC, phone, email, date of birth, gender, emergency contact or payment data. With sinceSeq only registrations changed since come back (and `removed`). 403 device_not_active; 404 device_not_found; 413 snapshot_too_large { rows, max }; 426 desk_update_required; 429 (6 full downloads and 60 deltas an hour per desk).',
  onGuard: readers('get', 'owner', 'admin', 'ops'),
  onRequest: stamped(async (req, res) => {
    const q = req.query || {};
    const delta = q.sinceSeq !== undefined && q.sinceSeq !== '';
    if (!q.cursor && limitOrNull(delta ? deltaLimiter : fullLimiter, `${delta ? 'd' : 'f'}:${q.deviceId ?? 'none'}`, res)) return undefined;
    return send(res, await svc.snapshot({ ...ctx(req), organizer: organizerOf(req).organizer, query: q }));
  }),
};

export const organizerOfflineHeartbeat = {
  created, method: 'post', path: `${base}/heartbeat`,
  description: 'Organizer owner / admin / ops (EVENTS_KIT_OFFLINE; own desk): the desk reports it is alive. Body { deviceId, pending, oldestPendingAt, discarded, deskBuild, clockOffsetMs } → 200 { serverTime, deviceStatus: active | revoked | expired, minDeskBuild }. Counts only. 404 device_not_found; 426 desk_update_required; 429.',
  onGuard: readers('post', 'owner', 'admin', 'ops'),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(heartbeatLimiter, `h:${req.user.sub}`, res)) return undefined;
    return send(res, await svc.heartbeat({ ...ctx(req), body: req.body || {} }));
  }),
};

export const organizerOfflineSync = {
  created, method: 'post', path: `${base}/sync`,
  description: 'Organizer owner / admin / ops (EVENTS_KIT_OFFLINE; own desk; a suspended organizer may send): send provisional scans. Body { deviceId, batchId, snapshotSeq, snapshotTakenAt, clockOffsetMs, deskBuild?, items [{ clientRef (uuid), method: scan | manual, payload? (scan), registrationId? + manualReason (manual: phone_lost | no_signal | screen_damaged | other), collectionPointId?, kitSize?, bibNumber?, claimedAt, outcomeOnDevice? }] } (≤ 200 items, oldest first). Each item is its own transaction and is re-verified by the SERVER (token HMAC, ticket, registration, event, organizer, desk, one kit per registration); the device verdict and the device clock are never trusted. → 200 { results [{ clientRef, outcome: accepted | duplicate | revoked_after_scan | event_closed | after_revoke | organizer_suspended | invalid_token | unknown_ticket | wrong_event | validation_failed | deferred, replayed?, registrationId?, collectionId?, bib? { outcome: assigned | same_already | not_applied | format_invalid | out_of_range | no_range | taken | registration_has_other, number? }, warnings [clock_adjusted? | collection_point_invalid | kit_size_differs], reviewId?, card? }], summary { accepted, duplicate, needsReview, bibExceptions, rejected, deferred }, serverTime, deviceStatus, minDeskBuild }. The same (deviceId, clientRef) again returns the stored outcome with replayed: true. `deferred` items are not stored: send them again. A bib is recorded only AFTER the handover is committed and never blocks it. 400 invalid_batch; 404 device_not_found; 413 too_many_items; 426 desk_update_required; 429; 503 tickets_unavailable.',
  onGuard: readers('post', 'owner', 'admin', 'ops'),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(syncLimiter, `s:${req.user.sub}`, res)) return undefined;
    return send(res, await svc.sync({ actor: staffActor(req), organizerId: organizerOf(req).organizer.id, organizer: organizerOf(req).organizer, eventId: req.params.id, body: req.body || {} }));
  }),
};

export const organizerOfflineReview = {
  created, method: 'get', path: `${base}/review`,
  description: 'Organizer owner / admin (EVENTS_KIT_OFFLINE): offline scans that need a person. ?status=needs_review|checked|manual&cursor&limit (manual = accepted offline manual handovers, for the post-event review, D67) → { items [{ id, outcome, bibOutcome?, bibClaimed?, card { displayName, categoryName, bibNumber } | null, deviceLabel, deviceTime, receivedAt, winner? { collectedAt, method, deviceLabel? }, reviewStatus, note?, method, manualReason?, warnings }], nextCursor, counts { needsReview, checked } }. Masked names only; never phone or email.',
  onGuard: readers('get', 'owner', 'admin'),
  onRequest: stamped(async (req, res) => send(res, await svc.reviewList({ ...ctx(req), query: req.query || {} }))),
};

export const organizerOfflineReviewCheck = {
  created, method: 'post', path: `${base}/review/:scanId/check`,
  description: 'Organizer owner / admin (EVENTS_KIT_OFFLINE): mark an offline scan as checked. Idempotency-Key required. Body { note? (≤300; required 10-300 for revoked_after_scan) } → 200 { review { id, reviewStatus: "checked", checkedAt, note? } }. Nothing is auto-voided or reassigned: the organizer fixes a bib with the S5 bib screens and then marks the item checked. 404 scan_not_found; 409 not_in_review; 422 note_required.',
  onGuard: writers('post', 'owner', 'admin'),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(writeLimiter, `w:${req.user.sub}`, res)) return undefined;
    return send(res, await svc.reviewCheck({ ...ctx(req), scanId: req.params.scanId, key: idemKey(req), body: req.body || {} }));
  }),
};
