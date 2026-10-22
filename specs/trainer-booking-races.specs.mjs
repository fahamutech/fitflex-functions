// Trainer booking races (security review of #231), against the CI database.
//
//  1. A group payment approved while another member books one of its rejected
//     sessions' slots: the booking side refuses under the slot locks, the
//     payment decision is put back, audited, and an ops alert is raised.
//  2. Mobile money is not started for a booking payment that cannot be
//     approved (409 group_slot_rebooked): the money would only sit in `held`.
//  3. New bookings and revived sessions take the trainer slot's advisory lock,
//     so one slot is never held by two live bookings.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureInit } from '../functions/index.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { gyms, trainers, trainerBookingService } from '../src/bootstrap/services.mjs';
import { paymentRequests } from '../src/bootstrap/collections.mjs';
import { adminDecidePaymentRequest, adminUpdatePaymentRequest } from '../functions/admin-payments.mjs';
import { createTrainerBooking } from '../functions/trainer-bookings.mjs';
import { createPgTrainerSlotStore } from '../src/infra/trainer-slot-store-pg.mjs';
import { createMobileMoneyService } from '../src/services/mobile-money-service.mjs';
import { createAdminPaymentService } from '../src/services/admin-payment-service.mjs';

await ensureInit();

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const HOUR = 3_600_000;
const made = { users: [], gyms: [], trainers: [] };

/** `date` + `slot` (EAT, whole hours) `offsetMs` from now. */
function eatSlot(offsetMs) {
  const t = new Date(Math.floor((Date.now() + offsetMs) / HOUR) * HOUR + 3 * HOUR).toISOString();
  return { date: t.slice(0, 10), slot: t.slice(11, 16) };
}
/** Another whole-hour slot on the same day. */
const nextHour = s => ({ date: s.date, slot: s.slot === '23:00' ? '22:00' : `${String(Number(s.slot.slice(0, 2)) + 1).padStart(2, '0')}:00` });

async function user(userType = 'member') {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `Races ${userType} ${id.slice(-4)}`, updatedAt: new Date() });
  made.users.push(id);
  return id;
}

async function scene() {
  const gymId = uid('gym');
  await gyms.insertAsync({ id: gymId, name: `Races Gym ${gymId.slice(-4)}`, tier: 'standard', location: 'Dar es Salaam', status: 'active', ratePerDay: 5000 });
  made.gyms.push(gymId);
  const trainerUserId = await user('trainer');
  const trainerId = uid('trn');
  await trainers.insertAsync({ id: trainerId, userId: trainerUserId, displayName: 'Coach Races', status: 'active', approvalStatus: 'approved', gymIds: [gymId], hourlyRateTzs: 20000 });
  made.trainers.push(trainerId);
  return { gymId, trainerId, memberId: await user('member'), adminId: await user('admin') };
}

const statusOf = async id => (await db('TrainerBooking').where({ id }).first()).status;
const auditFor = (target, action) => db('AuditLog').where({ target, action });

function res() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
async function call(route, { claims, params = {}, body = {}, query = {} } = {}) {
  const req = { headers: claims ? { authorization: `Bearer ${sign(claims)}` } : {}, params, body, query };
  const out = res();
  for (const guard of [route.onGuard].flat().filter(Boolean)) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return out;
}

const book = (s, memberId, slots) => trainerBookingService.createBooking({ memberId, body: { trainerId: s.trainerId, gymId: s.gymId, slots } });

/** A two-session group whose payment was rejected, so both its slots are free again. */
async function rejectedGroup(s, first) {
  const second = nextHour(first);
  const out = await call(createTrainerBooking, { claims: { sub: s.memberId, userType: 'member' }, body: { trainerId: s.trainerId, gymId: s.gymId, slots: [first, second] } });
  assert.equal(out.statusCode, 201, JSON.stringify(out.body));
  const requestId = out.body.paymentRequest.id;
  const reject = await call(adminDecidePaymentRequest, { claims: { sub: s.adminId, userType: 'admin' }, params: { id: requestId }, body: { decision: 'reject', note: 'bounced' } });
  assert.equal(reject.statusCode, 200, JSON.stringify(reject.body));
  return { requestId, bookings: out.body.bookings, second };
}

after(async () => {
  const requests = await db('PaymentRequest').whereIn('memberId', made.users).pluck('id');
  const bookings = await db('TrainerBooking').whereIn('trainerId', made.trainers).pluck('id');
  await db('OpsException').whereIn('entityId', requests).del();
  await db('AuditLog').whereIn('target', [...requests, ...bookings]).del();
  await db('AuditLog').where('target', 'like', 'tbg_%').whereIn('actor', made.users).del();
  await db('PaymentRequest').whereIn('id', requests).del();
  await db('TrainerBooking').whereIn('id', bookings).del();
  await db('TrainerProfileGym').whereIn('trainerId', made.trainers).del();
  await db('TrainerProfile').whereIn('id', made.trainers).del();
  await db('Gym').whereIn('id', made.gyms).del();
  await db('User').whereIn('id', made.users).del();
});

// ── 1 ──────────────────────────────────────────────────────────────────────

test('race 1: a slot booked between the approval check and the write — nothing moves, the decision is put back, audited and alerted', async () => {
  const s = await scene();
  const { requestId, bookings, second } = await rejectedGroup(s, eatSlot(6 * 24 * HOUR));
  const before = await db('PaymentRequest').where({ id: requestId }).first();

  // The check passes; right after it, before the write, another member books one of the freed slots.
  const otherMember = await user('member');
  let competitor = null;
  const realCheck = trainerBookingService.checkGroupPayment;
  trainerBookingService.checkGroupPayment = async (...args) => {
    const verdict = await realCheck(...args);
    competitor = await book(s, otherMember, [second]);
    return verdict;
  };
  let approve;
  try {
    approve = await call(adminUpdatePaymentRequest, { claims: { sub: s.adminId, userType: 'admin' }, params: { id: requestId }, body: { status: 'approved', reference: 'MPESA-RACE-1' } });
  } finally {
    trainerBookingService.checkGroupPayment = realCheck;
  }
  assert.equal(competitor.bookings?.length, 1, JSON.stringify(competitor));
  const takenId = bookings.find(b => b.slot === second.slot).id;
  assert.deepEqual([approve.statusCode, approve.body], [409, { error: 'group_slot_rebooked', bookingIds: [takenId] }]);

  // The payment request is as it was before the approval; no session of the group moved.
  const now = await db('PaymentRequest').where({ id: requestId }).first();
  for (const k of ['status', 'reference', 'note', 'decidedBy']) assert.deepEqual(now[k], before[k], k);
  assert.equal(+now.decidedAt, +before.decidedAt);
  assert.deepEqual(await Promise.all(bookings.map(b => statusOf(b.id))), ['payment_rejected', 'payment_rejected']);
  assert.equal(await statusOf(competitor.bookings[0].id), 'payment_pending', 'the other member keeps the slot');

  const [rolled] = await auditFor(requestId, 'payment_decision_rolled_back');
  assert.ok(rolled, 'the undo is on the record');
  const after_ = typeof rolled.after === 'string' ? JSON.parse(rolled.after) : rolled.after;
  assert.equal(after_.rolledBack, true);
  assert.deepEqual(after_.refusal.bookingIds, [takenId]);
  const alert = await db('OpsException').where({ dedupeKey: `trainer_group_slot_rebooked:${requestId}` }).first();
  assert.ok(alert, 'staff are alerted');
  assert.deepEqual([alert.type, alert.severity, alert.status, alert.entityId], ['payment_conflict', 'high', 'open', requestId]);
});

test('race 1: a decision that cannot be put back (changed meanwhile) still refuses, and says so in the alert', async () => {
  const refusal = { error: 'group_slot_rebooked', status: 409, bookingIds: ['tbk_x'] };
  const rows = new Map([['pay_1', { id: 'pay_1', memberId: 'm', bookingGroupId: 'tbg_1', status: 'rejected', reference: null, note: 'n', decidedAt: 'd', decidedBy: 'a0' }]]);
  const paymentRequestsMem = {
    findAsync: async pred => [...rows.values()].find(pred) || null,
    findByIdAsync: async id => rows.get(id) || null,
    // Every conditional write after the first finds the row changed by someone else.
    updateByIdWhereAsync: async (id, where, patch) => {
      const row = rows.get(id);
      if (row.status !== where.status || row.touched) return null;
      const next = { ...row, ...patch, touched: true };
      rows.set(id, next);
      return next;
    },
  };
  const audits = [];
  const alerts = [];
  const svc = createAdminPaymentService({
    paymentRequests: paymentRequestsMem, subscriptions: {}, users: {}, auditLog: { insertAsync: async a => audits.push(a) },
    onBookingPayment: async () => refusal,
    onBookingPaymentRefused: async a => alerts.push(a),
    secondApprover: () => false,
  });
  const out = await svc.update({ id: 'pay_1', status: 'approved', reference: 'R1', actorId: 'a1' });
  assert.deepEqual(out, { ...refusal, rolledBack: false });
  assert.deepEqual(audits.map(a => a.action), ['payment_decision_rolled_back']);
  assert.deepEqual(alerts.map(a => [a.rolledBack, a.refusal.error]), [[false, 'group_slot_rebooked']]);
});

// ── 2 ──────────────────────────────────────────────────────────────────────

test('race 2: mobile money is refused (409 group_slot_rebooked) for a booking payment that could not be approved; no prompt is sent', async () => {
  const s = await scene();
  const { requestId, bookings, second } = await rejectedGroup(s, eatSlot(7 * 24 * HOUR));
  // Back to pending while one of its slots is held by someone else: that session stays rejected.
  const otherMember = await user('member');
  const other = await book(s, otherMember, [second]);
  assert.equal(other.bookings?.length, 1, JSON.stringify(other));
  const pending = await call(adminUpdatePaymentRequest, { claims: { sub: s.adminId, userType: 'admin' }, params: { id: requestId }, body: { status: 'pending' } });
  assert.equal(pending.statusCode, 200, JSON.stringify(pending.body));
  const takenId = bookings.find(b => b.slot === second.slot).id;
  assert.equal(await statusOf(takenId), 'payment_rejected');
  assert.equal((await auditFor(takenId, 'trainer_booking_kept_rejected')).length, 1);

  let prompts = 0;
  const mobileMoney = createMobileMoneyService({
    paymentRequests, subscriptions: { findByIdAsync: async () => null }, adminPaymentService: null, auditLog: null,
    client: { environment: 'sandbox', initiatePayment: async () => { prompts += 1; return { transactionId: 'TXN-RACE-2' }; } },
    enabled: () => true, canSettle: () => true,
    // As wired in bootstrap.
    approvable: request => (request.bookingGroupId ? trainerBookingService.checkGroupPayment(request.bookingGroupId, 'approved') : null),
  });
  const out = await mobileMoney.pay({ memberId: s.memberId, paymentRequestId: requestId, phone: '0712345678' });
  assert.deepEqual(out, { error: 'group_slot_rebooked', status: 409, bookingIds: [takenId] });
  assert.equal(prompts, 0);
  const request = await db('PaymentRequest').where({ id: requestId }).first();
  assert.deepEqual([request.status, request.provider, request.reference], ['pending', 'admin_approved', null], 'not claimed for mobile money');
});

test('race 2: a request that can be approved goes on to the usual checks', async () => {
  const request = { id: 'pay_ok', memberId: 'm', status: 'pending', bookingGroupId: 'tbg_ok', amountTzs: 1000, provider: 'admin_approved' };
  let asked = 0;
  const mobileMoney = createMobileMoneyService({
    paymentRequests: { findByIdAsync: async () => request }, subscriptions: { findByIdAsync: async () => null },
    adminPaymentService: null, auditLog: null,
    client: { environment: 'sandbox', initiatePayment: async () => ({ transactionId: 'T' }) },
    enabled: () => true, canSettle: () => true,
    approvable: async () => { asked += 1; return null; },
  });
  // Trainer sessions are not sold by mobile money yet: that rule still applies after the check.
  assert.deepEqual(await mobileMoney.pay({ memberId: 'm', paymentRequestId: 'pay_ok', phone: '0712345678' }), { error: 'not_payable_this_way', status: 409 });
  assert.equal(asked, 1);
});

// ── 3 ──────────────────────────────────────────────────────────────────────

test('race 3: members booking the same trainer slot at the same time — exactly one gets it', async () => {
  const s = await scene();
  const slot = eatSlot(8 * 24 * HOUR);
  const members = await Promise.all([1, 2, 3, 4, 5].map(() => user('member')));
  const outs = await Promise.all(members.map(m => book(s, m, [slot])));
  const won = outs.filter(o => o.bookings);
  assert.equal(won.length, 1, JSON.stringify(outs.map(o => o.error || 'ok')));
  for (const lost of outs.filter(o => o.error)) assert.equal(lost.error, 'slot_already_booked');
  const live = await db('TrainerBooking').where({ trainerId: s.trainerId, ...slot }).whereNotIn('status', ['cancelled', 'payment_rejected']);
  assert.equal(live.length, 1);
  // The losers left nothing behind: no booking and no payment request.
  const losers = members.filter(m => m !== live[0].memberId);
  assert.equal((await db('PaymentRequest').whereIn('memberId', losers)).length, 0);
});

test('race 3: reviving a payment_rejected session and a new booking of its slot run one after the other', async () => {
  const s = await scene();
  const first = eatSlot(9 * 24 * HOUR);
  const { bookings } = await rejectedGroup(s, first);
  const groupId = (await db('TrainerBooking').where({ id: bookings[0].id }).first()).groupId;
  const otherMember = await user('member');

  let competitor = null;
  let settledWhileLocked = false;
  const store = createPgTrainerSlotStore({
    db,
    // While the revive holds the slot locks, another member tries to book the same slot.
    whileLocked: async () => {
      competitor = book(s, otherMember, [first]);
      competitor.then(() => { settledWhileLocked = true; }, () => { settledWhileLocked = true; });
      await new Promise(r => setTimeout(r, 300));
    },
  });
  const out = await store.moveGroup({
    groupId,
    decide: (group, taken) => ({ moves: group.filter(b => !taken.has(b.id)).map(b => ({ id: b.id, from: b.status, to: 'payment_pending' })) }),
  });
  assert.equal(settledWhileLocked, false, 'the new booking waited for the slot lock');
  assert.deepEqual(out.updated.map(b => b.status), ['payment_pending', 'payment_pending']);
  const lost = await competitor;
  assert.deepEqual([lost.error, lost.slot], ['slot_already_booked', first]);
  const live = await db('TrainerBooking').where({ trainerId: s.trainerId, ...first }).whereNotIn('status', ['cancelled', 'payment_rejected']);
  assert.deepEqual(live.map(b => b.id), [bookings.find(b => b.slot === first.slot).id]);
});

test('race 3: a revive that finds its slot taken under the lock leaves the session rejected', async () => {
  const s = await scene();
  const first = eatSlot(10 * 24 * HOUR);
  const { bookings, second } = await rejectedGroup(s, first);
  const groupId = (await db('TrainerBooking').where({ id: bookings[0].id }).first()).groupId;
  const other = await book(s, await user('member'), [second]);
  let seen = null;
  const out = await createPgTrainerSlotStore({ db }).moveGroup({
    groupId,
    decide: (group, taken) => {
      seen = Object.fromEntries(taken);
      return { error: 'group_slot_rebooked', status: 409, bookingIds: [...taken.keys()] };
    },
  });
  const takenId = bookings.find(b => b.slot === second.slot).id;
  assert.deepEqual(seen, { [takenId]: other.bookings[0].id });
  assert.deepEqual(out, { error: 'group_slot_rebooked', status: 409, bookingIds: [takenId] });
  assert.deepEqual(await Promise.all(bookings.map(b => statusOf(b.id))), ['payment_rejected', 'payment_rejected']);
});
