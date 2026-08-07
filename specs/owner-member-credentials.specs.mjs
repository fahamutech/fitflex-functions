// B2/B3 — Owner-created members with login credentials (FitFlex App Issues
// 25.07.2026). The owner can set an initial password when registering a
// member; the member can then log in with that email + password.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemberManagementService } from '../src/services/member-management-service.mjs';
import { authFirebaseSession } from '../functions/auth.mjs';
import { updateMemberProfile } from '../functions/subscriptions.mjs';
import { ownerCreateGym } from '../functions/owner-gyms.mjs';
import { ownerCreateMember } from '../functions/owner-members.mjs';

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
    async upsertAsync(fn, row) {
      const i = rows.findIndex(fn);
      if (i >= 0) { rows[i] = { ...rows[i], ...row }; return rows[i]; }
      rows.push(row); return row;
    },
  };
}

function makeService({ createUserCalls = [] } = {}) {
  return createMemberManagementService({
    users: memStore(),
    gyms: [{ id: 'gym_1', name: 'Gym One', tier: 'standard' }],
    subscriptions: memStore(),
    checkins: memStore(),
    paymentRequests: memStore(),
    publicUserId: async () => 'FF-9000',
    initFirebaseAdmin: () => {},
    getAdminAuth: () => ({
      async createUser(args) {
        createUserCalls.push(args);
        return { uid: `fb_${createUserCalls.length}` };
      },
    }),
  });
}

const baseBody = () => ({
  displayName: 'Cred Member',
  email: uniq('cred') + '@example.com',
  phone: uniqPhone(),
  gymId: 'gym_1',
  tier: 'basic',
  durationUnit: 'M',
  startDate: '2026-08-01',
  endDate: '2026-08-31',
});

const owner = { id: 'usr_owner_1', gymIds: ['gym_1'] };

test('B2: createMember with initialPassword creates a Firebase credential', async () => {
  const createUserCalls = [];
  const service = makeService({ createUserCalls });
  const body = { ...baseBody(), initialPassword: 'secret123' };
  const out = await service.createMember({ owner, body });
  assert.ok(!out.error, JSON.stringify(out));
  assert.equal(createUserCalls.length, 1);
  assert.equal(createUserCalls[0].email, body.email);
  assert.equal(createUserCalls[0].password, 'secret123');
  assert.equal(out.credentialCreated, true);
  assert.ok(out.member.firebaseUid, 'member must be linked to the Firebase login');
});

test('B2: createMember without initialPassword creates no credential', async () => {
  const createUserCalls = [];
  const service = makeService({ createUserCalls });
  const out = await service.createMember({ owner, body: baseBody() });
  assert.ok(!out.error, JSON.stringify(out));
  assert.equal(createUserCalls.length, 0);
  assert.equal(out.credentialCreated, false);
});

test('B2: initialPassword must be at least 6 characters', async () => {
  const service = makeService();
  const out = await service.createMember({ owner, body: { ...baseBody(), initialPassword: '123' } });
  assert.equal(out.status, 400);
  assert.equal(out.error, 'initialPassword_too_short');
});

test('B2: initialPassword requires an email', async () => {
  const service = makeService();
  const body = { ...baseBody(), email: null, initialPassword: 'secret123' };
  const out = await service.createMember({ owner, body });
  assert.equal(out.status, 400);
  assert.equal(out.error, 'email_required_for_credentials');
});

test('B2: Firebase failure does not block member creation', async () => {
  const service = createMemberManagementService({
    users: memStore(),
    gyms: [{ id: 'gym_1', name: 'Gym One', tier: 'standard' }],
    subscriptions: memStore(),
    checkins: memStore(),
    paymentRequests: memStore(),
    publicUserId: async () => 'FF-9001',
    initFirebaseAdmin: () => {},
    getAdminAuth: () => ({ async createUser() { throw new Error('firebase down'); } }),
  });
  const out = await service.createMember({ owner, body: { ...baseBody(), initialPassword: 'secret123' } });
  assert.ok(!out.error, JSON.stringify(out));
  assert.equal(out.credentialCreated, false);
});

// ── B3: the created member can log in (Firebase session links by email) ──

async function createOwnerWithGym() {
  const ownerId = uniq('usr_owner_cred');
  const profile = res();
  await updateMemberProfile.onRequest(
    { user: { sub: ownerId, userType: 'gym_operator' }, body: { displayName: 'Cred Owner', phone: uniqPhone() } },
    profile,
  );
  assert.equal(profile.statusCode, 200);
  const gymRes = res();
  await ownerCreateGym.onRequest(
    { user: { sub: ownerId, userType: 'gym_operator' }, body: { name: uniq('Cred Gym'), tier: 'standard', location: 'Dar', perVisitRate: 5000 } },
    gymRes,
  );
  assert.equal(gymRes.statusCode, 201);
  return { ownerId, gym: gymRes.body };
}

test('B3: an owner-created member can sign in with their email and use the app', async () => {
  const { ownerId, gym } = await createOwnerWithGym();
  const email = uniq('login_member') + '@example.com';

  const created = res();
  await ownerCreateMember.onRequest(
    {
      user: { sub: ownerId, userType: 'gym_operator' },
      body: { ...baseBody(), email, gymId: gym.id },
    },
    created,
  );
  assert.equal(created.statusCode, 201, JSON.stringify(created.body));

  // Firebase email sign-in then session exchange links the account by email.
  const session = res();
  await authFirebaseSession.onRequest(
    {
      body: {
        idToken: `dev:${Buffer.from(JSON.stringify({ uid: `fb_${email}`, email, name: 'Cred Member' })).toString('base64url')}`,
        requestedRole: 'member',
      },
    },
    session,
  );
  assert.equal(session.statusCode, 200, JSON.stringify(session.body));
  assert.equal(session.body.user.userType, 'member');
  assert.equal(session.body.user.id, created.body.member.id, 'must link to the owner-created member, not create a new user');
  assert.equal(session.body.user.onboardingCompleted, true, 'owner-created members skip onboarding');
  assert.ok(session.body.token);
});
