// Member-facing subscription (Platform Pass) service — catalogue, subscribe,
// self profile, check-in history, payment history.
import { randomUUID } from 'node:crypto';
import { PASS_TIERS } from '../shared/constants.mjs';

export function createSubscriptionService({
  subscriptions, paymentRequests, checkins, gyms, settingsService, publicUserId,
}) {
  function listPasses() {
    return Object.entries(PASS_TIERS).map(([id, cfg]) => ({
      id, ...cfg,
      visitCap: Number.isFinite(cfg.visitCap) ? cfg.visitCap : null
    }));
  }

  async function subscribe({ memberId, tier, type = 'platform_pass', homeGymId }) {
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
    const sub = subs
      .filter(s => ['active', 'expired', 'suspended'].includes(s.status))
      .sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt))[0] || null;
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

  return { listPasses, subscribe, me, memberCheckIns, memberPaymentHistory };
}
