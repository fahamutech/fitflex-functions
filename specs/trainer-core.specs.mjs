// Batch 5 — Trainer core (FitFlex App Issues 25.07.2026).
// C1: bookings validate the trainer's availability + reject double booking.
// C2: earnings derive from bookings + manual sessions.
// C3: today's sessions combine bookings and manually recorded sessions.
// A4: members can enquire / show interest in a trainer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrainerBookingService } from '../src/services/trainer-booking-service.mjs';
import { createTrainerEngagementService } from '../src/services/trainer-engagement-service.mjs';

function memStore(rows = []) {
  return {
    rows,
    async allAsync() { return rows.slice(); },
    async filterAsync(fn) { return rows.filter(fn); },
    async findAsync(fn) { return rows.find(fn) || null; },
    async findByIdAsync(id) { return rows.find((r) => r.id === id) || null; },
    async insertAsync(row) { rows.push(row); return row; },
    async updateByIdAsync(id, patch) {
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows[i] = { ...rows[i], ...patch };
      return rows[i] || null;
    },
  };
}

// 2099-05-04 is a Monday (far future, so the slot is never in the past).
const MONDAY = '2099-05-04';
const trainerFixture = {
  id: 'trn_1',
  userId: 'usr_trainer_1',
  displayName: 'Coach Asha',
  status: 'active',
  hourlyRateTzs: 20000,
  gymIds: ['gym_1'],
  availability: [
    { day: 'monday', gymId: 'gym_1', slots: ['09:00', '10:00'] },
  ],
};

function makeBookingService({ bookings = [], sessions = [], trainer = trainerFixture } = {}) {
  const trainerBookings = memStore(bookings);
  const trainerSessions = memStore(sessions);
  const service = createTrainerBookingService({
    trainerBookings,
    trainerSessions,
    trainers: {
      find: (fn) => [trainer].find(fn) || null,
      ...memStore([trainer]),
    },
    gyms: [{ id: 'gym_1', name: 'Gym One', tier: 'standard' }],
    users: memStore([{ id: 'usr_m1', displayName: 'Member One' }]),
    auditLog: { insert: () => {}, insertAsync: async () => {} },
    trainerService: {
      hydrateTrainer: (t) => t,
      findProfileByUser: (uid) => (trainer.userId === uid ? trainer : null),
    },
  });
  return { service, trainerBookings, trainerSessions };
}

// ───────────────────── C1: slot validation ─────────────────────

test('C1: booking an available slot succeeds', async () => {
  const { service } = makeBookingService();
  const out = await service.createBooking({
    memberId: 'usr_m1',
    body: { trainerId: 'trn_1', gymId: 'gym_1', date: MONDAY, slot: '09:00' },
  });
  assert.ok(!out.error, JSON.stringify(out));
  assert.equal(out.booking.status, 'confirmed');
});

test('C1: booking a slot outside availability is rejected', async () => {
  const { service } = makeBookingService();
  const out = await service.createBooking({
    memberId: 'usr_m1',
    body: { trainerId: 'trn_1', gymId: 'gym_1', date: MONDAY, slot: '15:00' },
  });
  assert.equal(out.status, 409);
  assert.equal(out.error, 'slot_not_available');
});

test('C1: booking a day the trainer is not available is rejected', async () => {
  const { service } = makeBookingService();
  const out = await service.createBooking({
    memberId: 'usr_m1',
    body: { trainerId: 'trn_1', gymId: 'gym_1', date: '2099-05-05', slot: '09:00' },
  });
  assert.equal(out.status, 409);
  assert.equal(out.error, 'slot_not_available');
});

test('C1: double-booking the same slot is rejected', async () => {
  const { service } = makeBookingService();
  const first = await service.createBooking({
    memberId: 'usr_m1',
    body: { trainerId: 'trn_1', gymId: 'gym_1', date: MONDAY, slot: '09:00' },
  });
  assert.ok(!first.error);
  const second = await service.createBooking({
    memberId: 'usr_m2',
    body: { trainerId: 'trn_1', gymId: 'gym_1', date: MONDAY, slot: '09:00' },
  });
  assert.equal(second.status, 409);
  assert.equal(second.error, 'slot_already_booked');
});

test('C1: a cancelled booking frees the slot', async () => {
  const { service, trainerBookings } = makeBookingService();
  const first = await service.createBooking({
    memberId: 'usr_m1',
    body: { trainerId: 'trn_1', gymId: 'gym_1', date: MONDAY, slot: '09:00' },
  });
  await trainerBookings.updateByIdAsync(first.booking.id, { status: 'cancelled' });
  const second = await service.createBooking({
    memberId: 'usr_m2',
    body: { trainerId: 'trn_1', gymId: 'gym_1', date: MONDAY, slot: '09:00' },
  });
  assert.ok(!second.error, JSON.stringify(second));
});

test('C1: trainers with no configured availability accept any slot (legacy)', async () => {
  const { service } = makeBookingService({
    trainer: { ...trainerFixture, availability: [] },
  });
  const out = await service.createBooking({
    memberId: 'usr_m1',
    body: { trainerId: 'trn_1', gymId: 'gym_1', date: MONDAY, slot: '23:00' },
  });
  assert.ok(!out.error, JSON.stringify(out));
});

// ───────────────────── C3: sessions ─────────────────────

test('C3: today\'s sessions combine bookings and manual sessions', async () => {
  const { service } = makeBookingService();
  await service.createBooking({
    memberId: 'usr_m1',
    body: { trainerId: 'trn_1', gymId: 'gym_1', date: MONDAY, slot: '09:00' },
  });
  const manual = await service.createManualSession({
    userId: 'usr_trainer_1',
    body: { customerName: 'Walk-in Client', customerPhone: '+255700000001', gymId: 'gym_1', date: MONDAY, slot: '11:00', amountTzs: 15000 },
  });
  assert.ok(!manual.error, JSON.stringify(manual));

  const out = await service.trainerSessionsForDate({ userId: 'usr_trainer_1', date: MONDAY });
  assert.ok(!out.error);
  assert.equal(out.sessions.length, 2);
  const sources = out.sessions.map((s) => s.source).sort();
  assert.deepEqual(sources, ['booking', 'manual']);
});

test('C3: manual session requires a customer contact', async () => {
  const { service } = makeBookingService();
  const out = await service.createManualSession({
    userId: 'usr_trainer_1',
    body: { gymId: 'gym_1', date: MONDAY },
  });
  assert.equal(out.status, 400);
  assert.equal(out.error, 'customer_contact_required');
});

test('C3: manual sessions retain an explicitly named other location', async () => {
  const { service } = makeBookingService();
  const result = await service.createManualSession({
    userId: 'usr_trainer_1',
    body: {
      customerName: 'Beach client', date: MONDAY, locationType: 'other_location',
      locationLabel: 'Coco Beach', amountTzs: 20000,
    },
  });
  assert.equal(result.error, undefined);
  const sessions = await service.trainerSessionsForDate({ userId: 'usr_trainer_1', date: MONDAY });
  assert.equal(sessions.sessions[0].locationType, 'other_location');
  assert.equal(sessions.sessions[0].locationLabel, 'Coco Beach');
});

// ───────────────────── C2: earnings ─────────────────────

test('C2: earnings sum confirmed/completed bookings plus manual sessions', async () => {
  const { service } = makeBookingService();
  await service.createBooking({
    memberId: 'usr_m1',
    body: { trainerId: 'trn_1', gymId: 'gym_1', date: MONDAY, slot: '09:00' },
  });
  await service.createBooking({
    memberId: 'usr_m2',
    body: { trainerId: 'trn_1', gymId: 'gym_1', date: MONDAY, slot: '10:00' },
  });
  await service.createManualSession({
    userId: 'usr_trainer_1',
    body: { customerName: 'Walk-in', customerPhone: '+255700000002', date: MONDAY, amountTzs: 15000 },
  });

  const out = await service.trainerEarnings({ userId: 'usr_trainer_1' });
  assert.ok(!out.error);
  // 2 bookings × 17,000 (20,000 less 15% commission) + 1 manual × 15,000
  assert.equal(out.earnings.totalTzs, 49000);
  assert.equal(out.earnings.bookingCount, 2);
  assert.equal(out.earnings.manualSessionCount, 1);
});

test('C2: cancelled bookings do not count towards earnings', async () => {
  const { service, trainerBookings } = makeBookingService();
  const b = await service.createBooking({
    memberId: 'usr_m1',
    body: { trainerId: 'trn_1', gymId: 'gym_1', date: MONDAY, slot: '09:00' },
  });
  await trainerBookings.updateByIdAsync(b.booking.id, { status: 'cancelled' });
  const out = await service.trainerEarnings({ userId: 'usr_trainer_1' });
  assert.equal(out.earnings.totalTzs, 0);
});

// ───────────────────── A4: enquiries + interest ─────────────────────

function makeEngagementService() {
  const trainerEngagements = memStore();
  const service = createTrainerEngagementService({
    trainerEngagements,
    trainers: { find: (fn) => [trainerFixture].find(fn) || null },
    users: memStore([{ id: 'usr_m1', displayName: 'Member One', phone: '+255700000009' }]),
    trainerService: { findProfileByUser: (uid) => (trainerFixture.userId === uid ? trainerFixture : null) },
  });
  return { service, trainerEngagements };
}

test('A4: a member can send an enquiry to a trainer', async () => {
  const { service } = makeEngagementService();
  const out = await service.create({
    memberId: 'usr_m1',
    trainerId: 'trn_1',
    type: 'enquiry',
    message: 'Do you offer morning sessions?',
  });
  assert.ok(!out.error, JSON.stringify(out));
  assert.equal(out.engagement.type, 'enquiry');
  assert.equal(out.engagement.status, 'new');
});

test('A4: an enquiry requires a message', async () => {
  const { service } = makeEngagementService();
  const out = await service.create({ memberId: 'usr_m1', trainerId: 'trn_1', type: 'enquiry' });
  assert.equal(out.status, 400);
  assert.equal(out.error, 'message_required');
});

test('A4: showing interest is idempotent per member/trainer', async () => {
  const { service, trainerEngagements } = makeEngagementService();
  const first = await service.create({ memberId: 'usr_m1', trainerId: 'trn_1', type: 'interest' });
  assert.ok(!first.error);
  const second = await service.create({ memberId: 'usr_m1', trainerId: 'trn_1', type: 'interest' });
  assert.ok(!second.error);
  assert.equal(second.idempotent, true);
  assert.equal(trainerEngagements.rows.filter((r) => r.type === 'interest').length, 1);
});

test('A4: unknown trainer is rejected', async () => {
  const { service } = makeEngagementService();
  const out = await service.create({ memberId: 'usr_m1', trainerId: 'trn_nope', type: 'interest' });
  assert.equal(out.status, 404);
});

test('A4: the trainer sees their engagements with member context', async () => {
  const { service } = makeEngagementService();
  await service.create({ memberId: 'usr_m1', trainerId: 'trn_1', type: 'enquiry', message: 'Hi!' });
  const out = await service.listForTrainer({ userId: 'usr_trainer_1' });
  assert.ok(!out.error);
  assert.equal(out.engagements.length, 1);
  assert.equal(out.engagements[0].member?.displayName, 'Member One');
});

// ───────────────── Paid multi-slot bookings (UAT #58) ─────────────────

function makePaidBookingService({ passTier = null } = {}) {
  const trainerBookings = memStore();
  const paymentRequests = memStore();
  const events = [];
  const service = createTrainerBookingService({
    trainerBookings,
    trainerSessions: memStore(),
    trainers: { find: (fn) => [trainerFixture].find(fn) || null, ...memStore([trainerFixture]) },
    gyms: [{ id: 'gym_1', name: 'Gym One', tier: 'standard' }],
    users: memStore([{ id: 'usr_m1', displayName: 'Member One' }]),
    auditLog: { insert: () => {}, insertAsync: async () => {} },
    trainerService: {
      hydrateTrainer: (t) => t,
      findProfileByUser: (uid) => (trainerFixture.userId === uid ? trainerFixture : null),
    },
    subscriptions: memStore(passTier ? [{ id: 's1', memberId: 'usr_m1', type: 'platform_pass', tier: passTier, status: 'active' }] : []),
    paymentRequests,
    notify: async (event, payload) => { events.push({ event, payload }); },
  });
  return { service, trainerBookings, paymentRequests, events };
}

const TWO_SLOTS = { trainerId: 'trn_1', gymId: 'gym_1', slots: [{ date: MONDAY, slot: '10:00' }, { date: MONDAY, slot: '09:00' }] };

test('quote prices several slots with the Pass discount and writes nothing', async () => {
  const { service, trainerBookings } = makePaidBookingService({ passTier: 'premium' });
  const out = await service.quoteBooking({ memberId: 'usr_m1', body: TWO_SLOTS });
  assert.ok(!out.error, JSON.stringify(out));
  assert.equal(out.summary.subtotal, 40_000);
  assert.equal(out.summary.discountPct, 20);
  assert.equal(out.summary.total, 32_000);
  assert.deepEqual(out.summary.slots.map(s => s.slot), ['09:00', '10:00']);
  assert.equal(trainerBookings.rows.length, 0);
});

test('booking several slots creates one payment request and holds them payment_pending', async () => {
  const { service, trainerBookings, paymentRequests, events } = makePaidBookingService({ passTier: 'pro' });
  const out = await service.createBooking({ memberId: 'usr_m1', body: TWO_SLOTS });
  assert.ok(!out.error, JSON.stringify(out));
  assert.equal(trainerBookings.rows.length, 2);
  assert.ok(trainerBookings.rows.every(b => b.status === 'payment_pending' && b.groupId === out.bookingGroupId));
  // Pro: the member pays 20,000 − 10% = 18,000. FitFlex funds the discount, so
  // the trainer earns on the full 20,000: 15% commission = 3,000, payout 17,000.
  assert.equal(trainerBookings.rows[0].amountTzs, 18_000);
  assert.equal(trainerBookings.rows[0].trainerPayoutTzs, 17_000);
  assert.equal(trainerBookings.rows[0].discountFundedBy, 'fitflex');
  assert.equal(paymentRequests.rows.length, 1);
  assert.equal(paymentRequests.rows[0].amountTzs, 36_000);
  assert.equal(paymentRequests.rows[0].bookingGroupId, out.bookingGroupId);
  assert.equal(events[0].event, 'trainer_booking_requested');
});

test('a pending booking holds its slots; a rejected payment frees them', async () => {
  const { service } = makePaidBookingService();
  const first = await service.createBooking({ memberId: 'usr_m1', body: TWO_SLOTS });
  const clash = await service.createBooking({ memberId: 'usr_m2', body: { ...TWO_SLOTS, slots: [{ date: MONDAY, slot: '09:00' }] } });
  assert.equal(clash.error, 'slot_already_booked');
  await service.applyPaymentToGroup(first.bookingGroupId, 'rejected');
  const retry = await service.createBooking({ memberId: 'usr_m2', body: { ...TWO_SLOTS, slots: [{ date: MONDAY, slot: '09:00' }] } });
  assert.ok(!retry.error, JSON.stringify(retry));
});

test('approving the payment confirms every slot and notifies', async () => {
  const { service, trainerBookings, events } = makePaidBookingService();
  const out = await service.createBooking({ memberId: 'usr_m1', body: TWO_SLOTS });
  await service.applyPaymentToGroup(out.bookingGroupId, 'approved');
  assert.ok(trainerBookings.rows.every(b => b.status === 'confirmed'));
  assert.equal(events.at(-1).event, 'trainer_booking_confirmed');
  const earnings = await service.trainerEarnings({ userId: 'usr_trainer_1' });
  assert.equal(earnings.earnings.bookingTzs, 2 * 17_000);
});

test('unpaid bookings do not count towards earnings', async () => {
  const { service } = makePaidBookingService();
  await service.createBooking({ memberId: 'usr_m1', body: TWO_SLOTS });
  const earnings = await service.trainerEarnings({ userId: 'usr_trainer_1' });
  assert.equal(earnings.earnings.totalTzs, 0);
});

test('a free session (no rate) is confirmed without a payment request', async () => {
  const { service, trainerBookings, paymentRequests } = makePaidBookingService();
  trainerFixture.hourlyRateTzs = 0;
  try {
    const out = await service.createBooking({ memberId: 'usr_m1', body: TWO_SLOTS });
    assert.ok(!out.error, JSON.stringify(out));
    assert.ok(trainerBookings.rows.every(b => b.status === 'confirmed'));
    assert.equal(paymentRequests.rows.length, 0);
    assert.equal(out.paymentRequest, null);
  } finally {
    trainerFixture.hourlyRateTzs = 20000;
  }
});
