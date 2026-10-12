// FitFlex Pass upgrade: a member on a pass pays the difference in price — not
// the full price, not reduced for days left — and the old plan is retired when
// the upgrade payment is approved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSubscriptionService } from '../src/services/subscription-service.mjs';
import { createAdminPaymentService } from '../src/services/admin-payment-service.mjs';
import { upgradeDifference, upgradedFromOf, isSponsoredPassId } from '../src/shared/pass-upgrade.mjs';

function memStore(rows = []) {
  return {
    rows,
    async filterAsync(fn) { return rows.filter(fn); },
    async findAsync(fn) { return rows.find(fn) || null; },
    async findByIdAsync(id) { return rows.find((r) => r.id === id) || null; },
    async allAsync() { return [...rows]; },
    async insertAsync(row) { rows.push(row); return row; },
    async updateByIdAsync(id, patch) {
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows[i] = { ...rows[i], ...patch };
      return rows[i] || null;
    },
  };
}

const PRICES = { online_free: 0, basic: 60_000, pro: 120_000, premium: 200_000, executive: 350_000 };
const tiers = Object.entries(PRICES).map(([key, monthlyPrice]) => ({ key, label: key, monthlyPrice, visits: 20, gymAccess: ['standard'] }));
const DAY = 86_400_000;

function setup(subs = []) {
  const subscriptions = memStore(subs);
  const paymentRequests = memStore();
  const service = createSubscriptionService({
    subscriptions, paymentRequests, checkins: memStore(), gyms: [],
    settingsService: { priceForTier: (t) => PRICES[t] ?? 0, visitCapForTier: () => null, publicTiers: () => tiers },
    publicUserId: async () => 'FF-1',
  });
  const admin = createAdminPaymentService({
    paymentRequests, subscriptions, users: memStore(), auditLog: { async insertAsync() {} },
  });
  return { subscriptions, paymentRequests, service, admin };
}

const active = (over = {}) => ({
  id: 'sub_old', memberId: 'm1', type: 'platform_pass', tier: 'basic', status: 'active',
  startedAt: new Date(Date.now() - 25 * DAY).toISOString(), cycleStartedAt: new Date(Date.now() - 25 * DAY).toISOString(),
  expiresAt: new Date(Date.now() + 5 * DAY).toISOString(), renewsAt: new Date(Date.now() + 5 * DAY).toISOString(), ...over,
});

test('pure rules: difference, note round trip, sponsored ids', () => {
  assert.equal(upgradeDifference(60_000, 120_000), 60_000);
  assert.equal(upgradeDifference(120_000, 120_000), null);
  assert.equal(upgradeDifference(200_000, 120_000), null);
  assert.equal(upgradedFromOf({ note: 'upgrade:sub_1' }), 'sub_1');
  assert.equal(upgradedFromOf({ note: 'trainer_pass' }), null);
  assert.equal(isSponsoredPassId('sub_b2be_x'), true);
  assert.equal(isSponsoredPassId('sub_ab12'), false);
});

test('the member pays only the difference, whatever is left of the current plan', async () => {
  for (const daysLeft of [29, 5, 1]) {
    const { service } = setup([active({ expiresAt: new Date(Date.now() + daysLeft * DAY).toISOString() })]);
    const out = await service.upgradePass({ memberId: 'm1', tier: 'pro' });
    assert.equal(out.status, 202);
    assert.equal(out.paymentRequest.amountTzs, 60_000, `${daysLeft} days left`);
    assert.equal(out.subscription.status, 'payment_pending');
    assert.equal(out.subscription.tier, 'pro');
  }
});

test('options list only higher tiers with their difference; the current plan keeps working while pending', async () => {
  const { service, subscriptions } = setup([active({ tier: 'pro' })]);
  const opts = await service.upgradeOptions('m1');
  assert.deepEqual(opts.options.map((o) => [o.tier, o.differenceTzs]), [['premium', 80_000], ['executive', 230_000]]);
  assert.equal(opts.current.tier, 'pro');
  await service.upgradePass({ memberId: 'm1', tier: 'premium' });
  assert.equal(subscriptions.rows.find((s) => s.id === 'sub_old').status, 'active');
});

test('not an upgrade, nothing to upgrade, sponsored, or one already pending are refused', async () => {
  const { service } = setup([active({ tier: 'pro' })]);
  assert.equal((await service.upgradePass({ memberId: 'm1', tier: 'basic' })).error, 'not_an_upgrade');
  assert.equal((await service.upgradePass({ memberId: 'm1', tier: 'pro' })).error, 'not_an_upgrade');
  assert.equal((await service.upgradePass({ memberId: 'm1', tier: 'nope' })).error, 'invalid_tier');
  assert.equal((await service.upgradePass({ memberId: 'm1', tier: 'online_free' })).error, 'invalid_tier');
  assert.equal((await service.upgradePass({ memberId: 'm1', tier: 'premium' })).status, 202);
  assert.equal((await service.upgradePass({ memberId: 'm1', tier: 'executive' })).error, 'payment_already_pending');

  assert.equal((await setup().service.upgradePass({ memberId: 'm1', tier: 'pro' })).error, 'no_active_pass');
  const expired = setup([active({ expiresAt: new Date(Date.now() - DAY).toISOString() })]);
  assert.equal((await expired.service.upgradePass({ memberId: 'm1', tier: 'pro' })).error, 'no_active_pass');
  const sponsored = setup([active({ id: 'sub_b2be_1' })]);
  assert.equal((await sponsored.service.upgradePass({ memberId: 'm1', tier: 'pro' })).error, 'sponsored_pass');
  const free = setup([active({ tier: 'online_free' })]);
  assert.equal((await free.service.upgradePass({ memberId: 'm1', tier: 'pro' })).error, 'no_paid_pass');
});

test('approving the upgrade starts the new tier and retires the old plan; rejecting leaves it alone', async () => {
  const a = setup([active()]);
  const out = await a.service.upgradePass({ memberId: 'm1', tier: 'pro' });
  await a.admin.decide({ id: out.paymentRequest.id, decision: 'approve', actorId: 'admin' });
  const byId = (s, id) => s.rows.find((r) => r.id === id);
  assert.equal(byId(a.subscriptions, out.subscription.id).status, 'active');
  assert.equal(byId(a.subscriptions, 'sub_old').status, 'upgraded');
  // the new tier runs a fresh 30 days from approval
  const left = +new Date(byId(a.subscriptions, out.subscription.id).expiresAt) - Date.now();
  assert.ok(left > 29 * DAY && left <= 30 * DAY);

  const b = setup([active()]);
  const out2 = await b.service.upgradePass({ memberId: 'm1', tier: 'pro' });
  await b.admin.decide({ id: out2.paymentRequest.id, decision: 'reject', actorId: 'admin' });
  assert.equal(byId(b.subscriptions, 'sub_old').status, 'active');
  // and after a rejection the member can ask again
  assert.equal((await b.service.upgradePass({ memberId: 'm1', tier: 'pro' })).status, 202);
});
