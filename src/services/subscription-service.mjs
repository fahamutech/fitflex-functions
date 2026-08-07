// Member-facing subscription (Platform Pass) service — catalogue, subscribe,
// self profile, check-in history, payment history.
import { randomUUID } from 'node:crypto';
import { PASS_TIERS } from '../shared/constants.mjs';
import { effectiveSubscriptionStatus } from '../shared/subscription-status.mjs';

export function createSubscriptionService({
  subscriptions, paymentRequests, checkins, gyms, settingsService, publicUserId,
}) {
  // A7: the member-facing catalogue must not offer the "Online Free" option.
  function listPasses() {
    return Object.entries(PASS_TIERS)
      .filter(([, cfg]) => cfg.accessMode !== 'free_online')
      .map(([id, cfg]) => ({
        id, ...cfg,
        visitCap: Number.isFinite(cfg.visitCap) ? cfg.visitCap : null
      }));
  }

  // A7: gym direct plans — durations drive real expiry (A1).
  const DIRECT_PLAN_DAYS = Object.freeze({ daily: 1, weekly: 7, monthly: 30 });
  const directPlanAmount = (gym, plan) => ({
    daily: Number(gym.ratePerDay || 0),
    weekly: Number(gym.ratePerWeek || 0),
    monthly: Number(gym.ratePerMonth || 0),
  })[plan];

  async function subscribeDirect({ memberId, homeGymId, plan }) {
    if (!homeGymId) return { error: 'homeGymId_required', status: 400 };
    const gym = gyms.find(g => g.id === homeGymId);
    if (!gym) return { error: 'gym_not_found', status: 404 };
    const days = DIRECT_PLAN_DAYS[plan];
    if (!days) return { error: 'invalid_plan', status: 400 };

    const now = new Date();
    const expiresAt = new Date(+now + days * 86_400_000);
    const amountTzs = directPlanAmount(gym, plan);
    const sub = {
      id: `sub_${randomUUID().slice(0, 8)}`,
      memberId,
      type: 'direct_sub',
      tier: null,
      plan,
      status: 'payment_pending',
      startedAt: now.toISOString(),
      cycleStartedAt: now.toISOString(),
      renewsAt: expiresAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      homeGymId,
      paymentRef: null,
      pilotPayment: true
    };
    await subscriptions.insertAsync(sub);
    const paymentRequest = await paymentRequests.insertAsync({
      id: `pay_${randomUUID().slice(0, 8)}`,
      memberId,
      subscriptionId: sub.id,
      tier: null,
      plan,
      gymId: homeGymId,
      amountTzs,
      status: 'pending',
      provider: 'admin_approved',
      reference: null,
      requestedAt: now.toISOString(),
      decidedAt: null,
      decidedBy: null,
      note: null
    });
    return { status: 202, subscription: sub, paymentRequest };
  }

  // C4/B12: a trainer purchases the gym's trainer pass to train clients there.
  async function trainerPassPurchase({ trainerUserId, gymId }) {
    const gym = gyms.find(g => g.id === gymId);
    if (!gym) return { error: 'gym_not_found', status: 404 };
    const tp = gym.trainerPass;
    if (!tp?.enabled || !(tp.feeTzs > 0)) return { error: 'trainer_pass_not_offered', status: 400 };

    const days = DIRECT_PLAN_DAYS[tp.period] ?? 30;
    const now = new Date();
    const expiresAt = new Date(+now + days * 86_400_000);
    const sub = {
      id: `sub_${randomUUID().slice(0, 8)}`,
      memberId: trainerUserId,
      type: 'trainer_pass',
      tier: null,
      plan: tp.period,
      status: 'payment_pending',
      startedAt: now.toISOString(),
      cycleStartedAt: now.toISOString(),
      renewsAt: expiresAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      homeGymId: gymId,
      paymentRef: null,
      pilotPayment: true
    };
    await subscriptions.insertAsync(sub);
    const paymentRequest = await paymentRequests.insertAsync({
      id: `pay_${randomUUID().slice(0, 8)}`,
      memberId: trainerUserId,
      subscriptionId: sub.id,
      tier: null,
      plan: tp.period,
      gymId,
      amountTzs: tp.feeTzs,
      status: 'pending',
      provider: 'admin_approved',
      reference: null,
      requestedAt: now.toISOString(),
      decidedAt: null,
      decidedBy: null,
      note: 'trainer_pass'
    });
    return { status: 202, subscription: sub, paymentRequest };
  }

  async function subscribe({ memberId, tier, type = 'platform_pass', homeGymId, plan }) {
    if (type === 'direct_sub') return subscribeDirect({ memberId, homeGymId, plan });
    if (type === 'platform_pass' && !PASS_TIERS[tier]) return { error: 'invalid_tier', status: 400 };
    const now = new Date();
    const renewsAt = new Date(+now + 30 * 86_400_000);
    const amountTzs = settingsService.priceForTier(tier);
    const isFreeOnline = amountTzs === 0 && PASS_TIERS[tier]?.accessMode === 'free_online';
    const sub = {
      id: `sub_${randomUUID().slice(0, 8)}`,
      memberId,
      type, tier: type === 'platform_pass' ? tier : null,
      status: isFreeOnline ? 'active' : 'payment_pending',
      startedAt: now.toISOString(),
      cycleStartedAt: now.toISOString(),
      renewsAt: renewsAt.toISOString(),
      expiresAt: renewsAt.toISOString(),
      homeGymId: homeGymId ?? null,
      paymentRef: isFreeOnline ? 'FREE_ONLINE' : null,
      pilotPayment: true
    };
    await subscriptions.insertAsync(sub);
    if (isFreeOnline) return { status: 201, subscription: sub, paymentRequest: null };

    const paymentRequest = await paymentRequests.insertAsync({
      id: `pay_${randomUUID().slice(0, 8)}`,
      memberId,
      subscriptionId: sub.id,
      tier,
      amountTzs,
      status: 'pending',
      provider: 'admin_approved',
      reference: null,
      requestedAt: now.toISOString(),
      decidedAt: null,
      decidedBy: null,
      note: null
    });
    return { status: 202, subscription: sub, paymentRequest };
  }

  async function me(user) {
    const uid = user.id;
    const subs = await subscriptions.filterAsync(s => s.memberId === uid);
    let sub = subs
      .filter(s => ['active', 'expired', 'suspended'].includes(s.status))
      .sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt))[0] || null;
    // A1: expiry is derived from expiresAt — lazily persist the transition.
    if (sub) {
      const derived = effectiveSubscriptionStatus(sub);
      if (derived !== sub.status) {
        await subscriptions.updateByIdAsync(sub.id, { status: derived });
        sub = { ...sub, status: derived };
      }
    }
    // A3: profile must show the subscribed gym for direct subscriptions.
    if (sub?.type === 'direct_sub' && sub.homeGymId) {
      const homeGym = gyms.find(g => g.id === sub.homeGymId) || null;
      sub = {
        ...sub,
        homeGym: homeGym
          ? { id: homeGym.id, name: homeGym.name, tier: homeGym.tier, location: homeGym.location || null }
          : null,
      };
    }
    const allPendingPayments = await paymentRequests.filterAsync(p => p.memberId === uid && p.status === 'pending');
    const pendingPayment = allPendingPayments
      .sort((a, b) => +new Date(b.requestedAt) - +new Date(a.requestedAt))[0] || null;
    let visitsUsed = 0, visitCap = null;
    if (sub) {
      const since = +new Date(sub.cycleStartedAt);
      const visitCheckins = await checkins.filterAsync(c => c.memberId === uid && c.visitConsumed && +new Date(c.timestamp) >= since);
      visitsUsed = visitCheckins.length;
      visitCap = settingsService.visitCapForTier(sub.tier);
    }
    const pubId = await publicUserId(user);
    return { user: { ...user, publicId: pubId, userCode: pubId }, subscription: sub, pendingPayment, visitsUsed, visitCap };
  }

  async function memberCheckIns(memberId) {
    return (await checkins.filterAsync(c => c.memberId === memberId))
      .sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp))
      .slice(0, 50)
      .map(c => ({ ...c, gym: gyms.find(g => g.id === c.gymId) || null }));
  }

  async function memberPaymentHistory(memberId) {
    return (await paymentRequests.filterAsync(p => p.memberId === memberId))
      .sort((a, b) => +new Date(b.requestedAt) - +new Date(a.requestedAt));
  }

  return { listPasses, subscribe, trainerPassPurchase, me, memberCheckIns, memberPaymentHistory };
}
