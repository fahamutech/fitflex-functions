// Identity V2 · I6 (slice A) — invitations for gym staff and trainers.
// Organisations invite; they never create accounts or set credentials. A token
// alone grants nothing; accepting needs the invited person's own session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import {
  gymPeopleLookup, gymCreateInvitation, gymListInvitations, gymCancelInvitation, gymResendInvitation,
  myInvitations, openMyInvitation, acceptMyInvitation, declineMyInvitation,
} from '../functions/invitations.mjs';
import { ownerCreateStaff } from '../functions/owner-staff.mjs';
import { ownerCreateTrainer } from '../functions/owner-gyms.mjs';
import { users, trainers } from '../src/bootstrap/services.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { maskName } from '../src/services/invitation-service.mjs';

const uniq = p => `${p}_${randomUUID().slice(0, 8)}`;
const localPhone = () => `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

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
async function withEnv(env, fn) {
  const names = ['IDENTITY_V2', 'V2_INVITES', ...Object.keys(env)];
  const saved = Object.fromEntries(names.map(n => [n, process.env[n]]));
  process.env.IDENTITY_V2 = 'true'; process.env.V2_INVITES = 'true';
  Object.assign(process.env, env);
  try { return await fn(); } finally {
    for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
  }
}
const on = fn => withEnv({}, fn);

async function makeGym() {
  const id = uniq('gym_i6');
  await db('Gym').insert({ id, name: 'Iron Paradise', tier: 'standard', location: 'Dar es Salaam', status: 'active', updatedAt: new Date() });
  return id;
}
async function makeUser(overrides = {}) {
  const row = {
    id: uniq('usr_i6'), userType: 'member', accountStatus: 'active', approvalStatus: 'approved',
    createdAt: new Date().toISOString(), ...overrides,
  };
  await users.upsertAsync(u => u.id === row.id, row);
  return db('User').where({ id: row.id }).first();
}
async function makeOwner() {
  const gymId = await makeGym();
  const owner = await makeUser({ userType: 'gym_operator', gymIds: [gymId], gymId });
  return { owner, gymId, claims: { sub: owner.id, userType: 'gym_operator' } };
}
/** A person with a VERIFIED email, as a verified sign-in would record it. */
async function verifiedPerson(overrides = {}) {
  const email = `${uniq('person')}@example.com`;
  const user = await makeUser({ firebaseUid: uniq('fb'), email, displayName: 'Neema Abdallah', ...overrides });
  await db('LoginIdentifier').insert({
    id: uniq('lid'), personId: user.personId, type: 'email', value: email, normalizedValue: email,
    verifiedAt: new Date(), status: 'active',
  });
  return { user, email, claims: { sub: user.id, userType: user.userType } };
}
const invite = (o, body) => call(gymCreateInvitation, o.claims, { params: { gymId: o.gymId }, body });

// ── Off ────────────────────────────────────────────────────────────────────

test('flag off: no invitation routes, and the legacy trainer create still works', async () => {
  const o = await makeOwner();
  assert.equal((await invite(o, { role: 'staff', email: 'a@example.com' })).statusCode, 404);
  assert.equal((await call(myInvitations, o.claims)).statusCode, 404);
  const legacy = await call(ownerCreateTrainer, o.claims, {
    body: { gymId: o.gymId, displayName: 'Coach', email: `${uniq('coach')}@example.com`, initialPin: '2468' },
  });
  assert.equal(legacy.statusCode, 201);
});

// ── Lookup ─────────────────────────────────────────────────────────────────

test('lookup answers only found + a masked name, and only for verified identifiers', async () => {
  await on(async () => {
    const o = await makeOwner();
    const { email } = await verifiedPerson();
    const unverified = await makeUser({ email: `${uniq('unv')}@example.com`, displayName: 'Hidden Person' });
    const look = body => call(gymPeopleLookup, o.claims, { params: { gymId: o.gymId }, body });

    const hit = await look({ email: email.toUpperCase() });
    assert.deepEqual(hit.body, { found: true, maskedName: 'N**** A*******' });
    const miss = await look({ email: `${uniq('nobody')}@example.com` });
    const unverifiedMatch = await look({ email: unverified.email });
    assert.deepEqual(unverifiedMatch.body, miss.body, 'an unverified match is indistinguishable from no match');
    assert.deepEqual(miss.body, { found: false, maskedName: null });

    assert.equal((await look({})).statusCode, 400);
    assert.equal((await look({ email, phone: '0712345678' })).statusCode, 400, 'exactly one identifier');
    assert.equal((await look({ email: 'not-an-email' })).statusCode, 400);

    const log = await db('OrgLookupLog').where({ actorUserId: o.owner.id }).orderBy('createdAt');
    assert.equal(log.length, 3);
    assert.equal(log[0].identifierHash, createHash('sha256').update(email).digest('hex'));
    assert.equal(JSON.stringify(log).includes(email), false, 'the identifier itself is never stored');
  });
  assert.equal(maskName('  asha  '), 'A***');
});

test('lookups are rate-limited per person and pause after repeated misses', async () => {
  await withEnv({ LOOKUP_PER_ACTOR_PER_HOUR: '3' }, async () => {
    const o = await makeOwner();
    const { email } = await verifiedPerson();
    const look = () => call(gymPeopleLookup, o.claims, { params: { gymId: o.gymId }, body: { email } });
    for (let i = 0; i < 3; i += 1) assert.equal((await look()).statusCode, 200);
    const limited = await look();
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.body.error, 'lookup_rate_limited');
  });
  await withEnv({ LOOKUP_MISSES_BEFORE_COOLDOWN: '2' }, async () => {
    const o = await makeOwner();
    const miss = () => call(gymPeopleLookup, o.claims, { params: { gymId: o.gymId }, body: { email: `${uniq('x')}@example.com` } });
    await miss(); await miss();
    assert.equal((await miss()).body.error, 'lookup_cooldown');
  });
});

// ── Staff invitation ───────────────────────────────────────────────────────

test('a known person accepts a staff invitation: persona and membership, no credentials', async () => {
  await on(async () => {
    const o = await makeOwner();
    const p = await verifiedPerson();
    const sent = await invite(o, { role: 'staff', email: p.email, aclPermissions: ['members', 'checkins'], message: 'Welcome' });
    assert.equal(sent.statusCode, 201);
    assert.ok(sent.body.token, 'the link token is returned once');
    // The in-app notice is in English for someone who never chose a language…
    const notice = await db('Notification').where({ userId: p.user.id, type: 'org_invitation' }).first();
    assert.deepEqual([notice.title, notice.body], ['You have an invitation', 'Iron Paradise invited you to join as staff.']);
    // …and in Swahili for someone who chose it.
    const q = await verifiedPerson();
    await db('CommunicationPreference').insert({ id: q.user.id, locale: 'sw', createdAt: new Date(), updatedAt: new Date() });
    try {
      assert.equal((await invite(o, { role: 'staff', email: q.email })).statusCode, 201);
      const inSw = await db('Notification').where({ userId: q.user.id, type: 'org_invitation' }).first();
      assert.deepEqual([inSw.title, inSw.body], ['Una mwaliko', 'Iron Paradise imekualika kujiunga kama mfanyakazi.']);
      assert.equal(inSw.data.role, 'staff');
    } finally {
      await db('CommunicationPreference').where('id', q.user.id).del();
    }
    const stored = await db('Invitation').where({ id: sent.body.invitation.id }).first();
    assert.equal(stored.targetPersonId, p.user.personId);
    assert.notEqual(stored.tokenHash, sent.body.token, 'only the hash is stored');
    assert.equal(JSON.stringify(sent.body.invitation).includes('tokenHash'), false);

    const again = await invite(o, { role: 'staff', email: p.email });
    assert.equal(again.statusCode, 200);
    assert.equal(again.body.created, false, 'one open invitation per person and role');

    const inbox = await call(myInvitations, p.claims);
    assert.deepEqual(inbox.body.invitations.map(i => [i.id, i.role, i.orgName]), [[stored.id, 'staff', 'Iron Paradise']]);

    const accepted = await call(acceptMyInvitation, p.claims, { params: { invitationId: stored.id } });
    assert.equal(accepted.statusCode, 200);
    const staff = await db('User').where({ id: accepted.body.personaId }).first();
    assert.equal(staff.userType, 'gym_staff');
    assert.equal(staff.personId, p.user.personId, 'a persona of the same Person');
    assert.deepEqual(staff.gymIds, [o.gymId]);
    assert.deepEqual([...staff.aclPermissions].sort(), ['checkins', 'members']);
    assert.equal(staff.passwordHash, null, 'the organisation set no credential');
    assert.equal(staff.firebaseUid, p.user.firebaseUid, 'they sign in with their own account');

    const membership = await db('OrgMembership').where({ id: accepted.body.membershipId }).first();
    assert.deepEqual([membership.role, membership.status, membership.source, membership.gymId], ['staff', 'active', 'invite', o.gymId]);
    assert.equal((await db('Invitation').where({ id: stored.id }).first()).status, 'accepted');

    assert.equal((await call(acceptMyInvitation, p.claims, { params: { invitationId: stored.id } })).statusCode, 409);
    assert.equal((await invite(o, { role: 'staff', email: p.email })).body.error, 'already_a_member');
  });
});

test('declining leaves no persona and no membership', async () => {
  await on(async () => {
    const o = await makeOwner();
    const p = await verifiedPerson();
    const sent = await invite(o, { role: 'staff', email: p.email });
    const out = await call(declineMyInvitation, p.claims, { params: { invitationId: sent.body.invitation.id } });
    assert.equal(out.body.invitation.status, 'declined');
    assert.equal(Number((await db('User').where({ personId: p.user.personId, userType: 'gym_staff' }).count({ n: '*' }).first()).n), 0);
    assert.equal(Number((await db('OrgMembership').where({ personId: p.user.personId, gymId: o.gymId }).count({ n: '*' }).first()).n), 0);
  });
});

// ── The token grants nothing ───────────────────────────────────────────────

test('a token alone grants nothing; an unknown person claims only after verifying the identifier', async () => {
  await on(async () => {
    const o = await makeOwner();
    const phone = localPhone();
    const e164 = `+255${phone.slice(1)}`;
    const sent = await invite(o, { role: 'staff', phone, aclPermissions: ['checkins'] });
    assert.equal(sent.statusCode, 201);
    const invitationId = sent.body.invitation.id;
    assert.equal((await db('Invitation').where({ id: invitationId }).first()).targetPersonId, null);

    // Someone else gets hold of the link.
    const thief = await verifiedPerson();
    const stolen = await call(openMyInvitation, thief.claims, { body: { token: sent.body.token } });
    assert.equal(stolen.statusCode, 403);
    assert.equal(stolen.body.error, 'identifier_not_verified');
    assert.equal((await call(acceptMyInvitation, thief.claims, { params: { invitationId } })).statusCode, 404);
    assert.equal((await call(openMyInvitation, thief.claims, { body: { token: 'wrong' } })).statusCode, 404);

    // The invited person signs up; until the phone is verified, nothing is theirs.
    const invited = await makeUser({ firebaseUid: uniq('fb'), phone });
    const claims = { sub: invited.id, userType: 'member' };
    assert.deepEqual((await call(myInvitations, claims)).body.invitations, []);

    // Firebase verifies the phone (recorded by verified sign-in linking).
    await db('LoginIdentifier').insert({
      id: uniq('lid'), personId: invited.personId, type: 'phone', value: phone, normalizedValue: e164,
      verifiedAt: new Date(), status: 'active',
    });
    const mine = await call(myInvitations, claims);
    assert.deepEqual(mine.body.invitations.map(i => [i.id, i.status]), [[invitationId, 'claimed']]);
    assert.equal((await call(openMyInvitation, claims, { body: { token: sent.body.token } })).statusCode, 200);
    assert.equal((await call(acceptMyInvitation, claims, { params: { invitationId } })).statusCode, 200);
  });
});

// ── Trainer invitation ─────────────────────────────────────────────────────

test('a trainer invitation adds the gym to an existing trainer profile, after acceptance', async () => {
  await on(async () => {
    const o = await makeOwner();
    const p = await verifiedPerson();
    const sent = await invite(o, { role: 'trainer', email: p.email });
    const invitationId = sent.body.invitation.id;

    const trainer = await makeUser({ firebaseUid: p.user.firebaseUid, userType: 'trainer' });
    const profileId = uniq('trn');
    await trainers.upsertAsync(t => t.id === profileId, { id: profileId, userId: trainer.id, displayName: 'Coach', gymIds: [] });
    assert.equal(Number((await db('TrainerProfileGym').where({ trainerId: profileId }).count({ n: '*' }).first()).n), 0, 'nothing attached before acceptance');

    const accepted = await call(acceptMyInvitation, p.claims, { params: { invitationId } });
    assert.equal(accepted.statusCode, 200);
    assert.deepEqual((await db('TrainerProfileGym').where({ trainerId: profileId })).map(r => r.gymId), [o.gymId]);
    const m = await db('OrgMembership').where({ id: accepted.body.membershipId }).first();
    assert.deepEqual([m.role, m.status, m.personaId], ['trainer', 'active', trainer.id]);
  });
});

test('a person with no trainer profile gets one at that gym when they accept a trainer invitation', async () => {
  await on(async () => {
    const o = await makeOwner();
    const p = await verifiedPerson();
    const sent = await invite(o, { role: 'trainer', email: p.email });
    assert.equal(await db('User').where({ personId: p.user.personId, userType: 'trainer' }).first(), undefined, 'nothing before acceptance');

    const accepted = await call(acceptMyInvitation, p.claims, { params: { invitationId: sent.body.invitation.id } });
    assert.equal(accepted.statusCode, 200, JSON.stringify(accepted.body));
    const persona = await db('User').where({ id: accepted.body.personaId }).first();
    assert.equal(persona.userType, 'trainer');
    assert.equal(persona.personId, p.user.personId, 'under the same Person');
    assert.equal(persona.approvalStatus, 'approved');
    const profile = trainers.find(t => t.userId === persona.id);
    assert.equal(profile.displayName, 'Neema Abdallah');
    assert.deepEqual(profile.gymIds, [o.gymId]);
    assert.equal((await db('User').where({ personId: p.user.personId })).length, 2, 'their member profile is untouched');
  });
});

// ── Organisation boundaries and lifecycle ──────────────────────────────────

test('only the gym\'s owner manages its invitations', async () => {
  await on(async () => {
    const a = await makeOwner();
    const b = await makeOwner();
    const p = await verifiedPerson();
    const sent = await invite(a, { role: 'staff', email: p.email });
    const id = sent.body.invitation.id;
    const asB = params => ({ params: { gymId: a.gymId, ...params } });
    assert.equal((await call(gymCreateInvitation, b.claims, { ...asB({}), body: { role: 'staff', email: 'x@example.com' } })).body.error, 'not_your_gym');
    assert.equal((await call(gymListInvitations, b.claims, asB({}))).statusCode, 403);
    assert.equal((await call(gymCancelInvitation, b.claims, asB({ invitationId: id }))).statusCode, 403);
    // B's own gym cannot reach A's invitation either.
    assert.equal((await call(gymCancelInvitation, b.claims, { params: { gymId: b.gymId, invitationId: id } })).statusCode, 404);
    assert.equal((await call(gymListInvitations, { sub: p.user.id, userType: 'member' }, asB({}))).statusCode, 403);

    const listed = await call(gymListInvitations, a.claims, { params: { gymId: a.gymId } });
    assert.deepEqual(listed.body.invitations.map(i => i.id), [id]);
  });
});

test('cancel, resend (new link, limited) and expiry', async () => {
  await withEnv({ INVITE_MAX_RESENDS: '1' }, async () => {
    const o = await makeOwner();
    const p = await verifiedPerson();
    const sent = await invite(o, { role: 'staff', email: p.email });
    const params = { gymId: o.gymId, invitationId: sent.body.invitation.id };
    const dayOld = () => db('Invitation').where({ id: params.invitationId }).update({ lastSentAt: new Date(Date.now() - 25 * 3600e3) });
    await dayOld(); // a day has passed since it was sent

    const resent = await call(gymResendInvitation, o.claims, { params });
    assert.equal(resent.statusCode, 200);
    assert.notEqual(resent.body.token, sent.body.token);
    assert.equal((await call(openMyInvitation, p.claims, { body: { token: sent.body.token } })).statusCode, 404, 'the old link stops working');
    assert.equal((await call(openMyInvitation, p.claims, { body: { token: resent.body.token } })).statusCode, 200);
    await dayOld();
    assert.equal((await call(gymResendInvitation, o.claims, { params })).body.error, 'resend_limit_reached');

    await db('Invitation').where({ id: params.invitationId }).update({ createdAt: new Date(Date.now() - 20 * 864e5), expiresAt: new Date(Date.now() - 864e5) });
    assert.deepEqual((await call(myInvitations, p.claims)).body.invitations, []);
    assert.equal((await db('Invitation').where({ id: params.invitationId }).first()).status, 'expired');
    assert.equal((await call(acceptMyInvitation, p.claims, { params: { invitationId: params.invitationId } })).statusCode, 409);

    const second = await invite(o, { role: 'staff', email: p.email });
    assert.equal(second.statusCode, 201, 'a new invitation can follow an expired one');
    const cancelled = await call(gymCancelInvitation, o.claims, { params: { gymId: o.gymId, invitationId: second.body.invitation.id } });
    assert.equal(cancelled.body.invitation.status, 'cancelled');
    assert.equal((await call(acceptMyInvitation, p.claims, { params: { invitationId: second.body.invitation.id } })).statusCode, 409);
  });
  await on(async () => {
    const o = await makeOwner();
    const p = await verifiedPerson();
    const sent = await invite(o, { role: 'staff', email: p.email });
    const soon = await call(gymResendInvitation, o.claims, { params: { gymId: o.gymId, invitationId: sent.body.invitation.id } });
    assert.equal(soon.body.error, 'resend_too_soon');
  });
});

test('input rules: role, ACL scopes, and staff at another organisation', async () => {
  await on(async () => {
    const o = await makeOwner();
    const p = await verifiedPerson();
    assert.equal((await invite(o, { role: 'member', email: p.email })).body.error, 'durationUnit_must_be_D_W_or_M', 'a member invitation needs its plan');
    assert.equal((await invite(o, { role: 'owner', email: p.email })).body.error, 'role_not_invitable');
    assert.equal((await invite(o, { role: 'staff', email: p.email, aclPermissions: ['everything'] })).body.error, 'invalid_acl_scopes');

    const other = await makeOwner();
    const first = await invite(o, { role: 'staff', email: p.email, aclPermissions: ['members'] });
    await call(acceptMyInvitation, p.claims, { params: { invitationId: first.body.invitation.id } });
    const second = await invite(other, { role: 'staff', email: p.email, aclPermissions: ['payments'] });
    const refused = await call(acceptMyInvitation, p.claims, { params: { invitationId: second.body.invitation.id } });
    assert.equal(refused.body.error, 'already_staff_elsewhere', 'one organisation cannot widen another\'s staff permissions');
  });
});

// ── Organisations stop setting credentials ─────────────────────────────────

test('flag on: the legacy create endpoints refuse credentials', async () => {
  await on(async () => {
    const o = await makeOwner();
    const staff = await call(ownerCreateStaff, o.claims, { body: { email: 'r@example.com', password: '123456', displayName: 'R', gymIds: [o.gymId] } });
    assert.equal(staff.statusCode, 400);
    assert.equal(staff.body.error, 'credentials_not_accepted');
    const trainer = await call(ownerCreateTrainer, o.claims, { body: { gymId: o.gymId, displayName: 'C', email: 'c@example.com', initialPin: '1234' } });
    assert.equal(trainer.body.error, 'credentials_not_accepted');
    assert.equal(Number((await db('User').whereIn('email', ['r@example.com', 'c@example.com']).count({ n: '*' }).first()).n), 0);
  });
});
