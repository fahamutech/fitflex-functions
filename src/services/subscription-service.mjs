// Member-facing subscription (Platform Pass) service — catalogue, subscribe,
// self profile, check-in history, payment history.
import { randomUUID } from 'node:crypto';
import { PASS_TIERS } from '../shared/constants.mjs';
import { currentSubscription, effectiveSubscriptionStatus } from '../shared/subscription-status.mjs';
import { trainerPassOptions, trainerGymAccess, hideTrainerPass } from '../shared/trainer-access.mjs';
import { publicGym } from './gym-service.mjs';
import { toSessionUser } from '../shared/session-user.mjs';
import { fundedBySubscription } from '../shared/check-in-rules.mjs';
import { PRODUCT_TYPES, MEMBER_ACCESS_PRODUCTS, productTypeOfPayment } from '../shared/payment-product.mjs';
import { upgradeNote, upgradeOf, upgradeDifference, isSponsoredPassId } from '../shared/pass-upgrade.mjs';
import {
  normalizePaymentReference, normalizePayerPhone, memoryReferenceStore, DUPLICATE_ATTEMPT_ACTION, DUPLICATE_ATTEMPT_LIMIT,
} from '../shared/manual-payment.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
// GET /me/checkins: rows without a date range (unchanged for older app builds).
export const CHECKIN_DEFAULT_LIMIT = 50;
// With a date range: default window, longest window, and a defensive row cap.
export const CHECKIN_RANGE_DEFAULT_DAYS = 90;
export const CHECKIN_RANGE_MAX_DAYS = 366;
export const CHECKIN_RANGE_MAX_ROWS = 1000;

export function createSubscriptionService({
  subscriptions, paymentRequests, checkins, gyms, settingsService, publicUserId,
  // Slice A3: required() is true when MANUAL_PAY_INSTRUCTIONS is on and the Lipa Namba is configured.
  manualPayment = { required: () => false },
  auditLog = null,
  // Reference lookups (holders of a key, refused attempts per member); the database one in production.
  referenceStore = null,
  now = () => Date.now(),
}) {
  const references = referenceStore || memoryReferenceStore({ paymentRequests, auditLog });
  // The legacy pass catalogue (GET /passes), read from Settings like
  // /subscription-tiers: only tiers that may be sold today (owner decision
  // 2026-10-19). Fields kept for older app builds (id, price, visitCap with
  // null = unlimited) alongside the Settings names. A7: never "Online Free".
  function listPasses() {
    return (settingsService.publicTiers?.() ?? [])
      .filter(t => PASS_TIERS[t.key]?.accessMode !== 'free_online')
      .map(t => {
        const cfg = settingsService.sellableTier(t.key);
        return cfg && {
          id: t.key,
          key: t.key,
          label: cfg.label,
          price: cfg.price,
          monthlyPrice: cfg.price,
          visitCap: Number.isFinite(cfg.visitCap) ? cfg.visitCap : null,
          visits: t.visits,
          gymAccess: cfg.gymAccess ?? null,
          trainerDiscountPct: PASS_TIERS[t.key]?.trainerDiscountPct ?? 0,
        };
      })
      .filter(Boolean);
  }

  /**
   * The tier when it may be sold today, else the refusal. Settings is the only
   * source: a tier must be there with a positive price and an explicit visits
   * value (and not switched off). Never a built-in fallback.
   */
  function sellable(tier) {
    if (!tier || typeof tier !== 'string') return { error: 'invalid_tier', status: 400 };
    const cfg = settingsService.sellableTier(tier);
    if (!cfg) return { error: 'tier_not_available', status: 409, tier };
    return { cfg };
  }

  // A7: gym direct plans — durations drive real expiry (A1).
  const DIRECT_PLAN_DAYS = Object.freeze({ daily: 1, weekly: 7, monthly: 30 });
  const directPlanAmount = (gym, plan) => ({
    daily: Number(gym.ratePerDay || 0),
    weekly: Number(gym.ratePerWeek || 0),
    monthly: Number(gym.ratePerMonth || 0),
  })[plan];

  const positiveTzs = (v) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  /** A subscription of this kind (and gym) still waiting on its payment. */
  async function pendingSubscription(memberId, type, gymId = null) {
    const rows = await subscriptions.filterAsync(s =>
      s.memberId === memberId && s.type === type && s.status === 'payment_pending'
      && (type !== 'direct_sub' || s.homeGymId === gymId));
    return rows[0] || null;
  }

  /** Record a refused duplicate (security review M1): admins see it; it also feeds the rate limit. */
  async function auditDuplicate(memberId, key, product) {
    try {
      await auditLog?.insertAsync?.({
        id: randomUUID(), at: new Date(now()).toISOString(), actor: memberId,
        action: DUPLICATE_ATTEMPT_ACTION, target: memberId, before: null, after: { referenceKey: key, product },
      });
    } catch { /* the refusal stands even if the audit write fails */ }
  }

  /**
   * Slice A3: while manual payment is on, the member's mobile-money transaction
   * ID — required, well formed, not used already (judged on its letters+digits
   * key, against member IDs and admin/provider references alike) — and the
   * number they paid from (+255…). A member who keeps offering IDs that are
   * taken is stopped for a while (429). {} when not required (flag off or no
   * Lipa Namba configured): nothing changes then.
   */
  async function memberReferenceFor(raw, rawPhone, memberId, product) {
    if (!manualPayment.required()) return {};
    const out = normalizePaymentReference(raw);
    if (out.error) return { error: out.error, status: 400 };
    const payer = normalizePayerPhone(rawPhone);
    if (payer.error) return { error: payer.error, status: 400 };
    const since = new Date(now() - DUPLICATE_ATTEMPT_LIMIT.windowMs);
    if (await references.duplicateAttemptsSince(memberId, since) >= DUPLICATE_ATTEMPT_LIMIT.max) {
      return { error: 'too_many_attempts', status: 429 };
    }
    if ((await references.holders(out.key)).length) {
      await auditDuplicate(memberId, out.key, product);
      return { error: 'payment_reference_duplicate', status: 409 };
    }
    return { memberReference: out.reference, memberReferenceKey: out.key, payerPhone: payer.phone };
  }

  /** The member-reference fields of a new payment request (none when not required). */
  const referenceFields = (ref) => (ref.memberReference
    ? { memberReference: ref.memberReference, memberReferenceKey: ref.memberReferenceKey, payerPhone: ref.payerPhone } : {});

  /**
   * Insert a payment request. Two requests racing with the same transaction ID:
   * the database's unique index stops the second, whose plan (if it made one) is
   * marked cancelled.
   */
  async function insertPaymentRequest(row, newSubscriptionId = null) {
    try {
      return { paymentRequest: await paymentRequests.insertAsync(row) };
    } catch (err) {
      if (err?.code !== '23505' || !row.memberReference) throw err;
      if (newSubscriptionId) await subscriptions.updateByIdAsync(newSubscriptionId, { status: 'payment_cancelled' });
      await auditDuplicate(row.memberId, row.memberReferenceKey, row.note || row.tier || row.plan || null);
      return { error: 'payment_reference_duplicate', status: 409 };
    }
  }

  async function subscribeDirect({ memberId, homeGymId, plan, reference, payerPhone, manual = false }) {
    if (!homeGymId) return { error: 'homeGymId_required', status: 400 };
    const gym = gyms.find(g => g.id === homeGymId);
    if (!gym) return { error: 'gym_not_found', status: 404 };
    // A gym that is not live (pending, suspended, ...) sells nothing.
    if (gym.status && gym.status !== 'active') return { error: 'gym_not_available', status: 409 };
    const days = DIRECT_PLAN_DAYS[plan];
    if (!days) return { error: 'invalid_plan', status: 400 };
    // The price is the gym's own configured rate, never the client's. A period
    // the gym has not priced is not for sale — and never falls back to a pass tier.
    const amountTzs = positiveTzs(directPlanAmount(gym, plan));
    if (!amountTzs) return { error: 'plan_not_offered', status: 400 };
    // One open request per gym: a repeated tap or a retry must not charge twice.
    const open = await pendingSubscription(memberId, 'direct_sub', homeGymId);
    if (open) return { error: 'payment_already_pending', status: 409 };
    // Member-bought plans only (POST /me/subscribe); a trainer's member plan is unchanged.
    const ref = manual ? await memberReferenceFor(reference, payerPhone, memberId, 'gym_plan') : {};
    if (ref.error) return ref;

    const now = new Date();
    const expiresAt = new Date(+now + days * 86_400_000);
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
    const inserted = await insertPaymentRequest({
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
      ...referenceFields(ref),
      requestedAt: now.toISOString(),
      decidedAt: null,
      decidedBy: null,
      note: null
    }, sub.id);
    if (inserted.error) return inserted;
    return { status: 202, subscription: sub, paymentRequest: inserted.paymentRequest };
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
    // A mobile-money prompt is on the member's phone: cancelling now would strand the money.
    const live = await paymentRequests.filterAsync(p => p.subscriptionId === sub.id && p.status === 'pending' && p.provider === 'tunzaa' && p.reference);
    if (live.length) return { error: 'payment_in_progress', status: 409 };
    const updated = await subscriptions.updateByIdAsync(sub.id, { status: 'payment_cancelled' });
    const requests = await paymentRequests.filterAsync(p => p.subscriptionId === sub.id && p.status === 'pending');
    for (const r of requests) {
      await paymentRequests.updateByIdAsync(r.id, { status: 'cancelled', decidedAt: new Date().toISOString(), note: r.note });
    }
    return { status: 200, subscription: updated };
  }

  async function subscribe({ memberId, tier, type = 'platform_pass', homeGymId, plan, reference, payerPhone }) {
    if (type === 'direct_sub') return subscribeDirect({ memberId, homeGymId, plan, reference, payerPhone, manual: true });
    // Only the two member products are bought here (trainer passes and sessions have their own routes).
    if (type !== 'platform_pass') return { error: 'invalid_type', status: 400 };
    // The tier must be one the platform sells today, as configured in
    // Settings (fail closed). This includes the free online plan: it is only
    // available if Settings lists it, and a listed tier needs a positive price.
    const offer = sellable(tier);
    if (offer.error) return offer;
    const amountTzs = offer.cfg.price;
    if (await openPassPayment(memberId)) return { error: 'payment_already_pending', status: 409 };
    const ref = await memberReferenceFor(reference, payerPhone, memberId, 'fitflex_pass');
    if (ref.error) return ref;
    const now = new Date();
    const renewsAt = new Date(+now + 30 * 86_400_000);
    const sub = {
      id: `sub_${randomUUID().slice(0, 8)}`,
      memberId,
      type, tier,
      status: 'payment_pending',
      startedAt: now.toISOString(),
      cycleStartedAt: now.toISOString(),
      renewsAt: renewsAt.toISOString(),
      expiresAt: renewsAt.toISOString(),
      homeGymId: null, // a FitFlex Pass roams; it is never bound to one gym
      paymentRef: null,
      pilotPayment: true
    };
    await subscriptions.insertAsync(sub);

    const inserted = await insertPaymentRequest({
      id: `pay_${randomUUID().slice(0, 8)}`,
      memberId,
      subscriptionId: sub.id,
      tier,
      amountTzs,
      status: 'pending',
      provider: 'admin_approved',
      reference: null,
      ...referenceFields(ref),
      requestedAt: now.toISOString(),
      decidedAt: null,
      decidedBy: null,
      note: null
    }, sub.id);
    if (inserted.error) return inserted;
    return { status: 202, subscription: sub, paymentRequest: inserted.paymentRequest };
  }

  /** The paid FitFlex Pass a member is on today, if it is one they can upgrade from. */
  async function upgradableCurrentPass(memberId) {
    const subs = await subscriptions.filterAsync(s => s.memberId === memberId && s.type === 'platform_pass');
    const current = currentSubscription(subs);
    if (!current || effectiveSubscriptionStatus(current) !== 'active') return { error: 'no_active_pass', status: 409 };
    if (isSponsoredPassId(current.id)) return { error: 'sponsored_pass', status: 409 };
    const fromPrice = Number(settingsService.priceForTier(current.tier));
    if (!(fromPrice > 0)) return { error: 'no_paid_pass', status: 409 };
    return { current, fromPrice };
  }

  /** The tiers a member can move up to, each with what the move costs them. */
  async function upgradeOptions(memberId) {
    const held = await upgradableCurrentPass(memberId);
    if (held.error) return held;
    // Only tiers that may be sold today (publicTiers lists just those).
    const catalogue = (settingsService.publicTiers?.() ?? []).filter(t => settingsService.isTierSellable(t.key));
    const options = catalogue
      .map(t => ({ ...t, differenceTzs: upgradeDifference(held.fromPrice, settingsService.priceForTier(t.key)) }))
      .filter(t => t.differenceTzs && PASS_TIERS[t.key]?.accessMode !== 'free_online')
      .map(t => ({ tier: t.key, label: t.label, monthlyPrice: t.monthlyPrice, visits: t.visits, gymAccess: t.gymAccess, differenceTzs: t.differenceTzs }))
      .sort((a, b) => a.differenceTzs - b.differenceTzs);
    return {
      status: 200,
      current: { subscriptionId: held.current.id, tier: held.current.tier, priceTzs: held.fromPrice, expiresAt: held.current.expiresAt },
      options,
    };
  }

  /** An upgrade or a pass purchase still waiting on its payment. */
  async function openPassPayment(memberId) {
    if (await pendingSubscription(memberId, 'platform_pass')) return true;
    const open = await paymentRequests.filterAsync(p => p.memberId === memberId && p.status === 'pending' && upgradeOf(p));
    return open.length > 0;
  }

  /**
   * Move up to a higher tier by paying the difference in price — never the
   * full price, and not reduced for the days left on the current plan. The
   * plan is upgraded in place when the payment is approved: it keeps its end
   * date and its visit counter, so an upgrade never extends a plan.
   */
  async function upgradePass({ memberId, tier, reference, payerPhone }) {
    const held = await upgradableCurrentPass(memberId);
    if (held.error) return held;
    if (PASS_TIERS[tier]?.accessMode === 'free_online') return { error: 'invalid_tier', status: 400 };
    // The target tier must be sold today, as configured in Settings (fail closed).
    const offer = sellable(tier);
    if (offer.error) return offer;
    const amountTzs = upgradeDifference(held.fromPrice, offer.cfg.price);
    if (!amountTzs) return { error: 'not_an_upgrade', status: 409 };
    if (await openPassPayment(memberId)) return { error: 'payment_already_pending', status: 409 };
    const ref = await memberReferenceFor(reference, payerPhone, memberId, 'pass_upgrade');
    if (ref.error) return ref;

    const inserted = await insertPaymentRequest({
      id: `pay_${randomUUID().slice(0, 8)}`,
      memberId,
      // The payment belongs to the plan it upgrades (settlement sums a plan's collected money by it); the note says it is an upgrade.
      subscriptionId: held.current.id,
      tier,
      amountTzs,
      status: 'pending',
      provider: 'admin_approved',
      reference: null,
      ...referenceFields(ref),
      requestedAt: new Date().toISOString(),
      decidedAt: null,
      decidedBy: null,
      note: upgradeNote(held.current.id, held.current.tier)
    });
    if (inserted.error) return inserted;
    return {
      status: 202, paymentRequest: inserted.paymentRequest,
      upgradeFrom: { subscriptionId: held.current.id, tier: held.current.tier },
      endsAt: held.current.expiresAt,
    };
  }

  /** A payment request with what it buys: product type, and the gym / tier / period behind it. */
  function describePayment(p, sub = null) {
    const productType = productTypeOfPayment(p, sub);
    const gym = p.gymId ? gyms.find(g => g.id === p.gymId) : null;
    return {
      ...p,
      productType,
      gym: gym ? { id: gym.id, name: gym.name } : null,
      subscriptionType: sub?.type ?? null,
    };
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
    // Every open request, labelled by what it buys. Only the member's access
    // products (FitFlex Pass, a gym plan) hold the single `pendingPayment`
    // slot: a pending trainer session or shop order must not block, or be
    // shown as, a pass or gym plan.
    const allPendingPayments = await paymentRequests.filterAsync(p => p.memberId === uid && p.status === 'pending');
    const subIds = [...new Set(allPendingPayments.map(p => p.subscriptionId).filter(Boolean))];
    const subRows = subIds.length ? await subscriptions.filterAsync(s => subIds.includes(s.id)) : [];
    const pendingPayments = allPendingPayments
      .sort((a, b) => +new Date(b.requestedAt) - +new Date(a.requestedAt))
      .map(p => describePayment(p, subRows.find(s => s.id === p.subscriptionId) || null));
    const pendingPayment = pendingPayments.find(p => MEMBER_ACCESS_PRODUCTS.includes(p.productType)) || null;
    // The two access products side by side: a gym plan never hides the member's FitFlex Pass.
    const paidSubs = subs.filter(s => ['active', 'expired', 'suspended'].includes(s.status));
    const passSub = currentSubscription(paidSubs.filter(s => s.type === 'platform_pass'));
    const entitlements = {
      fitflexPass: passSub ? { ...passSub, status: effectiveSubscriptionStatus(passSub), productType: PRODUCT_TYPES.FITFLEX_PASS } : null,
      gymSubscriptions: paidSubs
        .filter(s => s.type === 'direct_sub' && effectiveSubscriptionStatus(s) === 'active')
        .sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt))
        .map(s => {
          const g = gyms.find(x => x.id === s.homeGymId);
          return { ...s, status: 'active', productType: PRODUCT_TYPES.GYM_SUBSCRIPTION, homeGym: g ? { id: g.id, name: g.name, location: g.location || null } : null };
        }),
    };
    let visitsUsed = 0, visitCap = null;
    if (sub) {
      const since = +new Date(sub.cycleStartedAt);
      const own = fundedBySubscription(sub);
      const visitCheckins = await checkins.filterAsync(c => c.memberId === uid && c.visitConsumed && +new Date(c.timestamp) >= since && own(c));
      visitsUsed = visitCheckins.length;
      visitCap = settingsService.visitCapForTier(sub.tier);
    }
    const pubId = await publicUserId(user);
    return { user: { ...toSessionUser(user), publicId: pubId, userCode: pubId }, subscription: sub, pendingPayment, pendingPayments, entitlements, visitsUsed, visitCap };
  }

  // GET /me/checkins. Without from/to: the newest 50 (what older app builds
  // expect). With from and/or to: every check-in with from <= timestamp < to,
  // newest first, capped at CHECKIN_RANGE_MAX_ROWS as a guard. A missing `to`
  // is now; a missing `from` is `to` minus 90 days; the window is at most 366 days.
  async function memberCheckIns(memberId, { from, to } = {}) {
    const withGym = c => ({ ...c, gym: hideTrainerPass(publicGym(gyms.find(g => g.id === c.gymId) || null)) });
    const newestFirst = (a, b) => +new Date(b.timestamp) - +new Date(a.timestamp);
    const given = v => v !== undefined && v !== null && v !== '';
    if (!given(from) && !given(to)) {
      return (await checkins.filterAsync(c => c.memberId === memberId))
        .sort(newestFirst)
        .slice(0, CHECKIN_DEFAULT_LIMIT)
        .map(withGym);
    }
    const parse = v => {
      if (typeof v !== 'string') return null;
      const d = new Date(v);
      return Number.isNaN(+d) ? null : d;
    };
    const end = given(to) ? parse(to) : new Date();
    if (!end) return { error: 'invalid_date', status: 400 };
    const start = given(from) ? parse(from) : new Date(+end - CHECKIN_RANGE_DEFAULT_DAYS * DAY_MS);
    if (!start) return { error: 'invalid_date', status: 400 };
    if (start > end) return { error: 'invalid_range', status: 400 };
    if (+end - +start > CHECKIN_RANGE_MAX_DAYS * DAY_MS) return { error: 'range_too_long', status: 400 };
    return (await checkins.filterByColumnAsync('memberId', memberId))
      .filter(c => c.memberId === memberId)
      .filter(c => { const t = new Date(c.timestamp); return t >= start && t < end; })
      .sort(newestFirst)
      .slice(0, CHECKIN_RANGE_MAX_ROWS)
      .map(withGym);
  }

  async function memberPaymentHistory(memberId) {
    const rows = (await paymentRequests.filterAsync(p => p.memberId === memberId))
      .sort((a, b) => +new Date(b.requestedAt) - +new Date(a.requestedAt));
    const subIds = new Set(rows.map(p => p.subscriptionId).filter(Boolean));
    const subRows = subIds.size ? await subscriptions.filterAsync(s => subIds.has(s.id)) : [];
    return rows.map(p => describePayment(p, subRows.find(s => s.id === p.subscriptionId) || null));
  }

  return {
    listPasses, subscribe, upgradeOptions, upgradePass, trainerPassPurchase, trainerMemberPlanPurchase, trainerPasses, cancelTrainerPass,
    me, memberCheckIns, memberPaymentHistory,
  };
}
