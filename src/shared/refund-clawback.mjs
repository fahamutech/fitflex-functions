// Shared by the refund clawback, the check-in void clawback and the settlement workflow (Slice D).
export const REFUND_CLAWBACK_HOLD_REASON = 'A pass refund on this statement was paid after it was submitted';
/** Adjustments that count against what a gym line still holds. A rejected or voided one never took effect. */
export const LIVE_ADJUSTMENT_STATUSES = ['proposed', 'applied'];
