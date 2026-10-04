// Identity V2 · I7e — replacing the number or email a person signs in with:
// their PIN, then a code to the new value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { requestIdentifierChange, confirmIdentifierChange } from '../functions/identifiers.mjs';
import { pinLogin } from '../functions/pin-auth.mjs';
import { users, pinAuthService } from '../src/bootstrap/services.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
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
const freshAddress = () => `10.12.${Math.floor(addressCounter / 250)}.${(addressCounter++ % 250) + 1}`;
async function authed(route, claims, body) {
  const req = { headers: { authorization: `Bearer ${sign(claims)}`, 'x-forwarded-for': freshAddress() }, body };
  const out = res();
  let passed = false;
  await route.onGuard(req, out, () => { passed = true; });
  if (!passed) return out;
  await route.onRequest(req, out);
  return out;
}
async function post(route, body) {
  const out = res();
  await route.onRequest({ body, headers: { 'x-forwarded-for': freshAddress() } }, out);
  return out;
}
async function withEnv(env, fn) {
  const names = ['IDENTITY_V2', 'V2_PIN_LOGIN', 'V2_RECOVERY', 'V2_IDENTIFIERS', 'V2_PERSONAS', 'V2_LINKING', 'VERIFICATION_EMAIL_PROVIDER', 'VERIFICATION_SMS_PROVIDER', ...Object.keys(env)];
  const saved = Object.fromEntries(names.map(n => [n, process.env[n]]));
  Object.assign(process.env, env);
  for (const [k, v] of Object.entries(env)) if (v === null) delete process.env[k];
  try { return await fn(); } finally {
    for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
  }
}
const ON = { IDENTITY_V2: 'true', V2_PIN_LOGIN: 'true', V2_RECOVERY: 'true', V2_IDENTIFIERS: 'true', V2_PERSONAS: 'true', V2_LINKING: null, VERIFICATION_EMAIL_PROVIDER: 'fake', VERIFICATION_SMS_PROVIDER: 'fake' };
const on = (fn, extra = {}) => withEnv({ ...ON, ...extra }, fn);

async function makeUser(overrides = {}) {
  const row = {
    id: uniq('usr_i7e'), userType: 'member', accountStatus: 'active', approvalStatus: 'approved',
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
  const user = await makeUser({ email, phone: e164(local) });
  await verifyIdentifier(user.personId, 'phone', e164(local));
  await verifyIdentifier(user.personId, 'email', email);
  await pinAuthService.setPin(user.personId, pin);
  return { user, local, phone: e164(local), email, pin, claims: { sub: user.id, userType: 'member' } };
}
const codeFor = to => fakeOutbox.filter(m => m.to === to).at(-1)?.text.match(/\b(\d{6})\b/)?.[1];
const active = (personId, type) => db('LoginIdentifier').where({ personId, type, status: 'active' }).whereNotNull('verifiedAt');

test('flag off: the change routes do not exist', async () => {
  await on(async () => {
    const p = await personWithPin();
    assert.equal((await authed(requestIdentifierChange, p.claims, { phone: localPhone(), pin: p.pin })).statusCode, 404);
    assert.equal((await authed(confirmIdentifierChange, p.claims, { phone: localPhone(), code: '123456' })).statusCode, 404);
  }, { V2_RECOVERY: null });
});

test('changing the mobile number: PIN, a code to the new number, then it replaces the old one', async () => {
  await on(async () => {
    const p = await personWithPin();
    const other = await makeUser({ userType: 'trainer' });
    await db.transaction(async trx => {
      await trx.raw("SET LOCAL fitflex.identity_relink = 'on'");
      await trx('User').where({ id: other.id }).update({ personId: p.user.personId, phone: p.phone });
    });
    const newLocal = localPhone();
    const newPhone = e164(newLocal);

    const asked = await authed(requestIdentifierChange, p.claims, { phone: newLocal, pin: p.pin });
    assert.equal(asked.statusCode, 200, JSON.stringify(asked.body));
    assert.equal(asked.body.channel, 'sms');
    assert.equal(asked.body.identifierValue, newPhone);
    const code = codeFor(newPhone);
    assert.match(code, /^\d{6}$/, 'the code goes to the NEW number');
    assert.deepEqual((await active(p.user.personId, 'phone')).map(r => r.normalizedValue), [p.phone], 'nothing changes until the code is confirmed');

    assert.equal((await authed(confirmIdentifierChange, p.claims, { phone: newLocal, code: '000000' })).body.error, 'code_incorrect');
    const done = await authed(confirmIdentifierChange, p.claims, { phone: newLocal, code });
    assert.equal(done.statusCode, 200, JSON.stringify(done.body));
    assert.equal(done.body.changed, true);
    assert.deepEqual(done.body.identifiers.filter(i => i.type === 'phone').map(i => i.value), [newPhone]);
    assert.ok(done.body.identifiers.some(i => i.type === 'email' && i.value === p.email), 'the email is untouched');

    assert.deepEqual((await active(p.user.personId, 'phone')).map(r => r.normalizedValue), [newPhone]);
    const oldRow = await db('LoginIdentifier').where({ personId: p.user.personId, normalizedValue: p.phone }).first();
    assert.equal(oldRow.status, 'revoked');

    // The new number signs in; the old one no longer does.
    assert.equal((await post(pinLogin, { phone: newLocal, pin: p.pin })).statusCode, 200);
    assert.equal((await post(pinLogin, { phone: p.local, pin: p.pin })).statusCode, 401);
    // The copies shown on both profiles follow.
    for (const id of [p.user.id, other.id]) assert.equal((await db('User').where({ id }).first()).phone, newPhone);
    // The old number is told.
    const notice = fakeOutbox.filter(m => m.to === p.phone).at(-1);
    assert.match(notice.text, /mobile number on your account was changed/);
    // The same person and profiles: nothing was recreated.
    assert.equal((await db('User').where({ personId: p.user.personId })).length, 2);
  });
});

test('changing the email works the same way', async () => {
  await on(async () => {
    const p = await personWithPin();
    const newEmail = `${uniq('new')}@Example.com`;
    const asked = await authed(requestIdentifierChange, p.claims, { email: newEmail, pin: p.pin, locale: 'sw' });
    assert.equal(asked.body.channel, 'email');
    const done = await authed(confirmIdentifierChange, p.claims, { email: newEmail, code: codeFor(newEmail.toLowerCase()), locale: 'sw' });
    assert.equal(done.statusCode, 200, JSON.stringify(done.body));
    assert.deepEqual((await active(p.user.personId, 'email')).map(r => r.normalizedValue), [newEmail.toLowerCase()]);
    assert.equal((await post(pinLogin, { email: newEmail, pin: p.pin })).statusCode, 200);
    assert.equal((await post(pinLogin, { email: p.email, pin: p.pin })).statusCode, 401);
    assert.equal((await db('User').where({ id: p.user.id }).first()).email, newEmail.toLowerCase());
    assert.equal(fakeOutbox.filter(m => m.to === p.email).at(-1).subject, 'Taarifa zako za kuingia FitFlex zimebadilishwa');
  });
});

test('the PIN is required, and wrong PINs count toward the lockout', async () => {
  await on(async () => {
    const p = await personWithPin();
    const outbox = fakeOutbox.length;
    const noPin = await authed(requestIdentifierChange, p.claims, { phone: localPhone() });
    assert.deepEqual([noPin.statusCode, noPin.body.error], [400, 'pin_incorrect']);
    for (let i = 0; i < 3; i += 1) assert.equal((await authed(requestIdentifierChange, p.claims, { phone: localPhone(), pin: '0000' })).body.error, 'pin_incorrect');
    const locked = await authed(requestIdentifierChange, p.claims, { phone: localPhone(), pin: '0000' });
    assert.deepEqual([locked.statusCode, locked.body.error], [429, 'too_many_attempts']);
    assert.equal(fakeOutbox.length, outbox, 'no code is sent without the right PIN');
    assert.equal((await post(pinLogin, { phone: p.local, pin: p.pin })).statusCode, 429, 'sign-in is paused too');

    // No session, no change.
    const out = res();
    let passed = false;
    await requestIdentifierChange.onGuard({ headers: {} }, out, () => { passed = true; });
    assert.equal(passed, false);
    assert.equal(out.statusCode, 401);
  });
});

test('a value someone else signs in with, the same value, and a kind they do not have are refused', async () => {
  await on(async () => {
    const p = await personWithPin();
    const taken = await personWithPin();
    const outbox = fakeOutbox.length;

    const inUse = await authed(requestIdentifierChange, p.claims, { phone: taken.local, pin: p.pin });
    assert.deepEqual([inUse.statusCode, inUse.body.error], [409, 'identifier_in_use']);
    const firebaseEmail = `${uniq('fb')}@example.com`;
    await makeUser({ firebaseUid: uniq('fb'), email: firebaseEmail });
    assert.equal((await authed(requestIdentifierChange, p.claims, { email: firebaseEmail, pin: p.pin })).body.error, 'identifier_in_use');

    const same = await authed(requestIdentifierChange, p.claims, { phone: p.local, pin: p.pin });
    assert.deepEqual([same.statusCode, same.body.error], [400, 'identifier_unchanged']);
    assert.equal((await authed(requestIdentifierChange, p.claims, { pin: p.pin })).body.error, 'one_phone_or_email_required');
    assert.equal(fakeOutbox.length, outbox);

    // Only an email so far: a phone is added with the verify flow, not changed.
    const emailOnly = await makeUser({ email: `${uniq('e')}@example.com` });
    await verifyIdentifier(emailOnly.personId, 'email', emailOnly.email);
    await pinAuthService.setPin(emailOnly.personId, '1212');
    const none = await authed(requestIdentifierChange, { sub: emailOnly.id, userType: 'member' }, { phone: localPhone(), pin: '1212' });
    assert.deepEqual([none.statusCode, none.body.error], [409, 'nothing_to_change']);

    // Signed in without a FitFlex PIN (Google): nothing to prove it with.
    const google = await makeUser({ firebaseUid: uniq('fb'), email: `${uniq('g')}@example.com` });
    const noPin = await authed(requestIdentifierChange, { sub: google.id, userType: 'member' }, { email: `${uniq('x')}@example.com`, pin: '1234' });
    assert.deepEqual([noPin.statusCode, noPin.body.error], [409, 'pin_not_set']);
  });
});

test('a number someone else verifies before the code is confirmed is refused, and nothing changes', async () => {
  await on(async () => {
    const p = await personWithPin();
    const newLocal = localPhone();
    const newPhone = e164(newLocal);
    await authed(requestIdentifierChange, p.claims, { phone: newLocal, pin: p.pin });
    const code = codeFor(newPhone);
    const rival = await makeUser();
    await verifyIdentifier(rival.personId, 'phone', newPhone);

    const late = await authed(confirmIdentifierChange, p.claims, { phone: newLocal, code });
    assert.deepEqual([late.statusCode, late.body.error], [409, 'identifier_in_use']);
    assert.deepEqual((await active(p.user.personId, 'phone')).map(r => r.normalizedValue), [p.phone], 'the old number still signs in');
    assert.equal((await post(pinLogin, { phone: p.local, pin: p.pin })).statusCode, 200);
  });
});
