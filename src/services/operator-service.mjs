// Operator (gym-side) check-in + dashboard service — QR verification without
// consuming a visit, the actual scan-to-checkin flow, recent activity, and
// analytics for the owner/operator Home dashboard.
import { resolveOperatorGymSelection, operatorGymIds } from '../shared/operator-gym-selection.mjs';
import { validateCheckIn, pickSubscriptionForGym } from '../shared/check-in-rules.mjs';
import { calculatePayout } from '../shared/payout-engine.mjs';
import { issue as issueQr, verify as verifyQrToken, issueGymQr, verifyGymQr } from '../auth/qr-token.mjs';

function sameEatDate(a, b) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Dar_es_Salaam',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return fmt.format(new Date(a)) === fmt.format(new Date(b));
}

export function createOperatorService({
  users, gyms, subscriptions, checkins, checkInService, publicUserId, settingsService, memberManagement,
}) {
  /** Member self-service QR issuance — requires an active subscription. */
  async function issueMemberQr(memberId) {
    const allSubs = await subscriptions.filterAsync(s => s.memberId === memberId && s.status === 'active');
    const active = allSubs.sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt))[0];
    if (!active) return { error: 'active_subscription_required', status: 403 };
    return { qr: issueQr(memberId) };
  }

  async function verifyQr({ operator, gymId, qrToken }) {
    const claim = verifyQrToken(qrToken);
    if (!claim) return { status: 401, body: { ok: false, failure: 'invalid_or_expired_qr' } };
    const gymSelection = resolveOperatorGymSelection(operator, gymId);
    const operatorGymIdList = gymSelection.ids;
    const gym = gymSelection.ok ? gyms.find(g => g.id === gymSelection.gymId) || null : null;
    if (gymSelection.failure === 'not_your_gym') return { status: 403, body: { error: 'not_your_gym' } };
    const member = await users.findByIdAsync(claim.userId);
    if (!member) return { status: 404, body: { error: 'member_not_found' } };
    const allSubs = await subscriptions.filterAsync(s => s.memberId === member.id && s.status === 'active');
    const sub = gym
      ? pickSubscriptionForGym(allSubs, gym)
      : allSubs.sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt))[0] || null;
    let eligible = false;
    let reason = 'no_active_pass';
    let visitsUsed = 0;
    let visitCap = null;
    if (gymSelection.requiresGymSelection) {
      reason = 'select_gym';
    } else if (!gym) {
      return { status: 400, body: { error: 'operator_not_assigned_to_gym' } };
    } else if (sub) {
      const since = +new Date(sub.cycleStartedAt);
      const allCheckins = await checkins.filterAsync(c => c.memberId === member.id && c.visitConsumed && +new Date(c.timestamp) >= since);
      visitsUsed = allCheckins.length;
      visitCap = settingsService.visitCapForTier(sub.tier);
      const now = new Date();
      const allTodaysCheckins = await checkins.filterAsync(c => c.memberId === member.id && sameEatDate(c.timestamp, now));
      const validation = validateCheckIn({
        subscription: sub,
        gym,
        todaysCheckins: allTodaysCheckins,
        cycleUsage: { visitsUsedInCycle: visitsUsed },
        now,
        tierConfig: settingsService.getTierConfig(sub.tier),
      });
      if (validation.ok) {
        eligible = true;
        reason = 'pass_valid';
      } else {
        reason = validation.failure;
      }
    }
    return {
      status: 200,
      body: {
        ok: true,
        member: { id: member.id, publicId: await publicUserId(member), userCode: await publicUserId(member), photoUrl: member.photoUrl },
        subscription: sub ? { tier: sub.tier, status: sub.status } : null,
        gym: gym ? { id: gym.id, name: gym.name, tier: gym.tier } : null,
        requiresGymSelection: !gym && operatorGymIdList.length > 1,
        eligible,
        reason,
        visitsUsed,
        visitCap,
      },
    };
  }

  async function checkIn({ operator, gymId, qrToken }) {
    const claim = verifyQrToken(qrToken);
    if (!claim) return { status: 401, body: { ok: false, failure: 'invalid_or_expired_qr' } };
    const gymSelection = resolveOperatorGymSelection(operator, gymId);
    if (gymSelection.requiresGymSelection) return { status: 400, body: { ok: false, failure: 'gym_required' } };
    if (gymSelection.failure === 'not_your_gym') return { status: 403, body: { error: 'not_your_gym' } };
    const gym = gymSelection.ok ? gyms.find(g => g.id === gymSelection.gymId) || null : null;
    if (!gym) return { status: 400, body: { error: 'operator_not_assigned_to_gym' } };

    const result = await checkInService.perform({ memberId: claim.userId, gymId: gym.id, method: 'gym_scanned' });
    if (!result.ok) return { status: 409, body: result };
    return {
      status: 200,
      body: {
        ...result,
        checkin: result.checkin
          ? { ...result.checkin, memberPublicId: await publicUserId(claim.userId, 'member') }
          : result.checkin,
      },
    };
  }

  async function recentCheckIns(operator) {
    const ids = operatorGymIds(operator);
    const allCheckins = await checkins.filterAsync(c => ids.includes(c.gymId));
    const list = allCheckins
      .sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp))
      .slice(0, 50)
      .map(c => ({ ...c, memberId: c.memberId }));
    for (let i = 0; i < list.length; i++) {
      list[i].memberPublicId = await publicUserId(list[i].memberId, 'member');
      list[i].memberPhone = null;
      list[i].memberEmail = null;
    }
    return list;
  }

  async function dashboard({ operator, query }) {
    const ownedGymIds = operator?.gymIds || (operator?.gymId ? [operator.gymId] : []);
    const ownedGyms = [];
    for (const id of ownedGymIds) {
      const gym = await gyms.findByIdAsync(id);
      if (gym) ownedGyms.push(gym);
    }
    const requestedGymId = query?.gymId ? String(query.gymId) : null;
    const gym = (requestedGymId && ownedGymIds.includes(requestedGymId)
      ? await gyms.findByIdAsync(requestedGymId)
      : ownedGyms[0]) || null;
    if (!gym) return { error: 'gym_not_found', status: 404 };

    const now = new Date();
    const startOfDay = new Date(now); startOfDay.setUTCHours(0, 0, 0, 0);
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const periodStart = query?.periodStart
      ? new Date(`${String(query.periodStart).slice(0, 10)}T00:00:00Z`)
      : startOfMonth;
    const periodEnd = query?.periodEnd
      ? new Date(`${String(query.periodEnd).slice(0, 10)}T23:59:59Z`)
      : now;
    const memberType = ['all', 'direct', 'fitflex'].includes(String(query?.memberType || ''))
      ? String(query.memberType)
      : 'all';
    const inPeriod = c => {
      const t = +new Date(c.timestamp);
      return t >= +periodStart && t <= +periodEnd;
    };
    const isFitFlexVisit = c => ['platform_pass', 'roaming_topup'].includes(c.subscriptionType);
    const isDirectVisit = c => !isFitFlexVisit(c);
    const matchesMemberType = c => memberType === 'all' || (memberType === 'fitflex' ? isFitFlexVisit(c) : isDirectVisit(c));
    const allCheckins = await checkins.allAsync();
    const selectedGymPeriodCheckins = allCheckins.filter(c => c.gymId === gym.id && inPeriod(c));
    const selectedGymFilteredCheckins = selectedGymPeriodCheckins.filter(matchesMemberType);
    const ownedPeriodCheckins = allCheckins.filter(c => ownedGymIds.includes(c.gymId) && inPeriod(c));
    const ownedFilteredCheckins = ownedPeriodCheckins.filter(matchesMemberType);
    const unique = rows => new Set(rows.map(c => c.memberId).filter(Boolean)).size;

    // ── Previous period (same duration, immediately before current period) ──
    const periodDurationMs = +periodEnd - +periodStart;
    const prevPeriodEnd = new Date(+periodStart - 1); // 1 ms before current start
    const prevPeriodStart = new Date(+prevPeriodEnd - periodDurationMs);
    const inPrevPeriod = c => {
      const t = +new Date(c.timestamp);
      return t >= +prevPeriodStart && t <= +prevPeriodEnd;
    };
    const selectedGymPrevCheckins = allCheckins.filter(c => c.gymId === gym.id && inPrevPeriod(c));
    const selectedGymPrevFiltered = selectedGymPrevCheckins.filter(matchesMemberType);

    // ── Time-series chart data: split period into up to 5 equal buckets ──
    const BUCKETS = 5;
    const bucketMs = Math.max(Math.floor(periodDurationMs / BUCKETS), 1);
    const chartSeries = Array.from({ length: BUCKETS }, (_, i) => {
      const bucketStart = new Date(+periodStart + i * bucketMs);
      const bucketEnd = new Date(Math.min(+periodStart + (i + 1) * bucketMs - 1, +periodEnd));
      const inBucket = c => {
        const t = +new Date(c.timestamp);
        return t >= +bucketStart && t <= +bucketEnd && c.gymId === gym.id;
      };
      const bucketRows = selectedGymPeriodCheckins.filter(inBucket);
      const bucketDate = bucketStart;
      const label = `${bucketDate.getUTCMonth() + 1}/${bucketDate.getUTCDate()}`;
      return {
        label,
        direct: unique(bucketRows.filter(isDirectVisit)),
        fitflex: unique(bucketRows.filter(isFitFlexVisit)),
      };
    });

    const todayCount = allCheckins.filter(c => c.gymId === gym.id && +new Date(c.timestamp) >= +startOfDay).length;
    const monthVisits = allCheckins.filter(c => c.gymId === gym.id && +new Date(c.timestamp) >= +startOfMonth && isFitFlexVisit(c)).length;
    const gymSummaries = ownedGyms.map(g => {
      const rows = ownedPeriodCheckins.filter(c => c.gymId === g.id);
      const fitflexRows = rows.filter(isFitFlexVisit);
      const directRows = rows.filter(isDirectVisit);
      return {
        gymId: g.id,
        gymName: g.name,
        tier: g.tier,
        totalVisits: rows.length,
        uniqueMembers: unique(rows),
        directVisits: directRows.length,
        directMembers: unique(directRows),
        fitflexVisits: fitflexRows.length,
        fitflexMembers: unique(fitflexRows),
      };
    });
    const payout = monthVisits >= 500
      ? { band: 5, note: 'Negotiate flat fee' }
      : calculatePayout({ visitCount: monthVisits, gymTier: gym.tier, negotiatedPerVisitRate: gym.perVisitRate });

    // Real registered-member count for the selected gym (independent of the
    // period/date filters above) — backs the Home dashboard "Total Members" card.
    const memberStats = await memberManagement.getMemberStats({ owner: operator, gymId: gym.id });

    return {
      gym,
      gyms: ownedGyms,
      todayCount,
      monthVisits,
      periodStart: periodStart.toISOString().slice(0, 10),
      periodEnd: periodEnd.toISOString().slice(0, 10),
      memberType,
      totalMembers: memberStats.totalMembers,
      activeTodayMembers: memberStats.activeToday,
      expiringSoonMembers: memberStats.expiringSoon,
      periodVisits: selectedGymFilteredCheckins.length,
      periodMembers: unique(selectedGymFilteredCheckins),
      prevPeriodVisits: selectedGymPrevFiltered.length,
      prevPeriodMembers: unique(selectedGymPrevFiltered),
      directVisits: selectedGymPeriodCheckins.filter(isDirectVisit).length,
      directMembers: unique(selectedGymPeriodCheckins.filter(isDirectVisit)),
      fitflexVisits: selectedGymPeriodCheckins.filter(isFitFlexVisit).length,
      fitflexMembers: unique(selectedGymPeriodCheckins.filter(isFitFlexVisit)),
      overall: {
        gymCount: ownedGyms.length,
        totalVisits: ownedFilteredCheckins.length,
        uniqueMembers: unique(ownedFilteredCheckins),
        directVisits: ownedPeriodCheckins.filter(isDirectVisit).length,
        directMembers: unique(ownedPeriodCheckins.filter(isDirectVisit)),
        fitflexVisits: ownedPeriodCheckins.filter(isFitFlexVisit).length,
        fitflexMembers: unique(ownedPeriodCheckins.filter(isFitFlexVisit)),
      },
      gymSummaries,
      payout,
      chartSeries,
    };
  }

  /**
   * Member-scans-gym mode (Tech Brief §5): the member scans the static QR
   * posted at the entrance. Same BL-012 validation and logging as a staff
   * scan, recorded as method 'member_scanned'.
   */
  async function memberScanGym({ memberId, gymQr }) {
    const claim = verifyGymQr(gymQr);
    if (!claim) return { status: 400, body: { ok: false, failure: 'invalid_gym_qr' } };
    const gym = gyms.find(g => g.id === claim.gymId);
    if (!gym) return { status: 404, body: { ok: false, failure: 'gym_not_found' } };
    const result = await checkInService.perform({ memberId, gymId: gym.id, method: 'member_scanned' });
    if (!result.ok) return { status: 409, body: { ...result, gym: { id: gym.id, name: gym.name, tier: gym.tier } } };
    return { status: 200, body: { ...result, gym: { id: gym.id, name: gym.name, tier: gym.tier } } };
  }

  /** The printable entrance QR for a gym the operator manages (or any gym, for admins). */
  function gymEntranceQr({ operator, gymId, isAdmin = false }) {
    const gym = gyms.find(g => g.id === gymId);
    if (!gym) return { status: 404, body: { error: 'gym_not_found' } };
    if (!isAdmin && !operatorGymIds(operator).includes(gym.id)) return { status: 403, body: { error: 'not_your_gym' } };
    return { status: 200, body: { gymId: gym.id, gymName: gym.name, payload: issueGymQr(gym.id) } };
  }

  return { issueMemberQr, verifyQr, checkIn, recentCheckIns, dashboard, memberScanGym, gymEntranceQr };
}
