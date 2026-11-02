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

## A. Offline kit desk (B1) (pending)
## B. Waitlist (B2) (pending)
## D. Hardening (B4) (pending)
