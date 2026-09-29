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

/**
 * The dates a paid plan runs on once its payment is confirmed. A plan's
 * period starts when it is paid for, not when it was requested — otherwise
 * the days spent waiting for approval are lost. The plan keeps its length
 * (1, 7 or 30 days). Returns {} for a plan not waiting on payment.
 */
export function activationDates(sub, now = new Date()) {
  if (!sub || sub.status !== 'payment_pending' || !sub.startedAt || !sub.expiresAt) return {};
  const lengthMs = Math.max(0, +new Date(sub.expiresAt) - +new Date(sub.startedAt));
  const expiresAt = new Date(+now + lengthMs).toISOString();
  return { startedAt: now.toISOString(), cycleStartedAt: now.toISOString(), renewsAt: expiresAt, expiresAt };
}
