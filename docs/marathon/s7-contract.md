# Events S7 backend contract (portal and mobile)

Source of truth for the shapes below: the route `description` strings in `functions/events-analytics.mjs`, `events-kit-offline.mjs`, `events-waitlist.mjs`, `events-admin.mjs`, `events-admin-s7.mjs`, `events-integrations.mjs`, `events-results.mjs`, `events-rewards.mjs` and the specs in `specs/events-s7-*.specs.mjs`. Design: `docs/design/events-s7-hardening-and-pilot.md` on the parent repo (branch `docs/events-s7-design-1030`, decisions D63 to D85 accepted 2026-11-02, D66 changed to offline bib recording).

This file is written in the first slice and updated with every slice. A section marked **(pending)** is not yet on this branch.

## Conventions
- Errors: `{ "error": "<code>", ...extra }`; `X-Request-Id` on organizer routes; 5xx carries `requestId` on `/v1`. 429 carries `retryAfterSeconds` and `Retry-After`.
- Instants are ISO UTC. Money is whole TSh. Counts are integers.
- Every write that says "Idempotency-Key" needs header `Idempotency-Key` (8 to 100 chars); a replay returns the first answer with `200` and `Idempotent-Replayed: true`; the same key with another body is `409 idempotency_key_reused`.
- Cursor pagination `{ items, nextCursor }`.
- **Flags (all off by default, server env):** `EVENTS_KIT_OFFLINE` (needs `EVENTS_KIT_OPS`), `EVENTS_WAITLIST`, `EVENTS_ANALYTICS`; each also needs `EVENTS_MODULE` and `EVENTS_REGISTRATION`. A route behind an off flag answers `404 { error: "feature_disabled" }` (before sign-in is checked).
- Hardening fixes (H1 to H17) ride on the flag of the feature they fix; no new flag.

## `GET /events/options` (additive; an older client ignores new keys)
```
analytics: { enabled }                                   // EVENTS_ANALYTICS
waitlist:  { enabled, offerHours, maxActivePerUser }     // EVENTS_WAITLIST            (pending)
ops:       { kit, api, webhooks, kitOffline }            // kitOffline: EVENTS_KIT_OFFLINE and a usable ticket secret   (pending)
payments:  { blockedReason: null | "second_approver_off" | "no_ticket_secret" | "flag_off" }   // H14   (pending)
```

## C. Analytics and health (B3, this slice)

### `POST /events/analytics` (member JWT; 404 unless EVENTS_ANALYTICS)
Body `{ events: [{ name, props }] }`. At most 20 events; each `props` at most 8 keys; whole body at most 4 KB.
- Only **app** names are accepted: `event_list_viewed`, `event_detail_viewed`, `event_saved`, `registration_started`, `checkout_quote_created`, `payment_started`, `payment_submitted`, `payment_state_seen`, `ticket_opened`, `ticket_rotated`, `invitation_resent`, `cancel_preview_viewed`, `cancel_confirmed`, `run_started`, `waitlist_cta_viewed`, `waitlist_join_started`, `waitlist_offer_opened`. Anything else is dropped.
- Dimension keys outside the allowlist are dropped; a value outside the closed set is stored as `other`; counts are bucketed by the server too (`places` 1 / 2-5 / 6+, `filters` 0 / 1 / 2+, `results` 0 / 1-5 / 6-20 / 21+). Send buckets or raw small integers; never ids, amounts, names, phones, bibs, order or registration ids.
- Events marked with an event id (`event_detail_viewed`, `event_saved`, `registration_started`, `checkout_quote_created`, payment and ticket steps, `run_started`, waitlist steps) need `props.eventId` (or top-level `eventId`) of a real, publicly visible event, else the event is dropped.
- `202 { accepted, dropped }`. `400 invalid_batch` (not an array). `413 payload_too_large { maxBytes }` or `413 too_many_events { max }`. `429 rate_limited` (60 requests and 200 events a minute per member). `401` without a member token.
- Nothing about the caller is stored. A funnel is counts of events, not people.

Dimensions per name (closed sets): `platform` android | ios | web; `availability` open | closing_soon | sold_out | closed | not_yet_open | cancelled | in_progress | completed; `saved` true | false; `source` cta | ticket_row | deep_link | other; `mode` self | others | group | team; `method` manual | mobile_money; `late` true | false; `state` pending | confirmed | rejected | expired | unknown | refunded; `scope` place | order; `cancel mode` policy | none | full.

### `GET /admin/events/health` (admin, scope `events`; 404 unless EVENTS_ANALYTICS)
Query `days` = 1 | 7 | 30 (default 1), `eventId?`.
```
{ generatedAt, rolledUpAt, periodDays, eventId,
  setup:   { flags: { module, registration, kitOps, kitOffline, waitlist, analytics, webhooks, organizerApi, results, rewards, medalArt }, payment: "none"|"manual"|"provider", retentionConfigured, alertsConfigured, consentTextVersion },
  funnel:  [{ name, count, ratioToPrevious }],                       // list views, detail views, registration starts, orders created, payments confirmed
  payments?: { manualWaiting: { count, oldestAgeHours, targetHours }, rejected, lateCases, reconciliationRequired: { count, oldestAgeHours } },   // only with scope payments
  refunds: { requestedNotPaid: { count, oldestAgeDays, targetDays }, batchesStuck },
  webhooks: { pending, oldestPendingAgeMinutes, failedLast24h, failedByClass: [{ class, count }], gaveUp, endpointsAutoDisabled },
  kit:     { confirmed, collected, exceptions, offlineDesksActive, unsentScansReported, scansToCheck },
  results: { waitingForVerification: { count, oldestAgeHours }, openDisputes: { count, oldestAgeDays }, releasesInPeriod },
  rewards: { awardTasksFailed, oldestAwardTaskAgeMinutes, redemptionsWaiting, duplicatePreventionIncidents },
  waitlist:{ waiting, offersOpen, converted, expired, promoterLastRunAt, promoterLastStatus },
  jobs:    [{ name, schedule, lastRunAt, outcome, lastSuccessAt, flagOn, late }],
  errors:  [{ group, class, count }],
  alerts:  [{ rule: "A1".."A13", subject, severity, runbook, counts }] }
```
A group that cannot be read is `{ "error": "unavailable" }` in its own slot; the rest stay. `400 invalid_days`, `404 event_not_found`, `403 acl_forbidden` without scope `events`. Numbers come from the tables; counters answer only the client funnel steps and the S7 events. `rolledUpAt` is when the roll-up last ran ("Funnel updates hourly").

Alerts fire from the same rules the `event-health-alert` job emails to `OPS_ALERT_EMAILS` (unset: shown here only). Rules: A1 manual payment overdue, A2 refund overdue, A3 reconciliation required, A4 webhook backlog, A5 job late, A6 awards stuck, A7 waitlist stuck, A8 offline debt, A9 invalid-token burst, A10 5xx rising (daily counter), A11 reward duplicate prevented, A12 dispute aging, A13 retention not set.

### Jobs
`event-analytics-rollup` (hourly; reads the existing `analytics.%` audit rows once, with a 2 minute lag, then purges counters older than `EVENTS_ANALYTICS_KEEP_DAYS`), `event-health-alert` (every 15 minutes). Both return `skipped: "flag_off"` while `EVENTS_ANALYTICS` is off. Event jobs are hidden from the admin job list while `EVENTS_MODULE` is off (H15).

## A. Offline kit desk (B1)
Flag `EVENTS_KIT_OFFLINE` (needs `EVENTS_KIT_OPS`). `GET /events/options` -> `ops.kitOffline` is true only when the flag is on **and** the ticket secret is usable. All organizer routes are under `/organizer/events/:id/kit-offline`, JWT of an organizer staff user. A suspended organizer can read and **send** but not prepare or scan new tickets. Sync never needs a flag-off fallback: with the flag off every route is `404 feature_disabled`.

A **desk** is a registry row, not a credential: every call still uses the staff member's normal sign-in. Only the staff user that prepared a desk can download its list, heartbeat for it or sync for it (anyone else, even an admin, gets `404 device_not_found`).

| Route | Roles | Body / query | Success | Errors |
|---|---|---|---|---|
| `POST /devices` | owner admin ops | header `Idempotency-Key`; `{ label (1-40), clientKind: "web", deskBuild, bibRange?: { prefix?, padTo?, start, end } }` (`bibRange` owner/admin only) | `201 { device: { id, label, status, issuedAt, expiresAt, bibRange \| null }, warnings?: [{ code: "range_contains_assigned", count }], limits: { sessionHours, maxPending, clockToleranceSeconds, syncBatch }, serverTime }` | `409 device_limit_reached { limit: "event"\|"user", max, desks? }`, `409 bib_range_overlap { with }`, `422 bib_range_invalid { reason }`, `409 event_not_open`, `409 kit_not_provided`, `403 forbidden_role`, `403 organizer_suspended`, `426 desk_update_required { minBuild }` |
| `GET /devices` | owner admin (all) / ops (own) | `?status` | `{ items: [{ id, label, status, bibRange, bibsRecorded, bibExceptions, staffFirstName, issuedAt, expiresAt, lastSyncAt, lastHeartbeatAt, pendingReported, discardedReported, snapshotRows, snapshotSeq, deskBuild }] }` | |
| `POST /devices/:deviceId/revoke` | owner admin | header `Idempotency-Key`; `{ reason (10-300), reasonSw? (10-300) }` | `200 { device }` | `404 device_not_found`, `409 already_ended`, `422 reason_required` |
| `GET /snapshot` | owner admin ops (own desk) | `?deviceId&cursor&limit(<=1000)&sinceSeq&categoryId&deskBuild` | `200 { header: { snapshotSeq, takenAt, serverTime, validUntil, sinceSeq?, event: { status, timezone, kitProvided }, collectionPoints[], categories[], rowCount }, rows[], removed[], nextCursor }` | `403 device_not_active { deviceStatus }`, `404 device_not_found`, `413 snapshot_too_large { rows, max }`, `426`, `429` |
| `POST /heartbeat` | owner admin ops | `{ deviceId, pending, oldestPendingAt, discarded, deskBuild, clockOffsetMs }` | `200 { serverTime, deviceStatus: "active"\|"revoked"\|"expired", minDeskBuild }` | `404`, `426`, `429` |
| `POST /sync` | owner admin ops | `{ deviceId, batchId, snapshotSeq, snapshotTakenAt, clockOffsetMs, deskBuild?, items: [{ clientRef (uuid), method: "scan"\|"manual", payload?, registrationId?, manualReason?, collectionPointId?, kitSize?, bibNumber?, claimedAt, outcomeOnDevice? }] }` (<= 200 items) | `200 { results: [{ clientRef, outcome, replayed?, registrationId?, collectionId?, bib?: { outcome, number? }, warnings[], reviewId?, card? }], summary: { accepted, duplicate, needsReview, bibExceptions, rejected, deferred }, serverTime, deviceStatus, minDeskBuild }` | `400 invalid_batch`, `404 device_not_found`, `413 too_many_items { max }`, `426`, `429 rate_limited` (30 a minute per user), `503 tickets_unavailable` |
| `GET /review` | owner admin | `?status=needs_review\|checked\|manual&cursor&limit` | `{ items: [{ id, outcome, bibOutcome?, bibClaimed?, card: { displayName, categoryName, bibNumber } \| null, deviceLabel, deviceTime, receivedAt, winner?: { collectedAt, method, deviceLabel? }, reviewStatus, note?, method, manualReason?, warnings[] }], nextCursor, counts: { needsReview, checked } }` | |
| `POST /review/:scanId/check` | owner admin | header `Idempotency-Key`; `{ note? }` (required 10-300 for `revoked_after_scan`) | `200 { review: { id, reviewStatus: "checked", checkedAt, note? } }` | `404 scan_not_found`, `409 not_in_review`, `422 note_required` |

Admin (scope `events`, flag `EVENTS_KIT_OFFLINE`): `GET /admin/events/:id/kit-offline` -> `{ items: [desk], counts: { needsReview, checked } }`; `POST /admin/events/:id/kit-offline/devices/:deviceId/revoke { reason, reasonSw? }` -> `{ device }`.

`GET /organizer/events/:id/kit/summary` gains `offline: { desks, pendingReported, needsReview }` only while the flag is on.

**Snapshot rows** (never a token, a MAC, or contact data): `{ registrationId, tokenHash (sha256 hex of the ticket token), ticketCode, name ("Amina M."), categoryId, bibNumber, kitSize, ticket: "active"\|"revoked", revokeReason?, kit: "collected"\|"not_collected", collectedAt?, collectionPointName? }`. `removed` lists registration ids that left the list. A delta (`sinceSeq`) returns only registrations changed since that outbox sequence; `snapshotSeq` is the high-water mark read before the rows (rows may be newer than it; replaying a delta is safe). Offline the desk looks up `sha256(scanned token)`; the server re-verifies everything at sync.

**Sync outcomes:** `accepted` (collection written, method `offline`), `duplicate` (a kit was already collected: online, or another desk synced first; review), `revoked_after_scan`, `event_closed` (cancelled or archived), `after_revoke` (desk removed before the scan; review), `organizer_suspended` (review), `invalid_token` (not a token / MAC or hash mismatch), `unknown_ticket`, `wrong_event`, `validation_failed` (counted, not queued), `deferred` (not stored: send again). An item whose `clientRef` is not 8 to 64 of A-Z a-z 0-9 - cannot be stored and is answered `validation_failed` without `reviewId`. The device clock is never trusted: the time is corrected by `clockOffsetMs`, clamped to [list time - tolerance, received + tolerance] and flagged `clock_adjusted`; a kit is never refused because of a clock.

**Offline bib recording:** the number is a claim, applied only after the handover committed, in a savepoint: `assigned`, `same_already`, `not_applied` (the scan was not accepted), `format_invalid`, `out_of_range` (outside the desk's block), `no_range` (the desk has no block), `taken`, `registration_has_other`. Anything but `assigned` / `same_already` puts the accepted scan into review (a "bib exception") and counts in `summary.bibExceptions`. The kit stands in every case. An existing bib is never replaced offline.

Webhooks: no new type; `kit.collected` and `bib.assigned` fire once per accepted item at sync time. Notices: `event_kit_collected` to the participant at sync, `organizer_kit_desk_removed` to the staff user, `organizer_kit_offline_invalid_burst` (essential) to owners and admins when one batch has more than 20 `invalid_token` items.

Jobs: `event-kit-offline-purge` (daily 23:30 UTC). Env: `EVENTS_OFFLINE_SESSION_HOURS` 36, `EVENTS_OFFLINE_MAX_DEVICES` 10, `EVENTS_OFFLINE_MAX_PER_USER` 2, `EVENTS_OFFLINE_MAX_ROWS` 20000, `EVENTS_OFFLINE_SYNC_BATCH` 200, `EVENTS_OFFLINE_MAX_PENDING` 2000, `EVENTS_OFFLINE_CLOCK_TOLERANCE_SECONDS` 300, `EVENTS_OFFLINE_MIN_DESK_BUILD` (unset; an integer build number), `EVENTS_OFFLINE_SCAN_KEEP_DAYS` 180, `EVENTS_OFFLINE_MAX_BIB_RANGE` 5000.
## B. Waitlist (B2) (pending)
## D. Hardening (B4) (pending)
