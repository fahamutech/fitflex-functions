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

Each completion writes an audit row (`trainer_booking_completed_by_trainer`).

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

Effects: audit row `trainer_booking_no_show`; the member gets inbox/push `type: "trainer_booking_no_show"`
(`data: { bookingGroupId, trainerId, bookingId, titleSw, bodySw }`; Swahili is a draft for native review).
The trainer is paid in full (statement line basis `no_show`); the member is not refunded; a sponsor
trainer benefit is used as if the session took place (so the member's `sponsor_paid` refund is raised
exactly as for a completed session). The member can still review the trainer.

### `POST /admin/trainer-bookings/:id` (admin, `trainers` ACL)

`{ status }` may also be `no_show`:

- `no_show` only from `confirmed`, `completed` or `cancelled` (409 `{ error: "invalid_transition", from }`),
  and only after the start (409 `session_not_started`). No 48h limit for admins.
- `no_show → completed | cancelled` and back follow the existing rules (cancelling a paid session raises a
  `cancelled_by_fitflex` refund, as for a completed one).
- Any status change to a session on a `submitted`, `approved`, `payable` or `paid` trainer statement:
  409 `{ error: "booking_on_trainer_statement", statementId, statementStatus }`. A draft does not lock.
- One admin is enough. Flag off: `no_show` is 400 `invalid_status` and there is no statement lock (as before).

### `actions` on every booking

Present only when the flag is on, on `GET /trainer/bookings`, `GET /me/trainer-bookings`,
`GET /admin/trainer-bookings`, and the bookings returned by complete, no-show, admin update and the
cancel endpoints: `actions: { canComplete: boolean, canMarkNoShow: boolean }` — what **the caller** may do now.

- Trainer: `canComplete` = confirmed and started; `canMarkNoShow` = confirmed, started, within 48h.
- Member: always both `false` (members do not record outcomes).
- Admin: `canComplete` = `confirmed` or `no_show`; `canMarkNoShow` = `confirmed` or `completed` and started;
  both `false` once on a submitted/approved/payable/paid statement.

Show the buttons from `actions`; do not compute windows on the device. Treat a missing `actions` as "flag off".
