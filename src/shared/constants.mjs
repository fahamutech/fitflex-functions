// Single source of truth for FitFlex Af business constants (Business Logic Doc v2.0).
// Mirror this file into apps/mobile/portal as needed (e.g., via codegen or copy).

export const PASS_TIERS = Object.freeze({
  online_free: { price: 0,       visitCap: Infinity,  gymTiers: ['online'],                                     multiGymPerDay: true,  trainerDiscountPct: 0, accessMode: 'free_online' },
  basic:     { price: 60_000,  visitCap: 20,        gymTiers: ['standard'],                                   multiGymPerDay: false, trainerDiscountPct: 0 },
  pro:       { price: 120_000, visitCap: 30,        gymTiers: ['standard', 'midtier'],                        multiGymPerDay: true,  trainerDiscountPct: 10 },
  premium:   { price: 200_000, visitCap: 40,        gymTiers: ['standard', 'midtier', 'premium'],             multiGymPerDay: true,  trainerDiscountPct: 20 },
  executive: { price: 350_000, visitCap: Infinity,  gymTiers: ['standard', 'midtier', 'premium', 'luxury_executive'], multiGymPerDay: true, trainerDiscountPct: 20 }
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

// What FitFlex pays a GYM per visit when no negotiated rate is stored on the
// gym (Pricing Strategy v2.0 §5.1, top of each range). Deliberately separate
// from PER_VISIT_RATES_TZS: paying gyms the member price leaves no margin.
export const GYM_PAYOUT_RATES_TZS = Object.freeze({
  online: 0,
  standard: 3_500,
  midtier:  6_000,
  premium:  12_000,
  luxury_executive: 18_000
});

// 5-band payout structure (BL-019)
export const PAYOUT_BANDS = Object.freeze([
  { band: 1, min: 0,   max: 49,       commissionPct: 25, payoutDelayDays: 30 },
  { band: 2, min: 50,  max: 149,      commissionPct: 20, payoutDelayDays: 14 },
  { band: 3, min: 150, max: 299,      commissionPct: 15, payoutDelayDays: 7  },
  { band: 4, min: 300, max: 499,      commissionPct: 10, payoutDelayDays: 0  },
  { band: 5, min: 500, max: Infinity, commissionPct: 0,  payoutDelayDays: 0, flatFee: true }
]);

export const DIRECT_SUB_COMMISSION_PCT = { min: 10, max: 15 };
export const TRAINER_COMMISSION_PCT    = { min: 15, max: 20 };

export const CREDITS_ROLLING_EXPIRY_DAYS = 90;
export const SUBSCRIPTION_GRACE_HOURS    = 24;
export const QR_ROTATION_SECONDS         = 60;
