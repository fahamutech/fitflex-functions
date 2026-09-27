// Trainer interface — pure rules: trainer-pass options + member-plan fallback,
// social handles, availability cleaning and the dated schedule (EAT).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTrainerPassConfig, trainerPassOptions, trainerGymAccess, hideTrainerPass, canSeeTrainerPass,
  normalizeSocialHandle, normalizeSocialLinks,
  normalizeAvailability, buildTrainerSchedule, isPastSlot, eatToday,
} from '../src/shared/trainer-access.mjs';
import { createGymService } from '../src/services/gym-service.mjs';
import { createTrainerBookingService, slotIsAvailable } from '../src/services/trainer-booking-service.mjs';

// ── Trainer passes ──

test('trainer pass: daily/weekly/monthly options keep only positive fees', () => {
  assert.deepEqual(
    normalizeTrainerPassConfig({ enabled: true, options: { daily: 8000, weekly: '40000', monthly: 0, yearly: 9 } }),
    { enabled: true, options: { daily: 8000, weekly: 40000 } },
  );
});

test('trainer pass: the legacy single-period shape reads as one option', () => {
  assert.deepEqual(
    normalizeTrainerPassConfig({ enabled: true, feeTzs: 50000, period: 'monthly' }),
    { enabled: true, options: { monthly: 50000 } },
  );
});

test('trainer pass: a disabled pass offers nothing', () => {
  assert.deepEqual(trainerPassOptions({ trainerPass: { enabled: false, options: { daily: 8000 } } }), []);
});

test('gym payload stores options and mirrors the first as feeTzs/period for older apps', () => {
  const gyms = createGymService({
    gyms: { find: () => null, filter: () => [] }, users: {}, checkins: {}, auditLog: { insertAsync: async () => {} },
  });
  const row = gyms.normalizeGymPayload({ name: 'G', trainerPass: { enabled: true, options: { weekly: 40000, monthly: 120000 } } }, {});
  assert.deepEqual(row.trainerPass, { enabled: true, options: { weekly: 40000, monthly: 120000 }, feeTzs: 40000, period: 'weekly' });
  const kept = gyms.normalizeGymPayload({ location: 'New' }, row);
  assert.deepEqual(kept.trainerPass.options, { weekly: 40000, monthly: 120000 });
});

const passGym = { id: 'g_pass', trainerPass: { enabled: true, options: { daily: 8000 } }, ratePerDay: 5000 };
const planGym = { id: 'g_plan', ratePerDay: 5000, ratePerMonth: 90000 };
const bareGym = { id: 'g_bare' };

test('access: linked gym is free, trainer pass wins over member plans, else member plans, else unavailable', () => {
  const trainer = { gymIds: ['g_pass'] };
  assert.equal(trainerGymAccess({ trainer, gym: passGym }).access, 'home');
  assert.deepEqual(trainerGymAccess({ trainer: null, gym: passGym }), {
    access: 'trainer_pass', options: [{ kind: 'trainer_pass', period: 'daily', feeTzs: 8000 }],
  });
  assert.deepEqual(trainerGymAccess({ trainer, gym: planGym }).options.map(o => o.period), ['daily', 'monthly']);
  assert.equal(trainerGymAccess({ trainer, gym: planGym }).access, 'member_plan');
  assert.equal(trainerGymAccess({ trainer, gym: bareGym }).access, 'unavailable');
});

test('visibility: only trainers and admins see trainerPass', () => {
  assert.equal(hideTrainerPass(passGym).trainerPass, undefined);
  assert.equal(hideTrainerPass(passGym).ratePerDay, 5000);
  assert.equal(hideTrainerPass(null), null);
  assert.equal(canSeeTrainerPass('trainer'), true);
  assert.equal(canSeeTrainerPass('admin'), true);
  assert.equal(canSeeTrainerPass('member'), false);
  assert.equal(canSeeTrainerPass('gym_operator'), false);
  assert.equal(canSeeTrainerPass(undefined), false);
});

// ── Social handles ──

test('social: handles, @handles and profile URLs reduce to the bare handle', () => {
  assert.equal(normalizeSocialHandle('instagram', '@coach.asha'), 'coach.asha');
  assert.equal(normalizeSocialHandle('instagram', 'https://www.instagram.com/coach.asha/?hl=en'), 'coach.asha');
  assert.equal(normalizeSocialHandle('twitter', 'x.com/coach_asha'), 'coach_asha');
  assert.equal(normalizeSocialHandle('facebook', 'https://facebook.com/profile.php?id=100012345'), 'profile.php?id=100012345');
  assert.equal(normalizeSocialHandle('instagram', '  '), '');
});

test('social: other sites and invalid characters are rejected', () => {
  assert.equal(normalizeSocialHandle('instagram', 'https://evil.example/coach'), null);
  assert.equal(normalizeSocialHandle('twitter', 'coach asha'), null);
  assert.deepEqual(
    normalizeSocialLinks({ instagram: '@ok', facebook: '', twitter: 'bad handle!', tiktok: 'x' }),
    { links: { instagram: 'ok' }, invalid: ['twitter'] },
  );
});

// ── Availability + schedule ──

test('availability: legacy date entries, short weekdays and loose times are cleaned', () => {
  assert.deepEqual(normalizeAvailability([
    { date: '2099-05-05', slots: ['9:00', '09:00', '17:00'] },
    { day: 'Mon', gymId: 'g1', slots: ['06:00', 'noon'] },
    { day: 'someday', slots: ['07:00'] },
    { day: 'friday', slots: [] },
  ]), [
    { day: '2099-05-05', slots: ['09:00', '17:00'] },
    { day: 'monday', gymId: 'g1', slots: ['06:00'] },
  ]);
});

test('slotIsAvailable matches legacy { date } entries and unpadded times', () => {
  assert.equal(slotIsAvailable([{ date: '2099-05-05', slots: ['09:00'] }], { date: '2099-05-05', slot: '9:00' }), true);
  assert.equal(slotIsAvailable([{ day: 'tue', slots: ['09:00'] }], { date: '2099-05-05', slot: '09:00' }), true);
  assert.equal(slotIsAvailable([{ day: 'monday', slots: ['09:00'] }], { date: '2099-05-05', slot: '09:00' }), false);
});

test('isPastSlot uses EAT (UTC+3)', () => {
  const now = new Date('2099-05-04T06:30:00Z'); // 09:30 EAT
  assert.equal(isPastSlot('2099-05-04', '09:00', now), true);
  assert.equal(isPastSlot('2099-05-04', '10:00', now), false);
  assert.equal(eatToday(new Date('2099-05-04T22:00:00Z')), '2099-05-05');
});

test('schedule: weekly hours expand to dated slots with available/booked/past', () => {
  const now = new Date('2099-05-04T06:30:00Z'); // Monday 09:30 EAT
  const days = buildTrainerSchedule({
    availability: [
      { day: 'monday', gymId: 'g1', slots: ['09:00', '10:00', '11:00'] },
      { day: 'tuesday', gymId: 'g2', slots: ['07:00'] },
    ],
    bookings: [{ date: '2099-05-04', slot: '11:00', memberId: 'm1' }],
    days: 8,
    now,
    describeBooking: (b) => ({ memberId: b.memberId }),
  });
  assert.equal(days.length, 8);
  assert.equal(days[0].date, '2099-05-04');
  assert.deepEqual(days[0].slots.map(s => [s.slot, s.status]), [['09:00', 'past'], ['10:00', 'available'], ['11:00', 'booked']]);
  assert.deepEqual(days[0].slots[2].booking, { memberId: 'm1' });
  assert.deepEqual(days[1].slots, [{ slot: '07:00', status: 'available', gymIds: ['g2'] }]);
  assert.deepEqual(days[2].slots, []);
  assert.equal(days[7].weekday, 'monday');
});

test('schedule: gym filter, no dates before today, and a 31-day cap', () => {
  const now = new Date('2099-05-04T00:00:00Z');
  const availability = [{ day: 'monday', gymId: 'g1', slots: ['09:00'] }, { day: 'monday', gymId: 'g2', slots: ['18:00'] }];
  const g2 = buildTrainerSchedule({ availability, gymId: 'g2', days: 1, now });
  assert.deepEqual(g2[0].slots.map(s => s.slot), ['18:00']);
  assert.equal(buildTrainerSchedule({ availability, from: '2020-01-01', days: 1, now })[0].date, '2099-05-04');
  assert.equal(buildTrainerSchedule({ availability, days: 400, now }).length, 31);
});

// ── Booking service ──

function memStore(rows = []) {
  return {
    rows,
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

const trainer = {
  id: 'trn_s', userId: 'usr_trn_s', status: 'active', hourlyRateTzs: 0, gymIds: ['g1'],
  availability: [{ day: 'monday', gymId: 'g1', slots: ['09:00', '10:00'] }],
};

function bookingService(bookings = []) {
  return createTrainerBookingService({
    trainerBookings: memStore(bookings),
    trainerSessions: memStore(),
    trainers: { find: (fn) => [trainer].find(fn) || null },
    gyms: [{ id: 'g1', name: 'G1', trainerPass: { enabled: true, options: { daily: 1 } } }],
    users: memStore([{ id: 'usr_m', displayName: 'Member M', email: 'm@example.com', phone: '+255700' }]),
    auditLog: { insertAsync: async () => {} },
    trainerService: { hydrateTrainer: (t) => t, findProfileByUser: (uid) => (uid === trainer.userId ? trainer : null) },
  });
}

test('booking: a slot that has already started is rejected', async () => {
  const out = await bookingService().createBooking({
    memberId: 'usr_m', body: { trainerId: 'trn_s', gymId: 'g1', date: '2020-01-06', slot: '09:00' },
  });
  assert.equal(out.status, 400);
  assert.equal(out.error, 'slot_in_past');
});

test('booking: members get the gym without trainer-pass pricing', async () => {
  const svc = bookingService();
  const out = await svc.createBooking({ memberId: 'usr_m', body: { trainerId: 'trn_s', gymId: 'g1', date: '2099-05-04', slot: '09:00' } });
  assert.equal(out.error, undefined, JSON.stringify(out));
  const mine = await svc.memberMyBookings('usr_m');
  assert.equal(mine[0].gym.trainerPass, undefined);
});

test('schedule: the public view hides who booked; the trainer view shows them', async () => {
  const svc = bookingService([
    { id: 'b1', trainerId: 'trn_s', memberId: 'usr_m', gymId: 'g1', date: '2099-05-04', slot: '10:00', status: 'confirmed' },
    { id: 'b2', trainerId: 'trn_s', memberId: 'usr_m', gymId: 'g1', date: '2099-05-04', slot: '09:00', status: 'cancelled' },
  ]);
  const pub = await svc.publicSchedule({ trainerId: 'trn_s', from: '2099-05-04', days: 1 });
  assert.deepEqual(pub.days[0].slots.map(s => [s.slot, s.status]), [['09:00', 'available'], ['10:00', 'booked']]);
  assert.equal(pub.days[0].slots[1].booking, undefined);
  assert.equal(JSON.stringify(pub).includes('Member M'), false);

  const own = await svc.trainerSchedule({ userId: 'usr_trn_s', from: '2099-05-04', days: 1 });
  assert.deepEqual(own.days[0].slots[1].booking.member, { id: 'usr_m', displayName: 'Member M', photoUrl: null });
  assert.equal(JSON.stringify(own).includes('m@example.com'), false, 'no email/phone in the trainer view');

  assert.equal((await svc.publicSchedule({ trainerId: 'nope' })).status, 404);
});
