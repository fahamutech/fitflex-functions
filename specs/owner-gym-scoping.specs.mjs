// Owner multi-gym scoping — backend REST endpoint integration journeys (runs against the CI database).
// Regression coverage for the "Members Management Flow" active-gym bug: several owner endpoints
// used to ignore the requested `gymId` and always aggregate across every gym the owner owns.
//   - GET /owner/members            must scope members + stats to ?gymId when provided
//   - GET /operator/dashboard       must expose a real gym-scoped `totalMembers` count
//   - GET /owner/trainers           must scope the trainer list to ?gymId when provided
//   - GET /owner/earnings           must scope earnings totals to ?gymId when provided

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  updateMemberProfile,
  ownerCreateGym,
  ownerCreateMember,
  ownerListMembers,
  operatorDashboard,
  trainerRegister,
  trainerApplyToGym,
  ownerDecideTrainerJoin,
  ownerListTrainers,
  ownerMyEarnings,
  adminCreateInvoice,
} from '../functions/index.mjs';

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

async function ensureUser({ id, userType, displayName, email, phone }) {
  const out = res();
  await updateMemberProfile.onRequest(
    { user: { sub: id, userType }, body: { displayName, email, phone } },
    out,
  );
  assert.equal(out.statusCode, 200, `ensureUser ${userType} failed: ${JSON.stringify(out.body)}`);
  return out.body.user;
}

async function createGymForOwner(ownerId, name) {
  const gymRes = res();
  await ownerCreateGym.onRequest(
    {
      user: { sub: ownerId, userType: 'gym_operator' },
      body: { name: uniq(name), tier: 'standard', location: 'Dar es Salaam', perVisitRate: 5000 },
    },
    gymRes,
  );
  assert.equal(gymRes.statusCode, 201, `gym create failed: ${JSON.stringify(gymRes.body)}`);
  return gymRes.body;
}

/** Owner with two distinct gyms — the fixture every test below scopes against. */
async function createOwnerWithTwoGyms() {
  const ownerId = uniq('usr_owner');
  await ensureUser({ id: ownerId, userType: 'gym_operator', displayName: 'Multi Gym Owner', phone: uniqPhone() });
  const gymA = await createGymForOwner(ownerId, 'Gym A');
  const gymB = await createGymForOwner(ownerId, 'Gym B');
  return { ownerId, gymA, gymB };
}

async function createDirectMember(ownerId, gym, displayName) {
  const start = new Date();
  const end = new Date(start.getTime() + 30 * 86_400_000);
  const out = res();
  await ownerCreateMember.onRequest(
    {
      user: { sub: ownerId, userType: 'gym_operator' },
      body: {
        displayName,
        email: uniq('member') + '@example.com',
        phone: uniqPhone(),
        gymId: gym.id,
        tier: 'premium',
        paidAmount: 180000,
        durationUnit: 'M',
        startDate: dateOnly(start),
        endDate: dateOnly(end),
      },
    },
    out,
  );
  assert.equal(out.statusCode, 201, `create member failed: ${JSON.stringify(out.body)}`);
  return out.body.member;
}

// ───────────────────────── GET /owner/members ?gymId ─────────────────────────
test('owner members list is scoped to ?gymId — members from other owned gyms are excluded', async () => {
  const { ownerId, gymA, gymB } = await createOwnerWithTwoGyms();
  const memberA = await createDirectMember(ownerId, gymA, 'Gym A Member');
  const memberB = await createDirectMember(ownerId, gymB, 'Gym B Member');

  const scopedToA = res();
  await ownerListMembers.onRequest({ user: { sub: ownerId, userType: 'gym_operator' }, query: { gymId: gymA.id } }, scopedToA);
  assert.equal(scopedToA.statusCode, 200, JSON.stringify(scopedToA.body));
  assert.ok(scopedToA.body.members.some(m => m.id === memberA.id), 'gym A member must be present when scoped to gym A');
  assert.ok(!scopedToA.body.members.some(m => m.id === memberB.id), 'gym B member must be excluded when scoped to gym A');
  assert.equal(scopedToA.body.stats.totalMembers, 1, 'stats.totalMembers must reflect only the selected gym');

  const scopedToB = res();
  await ownerListMembers.onRequest({ user: { sub: ownerId, userType: 'gym_operator' }, query: { gymId: gymB.id } }, scopedToB);
  assert.equal(scopedToB.statusCode, 200);
  assert.ok(scopedToB.body.members.some(m => m.id === memberB.id));
  assert.ok(!scopedToB.body.members.some(m => m.id === memberA.id));

  const unscoped = res();
  await ownerListMembers.onRequest({ user: { sub: ownerId, userType: 'gym_operator' }, query: {} }, unscoped);
  assert.equal(unscoped.statusCode, 200);
  assert.ok(unscoped.body.members.some(m => m.id === memberA.id) && unscoped.body.members.some(m => m.id === memberB.id),
    'omitting gymId must still aggregate across every owned gym (back-compat)');
});

test('owner members list rejects a gymId the owner does not own — falls back to aggregate scope', async () => {
  const { ownerId, gymA, gymB } = await createOwnerWithTwoGyms();
  await createDirectMember(ownerId, gymA, 'Gym A Member');
  await createDirectMember(ownerId, gymB, 'Gym B Member');

  const out = res();
  await ownerListMembers.onRequest({ user: { sub: ownerId, userType: 'gym_operator' }, query: { gymId: 'gym_not_owned' } }, out);
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.members.length, 2, 'unowned gymId must not silently return an empty/foreign scope');
});

// ───────────────────────── GET /operator/dashboard totalMembers ─────────────────────────
test('operator dashboard exposes a real gym-scoped totalMembers count', async () => {
  const { ownerId, gymA, gymB } = await createOwnerWithTwoGyms();
  await createDirectMember(ownerId, gymA, 'Gym A Member 1');
  await createDirectMember(ownerId, gymA, 'Gym A Member 2');
  await createDirectMember(ownerId, gymB, 'Gym B Member 1');

  const dashA = res();
  await operatorDashboard.onRequest({ user: { sub: ownerId, userType: 'gym_operator' }, query: { gymId: gymA.id } }, dashA);
  assert.equal(dashA.statusCode, 200, JSON.stringify(dashA.body));
  assert.equal(dashA.body.totalMembers, 2, 'gym A dashboard must report its own registered member count');

  const dashB = res();
  await operatorDashboard.onRequest({ user: { sub: ownerId, userType: 'gym_operator' }, query: { gymId: gymB.id } }, dashB);
  assert.equal(dashB.statusCode, 200);
  assert.equal(dashB.body.totalMembers, 1, 'gym B dashboard must report its own registered member count');
});

// Self-registers a trainer, applies to a gym, and has the owner approve the
// join request — the current trainer↔gym linking flow (replaces the old
// direct ownerAddTrainer endpoint).
async function createTrainerLinkedToGym(ownerId, gym, displayName) {
  const trainerId = uniq('usr_trainer');
  await ensureUser({ id: trainerId, userType: 'trainer', displayName, phone: uniqPhone() });

  const register = res();
  await trainerRegister.onRequest(
    { user: { sub: trainerId, userType: 'trainer' }, body: { displayName, photoUrl: 'https://example.com/p.jpg', gender: 'male' } },
    register,
  );
  assert.equal(register.statusCode, 200, `trainer register failed: ${JSON.stringify(register.body)}`);

  const apply = res();
  await trainerApplyToGym.onRequest(
    { user: { sub: trainerId, userType: 'trainer' }, params: { gymId: gym.id } },
    apply,
  );
  assert.equal(apply.statusCode, 201, `trainer apply failed: ${JSON.stringify(apply.body)}`);

  const decide = res();
  await ownerDecideTrainerJoin.onRequest(
    { user: { sub: ownerId, userType: 'gym_operator' }, params: { trainerId: apply.body.id }, body: { gymId: gym.id, decision: 'approve' } },
    decide,
  );
  assert.equal(decide.statusCode, 200, `owner approval failed: ${JSON.stringify(decide.body)}`);
  return decide.body;
}

// ───────────────────────── GET /owner/trainers ?gymId ─────────────────────────
test('owner trainers list is scoped to ?gymId — trainers from other owned gyms are excluded', async () => {
  const { ownerId, gymA, gymB } = await createOwnerWithTwoGyms();

  const trainerA = await createTrainerLinkedToGym(ownerId, gymA, 'Trainer A');
  const trainerB = await createTrainerLinkedToGym(ownerId, gymB, 'Trainer B');

  const scopedToA = res();
  await ownerListTrainers.onRequest({ user: { sub: ownerId, userType: 'gym_operator' }, query: { gymId: gymA.id } }, scopedToA);
  assert.equal(scopedToA.statusCode, 200);
  assert.ok(scopedToA.body.some(t => t.id === trainerA.id), 'gym A trainer must be present when scoped to gym A');
  assert.ok(!scopedToA.body.some(t => t.id === trainerB.id), 'gym B trainer must be excluded when scoped to gym A');

  const unscoped = res();
  await ownerListTrainers.onRequest({ user: { sub: ownerId, userType: 'gym_operator' }, query: {} }, unscoped);
  assert.equal(unscoped.statusCode, 200);
  assert.ok(unscoped.body.some(t => t.id === trainerA.id) && unscoped.body.some(t => t.id === trainerB.id),
    'omitting gymId must still aggregate across every owned gym (back-compat)');
});

// ───────────────────────── GET /owner/earnings ?gymId ─────────────────────────
test('owner earnings summary is scoped to ?gymId — invoices from other owned gyms are excluded', async () => {
  const { ownerId, gymA, gymB } = await createOwnerWithTwoGyms();

  const invA = res();
  await adminCreateInvoice.onRequest(
    { user: { sub: 'usr_admin_test' }, body: { gymId: gymA.id, amount: 100000, periodStart: '2026-01-01', periodEnd: '2026-01-14' } },
    invA,
  );
  assert.equal(invA.statusCode, 200, JSON.stringify(invA.body));

  const invB = res();
  await adminCreateInvoice.onRequest(
    { user: { sub: 'usr_admin_test' }, body: { gymId: gymB.id, amount: 50000, periodStart: '2026-01-01', periodEnd: '2026-01-14' } },
    invB,
  );
  assert.equal(invB.statusCode, 200, JSON.stringify(invB.body));

  const scopedToA = res();
  await ownerMyEarnings.onRequest({ user: { sub: ownerId, userType: 'gym_operator' }, query: { gymId: gymA.id } }, scopedToA);
  assert.equal(scopedToA.statusCode, 200, JSON.stringify(scopedToA.body));
  assert.equal(scopedToA.body.totalPending, 100000, 'gym A earnings must exclude gym B invoices');

  const scopedToB = res();
  await ownerMyEarnings.onRequest({ user: { sub: ownerId, userType: 'gym_operator' }, query: { gymId: gymB.id } }, scopedToB);
  assert.equal(scopedToB.statusCode, 200);
  assert.equal(scopedToB.body.totalPending, 50000, 'gym B earnings must exclude gym A invoices');

  const unscoped = res();
  await ownerMyEarnings.onRequest({ user: { sub: ownerId, userType: 'gym_operator' }, query: {} }, unscoped);
  assert.equal(unscoped.statusCode, 200);
  assert.equal(unscoped.body.totalPending, 150000, 'omitting gymId must still aggregate across every owned gym (back-compat)');
});
