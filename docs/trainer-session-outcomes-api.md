# Trainer session outcomes (Phase B · B1a) — API contract

Flag: `TRAINER_SESSION_OUTCOMES` (off by default). Times are East Africa Time; a session starts at `date` + `slot`.

## Always on (not behind the flag)

`POST /trainer/bookings/:id/complete` (trainer) now refuses a session that has not started:

| Status | Body | When |
|---|---|---|
| 200 | the booking, `status: "completed"` | confirmed and started |
| 404 | `{ error: "trainer_profile_not_found" }` / `{ error: "booking_not_found" }` | not this trainer's booking |
| 409 | `{ error: "booking_not_confirmable" }` | not `confirmed` (unchanged) |
| 409 | `{ error: "session_not_started", startsAt }` | **new**: before the start (`startsAt` ISO) |
| 400 | `{ error: "invalid_booking_time" }` | **new**: the booking's date/slot cannot be read |
| 409 | `{ error: "booking_on_trainer_statement", statementId, statementStatus }` | **new**: on a submitted/approved/payable/paid statement |
| 409 | `{ error: "booking_changed" }` | **new**: changed by someone else at the same moment (retry by reloading) |

Each completion writes an audit row (`trainer_booking_completed_by_trainer`). The status change is one
locked, conditional write; a draft statement line for the session is re-based in the same transaction.

Admin (`POST /admin/trainer-bookings/:id`), flag or not: a **cancelled** booking is final — moving it to
any other status is `409 { error: "booking_cancelled" }` (its refund may already be raised and the slot booked again).

Booking (`POST /me/trainer-bookings`, `/quote`), flag or not: a trainer cannot book their own sessions, from
the same account or another account of the same person — `403 { error: "cannot_book_own_sessions" }`.

Statements: submitting a trainer statement whose session no longer pays on the basis it was prepared on is
`409 { error: "stale_statement_lines", lines: [{ bookingId, basis, bookingStatus, payableBasis }] }`;
preparing the week again rebuilds the draft.

## Flag on

### `POST /trainer/bookings/:id/no-show` (trainer)

| Status | Body | When |
|---|---|---|
| 200 | the booking, `status: "no_show"`, with `actions` | confirmed, started, ≤ 48h after the start |
| 404 | `{ error: "feature_disabled" }` | flag off |
| 404 | `{ error: "trainer_profile_not_found" \| "booking_not_found" }` | not this trainer's booking |
| 409 | `{ error: "booking_not_confirmed" }` | not `confirmed` |
| 409 | `{ error: "session_not_started", startsAt }` | before the start |
| 409 | `{ error: "no_show_window_passed", closedAt }` | more than 48h after the start |
| 400 | `{ error: "invalid_booking_time" }` | date/slot cannot be read |
| 409 | `{ error: "booking_on_trainer_statement", statementId, statementStatus }` | on a submitted/approved/payable/paid statement |
| 409 | `{ error: "booking_changed" }` | changed concurrently |

Effects: audit row `trainer_booking_no_show`; the member gets inbox/push `type: "trainer_booking_no_show"`
(also when an admin sets `no_show`). Title/body are in the member's `CommunicationPreference.locale`
(`sw` → Swahili; `en` or none saved → English). `data: { bookingGroupId, trainerId, bookingId, locale, titleEn,
bodyEn, titleSw, bodySw }`. Swahili is a draft for native review.
The trainer is paid in full (statement line basis `no_show`); the member is not refunded; a sponsor
trainer benefit is used as if the session took place (so the member's `sponsor_paid` refund is raised
exactly as for a completed session). The member can still review the trainer.

### `POST /admin/trainer-bookings/:id` (admin, `trainers` ACL)

`{ status }` may also be `no_show`:

- `no_show` only from `confirmed` or `completed` (409 `{ error: "invalid_transition", from }`), only after
  the start (409 `session_not_started`; 400 `invalid_booking_time`). No 48h limit for admins.
- `no_show → completed | cancelled` and `completed → no_show` follow the existing rules (cancelling a paid
  session raises a `cancelled_by_fitflex` refund, as for a completed one). Nothing leaves `cancelled`.
- A draft statement line follows the change in the same transaction: re-based, or removed (and the draft's
  totals recomputed; an emptied draft is deleted).
- Any status change to a session on a `submitted`, `approved`, `payable` or `paid` trainer statement:
  409 `{ error: "booking_on_trainer_statement", statementId, statementStatus }` — **flag on or off**. A draft does not lock.
- One admin is enough. Flag off: `no_show` is 400 `invalid_status`.
- A change that races a statement being prepared, or a database deadlock, answers 409 `booking_changed`
  (nothing was written; reload and retry).

### `actions` on every booking

Present only when the flag is on, on `GET /trainer/bookings`, `GET /me/trainer-bookings`,
`GET /trainer/sessions` (on each `sessions[i]` with `source: "booking"`; manual sessions have none),
`GET /admin/trainer-bookings`, and the bookings returned by complete, no-show, admin update and the
cancel endpoints: `actions: { canComplete: boolean, canMarkNoShow: boolean }` — what **the caller** may do now.

- Trainer: `canComplete` = confirmed and started; `canMarkNoShow` = confirmed, started, within 48h.
- Member: always both `false` (members do not record outcomes).
- Admin: `canComplete` = `confirmed` or `no_show`; `canMarkNoShow` = `confirmed` or `completed` and started;
  both `false` once on a submitted/approved/payable/paid statement.

Show the buttons from `actions`; do not compute windows on the device. Treat a missing `actions` as "flag off".

## Payment approval of a booking group

Approving (or otherwise deciding) a group's payment moves its sessions with it, except: `completed` /
`no_show` sessions stay; a **cancelled** session stays cancelled (it was dropped and the payment shrunk);
a `payment_rejected` session follows a changed decision unless its slot has been booked by someone else since.

## Reconciliation (read-only)

`node scripts/trainer-outcome-reconcile.mjs [--json]` compares booking outcomes with sponsor usage, live
refunds and statement lines and prints each mismatch (count + up to 50 booking ids). It runs in a READ ONLY
transaction and changes nothing; exit code 2 when something is found. Checks: `sponsor_usage_without_outcome`,
`sponsored_outcome_without_refund`, `outcome_with_member_refund`, `cancelled_on_statement`,
`cancelled_paid_without_refund`, `released_usage_still_happened`.
