import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adminDeleteTrainer,
  adminListGymOwners,
  adminListTrainerBookings,
  adminListTrainers,
  adminUpdateTrainerBooking,
  adminUpsertGymOwner,
  adminUpsertTrainer,
  createTrainerBooking
} from '../functions/index.mjs';

function res() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('admin can create update and delete trainer profiles used by member discovery', () => {
  const suffix = Date.now();
  const created = res();
  adminUpsertTrainer.onRequest({
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
  adminUpsertTrainer.onRequest({
    user: { sub: 'usr_admin_1', userType: 'admin' },
    body: { id: created.body.id, displayName: `Updated Trainer ${suffix}`, hourlyRateTzs: 30000, status: 'suspended' }
  }, updated);
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.body.displayName, `Updated Trainer ${suffix}`);
  assert.equal(updated.body.hourlyRateTzs, 30000);

  const list = res();
  adminListTrainers.onRequest({}, list);
  assert.ok(list.body.some(t => t.id === created.body.id && t.gyms.length === 1));

  const deleted = res();
  adminDeleteTrainer.onRequest({
    user: { sub: 'usr_admin_1', userType: 'admin' },
    params: { id: created.body.id }
  }, deleted);
  assert.equal(deleted.statusCode, 200);
  assert.equal(deleted.body.ok, true);
});

test('admin can create and update gym owner assignments with unique email by role', () => {
  const suffix = Date.now();
  const created = res();
  adminUpsertGymOwner.onRequest({
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
  adminUpsertGymOwner.onRequest({
    user: { sub: 'usr_admin_1', userType: 'admin' },
    body: { id: created.body.id, displayName: 'Updated Gym Owner', accountStatus: 'suspended' }
  }, updated);
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.body.accountStatus, 'suspended');

  const conflict = res();
  adminUpsertGymOwner.onRequest({
    user: { sub: 'usr_admin_1', userType: 'admin' },
    body: { email: created.body.email, displayName: 'Duplicate Owner' }
  }, conflict);
  assert.equal(conflict.statusCode, 409);

  const list = res();
  adminListGymOwners.onRequest({}, list);
  assert.ok(list.body.some(owner => owner.id === created.body.id));
});

test('admin can list and update trainer booking status', () => {
  const booked = res();
  createTrainerBooking.onRequest({
    user: { sub: `usr_booking_${Date.now()}`, userType: 'member' },
    body: { trainerId: 'trn_ali', gymId: 'gym_001', date: '2026-05-10', slot: '09:00' }
  }, booked);
  assert.equal(booked.statusCode, 201);

  const list = res();
  adminListTrainerBookings.onRequest({}, list);
  assert.ok(list.body.some(booking => booking.id === booked.body.booking.id && booking.trainer));

  const updated = res();
  adminUpdateTrainerBooking.onRequest({
    user: { sub: 'usr_admin_1', userType: 'admin' },
    params: { id: booked.body.booking.id },
    body: { status: 'completed' }
  }, updated);
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.body.status, 'completed');
});
