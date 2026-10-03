// Trainer session pricing (Technical Onboarding Brief §4 "Trainer Payout Logic").
// Pure logic — no I/O.
//
// Whoever sponsors a discount absorbs it; the trainer is paid in full unless
// the trainer is the sponsor. Per session:
//   1. The member pays the session price less the discount.
//   2. A discount funded by someone else (FitFlex for the Pass trainer
//      discount, or a sponsor): commission and payout are worked out on the
//      trainer's FULL price, so the trainer earns what they would without it.
//   3. A discount the trainer funds themselves: commission and payout are
//      worked out on the discounted price.
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

/** Who can fund a session discount. */
export const DISCOUNT_FUNDERS = ['fitflex', 'sponsor', 'trainer'];

/**
 * Price one session.
 * @param {{ listPrice:number, discountPct?:number, commissionPct:number, discountFundedBy?:'fitflex'|'sponsor'|'trainer' }} args
 */
export function priceSession({ listPrice, discountPct = 0, commissionPct, discountFundedBy = 'fitflex' }) {
  const list = Math.max(0, Math.round(Number(listPrice) || 0));
  const discount = Math.round(list * discountPct / 100);
  const memberPrice = list - discount;
  const trainerFunds = discountFundedBy === 'trainer';
  const commission = Math.round((trainerFunds ? memberPrice : list) * commissionPct / 100);
  return {
    listPrice: list,
    discountPct,
    discount,
    discountFundedBy: discount > 0 ? discountFundedBy : null,
    memberPrice,
    commissionPct,
    commission,
    trainerPayout: (trainerFunds ? memberPrice : list) - commission,
  };
}

/** Price a multi-slot booking: per-session breakdown plus totals. */
export function priceBooking({ listPrice, slotCount, discountPct = 0, commissionPct, discountFundedBy = 'fitflex' }) {
  const each = priceSession({ listPrice, discountPct, commissionPct, discountFundedBy });
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
