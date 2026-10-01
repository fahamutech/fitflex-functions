// Identity V2 · I6a — proving a phone or email through Firebase.
// The backend sends no code: it records what a fresh Firebase ID token proves
// for the Firebase account the caller already signs in with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { myIdentifiers, verifyMyIdentifier } from '../functions/identifiers.mjs';
import { gymCreateInvitation, myInvitations, acceptMyInvitation } from '../functions/invitations.mjs';
import { users } from '../src/bootstrap/services.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';

const uniq = p => `${p}_${randomUUID().slice(0, 8)}`;
const devToken = payload => `dev:${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
const localPhone = () => `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const e164 = local => `+255${local.slice(1)}`;

function res() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
async function call(route, claims, { params = {}, body = {}, query = {} } = {}) {
  const req = { headers: { authorization: `Bearer ${sign(claims)}` }, params, body, query };
  const out = res();
  for (const guard of [route.onGuard].flat()) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return out;
}
async function withFlags(flags, fn) {
  const names = ['IDENTITY_V2', 'V2_IDENTIFIERS', 'V2_INVITES', 'V2_LINKING'];
  const saved = Object.fromEntries(names.map(n => [n, process.env[n]]));
  for (const n of names) delete process.env[n];
  for (const f of flags) process.env[f] = 'true';
  if (flags.length) process.env.IDENTITY_V2 = 'true';
  try { return await fn(); } finally {
    for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
  }
}
const on = fn => withFlags(['V2_IDENTIFIERS', 'V2_INVITES'], fn);

async function makeUser(overrides = {}) {
  const row = {
    id: uniq('usr_i6a'), userType: 'member', accountStatus: 'active', approvalStatus: 'approved',
    createdAt: new Date().toISOString(), ...overrides,
  };
  await users.upsertAsync(u => u.id === row.id, row);
  return db('User').where({ id: row.id }).first();
}
/** A signed-in person with a Firebase account. */
async function person(overrides = {}) {
  const uid = uniq('fb');
  const user = await makeUser({ firebaseUid: uid, email: `${uniq('p')}@example.com`, displayName: 'Neema Abdallah', ...overrides });
  return { user, uid, claims: { sub: user.id, userType: user.userType } };
}
const verify = (p, token) => call(verifyMyIdentifier, p.claims, { body: { idToken: devToken(token) } });
const identifiersOf = personId => db('LoginIdentifier').where({ personId, status: 'active' }).whereIn('type', ['email', 'phone']);

test('flag off: the identifier routes do not exist', async () => {
  await withFlags([], async () => {
    const p = await person();
    assert.equal((await call(myIdentifiers, p.claims)).statusCode, 404);
    assert.equal((await verify(p, { uid: p.uid, phone_number: '+255712345678' })).statusCode, 404);
  });
});

test('a phone verified by Firebase is recorded on the Person, in E.164', async () => {
  await on(async () => {
    const local = localPhone();
    const p = await person({ phone: local });

    const before = await call(myIdentifiers, p.claims);
    assert.deepEqual(before.body.identifiers, []);
    assert.deepEqual(before.body.unverified.find(u => u.type === 'phone'), { type: 'phone', value: e164(local) });

    const done = await verify(p, { uid: p.uid, email: p.user.email, email_verified: false, phone_number: e164(local), sign_in_provider: 'phone' });
    assert.equal(done.statusCode, 200, JSON.stringify(done.body));
    assert.equal(done.body.identifiers.length, 1);
    assert.equal(done.body.identifiers[0].type, 'phone');
    assert.equal(done.body.identifiers[0].value, e164(local));
    assert.equal(done.body.identifiers[0].verified, true);
    assert.ok(done.body.unverified.some(u => u.type === 'email'), 'the unverified email stays unverified');

    const rows = await identifiersOf(p.user.personId);
    const phone = rows.find(r => r.type === 'phone');
    assert.equal(phone.normalizedValue, e164(local));
    assert.ok(phone.verifiedAt);
    assert.equal(phone.provider, 'phone');
    assert.equal(rows.some(r => r.type === 'email' && r.verifiedAt), false);

    // Idempotent.
    assert.equal((await verify(p, { uid: p.uid, phone_number: e164(local) })).statusCode, 200);
    assert.equal((await identifiersOf(p.user.personId)).filter(r => r.type === 'phone').length, 1);
  });
});

test('a verified email is recorded the same way', async () => {
  await on(async () => {
    const p = await person();
    const done = await verify(p, { uid: p.uid, email: p.user.email.toUpperCase(), email_verified: true });
    assert.equal(done.statusCode, 200);
    assert.deepEqual(done.body.identifiers.map(i => [i.type, i.value]), [['email', p.user.email]]);
  });
});

test('the token must be valid, fresh evidence for the caller\'s own Firebase account', async () => {
  await on(async () => {
    const p = await person();
    const other = await person();
    const phone = e164(localPhone());

    assert.equal((await call(verifyMyIdentifier, p.claims, { body: {} })).body.error, 'idToken_required');
    assert.equal((await call(verifyMyIdentifier, p.claims, { body: { idToken: 'not-a-token' } })).statusCode, 401);

    const stolen = await verify(p, { uid: other.uid, phone_number: phone });
    assert.equal(stolen.statusCode, 403);
    assert.equal(stolen.body.error, 'token_not_yours');
    assert.deepEqual(await identifiersOf(p.user.personId), []);
    assert.deepEqual(await identifiersOf(other.user.personId), []);

    const nothing = await verify(p, { uid: p.uid, email: p.user.email, email_verified: false });
    assert.equal(nothing.statusCode, 409);
    assert.equal(nothing.body.error, 'nothing_verified');

    // A persona with no Firebase account (legacy password sign-in) cannot verify.
    const legacy = await makeUser({ userType: 'vendor_staff' });
    const refused = await call(verifyMyIdentifier, { sub: legacy.id, userType: 'vendor_staff' }, { body: { idToken: devToken({ uid: uniq('fb'), phone_number: phone }) } });
    assert.equal(refused.statusCode, 403);
  });
});

test('a phone another person has verified is refused, never moved', async () => {
  await on(async () => {
    const phone = e164(localPhone());
    const first = await person();
    const second = await person();
    assert.equal((await verify(first, { uid: first.uid, phone_number: phone })).statusCode, 200);

    const clash = await verify(second, { uid: second.uid, phone_number: phone });
    assert.equal(clash.statusCode, 409);
    assert.equal(clash.body.error, 'identifier_in_use');
    assert.deepEqual(clash.body.identifierTypes, ['phone']);
    assert.equal((await identifiersOf(second.user.personId)).some(r => r.type === 'phone'), false);
    assert.equal((await identifiersOf(first.user.personId)).filter(r => r.type === 'phone').length, 1);
    const conflict = await db('IdentityConflict').where({ kind: 'verified_identifier_collision', normalizedValue: phone, status: 'open' }).first();
    assert.ok(conflict, 'left for review');
    assert.deepEqual([...conflict.personIds].sort(), [first.user.personId, second.user.personId].sort());
  });
});

test('verifying the phone claims an invitation that was sent to it', async () => {
  await on(async () => {
    const local = localPhone();
    const gymId = uniq('gym_i6a');
    await db('Gym').insert({ id: gymId, name: 'Iron Paradise', tier: 'standard', location: 'Dar es Salaam', status: 'active', updatedAt: new Date() });
    const owner = await makeUser({ userType: 'gym_operator', gymIds: [gymId], gymId });
    const p = await person();

    const sent = await call(gymCreateInvitation, { sub: owner.id, userType: 'gym_operator' }, { params: { gymId }, body: { role: 'staff', phone: local, aclPermissions: ['members'] } });
    assert.equal(sent.statusCode, 201);
    assert.deepEqual((await call(myInvitations, p.claims)).body.invitations, [], 'not theirs until the phone is proved');

    assert.equal((await verify(p, { uid: p.uid, phone_number: e164(local) })).statusCode, 200);
    const inv = await db('Invitation').where({ id: sent.body.invitation.id }).first();
    assert.equal(inv.status, 'claimed');
    assert.equal(inv.targetPersonId, p.user.personId);

    const mine = await call(myInvitations, p.claims);
    assert.equal(mine.body.invitations.length, 1);
    const accepted = await call(acceptMyInvitation, p.claims, { params: { invitationId: inv.id } });
    assert.equal(accepted.statusCode, 200);
    assert.equal((await db('User').where({ id: accepted.body.personaId }).first()).userType, 'gym_staff');
  });
});

test('other profiles are linked by the proved phone only when linking is on', async () => {
  const setup = async () => {
    const local = localPhone();
    // A profile a gym created at the desk: a phone, no Firebase account.
    const deskRow = await makeUser({ userType: 'trainer', phone: local, displayName: 'Desk Created' });
    const p = await person();
    return { local, deskRow, p };
  };
  await on(async () => {
    const { local, deskRow, p } = await setup();
    assert.equal((await verify(p, { uid: p.uid, phone_number: e164(local) })).statusCode, 200);
    assert.notEqual((await db('User').where({ id: deskRow.id }).first()).personId, p.user.personId, 'V2_LINKING off: nothing moves');
  });
  await withFlags(['V2_IDENTIFIERS', 'V2_LINKING'], async () => {
    const { local, deskRow, p } = await setup();
    assert.equal((await verify(p, { uid: p.uid, phone_number: e164(local) })).statusCode, 200);
    assert.equal((await db('User').where({ id: deskRow.id }).first()).personId, p.user.personId, 'D1: linked on verified evidence');
    const event = await db('IdentityEvent').where({ personId: p.user.personId, kind: 'link' }).first();
    assert.equal(event.trigger, 'identifier_verify');
  });
});
