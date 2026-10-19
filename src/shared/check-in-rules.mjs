// BL-010, BL-011, BL-012: visit counting & check-in validation.
// Pure functions — no I/O, fully unit-testable.

import { PASS_TIERS, SUBSCRIPTION_GRACE_HOURS } from './constants.mjs';
import { effectiveSubscriptionStatus } from './subscription-status.mjs';

/**
 * Check-in failure codes mapped to specific user-facing CTAs (per BL-012).
 */
export const CHECKIN_FAILURE = Object.freeze({
  SUBSCRIPTION_INACTIVE: 'subscription_inactive',
  TIER_NOT_COVERED:      'tier_not_covered',
  VISITS_EXHAUSTED:      'visits_exhausted',
  GYM_CLOSED:            'gym_closed',
  BASIC_DAILY_LIMIT:     'basic_daily_limit',
  WRONG_GYM:             'wrong_gym'
});

// Direct gym plans and trainer passes are bought for ONE gym (homeGymId);
// platform passes roam across every gym their tier covers.
const GYM_BOUND_TYPES = new Set(['direct_sub', 'trainer_pass']);

/** Does this subscription grant entry to this gym at all (ignoring status)? */
export function subscriptionCoversGym(subscription, gym) {
  if (!subscription || !gym) return false;
  if (GYM_BOUND_TYPES.has(subscription.type)) return subscription.homeGymId === gym.id;
  return true;
}

/**
 * Was this check-in made on this subscription? A pass's visit count and its
 * "already visited today" rule look only at its own check-ins: a visit funded
 * by a company benefit, or made on another membership (a direct plan at some
 * gym), doesn't use up a pass visit or block the pass that day. Check-ins
 * recorded before they carried the subscription link fall back to the
 * subscription type (and count if they have no type either).
 */
export function fundedBySubscription(subscription) {
  return (checkin) => {
    if (!subscription) return false;
    if (checkin.subscriptionId != null) return checkin.subscriptionId === subscription.id;
    return checkin.subscriptionType == null || checkin.subscriptionType === subscription.type;
  };
}

/**
 * Pick the subscription to validate a check-in against: the newest one that
 * covers this gym, else the newest overall (so the failure reason is still
 * meaningful, e.g. wrong_gym).
 */
export function pickSubscriptionForGym(subscriptions, gym) {
  const newestFirst = [...(subscriptions || [])]
    .sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt));
  return newestFirst.find(s => subscriptionCoversGym(s, gym)) || newestFirst[0] || null;
}

const isWithinGrace = (expiresAt, nowMs) =>
  expiresAt && nowMs <= +new Date(expiresAt) + SUBSCRIPTION_GRACE_HOURS * 3_600_000;

const isGymOpen = (gym, now) => {
  if (!gym?.operatingHours) return true; // assume 24/7 if not set
  const day = now.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'Africa/Dar_es_Salaam' }).toLowerCase();
  const window = gym.operatingHours[day] || gym.operatingHours.default;
  if (!window) return false;
  const [openH, openM]   = window.open.split(':').map(Number);
  const [closeH, closeM] = window.close.split(':').map(Number);
  const m = now.getUTCHours() * 60 + now.getUTCMinutes() + 3 * 60; // EAT = UTC+3
  return m >= openH * 60 + openM && m < closeH * 60 + closeM;
};

const gymAccessTiers = (access) => {
  switch (access) {
    case 'standard':
      return ['standard'];
    case 'midtier':
      return ['standard', 'midtier'];
    case 'premium':
      return ['standard', 'midtier', 'premium'];
    case 'luxury_executive':
      return ['standard', 'midtier', 'premium', 'luxury_executive'];
    default:
      return null;
  }
};

const tierCoversGym = (tierCfg, gym) => {
  const tiers = tierCfg.gymTiers ?? gymAccessTiers(tierCfg.gymAccess);
  return !tiers || tiers.includes(gym.tier);
};

/**
 * BL-010 / BL-011: determine whether THIS check-in consumes a visit slot.
 * Each gym visited on a day consumes one visit (decided 1 Oct 2026): a second
 * gym the same day uses a second visit, and that gym is paid for it. Going
 * back into the SAME gym the same day consumes nothing more. (Basic is still
 * limited to one gym a day; see validateCheckIn.)
 *
 * @param {Array} todaysCheckins same-day prior check-ins for the member
 * @param {string} gymId
 * @returns {{ consumesVisit: boolean, sameDaySameGym: boolean, sameDayAlreadyCheckedIn: boolean, differentGymToday: boolean }}
 */
export function classifyVisit(todaysCheckins, gymId) {
  const sameGym = todaysCheckins.some(c => c.gymId === gymId);
  const otherGym = todaysCheckins.some(c => c.gymId !== gymId);
  const alreadyCheckedInToday = todaysCheckins.length > 0;
  return {
    consumesVisit: !sameGym,
    sameDaySameGym: sameGym,
    sameDayAlreadyCheckedIn: alreadyCheckedInToday,
    differentGymToday: otherGym
  };
}

/**
 * BL-012: validate a check-in attempt sequentially. Returns { ok, failure?, visitConsumed }.
 *
 * @param {Object} ctx
 * @param {Object} ctx.subscription { status, tier, expiresAt }
 * @param {Object} ctx.gym { id, tier, operatingHours }
 * @param {Array}  ctx.todaysCheckins same-day check-ins for the member
 * @param {Object} ctx.cycleUsage { visitsUsedInCycle }
 * @param {Date}   ctx.now
 * @param {Object} ctx.tierConfig optional subscription-tier override from platform settings
 */
export function validateCheckIn({ subscription, gym, todaysCheckins, cycleUsage, now = new Date(), tierConfig }) {
  // 1. Subscription active (with grace) — status is DERIVED from expiresAt (A1)
  const status = effectiveSubscriptionStatus(subscription, now);
  if (!subscription || (status !== 'active' &&
      !(status === 'expired' && isWithinGrace(subscription.expiresAt, +now)))) {
    return { ok: false, failure: CHECKIN_FAILURE.SUBSCRIPTION_INACTIVE };
  }

  if (!subscriptionCoversGym(subscription, gym)) {
    return { ok: false, failure: CHECKIN_FAILURE.WRONG_GYM };
  }

  const tierCfg = tierConfig ?? PASS_TIERS[subscription.tier] ?? { visitCap: Infinity, multiGymPerDay: true };
  if (!tierCoversGym(tierCfg, gym)) {
    return { ok: false, failure: CHECKIN_FAILURE.TIER_NOT_COVERED };
  }

  // Basic-tier daily-gym restriction: cannot visit a different gym same day
  const visit = classifyVisit(todaysCheckins, gym.id);
  if (subscription.tier === 'basic' && visit.differentGymToday) {
    return { ok: false, failure: CHECKIN_FAILURE.BASIC_DAILY_LIMIT };
  }

  // 3. Visits remaining (skip for unlimited tiers)
  if (Number.isFinite(tierCfg.visitCap) && visit.consumesVisit &&
      cycleUsage.visitsUsedInCycle >= tierCfg.visitCap) {
    return { ok: false, failure: CHECKIN_FAILURE.VISITS_EXHAUSTED };
  }

  // 4. Operating hours
  if (!isGymOpen(gym, now)) {
    return { ok: false, failure: CHECKIN_FAILURE.GYM_CLOSED };
  }

  return { ok: true, visitConsumed: visit.consumesVisit, sameDaySameGym: visit.sameDaySameGym };
}

/**
 * T5: a trainer linked to the gym (owner-approved) enters free — no pass, no
 * visit counted; only opening hours apply.
 */
export function validateTrainerHomeEntry({ gym, now = new Date() }) {
  if (!isGymOpen(gym, now)) return { ok: false, failure: CHECKIN_FAILURE.GYM_CLOSED };
  return { ok: true, visitConsumed: false, sameDaySameGym: false };
}

/**
 * Until a gym's owner is verified, only the gym's own people get in: its home
 * trainers and its direct members (a gym plan for this gym). FitFlex Pass
 * members and sponsor-paid visits wait for verification. True when THIS
 * visitor needs the gym to be verified. Used by the check-in itself and by the
 * scanner's preview (operator verify), so both decide the same way.
 */
export function visitNeedsVerifiedGym({ subscription, gym, homeTrainer = false }) {
  if (homeTrainer) return false;
  const gymsOwnMember = subscription?.type === 'direct_sub' && subscriptionCoversGym(subscription, gym);
  return !gymsOwnMember;
}

/**
 * Every refusal code a check-in or a scanner preview can return, for docs,
 * app translations and tests. Response shapes are unchanged: these appear as
 * `failure` (check-in) / `reason` (preview, eligible = false) or `error`.
 *   Rule failures (CHECKIN_FAILURE): see above.
 *   member_not_found              the QR's member does not exist
 *   gym_not_found                 the gym does not exist
 *   gym_not_verified              the gym's owner is not verified yet; only its own members and home trainers get in
 *   gym_required                  a staff member of several gyms must pick the gym first
 *   invalid_or_expired_qr         the member's QR is invalid or has expired
 *   not_your_gym                  the staff member does not manage this gym
 *   operator_not_assigned_to_gym  the staff member manages no gym
 *   invalid_gym_qr                the entrance QR the member scanned is invalid
 *   active_subscription_required  no active pass or benefit, so no member QR is issued
 */
export const CHECKIN_REFUSAL_CODES = Object.freeze([...new Set([
  ...Object.values(CHECKIN_FAILURE),
  'member_not_found',
  'gym_not_found',
  'gym_not_verified',
  'gym_required',
  'invalid_or_expired_qr',
  'not_your_gym',
  'operator_not_assigned_to_gym',
  'invalid_gym_qr',
  'active_subscription_required',
])]);

/**
 * The scanner preview's other `reason` values (POST /operator/verify-qr):
 * eligible ones, and the two "not yet" states that are not check-in refusals.
 * A preview with eligible = false otherwise carries a CHECKIN_REFUSAL_CODES code.
 */
export const VERIFY_PREVIEW_REASONS = Object.freeze({
  eligible: Object.freeze(['pass_valid', 'trainer_home_gym', 'sponsor_benefit']),
  notEligible: Object.freeze(['no_active_pass', 'select_gym']),
});
