// Subscription & payment journey audit — the three commercial products
// (FitFlex Pass, direct gym plan, trainer service) stay distinct from
// selection through payment, activation and history.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSubscriptionService } from '../src/services/subscription-service.mjs';
import { createWebhookService } from '../src/services/webhook-service.mjs';
import { createAdminPaymentService } from '../src/services/admin-payment-service.mjs';
import { productTypeOfPayment, PRODUCT_TYPES } from '../src/shared/payment-product.mjs';

function memStore(rows = []) {
  return {
    rows,
    async allAsync() { return rows; },
    async filterAsync(fn) { return rows.filter(fn); },
    async filterByColumnInAsync(col, vals) { return rows.filter(r => vals.includes(r[col])); },
    async findAsync(fn) { return rows.find(fn) || null; },
    async findByIdAsync(id) { return rows.find((r) => r.id === id) || null; },
    async insertAsync(row) {
      if (row.id && rows.some(r => r.id === row.id)) throw new Error('duplicate key');
      rows.push(row); return row;
    },
    async updateByIdAsync(id, patch) {
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows[i] = { ...rows[i], ...patch };
      return rows[i] || null;
    },
  };
}

const TIERS = [
  { key: 'basic', label: 'Basic', monthlyPrice: 60000, visits: 8, gymAccess: 'standard' },
  { key: 'pro', label: 'Pro', monthlyPrice: 120000, visits: 12, gymAccess: 'midtier' },
  { key: 'premium', label: 'Premium', monthlyPrice: 200000, visits: 20, gymAccess: 'premium' },
  { key: 'executive', label: 'Executive', monthlyPrice: 350000, visits: -1, gymAccess: 'luxury_executive' },
];
const settingsService = {
  publicTiers: () => TIERS,
  priceForTier: (k) => TIERS.find(t => t.key === k)?.monthlyPrice ?? 0,
  visitCapForTier: () => null,
};

const gymA = { id: 'gym_a', name: 'Alpha Gym', tier: 'standard', status: 'active', ratePerDay: 5000, ratePerWeek: 25000, ratePerMonth: 80000 };
const gymMonthlyOnly = { id: 'gym_m', name: 'Monthly Only', tier: 'standard', status: 'active', ratePerMonth: 90000 };
const gymNoRates = { id: 'gym_n', name: 'No Rates', tier: 'standard', status: 'active' };
const gymSuspended = { id: 'gym_s', name: 'Suspended', tier: 'standard', status: 'suspended', ratePerDay: 1000 };

function setup() {
  const subscriptions = memStore();
  const paymentRequests = memStore();
  const service = createSubscriptionService({
    subscriptions, paymentRequests, checkins: memStore(),
    gyms: [gymA, gymMonthlyOnly, gymNoRates, gymSuspended],
    settingsService, publicUserId: async () => 'FF-1',
  });
  return { service, subscriptions, paymentRequests };
}

// ── Direct gym plan: only what the gym actually sells ───────────────────────

test('direct plan for a period the gym has not priced is refused (no zero-TZS request)', async () => {
  const { service, paymentRequests } = setup();
  const out = await service.subscribe({ memberId: 'u1', type: 'direct_sub', homeGymId: 'gym_m', plan: 'daily' });
  assert.equal(out.error, 'plan_not_offered');
  assert.equal(paymentRequests.rows.length, 0);
});

test('a gym with no pricing never falls back to pass tiers', async () => {
  const { service, subscriptions } = setup();
  for (const plan of ['daily', 'weekly', 'monthly']) {
    const out = await service.subscribe({ memberId: 'u1', type: 'direct_sub', homeGymId: 'gym_n', plan });
    assert.equal(out.error, 'plan_not_offered');
  }
  assert.equal(subscriptions.rows.length, 0);
});

test('direct plan price is the gym rate and the request keeps the gym and plan', async () => {
  const { service } = setup();
  const out = await service.subscribe({ memberId: 'u1', type: 'direct_sub', homeGymId: 'gym_a', plan: 'weekly', tier: 'executive', amountTzs: 1 });
  assert.equal(out.status, 202);
  assert.equal(out.paymentRequest.amountTzs, 25000);
  assert.equal(out.paymentRequest.gymId, 'gym_a');
  assert.equal(out.paymentRequest.plan, 'weekly');
  assert.equal(out.paymentRequest.tier, null, 'a gym plan carries no pass tier');
  assert.equal(out.subscription.tier, null);
  assert.equal(out.subscription.homeGymId, 'gym_a');
});

test('a suspended gym sells nothing', async () => {
  const { service } = setup();
  const out = await service.subscribe({ memberId: 'u1', type: 'direct_sub', homeGymId: 'gym_s', plan: 'daily' });
  assert.equal(out.error, 'gym_not_available');
});

// ── FitFlex Pass: only the configured tiers ─────────────────────────────────

test('unknown tier, missing tier and unknown type are refused', async () => {
  const { service, subscriptions } = setup();
  assert.equal((await service.subscribe({ memberId: 'u1', tier: 'diamond' })).error, 'invalid_tier');
  assert.equal((await service.subscribe({ memberId: 'u1' })).error, 'invalid_tier');
  assert.equal((await service.subscribe({ memberId: 'u1', type: 'trainer_pass', tier: 'pro' })).error, 'invalid_type');
  assert.equal((await service.subscribe({ memberId: 'u1', type: 'bogus' })).error, 'invalid_type');
  assert.equal(subscriptions.rows.length, 0);
});

test('a tier the admin removed from the catalogue is not sellable even if built in', async () => {
  const subscriptions = memStore();
  const service = createSubscriptionService({
    subscriptions, paymentRequests: memStore(), checkins: memStore(), gyms: [],
    settingsService: { ...settingsService, publicTiers: () => TIERS.filter(t => t.key !== 'executive') },
    publicUserId: async () => 'x',
  });
  assert.equal((await service.subscribe({ memberId: 'u1', tier: 'executive' })).error, 'invalid_tier');
});

test('a tier configured at price 0 is not for sale', async () => {
  const service = createSubscriptionService({
    subscriptions: memStore(), paymentRequests: memStore(), checkins: memStore(), gyms: [],
    settingsService: { ...settingsService, publicTiers: () => [{ key: 'pro' }], priceForTier: () => 0 },
    publicUserId: async () => 'x',
  });
  assert.equal((await service.subscribe({ memberId: 'u1', tier: 'pro' })).error, 'tier_not_available');
});

test('pass price comes from the catalogue; a pass is never bound to a gym', async () => {
  const { service } = setup();
  const out = await service.subscribe({ memberId: 'u1', tier: 'pro', homeGymId: 'gym_a', amountTzs: 1 });
  assert.equal(out.paymentRequest.amountTzs, 120000);
  assert.equal(out.subscription.homeGymId, null);
  assert.equal(out.subscription.type, 'platform_pass');
});

// ── Duplicate submissions ───────────────────────────────────────────────────

test('repeating a pass request while one is pending creates nothing new', async () => {
  const { service, subscriptions, paymentRequests } = setup();
  assert.equal((await service.subscribe({ memberId: 'u1', tier: 'pro' })).status, 202);
  const again = await service.subscribe({ memberId: 'u1', tier: 'pro' });
  assert.equal(again.error, 'payment_already_pending');
  assert.equal(subscriptions.rows.length, 1);
  assert.equal(paymentRequests.rows.length, 1);
});

test('a pending request for one gym does not block another gym or the pass', async () => {
  const { service } = setup();
  assert.equal((await service.subscribe({ memberId: 'u1', type: 'direct_sub', homeGymId: 'gym_a', plan: 'daily' })).status, 202);
  assert.equal((await service.subscribe({ memberId: 'u1', type: 'direct_sub', homeGymId: 'gym_a', plan: 'daily' })).error, 'payment_already_pending');
  assert.equal((await service.subscribe({ memberId: 'u1', type: 'direct_sub', homeGymId: 'gym_m', plan: 'monthly' })).status, 202);
  assert.equal((await service.subscribe({ memberId: 'u1', tier: 'basic' })).status, 202);
});

// ── History & /me ───────────────────────────────────────────────────────────

test('payment history labels each request with its product and gym', async () => {
  const { service, paymentRequests } = setup();
  await service.subscribe({ memberId: 'u1', tier: 'pro' });
  await service.subscribe({ memberId: 'u1', type: 'direct_sub', homeGymId: 'gym_a', plan: 'monthly' });
  paymentRequests.rows.push({ id: 'pay_bk', memberId: 'u1', bookingGroupId: 'tbg_1', plan: 'trainer_session', gymId: 'gym_a', amountTzs: 30000, status: 'pending', requestedAt: new Date().toISOString() });
  const history = await service.memberPaymentHistory('u1');
  const byType = Object.fromEntries(history.map(h => [h.productType, h]));
  assert.deepEqual(Object.keys(byType).sort(), ['FITFLEX_PASS', 'GYM_SUBSCRIPTION', 'TRAINER_SERVICE']);
  assert.equal(byType.GYM_SUBSCRIPTION.gym.name, 'Alpha Gym');
  assert.equal(byType.FITFLEX_PASS.gym, null);
});

test('/me: a pending trainer booking neither blocks nor masquerades as a pass or gym plan', async () => {
  const { service, paymentRequests } = setup();
  paymentRequests.rows.push({ id: 'pay_bk', memberId: 'u1', bookingGroupId: 'tbg_1', plan: 'trainer_session', amountTzs: 30000, status: 'pending', requestedAt: new Date().toISOString() });
  const out = await service.me({ id: 'u1', userType: 'member' });
  assert.equal(out.pendingPayment, null);
  assert.equal(out.pendingPayments.length, 1);
  assert.equal(out.pendingPayments[0].productType, 'TRAINER_SERVICE');
});

test('/me: pending gym plan is reported as a gym plan with its gym', async () => {
  const { service } = setup();
  await service.subscribe({ memberId: 'u1', type: 'direct_sub', homeGymId: 'gym_a', plan: 'daily' });
  const out = await service.me({ id: 'u1', userType: 'member' });
  assert.equal(out.pendingPayment.productType, 'GYM_SUBSCRIPTION');
  assert.equal(out.pendingPayment.gym.id, 'gym_a');
  assert.equal(out.pendingPayment.tier, null);
});

test('/me: a newer gym plan does not hide the FitFlex Pass', async () => {
  const { service, subscriptions } = setup();
  const now = Date.now();
  subscriptions.rows.push(
    { id: 's_pass', memberId: 'u1', type: 'platform_pass', tier: 'pro', status: 'active', startedAt: new Date(now - 5 * 86400000).toISOString(), cycleStartedAt: new Date(now - 5 * 86400000).toISOString(), expiresAt: new Date(now + 25 * 86400000).toISOString() },
    { id: 's_gym', memberId: 'u1', type: 'direct_sub', plan: 'monthly', homeGymId: 'gym_a', status: 'active', startedAt: new Date(now - 86400000).toISOString(), cycleStartedAt: new Date(now - 86400000).toISOString(), expiresAt: new Date(now + 29 * 86400000).toISOString() },
  );
  const out = await service.me({ id: 'u1', userType: 'member' });
  assert.equal(out.entitlements.fitflexPass.tier, 'pro');
  assert.equal(out.entitlements.fitflexPass.productType, 'FITFLEX_PASS');
  assert.equal(out.entitlements.gymSubscriptions.length, 1);
  assert.equal(out.entitlements.gymSubscriptions[0].homeGym.name, 'Alpha Gym');
  assert.equal(out.entitlements.gymSubscriptions[0].productType, 'GYM_SUBSCRIPTION');
});

test('productTypeOfPayment: existing rows keep their meaning', () => {
  assert.equal(productTypeOfPayment({ bookingGroupId: 'g' }), PRODUCT_TYPES.TRAINER_SERVICE);
  assert.equal(productTypeOfPayment({ orderId: 'o' }), PRODUCT_TYPES.SHOP_ORDER);
  assert.equal(productTypeOfPayment({ subscriptionId: 's' }, { type: 'platform_pass' }), PRODUCT_TYPES.FITFLEX_PASS);
  assert.equal(productTypeOfPayment({ subscriptionId: 's' }, { type: 'direct_sub' }), PRODUCT_TYPES.GYM_SUBSCRIPTION);
  assert.equal(productTypeOfPayment({ subscriptionId: 's' }, { type: 'trainer_pass' }), PRODUCT_TYPES.TRAINER_GYM_PASS);
  assert.equal(productTypeOfPayment({ tier: 'pro' }), PRODUCT_TYPES.FITFLEX_PASS);
  assert.equal(productTypeOfPayment({ gymId: 'g', plan: 'daily' }), PRODUCT_TYPES.GYM_SUBSCRIPTION);
});

// ── Payment lifecycle ───────────────────────────────────────────────────────

function lifecycle() {
  const { service, subscriptions, paymentRequests } = setup();
  const activated = [];
  const webhook = createWebhookService({
    subscriptions, paymentRequests, webhookSeen: memStore(),
    onSubscriptionActivated: async (sub) => { activated.push(sub.id); },
  });
  const admin = createAdminPaymentService({
    paymentRequests, subscriptions, users: memStore(), auditLog: memStore(), gyms: [gymA],
    onSubscriptionActivated: async (sub) => { activated.push(sub.id); },
  });
  return { service, subscriptions, paymentRequests, webhook, admin, activated };
}

test('pending and rejected payments grant nothing; approval activates exactly the purchased product', async () => {
  const { service, subscriptions, paymentRequests, admin } = lifecycle();
  const pass = await service.subscribe({ memberId: 'u1', tier: 'pro' });
  const gym = await service.subscribe({ memberId: 'u1', type: 'direct_sub', homeGymId: 'gym_a', plan: 'monthly' });
  assert.deepEqual(subscriptions.rows.map(s => s.status), ['payment_pending', 'payment_pending']);

  await admin.decide({ id: gym.paymentRequest.id, decision: 'reject', actorId: 'adm' });
  assert.equal(subscriptions.rows.find(s => s.id === gym.subscription.id).status, 'payment_rejected');
  assert.equal(subscriptions.rows.find(s => s.id === pass.subscription.id).status, 'payment_pending');

  await admin.decide({ id: pass.paymentRequest.id, decision: 'approve', actorId: 'adm' });
  const rows = Object.fromEntries(subscriptions.rows.map(s => [s.type, s]));
  assert.equal(rows.platform_pass.status, 'active');
  assert.equal(rows.direct_sub.status, 'payment_rejected', 'paying for the pass never activates the gym plan');
  assert.equal(paymentRequests.rows.find(p => p.id === gym.paymentRequest.id).status, 'rejected');
});

test('webhook success activates once, settles the request and ignores replays', async () => {
  const { service, subscriptions, paymentRequests, webhook, admin, activated } = lifecycle();
  const out = await service.subscribe({ memberId: 'u1', type: 'direct_sub', homeGymId: 'gym_a', plan: 'daily' });
  const body = { payment_id: 'sel_1', status: 'success', subscription_id: out.subscription.id, amount: 5000 };
  assert.deepEqual(await webhook.handleSelcom(body), { ok: true });
  assert.deepEqual(await webhook.handleSelcom(body), { ok: true, idempotent: true });
  assert.equal(subscriptions.rows[0].status, 'active');
  assert.equal(paymentRequests.rows[0].status, 'approved');
  assert.equal(paymentRequests.rows[0].reference, 'sel_1');
  assert.deepEqual(activated, [out.subscription.id], 'activated once');
  // an admin cannot approve the already-settled request again
  assert.equal((await admin.decide({ id: out.paymentRequest.id, decision: 'approve', actorId: 'adm' })).error, 'already_decided');
});

test('webhook with the wrong amount does not activate and can be retried with the right one', async () => {
  const { service, subscriptions, webhook } = lifecycle();
  const out = await service.subscribe({ memberId: 'u1', tier: 'pro' });
  const wrong = await webhook.handleSelcom({ payment_id: 'sel_2', status: 'success', subscription_id: out.subscription.id, amount: 1000 });
  assert.equal(wrong.error, 'amount_mismatch');
  assert.equal(subscriptions.rows[0].status, 'payment_pending');
  assert.deepEqual(await webhook.handleSelcom({ payment_id: 'sel_2', status: 'success', subscription_id: out.subscription.id, amount: 120000 }), { ok: true });
  assert.equal(subscriptions.rows[0].status, 'active');
});

test('webhook failure leaves the subscription pending so the member can retry', async () => {
  const { service, subscriptions, paymentRequests, webhook } = lifecycle();
  const out = await service.subscribe({ memberId: 'u1', tier: 'basic' });
  await webhook.handleSelcom({ payment_id: 'sel_3', status: 'failed', subscription_id: out.subscription.id });
  assert.equal(subscriptions.rows[0].status, 'payment_pending');
  assert.equal(paymentRequests.rows[0].status, 'pending');
});

test('concurrent duplicate deliveries activate once', async () => {
  const { service, activated, webhook } = lifecycle();
  const out = await service.subscribe({ memberId: 'u1', tier: 'basic' });
  const body = { payment_id: 'sel_4', status: 'success', subscription_id: out.subscription.id };
  await Promise.all([webhook.handleSelcom(body), webhook.handleSelcom(body)]);
  assert.equal(activated.length, 1);
});

test('admin payment list labels every row with its product', async () => {
  const { service, admin } = lifecycle();
  await service.subscribe({ memberId: 'u1', tier: 'pro' });
  await service.subscribe({ memberId: 'u1', type: 'direct_sub', homeGymId: 'gym_a', plan: 'daily' });
  const list = await admin.list();
  assert.deepEqual(list.map(p => p.productType).sort(), ['FITFLEX_PASS', 'GYM_SUBSCRIPTION']);
});
