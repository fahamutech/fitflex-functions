import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminDeleteTrainer, adminListTrainers, adminUpsertTrainer } from '../functions/trainers.mjs';
import { adminListGymOwners, adminUpsertGymOwner } from '../functions/admin-owners.mjs';
import { adminListTrainerBookings, adminUpdateTrainerBooking, createTrainerBooking } from '../functions/trainer-bookings.mjs';
import { updateMemberProfile } from '../functions/subscriptions.mjs';
import { ensureInit } from '../functions/index.mjs';

// Collections are primed from PostgreSQL asynchronously in the background
// (see ensureInit() in functions/index.mjs); this file's first test is fully
// synchronous, so without this await it can run before `gyms`/`trainers` are
// primed, causing spurious `not found` / empty-relation failures.
await ensureInit();

function res() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('admin can create update and delete trainer profiles used by member discovery', async () => {
  const suffix = Date.now();
  const created = res();
  await adminUpsertTrainer.onRequest({
    user: { sub: 'usr_admin_1', userType: 'admin' },
    body: {
      displayName: `CRUD Trainer ${suffix}`,
      email: `trainer-crud-${suffix}@example.com`,
      specialties: 'Strength, Mobility',
      bio: 'Pilot trainer profile',
      hourlyRateTzs: 24000,
      experienceYears: 5,
      gymIds: ['gym_001'],
      status: 'active',
      availability: [{ date: '2026-05-09', slots: ['09:00'] }]
    }
  }, created);

  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.body.specialties, ['Strength', 'Mobility']);

  const updated = res();
  await adminUpsertTrainer.onRequest({
    user: { sub: 'usr_admin_1', userType: 'admin' },
    body: { id: created.body.id, displayName: `Updated Trainer ${suffix}`, hourlyRateTzs: 30000, status: 'suspended' }
  }, updated);
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.body.displayName, `Updated Trainer ${suffix}`);
  assert.equal(updated.body.hourlyRateTzs, 30000);

  const list = res();
  await adminListTrainers.onRequest({}, list);
  assert.ok(list.body.some(t => t.id === created.body.id && t.gyms.length === 1));

  const deleted = res();
  await adminDeleteTrainer.onRequest({
    user: { sub: 'usr_admin_1', userType: 'admin' },
    params: { id: created.body.id }
  }, deleted);
  assert.equal(deleted.statusCode, 200);
  assert.equal(deleted.body.ok, true);
});

test('admin can create and update gym owner assignments with unique email by role', async () => {
  const suffix = Date.now();
  const created = res();
  await adminUpsertGymOwner.onRequest({
    user: { sub: 'usr_admin_1', userType: 'admin' },
    body: {
      email: `owner-crud-${suffix}@example.com`,
      displayName: 'CRUD Gym Owner',
      gymId: 'gym_001',
      approvalStatus: 'approved',
      accountStatus: 'active'
    }
  }, created);

  assert.equal(created.statusCode, 201);
  assert.equal(created.body.userType, 'gym_operator');
  assert.equal(created.body.gym?.id, 'gym_001');

  const updated = res();
  await adminUpsertGymOwner.onRequest({
    user: { sub: 'usr_admin_1', userType: 'admin' },
    body: { id: created.body.id, displayName: 'Updated Gym Owner', accountStatus: 'suspended' }
  }, updated);
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.body.accountStatus, 'suspended');

  const conflict = res();
  await adminUpsertGymOwner.onRequest({
    user: { sub: 'usr_admin_1', userType: 'admin' },
    body: { email: created.body.email, displayName: 'Duplicate Owner' }
  }, conflict);
  assert.equal(conflict.statusCode, 409);

  const list = res();
  await adminListGymOwners.onRequest({}, list);
  assert.ok(list.body.some(owner => owner.id === created.body.id));
});

test('admin can list and update trainer booking status', async () => {
  const memberId = `usr_booking_${Date.now()}`;
  await updateMemberProfile.onRequest({ user: { sub: memberId, userType: 'member' }, body: { displayName: 'Booking Member' } }, res());
  const booked = res();
  await createTrainerBooking.onRequest({
    user: { sub: memberId, userType: 'member' },
    body: { trainerId: 'trn_ali', gymId: 'gym_001', date: '2026-05-10', slot: '09:00' }
  }, booked);
  assert.equal(booked.statusCode, 201);

  const list = res();
  await adminListTrainerBookings.onRequest({}, list);
  assert.ok(list.body.some(booking => booking.id === booked.body.booking.id && booking.trainer));

  const updated = res();
  await adminUpdateTrainerBooking.onRequest({
    user: { sub: 'usr_admin_1', userType: 'admin' },
    params: { id: booked.body.booking.id },
    body: { status: 'completed' }
  }, updated);
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.body.status, 'completed');
});
