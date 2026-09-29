// Check-in lifecycle for gym settlement (DR-14) — pure rules, no I/O.
//
//   valid ──► disputed / flagged ──► valid (resolved) or voided
//     └──────────────────────────────► voided (final)
//
// Only VALID check-ins can be paid; DISPUTED and FLAGGED are held until
// resolved; VOIDED is never paid and can't change again (the database
// enforces that too, trigger checkin_void_is_final).

export const CHECKIN_STATUS = Object.freeze({
  VALID:    'valid',
  DISPUTED: 'disputed',
  FLAGGED:  'flagged',
  VOIDED:   'voided'
});

/** How a check-in was recorded. */
export const CHECKIN_SOURCE = Object.freeze({
  MEMBER_QR_BY_STAFF: 'member_qr_by_staff', // staff scanned the member's QR
  GYM_QR_BY_MEMBER:   'gym_qr_by_member',   // member scanned the gym's entrance QR
  OWNER_MANUAL:       'owner_manual',       // owner/staff checked a direct member in by hand
  ADMIN_BACKFILL:     'admin_backfill'
});

/** check-in-service `method` → source. */
export function sourceForMethod(method) {
  return method === 'member_scanned' ? CHECKIN_SOURCE.GYM_QR_BY_MEMBER : CHECKIN_SOURCE.MEMBER_QR_BY_STAFF;
}

const TRANSITIONS = Object.freeze({
  [CHECKIN_STATUS.VALID]:    [CHECKIN_STATUS.DISPUTED, CHECKIN_STATUS.FLAGGED, CHECKIN_STATUS.VOIDED],
  [CHECKIN_STATUS.DISPUTED]: [CHECKIN_STATUS.VALID, CHECKIN_STATUS.VOIDED],
  [CHECKIN_STATUS.FLAGGED]:  [CHECKIN_STATUS.VALID, CHECKIN_STATUS.VOIDED],
  [CHECKIN_STATUS.VOIDED]:   []
});

/** AuditLog action for a move into `to` (from a held state back to valid = reinstated). */
export const STATUS_AUDIT_ACTION = Object.freeze({
  [CHECKIN_STATUS.VALID]:    'checkin_reinstated',
  [CHECKIN_STATUS.DISPUTED]: 'checkin_disputed',
  [CHECKIN_STATUS.FLAGGED]:  'checkin_flagged',
  [CHECKIN_STATUS.VOIDED]:   'checkin_voided'
});

export const MAX_STATUS_REASON_LENGTH = 500;

/** Older rows written before the lifecycle existed read as valid (the column default). */
export const currentStatus = (checkin) => checkin?.status || CHECKIN_STATUS.VALID;

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

/**
 * Validate a requested status change.
 * @returns {{ ok: true, reason: string } | { ok: false, error: string, status: number }}
 */
export function checkStatusChange({ from, to, reason }) {
  if (!Object.values(CHECKIN_STATUS).includes(to)) return { ok: false, error: 'invalid_status', status: 400 };
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (!text) return { ok: false, error: 'reason_required', status: 400 };
  if (text.length > MAX_STATUS_REASON_LENGTH) return { ok: false, error: 'reason_too_long', status: 400 };
  if (from === CHECKIN_STATUS.VOIDED) return { ok: false, error: 'checkin_voided_final', status: 409 };
  if (!canTransition(from, to)) return { ok: false, error: 'invalid_status_transition', status: 409 };
  return { ok: true, reason: text };
}
