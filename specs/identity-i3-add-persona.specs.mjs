// Identity V2 · I3 — one Person, several personas.
// Adding a persona creates a new User row under the caller's existing Person:
// no second Person, no duplicated identifiers, existing ids and history
// untouched, and each persona still authorises only as its own role.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { addMyPersona, authSwitchPersona, myPersonas } from '../functions/auth.mjs';
import { users } from '../src/bootstrap/services.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';

const uniq = p => `${p}_${randomUUID().slice(0, 8)}`;

function res() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

async function withFlags(flags, fn) {
  const names = ['IDENTITY_V2', 'V2_LINKING', 'V2_PERSONAS', 'V2_ADD_PERSONA'];
  const saved = Object.fromEntries(names.map(n => [n, process.env[n]]));
  for (const n of names) delete process.env[n];
  for (const f of flags) process.env[f] = 'true';
  if (flags.length) process.env.IDENTITY_V2 = 'true';
  try { return await fn(); } finally {
    for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
  }
}
const ON = ['V2_PERSONAS', 'V2_ADD_PERSONA'];

async function makeUser(overrides = {}) {
  const row = {
    id: uniq('usr_i3'), userType: 'member', accountStatus: 'active', approvalStatus: 'approved',
    createdAt: new Date().toISOString(), ...overrides,
  };
  await users.upsertAsync(u => u.id === row.id, row);
  return db('User').where({ id: row.id }).first();
}
async function add(claims, userType) {
  const out = res();
  await addMyPersona.onRequest({ user: claims, body: { userType } }, out);
  return out;
}
const count = async (table, where = {}) => Number((await db(table).where(where).count({ n: '*' }).first()).n);
async function guardPasses(guard, token) {
  let passed = false;
  await guard({ headers: { authorization: `Bearer ${token}` } }, res(), () => { passed = true; });
  return passed;
}

test('flag off: adding a persona is not available', async () => {
  await withFlags(['V2_PERSONAS'], async () => {
    const member = await makeUser({ firebaseUid: uniq('fb') });
    assert.equal((await add({ sub: member.id, userType: 'member' }, 'trainer')).statusCode, 404);
    const list = res();
    await myPersonas.onRequest({ user: { sub: member.id } }, list);
    assert.deepEqual(list.body.addablePersonaTypes, []);
  });
});

test('one Person, one persona: the baseline lists what could be added', async () => {
  await withFlags(ON, async () => {
    const member = await makeUser({ firebaseUid: uniq('fb') });
    const list = res();
    await myPersonas.onRequest({ user: { sub: member.id } }, list);
    assert.deepEqual(list.body.personas.map(p => p.id), [member.id]);
    assert.deepEqual(list.body.addablePersonaTypes, ['trainer', 'gym_operator', 'vendor']);
  });
});

test('adding a persona creates a new User under the same Person, nothing else', async () => {
  await withFlags(ON, async () => {
    const uid = uniq('fb');
    const email = `${uniq('multi')}@example.com`;
    const member = await makeUser({ firebaseUid: uid, email, displayName: 'Asha' });
    const personsBefore = await count('Person');
    const identifiersBefore = await count('LoginIdentifier', { personId: member.personId });

    const out = await add({ sub: member.id, userType: 'member' }, 'trainer');
    assert.equal(out.statusCode, 201);
    assert.equal(out.body.created, true);
    const trainer = await db('User').where({ id: out.body.persona.id }).first();

    assert.notEqual(trainer.id, member.id, 'a new persona row');
    assert.equal(trainer.personId, member.personId, 'explicitly on the same Person');
    assert.equal(trainer.userType, 'trainer');
    assert.equal(trainer.approvalStatus, 'approved', 'a trainer is active at once (not verified until KYC)');
    assert.equal(trainer.onboardingCompleted, false);
    // Same identifier across personas: display copies on the row, one identifier on the Person.
    assert.equal(trainer.firebaseUid, uid);
    assert.equal(trainer.email, email);
    assert.equal(await count('Person'), personsBefore, 'no second Person');
    assert.equal(await count('LoginIdentifier', { personId: member.personId }), identifiersBefore, 'no duplicated identifiers');
    assert.equal(await count('LoginIdentifier', { type: 'firebase_uid', normalizedValue: uid }), 1);

    const unchanged = await db('User').where({ id: member.id }).first();
    assert.equal(unchanged.userType, 'member', 'the existing persona is untouched');
    assert.deepEqual(out.body.personas.map(p => p.userType).sort(), ['member', 'trainer']);
    assert.deepEqual(out.body.addablePersonaTypes, ['gym_operator', 'vendor']);
  });
});

test('one Person can hold member, trainer, owner and vendor; each type only once', async () => {
  await withFlags(ON, async () => {
    const member = await makeUser({ firebaseUid: uniq('fb') });
    const claims = { sub: member.id, userType: 'member' };
    for (const type of ['trainer', 'gym_owner', 'vendor']) assert.equal((await add(claims, type)).statusCode, 201, type);

    const again = await add(claims, 'trainer');
    assert.equal(again.statusCode, 200, 'idempotent');
    assert.equal(again.body.created, false);
    const personas = await db('User').where({ personId: member.personId });
    assert.deepEqual(personas.map(p => p.userType).sort(), ['gym_operator', 'member', 'trainer', 'vendor']);
    assert.deepEqual(again.body.addablePersonaTypes, []);
  });
});

test('the database refuses a second live persona of the same type', async () => {
  const member = await makeUser();
  await assert.rejects(
    db('User').insert({
      id: uniq('usr_dup'), personId: member.personId, userType: 'member',
      accountStatus: 'active', approvalStatus: 'approved', createdAt: new Date(), updatedAt: new Date(),
    }),
    /user_person_type_unique/,
  );
});

test('organisation and platform roles cannot be self-added', async () => {
  await withFlags(ON, async () => {
    const member = await makeUser({ firebaseUid: uniq('fb') });
    for (const type of ['gym_staff', 'vendor_staff', 'corporate_hr', 'admin', '', undefined]) {
      const out = await add({ sub: member.id, userType: 'member' }, type);
      assert.equal(out.statusCode, 400, String(type));
      assert.equal(out.body.error, 'persona_type_not_allowed');
    }
    assert.equal(await count('User', { personId: member.personId }), 1);
  });
});

test('a suspended Person cannot add personas', async () => {
  await withFlags(ON, async () => {
    const member = await makeUser({ firebaseUid: uniq('fb') });
    await db('Person').where({ id: member.personId }).update({ status: 'suspended' });
    const out = await add({ sub: member.id, userType: 'member' }, 'trainer');
    assert.equal(out.statusCode, 403);
    assert.equal(out.body.error, 'person_not_active');
  });
});

test('an email already used by another profile of that role is refused, not duplicated', async () => {
  await withFlags(ON, async () => {
    const email = `${uniq('taken')}@example.com`;
    const member = await makeUser({ firebaseUid: uniq('fb'), email });
    const gymMade = await makeUser({ email, userType: 'trainer' }); // unlinked, created by a gym
    const out = await add({ sub: member.id, userType: 'member' }, 'trainer');
    assert.equal(out.statusCode, 409);
    assert.equal(out.body.error, 'persona_identifier_in_use');
    assert.equal(await count('User', { personId: member.personId }), 1);
    assert.notEqual(gymMade.personId, member.personId, 'the other profile is left alone');
  });
});

test('persona-specific authorisation: each token works only for its own role', async () => {
  await withFlags(ON, async () => {
    const member = await makeUser({ firebaseUid: uniq('fb') });
    const added = await add({ sub: member.id, userType: 'member' }, 'vendor');
    const vendorId = added.body.persona.id;

    const switched = res();
    await authSwitchPersona.onRequest({ user: { sub: member.id, userType: 'member' }, body: { personaId: vendorId } }, switched);
    assert.equal(switched.statusCode, 200);
    const vendorToken = switched.body.token;
    const claims = jwt.decode(vendorToken);
    assert.equal(claims.sub, vendorId, 'sub is the new persona (legacy JWT contract)');
    assert.equal(claims.userType, 'vendor');
    assert.equal(claims.pid, member.personId, 'same Person');

    assert.equal(await guardPasses(requireAuth('vendor'), vendorToken), true);
    assert.equal(await guardPasses(requireAuth('member'), vendorToken), false, 'a vendor token is not a member');
    assert.equal(await guardPasses(requireAuth('trainer'), vendorToken), false);
  });
});

test('existing history stays on the original persona', async () => {
  await withFlags(ON, async () => {
    const member = await makeUser({ firebaseUid: uniq('fb') });
    const subId = uniq('sub');
    await db('Subscription').insert({
      id: subId, memberId: member.id, type: 'platform_pass', tier: 'basic', status: 'active',
      startedAt: new Date(), cycleStartedAt: new Date(), renewsAt: new Date(Date.now() + 864e5),
      expiresAt: new Date(Date.now() + 864e5),
    });
    const out = await add({ sub: member.id, userType: 'member' }, 'trainer');
    assert.equal(out.statusCode, 201);
    assert.equal((await db('Subscription').where({ id: subId }).first()).memberId, member.id);
    assert.equal(await count('Subscription', { memberId: out.body.persona.id }), 0, 'the new persona starts clean');
  });
});
