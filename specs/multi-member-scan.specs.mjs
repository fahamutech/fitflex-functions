// TDD: B.3 — Scanning multiple members must increment dashboard visit counts correctly.
// A.8 — After every successful scan, the remaining visits should decrease.
// Each member scan should independently record a visit and contribute to gym totals.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createCheckInService } from '../src/services/check-in-service.mjs';

const mkCol = (initial = []) => {
  const arr = [...initial];
  return {
    all: () => [...arr],
    find: (pred) => arr.find(pred),
    filter: (pred) => arr.filter(pred),
    insert: (row) => { arr.push(row); return row; },
    update: (pred, patch) => { const i = arr.findIndex(pred); if (i < 0) return null; arr[i] = { ...arr[i], ...patch }; return arr[i]; },
    upsert: (pred, row) => { const i = arr.findIndex(pred); if (i < 0) arr.push(row); else arr[i] = { ...arr[i], ...row }; return row; },
  };
};

const TIER_CONFIG = {
  basic:     { price: 30_000,  visitCap: 12, gymAccess: 'standard',         multiGymPerDay: false },
  pro:       { price: 60_000,  visitCap: 30, gymAccess: 'midtier',          multiGymPerDay: true },
  premium:   { price: 100_000, visitCap: 30, gymAccess: 'premium',          multiGymPerDay: true },
  executive: { price: 200_000, visitCap: 30, gymAccess: 'luxury_executive', multiGymPerDay: true },
};
const getTierConfig = (tier) => TIER_CONFIG[tier] ?? null;

let users, gyms, subscriptions, checkins, svc;

beforeEach(() => {
  users = mkCol([
    { id: 'm1', userType: 'member' },
    { id: 'm2', userType: 'member' },
    { id: 'm3', userType: 'member' },
  ]);
  gyms = mkCol([
    { id: 'gymA', tier: 'standard' },
  ]);
  subscriptions = mkCol([]);
  checkins = mkCol([]);
  svc = createCheckInService({ users, gyms, subscriptions, checkins, getTierConfig });
});

function subscribe(memberId, { tier, startedAt }) {
  const at = startedAt || new Date().toISOString();
  return subscriptions.insert({
    id: `sub_${memberId}_${tier}`,
    memberId,
    type: 'platform_pass',
    tier,
    status: 'active',
    startedAt: at,
    cycleStartedAt: at,
    expiresAt: '2099-01-01T00:00:00Z',
  });
}

// ─── B.3: Scanning multiple members should add visit numbers on dashboard ───
test('B.3: scanning 3 different members in same gym creates 3 separate visit records', () => {
  subscribe('m1', { tier: 'basic' });
  subscribe('m2', { tier: 'pro' });
  subscribe('m3', { tier: 'premium' });

  const now = new Date('2026-03-15T09:00:00Z');

  const r1 = svc.perform({ memberId: 'm1', gymId: 'gymA', now });
  const r2 = svc.perform({ memberId: 'm2', gymId: 'gymA', now });
  const r3 = svc.perform({ memberId: 'm3', gymId: 'gymA', now });

  assert.equal(r1.ok, true, 'member 1 scan should succeed');
  assert.equal(r2.ok, true, 'member 2 scan should succeed');
  assert.equal(r3.ok, true, 'member 3 scan should succeed');

  // Dashboard query: total visits for gymA today
  const gymVisits = checkins.filter(c => c.gymId === 'gymA' && c.visitConsumed);
  assert.equal(gymVisits.length, 3, 'dashboard should show 3 visits for the gym');
});

test('B.3: each member scan has unique check-in IDs', () => {
  subscribe('m1', { tier: 'basic' });
  subscribe('m2', { tier: 'basic' });

  const now = new Date('2026-03-15T09:00:00Z');
  const r1 = svc.perform({ memberId: 'm1', gymId: 'gymA', now });
  const r2 = svc.perform({ memberId: 'm2', gymId: 'gymA', now });

  assert.notEqual(r1.checkin.id, r2.checkin.id, 'check-in IDs must be unique');
  assert.equal(r1.checkin.memberId, 'm1');
  assert.equal(r2.checkin.memberId, 'm2');
});

// ─── A.8: Remaining visits should reduce after each successful scan ───
test('A.8: visitNumberInCycle increments with each scan (remaining decreases)', () => {
  subscribe('m1', { tier: 'basic', startedAt: '2026-03-01T00:00:00Z' });

  // Day 1 scan
  const r1 = svc.perform({ memberId: 'm1', gymId: 'gymA', now: new Date('2026-03-01T09:00:00Z') });
  assert.equal(r1.ok, true);
  assert.equal(r1.visitNumberInCycle, 1, 'first scan: visit #1');

  // Day 2 scan
  const r2 = svc.perform({ memberId: 'm1', gymId: 'gymA', now: new Date('2026-03-02T09:00:00Z') });
  assert.equal(r2.ok, true);
  assert.equal(r2.visitNumberInCycle, 2, 'second scan: visit #2');

  // Day 3 scan
  const r3 = svc.perform({ memberId: 'm1', gymId: 'gymA', now: new Date('2026-03-03T09:00:00Z') });
  assert.equal(r3.ok, true);
  assert.equal(r3.visitNumberInCycle, 3, 'third scan: visit #3');

  // Remaining visits: cap (12) - used (3) = 9
  const remaining = TIER_CONFIG.basic.visitCap - r3.visitNumberInCycle;
  assert.equal(remaining, 9, 'remaining visits should decrease after each scan');
});

test('A.8: idempotent scan on same day does NOT consume another visit', () => {
  subscribe('m1', { tier: 'basic', startedAt: '2026-03-01T00:00:00Z' });

  const now = new Date('2026-03-01T09:00:00Z');
  const r1 = svc.perform({ memberId: 'm1', gymId: 'gymA', now });
  assert.equal(r1.ok, true);
  assert.equal(r1.visitNumberInCycle, 1);

  // Same day, same member — idempotent
  const r2 = svc.perform({ memberId: 'm1', gymId: 'gymA', now: new Date('2026-03-01T14:00:00Z') });
  assert.equal(r2.ok, true);
  assert.equal(r2.idempotent, true, 'second scan same day should be idempotent');
  assert.equal(r2.visitNumberInCycle, 1, 'should not increment on idempotent');
});

test('A.8: when visit cap is exhausted, scan is rejected', () => {
  subscribe('m1', { tier: 'basic', startedAt: '2026-03-01T00:00:00Z' });

  // Use all 12 visits
  for (let day = 1; day <= 12; day++) {
    const d = new Date('2026-03-01T09:00:00Z');
    d.setUTCDate(d.getUTCDate() + day - 1);
    const r = svc.perform({ memberId: 'm1', gymId: 'gymA', now: d });
    assert.equal(r.ok, true, `visit ${day} should succeed`);
    assert.equal(r.visitNumberInCycle, day);
  }

  // 13th visit should fail
  const rejected = svc.perform({
    memberId: 'm1',
    gymId: 'gymA',
    now: new Date('2026-03-13T09:00:00Z'),
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.failure, 'visits_exhausted');
});
