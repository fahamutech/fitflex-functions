import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authRequestOtp, authVerifyOtp, trainerRegister } from '../functions/index.mjs';

function res() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function createTrainerUser(phone) {
  const otpRes = res();
  authRequestOtp.onRequest({ body: { phone, userType: 'trainer' } }, otpRes);
  const code = otpRes.body.devOtp;

  const verifyRes = res();
  authVerifyOtp.onRequest({ body: { phone, code } }, verifyRes);
  return verifyRes.body.user;
}

test('trainerRegister: rejects when photoUrl (picture) is missing', () => {
  const user = createTrainerUser(`+255700000${Date.now().toString().slice(-4)}`);
  const out = res();
  trainerRegister.onRequest({
    user: { sub: user.id, userType: 'trainer' },
    body: {
      displayName: 'Amina Trainer',
      gender: 'female',
      bio: 'Yoga specialist',
      hourlyRateTzs: 15000,
      specialties: ['yoga'],
    }
  }, out);
  assert.equal(out.statusCode, 400);
  assert.ok(out.body.error.includes('photoUrl'));
});

test('trainerRegister: rejects when gender is missing', () => {
  const user = createTrainerUser(`+255700001${Date.now().toString().slice(-4)}`);
  const out = res();
  trainerRegister.onRequest({
    user: { sub: user.id, userType: 'trainer' },
    body: {
      displayName: 'Amina Trainer',
      photoUrl: 'https://example.com/photo.jpg',
      bio: 'Yoga specialist',
      hourlyRateTzs: 15000,
      specialties: ['yoga'],
    }
  }, out);
  assert.equal(out.statusCode, 400);
  assert.ok(out.body.error.includes('gender'));
});

test('trainerRegister: rejects when gender value is invalid', () => {
  const user = createTrainerUser(`+255700002${Date.now().toString().slice(-4)}`);
  const out = res();
  trainerRegister.onRequest({
    user: { sub: user.id, userType: 'trainer' },
    body: {
      displayName: 'Amina Trainer',
      photoUrl: 'https://example.com/photo.jpg',
      gender: 'unknown',
      bio: 'Yoga specialist',
      hourlyRateTzs: 15000,
      specialties: ['yoga'],
    }
  }, out);
  assert.equal(out.statusCode, 400);
  assert.ok(out.body.error.includes('gender'));
});

test('trainerRegister: succeeds with photoUrl and gender present', () => {
  const user = createTrainerUser(`+255700003${Date.now().toString().slice(-4)}`);
  const out = res();
  trainerRegister.onRequest({
    user: { sub: user.id, userType: 'trainer' },
    body: {
      displayName: 'Baraka Kocha',
      photoUrl: 'https://example.com/baraka.jpg',
      gender: 'male',
      bio: 'Strength and conditioning coach',
      hourlyRateTzs: 20000,
      specialties: ['weight_training', 'cardio'],
    }
  }, out);
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.displayName, 'Baraka Kocha');
  assert.equal(out.body.photoUrl, 'https://example.com/baraka.jpg');
  assert.equal(out.body.gender, 'male');
  assert.equal(out.body.approvalStatus, 'pending_approval');
});

test('trainerRegister: stores gender in profile and returns it', () => {
  const user = createTrainerUser(`+255700004${Date.now().toString().slice(-4)}`);
  const out = res();
  trainerRegister.onRequest({
    user: { sub: user.id, userType: 'trainer' },
    body: {
      displayName: 'Fatuma Kocha',
      photoUrl: 'https://example.com/fatuma.jpg',
      gender: 'female',
      bio: 'Pilates expert',
      hourlyRateTzs: 18000,
      specialties: ['pilates'],
    }
  }, out);
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.gender, 'female');
});
