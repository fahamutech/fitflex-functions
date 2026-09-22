// FitFlex Af — Vendor B2B Constants
// Extends the marketplace vendor module with enquiry messaging, payout
// ledger, and vendor profile management.

// ─────────────────────────────────────────────────────────────────────────────
// Enquiry Status
// ─────────────────────────────────────────────────────────────────────────────
export const ENQUIRY_STATUS = {
  OPEN: 'open',           // customer sent enquiry, awaiting vendor reply
  REPLIED: 'replied',     // vendor has responded
  CLOSED: 'closed'         // customer or vendor closed the thread
};

// ─────────────────────────────────────────────────────────────────────────────
// Payout Status
// ─────────────────────────────────────────────────────────────────────────────
export const PAYOUT_STATUS = {
  PENDING: 'pending',       // payout requested, awaiting processing
  PROCESSING: 'processing', // payout in progress (Selcom/bank transfer)
  COMPLETED: 'completed',   // funds sent to vendor wallet/bank
  FAILED: 'failed',          // transfer failed (will retry)
  CANCELLED: 'cancelled'    // cancelled by admin
};

// ─────────────────────────────────────────────────────────────────────────────
// Payout Cycle
// ─────────────────────────────────────────────────────────────────────────────
export const PAYOUT_CYCLE = {
  WEEKLY: 'weekly',     // default for marketplace orders
  MONTHLY: 'monthly',   // for high-volume vendors
};

// ─────────────────────────────────────────────────────────────────────────────
// Minimum Payout Threshold (TZS)
// Vendors can only request early payout if their pending balance exceeds this.
// ─────────────────────────────────────────────────────────────────────────────
export const MIN_EARLY_PAYOUT_TZS = 50000; // 50,000 TZS minimum

// ─────────────────────────────────────────────────────────────────────────────
// Payout Calculation
// Aggregates completed order payouts per vendor, minus already-disbursed amounts.
// ─────────────────────────────────────────────────────────────────────────────
export function calculateVendorPayoutBalance({ vendorId, orders, payouts }) {
  // Total earned from collected (completed) orders
  const earnedFromOrders = orders
    .filter(o => o.status === 'collected' &&
            o.vendorBreakdown?.some(v => v.vendorId === vendorId))
    .reduce((sum, o) => {
      const vBreak = o.vendorBreakdown.find(v => v.vendorId === vendorId);
      return sum + (vBreak?.payout || 0);
    }, 0);

  // Total already disbursed via payouts
  const alreadyDisbursed = payouts
    .filter(p => p.vendorId === vendorId && p.status === PAYOUT_STATUS.COMPLETED)
    .reduce((sum, p) => sum + p.netAmount, 0);

  // Pending (requested but not yet completed)
  const pendingInPayouts = payouts
    .filter(p => p.vendorId === vendorId &&
            [PAYOUT_STATUS.PENDING, PAYOUT_STATUS.PROCESSING].includes(p.status))
    .reduce((sum, p) => sum + p.netAmount, 0);

  return {
    totalEarned: earnedFromOrders,
    totalDisbursed: alreadyDisbursed,
    pendingDisbursement: pendingInPayouts,
    availableBalance: earnedFromOrders - alreadyDisbursed - pendingInPayouts
  };
}
