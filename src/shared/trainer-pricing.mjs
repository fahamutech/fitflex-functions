// Trainer session pricing (Technical Onboarding Brief §4 "Trainer Payout Logic").
// Pure logic — no I/O.
//
// Calculation order, per session:
//   1. Apply the member's Platform Pass trainer discount to the session price.
//   2. FitFlex commission = commission % of the DISCOUNTED price.
//   3. Trainer payout = discounted price − commission.
import { PASS_TIERS, TRAINER_COMMISSION_PCT } from './constants.mjs';

/** Trainer discount the member's active pass grants (0 when none). */
export function passDiscountPct(passTier) {
  return PASS_TIERS[passTier]?.trainerDiscountPct ?? 0;
}

/** Commission for a trainer: negotiated rate clamped to the 15–20% band. */
export function trainerCommissionPct(trainer) {
  const negotiated = Number(trainer?.commissionPct);
  if (!Number.isFinite(negotiated) || negotiated <= 0) return TRAINER_COMMISSION_PCT.min;
  return Math.min(TRAINER_COMMISSION_PCT.max, Math.max(TRAINER_COMMISSION_PCT.min, negotiated));
}

/**
 * Price one session.
 * @param {{ listPrice:number, discountPct?:number, commissionPct:number }} args
 */
export function priceSession({ listPrice, discountPct = 0, commissionPct }) {
  const list = Math.max(0, Math.round(Number(listPrice) || 0));
  const discount = Math.round(list * discountPct / 100);
  const memberPrice = list - discount;
  const commission = Math.round(memberPrice * commissionPct / 100);
  return {
    listPrice: list,
    discountPct,
    discount,
    memberPrice,
    commissionPct,
    commission,
    trainerPayout: memberPrice - commission,
  };
}

/** Price a multi-slot booking: per-session breakdown plus totals. */
export function priceBooking({ listPrice, slotCount, discountPct = 0, commissionPct }) {
  const each = priceSession({ listPrice, discountPct, commissionPct });
  const n = Math.max(0, slotCount | 0);
  return {
    perSession: each,
    slotCount: n,
    listTotal: each.listPrice * n,
    discountTotal: each.discount * n,
    memberTotal: each.memberPrice * n,
    commissionTotal: each.commission * n,
    trainerPayoutTotal: each.trainerPayout * n,
  };
}
