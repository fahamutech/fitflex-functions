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
