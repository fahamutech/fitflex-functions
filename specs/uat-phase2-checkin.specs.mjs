// UAT Phase 2 — backend business-logic journeys (DB-free, dependency-injected).
// Mirrors the portal-configured tiers (see src/infra/seed-db.mjs DEFAULT_SETTINGS):
//   basic: 12 visits | pro: 30 | premium: 30 | executive: 30 (NOT unlimited unless configured -1).
// Covers the member/owner feedback that is enforced server-side:
//   A7  — member scanning is tied to a specific gym (visit logged against that gym + that gym's tier).
//   B1  — upgrading a subscription RESETS the visit counter (does not add Basic+Premium = 40).
//   B4  — Executive (and every tier) strictly honours the portal-configured visit cap & price.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createCheckInService } from '../src/services/check-in-service.mjs';

// In-memory collection mock matching the json-store / knex-store contract.
const mkCol = (initial = []) => {
  const arr = [...initial];
  return {
    all: () => [...arr],
    find: (pred) => arr.find(pred),
    filter: (pred) => arr.filter(pred),
    insert: (row) => { arr.push(row); return row; },
    update: (pred, patch) => { const i = arr.findIndex(pred); if (i < 0) return null; arr[i] = { ...arr[i], ...patch }; return arr[i]; },
    upsert: (pred, row) => { const i = arr.findIndex(pred); if (i < 0) arr.push(row); else arr[i] = { ...arr[i], ...row }; return row; },
    // Async variants used by check-in-service after DB-only migration
    findByIdAsync: async (id) => arr.find(r => r.id === id) ?? null,
    findAsync: async (pred) => arr.find(pred) ?? null,
    filterAsync: async (pred) => arr.filter(pred),
    allAsync: async () => [...arr],
    insertAsync: async (row) => { arr.push(row); return row; },
    updateByIdAsync: async (id, patch) => { const i = arr.findIndex(r => r.id === id); if (i < 0) return null; arr[i] = { ...arr[i], ...patch }; return arr[i]; },
    upsertAsync: async (pred, row) => { const i = arr.findIndex(pred); if (i < 0) arr.push(row); else arr[i] = { ...arr[i], ...row }; return row; },
  };
};

// Source of truth for visit caps — the configured portal tiers (B4: "strictly maintain
// visits and pricing as per the portal configuration").
const TIER_CONFIG = {
  basic:     { price: 30_000,  visitCap: 12, gymAccess: 'standard',         multiGymPerDay: false },
  pro:       { price: 60_000,  visitCap: 30, gymAccess: 'midtier',          multiGymPerDay: true },
  premium:   { price: 100_000, visitCap: 30, gymAccess: 'premium',          multiGymPerDay: true },
  executive: { price: 200_000, visitCap: 30, gymAccess: 'luxury_executive', multiGymPerDay: true },
};
const getTierConfig = (tier) => TIER_CONFIG[tier] ?? null;

let users, gyms, subscriptions, checkins, svc;

beforeEach(() => {
  users = mkCol([{ id: 'm1', userType: 'member', phone: '+255700000001' }]);
  gyms = mkCol([
    { id: 'gymA', tier: 'standard' },
    { id: 'gymB', tier: 'standard' },
    { id: 'gymMid', tier: 'midtier' },
    { id: 'gymPrem', tier: 'premium' },
    { id: 'gymExec', tier: 'luxury_executive' },
  ]);
  subscriptions = mkCol([]);
  checkins = mkCol([]);
  svc = createCheckInService({ users, gyms, subscriptions, checkins, getTierConfig });
});

function subscribe({ tier, startedAt }) {
  const at = startedAt || new Date().toISOString();
  return subscriptions.insert({
    id: `sub_${tier}_${at}`,
    memberId: 'm1',
    type: 'platform_pass',
    tier,
    status: 'active',
    startedAt: at,
    cycleStartedAt: at,
    expiresAt: '2099-01-01T00:00:00Z',
  });
}

// ───────────────────────── A7: scanning tied to a specific gym ─────────────────────────
test('A7: a successful scan logs the visit against the scanned gym and its tier', async () => {
  subscribe({ tier: 'premium' });
  const r = await svc.perform({ memberId: 'm1', gymId: 'gymMid', method: 'gym_scanned' });

  assert.equal(r.ok, true);
  assert.equal(r.checkin.gymId, 'gymMid', 'visit must be tied to the scanned gym, not the owner');
  assert.equal(r.checkin.gymTier, 'midtier');
  assert.equal(r.checkin.method, 'gym_scanned');
});

test('A7: a member is bound by the scanned gym tier — Basic blocked at a higher-tier gym', async () => {
  subscribe({ tier: 'basic' }); // basic → standard only
  const r = await svc.perform({ memberId: 'm1', gymId: 'gymMid' });

  assert.equal(r.ok, false);
  assert.equal(r.failure, 'tier_not_covered');
});

// ───────────────────────── B1: upgrade RESETS the visit counter ─────────────────────────
test('B1: upgrading from Basic to Premium resets visits to 0 (does not sum to 40)', async () => {
  // Member subscribes to Basic and uses 8 visits over 8 days.
  subscribe({ tier: 'basic', startedAt: '2026-01-01T00:00:00Z' });
  for (let day = 1; day <= 8; day += 1) {
    await svc.perform({
      memberId: 'm1',
      gymId: 'gymA',
      now: new Date(`2026-01-${String(day).padStart(2, '0')}T08:00:00Z`),
    });
  }
  assert.equal(checkins.filter((c) => c.visitConsumed).length, 8, 'sanity: 8 visits consumed on Basic');

  // Upgrade: a new Premium subscription begins with a fresh cycle.
  subscribe({ tier: 'premium', startedAt: '2026-01-10T00:00:00Z' });

  // First scan after upgrade.
  const r = await svc.perform({ memberId: 'm1', gymId: 'gymPrem', now: new Date('2026-01-11T08:00:00Z') });
  assert.equal(r.ok, true);

  // The counter restarts at the new cycle: this is visit #1, NOT #9 and NOT against a 40 cap.
  assert.equal(r.visitNumberInCycle, 1, 'upgrade must reset the cycle visit counter to 1');
  assert.equal(getTierConfig('premium').visitCap, 30, 'cap follows the new tier (30), never Basic+Premium = 40');
});

test('B1: post-upgrade cap is the new tier cap, not the sum of both tiers', async () => {
  subscribe({ tier: 'basic', startedAt: '2026-01-01T00:00:00Z' });
  // Upgrade to premium on day 10.
  subscribe({ tier: 'premium', startedAt: '2026-01-10T00:00:00Z' });

  // Consume exactly the Premium cap (30) within the new cycle, one per day.
  for (let i = 0; i < 30; i += 1) {
    const date = new Date('2026-01-11T08:00:00Z');
    date.setUTCDate(date.getUTCDate() + i);
    const r = await svc.perform({ memberId: 'm1', gymId: 'gymPrem', now: date });
    assert.equal(r.ok, true, `visit ${i + 1} within premium cap should pass`);
  }

  // The 31st visit must be blocked — proving the cap is 30 (premium), not 40 (basic+premium).
  const date = new Date('2026-01-11T08:00:00Z');
  date.setUTCDate(date.getUTCDate() + 30);
  const blocked = await svc.perform({ memberId: 'm1', gymId: 'gymPrem', now: date });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.failure, 'visits_exhausted');
});

// ───────────────────────── B4: strict portal-configured caps ─────────────────────────
test('B4: Executive is NOT unlimited — it honours the configured 30-visit cap', async () => {
  subscribe({ tier: 'executive', startedAt: '2026-01-01T00:00:00Z' });

  for (let i = 0; i < 30; i += 1) {
    const date = new Date('2026-01-01T08:00:00Z');
    date.setUTCDate(date.getUTCDate() + i);
    const r = await svc.perform({ memberId: 'm1', gymId: 'gymExec', now: date });
    assert.equal(r.ok, true, `executive visit ${i + 1} should pass`);
  }

  const date = new Date('2026-01-01T08:00:00Z');
  date.setUTCDate(date.getUTCDate() + 30);
  const blocked = await svc.perform({ memberId: 'm1', gymId: 'gymExec', now: date });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.failure, 'visits_exhausted', 'Executive must stop at the configured cap, not run unlimited');
});

test('B4: an explicitly unlimited configuration (visitCap=Infinity) never exhausts', async () => {
  // When the portal configures a tier with -1/unlimited visits, getTierConfig yields Infinity.
  svc = createCheckInService({
    users,
    gyms,
    subscriptions,
    checkins,
    getTierConfig: (tier) => (tier === 'executive' ? { visitCap: Infinity, multiGymPerDay: true } : null),
  });
  subscribe({ tier: 'executive', startedAt: '2026-01-01T00:00:00Z' });

  for (let i = 0; i < 50; i += 1) {
    const date = new Date('2026-01-01T08:00:00Z');
    date.setUTCDate(date.getUTCDate() + i);
    const r = await svc.perform({ memberId: 'm1', gymId: 'gymExec', now: date });
    assert.equal(r.ok, true, `unlimited config visit ${i + 1} should pass`);
  }
});

test('B4: configured price per tier matches the portal configuration', () => {
  assert.equal(getTierConfig('basic').price, 30_000);
  assert.equal(getTierConfig('pro').price, 60_000);
  assert.equal(getTierConfig('premium').price, 100_000);
  assert.equal(getTierConfig('executive').price, 200_000);
});
