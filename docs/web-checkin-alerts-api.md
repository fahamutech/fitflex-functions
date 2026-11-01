# Browser check-in security alert (S3) - API contract

Flags: `WEB_QR_CHECKIN` (S2, must be on), `WEB_CHECKIN_ALERTS` (this slice, default off; effective only while WEB_QR_CHECKIN is on), `PUSH_NOTIFICATIONS=on` for the phone push. Launch gate: keep WEB_CHECKIN_ALERTS off until the app's security-activity screen (S4) is live.

## POST /me/web-checkins (confirm) - new field
`alertQueued: boolean`. True only when this call recorded a NEW visit, both flags are on and the member has at least one registered device token. False on idempotent repeats and in every other case. It does not wait for the push.

## GET /me/security-activity?limit=&before=
Member or trainer; 404 `{ error: "not_found" }` while WEB_QR_CHECKIN is off. `Cache-Control: no-store`.
`{ events: [{ id, kind: "web_checkin", occurredAt (ISO), gym: { id, name }, channel: "web", status: "notified" | "recorded" }], next? }`
Newest first, caller's own rows only, limit default 20 / max 50. Pass `next` back as `before`. Bad `before` gives 400 `invalid_before`. `gym.id` is the Gym id (the same `id` the member gym APIs return). `name` is the snapshot taken at check-in time.

## Notification
Inbox type `web_checkin_recorded`, id `ntf_wchk_<checkinId>` (once per check-in). Title/body in the member's language (CommunicationPreference.locale `sw`, else English); both languages are in `data` (`locale, titleEn, bodyEn, titleSw, bodySw`) with `eventId, gymId, open: "security_activity"`. Phone push data is ONLY `{ type, notificationId, eventId, gymId, open: "security_activity" }`. Time is shown in Africa/Dar_es_Salaam from the check-in instant. Swahili is a draft for native review.

## Data
Table `SecurityEvent` (migration 20270130090000): id, userId (FK User, cascade), kind ('web_checkin'), checkinId, gymId, occurredAt, businessDate, channel, notifiedAt, notifyState ('queued'|'none'), details { gymName }, createdAt. No IP, user agent, client meta, session or intent id. Retained 13 months (daily job `securityEventRetention`, 02:55 UTC, runs while WEB_QR_CHECKIN is on).
