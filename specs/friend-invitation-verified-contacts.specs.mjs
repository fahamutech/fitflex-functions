// Friend invitations go only to verified contacts (security fix, 19 Oct 2026).
// End to end against the CI database: real Firebase-session exchange (dev
// tokens, which can say email_verified: false), real LoginIdentifier rows,
// real friend-invitation service and its bootstrap lookups.
//
//   - an unverified Firebase email sign-up gets no invitations for that email
//     (inbox attach, link claim) and inviters don't find them by it;
//   - an email / number typed onto the User row (profile edit) proves nothing;
//   - with Identity V2 linking off, a verified sign-in records its evidence
//     only when IDENTITY_RECORD_FIREBASE_EVIDENCE is on (default off: nothing
//     is recorded and Firebase-only members stay unmatched, fail-closed);
//   - evidence is never recorded onto a row owned by another Firebase account
//     (an email planted on someone's own row through POST /me/profile);
//   - a legacy member with a verified LoginIdentifier (reconcile backfill)
//     keeps working; one without it is covered at their next verified sign-in
//     once recording is on.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureInit } from '../functions/index.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { authService, friendInvitationService as fi, identityLinkService } from '../src/bootstrap/services.mjs';
import { updateMemberProfile } from '../functions/subscriptions.mjs';
import { createVerifiedContacts } from '../src/services/friend-invitation-contacts.mjs';

await ensureInit();

const tag = randomUUID().slice(0, 8);
const made = { uids: [], userIds: [] };
const mail = name => `fivc.${name}.${tag}@example.com`;
const phoneNo = () => `+2557${String(10000000 + Math.floor(Math.random() * 89999999)).slice(0, 8)}`;
const devToken = claims => `dev:${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;

// No Identity V2 flags: the default deployment. Recording is off by default too.
for (const k of ['IDENTITY_V2', 'V2_LINKING', 'V2_PERSONAS', 'IDENTITY_RECORD_FIREBASE_EVIDENCE']) delete process.env[k];

/** Run with IDENTITY_RECORD_FIREBASE_EVIDENCE on, restoring it afterwards. */
async function withEvidence(fn) {
  process.env.IDENTITY_RECORD_FIREBASE_EVIDENCE = 'on';
  try { return await fn(); } finally { delete process.env.IDENTITY_RECORD_FIREBASE_EVIDENCE; }
}

async function signIn({ name, email = null, verified = true, phone = null, uid = `fivc_${name}_${tag}` }) {
  if (!made.uids.includes(uid)) made.uids.push(uid);
  const r = await authService.firebaseSession({
    idToken: devToken({ uid, email, email_verified: verified, phone_number: phone, name: `FIVC ${name}`, sign_in_provider: phone ? 'phone' : 'password' }),
    requestedRole: 'member',
  });
  assert.ok(r.token, JSON.stringify(r));
  if (!made.userIds.includes(r.user.id)) made.userIds.push(r.user.id);
  return { id: r.user.id, uid };
}

async function verifiedRows(userId, type) {
  const u = await db('User').where({ id: userId }).first('personId');
  return db('LoginIdentifier').where({ personId: u.personId, type, status: 'active' }).whereNotNull('verifiedAt').select('normalizedValue');
}

async function shareToken(inviterId, contact) {
  const r = await fi.invite(inviterId, contact);
  assert.ok(r.share, `expected a share link (nobody verified holds the contact): ${JSON.stringify(r)}`);
  return r.share.link.split('#').pop();
}

after(async () => {
  const persons = (await db('User').whereIn('id', made.userIds).select('personId')).map(r => r.personId).filter(Boolean);
  await db('FriendInvitation').whereIn('inviterId', made.userIds).orWhereIn('recipientUserId', made.userIds).del();
  await db('Notification').whereIn('userId', made.userIds).del().catch(() => {});
  await db('Follow').whereIn('followerId', made.userIds).orWhereIn('followeeId', made.userIds).del().catch(() => {});
  await db('LoginIdentifier').whereIn('personId', persons).del();
  await db('IdentityConflict').whereRaw('"personIds" && ?::text[]', [persons]).del().catch(() => {});
  await db('User').whereIn('id', made.userIds).del();
  await db('Person').whereIn('id', persons).del().catch(() => {});
  await db.destroy();
});

test('unverified Firebase email sign-up: no invitation attaches or can be claimed, and lookup does not find them', async () => {
  const inviter = await signIn({ name: 'inviter1', email: mail('inviter1') });
  const victim = mail('victim1');
  const token = await shareToken(inviter.id, { email: victim });

  const impostor = await signIn({ name: 'impostor1', email: victim, verified: false });
  assert.equal((await verifiedRows(impostor.id, 'email')).length, 0, 'no verified email recorded for them');

  assert.equal(await fi.attachFor(impostor.id), 0);
  const listed = await fi.list(impostor.id);
  assert.equal(listed.incoming.length, 0, 'GET /me/friend-invitations shows nothing');
  const c = await fi.claim(impostor.id, token);
  assert.equal(c.error, 'contact_mismatch');
  assert.equal(c.status, 403);
  const row = await db('FriendInvitation').where({ inviterId: inviter.id }).first('recipientUserId', 'status');
  assert.equal(row.recipientUserId, null);
  assert.equal(row.status, 'pending');
  assert.equal((await db('Notification').where({ userId: impostor.id }).count('* as n').first()).n * 1, 0, 'no inviter name in their inbox');

  const look = await fi.lookup(inviter.id, { email: victim });
  assert.equal(look.result.kind, 'unregistered', 'the inviter is not routed to the impostor');
});

test('email or number typed onto the User row (profile edit) proves nothing', async () => {
  const inviter = await signIn({ name: 'inviter2', email: mail('inviter2') });
  const someone = await signIn({ name: 'someone2', email: mail('someone2') });
  const victimEmail = mail('victim2');
  const victimPhone = phoneNo();
  const emailToken = await shareToken(inviter.id, { email: victimEmail });
  const phoneToken = await shareToken(inviter.id, { phone: victimPhone });
  await db('User').where({ id: someone.id }).update({ email: victimEmail, phone: victimPhone });

  assert.equal(await fi.attachFor(someone.id), 0);
  assert.equal((await fi.claim(someone.id, emailToken)).error, 'contact_mismatch');
  assert.equal((await fi.claim(someone.id, phoneToken)).error, 'contact_mismatch');
  assert.equal((await fi.lookup(inviter.id, { email: victimEmail })).result.kind, 'unregistered');
  assert.equal((await fi.lookup(inviter.id, { phone: victimPhone })).result.kind, 'unregistered');
  const { findMember } = createVerifiedContacts(db);
  assert.equal(await findMember({ type: 'email', value: victimEmail }), null);
  assert.equal(await findMember({ type: 'phone', value: victimPhone }), null);
});

test('recording on: verified sign-in (linking off) records the email; invitations attach, claim and lookup work', () => withEvidence(async () => {
  const inviter = await signIn({ name: 'inviter3', email: mail('inviter3') });
  const email = mail('real3');
  const token = await shareToken(inviter.id, { email });
  const inboxOnly = await signIn({ name: 'inviter3b', email: mail('inviter3b') });
  await shareToken(inboxOnly.id, { email });

  const real = await signIn({ name: 'real3', email });
  assert.deepEqual((await verifiedRows(real.id, 'email')).map(r => r.normalizedValue), [email]);
  assert.equal((await fi.claim(real.id, token)).invitation.status, 'pending', 'the link works for the verified owner');
  assert.equal(await fi.attachFor(real.id), 1, 'the other one arrives in the inbox');
  assert.equal((await fi.list(real.id)).incoming.length, 2);
  const look = await fi.lookup(inviter.id, { email: email.toUpperCase() });
  assert.equal(look.result.kind, 'member');
  assert.equal(look.result.userId, real.id);
}));

test('new unverified sign-up: the email waits on the row; a later verified sign-in makes it count', () => withEvidence(async () => {
  const inviter = await signIn({ name: 'inviter4', email: mail('inviter4') });
  const email = mail('late4');
  await shareToken(inviter.id, { email });

  const first = await signIn({ name: 'late4', email, verified: false });
  const row = await db('User').where({ id: first.id }).first('email');
  assert.equal(row.email, email, 'kept as an unverified contact field (see PR: matching never uses it)');
  assert.equal((await verifiedRows(first.id, 'email')).length, 0);
  assert.equal(await fi.attachFor(first.id), 0);

  const again = await signIn({ name: 'late4', email, verified: true, uid: first.uid });
  assert.equal(again.id, first.id, 'same account');
  assert.deepEqual((await verifiedRows(first.id, 'email')).map(r => r.normalizedValue), [email]);
  assert.equal(await fi.attachFor(first.id), 1);
}));

test('Firebase phone sign-in records the number; the member is found and gets number invitations', () => withEvidence(async () => {
  const inviter = await signIn({ name: 'inviter5', email: mail('inviter5') });
  const phone = phoneNo();
  await shareToken(inviter.id, { phone });
  const member = await signIn({ name: 'phone5', phone });
  assert.deepEqual((await verifiedRows(member.id, 'phone')).map(r => r.normalizedValue), [phone]);
  assert.equal(await fi.attachFor(member.id), 1);
  const local = `0${phone.slice(4)}`;
  assert.equal((await fi.lookup(inviter.id, { phone: local })).result.userId, member.id);
}));

test('legacy member: verified LoginIdentifier (reconcile backfill) works; without it, covered at the next verified sign-in once recording is on', () => withEvidence(async () => {
  const inviter = await signIn({ name: 'inviter6', email: mail('inviter6') });
  const backfilled = mail('legacy6a');
  const notYet = mail('legacy6b');
  // Rows as they exist from before Identity V2: email on the row, no identifiers.
  const legacy = async (name, email) => {
    const id = `usr_fivc_${name}_${tag}`;
    await db('User').insert({ id, userType: 'member', displayName: `Legacy ${name}`, email, firebaseUid: `fivc_${name}_${tag}`, accountStatus: 'active', updatedAt: new Date() });
    made.userIds.push(id);
    made.uids.push(`fivc_${name}_${tag}`);
    return id;
  };
  const a = await legacy('legacy6a', backfilled);
  const b = await legacy('legacy6b', notYet);
  // scripts/identity-reconcile.mjs --firebase --apply writes exactly this for a Firebase-verified email.
  const pa = (await db('User').where({ id: a }).first('personId')).personId;
  await db('LoginIdentifier').insert({
    id: `lid_fivc_${tag}`, personId: pa, type: 'email', value: backfilled, normalizedValue: backfilled,
    verifiedAt: new Date(), provider: 'firebase', firebaseUid: `fivc_legacy6a_${tag}`, status: 'active',
  });
  await shareToken(inviter.id, { email: notYet });
  const r = await fi.invite(inviter.id, { email: backfilled });
  assert.equal(r.invitation.status, 'pending');
  assert.equal(r.share, undefined, 'found as a member: request goes straight to them');
  assert.equal((await fi.list(a)).incoming.length, 1);

  assert.equal(await fi.attachFor(b), 0, 'not proven yet');
  assert.equal((await fi.lookup(inviter.id, { email: notYet })).result.kind, 'unregistered');
  const signedIn = await signIn({ name: 'legacy6b', email: notYet, uid: `fivc_legacy6b_${tag}` });
  assert.equal(signedIn.id, b);
  assert.equal(await fi.attachFor(b), 1);
  assert.equal((await fi.lookup(inviter.id, { email: notYet })).result.userId, b);
}));

test('recording off (default): a verified sign-in records nothing and Firebase-only members stay unmatched', async () => {
  assert.equal(process.env.IDENTITY_RECORD_FIREBASE_EVIDENCE, undefined);
  const inviter = await signIn({ name: 'inviter7', email: mail('inviter7') });
  const email = mail('off7');
  const phone = phoneNo();
  await shareToken(inviter.id, { email });
  await shareToken(inviter.id, { phone });
  const member = await signIn({ name: 'off7', email });
  const byPhone = await signIn({ name: 'off7p', phone });
  // Picked by id: whereIn returns the rows in no fixed order.
  const personOf = new Map((await db('User').whereIn('id', [member.id, byPhone.id]).select('id', 'personId')).map(r => [r.id, r.personId]));
  const persons = [personOf.get(member.id), personOf.get(byPhone.id)];
  assert.equal((await db('LoginIdentifier').whereIn('personId', persons).whereIn('type', ['email', 'phone']).count('* as n').first()).n * 1, 0,
    'no email / phone identifier written by a Firebase session');
  // The only uid row is the one the user_person_guard trigger has always
  // written for a new row's own Firebase uid (pre-existing, not this code).
  const uidRows = await db('LoginIdentifier').where({ type: 'firebase_uid', normalizedValue: member.uid }).select('personId');
  assert.ok(uidRows.every(x => x.personId === personOf.get(member.id)), 'uid only on their own person');
  assert.equal(await fi.attachFor(member.id), 0, 'fail-closed');
  assert.equal(await fi.attachFor(byPhone.id), 0, 'fail-closed');
  assert.equal((await fi.lookup(inviter.id, { email })).result.kind, 'unregistered');
});

test('planted email: a verified sign-in that lands on a row owned by another Firebase account records nothing on that person', () => withEvidence(async () => {
  const inviter = await signIn({ name: 'inviter8', email: mail('inviter8') });
  const victimEmail = mail('victim8');
  const token = await shareToken(inviter.id, { email: victimEmail });

  const attacker = await signIn({ name: 'attacker8', email: mail('attacker8') });
  const attackerPerson = (await db('User').where({ id: attacker.id }).first('personId')).personId;
  // Types a case variant of the victim's email onto their own row (real route).
  const out = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await updateMemberProfile.onRequest({ user: { sub: attacker.id, userType: 'member' }, body: { email: victimEmail.toUpperCase() } }, out);
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));

  const victimUid = `fivc_victim8_${tag}`;
  made.uids.push(victimUid);
  const r = await authService.firebaseSession({
    idToken: devToken({ uid: victimUid, email: victimEmail, email_verified: true, name: 'FIVC victim8', sign_in_provider: 'password' }),
    requestedRole: 'member',
  });
  if (r.user?.id && !made.userIds.includes(r.user.id)) made.userIds.push(r.user.id);

  const onAttacker = await db('LoginIdentifier').where({ personId: attackerPerson, status: 'active' })
    .where(b => b.where({ type: 'firebase_uid', normalizedValue: victimUid }).orWhere({ type: 'email', normalizedValue: victimEmail }));
  assert.equal(onAttacker.length, 0, "the victim's uid / email are not on the attacker's person");
  assert.equal((await db('LoginIdentifier').where({ type: 'firebase_uid', normalizedValue: victimUid }).whereNot({ personId: attackerPerson }).count('* as n').first()).n * 1,
    r.user?.id === attacker.id ? 0 : 1, 'only ever recorded on a row the victim owns');
  assert.equal(await fi.attachFor(attacker.id), 0);
  assert.equal((await fi.claim(attacker.id, token)).error, 'contact_mismatch');
  const look = (await fi.lookup(inviter.id, { email: victimEmail })).result;
  assert.ok(look.kind !== 'member' || look.userId !== attacker.id, 'never routed to the attacker');
}));

test('linkOnVerifiedSignIn attachOnly: nothing attached to a row of another Firebase account; FitFlex codes (no uid) still attach', async () => {
  const owner = await signIn({ name: 'guard9', email: mail('guard9') });
  const person = (await db('User').where({ id: owner.id }).first('personId')).personId;
  const foreignUid = `fivc_foreign9_${tag}`;
  const foreignEmail = mail('foreign9');
  const res = await identityLinkService.linkOnVerifiedSignIn({
    anchorUserId: owner.id, uid: foreignUid, email: foreignEmail, provider: 'password', attachOnly: true,
  });
  assert.equal(res.personId, null);
  assert.equal((await db('LoginIdentifier').where({ type: 'firebase_uid', normalizedValue: foreignUid }).count('* as n').first()).n * 1, 0);
  assert.equal((await db('LoginIdentifier').where({ type: 'email', normalizedValue: foreignEmail }).count('* as n').first()).n * 1, 0);

  const codeEmail = mail('code9');
  const viaCode = await identityLinkService.linkOnVerifiedSignIn({
    anchorUserId: owner.id, uid: null, email: codeEmail, provider: 'fitflex_email', trigger: 'identifier_verify', attachOnly: true,
  });
  assert.equal(viaCode.personId, person);
  assert.deepEqual((await verifiedRows(owner.id, 'email')).map(x => x.normalizedValue), [codeEmail]);
});
