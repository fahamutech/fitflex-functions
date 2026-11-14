import { updateIf } from './conditional-update.mjs';
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
export function activationDates(sub, now = new Date(), notBefore = null) {
  if (!sub || sub.status !== 'payment_pending' || !sub.startedAt || !sub.expiresAt) return {};
  const lengthMs = Math.max(0, +new Date(sub.expiresAt) - +new Date(sub.startedAt));
  // A renewal paid before the current plan ends starts when that plan ends (owner decision 2026-11-15).
  const start = notBefore && +new Date(notBefore) > +now ? new Date(notBefore) : now;
  const expiresAt = new Date(+start + lengthMs).toISOString();
  return { startedAt: start.toISOString(), cycleStartedAt: start.toISOString(), renewsAt: expiresAt, expiresAt };
}

/**
 * A paid renewal waiting for the member's current plan to end. Stored as
 * status 'scheduled' with its future startedAt; every query that looks for
 * 'active' plans ignores it until it is promoted (promoteStartedSubscriptions).
 */
export const SCHEDULED = 'scheduled';

/** Has a scheduled plan's start come? */
export const scheduledHasStarted = (sub, now = new Date()) =>
  sub?.status === SCHEDULED && Boolean(sub.startedAt) && +new Date(sub.startedAt) <= +now;

/** Plans of the same product a renewal of `sub` follows: FitFlex Pass (any tier), or the same gym's plan / trainer pass. */
export const sameProduct = (a, b) => a.memberId === b.memberId && a.type === b.type
  && (a.type === 'platform_pass' || (a.homeGymId ?? null) === (b.homeGymId ?? null));

/**
 * When a newly paid plan should start: the end of the member's running (or
 * already scheduled) plan of the same product, or null to start now. A
 * suspended or expired plan does not hold a renewal back.
 */
export function renewalStartFor(sub, memberSubs, now = new Date()) {
  let latest = null;
  for (const s of memberSubs || []) {
    if (!s || s.id === sub?.id || !sameProduct(s, sub) || !s.expiresAt) continue;
    const running = s.status === SCHEDULED || effectiveSubscriptionStatus(s, now) === 'active';
    if (!running) continue;
    const end = +new Date(s.expiresAt);
    if (end > +now && (latest == null || end > latest)) latest = end;
  }
  return latest == null ? null : new Date(latest);
}

/**
 * The patch that marks a plan paid: active from now, or scheduled to start when
 * the member's current plan of the same product ends.
 */
export function paidPlanPatch(sub, memberSubs, now = new Date(), { scheduleRenewals = true } = {}) {
  const notBefore = scheduleRenewals ? renewalStartFor(sub, memberSubs, now) : null;
  const dates = activationDates(sub, now, notBefore);
  const scheduled = Boolean(dates.startedAt) && +new Date(dates.startedAt) > +now;
  return { status: scheduled ? SCHEDULED : 'active', ...dates };
}

/**
 * Turn scheduled plans whose start has come into active ones (stored), and
 * return the list with them active. `onStarted(sub)` runs once per plan that
 * this call promoted (best-effort). A plan promoted by someone else at the same
 * time is not reported twice: the write is conditional on 'scheduled'.
 */
export async function promoteStartedSubscriptions(store, subs, { now = new Date(), onStarted = null } = {}) {
  const out = [];
  for (const s of subs || []) {
    if (!scheduledHasStarted(s, now)) { out.push(s); continue; }
    const updated = await updateIf(store, s.id, { status: SCHEDULED }, { status: 'active' });
    const row = { ...s, ...(updated && typeof updated === 'object' ? updated : {}), status: 'active' };
    if (updated && onStarted) { try { await onStarted(row); } catch { /* best-effort */ } }
    out.push(row);
  }
  return out;
}
