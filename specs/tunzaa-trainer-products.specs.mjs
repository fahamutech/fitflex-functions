// Phase B · B6a: trainer products paid by mobile money (Malipo by Tunzaa), behind
// TUNZAA_TRAINER_PRODUCTS (effective only with TUNZAA_PAYMENTS).
//   TRAINER_SERVICE   a member paying for trainer sessions (booking group)
//   TRAINER_GYM_PASS  a trainer buying a gym's trainer pass
// Service-level on in-memory stores with the real admin payment and trainer
// booking services; never a real Tunzaa call (the client is a test double).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TunzaaError } from '../src/integrations/payments/tunzaa.mjs';
import { createMobileMoneyService } from '../src/services/mobile-money-service.mjs';
import { createAdminPaymentService } from '../src/services/admin-payment-service.mjs';
import { createTrainerBookingService } from '../src/services/trainer-booking-service.mjs';
import { tunzaaTrainerProductsOn } from '../src/shared/feature-flags.mjs';

function memStore(rows = []) {
  return {
    rows,
    async filterAsync(fn) { return rows.filter(fn); },
    async findAsync(fn) { return rows.find(fn) || null; },
    async findByIdAsync(id) { return rows.find((r) => r.id === id) || null; },
    async filterByColumnAsync(col, value) { return rows.filter((r) => r[col] === value); },
    async filterByColumnInAsync(col, values) { return rows.filter((r) => values.includes(r[col])); },
    async allAsync() { return [...rows]; },
    async insertAsync(row) { rows.push(row); return row; },
    async updateByIdAsync(id, patch) {
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows[i] = { ...rows[i], ...patch };
      return rows[i] || null;
    },
  };
}

const DAY = 86_400_000;
const PHONE = '0712345678';
const future = (days) => new Date(Date.now() + days * DAY).toISOString();

const memberPass = () => ({
  sub: { id: 'sub_m', memberId: 'm1', type: 'platform_pass', tier: 'basic', status: 'payment_pending', startedAt: new Date().toISOString(), expiresAt: future(30) },
  req: { id: 'pay_m', memberId: 'm1', subscriptionId: 'sub_m', tier: 'basic', amountTzs: 60_000, status: 'pending', provider: 'admin_approved', reference: null, note: null },
});
const trainerPass = () => ({
  sub: { id: 'sub_t', memberId: 't1', type: 'trainer_pass', tier: null, plan: 'weekly', homeGymId: 'gym_1', status: 'payment_pending', startedAt: new Date().toISOString(), expiresAt: future(7) },
  req: { id: 'pay_t', memberId: 't1', subscriptionId: 'sub_t', tier: null, plan: 'weekly', gymId: 'gym_1', amountTzs: 15_000, status: 'pending', provider: 'admin_approved', reference: null, note: 'trainer_pass' },
});
const trainerMemberPlan = () => ({
  sub: { id: 'sub_tp', memberId: 't1', type: 'direct_sub', plan: 'monthly', homeGymId: 'gym_2', status: 'payment_pending', startedAt: new Date().toISOString(), expiresAt: future(30) },
  req: { id: 'pay_tp', memberId: 't1', subscriptionId: 'sub_tp', plan: 'monthly', gymId: 'gym_2', amountTzs: 50_000, status: 'pending', provider: 'admin_approved', reference: null, note: null },
});
const sessionRequest = (over = {}) => ({
  id: 'pay_s', memberId: 'm1', subscriptionId: null, bookingGroupId: 'grp_1', tier: null, plan: 'trainer_session', gymId: 'gym_1',
  currency: 'TZS', amountTzs: 40_000, status: 'pending', provider: 'admin_approved', reference: null, note: '2 session(s) with Coach', ...over,
});
const booking = (id, over = {}) => ({
  id, groupId: 'grp_1', trainerId: 'tr_1', memberId: 'm1', gymId: 'gym_1', date: '2030-01-10', slot: '07:00',
  amountTzs: 20_000, paymentRequestId: 'pay_s', status: 'payment_pending', createdAt: new Date().toISOString(), ...over,
});

/**
 * One world: payment requests, subscriptions, trainer bookings, the real admin payment
 * service (wired to the real trainer booking service as bootstrap wires it) and the
 * mobile-money service with a fake Tunzaa client.
 */
function world({
  enabled = true, trainerProducts = true, canSettle = true, secondApprover = false,
  subs = [], requests = [], bookings = [], wireBookingCheck = true,
} = {}) {
  const subscriptions = memStore(subs);
  const paymentRequests = memStore(requests);
  const trainerBookings = memStore(bookings);
  const audit = [];
  const auditLog = { async insertAsync(e) { audit.push(e); } };
  const activated = [];
  const trainerBookingService = createTrainerBookingService({
    trainerBookings, trainerSessions: memStore(), trainers: [{ id: 'tr_1', userId: 't9', displayName: 'Coach' }], gyms: [],
    users: memStore(), auditLog, subscriptions, paymentRequests,
    trainerService: { hydrateTrainer: (t) => t, findProfileByUser: (userId) => (userId === 't9' ? { id: 'tr_1', userId: 't9', gymIds: ['gym_1'] } : null) },
  });
  const adminPaymentService = createAdminPaymentService({
    paymentRequests, subscriptions, users: memStore(), auditLog,
    onBookingPayment: (groupId, status) => trainerBookingService.applyPaymentToGroup(groupId, status),
    beforeBookingPayment: (request) => trainerBookingService.checkGroupPayment(request.bookingGroupId, 'approved'),
    onSubscriptionActivated: async (sub) => { activated.push(sub.id); },
    secondApprover: () => secondApprover,
  });
  const remote = { initiated: [], statusOf: {}, failInitiate: null, statusCalls: 0 };
  const client = {
    environment: 'sandbox',
    async initiatePayment(args) {
      if (remote.failInitiate) throw new TunzaaError('no', { code: remote.failInitiate, status: 502 });
      remote.initiated.push(args);
      return { transactionId: `TXN_${remote.initiated.length}` };
    },
    async checkStatus(id) {
      remote.statusCalls += 1;
      const s = remote.statusOf[id] || { status: 'PENDING', amount: null };
      return { status: s.status, amountTzs: s.amount ? Number(s.amount) : null, transactionId: id, remark: s.remark || null };
    },
  };
  const flags = { enabled, trainerProducts };
  const service = createMobileMoneyService({
    paymentRequests, subscriptions, adminPaymentService, auditLog, client,
    enabled: () => flags.enabled, canSettle: () => canSettle,
    // The real flag is effective only with TUNZAA_PAYMENTS on (see feature-flags).
    trainerProducts: () => flags.trainerProducts && flags.enabled,
    beforeBookingPayment: wireBookingCheck
      ? (request) => trainerBookingService.checkGroupPayment(request.bookingGroupId, 'approved')
      : null,
  });
  return { subscriptions, paymentRequests, trainerBookings, audit, activated, service, remote, flags, trainerBookingService };
}

const reqOf = (w, id) => w.paymentRequests.rows.find((r) => r.id === id);
const subOf = (w, id) => w.subscriptions.rows.find((s) => s.id === id);
const statuses = (w) => w.trainerBookings.rows.filter((b) => b.groupId === 'grp_1').map((b) => b.status);

// ── the flag ──────────────────────────────────────────────────────────────

test('flag: TUNZAA_TRAINER_PRODUCTS is effective only together with TUNZAA_PAYMENTS', () => {
  const saved = { a: process.env.TUNZAA_PAYMENTS, b: process.env.TUNZAA_TRAINER_PRODUCTS };
  try {
    for (const [payments, trainer, expected] of [
      [undefined, undefined, false], ['1', undefined, false], [undefined, '1', false], ['1', '1', true], ['true', 'on', true], ['1', '0', false],
    ]) {
      if (payments === undefined) delete process.env.TUNZAA_PAYMENTS; else process.env.TUNZAA_PAYMENTS = payments;
      if (trainer === undefined) delete process.env.TUNZAA_TRAINER_PRODUCTS; else process.env.TUNZAA_TRAINER_PRODUCTS = trainer;
      assert.equal(tunzaaTrainerProductsOn(), expected, `TUNZAA_PAYMENTS=${payments} TUNZAA_TRAINER_PRODUCTS=${trainer}`);
    }
  } finally {
    if (saved.a === undefined) delete process.env.TUNZAA_PAYMENTS; else process.env.TUNZAA_PAYMENTS = saved.a;
    if (saved.b === undefined) delete process.env.TUNZAA_TRAINER_PRODUCTS; else process.env.TUNZAA_TRAINER_PRODUCTS = saved.b;
  }
});

test('flag combinations: what each role may pay, and what options report', async () => {
  const fresh = (o) => {
    const t = trainerPass();
    return world({ ...o, subs: [t.sub], requests: [sessionRequest(), t.req], bookings: [booking('bk_1')] });
  };

  // Mobile money off (trainer flag set, not effective): nothing for anyone.
  const off = fresh({ enabled: false, trainerProducts: true });
  assert.deepEqual([off.service.payableProducts('member'), off.service.payableProducts('trainer')], [[], []]);
  assert.equal((await off.service.pay({ memberId: 'm1', paymentRequestId: 'pay_s', phone: PHONE })).error, 'feature_disabled');
  assert.equal((await off.service.pay({ memberId: 't1', role: 'trainer', paymentRequestId: 'pay_t', phone: PHONE })).error, 'feature_disabled');

  // Mobile money on, trainer products off: exactly as before.
  const base = fresh({ enabled: true, trainerProducts: false });
  assert.deepEqual(base.service.payableProducts('member'), ['FITFLEX_PASS', 'GYM_SUBSCRIPTION']);
  assert.deepEqual(base.service.payableProducts('trainer'), []);
  assert.deepEqual(base.service.payableProducts('vendor'), []);
  const s = await base.service.pay({ memberId: 'm1', paymentRequestId: 'pay_s', phone: PHONE });
  assert.deepEqual([s.status, s.error], [409, 'not_payable_this_way']);
  assert.equal((await base.service.pay({ memberId: 't1', role: 'trainer', paymentRequestId: 'pay_t', phone: PHONE })).error, 'feature_disabled');
  // No prompt out for the trainer: refresh answers as the member-only route did.
  assert.deepEqual(await base.service.refresh({ memberId: 't1', role: 'trainer', paymentRequestId: 'pay_t' }), { error: 'forbidden', status: 403, requiredRoles: ['member'] });
  assert.equal(base.remote.initiated.length, 0);

  // Both on: members pay sessions, trainers pay their pass.
  const on = fresh({ enabled: true, trainerProducts: true });
  assert.deepEqual(on.service.payableProducts('member'), ['FITFLEX_PASS', 'GYM_SUBSCRIPTION', 'TRAINER_SERVICE']);
  assert.deepEqual(on.service.payableProducts('trainer'), ['TRAINER_GYM_PASS']);
  assert.deepEqual(on.service.payableProducts('owner'), []);
  assert.equal((await on.service.pay({ memberId: 'm1', paymentRequestId: 'pay_s', phone: PHONE })).status, 202);
  assert.equal((await on.service.pay({ memberId: 't1', role: 'trainer', paymentRequestId: 'pay_t', phone: '0754000111' })).status, 202);
  assert.deepEqual(on.remote.initiated.map((x) => x.amountTzs), [40_000, 15_000], 'each request\'s own amount');

  // Both on, but the sandbox may not settle: nothing offered.
  const sandbox = fresh({ enabled: true, trainerProducts: true, canSettle: false });
  assert.deepEqual(sandbox.service.payableProducts('trainer'), []);
  assert.equal((await sandbox.service.pay({ memberId: 't1', role: 'trainer', paymentRequestId: 'pay_t', phone: PHONE })).error, 'feature_disabled');
});

test('trainer sessions are not payable this way when the booking check is not wired (fail closed)', async () => {
  const w = world({ requests: [sessionRequest()], bookings: [booking('bk_1')], wireBookingCheck: false });
  assert.deepEqual(w.service.payableProducts('member'), ['FITFLEX_PASS', 'GYM_SUBSCRIPTION']);
  assert.equal((await w.service.pay({ memberId: 'm1', paymentRequestId: 'pay_s', phone: PHONE })).error, 'not_payable_this_way');
});

// ── ownership and roles ───────────────────────────────────────────────────

test('ownership: a trainer cannot pay a member\'s request; a member cannot pay a trainer pass', async () => {
  const t = trainerPass();
  const tp = trainerMemberPlan();
  const m = memberPass();
  const w = world({
    subs: [t.sub, tp.sub, m.sub],
    // a TRAINER_SERVICE request on the trainer's own user id (a person with both roles)
    requests: [sessionRequest(), sessionRequest({ id: 'pay_s_t1', memberId: 't1', bookingGroupId: 'grp_9' }), t.req, tp.req, m.req],
    bookings: [booking('bk_1')],
  });
  const trainerPay = (id) => w.service.pay({ memberId: 't1', role: 'trainer', paymentRequestId: id, phone: PHONE });
  const memberPay = (memberId, id) => w.service.pay({ memberId, role: 'member', paymentRequestId: id, phone: PHONE });

  // Someone else's request is not found, whatever it is.
  assert.deepEqual(await trainerPay('pay_s'), { error: 'not_found', status: 404 });
  assert.deepEqual(await trainerPay('pay_m'), { error: 'not_found', status: 404 });
  assert.deepEqual(await memberPay('m1', 'pay_t'), { error: 'not_found', status: 404 });
  // Own request, wrong role for the product.
  assert.deepEqual(await trainerPay('pay_s_t1'), { error: 'not_payable_by_role', status: 403, product: 'TRAINER_SERVICE' });
  assert.deepEqual(await trainerPay('pay_tp'), { error: 'not_payable_by_role', status: 403, product: 'GYM_SUBSCRIPTION' });
  assert.deepEqual(await memberPay('t1', 'pay_t'), { error: 'not_payable_by_role', status: 403, product: 'TRAINER_GYM_PASS' });
  assert.equal(w.remote.initiated.length, 0);
  assert.ok(w.paymentRequests.rows.every((r) => r.provider === 'admin_approved' && r.reference === null), 'nothing claimed');

  // Status follows the same rules.
  assert.equal((await w.service.refresh({ memberId: 't1', role: 'trainer', paymentRequestId: 'pay_s' })).error, 'not_found');
  assert.equal((await w.service.refresh({ memberId: 't1', role: 'trainer', paymentRequestId: 'pay_tp' })).error, 'not_payable_by_role');
  assert.equal((await w.service.refresh({ memberId: 't1', role: 'member', paymentRequestId: 'pay_t' })).error, 'not_payable_by_role');
  assert.equal((await w.service.refresh({ memberId: 't1', role: 'trainer', paymentRequestId: 'pay_t' })).state, 'none');

  // The rightful payers still can.
  assert.equal((await trainerPay('pay_t')).status, 202);
  assert.equal((await memberPay('m1', 'pay_s')).status, 202);
  assert.equal((await memberPay('m1', 'pay_m')).status, 202);
});

// ── existing checks still hold for trainer products ───────────────────────

test('existing checks hold: not pending, Lipa Namba already submitted, amount, currency, in flight', async () => {
  const t = trainerPass();
  const w = world({
    subs: [t.sub],
    requests: [
      sessionRequest({ id: 'pay_done', status: 'approved' }),
      sessionRequest({ id: 'pay_manual', memberReference: 'QWE123RTY' }),
      sessionRequest({ id: 'pay_zero', amountTzs: 0 }),
      sessionRequest({ id: 'pay_usd', currency: 'USD' }),
      { ...t.req, memberReference: 'MPESA-1' },
    ],
    bookings: [booking('bk_1')],
  });
  const pay = (id, memberId = 'm1', role = 'member') => w.service.pay({ memberId, role, paymentRequestId: id, phone: PHONE });
  assert.equal((await pay('pay_done')).error, 'payment_not_pending');
  assert.equal((await pay('pay_manual')).error, 'manual_payment_submitted');
  assert.equal((await pay('pay_t', 't1', 'trainer')).error, 'manual_payment_submitted');
  assert.equal((await pay('pay_zero')).error, 'invalid_amount');
  assert.equal((await pay('pay_usd')).error, 'unsupported_currency');
  assert.equal((await w.service.pay({ memberId: 'm1', paymentRequestId: 'pay_zero', phone: '12' })).error, 'invalid_amount');
  assert.equal(w.remote.initiated.length, 0);

  const again = world({ requests: [sessionRequest()], bookings: [booking('bk_1')] });
  assert.equal((await again.service.pay({ memberId: 'm1', paymentRequestId: 'pay_s', phone: '12' })).error, 'invalid_phone');
  assert.equal((await again.service.pay({ memberId: 'm1', paymentRequestId: 'pay_s', phone: PHONE })).status, 202);
  const second = await again.service.pay({ memberId: 'm1', paymentRequestId: 'pay_s', phone: PHONE });
  assert.deepEqual([second.state, second.alreadyRequested], ['in_progress', true]);
  assert.equal(again.remote.initiated.length, 1, 'one prompt per request');
});

test('SHOP_ORDER is still refused with every flag on', async () => {
  const w = world({ requests: [{ id: 'pay_o', memberId: 'm1', subscriptionId: null, orderId: 'ord_1', currency: 'TZS', amountTzs: 5000, status: 'pending', provider: 'admin_approved', reference: null }] });
  assert.ok(!w.service.payableProducts('member').includes('SHOP_ORDER'));
  assert.deepEqual(await w.service.pay({ memberId: 'm1', paymentRequestId: 'pay_o', phone: PHONE }), { error: 'not_payable_this_way', status: 409 });
  assert.equal(w.remote.initiated.length, 0);
});

// ── group_slot_rebooked (B1 security review) ──────────────────────────────

test('a booking payment covering a rejected session whose slot was rebooked is refused before any prompt', async () => {
  const w = world({
    requests: [sessionRequest()],
    bookings: [
      booking('bk_1', { status: 'payment_rejected' }),
      booking('bk_2', { status: 'payment_rejected', slot: '08:00' }),
      // someone else took bk_1's slot after the rejection freed it
      booking('bk_other', { groupId: 'grp_other', memberId: 'm2', paymentRequestId: 'pay_other', status: 'payment_pending' }),
    ],
  });
  const out = await w.service.pay({ memberId: 'm1', paymentRequestId: 'pay_s', phone: PHONE });
  assert.deepEqual(out, { error: 'group_slot_rebooked', status: 409, bookingIds: ['bk_1'] });
  assert.equal(w.remote.initiated.length, 0, 'no money asked for');
  assert.deepEqual([reqOf(w, 'pay_s').provider, reqOf(w, 'pay_s').reference], ['admin_approved', null], 'not claimed');

  // Once the other booking lets the slot go, paying goes through.
  w.trainerBookings.rows.find((b) => b.id === 'bk_other').status = 'cancelled';
  assert.equal((await w.service.pay({ memberId: 'm1', paymentRequestId: 'pay_s', phone: PHONE })).status, 202);
});

test('a slot rebooked while the prompt was out: the money is held for staff, the bookings stay as they are', async () => {
  const w = world({
    requests: [sessionRequest()],
    bookings: [booking('bk_1', { status: 'payment_rejected' }), booking('bk_2', { status: 'payment_rejected', slot: '08:00' })],
  });
  assert.equal((await w.service.pay({ memberId: 'm1', paymentRequestId: 'pay_s', phone: PHONE })).status, 202);
  w.trainerBookings.rows.push(booking('bk_other', { groupId: 'grp_other', memberId: 'm2', status: 'payment_pending' }));
  w.remote.statusOf.TXN_1 = { status: 'COMPLETED', amount: '40000.00' };
  const out = await w.service.refresh({ memberId: 'm1', paymentRequestId: 'pay_s' });
  assert.deepEqual([out.state, out.reason], ['held', 'group_slot_rebooked']);
  assert.equal(reqOf(w, 'pay_s').status, 'pending');
  assert.deepEqual(statuses(w), ['payment_rejected', 'payment_rejected']);
  assert.ok(w.audit.some((a) => a.action === 'payment_mobile_money_held' && a.after?.error === 'group_slot_rebooked'));
});

// ── settling ──────────────────────────────────────────────────────────────

test('settle confirms the booking group through decide({automated}); a double settle changes nothing', async () => {
  const w = world({ requests: [sessionRequest()], bookings: [booking('bk_1'), booking('bk_2', { slot: '08:00' })] });
  await w.service.pay({ memberId: 'm1', paymentRequestId: 'pay_s', phone: PHONE });
  assert.deepEqual(statuses(w), ['payment_pending', 'payment_pending'], 'nothing confirmed before the money');
  w.remote.statusOf.TXN_1 = { status: 'COMPLETED', amount: '40000.00' };

  const cb = await w.service.handleCallback({ transaction_id: 'TXN_1', reference_id: 'pay_s.k1', status: 'COMPLETED', amount: '40000.00' });
  assert.deepEqual([cb.status, cb.state], [200, 'completed']);
  const r = reqOf(w, 'pay_s');
  assert.deepEqual([r.status, r.reference, r.decidedBy], ['approved', 'TXN_1', 'tunzaa']);
  assert.deepEqual(statuses(w), ['confirmed', 'confirmed']);

  // Repeat callback and a refresh: still completed, decided once.
  assert.equal((await w.service.handleCallback({ transaction_id: 'TXN_1', reference_id: 'pay_s.k1', status: 'COMPLETED' })).state, 'completed');
  assert.equal((await w.service.refresh({ memberId: 'm1', paymentRequestId: 'pay_s' })).state, 'completed');
  assert.equal(w.audit.filter((a) => a.action === 'payment_approved').length, 1);
  assert.deepEqual(statuses(w), ['confirmed', 'confirmed']);
  assert.equal(w.paymentRequests.rows.length, 1);
});

test('settle activates the trainer pass; a double settle activates it once', async () => {
  const t = trainerPass();
  const w = world({ subs: [t.sub], requests: [t.req] });
  assert.equal((await w.service.pay({ memberId: 't1', role: 'trainer', paymentRequestId: 'pay_t', phone: PHONE })).status, 202);
  w.remote.statusOf.TXN_1 = { status: 'COMPLETED', amount: '15000.00' };
  const done = await w.service.refresh({ memberId: 't1', role: 'trainer', paymentRequestId: 'pay_t' });
  assert.equal(done.state, 'completed');
  assert.deepEqual([subOf(w, 'sub_t').status, subOf(w, 'sub_t').paymentRef], ['active', 'TXN_1']);
  assert.equal(reqOf(w, 'pay_t').status, 'approved');
  assert.equal((await w.service.handleCallback({ transaction_id: 'TXN_1', reference_id: 'pay_t.a', status: 'COMPLETED' })).state, 'completed');
  assert.deepEqual(w.activated, ['sub_t'], 'activated once');
  assert.equal(w.audit.filter((a) => a.action === 'payment_approved').length, 1);
});

test('a failed trainer-pass prompt is released so the trainer can try again', async () => {
  const t = trainerPass();
  const w = world({ subs: [t.sub], requests: [t.req] });
  await w.service.pay({ memberId: 't1', role: 'trainer', paymentRequestId: 'pay_t', phone: PHONE });
  w.remote.statusOf.TXN_1 = { status: 'FAILED', remark: 'Insufficient funds' };
  assert.equal((await w.service.refresh({ memberId: 't1', role: 'trainer', paymentRequestId: 'pay_t' })).state, 'failed');
  assert.deepEqual([reqOf(w, 'pay_t').provider, reqOf(w, 'pay_t').reference, subOf(w, 'sub_t').status], ['admin_approved', null, 'payment_pending']);
  assert.equal((await w.service.pay({ memberId: 't1', role: 'trainer', paymentRequestId: 'pay_t', phone: PHONE })).status, 202);
});

test('MONEY_SECOND_APPROVER on: a provider-confirmed payment needs no second admin, but a reused transaction is held', async () => {
  // automated exemption: confirmed without any verification
  const w = world({ secondApprover: true, requests: [sessionRequest()], bookings: [booking('bk_1')] });
  await w.service.pay({ memberId: 'm1', paymentRequestId: 'pay_s', phone: PHONE });
  w.remote.statusOf.TXN_1 = { status: 'COMPLETED', amount: '40000.00' };
  const ok = await w.service.refresh({ memberId: 'm1', paymentRequestId: 'pay_s' });
  assert.equal(ok.state, 'completed');
  assert.equal(reqOf(w, 'pay_s').verifiedBy ?? null, null);
  assert.deepEqual(statuses(w), ['confirmed']);

  // reference_already_used: the same transaction already confirmed another payment
  const t = trainerPass();
  const dup = world({
    secondApprover: true, subs: [t.sub],
    requests: [t.req, { id: 'pay_old', memberId: 'm7', subscriptionId: null, amountTzs: 15_000, status: 'approved', provider: 'tunzaa', reference: 'TXN_1' }],
  });
  await dup.service.pay({ memberId: 't1', role: 'trainer', paymentRequestId: 'pay_t', phone: PHONE });
  dup.remote.statusOf.TXN_1 = { status: 'COMPLETED', amount: '15000.00' };
  const held = await dup.service.refresh({ memberId: 't1', role: 'trainer', paymentRequestId: 'pay_t' });
  assert.deepEqual([held.state, held.reason], ['held', 'reference_already_used']);
  assert.equal(reqOf(dup, 'pay_t').status, 'pending');
  assert.equal(subOf(dup, 'sub_t').status, 'payment_pending');
  assert.deepEqual(dup.activated, []);
});

test('flag turned off while a trainer\'s prompt is out: they can refresh it (not start one); the callback settles too', async () => {
  const t = trainerPass();
  const other = trainerPass();
  const w = world({
    subs: [t.sub, { ...other.sub, id: 'sub_t2', memberId: 't2' }],
    requests: [t.req, { ...other.req, id: 'pay_t2', memberId: 't2', subscriptionId: 'sub_t2' }],
  });
  await w.service.pay({ memberId: 't1', role: 'trainer', paymentRequestId: 'pay_t', phone: PHONE });
  await w.service.pay({ memberId: 't2', role: 'trainer', paymentRequestId: 'pay_t2', phone: '0754000222' });
  w.flags.trainerProducts = false;
  const forbidden = { error: 'forbidden', status: 403, requiredRoles: ['member'] };

  // Starting is closed; asking how the live prompt went is not.
  assert.equal((await w.service.pay({ memberId: 't1', role: 'trainer', paymentRequestId: 'pay_t', phone: PHONE })).error, 'feature_disabled');
  assert.equal((await w.service.refresh({ memberId: 't1', role: 'trainer', paymentRequestId: 'pay_t' })).state, 'in_progress');
  // Not their own, or unknown: as the member-only route answered before.
  assert.deepEqual(await w.service.refresh({ memberId: 't1', role: 'trainer', paymentRequestId: 'pay_t2' }), forbidden);
  assert.deepEqual(await w.service.refresh({ memberId: 't1', role: 'trainer', paymentRequestId: 'nope' }), forbidden);

  w.remote.statusOf.TXN_1 = { status: 'COMPLETED', amount: '15000.00' };
  assert.equal((await w.service.refresh({ memberId: 't1', role: 'trainer', paymentRequestId: 'pay_t' })).state, 'completed');
  assert.equal(subOf(w, 'sub_t').status, 'active');
  // Settled: nothing live any more, so the trainer is back to 403.
  assert.deepEqual(await w.service.refresh({ memberId: 't1', role: 'trainer', paymentRequestId: 'pay_t' }), forbidden);

  // The other trainer's prompt settles through its signed callback.
  w.remote.statusOf.TXN_2 = { status: 'COMPLETED', amount: '15000.00' };
  assert.equal((await w.service.handleCallback({ transaction_id: 'TXN_2', reference_id: 'pay_t2.a', status: 'COMPLETED' })).state, 'completed');
  assert.equal(subOf(w, 'sub_t2').status, 'active');
});

// ── review fixes: cancelling under a live prompt; transaction checks on settle ──

test('a session cannot be cancelled (member, trainer or admin) while a prompt is out for its payment', async () => {
  const w = world({ requests: [sessionRequest()], bookings: [booking('bk_1'), booking('bk_2', { slot: '08:00' })] });
  await w.service.pay({ memberId: 'm1', paymentRequestId: 'pay_s', phone: PHONE });
  const before = { ...reqOf(w, 'pay_s') };
  const refused = { error: 'payment_in_progress', status: 409 };
  assert.deepEqual(await w.trainerBookingService.memberCancelBooking({ memberId: 'm1', bookingId: 'bk_1' }), refused);
  assert.deepEqual(await w.trainerBookingService.trainerCancelBooking({ userId: 't9', bookingId: 'bk_2' }), refused);
  assert.deepEqual(await w.trainerBookingService.adminUpdateStatus({ id: 'bk_1', status: 'cancelled', actorId: 'adm' }), refused);
  assert.deepEqual(statuses(w), ['payment_pending', 'payment_pending'], 'nothing cancelled');
  assert.deepEqual(reqOf(w, 'pay_s'), before, 'the payment under the prompt is untouched');

  // The prompt completes for the full amount: both sessions confirmed, nothing held.
  w.remote.statusOf.TXN_1 = { status: 'COMPLETED', amount: '40000.00' };
  assert.equal((await w.service.refresh({ memberId: 'm1', paymentRequestId: 'pay_s' })).state, 'completed');
  assert.deepEqual(statuses(w), ['confirmed', 'confirmed']);
});

test('once the prompt has failed (or its claim expired), cancelling works and shrinks the payment as before', async () => {
  const w = world({ requests: [sessionRequest()], bookings: [booking('bk_1'), booking('bk_2', { slot: '08:00' })] });
  await w.service.pay({ memberId: 'm1', paymentRequestId: 'pay_s', phone: PHONE });
  w.remote.statusOf.TXN_1 = { status: 'FAILED', remark: 'Cancelled by user' };
  assert.equal((await w.service.refresh({ memberId: 'm1', paymentRequestId: 'pay_s' })).state, 'failed');
  const out = await w.trainerBookingService.memberCancelBooking({ memberId: 'm1', bookingId: 'bk_1' });
  assert.equal(out.error, undefined, JSON.stringify(out));
  assert.deepEqual(statuses(w), ['cancelled', 'payment_pending']);
  assert.deepEqual([reqOf(w, 'pay_s').status, reqOf(w, 'pay_s').amountTzs], ['pending', 20_000]);
  // the last slot withdraws the request
  assert.equal((await w.trainerBookingService.trainerCancelBooking({ userId: 't9', bookingId: 'bk_2' })).error, undefined);
  assert.equal(reqOf(w, 'pay_s').status, 'cancelled');

  // A claim that never produced a prompt and has expired does not block (the app may retry anyway).
  const stale = world({
    requests: [sessionRequest({ provider: 'tunzaa', reference: `pending:${Date.now() - 10 * 60_000}` })],
    bookings: [booking('bk_1'), booking('bk_2', { slot: '08:00' })],
  });
  assert.equal((await stale.trainerBookingService.memberCancelBooking({ memberId: 'm1', bookingId: 'bk_1' })).error, undefined);
  assert.equal(reqOf(stale, 'pay_s').amountTzs, 20_000);
  // A recent claim does block.
  const fresh = world({
    requests: [sessionRequest({ provider: 'tunzaa', reference: `pending:${Date.now()}` })],
    bookings: [booking('bk_1')],
  });
  assert.equal((await fresh.trainerBookingService.memberCancelBooking({ memberId: 'm1', bookingId: 'bk_1' })).error, 'payment_in_progress');
});

test('a prompt claimed between the cancel\'s read and its write: the payment is left alone and the session stays', async () => {
  const w = world({ requests: [sessionRequest()], bookings: [booking('bk_1'), booking('bk_2', { slot: '08:00' })] });
  // The cancel reads the request as it was; by the time it writes, a prompt has been claimed.
  const realFind = w.paymentRequests.findByIdAsync;
  const snapshot = { ...reqOf(w, 'pay_s') };
  let first = true;
  w.paymentRequests.findByIdAsync = async (id) => {
    if (id === 'pay_s' && first) {
      first = false;
      Object.assign(w.paymentRequests.rows[0], { provider: 'tunzaa', reference: 'TXN_RACE' });
      return snapshot;
    }
    return realFind(id);
  };
  assert.deepEqual(await w.trainerBookingService.memberCancelBooking({ memberId: 'm1', bookingId: 'bk_1' }), { error: 'payment_in_progress', status: 409 });
  assert.deepEqual(statuses(w), ['payment_pending', 'payment_pending']);
  assert.deepEqual([reqOf(w, 'pay_s').amountTzs, reqOf(w, 'pay_s').reference], [40_000, 'TXN_RACE']);
});

test('settle holds money confirmed for a different transaction than the one the request is waiting on', async () => {
  const w = world({ requests: [sessionRequest()], bookings: [booking('bk_1')] });
  await w.service.pay({ memberId: 'm1', paymentRequestId: 'pay_s', phone: PHONE }); // waiting on TXN_1
  w.remote.statusOf.TXN_OTHER = { status: 'COMPLETED', amount: '40000.00' };
  const out = await w.service.handleCallback({ transaction_id: 'TXN_OTHER', reference_id: 'pay_s.a', status: 'COMPLETED' });
  assert.deepEqual([out.status, out.state], [200, 'held']);
  assert.deepEqual([reqOf(w, 'pay_s').status, reqOf(w, 'pay_s').reference], ['pending', 'TXN_1']);
  assert.deepEqual(statuses(w), ['payment_pending']);
  assert.ok(w.audit.some((a) => a.action === 'payment_mobile_money_held' && a.after?.error === 'transaction_mismatch' && a.after?.transactionId === 'TXN_OTHER'));

  // The transaction it is waiting on still settles it.
  w.remote.statusOf.TXN_1 = { status: 'COMPLETED', amount: '40000.00' };
  assert.equal((await w.service.handleCallback({ transaction_id: 'TXN_1', reference_id: 'pay_s.a', status: 'COMPLETED' })).state, 'completed');
  assert.deepEqual(statuses(w), ['confirmed']);
});

test('a transaction already used on another approved payment is held whatever MONEY_SECOND_APPROVER / MANUAL_PAY_INSTRUCTIONS say', async () => {
  const t = trainerPass();
  const w = world({
    secondApprover: false, subs: [t.sub],
    requests: [t.req, { id: 'pay_old', memberId: 'm7', subscriptionId: null, amountTzs: 15_000, status: 'approved', provider: 'tunzaa', reference: 'TXN_1' }],
  });
  await w.service.pay({ memberId: 't1', role: 'trainer', paymentRequestId: 'pay_t', phone: PHONE });
  w.remote.statusOf.TXN_1 = { status: 'COMPLETED', amount: '15000.00' };
  const held = await w.service.refresh({ memberId: 't1', role: 'trainer', paymentRequestId: 'pay_t' });
  assert.deepEqual([held.state, held.reason], ['held', 'reference_already_used']);
  assert.equal(reqOf(w, 'pay_t').status, 'pending');
  assert.equal(subOf(w, 'sub_t').status, 'payment_pending');
  assert.ok(w.audit.some((a) => a.action === 'payment_mobile_money_held' && a.after?.error === 'reference_already_used'));
  // A pending or cancelled request carrying the same id does not count.
  const ok = world({
    subs: [t.sub],
    requests: [t.req, { id: 'pay_c', memberId: 'm7', amountTzs: 15_000, status: 'cancelled', provider: 'tunzaa', reference: 'TXN_1' }],
  });
  await ok.service.pay({ memberId: 't1', role: 'trainer', paymentRequestId: 'pay_t', phone: PHONE });
  ok.remote.statusOf.TXN_1 = { status: 'COMPLETED', amount: '15000.00' };
  assert.equal((await ok.service.refresh({ memberId: 't1', role: 'trainer', paymentRequestId: 'pay_t' })).state, 'completed');
});
