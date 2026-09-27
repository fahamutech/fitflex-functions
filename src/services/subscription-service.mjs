// Member-facing subscription (Platform Pass) service — catalogue, subscribe,
// self profile, check-in history, payment history.
import { randomUUID } from 'node:crypto';
import { PASS_TIERS } from '../shared/constants.mjs';
import { currentSubscription, effectiveSubscriptionStatus } from '../shared/subscription-status.mjs';
import { trainerPassOptions, trainerGymAccess, hideTrainerPass } from '../shared/trainer-access.mjs';

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

  // A pass/plan already held (active or awaiting payment) for this gym.
  async function heldGymPlan(userId, gymId, type) {
    const rows = await subscriptions.filterAsync(s =>
      s.memberId === userId && s.type === type && s.homeGymId === gymId);
    return rows.find(s => s.status === 'payment_pending' || effectiveSubscriptionStatus(s) === 'active') || null;
  }

  // C4/B12: a trainer buys one of the gym's trainer passes (daily / weekly /
  // monthly, priced by the owner) to train clients there. Trainers linked to
  // the gym train there free, so they never need one.
  async function trainerPassPurchase({ trainerUserId, gymId, period, trainer = null }) {
    const gym = gyms.find(g => g.id === gymId);
    if (!gym) return { error: 'gym_not_found', status: 404 };
    const access = trainerGymAccess({ trainer, gym });
    if (access.access === 'home') return { error: 'home_gym_free', status: 409 };
    const options = trainerPassOptions(gym);
    if (!options.length) return { error: 'trainer_pass_not_offered', status: 400 };
    // Older app builds send no period — fine while the gym sells just one.
    const chosen = period
      ? options.find(o => o.period === period)
      : (options.length === 1 ? options[0] : null);
    if (!chosen) return { error: period ? 'trainer_pass_period_not_offered' : 'period_required', status: 400 };
    const held = await heldGymPlan(trainerUserId, gymId, 'trainer_pass');
    if (held) {
      return { error: held.status === 'payment_pending' ? 'trainer_pass_pending' : 'trainer_pass_already_active', status: 409 };
    }

    const days = DIRECT_PLAN_DAYS[chosen.period];
    const now = new Date();
    const expiresAt = new Date(+now + days * 86_400_000);
    const sub = {
      id: `sub_${randomUUID().slice(0, 8)}`,
      memberId: trainerUserId,
      type: 'trainer_pass',
      tier: null,
      plan: chosen.period,
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
      plan: chosen.period,
      gymId,
      amountTzs: chosen.feeTzs,
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

  /**
   * T4: at a gym that sells no trainer pass, a trainer buys the gym's member
   * plan instead (member price). Not allowed where trainer passes exist, and
   * not needed at the trainer's own gyms.
   */
  async function trainerMemberPlanPurchase({ trainerUserId, gymId, plan, trainer = null }) {
    const gym = gyms.find(g => g.id === gymId);
    if (!gym) return { error: 'gym_not_found', status: 404 };
    const access = trainerGymAccess({ trainer, gym });
    if (access.access === 'home') return { error: 'home_gym_free', status: 409 };
    if (access.access === 'trainer_pass') return { error: 'use_trainer_pass', status: 409 };
    if (!access.options.some(o => o.period === plan)) return { error: 'invalid_plan', status: 400 };
    if (await heldGymPlan(trainerUserId, gymId, 'direct_sub')) return { error: 'plan_already_held', status: 409 };
    return subscribeDirect({ memberId: trainerUserId, homeGymId: gymId, plan });
  }

  /** A trainer's gym passes and member plans, newest first, with the gym and pending payment. */
  async function trainerPasses({ trainerUserId }) {
    const subs = await subscriptions.filterAsync(s =>
      s.memberId === trainerUserId && (s.type === 'trainer_pass' || s.type === 'direct_sub'));
    const pending = await paymentRequests.filterAsync(p => p.memberId === trainerUserId && p.status === 'pending');
    return subs
      .sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt))
      .map(s => {
        const gym = gyms.find(g => g.id === s.homeGymId);
        return {
          ...s,
          status: s.status === 'payment_pending' ? s.status : effectiveSubscriptionStatus(s),
          kind: s.type === 'trainer_pass' ? 'trainer_pass' : 'member_plan',
          gym: gym ? { id: gym.id, name: gym.name, location: gym.location || null } : null,
          paymentRequest: pending.find(p => p.subscriptionId === s.id) || null,
        };
      });
  }

  /** Withdraw a pass/plan request that has not been paid yet. */
  async function cancelTrainerPass({ trainerUserId, subscriptionId }) {
    const sub = await subscriptions.findByIdAsync(subscriptionId);
    if (!sub || sub.memberId !== trainerUserId || !['trainer_pass', 'direct_sub'].includes(sub.type)) {
      return { error: 'not_found', status: 404 };
    }
    if (sub.status !== 'payment_pending') return { error: 'not_cancellable', status: 409 };
    const updated = await subscriptions.updateByIdAsync(sub.id, { status: 'payment_cancelled' });
    const requests = await paymentRequests.filterAsync(p => p.subscriptionId === sub.id && p.status === 'pending');
    for (const r of requests) {
      await paymentRequests.updateByIdAsync(r.id, { status: 'cancelled', decidedAt: new Date().toISOString(), note: r.note });
    }
    return { status: 200, subscription: updated };
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
    let sub = currentSubscription(subs);
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
      .map(c => ({ ...c, gym: hideTrainerPass(gyms.find(g => g.id === c.gymId) || null) }));
  }

  async function memberPaymentHistory(memberId) {
    return (await paymentRequests.filterAsync(p => p.memberId === memberId))
      .sort((a, b) => +new Date(b.requestedAt) - +new Date(a.requestedAt));
  }

  return {
    listPasses, subscribe, trainerPassPurchase, trainerMemberPlanPurchase, trainerPasses, cancelTrainerPass,
    me, memberCheckIns, memberPaymentHistory,
  };
}
