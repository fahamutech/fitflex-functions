// Identity V2 · I1 — Person + LoginIdentifier foundation.
// Every User row maps to one Person without changing the User or its history;
// only verified evidence marks an identifier verified; conflicts are recorded,
// never merged; sign-in and JWT `sub` are unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { authFirebaseSession } from '../functions/auth.mjs';
import { me } from '../functions/subscriptions.mjs';
import { users, identityService } from '../src/bootstrap/services.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { reconcileIdentities } from '../src/infra/identity-reconcile.mjs';
import { normalizePhone } from '../src/shared/identifiers.mjs';
import { identityFlag } from '../src/shared/feature-flags.mjs';
import { toSessionUser } from '../src/shared/session-user.mjs';
import foundation from '../db/migrations/20261030090000-identity-foundation.cjs';
import linking from '../db/migrations/20261101090000-identity-linking.cjs';
import onePersonaPerType from '../db/migrations/20261103090000-identity-one-persona-per-type.cjs';
import orgMembership from '../db/migrations/20261105090000-org-membership.cjs';
import invitations from '../db/migrations/20261106090000-identity-invitations.cjs';
import verificationCodes from '../db/migrations/20261112090000-identity-verification-codes.cjs';

// Later identity migrations depend on Person, so a rollback runs newest first.
// Add each new identity migration here.
const LATER_IDENTITY_MIGRATIONS = [linking, onePersonaPerType, orgMembership, invitations, verificationCodes];

const uniq = p => `${p}_${randomUUID().slice(0, 8)}`;
const now = () => new Date().toISOString();
const localPhone = () => `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

function res() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const devToken = payload => `dev:${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;

async function makeUser(overrides = {}) {
  const row = {
    id: uniq('usr_i1'), userType: 'member', accountStatus: 'active', approvalStatus: 'approved',
    createdAt: now(), ...overrides,
  };
  await users.upsertAsync(u => u.id === row.id, row);
  return db('User').where({ id: row.id }).first();
}
const identifiersOf = personId => db('LoginIdentifier').where({ personId, status: 'active' }).orderBy('type');
const fakeFirebase = evidence => async uids => new Map(uids.filter(uid => evidence[uid]).map(uid => [uid, evidence[uid]]));

// ── 1, 2, 4, 8: Person creation and Firebase uid ───────────────────────────

test('every new User row gets exactly one active Person', async () => {
  const user = await makeUser({ email: `${uniq('p')}@example.com` });
  assert.match(user.personId, /^psn_[0-9a-f]{12}$/);
  const person = await db('Person').where({ id: user.personId }).first();
  assert.equal(person.status, 'active');
});

test('a Firebase uid becomes a verified firebase_uid identifier', async () => {
  const uid = uniq('fb');
  const user = await makeUser({ firebaseUid: uid });
  const [identifier] = await identifiersOf(user.personId);
  assert.equal(identifier.type, 'firebase_uid');
  assert.equal(identifier.normalizedValue, uid);
  assert.ok(identifier.verifiedAt, 'a Firebase uid is verified by definition');
});

test('two personas on one Firebase account share one Person', async () => {
  const uid = uniq('fb');
  const member = await makeUser({ firebaseUid: uid, userType: 'member' });
  const trainer = await makeUser({ firebaseUid: uid, userType: 'trainer' });
  assert.notEqual(member.id, trainer.id, 'still two User rows (personas)');
  assert.equal(member.personId, trainer.personId);
  const uids = (await identifiersOf(member.personId)).filter(i => i.type === 'firebase_uid');
  assert.equal(uids.length, 1);
});

test('an upsert of an existing row does not create another Person', async () => {
  const user = await makeUser();
  const before = Number((await db('Person').count({ n: '*' }).first()).n);
  await users.upsertAsync(u => u.id === user.id, { ...user, displayName: 'Renamed', personId: null });
  const after = Number((await db('Person').count({ n: '*' }).first()).n);
  assert.equal(after, before);
  assert.equal((await db('User').where({ id: user.id }).first()).personId, user.personId);
});

test('personId cannot be cleared or moved by an ordinary write', async () => {
  const a = await makeUser();
  const b = await makeUser();
  await db('User').where({ id: a.id }).update({ personId: null });
  assert.equal((await db('User').where({ id: a.id }).first()).personId, a.personId);
  await assert.rejects(
    db('User').where({ id: a.id }).update({ personId: b.personId }),
    /managed by identity linking/,
  );
});

// ── 3, 5, 6, 7: identifiers and verification evidence ───────────────────────

test('one Person can hold uid, verified email and verified phone identifiers', async () => {
  const uid = uniq('fb');
  const email = `${uniq('multi')}@example.com`;
  const phone = localPhone();
  const e164 = `+255${phone.slice(1)}`;
  const user = await makeUser({ firebaseUid: uid, email: email.toUpperCase(), phone: `${phone.slice(0, 4)} ${phone.slice(4)}` });
  await reconcileIdentities({
    db, apply: true,
    lookupFirebaseUsers: fakeFirebase({ [uid]: { email, emailVerified: true, phoneNumber: e164 } }),
  });
  const ids = await identifiersOf(user.personId);
  assert.deepEqual(ids.map(i => i.type), ['email', 'firebase_uid', 'phone']);
  const byType = Object.fromEntries(ids.map(i => [i.type, i]));
  assert.equal(byType.email.normalizedValue, email);
  assert.ok(byType.email.verifiedAt, 'Firebase verified the email');
  assert.equal(byType.phone.normalizedValue, e164);
  assert.ok(byType.phone.verifiedAt, 'Firebase holds the same phone');
});

test('without Firebase evidence an email is stored but never verified', async () => {
  const email = `${uniq('unverified')}@example.com`;
  const user = await makeUser({ email });
  await reconcileIdentities({ db, apply: true });
  const [identifier] = (await identifiersOf(user.personId)).filter(i => i.type === 'email');
  assert.equal(identifier.normalizedValue, email);
  assert.equal(identifier.verifiedAt, null);
});

test('Firebase saying unverified, or a different email, leaves it unverified', async () => {
  const uidA = uniq('fb');
  const uidB = uniq('fb');
  const a = await makeUser({ firebaseUid: uidA, email: `${uniq('a')}@example.com` });
  const b = await makeUser({ firebaseUid: uidB, email: `${uniq('b')}@example.com` });
  await reconcileIdentities({
    db, apply: true,
    lookupFirebaseUsers: fakeFirebase({
      [uidA]: { email: a.email, emailVerified: false },
      [uidB]: { email: 'someone-else@example.com', emailVerified: true },
    }),
  });
  for (const u of [a, b]) {
    const [email] = (await identifiersOf(u.personId)).filter(i => i.type === 'email');
    assert.equal(email.verifiedAt, null);
  }
});

test('the same unverified email on two uid-less rows is not linked', async () => {
  const email = `${uniq('shared')}@example.com`;
  const owner = await makeUser({ email, userType: 'gym_operator' });
  const member = await makeUser({ email, userType: 'member' });
  const report = await reconcileIdentities({ db, apply: true });
  assert.notEqual(owner.personId, member.personId, 'weak evidence never merges');
  assert.ok(report.possibleDuplicates.email >= 1, 'reported as a possible duplicate');
});

test('phones normalise to E.164 with the +255 default', () => {
  for (const input of ['0712 345 678', '712345678', '+255712345678', '255712345678', '00255712345678', '+255 712-345-678']) {
    assert.equal(normalizePhone(input), '+255712345678', input);
  }
  assert.equal(normalizePhone('+1 415 555 0100'), '+14155550100');
  for (const bad of ['12345', '071234567', 'abc', '', null, '+2557123456789000']) assert.equal(normalizePhone(bad), null, String(bad));
});

// ── 9: duplicate verified identifiers ───────────────────────────────────────

test('a verified email on two Persons becomes a conflict and is given to neither', async () => {
  const email = `${uniq('dupe')}@example.com`;
  const uidA = uniq('fb');
  const uidB = uniq('fb');
  const a = await makeUser({ firebaseUid: uidA, email });
  const b = await makeUser({ firebaseUid: uidB, email, userType: 'trainer' });
  const evidence = { email, emailVerified: true };
  await reconcileIdentities({ db, apply: true, lookupFirebaseUsers: fakeFirebase({ [uidA]: evidence, [uidB]: evidence }) });

  const conflict = await db('IdentityConflict')
    .where({ kind: 'verified_identifier_collision', identifierType: 'email', normalizedValue: email, status: 'open' }).first();
  assert.ok(conflict, 'an open, reviewable conflict');
  assert.deepEqual([...conflict.personIds].sort(), [a.personId, b.personId].sort());
  const verified = await db('LoginIdentifier').where({ type: 'email', normalizedValue: email }).whereNotNull('verifiedAt');
  assert.equal(verified.length, 0);
  assert.notEqual(a.personId, b.personId, 'not merged');
});

test('the database refuses one verified identifier on two Persons', async () => {
  const a = await makeUser();
  const b = await makeUser();
  const value = `${uniq('db')}@example.com`;
  const row = personId => ({
    id: uniq('lid'), personId, type: 'email', value, normalizedValue: value, verifiedAt: new Date(), status: 'active',
  });
  await db('LoginIdentifier').insert(row(a.personId));
  await assert.rejects(db('LoginIdentifier').insert(row(b.personId)), /login_identifier_verified_unique/);
});

test('rows sharing a Firebase uid on different Persons are reported, not merged', async () => {
  const uid = uniq('fb');
  const staffMade = await makeUser({ userType: 'gym_operator' });
  const selfMade = await makeUser({ firebaseUid: uid });
  // A later sign-in attaches the same uid to the staff-created row.
  await db('User').where({ id: staffMade.id }).update({ firebaseUid: uid });
  await reconcileIdentities({ db, apply: true });
  const conflict = await db('IdentityConflict')
    .where({ kind: 'firebase_uid_split', normalizedValue: uid, status: 'open' }).first();
  assert.ok(conflict);
  assert.deepEqual([...conflict.userIds].sort(), [staffMade.id, selfMade.id].sort());
  assert.notEqual((await db('User').where({ id: staffMade.id }).first()).personId, selfMade.personId);
});

// ── 10, 11, 12, 13: IDs, history, idempotency, rollback ─────────────────────

async function memberWithHistory() {
  const member = await makeUser({ email: `${uniq('hist')}@example.com` });
  const gymId = uniq('gym_i1');
  await db('Gym').insert({ id: gymId, name: 'I1 History Gym', tier: 'standard', location: 'Dar es Salaam', status: 'active', updatedAt: new Date() });
  const subId = uniq('sub');
  await db('Subscription').insert({
    id: subId, memberId: member.id, type: 'platform_pass', tier: 'basic', status: 'active',
    startedAt: new Date(), cycleStartedAt: new Date(), renewsAt: new Date(Date.now() + 864e5),
    expiresAt: new Date(Date.now() + 864e5),
  });
  const checkinId = uniq('chk');
  await db('Checkin').insert({
    id: checkinId, memberId: member.id, gymId, timestamp: new Date(), method: 'qr',
    subscriptionType: 'platform_pass', gymTier: 'standard', visitConsumed: true,
  });
  return { member, subId, checkinId };
}

test('reconcile and backfill are idempotent and never change User ids', async () => {
  const { member } = await memberWithHistory();
  const snapshot = async () => ({
    users: await db('User').orderBy('id').select('id', 'personId', 'publicId'),
    identifiers: Number((await db('LoginIdentifier').count({ n: '*' }).first()).n),
    conflicts: Number((await db('IdentityConflict').count({ n: '*' }).first()).n),
  });
  // One full pass settles everything (rows created since the migration get
  // their frozen public id); every later pass must change nothing.
  await foundation.backfill(db);
  await reconcileIdentities({ db, apply: true });
  const first = await snapshot();
  await foundation.backfill(db);
  await reconcileIdentities({ db, apply: true });
  assert.deepEqual(await snapshot(), first);
  assert.ok(first.users.some(u => u.id === member.id));
});

test('dry run reports but writes nothing', async () => {
  await makeUser({ email: `${uniq('dry')}@example.com`, phone: localPhone() });
  const before = Number((await db('LoginIdentifier').count({ n: '*' }).first()).n);
  const report = await reconcileIdentities({ db });
  assert.equal(report.mode, 'dry-run');
  assert.ok(report.identifiersAdded.email >= 1);
  assert.equal(Number((await db('LoginIdentifier').count({ n: '*' }).first()).n), before);
});

test('rolling the migration back and forward keeps every User and its history', async () => {
  const { member, subId, checkinId } = await memberWithHistory();
  const idsBefore = (await db('User').orderBy('id').select('id')).map(r => r.id);

  for (const m of [...LATER_IDENTITY_MIGRATIONS].reverse()) await m.down(db);
  await foundation.down(db);
  assert.equal(await db.schema.hasTable('Person'), false);
  assert.equal(await db.schema.hasColumn('User', 'personId'), false);
  assert.deepEqual((await db('User').orderBy('id').select('id')).map(r => r.id), idsBefore, 'down keeps User rows');

  await foundation.up(db);
  for (const m of LATER_IDENTITY_MIGRATIONS) await m.up(db);
  const idsAfter = await db('User').orderBy('id').select('id', 'personId');
  assert.deepEqual(idsAfter.map(r => r.id), idsBefore, 'User ids unchanged');
  assert.equal(idsAfter.filter(r => !r.personId).length, 0, 'every User maps to a Person again');
  assert.equal((await db('Subscription').where({ id: subId }).first()).memberId, member.id);
  assert.equal((await db('Checkin').where({ id: checkinId }).first()).memberId, member.id);
  assert.ok((await db('User').where({ id: member.id }).first()).publicId, 'backfill freezes a public id');
});

// ── 14, 15: sign-in and JWT unchanged; nothing new leaks ────────────────────

test('an existing account still signs in, and JWT sub is the persona id without pid', async () => {
  const uid = uniq('fb');
  const user = await makeUser({ firebaseUid: uid, email: `${uniq('login')}@example.com`, userType: 'trainer' });
  const out = res();
  await authFirebaseSession.onRequest({ body: { idToken: devToken({ uid, email: user.email }) } }, out);
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.user.id, user.id);
  const claims = jwt.decode(out.body.token);
  assert.equal(claims.sub, user.id);
  assert.equal('pid' in claims, false, 'pid arrives in I2, not I1');
  assert.equal('personId' in out.body.user, false, 'legacy clients see nothing new');
});

test('/me does not expose the Person link', async () => {
  const user = await makeUser();
  const out = res();
  await me.onRequest({ user: { sub: user.id, userType: 'member' } }, out);
  assert.equal(out.statusCode, 200);
  assert.equal('personId' in out.body.user, false);
  assert.equal('personId' in toSessionUser({ id: 'x', personId: 'psn_1' }), false);
});

// ── Flags ───────────────────────────────────────────────────────────────────

test('the frozen public id is read only when IDENTITY_V2 and V2_FOUNDATION are on', async () => {
  const user = await makeUser();
  await db('User').where({ id: user.id }).update({ publicId: 'FM999' });
  const row = await db('User').where({ id: user.id }).first();
  const saved = { a: process.env.IDENTITY_V2, b: process.env.V2_FOUNDATION };
  try {
    delete process.env.IDENTITY_V2; delete process.env.V2_FOUNDATION;
    assert.equal(identityFlag('V2_FOUNDATION'), false);
    assert.notEqual(await identityService.publicUserId(row), 'FM999');
    process.env.V2_FOUNDATION = 'true';
    assert.equal(identityFlag('V2_FOUNDATION'), false, 'needs the umbrella flag too');
    process.env.IDENTITY_V2 = 'true';
    assert.equal(identityFlag('V2_FOUNDATION'), true);
    assert.equal(await identityService.publicUserId(row), 'FM999');
    assert.notEqual(await identityService.publicUserId(row, 'trainer'), 'FM999', 'only for the row\'s own role');
  } finally {
    if (saved.a === undefined) delete process.env.IDENTITY_V2; else process.env.IDENTITY_V2 = saved.a;
    if (saved.b === undefined) delete process.env.V2_FOUNDATION; else process.env.V2_FOUNDATION = saved.b;
  }
  assert.throws(() => identityFlag('V2_NOPE'), /unknown/);
});
