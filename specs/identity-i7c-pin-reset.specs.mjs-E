// Identity V2 · I7c — forgot PIN and change PIN.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pinLogin, pinResetStart, pinResetConfirm, pinResetComplete, changeMyPin } from '../functions/pin-auth.mjs';
import { users, pinAuthService } from '../src/bootstrap/services.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
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
const freshAddress = () => `10.9.${Math.floor(addressCounter / 250)}.${(addressCounter++ % 250) + 1}`;
async function post(route, body, ip = freshAddress()) {
  const out = res();
  await route.onRequest({ body, headers: { 'x-forwarded-for': ip } }, out);
  return out;
}
/** A signed-in call: runs the route's guard with the session token. */
async function authed(route, token, body) {
  const req = { headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': freshAddress() }, body };
  const out = res();
  let passed = false;
  await route.onGuard(req, out, () => { passed = true; });
  if (!passed) return out;
  await route.onRequest(req, out);
  return out;
}
const sessionWorks = async token => {
  const out = res();
  let passed = false;
  await requireAuth()({ headers: { authorization: `Bearer ${token}` } }, out, () => { passed = true; });
  return passed;
};
async function withEnv(env, fn) {
  const names = ['IDENTITY_V2', 'V2_PIN_LOGIN', 'V2_RECOVERY', 'V2_PERSONAS', 'V2_LINKING', 'VERIFICATION_EMAIL_PROVIDER', 'VERIFICATION_SMS_PROVIDER', ...Object.keys(env)];
  const saved = Object.fromEntries(names.map(n => [n, process.env[n]]));
  Object.assign(process.env, env);
  for (const [k, v] of Object.entries(env)) if (v === null) delete process.env[k];
  try { return await fn(); } finally {
    for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
  }
}
const ON = { IDENTITY_V2: 'true', V2_PIN_LOGIN: 'true', V2_RECOVERY: 'true', V2_PERSONAS: 'true', V2_LINKING: null, VERIFICATION_EMAIL_PROVIDER: 'fake', VERIFICATION_SMS_PROVIDER: 'fake' };
const on = (fn, extra = {}) => withEnv({ ...ON, ...extra }, fn);

async function makeUser(overrides = {}) {
  const row = {
    id: uniq('usr_i7c'), userType: 'member', accountStatus: 'active', approvalStatus: 'approved',
    createdAt: new Date().toISOString(), ...overrides,
  };
  await users.upsertAsync(u => u.id === row.id, row);
  return db('User').where({ id: row.id }).first();
}
const verifyIdentifier = (personId, type, value) => db('LoginIdentifier').insert({
  id: uniq('lid'), personId, type, value, normalizedValue: value, verifiedAt: new Date(), status: 'active',
});
async function personWithPin(pin = '4821') {
  const local = localPhone();
  const email = `${uniq('p')}@example.com`;
  const user = await makeUser({ email, phone: local });
  await verifyIdentifier(user.personId, 'phone', e164(local));
  await verifyIdentifier(user.personId, 'email', email);
  await pinAuthService.setPin(user.personId, pin);
  return { user, local, phone: e164(local), email, pin };
}
const codeFor = to => fakeOutbox.filter(m => m.to === to).at(-1)?.text.match(/\b(\d{6})\b/)?.[1];
const personRow = id => db('Person').where({ id }).first();
/** Let the session's issue second pass, so "issued before the reset" is unambiguous. */
const nextSecond = () => new Promise(resolve => setTimeout(resolve, 1100));

test('flags off: forgot PIN and change PIN do not exist', async () => {
  await withEnv({ IDENTITY_V2: 'true', V2_PIN_LOGIN: 'true', V2_RECOVERY: null }, async () => {
    for (const route of [pinResetStart, pinResetConfirm, pinResetComplete]) {
      assert.equal((await post(route, { phone: '0712345678' })).statusCode, 404);
    }
  });
  await on(async () => {
    const p = await personWithPin();
    const { token } = (await post(pinLogin, { phone: p.local, pin: p.pin })).body;
    await withEnv({ V2_PIN_LOGIN: null }, async () => {
      assert.equal((await authed(changeMyPin, token, { currentPin: p.pin, newPin: '7310' })).statusCode, 404);
    });
  });
});

test('forgot PIN: a code to the number, a new PIN, other devices signed out, lockout cleared', async () => {
  await on(async () => {
    const p = await personWithPin();
    const oldSession = (await post(pinLogin, { phone: p.local, pin: p.pin })).body.token;
    assert.equal(await sessionWorks(oldSession), true);
    // Lock the PIN out entirely.
    await db('Person').where({ id: p.user.personId }).update({ pinFailedCount: 10 });
    assert.equal((await post(pinLogin, { phone: p.local, pin: p.pin })).body.error, 'pin_reset_required');
    await nextSecond();

    const started = await post(pinResetStart, { phone: p.local });
    assert.equal(started.statusCode, 200, JSON.stringify(started.body));
    assert.equal(started.body.channel, 'sms');
    const code = codeFor(p.phone);
    assert.match(code, /^\d{6}$/);
    assert.equal(JSON.stringify(started.body).includes(code), false);

    assert.equal((await post(pinResetConfirm, { phone: p.local, code: '000000' })).body.error, 'code_incorrect');
    const confirmed = await post(pinResetConfirm, { phone: p.local, code });
    assert.equal(confirmed.statusCode, 200);
    const resetToken = confirmed.body.resetToken;
    assert.equal(await sessionWorks(resetToken), false, 'the reset token is not a session');

    assert.equal((await post(pinResetComplete, { resetToken, pin: '123' })).body.error, 'pin_must_be_4_digits');
    assert.equal((await post(pinResetComplete, { resetToken: 'nonsense', pin: '7310' })).statusCode, 401);
    const done = await post(pinResetComplete, { resetToken, pin: '7310' });
    assert.equal(done.statusCode, 200, JSON.stringify(done.body));
    assert.equal(done.body.user.id, p.user.id);

    assert.equal(await sessionWorks(done.body.token), true, 'this device is signed in');
    assert.equal(await sessionWorks(oldSession), false, 'every earlier session is over');
    const person = await personRow(p.user.personId);
    assert.equal(person.pinFailedCount, 0);
    assert.equal((await post(pinLogin, { phone: p.local, pin: '7310' })).statusCode, 200);
    assert.equal((await post(pinLogin, { email: p.email, pin: p.pin })).statusCode, 401, 'the old PIN is gone');

    // The reset token sets a PIN once.
    const again = await post(pinResetComplete, { resetToken, pin: '9999' });
    assert.deepEqual([again.statusCode, again.body.error], [401, 'reset_token_invalid']);
    assert.equal((await post(pinLogin, { phone: p.local, pin: '9999' })).statusCode, 401);
  });
});

test('forgot PIN works through the verified email too', async () => {
  await on(async () => {
    const p = await personWithPin();
    const started = await post(pinResetStart, { email: p.email.toUpperCase(), locale: 'sw' });
    assert.equal(started.body.channel, 'email');
    const confirmed = await post(pinResetConfirm, { email: p.email, code: codeFor(p.email) });
    const done = await post(pinResetComplete, { resetToken: confirmed.body.resetToken, pin: '2468' });
    assert.equal(done.statusCode, 200);
    assert.equal((await post(pinLogin, { phone: p.local, pin: '2468' })).statusCode, 200, 'one PIN for number and email');
  });
});

test('forgot PIN gives the same answer for a number nobody uses, and sends nothing', async () => {
  await on(async () => {
    const p = await personWithPin();
    const known = await post(pinResetStart, { phone: p.local });
    const outbox = fakeOutbox.length;
    const unknownPhone = localPhone();
    const unknown = await post(pinResetStart, { phone: unknownPhone });
    assert.equal(unknown.statusCode, 200);
    assert.deepEqual(Object.keys(unknown.body).sort(), Object.keys(known.body).sort());
    assert.deepEqual({ ...unknown.body, identifierValue: null }, { ...known.body, identifierValue: null });
    assert.equal(fakeOutbox.length, outbox, 'no code is sent to a number nobody uses');
    assert.equal((await post(pinResetConfirm, { phone: unknownPhone, code: '123456' })).body.error, 'code_not_found_or_expired');

    // Asking again too soon looks the same as a first request (no second SMS).
    const repeat = await post(pinResetStart, { phone: p.local });
    assert.equal(repeat.statusCode, 200);
    assert.equal(repeat.body.sent, true);
    assert.equal(fakeOutbox.length, outbox);

    assert.equal((await post(pinResetStart, {})).body.error, 'one_phone_or_email_required');
  });
});

test('forgot PIN requests are limited per network address', async () => {
  await on(async () => {
    const ip = '203.0.113.91';
    for (let i = 0; i < 2; i += 1) assert.equal((await post(pinResetStart, { phone: localPhone() }, ip)).statusCode, 200);
    const limited = await post(pinResetStart, { phone: localPhone() }, ip);
    assert.deepEqual([limited.statusCode, limited.body.error], [429, 'too_many_attempts']);
  }, { PIN_RESET_STARTS_PER_ADDRESS_PER_HOUR: '2' });
});

test('an existing user whose PIN is still in Firebase can reset it by email, which moves them to FitFlex', async () => {
  await on(async () => {
    const uid = uniq('fb');
    const email = `${uniq('forgot')}@example.com`;
    const user = await makeUser({ firebaseUid: uid, email });
    assert.equal((await personRow(user.personId)).pinHash, null);

    await post(pinResetStart, { email });
    const confirmed = await post(pinResetConfirm, { email, code: codeFor(email) });
    assert.equal(confirmed.statusCode, 200, JSON.stringify(confirmed.body));
    const done = await post(pinResetComplete, { resetToken: confirmed.body.resetToken, pin: '5050' });
    assert.equal(done.statusCode, 200, JSON.stringify(done.body));
    assert.equal(done.body.user.id, user.id);
    const identifier = await db('LoginIdentifier').where({ personId: user.personId, type: 'email', normalizedValue: email }).first();
    assert.ok(identifier.verifiedAt, 'the code proved the email');
    assert.equal((await post(pinLogin, { email, pin: '5050' })).statusCode, 200);

    // A number that is only typed into a profile, never proved, cannot reset anything.
    const unproved = await makeUser({ firebaseUid: uniq('fb'), phone: localPhone() });
    const outbox = fakeOutbox.length;
    await post(pinResetStart, { phone: unproved.phone });
    assert.equal(fakeOutbox.length, outbox);
  });
});

test('change PIN: the current PIN, then a new one; earlier sessions end and a new one is returned', async () => {
  await on(async () => {
    const p = await personWithPin();
    const first = (await post(pinLogin, { phone: p.local, pin: p.pin })).body.token;
    const second = (await post(pinLogin, { email: p.email, pin: p.pin })).body.token;
    await nextSecond();

    assert.equal((await authed(changeMyPin, 'not-a-token', { currentPin: p.pin, newPin: '7310' })).statusCode, 401);
    assert.equal((await authed(changeMyPin, first, { currentPin: p.pin, newPin: '73100' })).body.error, 'pin_must_be_4_digits');
    const wrong = await authed(changeMyPin, first, { currentPin: '0000', newPin: '7310' });
    assert.deepEqual([wrong.statusCode, wrong.body.error], [400, 'current_pin_incorrect']);
    assert.equal((await personRow(p.user.personId)).pinFailedCount, 1, 'a wrong current PIN counts toward the lockout');
    assert.equal((await authed(changeMyPin, first, { currentPin: p.pin, newPin: p.pin })).body.error, 'pin_unchanged');

    const changed = await authed(changeMyPin, first, { currentPin: p.pin, newPin: '7310' });
    assert.equal(changed.statusCode, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.user.id, p.user.id);
    assert.equal(await sessionWorks(changed.body.token), true);
    assert.equal(await sessionWorks(first), false);
    assert.equal(await sessionWorks(second), false, 'the other device is signed out');
    assert.equal((await post(pinLogin, { phone: p.local, pin: '7310' })).statusCode, 200);
    assert.equal((await post(pinLogin, { phone: p.local, pin: p.pin })).statusCode, 401);
  });
});

test('change PIN is refused when there is no FitFlex PIN, and wrong tries lock it like sign-in', async () => {
  await on(async () => {
    const google = await makeUser({ firebaseUid: uniq('fb'), email: `${uniq('g')}@example.com` });
    const { sign } = await import('../src/auth/jwt.mjs');
    const out = await authed(changeMyPin, sign({ sub: google.id, userType: 'member' }), { currentPin: '1234', newPin: '7310' });
    assert.deepEqual([out.statusCode, out.body.error], [409, 'pin_not_set']);

    const p = await personWithPin();
    const token = (await post(pinLogin, { phone: p.local, pin: p.pin })).body.token;
    for (let i = 0; i < 4; i += 1) assert.equal((await authed(changeMyPin, token, { currentPin: '0000', newPin: '7310' })).statusCode, 400);
    const fifth = await authed(changeMyPin, token, { currentPin: '0000', newPin: '7310' });
    assert.deepEqual([fifth.statusCode, fifth.body.error], [429, 'too_many_attempts']);
    assert.equal((await post(pinLogin, { phone: p.local, pin: p.pin })).statusCode, 429, 'sign-in is paused too');
  });
});
