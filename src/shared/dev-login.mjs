// Dev-only mock-auth helper. Maps a requested role to a deterministic test
// identity so blackbox runs reuse the same seeded users across launches.
// NEVER used in production — the endpoint that consumes this is hard-blocked
// when NODE_ENV === 'production'.

const ROLE_ALIASES = Object.freeze({
  member: 'member',
  trainer: 'trainer',
  owner: 'gym_operator',
  gym_owner: 'gym_operator',
  gym_operator: 'gym_operator',
  vendor: 'vendor',
});

const IDENTITIES = Object.freeze({
  member: {
    id: 'usr_dev_member',
    email: 'dev.member@fitflex.test',
    phone: '+255700000010',
    displayName: 'Dev Member',
  },
  trainer: {
    id: 'usr_dev_trainer',
    email: 'dev.trainer@fitflex.test',
    phone: '+255700000011',
    displayName: 'Dev Trainer',
  },
  gym_operator: {
    id: 'usr_dev_owner',
    email: 'dev.owner@fitflex.test',
    phone: '+255700000012',
    displayName: 'Dev Owner',
  },
  vendor: {
    id: 'usr_dev_vendor',
    email: 'dev.vendor@fitflex.test',
    phone: '+255700000013',
    displayName: 'Dev Vendor',
  },
});

/** Normalise an incoming role string to a canonical userType, or null if unknown. */
export function normalizeDevRole(role) {
  return ROLE_ALIASES[String(role || '').toLowerCase()] ?? null;
}

/**
 * Returns the deterministic dev identity for a requested role.
 * @returns {{ id, email, phone, displayName, userType } | null}
 */
export function buildDevIdentity(role) {
  const userType = normalizeDevRole(role);
  if (!userType) return null;
  return { ...IDENTITIES[userType], userType };
}

export const DEV_GYM_ID = 'gym_dev_demo';
export const DEV_OWNER_GYM_ID = 'gym_dev_owner';

/**
 * The marketplace product the dev vendor login seeds. It has no reviews and no
 * sales, so it claims none (rating, reviewCount and soldCount are 0), and its
 * category is one of the real keys. Re-seeding overwrites older seeded values.
 */
export function devMarketplaceProduct(vendorId, nowIso) {
  return {
    id: 'prd_dev_marketplace', vendorId,
    name: 'FitFlex Resistance Bands', description: 'Five-band training set for home or gym workouts.',
    category: 'accessories_gear', brand: 'FitFlex', priceTzs: 45000, discountPriceTzs: 39000,
    stock: 25, sku: 'FF-RB-5', weightKg: 0.7, distanceKm: 3.2,
    variants: [{ name: 'Five-band set', stock: 25 }],
    images: ['https://images.unsplash.com/photo-1598289431512-b97b0917affc?w=800'],
    visibility: 'visible', deliveryAvailable: true, status: 'active', approvalStatus: 'approved',
    rating: 0, reviewCount: 0, soldCount: 0,
    homepageVisible: true, homepagePriority: 5000, createdAt: nowIso, updatedAt: nowIso,
  };
}
