// What gym owners, staff and vendors are told about their gym or shop, and
// that telling them can never break the thing being reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPartnerNotifier } from '../src/services/partner-notifier.mjs';
import { createShopService } from '../src/services/shop-service.mjs';

function store(rows = []) {
  return {
    rows,
    async filterAsync(pred) { return rows.filter(pred); },
    async filterByColumnAsync(col, v) { return rows.filter(r => r[col] === v); },
    async findByIdAsync(id) { return rows.find(r => r.id === id) ?? null; },
    async insertAsync(row) { rows.push(row); return row; },
  };
}

const NOW = new Date('2026-10-12T09:00:00.000Z');
function setup({ notify } = {}) {
  const sent = [];
  const s = {
    sent,
    users: store([
      { id: 'owner_1', userType: 'gym_operator', gymIds: ['g1', 'g2'] },
      { id: 'staff_1', userType: 'gym_staff', gymId: 'g1' },
      { id: 'staff_gone', userType: 'gym_staff', gymId: 'g1', accountStatus: 'suspended' },
      { id: 'owner_other', userType: 'gym_operator', gymIds: ['g9'] },
      { id: 'm1', userType: 'member', displayName: 'Asha', gymId: 'g1' },
      { id: 'v1', userType: 'vendor' },
    ]),
    gyms: store([{ id: 'g1', name: 'Kilimanjaro Fitness' }, { id: 'g2', name: 'Second Gym' }]),
    subscriptions: store(),
    payments: store(),
    preferences: store(),
  };
  s.notifier = createPartnerNotifier({
    users: s.users, gyms: s.gyms, subscriptions: s.subscriptions, paymentRequests: s.payments, preferences: s.preferences, now: () => NOW, logger: { warn() {} },
    notify: notify ?? (async (userId, m) => { sent.push({ userId, ...m }); }),
  });
  s.to = type => sent.filter(m => m.type === type).map(m => m.userId).sort();
  return s;
}

test('a gym\'s people are its owner and staff — not members, other gyms, or suspended staff', async () => {
  const s = setup();
  assert.deepEqual((await s.notifier.gymPeople('g1')).sort(), ['owner_1', 'staff_1']);
  assert.deepEqual(await s.notifier.gymPeople('g1', { ownersOnly: true }), ['owner_1']);
  assert.deepEqual(await s.notifier.gymPeople('g2'), ['owner_1']);
  assert.deepEqual(await s.notifier.gymPeople('g_nobody'), []);
});

test('a check-in tells the gym, once per visit and person, with what a phone needs to open it', async () => {
  const s = setup();
  const checkin = { id: 'chk-1', gymId: 'g1', memberId: 'm1' };
  await s.notifier.gymCheckin(checkin);
  assert.deepEqual(s.to('gym_checkin'), ['owner_1', 'staff_1']);
  const m = s.sent[0];
  assert.equal(m.body, 'Asha checked in at Kilimanjaro Fitness.');
  assert.deepEqual(m.data, { gymId: 'g1', memberId: 'm1', checkinId: 'chk-1' });
  // Each person has their own copy of the same visit, so a repeat is recognised.
  const ids = s.sent.map(x => x.id);
  assert.equal(new Set(ids).size, 2);
  await s.notifier.gymCheckin(checkin);
  assert.deepEqual(s.sent.slice(2).map(x => x.id), ids, 'the same ids again: the notification service drops them');
  await s.notifier.gymCheckin({ id: 'x', memberId: 'm1' });
  assert.equal(s.sent.length, 4, 'no gym, nothing sent');
});

test('a first membership is news for the gym; a renewal is a payment notice for the owner', async () => {
  const s = setup();
  const fresh = { id: 'sub_1', memberId: 'm1', homeGymId: 'g1', type: 'direct_sub', createdAt: '2026-10-12T08:59:00.000Z', renewsAt: '2026-11-12T08:59:00.000Z' };
  s.subscriptions.rows.push(fresh);
  await s.notifier.gymMemberJoined(fresh);
  assert.deepEqual(s.to('gym_member_joined'), ['owner_1', 'staff_1']);
  assert.equal(s.sent[0].body, 'Asha now has a membership at Kilimanjaro Fitness.');
  assert.equal(s.sent[0].data.memberId, 'm1');
  assert.deepEqual(s.to('gym_membership_renewed'), [], 'a first membership is not a renewal');

  s.sent.length = 0;
  // The same membership, renewed weeks later and paid for an hour ago.
  const renewed = { ...fresh, createdAt: '2026-09-01T08:00:00.000Z', renewsAt: '2026-12-12T08:59:00.000Z' };
  s.payments.rows.push(
    { id: 'pay_old', subscriptionId: 'sub_1', status: 'approved', amountTzs: 50000, decidedAt: '2026-09-01T08:00:00.000Z' },
    { id: 'pay_new', subscriptionId: 'sub_1', status: 'approved', amountTzs: 60000, decidedAt: '2026-10-12T08:00:00.000Z' },
    { id: 'pay_wait', subscriptionId: 'sub_1', status: 'pending', amountTzs: 99999, decidedAt: '2026-10-12T08:30:00.000Z' },
  );
  await s.notifier.gymMemberJoined(renewed);
  assert.deepEqual(s.to('gym_membership_renewed'), ['owner_1'], 'money: the owner only');
  assert.deepEqual(s.to('gym_member_joined'), []);
  assert.equal(s.sent[0].title, 'Membership renewed');
  assert.equal(s.sent[0].body, 'Asha renewed at Kilimanjaro Fitness and paid TSh 60,000. It now runs to 2026-12-12.');
  assert.deepEqual(s.sent[0].data, { gymId: 'g1', memberId: 'm1', subscriptionId: 'sub_1', amountTzs: 60000 });

  // Reported twice for the same period: the same id, so it is told once.
  await s.notifier.gymMemberJoined(renewed);
  assert.equal(s.sent[1].id, s.sent[0].id);
  // The next period is a new notice.
  await s.notifier.gymMemberJoined({ ...renewed, renewsAt: '2027-01-12T08:59:00.000Z' });
  assert.notEqual(s.sent[2].id, s.sent[0].id);

  s.sent.length = 0;
  // Someone who was a member before and comes back counts as a renewal too.
  const again = { id: 'sub_2', memberId: 'm1', homeGymId: 'g1', type: 'direct_sub', createdAt: '2026-10-12T08:59:30.000Z', expiresAt: '2026-11-12T00:00:00.000Z' };
  s.subscriptions.rows.push(again);
  await s.notifier.gymMemberJoined(again);
  assert.deepEqual(s.sent.map(m => m.type), ['gym_membership_renewed']);
  assert.equal(s.sent[0].body, 'Asha renewed at Kilimanjaro Fitness. It now runs to 2026-11-12.', 'no payment on record: no amount');

  s.sent.length = 0;
  // A FitFlex pass is not a membership of any one gym.
  await s.notifier.gymMemberJoined({ id: 'sub_3', memberId: 'm1', homeGymId: 'g1', type: 'pass', createdAt: NOW.toISOString() });
  assert.deepEqual(s.sent, []);
});

test('each person can switch check-in alerts off for themselves — and only those', async () => {
  const s = setup();
  s.preferences.rows.push({ id: 'owner_1', gymCheckinAlerts: false }, { id: 'staff_1', gymCheckinAlerts: null });
  await s.notifier.gymCheckin({ id: 'chk-1', gymId: 'g1', memberId: 'm1' });
  assert.deepEqual(s.to('gym_checkin'), ['staff_1'], 'the owner switched them off; staff did not');

  // Everything else still reaches the owner.
  await s.notifier.gymReview({ id: 'rev-1', gymId: 'g1', memberId: 'm1', rating: 5 });
  await s.notifier.gymStatement({ id: 'stl-1', gymId: 'g1', periodStartDate: 'a', periodEndDate: 'b', finalNetTzs: 1 }, 'paid');
  assert.ok(s.to('gym_review').includes('owner_1'));
  assert.deepEqual(s.to('gym_payout_paid'), ['owner_1']);

  // Switched back on.
  s.preferences.rows[0].gymCheckinAlerts = true;
  await s.notifier.gymCheckin({ id: 'chk-2', gymId: 'g1', memberId: 'm1' });
  assert.deepEqual(s.sent.filter(m => m.data.checkinId === 'chk-2').map(m => m.userId).sort(), ['owner_1', 'staff_1']);
});

test('a trainer\'s request and money matters go to the owner only', async () => {
  const s = setup();
  await s.notifier.gymTrainerRequest({ gymId: 'g1', trainer: { id: 't1', displayName: 'Coach Amani' } });
  assert.deepEqual(s.to('gym_trainer_request'), ['owner_1']);
  assert.equal(s.sent[0].data.trainerId, 't1');
  assert.match(s.sent[0].body, /Coach Amani asked to train at Kilimanjaro Fitness/);

  const statement = { id: 'stl-1', gymId: 'g1', periodStartDate: '2026-09-01', periodEndDate: '2026-09-30', finalNetTzs: 1250000 };
  await s.notifier.gymStatement(statement, 'approved');
  await s.notifier.gymStatement(statement, 'paid');
  await s.notifier.gymStatement(statement, 'submitted'); // internal step: not told
  assert.deepEqual(s.to('gym_statement_approved'), ['owner_1']);
  assert.deepEqual(s.to('gym_payout_paid'), ['owner_1']);
  assert.equal(s.sent.length, 3);
  assert.match(s.sent[1].body, /TSh 1,250,000 to be paid/);
  assert.match(s.sent[2].body, /TSh 1,250,000 for 2026-09-01 – 2026-09-30 has been paid/);
  assert.notEqual(s.sent[1].id, s.sent[2].id);
});

test('a new review tells the gym', async () => {
  const s = setup();
  await s.notifier.gymReview({ id: 'rev-1', gymId: 'g1', memberId: 'm1', rating: 4 });
  assert.deepEqual(s.to('gym_review'), ['owner_1', 'staff_1']);
  assert.equal(s.sent[0].title, 'New 4-star review');
  assert.equal(s.sent[0].data.reviewId, 'rev-1');
});

test('vendors hear about orders, questions and decisions; other shop events stay in the list', async () => {
  const s = setup();
  await s.notifier.vendorEvent('v1', 'new_order', { orderId: 'ord-1' });
  await s.notifier.vendorEvent('v1', 'order_cancelled', { orderId: 'ord-1', by: 'buyer' });
  await s.notifier.vendorEvent('v1', 'new_customer_enquiry', { enquiryId: 'enq-1' });
  await s.notifier.vendorEvent('v1', 'product_approved', { productId: 'p-1' });
  await s.notifier.vendorEvent('v1', 'product_rejected', { productId: 'p-2' });
  await s.notifier.vendorEvent('v1', 'vendor_approved', {});
  await s.notifier.vendorEvent('v1', 'vendor_rejected', { approvalNote: 'Upload your licence.' });
  await s.notifier.vendorEvent('v1', 'product_pending', { productId: 'p-3' });
  await s.notifier.vendorEvent('v1', 'something_new', {});
  assert.deepEqual(s.sent.map(m => m.type), [
    'vendor_new_order', 'vendor_order_cancelled', 'vendor_customer_enquiry', 'vendor_product_approved',
    'vendor_product_rejected', 'vendor_shop_approved', 'vendor_shop_rejected',
  ]);
  assert.ok(s.sent.every(m => m.userId === 'v1'));
  assert.deepEqual(s.sent[0].data, { orderId: 'ord-1' });
  assert.deepEqual(s.sent[2].data, { enquiryId: 'enq-1' });
  assert.equal(s.sent[6].body, 'Upload your licence.');
});

test('a notification that fails never reaches the caller', async () => {
  const s = setup({ notify: async () => { throw new Error('push is down'); } });
  await s.notifier.gymCheckin({ id: 'chk-1', gymId: 'g1', memberId: 'm1' });
  await s.notifier.gymReview({ id: 'rev-1', gymId: 'g1', memberId: 'm1', rating: 5 });
  await s.notifier.vendorEvent('v1', 'new_order', { orderId: 'ord-1' });
  await s.notifier.gymStatement({ id: 's', gymId: 'g1', finalNetTzs: 1 }, 'paid');
});

test('the shop tells the vendor — and only the vendor — and a failed push never fails the sale', async () => {
  const told = [];
  const marketplaceNotifications = store();
  const shop = createShopService({
    products: store(), shopOrders: store(), users: store(), auditLog: store(),
    marketplaceEnquiries: store(), marketplaceNotifications, productReviews: store(),
    onVendorEvent: async (vendorId, event, data) => { told.push([vendorId, event, data]); throw new Error('push is down'); },
  });
  // A customer asks a question: the vendor's list gets it, the vendor is told, and the buyer's request succeeds.
  const out = await shop.sendEnquiry({ buyerId: 'm1', body: { vendorId: 'v1', message: 'Do you deliver to Arusha?' } });
  assert.equal(out.status, 201);
  assert.equal(told.length, 1);
  assert.deepEqual(told[0].slice(0, 2), ['v1', 'new_customer_enquiry']);
  assert.equal(told[0][2].enquiryId, out.enquiry.id);
  assert.deepEqual((await shop.notifications('v1')).map(n => n.type), ['new_customer_enquiry'], 'still in the shop list, as before');
});

test('the check-in switch is a preference like the others: on by default, saved per person', async () => {
  const { createCommunicationPreferenceService } = await import('../src/services/communication-preference-service.mjs');
  const rows = [];
  const preferences = {
    async findByIdAsync(id) { return rows.find(r => r.id === id) ?? null; },
    async insertAsync(row) { rows.push(row); return row; },
    async updateByIdAsync(id, patch) { const r = rows.find(x => x.id === id); Object.assign(r, patch); return r; },
  };
  const svc = createCommunicationPreferenceService({ preferences });
  assert.equal((await svc.get('owner_1')).preferences.gymCheckinAlerts, true, 'on until someone says otherwise');
  assert.equal((await svc.update('owner_1', { gymCheckinAlerts: false })).preferences.gymCheckinAlerts, false);
  assert.equal(rows[0].gymCheckinAlerts, false);
  assert.equal((await svc.update('owner_1', { pushMarketing: false })).preferences.gymCheckinAlerts, false, 'other changes leave it alone');
  assert.equal((await svc.update('owner_1', { gymCheckinAlerts: true })).preferences.gymCheckinAlerts, true);
  assert.equal((await svc.update('owner_1', { gymCheckinAlerts: 'no' })).error, 'invalid_preference');
});
