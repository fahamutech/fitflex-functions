// Marathon & running events · S5 — venue operations for a signed-in organizer user (spec §4, §6). Every route answers 404
// feature_disabled unless EVENTS_MODULE, EVENTS_REGISTRATION and EVENTS_KIT_OPS are on. Guards are wrapped in routeGuard (bfast mounts
// guards method-blind); the role is checked again in the service. Another organizer's event is always 404 event_not_found (never 403).
// No request body of verify / kit-collections is logged; responses that carry a card are `Cache-Control: no-store`.
import { randomUUID } from 'node:crypto';
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { requireActiveOrganizer, requireOpenOrganizer, organizerOf } from '../src/auth/events-authz.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { requireEventsKitOps } from '../src/shared/feature-flags.mjs';
import { eventsOpsService as ops, eventsSyncService as sync } from '../src/bootstrap/services.mjs';
import { createVendorLimiter, limitOrNull } from '../src/shared/vendor-rate-limit.mjs';
import { createCounterWindow } from '../src/shared/events-rate-limits.mjs';

const created = new Date().toISOString();
const ORGANIZER_TYPES = ['event_organizer', 'organizer_staff'];

const verifyUser = createVendorLimiter({ perMinute: 120 });
const verifyEvent = createVendorLimiter({ perMinute: 600 });
const verifyFailures = createCounterWindow({ limit: 30 });
const lookupLimiter = createVendorLimiter({ perMinute: 60 });
const writeLimiter = createVendorLimiter({ perMinute: 120 });
const exportLimiter = createVendorLimiter({ perMinute: 5, windowMs: 3_600_000 });
/** For specs: clear every window of this file. */
export const resetEventsOpsLimits = () => { for (const l of [verifyUser, verifyEvent, lookupLimiter, writeLimiter, exportLimiter]) l.reset(); verifyFailures.reset(); };

const requestIdOf = (req) => {
  const given = String(req.headers?.['x-request-id'] ?? '');
  return /^[A-Za-z0-9._-]{8,64}$/.test(given) ? given : `req_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
};
const staffActor = req => ({ kind: 'staff', userId: req.user.sub, role: organizerOf(req).role, requestId: req.requestId });
const idemKey = req => req.headers?.['idempotency-key'];

function send(res, result, okStatus = 200) {
  if (result?.error) {
    const { error, status, ...extra } = result;
    return res.status(status || 400).json({ error, ...extra });
  }
  const { status, replayed, ...body } = result ?? {};
  if (replayed) res.set?.('Idempotent-Replayed', 'true');
  return res.status(Number.isInteger(status) ? status : okStatus).json(body);
}
/** Stamp X-Request-Id on the response first, whatever the route does. */
const stamped = handler => async (req, res) => {
  req.requestId = requestIdOf(req);
  res.set?.('X-Request-Id', req.requestId);
  return handler(req, res);
};

// Reads/writes: an active organizer for writes and the desk; an open (active or suspended) organizer for reads.
const writers = (method, ...roles) => routeGuard(method, [requireEventsKitOps, requireAuth(...ORGANIZER_TYPES), requireActiveOrganizer(...roles)]);
const readers = (method, ...roles) => routeGuard(method, [requireEventsKitOps, requireAuth(...ORGANIZER_TYPES), requireOpenOrganizer(...roles)]);
const base = '/organizer/events/:id';

// ── Verify and hand over ──────────────────────────────────────────────────

export const organizerVerifyTicket = {
  created, method: 'post', path: `${base}/tickets/verify`,
  description: 'Organizer owner / admin / ops (EVENTS_KIT_OPS): read-only check of a scanned or pasted ticket for ONE event. Body { payload: "FFEV1:…" | bare token (≤200), collectionPointId? } → 200 { result: valid | already_collected | wrong_event | revoked | unpaid | unknown, registrationId? (valid | already_collected | revoked), card? { displayName ("Amina M."), ticketCode, categoryName, distanceM, ticketTypeName, teamName, bibNumber, kitSize, kit { state, collectedAt?, collectionPointName? }, payment }, warnings [bib_missing | kit_size_missing | outside_collection_window | bib_changed_after_collection | claim_pending], revokedReason? (cancelled | refunded | event_cancelled | admin | replaced), otherEvent? { title } (same organizer only), collectedAt?, collectionPointName?, byFirstName?, canCollect, canOverride }. Another organizer\'s ticket is `unknown`, never `wrong_event`. 400 not_event_ticket (a gym QR or random text) | invalid_payload; 404 event_not_found; 429 rate_limited (120/min per user, 600/min per event, 30 failed outcomes/min per user); 503 tickets_unavailable. Never phone, email, date of birth, order or payment data, or the token. no-store.',
  onGuard: writers('post', 'owner', 'admin', 'ops'),
  onRequest: stamped(async (req, res) => {
    res.set?.('Cache-Control', 'no-store');
    const blocked = verifyFailures.blocked(req.user.sub);
    if (blocked) { res.set?.('Retry-After', String(blocked.retryAfterSeconds)); return res.status(429).json({ error: 'rate_limited', retryAfterSeconds: blocked.retryAfterSeconds }); }
    if (limitOrNull(verifyUser, `u:${req.user.sub}`, res)) return undefined;
    if (limitOrNull(verifyEvent, `e:${req.params.id}`, res)) return undefined;
    const out = await ops.verifyTicket({ actor: staffActor(req), organizerId: organizerOf(req).organizer.id, eventId: req.params.id, body: req.body || {} });
    if (out.error === 'not_event_ticket' || ['unknown', 'wrong_event'].includes(out.result)) verifyFailures.hit(req.user.sub);
    return send(res, out);
  }),
};

export const organizerCollectKit = {
  created, method: 'post', path: `${base}/kit-collections`,
  description: 'Organizer owner / admin / ops (EVENTS_KIT_OPS): record a kit handover. Header Idempotency-Key (8–100, REQUIRED). Body { method: scan | manual, payload? (scan), registrationId? + manualReason: phone_lost | no_signal | screen_damaged | other (manual), collectionPointId? (required when the event has an active point), kitSize?, bibNumber?, status?: collected | exception, note? (≤300; required for exception) }. The payload is re-resolved by the write itself. One `collected` row per registration is a database fact. → 201 { collection { id, status, collectedAt, collectionPointId }, card, warnings } ; the same key and body again → 200 + Idempotent-Replayed: true. 409 already_collected { collectedAt, collectionPointName, byFirstName, canOverride } | ticket_revoked { reason } | registration_unpaid | idempotency_key_reused | request_in_progress | event_cancelled | event_not_open | bib_taken; 400 idempotency_key_required | not_event_ticket | invalid_payload; 404 registration_not_found | event_not_found; 422 collection_point_required | collection_point_invalid | manual_reason_required | note_required | bib_invalid | validation_failed; 429 rate_limited.',
  onGuard: writers('post', 'owner', 'admin', 'ops'),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(writeLimiter, `w:${req.user.sub}`, res)) return undefined;
    res.set?.('Cache-Control', 'no-store');
    return send(res, await ops.collectKit({ actor: staffActor(req), organizerId: organizerOf(req).organizer.id, eventId: req.params.id, key: idemKey(req), body: req.body || {} }), 201);
  }),
};

export const organizerCorrectKit = {
  created, method: 'post', path: `${base}/kit-collections/:collectionId/corrections`,
  description: 'Organizer owner / admin ONLY (EVENTS_KIT_OPS): void a handover, or void it and record a new one. Idempotency-Key required. Body { action: void | recollect, reason (10–300, required) } → 200 { corrected { collectionId, action, newCollectionId? } }. `void` inserts a corrected row, the superseded row becomes `exception` and kitStatus returns to ready; `recollect` also inserts a new collected row. Nothing is edited or deleted. 403 forbidden_role (ops); 404 collection_not_found | event_not_found; 409 already_corrected | event_cancelled | event_not_open; 422 reason_required | validation_failed.',
  onGuard: writers('post', 'owner', 'admin'),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(writeLimiter, `w:${req.user.sub}`, res)) return undefined;
    return send(res, await ops.correctKit({ actor: staffActor(req), organizerId: organizerOf(req).organizer.id, eventId: req.params.id, collectionId: req.params.collectionId, key: idemKey(req), body: req.body || {} }));
  }),
};

export const organizerKitHistory = {
  created, method: 'get', path: `${base}/kit-collections`,
  description: 'Organizer owner / admin / ops (EVENTS_KIT_OPS; a suspended organizer may read): the handover history, newest first. ?cursor&limit (≤200)&status=collected|exception|corrected&collectionPointId → { items [{ id, registrationId, displayName ("Amina M."), bibNumber, status, collectedAt, collectionPointName, byFirstName, method: scan | manual | api, manualReason?, correctionReason? }], nextCursor }.',
  onGuard: readers('get', 'owner', 'admin', 'ops'),
  onRequest: stamped(async (req, res) => send(res, await ops.kitHistory({ organizerId: organizerOf(req).organizer.id, eventId: req.params.id, query: req.query || {} }))),
};

export const organizerKitSummary = {
  created, method: 'get', path: `${base}/kit/summary`,
  description: 'Organizer owner / admin / ops (EVENTS_KIT_OPS): the desk progress header → { confirmed, collected, remaining, exceptions, byCategory [{ categoryId, name, confirmed, collected }], byCollectionPoint [{ collectionPointId, name, collected }] }.',
  onGuard: readers('get', 'owner', 'admin', 'ops'),
  onRequest: stamped(async (req, res) => send(res, await ops.kitSummary({ organizerId: organizerOf(req).organizer.id, eventId: req.params.id }))),
};

export const organizerKitLookup = {
  created, method: 'get', path: `${base}/kit/lookup`,
  description: 'Organizer owner / admin / ops (EVENTS_KIT_OPS): manual lookup for a lost phone. ?q (3–80 characters) matches CONFIRMED places by exact registration id, exact bib, exact ticket code, or a first/last name PREFIX; an unpaid place is returned (as payment: unpaid) only for its exact registration id. At most 10, no browse-all → { items [{ registrationId, card, warnings, canCollect }] }. Masked cards only (no phone, email, DOB, full name). 400 query_too_short | query_too_long; 429 rate_limited (60/min per user).',
  onGuard: readers('get', 'owner', 'admin', 'ops'),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(lookupLimiter, `l:${req.user.sub}`, res)) return undefined;
    res.set?.('Cache-Control', 'no-store');
    return send(res, await ops.lookup({ actor: staffActor(req), organizerId: organizerOf(req).organizer.id, eventId: req.params.id, query: req.query || {} }));
  }),
};

// ── Bibs ──────────────────────────────────────────────────────────────────

export const organizerAssignBib = {
  created, method: 'post', path: `${base}/bib-assignments`,
  description: 'Organizer owner / admin / ops (EVENTS_KIT_OPS): assign a bib number to a CONFIRMED registration. Idempotency-Key required. Body { registrationId, bibNumber (1–12 of A–Z 0–9 -, not starting with a dash; upper-cased), replace?: true, reason? (10–300, required with replace) }. Unique across the WHOLE event (D40). → 201 { assignment { id, registrationId, bibNumber, assignedAt }, previousBibNumber, warnings [bib_changed_after_collection] } (200 when unchanged). 409 bib_taken | bib_already_assigned { current } | registration_unpaid | ticket_revoked | idempotency_key_reused | request_in_progress; 403 forbidden_role (ops cannot replace); 422 bib_invalid | reason_required; 404 registration_not_found | event_not_found.',
  onGuard: writers('post', 'owner', 'admin', 'ops'),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(writeLimiter, `w:${req.user.sub}`, res)) return undefined;
    return send(res, await ops.assignBib({ actor: staffActor(req), organizerId: organizerOf(req).organizer.id, eventId: req.params.id, key: idemKey(req), body: req.body || {} }), 201);
  }),
};

export const organizerReleaseBib = {
  created, method: 'post', path: `${base}/bib-assignments/:assignmentId/release`,
  description: 'Organizer owner / admin (EVENTS_KIT_OPS): release a bib. Idempotency-Key required. Body { reason (10–300) } → 200 { released { id, registrationId, bibNumber }, warnings [bib_changed_after_collection] }. 404 assignment_not_found; 409 already_released; 422 reason_required.',
  onGuard: writers('post', 'owner', 'admin'),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(writeLimiter, `w:${req.user.sub}`, res)) return undefined;
    return send(res, await ops.releaseBib({ actor: staffActor(req), organizerId: organizerOf(req).organizer.id, eventId: req.params.id, assignmentId: req.params.assignmentId, key: idemKey(req), body: req.body || {} }));
  }),
};

export const organizerBibsBulkPreview = {
  created, method: 'post', path: `${base}/bib-assignments/bulk/preview`,
  description: 'Organizer owner / admin (EVENTS_KIT_OPS): preview a bulk rule. Body { categoryId?, start (int ≥ 0), end?, prefix? (≤8 of A–Z 0–9 -), padTo? (0–8), order?: registered_at | last_name } for confirmed registrations WITHOUT a bib → { previewHash, count, first, last, conflicts [bib numbers already taken], shortfall }. Writes nothing.',
  onGuard: writers('post', 'owner', 'admin'),
  onRequest: stamped(async (req, res) => send(res, await ops.bulkPreview({ actor: staffActor(req), organizerId: organizerOf(req).organizer.id, eventId: req.params.id, body: req.body || {} }))),
};

export const organizerBibsBulk = {
  created, method: 'post', path: `${base}/bib-assignments/bulk`,
  description: 'Organizer owner / admin (EVENTS_KIT_OPS): apply a bulk rule ATOMICALLY (all or nothing, one advisory lock per event). Idempotency-Key required. Body as the preview + previewHash → 200 { assigned, first, last }; 409 preview_stale (registrations or taken numbers changed) | bulk_not_applicable { conflicts, shortfall }; one events.bibs_bulk_assigned audit row and one bib.assigned outbox row per registration; participants get an in-app notice only (no push).',
  onGuard: writers('post', 'owner', 'admin'),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(writeLimiter, `w:${req.user.sub}`, res)) return undefined;
    return send(res, await ops.bulkApply({ actor: staffActor(req), organizerId: organizerOf(req).organizer.id, eventId: req.params.id, key: idemKey(req), body: req.body || {} }));
  }),
};

export const organizerBibsImportPreview = {
  created, method: 'post', path: `${base}/bib-assignments/import/preview`,
  description: 'Organizer owner / admin (EVENTS_KIT_OPS): dry-run a CSV of bib numbers. Body { csv } (UTF-8, header row required with bibNumber and registrationId OR ticketCode, `,` or `;`, ≤2,000 rows and 512 KB; cells starting = + - @ tab CR are refused as ids and neutralised when echoed) → { total, ok, bad, rows [{ line, status: ok | error, code: registration_not_found | registration_not_confirmed | bib_invalid | bib_taken | bib_duplicate_in_file | registration_duplicate_in_file | already_assigned | null, bibNumber }], previewHash }. 413 payload_too_large | too_many_rows; 422 csv_invalid | csv_header_invalid. Writes nothing.',
  onGuard: writers('post', 'owner', 'admin'),
  onRequest: stamped(async (req, res) => send(res, await ops.importPreview({ actor: staffActor(req), organizerId: organizerOf(req).organizer.id, eventId: req.params.id, body: req.body || {} }))),
};

export const organizerBibsImport = {
  created, method: 'post', path: `${base}/bib-assignments/import`,
  description: 'Organizer owner / admin (EVENTS_KIT_OPS): apply a CSV. ALL OR NOTHING: any error row → 409 import_has_errors { bad, rows } and nothing is written; changed data since the preview → 409 preview_stale. Idempotency-Key required. Body { csv, previewHash } → 200 { imported }.',
  onGuard: writers('post', 'owner', 'admin'),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(writeLimiter, `w:${req.user.sub}`, res)) return undefined;
    return send(res, await ops.importApply({ actor: staffActor(req), organizerId: organizerOf(req).organizer.id, eventId: req.params.id, key: idemKey(req), body: req.body || {} }));
  }),
};

export const organizerListBibs = {
  created, method: 'get', path: `${base}/bib-assignments`,
  description: 'Organizer owner / admin / ops / timing (EVENTS_KIT_OPS): confirmed registrations with their bib. ?cursor&limit (≤200)&categoryId&filter=assigned|unassigned&q (name prefix, exact bib or ticket code) → { items [{ registrationId, displayName, categoryName, bibNumber, assignedAt, kit { state } }], nextCursor, counts { assigned, unassigned } }.',
  onGuard: readers('get', 'owner', 'admin', 'ops', 'timing'),
  onRequest: stamped(async (req, res) => send(res, await ops.listBibs({ organizerId: organizerOf(req).organizer.id, eventId: req.params.id, query: req.query || {} }))),
};

// ── Sync and export ───────────────────────────────────────────────────────

export const organizerRegistrationChanges = {
  created, method: 'get', path: `${base}/registration-changes`,
  description: 'Organizer owner / admin / ops / timing (EVENTS_KIT_OPS): the change feed of one event over committed outbox rows (registration.created | updated | paid | cancelled, kit.collected, bib.assigned), ordered by seq. ?cursor&limit (≤200; ≤100 with expand)&expand=registration → { items [{ seq, id (outbox id: dedupe on it), eventType, registrationId, changedAt, status, changed?, cancelledAt?, reasonCode?, registration? }], nextCursor (always; the same position when nothing is new), hasMore }. A cancelled place is a tombstone with no names. Only rows older than EVENTS_FEED_LAG_SECONDS are served. 410 cursor_expired (older than 90 days: do a full resync with GET registrations?updatedSince=); 400 invalid_cursor | invalid_limit.',
  onGuard: readers('get', 'owner', 'admin', 'ops', 'timing'),
  onRequest: stamped(async (req, res) => send(res, await sync.changeFeed({ organizerId: organizerOf(req).organizer.id, eventId: req.params.id, query: req.query || {} }))),
};

export const organizerExportRegistrations = {
  created, method: 'get', path: `${base}/exports/registrations.csv`,
  description: 'Organizer owner / admin ONLY (EVENTS_KIT_OPS, organizer active): the participant list as CSV. Fixed columns registrationId, ticketCode, firstName, lastName, categoryName, ticketTypeName, status, bibNumber, kitStatus, kitCollectedAt, kitSize, teamName, groupLabel, claimed. NEVER phone, email, date of birth, gender or emergency contact. Cancelled rows keep id and status but blank names. Every cell is quoted; a cell starting = + - @ tab or CR gets a leading apostrophe; UTF-8 with BOM; attachment; no-store. The events.roster_exported audit row is written BEFORE the first byte. 429 rate_limited (5 per hour per organizer); 413 export_too_large (EVENTS_EXPORT_MAX_ROWS).',
  onGuard: writers('get', 'owner', 'admin'),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(exportLimiter, `x:${organizerOf(req).organizer.id}`, res)) return undefined;
    const out = await sync.startExport({ actor: req.user.sub, organizerId: organizerOf(req).organizer.id, eventId: req.params.id });
    if (out.error) return send(res, out);
    res.set?.('Content-Type', 'text/csv; charset=utf-8');
    res.set?.('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.set?.('Cache-Control', 'no-store');
    res.status(200);
    if (typeof res.write === 'function') {
      for await (const chunk of out.chunks) res.write(chunk);
      return res.end();
    }
    let all = '';
    for await (const chunk of out.chunks) all += chunk;
    return typeof res.send === 'function' ? res.send(all) : res.end(all);
  }),
};
