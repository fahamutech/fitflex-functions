// A7 — Direct gym subscription (FitFlex App Issues 25.07.2026).
// "Subscribe" on a gym must offer the gym's own Daily / Weekly / Monthly plans,
// each expiring after its real duration (feeds A1 expiry), and the member-facing
// pass catalogue must NOT list the "Online Free" option.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSubscriptionService } from '../src/services/subscription-service.mjs';

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

const gymFixture = {
  id: 'gym_direct_1',
  name: 'Direct Gym',
  tier: 'standard',
  ratePerDay: 5000,
  ratePerWeek: 25000,
  ratePerMonth: 80000,
};

function makeService({ gyms = [gymFixture] } = {}) {
  return createSubscriptionService({
    subscriptions: memStore(),
    paymentRequests: memStore(),
    checkins: memStore(),
    gyms,
    settingsService: { priceForTier: () => 100000, visitCapForTier: () => null },
    publicUserId: async () => 'FF-1000',
  });
}

// ───────────────────── pass catalogue ─────────────────────

test('A7: member pass catalogue does not include the Online Free option', () => {
  const service = makeService();
  const passes = service.listPasses();
  assert.ok(passes.length > 0, 'catalogue must not be empty');
  assert.ok(!passes.some((p) => p.id === 'online_free'), 'online_free must be excluded');
  assert.ok(!passes.some((p) => p.accessMode === 'free_online'), 'no free_online plans');
});

// ───────────────────── direct plan durations ─────────────────────

const DAY = 86_400_000;

async function subscribeDirect(service, plan) {
  return service.subscribe({
    memberId: 'usr_direct_1',
    type: 'direct_sub',
    homeGymId: gymFixture.id,
    plan,
  });
}

test('A7: daily direct plan expires after 1 day', async () => {
  const service = makeService();
  const out = await subscribeDirect(service, 'daily');
  assert.equal(out.status, 202, JSON.stringify(out));
  const sub = out.subscription;
  assert.equal(sub.type, 'direct_sub');
  assert.equal(sub.homeGymId, gymFixture.id);
  const durationMs = +new Date(sub.expiresAt) - +new Date(sub.startedAt);
  assert.equal(Math.round(durationMs / DAY), 1);
  assert.equal(out.paymentRequest.amountTzs, gymFixture.ratePerDay);
});

test('A7: weekly direct plan expires after 7 days', async () => {
  const service = makeService();
  const out = await subscribeDirect(service, 'weekly');
  const durationMs = +new Date(out.subscription.expiresAt) - +new Date(out.subscription.startedAt);
  assert.equal(Math.round(durationMs / DAY), 7);
  assert.equal(out.paymentRequest.amountTzs, gymFixture.ratePerWeek);
});

test('A7: monthly direct plan expires after 30 days', async () => {
  const service = makeService();
  const out = await subscribeDirect(service, 'monthly');
  const durationMs = +new Date(out.subscription.expiresAt) - +new Date(out.subscription.startedAt);
  assert.equal(Math.round(durationMs / DAY), 30);
  assert.equal(out.paymentRequest.amountTzs, gymFixture.ratePerMonth);
});

// ───────────────────── validation ─────────────────────

test('A7: direct subscription requires a gym', async () => {
  const service = makeService();
  const out = await service.subscribe({ memberId: 'usr_x', type: 'direct_sub', plan: 'daily' });
  assert.equal(out.status, 400);
  assert.equal(out.error, 'homeGymId_required');
});

test('A7: direct subscription rejects an unknown gym', async () => {
  const service = makeService();
  const out = await service.subscribe({ memberId: 'usr_x', type: 'direct_sub', plan: 'daily', homeGymId: 'gym_nope' });
  assert.equal(out.status, 404);
  assert.equal(out.error, 'gym_not_found');
});

test('A7: direct subscription rejects an invalid plan', async () => {
  const service = makeService();
  const out = await service.subscribe({ memberId: 'usr_x', type: 'direct_sub', plan: 'yearly', homeGymId: gymFixture.id });
  assert.equal(out.status, 400);
  assert.equal(out.error, 'invalid_plan');
});

// ───────────────────── A3: profile shows subscribed gym ─────────────────────

test('A3: me() embeds the subscribed gym for a direct subscription', async () => {
  const service = makeService();
  await subscribeDirect(service, 'monthly');
  const out = await service.me({ id: 'usr_direct_1', userType: 'member' });
  // payment_pending direct sub is still surfaced as the pending one; activate it
  // by checking the embedded gym on the subscription payload instead.
  assert.ok(out.pendingPayment, 'pending payment expected');
  const active = await makeActiveDirect(service);
  assert.equal(active.subscription.homeGym?.id, gymFixture.id);
  assert.equal(active.subscription.homeGym?.name, gymFixture.name);
});

async function makeActiveDirect(service) {
  const sub = await service.subscribe({
    memberId: 'usr_direct_active',
    type: 'direct_sub',
    homeGymId: gymFixture.id,
    plan: 'monthly',
  });
  // simulate admin approval
  sub.subscription.status = 'active';
  return service.me({ id: 'usr_direct_active', userType: 'member' });
}

test('A3: me() has no homeGym for a platform pass', async () => {
  const service = makeService();
  await service.subscribe({ memberId: 'usr_pp2', tier: 'pro', type: 'platform_pass' });
  const out = await service.me({ id: 'usr_pp2', userType: 'member' });
  assert.equal(out.subscription?.homeGym ?? null, null);
});

test('A7: platform pass subscription still works unchanged', async () => {
  const service = makeService();
  const out = await service.subscribe({ memberId: 'usr_pp', tier: 'pro', type: 'platform_pass' });
  assert.equal(out.status, 202);
  assert.equal(out.subscription.tier, 'pro');
  const durationMs = +new Date(out.subscription.expiresAt) - +new Date(out.subscription.startedAt);
  assert.equal(Math.round(durationMs / DAY), 30);
});
