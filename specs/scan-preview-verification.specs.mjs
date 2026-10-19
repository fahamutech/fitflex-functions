// The scanner preview (POST /operator/verify-qr) must decide like the check-in
// itself: at a gym whose owner is not verified yet, a FitFlex Pass member is
// previewed as not eligible with reason gym_not_verified (the check-in then
// refuses with the same code), while the gym's own direct members and home
// trainers stay eligible. Also: one complete list of check-in refusal codes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCheckInService } from '../src/services/check-in-service.mjs';
import { createOperatorService } from '../src/services/operator-service.mjs';
import { issue as issueQr } from '../src/auth/qr-token.mjs';
import {
  CHECKIN_FAILURE, CHECKIN_REFUSAL_CODES, VERIFY_PREVIEW_REASONS, visitNeedsVerifiedGym,
} from '../src/shared/check-in-rules.mjs';

const col = (rows = []) => ({
  rows,
  find: (fn) => rows.find(fn),
  findByIdAsync: async (id) => rows.find(r => r.id === id) ?? null,
  filterAsync: async (fn) => rows.filter(fn),
  insertAsync: async (row) => { rows.push(row); return row; },
});

const TIERS = { pro: { price: 60_000, visitCap: 30, gymAccess: 'midtier', multiGymPerDay: true } };
const FAR = '2099-01-01T00:00:00Z';
const START = '2026-01-01T00:00:00Z';

function setup({ verified = false } = {}) {
  const users = col([{ id: 'pass_m' }, { id: 'own_m' }, { id: 'trainer_t' }, { id: 'nopass_m' }]);
  const gyms = col([{ id: 'g_new', name: 'New Gym', tier: 'standard' }]);
  const subscriptions = col([
    { id: 's_pass', memberId: 'pass_m', type: 'platform_pass', tier: 'pro', status: 'active', startedAt: START, cycleStartedAt: START, expiresAt: FAR },
    { id: 's_own', memberId: 'own_m', type: 'direct_sub', tier: null, homeGymId: 'g_new', status: 'active', startedAt: START, cycleStartedAt: START, expiresAt: FAR },
  ]);
  const checkins = col();
  const trainers = col([{ id: 'trainer_t', userId: 'trainer_t', status: 'active', gymIds: ['g_new'] }]);
  const asked = [];
  const gymOpenToPass = async (gymId) => { asked.push(gymId); return verified; };
  const getTierConfig = (t) => TIERS[t] ?? null;
  const checkInService = createCheckInService({ users, gyms, subscriptions, checkins, trainers, getTierConfig, gymOpenToPass });
  const operator = createOperatorService({
    users, gyms, subscriptions, checkins, checkInService,
    publicUserId: async (u) => `FF-${typeof u === 'string' ? u : u.id}`,
    settingsService: { getTierConfig, visitCapForTier: (t) => TIERS[t]?.visitCap ?? null },
    gymOpenToPass,
  });
  const scanner = { gymIds: ['g_new'] };
  const preview = async (memberId) => (await operator.verifyQr({ operator: scanner, gymId: 'g_new', qrToken: issueQr(memberId).token })).body;
  const checkIn = async (memberId) => (await operator.checkIn({ operator: scanner, gymId: 'g_new', qrToken: issueQr(memberId).token }));
  return { preview, checkIn, checkins, asked };
}

test('unverified gym: a FitFlex Pass member is previewed as gym_not_verified, and the check-in refuses the same way', async () => {
  const { preview, checkIn, checkins, asked } = setup();
  const p = await preview('pass_m');
  assert.equal(p.ok, true, 'response shape unchanged');
  assert.equal(p.eligible, false);
  assert.equal(p.reason, 'gym_not_verified');
  assert.deepEqual(p.subscription, { tier: 'pro', status: 'active' });
  assert.ok(asked.includes('g_new'));
  const c = await checkIn('pass_m');
  assert.equal(c.status, 409);
  assert.equal(c.body.failure, 'gym_not_verified');
  assert.equal(checkins.rows.length, 0);
});

test('unverified gym: a member with no pass is also told gym_not_verified (as the check-in would)', async () => {
  const { preview, checkIn } = setup();
  assert.equal((await preview('nopass_m')).reason, 'gym_not_verified');
  assert.equal((await checkIn('nopass_m')).body.failure, 'gym_not_verified');
});

test('unverified gym: the gym\'s own direct member and its home trainer stay eligible', async () => {
  const { preview, checkIn } = setup();
  const own = await preview('own_m');
  assert.deepEqual([own.eligible, own.reason], [true, 'pass_valid']);
  assert.equal((await checkIn('own_m')).status, 200);
  const trainer = await preview('trainer_t');
  assert.deepEqual([trainer.eligible, trainer.reason], [true, 'trainer_home_gym']);
});

test('unverified gym: the gym\'s own member whose plan just ended (24h grace) is not told gym_not_verified', async () => {
  const users = col([{ id: 'own_m' }]);
  const gyms = col([{ id: 'g_new', name: 'New Gym', tier: 'standard' }]);
  const justEnded = new Date(Date.now() - 60_000).toISOString();
  const subscriptions = col([{ id: 's_own', memberId: 'own_m', type: 'direct_sub', tier: null, homeGymId: 'g_new', status: 'expired', startedAt: START, cycleStartedAt: START, expiresAt: justEnded }]);
  const gymOpenToPass = async () => false;
  const getTierConfig = () => null;
  const checkInService = createCheckInService({ users, gyms, subscriptions, checkins: col(), getTierConfig, gymOpenToPass });
  const operator = createOperatorService({
    users, gyms, subscriptions, checkins: col(), checkInService, publicUserId: async () => 'FF-1',
    settingsService: { getTierConfig, visitCapForTier: () => null }, gymOpenToPass,
  });
  const p = (await operator.verifyQr({ operator: { gymIds: ['g_new'] }, gymId: 'g_new', qrToken: issueQr('own_m').token })).body;
  assert.notEqual(p.reason, 'gym_not_verified');
  assert.notEqual((await checkInService.perform({ memberId: 'own_m', gymId: 'g_new' })).failure, 'gym_not_verified');
});

test('verified gym: a FitFlex Pass member is eligible again', async () => {
  const { preview, checkIn } = setup({ verified: true });
  const p = await preview('pass_m');
  assert.deepEqual([p.eligible, p.reason], [true, 'pass_valid']);
  assert.equal((await checkIn('pass_m')).status, 200);
});

test('without a verification check wired, the preview behaves as before', async () => {
  const users = col([{ id: 'pass_m' }]);
  const gyms = col([{ id: 'g1', name: 'G', tier: 'standard' }]);
  const subscriptions = col([{ id: 's', memberId: 'pass_m', type: 'platform_pass', tier: 'pro', status: 'active', startedAt: START, cycleStartedAt: START, expiresAt: FAR }]);
  const getTierConfig = (t) => TIERS[t] ?? null;
  const operator = createOperatorService({
    users, gyms, subscriptions, checkins: col(),
    checkInService: createCheckInService({ users, gyms, subscriptions, checkins: col(), getTierConfig }),
    publicUserId: async () => 'FF-1', settingsService: { getTierConfig, visitCapForTier: () => 30 },
  });
  const p = (await operator.verifyQr({ operator: { gymIds: ['g1'] }, gymId: 'g1', qrToken: issueQr('pass_m').token })).body;
  assert.deepEqual([p.eligible, p.reason], [true, 'pass_valid']);
});

test('visitNeedsVerifiedGym: only the gym\'s own direct members and home trainers are exempt', () => {
  const gym = { id: 'g1' };
  assert.equal(visitNeedsVerifiedGym({ subscription: null, gym }), true);
  assert.equal(visitNeedsVerifiedGym({ subscription: { type: 'platform_pass' }, gym }), true);
  assert.equal(visitNeedsVerifiedGym({ subscription: { type: 'direct_sub', homeGymId: 'g2' }, gym }), true);
  assert.equal(visitNeedsVerifiedGym({ subscription: { type: 'trainer_pass', homeGymId: 'g1' }, gym }), true);
  assert.equal(visitNeedsVerifiedGym({ subscription: { type: 'direct_sub', homeGymId: 'g1' }, gym }), false);
  assert.equal(visitNeedsVerifiedGym({ subscription: null, gym, homeTrainer: true }), false);
});

test('CHECKIN_REFUSAL_CODES lists every check-in refusal code once', () => {
  for (const code of [
    'member_not_found', 'gym_not_found', 'gym_not_verified', 'gym_required', 'invalid_or_expired_qr',
    'not_your_gym', 'operator_not_assigned_to_gym', 'invalid_gym_qr', 'active_subscription_required',
    ...Object.values(CHECKIN_FAILURE),
  ]) {
    assert.ok(CHECKIN_REFUSAL_CODES.includes(code), code);
  }
  assert.equal(new Set(CHECKIN_REFUSAL_CODES).size, CHECKIN_REFUSAL_CODES.length);
  assert.ok(Object.isFrozen(CHECKIN_REFUSAL_CODES));
  for (const r of [...VERIFY_PREVIEW_REASONS.eligible, ...VERIFY_PREVIEW_REASONS.notEligible]) {
    assert.ok(!CHECKIN_REFUSAL_CODES.includes(r), r);
  }
});

test('every refusal the scan endpoints return is in CHECKIN_REFUSAL_CODES', async () => {
  const users = col([{ id: 'm1' }]);
  const gyms = col([{ id: 'g1', name: 'G', tier: 'standard' }, { id: 'g2', name: 'H', tier: 'standard' }]);
  const subscriptions = col();
  const checkInService = createCheckInService({ users, gyms, subscriptions, checkins: col(), getTierConfig: () => null });
  const operator = createOperatorService({
    users, gyms, subscriptions, checkins: col(), checkInService,
    publicUserId: async () => 'FF-1', settingsService: { getTierConfig: () => null, visitCapForTier: () => null },
  });
  const qr = issueQr('m1').token;
  const seen = [
    (await operator.verifyQr({ operator: { gymIds: ['g1'] }, gymId: 'g1', qrToken: 'bad' })).body.failure,
    (await operator.verifyQr({ operator: { gymIds: ['g1'] }, gymId: 'g2', qrToken: qr })).body.error,
    (await operator.verifyQr({ operator: {}, gymId: null, qrToken: qr })).body.error,
    (await operator.verifyQr({ operator: { gymIds: ['g1'] }, gymId: 'g1', qrToken: issueQr('ghost').token })).body.error,
    (await operator.checkIn({ operator: { gymIds: ['g1', 'g2'] }, gymId: null, qrToken: qr })).body.failure,
    (await operator.memberScanGym({ memberId: 'm1', gymQr: 'bad' })).body.failure,
    (await operator.issueMemberQr('m1')).error,
    (await checkInService.perform({ memberId: 'ghost', gymId: 'g1' })).failure,
    (await checkInService.perform({ memberId: 'm1', gymId: 'nope' })).failure,
    (await checkInService.perform({ memberId: 'm1', gymId: 'g1' })).failure,
  ];
  assert.deepEqual(seen, [
    'invalid_or_expired_qr', 'not_your_gym', 'operator_not_assigned_to_gym', 'member_not_found', 'gym_required',
    'invalid_gym_qr', 'active_subscription_required', 'member_not_found', 'gym_not_found', 'subscription_inactive',
  ]);
  for (const code of seen) assert.ok(CHECKIN_REFUSAL_CODES.includes(code), code);
});
