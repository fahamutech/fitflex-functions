// A voided check-in never happened as far as the member is concerned (2026-10-19 fix):
//   - a same-day rescan at the same gym records a NEW visit (not the voided one as a repeat);
//   - it does not use a visit from the cycle allowance (check-in, scanner preview, member /me);
//   - it does not count as "a gym today" for Basic's one-gym-per-day rule.
// The database index checkin_one_visit_per_day_uq already leaves voided rows out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCheckInService } from '../src/services/check-in-service.mjs';
import { createOperatorService } from '../src/services/operator-service.mjs';
import { createSubscriptionService } from '../src/services/subscription-service.mjs';
import { CHECKIN_STATUS } from '../src/shared/checkin-status.mjs';
import { issue as issueQr } from '../src/auth/qr-token.mjs';

const col = (rows = []) => ({
  rows,
  find: fn => rows.find(fn),
  findByIdAsync: async id => rows.find(r => r.id === id) ?? null,
  findAsync: async fn => rows.find(fn) ?? null,
  filterAsync: async fn => rows.filter(fn),
  insertAsync: async row => { rows.push(row); return row; },
  updateByIdAsync: async (id, patch) => { const i = rows.findIndex(r => r.id === id); if (i >= 0) rows[i] = { ...rows[i], ...patch }; return rows[i] ?? null; },
});

const TIERS = {
  basic: { price: 30_000, visitCap: 1, gymAccess: 'standard', multiGymPerDay: false },
  pro: { price: 60_000, visitCap: 2, gymAccess: 'midtier', multiGymPerDay: true },
};
const START = '2026-01-01T00:00:00Z';
const FAR = '2099-01-01T00:00:00Z';
const ALWAYS_OPEN = undefined; // gyms without operatingHours are open

function setup(tier = 'pro') {
  const users = col([{ id: 'm1', userType: 'member', displayName: 'Asha' }]);
  const gyms = col([
    { id: 'gA', name: 'Gym A', tier: 'standard', operatingHours: ALWAYS_OPEN },
    { id: 'gB', name: 'Gym B', tier: 'standard', operatingHours: ALWAYS_OPEN },
  ]);
  const subscriptions = col([{ id: 's1', memberId: 'm1', type: 'platform_pass', tier, status: 'active', startedAt: START, cycleStartedAt: START, expiresAt: FAR }]);
  const checkins = col();
  const getTierConfig = t => TIERS[t] ?? null;
  const gymOpenToPass = async () => true;
  const checkInService = createCheckInService({ users, gyms, subscriptions, checkins, trainers: col(), getTierConfig, gymOpenToPass });
  const settingsService = { getTierConfig, visitCapForTier: t => TIERS[t]?.visitCap ?? null };
  const operator = createOperatorService({
    users, gyms, subscriptions, checkins, checkInService, settingsService, gymOpenToPass,
    publicUserId: async u => `FF-${typeof u === 'string' ? u : u.id}`,
  });
  const scan = gymId => operator.checkIn({ operator: { gymIds: ['gA', 'gB'] }, gymId, qrToken: issueQr('m1').token });
  const preview = async gymId => (await operator.verifyQr({ operator: { gymIds: ['gA', 'gB'] }, gymId, qrToken: issueQr('m1').token })).body;
  const voidIt = id => { const r = checkins.rows.find(c => c.id === id); r.status = CHECKIN_STATUS.VOIDED; };
  return { scan, preview, voidIt, checkins, users, gyms, subscriptions, settingsService };
}

test('same-day rescan after a void records a new visit, not the voided one as a repeat', async () => {
  const f = setup('pro');
  const first = await f.scan('gA');
  assert.equal(first.status, 200);
  assert.equal(first.body.idempotent, false);
  f.voidIt(first.body.checkin.id);

  const again = await f.scan('gA');
  assert.equal(again.status, 200);
  assert.equal(again.body.idempotent, false, 'not answered as a repeat');
  assert.notEqual(again.body.checkin.id, first.body.checkin.id);
  assert.equal(again.body.checkin.status, CHECKIN_STATUS.VALID);
  assert.equal(again.body.visitNumberInCycle, 1, 'the voided visit is not counted');
  assert.equal(f.checkins.rows.length, 2);

  // A third scan is now the repeat of the new, live visit.
  const third = await f.scan('gA');
  assert.equal(third.body.idempotent, true);
  assert.equal(third.body.checkin.id, again.body.checkin.id);
});

test('a voided visit gives the allowance back (cap 1)', async () => {
  const f = setup('basic');
  const first = await f.scan('gA');
  assert.equal(first.status, 200);
  f.voidIt(first.body.checkin.id);
  const p = await f.preview('gA');
  assert.deepEqual([p.eligible, p.visitsUsed], [true, 0]);
  const again = await f.scan('gA');
  assert.equal(again.status, 200);
  assert.equal(again.body.visitNumberInCycle, 1);
});

test('without a void, the cap still holds (unchanged)', async () => {
  const f = setup('pro');
  await f.scan('gA');
  await f.scan('gB');
  assert.equal(f.checkins.rows.length, 2);
  // Next EAT day would be needed for a third; same day same gym is the repeat.
  const repeat = await f.scan('gA');
  assert.equal(repeat.body.idempotent, true);
});

test('Basic one-gym-per-day: a voided visit at gym A does not block gym B', async () => {
  const blocked = setup('basic');
  TIERS.basic.visitCap = 5;
  try {
    await blocked.scan('gA');
    const refused = await blocked.scan('gB');
    assert.equal(refused.status, 409);
    assert.equal(refused.body.failure, 'basic_daily_limit');

    const f = setup('basic');
    const first = await f.scan('gA');
    f.voidIt(first.body.checkin.id);
    assert.equal((await f.preview('gB')).eligible, true);
    const other = await f.scan('gB');
    assert.equal(other.status, 200);
    assert.equal(other.body.checkin.gymId, 'gB');
  } finally {
    TIERS.basic.visitCap = 1;
  }
});

test('member /me: visitsUsed leaves voided visits out', async () => {
  const f = setup('pro');
  const a = await f.scan('gA');
  await f.scan('gB');
  f.voidIt(a.body.checkin.id);
  const svc = createSubscriptionService({
    subscriptions: f.subscriptions, paymentRequests: col(), checkins: f.checkins, gyms: f.gyms,
    settingsService: f.settingsService, publicUserId: async () => 'FF-m1',
  });
  const me = await svc.me(f.users.rows[0]);
  assert.equal(me.visitsUsed, 1);
  assert.equal(me.visitCap, 2);
});
