// A1 — derived subscription status.
// A subscription's usable status can never rely solely on the stored `status`
// column: nothing guarantees a sweep flipped it when `expiresAt` passed.
// `effectiveSubscriptionStatus` derives the truth from `expiresAt` so expiry
// is enforced at read/validation time everywhere.

/**
 * @param {{ status?: string, expiresAt?: string|null }|null} sub
 * @param {Date} now
 * @returns {string|null} derived status ('expired' once past expiresAt),
 *   preserving 'suspended', or the stored status otherwise.
 */
export function effectiveSubscriptionStatus(sub, now = new Date()) {
  if (!sub) return null;
  if (sub.status === 'suspended') return 'suspended';
  if (sub.expiresAt && +now > +new Date(sub.expiresAt)) return 'expired';
  return sub.status ?? null;
}
