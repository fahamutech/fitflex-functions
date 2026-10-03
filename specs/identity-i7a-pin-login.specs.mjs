// Identity V2 · I7a — sign in with a number or email and a PIN kept by FitFlex.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pinLogin, pinSetup } from '../functions/pin-auth.mjs';
import { myIdentifiers } from '../functions/identifiers.mjs';
import { users, pinAuthService, firebasePasswordCheck } from '../src/bootstrap/services.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { requireAuth, sign, signPurpose, invalidateAccountStatus } from '../src/auth/jwt.mjs';
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
/** Each test signs in from its own address unless it says otherwise. */
const freshAddress = () => `10.7.${Math.floor(addressCounter / 250)}.${(addressCounter++ % 250) + 1}`;
async function post(route, body, ip = freshAddress()) {
  const out = res();
  await route.onRequest({ body, headers: { 'x-forwarded-for': ip } }, out);
  return out;
}
async function withEnv(env, fn) {
  const names = ['IDENTITY_V2', 'V2_PIN_LOGIN', 'V2_PERSONAS', 'V2_IDENTIFIERS', 'V2_LINKING', 'VERIFICATION_EMAIL_PROVIDER', 'PIN_PEPPER', 'NODE_ENV', ...Object.keys(env)];
  const saved = Object.fromEntries(names.map(n => [n, process.env[n]]));
  Object.assign(process.env, env);
  for (const [k, v] of Object.entries(env)) if (v === null) delete process.env[k];
  try { return await fn(); } finally {
    for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
  }
}
const ON = { IDENTITY_V2: 'true', V2_PIN_LOGIN: 'true', V2_PERSONAS: 'true', V2_IDENTIFIERS: 'true', V2_LINKING: null, VERIFICATION_EMAIL_PROVIDER: 'fake' };
const on = (fn, extra = {}) => withEnv({ ...ON, ...extra }, fn);

async function makeUser(overrides = {}) {
  const row = {
    id: uniq('usr_i7a'), userType: 'member', accountStatus: 'active', approvalStatus: 'approved',
    createdAt: new Date().toISOString(), ...overrides,
  };
  await users.upsertAsync(u => u.id === row.id, row);
  return db('User').where({ id: row.id }).first();
}
const verifyIdentifier = (personId, type, value) => db('LoginIdentifier').insert({
  id: uniq('lid'), personId, type, value, normalizedValue: value, verifiedAt: new Date(), status: 'active',
});
/** A person who keeps a PIN with FitFlex and has a verified phone and email. */
async function personWithPin(pin = '4821', overrides = {}) {
  const local = localPhone();
  const email = `${uniq('p')}@example.com`;
  const user = await makeUser({ email, phone: local, displayName: 'Neema Abdallah', ...overrides });
  await verifyIdentifier(user.personId, 'phone', e164(local));
  await verifyIdentifier(user.personId, 'email', email);
  await pinAuthService.setPin(user.personId, pin);
  return { user, local, phone: e164(local), email, pin };
}
const personRow = id => db('Person').where({ id }).first();
const codeFor = to => fakeOutbox.filter(m => m.to === to).at(-1)?.text.match(/\b(\d{6})\b/)?.[1];
/** Stand in for Firebase: these email → password pairs are the accounts it knows. */
function firebaseKnows(accounts) {
  const original = firebasePasswordCheck.verify;
  firebasePasswordCheck.verify = async (email, password) => {
    const hit = accounts[email];
    return hit && hit.password === password ? { configured: true, ok: true, uid: hit.uid } : { configured: true, ok: false };
  };
  return () => { firebasePasswordCheck.verify = original; };
}

test('flag off: the PIN routes do not exist', async () => {
  await withEnv({ IDENTITY_V2: null, V2_PIN_LOGIN: null }, async () => {
    assert.equal((await post(pinLogin, { phone: '0712345678', pin: '1234' })).statusCode, 404);
    assert.equal((await post(pinSetup, { setupToken: 'x', pin: '1234' })).statusCode, 404);
  });
});

test('in production the PIN key must be set', async () => {
  await on(async () => {
    const out = await post(pinLogin, { phone: '0712345678', pin: '1234' });
    assert.equal(out.statusCode, 503);
    assert.equal(out.body.error, 'pin_not_configured');
  }, { NODE_ENV: 'production', PIN_PEPPER: null });
});

test('a verified number or email + PIN signs in, with no code', async () => {
  await on(async () => {
    const p = await personWithPin();
    const outbox = fakeOutbox.length;

    const byPhone = await post(pinLogin, { phone: p.local, pin: p.pin });
    assert.equal(byPhone.statusCode, 200, JSON.stringify(byPhone.body));
    assert.equal(byPhone.body.user.id, p.user.id);
    assert.ok(byPhone.body.token);
    assert.equal(byPhone.body.user.pinHash, undefined);
    assert.equal(JSON.stringify(byPhone.body).includes('scrypt:'), false, 'no hash leaves the server');
    assert.equal(byPhone.body.personas.length, 1);

    const byEmail = await post(pinLogin, { email: p.email.toUpperCase(), pin: p.pin });
    assert.equal(byEmail.statusCode, 200);
    assert.equal(byEmail.body.user.id, p.user.id);
    assert.equal(fakeOutbox.length, outbox, 'nothing is sent at sign-in');

    // The session it mints is an ordinary one.
    const guard = res();
    let passed = false;
    await requireAuth()({ headers: { authorization: `Bearer ${byPhone.body.token}` } }, guard, () => { passed = true; });
    assert.equal(passed, true);

    // What is stored is not the PIN, and is different for each person.
    const other = await personWithPin(p.pin);
    const [mine, theirs] = [await personRow(p.user.personId), await personRow(other.user.personId)];
    assert.match(mine.pinHash, /^scrypt:/);
    assert.equal(mine.pinHash.includes(p.pin), false);
    assert.notEqual(mine.pinHash, theirs.pinHash);
  });
});

test('wrong PIN, unknown number and unverified number all get the same answer', async () => {
  await on(async () => {
    const p = await personWithPin();
    const unverified = await makeUser({ phone: localPhone() });
    await pinAuthService.setPin(unverified.personId, '4821');

    const wrong = await post(pinLogin, { phone: p.local, pin: '0000' });
    const unknown = await post(pinLogin, { phone: localPhone(), pin: '4821' });
    const notVerified = await post(pinLogin, { phone: unverified.phone, pin: '4821' });
    for (const out of [wrong, unknown, notVerified]) {
      assert.equal(out.statusCode, 401);
      assert.deepEqual(out.body, { error: 'invalid_credentials' });
    }
    assert.equal((await post(pinLogin, { pin: '4821' })).body.error, 'one_phone_or_email_required');
    assert.equal((await post(pinLogin, { phone: p.local, email: p.email, pin: '4821' })).body.error, 'one_phone_or_email_required');
    assert.equal((await post(pinLogin, { phone: p.local, pin: '12' })).body.error, 'pin_required');
    assert.equal((await post(pinLogin, { phone: p.local, pin: 'abcd' })).body.error, 'pin_required');
  });
});

test('five wrong PINs pause sign-in; ten switch the PIN off until it is reset', async () => {
  await on(async () => {
    const p = await personWithPin();
    for (let i = 0; i < 4; i += 1) assert.equal((await post(pinLogin, { phone: p.local, pin: '0000' })).statusCode, 401);
    const fifth = await post(pinLogin, { phone: p.local, pin: '0000' });
    assert.equal(fifth.statusCode, 429);
    assert.equal(fifth.body.error, 'too_many_attempts');
    assert.equal(fifth.body.retryAfterSeconds, 15 * 60);

    // While paused, even the right PIN waits.
    const paused = await post(pinLogin, { phone: p.local, pin: p.pin });
    assert.equal(paused.statusCode, 429);
    assert.ok(paused.body.retryAfterSeconds > 0 && paused.body.retryAfterSeconds <= 15 * 60);
    assert.equal((await personRow(p.user.personId)).pinFailedCount, 5, 'a paused attempt is not counted');

    // After the pause the right PIN works and clears the count.
    await db('Person').where({ id: p.user.personId }).update({ pinLockedUntil: new Date(Date.now() - 1000) });
    assert.equal((await post(pinLogin, { phone: p.local, pin: p.pin })).statusCode, 200);
    assert.equal((await personRow(p.user.personId)).pinFailedCount, 0);

    // Ten in a row (each pause waited out) switch it off, even for the right PIN.
    for (let i = 0; i < 10; i += 1) {
      await db('Person').where({ id: p.user.personId }).update({ pinLockedUntil: null });
      await post(pinLogin, { email: p.email, pin: '0000' });
    }
    await db('Person').where({ id: p.user.personId }).update({ pinLockedUntil: null });
    const off = await post(pinLogin, { phone: p.local, pin: p.pin });
    assert.equal(off.statusCode, 403);
    assert.equal(off.body.error, 'pin_reset_required');
  }, { PIN_FAILURES_PER_IDENTIFIER: '100' });
});

test('guessing is limited per identifier and per network address', async () => {
  await on(async () => {
    const phone = localPhone();
    for (let i = 0; i < 3; i += 1) assert.equal((await post(pinLogin, { phone, pin: '0000' })).statusCode, 401);
    const limited = await post(pinLogin, { phone, pin: '0000' });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.body.error, 'too_many_attempts');
  }, { PIN_FAILURES_PER_IDENTIFIER: '3' });
  await on(async () => {
    const ip = '203.0.113.77';
    for (let i = 0; i < 3; i += 1) assert.equal((await post(pinLogin, { phone: localPhone(), pin: '0000' }, ip)).statusCode, 401);
    const p = await personWithPin();
    assert.equal((await post(pinLogin, { phone: p.local, pin: p.pin }, ip)).statusCode, 429, 'one address cannot try many accounts');
    assert.equal((await post(pinLogin, { phone: p.local, pin: p.pin })).statusCode, 200, 'another address is unaffected');
  }, { PIN_FAILURES_PER_ADDRESS: '3' });
});

test('the persona used last opens; a suspended or closed person cannot sign in', async () => {
  await on(async () => {
    const p = await personWithPin();
    const trainer = await makeUser({ userType: 'trainer', email: p.email });
    await db.transaction(async trx => {
      await trx.raw("SET LOCAL fitflex.identity_relink = 'on'");
      await trx('User').where({ id: trainer.id }).update({ personId: p.user.personId });
    });
    const first = await post(pinLogin, { phone: p.local, pin: p.pin });
    assert.equal(first.body.user.userType, 'trainer', 'the single non-member profile');
    await db('Person').where({ id: p.user.personId }).update({ lastPersonaId: p.user.id });
    assert.equal((await post(pinLogin, { phone: p.local, pin: p.pin })).body.user.id, p.user.id, 'the one used last');
    assert.equal((await post(pinLogin, { phone: p.local, pin: p.pin })).body.personas.length, 2);

    await db('Person').where({ id: p.user.personId }).update({ status: 'suspended' });
    const suspended = await post(pinLogin, { phone: p.local, pin: p.pin });
    assert.deepEqual([suspended.statusCode, suspended.body.error], [401, 'invalid_credentials']);
  });
});

test('sessions issued before sessionsValidAfter are refused; single-step tokens are never sessions', async () => {
  await on(async () => {
    const p = await personWithPin();
    const session = (await post(pinLogin, { phone: p.local, pin: p.pin })).body.token;
    const check = async token => {
      const out = res();
      let passed = false;
      await requireAuth()({ headers: { authorization: `Bearer ${token}` } }, out, () => { passed = true; });
      return passed ? 200 : out.statusCode;
    };
    assert.equal(await check(session), 200);

    await db('Person').where({ id: p.user.personId }).update({ sessionsValidAfter: new Date(Date.now() + 5000) });
    invalidateAccountStatus(p.user.id);
    assert.equal(await check(session), 401, 'ended');
    await db('Person').where({ id: p.user.personId }).update({ sessionsValidAfter: new Date(Date.now() - 3600e3) });
    invalidateAccountStatus(p.user.id);
    assert.equal(await check(session), 200, 'a session issued after it is fine');

    assert.equal(await check(signPurpose('pin_setup', { sub: p.user.id, userType: 'member' })), 401);
    assert.equal(await check(sign({ sub: p.user.id, userType: 'member' })), 200);
  });
});

// ── Existing users: the PIN is still only in Firebase ──────────────────────

test('an existing user proves their Firebase PIN, then their email by code, and keeps the PIN', async () => {
  await on(async () => {
    const uid = uniq('fb');
    const email = `${uniq('old')}@example.com`;
    const user = await makeUser({ firebaseUid: uid, email, displayName: 'Old Timer' });
    const restore = firebaseKnows({ [email]: { uid, password: 'fitflex-pin:2468' } });
    try {
      const wrong = await post(pinLogin, { email, pin: '1111' });
      assert.deepEqual([wrong.statusCode, wrong.body.error], [401, 'invalid_credentials']);

      const step = await post(pinLogin, { email, pin: '2468' });
      assert.equal(step.statusCode, 200, JSON.stringify(step.body));
      assert.equal(step.body.token, undefined, 'not signed in yet');
      assert.equal(step.body.setupRequired, true);
      assert.equal(step.body.verificationRequired, true);
      assert.equal(step.body.pinChangeRequired, false);
      const code = codeFor(email);
      assert.match(code, /^\d{6}$/);
      assert.equal((await personRow(user.personId)).pinHash, null, 'nothing is stored before the email is proved');

      assert.equal((await post(pinSetup, { setupToken: step.body.setupToken, code: '000000', pin: '2468' })).body.error, 'code_incorrect');
      assert.equal((await post(pinSetup, { setupToken: step.body.setupToken, code, pin: '24681' })).body.error, 'pin_must_be_4_digits');
      assert.equal((await post(pinSetup, { setupToken: 'nonsense', code, pin: '2468' })).statusCode, 401);

      const done = await post(pinSetup, { setupToken: step.body.setupToken, code, pin: '2468' });
      assert.equal(done.statusCode, 200, JSON.stringify(done.body));
      assert.equal(done.body.user.id, user.id);
      const identifier = await db('LoginIdentifier').where({ personId: user.personId, type: 'email', normalizedValue: email }).first();
      assert.ok(identifier.verifiedAt);

      // From now on FitFlex checks the PIN itself; Firebase is not asked again.
      firebasePasswordCheck.verify = async () => { throw new Error('Firebase must not be called'); };
      assert.equal((await post(pinLogin, { email, pin: '2468' })).statusCode, 200);
      assert.equal((await post(pinLogin, { email, pin: '1111' })).statusCode, 401);
      // The setup token works once.
      assert.equal((await post(pinSetup, { setupToken: step.body.setupToken, code, pin: '9999' })).body.error, 'pin_already_set');
      // It also shows as verified in the identifiers list.
      const out = res();
      await myIdentifiers.onRequest({ user: { sub: user.id } }, out);
      assert.deepEqual(out.body.identifiers.map(i => [i.type, i.value]), [['email', email]]);
    } finally { restore(); }
  });
});

test('an existing user with a longer PIN must choose a four-digit one', async () => {
  await on(async () => {
    const uid = uniq('fb');
    const email = `${uniq('long')}@example.com`;
    const user = await makeUser({ firebaseUid: uid, email });
    const restore = firebaseKnows({ [email]: { uid, password: 'fitflex-pin:135790' } });
    try {
      const step = await post(pinLogin, { email, pin: '135790' });
      assert.equal(step.body.setupRequired, true);
      assert.equal(step.body.pinChangeRequired, true);
      const code = codeFor(email);
      assert.equal((await post(pinSetup, { setupToken: step.body.setupToken, code, pin: '135790' })).body.error, 'pin_must_be_4_digits');
      // A refused PIN does not use up the code.
      const done = await post(pinSetup, { setupToken: step.body.setupToken, code, pin: '7310' });
      assert.equal(done.statusCode, 200, JSON.stringify(done.body));
      assert.equal(done.body.user.id, user.id);
      assert.equal((await post(pinLogin, { email, pin: '7310' })).statusCode, 200);
      assert.equal((await post(pinLogin, { email, pin: '135790' })).statusCode, 401, 'the old PIN is gone');
    } finally { restore(); }
  });
});

test('an existing user whose email is already verified keeps a four-digit PIN at once', async () => {
  await on(async () => {
    const uid = uniq('fb');
    const email = `${uniq('ver')}@example.com`;
    const user = await makeUser({ firebaseUid: uid, email });
    await verifyIdentifier(user.personId, 'email', email);
    const restore = firebaseKnows({ [email]: { uid, password: 'fitflex-pin:5050' } });
    const outbox = fakeOutbox.length;
    try {
      const out = await post(pinLogin, { email, pin: '5050' });
      assert.equal(out.statusCode, 200, JSON.stringify(out.body));
      assert.ok(out.body.token, 'signed in straight away');
      assert.equal(fakeOutbox.length, outbox, 'no code needed');
      assert.match((await personRow(user.personId)).pinHash, /^scrypt:/);
    } finally { restore(); }
  });
});

test('adoption is only for email accounts Firebase recognises, and never without Firebase configured', async () => {
  await on(async () => {
    const uid = uniq('fb');
    const email = `${uniq('g')}@example.com`;
    await makeUser({ firebaseUid: uid, email });
    // Firebase does not know a password for this account (for example Google sign-in only).
    const restore = firebaseKnows({});
    try {
      assert.equal((await post(pinLogin, { email, pin: '2468' })).statusCode, 401);
    } finally { restore(); }
    // The real check with no web API key configured: unavailable, same answer.
    await withEnv({ FIREBASE_WEB_API_KEY: null }, async () => {
      assert.deepEqual((await post(pinLogin, { email, pin: '2468' })).body, { error: 'invalid_credentials' });
    });
  });
});
