// Identity V2 · I7b — register with a number or email: a code, then a PIN.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerStart, registerConfirm, registerComplete, pinLogin } from '../functions/pin-auth.mjs';
import { gymCreateInvitation, myInvitations } from '../functions/invitations.mjs';
import { users } from '../src/bootstrap/services.mjs';
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
const freshAddress = () => `10.8.${Math.floor(addressCounter / 250)}.${(addressCounter++ % 250) + 1}`;
async function post(route, body, ip = freshAddress()) {
  const out = res();
  await route.onRequest({ body, headers: { 'x-forwarded-for': ip } }, out);
  return out;
}
async function withEnv(env, fn) {
  const names = ['IDENTITY_V2', 'V2_PIN_LOGIN', 'V2_PERSONAS', 'V2_INVITES', 'V2_LINKING', 'VERIFICATION_EMAIL_PROVIDER', 'VERIFICATION_SMS_PROVIDER', ...Object.keys(env)];
  const saved = Object.fromEntries(names.map(n => [n, process.env[n]]));
  Object.assign(process.env, env);
  for (const [k, v] of Object.entries(env)) if (v === null) delete process.env[k];
  try { return await fn(); } finally {
    for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
  }
}
const ON = { IDENTITY_V2: 'true', V2_PIN_LOGIN: 'true', V2_PERSONAS: 'true', V2_INVITES: 'true', V2_LINKING: null, VERIFICATION_EMAIL_PROVIDER: 'fake', VERIFICATION_SMS_PROVIDER: 'fake' };
const on = (fn, extra = {}) => withEnv({ ...ON, ...extra }, fn);

const codeFor = to => fakeOutbox.filter(m => m.to === to).at(-1)?.text.match(/\b(\d{6})\b/)?.[1];
/** start + confirm; returns the registration token. */
async function verified(contact) {
  const started = await post(registerStart, contact);
  assert.equal(started.statusCode, 200, JSON.stringify(started.body));
  const to = started.body.identifierValue;
  const confirmed = await post(registerConfirm, { ...contact, code: codeFor(to) });
  assert.equal(confirmed.statusCode, 200, JSON.stringify(confirmed.body));
  return { token: confirmed.body.registrationToken, to };
}
async function makeUser(overrides = {}) {
  const row = {
    id: uniq('usr_i7b'), userType: 'member', accountStatus: 'active', approvalStatus: 'approved',
    createdAt: new Date().toISOString(), ...overrides,
  };
  await users.upsertAsync(u => u.id === row.id, row);
  return db('User').where({ id: row.id }).first();
}

test('flag off: the registration routes do not exist', async () => {
  await withEnv({ IDENTITY_V2: null, V2_PIN_LOGIN: null }, async () => {
    for (const route of [registerStart, registerConfirm, registerComplete]) {
      assert.equal((await post(route, { phone: '0712345678' })).statusCode, 404);
    }
  });
});

test('register with a mobile number: code, then a four-digit PIN, then signed in', async () => {
  await on(async () => {
    const local = localPhone();
    const started = await post(registerStart, { phone: local, locale: 'sw' });
    assert.equal(started.statusCode, 200, JSON.stringify(started.body));
    assert.equal(started.body.channel, 'sms');
    assert.equal(started.body.identifierValue, e164(local));
    const code = codeFor(e164(local));
    assert.equal(JSON.stringify(started.body).includes(code), false, 'the code is never returned');
    assert.equal((await db('User').whereRaw("regexp_replace(phone, '\\D', '', 'g') LIKE ?", [`%${local.slice(1)}`])).length, 0, 'no account yet');

    assert.equal((await post(registerConfirm, { phone: local, code: '000000' })).body.error, 'code_incorrect');
    const confirmed = await post(registerConfirm, { phone: local, code });
    assert.equal(confirmed.statusCode, 200);
    assert.ok(confirmed.body.registrationToken);
    assert.equal((await db('User').whereRaw("regexp_replace(phone, '\\D', '', 'g') LIKE ?", [`%${local.slice(1)}`])).length, 0, 'still no account: the PIN comes first');

    const token = confirmed.body.registrationToken;
    assert.equal((await post(registerComplete, { registrationToken: token, role: 'member', pin: '12345' })).body.error, 'pin_must_be_4_digits');
    assert.equal((await post(registerComplete, { registrationToken: token, role: 'member' })).body.error, 'pin_must_be_4_digits');
    assert.equal((await post(registerComplete, { registrationToken: token, role: 'gym_staff', pin: '4821' })).body.error, 'role_not_allowed');
    assert.equal((await post(registerComplete, { registrationToken: token, role: 'admin', pin: '4821' })).body.error, 'role_not_allowed');
    assert.equal((await post(registerComplete, { registrationToken: 'nonsense', role: 'member', pin: '4821' })).statusCode, 401);

    const done = await post(registerComplete, { registrationToken: token, role: 'member', pin: '4821', displayName: 'Neema Abdallah' });
    assert.equal(done.statusCode, 200, JSON.stringify(done.body));
    assert.ok(done.body.token);
    assert.equal(done.body.user.userType, 'member');
    assert.equal(done.body.user.displayName, 'Neema Abdallah');
    assert.equal(done.body.user.phone, e164(local));
    assert.equal(done.body.user.onboardingCompleted, false, 'onboarding follows, as for any new account');

    const user = await db('User').where({ id: done.body.user.id }).first();
    assert.equal(user.firebaseUid, null, 'no Firebase account is involved');
    const identifier = await db('LoginIdentifier').where({ personId: user.personId, type: 'phone', normalizedValue: e164(local) }).first();
    assert.ok(identifier.verifiedAt);
    assert.equal(identifier.provider, 'fitflex_sms');
    assert.match((await db('Person').where({ id: user.personId }).first()).pinHash, /^scrypt:/);

    // The session works, and so does signing in again with number + PIN.
    let passed = false;
    await requireAuth()({ headers: { authorization: `Bearer ${done.body.token}` } }, res(), () => { passed = true; });
    assert.equal(passed, true);
    const again = await post(pinLogin, { phone: local, pin: '4821' });
    assert.equal(again.statusCode, 200);
    assert.equal(again.body.user.id, user.id);

    // The token works once, and the number is now taken.
    assert.equal((await post(registerComplete, { registrationToken: token, role: 'trainer', pin: '4821' })).body.error, 'already_registered');
    const retry = await post(registerStart, { phone: local });
    assert.deepEqual([retry.statusCode, retry.body.error], [409, 'already_registered']);
    assert.equal((await db('User').where({ personId: user.personId })).length, 1);
  });
});

test('register with an email; each role gets its usual starting state', async () => {
  await on(async () => {
    const expected = { member: ['member', 'approved'], trainer: ['trainer', 'approved'], gym_owner: ['gym_operator', 'approved'], vendor: ['vendor', 'pending_approval'] };
    for (const [role, [userType, approvalStatus]] of Object.entries(expected)) {
      const email = `${uniq(role)}@Example.com`;
      const started = await post(registerStart, { email });
      assert.equal(started.body.channel, 'email');
      const { token } = await verified({ email: `${uniq(role)}@example.com` });
      const done = await post(registerComplete, { registrationToken: token, role, pin: '7310' });
      assert.equal(done.statusCode, 200, JSON.stringify(done.body));
      assert.deepEqual([done.body.user.userType, done.body.user.approvalStatus], [userType, approvalStatus]);
      assert.equal(done.body.pendingApproval, approvalStatus === 'pending_approval');
      const identifier = await db('LoginIdentifier').where({ type: 'email', normalizedValue: done.body.user.email }).first();
      assert.equal(identifier.provider, 'fitflex_email');
      assert.equal((await post(pinLogin, { email: done.body.user.email.toUpperCase(), pin: '7310' })).statusCode, 200);
    }
  });
});

test('an email or number someone already signs in with is told so, and no code is sent', async () => {
  await on(async () => {
    // Today's app user: an email with a Firebase sign-in.
    const email = `${uniq('fb')}@example.com`;
    await makeUser({ firebaseUid: uniq('fb'), email });
    const outbox = fakeOutbox.length;
    const out = await post(registerStart, { email });
    assert.deepEqual([out.statusCode, out.body.error], [409, 'already_registered']);
    assert.equal(fakeOutbox.length, outbox);

    assert.equal((await post(registerStart, {})).body.error, 'one_phone_or_email_required');
    assert.equal((await post(registerStart, { email, phone: '0712345678' })).body.error, 'one_phone_or_email_required');
    assert.equal((await post(registerConfirm, { email: `${uniq('none')}@example.com`, code: '123456' })).body.error, 'code_not_found_or_expired');
  });
});

test('a profile a gym created earlier is reused, not duplicated, and its invitation follows', async () => {
  await on(async () => {
    const local = localPhone();
    // Created at the desk before invitations: a phone, no sign-in of its own.
    const desk = await makeUser({ userType: 'member', phone: local, displayName: 'Desk Member' });
    const gymId = uniq('gym_i7b');
    await db('Gym').insert({ id: gymId, name: 'Iron Paradise', tier: 'standard', location: 'Dar es Salaam', status: 'active', updatedAt: new Date() });
    const owner = await makeUser({ userType: 'gym_operator', gymIds: [gymId], gymId });
    const invited = res();
    const ownerClaims = { sub: owner.id, userType: 'gym_operator' };
    for (const guard of [gymCreateInvitation.onGuard].flat()) await guard({ headers: { authorization: `Bearer ${sign(ownerClaims)}` }, params: { gymId } }, invited, () => {});
    await gymCreateInvitation.onRequest({ user: ownerClaims, headers: { authorization: `Bearer ${sign(ownerClaims)}` }, params: { gymId }, body: { role: 'staff', phone: local, aclPermissions: ['members'] } }, invited);
    assert.equal(invited.statusCode, 201, JSON.stringify(invited.body));

    const { token } = await verified({ phone: local });
    const done = await post(registerComplete, { registrationToken: token, role: 'member', pin: '2468' });
    assert.equal(done.statusCode, 200, JSON.stringify(done.body));
    assert.equal(done.body.user.id, desk.id, 'the same profile, same id, same history');
    assert.equal((await db('User').whereRaw("regexp_replace(phone, '\\D', '', 'g') LIKE ?", [`%${local.slice(1)}`])).length, 1);

    // The invitation sent to that number is now theirs.
    const mine = res();
    await myInvitations.onRequest({ user: { sub: desk.id } }, mine);
    assert.equal(mine.body.invitations.length, 1);
    assert.equal(mine.body.invitations[0].role, 'staff');
  });
});

test('requests are limited per network address and capped per day', async () => {
  await on(async () => {
    const ip = '203.0.113.90';
    for (let i = 0; i < 2; i += 1) assert.equal((await post(registerStart, { phone: localPhone() }, ip)).statusCode, 200);
    const outbox = fakeOutbox.length;
    const limited = await post(registerStart, { phone: localPhone() }, ip);
    assert.deepEqual([limited.statusCode, limited.body.error], [429, 'too_many_attempts']);
    assert.equal(fakeOutbox.length, outbox, 'nothing is sent once limited');
    assert.equal((await post(registerStart, { phone: localPhone() })).statusCode, 200, 'another address is unaffected');
  }, { REGISTER_STARTS_PER_ADDRESS_PER_HOUR: '2' });
  await on(async () => {
    const sentToday = Number((await db('VerificationCode').where({ purpose: 'register', outcome: 'sent' }).count({ n: '*' }).first()).n);
    await withEnv({ REGISTER_CODES_PER_DAY: String(sentToday) }, async () => {
      const outbox = fakeOutbox.length;
      const capped = await post(registerStart, { phone: localPhone() });
      assert.deepEqual([capped.statusCode, capped.body.error], [503, 'registration_busy']);
      assert.equal(fakeOutbox.length, outbox);
    });
  });
});

test('a provider that is not configured sends nothing and creates nothing', async () => {
  await on(async () => {
    const out = await post(registerStart, { phone: localPhone() });
    assert.deepEqual([out.statusCode, out.body.error], [503, 'sms_not_configured']);
  }, { VERIFICATION_SMS_PROVIDER: null });
});
