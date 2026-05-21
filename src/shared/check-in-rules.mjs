// BL-010, BL-011, BL-012: visit counting & check-in validation.
// Pure functions — no I/O, fully unit-testable.

import { PASS_TIERS, SUBSCRIPTION_GRACE_HOURS } from './constants.mjs';

/**
 * Check-in failure codes mapped to specific user-facing CTAs (per BL-012).
 */
export const CHECKIN_FAILURE = Object.freeze({
  SUBSCRIPTION_INACTIVE: 'subscription_inactive',
  TIER_NOT_COVERED:      'tier_not_covered',
  VISITS_EXHAUSTED:      'visits_exhausted',
  GYM_CLOSED:            'gym_closed',
  BASIC_DAILY_LIMIT:     'basic_daily_limit'
});

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

/**
 * BL-010 / BL-011: determine whether THIS check-in consumes a visit slot.
 * Any prior same-day check-in = does NOT consume an additional slot.
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
    consumesVisit: !alreadyCheckedInToday,
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
 */
export function validateCheckIn({ subscription, gym, todaysCheckins, cycleUsage, now = new Date() }) {
  // 1. Subscription active (with grace)
  if (!subscription || (subscription.status !== 'active' &&
      !(subscription.status === 'expired' && isWithinGrace(subscription.expiresAt, +now)))) {
    return { ok: false, failure: CHECKIN_FAILURE.SUBSCRIPTION_INACTIVE };
  }

  // 2. Tier covers this gym's tier — TEMPORARILY DISABLED: all gym tiers accessible
  const tierCfg = PASS_TIERS[subscription.tier] ?? { visitCap: Infinity, multiGymPerDay: true };

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
