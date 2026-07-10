// Member-management service — owner-facing member CRUD + analytics.
// Pure DI: receives store collections + helpers via the factory, no direct imports of infra.
// Backs the Gym Owner app "Members Management Flow".

import { randomUUID } from 'node:crypto';

const EXPIRING_SOON_DAYS = 7;
const FITFLEX_VISIT_TYPES = ['platform_pass', 'roaming_topup'];

export function createMemberManagementService({
  users,
  gyms,
  subscriptions,
  checkins,
  paymentRequests,
  publicUserId,
}) {
  // ── helpers ──────────────────────────────────────────────────────────────
  const ownerGymIdsOf = (owner) => owner?.gymIds || (owner?.gymId ? [owner.gymId] : []);

  const toIso = (dateStr) => {
    if (!dateStr) return null;
    const s = String(dateStr);
    return s.length <= 10 ? new Date(`${s}T00:00:00.000Z`).toISOString() : new Date(s).toISOString();
  };

  const dateKey = (d) => new Date(d).toISOString().slice(0, 10);

  function startOfDayUtc(now) {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }

  function daysLeft(expiresAt, now) {
    if (!expiresAt) return null;
    return Math.ceil((+new Date(expiresAt) - +now) / 86_400_000);
  }

  function latestDirectSub(memberId, gymIds) {
    return subscriptions
      .filter((s) => s.memberId === memberId && s.type === 'direct_sub' && gymIds.includes(s.homeGymId))
      .sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt))[0] || null;
  }

  function ownerCheckinsFor(memberId, gymIds) {
    return checkins
      .filter((c) => c.memberId === memberId && gymIds.includes(c.gymId))
      .sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp));
  }

  function hasCheckinToday(memberId, gymIds, now) {
    const start = +startOfDayUtc(now);
    return checkins.filter(
      (c) => c.memberId === memberId && gymIds.includes(c.gymId) && +new Date(c.timestamp) >= start,
    ).length > 0;
  }

  function statusForDirect(member, sub, gymIds, now) {
    if (member.accountStatus === 'suspended' || sub?.status === 'suspended') return 'suspended';
    if (hasCheckinToday(member.id, gymIds, now)) return 'checked_in';
    const dl = sub ? daysLeft(sub.expiresAt, now) : null;
    if (dl == null || dl < 0) return 'expired';
    if (dl <= EXPIRING_SOON_DAYS) return 'expiring_soon';
    return 'active';
  }

  function statusForRoaming(member, gymIds, now) {
    if (member.accountStatus === 'suspended') return 'suspended';
    if (hasCheckinToday(member.id, gymIds, now)) return 'checked_in';
    return 'active';
  }

  function computeStreak(sortedDesc, now) {
    const days = new Set(sortedDesc.map((c) => dateKey(c.timestamp)));
    let cursor = startOfDayUtc(now);
    if (!days.has(dateKey(cursor))) {
      cursor = new Date(+cursor - 86_400_000);
      if (!days.has(dateKey(cursor))) return 0;
    }
    let streak = 0;
    while (days.has(dateKey(cursor))) {
      streak += 1;
      cursor = new Date(+cursor - 86_400_000);
    }
    return streak;
  }

  function buildRow(member, memberType, sub, gymIds, now) {
    const status = memberType === 'direct'
      ? statusForDirect(member, sub, gymIds, now)
      : statusForRoaming(member, gymIds, now);
    const recent = ownerCheckinsFor(member.id, gymIds);
    return {
      id: member.id,
      publicId: publicUserId(member, 'member'),
      displayName: member.displayName || null,
      phone: member.phone || null,
      photoUrl: member.photoUrl || null,
      memberType,
      tier: sub?.tier || null,
      status,
      lastCheckinAt: recent[0]?.timestamp || null,
      startDate: sub?.startedAt || null,
      expiresAt: sub?.expiresAt || null,
      daysLeft: sub ? daysLeft(sub.expiresAt, now) : null,
    };
  }

  function membershipOwnership(memberId, gymIds) {
    const sub = latestDirectSub(memberId, gymIds);
    const hasOwnerCheckin = checkins.filter((c) => c.memberId === memberId && gymIds.includes(c.gymId)).length > 0;
    return { sub, owns: Boolean(sub) || hasOwnerCheckin };
  }

  // Resolves the [start, end] window (end may be null = open-ended) for a named
  // period preset or an explicit custom from/to range. `to` is inclusive (EOD).
  function periodRange(period, from, to, now) {
    if (period === 'week') {
      const d = startOfDayUtc(now);
      const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
      return { start: new Date(+d - dow * 86_400_000), end: null };
    }
    if (period === 'year') {
      return { start: new Date(Date.UTC(now.getUTCFullYear(), 0, 1)), end: null };
    }
    if (period === 'custom') {
      return customRange(from, to);
    }
    // default: this month
    return { start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), end: null };
  }

  function customRange(from, to) {
    const start = from ? new Date(toIso(from)) : null;
    const end = to
      ? new Date(String(to).length <= 10 ? `${to}T23:59:59.999Z` : to)
      : null;
    return { start, end };
  }

  function inWindow(ts, start, end) {
    const t = +new Date(ts);
    if (start && t < +start) return false;
    if (end && t > +end) return false;
    return true;
  }

  function paginate(rows, query) {
    const total = rows.length;
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);
    const offset = Math.max(parseInt(query.cursor, 10) || 0, 0);
    const items = rows.slice(offset, offset + limit);
    const nextCursor = offset + limit < total ? offset + limit : null;
    return { items, total, nextCursor };
  }

  // ── use-cases ──────────────────────────────────────────────────────────────
  async function createMember({ owner, body }) {
    const gymIds = ownerGymIdsOf(owner);
    if (gymIds.length === 0) return { error: 'owner_has_no_gyms', status: 400 };

    const { displayName, email, phone, gymId, paidAmount, durationUnit, startDate, endDate, tier } = body || {};
    if (!displayName?.trim()) return { error: 'displayName_required', status: 400 };
    if (!email?.trim() && !phone?.trim()) return { error: 'email_or_phone_required', status: 400 };
    if (!['D', 'W', 'M'].includes(durationUnit)) return { error: 'durationUnit_must_be_D_W_or_M', status: 400 };
    if (!startDate || !endDate) return { error: 'startDate_and_endDate_required', status: 400 };

    const assignedGymId = gymId && gymIds.includes(gymId) ? gymId : gymIds[0];
    if (email) {
      const existing = users.find((u) => u.email === email && u.userType === 'member');
      if (existing) return { error: 'email_already_registered', status: 409 };
    }

    const memberId = `usr_${randomUUID().slice(0, 8)}`;
    const nowIso = new Date().toISOString();
    const member = {
      id: memberId,
      displayName: displayName.trim(),
      email: email?.trim() || null,
      phone: phone?.trim() || null,
      userType: 'member',
      accountStatus: 'active',
      approvalStatus: 'approved',
      onboardingCompleted: true,
      createdAt: nowIso,
    };
    await users.upsertAsync((u) => u.id === memberId, member);

    const startIso = toIso(startDate);
    const endIso = toIso(endDate);
    const sub = {
      id: `sub_${randomUUID().slice(0, 8)}`,
      memberId,
      homeGymId: assignedGymId,
      tier: tier || 'basic',
      type: 'direct_sub',
      status: 'active',
      startedAt: startIso,
      cycleStartedAt: startIso,
      renewsAt: endIso,
      expiresAt: endIso,
      createdAt: nowIso,
    };
    subscriptions.insert(sub);

    let payment = null;
    if (paidAmount && Number(paidAmount) > 0) {
      payment = {
        id: `pay_${randomUUID().slice(0, 8)}`,
        memberId,
        subscriptionId: sub.id,
        tier: tier || 'basic',
        amountTzs: Number(paidAmount),
        status: 'approved',
        provider: 'admin_manual',
        requestedAt: nowIso,
        decidedAt: nowIso,
      };
      paymentRequests.insert(payment);
    }

    return { member, subscription: sub, payment };
  }

  // Resolves the effective gym scope for a members/stats query: a single
  // owned gym when `requestedGymId` is provided and owned, otherwise every
  // gym the owner has (aggregate view).
  function scopedGymIds(owner, requestedGymId) {
    const ownedGymIds = ownerGymIdsOf(owner);
    const gymId = requestedGymId ? String(requestedGymId) : null;
    return gymId && ownedGymIds.includes(gymId) ? [gymId] : ownedGymIds;
  }

  // Builds the member rows + summary stats for a given gym scope. Shared by
  // [listMembers] (owner Members screen) and [getMemberStats] (owner Home
  // dashboard "total members" card) so the two never disagree.
  function computeRowsAndStats(gymIds, now) {
    if (gymIds.length === 0) {
      return { rows: [], stats: { totalMembers: 0, activeToday: 0, expiringSoon: 0 } };
    }

    const directByMember = new Map();
    for (const s of subscriptions.filter((x) => x.type === 'direct_sub' && gymIds.includes(x.homeGymId))) {
      const prev = directByMember.get(s.memberId);
      if (!prev || +new Date(s.startedAt) > +new Date(prev.startedAt)) directByMember.set(s.memberId, s);
    }

    const roamingMemberIds = new Set(
      checkins
        .filter((c) => gymIds.includes(c.gymId) && FITFLEX_VISIT_TYPES.includes(c.subscriptionType))
        .map((c) => c.memberId)
        .filter((id) => id && !directByMember.has(id)),
    );

    const rows = [];
    for (const [memberId, sub] of directByMember) {
      const member = users.find((u) => u.id === memberId);
      if (member) rows.push(buildRow(member, 'direct', sub, gymIds, now));
    }
    for (const memberId of roamingMemberIds) {
      const member = users.find((u) => u.id === memberId);
      if (member) rows.push(buildRow(member, 'fitflex', null, gymIds, now));
    }

    const stats = {
      totalMembers: rows.length,
      activeToday: rows.filter((r) => r.status === 'checked_in').length,
      expiringSoon: rows.filter((r) => r.status === 'expiring_soon').length,
    };
    return { rows, stats };
  }

  function listMembers({ owner, query = {} }) {
    const gymIds = scopedGymIds(owner, query.gymId);
    const now = new Date();
    const { rows, stats } = computeRowsAndStats(gymIds, now);

    let filtered = rows;
    const memberType = query.memberType;
    if (memberType === 'direct') filtered = filtered.filter((r) => r.memberType === 'direct');
    else if (memberType === 'fitflex') filtered = filtered.filter((r) => r.memberType === 'fitflex');

    const status = query.status;
    if (status && status !== 'all') filtered = filtered.filter((r) => r.status === status);

    const search = String(query.search || '').trim().toLowerCase();
    if (search) {
      filtered = filtered.filter((r) =>
        (r.displayName || '').toLowerCase().includes(search) ||
        (r.phone || '').toLowerCase().includes(search) ||
        (r.publicId || '').toLowerCase().includes(search));
    }

    filtered.sort((a, b) => (+new Date(b.lastCheckinAt || 0)) - (+new Date(a.lastCheckinAt || 0)));
    return { members: filtered, stats };
  }

  // Gym-scoped member stats only (no row list) — used by the owner Home
  // dashboard to show the gym's real registered member count, independent
  // of the analytics date-range/period filters.
  function getMemberStats({ owner, gymId }) {
    const gymIds = scopedGymIds(owner, gymId);
    const { stats } = computeRowsAndStats(gymIds, new Date());
    return stats;
  }

  function getMemberDetail({ owner, memberId }) {
    const gymIds = ownerGymIdsOf(owner);
    const member = users.find((u) => u.id === memberId);
    if (!member) return { error: 'member_not_found', status: 404 };

    const { sub, owns } = membershipOwnership(memberId, gymIds);
    if (!owns) return { error: 'not_your_member', status: 403 };

    const now = new Date();
    const memberType = sub ? 'direct' : 'fitflex';
    const status = sub ? statusForDirect(member, sub, gymIds, now) : statusForRoaming(member, gymIds, now);

    const sorted = ownerCheckinsFor(memberId, gymIds);
    const recentCheckins = sorted.slice(0, 10).map((c) => {
      const gym = gyms.find((g) => g.id === c.gymId);
      return { id: c.id, timestamp: c.timestamp, gymId: c.gymId, gymName: gym?.name || null };
    });

    const startMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const visits = sorted.filter((c) => +new Date(c.timestamp) >= +startMonth).length;

    const paymentHistory = paymentRequests
      .filter((p) => p.memberId === memberId)
      .sort((a, b) => +new Date(b.requestedAt) - +new Date(a.requestedAt))
      .map((p) => ({
        id: p.id,
        amountTzs: p.amountTzs,
        tier: p.tier,
        status: p.status,
        requestedAt: p.requestedAt,
      }));

    return {
      detail: {
        id: member.id,
        publicId: publicUserId(member, 'member'),
        displayName: member.displayName || null,
        email: member.email || null,
        phone: member.phone || null,
        photoUrl: member.photoUrl || null,
        memberType,
        status,
        accountStatus: member.accountStatus || 'active',
        joinedAt: member.createdAt || null,
        checkInSummary: {
          visits,
          lastCheckinAt: sorted[0]?.timestamp || null,
          streakDays: computeStreak(sorted, now),
        },
        plan: sub
          ? {
              tier: sub.tier,
              startDate: sub.startedAt,
              expiresAt: sub.expiresAt,
              daysLeft: daysLeft(sub.expiresAt, now),
              status: sub.status,
            }
          : null,
        recentCheckins,
        paymentHistory,
      },
    };
  }

  function getCheckInSummary({ owner, memberId, period = 'month', from, to }) {
    const gymIds = ownerGymIdsOf(owner);
    const member = users.find((u) => u.id === memberId);
    if (!member) return { error: 'member_not_found', status: 404 };
    const { owns } = membershipOwnership(memberId, gymIds);
    if (!owns) return { error: 'not_your_member', status: 403 };

    const now = new Date();
    const sorted = ownerCheckinsFor(memberId, gymIds);
    const { start, end } = periodRange(period, from, to, now);
    const visits = sorted.filter((c) => inWindow(c.timestamp, start, end)).length;

    return {
      summary: {
        period,
        from: start ? start.toISOString() : null,
        to: end ? end.toISOString() : null,
        visits,
        lastCheckinAt: sorted[0]?.timestamp || null,
        streakDays: computeStreak(sorted, now),
      },
    };
  }

  function listMemberCheckins({ owner, memberId, query = {} }) {
    const gymIds = ownerGymIdsOf(owner);
    const member = users.find((u) => u.id === memberId);
    if (!member) return { error: 'member_not_found', status: 404 };
    const { owns } = membershipOwnership(memberId, gymIds);
    if (!owns) return { error: 'not_your_member', status: 403 };

    const { start, end } = customRange(query.from, query.to);
    const search = String(query.search || '').trim().toLowerCase();

    let rows = ownerCheckinsFor(memberId, gymIds).map((c) => {
      const gym = gyms.find((g) => g.id === c.gymId);
      return { id: c.id, timestamp: c.timestamp, gymId: c.gymId, gymName: gym?.name || null };
    });
    rows = rows.filter((r) => inWindow(r.timestamp, start, end));
    if (search) rows = rows.filter((r) => (r.gymName || '').toLowerCase().includes(search));

    return paginate(rows, query);
  }

  function listMemberPayments({ owner, memberId, query = {} }) {
    const gymIds = ownerGymIdsOf(owner);
    const member = users.find((u) => u.id === memberId);
    if (!member) return { error: 'member_not_found', status: 404 };
    const { owns } = membershipOwnership(memberId, gymIds);
    if (!owns) return { error: 'not_your_member', status: 403 };

    const { start, end } = customRange(query.from, query.to);
    const search = String(query.search || '').trim().toLowerCase();

    let rows = paymentRequests
      .filter((p) => p.memberId === memberId)
      .sort((a, b) => +new Date(b.requestedAt) - +new Date(a.requestedAt))
      .map((p) => ({
        id: p.id,
        amountTzs: p.amountTzs,
        tier: p.tier,
        status: p.status,
        requestedAt: p.requestedAt,
      }));
    rows = rows.filter((r) => inWindow(r.requestedAt, start, end));
    if (search) {
      rows = rows.filter((r) =>
        (r.tier || '').toLowerCase().includes(search) ||
        String(r.amountTzs).includes(search) ||
        (r.status || '').toLowerCase().includes(search));
    }

    return paginate(rows, query);
  }

  function checkInMember({ owner, memberId, gymId }) {
    const gymIds = ownerGymIdsOf(owner);
    const member = users.find((u) => u.id === memberId);
    if (!member) return { error: 'member_not_found', status: 404 };

    const targetGymId = gymId && gymIds.includes(gymId) ? gymId : gymIds[0];
    if (!targetGymId) return { error: 'owner_has_no_gyms', status: 400 };
    const gym = gyms.find((g) => g.id === targetGymId);
    if (!gym) return { error: 'gym_not_found', status: 404 };

    const { sub, owns } = membershipOwnership(memberId, gymIds);
    if (!owns) return { error: 'not_your_member', status: 403 };
    if (member.accountStatus === 'suspended') return { error: 'member_suspended', status: 409 };

    const now = new Date();
    const start = +startOfDayUtc(now);
    const existing = checkins.find(
      (c) => c.memberId === memberId && gymIds.includes(c.gymId) && +new Date(c.timestamp) >= start,
    );
    if (existing) return { ok: true, checkin: existing, idempotent: true };

    const row = {
      id: randomUUID(),
      memberId,
      gymId: targetGymId,
      timestamp: now.toISOString(),
      method: 'gym_scanned',
      subscriptionType: sub?.type || 'direct_sub',
      passTier: sub?.tier || null,
      visitNumberInCycle: null,
      gymTier: gym.tier,
      creditsDeductedTzs: 0,
      visitConsumed: true,
    };
    checkins.insert(row);
    return { ok: true, checkin: row };
  }

  function renewMember({ owner, memberId, body }) {
    const gymIds = ownerGymIdsOf(owner);
    const member = users.find((u) => u.id === memberId);
    if (!member) return { error: 'member_not_found', status: 404 };

    const sub = latestDirectSub(memberId, gymIds);
    if (!sub) return { error: 'not_your_member', status: 403 };

    const { tier, paidAmount, startDate, endDate } = body || {};
    if (!startDate || !endDate) return { error: 'startDate_and_endDate_required', status: 400 };

    const startIso = toIso(startDate);
    const endIso = toIso(endDate);
    subscriptions.update((s) => s.id === sub.id, {
      status: 'active',
      cycleStartedAt: startIso,
      renewsAt: endIso,
      expiresAt: endIso,
      tier: tier || sub.tier,
    });
    const updatedSub = subscriptions.find((s) => s.id === sub.id);

    let payment = null;
    if (paidAmount && Number(paidAmount) > 0) {
      const nowIso = new Date().toISOString();
      payment = {
        id: `pay_${randomUUID().slice(0, 8)}`,
        memberId,
        subscriptionId: sub.id,
        tier: tier || sub.tier,
        amountTzs: Number(paidAmount),
        status: 'approved',
        provider: 'admin_manual',
        requestedAt: nowIso,
        decidedAt: nowIso,
      };
      paymentRequests.insert(payment);
    }

    if (member.accountStatus === 'suspended') {
      users.update((u) => u.id === memberId, { accountStatus: 'active' });
    }

    return { subscription: updatedSub, payment };
  }

  function updateMember({ owner, memberId, body }) {
    const gymIds = ownerGymIdsOf(owner);
    const member = users.find((u) => u.id === memberId);
    if (!member) return { error: 'member_not_found', status: 404 };

    const { sub, owns } = membershipOwnership(memberId, gymIds);
    if (!owns) return { error: 'not_your_member', status: 403 };

    const { displayName, phone, tier } = body || {};
    if (!displayName?.trim()) return { error: 'displayName_required', status: 400 };

    const userPatch = {
      displayName: displayName.trim(),
      phone: phone?.trim() || member.phone || null,
    };
    users.update((u) => u.id === memberId, userPatch);

    if (tier && sub) {
      subscriptions.update((s) => s.id === sub.id, { tier });
    }

    const updated = users.find((u) => u.id === memberId);
    return { member: { id: memberId, displayName: updated.displayName, phone: updated.phone } };
  }

  function setMemberStatus({ owner, memberId, suspend }) {
    const gymIds = ownerGymIdsOf(owner);
    const member = users.find((u) => u.id === memberId);
    if (!member) return { error: 'member_not_found', status: 404 };

    const { sub, owns } = membershipOwnership(memberId, gymIds);
    if (!owns) return { error: 'not_your_member', status: 403 };

    const accountStatus = suspend ? 'suspended' : 'active';
    users.update((u) => u.id === memberId, { accountStatus });
    if (sub) subscriptions.update((s) => s.id === sub.id, { status: suspend ? 'suspended' : 'active' });

    return { member: { id: memberId, accountStatus } };
  }

  return {
    createMember,
    listMembers,
    getMemberStats,
    getMemberDetail,
    getCheckInSummary,
    listMemberCheckins,
    listMemberPayments,
    checkInMember,
    renewMember,
    updateMember,
    setMemberStatus,
  };
}
