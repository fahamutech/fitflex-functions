// Marathon & running events · S6 — results: organizer routes (portal), FitFlex admin exception routes, and the member app's result,
// visibility, dispute and board routes (spec §8.1–§8.3). Every route answers 404 feature_disabled unless EVENTS_MODULE,
// EVENTS_REGISTRATION and EVENTS_RESULTS are on (the board also needs EVENTS_RESULTS_PUBLIC). Guards are wrapped in routeGuard
// (bfast mounts guards method-blind); the role is checked again in the service. Another organizer's event is always 404.
// No request body is logged. Every write needs an Idempotency-Key; X-Request-Id is stamped on every response.
import { randomUUID } from 'node:crypto';
import '../src/bootstrap/init.mjs';
import { errorText } from '../src/shared/events-results-copy.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { requireActiveOrganizer, requireOpenOrganizer, organizerOf } from '../src/auth/events-authz.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { requireEventsResults, requireEventsResultsPublic } from '../src/shared/feature-flags.mjs';
import { eventsResultsService as svc } from '../src/bootstrap/services.mjs';
import { createVendorLimiter, limitOrNull } from '../src/shared/vendor-rate-limit.mjs';
import { SAMPLE_CSV } from '../src/shared/events-results-csv.mjs';

const created = new Date().toISOString();
const ORGANIZER_TYPES = ['event_organizer', 'organizer_staff'];
const writeLimiter = createVendorLimiter({ perMinute: 120 });
const importLimiter = createVendorLimiter({ perMinute: 20 });
const memberWriteLimiter = createVendorLimiter({ perMinute: 30 });
const boardLimiter = createVendorLimiter({ perMinute: 120 });
/** For specs: clear every window of this file. */
export const resetEventsResultsLimits = () => { for (const l of [writeLimiter, importLimiter, memberWriteLimiter, boardLimiter]) l.reset(); };

const requestIdOf = (req) => {
  const given = String(req.headers?.['x-request-id'] ?? '');
  return /^[A-Za-z0-9._-]{8,64}$/.test(given) ? given : `req_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
};
const staffActor = req => ({ kind: 'staff', userId: req.user.sub, role: organizerOf(req).role, requestId: req.requestId });
const adminActor = req => ({ kind: 'admin', userId: req.user.sub, requestId: req.requestId });
const idemKey = req => req.headers?.['idempotency-key'];

function send(res, result, okStatus = 200) {
  if (result?.error) {
    const { error, status, ...extra } = result;
    if (extra.retryAfterSeconds) res.set?.('Retry-After', String(extra.retryAfterSeconds));
    return res.status(status || 400).json({ error, ...errorText(error), ...extra });
  }
  const { status, replayed, ...body } = result ?? {};
  if (replayed) res.set?.('Idempotent-Replayed', 'true');
  return res.status(Number.isInteger(status) ? status : okStatus).json(body);
}
/** Stamp X-Request-Id on the response first; an unexpected error is a 500 with the request id and nothing else. */
const stamped = handler => async (req, res) => {
  req.requestId = requestIdOf(req);
  res.set?.('X-Request-Id', req.requestId);
  try {
    return await handler(req, res);
  } catch (err) {
    console.error(`[events-results] ${req.requestId} ${err?.message}`);
    return res.status(500).json({ error: 'internal_error', requestId: req.requestId });
  }
};

const base = '/organizer/events/:id';
// Writes: an ACTIVE organizer (a suspended one is read-only). Reads: active or suspended.
const writers = (method, ...roles) => routeGuard(method, [requireEventsResults, requireAuth(...ORGANIZER_TYPES), requireActiveOrganizer(...roles)]);
const readers = (method, ...roles) => routeGuard(method, [requireEventsResults, requireAuth(...ORGANIZER_TYPES), requireOpenOrganizer(...roles)]);
const admin = method => routeGuard(method, [requireEventsResults, requireAuth('admin'), requireAcl('events')]);
const member = method => routeGuard(method, [requireEventsResults, requireAuth('member')]);
const orgId = req => organizerOf(req).organizer.id;
const ctxOf = req => ({ actor: staffActor(req), organizerId: orgId(req), eventId: req.params.id });

// ── Reads ────────────────────────────────────────────────────────────────────

export const organizerResultsSummary = {
  created, method: 'get', path: `${base}/results/summary`,
  description: 'Organizer owner / admin / timing (EVENTS_RESULTS; a suspended organizer may read): the Results tab header → { eventId, eventStatus, eventType, perCategory [{ categoryId, name, distanceMeters, confirmed, finished, dnf, dns, dq, pending, rejected, noResult, flagged, release { stage: none | provisional | official, releasedAt, releasedBy { name } }, disputesOpen, rules { timeBasis, cutoffMinutes, virtualDistanceToleranceBps } }], disputesOpen, importsCount, settings { timeBasis, cutoffMinutes, disputeWindowHours, publicNames } }.',
  onGuard: readers('get', 'owner', 'admin', 'timing'),
  onRequest: stamped(async (req, res) => send(res, await svc.summary(ctxOf(req)))),
};

export const organizerResultsList = {
  created, method: 'get', path: `${base}/results`,
  description: 'Organizer owner / admin / timing (EVENTS_RESULTS): confirmed places with their current result. ?categoryId&status=needs_review|verified|rejected|dnf|dns|dq|no_result&flag&q (bib or name prefix, 2+ characters)&cursor&limit (≤200) → { items [{ registrationId, displayName (full name; confirmed places only), bibNumber, categoryId, categoryName, resultId, revision, finishStatus, verificationStatus, stage, sourceType, sourceLabel, netElapsedMs, gunElapsedMs, elapsedMs, overallRank, categoryRank, withinCutoff, flags [], disputeOpen, updatedAt }], nextCursor, total }. Never phone, email, date of birth or route.',
  onGuard: readers('get', 'owner', 'admin', 'timing'),
  onRequest: stamped(async (req, res) => send(res, await svc.list({ ...ctxOf(req), query: req.query || {} }))),
};

export const organizerResultsSample = {
  created, method: 'get', path: `${base}/results-sample.csv`,
  description: 'Organizer owner / admin / timing (EVENTS_RESULTS): the sample CSV for the import dialog (bib, status, net_time, gun_time, category, note).',
  onGuard: readers('get', 'owner', 'admin', 'timing'),
  onRequest: stamped(async (_req, res) => { res.set?.('Content-Type', 'text/csv; charset=utf-8'); res.set?.('Cache-Control', 'public, max-age=3600'); return res.status(200).send(SAMPLE_CSV); }),
};

/** GET …/results/:registrationId also serves the literal sub-paths summary / imports / disputes (one Express pattern matches all of them). */
export const organizerResultDetail = {
  created, method: 'get', path: `${base}/results/:registrationId`,
  description: 'Organizer owner / admin / timing (EVENTS_RESULTS): one place with its revisions → { result (as a list row), revisions [{ revision, finishStatus, verificationStatus, netElapsedMs, gunElapsedMs, sourceType, reasonCode, note, by { name }, at }], linkedRun { distanceMeters, elapsedMs, movingSeconds, checks, flags } | null (never the route), disputes [] }. 404 registration_not_found.',
  onGuard: readers('get', 'owner', 'admin', 'timing'),
  onRequest: stamped(async (req, res) => {
    const lit = req.params.registrationId;
    if (lit === 'summary') return send(res, await svc.summary(ctxOf(req)));
    if (lit === 'imports') return send(res, await svc.importsList({ ...ctxOf(req), query: req.query || {} }));
    if (lit === 'disputes') return send(res, await svc.disputesList({ ...ctxOf(req), query: req.query || {} }));
    return send(res, await svc.detail({ ...ctxOf(req), registrationId: lit }));
  }),
};

export const organizerResultsImports = {
  created, method: 'get', path: `${base}/results/imports`,
  description: 'Organizer owner / admin / timing (EVENTS_RESULTS): applied imports, newest first. ?cursor&limit → { items [{ id, fileName, sourceType, sourceLabel, rowCount, createdCount, revisedCount, unchangedCount, createdBy { name }, createdAt }], nextCursor }.',
  onGuard: readers('get', 'owner', 'admin', 'timing'),
  onRequest: stamped(async (req, res) => send(res, await svc.importsList({ ...ctxOf(req), query: req.query || {} }))),
};

export const organizerDisputesList = {
  created, method: 'get', path: `${base}/results/disputes`,
  description: 'Organizer owner / admin / timing (EVENTS_RESULTS): disputes of the event. ?status=open|upheld|rejected|withdrawn → { items [{ id, registrationId, resultId, bibNumber, displayName, reasonCode, note, status, resolutionNote, createdAt, resolvedAt, windowEndsAt, linkedRun { distanceMeters, elapsedMs, movingSeconds } | null }], disputesOpen }.',
  onGuard: readers('get', 'owner', 'admin', 'timing'),
  onRequest: stamped(async (req, res) => send(res, await svc.disputesList({ ...ctxOf(req), query: req.query || {} }))),
};

// ── Import and entry ─────────────────────────────────────────────────────────

export const organizerImportPreview = {
  created, method: 'post', path: `${base}/results/imports/preview`,
  description: 'Organizer owner / admin / timing (EVENTS_RESULTS; event in_progress or completed): check a results CSV, write nothing. Body { csv (UTF-8, header row with bib or registrationId, optional status net_time gun_time category note; ≤1 MB and ≤EVENTS_RESULTS_IMPORT_MAX_ROWS rows; `,` or `;`), sourceType: timing_provider | organizer_verified, sourceLabel? (≤60), timeBasis?: net | gun } → { previewHash, rows { total, ok, warnings, problems }, willCreate, willRevise, unchanged, byStatus { finished, dnf, dns, dq }, unmatchedRegistrations, problems [{ line, bib, code, message }] (max 200), problemsTotal, warnings [{ line, bib, code }] }. Ranks in the file are ignored (warning rank_ignored). 422 event_not_open_for_results | csv_invalid; 413 payload_too_large | too_many_rows.',
  onGuard: writers('post', 'owner', 'admin', 'timing'),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(importLimiter, `i:${req.user.sub}`, res)) return undefined;
    return send(res, await svc.importPreview({ ...ctxOf(req), body: req.body || {} }));
  }),
};

export const organizerImportApply = {
  created, method: 'post', path: `${base}/results/imports`,
  description: 'Organizer owner / admin / timing (EVENTS_RESULTS): apply a checked CSV ATOMICALLY and only when it has no problems. Header Idempotency-Key (8–100, REQUIRED). Body as the preview + previewHash (+ fileName?) → 201 { import { id, fileName, sourceType, sourceLabel, rowCount, createdCount, revisedCount, unchangedCount, createdBy, createdAt } }. New results are pending_verification (import is a submission; verifying is a human act); DNF / DNS rows enter settled. The same file again returns the first answer (200 + Idempotent-Replayed: true). 409 preview_stale | import_has_errors { problems, rows } | idempotency_key_reused | request_in_progress | event_cancelled; 422 event_not_open_for_results.',
  onGuard: writers('post', 'owner', 'admin', 'timing'),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(writeLimiter, `w:${req.user.sub}`, res)) return undefined;
    return send(res, await svc.importApply({ ...ctxOf(req), key: idemKey(req), body: req.body || {} }), 201);
  }),
};

export const organizerEnterResult = {
  created, method: 'put', path: `${base}/results/:registrationId`,
  description: 'Organizer owner / admin / timing (EVENTS_RESULTS; event in_progress or completed): enter a result by hand. Idempotency-Key REQUIRED. Body { finishStatus: finished | dnf | dns, netTime? (H:MM:SS[.mmm]), gunTime?, sourceLabel? (≤60), reason? (≤300) } → { result { id, revision, finishStatus, verificationStatus, elapsedMs } }. finished is pending_verification; dnf / dns are settled. 409 already_official (use a correction); 422 validation_failed | event_not_open_for_results; 404 registration_not_found.',
  onGuard: writers('put', 'owner', 'admin', 'timing'),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(writeLimiter, `w:${req.user.sub}`, res)) return undefined;
    return send(res, await svc.enter({ ...ctxOf(req), registrationId: req.params.registrationId, key: idemKey(req), body: req.body || {} }));
  }),
};

// ── Decisions (owner / admin only) ───────────────────────────────────────────

const decision = (name, fn, text, extra = '') => ({
  created, method: 'post', path: `${base}/results/:resultId/${name}`,
  description: `Organizer owner / admin ONLY (EVENTS_RESULTS): ${text} Idempotency-Key REQUIRED; body.expectedRevision REQUIRED (409 result_changed { currentRevision } when the result moved). ${extra}`.trim(),
  onGuard: writers('post', 'owner', 'admin'),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(writeLimiter, `w:${req.user.sub}`, res)) return undefined;
    return send(res, await svc[fn]({ ...ctxOf(req), resultId: req.params.resultId, key: idemKey(req), body: req.body || {} }));
  }),
});

export const organizerVerifyResult = decision('verify', 'verify', 'verify a pending result (pending_verification → verified; a dq row becomes disqualified and needs reasonCode). Body { expectedRevision, reasonCode? } → { result { id, revision, verificationStatus, finishStatus } }; outbox result.verified.');
export const organizerRejectResult = decision('reject', 'reject', 'reject a pending result. Body { expectedRevision, reasonCode: not_a_valid_run | data_error | duplicate | other, note? (≤120) } → { result }. A rejected GPS run tells the participant why.');
export const organizerCorrectResult = decision('correct', 'correct', 'correct a verified, corrected or disqualified result (inserts revision n+1, status corrected; recomputes ranks; queues medals; tells the participant). Body { expectedRevision, netTime?, gunTime?, finishStatus?: finished | dnf | dns, reasonCode: timing_error | wrong_bib | late_finish_data | other, note (10–300) } → { result }. 422 no_change; 409 invalid_transition.');
export const organizerDisqualifyResult = decision('disqualify', 'disqualify', 'disqualify a result (inserts revision n+1, status disqualified; medals and event-linked rewards are revoked by the award engine). Body { expectedRevision, reasonCode: rule_violation | course_cut | wrong_category | equipment | identity | virtual_evidence | other, note? (≤300) } → { result }.');

export const organizerBulkVerifyPreview = {
  created, method: 'post', path: `${base}/results/verify-bulk/preview`,
  description: 'Organizer owner / admin (EVENTS_RESULTS): count the pending results that have NO flags (flagged GPS runs and dq rows are excluded). Body { categoryId?, filter?: "pending_clean" } → { previewHash, count, excludedFlagged }.',
  onGuard: writers('post', 'owner', 'admin'),
  onRequest: stamped(async (req, res) => send(res, await svc.bulkPreview({ ...ctxOf(req), body: req.body || {} }))),
};
export const organizerBulkVerify = {
  created, method: 'post', path: `${base}/results/verify-bulk`,
  description: 'Organizer owner / admin (EVENTS_RESULTS): verify every clean pending result of the preview ATOMICALLY. Idempotency-Key REQUIRED. Body { categoryId?, previewHash } → { verified, excludedFlagged }. 409 preview_stale.',
  onGuard: writers('post', 'owner', 'admin'),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(writeLimiter, `w:${req.user.sub}`, res)) return undefined;
    return send(res, await svc.bulkApply({ ...ctxOf(req), key: idemKey(req), body: req.body || {} }));
  }),
};

export const organizerReleasePreview = {
  created, method: 'post', path: `${base}/results/release/preview`,
  description: 'Organizer owner / admin (EVENTS_RESULTS): what a release would publish. Body { categoryId? (null = whole event), stage: provisional | official } → { previewHash, finished, dnf, dns, dq, noResult, unsettled, rejected, willMarkDns }.',
  onGuard: writers('post', 'owner', 'admin'),
  onRequest: stamped(async (req, res) => send(res, await svc.releasePreview({ ...ctxOf(req), body: req.body || {} }))),
};
export const organizerRelease = {
  created, method: 'post', path: `${base}/results/release`,
  description: 'Organizer owner / admin (EVENTS_RESULTS; event in_progress or completed): publish results of a category or the whole event. Idempotency-Key REQUIRED. Body { categoryId?, stage: provisional | official, previewHash, markRemainingDns?: bool, leaveUnsettledOut?: bool } → { release { id, stage, categoryId, resultCount, unsettledCount, releasedAt, markedDns } }. Official cannot be withdrawn (later changes are corrections); ranks are computed here; outbox result.published. 409 already_released | unsettled_results { unsettled } | preview_stale; 422 no_results | event_not_open_for_results.',
  onGuard: writers('post', 'owner', 'admin'),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(writeLimiter, `w:${req.user.sub}`, res)) return undefined;
    return send(res, await svc.release({ ...ctxOf(req), key: idemKey(req), body: req.body || {} }));
  }),
};
export const organizerWithdrawRelease = {
  created, method: 'post', path: `${base}/results/release/withdraw`,
  description: 'Organizer owner / admin (EVENTS_RESULTS): withdraw a PROVISIONAL release while no official release exists. Idempotency-Key REQUIRED. Body { categoryId? } → { withdrawn { id, categoryId } }. 409 already_released | nothing_to_withdraw.',
  onGuard: writers('post', 'owner', 'admin'),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(writeLimiter, `w:${req.user.sub}`, res)) return undefined;
    return send(res, await svc.withdraw({ ...ctxOf(req), key: idemKey(req), body: req.body || {} }));
  }),
};

export const organizerResolveDispute = {
  created, method: 'post', path: `${base}/results/disputes/:disputeId/resolve`,
  description: 'Organizer owner / admin ONLY (EVENTS_RESULTS): resolve an open dispute. Idempotency-Key REQUIRED. Body { outcome: upheld | rejected, note (5–500), correction? } — upheld needs correction { action?: correct | disqualify, expectedRevision?, …the fields of POST …/correct or …/disqualify } and commits it in the same transaction; rejected means no change. → { dispute { id, status, resolvedAt, resultIdAfter } }. Outbox result.disputed; the participant is told.',
  onGuard: writers('post', 'owner', 'admin'),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(writeLimiter, `w:${req.user.sub}`, res)) return undefined;
    return send(res, await svc.disputeResolve({ ...ctxOf(req), disputeId: req.params.disputeId, key: idemKey(req), body: req.body || {} }));
  }),
};

export const organizerResultsSettings = {
  created, method: 'patch', path: `${base}/results-settings`,
  description: 'Organizer owner / admin (EVENTS_RESULTS): { timeBasis?: net | gun, cutoffMinutes? (1–1440 | null) } for every category, { categories?: [{ id, timeBasis?, cutoffMinutes?, virtualDistanceToleranceBps? (0–500 | null) }] }, { disputeWindowHours? (24–720), publicNames?: initial | bib_only }. Idempotency-Key REQUIRED. Unknown keys are refused (422 validation_failed). After the first official release only a LONGER dispute window can change (409 settings_locked). → { settings }.',
  onGuard: writers('patch', 'owner', 'admin'),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(writeLimiter, `w:${req.user.sub}`, res)) return undefined;
    return send(res, await svc.updateSettings({ ...ctxOf(req), key: idemKey(req), body: req.body || {} }));
  }),
};

// ── FitFlex admin (scope events): read, and audited exceptions (D59) ─────────

export const adminResultsSummary = {
  created, method: 'get', path: '/admin/events/:id/results/summary',
  description: 'Admin (scope events; EVENTS_RESULTS): the same summary as the organizer\'s Results tab for any event.',
  onGuard: admin('get'),
  onRequest: stamped(async (req, res) => send(res, await svc.summary({ actor: adminActor(req), eventId: req.params.id }))),
};
export const adminResultsList = {
  created, method: 'get', path: '/admin/events/:id/results',
  description: 'Admin (scope events; EVENTS_RESULTS): the same rows as the organizer\'s list (read only).',
  onGuard: admin('get'),
  onRequest: stamped(async (req, res) => send(res, await svc.list({ actor: adminActor(req), eventId: req.params.id, query: req.query || {} }))),
};
const adminDecision = (name, fn, text) => ({
  created, method: 'post', path: `/admin/events/:id/results/:resultId/${name}`,
  description: `Admin (scope events; EVENTS_RESULTS): ${text} Exception path (D59): body.expectedRevision and a note of 10–300 characters are REQUIRED; the organizer owners are told; audited as events.admin_result_exception. Idempotency-Key REQUIRED.`,
  onGuard: admin('post'),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(writeLimiter, `a:${req.user.sub}`, res)) return undefined;
    return send(res, await svc[fn]({ actor: adminActor(req), eventId: req.params.id, resultId: req.params.resultId, key: idemKey(req), body: req.body || {} }));
  }),
});
export const adminCorrectResult = adminDecision('correct', 'correct', 'correct a result (same body as the organizer route).');
export const adminDisqualifyResult = adminDecision('disqualify', 'disqualify', 'disqualify a result (same body as the organizer route).');
export const adminResolveDispute = {
  created, method: 'post', path: '/admin/events/:id/results/disputes/:disputeId/resolve',
  description: 'Admin (scope events; EVENTS_RESULTS): resolve a dispute that has been open more than 7 days, or whose organizer is not active (else 409 organizer_can_resolve). Same body as the organizer route; Idempotency-Key REQUIRED.',
  onGuard: admin('post'),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(writeLimiter, `a:${req.user.sub}`, res)) return undefined;
    return send(res, await svc.disputeResolve({ actor: adminActor(req), eventId: req.params.id, disputeId: req.params.disputeId, key: idemKey(req), body: req.body || {} }));
  }),
};

// ── Member app ───────────────────────────────────────────────────────────────

export const myEventResult = {
  created, method: 'get', path: '/me/event-registrations/:id/result',
  description: 'Member (participant; the purchaser while the place is unclaimed; EVENTS_RESULTS): the result of one place → { registrationId, eventId, eventTitle, eventType, categoryId, categoryName, distanceMeters, bibNumber, stage: none | provisional | official | corrected | disputed | disqualified | rejected, viewer: participant | purchaser_status_only, result: null | { id, revision, finishStatus, verificationStatus, sourceType, sourceLabel, netElapsedMs, gunElapsedMs, elapsedMs, overallRank, categoryRank, finishersInCategory, withinCutoff, verifiedAt, correctedAt, reasonCode, correctionNote, personalBest: { isPersonalBest, previousBestElapsedMs, basis } | null }, release { stage, releasedAt }, dispute { id, status, createdAt, resolvedAt, resolutionNote, canRaise, windowEndsAt }, visibility { current, canChange, allowed [], reason? (minor | ask) }, runLinks [], medals [MedalAward], rewardsEarned [] }. A purchaser after the claim gets only { …header, stage, viewer, finishStatus }. 404 registration_not_found.',
  onGuard: member('get'),
  onRequest: stamped(async (req, res) => { res.set?.('Cache-Control', 'private, no-store'); return send(res, await svc.myResult({ userId: req.user.sub, registrationId: req.params.id })); }),
};

export const myEventResults = {
  created, method: 'get', path: '/me/event-results',
  description: 'Member (EVENTS_RESULTS): my OFFICIAL results across events, newest first. ?cursor&limit → { items [{ registrationId, eventId, eventTitle, eventStartsAt, categoryName, distanceMeters, bibNumber, finishStatus, stage, elapsedMs, overallRank, categoryRank }], nextCursor }.',
  onGuard: member('get'),
  onRequest: stamped(async (req, res) => send(res, await svc.myResults({ userId: req.user.sub, query: req.query || {} }))),
};

export const setMyResultsVisibility = {
  created, method: 'put', path: '/me/event-registrations/:id/results-visibility',
  description: 'Member (the participant; EVENTS_RESULTS): who sees my name on the results board. Body { visibility: standard | bib_only | hidden } → { visibility }. Idempotent. 422 visibility_not_allowed (a minor cannot pick standard); 404 registration_not_found.',
  onGuard: member('put'),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(memberWriteLimiter, `v:${req.user.sub}`, res)) return undefined;
    return send(res, await svc.setVisibility({ userId: req.user.sub, registrationId: req.params.id, body: req.body || {} }));
  }),
};

export const raiseMyResultDispute = {
  created, method: 'post', path: '/me/event-registrations/:id/result/disputes',
  description: 'Member (the participant; EVENTS_RESULTS): ask the organizer to review my result while the category is released and the dispute window is open. Body { reasonCode: time_wrong | not_my_result | wrong_category | missing_split | dq_challenge | other, note? (≤500) } → 201 { dispute { id, status, createdAt } }. 409 dispute_open | dispute_window_closed | no_result; 429 rate_limited (5 a day).',
  onGuard: member('post'),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(memberWriteLimiter, `d:${req.user.sub}`, res)) return undefined;
    return send(res, await svc.raiseDispute({ userId: req.user.sub, registrationId: req.params.id, body: req.body || {} }), 201);
  }),
};

export const withdrawMyResultDispute = {
  created, method: 'delete', path: '/me/event-registrations/:id/result/disputes/:disputeId',
  description: 'Member (the participant; EVENTS_RESULTS): withdraw my own OPEN dispute → { dispute { id, status: withdrawn } }. 409 dispute_closed; 404 dispute_not_found.',
  onGuard: member('delete'),
  onRequest: stamped(async (req, res) => send(res, await svc.withdrawDispute({ userId: req.user.sub, registrationId: req.params.id, disputeId: req.params.disputeId }))),
};

export const eventResultsBoard = {
  created, method: 'get', path: '/events/:eventId/results',
  description: 'Signed-in member (EVENTS_RESULTS_PUBLIC; there is no signed-out board): the results board of a released event. ?categoryId&q (bib or visible name prefix)&cursor&limit (≤200) → { event { title, eventType, timezone }, release { stage, releasedAt }, categories [{ id, name, distanceMeters, stage }], items [{ rank, bibNumber, displayName (first name + last initial, or "Runner"), elapsedMs, finishStatus, stage, sourceType, badges [corrected | under_review] }], mine { rank, bibNumber } | null, nextCursor }. Hidden people are omitted; minors and bib-only people show "Runner"; DNF / DNS / DQ rows carry no time or rank; unreleased categories are absent.',
  onGuard: routeGuard('get', [requireEventsResultsPublic, requireAuth('member')]),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(boardLimiter, `b:${req.user.sub}`, res)) return undefined;
    return send(res, await svc.board({ userId: req.user.sub, eventId: req.params.eventId, query: req.query || {} }));
  }),
};
