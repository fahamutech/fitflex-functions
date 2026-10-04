// Identity V2 — invitation sign-in with a start PIN (agreed 3 Oct 2026).
// The invited person is told directly. Someone new to FitFlex gets a start
// PIN, signs in with it once, chooses their own PIN, then accepts or declines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { gymCreateInvitation, gymResendInvitation, vendorCreateInvitation } from '../functions/invitations.mjs';
import { pinLogin, pinResetStart, pinResetConfirm, pinResetComplete } from '../functions/pin-auth.mjs';
import { inviteBegin, onboardingAccept, onboardingDecline, onboardingRole } from '../functions/onboarding.mjs';
import { users, trainers, pinAuthService } from '../src/bootstrap/services.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { requireAuth, sign } from '../src/auth/jwt.mjs';
import { fakeOutbox } from '../src/infra/verification-senders.mjs';

const uniq = p => `${p}_${randomUUID().slice(0, 8)}`;
const localPhone = () => `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const e164 = local => `+255${local.slice(1)}`;

function res() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
let addressCounter = 0;
const freshAddress = () => `10.11.${Math.floor(addressCounter / 250)}.${(addressCounter++ % 250) + 1}`;
async function post(route, body) {
  const out = res();
  await route.onRequest({ body, headers: { 'x-forwarded-for': freshAddress() } }, out);
  return out;
}
async function asOrg(route, claims, { params = {}, body = {} } = {}) {
  const req = { headers: { authorization: `Bearer ${sign(claims)}` }, params, body, query: {} };
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
  const names = ['IDENTITY_V2', 'V2_PIN_LOGIN', 'V2_INVITES', 'V2_PERSONAS', 'V2_LINKING', 'V2_RECOVERY', 'VERIFICATION_EMAIL_PROVIDER', 'VERIFICATION_SMS_PROVIDER', ...Object.keys(env)];
  const saved = Object.fromEntries(names.map(n => [n, process.env[n]]));
  Object.assign(process.env, env);
  for (const [k, v] of Object.entries(env)) if (v === null) delete process.env[k];
  try { return await fn(); } finally {
    for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
  }
}
const ON = { IDENTITY_V2: 'true', V2_PIN_LOGIN: 'true', V2_INVITES: 'true', V2_PERSONAS: 'true', V2_LINKING: null, VERIFICATION_EMAIL_PROVIDER: 'fake', VERIFICATION_SMS_PROVIDER: 'fake' };
const on = (fn, extra = {}) => withEnv({ ...ON, ...extra }, fn);

async function makeUser(overrides = {}) {
  const row = {
    id: uniq('usr_sp'), userType: 'member', accountStatus: 'active', approvalStatus: 'approved',
    createdAt: new Date().toISOString(), ...overrides,
  };
  await users.upsertAsync(u => u.id === row.id, row);
  return db('User').where({ id: row.id }).first();
}
async function makeOwner() {
  const gymId = uniq('gym_sp');
  await db('Gym').insert({ id: gymId, name: 'Iron Paradise', tier: 'standard', location: 'Dar es Salaam', status: 'active', updatedAt: new Date() });
  const owner = await makeUser({ userType: 'gym_operator', gymIds: [gymId], gymId });
  return { owner, gymId, claims: { sub: owner.id, userType: 'gym_operator' } };
}
const invite = (o, body) => asOrg(gymCreateInvitation, o.claims, { params: { gymId: o.gymId }, body });
const lastMessage = to => fakeOutbox.filter(m => m.to === to).at(-1);
const startPinIn = message => message?.text.match(/start PIN (\d{4})\b|PIN ya kuanzia (\d{4})\b/)?.slice(1).find(Boolean);
const sessionWorks = async token => {
  let passed = false;
  await requireAuth()({ headers: { authorization: `Bearer ${token}` } }, res(), () => { passed = true; });
  return passed;
};
const wrongPin = pin => String((Number(pin) + 1) % 10000).padStart(4, '0');

test('someone new is invited as staff: a start PIN by SMS, their own PIN, then Accept', async () => {
  await on(async () => {
    const o = await makeOwner();
    const local = localPhone();
    const phone = e164(local);

    const sent = await invite(o, { role: 'staff', phone: local, aclPermissions: ['members'] });
    assert.equal(sent.statusCode, 201, JSON.stringify(sent.body));
    assert.deepEqual(sent.body.delivery, { sent: true, channel: 'sms', startPin: true });
    const message = lastMessage(phone);
    assert.match(message.text, /Iron Paradise invited you to join as staff/);
    assert.match(message.text, /https?:\/\//, 'a link to get the app');
    const startPin = startPinIn(message);
    assert.match(startPin, /^\d{4}$/);
    assert.equal(JSON.stringify(sent.body).includes(`"${startPin}"`), false, 'the gym never sees the PIN');
    const stored = await db('Invitation').where({ id: sent.body.invitation.id }).first();
    assert.ok(stored.startPinHash);
    assert.equal(stored.startPinHash.includes(startPin), false);

    // A wrong start PIN is the usual refusal, and is counted.
    const wrong = await post(pinLogin, { phone: local, pin: wrongPin(startPin) });
    assert.deepEqual([wrong.statusCode, wrong.body.error], [401, 'invalid_credentials']);
    assert.equal((await db('Invitation').where({ id: stored.id }).first()).startPinAttempts, 1);

    // The start PIN signs nobody in: it opens the next step.
    const started = await post(pinLogin, { phone: local, pin: startPin });
    assert.equal(started.statusCode, 200, JSON.stringify(started.body));
    assert.equal(started.body.startPin, true);
    assert.equal(started.body.token, undefined);
    assert.deepEqual(started.body.invitation, { orgType: 'gym', role: 'staff' });
    assert.equal(await sessionWorks(started.body.startToken), false);
    assert.equal(await db('LoginIdentifier').where({ type: 'phone', normalizedValue: phone }).first(), undefined, 'nothing exists for them yet');

    const { startToken } = started.body;
    assert.equal((await post(inviteBegin, { startToken, displayName: 'Neema Abdallah', pin: '12' })).body.error, 'pin_must_be_4_digits');
    assert.equal((await post(inviteBegin, { startToken, displayName: ' ', pin: '4821' })).body.error, 'display_name_required');
    assert.equal((await post(inviteBegin, { startToken: 'nonsense', displayName: 'Neema', pin: '4821' })).statusCode, 401);

    const begun = await post(inviteBegin, { startToken, displayName: 'Neema  Abdallah', pin: '4821' });
    assert.equal(begun.statusCode, 200, JSON.stringify(begun.body));
    assert.equal(begun.body.onboarding, true);
    assert.equal(begun.body.token, undefined, 'still not a session: accepting comes next');
    assert.equal(begun.body.invitations.length, 1);
    assert.equal(begun.body.invitations[0].orgName, 'Iron Paradise');
    assert.equal(begun.body.invitations[0].role, 'staff');
    const identifier = await db('LoginIdentifier').where({ type: 'phone', normalizedValue: phone }).first();
    assert.ok(identifier.verifiedAt, 'using the start PIN proved the number');
    const person = await db('Person').where({ id: identifier.personId }).first();
    assert.equal(person.displayName, 'Neema Abdallah');
    assert.match(person.pinHash, /^scrypt:/);
    assert.deepEqual(await db('User').where({ personId: person.id }), [], 'no profile until they accept');

    // The start PIN and its token are spent; their own PIN is what works now.
    assert.equal((await post(inviteBegin, { startToken, displayName: 'Neema', pin: '4821' })).statusCode, 401);
    const again = await post(pinLogin, { phone: local, pin: '4821' });
    assert.equal(again.body.onboarding, true, 'no profile yet, so the same step again');
    if (startPin !== '4821') assert.equal((await post(pinLogin, { phone: local, pin: startPin })).statusCode, 401);

    const accepted = await post(onboardingAccept, { onboardingToken: begun.body.onboardingToken, invitationId: begun.body.invitations[0].id });
    assert.equal(accepted.statusCode, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.user.userType, 'gym_staff');
    assert.equal(accepted.body.user.displayName, 'Neema Abdallah');
    assert.deepEqual(accepted.body.user.gymIds, [o.gymId]);
    assert.equal(await sessionWorks(accepted.body.token), true);
    const profiles = await db('User').where({ personId: person.id });
    assert.deepEqual(profiles.map(p => p.userType), ['gym_staff'], 'only the invited role');
    assert.equal(profiles[0].passwordHash ?? null, null);

    const signedIn = await post(pinLogin, { phone: local, pin: '4821' });
    assert.equal(signedIn.body.user.id, profiles[0].id);
  });
});

test('declining leaves an account with no role; they choose one like anyone registering', async () => {
  await on(async () => {
    const o = await makeOwner();
    const email = `${uniq('new')}@example.com`;
    const sent = await invite(o, { role: 'staff', email, aclPermissions: [] });
    assert.deepEqual(sent.body.delivery, { sent: true, channel: 'email', startPin: true });
    const message = lastMessage(email);
    assert.equal(message.subject, 'You are invited on FitFlex');
    const started = await post(pinLogin, { email, pin: startPinIn(message) });
    const begun = await post(inviteBegin, { startToken: started.body.startToken, displayName: 'Juma Said', pin: '7310' });

    const declined = await post(onboardingDecline, { onboardingToken: begun.body.onboardingToken, invitationId: begun.body.invitations[0].id });
    assert.equal(declined.statusCode, 200, JSON.stringify(declined.body));
    assert.equal(declined.body.onboarding, true);
    assert.deepEqual(declined.body.invitations, []);
    assert.equal((await db('Invitation').where({ id: sent.body.invitation.id }).first()).status, 'declined');
    const identifier = await db('LoginIdentifier').where({ type: 'email', normalizedValue: email }).first();
    assert.deepEqual(await db('User').where({ personId: identifier.personId }), [], 'declining creates no profile');

    // They can come back later: the number or email and their PIN open the same choice.
    const later = await post(pinLogin, { email, pin: '7310' });
    assert.equal(later.body.onboarding, true);
    assert.equal((await post(onboardingRole, { onboardingToken: later.body.onboardingToken, role: 'gym_staff' })).body.error, 'role_not_allowed');
    assert.equal((await post(onboardingRole, { onboardingToken: 'nonsense', role: 'member' })).statusCode, 401);

    const chosen = await post(onboardingRole, { onboardingToken: later.body.onboardingToken, role: 'member' });
    assert.equal(chosen.statusCode, 200, JSON.stringify(chosen.body));
    assert.equal(chosen.body.user.userType, 'member');
    assert.equal(chosen.body.user.displayName, 'Juma Said');
    assert.equal(chosen.body.user.email, email);
    assert.equal((await post(pinLogin, { email, pin: '7310' })).body.user.id, chosen.body.user.id, 'now it is an ordinary sign-in');
  });
});

test('a new person invited as a trainer gets a trainer profile at that gym on accepting', async () => {
  await on(async () => {
    const o = await makeOwner();
    const local = localPhone();
    const sent = await invite(o, { role: 'trainer', phone: local });
    assert.equal(sent.body.delivery.startPin, true);
    assert.match(lastMessage(e164(local)).text, /as a trainer/);
    const started = await post(pinLogin, { phone: local, pin: startPinIn(lastMessage(e164(local))) });
    const begun = await post(inviteBegin, { startToken: started.body.startToken, displayName: 'Coach Baraka', pin: '2468' });
    const accepted = await post(onboardingAccept, { onboardingToken: begun.body.onboardingToken, invitationId: begun.body.invitations[0].id });
    assert.equal(accepted.statusCode, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.user.userType, 'trainer');
    assert.equal(accepted.body.user.approvalStatus, 'approved', 'active at once');
    const profile = trainers.find(t => t.userId === accepted.body.user.id);
    assert.ok(profile, 'a trainer profile was created');
    assert.equal(profile.displayName, 'Coach Baraka');
    assert.deepEqual(profile.gymIds, [o.gymId]);
    assert.equal(profile.status, 'active');
  });
});

test('someone who already has an account gets the notice only, never a PIN', async () => {
  await on(async () => {
    const o = await makeOwner();
    const local = localPhone();
    const existing = await makeUser({ phone: local, displayName: 'Already Here' });
    await db('LoginIdentifier').insert({ id: uniq('lid'), personId: existing.personId, type: 'phone', value: e164(local), normalizedValue: e164(local), verifiedAt: new Date(), status: 'active' });
    await pinAuthService.setPin(existing.personId, '9090');

    const sent = await invite(o, { role: 'staff', phone: local, aclPermissions: [] });
    assert.deepEqual(sent.body.delivery, { sent: true, channel: 'sms', startPin: false });
    const message = lastMessage(e164(local));
    assert.match(message.text, /Open the FitFlex app to accept/);
    assert.equal(startPinIn(message), undefined);
    assert.equal((await db('Invitation').where({ id: sent.body.invitation.id }).first()).startPinHash, null);
    assert.equal((await post(pinLogin, { phone: local, pin: '9090' })).body.user.id, existing.id, 'they sign in with their own PIN');

    // An email that signs in through Firebase today is "already has an account" too.
    const email = `${uniq('fb')}@example.com`;
    await makeUser({ firebaseUid: uniq('fb'), email });
    const other = await invite(o, { role: 'staff', email, aclPermissions: [] });
    assert.equal(other.body.delivery.startPin, false);
  });
});

test('five wrong start PINs switch it off; sending again gives a new one', async () => {
  await on(async () => {
    const o = await makeOwner();
    const local = localPhone();
    const sent = await invite(o, { role: 'staff', phone: local, aclPermissions: [] });
    const first = startPinIn(lastMessage(e164(local)));
    for (let i = 0; i < 5; i += 1) assert.equal((await post(pinLogin, { phone: local, pin: wrongPin(first) })).statusCode, 401);
    const dead = await db('Invitation').where({ id: sent.body.invitation.id }).first();
    assert.equal(dead.startPinHash, null);
    assert.equal((await post(pinLogin, { phone: local, pin: first })).statusCode, 401, 'even the right one no longer works');

    await db('Invitation').where({ id: dead.id }).update({ lastSentAt: new Date(Date.now() - 25 * 3600e3) });
    const resent = await asOrg(gymResendInvitation, o.claims, { params: { gymId: o.gymId, invitationId: dead.id } });
    assert.equal(resent.statusCode, 200, JSON.stringify(resent.body));
    assert.deepEqual(resent.body.delivery, { sent: true, channel: 'sms', startPin: true });
    const second = startPinIn(lastMessage(e164(local)));
    assert.equal((await post(pinLogin, { phone: local, pin: second })).body.startPin, true);
  }, { PIN_FAILURES_PER_IDENTIFIER: '100' });
});

test('a vendor\'s invited staff member starts the same way', async () => {
  await on(async () => {
    const vendor = await makeUser({ userType: 'vendor', displayName: 'Mazoezi Gear', email: `${uniq('shop')}@example.com` });
    const email = `${uniq('clerk')}@example.com`;
    const sent = await asOrg(vendorCreateInvitation, { sub: vendor.id, userType: 'vendor' }, {
      params: { vendorId: vendor.id }, body: { role: 'staff', email, vendorRole: 'sales', permissions: ['orders'], locale: 'sw' },
    });
    assert.equal(sent.statusCode, 201, JSON.stringify(sent.body));
    assert.equal(sent.body.delivery.startPin, true);
    const message = lastMessage(email);
    assert.match(message.text, /Mazoezi Gear imekualika kujiunga kama mfanyakazi/);
    const started = await post(pinLogin, { email, pin: startPinIn(message) });
    assert.deepEqual(started.body.invitation, { orgType: 'vendor', role: 'staff' });
    const begun = await post(inviteBegin, { startToken: started.body.startToken, displayName: 'Asha Clerk', pin: '5050' });
    const accepted = await post(onboardingAccept, { onboardingToken: begun.body.onboardingToken, invitationId: begun.body.invitations[0].id });
    assert.equal(accepted.statusCode, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.user.userType, 'vendor_staff');
    assert.equal(accepted.body.user.vendorId, vendor.id);
  });
});

test('member invitations are not sent this way, and nothing is sent without a provider', async () => {
  await on(async () => {
    const o = await makeOwner();
    const local = localPhone();
    const now = new Date();
    const outbox = fakeOutbox.length;
    const member = await invite(o, { role: 'member', phone: local, durationUnit: 'M', startDate: now.toISOString(), endDate: new Date(+now + 30 * 86400e3).toISOString() });
    assert.equal(member.statusCode, 201, JSON.stringify(member.body));
    assert.deepEqual(member.body.delivery, { sent: false });
    assert.equal(fakeOutbox.length, outbox);
  });
  await on(async () => {
    const o = await makeOwner();
    const sent = await invite(o, { role: 'staff', phone: localPhone(), aclPermissions: [] });
    assert.equal(sent.statusCode, 201);
    assert.deepEqual(sent.body.delivery, { sent: false, reason: 'sms_not_configured' });
    assert.ok(sent.body.token, 'the gym still gets the link to share, as before');
  }, { VERIFICATION_SMS_PROVIDER: null });
});

test('with FitFlex PINs off, the invitation is announced without a start PIN and the routes do not exist', async () => {
  await on(async () => {
    const o = await makeOwner();
    const local = localPhone();
    const sent = await invite(o, { role: 'staff', phone: local, aclPermissions: [] });
    assert.deepEqual(sent.body.delivery, { sent: true, channel: 'sms', startPin: false });
    assert.equal(startPinIn(lastMessage(e164(local))), undefined);
    for (const route of [inviteBegin, onboardingAccept, onboardingDecline, onboardingRole]) {
      assert.equal((await post(route, {})).statusCode, 404);
    }
  }, { V2_PIN_LOGIN: null });
});

test('someone with no profile yet who resets their PIN lands on the choice, not an error', async () => {
  await on(async () => {
    const o = await makeOwner();
    const local = localPhone();
    const phone = e164(local);
    await invite(o, { role: 'staff', phone: local, aclPermissions: [] });
    const started = await post(pinLogin, { phone: local, pin: startPinIn(lastMessage(phone)) });
    const begun = await post(inviteBegin, { startToken: started.body.startToken, displayName: 'Zawadi Omari', pin: '4821' });
    await post(onboardingDecline, { onboardingToken: begun.body.onboardingToken, invitationId: begun.body.invitations[0].id });

    // Forgot PIN, with no profile to sign in to.
    assert.equal((await post(pinResetStart, { phone: local })).statusCode, 200);
    const code = lastMessage(phone).text.match(/\b(\d{6})\b/)[1];
    const confirmed = await post(pinResetConfirm, { phone: local, code });
    assert.equal(confirmed.statusCode, 200, JSON.stringify(confirmed.body));
    const done = await post(pinResetComplete, { resetToken: confirmed.body.resetToken, pin: '7310' });
    assert.equal(done.statusCode, 200, JSON.stringify(done.body));
    assert.equal(done.body.onboarding, true);
    assert.equal(done.body.token, undefined);
    assert.deepEqual(done.body.invitations, []);

    // The new PIN is the one that works, and the choice still leads to a session.
    assert.equal((await post(pinLogin, { phone: local, pin: '4821' })).statusCode, 401);
    const chosen = await post(onboardingRole, { onboardingToken: done.body.onboardingToken, role: 'member' });
    assert.equal(chosen.statusCode, 200, JSON.stringify(chosen.body));
    assert.equal(chosen.body.user.displayName, 'Zawadi Omari');
    assert.equal((await post(pinLogin, { phone: local, pin: '7310' })).body.user.id, chosen.body.user.id);
  }, { V2_RECOVERY: 'true' });
});
