// FitFlex Af — Marketplace Constants
// E-commerce & services marketplace for the FitFlex platform.
// Built per the Marketplace & B2B Modules spec document.

// ─────────────────────────────────────────────────────────────────────────────
// Product Categories
// Five specialized merchandise categories per the spec document.
// ─────────────────────────────────────────────────────────────────────────────
export const PRODUCT_CATEGORIES = {
  supplements: {
    id: 'supplements',
    label: 'Supplements & Nutrition',
    subcategories: ['Protein', 'Creatine & Aminos', 'Pre-Workout', 'Vitamins & Health']
  },
  equipment: {
    id: 'equipment',
    label: 'Fitness Equipment & Hardware',
    subcategories: ['Strength & Weights', 'Flexibility', 'Cardio Gear']
  },
  apparel: {
    id: 'apparel',
    label: 'Athletic Apparel & Performance Wear',
    subcategories: ['Tops & Tees', 'Bottoms & Leggings', 'Headwear & Accessories']
  },
  events: {
    id: 'events',
    label: 'Events & Marathon Tickets',
    subcategories: ['Marathons & Runs', 'Concerts & Parties', 'Wellness (Massage/Tattoo)']
  },
  services: {
    id: 'services',
    label: 'Recovery & Specialized Athletic Services',
    subcategories: ['Sports Massage', 'Physiotherapy', 'Personal Escort & Security']
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Order Status Flow
// ─────────────────────────────────────────────────────────────────────────────
export const ORDER_STATUS = {
  PENDING: 'pending',           // order placed, payment pending
  PAID: 'paid',                  // payment confirmed
  PRE_DELIVERY: 'pre_delivery',  // vendor preparing and packaging goods
  DISPATCHED: 'dispatched',      // courier en-route to pickup gym
  CUSTODY: 'custody',            // package safely held at gym reception
  COLLECTED: 'collected',        // member collected from gym
  CANCELLED: 'cancelled',        // order cancelled
  REFUNDED: 'refunded'           // order refunded
};

// ─────────────────────────────────────────────────────────────────────────────
// Order Status Progression (allowed transitions)
// ─────────────────────────────────────────────────────────────────────────────
export const ORDER_TRANSITIONS = {
  pending: ['paid', 'cancelled'],
  paid: ['pre_delivery', 'cancelled', 'refunded'],
  pre_delivery: ['dispatched', 'cancelled'],
  dispatched: ['custody'],
  custody: ['collected'],
  collected: [],
  cancelled: ['refunded'],
  refunded: []
};

// ─────────────────────────────────────────────────────────────────────────────
// Delivery Fee Calculation
// Based on distance from central logistics depot to the chosen pickup gym.
// Digital-only items (events, services) have delivery fee waived.
// ─────────────────────────────────────────────────────────────────────────────
export const DELIVERY_FEE_BASE_TZS = 3000;        // base fee
export const DELIVERY_FEE_PER_KM_TZS = 1500;      // per km surcharge
export const DIGITAL_CATEGORIES = ['events', 'services']; // no delivery fee

export function calculateDeliveryFee({ category, distanceKm }) {
  // Digital items (event tickets, services) — no delivery needed
  if (DIGITAL_CATEGORIES.includes(category)) return 0;
  // Physical items — base + per-km surcharge
  const km = Math.max(0, Number(distanceKm) || 0);
  return DELIVERY_FEE_BASE_TZS + (km * DELIVERY_FEE_PER_KM_TZS);
}

// ─────────────────────────────────────────────────────────────────────────────
// Collection Code Generation
// Format: FF-COL-XXXX (4-digit alphanumeric)
// ─────────────────────────────────────────────────────────────────────────────
export function generateCollectionCode() {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return `FF-COL-${code}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Vendor Commission Configuration
// 10-15% per vendor, negotiated at onboarding. Default 12%.
// ─────────────────────────────────────────────────────────────────────────────
export const VENDOR_COMMISSION_RANGE = {
  min: 0.10,     // 10% — floor
  max: 0.15,     // 15% — ceiling
  default: 0.12  // 12% — default for new vendors
};

// ─────────────────────────────────────────────────────────────────────────────
// Vendor Status
// ─────────────────────────────────────────────────────────────────────────────
export const VENDOR_STATUS = {
  PENDING: 'pending',    // onboarding submitted, awaiting admin approval
  ACTIVE: 'active',      // approved and selling
  SUSPENDED: 'suspended' // temporarily disabled by admin
};

// ─────────────────────────────────────────────────────────────────────────────
// Vendor Payout Cycle
// ─────────────────────────────────────────────────────────────────────────────
export const VENDOR_PAYOUT_CYCLE = {
  WEEKLY: 'weekly',     // direct subs — weekly disbursement
  MONTHLY: 'monthly'    // pass-based — monthly disbursement
};

// ─────────────────────────────────────────────────────────────────────────────
// Escrow Release Window
// Vendor payout released 48 hours after delivery (collected) to allow
// for consumer protection claims (damaged items, incorrect orders).
// ─────────────────────────────────────────────────────────────────────────────
export const ESCROW_RELEASE_HOURS = 48;

// ─────────────────────────────────────────────────────────────────────────────
// Cart Limits
// ─────────────────────────────────────────────────────────────────────────────
export const MAX_CART_ITEMS = 50;
export const MAX_QUANTITY_PER_ITEM = 99;

// ─────────────────────────────────────────────────────────────────────────────
// Product Review (1-5 stars, same pattern as gym/trainer reviews)
// ─────────────────────────────────────────────────────────────────────────────
export const MIN_RATING = 1;
export const MAX_RATING = 5;
export const MIN_REVIEW_TEXT_LENGTH = 3;
export const MAX_REVIEW_TEXT_LENGTH = 1000;
export const REVIEW_STATUS = {
  PUBLISHED: 'published',
  FLAGGED: 'flagged',
  HIDDEN: 'hidden'
};
