// Single source of truth for FitFlex Af business constants (Business Logic Doc v2.0).
// Mirror this file into apps/mobile/portal as needed (e.g., via codegen or copy).

// FitFlex Pass tiers: the known tier keys and their NON-price metadata only.
// Prices, visit caps and gym access live in platform Settings and nowhere
// else (owner decision 2026-10-19: no tier may be sold unless it is
// configured in Settings). Do not add price or visitCap back here.
//   trainerDiscountPct — member discount on trainer sessions (trainer-pricing)
//   accessMode         — 'free_online' marks the free online plan, which is
//                        never in the member catalogue
export const PASS_TIERS = Object.freeze({
  online_free: Object.freeze({ trainerDiscountPct: 0, accessMode: 'free_online' }),
  basic:       Object.freeze({ trainerDiscountPct: 0 }),
  pro:         Object.freeze({ trainerDiscountPct: 10 }),
  premium:     Object.freeze({ trainerDiscountPct: 20 }),
  executive:   Object.freeze({ trainerDiscountPct: 20 }),
});

export const GYM_TIERS = Object.freeze(['online', 'standard', 'midtier', 'premium', 'luxury_executive']);

// What a MEMBER pays in credits per visit (Pricing Strategy v2.0 §6.1).
export const PER_VISIT_RATES_TZS = Object.freeze({
  online: 0,
  standard: 5_000,
  midtier:  8_000,
  premium:  13_000,
  luxury_executive: 22_500 // midpoint of 20-25k
});

export const DIRECT_SUB_COMMISSION_PCT = { min: 10, max: 15 };
export const TRAINER_COMMISSION_PCT    = { min: 15, max: 20 };

export const CREDITS_ROLLING_EXPIRY_DAYS = 90;
export const SUBSCRIPTION_GRACE_HOURS    = 24;
export const QR_ROTATION_SECONDS         = 60;
