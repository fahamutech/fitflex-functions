// A1 — derived subscription status.
// A subscription's usable status can never rely solely on the stored `status`
// column: nothing guarantees a sweep flipped it when `expiresAt` passed.
// `effectiveSubscriptionStatus` derives the truth from `expiresAt` so expiry
// is enforced at read/validation time everywhere.

/**
 * The subscription a member's account runs on: the most recently started
 * one that has been paid for (active, expired or suspended). Subscriptions
 * still waiting on, or refused, payment don't count.
 */
export function currentSubscription(subs) {
  return (subs || [])
    .filter(s => ['active', 'expired', 'suspended'].includes(s.status))
    .sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt))[0] || null;
}

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
