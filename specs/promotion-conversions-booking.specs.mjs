// The booking service tells promotion analytics when a booking request starts or stops
// counting: confirmed (free, or its payment approved) is a conversion; rejected,
// cancelled or refunded is not. In-memory, with a spy in place of analytics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrainerBookingService } from '../src/services/trainer-booking-service.mjs';
import { createPromotionEventsService } from '../src/services/promotion-events-service.mjs';

function memStore(rows = []) {
  return {
    rows,
    find(fn) { return rows.find(fn) || null; },
    async allAsync() { return rows; },
    async filterAsync(fn) { return rows.filter(fn); },
    async findAsync(fn) { return rows.find(fn) || null; },
    async findByIdAsync(id) { return rows.find(r => r.id === id) || null; },
    async insertAsync(row) { rows.push(row); return row; },
    async updateByIdAsync(id, patch) { const i = rows.findIndex(r => r.id === id); if (i >= 0) rows[i] = { ...rows[i], ...patch }; return rows[i] || null; },
  };
}
const HOUR = 3_600_000;
const slotIn = hours => { const eat = new Date(Date.now() + hours * HOUR + 3 * HOUR); return { date: eat.toISOString().slice(0, 10), slot: eat.toISOString().slice(11, 16) }; };

function fixture({ hook, rate = 0 } = {}) {
  const calls = [];
  const trainerBookings = memStore();
  const paymentRequests = memStore();
  const trainer = { id: 'trn_c', userId: 'usr_trn_c', status: 'active', hourlyRateTzs: rate, gymIds: ['g1'], displayName: 'Coach C', availability: [] };
  const svc = createTrainerBookingService({
    trainerBookings, trainerSessions: memStore(), trainers: { find: fn => [trainer].find(fn) || null },
    gyms: [{ id: 'g1', name: 'G1', trainerPass: { enabled: true, options: { daily: 1 } } }],
    users: memStore([{ id: 'm1', displayName: 'Member' }]), auditLog: { insertAsync: async () => {} }, paymentRequests,
    trainerService: { hydrateTrainer: t => t, findProfileByUser: uid => (uid === trainer.userId ? trainer : null) },
    onBookingConversion: hook !== undefined ? hook : (async c => { calls.push({ action: c.action, groupId: c.groupId, sessions: c.bookings.map(b => b.id) }); }),
  });
  /** Bookings already in a group, in the given statuses. */
  const seed = (groupId, statuses) => statuses.map((status, i) => {
    const row = { id: `${groupId}_${i}`, groupId, memberId: 'm1', trainerId: 'trn_c', gymId: 'g1', ...slotIn(48 + i), amountTzs: 20000, status, createdAt: new Date().toISOString() };
    trainerBookings.rows.push(row);
    return row;
  });
  return { svc, calls, trainerBookings, seed };
}

test('a session that needs no payment counts as soon as it is booked', async () => {
  const f = fixture();
  const out = await f.svc.createBooking({ memberId: 'm1', body: { trainerId: 'trn_c', gymId: 'g1', date: '2099-05-04', slot: '09:00' } });
  assert.equal(out.error, undefined, JSON.stringify(out));
  assert.deepEqual(f.calls.map(c => [c.action, c.sessions.length]), [['credit', 1]]);
  assert.equal(f.calls[0].groupId, out.bookingGroupId);
});

test('a paid booking counts only once its payment is approved, and not if it is rejected or cancelled', async () => {
  const f = fixture();
  f.seed('tbg_pay', ['payment_pending', 'payment_pending']);
  await f.svc.applyPaymentToGroup('tbg_pay', 'pending');
  assert.deepEqual(f.calls.map(c => c.action), ['reverse']);                                    // nothing confirmed: nothing to count
  await f.svc.applyPaymentToGroup('tbg_pay', 'approved');
  assert.deepEqual(f.calls.at(-1), { action: 'credit', groupId: 'tbg_pay', sessions: ['tbg_pay_0', 'tbg_pay_1'] });
  await f.svc.applyPaymentToGroup('tbg_pay', 'rejected');                                       // staff mark the payment bounced
  assert.equal(f.calls.at(-1).action, 'reverse');
  await f.svc.applyPaymentToGroup('tbg_pay', 'approved');
  assert.equal(f.calls.at(-1).action, 'credit');
  await f.svc.applyPaymentToGroup('tbg_pay', 'cancelled');
  assert.equal(f.calls.at(-1).action, 'reverse');
});

test('cancelling every session takes the booking back; cancelling one of two keeps it, valued by what is left', async () => {
  const f = fixture();
  f.seed('tbg_two', ['confirmed', 'confirmed']);
  const first = await f.svc.memberCancelBooking({ memberId: 'm1', bookingId: 'tbg_two_0' });
  assert.equal(first.error, undefined, JSON.stringify(first));
  assert.deepEqual(f.calls.at(-1), { action: 'credit', groupId: 'tbg_two', sessions: ['tbg_two_1'] });
  const second = await f.svc.memberCancelBooking({ memberId: 'm1', bookingId: 'tbg_two_1' });
  assert.equal(second.error, undefined, JSON.stringify(second));
  assert.equal(f.calls.at(-1).action, 'reverse');
});

test('the trainer or staff cancelling, or staff confirming, moves the booking in and out of the count', async () => {
  const f = fixture();
  f.seed('tbg_adm', ['payment_pending']);
  await f.svc.adminUpdateStatus({ id: 'tbg_adm_0', status: 'confirmed', actorId: 'admin_1' });
  assert.equal(f.calls.at(-1).action, 'credit');
  await f.svc.adminUpdateStatus({ id: 'tbg_adm_0', status: 'cancelled', actorId: 'admin_1' });
  assert.equal(f.calls.at(-1).action, 'reverse');
  f.seed('tbg_trn', ['confirmed']);
  await f.svc.trainerCancelBooking({ userId: 'usr_trn_c', bookingId: 'tbg_trn_0' });
  assert.deepEqual(f.calls.at(-1), { action: 'reverse', groupId: 'tbg_trn', sessions: ['tbg_trn_0'] });
});

test('a completed session still counts', async () => {
  const f = fixture();
  f.seed('tbg_done', ['completed']);
  await f.svc.applyPaymentToGroup('tbg_done', 'approved');                                       // completed rows are left as they are
  assert.deepEqual(f.calls.at(-1), { action: 'credit', groupId: 'tbg_done', sessions: ['tbg_done_0'] });
});

test('analytics failing never fails a booking', async () => {
  const f = fixture({ hook: async () => { throw new Error('analytics is down'); } });
  f.seed('tbg_safe', ['payment_pending']);
  const out = await f.svc.applyPaymentToGroup('tbg_safe', 'approved');
  assert.equal(out[0].status, 'confirmed');
  const booked = await f.svc.createBooking({ memberId: 'm1', body: { trainerId: 'trn_c', gymId: 'g1', date: '2099-05-04', slot: '10:00' } });
  assert.equal(booked.error, undefined, JSON.stringify(booked));
});

test('a service with no hook behaves exactly as before', async () => {
  const f = fixture({ hook: null });
  f.seed('tbg_none', ['payment_pending']);
  assert.equal((await f.svc.applyPaymentToGroup('tbg_none', 'approved'))[0].status, 'confirmed');
  assert.deepEqual(f.calls, []);
});

test('the analytics service never throws into a booking, even if its database is gone', async () => {
  const broken = createPromotionEventsService({ db: () => { throw new Error('database is down'); }, promotions: null });
  const bookings = [{ id: 'b', groupId: 'g', memberId: 'm1', trainerId: 't', amountTzs: 1, createdAt: new Date().toISOString() }];
  assert.deepEqual(await broken.recordBooking(bookings), { credited: 0 });
  assert.deepEqual(await broken.reverseBooking('g'), { reversed: 0 });
  assert.deepEqual(await broken.recordSubscription({ id: 's', memberId: 'm1', type: 'direct_sub', homeGymId: 'g' }), { credited: 0 });
  assert.deepEqual(await broken.reverseSubscription({ id: 's' }), { reversed: 0 });
});
