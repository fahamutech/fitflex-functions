// The admin Members list says what plan a member's account runs on and which payment
// requests are open, separately: an old open request for one product must not make a
// member with a running, paid pass look unpaid (found on a live account 2026-11-25).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdminMemberService } from '../src/services/admin-member-service.mjs';

const DAY = 86_400_000;
const at = (days) => new Date(Date.now() + days * DAY).toISOString();

function store(rows = []) {
  return {
    rows,
    async filterByColumnAsync(col, value) { return rows.filter((r) => r[col] === value); },
    async filterByColumnInAsync(col, values) { return rows.filter((r) => values.includes(r[col])); },
  };
}

function service({ subs = [], pays = [] } = {}) {
  const users = store([
    { id: 'm1', userType: 'member', displayName: 'Member One', createdAt: at(-60) },
    { id: 'm2', userType: 'member', displayName: 'Member Two', createdAt: at(-60) },
  ]);
  return createAdminMemberService({ users, subscriptions: store(subs), paymentRequests: store(pays), checkins: store(), gyms: [], auditLog: store() });
}

const pass = { id: 'sub_pass', memberId: 'm1', type: 'platform_pass', tier: 'executive', status: 'active', startedAt: at(-23), expiresAt: at(7) };
const dayPlanEnded = { id: 'sub_day', memberId: 'm1', type: 'direct_sub', plan: 'daily', homeGymId: 'g1', status: 'active', startedAt: at(-9), expiresAt: at(-8) };
const renewal = { id: 'sub_next', memberId: 'm1', type: 'platform_pass', tier: 'basic', status: 'scheduled', startedAt: at(7), expiresAt: at(37) };
const unpaidDay = { id: 'sub_unpaid', memberId: 'm1', type: 'direct_sub', plan: 'daily', homeGymId: 'g2', status: 'payment_pending', startedAt: at(-8), expiresAt: at(-7) };

test('members list: running pass, waiting renewal and open requests are reported separately', async () => {
  const svc = service({
    subs: [pass, dayPlanEnded, renewal, unpaidDay],
    pays: [
      { id: 'pay_gym', memberId: 'm1', subscriptionId: 'sub_unpaid', gymId: 'g2', plan: 'daily', amountTzs: 10_000, status: 'pending', requestedAt: at(-8) },
      { id: 'pay_shop', memberId: 'm1', orderId: 'ord_1', amountTzs: 4_500, status: 'pending', requestedAt: at(0) },
      { id: 'pay_done', memberId: 'm1', subscriptionId: 'sub_next', tier: 'basic', amountTzs: 60_000, status: 'approved', requestedAt: at(0) },
    ],
  });
  const [m1, m2] = await svc.list();
  assert.deepEqual(m1.currentPlan, { id: 'sub_pass', tier: 'executive', type: 'platform_pass', plan: null, status: 'active', expiresAt: pass.expiresAt });
  assert.deepEqual(m1.scheduledPlan, { id: 'sub_next', tier: 'basic', type: 'platform_pass', plan: null, startsAt: renewal.startedAt });
  assert.deepEqual(m1.openPayments.map((p) => [p.id, p.productType, p.amountTzs]), [['pay_shop', 'SHOP_ORDER', 4_500], ['pay_gym', 'GYM_SUBSCRIPTION', 10_000]]);
  // unchanged fields, for portal builds that do not know the new ones
  assert.equal(m1.pendingPayment.id, 'pay_shop');
  assert.equal(m1.subscription.id, 'sub_next');
  assert.deepEqual([m2.currentPlan, m2.scheduledPlan, m2.openPayments, m2.pendingPayment, m2.subscription], [null, null, [], null, null]);
});

test('members list: an ended plan is reported as expired whatever its stored status; an unpaid plan is never the current one', async () => {
  let [m1] = await service({ subs: [dayPlanEnded] }).list();
  assert.deepEqual([m1.currentPlan.id, m1.currentPlan.status], ['sub_day', 'expired']);
  [m1] = await service({ subs: [unpaidDay] }).list();
  assert.equal(m1.currentPlan, null);
  [m1] = await service({ subs: [{ ...pass, status: 'suspended' }] }).list();
  assert.equal(m1.currentPlan.status, 'suspended');
});
