// 5-band payout engine — pure logic.

import { PAYOUT_BANDS, PER_VISIT_RATES_TZS } from './constants.mjs';

export function bandFor(visitCount) {
  return PAYOUT_BANDS.find(b => visitCount >= b.min && visitCount <= b.max);
}

/**
 * Calculate payout for a gym for a billing period.
 *
 * @param {Object} args
 * @param {number} args.visitCount  Total Platform-Pass visits in period
 * @param {string} args.gymTier
 * @param {number} [args.negotiatedPerVisitRate]  Override of indicative rate
 * @param {number} [args.flatMonthlyFee]  Pre-negotiated Band 5 fee
 * @returns {{ band:number, commissionPct:number, gross:number, commission:number, net:number, payoutDelayDays:number, flatFee:boolean }}
 */
export function calculatePayout({ visitCount, gymTier, negotiatedPerVisitRate, flatMonthlyFee }) {
  const b = bandFor(visitCount);
  if (b.flatFee) {
    if (flatMonthlyFee == null) {
      throw new Error('Band 5 reached but flatMonthlyFee not set — trigger renegotiation workflow');
    }
    return { band: b.band, commissionPct: 0, gross: flatMonthlyFee, commission: 0,
             net: flatMonthlyFee, payoutDelayDays: 0, flatFee: true };
  }
  const rate  = negotiatedPerVisitRate ?? PER_VISIT_RATES_TZS[gymTier];
  const gross = rate * visitCount;
  const commission = Math.round(gross * b.commissionPct / 100);
  return {
    band: b.band, commissionPct: b.commissionPct, gross,
    commission, net: gross - commission, payoutDelayDays: b.payoutDelayDays, flatFee: false
  };
}
