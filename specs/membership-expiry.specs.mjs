// A1 — Membership expiry (FitFlex App Issues 25.07.2026).
// Direct gym memberships must expire after their selected plan duration.
// Expiry is DERIVED from expiresAt so a subscription can never stay usable
// just because nothing flipped its stored status.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveSubscriptionStatus } from '../src/shared/subscription-status.mjs';
import { validateCheckIn, CHECKIN_FAILURE } from '../src/shared/check-in-rules.mjs';
import { createSubscriptionService } from '../src/services/subscription-service.mjs';
import { updateMemberProfile } from '../functions/subscriptions.mjs';
import { ownerCreateGym } from '../functions/owner-gyms.mjs';
import { ownerCreateMember, ownerListMembers, ownerCheckInMember } from '../functions/owner-members.mjs';

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
const dateOnly = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000);
const daysAhead = (n) => new Date(Date.now() + n * 86_400_000);

// ───────────────────── derived status (pure) ─────────────────────

test('effectiveSubscriptionStatus: active with future expiresAt stays active', () => {
  const s = { status: 'active', expiresAt: daysAhead(10).toISOString() };
  assert.equal(effectiveSubscriptionStatus(s), 'active');
});

test('effectiveSubscriptionStatus: active with past expiresAt is expired', () => {
  const s = { status: 'active', expiresAt: daysAgo(3).toISOString() };
  assert.equal(effectiveSubscriptionStatus(s), 'expired');
});

test('effectiveSubscriptionStatus: suspended is preserved even when past expiry', () => {
  const s = { status: 'suspended', expiresAt: daysAgo(3).toISOString() };
  assert.equal(effectiveSubscriptionStatus(s), 'suspended');
});

test('effectiveSubscriptionStatus: no expiresAt falls back to stored status', () => {
  assert.equal(effectiveSubscriptionStatus({ status: 'active', expiresAt: null }), 'active');
});

test('effectiveSubscriptionStatus: null subscription returns null', () => {
  assert.equal(effectiveSubscriptionStatus(null), null);
});

test('effectiveSubscriptionStatus honors an explicit now', () => {
  const s = { status: 'active', expiresAt: '2026-06-01T00:00:00.000Z' };
  assert.equal(effectiveSubscriptionStatus(s, new Date('2026-05-01T00:00:00.000Z')), 'active');
  assert.equal(effectiveSubscriptionStatus(s, new Date('2026-07-01T00:00:00.000Z')), 'expired');
});

// ───────────────────── check-in rules ─────────────────────

test('A1: stored-active subscription past expiry (beyond grace) is rejected at check-in', () => {
  const r = validateCheckIn({
    subscription: { status: 'active', tier: 'pro', expiresAt: daysAgo(3).toISOString() },
    gym: { id: 'g1', tier: 'standard' },
    todaysCheckins: [],
    cycleUsage: { visitsUsedInCycle: 0 },
  });
  assert.equal(r.ok, false);
  assert.equal(r.failure, CHECKIN_FAILURE.SUBSCRIPTION_INACTIVE);
});

test('A1: stored-active subscription just past expiry is allowed within the 24h grace', () => {
  const justExpired = new Date(Date.now() - 60_000).toISOString();
  const r = validateCheckIn({
    subscription: { status: 'active', tier: 'pro', expiresAt: justExpired },
    gym: { id: 'g1', tier: 'standard' },
    todaysCheckins: [],
    cycleUsage: { visitsUsedInCycle: 0 },
  });
  assert.equal(r.ok, true);
});

// ───────────────────── subscription-service.me() ─────────────────────

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

test('A1: me() reports a past-expiry direct subscription as expired and writes it back', async () => {
  const sub = {
    id: 'sub_exp1',
    memberId: 'usr_m1',
    type: 'direct_sub',
    tier: 'basic',
    status: 'active',
    startedAt: daysAgo(40).toISOString(),
    cycleStartedAt: daysAgo(40).toISOString(),
    expiresAt: daysAgo(10).toISOString(),
    homeGymId: 'gym_1',
  };
  const subscriptions = memStore([sub]);
  const service = createSubscriptionService({
    subscriptions,
    paymentRequests: memStore(),
    checkins: memStore(),
    gyms: [{ id: 'gym_1', name: 'Test Gym' }],
    settingsService: { priceForTier: () => 0, visitCapForTier: () => null },
    publicUserId: async () => 'FF-0001',
  });

  const out = await service.me({ id: 'usr_m1', userType: 'member' });
  assert.equal(out.subscription.status, 'expired');
  assert.equal(subscriptions.rows[0].status, 'expired', 'expired status must be persisted');
});

test('A1: me() keeps a future-expiry subscription active', async () => {
  const sub = {
    id: 'sub_act1',
    memberId: 'usr_m2',
    type: 'direct_sub',
    tier: 'basic',
    status: 'active',
    startedAt: daysAgo(2).toISOString(),
    cycleStartedAt: daysAgo(2).toISOString(),
    expiresAt: daysAhead(28).toISOString(),
    homeGymId: 'gym_1',
  };
  const subscriptions = memStore([sub]);
  const service = createSubscriptionService({
    subscriptions,
    paymentRequests: memStore(),
    checkins: memStore(),
    gyms: [{ id: 'gym_1', name: 'Test Gym' }],
    settingsService: { priceForTier: () => 0, visitCapForTier: () => null },
    publicUserId: async () => 'FF-0002',
  });

  const out = await service.me({ id: 'usr_m2', userType: 'member' });
  assert.equal(out.subscription.status, 'active');
});

// ───────────────────── owner endpoints (integration) ─────────────────────

async function ensureUser({ id, userType, displayName, phone }) {
  const out = res();
  await updateMemberProfile.onRequest({ user: { sub: id, userType }, body: { displayName, phone } }, out);
  assert.equal(out.statusCode, 200);
  return out.body.user;
}

async function createOwnerWithGym() {
  const ownerId = uniq('usr_owner_exp');
  await ensureUser({ id: ownerId, userType: 'gym_operator', displayName: 'Expiry Owner', phone: uniqPhone() });
  const gymRes = res();
  await ownerCreateGym.onRequest(
    {
      user: { sub: ownerId, userType: 'gym_operator' },
      body: { name: uniq('Expiry Gym'), tier: 'standard', location: 'Dar es Salaam', perVisitRate: 5000 },
    },
    gymRes,
  );
  assert.equal(gymRes.statusCode, 201);
  return { ownerId, gym: gymRes.body };
}

test('A1: weekly direct member whose plan ended is listed as expired with negative daysLeft', async () => {
  const { ownerId, gym } = await createOwnerWithGym();
  const ctx = { user: { sub: ownerId, userType: 'gym_operator' } };

  const created = res();
  await ownerCreateMember.onRequest(
    {
      ...ctx,
      body: {
        displayName: 'Expired Weekly Member',
        email: uniq('expired') + '@example.com',
        phone: uniqPhone(),
        gymId: gym.id,
        tier: 'basic',
        durationUnit: 'W',
        startDate: dateOnly(daysAgo(10)),
        endDate: dateOnly(daysAgo(3)),
      },
    },
    created,
  );
  assert.equal(created.statusCode, 201, JSON.stringify(created.body));

  const list = res();
  await ownerListMembers.onRequest({ ...ctx, query: { gymId: gym.id } }, list);
  assert.equal(list.statusCode, 200);
  const row = list.body.members.find((m) => m.id === created.body.member.id);
  assert.ok(row, 'member row expected');
  assert.equal(row.status, 'expired');
  assert.ok(row.daysLeft < 0, `daysLeft should be negative, got ${row.daysLeft}`);
});

test('A1: owner manual check-in of an expired direct member is rejected', async () => {
  const { ownerId, gym } = await createOwnerWithGym();
  const ctx = { user: { sub: ownerId, userType: 'gym_operator' } };

  const created = res();
  await ownerCreateMember.onRequest(
    {
      ...ctx,
      body: {
        displayName: 'Expired Checkin Member',
        email: uniq('expchk') + '@example.com',
        phone: uniqPhone(),
        gymId: gym.id,
        tier: 'basic',
        durationUnit: 'M',
        startDate: dateOnly(daysAgo(45)),
        endDate: dateOnly(daysAgo(15)),
      },
    },
    created,
  );
  assert.equal(created.statusCode, 201, JSON.stringify(created.body));

  const checkin = res();
  await ownerCheckInMember.onRequest(
    { ...ctx, params: { memberId: created.body.member.id }, body: { gymId: gym.id } },
    checkin,
  );
  assert.equal(checkin.statusCode, 409, JSON.stringify(checkin.body));
  assert.equal(checkin.body.error, 'membership_expired');
});
