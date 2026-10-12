// FitFlex Pass upgrade: a member on a pass pays the difference in price — not
// the full price, not reduced for days left — and the plan is upgraded IN PLACE
// when the payment is approved: same end date, same visits, only the tier changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSubscriptionService } from '../src/services/subscription-service.mjs';
import { createAdminPaymentService } from '../src/services/admin-payment-service.mjs';
import { upgradeDifference, upgradeOf, upgradeNote, isSponsoredPassId } from '../src/shared/pass-upgrade.mjs';

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
  assert.deepEqual(upgradeOf({ note: upgradeNote('sub_1', 'basic') }), { subscriptionId: 'sub_1', fromTier: 'basic' });
  assert.equal(upgradeOf({ note: 'trainer_pass' }), null);
  assert.equal(isSponsoredPassId('sub_b2be_x'), true);
  assert.equal(isSponsoredPassId('sub_ab12'), false);
});

test('the member pays only the difference, whatever is left of the current plan', async () => {
  for (const daysLeft of [29, 5, 1]) {
    const { service } = setup([active({ expiresAt: new Date(Date.now() + daysLeft * DAY).toISOString() })]);
    const out = await service.upgradePass({ memberId: 'm1', tier: 'pro' });
    assert.equal(out.status, 202);
    assert.equal(out.paymentRequest.amountTzs, 60_000, `${daysLeft} days left`);
    assert.equal(out.paymentRequest.tier, 'pro');
  }
});

test('options list only higher tiers with their difference; the current plan keeps working while pending', async () => {
  const { service, subscriptions } = setup([active({ tier: 'pro' })]);
  const opts = await service.upgradeOptions('m1');
  assert.deepEqual(opts.options.map((o) => [o.tier, o.differenceTzs]), [['premium', 80_000], ['executive', 230_000]]);
  assert.equal(opts.current.tier, 'pro');
  await service.upgradePass({ memberId: 'm1', tier: 'premium' });
  // the plan keeps working as it is while the payment waits, and no second plan is created
  assert.equal(subscriptions.rows.length, 1);
  assert.equal(subscriptions.rows[0].tier, 'pro');
  assert.equal(subscriptions.rows[0].status, 'active');
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

test('approving upgrades the plan in place: same row, end date and cycle; only the tier changes', async () => {
  const before = active();
  const a = setup([before]);
  const out = await a.service.upgradePass({ memberId: 'm1', tier: 'pro' });
  assert.equal(out.endsAt, before.expiresAt);
  assert.equal(out.paymentRequest.subscriptionId, 'sub_old', 'the money counts toward the plan it upgrades');
  await a.admin.decide({ id: out.paymentRequest.id, decision: 'approve', actorId: 'admin' });
  assert.equal(a.subscriptions.rows.length, 1);
  const sub = a.subscriptions.rows[0];
  assert.equal(sub.id, 'sub_old');
  assert.equal(sub.tier, 'pro');
  assert.equal(sub.status, 'active');
  assert.equal(sub.expiresAt, before.expiresAt, 'an upgrade never lengthens a plan');
  assert.equal(sub.cycleStartedAt, before.cycleStartedAt, 'visits already used still count');
  assert.equal(sub.startedAt, before.startedAt);
});

test('the member is told, and the decision can be taken back', async () => {
  const told = [];
  const subscriptions = memStore([active()]);
  const paymentRequests = memStore();
  const service = createSubscriptionService({
    subscriptions, paymentRequests, checkins: memStore(), gyms: [],
    settingsService: { priceForTier: (t) => PRICES[t] ?? 0, visitCapForTier: () => null, publicTiers: () => tiers },
    publicUserId: async () => 'FF-1',
  });
  const admin = createAdminPaymentService({
    paymentRequests, subscriptions, users: memStore(), auditLog: { async insertAsync() {} },
    onPassUpgraded: async (sub) => { told.push(sub.tier); },
  });
  const { paymentRequest } = await service.upgradePass({ memberId: 'm1', tier: 'premium' });
  await admin.decide({ id: paymentRequest.id, decision: 'approve', actorId: 'admin' });
  assert.deepEqual(told, ['premium']);
  assert.equal(subscriptions.rows[0].tier, 'premium');
  // approved by mistake: putting it back to pending gives the old tier back
  await admin.update({ id: paymentRequest.id, status: 'pending', actorId: 'admin' });
  assert.equal(subscriptions.rows[0].tier, 'basic');
  assert.equal(upgradeOf(paymentRequests.rows[0])?.subscriptionId, 'sub_old', 'the note still names the plan');
});

test('rejecting leaves the plan alone and the member can ask again', async () => {
  const b = setup([active()]);
  const out = await b.service.upgradePass({ memberId: 'm1', tier: 'pro' });
  await b.admin.decide({ id: out.paymentRequest.id, decision: 'reject', actorId: 'admin' });
  assert.equal(b.subscriptions.rows[0].tier, 'basic');
  assert.equal(b.subscriptions.rows[0].status, 'active');
  assert.equal((await b.service.upgradePass({ memberId: 'm1', tier: 'pro' })).status, 202);
});

test('a plan that ended before approval cannot be upgraded', async () => {
  const c = setup([active()]);
  const out = await c.service.upgradePass({ memberId: 'm1', tier: 'pro' });
  c.subscriptions.rows[0].expiresAt = new Date(Date.now() - DAY).toISOString();
  const res = await c.admin.decide({ id: out.paymentRequest.id, decision: 'approve', actorId: 'admin' });
  assert.equal(res.error, 'upgrade_plan_not_active');
  assert.equal(c.paymentRequests.rows[0].status, 'pending');
  assert.equal(c.subscriptions.rows[0].tier, 'basic');
});

test('while an upgrade waits, a second one or a new pass purchase is refused', async () => {
  const { service } = setup([active()]);
  await service.upgradePass({ memberId: 'm1', tier: 'pro' });
  assert.equal((await service.upgradePass({ memberId: 'm1', tier: 'premium' })).error, 'payment_already_pending');
  assert.equal((await service.subscribe({ memberId: 'm1', tier: 'executive' })).error, 'payment_already_pending');
});
