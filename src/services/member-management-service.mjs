// Member-management service — owner-facing member CRUD + analytics.
// Pure DI: receives store collections + helpers via the factory, no direct imports of infra.
// Backs the Gym Owner app "Members Management Flow".

import { randomUUID } from 'node:crypto';
import { effectiveSubscriptionStatus } from '../shared/subscription-status.mjs';
import {
  FITFLEX_VISIT_TYPES, daysLeft, directMembershipStatus, latestDirectSubscription, latestDirectSubscriptionsByMember, ownerGymIds,
} from '../shared/member-status.mjs';
import { toSessionUser } from '../shared/session-user.mjs';
import { normalizeEmail, sameEmail } from '../shared/identifiers.mjs';
import { CHECKIN_STATUS, CHECKIN_SOURCE } from '../shared/checkin-status.mjs';
import { localDay } from '../shared/member-progress.mjs';

export function createMemberManagementService({
  users,
  gyms,
  subscriptions,
  checkins,
  paymentRequests,
  publicUserId,
  // A membership started or was renewed here (lifecycle automations).
  onMembershipActivated = async () => {},
  initFirebaseAdmin,
  getAdminAuth,
}) {
  // ── helpers ──────────────────────────────────────────────────────────────
  const ownerGymIdsOf = ownerGymIds;

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

  async function latestDirectSub(memberId, gymIds) {
    return latestDirectSubscription(await subscriptions.filterAsync((s) => s.memberId === memberId), gymIds);
  }

  /**
   * A member's payments that belong to the owner's gyms: memberships at
   * those gyms. Their FitFlex pass, trainer sessions and payments to other
   * gyms are theirs and those businesses', not this gym's (audit S1).
   */
  async function gymPayments(memberId, gymIds) {
    const own = new Set((await subscriptions.filterAsync((x) =>
      x.memberId === memberId && x.type === 'direct_sub' && gymIds.includes(x.homeGymId))).map((x) => x.id));
    return paymentRequests.filterAsync((p) => p.memberId === memberId && own.has(p.subscriptionId));
  }

  async function ownerCheckinsFor(memberId, gymIds) {
    const rows = await checkins.filterAsync((c) => c.memberId === memberId && gymIds.includes(c.gymId));
    return rows.sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp));
  }

  async function hasCheckinToday(memberId, gymIds, now) {
    const start = +startOfDayUtc(now);
    const rows = await checkins.filterAsync(
      (c) => c.memberId === memberId && gymIds.includes(c.gymId) && +new Date(c.timestamp) >= start,
    );
    return rows.length > 0;
  }

  async function statusForDirect(member, sub, gymIds, now) {
    const status = directMembershipStatus({ accountStatus: member.accountStatus, sub, now });
    if (status === 'suspended') return status;
    if (await hasCheckinToday(member.id, gymIds, now)) return 'checked_in';
    return status;
  }

  async function statusForRoaming(member, gymIds, now) {
    if (member.accountStatus === 'suspended') return 'suspended';
    if (await hasCheckinToday(member.id, gymIds, now)) return 'checked_in';
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

  async function buildRow(member, memberType, sub, gymIds, now) {
    const status = memberType === 'direct'
      ? await statusForDirect(member, sub, gymIds, now)
      : await statusForRoaming(member, gymIds, now);
    const recent = await ownerCheckinsFor(member.id, gymIds);
    return {
      id: member.id,
      publicId: await publicUserId(member, 'member'),
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

  async function membershipOwnership(memberId, gymIds) {
    const sub = await latestDirectSub(memberId, gymIds);
    const ownerCheckins = await checkins.filterAsync((c) => c.memberId === memberId && gymIds.includes(c.gymId));
    const hasOwnerCheckin = ownerCheckins.length > 0;
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

    const { displayName, email: rawEmail, phone, gymId, paidAmount, durationUnit, startDate, endDate, tier, initialPassword } = body || {};
    const email = normalizeEmail(rawEmail);
    if (!displayName?.trim()) return { error: 'displayName_required', status: 400 };
    if (!email && !phone?.trim()) return { error: 'email_or_phone_required', status: 400 };
    if (!['D', 'W', 'M'].includes(durationUnit)) return { error: 'durationUnit_must_be_D_W_or_M', status: 400 };
    if (!startDate || !endDate) return { error: 'startDate_and_endDate_required', status: 400 };
    // B2: optional login credential for the member.
    if (initialPassword != null && String(initialPassword).length > 0) {
      if (String(initialPassword).length < 6) return { error: 'initialPassword_too_short', status: 400 };
      if (!email?.trim()) return { error: 'email_required_for_credentials', status: 400 };
    }

    const assignedGymId = gymId && gymIds.includes(gymId) ? gymId : gymIds[0];
    if (email) {
      const existing = await users.findAsync((u) => sameEmail(u.email, email) && u.userType === 'member');
      if (existing) return { error: 'email_already_registered', status: 409 };
    }

    // B2: create the Firebase login before persisting so the member row can
    // carry the linked firebaseUid. A Firebase outage must not block
    // registration — the owner can retry the credential later.
    let firebaseUid = null;
    let credentialCreated = false;
    if (initialPassword && email?.trim() && initFirebaseAdmin && getAdminAuth) {
      try {
        initFirebaseAdmin();
        const fbUser = await getAdminAuth().createUser({
          email: email.trim(),
          password: String(initialPassword),
          displayName: displayName.trim(),
        });
        firebaseUid = fbUser.uid;
        credentialCreated = true;
      } catch (fbErr) {
        console.warn('[owner-members] Firebase credential creation failed:', fbErr?.message);
      }
    }

    const memberId = `usr_${randomUUID().slice(0, 8)}`;
    const nowIso = new Date().toISOString();
    const member = {
      id: memberId,
      displayName: displayName.trim(),
      email,
      phone: phone?.trim() || null,
      firebaseUid,
      userType: 'member',
      accountStatus: 'active',
      approvalStatus: 'approved',
      onboardingCompleted: true,
      createdAt: nowIso,
    };
    await users.upsertAsync((u) => u.id === memberId, member);

    const { subscription: sub, payment } = await activateDirectMembership({
      memberId, gymId: assignedGymId, tier, startDate, endDate, paidAmount,
    });

    return { member: toSessionUser(member), subscription: sub, payment, credentialCreated };
  }

  /**
   * A direct plan for `memberId` at `gymId`, with its desk payment if one was
   * taken. Shared by the desk sale above and by an accepted member invitation
   * (Identity V2 · I6), so both create exactly the same records.
   */
  async function activateDirectMembership({ memberId, gymId, tier, startDate, endDate, paidAmount, paidAt = null }) {
    const nowIso = new Date().toISOString();
    const startIso = toIso(startDate);
    const endIso = toIso(endDate);
    const sub = {
      id: `sub_${randomUUID().slice(0, 8)}`,
      memberId,
      homeGymId: gymId,
      tier: tier || 'basic',
      type: 'direct_sub',
      status: 'active',
      startedAt: startIso,
      cycleStartedAt: startIso,
      renewsAt: endIso,
      expiresAt: endIso,
      createdAt: nowIso,
    };
    await subscriptions.insertAsync(sub);
    try { await onMembershipActivated(sub); } catch { /* best-effort */ }

    let payment = null;
    if (paidAmount && Number(paidAmount) > 0) {
      const paidIso = paidAt ? toIso(paidAt) : nowIso;
      payment = {
        id: `pay_${randomUUID().slice(0, 8)}`,
        memberId,
        subscriptionId: sub.id,
        tier: tier || 'basic',
        amountTzs: Number(paidAmount),
        status: 'approved',
        provider: 'admin_manual',
        requestedAt: paidIso,
        decidedAt: paidIso,
      };
      await paymentRequests.insertAsync(payment);
    }
    return { subscription: sub, payment };
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
  async function computeRowsAndStats(gymIds, now) {
    if (gymIds.length === 0) {
      return { rows: [], stats: { totalMembers: 0, activeToday: 0, expiringSoon: 0 } };
    }

    const directByMember = latestDirectSubscriptionsByMember(
      await subscriptions.filterAsync((x) => x.type === 'direct_sub' && gymIds.includes(x.homeGymId)),
      gymIds,
    );

    const roamingCheckins = await checkins.filterAsync((c) => gymIds.includes(c.gymId) && FITFLEX_VISIT_TYPES.includes(c.subscriptionType));
    const roamingMemberIds = new Set(
      roamingCheckins
        .map((c) => c.memberId)
        .filter((id) => id && !directByMember.has(id)),
    );

    const rows = [];
    for (const [memberId, sub] of directByMember) {
      const member = await users.findByIdAsync(memberId);
      if (member) rows.push(await buildRow(member, 'direct', sub, gymIds, now));
    }
    for (const memberId of roamingMemberIds) {
      const member = await users.findByIdAsync(memberId);
      if (member) rows.push(await buildRow(member, 'fitflex', null, gymIds, now));
    }

    const stats = {
      totalMembers: rows.length,
      activeToday: rows.filter((r) => r.status === 'checked_in').length,
      expiringSoon: rows.filter((r) => r.status === 'expiring_soon').length,
    };
    return { rows, stats };
  }

  async function listMembers({ owner, query = {} }) {
    const gymIds = scopedGymIds(owner, query.gymId);
    const now = new Date();
    const { rows, stats } = await computeRowsAndStats(gymIds, now);

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
  async function getMemberStats({ owner, gymId }) {
    const gymIds = scopedGymIds(owner, gymId);
    const { stats } = await computeRowsAndStats(gymIds, new Date());
    return stats;
  }

  async function getMemberDetail({ owner, memberId }) {
    const gymIds = ownerGymIdsOf(owner);
    const member = await users.findByIdAsync(memberId);
    if (!member) return { error: 'member_not_found', status: 404 };

    const { sub, owns } = await membershipOwnership(memberId, gymIds);
    if (!owns) return { error: 'not_your_member', status: 403 };

    const now = new Date();
    const memberType = sub ? 'direct' : 'fitflex';
    const status = sub ? await statusForDirect(member, sub, gymIds, now) : await statusForRoaming(member, gymIds, now);

    const sorted = await ownerCheckinsFor(memberId, gymIds);
    const recentCheckins = sorted.slice(0, 10).map((c) => {
      const gym = gyms.find((g) => g.id === c.gymId);
      return { id: c.id, timestamp: c.timestamp, gymId: c.gymId, gymName: gym?.name || null };
    });

    const startMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const visits = sorted.filter((c) => +new Date(c.timestamp) >= +startMonth).length;

    const allPayments = await gymPayments(memberId, gymIds);
    const paymentHistory = allPayments
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
        publicId: await publicUserId(member, 'member'),
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

  async function getCheckInSummary({ owner, memberId, period = 'month', from, to }) {
    const gymIds = ownerGymIdsOf(owner);
    const member = await users.findByIdAsync(memberId);
    if (!member) return { error: 'member_not_found', status: 404 };
    const { owns } = await membershipOwnership(memberId, gymIds);
    if (!owns) return { error: 'not_your_member', status: 403 };

    const now = new Date();
    const sorted = await ownerCheckinsFor(memberId, gymIds);
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

  async function listMemberCheckins({ owner, memberId, query = {} }) {
    const gymIds = ownerGymIdsOf(owner);
    const member = await users.findByIdAsync(memberId);
    if (!member) return { error: 'member_not_found', status: 404 };
    const { owns } = await membershipOwnership(memberId, gymIds);
    if (!owns) return { error: 'not_your_member', status: 403 };

    const { start, end } = customRange(query.from, query.to);
    const search = String(query.search || '').trim().toLowerCase();

    let rows = (await ownerCheckinsFor(memberId, gymIds)).map((c) => {
      const gym = gyms.find((g) => g.id === c.gymId);
      return { id: c.id, timestamp: c.timestamp, gymId: c.gymId, gymName: gym?.name || null };
    });
    rows = rows.filter((r) => inWindow(r.timestamp, start, end));
    if (search) rows = rows.filter((r) => (r.gymName || '').toLowerCase().includes(search));

    return paginate(rows, query);
  }

  async function listMemberPayments({ owner, memberId, query = {} }) {
    const gymIds = ownerGymIdsOf(owner);
    const member = await users.findByIdAsync(memberId);
    if (!member) return { error: 'member_not_found', status: 404 };
    const { owns } = await membershipOwnership(memberId, gymIds);
    if (!owns) return { error: 'not_your_member', status: 403 };

    const { start, end } = customRange(query.from, query.to);
    const search = String(query.search || '').trim().toLowerCase();

    let rows = (await gymPayments(memberId, gymIds))
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

  async function checkInMember({ owner, memberId, gymId }) {
    const gymIds = ownerGymIdsOf(owner);
    const member = await users.findByIdAsync(memberId);
    if (!member) return { error: 'member_not_found', status: 404 };

    const targetGymId = gymId && gymIds.includes(gymId) ? gymId : gymIds[0];
    if (!targetGymId) return { error: 'owner_has_no_gyms', status: 400 };
    const gym = gyms.find((g) => g.id === targetGymId);
    if (!gym) return { error: 'gym_not_found', status: 404 };

    const { sub, owns } = await membershipOwnership(memberId, gymIds);
    if (!owns) return { error: 'not_your_member', status: 403 };
    if (member.accountStatus === 'suspended') return { error: 'member_suspended', status: 409 };
    // Manual check-in is for the gym's own (direct) members. A FitFlex pass
    // member checks in by QR, where the visit allowance, tier and same-day
    // rules apply; recording them here as a direct visit would use up a pass
    // visit the gym is never paid for (settlement Phase 2, PR 1).
    if (!sub) return { error: 'direct_membership_required', status: 409 };
    // A1: direct memberships must not check in past their plan expiry.
    const membershipStatus = effectiveSubscriptionStatus(sub);
    if (membershipStatus === 'expired') {
      return { error: 'membership_expired', status: 409 };
    }
    // A plan the gym has paused can't be checked in by hand either (the QR
    // path already refuses it as inactive).
    if (membershipStatus === 'suspended') {
      return { error: 'member_suspended', status: 409 };
    }

    // One manual visit per member per East Africa Time day across the owner's gyms.
    const now = new Date();
    const today = localDay(now);
    const existing = await checkins.findAsync(
      (c) => c.memberId === memberId && gymIds.includes(c.gymId) && (c.businessDate || localDay(c.timestamp)) === today,
    );
    if (existing) return { ok: true, checkin: existing, idempotent: true };

    const row = {
      id: randomUUID(),
      memberId,
      gymId: targetGymId,
      timestamp: now.toISOString(),
      method: 'gym_scanned',
      subscriptionType: sub.type || 'direct_sub',
      passTier: sub.tier || null,
      visitNumberInCycle: null,
      gymTier: gym.tier,
      creditsDeductedTzs: 0,
      visitConsumed: true,
      status: CHECKIN_STATUS.VALID,
      subscriptionId: sub.id ?? null,
      businessDate: today,
      source: CHECKIN_SOURCE.OWNER_MANUAL,
    };
    await checkins.insertAsync(row);
    return { ok: true, checkin: row };
  }

  async function renewMember({ owner, memberId, body }) {
    const gymIds = ownerGymIdsOf(owner);
    const member = await users.findByIdAsync(memberId);
    if (!member) return { error: 'member_not_found', status: 404 };

    const sub = await latestDirectSub(memberId, gymIds);
    if (!sub) return { error: 'not_your_member', status: 403 };

    const { tier, paidAmount, startDate, endDate } = body || {};
    if (!startDate || !endDate) return { error: 'startDate_and_endDate_required', status: 400 };

    const startIso = toIso(startDate);
    const endIso = toIso(endDate);
    await subscriptions.updateByIdAsync(sub.id, {
      status: 'active',
      cycleStartedAt: startIso,
      renewsAt: endIso,
      expiresAt: endIso,
      tier: tier || sub.tier,
    });
    const updatedSub = await subscriptions.findByIdAsync(sub.id);
    try { await onMembershipActivated(updatedSub); } catch { /* best-effort */ }

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
      await paymentRequests.insertAsync(payment);
    }

    // Renewing re-opens the membership at this gym only. A suspended FitFlex
    // account is FitFlex's to lift, never the gym's.
    return { subscription: updatedSub, payment };
  }

  async function updateMember({ owner, memberId, body }) {
    const gymIds = ownerGymIdsOf(owner);
    const member = await users.findByIdAsync(memberId);
    if (!member) return { error: 'member_not_found', status: 404 };

    // Only the gym's own direct members, and only their membership here:
    // a member who signs in themselves keeps control of their own details.
    const { sub, owns } = await membershipOwnership(memberId, gymIds);
    if (!owns) return { error: 'not_your_member', status: 403 };
    if (!sub) return { error: 'direct_membership_required', status: 409 };
    if (member.firebaseUid) return { error: 'member_manages_own_details', status: 409 };

    const { displayName, phone, tier } = body || {};
    if (!displayName?.trim()) return { error: 'displayName_required', status: 400 };

    const userPatch = {
      displayName: displayName.trim(),
      phone: phone?.trim() || member.phone || null,
    };
    await users.updateByIdAsync(memberId, userPatch);

    if (tier && sub) {
      await subscriptions.updateByIdAsync(sub.id, { tier });
    }

    const updated = await users.findByIdAsync(memberId);
    return { member: { id: memberId, displayName: updated.displayName, phone: updated.phone } };
  }

  async function setMemberStatus({ owner, memberId, suspend }) {
    const gymIds = ownerGymIdsOf(owner);
    const member = await users.findByIdAsync(memberId);
    if (!member) return { error: 'member_not_found', status: 404 };

    const { sub, owns } = await membershipOwnership(memberId, gymIds);
    if (!owns) return { error: 'not_your_member', status: 403 };
    // A gym can pause a member's plan at its own gym, never their whole
    // FitFlex account (Terms of Use 17): Pass members aren't the gym's to suspend.
    if (!sub) return { error: 'direct_membership_required', status: 409 };

    await subscriptions.updateByIdAsync(sub.id, { status: suspend ? 'suspended' : 'active' });
    const membershipStatus = suspend ? 'suspended' : effectiveSubscriptionStatus({ ...sub, status: 'active' });
    return { member: { id: memberId, accountStatus: member.accountStatus || 'active', membershipStatus } };
  }

  return {
    createMember,
    activateDirectMembership,
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
