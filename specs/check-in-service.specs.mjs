import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createCheckInService } from '../src/services/check-in-service.mjs';

// In-memory collection mock matching the json-store contract.
const mkCol = (initial = []) => {
  const arr = [...initial];
  return {
    all: () => [...arr],
    find: pred => arr.find(pred),
    filter: pred => arr.filter(pred),
    insert: row => { arr.push(row); return row; },
    update: (pred, patch) => { const i = arr.findIndex(pred); if (i < 0) return null; arr[i] = { ...arr[i], ...patch }; return arr[i]; },
    upsert: (pred, row) => { const i = arr.findIndex(pred); if (i < 0) arr.push(row); else arr[i] = { ...arr[i], ...row }; return row; }
  };
};

let users, gyms, subscriptions, checkins, svc;
beforeEach(() => {
  users = mkCol([{ id: 'm1', userType: 'member', phone: '+255700000001' }]);
  gyms  = mkCol([
    { id: 'g1', tier: 'standard' },
    { id: 'g2', tier: 'standard' },
    { id: 'g3', tier: 'midtier' }
  ]);
  subscriptions = mkCol([{
    id: 's1', memberId: 'm1', type: 'platform_pass', tier: 'pro',
    status: 'active', startedAt: '2026-01-01T00:00:00Z',
    cycleStartedAt: '2026-01-01T00:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z'
  }]);
  checkins = mkCol([]);
  svc = createCheckInService({ users, gyms, subscriptions, checkins });
});

test('first check-in of the day consumes a visit and logs all 8 fields', () => {
  const r = svc.perform({ memberId: 'm1', gymId: 'g1' });
  assert.equal(r.ok, true);
  assert.equal(r.checkin.visitConsumed, true);
  assert.equal(r.checkin.visitNumberInCycle, 1);
  for (const f of ['memberId','gymId','timestamp','method','subscriptionType','passTier','visitNumberInCycle','gymTier']) {
    assert.ok(r.checkin[f] !== undefined, `missing ${f}`);
  }
});

test('second check-in same day same gym is idempotent — returns existing record', () => {
  const first = svc.perform({ memberId: 'm1', gymId: 'g1' });
  const r = svc.perform({ memberId: 'm1', gymId: 'g1' });
  assert.equal(r.ok, true);
  assert.equal(r.idempotent, true);
  assert.equal(r.checkin.id, first.checkin.id);
});

test('check-in at a different gym same day is idempotent and does not consume another visit', () => {
  svc.perform({ memberId: 'm1', gymId: 'g1' });
  const r = svc.perform({ memberId: 'm1', gymId: 'g2' });
  assert.equal(r.ok, true);
  assert.equal(r.idempotent, true);
  assert.equal(r.checkin.gymId, 'g1');
  assert.equal(r.checkin.visitConsumed, true);
  assert.equal(r.checkin.visitNumberInCycle, 1);
  assert.equal(checkins.all().length, 1);
});

test('Basic tier blocked at midtier gym', () => {
  subscriptions.update(s => s.id === 's1', { tier: 'basic' });
  const r = svc.perform({ memberId: 'm1', gymId: 'g3' });
  assert.equal(r.ok, false);
  assert.equal(r.failure, 'tier_not_covered');
});

test('configured tier cap overrides hard-coded pass constants', () => {
  checkins = mkCol([
    { memberId: 'm1', gymId: 'g1', timestamp: '2026-01-02T00:00:00Z', visitConsumed: true },
    { memberId: 'm1', gymId: 'g1', timestamp: '2026-01-03T00:00:00Z', visitConsumed: true },
  ]);
  svc = createCheckInService({
    users,
    gyms,
    subscriptions,
    checkins,
    getTierConfig: tier => tier === 'pro' ? { visitCap: 2, multiGymPerDay: true } : null,
  });

  const r = svc.perform({ memberId: 'm1', gymId: 'g1', now: new Date('2026-01-04T00:00:00Z') });
  assert.equal(r.ok, false);
  assert.equal(r.failure, 'visits_exhausted');
});

test('configured unlimited tier never exhausts', () => {
  subscriptions.update(s => s.id === 's1', { tier: 'executive' });
  checkins = mkCol(Array.from({ length: 40 }, (_, i) => ({
    memberId: 'm1',
    gymId: 'g1',
    timestamp: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    visitConsumed: true,
  })));
  svc = createCheckInService({
    users,
    gyms,
    subscriptions,
    checkins,
    getTierConfig: tier => tier === 'executive' ? { visitCap: Infinity, multiGymPerDay: true } : null,
  });

  const r = svc.perform({ memberId: 'm1', gymId: 'g2', now: new Date('2026-02-15T00:00:00Z') });
  assert.equal(r.ok, true);
});
