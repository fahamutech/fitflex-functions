// Identity V2 · account recovery, member path: someone who lost every verified
// number and email and forgot the PIN. 24 hours' wait, owner can cancel, a
// FitFlex admin decides, nobody sets a PIN.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  recoveryStart, recoveryConfirm, recoveryEvidence, recoveryStatus, recoveryCancel, recoveryCancelPage,
  recoveryCancelByLink, myRecovery, cancelMyRecovery, adminRecoveries, adminRecovery, adminRecoveryNote, adminDecideRecovery,
} from '../functions/account-recovery.mjs';
import { pinLogin, pinResetStart, pinResetConfirm, pinResetComplete } from '../functions/pin-auth.mjs';
import { myIdentifiers } from '../functions/identifiers.mjs';
import { users, pinAuthService } from '../src/bootstrap/services.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { fakeOutbox } from '../src/infra/verification-senders.mjs';

const uniq = p => `${p}_${randomUUID().slice(0, 8)}`;
const localPhone = () => `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const e164 = local => `+255${local.slice(1)}`;

function res() {
  return {
    statusCode: 200, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    set(k, v) { this.headers[k] = v; return this; },
    send(b) { this.body = b; return this; },
  };
}
// Addresses are counted per day in the database, so each run uses its own.
const runOctet = Math.floor(Math.random() * 200) + 20;
let addressCounter = 0;
const freshAddress = () => `10.${runOctet}.${Math.floor(addressCounter / 250)}.${(addressCounter++ % 250) + 1}`;
async function call(route, { body, claims, params, query, ip } = {}) {
  const req = {
    headers: { ...(claims ? { authorization: `Bearer ${sign(claims)}` } : {}), 'x-forwarded-for': ip || freshAddress() },
    body, params: params || {}, query: query || {},
  };
  const out = res();
  if (route.onGuard) {
    let passed = false;
    for (const g of [].concat(route.onGuard)) {
      passed = false;
      await g(req, out, () => { passed = true; });
      if (!passed) return out;
    }
    req.user = req.user || {};
  }
  await route.onRequest(req, out);
  return out;
}
const admin = { sub: 'adm_rec', userType: 'admin' };
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
    id: uniq('usr_rec'), userType: 'member', accountStatus: 'active', approvalStatus: 'approved',
    createdAt: new Date().toISOString(), displayName: 'Asha Mushi', ...overrides,
  };
  await users.upsertAsync(u => u.id === row.id, row);
  return db('User').where({ id: row.id }).first();
}
const verifyIdentifier = (personId, type, value) => db('LoginIdentifier').insert({
  id: uniq('lid'), personId, type, value, normalizedValue: value, verifiedAt: new Date(), status: 'active',
});
async function member(pin = '4821') {
  const local = localPhone();
  const email = `${uniq('m')}@example.com`;
  const user = await makeUser({ email, phone: e164(local) });
  await verifyIdentifier(user.personId, 'phone', e164(local));
  await verifyIdentifier(user.personId, 'email', email);
  await pinAuthService.setPin(user.personId, pin);
  return { user, local, phone: e164(local), email, pin, claims: { sub: user.id, userType: 'member' } };
}
const codeFor = to => fakeOutbox.filter(m => m.to === to).at(-1)?.text.match(/\b(\d{6})\b/)?.[1];
const lastTo = to => fakeOutbox.filter(m => m.to === to).at(-1);

/** Ask, prove the new number, and record the request. */
async function ask(p, { oldIdentifier, newLocal = localPhone(), name = 'Asha Mushi', ip } = {}) {
  const body = { old: oldIdentifier || { email: p.email }, new: { phone: newLocal } };
  const started = await call(recoveryStart, { body, ip });
  assert.equal(started.statusCode, 200, JSON.stringify(started.body));
  const confirmed = await call(recoveryConfirm, { body: { ...body, code: codeFor(e164(newLocal)), name }, ip });
  assert.equal(confirmed.statusCode, 200, JSON.stringify(confirmed.body));
  return { ...confirmed.body, newLocal, newPhone: e164(newLocal) };
}
const pastWait = id => db('AccountRecovery').where({ id }).update({ waitUntil: new Date(Date.now() - 1000) });
const rowOf = requestToken => {
  const id = JSON.parse(Buffer.from(requestToken.split('.')[1], 'base64url')).rid;
  return db('AccountRecovery').where({ id }).first();
};

test('flag off: no recovery routes', async () => {
  await on(async () => {
    assert.equal((await call(recoveryStart, { body: {} })).statusCode, 404);
    assert.equal((await call(adminRecoveries, { claims: admin })).statusCode, 404);
  }, { V2_RECOVERY: null });
});

test('a member who lost every number and email: ask, prove, wait, admin approves, then Forgot PIN', async () => {
  await on(async () => {
    const p = await member();
    const personasBefore = (await db('User').where({ personId: p.user.personId }).select('id')).map(r => r.id);
    // They are still signed in on a device somewhere (an old session).
    const oldSession = { sub: p.user.id, userType: 'member', iat: Math.floor(Date.now() / 1000) - 5 };

    const asked = await ask(p);
    assert.equal(asked.status, 'open');
    assert.equal(asked.waitHours, 24);
    assert.ok(+new Date(asked.waitUntil) - Date.now() > 23 * 3600e3, 'a day to wait');
    assert.deepEqual(asked.questions.sort(), ['homeGym', 'lastCheckin', 'other', 'paymentRef', 'plan']);

    // The old email and number are both told, with a way to cancel; the new one is not sent the cancel link.
    for (const to of [p.email, p.phone]) {
      assert.match(lastTo(to).text, /someone asked to recover your account/);
      assert.match(lastTo(to).text, /\/auth\/recovery\/cancel\/arc_/);
    }
    assert.doesNotMatch(lastTo(asked.newPhone).text, /recover/, 'the new number only got its code');

    // Staff cannot approve yet, nor without answers.
    const queue = await call(adminRecoveries, { claims: admin });
    assert.equal(queue.statusCode, 200);
    const item = queue.body.recoveries.find(r => r.newIdentifierType === 'phone' && r.claimedName === 'Asha Mushi' && r.status === 'open');
    assert.ok(item);
    const id = (await rowOf(asked.requestToken)).id;
    const early = await call(adminDecideRecovery, { claims: admin, params: { id }, body: { decision: 'approve' } });
    assert.deepEqual([early.statusCode, early.body.error], [409, 'waiting_period_not_over']);
    await pastWait(id);
    const noAnswers = await call(adminDecideRecovery, { claims: admin, params: { id }, body: { decision: 'approve' } });
    assert.equal(noAnswers.body.error, 'evidence_missing');

    // Answers; the status shows what has been answered.
    assert.equal((await call(recoveryEvidence, { body: { requestToken: asked.requestToken, answers: {} } })).body.error, 'evidence_required');
    const ev = await call(recoveryEvidence, { body: { requestToken: asked.requestToken, answers: { homeGym: 'Fit Zone', plan: 'Standard', junk: 'x' } } });
    assert.deepEqual(ev.body.answered, ['homeGym', 'plan']);
    assert.equal((await call(recoveryStatus, { body: { requestToken: asked.requestToken } })).body.ready, true);

    // The admin sees the answers beside facts about the account, with masked contacts.
    await call(adminRecoveryNote, { claims: admin, params: { id }, body: { note: 'Gym desk confirmed by phone.' } });
    const detail = await call(adminRecovery, { claims: admin, params: { id } });
    assert.equal(detail.body.recovery.evidence.homeGym, 'Fit Zone');
    assert.equal(detail.body.recovery.newIdentifier.value, asked.newPhone);
    assert.match(detail.body.recovery.oldIdentifier.masked, /^\w\*\*\*@example\.com$/);
    assert.ok(detail.body.account.identifiers.every(i => !i.masked.includes(p.email) && !i.masked.includes(p.phone)));
    assert.ok(detail.body.events.some(e => e.kind === 'note'));

    // Approve: handed over.
    const done = await call(adminDecideRecovery, { claims: admin, params: { id }, body: { decision: 'approve', note: 'Matches.' } });
    assert.deepEqual([done.statusCode, done.body.status], [200, 'completed']);
    assert.equal((await db('LoginIdentifier').where({ personId: p.user.personId, normalizedValue: p.email }).first()).status, 'revoked');
    assert.equal((await db('LoginIdentifier').where({ personId: p.user.personId, normalizedValue: p.phone }).first()).status, 'revoked');
    const fresh = await db('LoginIdentifier').where({ personId: p.user.personId, normalizedValue: asked.newPhone, status: 'active' }).first();
    assert.ok(fresh?.verifiedAt, 'the new number is the verified sign-in');
    assert.match(lastTo(p.email).text, /account was recovered/);
    const person = await db('Person').where({ id: p.user.personId }).first();
    assert.equal(person.pinHash, null, 'the old PIN is removed; nobody at FitFlex sets one');
    // Same person, same profiles: nothing recreated.
    assert.deepEqual((await db('User').where({ personId: p.user.personId }).select('id')).map(r => r.id), personasBefore);
    assert.equal((await db('User').where({ id: p.user.id }).first()).phone, asked.newPhone);
    // Every session is over; the old identifiers no longer sign in.
    const ended = await call(myRecovery, { claims: oldSession });
    assert.equal(ended.statusCode, 401);
    assert.equal((await call(pinLogin, { body: { email: p.email, pin: p.pin } })).statusCode, 401);
    assert.equal((await call(pinLogin, { body: { phone: asked.newLocal, pin: p.pin } })).statusCode, 401, 'no PIN yet');

    // The requester sees it is done and goes to Forgot PIN with the new number.
    const finished = await call(recoveryStatus, { body: { requestToken: asked.requestToken } });
    assert.deepEqual([finished.body.status, finished.body.next, finished.body.identifierValue], ['completed', 'forgot_pin', asked.newPhone]);
    // In real life a day has passed since the code that proved this number.
    await db('VerificationCode').where({ identifierValue: asked.newPhone }).update({ createdAt: new Date(Date.now() - 86400e3) });
    assert.equal((await call(pinResetStart, { body: { phone: asked.newLocal } })).statusCode, 200);
    const confirmed = await call(pinResetConfirm, { body: { phone: asked.newLocal, code: codeFor(asked.newPhone) } });
    assert.equal(confirmed.statusCode, 200, JSON.stringify(confirmed.body));
    const reset = await call(pinResetComplete, { body: { resetToken: confirmed.body.resetToken, pin: '7319' } });
    assert.equal(reset.statusCode, 200, JSON.stringify(reset.body));
    assert.equal((await call(pinLogin, { body: { phone: asked.newLocal, pin: '7319' } })).statusCode, 200);

    // A decided request cannot be decided again.
    assert.equal((await call(adminDecideRecovery, { claims: admin, params: { id }, body: { decision: 'approve' } })).body.error, 'recovery_not_open');
  });
});

test('the owner cancels from the link (opening it does not cancel) and a new request is blocked for 7 days', async () => {
  await on(async () => {
    const p = await member();
    const asked = await ask(p);
    const link = lastTo(p.email).text.match(/\/auth\/recovery\/cancel\/(arc_[^\s]+)/)[1];
    const page = await call(recoveryCancelPage, { params: { link } });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /<form method="post">/);
    assert.equal((await rowOf(asked.requestToken)).status, 'open', 'a link preview does not cancel');

    assert.equal((await call(recoveryCancelByLink, { params: { link: `${link}x` } })).statusCode, 404);
    const cancelled = await call(recoveryCancelByLink, { params: { link } });
    assert.equal(cancelled.statusCode, 200);
    assert.match(cancelled.body, /Request cancelled/);
    const row = await rowOf(asked.requestToken);
    assert.deepEqual([row.status, row.cancelledBy], ['cancelled', 'owner_link']);
    assert.equal((await call(recoveryStatus, { body: { requestToken: asked.requestToken } })).body.status, 'cancelled');
    // Nothing moved.
    assert.equal((await db('LoginIdentifier').where({ personId: p.user.personId, normalizedValue: p.email }).first()).status, 'active');
    // Cancelling twice is harmless; a decision after is refused.
    assert.match((await call(recoveryCancelByLink, { params: { link } })).body, /already finished/);
    assert.equal((await call(adminDecideRecovery, { claims: admin, params: { id: row.id }, body: { decision: 'approve' } })).body.error, 'recovery_not_open');

    const again = await call(recoveryStart, { body: { old: { email: p.email }, new: { phone: localPhone() } } });
    assert.deepEqual([again.statusCode, again.body.error], [429, 'recovery_blocked']);
    assert.ok(again.body.retryAfterSeconds > 6 * 86400);
  });
});

test('a device that is still signed in sees the request and can cancel it; the requester can also withdraw', async () => {
  await on(async () => {
    const p = await member();
    assert.deepEqual((await call(myRecovery, { claims: p.claims })).body, { open: false });
    const asked = await ask(p);
    const banner = await call(myRecovery, { claims: p.claims });
    assert.equal(banner.body.open, true);
    assert.equal(banner.body.newIdentifierType, 'phone');
    assert.match(banner.body.newIdentifier, /^\+255•+\d{3}$/, 'the new number is masked');
    assert.equal((await call(recoveryStart, { body: { old: { email: p.email }, new: { phone: localPhone() } } })).body.error, 'recovery_already_open');
    const done = await call(cancelMyRecovery, { claims: p.claims });
    assert.deepEqual(done.body, { cancelled: true, status: 'cancelled' });
    assert.equal((await rowOf(asked.requestToken)).cancelledBy, 'owner_device');

    const q = await member();
    const own = await ask(q);
    assert.equal((await call(recoveryCancel, { body: { requestToken: own.requestToken } })).body.cancelled, true);
    assert.equal((await rowOf(own.requestToken)).cancelledBy, 'requester');
  });
});

test('refusing needs a reason; the requester sees it in general terms and can retry after 7 days', async () => {
  await on(async () => {
    const p = await member();
    const asked = await ask(p);
    const id = (await rowOf(asked.requestToken)).id;
    assert.equal((await call(adminDecideRecovery, { claims: admin, params: { id }, body: { decision: 'refuse' } })).body.error, 'reason_required');
    assert.equal((await call(adminDecideRecovery, { claims: admin, params: { id }, body: { decision: 'maybe' } })).body.error, 'decision_invalid');
    const refused = await call(adminDecideRecovery, { claims: admin, params: { id }, body: { decision: 'refuse', reason: 'evidence_insufficient', note: 'private note' } });
    assert.equal(refused.body.status, 'refused');
    const seen = await call(recoveryStatus, { body: { requestToken: asked.requestToken } });
    assert.equal(seen.body.status, 'refused');
    assert.equal(seen.body.reason, 'evidence_insufficient');
    assert.ok(!JSON.stringify(seen.body).includes('private note'), 'staff notes stay private');
    assert.equal((await call(recoveryStart, { body: { old: { email: p.email }, new: { phone: localPhone() } } })).body.error, 'recovery_blocked');
    // After the block, a new request is possible.
    await db('AccountRecovery').where({ id }).update({ updatedAt: new Date(Date.now() - 8 * 86400e3) });
    assert.equal((await call(recoveryStart, { body: { old: { email: p.email }, new: { phone: localPhone() } } })).statusCode, 200);
    // Nothing moved on refusal.
    assert.equal((await db('LoginIdentifier').where({ personId: p.user.personId, normalizedValue: p.email }).first()).status, 'active');
  });
});

test('not offered to staff, verified partners or admins; checks on the request itself', async () => {
  await on(async () => {
    // Staff only: the owner re-invites.
    const staffEmail = `${uniq('s')}@example.com`;
    const staff = await makeUser({ userType: 'gym_staff', email: staffEmail });
    await verifyIdentifier(staff.personId, 'email', staffEmail);
    assert.equal((await call(recoveryStart, { body: { old: { email: staffEmail }, new: { phone: localPhone() } } })).body.error, 'staff_recovery_not_available');

    // A verified (KYC-approved) trainer: their path is not built; they go to support.
    const trainerEmail = `${uniq('t')}@example.com`;
    const trainer = await makeUser({ userType: 'trainer', email: trainerEmail });
    await verifyIdentifier(trainer.personId, 'email', trainerEmail);
    assert.equal((await call(recoveryStart, { body: { old: { email: trainerEmail }, new: { phone: localPhone() } } })).statusCode, 200, 'a trainer not verified yet is asked for member-level proof');
    await db('PartnerKycCase').insert({ id: uniq('kyc'), partnerType: 'trainer', userId: trainer.id, status: 'approved', tier: 2, updatedAt: new Date() });
    const verified = await call(recoveryStart, { body: { old: { email: trainerEmail }, new: { phone: localPhone() } } });
    assert.deepEqual([verified.statusCode, verified.body.error], [409, 'partner_recovery_not_available']);

    // An admin account.
    const adminEmail = `${uniq('a')}@example.com`;
    const adm = await makeUser({ userType: 'admin', email: adminEmail });
    await verifyIdentifier(adm.personId, 'email', adminEmail);
    assert.equal((await call(recoveryStart, { body: { old: { email: adminEmail }, new: { phone: localPhone() } } })).body.error, 'recovery_not_available');

    const p = await member();
    const other = await member();
    assert.equal((await call(recoveryStart, { body: { old: { email: `${uniq('nobody')}@example.com` }, new: { phone: localPhone() } } })).body.error, 'account_not_found');
    assert.equal((await call(recoveryStart, { body: { old: { email: p.email }, new: { phone: other.local } } })).body.error, 'identifier_in_use');
    assert.equal((await call(recoveryStart, { body: { old: { email: p.email }, new: { email: p.email } } })).body.error, 'identifier_unchanged');
    assert.equal((await call(recoveryStart, { body: { old: { email: p.email } } })).body.error, 'old_and_new_identifier_required');

    // A wrong code, and a missing name, record nothing.
    const newLocal = localPhone();
    await call(recoveryStart, { body: { old: { email: p.email }, new: { phone: newLocal } } });
    const bad = await call(recoveryConfirm, { body: { old: { email: p.email }, new: { phone: newLocal }, code: '000000', name: 'Asha' } });
    assert.equal(bad.body.error, 'code_incorrect');
    const noName = await call(recoveryConfirm, { body: { old: { email: p.email }, new: { phone: newLocal }, code: codeFor(e164(newLocal)) } });
    assert.equal(noName.body.error, 'name_required');
    assert.equal((await db('AccountRecovery').where({ personId: p.user.personId })).length, 0);
  });
});

test('limits: three requests per address per day; admin permission needed; staff cannot decide their own', async () => {
  await on(async () => {
    const p = await member();
    const ip = freshAddress();
    for (let i = 0; i < 3; i += 1) {
      const r = await call(recoveryStart, { body: { old: { email: p.email }, new: { phone: localPhone() } }, ip });
      assert.equal(r.statusCode, 200);
    }
    const fourth = await call(recoveryStart, { body: { old: { email: p.email }, new: { phone: localPhone() } }, ip });
    assert.deepEqual([fourth.statusCode, fourth.body.error], [429, 'too_many_attempts']);

    // Portal staff need the account_recovery permission.
    const without = await call(adminRecoveries, { claims: { sub: 'adm_x', userType: 'admin', portalUser: true, aclPermissions: ['approvals'] } });
    assert.deepEqual([without.statusCode, without.body.requiredScope], [403, 'account_recovery']);
    const withScope = await call(adminRecoveries, { claims: { sub: 'adm_y', userType: 'admin', portalUser: true, aclPermissions: ['account_recovery'] } });
    assert.equal(withScope.statusCode, 200);

    // An admin who is the account itself cannot decide it.
    const q = await member();
    const asked = await ask(q);
    const id = (await rowOf(asked.requestToken)).id;
    await pastWait(id);
    const own = await call(adminDecideRecovery, { claims: { sub: q.user.id, userType: 'admin' }, params: { id }, body: { decision: 'refuse', reason: 'other' } });
    assert.equal(own.body.error, 'cannot_decide_own_recovery');
  });
});

test('the reminder: with only one kind verified the list suggests the other', async () => {
  await on(async () => {
    const local = localPhone();
    const onlyPhone = await makeUser({ phone: e164(local) });
    await verifyIdentifier(onlyPhone.personId, 'phone', e164(local));
    const one = await call(myIdentifiers, { claims: { sub: onlyPhone.id, userType: 'member' } });
    assert.deepEqual(one.body.secondContact, { missing: 'email' });

    const onlyEmail = await makeUser({ email: `${uniq('e')}@example.com` });
    await verifyIdentifier(onlyEmail.personId, 'email', onlyEmail.email);
    assert.deepEqual((await call(myIdentifiers, { claims: { sub: onlyEmail.id, userType: 'member' } })).body.secondContact, { missing: 'phone' });

    const both = await member();
    assert.equal((await call(myIdentifiers, { claims: both.claims })).body.secondContact, null);
  });
});
