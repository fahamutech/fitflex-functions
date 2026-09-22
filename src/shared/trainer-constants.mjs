// FitFlex Af — Trainer System Constants
// All trainer-related business rules from the Technical Onboarding Brief v1.0
// and the Business Logic Document v2.0.

// ─────────────────────────────────────────────────────────────────────────────
// Trainer Commission Configuration
// Per the onboarding brief: 15-20% commission, negotiated individually at
// trainer onboarding. FitFlex absorbs the member discount — NOT the trainer.
// ─────────────────────────────────────────────────────────────────────────────

export const TRAINER_COMMISSION_RANGE = {
  min: 0.15,   // 15% — floor for new trainers
  max: 0.20,   // 20% — ceiling for high-demand trainers
  default: 0.15 // default for new onboarding
};

// ─────────────────────────────────────────────────────────────────────────────
// Session Types & Default Pricing (TZS)
// Trainers can offer multiple session types with different pricing.
// These are defaults — trainers override their own rates at onboarding.
// ─────────────────────────────────────────────────────────────────────────────

export const SESSION_TYPES = {
  'personal_training': { label: 'Personal Training', defaultPrice: 50000 },
  'strength_coaching': { label: 'Strength Coaching', defaultPrice: 60000 },
  'yoga_session':      { label: 'Yoga Session',      defaultPrice: 45000 },
  'crossfit':          { label: 'CrossFit Session',   defaultPrice: 55000 },
  'nutrition_plan':    { label: 'Nutrition Plan',     defaultPrice: 35000 },
  'group_class':       { label: 'Group Class',        defaultPrice: 25000 }
};

// ─────────────────────────────────────────────────────────────────────────────
// Booking Status Flow
// ─────────────────────────────────────────────────────────────────────────────

export const BOOKING_STATUS = {
  PENDING: 'pending',         // member booked, awaiting trainer confirmation
  CONFIRMED: 'confirmed',     // trainer confirmed
  COMPLETED: 'completed',     // session finished (triggers payout)
  CANCELLED_MEMBER: 'cancelled_member',   // member cancelled
  CANCELLED_TRAINER: 'cancelled_trainer', // trainer cancelled
  NO_SHOW: 'no_show',         // member didn't show (trainer still gets paid)
  EXPIRED: 'expired'          // not confirmed within 24h
};

// ─────────────────────────────────────────────────────────────────────────────
// Cancellation Policy (from BRD: 12-hour advance for full refund)
// ─────────────────────────────────────────────────────────────────────────────

export const CANCELLATION_WINDOW_HOURS = 12; // must cancel >= 12h before session for refund
export const CONFIRMATION_WINDOW_HOURS = 24; // trainer must confirm within 24h or booking expires

// ─────────────────────────────────────────────────────────────────────────────
// Trainer Specializations (for filtering in the marketplace)
// ─────────────────────────────────────────────────────────────────────────────

export const TRAINER_SPECIALIZATIONS = [
  'Weight Loss',
  'Bodybuilding',
  'CrossFit',
  'Yoga',
  'Pilates',
  'Functional Fitness',
  'Strength Training',
  'Athletic Performance',
  'Nutrition',
  'Rehabilitation'
];

// ─────────────────────────────────────────────────────────────────────────────
// Trainer Payout Calculation
// Member-to-trainer tier-based discounts are NOT applied at this time.
// Payout is a straight commission: trainerPayout = sessionPrice - commission.
//
// Returns an object with all the math broken out for audit logging.
// ─────────────────────────────────────────────────────────────────────────────

export function calculateTrainerPayout({
  sessionPrice,        // TZS — the trainer's listed session price
  commissionRate        // 0.15-0.20 — the trainer's negotiated commission rate
}) {
  if (typeof sessionPrice !== 'number' || sessionPrice < 0)
    throw new Error('sessionPrice must be a non-negative number');
  if (typeof commissionRate !== 'number' || commissionRate < TRAINER_COMMISSION_RANGE.min || commissionRate > TRAINER_COMMISSION_RANGE.max)
    throw new Error(`commissionRate must be between ${TRAINER_COMMISSION_RANGE.min} and ${TRAINER_COMMISSION_RANGE.max}`);

  const commissionAmount = Math.round(sessionPrice * commissionRate);
  const trainerPayout = sessionPrice - commissionAmount;

  return {
    sessionPrice,
    commissionRate,
    commissionAmount,
    trainerPayout,
    fitflexNet: commissionAmount,
    currency: 'TZS'
  };
}
