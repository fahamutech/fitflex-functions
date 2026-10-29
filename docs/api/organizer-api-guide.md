# FitFlex Organizer API — guide

For timing, registration and kit-desk systems that work with a FitFlex event organizer. The contract is `organizer-api-v1.openapi.json` (also served at `GET /v1/organizer/openapi.json`); webhooks are in `organizer-webhooks.md`.

**Status:** dormant. Nothing here is live until FitFlex switches `EVENTS_ORGANIZER_API` on and enables your organizer account. The legal terms for API use are still a draft pending Tanzanian counsel; there are no API terms of use yet.

## What you get, and what you never get

You can read registrations of your own events (name, category, status, bib, kit state, kit size, team and group labels), follow changes, record kit handovers and assign bib numbers. With the explicit `registrations:demographics` scope you also get gender and age on event day.

You **never** receive participant phone numbers, email addresses, dates of birth, emergency contacts or payer and payment details. Reach people through FitFlex notices.

## 1. Get a client

In the organizer portal, **Integrations → API clients → New API client** (owner or admin). Choose **Test** first. The secret is shown **once**: copy it into your secret store. FitFlex keeps only a hash, and cannot show it again; if you lose it, rotate.

* `clientId` looks like `ffc_0123456789abcdef`; the secret like `ffs_test_…` or `ffs_live_…` (the prefix lets secret scanners find a leak).
* Scopes: `registrations:read`, `registrations:demographics`, `kit:write`, `bibs:write`, `webhooks:manage` (only the organizer owner can grant this one).
* A client expires (default 365 days, at most 730). Rotate before then: **Rotate** gives a new secret and keeps the old one working for 24 or 72 hours so you can switch without downtime.

## 2. Get a token

```
curl -s -X POST "$BASE/v1/organizer/token" -H 'Content-Type: application/json' \
  -d '{"grant_type":"client_credentials","client_id":"ffc_…","client_secret":"ffs_test_…"}'
→ { "access_token": "…", "token_type": "Bearer", "expires_in": 900 }
```

HTTP Basic (`client_id:client_secret`) also works. This is the **only** request that carries the secret. Every failure is the same `401 {"error":"invalid_client"}` whether the id is unknown, the secret wrong, or the client revoked or expired. Wrong secrets are rate-limited (10 a minute per client id, 20 per source address; only failures are counted, so a valid exchange is never blocked) but a client is never locked out; the organizer owner is told when a client has many failures in an hour.

Send `Authorization: Bearer <access_token>` on everything else and fetch a new token a minute before it expires. Scopes, revocation and expiry are checked on **every** call, so a revoked client stops working at once even with an unexpired token.

## 3. Read

```
curl -s "$BASE/v1/organizer/events" -H "Authorization: Bearer $TOKEN"
curl -s "$BASE/v1/organizer/events/$EVENT/registrations?limit=200" -H "Authorization: Bearer $TOKEN"
```

Lists use `limit` (1–200, default 50) and an opaque `cursor`; the answer is `{ items, nextCursor }` and `nextCursor` is `null` on the last page.

## 4. Follow changes (the sync loop)

```
GET /v1/organizer/events/{eventId}/registration-changes?cursor=…&limit=100
→ { "items": [{ "seq", "id", "eventType", "registrationId", "changedAt", "status", … }], "nextCursor": "…", "hasMore": false }
```

1. First run: page through `GET …/registrations` and store everything; then call the feed **without** a cursor and keep the `nextCursor` it returns.
2. Loop: call the feed with your saved cursor; apply each item (look up the registration with `?expand=registration` or `GET /v1/organizer/registrations/{id}`); save `nextCursor`; if `hasMore` is true call again at once, else wait a few seconds.
3. `nextCursor` is returned even when nothing is new (the same position), so you can always save it.
4. The feed only serves rows older than 5 seconds (`EVENTS_FEED_LAG_SECONDS`) so a slow transaction never commits "behind" you. **Dedupe on the item `id`**: you may see an item twice if you overlap cursors, and that is safe.
5. A cancelled place is a tombstone: `status: "cancelled"`, a `reasonCode`, and no names afterwards.
6. `410 cursor_expired` (older than 90 days): do a full resync with `GET …/registrations?updatedSince=<ISO time>` and start a new feed.

## 5. Write: kit handovers and bibs

Every write needs `Idempotency-Key: <8–100 characters>`. Retry with the **same** key after a timeout: you get the original answer (`200` with `Idempotent-Replayed: true`) and nothing is written twice. The same key with a different body is `409 idempotency_key_reused`.

```
POST /v1/organizer/events/{eventId}/kit-collections
{ "method": "scan", "payload": "FFEV1:…", "collectionPointId": "ecp_…" }
→ 201 { "collection": {…}, "card": { "displayName": "Amina M.", … }, "warnings": [] }
```

A second handover for the same registration is `409 already_collected` with the time, point and first name of the first one. `bibs:write` can assign one bib (`POST …/bib-assignments`) or up to 500 (`POST …/bib-assignments/batch`, each item answered on its own). A bib number is unique across the **whole event** (`409 bib_taken`); use a prefix (`5K-001`) for per-distance ranges.

## 6. Errors, limits, headers

Errors are `{ "error": "<code>", …extra }`. Every response has `X-Request-Id`; quote it to support. Common codes: `invalid_token`, `token_expired`, `insufficient_scope` (with `requiredScope`), `client_expired`, `organizer_suspended`, `api_access_not_enabled`, `event_not_found` (also for an event of another organizer or one outside your client's list), `invalid_cursor`, `invalid_limit`, `cursor_expired`, `idempotency_key_required`, `bib_taken`, `already_collected`, `rate_limited`.

Each client may make at least 120 calls a minute (an admin can raise it to 600); beyond that you get `429` with `Retry-After` and `retryAfterSeconds`. Limits are per server, so treat the figure as "at least". On the token route, wrong secrets are limited to 20 a minute per source address.

## 7. Sandbox

A **Test** client sees one built-in event, `evt_sandbox`, with three categories, two collection points and 25 clearly fake registrations ("Test Runner 01" … no contact data). Reads return that data. Writes are validated and answered as if applied (a repeated handover is `409 already_collected`) but **nothing is saved**. Responses carry `X-FitFlex-Sandbox: true`. In the sandbox a scan payload is `FFEV1:sandbox-NN` (NN = 01…24) and manual handovers use `ereg_sandbox_NN`. A sandbox client cannot reach real data and cannot hold `webhooks:manage`.
