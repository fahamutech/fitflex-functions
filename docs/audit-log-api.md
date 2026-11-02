# Audit log viewer and required reasons (admin-portal audit S2/S3)

## GET /admin/audit-log
Guard: `requireAuth('admin')` + `requireAcl('audit')` (new scope `audit`; super-admins always pass).

Query: `actor`, `action`, `target` (exact), `from`, `to` (ISO date-time, inclusive), `limit` (default 50, max 200), `cursor`.

Response: `{ items: [{ id, at, actor, action, target, before, after, reason }], nextCursor }`, newest first, keyset by `(at, id)`.
`nextCursor` is opaque; pass it back unchanged; `null` on the last page. `before`/`after` have credentials removed
(`src/shared/audit-redact.mjs`); any key containing the word secret, token, hash, apikey, password, pin, otp, nationalId, tin or accountNumber is removed, `manualPayment.lipaNamba` is masked to its last three digits; whole user rows are cut down to account fields. 400 `{ error: 'invalid_filter', field }` for a bad from/to/cursor.

## Reasons (flag `ADMIN_REASONS_REQUIRED`, default OFF)
Optional `reason` (string, trimmed, 500 characters max) is stored in `AuditLog.reason` on:
- `POST /admin/members/:id/status` body `{ status, reason }` (reason required only to suspend)
- `DELETE /admin/gym-owners/:id` body `{ reason }` only (a `?reason=` query is ignored)
- `PUT /admin/settings` body `{ ..., reason }` (required when the body changes subscriptionTiers, payoutBands, paymentPeriodDays, payoutModel, currency or manualPayment; not for trainerSpecialties)

Flag ON and no reason: `400 { error: 'reason_required' }`, nothing changed, nothing audited. Portal wording for the error
(EN/SW): "Give a reason for this action." / "Toa sababu ya hatua hii."

**The reason is free text typed by an admin: the portal must render it (and before/after values) as plain text, never as HTML.**

On these paths the audit write is not best-effort. Member status and settings change in ONE database transaction together with
their audit row (the in-memory settings copy changes only after commit); if the audit insert fails nothing changes and the
request fails (500). The owner delete writes its audit row first, so if that fails nothing is deleted.

## AuditLog is append-only
A database trigger refuses UPDATE, DELETE and TRUNCATE. Exceptions: (1) account erasure's personal-key scrub
(`fitflex.audit_scrub`, set inside the erasure transaction): only before/after may change and only by removing data
(NEW must be NULL or contained in OLD); (2) a test bypass honoured only in databases named `^fitflex_ci(_[A-Za-z0-9]+)*$`.
Indexes for the viewer are built CONCURRENTLY by migration 20270202090100.

**Note for counsel:** on account deletion the audit trail is scrubbed of personal keys rather than kept or deleted whole.
Whether that is the right retention rule is a legal question (see the legal review pack).
