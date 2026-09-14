// Admin member management — list/upsert/status + per-member payments/check-ins/QR.
// List responses are kept lean (lean subscription + pendingPayment projections)
// so the admin members table gets a fast first paint even with many rows.
import { randomUUID } from 'node:crypto';

export function createAdminMemberService({ users, subscriptions, paymentRequests, checkins, gyms, auditLog, issueQr }) {
  async function latestMemberSubscription(memberId) {
    const subs = await subscriptions.filterByColumnAsync('memberId', memberId);
    return subs.sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt))[0] || null;
  }

  /** Lean subscription projection for list rows — drops internal payment refs. */
  function slimSub(sub) {
    if (!sub) return null;
    return { id: sub.id, tier: sub.tier, type: sub.type, status: sub.status, expiresAt: sub.expiresAt };
  }

  function slimPendingPayment(p) {
    if (!p) return null;
    return { id: p.id, amountTzs: p.amountTzs, tier: p.tier, status: p.status, requestedAt: p.requestedAt };
  }

  async function list() {
    // Pushed-down SQL WHERE instead of a full-table scan, then batch-fetch
    // every member's subscriptions/payment-requests in two queries instead
    // of two sequential round trips PER MEMBER (was N+1: with ~200 members
    // that's 400+ sequential DB calls, the actual cause of this endpoint's
    // 200-270ms response time — not payload size).
    const allMembers = await users.filterByColumnAsync('userType', 'member');
    const memberIds = allMembers.map(u => u.id);
    const [allSubs, allPendingPays] = await Promise.all([
      subscriptions.filterByColumnInAsync('memberId', memberIds),
      paymentRequests.filterByColumnInAsync('memberId', memberIds),
    ]);

    const subsByMember = new Map();
    for (const s of allSubs) {
      if (!subsByMember.has(s.memberId)) subsByMember.set(s.memberId, []);
      subsByMember.get(s.memberId).push(s);
    }
    const pendingByMember = new Map();
    for (const p of allPendingPays) {
      if (p.status !== 'pending') continue;
      if (!pendingByMember.has(p.memberId)) pendingByMember.set(p.memberId, []);
      pendingByMember.get(p.memberId).push(p);
    }

    return allMembers.map(u => {
      const sub = (subsByMember.get(u.id) || []).sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt))[0] || null;
      const pendingPays = pendingByMember.get(u.id) || [];
      return {
        id: u.id,
        email: u.email || null,
        phone: u.phone || null,
        displayName: u.displayName || null,
        photoUrl: u.photoUrl || null,
        accountStatus: u.accountStatus || 'active',
        memberProfile: u.memberProfile || null,
        createdAt: u.createdAt,
        subscription: slimSub(sub),
        pendingPayment: slimPendingPayment(pendingPays.sort((a, b) => +new Date(b.requestedAt) - +new Date(a.requestedAt))[0] || null),
      };
    });
  }

  async function upsert({ body, actorId }) {
    if (!body.id && !body.email && !body.phone) return { error: 'email_or_phone_required', status: 400 };
    const id = body.id || `usr_${randomUUID().slice(0, 8)}`;
    const prior = await users.findByIdAsync(id);
    if (body.email && !body.id) {
      const dup = await users.findAsync(
        u => u.email === body.email && u.userType === 'member' && u.id !== id,
      );
      if (dup) return { error: 'email_already_used', status: 409, existingRole: dup.userType };
    }
    const priorProfile = prior?.memberProfile || {};
    const memberProfile = {
      fitnessGoal: body.memberProfile?.fitnessGoal ?? priorProfile.fitnessGoal ?? null,
      fitnessLevel: body.memberProfile?.fitnessLevel ?? priorProfile.fitnessLevel ?? null,
      heightCm: body.memberProfile?.heightCm ?? priorProfile.heightCm ?? null,
      weightKg: body.memberProfile?.weightKg ?? priorProfile.weightKg ?? null,
      dateOfBirth: body.memberProfile?.dateOfBirth ?? priorProfile.dateOfBirth ?? null,
      gender: body.memberProfile?.gender ?? priorProfile.gender ?? null,
      preferredWorkoutTimes: Array.isArray(body.memberProfile?.preferredWorkoutTimes)
        ? body.memberProfile.preferredWorkoutTimes
        : (priorProfile.preferredWorkoutTimes || [])
    };
    const row = {
      id,
      userType: 'member',
      email: body.email ?? prior?.email ?? null,
      phone: body.phone ?? prior?.phone ?? null,
      displayName: body.displayName ?? prior?.displayName ?? null,
      photoUrl: body.photoUrl ?? prior?.photoUrl ?? null,
      accountStatus: body.accountStatus ?? prior?.accountStatus ?? 'active',
      memberProfile,
      createdAt: prior?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await users.upsertAsync(u => u.id === id, row);
    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: actorId, action: prior ? 'member_updated' : 'member_created',
      target: id, before: prior ?? null, after: row
    });
    const enrichedSub = await latestMemberSubscription(id);
    const enrichedPendingPays = await paymentRequests.filterAsync(p => p.memberId === id && p.status === 'pending');
    return {
      created: !prior,
      member: {
        ...row,
        subscription: enrichedSub,
        pendingPayment: enrichedPendingPays.sort((a, b) => +new Date(b.requestedAt) - +new Date(a.requestedAt))[0] || null
      },
    };
  }

  async function payments(memberId) {
    return (await paymentRequests.filterAsync(p => p.memberId === memberId))
      .sort((a, b) => +new Date(b.requestedAt) - +new Date(a.requestedAt));
  }

  async function qr(memberId) {
    const member = await users.findAsync(u => u.id === memberId && u.userType === 'member');
    if (!member) return { error: 'member_not_found', status: 404 };
    const allSubs = await subscriptions.filterAsync(s => s.memberId === member.id && s.status === 'active');
    const active = allSubs.sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt))[0];
    if (!active) return { error: 'active_subscription_required', status: 403 };
    return { qr: issueQr(member.id) };
  }

  async function memberCheckins({ memberId, from, to }) {
    const fromTs = from ? +new Date(from + 'T00:00:00Z') : 0;
    const toTs = to ? +new Date(to + 'T23:59:59Z') : Date.now();
    return (await checkins.filterAsync(c => c.memberId === memberId))
      .filter(c => { const ts = +new Date(c.timestamp); return ts >= fromTs && ts <= toTs; })
      .sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp))
      .map(c => ({ ...c, gym: gyms.find(g => g.id === c.gymId) || null }));
  }

  async function setStatus({ memberId, status, actorId }) {
    if (!['active', 'suspended'].includes(status)) return { error: 'invalid_status', status: 400 };
    const member = await users.findAsync(u => u.id === memberId && u.userType === 'member');
    if (!member) return { error: 'not_found', status: 404 };
    const beforeSub = await latestMemberSubscription(member.id);
    const before = { ...member, subscription: beforeSub };
    const updatedUser = await users.updateByIdAsync(member.id, { accountStatus: status });
    const sub = await latestMemberSubscription(member.id);
    let updatedSub = sub;
    if (sub) {
      updatedSub = await subscriptions.updateByIdAsync(sub.id, {
        status: status === 'suspended' ? 'suspended' : (sub.status === 'suspended' ? 'active' : sub.status)
      });
    }
    const after = { ...updatedUser, subscription: updatedSub };
    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: actorId, action: `member_${status}`,
      target: member.id, before, after
    });
    return { member: after };
  }

  return { latestMemberSubscription, list, upsert, payments, qr, memberCheckins, setStatus };
}
