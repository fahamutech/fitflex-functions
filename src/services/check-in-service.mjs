// Check-in service: orchestrates BL-012 validation + BL-010/011 visit counting + logging.
// Pure DI: receives repos via constructor.

import { validateCheckIn } from '../shared/check-in-rules.mjs';
import { randomUUID } from 'node:crypto';

export function createCheckInService({ users, gyms, subscriptions, checkins }) {
  function todayBoundsUTC(now = new Date()) {
    // EAT (UTC+3) day window expressed in UTC
    const eatNow = new Date(now.getTime() + 3 * 3_600_000);
    const dayStart = new Date(Date.UTC(eatNow.getUTCFullYear(), eatNow.getUTCMonth(), eatNow.getUTCDate()));
    const startUtc = new Date(dayStart.getTime() - 3 * 3_600_000);
    const endUtc   = new Date(startUtc.getTime() + 86_400_000);
    return { startUtc, endUtc };
  }

  function visitsUsedInCycle(memberId, sub) {
    if (!sub) return 0;
    const since = +new Date(sub.cycleStartedAt || sub.startedAt);
    return checkins.filter(c => c.memberId === memberId && +new Date(c.timestamp) >= since && c.visitConsumed).length;
  }

  function todaysCheckins(memberId, now = new Date()) {
    const { startUtc, endUtc } = todayBoundsUTC(now);
    return checkins.filter(c =>
      c.memberId === memberId &&
      new Date(c.timestamp) >= startUtc &&
      new Date(c.timestamp) <  endUtc
    );
  }

  return {
    /**
     * Perform a check-in for memberId at gymId, scanned by operator.
     * @returns { ok, failure?, checkin?, visitNumberInCycle? }
     */
    perform({ memberId, gymId, method = 'gym_scanned', now = new Date() }) {
      const member = users.find(u => u.id === memberId);
      if (!member) return { ok: false, failure: 'member_not_found' };
      const gym = gyms.find(g => g.id === gymId);
      if (!gym) return { ok: false, failure: 'gym_not_found' };

      const subs = subscriptions.filter(s => s.memberId === memberId);
      const sub  = subs
        .filter(s => ['active', 'expired', 'suspended'].includes(s.status))
        .sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt))[0];

      const cycleUsage = { visitsUsedInCycle: visitsUsedInCycle(memberId, sub) };
      const todays = todaysCheckins(memberId, now);

      const result = validateCheckIn({ subscription: sub, gym, todaysCheckins: todays, cycleUsage, now });
      if (!result.ok) return result;

      // Idempotency: if same member already checked in at same gym today, return existing
      const existing = todays.find(c => c.gymId === gymId);
      if (existing) {
        return { ok: true, checkin: existing, visitNumberInCycle: existing.visitNumberInCycle, idempotent: true };
      }

      // Log check-in (all 8 BL-015 fields)
      const visitNumber = result.visitConsumed
        ? cycleUsage.visitsUsedInCycle + 1
        : cycleUsage.visitsUsedInCycle;
      const row = {
        id: randomUUID(),
        memberId,
        gymId,
        timestamp: now.toISOString(),
        method,
        subscriptionType: sub.type,           // 'platform_pass' | 'direct_sub' | 'roaming_topup'
        passTier: sub.tier ?? null,
        visitNumberInCycle: Number.isFinite(visitNumber) ? visitNumber : null,
        gymTier: gym.tier,
        creditsDeductedTzs: 0,                 // roaming wired separately
        visitConsumed: !!result.visitConsumed
      };
      checkins.insert(row);
      return { ok: true, checkin: row, visitNumberInCycle: row.visitNumberInCycle };
    }
  };
}
