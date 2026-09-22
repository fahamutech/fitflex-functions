// FitFlex Af — Admin Portal Constants
// 5-pillar gym classification rubric, roaming compensation controls,
// B2B contract administration, audit log, and pitch deck data.

// ─────────────────────────────────────────────────────────────────────────────
// 5-Pillar Gym Classification Rubric (per the Marketplace & B2B Modules doc)
// Total: 100 points across 5 inspection pillars.
// ─────────────────────────────────────────────────────────────────────────────
export const RUBRIC_PILLARS = {
  equipment_modernity: {
    id: 'equipment_modernity',
    label: 'Equipment Modernity & Maintenance',
    maxScore: 25,
    description: 'Biomechanical condition of selectorized machines, free weights, and cardio consoles.'
  },
  hygiene_ventilation: {
    id: 'hygiene_ventilation',
    label: 'Hygiene, Ventilation & Sanitation',
    maxScore: 25,
    description: 'Air conditioning CFM, shower cleanliness, locker maintenance, water filtration.'
  },
  safety_emergency: {
    id: 'safety_emergency',
    label: 'Safety & Emergency Readiness',
    maxScore: 20,
    description: 'First aid kits, certified CPR personnel on floor, fire extinguishers.'
  },
  staff_professionalism: {
    id: 'staff_professionalism',
    label: 'Staff Professionalism & Amenities',
    maxScore: 20,
    description: 'Front desk etiquette, changing room comfort, steam/sauna operation.'
  },
  digital_connectivity: {
    id: 'digital_connectivity',
    label: 'Digital Connectivity',
    maxScore: 10,
    description: 'High-speed Wi-Fi and digital check-in terminal reliability.'
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Tier Assignment Thresholds (based on total rubric score)
// ─────────────────────────────────────────────────────────────────────────────
export const TIER_THRESHOLDS = {
  luxury_executive: { min: 90, label: 'Luxury / VIP' },
  premium:          { min: 75, label: 'Premium' },
  midtier:          { min: 60, label: 'Mid-Tier' },
  standard:         { min: 0,  label: 'Standard' }
};

// ─────────────────────────────────────────────────────────────────────────────
// Assign tier based on total score
// ─────────────────────────────────────────────────────────────────────────────
export function assignTierFromScore(totalScore) {
  if (totalScore >= TIER_THRESHOLDS.luxury_executive.min) return 'luxury_executive';
  if (totalScore >= TIER_THRESHOLDS.premium.min) return 'premium';
  if (totalScore >= TIER_THRESHOLDS.midtier.min) return 'midtier';
  return 'standard';
}

// ─────────────────────────────────────────────────────────────────────────────
// Validate rubric scores
// ─────────────────────────────────────────────────────────────────────────────
export function validateRubricScores(scores) {
  if (!scores || typeof scores !== 'object')
    return { valid: false, error: 'scores_required' };

  let total = 0;
  const validated = {};

  for (const [pillarId, pillar] of Object.entries(RUBRIC_PILLARS)) {
    const score = scores[pillarId];
    if (typeof score !== 'number' || score < 0 || score > pillar.maxScore)
      return { valid: false, error: `invalid_score_for_${pillarId}`, maxAllowed: pillar.maxScore };
    validated[pillarId] = score;
    total += score;
  }

  return { valid: true, scores: validated, total };
}

// ─────────────────────────────────────────────────────────────────────────────
// Roaming Compensation Defaults (TZS)
// Configurable per gym by admin.
// ─────────────────────────────────────────────────────────────────────────────
export const ROAMING_DEFAULTS = {
  daily_scan_fee: 12000,      // per daily check-in from a FitFlex pass member
  weekly_pass_fee: 45000,     // per weekly pass redemption
  monthly_pass_fee: 90000,    // per monthly pass redemption
  commission_rate: 0.15       // default platform commission (15%)
};

// ─────────────────────────────────────────────────────────────────────────────
// Commission Rate Range (configurable per gym, trainer, vendor)
// ─────────────────────────────────────────────────────────────────────────────
export const COMMISSION_RANGE = {
  min: 0.10,       // 10%
  max: 0.25,       // 25%
  default: 0.15    // 15%
};

// ─────────────────────────────────────────────────────────────────────────────
// B2B Contract Status
// ─────────────────────────────────────────────────────────────────────────────
export const CONTRACT_STATUS = {
  DRAFT: 'draft',
  ACTIVE: 'active',
  EXPIRED: 'expired',
  TERMINATED: 'terminated',
  RENEWAL_PENDING: 'renewal_pending'
};

// ─────────────────────────────────────────────────────────────────────────────
// Audit Log Action Types
// ─────────────────────────────────────────────────────────────────────────────
export const AUDIT_ACTIONS = {
  GYM_CREATED: 'gym_created',
  GYM_UPDATED: 'gym_updated',
  GYM_DELETED: 'gym_deleted',
  GYM_TIER_CHANGED: 'gym_tier_changed',
  RUBRIC_SCORED: 'rubric_scored',
  TRAINER_VERIFIED: 'trainer_verified',
  TRAINER_SUSPENDED: 'trainer_suspended',
  VENDOR_APPROVED: 'vendor_approved',
  VENDOR_SUSPENDED: 'vendor_suspended',
  CORPORATE_ACTIVATED: 'corporate_activated',
  CORPORATE_SUSPENDED: 'corporate_suspended',
  PAYMENT_PROCESSED: 'payment_processed',
  PAYOUT_COMPLETED: 'payout_completed',
  COMMISSION_UPDATED: 'commission_updated',
  ROAMING_RATE_UPDATED: 'roaming_rate_updated',
  CONTRACT_SIGNED: 'contract_signed',
  CONTRACT_TERMINATED: 'contract_terminated'
};

// ─────────────────────────────────────────────────────────────────────────────
// Pitch Deck Slides (static data for the built-in pitch deck)
// ─────────────────────────────────────────────────────────────────────────────
export const PITCH_DECK_SLIDES = [
  {
    id: 1,
    title: 'The Problem',
    subtitle: 'Market Lock-In & Rigid Memberships',
    bullets: [
      'East African gym-goers locked into expensive single-club annual memberships',
      'No flexibility to try different gyms or visit based on proximity',
      'Gym owners struggle with underutilized off-peak hours and no digital visibility',
      'Cash-only drop-in rates deter casual fitness enthusiasts'
    ]
  },
  {
    id: 2,
    title: 'The Solution',
    subtitle: 'FitFlex Unified Digital Passport & Marketplace',
    bullets: [
      'One subscription, multi-gym access across Dar es Salaam, Nairobi, Kampala',
      'Tiered passes (Basic to Executive) with visit caps and mobile money payments',
      'QR code check-in with 60-second rotation for fraud prevention',
      'Marketplace for supplements, equipment, apparel, and event tickets with gym pickup'
    ]
  },
  {
    id: 3,
    title: 'Market Opportunity',
    subtitle: '4.8M Addressable Users in East Africa',
    bullets: [
      '4.8M urban fitness-conscious demographic across 3 countries',
      '6.2B TZS annual wellness wallet spend (gyms, supplements, coaching)',
      'Mobile money penetration: 73% in Tanzania, 82% in Kenya',
      'Corporate wellness: 500+ companies with 100+ employees in DSM alone'
    ]
  },
  {
    id: 4,
    title: 'Traction & Network Economics',
    subtitle: 'Cold-Start Strategy & Growth Loops',
    bullets: [
      'Supply-first seeding: trainers as warm-introduction partners to onboard gyms',
      'Day 1 target: 5 partner gyms in Dar es Salaam (Mikocheni, Masaki, Oysterbay)',
      'Each new gym adds discovery value for members → more subscriptions → more gyms join',
      'Corporate B2B: CRDB Bank, Vodacom, Jubilee Insurance pilot discussions'
    ]
  },
  {
    id: 5,
    title: 'Revenue Model',
    subtitle: 'Multi-Stream Marketplace Economics',
    bullets: [
      'Platform Pass: 15% commission on all subscription tiers (60K-350K TZS/month)',
      'Direct Gym Subscriptions: 10-15% commission on individual gym subscriptions',
      'Marketplace: 10-15% commission on all vendor product sales',
      'Corporate B2B: Per-seat licensing (60K-350K TZS/seat/month, employer-subsidized)',
      '5-band payout engine: commission decreases as gym volume increases (incentivizes growth)'
    ]
  },
  {
    id: 6,
    title: 'Technology & Platform',
    subtitle: 'Built for East African Realities',
    bullets: [
      'Flutter mobile app (iOS + Android) — single codebase, offline-tolerant',
      'bfast-functions backend — FahamuTech serverless platform',
      'Selcom payment gateway — aggregates M-Pesa, Airtel Money, Tigo Pesa',
      'WhatsApp Business API — OTP, notifications, trainer-member chat',
      'Multi-lingual (English + Swahili) from Day 1'
    ]
  }
];
