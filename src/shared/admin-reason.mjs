// The reason an admin gives for a sensitive action (AuditLog.reason). See adminReasonsRequiredOn().
import { adminReasonsRequiredOn } from './feature-flags.mjs';

export const REASON_MAX_LENGTH = 500;

/** Trimmed reason, cut to REASON_MAX_LENGTH; null when absent or blank. */
export function cleanReason(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  return t ? t.slice(0, REASON_MAX_LENGTH) : null;
}

/** { reason } on success; { error: 'reason_required', status: 400 } when the flag is on and no reason was given. */
export function checkReason(raw, { required = true } = {}) {
  const reason = cleanReason(raw);
  if (!reason && required && adminReasonsRequiredOn()) return { error: 'reason_required', status: 400 };
  return { reason };
}
