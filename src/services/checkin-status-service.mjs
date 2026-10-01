// Check-in status service — admins dispute, flag, reinstate or void a
// check-in (DR-14). Every change is audited in AuditLog; a void keeps who,
// when and why on the check-in itself, forever. Check-ins are never deleted.
import { randomUUID } from 'node:crypto';
import { CHECKIN_STATUS, STATUS_AUDIT_ACTION, checkStatusChange, currentStatus } from '../shared/checkin-status.mjs';

export function createCheckinStatusService({ checkins, auditLog, onVoided = null }) {
  /**
   * @param {{ checkinId: string, status: string, reason: string, actorId: string, now?: Date }} args
   */
  async function setStatus({ checkinId, status, reason, actorId, now = new Date() }) {
    const checkin = await checkins.findByIdAsync(checkinId);
    if (!checkin) return { error: 'checkin_not_found', status: 404 };

    const from = currentStatus(checkin);
    const check = checkStatusChange({ from, to: status, reason });
    if (!check.ok) return { error: check.error, status: check.status };

    const at = now.toISOString();
    const patch = { status, statusReason: check.reason, statusChangedBy: actorId, statusChangedAt: at };
    if (status === CHECKIN_STATUS.VOIDED) Object.assign(patch, { voidedAt: at, voidedBy: actorId, voidReason: check.reason });

    const updated = await checkins.updateByIdAsync(checkinId, patch);
    await auditLog.insertAsync({
      id: randomUUID(), at, actor: actorId, action: STATUS_AUDIT_ACTION[status], target: checkinId,
      before: { status: from, statusReason: checkin.statusReason ?? null },
      after: { status, statusReason: check.reason }
    });
    // A voided visit gives back whatever it used (a B2B allowance). The void
    // itself has already happened; a failing hook must not undo it.
    if (status === CHECKIN_STATUS.VOIDED && onVoided) {
      try {
        await onVoided({ checkin: updated, reason: check.reason, actorId });
      } catch (err) {
        console.warn('[check-in] onVoided failed:', err?.message);
      }
    }
    return { checkin: updated };
  }

  return { setStatus };
}
