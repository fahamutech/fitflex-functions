// Check-in service: orchestrates BL-012 validation + BL-010/011 visit counting + logging.
// Pure DI: receives repos via constructor.

import { validateCheckIn, pickSubscriptionForGym, subscriptionCoversGym, validateTrainerHomeEntry, fundedBySubscription } from '../shared/check-in-rules.mjs';
import { CHECKIN_STATUS, sourceForMethod, isDuplicateVisit } from '../shared/checkin-status.mjs';
import { localDay } from '../shared/member-progress.mjs';
import { randomUUID } from 'node:crypto';

export function createCheckInService({ users, gyms, subscriptions, checkins, getTierConfig, trainers = null, b2bFunding = null, gymOpenToPass = null }) {
  /** T5: the user is an active trainer linked to this gym (trains there free). */
  function homeGymIds(userId) {
    const t = trainers?.find?.(r => (r.userId === userId || r.id === userId) && r.status !== 'inactive' && r.status !== 'suspended');
    return t?.gymIds || [];
  }
  const isHomeGymTrainer = (userId, gymId) => homeGymIds(userId).includes(gymId);

  function todayBoundsUTC(now = new Date()) {
    // EAT (UTC+3) day window expressed in UTC
    const eatNow = new Date(now.getTime() + 3 * 3_600_000);
    const dayStart = new Date(Date.UTC(eatNow.getUTCFullYear(), eatNow.getUTCMonth(), eatNow.getUTCDate()));
    const startUtc = new Date(dayStart.getTime() - 3 * 3_600_000);
    const endUtc   = new Date(startUtc.getTime() + 86_400_000);
    return { startUtc, endUtc };
  }

  async function visitsUsedInCycle(memberId, sub) {
    if (!sub) return 0;
    const since = +new Date(sub.cycleStartedAt || sub.startedAt);
    const own = fundedBySubscription(sub);
    const rows = await checkins.filterAsync(c => c.memberId === memberId && +new Date(c.timestamp) >= since && c.visitConsumed && own(c));
    return rows.length;
  }

  async function todaysCheckins(memberId, now = new Date()) {
    const { startUtc, endUtc } = todayBoundsUTC(now);
    return checkins.filterAsync(c =>
      c.memberId === memberId &&
      new Date(c.timestamp) >= startUtc &&
      new Date(c.timestamp) <  endUtc
    );
  }

  /** The member's live visit at this gym today, after the database refused a second one. */
  async function visitAlreadyRecorded(memberId, gymId, now) {
    const existing = (await todaysCheckins(memberId, now)).find(c => c.gymId === gymId && c.status !== CHECKIN_STATUS.VOIDED);
    return existing ? { ok: true, checkin: existing, visitNumberInCycle: existing.visitNumberInCycle, idempotent: true } : null;
  }

  /**
   * Check in on a B2B benefit: reserve the allowance, record the visit, then
   * confirm. Returns null when no benefit covers the visit. The member's own
   * pass is not consulted and no pass visit is used.
   *
   * The three steps are separate writes. Whatever fails, the ledger ends up
   * right: a hold whose visit was never recorded is cancelled, and a hold
   * whose visit exists is approved, here or by the reconciler
   * (b2bFunding.reconcileHolds) a few minutes later.
   */
  async function performWithBenefit({ memberId, gym, method, now }) {
    const checkinId = randomUUID();
    let hold = null;
    try {
      hold = await b2bFunding.holdGymVisit({ memberId, gym, checkinId, now, method });
    } catch (err) {
      console.warn('[check-in] B2B benefit evaluation failed, using the member\'s own pass:', err?.message);
      return null;
    }
    if (!hold) return null;

    const row = {
      id: checkinId,
      memberId,
      gymId: gym.id,
      timestamp: now.toISOString(),
      method,
      subscriptionType: 'b2b_benefit',
      passTier: null,
      visitNumberInCycle: null,
      gymTier: gym.tier,
      creditsDeductedTzs: 0,
      visitConsumed: false,                    // no visit taken from a personal pass
      status: CHECKIN_STATUS.VALID,
      subscriptionId: null,
      businessDate: localDay(now),
      source: sourceForMethod(method)
    };
    try {
      await checkins.insertAsync(row);
    } catch (err) {
      const duplicate = isDuplicateVisit(err);
      await b2bFunding.cancel({ consumptionId: hold.consumption.id, reason: duplicate ? 'duplicate_scan' : 'checkin_not_recorded' })
        .catch(e => console.warn('[check-in] could not release a B2B hold (the reconciler will):', e?.message));
      // Another scan recorded this visit a moment ago: one visit, one charge.
      const existing = duplicate ? await visitAlreadyRecorded(memberId, gym.id, now) : null;
      if (existing) return existing;
      throw err;
    }
    // The visit is recorded, so the member is in. A confirmation that fails
    // must not turn that into an error; the reconciler approves the hold.
    try {
      await b2bFunding.confirm({ consumptionId: hold.consumption.id });
    } catch (err) {
      console.warn('[check-in] B2B hold not confirmed yet (the reconciler will):', err?.message);
    }
    const c = hold.consumption;
    return {
      ok: true,
      checkin: row,
      visitNumberInCycle: null,
      b2b: {
        consumptionId: c.id,
        organization: hold.organization ?? null,
        program: hold.program ?? null,
        benefit: hold.benefit ?? null,
        grossTzs: c.grossTzs,
        sponsorTzs: c.sponsorTzs,
        beneficiaryTzs: c.beneficiaryTzs,
        remaining: hold.remaining ?? null,
      },
    };
  }

  return {
    homeGymIds,
    isHomeGymTrainer,

    /**
     * Perform a check-in for memberId at gymId, scanned by operator.
     * @returns { ok, failure?, checkin?, visitNumberInCycle? }
     */
    async perform({ memberId, gymId, method = 'gym_scanned', now = new Date() }) {
      const member = await users.findByIdAsync(memberId);
      if (!member) return { ok: false, failure: 'member_not_found' };
      const gym = gyms.find(g => g.id === gymId);
      if (!gym) return { ok: false, failure: 'gym_not_found' };

      const subs = await subscriptions.filterAsync(s => s.memberId === memberId);
      const sub  = pickSubscriptionForGym(
        subs.filter(s => ['active', 'expired', 'suspended'].includes(s.status)),
        gym,
      );

      const cycleUsage = { visitsUsedInCycle: await visitsUsedInCycle(memberId, sub) };
      const todays = await todaysCheckins(memberId, now);

      // Idempotency: re-entering the SAME gym on the same EAT day returns the
      // existing record. A different gym still goes through validation, so
      // Basic's one-gym-per-day rule applies and that gym gets its own
      // check-in row (its payout depends on it). A second gym the same day
      // consumes a second visit (classifyVisit), so it needs one left.
      const existingToday = todays.find(c => c.gymId === gymId);
      if (existingToday) {
        return {
          ok: true,
          checkin: existingToday,
          visitNumberInCycle: existingToday.visitNumberInCycle,
          idempotent: true
        };
      }

      const homeTrainer = isHomeGymTrainer(memberId, gymId);

      // Until the gym's owner is verified, only the gym's own people get in:
      // its direct members and its home trainers. FitFlex Pass members, and
      // visits a sponsor would pay for through FitFlex, wait for verification.
      const gymsOwnMember = sub?.type === 'direct_sub' && subscriptionCoversGym(sub, gym);
      if (gymOpenToPass && !homeTrainer && !gymsOwnMember && !(await gymOpenToPass(gymId))) {
        return { ok: false, failure: 'gym_not_verified' };
      }

      // A sponsor's B2B benefit pays for the visit before the member's own
      // pass is touched. When none applies (no benefit, wrong gym, allowance
      // used up, anything going wrong) the normal validation below decides,
      // exactly as it always has.
      if (b2bFunding && !homeTrainer && validateTrainerHomeEntry({ gym, now }).ok) {
        const funded = await performWithBenefit({ memberId, gym, method, now });
        if (funded) return funded;
      }

      const result = homeTrainer
        ? validateTrainerHomeEntry({ gym, now })
        : validateCheckIn({
          subscription: sub,
          gym,
          // Only this subscription's visits today: a company-funded visit or a
          // visit on another membership earlier in the day doesn't make this
          // one a "second gym".
          todaysCheckins: todays.filter(fundedBySubscription(sub)),
          cycleUsage,
          now,
          tierConfig: getTierConfig?.(sub?.tier),
        });
      if (!result.ok) return result;

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
        // 'platform_pass' | 'direct_sub' | 'roaming_topup' | 'trainer_pass' | 'trainer_home'
        subscriptionType: homeTrainer ? 'trainer_home' : sub.type,
        passTier: homeTrainer ? null : (sub.tier ?? null),
        visitNumberInCycle: Number.isFinite(visitNumber) ? visitNumber : null,
        gymTier: gym.tier,
        creditsDeductedTzs: 0,                 // roaming wired separately
        visitConsumed: !!result.visitConsumed,
        // Settlement inputs: lifecycle, the member cycle (subscription) this
        // visit was validated against, its EAT day, and how it was recorded.
        status: CHECKIN_STATUS.VALID,
        subscriptionId: homeTrainer ? null : (sub.id ?? null),
        businessDate: localDay(now),
        source: sourceForMethod(method)
      };
      try {
        await checkins.insertAsync(row);
      } catch (err) {
        // Another scan recorded this visit a moment ago: return that one.
        const existing = isDuplicateVisit(err) ? await visitAlreadyRecorded(memberId, gymId, now) : null;
        if (existing) return existing;
        throw err;
      }
      return { ok: true, checkin: row, visitNumberInCycle: row.visitNumberInCycle };
    }
  };
}
