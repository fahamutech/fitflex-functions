# Audit log viewer and required reasons (admin-portal audit S2/S3)

## GET /admin/audit-log
Guard: `requireAuth('admin')` + `requireAcl('audit')` (new scope `audit`; super-admins always pass).

Query: `actor`, `action`, `target` (exact), `from`, `to` (ISO date-time, inclusive), `limit` (default 50, max 200), `cursor`.

Response: `{ items: [{ id, at, actor, action, target, before, after, reason }], nextCursor }`, newest first, keyset by `(at, id)`.
`nextCursor` is opaque; pass it back unchanged; `null` on the last page. `before`/`after` have credentials removed
(`src/shared/audit-redact.mjs`); whole user rows are cut down to account fields. 400 `{ error: 'invalid_filter', field }` for a bad from/to/cursor.

## Reasons (flag `ADMIN_REASONS_REQUIRED`, default OFF)
Optional `reason` (string, trimmed, 500 characters max) is stored in `AuditLog.reason` on:
- `POST /admin/members/:id/status` body `{ status, reason }` (reason required only to suspend)
- `DELETE /admin/gym-owners/:id` body `{ reason }` or `?reason=`
- `PUT /admin/settings` body `{ ..., reason }` (required when the body changes subscriptionTiers, payoutBands, paymentPeriodDays, payoutModel, currency or manualPayment; not for trainerSpecialties)

Flag ON and no reason: `400 { error: 'reason_required' }`, nothing changed, nothing audited. Portal wording for the error
(EN/SW): "Give a reason for this action." / "Toa sababu ya hatua hii."

On these paths the audit write is not best-effort: if it fails the request fails (500) and the change is undone
(member status, settings) or never made (owner delete: the audit row is written first).

## AuditLog is append-only
A database trigger refuses UPDATE, DELETE and TRUNCATE. Exceptions: account erasure's personal-key scrub
(`fitflex.audit_scrub`, before/after columns only), and a test bypass honoured only in databases whose name contains `_ci`.
