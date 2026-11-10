# Report an unrecognised web check-in (S4b) - API contract

Flag: `SECURITY_INCIDENT_REPORTS` (default off; effective only while `WEB_QR_CHECKIN` is on). Optional `SECURITY_REPORT_MAX_PER_DAY` (default 3). No other new env.
**Launch gate: `WEB_CHECKIN_ALERTS` stays off until S4a (app list) + S4b (this) + S4c (app report UI) are all live.** Deploy order: run migration `20270203090000-security-incident` BEFORE the code; without the tables only the report and admin routes fail (the list does not touch them while the flag is off).

## POST /me/security-activity/:eventId/report
Member or trainer; `Authorization: Bearer`. `Cache-Control: no-store`. Body `{ secureAccount?: boolean }` (default `true`; anything but a boolean is 400 `invalid_secure_account`).
Choices shown to the member: "Report and secure my account" (`true`) or "Report only" (`false`).

200: `{ ok: true, idempotent, incident: { id, status: "open"|"acknowledged"|"resolved", reportedAt }, protection: { requested, sessionsEnded, pinResetRequired: true | false | "not_applicable", limited? }, signedOut }`
- `secureAccount: true`: every session of the account is ended (`sessionsEnded: true`, `signedOut: true`: **the app must clear its token and show sign-in**; this very session is also over). If FitFlex holds a PIN, PIN sign-in then answers `403 pin_reset_required` until the member completes "Forgot PIN" (`pinResetRequired: true`). No PIN held by FitFlex (Google / Firebase-only PIN): `pinResetRequired: "not_applicable"`. Sessions always end when requested, whatever the PIN state.
- `secureAccount: false`: nothing is locked; `sessionsEnded: false`, `pinResetRequired: false`, `signedOut: false`.
- After **2 secure actions in 24 hours** a further report is still recorded and staff are told, but nothing is locked again: `protection: { requested: true, sessionsEnded: false, pinResetRequired: false, limited: true }`, `signedOut: false`. It is NOT a 429.
- Reporting the same event again returns the same incident with `idempotent: true` and the stored `protection` (no second incident, no second lockout, no second alert). Repeat is checked before the cap.
- Firebase refresh tokens are NOT revoked (S5). Locked-out members cannot report yet (S5).
- If ending sessions fails, the incident is still recorded (`sessionsEnded: false`); staff see `protection.failed`.

Errors: `400 invalid_secure_account`; `401` no/invalid token; `404 { error: "not_found" }` (flag off, unknown event, **another member's event**); `429 { error: "report_limit_reached", retryAfterSeconds }` when the member already created `SECURITY_REPORT_MAX_PER_DAY` NEW incidents in the last 24 hours.

A report **never** voids or deletes the check-in and never changes visits, payouts or settlement.

## GET /me/security-activity (additive)
Each event gets `report: null | { incidentId, status: "open"|"acknowledged"|"resolved", reportedAt }`; the list gets top-level `reportEnabled: boolean`. With the flag off: `report: null`, `reportEnabled: false` (hide the button). The member never sees the staff outcome, only `status`.

## Member messages (neutral, EN + SW draft for native review)
When staff resolve, the member gets an inbox message + push, type `security_report_resolved`, id `ntf_secinc_<incidentId>`, data `{ incidentId, eventId, open: "security_activity", locale, titleEn, bodyEn, titleSw, bodySw }`. The text is identical for every outcome and accuses nobody. Push content is the title plus a generic line.
EN: "We reviewed your security report" / "Thank you for telling us. We have reviewed your report about the check-in at <gym> on <time> and closed it. If anything still looks wrong, open Security activity or contact FitFlex support."
SW (draft): "Tumepitia ripoti yako ya usalama" / "Asante kwa kutuambia. Tumepitia ripoti yako kuhusu kujiandikisha <gym> tarehe <time> na tumeifunga. Ikiwa kuna kitu bado hakionekani sawa, fungua Shughuli za usalama au wasiliana na msaada wa FitFlex."

## Staff (portal) - ACL scope `security_incidents`
`requireAuth('admin')` + `requireAcl('security_incidents')` (super-admin passes). 404 `{ error: "feature_disabled" }` while the flag is off. Every change writes an `AuditLog` row (`security_incident_acknowledged`, `security_incident_resolved`; outcome only, no free text) and an append-only `SecurityIncidentEvent`.
- `GET /admin/security-incidents?status=open|acknowledged|resolved|all&limit=&before=` (default: open + acknowledged; limit default 25, max 100; `next` is opaque) -> `{ incidents: [{ id, userId, eventId, status, outcome, snapshot, protection, opsExceptionId, reportedAt, acknowledgedAt, acknowledgedBy, resolvedAt, resolvedBy, resolutionReason }], next? }`
- `GET /admin/security-incidents/:id` -> `{ incident, events: [{ id, kind, actor, detail, at }] }`
- `POST /admin/security-incidents/:id/acknowledge` open -> acknowledged (409 `invalid_state` otherwise)
- `POST /admin/security-incidents/:id/resolve` `{ outcome: "unauthorised_confirmed"|"authorised_by_member"|"inconclusive", reason: string 10-500 chars (trimmed) }` from open or acknowledged (400 `invalid_outcome` / `invalid_reason`, 409 `invalid_state`). Clears the staff alert and sends the neutral message.

## Staff alert
On a new incident `opsService.raise` records a **high**-severity exception (`type security_incident`, dedupeKey `security_incident:<id>`, title "Member reported an unrecognised web check-in at <gym> (incident <id>)"). The existing `ops-alerts` job (every 10 minutes, not gated by any B2B flag) emails `OPS_ALERT_EMAILS` once per exception: ids and gym name only; no member name, phone, email, PIN, token, IP or user agent. **Ops must put the owner and one support address in `OPS_ALERT_EMAILS`**; target response: one business day. The email subject/prefix is the generic B2B one ("FitFlex B2B: ...").

## Data
`SecurityIncident` and `SecurityIncidentEvent` (migration `20270203090000-security-incident`). One incident per (userId, eventId) (partial unique index). `userId` / `eventId` are plain references, not foreign keys, so deleting an account removes its SecurityEvent but leaves the incident as an anonymised record (staff `resolutionReason` cleared). Retention 24 months: daily job `securityIncidentRetention` (03:05 UTC, runs regardless of flags) deletes **resolved** incidents older than 24 months with their trail; unresolved ones are kept. The trail table refuses UPDATE and DELETE (trigger); only the cascade from deleting an incident is allowed. No IP, user agent, session or intent id, or PIN is stored.
