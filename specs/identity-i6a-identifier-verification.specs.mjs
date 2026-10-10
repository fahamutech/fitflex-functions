// Identity V2 · I6a — proving a phone or email with a code FitFlex sends.
// The code goes by SMS to a phone and by email to an email; only its keyed
// hash is stored; it expires, dies after wrong tries, and requests are limited.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { myIdentifiers, requestIdentifierCode, confirmIdentifierCode } from '../functions/identifiers.mjs';
import { gymCreateInvitation, myInvitations, acceptMyInvitation } from '../functions/invitations.mjs';
import { users } from '../src/bootstrap/services.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { fakeOutbox, smsSender, emailSender } from '../src/infra/verification-senders.mjs';

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
  const names = ['IDENTITY_V2', 'V2_IDENTIFIERS', 'V2_INVITES', 'V2_LINKING', 'VERIFICATION_SMS_PROVIDER', 'VERIFICATION_EMAIL_PROVIDER', 'NODE_ENV', ...Object.keys(env)];
  const saved = Object.fromEntries(names.map(n => [n, process.env[n]]));
  Object.assign(process.env, env);
  for (const [k, v] of Object.entries(env)) if (v === null) delete process.env[k];
  try { return await fn(); } finally {
    for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
  }
}
const ON = { IDENTITY_V2: 'true', V2_IDENTIFIERS: 'true', V2_INVITES: 'true', V2_LINKING: null, VERIFICATION_SMS_PROVIDER: 'fake', VERIFICATION_EMAIL_PROVIDER: 'fake' };
const on = (fn, extra = {}) => withEnv({ ...ON, ...extra }, fn);

async function makeUser(overrides = {}) {
  const row = {
    id: uniq('usr_i6a'), userType: 'member', accountStatus: 'active', approvalStatus: 'approved',
    createdAt: new Date().toISOString(), ...overrides,
  };
  await users.upsertAsync(u => u.id === row.id, row);
  return db('User').where({ id: row.id }).first();
}
async function person(overrides = {}) {
  const user = await makeUser({ firebaseUid: uniq('fb'), email: `${uniq('p')}@example.com`, displayName: 'Neema Abdallah', ...overrides });
  return { user, claims: { sub: user.id, userType: user.userType } };
}
const request = (p, body) => call(requestIdentifierCode, p.claims, { body });
const confirm = (p, body) => call(confirmIdentifierCode, p.claims, { body });
/** The code in the last message "sent" to this address. */
const codeFor = to => fakeOutbox.filter(m => m.to === to).at(-1)?.text.match(/\b(\d{6})\b/)?.[1];
const wrongCode = code => String((Number(code) + 1) % 1000000).padStart(6, '0');
const identifiersOf = personId => db('LoginIdentifier').where({ personId, status: 'active' }).whereIn('type', ['email', 'phone']);
/** Let the next request through the resend wait. */
const skipResendWait = value => db('VerificationCode').where({ identifierValue: value }).update({ createdAt: new Date(Date.now() - 120e3) });

test('flag off: the identifier routes do not exist', async () => {
  await withEnv({ IDENTITY_V2: null, V2_IDENTIFIERS: null }, async () => {
    const p = await person();
    assert.equal((await call(myIdentifiers, p.claims)).statusCode, 404);
    assert.equal((await request(p, { phone: localPhone() })).statusCode, 404);
    assert.equal((await confirm(p, { phone: localPhone(), code: '123456' })).statusCode, 404);
  });
});

test('no provider configured: nothing is sent and nothing is recorded', async () => {
  await on(async () => {
    const p = await person();
    const sms = await request(p, { phone: localPhone() });
    assert.equal(sms.statusCode, 503);
    assert.equal(sms.body.error, 'sms_not_configured');
    const email = await request(p, { email: p.user.email });
    assert.equal(email.body.error, 'email_not_configured');
    assert.equal(await db('VerificationCode').where({ personId: p.user.personId }).first(), undefined);
  }, { VERIFICATION_SMS_PROVIDER: null, VERIFICATION_EMAIL_PROVIDER: null });
  // The fake providers can never be selected in production.
  await withEnv({ NODE_ENV: 'production', VERIFICATION_SMS_PROVIDER: 'fake' }, async () => {
    assert.equal(smsSender().configured, false);
  });
});

test('a phone is proved by an SMS code and recorded on the Person in E.164', async () => {
  await on(async () => {
    const local = localPhone();
    const p = await person({ phone: local });
    const before = await call(myIdentifiers, p.claims);
    assert.deepEqual(before.body.identifiers, []);
    assert.deepEqual(before.body.unverified.find(u => u.type === 'phone'), { type: 'phone', value: e164(local) });

    const sent = await request(p, { phone: local, locale: 'sw' });
    assert.equal(sent.statusCode, 200, JSON.stringify(sent.body));
    assert.deepEqual({ ...sent.body }, { sent: true, channel: 'sms', identifierType: 'phone', identifierValue: e164(local), expiresInSeconds: 600, resendAfterSeconds: 60 });
    const message = fakeOutbox.filter(m => m.to === e164(local)).at(-1);
    assert.equal(message.channel, 'sms');
    assert.match(message.text, /msimbo wako wa uthibitisho/);
    const code = codeFor(e164(local));
    assert.match(code, /^\d{6}$/);

    const row = await db('VerificationCode').where({ personId: p.user.personId }).first();
    assert.equal(JSON.stringify(row).includes(code), false, 'the code itself is never stored');
    assert.equal(JSON.stringify(sent.body).includes(code), false, 'and never returned');

    const done = await confirm(p, { phone: `0${local.slice(1)}`, code });
    assert.equal(done.statusCode, 200, JSON.stringify(done.body));
    assert.equal(done.body.verified, true);
    assert.deepEqual(done.body.identifiers.map(i => [i.type, i.value, i.verified]), [['phone', e164(local), true]]);

    const phone = (await identifiersOf(p.user.personId)).find(r => r.type === 'phone');
    assert.ok(phone.verifiedAt);
    assert.equal(phone.provider, 'fitflex_sms');
    assert.equal((await identifiersOf(p.user.personId)).some(r => r.type === 'email' && r.verifiedAt), false, 'the email is not proved by this');

    // A used code is spent; asking again says it is already verified and sends nothing.
    assert.equal((await confirm(p, { phone: local, code })).body.error, 'code_not_found_or_expired');
    const outbox = fakeOutbox.length;
    assert.equal((await request(p, { phone: local })).body.alreadyVerified, true);
    assert.equal(fakeOutbox.length, outbox);
  });
});

test('an email is proved by a code sent to that email', async () => {
  await on(async () => {
    const p = await person();
    const sent = await request(p, { email: p.user.email.toUpperCase() });
    assert.equal(sent.body.channel, 'email');
    const message = fakeOutbox.filter(m => m.to === p.user.email).at(-1);
    assert.equal(message.subject, 'Your FitFlex verification code');
    const done = await confirm(p, { email: p.user.email, code: codeFor(p.user.email) });
    assert.equal(done.statusCode, 200);
    const email = (await identifiersOf(p.user.personId)).find(r => r.type === 'email');
    assert.ok(email.verifiedAt);
    assert.equal(email.provider, 'fitflex_email');
  });
});

test('wrong codes are counted, and the code dies after too many', async () => {
  await on(async () => {
    const phone = e164(localPhone());
    const p = await person();
    await request(p, { phone });
    const code = codeFor(phone);

    const first = await confirm(p, { phone, code: wrongCode(code) });
    assert.equal(first.statusCode, 400);
    assert.equal(first.body.error, 'code_incorrect');
    assert.equal(first.body.attemptsLeft, 2);
    assert.equal((await confirm(p, { phone, code: wrongCode(code) })).body.attemptsLeft, 1);
    const dead = await confirm(p, { phone, code: wrongCode(code) });
    assert.equal(dead.statusCode, 429);
    assert.equal(dead.body.error, 'code_attempts_exceeded');
    assert.equal((await confirm(p, { phone, code })).statusCode, 429, 'even the right code no longer works');
    assert.deepEqual(await identifiersOf(p.user.personId), []);

    // Another person cannot confirm a code that was sent for someone else's request.
    const other = await person();
    assert.equal((await confirm(other, { phone, code })).body.error, 'code_not_found_or_expired');
    assert.equal((await confirm(p, { phone })).body.error, 'code_required');
    assert.equal((await confirm(p, { code })).body.error, 'one_phone_or_email_required');
  }, { VERIFY_CODE_MAX_ATTEMPTS: '3' });
});

test('codes expire, and a new code replaces the old one', async () => {
  await on(async () => {
    const phone = e164(localPhone());
    const p = await person();
    await request(p, { phone });
    const old = codeFor(phone);

    const soon = await request(p, { phone });
    assert.equal(soon.statusCode, 429);
    assert.equal(soon.body.error, 'code_resend_too_soon');
    assert.ok(soon.body.retryAfterSeconds > 0);

    await skipResendWait(phone);
    assert.equal((await request(p, { phone })).statusCode, 200);
    const fresh = codeFor(phone);
    if (old !== fresh) assert.equal((await confirm(p, { phone, code: old })).body.error, 'code_incorrect', 'the old code stops working');

    await db('VerificationCode').where({ identifierValue: phone }).update({ expiresAt: new Date(Date.now() - 1000) });
    assert.equal((await confirm(p, { phone, code: fresh })).body.error, 'code_not_found_or_expired');
    assert.deepEqual(await identifiersOf(p.user.personId), []);
  });
});

test('requests are limited per identifier and per person', async () => {
  await on(async () => {
    const phone = e164(localPhone());
    const p = await person();
    for (let i = 0; i < 2; i += 1) {
      assert.equal((await request(p, { phone })).statusCode, 200);
      await skipResendWait(phone);
    }
    const limited = await request(p, { phone });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.body.error, 'code_rate_limited');
  }, { VERIFY_CODE_PER_IDENTIFIER_PER_HOUR: '2' });
  await on(async () => {
    const p = await person();
    for (let i = 0; i < 2; i += 1) assert.equal((await request(p, { phone: localPhone() })).statusCode, 200);
    const outbox = fakeOutbox.length;
    const limited = await request(p, { phone: localPhone() });
    assert.equal(limited.body.error, 'code_rate_limited');
    assert.equal(fakeOutbox.length, outbox, 'nothing is sent once limited');
  }, { VERIFY_CODE_PER_PERSON_PER_DAY: '2' });
});

test('a phone another person has verified is refused, never moved, and no SMS is sent', async () => {
  await on(async () => {
    const phone = e164(localPhone());
    const first = await person();
    const second = await person();
    await request(first, { phone });
    assert.equal((await confirm(first, { phone, code: codeFor(phone) })).statusCode, 200);

    const outbox = fakeOutbox.length;
    const refused = await request(second, { phone });
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.body.error, 'identifier_in_use');
    assert.equal(fakeOutbox.length, outbox);
    assert.equal((await db('VerificationCode').where({ personId: second.user.personId }).first()).outcome, 'refused', 'counted against the limits');
    assert.equal((await identifiersOf(second.user.personId)).some(r => r.type === 'phone'), false);
  });
});

test('two people racing for one phone: the second confirmation is refused and left for review', async () => {
  await on(async () => {
    const phone = e164(localPhone());
    const first = await person();
    const second = await person();
    await request(first, { phone });
    const firstCode = codeFor(phone);
    await skipResendWait(phone);
    await request(second, { phone });
    const secondCode = codeFor(phone);

    assert.equal((await confirm(first, { phone, code: firstCode })).statusCode, 200);
    const late = await confirm(second, { phone, code: secondCode });
    assert.equal(late.statusCode, 409);
    assert.equal(late.body.error, 'identifier_in_use');
    assert.equal((await identifiersOf(first.user.personId)).filter(r => r.type === 'phone').length, 1);
    assert.equal((await identifiersOf(second.user.personId)).some(r => r.type === 'phone'), false);
    assert.ok(await db('IdentityConflict').where({ kind: 'verified_identifier_collision', normalizedValue: phone, status: 'open' }).first());
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

    await request(p, { phone: local });
    assert.equal((await confirm(p, { phone: local, code: codeFor(e164(local)) })).statusCode, 200);
    const inv = await db('Invitation').where({ id: sent.body.invitation.id }).first();
    assert.equal(inv.status, 'claimed');
    assert.equal(inv.targetPersonId, p.user.personId);
    const accepted = await call(acceptMyInvitation, p.claims, { params: { invitationId: inv.id } });
    assert.equal(accepted.statusCode, 200);
    assert.equal((await db('User').where({ id: accepted.body.personaId }).first()).userType, 'gym_staff');
  });
});

test('a person with no Firebase account can verify, and their own rows are not a conflict', async () => {
  await on(async () => {
    const p = await person({ firebaseUid: null });
    await request(p, { email: p.user.email });
    const done = await confirm(p, { email: p.user.email, code: codeFor(p.user.email) });
    assert.equal(done.statusCode, 200);
    assert.equal(await db('IdentityConflict').where({ normalizedValue: p.user.email }).first(), undefined);

    const q = await person();
    await request(q, { email: q.user.email });
    assert.equal((await confirm(q, { email: q.user.email, code: codeFor(q.user.email) })).statusCode, 200);
    assert.equal(await db('IdentityConflict').where({ normalizedValue: q.user.email }).first(), undefined);
  }, { V2_LINKING: 'true' });
});

test('other profiles are linked by the proved phone only when linking is on', async () => {
  const run = async () => {
    const local = localPhone();
    // A profile a gym created at the desk: a phone, no Firebase account.
    const deskRow = await makeUser({ userType: 'trainer', phone: local, displayName: 'Desk Created' });
    // Someone else's profile with its own Firebase account and the same phone typed in.
    const stranger = await makeUser({ userType: 'vendor', phone: local, firebaseUid: uniq('fb') });
    const p = await person();
    await request(p, { phone: local });
    assert.equal((await confirm(p, { phone: local, code: codeFor(e164(local)) })).statusCode, 200);
    const personOf = async id => (await db('User').where({ id }).first()).personId;
    return { p, desk: await personOf(deskRow.id), stranger: await personOf(stranger.id) };
  };
  await on(async () => {
    const { p, desk } = await run();
    assert.notEqual(desk, p.user.personId, 'V2_LINKING off: nothing moves');
  });
  await on(async () => {
    const { p, desk, stranger } = await run();
    assert.equal(desk, p.user.personId, 'D1: linked on verified evidence');
    assert.notEqual(stranger, p.user.personId, 'a row with its own Firebase account is never moved');
    const event = await db('IdentityEvent').where({ personId: p.user.personId, kind: 'link' }).first();
    assert.equal(event.trigger, 'identifier_verify');
  }, { V2_LINKING: 'true' });
});

// ── Providers (decision of 2 Oct 2026: Beem for SMS, Mailgun for email) ────

/** Run with fetch replaced; returns the requests that were made. */
async function withFetch(reply, fn) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), ...init }); return reply(calls.length); };
  try { await fn(calls); } finally { globalThis.fetch = original; }
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('Beem SMS: needs its credentials and a sender name, and sends the number without "+"', async () => {
  const env = { VERIFICATION_SMS_PROVIDER: 'beem', BEEM_API_KEY: 'key', BEEM_SECRET_KEY: 'secret', VERIFICATION_SMS_SENDER_ID: 'FITFLEX', BEEM_SMS_API_URL: null, NODE_ENV: 'production' };
  await withEnv({ ...env, VERIFICATION_SMS_SENDER_ID: null }, async () => assert.equal(smsSender().configured, false));
  await withEnv({ ...env, BEEM_SECRET_KEY: null }, async () => assert.equal(smsSender().configured, false));
  await withEnv(env, async () => {
    await withFetch(() => json(200, { successful: true, request_id: 1, code: 100, valid: 1, invalid: 0 }), async calls => {
      assert.deepEqual(await smsSender().send('+255712345678', { text: 'code 123456' }), { ok: true });
      assert.equal(calls[0].url, 'https://apisms.beem.africa/v1/send');
      assert.equal(calls[0].headers.Authorization, `Basic ${Buffer.from('key:secret').toString('base64')}`);
      const body = JSON.parse(calls[0].body);
      assert.equal(body.source_addr, 'FITFLEX');
      assert.equal(body.message, 'code 123456');
      assert.deepEqual(body.recipients, [{ recipient_id: 1, dest_addr: '255712345678' }]);
    });
    await withFetch(() => json(200, { successful: true, valid: 0, invalid: 1 }), async () => {
      assert.equal((await smsSender().send('+255712345678', { text: 'x' })).ok, false, 'a number Beem calls invalid is not a send');
    });
    await withFetch(() => json(401, { code: 120, message: 'Invalid Authentication Parameters' }), async () => {
      assert.deepEqual(await smsSender().send('+255712345678', { text: 'x' }), { ok: false, error: 'provider_rejected' });
    });
    await withFetch(() => { throw new Error('network down'); }, async () => {
      assert.deepEqual(await smsSender().send('+255712345678', { text: 'x' }), { ok: false, error: 'provider_unreachable' });
    });
  });
});

test('Mailgun email: needs a key and a domain, and sends subject and text', async () => {
  const env = { VERIFICATION_EMAIL_PROVIDER: 'mailgun', MAILGUN_API_KEY: 'key', MAILGUN_DOMAIN: 'mg.example.com', MAILGUN_API_URL: null, VERIFICATION_EMAIL_FROM: null, NODE_ENV: 'production' };
  await withEnv({ ...env, MAILGUN_DOMAIN: null }, async () => assert.equal(emailSender().configured, false));
  await withEnv(env, async () => {
    await withFetch(() => json(200, { id: '<1@mg>', message: 'Queued. Thank you.' }), async calls => {
      assert.deepEqual(await emailSender().send('person@example.com', { subject: 'Your FitFlex verification code', text: 'code 123456' }), { ok: true });
      assert.equal(calls[0].url, 'https://api.mailgun.net/v3/mg.example.com/messages');
      assert.equal(calls[0].headers.Authorization, `Basic ${Buffer.from('api:key').toString('base64')}`);
      const form = new URLSearchParams(calls[0].body);
      assert.equal(form.get('from'), 'FitFlex <no-reply@mg.example.com>');
      assert.equal(form.get('to'), 'person@example.com');
      assert.equal(form.get('subject'), 'Your FitFlex verification code');
      assert.equal(form.get('text'), 'code 123456');
    });
    await withFetch(() => json(401, {}), async () => {
      assert.deepEqual(await emailSender().send('person@example.com', { subject: 's', text: 't' }), { ok: false, error: 'provider_rejected' });
    });
  });
  await withEnv({ ...env, MAILGUN_API_URL: 'https://api.eu.mailgun.net/' }, async () => {
    await withFetch(() => json(200, {}), async calls => {
      await emailSender().send('person@example.com', { subject: 's', text: 't' });
      assert.equal(calls[0].url, 'https://api.eu.mailgun.net/v3/mg.example.com/messages');
    });
  });
});

test('a provider failure sends no code and tells the person to try again', async () => {
  await on(async () => {
    const p = await person();
    const phone = e164(localPhone());
    await withFetch(() => json(500, {}), async () => {
      const out = await request(p, { phone });
      assert.equal(out.statusCode, 502);
      assert.equal(out.body.error, 'code_not_sent');
    });
    const row = await db('VerificationCode').where({ personId: p.user.personId }).first();
    assert.equal(row.outcome, 'send_failed');
    assert.equal(row.codeHash, null);
  }, { VERIFICATION_SMS_PROVIDER: 'beem', BEEM_API_KEY: 'key', BEEM_SECRET_KEY: 'secret', VERIFICATION_SMS_SENDER_ID: 'FITFLEX' });
});
