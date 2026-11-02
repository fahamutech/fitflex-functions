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
waitlist:  { enabled, offerHours, maxActivePerUser }     // EVENTS_WAITLIST
ops:       { kit, api, webhooks, kitOffline }            // kitOffline: EVENTS_KIT_OFFLINE and a usable ticket secret
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
## B. Waitlist (B2)
Flag `EVENTS_WAITLIST` (needs `EVENTS_MODULE` and `EVENTS_REGISTRATION`). Off: every route below is `404 feature_disabled`, ticket types carry **no** `waitlist` key, nothing gates a purchase.

**Model.** One signed-in member, one place, for themselves, in one sold-out ticket type, with a verified phone or email (D70). Waiting costs nothing and holds nothing. Strict first in, first offered per ticket type (database sequence). When a place opens the server creates a **normal order** (`awaiting_payment`) for the head of the line from the details given at joining; from there it is the existing S3/S4 flow (hold timer, manual payment, 24 h confirmation, refund rules). The hold is the **offer window**: `clamp(hours until registration closes / 4, 2 h, EVENTS_WAITLIST_OFFER_HOURS)`, never past the close; no offers inside the last `EVENTS_WAITLIST_MIN_OFFER_MINUTES` (120) and none in quiet hours (21:00 to 07:00 event time, `EVENTS_WAITLIST_QUIET_HOURS`, `off` disables). The app counts down from `serverTime` and the order's `holdExpiresAt`, never the phone clock.

**Queue gate.** While a ticket type has a `waiting` or `offered` entry, creating any other order for it answers `409 waitlist_active { ticketTypeId }`, and the ticket type reads `availability: "sold_out"` even when a place is free (so old app builds show "Sold out"). New builds read `waitlist.state`.

Additive reads:
- `GET /events/:id` (and `GET /events/:id` ticket types): event `waitlist: { enabled }`; each ticket type `waitlist: { state: "none" | "open" | "closed" }` (`open`: a member can join or is queued; `closed`: sold out but new sign-ups are stopped or the line is closed; `none`: nothing to wait for, or the waitlist cannot work now, for example payments are off for a priced ticket).
- `GET /events/options`: `waitlist: { enabled, offerHours, maxActivePerUser }`.
- `GET /me/event-orders`: each row gains `source: "waitlist" | null` (key absent while the flag is off).

Member (JWT `member`):

| Route | Body | Success | Errors |
|---|---|---|---|
| `POST /me/events/:id/waitlist` | `{ ticketTypeId, participants: [one self participant exactly as the checkout takes it], consent: { accepted: true, textVersion }, locale? }` | `201 { entry: { id, status: "waiting", position, ticketTypeId, ticketTypeName, categoryName, priceTzs, currency, joinedAt } }` | `404 event_not_found`, `409 not_sold_out`, `409 waitlist_unavailable { reason: registration_closed \| waitlist_closed \| sale_closed \| payments_unavailable }`, `409 already_registered`, `409 waitlist_full`, `409 waitlist_limit_reached { max }`, `409 waitlist_lapse_limit`, `403 verification_required`, `422 validation_failed { fields }`, `422 consent_required { current }`, `429 rate_limited` (10 joins an hour) |
| `GET /me/event-waitlist` | | `{ items: [{ id, eventId, eventTitle, startsAt, timezone, ticketTypeName, categoryName, status, position?, joinedAt, blockedReason?, offer?: { orderId, expiresAt, amountTzs, currency }, endedAt?, endedReason? }], serverTime }` (`status`: waiting offered converted expired declined left removed closed; the queue length is never sent) | |
| `DELETE /me/event-waitlist/:id` | | `200 { entry: { id, status } }` (`left`, or `declined` for an offered entry, which cancels its held order) | `404 entry_not_found`, `409 already_ended`, `409 payment_pending` |
| `POST /me/event-waitlist/:id/reconfirm` | `{ consent: { accepted: true, textVersion } }` | `200 { entry: { id, status, position } }` | `409 not_blocked`, `422 consent_required` |

`blockedReason: "reconsent"`: the consent text changed after joining; the entry keeps its place but is skipped until the member reconfirms.

Organizer (JWT; `/organizer/events/:id/waitlist`): `GET` (owner admin ops finance; a suspended organizer may read) -> `{ enabled, closedAt, byTicketType: [{ ticketTypeId, name, waiting, offered, converted, expired, left }], totals }` (**counts only**: no names, no positions, no promote or reorder). `PATCH { enabled }` (owner admin, active organizer) stops or resumes **new** sign-ups -> `{ enabled, closedAt: null }`, `409 waitlist_closed` after a close. `POST …/waitlist/close` (owner admin) ends the line for good, tells everyone waiting, leaves offers already made to run out -> `{ enabled: false, closedAt, closed }`.

Admin (scope `events`): `GET /admin/events/:id/waitlist?ticketTypeId&status&cursor&limit` -> `{ items: [{ id, seq, status, ticketTypeId, joinedAt, name: "Amina M." }], nextCursor }` (no contact data). `POST /admin/events/:id/waitlist/:entryId/remove { reason (10-300), reasonSw? (10-300) }` -> `{ entry: { id, status: "removed" } }`; an offered entry cancels its unpaid order (`409 payment_pending` if a payment is waiting for a decision).

Notices (server strings `{en, sw}`; type -> deep link): `event_waitlist_joined` (in-app only), `event_waitlist_offer` -> `/member/events/orders/<orderId>`, `event_waitlist_offer_reminder` (one hour left) -> same, `event_waitlist_offer_expired`, `event_waitlist_closed`, `event_waitlist_removed` -> `/member/events/waitlist`. The offer replaces the usual "registration received" notice for the order.

Jobs: `event-waitlist-promote` (every minute: reconcile converted / expired / declined, send reminders, end entries whose sale closed, offer freed places; also nudged right after a hold expires) and `event-waitlist-purge` (daily 23:15 UTC: stored details cleared 24 h after an entry ends, ended rows deleted after `EVENTS_WAITLIST_KEEP_DAYS`). A late payment after the offer expired follows the S4 re-reserve-or-refund rule and has no priority over the line. Env: `EVENTS_WAITLIST_OFFER_HOURS` 12, `EVENTS_WAITLIST_MIN_OFFER_MINUTES` 120, `EVENTS_WAITLIST_MAX_ACTIVE_PER_USER` 5, `EVENTS_WAITLIST_MAX_QUEUE` 500, `EVENTS_WAITLIST_MAX_LAPSES` 2, `EVENTS_WAITLIST_QUIET_HOURS` `21-7`, `EVENTS_WAITLIST_KEEP_DAYS` 90.

Order create (`POST /me/event-orders`, additive errors): `409 waitlist_active { ticketTypeId }`, `409 unpaid_places_limit { limit }` (H5, see D).
## D. Hardening (B4)
Ride on the flag of the feature each fixes; no new flag. With every S7 flag off, behaviour is S6 plus the fixes below.

| ID | Route / behaviour | Shape |
|---|---|---|
| H1 | webhook dispatcher | at most `EVENTS_WEBHOOK_PER_HOST_BATCH` (5) deliveries per receiving host per claim; leases returned at once when the run's time budget is spent. No API change. |
| H2 | kit and bib writes | after the transaction commits, a failing card read, notice or analytics cannot fail the request. `POST …/kit-collections` may answer `201` with `card: null`; a retry with the same key returns the original answer (`200`, `Idempotent-Replayed: true`), never `already_collected`. |
| H3 | outbox retention | rows older than 90 days are deleted whether published or not (batches of 5,000). A feed cursor older than 90 days is already `410 cursor_expired`. |
| H4 | `POST /organizer/webhook-endpoints/:id/redeliver` (owner only, `EVENTS_WEBHOOKS`) | `{ from, to, types? }` -> `200 { queued, scanned }`. At most 7 days and 5,000 events; 3 requests an hour per organizer (`429 rate_limited`); only that organizer's events; same event ids. `409 endpoint_not_active`, `422 range_too_large { maxDays } \| too_many_events { max } \| validation_failed`. |
| H5 | `POST /me/event-orders` | `409 unpaid_places_limit { limit }`. Interpretation (see PR): a member's FIRST concurrent unpaid order is never limited here; a further concurrent unpaid order must fit, with what is already held, under `EVENTS_MAX_UNPAID_PLACES_PER_USER` (4). Organisation orders exempt. A waitlist offer that hits it is skipped, not dropped. |
| H6 | `POST /admin/events/:id/rewards-eligible` (scope `events`, `EVENTS_REWARDS`) | `{ eligible: boolean, reason (10-300), reasonSw? }` -> `{ rewardsEligible, changed }`. Default **false**: medals are awarded either way, rewards are earned only while true. `GET /admin/events/:id` gains `rewardsEligible` and `waitlist: { waiting, offered }`. Organizer owners and admins are told. |
| H7 | job `event-organizer-status-sweep` (hourly) | no API. Corrections audited as `events.organizer_status_corrected`. |
| H8 | event submit | `422` validation code `timezone` unless the zone is one of `GET /events/options.timezones`. |
| H9 | `POST /me/event-orders/quote` and `POST /me/event-orders` with `team.joinCode` | share the team lookup limiter (30 an hour per member): `429 rate_limited`. |
| H10 | `GET /admin/events/results/disputes` (scope `events`, `EVENTS_RESULTS`) | `?status=open\|upheld\|rejected\|withdrawn&olderThanDays&organizerStatus&cursor&limit` -> `{ items: [{ id, eventId, eventTitle, organizerName, organizerStatus, openedAt, ageDays, status, adminMayResolve }], nextCursor, counts: { open, olderThan7Days, organizerInactive } }`. Resolve with the existing `POST /admin/events/:id/results/disputes/:disputeId/resolve`. |
| H11 | `GET /admin/reward-redemptions` (scope `events`, `EVENTS_REWARDS`) | `?status&cursor&limit` -> `{ items: [{ id, person ("Amina M."), reward: { en, sw }, redeemMode, codeState, claimedAt, redeemedAt, expiresAt, needsReview }], nextCursor }`. Never a code, hash or user id. |
| H12 | `POST /organizer/events/:id/results/:resultId/correct/preview` (owner admin, `EVENTS_RESULTS`) | body as `…/correct`; no `Idempotency-Key`. `200 { revision, rankBefore: { overall, category }, rankAfter: { overall, category }, othersShifted, medalsAffected }`. Nothing is stored. Same errors as `…/correct`. |
| H13 | `GET …/medal-templates` | each template's `art` gains `status: "live" \| "taken_down" \| "none"` and, for a taken-down design with no live replacement, `takedown: { reasonCode, at }`. |
| H14 | `GET /events/options` | `payments: { blockedReason: null \| "second_approver_off" \| "no_ticket_secret" \| "flag_off" }`. |
| H15 | admin job list | event jobs are hidden while `EVENTS_MODULE` is off. |
| H16 | `POST /admin/events/:id/registration-state` (scope `events`, `EVENTS_MODULE`) | `{ state: "closed" \| "open", reason (10-300), reasonSw? }` -> `{ eventStatus: "registration_closed" \| "published", from }`. `409 invalid_transition \| registration_window_over`. Organizer notified (essential). |
| H17 | `GET /admin/events/organizers` (scope `events`) | `?q&apiAccess=true\|false&cursor&limit` -> `{ items: [{ id, name, status, apiAccessEnabled, activeClients, activeEndpoints }], nextCursor }`. |

**Retention (ships unset).** Job `event-registration-anonymise` (daily 01:10 UTC). `EVENTS_RETENTION_MONTHS` unset (and `EVENTS_DELETED_USER_ANONYMISE_DAYS` unset) = it does nothing and writes nothing; the Health tab shows `setup.retentionConfigured: false`. When set it clears phone, email, date of birth, gender, emergency contact and claim token data of registrations of events completed, cancelled or archived more than N months ago, keeps first name, last name (the board shows an initial), bib, kit and results, once per registration (`EventRegistration.anonymisedAt`), with one audit row per run.

**Consent text.** Default `EVENTS_CONSENT_TEXT_VERSION` is now `2026-11-draft`: the draft states what the organizer receives (name, race category, ticket type, bib, kit size, kit collection status) and that phone, email, date of birth, gender and emergency contact are kept by FitFlex. Clients must read `consentText` from the quote as before and send `consentTextVersion` back; a waitlist entry made under an older version shows `blockedReason: "reconsent"`. The wording is a proposal for counsel; Swahili needs native review (TODO(sw-review)). `EVENTS_RESULTS_CONSENT_VERSIONS` must list every version that carries the public-results clause.

**New notification types** (all `{en, sw}` inline): `organizer_registration_paused`, `organizer_registration_resumed`, `organizer_rewards_eligibility_changed`, `organizer_kit_desk_removed`, `organizer_kit_offline_invalid_burst`, and the waitlist set in B.

**New env (all optional, defaults in parentheses):** `EVENTS_ANALYTICS_KEEP_DAYS` (730), `EVENTS_ALERT_RULES` (JSON overrides, e.g. `{"A1":{"hours":12}}`), `OPS_ALERT_EMAILS` (existing), `EVENTS_WEBHOOK_PER_HOST_BATCH` (5), `EVENTS_MAX_UNPAID_PLACES_PER_USER` (4), `EVENTS_RETENTION_MONTHS` (unset), `EVENTS_DELETED_USER_ANONYMISE_DAYS` (unset), and the offline and waitlist variables listed in A and B. **Migrations:** `20270202090000-events-analytics-s7`, `…090100-events-kit-offline-s7`, `…090200-events-waitlist-s7`, `…090300-events-hardening-s7` (additive; down fails closed once data exists).
