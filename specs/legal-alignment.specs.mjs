// Behaviour the revised legal documents (29 Sep 2026) promise:
//   - a paid plan's period starts when it is paid for, not when requested;
//   - passes are prepaid, and the renewal reminder says so;
//   - only FitFlex changes a gym's classification;
//   - a gym manages only its own direct members, and pauses their plan at
//     its gym rather than suspending their whole FitFlex account;
//   - a marketplace order is paid only once FitFlex confirms the payment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activationDates } from '../src/shared/subscription-status.mjs';
import { createAdminPaymentService } from '../src/services/admin-payment-service.mjs';
import { createWebhookService } from '../src/services/webhook-service.mjs';
import { createNotificationService } from '../src/services/notification-service.mjs';
import { createOwnerGymService } from '../src/services/owner-gym-service.mjs';
import { createGymService } from '../src/services/gym-service.mjs';
import { createMemberManagementService } from '../src/services/member-management-service.mjs';
import { createShopService } from '../src/services/shop-service.mjs';

function memStore(rows = []) {
  return {
    rows,
    find(fn) { return rows.find(fn) || null; },
    filter(fn) { return rows.filter(fn); },
    async allAsync() { return rows; },
    async filterAsync(fn) { return rows.filter(fn); },
    async findAsync(fn) { return rows.find(fn) || null; },
    async findByIdAsync(id) { return rows.find(r => r.id === id) || null; },
    async filterByColumnInAsync(col, ids) { return rows.filter(r => ids.includes(r[col])); },
    async insertAsync(row) { rows.push(row); return row; },
    async upsertAsync(fn, row) {
      const i = rows.findIndex(fn);
      if (i >= 0) rows[i] = { ...rows[i], ...row }; else rows.push(row);
      return row;
    },
    async updateByIdAsync(id, patch) {
      const i = rows.findIndex(r => r.id === id);
      if (i >= 0) rows[i] = { ...rows[i], ...patch };
      return rows[i] || null;
    },
  };
}
const audit = { insert() {}, async insertAsync() {} };
const DAY = 86_400_000;

// ── Plan periods start at payment ───────────────────────────────────────────

test('a plan\'s period starts when it is paid for and keeps its length', () => {
  const requested = new Date('2026-09-01T08:00:00Z');
  const sub = { status: 'payment_pending', startedAt: requested.toISOString(), expiresAt: new Date(+requested + 30 * DAY).toISOString() };
  const paidAt = new Date('2026-09-03T10:00:00Z');
  assert.deepEqual(activationDates(sub, paidAt), {
    startedAt: paidAt.toISOString(), cycleStartedAt: paidAt.toISOString(),
    renewsAt: new Date(+paidAt + 30 * DAY).toISOString(), expiresAt: new Date(+paidAt + 30 * DAY).toISOString(),
  });
  assert.deepEqual(activationDates({ ...sub, status: 'active' }, paidAt), {}, 'an active plan keeps its dates');
});

test('approving a Pass payment, or a Selcom confirmation, starts the 30 days then', async () => {
  const requested = new Date(Date.now() - 2 * DAY);
  const pending = id => ({ id, memberId: 'm1', type: 'platform_pass', tier: 'pro', status: 'payment_pending',
    startedAt: requested.toISOString(), cycleStartedAt: requested.toISOString(),
    renewsAt: new Date(+requested + 30 * DAY).toISOString(), expiresAt: new Date(+requested + 30 * DAY).toISOString() });
  const subscriptions = memStore([pending('sub_a'), pending('sub_b')]);
  const paymentRequests = memStore([{ id: 'pay_a', memberId: 'm1', subscriptionId: 'sub_a', status: 'pending', amountTzs: 150000 }]);

  const admin = createAdminPaymentService({ paymentRequests, subscriptions, users: memStore(), auditLog: audit });
  await admin.decide({ id: 'pay_a', decision: 'approve', actorId: 'adm' });
  const a = await subscriptions.findByIdAsync('sub_a');
  assert.equal(a.status, 'active');
  assert.ok(Date.now() - +new Date(a.startedAt) < 60_000, 'starts at approval');
  assert.equal(+new Date(a.expiresAt) - +new Date(a.startedAt), 30 * DAY);

  const webhook = createWebhookService({ subscriptions, webhookSeen: memStore() });
  await webhook.handleSelcom({ payment_id: 'sel_1', status: 'success', subscription_id: 'sub_b' });
  const b = await subscriptions.findByIdAsync('sub_b');
  assert.equal(b.status, 'active');
  assert.ok(Date.now() - +new Date(b.startedAt) < 60_000);
});

test('the renewal reminder says the pass ends and is renewed by paying, not that it renews', async () => {
  const notifications = memStore();
  const svc = createNotificationService({ users: memStore([{ id: 'm1' }]), deviceTokens: memStore(), notifications, logger: { warn() {}, error() {}, log() {} } });
  await svc.notifyRenewal({ id: 'sub_r', memberId: 'm1', tier: 'basic', renewsAt: new Date().toISOString() }, 1);
  const n = notifications.rows[0];
  assert.equal(n.title, 'Your Basic pass ends tomorrow');
  assert.match(n.body, /renew it from the Passes screen/);
  assert.doesNotMatch(`${n.title} ${n.body}`, /cancel|renews/);
});

// ── Gym classification ──────────────────────────────────────────────────────

test('an owner can propose a tier for a new gym but never change it afterwards', async () => {
  const gyms = memStore();
  const users = memStore([{ id: 'own1', userType: 'gym_operator', gymIds: [] }]);
  const gymService = createGymService({ gyms, users, checkins: memStore(), auditLog: audit });
  const svc = createOwnerGymService({ gyms, users, trainers: memStore(), invoices: memStore(), auditLog: audit, gymService, trainerService: {} });
  const owner = users.rows[0];

  const created = await svc.createGym({ owner, body: { name: 'Kilimani Fit', tier: 'premium', location: 'Sinza' } });
  assert.equal(created.gym?.tier ?? gyms.rows[0].tier, 'premium');
  const gymId = gyms.rows[0].id;

  const out = await svc.updateGym({ owner: { ...owner, gymIds: [gymId] }, gymId, body: { name: 'Kilimani Fitness', tier: 'luxury_executive' } });
  assert.equal(out.gym.name, 'Kilimani Fitness');
  assert.equal(out.gym.tier, 'premium');
});

// ── Owners and members ──────────────────────────────────────────────────────

function memberFixture() {
  const now = Date.now();
  const users = memStore([
    { id: 'direct', displayName: 'Desk Member', phone: '0754000001', userType: 'member', accountStatus: 'active', firebaseUid: null },
    { id: 'direct_app', displayName: 'App Member', phone: '0754000002', userType: 'member', accountStatus: 'active', firebaseUid: 'fb_1' },
    { id: 'pass', displayName: 'Pass Member', phone: '0754000003', userType: 'member', accountStatus: 'active', firebaseUid: 'fb_2' },
  ]);
  const plan = (id, memberId) => ({ id, memberId, type: 'direct_sub', homeGymId: 'gym_1', status: 'active', tier: 'basic',
    startedAt: new Date(now - 5 * DAY).toISOString(), cycleStartedAt: new Date(now - 5 * DAY).toISOString(),
    expiresAt: new Date(now + 25 * DAY).toISOString(), renewsAt: new Date(now + 25 * DAY).toISOString() });
  const subscriptions = memStore([plan('sub_d', 'direct'), plan('sub_da', 'direct_app'),
    { id: 'sub_p', memberId: 'pass', type: 'platform_pass', tier: 'pro', status: 'active', startedAt: new Date(now - DAY).toISOString(), expiresAt: new Date(now + 29 * DAY).toISOString() }]);
  const checkins = memStore([{ id: 'c1', memberId: 'pass', gymId: 'gym_1', timestamp: new Date(now - DAY).toISOString() }]);
  const svc = createMemberManagementService({
    users, gyms: memStore([{ id: 'gym_1', name: 'Gym One', tier: 'standard' }]), subscriptions, checkins,
    paymentRequests: memStore(), publicUserId: u => u.id,
  });
  return { svc, users, subscriptions, owner: { id: 'own1', gymIds: ['gym_1'] } };
}

test('a gym pauses its own member\'s plan, never their FitFlex account, and cannot touch Pass members', async () => {
  const { svc, users, subscriptions, owner } = memberFixture();

  const paused = await svc.setMemberStatus({ owner, memberId: 'direct', suspend: true });
  assert.equal(paused.member.membershipStatus, 'suspended');
  assert.equal((await subscriptions.findByIdAsync('sub_d')).status, 'suspended');
  assert.equal((await users.findByIdAsync('direct')).accountStatus, 'active', 'the account itself stays active');

  const resumed = await svc.setMemberStatus({ owner, memberId: 'direct', suspend: false });
  assert.equal(resumed.member.membershipStatus, 'active');

  // A Pass member who only checked in here is not the gym's to suspend or edit.
  assert.deepEqual(await svc.setMemberStatus({ owner, memberId: 'pass', suspend: true }), { error: 'direct_membership_required', status: 409 });
  assert.deepEqual(await svc.updateMember({ owner, memberId: 'pass', body: { displayName: 'Changed' } }), { error: 'direct_membership_required', status: 409 });
  assert.equal((await users.findByIdAsync('pass')).accountStatus, 'active');
  assert.equal((await users.findByIdAsync('pass')).displayName, 'Pass Member');
});

test('a gym edits contact details only for desk members without their own sign-in', async () => {
  const { svc, users, owner } = memberFixture();
  const ok = await svc.updateMember({ owner, memberId: 'direct', body: { displayName: 'Desk Member Two', phone: '0754999999' } });
  assert.equal(ok.member.displayName, 'Desk Member Two');
  assert.deepEqual(await svc.updateMember({ owner, memberId: 'direct_app', body: { displayName: 'Changed' } }), { error: 'member_manages_own_details', status: 409 });
  assert.equal((await users.findByIdAsync('direct_app')).displayName, 'App Member');
});

test('renewing a member at the gym does not lift a FitFlex account suspension', async () => {
  const { svc, users, owner } = memberFixture();
  await users.updateByIdAsync('direct', { accountStatus: 'suspended' });
  const out = await svc.renewMember({ owner, memberId: 'direct', body: { startDate: '2026-10-01', endDate: '2026-10-31' } });
  assert.equal(out.subscription.status, 'active');
  assert.equal((await users.findByIdAsync('direct')).accountStatus, 'suspended');
});

// ── Marketplace payments ────────────────────────────────────────────────────

function shopFixture() {
  const products = memStore([{ id: 'prd_1', vendorId: 'ven_1', name: 'Whey', priceTzs: 50000, stock: 5, status: 'active', approvalStatus: 'approved' }]);
  const shopOrders = memStore();
  const paymentRequests = memStore();
  const marketplaceNotifications = memStore();
  const service = createShopService({ products, shopOrders, users: memStore(), auditLog: audit, paymentRequests, marketplaceNotifications });
  const checkout = { items: [{ productId: 'prd_1', qty: 2 }], deliveryMethod: 'home_delivery', deliveryAddress: 'Sinza', paymentMethod: 'mpesa', paymentOutcome: 'success' };
  return { service, products, shopOrders, paymentRequests, marketplaceNotifications, checkout };
}

test('an order waits for FitFlex to confirm payment; the app saying "success" is not enough', async () => {
  const { service, products, paymentRequests, marketplaceNotifications, checkout } = shopFixture();
  const placed = await service.createOrder({ buyerId: 'm1', body: checkout });
  assert.equal(placed.status, 202);
  assert.equal(placed.order.paymentStatus, 'pending');
  assert.deepEqual([placed.paymentRequest.orderId, placed.paymentRequest.amountTzs, placed.paymentRequest.status], [placed.order.id, 100000, 'pending']);
  assert.equal((await products.findByIdAsync('prd_1')).stock, 3, 'stock is reserved');
  assert.equal(marketplaceNotifications.rows.filter(n => n.userId === 'ven_1').length, 0, 'the vendor hears nothing yet');

  // The vendor can't start fulfilling an unpaid order.
  assert.deepEqual(await service.updateOrderStatus({ orderId: placed.order.id, status: 'accepted', actorId: 'ven_1' }), { error: 'order_not_paid', status: 409 });

  // Admin approval of the payment request pays the order.
  const admin = createAdminPaymentService({ paymentRequests, subscriptions: memStore(), users: memStore(), auditLog: audit,
    onOrderPayment: (orderId, status) => service.applyPaymentToOrder(orderId, status) });
  await admin.decide({ id: placed.paymentRequest.id, decision: 'approve', actorId: 'adm' });
  const paid = (await service.myOrders('m1'))[0];
  assert.equal(paid.paymentStatus, 'paid');
  assert.equal(marketplaceNotifications.rows.filter(n => n.userId === 'ven_1').length, 1);
  assert.ok(!(await service.updateOrderStatus({ orderId: paid.id, status: 'accepted', actorId: 'ven_1' })).error);
});

test('a rejected payment cancels the order and releases its stock; a vendor cancelling withdraws the payment request', async () => {
  const { service, products, paymentRequests, checkout } = shopFixture();
  const first = await service.createOrder({ buyerId: 'm1', body: checkout });
  await service.applyPaymentToOrder(first.order.id, 'rejected');
  const rejected = (await service.myOrders('m1')).find(o => o.id === first.order.id);
  assert.deepEqual([rejected.status, rejected.paymentStatus], ['cancelled', 'failed']);
  assert.equal((await products.findByIdAsync('prd_1')).stock, 5);

  const second = await service.createOrder({ buyerId: 'm1', body: checkout });
  await service.updateOrderStatus({ orderId: second.order.id, status: 'cancelled', actorId: 'ven_1' });
  assert.equal((await paymentRequests.findByIdAsync(second.paymentRequest.id)).status, 'cancelled');
  assert.equal((await products.findByIdAsync('prd_1')).stock, 5);
  // A late approval of a cancelled order does not revive it.
  await service.applyPaymentToOrder(second.order.id, 'approved');
  assert.equal((await service.myOrders('m1')).find(o => o.id === second.order.id).status, 'cancelled');
});
