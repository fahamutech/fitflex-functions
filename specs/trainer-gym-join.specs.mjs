// TDD — Trainers self-register (no gym) and then apply to join a specific gym from their
// trainer home screen. The gym owner reviews the pending request and approves or rejects it
// before the trainer is actually linked to (and visible at) that gym.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authRequestOtp, authVerifyOtp } from '../functions/auth.mjs';
import { updateMemberProfile } from '../functions/subscriptions.mjs';
import { trainerRegister, trainerApplyToGym, trainerCancelGymApplication } from '../functions/trainers.mjs';
import {
  ownerCreateGym,
  ownerPendingTrainers,
  ownerDecideTrainerJoin,
  ownerListTrainers,
} from '../functions/owner-gyms.mjs';

function res() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const uniq = (p) => `${p}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const uniqPhone = () => `+2557${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

async function createTrainerUser() {
  const phone = uniqPhone();
  const otpRes = res();
  authRequestOtp.onRequest({ body: { phone, userType: 'trainer' } }, otpRes);
  const verifyRes = res();
  await authVerifyOtp.onRequest({ body: { phone, code: otpRes.body.devOtp } }, verifyRes);
  return verifyRes.body.user;
}

async function registerTrainer(userId) {
  const out = res();
  await trainerRegister.onRequest({
    user: { sub: userId, userType: 'trainer' },
    body: {
      displayName: 'Join-Flow Trainer',
      photoUrl: 'https://example.com/photo.jpg',
      gender: 'female',
      bio: 'Strength coach',
      hourlyRateTzs: 15000,
      specialties: ['strength'],
    },
  }, out);
  assert.equal(out.statusCode, 200, `trainerRegister failed: ${JSON.stringify(out.body)}`);
  return out.body;
}

async function createOwnerWithGym() {
  const ownerId = uniq('usr_owner_join');
  const ownerOut = res();
  await updateMemberProfile.onRequest(
    { user: { sub: ownerId, userType: 'gym_operator' }, body: { displayName: 'Join Flow Owner', phone: uniqPhone() } },
    ownerOut,
  );
  assert.equal(ownerOut.statusCode, 200);
  const gymOut = res();
  await ownerCreateGym.onRequest(
    { user: { sub: ownerId, userType: 'gym_operator' }, body: { name: uniq('Join Flow Gym'), tier: 'standard', location: 'Dar es Salaam' } },
    gymOut,
  );
  assert.equal(gymOut.statusCode, 201, JSON.stringify(gymOut.body));
  return { ownerId, gym: gymOut.body };
}

test('trainer can apply to join a gym; owner sees it pending and approves it', async () => {
  const trainerUser = await createTrainerUser();
  await registerTrainer(trainerUser.id);
  const { ownerId, gym } = await createOwnerWithGym();

  const applyOut = res();
  await trainerApplyToGym.onRequest({ user: { sub: trainerUser.id, userType: 'trainer' }, params: { gymId: gym.id } }, applyOut);
  assert.equal(applyOut.statusCode, 201, JSON.stringify(applyOut.body));
  assert.ok(applyOut.body.pendingGymIds.includes(gym.id));
  assert.ok(!applyOut.body.gymIds.includes(gym.id), 'must not be linked until approved');

  const pendingOut = res();
  await ownerPendingTrainers.onRequest({ user: { sub: ownerId, userType: 'gym_operator' } }, pendingOut);
  assert.equal(pendingOut.statusCode, 200);
  assert.ok(pendingOut.body.some(t => t.id === applyOut.body.id));

  const decisionOut = res();
  await ownerDecideTrainerJoin.onRequest({
    user: { sub: ownerId, userType: 'gym_operator' },
    params: { trainerId: applyOut.body.id },
    body: { gymId: gym.id, decision: 'approve' },
  }, decisionOut);
  assert.equal(decisionOut.statusCode, 200, JSON.stringify(decisionOut.body));
  assert.ok(decisionOut.body.gymIds.includes(gym.id), 'trainer must be linked after approval');
  assert.ok(!decisionOut.body.pendingGymIds.includes(gym.id), 'no longer pending after approval');

  const listOut = res();
  await ownerListTrainers.onRequest({ user: { sub: ownerId, userType: 'gym_operator' } }, listOut);
  assert.ok(listOut.body.some(t => t.id === applyOut.body.id), 'approved trainer shows up in the owner roster');
});

test('owner can reject a pending gym join request', async () => {
  const trainerUser = await createTrainerUser();
  const profile = await registerTrainer(trainerUser.id);
  const { ownerId, gym } = await createOwnerWithGym();

  await trainerApplyToGym.onRequest({ user: { sub: trainerUser.id, userType: 'trainer' }, params: { gymId: gym.id } }, res());

  const decisionOut = res();
  await ownerDecideTrainerJoin.onRequest({
    user: { sub: ownerId, userType: 'gym_operator' },
    params: { trainerId: profile.id },
    body: { gymId: gym.id, decision: 'reject' },
  }, decisionOut);
  assert.equal(decisionOut.statusCode, 200);
  assert.ok(!decisionOut.body.gymIds.includes(gym.id));
  assert.ok(!decisionOut.body.pendingGymIds.includes(gym.id));
});

test('trainer can cancel a pending application before the owner decides', async () => {
  const trainerUser = await createTrainerUser();
  await registerTrainer(trainerUser.id);
  const { gym } = await createOwnerWithGym();

  const applyOut = res();
  await trainerApplyToGym.onRequest({ user: { sub: trainerUser.id, userType: 'trainer' }, params: { gymId: gym.id } }, applyOut);
  assert.equal(applyOut.statusCode, 201);

  const cancelOut = res();
  await trainerCancelGymApplication.onRequest({ user: { sub: trainerUser.id, userType: 'trainer' }, params: { gymId: gym.id } }, cancelOut);
  assert.equal(cancelOut.statusCode, 200);
  assert.ok(!cancelOut.body.pendingGymIds.includes(gym.id));
});

test('a gym owner cannot approve a request for a gym they do not own', async () => {
  const trainerUser = await createTrainerUser();
  const profile = await registerTrainer(trainerUser.id);
  const { gym } = await createOwnerWithGym();
  const { ownerId: otherOwnerId } = await createOwnerWithGym();

  await trainerApplyToGym.onRequest({ user: { sub: trainerUser.id, userType: 'trainer' }, params: { gymId: gym.id } }, res());

  const decisionOut = res();
  await ownerDecideTrainerJoin.onRequest({
    user: { sub: otherOwnerId, userType: 'gym_operator' },
    params: { trainerId: profile.id },
    body: { gymId: gym.id, decision: 'approve' },
  }, decisionOut);
  assert.equal(decisionOut.statusCode, 403);
  assert.equal(decisionOut.body.error, 'not_your_gym');
});

test('applying twice to the same gym is rejected as a duplicate', async () => {
  const trainerUser = await createTrainerUser();
  await registerTrainer(trainerUser.id);
  const { gym } = await createOwnerWithGym();

  await trainerApplyToGym.onRequest({ user: { sub: trainerUser.id, userType: 'trainer' }, params: { gymId: gym.id } }, res());
  const secondOut = res();
  await trainerApplyToGym.onRequest({ user: { sub: trainerUser.id, userType: 'trainer' }, params: { gymId: gym.id } }, secondOut);
  assert.equal(secondOut.statusCode, 409);
  assert.equal(secondOut.body.error, 'application_already_pending');
});
