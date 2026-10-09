// Identity V2 · I2 — verified sign-in linking and persona-aware sessions.
// Linking uses verified evidence only and never merges an ambiguous case;
// old clients keep legacy behaviour; flags off means no change at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { authFirebaseSession, myPersonas, authSwitchPersona } from '../functions/auth.mjs';
import { users, identityLinkService } from '../src/bootstrap/services.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { requireAuth, sign } from '../src/auth/jwt.mjs';
import { openingPool } from '../src/services/auth-service.mjs';

const uniq = p => `${p}_${randomUUID().slice(0, 8)}`;
const devToken = payload => `dev:${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
const localPhone = () => `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const V2 = 'identity-v2';

function res() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

async function withFlags(flags, fn) {
  const names = ['IDENTITY_V2', 'V2_LINKING', 'V2_PERSONAS'];
  const saved = Object.fromEntries(names.map(n => [n, process.env[n]]));
  for (const n of names) delete process.env[n];
  for (const f of flags) process.env[f] = 'true';
  if (flags.length) process.env.IDENTITY_V2 = 'true';
  try { return await fn(); } finally {
    for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
  }
}

async function signIn(fbPayload, { role, client } = {}) {
  const out = res();
  await authFirebaseSession.onRequest({
    body: { idToken: devToken(fbPayload), ...(role ? { requestedRole: role } : {}) },
    headers: client ? { 'x-fitflex-client': client } : {},
  }, out);
  return out;
}

async function makeUser(overrides = {}) {
  const row = {
    id: uniq('usr_i2'), userType: 'member', accountStatus: 'active', approvalStatus: 'approved',
    createdAt: new Date().toISOString(), ...overrides,
  };
  await users.upsertAsync(u => u.id === row.id, row);
  return db('User').where({ id: row.id }).first();
}
const personOf = async id => (await db('User').where({ id }).first()).personId;
const openConflict = (kind, normalizedValue) => db('IdentityConflict').where({ kind, normalizedValue, status: 'open' }).first();

// ── Flags off: nothing changes ─────────────────────────────────────────────

test('flags off: no linking, no pid, and the legacy role question stays', async () => {
  await withFlags([], async () => {
    const uid = uniq('fb');
    const email = `${uniq('off')}@example.com`;
    await makeUser({ firebaseUid: uid, email, userType: 'trainer' });
    await makeUser({ firebaseUid: uid, email, userType: 'vendor' });
    const staffMade = await makeUser({ email, userType: 'gym_operator' });
    const before = await personOf(staffMade.id);

    const out = await signIn({ uid, email, email_verified: true }, { client: V2 });
    assert.equal(out.statusCode, 409);
    assert.equal(out.body.error, 'profile_role_required');
    assert.equal(await personOf(staffMade.id), before, 'not linked');

    const trainer = await signIn({ uid, email, email_verified: true }, { role: 'trainer' });
    assert.equal(trainer.statusCode, 200);
    assert.equal('pid' in jwt.decode(trainer.body.token), false);
    assert.equal('personas' in trainer.body, false);
  });
});

// ── V2_LINKING: cases A–G ──────────────────────────────────────────────────

test('Case A: a verified email links a staff-created row and merges its empty Person', async () => {
  await withFlags(['V2_LINKING'], async () => {
    const uid = uniq('fb');
    const email = `${uniq('a')}@example.com`;
    const member = await makeUser({ firebaseUid: uid, email });
    const staffMade = await makeUser({ email: email.toUpperCase(), userType: 'gym_operator' });
    const oldPerson = staffMade.personId;

    const out = await signIn({ uid, email, email_verified: true }, { role: 'member' });
    assert.equal(out.statusCode, 200);
    assert.equal(await personOf(staffMade.id), member.personId, 'linked to the signer');
    assert.equal(staffMade.id, (await db('User').where({ id: staffMade.id }).first()).id, 'User id unchanged');

    const tomb = await db('Person').where({ id: oldPerson }).first();
    assert.equal(tomb.status, 'merged');
    assert.equal(tomb.mergedIntoId, member.personId);
    const events = await db('IdentityEvent').where({ fromPersonId: oldPerson }).orderBy('kind');
    assert.deepEqual(events.map(e => e.kind), ['link', 'merge']);
    assert.deepEqual(events[0].userIds, [staffMade.id], 'previous Person recorded, so it can be reversed');
    const verified = await db('LoginIdentifier').where({ personId: member.personId, type: 'email', normalizedValue: email }).whereNotNull('verifiedAt');
    assert.equal(verified.length, 1);
  });
});

test('Case B: an unverified email links nothing', async () => {
  await withFlags(['V2_LINKING'], async () => {
    const uid = uniq('fb');
    const email = `${uniq('b')}@example.com`;
    const member = await makeUser({ firebaseUid: uid, email });
    const staffMade = await makeUser({ email, userType: 'gym_operator' });
    const out = await signIn({ uid, email, email_verified: false }, { role: 'member' });
    assert.equal(out.statusCode, 200);
    assert.equal(out.body.user.id, member.id);
    assert.notEqual(await personOf(staffMade.id), member.personId);
  });
});

test('Case C: a Firebase-verified phone links a staff-created row with that phone', async () => {
  await withFlags(['V2_LINKING'], async () => {
    const uid = uniq('fb');
    const phone = localPhone();
    const member = await makeUser({ firebaseUid: uid });
    const staffMade = await makeUser({ phone: `${phone.slice(0, 4)} ${phone.slice(4)}`, userType: 'trainer' });
    const out = await signIn({ uid, phone_number: `+255${phone.slice(1)}` }, { role: 'member' });
    assert.equal(out.statusCode, 200);
    assert.equal(await personOf(staffMade.id), member.personId);
  });
});

test('Case D: the same email on a different Firebase account is a conflict, not a link', async () => {
  await withFlags(['V2_LINKING'], async () => {
    const email = `${uniq('d')}@example.com`;
    const mine = await makeUser({ firebaseUid: uniq('fb'), email });
    const theirs = await makeUser({ firebaseUid: uniq('fb_other'), email, userType: 'trainer' });
    const out = await signIn({ uid: mine.firebaseUid, email, email_verified: true }, { role: 'member' });
    assert.equal(out.statusCode, 200);
    assert.notEqual(await personOf(theirs.id), mine.personId);
    const conflict = await openConflict('email_other_firebase_account', email);
    assert.ok(conflict);
    assert.deepEqual(conflict.userIds, [theirs.id]);
  });
});

test('Case F: a second live persona of the same type is a conflict, not a link', async () => {
  await withFlags(['V2_LINKING'], async () => {
    const uid = uniq('fb');
    const email = `${uniq('f')}@example.com`;
    const member = await makeUser({ firebaseUid: uid, email: `${uniq('own')}@example.com` });
    const staffMadeMember = await makeUser({ email, userType: 'member' });
    const out = await signIn({ uid, email, email_verified: true }, { role: 'member' });
    assert.equal(out.statusCode, 200);
    assert.notEqual(await personOf(staffMadeMember.id), member.personId);
    assert.ok(await openConflict('duplicate_persona', `${member.personId}:member`));
  });
});

test('Case G: an email already verified on another Person is a conflict', async () => {
  await withFlags(['V2_LINKING'], async () => {
    const email = `${uniq('g')}@example.com`;
    const other = await makeUser({ firebaseUid: uniq('fb_other') });
    await db('LoginIdentifier').insert({
      id: uniq('lid'), personId: other.personId, type: 'email', value: email, normalizedValue: email,
      verifiedAt: new Date(), status: 'active',
    });
    const mine = await makeUser({ firebaseUid: uniq('fb') });
    const out = await signIn({ uid: mine.firebaseUid, email, email_verified: true }, { role: 'member' });
    assert.equal(out.statusCode, 200);
    const conflict = await openConflict('verified_identifier_collision', email);
    assert.ok(conflict);
    assert.deepEqual([...conflict.personIds].sort(), [other.personId, mine.personId].sort());
    const holder = await db('LoginIdentifier').where({ type: 'email', normalizedValue: email }).whereNotNull('verifiedAt');
    assert.deepEqual(holder.map(h => h.personId), [other.personId], 'not moved');
  });
});

test('a row claimed by this Firebase uid joins the Person that owns the uid', async () => {
  await withFlags(['V2_LINKING'], async () => {
    const uid = uniq('fb');
    const email = `${uniq('claim')}@example.com`;
    const member = await makeUser({ firebaseUid: uid });
    const staffMade = await makeUser({ email, userType: 'gym_operator' });
    // The owner signs in as the owner persona with a verified email: the row
    // is claimed (firebaseUid set) and then moved onto the uid's Person.
    const out = await signIn({ uid, email, email_verified: true }, { role: 'gym_operator' });
    assert.equal(out.statusCode, 200);
    assert.equal(out.body.user.id, staffMade.id);
    assert.equal(await personOf(staffMade.id), member.personId);
  });
});

test('linking is idempotent: a second sign-in writes no new events', async () => {
  await withFlags(['V2_LINKING'], async () => {
    const uid = uniq('fb');
    const email = `${uniq('idem')}@example.com`;
    const member = await makeUser({ firebaseUid: uid, email });
    await makeUser({ email, userType: 'trainer' });
    await signIn({ uid, email, email_verified: true }, { role: 'member' });
    const count = async () => Number((await db('IdentityEvent').where({ personId: member.personId }).count({ n: '*' }).first()).n);
    const first = await count();
    await signIn({ uid, email, email_verified: true }, { role: 'member' });
    assert.equal(await count(), first);
  });
});

test('a linking failure never blocks the sign-in', async () => {
  await withFlags(['V2_LINKING'], async () => {
    const uid = uniq('fb');
    const user = await makeUser({ firebaseUid: uid });
    const original = identityLinkService.linkOnVerifiedSignIn;
    identityLinkService.linkOnVerifiedSignIn = async () => { throw new Error('boom'); };
    try {
      const out = await signIn({ uid });
      assert.equal(out.statusCode, 200);
      assert.equal(out.body.user.id, user.id);
    } finally {
      identityLinkService.linkOnVerifiedSignIn = original;
    }
  });
});

test('IdentityEvent rows are append-only', async () => {
  const event = await db('IdentityEvent').first('id');
  assert.ok(event, 'earlier tests wrote events');
  await assert.rejects(db('IdentityEvent').where({ id: event.id }).update({ trigger: 'x' }), /append-only/);
  await assert.rejects(db('IdentityEvent').where({ id: event.id }).del(), /append-only/);
});

// ── V2_PERSONAS: sessions ──────────────────────────────────────────────────

test('V2_PERSONAS: tokens carry pid; only V2 clients get the persona payload', async () => {
  await withFlags(['V2_PERSONAS'], async () => {
    const uid = uniq('fb');
    const user = await makeUser({ firebaseUid: uid, email: `${uniq('p')}@example.com` });
    const legacy = await signIn({ uid });
    assert.equal(legacy.statusCode, 200);
    const claims = jwt.decode(legacy.body.token);
    assert.equal(claims.sub, user.id, 'sub stays the persona');
    assert.equal(claims.pid, user.personId);
    assert.equal(claims.ver, 2);
    assert.equal('personas' in legacy.body, false, 'old clients see the legacy shape');

    const v2 = await signIn({ uid }, { client: V2 });
    assert.equal(v2.body.person.id, user.personId);
    assert.equal(v2.body.activePersonaId, user.id);
    assert.deepEqual(v2.body.personas.map(p => p.id), [user.id]);
  });
});

test('V2 client with two operational personas: no 409, a choice, then the last one is restored', async () => {
  await withFlags(['V2_PERSONAS'], async () => {
    const uid = uniq('fb');
    const trainer = await makeUser({ firebaseUid: uid, userType: 'trainer' });
    const vendor = await makeUser({ firebaseUid: uid, userType: 'vendor' });

    const legacy = await signIn({ uid });
    assert.equal(legacy.body.error, 'profile_role_required', 'old clients still get the question');

    const first = await signIn({ uid }, { client: V2 });
    assert.equal(first.statusCode, 200);
    assert.equal(first.body.personaChoiceRequired, true);
    assert.deepEqual(first.body.personas.map(p => p.id).sort(), [trainer.id, vendor.id].sort());

    const switched = res();
    await authSwitchPersona.onRequest({ user: jwt.decode(first.body.token), body: { personaId: vendor.id } }, switched);
    assert.equal(switched.statusCode, 200);
    assert.equal(jwt.decode(switched.body.token).sub, vendor.id);
    assert.equal(jwt.decode(switched.body.token).pid, trainer.personId);

    const again = await signIn({ uid }, { client: V2 });
    assert.equal(again.body.user.id, vendor.id, 'last persona restored');
    assert.equal(again.body.personaChoiceRequired, false);
  });
});

test('switch-persona refuses someone else\'s, suspended and portal-only personas', async () => {
  await withFlags(['V2_PERSONAS'], async () => {
    const uid = uniq('fb');
    const me = await makeUser({ firebaseUid: uid });
    const suspended = await makeUser({ firebaseUid: uid, userType: 'trainer', accountStatus: 'suspended' });
    const portal = await makeUser({ firebaseUid: uid, userType: 'admin', portalUser: true });
    const stranger = await makeUser({ firebaseUid: uniq('fb_other'), userType: 'vendor' });
    const claims = { sub: me.id, userType: 'member' };
    const call = async personaId => {
      const out = res();
      await authSwitchPersona.onRequest({ user: claims, body: { personaId } }, out);
      return out;
    };
    assert.equal((await call(stranger.id)).statusCode, 404);
    assert.equal((await call('usr_missing')).statusCode, 404);
    assert.equal((await call(suspended.id)).body.error, 'account_suspended');
    assert.equal((await call(portal.id)).body.error, 'portal_persona_not_switchable');
    assert.equal((await call(undefined)).statusCode, 400);
  });
});

test('/me/personas lists the Person\'s personas; both endpoints 404 with the flag off', async () => {
  const uid = uniq('fb');
  const member = await makeUser({ firebaseUid: uid });
  const trainer = await makeUser({ firebaseUid: uid, userType: 'trainer' });
  const claims = { sub: member.id, userType: 'member' };
  await withFlags(['V2_PERSONAS'], async () => {
    const out = res();
    await myPersonas.onRequest({ user: claims }, out);
    assert.equal(out.statusCode, 200);
    assert.deepEqual(out.body.personas.map(p => p.id).sort(), [member.id, trainer.id].sort());
    assert.equal('personId' in out.body.personas[0], false);
  });
  await withFlags([], async () => {
    const a = res();
    await myPersonas.onRequest({ user: claims }, a);
    assert.equal(a.statusCode, 404);
    const b = res();
    await authSwitchPersona.onRequest({ user: claims, body: { personaId: trainer.id } }, b);
    assert.equal(b.statusCode, 404);
  });
});

test('a suspended Person is refused on every persona; a suspended persona is not the Person', async () => {
  const uid = uniq('fb');
  const member = await makeUser({ firebaseUid: uid });
  const trainer = await makeUser({ firebaseUid: uid, userType: 'trainer', accountStatus: 'suspended' });
  const guard = requireAuth();
  const run = async (sub, userType) => {
    const out = res();
    let passed = false;
    await guard({ headers: { authorization: `Bearer ${sign({ sub, userType })}` } }, out, () => { passed = true; });
    return passed;
  };
  assert.equal(await run(trainer.id, 'trainer'), false, 'suspended persona');
  assert.equal(await run(member.id, 'member'), true, 'other personas unaffected');

  const other = await makeUser({ firebaseUid: uniq('fb') });
  await db('Person').where({ id: other.personId }).update({ status: 'suspended' });
  assert.equal(await run(other.id, 'member'), false, 'Person-level suspension');
});

// ── Opening an approved role instead of one still waiting for approval ─────

test('openingPool: the last role, unless it is pending and another is ready', () => {
  const m = { id: 'm', userType: 'member', approvalStatus: 'approved' };
  const v = { id: 'v', userType: 'vendor', approvalStatus: 'pending_approval' };
  const t = { id: 't', userType: 'trainer', approvalStatus: 'approved' };
  assert.equal(openingPool([m, v], 'm').last.id, 'm');
  assert.equal(openingPool([m, v], 'v').last, null, 'pending last: not opened');
  assert.deepEqual(openingPool([m, v], 'v').pool.map(p => p.id), ['m']);
  assert.equal(openingPool([m, v], 'v').switchedAway, true);
  assert.equal(openingPool([v], 'v').last.id, 'v', 'nothing else ready: stays');
  assert.equal(openingPool([m, t], 't').last.id, 't', 'an approved last role is kept');
  assert.equal(openingPool([m, v], null).last, undefined);
});

test('V2 sign-in: a member who applied as a vendor lands as a member while the vendor waits', async () => {
  await withFlags(['V2_PERSONAS'], async () => {
    const uid = uniq('fb');
    const member = await makeUser({ firebaseUid: uid });
    const vendor = await makeUser({ firebaseUid: uid, userType: 'vendor', approvalStatus: 'pending_approval' });
    await db('Person').where({ id: member.personId }).update({ lastPersonaId: vendor.id });

    const again = await signIn({ uid }, { client: V2 });
    assert.equal(again.statusCode, 200);
    assert.equal(again.body.user.id, member.id, 'the approved role opens');
    assert.equal(again.body.pendingApproval, false);
    assert.equal(again.body.personaChoiceRequired, false);
    assert.ok(again.body.personas.some(p => p.id === vendor.id), 'the pending role is still switchable');
    assert.equal((await db('Person').where({ id: member.personId }).first()).lastPersonaId, member.id);

    // Switching to the pending role is still allowed; it is then the one remembered.
    const switched = res();
    await authSwitchPersona.onRequest({ user: jwt.decode(again.body.token), body: { personaId: vendor.id } }, switched);
    assert.equal(switched.statusCode, 200);
    assert.equal(switched.body.pendingApproval, true);
  });
});

test('V2 sign-in: once the vendor is approved, the role used last opens again; only pending roles stay put', async () => {
  await withFlags(['V2_PERSONAS'], async () => {
    const uid = uniq('fb');
    const member = await makeUser({ firebaseUid: uid });
    const vendor = await makeUser({ firebaseUid: uid, userType: 'vendor', approvalStatus: 'pending_approval' });
    await db('Person').where({ id: member.personId }).update({ lastPersonaId: vendor.id });
    await db('User').where({ id: vendor.id }).update({ approvalStatus: 'approved' });
    assert.equal((await signIn({ uid }, { client: V2 })).body.user.id, vendor.id);

    // Both waiting: nothing better to open, so the last one stays.
    await db('User').where({ id: vendor.id }).update({ approvalStatus: 'pending_approval' });
    await db('User').where({ id: member.id }).update({ approvalStatus: 'pending_approval' });
    const both = await signIn({ uid }, { client: V2 });
    assert.equal(both.body.user.id, vendor.id);
    assert.equal(both.body.pendingApproval, true);
  });
});

test('V2 sign-in: pending last role and two ready operational roles: the person is asked', async () => {
  await withFlags(['V2_PERSONAS'], async () => {
    const uid = uniq('fb');
    const trainer = await makeUser({ firebaseUid: uid, userType: 'trainer' });
    const owner = await makeUser({ firebaseUid: uid, userType: 'gym_operator' });
    const vendor = await makeUser({ firebaseUid: uid, userType: 'vendor', approvalStatus: 'pending_approval' });
    await db('Person').where({ id: trainer.personId }).update({ lastPersonaId: vendor.id });
    const out = await signIn({ uid }, { client: V2 });
    assert.equal(out.body.personaChoiceRequired, true);
    assert.notEqual(out.body.user.id, vendor.id);
    assert.ok([trainer.id, owner.id].includes(out.body.user.id));
  });
});
