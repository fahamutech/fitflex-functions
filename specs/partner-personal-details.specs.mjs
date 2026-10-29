// Partner date of birth · slice 2 against the CI database (docs/partner-dob-api.md): the Person
// columns, GET/PUT /me/personal-details, the optional fields on /trainer/register and
// /gym-owner/register, the flag, identity merge carry-over, account deletion, public payloads and
// the admin view-only read.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { ensureInit } from '../functions/index.mjs';
import {
  getMyPersonalDetails, putMyPersonalDetails, adminTrainerPersonalDetails, adminGymOwnerPersonalDetails,
  resetPersonalDetailsLimits, PERSONAL_DETAILS_WRITES_PER_MINUTE,
} from '../functions/personal-details.mjs';
import { trainerRegister, listTrainers, getTrainer, adminListTrainers, trainerMyProfile, adminDeleteTrainer } from '../functions/trainers.mjs';
import { gymOwnerRegister } from '../functions/owner-gyms.mjs';
import { adminListGymOwners, adminDeleteGymOwner } from '../functions/admin-owners.mjs';
import { me, updateMemberProfile } from '../functions/subscriptions.mjs';
import { getGym } from '../functions/gyms.mjs';
import { identityLinkService, accountService, authService } from '../src/bootstrap/services.mjs';
import { resetPersonDetailsColumnsCache } from '../src/infra/person-details-store-pg.mjs';
import { eatToday } from '../src/shared/date-of-birth.mjs';

await ensureInit();

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], persons: [], gyms: [], trainers: [], linked: [] };

function res() {
  return {
    statusCode: 200, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    set(k, v) { this.headers[k] = v; return this; },
  };
}
async function call(route, claims, { body = {}, params = {}, query = {} } = {}) {
  const req = { headers: claims ? { authorization: `Bearer ${sign(claims)}` } : {}, params, query, body, get: () => null };
  const out = res();
  for (const guard of [route.onGuard].flat().filter(Boolean)) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return out;
}
async function user(userType, extra = {}) {
  const id = uid('usr');
  await db('User').insert({
    id, userType, displayName: `Dob ${userType}`, accountStatus: 'active', approvalStatus: 'approved',
    createdAt: new Date(), updatedAt: new Date(), ...extra,
  });
  made.users.push(id);
  const row = await db('User').where({ id }).first('personId');
  if (row.personId && !extra.personId) made.persons.push(row.personId);
  return id;
}
async function person() {
  const id = uid('per');
  await db('Person').insert({ id, updatedAt: new Date() });
  made.persons.push(id);
  return id;
}
const personOf = async userId => (await db('User').where({ id: userId }).first('personId')).personId;
const stored = async personId => db('Person').where({ id: personId })
  .first(db.raw(`to_char("dateOfBirth", 'YYYY-MM-DD') AS "dateOfBirth"`), 'gender', 'declaredProfileUpdatedAt');
const as = (sub, userType, extra = {}) => ({ sub, userType, ...extra });

// "YYYY-MM-DD" n years before today (East Africa day), shifted by `days`.
function yearsAgo(n, days = 0) {
  const [y, m, d] = eatToday().split('-').map(Number);
  const dt = new Date(Date.UTC(y - n, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) dt.setUTCDate(0); // 29 Feb in a non-leap year → 28 Feb
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
function tomorrow() {
  const [y, m, d] = eatToday().split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

const on = () => { process.env.PARTNER_DOB_REQUIRED = '1'; };
const off = () => { delete process.env.PARTNER_DOB_REQUIRED; };
beforeEach(() => { on(); resetPersonalDetailsLimits(); });

after(async () => {
  off();
  const keys = [...made.users, ...made.persons, ...made.linked, ...made.trainers];
  await db('AuditLog').whereIn('target', keys).del();
  await db('AuditLog').whereIn('actor', made.users).del();
  if (made.gyms.length) await db('Gym').whereIn('id', made.gyms).del();
  await db('TrainerProfile').whereIn('userId', made.users).del();
  if (made.trainers.length) await db('TrainerProfile').whereIn('id', made.trainers).del();
  await db('User').whereIn('id', made.users).del();
  // Persons of the link specs stay (IdentityEvent is append-only, as in identity-i2-linking.specs.mjs).
  const removable = made.persons.filter(p => !made.linked.includes(p));
  for (const p of removable) {
    try { await db('Person').where({ id: p }).del(); } catch { /* still referenced: leave it */ }
  }
  await db.destroy();
});

const trainerBody = extra => ({ displayName: 'Dob Trainer', photoUrl: '/storage/bafytest/t.jpg', gender: 'female', bio: 'x', ...extra });
const ownerBody = extra => ({ displayName: 'Dob Owner', gyms: [{ name: `Dob Gym ${uid('g')}`, tier: 'standard', location: 'Dar es Salaam' }], ...extra });
async function registerOwner(userId, extra) {
  const r = await call(gymOwnerRegister, as(userId, 'gym_operator'), { body: ownerBody(extra) });
  if (r.body?.gymIds) made.gyms.push(...r.body.gymIds);
  return r;
}

// ── flag off ────────────────────────────────────────────────────────────────

test('flag off: every new endpoint is 404 feature_disabled and registration ignores the new fields', async () => {
  off();
  const t = await user('trainer');
  const o = await user('gym_operator');
  for (const [route, claims, params] of [
    [getMyPersonalDetails, as(t, 'trainer'), {}],
    [putMyPersonalDetails, as(t, 'trainer'), {}],
    [adminTrainerPersonalDetails, as(await user('admin'), 'admin'), { id: 'trn_none' }],
    [adminGymOwnerPersonalDetails, as(await user('admin'), 'admin'), { id: o }],
  ]) {
    const r = await call(route, claims, { params, body: { dateOfBirth: '1990-01-01' } });
    assert.equal(r.statusCode, 404, route.path);
    assert.deepEqual(r.body, { error: 'feature_disabled' });
  }
  // Invalid and under-18 values are ignored exactly as before; nothing is stored.
  const reg = await call(trainerRegister, as(t, 'trainer'), { body: trainerBody({ dateOfBirth: 'not-a-date' }) });
  assert.equal(reg.statusCode, 200, JSON.stringify(reg.body));
  const reg2 = await registerOwner(o, { dateOfBirth: yearsAgo(10), gender: 'robot' });
  assert.equal(reg2.statusCode, 200, JSON.stringify(reg2.body));
  for (const id of [t, o]) {
    const p = await stored(await personOf(id));
    assert.deepEqual([p.dateOfBirth, p.gender, p.declaredProfileUpdatedAt], [null, null, null]);
  }
});

// ── GET /me/personal-details ────────────────────────────────────────────────

test('GET: a new trainer with no date of birth is asked; gender comes from the trainer profile', async () => {
  const t = await user('trainer');
  await call(trainerRegister, as(t, 'trainer'), { body: trainerBody() });
  const r = await call(getMyPersonalDetails, as(t, 'trainer'));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { dateOfBirth: null, gender: 'female', source: null, ask: true, required: true, genderFrom: 'trainer_profile' });
});

test('GET: a member is never asked; their member-profile date of birth is the fallback source', async () => {
  const m = await user('member', { memberProfile: JSON.stringify({ dateOfBirth: '1990-05-17', gender: 'male' }) });
  const r = await call(getMyPersonalDetails, as(m, 'member'));
  assert.deepEqual(r.body, { dateOfBirth: '1990-05-17', gender: null, source: 'member', ask: false, required: false, genderFrom: null });
  // An invalid stored member date counts as none.
  const bad = await user('member', { memberProfile: JSON.stringify({ dateOfBirth: '2023-02-31' }) });
  assert.equal((await call(getMyPersonalDetails, as(bad, 'member'))).body.dateOfBirth, null);
  assert.equal((await call(getMyPersonalDetails, null)).statusCode, 401);
});

test('GET precedence: the Person date of birth wins over a member one; the member one fills in for an owner', async () => {
  const per = await person();
  const m = await user('member', { personId: per, memberProfile: JSON.stringify({ dateOfBirth: '1991-01-01' }) });
  const o = await user('gym_operator', { personId: per });
  let r = await call(getMyPersonalDetails, as(o, 'gym_operator'));
  assert.deepEqual([r.body.dateOfBirth, r.body.source, r.body.ask, r.body.required], ['1991-01-01', 'member', false, true]);
  const put = await call(putMyPersonalDetails, as(o, 'gym_operator'), { body: { dateOfBirth: '1985-07-04', gender: 'other' } });
  assert.equal(put.statusCode, 200, JSON.stringify(put.body));
  r = await call(getMyPersonalDetails, as(m, 'member'));
  assert.deepEqual(r.body, { dateOfBirth: '1985-07-04', gender: 'other', source: 'person', ask: false, required: true, genderFrom: 'person' });
});

// ── PUT /me/personal-details ────────────────────────────────────────────────

test('PUT: strict date of birth — the same 400 body as /me/profile for every bad value', async () => {
  const o = await user('gym_operator');
  for (const bad of ['2023-02-29', '2024-02-30', '2011/05/03', '03/05/2011', '2011-5-3', ' 1990-01-01', '1990-01-01T00:00:00Z',
    '1900-12-31', tomorrow(), 19900101, true, {}, ['1990-01-01']]) {
    resetPersonalDetailsLimits();
    const r = await call(putMyPersonalDetails, as(o, 'gym_operator'), { body: { dateOfBirth: bad } });
    assert.equal(r.statusCode, 400, `${JSON.stringify(bad)} → ${JSON.stringify(r.body)}`);
    assert.deepEqual(r.body, { error: 'invalid_field', field: 'dateOfBirth' });
  }
  assert.equal((await stored(await personOf(o))).dateOfBirth, null, 'nothing saved');
  // Boundaries that are valid: 1901-01-01 is not a partner-age problem; 2024-02-29 is a real day.
  assert.equal((await call(putMyPersonalDetails, as(o, 'gym_operator'), { body: { dateOfBirth: '1901-01-01' } })).statusCode, 200);
  assert.equal((await call(putMyPersonalDetails, as(o, 'gym_operator'), { body: { dateOfBirth: '1996-02-29' } })).body.dateOfBirth, '1996-02-29');
});

test('PUT: gender must be male, female or other; null or "" = prefer not to say; left out keeps it', async () => {
  const o = await user('gym_operator');
  for (const bad of ['Female', 'x', 5, true, {}]) {
    const r = await call(putMyPersonalDetails, as(o, 'gym_operator'), { body: { gender: bad } });
    assert.deepEqual([r.statusCode, r.body], [400, { error: 'invalid_field', field: 'gender' }], JSON.stringify(bad));
  }
  let r = await call(putMyPersonalDetails, as(o, 'gym_operator'), { body: { gender: 'female', dateOfBirth: '1980-10-10' } });
  assert.deepEqual([r.body.gender, r.body.genderFrom, r.body.dateOfBirth], ['female', 'person', '1980-10-10']);
  r = await call(putMyPersonalDetails, as(o, 'gym_operator'), { body: { dateOfBirth: null } });
  assert.deepEqual([r.body.gender, r.body.dateOfBirth], ['female', '1980-10-10'], 'null / absent keep both');
  r = await call(putMyPersonalDetails, as(o, 'gym_operator'), { body: { gender: null } });
  assert.deepEqual([r.body.gender, r.body.dateOfBirth], [null, '1980-10-10'], 'gender null clears it');
  r = await call(putMyPersonalDetails, as(o, 'gym_operator'), { body: { dateOfBirth: '  ' } });
  assert.deepEqual([r.body.dateOfBirth, r.body.ask], [null, true], '"" clears the date; the owner is asked again');
});

test('PUT: under 18 is refused for a trainer or owner (18 today is fine); a member may give any valid date', async () => {
  const t = await user('trainer');
  const r = await call(putMyPersonalDetails, as(t, 'trainer'), { body: { dateOfBirth: yearsAgo(18, 1) } });
  assert.deepEqual([r.statusCode, r.body], [400, { error: 'partner_under_18' }]);
  assert.equal((await stored(await personOf(t))).dateOfBirth, null);
  const ok = await call(putMyPersonalDetails, as(t, 'trainer'), { body: { dateOfBirth: yearsAgo(18) } });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  const m = await user('member');
  const kid = await call(putMyPersonalDetails, as(m, 'member'), { body: { dateOfBirth: yearsAgo(12) } });
  assert.equal(kid.statusCode, 200, JSON.stringify(kid.body));
});

test('PUT: audited without the values; rate limited per person', async () => {
  const o = await user('gym_operator');
  const dob = '1977-03-09';
  await call(putMyPersonalDetails, as(o, 'gym_operator'), { body: { dateOfBirth: dob, gender: 'male' } });
  const rows = await db('AuditLog').where({ target: await personOf(o), action: 'personal_details_updated' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor, o);
  const text = JSON.stringify(rows[0]);
  assert.ok(!text.includes(dob) && !text.includes('1977') && !text.includes('male'), text);
  assert.deepEqual(rows[0].after, { dateOfBirth: 'set', gender: 'set', via: 'me' });
  for (let i = 1; i < PERSONAL_DETAILS_WRITES_PER_MINUTE; i += 1) {
    assert.equal((await call(putMyPersonalDetails, as(o, 'gym_operator'), { body: {} })).statusCode, 200);
  }
  const limited = await call(putMyPersonalDetails, as(o, 'gym_operator'), { body: {} });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.body.error, 'rate_limited');
  assert.ok(limited.body.retryAfterSeconds >= 1);
});

// ── registration ────────────────────────────────────────────────────────────

test('trainer register: no date of birth is accepted; a valid one is saved on the Person, not the profile', async () => {
  const t = await user('trainer');
  const plain = await call(trainerRegister, as(t, 'trainer'), { body: trainerBody() });
  assert.equal(plain.statusCode, 200, JSON.stringify(plain.body));
  const t2 = await user('trainer');
  const dob = '1988-12-01';
  const reg = await call(trainerRegister, as(t2, 'trainer'), { body: trainerBody({ dateOfBirth: dob }) });
  assert.equal(reg.statusCode, 200, JSON.stringify(reg.body));
  assert.ok(!JSON.stringify(reg.body).includes(dob), 'not echoed on the trainer profile');
  const p = await stored(await personOf(t2));
  assert.equal(p.dateOfBirth, dob);
  assert.equal(p.gender, null, 'trainer gender stays on the trainer profile');
  const row = await db('TrainerProfile').where({ userId: t2 }).first();
  assert.ok(!JSON.stringify(row).includes(dob));
  const audit = await db('AuditLog').where({ target: await personOf(t2), action: 'personal_details_updated' }).first();
  assert.deepEqual(audit.after, { dateOfBirth: 'set', via: 'trainer_register' });
});

test('trainer register: invalid or under-18 date of birth is refused before anything is saved', async () => {
  const t = await user('trainer');
  const bad = await call(trainerRegister, as(t, 'trainer'), { body: trainerBody({ dateOfBirth: '1990-02-30' }) });
  assert.deepEqual([bad.statusCode, bad.body], [400, { error: 'invalid_field', field: 'dateOfBirth' }]);
  const young = await call(trainerRegister, as(t, 'trainer'), { body: trainerBody({ dateOfBirth: yearsAgo(17) }) });
  assert.deepEqual([young.statusCode, young.body], [400, { error: 'partner_under_18' }]);
  assert.equal(await db('TrainerProfile').where({ userId: t }).first(), undefined, 'no profile made');
  assert.equal((await stored(await personOf(t))).dateOfBirth, null);
});

test('owner register: date of birth and gender optional; saved when sent; checked strictly', async () => {
  const o1 = await user('gym_operator');
  const plain = await registerOwner(o1, {});
  assert.equal(plain.statusCode, 200, JSON.stringify(plain.body));
  assert.equal((await stored(await personOf(o1))).dateOfBirth, null);

  const o2 = await user('gym_operator');
  const reg = await registerOwner(o2, { dateOfBirth: '1979-06-30', gender: 'female' });
  assert.equal(reg.statusCode, 200, JSON.stringify(reg.body));
  const p = await stored(await personOf(o2));
  assert.deepEqual([p.dateOfBirth, p.gender], ['1979-06-30', 'female']);
  assert.ok(p.declaredProfileUpdatedAt);
  assert.ok(!JSON.stringify(reg.body).includes('1979-06-30'));

  const o3 = await user('gym_operator');
  const g = await registerOwner(o3, { gender: 'F' });
  assert.deepEqual([g.statusCode, g.body], [400, { error: 'invalid_field', field: 'gender' }]);
  const young = await registerOwner(o3, { dateOfBirth: yearsAgo(16) });
  assert.deepEqual([young.statusCode, young.body], [400, { error: 'partner_under_18' }]);
  assert.equal((await db('User').where({ id: o3 }).first()).gymId ?? null, null, 'no gym assigned');
  // "Prefer not to say" stores nothing.
  const o4 = await user('gym_operator');
  assert.equal((await registerOwner(o4, { dateOfBirth: '1990-01-01', gender: null })).statusCode, 200);
  assert.equal((await stored(await personOf(o4))).gender, null);
});

// ── identity merge, deletion ────────────────────────────────────────────────

// B's persona moves onto A's Person through a verified email; B's Person becomes a tombstone.
async function linkScenario({ aDetails = null, bDetails = null }) {
  const uidA = uid('fb');
  const email = `${uid('dobmerge')}@example.com`;
  const a = await user('member', { firebaseUid: uidA, email });
  const b = await user('gym_operator', { email });
  const pa = await personOf(a);
  const pb = await personOf(b);
  made.linked.push(pa, pb);
  assert.notEqual(pa, pb);
  if (aDetails) await db('Person').where({ id: pa }).update(aDetails);
  if (bDetails) await db('Person').where({ id: pb }).update(bDetails);
  const result = await identityLinkService.linkOnVerifiedSignIn({ anchorUserId: a, uid: uidA, email });
  assert.deepEqual(result.mergedPersonIds, [pb], JSON.stringify(result));
  return { a, b, pa, pb };
}

test('merge: the survivor takes the merged-in date of birth and gender when it has none; the tombstone keeps neither', async () => {
  const { pa, pb } = await linkScenario({ bDetails: { dateOfBirth: '1982-04-04', gender: 'male' } });
  const survivor = await stored(pa);
  assert.deepEqual([survivor.dateOfBirth, survivor.gender], ['1982-04-04', 'male']);
  const tomb = await stored(pb);
  assert.deepEqual([tomb.dateOfBirth, tomb.gender], [null, null]);
});

test('merge: the survivor keeps its own values; each field is filled only where empty', async () => {
  const { pa } = await linkScenario({
    aDetails: { dateOfBirth: '1970-01-01' },
    bDetails: { dateOfBirth: '1982-04-04', gender: 'female' },
  });
  const survivor = await stored(pa);
  assert.deepEqual([survivor.dateOfBirth, survivor.gender], ['1970-01-01', 'female']);
});

test('account deletion: the date of birth and gender go with the last persona, stay while one remains', async () => {
  const per = await person();
  const m = await user('member', { personId: per });
  const t = await user('trainer', { personId: per });
  await call(putMyPersonalDetails, as(t, 'trainer'), { body: { dateOfBirth: '1984-08-08', gender: 'other' } });
  const first = await accountService.deleteMyAccount(await db('User').where({ id: m }).first());
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal((await stored(per)).dateOfBirth, '1984-08-08');
  const last = await accountService.deleteMyAccount(await db('User').where({ id: t }).first());
  assert.equal(last.ok, true, JSON.stringify(last));
  const p = await stored(per);
  assert.deepEqual([p.dateOfBirth, p.gender, p.declaredProfileUpdatedAt], [null, null, null]);
});

// ── public and list payloads ────────────────────────────────────────────────

test('public, own-profile and admin list payloads never carry the declared date of birth', async () => {
  const dob = '1966-11-23';
  const t = await user('trainer');
  const reg = await call(trainerRegister, as(t, 'trainer'), { body: trainerBody({ dateOfBirth: dob }) });
  assert.equal(reg.statusCode, 200);
  const trainerId = reg.body.id;
  const o = await user('gym_operator');
  const owner = await registerOwner(o, { dateOfBirth: dob, gender: 'male' });
  assert.equal(owner.statusCode, 200);
  const admin = as(await user('admin'), 'admin');
  const payloads = [
    (await call(getTrainer, null, { params: { id: trainerId } })).body,
    (await call(listTrainers, null)).body,
    (await call(trainerMyProfile, as(t, 'trainer'))).body,
    (await call(me, as(t, 'trainer'))).body,
    (await call(me, as(o, 'gym_operator'))).body,
    (await call(adminListTrainers, admin)).body,
    (await call(adminListGymOwners, admin)).body,
    (await call(getGym, null, { params: { id: owner.body.gymIds[0] } })).body,
  ];
  for (const body of payloads) {
    const text = JSON.stringify(body ?? null);
    assert.ok(!text.includes(dob), text.slice(0, 200));
    assert.ok(!text.includes('dateOfBirth'), text.slice(0, 200));
    assert.ok(!text.includes('personalDetails'));
  }
});

// ── admin view only ─────────────────────────────────────────────────────────

test('admin: trainer and owner detail show personalDetails (with age); each view is audited without values', async () => {
  const t = await user('trainer');
  const dob = yearsAgo(30);
  const reg = await call(trainerRegister, as(t, 'trainer'), { body: trainerBody({ dateOfBirth: dob, gender: 'male' }) });
  const trainerId = reg.body.id;
  const o = await user('gym_operator');
  await registerOwner(o, { dateOfBirth: yearsAgo(45, -1), gender: 'female' });
  const adminId = await user('admin');
  const admin = as(adminId, 'admin');

  const tr = await call(adminTrainerPersonalDetails, admin, { params: { id: trainerId } });
  assert.equal(tr.statusCode, 200, JSON.stringify(tr.body));
  assert.deepEqual(tr.body, {
    trainerId, userId: t,
    personalDetails: { dateOfBirth: dob, age: 30, gender: 'male', genderFrom: 'trainer_profile', source: 'person' },
  });
  const ow = await call(adminGymOwnerPersonalDetails, admin, { params: { id: o } });
  assert.deepEqual(ow.body, {
    ownerId: o,
    personalDetails: { dateOfBirth: yearsAgo(45, -1), age: 45, gender: 'female', genderFrom: 'person', source: 'person' },
  });
  const views = await db('AuditLog').where({ actor: adminId, action: 'personal_details_viewed' });
  assert.equal(views.length, 2);
  assert.ok(!JSON.stringify(views).includes(dob));

  // Nothing given yet: all null, not an error.
  const blank = await user('gym_operator');
  const none = await call(adminGymOwnerPersonalDetails, admin, { params: { id: blank } });
  assert.deepEqual(none.body.personalDetails, { dateOfBirth: null, age: null, gender: null, genderFrom: null, source: null });
  // Unknown ids and the wrong kind of account are 404.
  assert.equal((await call(adminTrainerPersonalDetails, admin, { params: { id: 'trn_missing' } })).statusCode, 404);
  assert.equal((await call(adminGymOwnerPersonalDetails, admin, { params: { id: t } })).statusCode, 404);
});

test('admin: only admins with the page scope may view; nobody can write through these routes', async () => {
  const t = await user('trainer');
  const reg = await call(trainerRegister, as(t, 'trainer'), { body: trainerBody({ dateOfBirth: '1990-01-01' }) });
  const o = await user('gym_operator');
  const trainersStaff = as(await user('admin', { portalUser: true, aclPermissions: ['trainers'] }), 'admin', { portalUser: true, aclPermissions: ['trainers'] });
  const ownersStaff = as(await user('admin', { portalUser: true, aclPermissions: ['owners'] }), 'admin', { portalUser: true, aclPermissions: ['owners'] });
  const otherStaff = as(await user('admin', { portalUser: true, aclPermissions: ['members'] }), 'admin', { portalUser: true, aclPermissions: ['members'] });

  assert.equal((await call(adminTrainerPersonalDetails, trainersStaff, { params: { id: reg.body.id } })).statusCode, 200);
  assert.equal((await call(adminGymOwnerPersonalDetails, ownersStaff, { params: { id: o } })).statusCode, 200);
  for (const [route, claims, id] of [
    [adminTrainerPersonalDetails, ownersStaff, reg.body.id],
    [adminTrainerPersonalDetails, otherStaff, reg.body.id],
    [adminGymOwnerPersonalDetails, trainersStaff, o],
    [adminGymOwnerPersonalDetails, otherStaff, o],
  ]) {
    const r = await call(route, claims, { params: { id } });
    assert.deepEqual([r.statusCode, r.body.error], [403, 'acl_forbidden'], route.path);
  }
  for (const [route, claims] of [[adminTrainerPersonalDetails, as(t, 'trainer')], [adminGymOwnerPersonalDetails, as(o, 'gym_operator')]]) {
    assert.equal((await call(route, claims, { params: { id: o } })).statusCode, 403);
  }
  assert.equal((await call(adminTrainerPersonalDetails, null, { params: { id: reg.body.id } })).statusCode, 401);
  for (const route of [adminTrainerPersonalDetails, adminGymOwnerPersonalDetails]) assert.equal(route.method, 'get');
});

// ── KYC is never read ───────────────────────────────────────────────────────

test('static: the declared date of birth code never imports or reads the KYC store', () => {
  for (const file of [
    '../src/services/personal-details-service.mjs',
    '../src/infra/person-details-store-pg.mjs',
    '../functions/personal-details.mjs',
  ]) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const banned of ['partner_people', 'partnerPeople', 'PartnerPerson', 'partner-kyc', 'partnerKyc', 'PartnerKyc']) {
      assert.ok(!src.includes(banned), `${file} mentions ${banned}`);
    }
  }
});

// ── security review fix round (M1, L1, L2, L3) ──────────────────────────────

const memberDob = dob => JSON.stringify({ dateOfBirth: dob });

test('M1: registering without a date of birth is refused when the stored one (member profile or Person) is under 18', async () => {
  // Member profile under 18 on the same Person; the trainer sends nothing.
  const per = await person();
  await user('member', { personId: per, memberProfile: memberDob(yearsAgo(16)) });
  const t = await user('trainer', { personId: per });
  const r = await call(trainerRegister, as(t, 'trainer'), { body: trainerBody() });
  assert.deepEqual([r.statusCode, r.body], [400, { error: 'partner_under_18' }]);
  assert.equal(await db('TrainerProfile').where({ userId: t }).first(), undefined, 'no profile made');

  // Owner clearing the date ("") falls back to the member profile, still under 18: no gym made.
  const per2 = await person();
  await user('member', { personId: per2, memberProfile: memberDob(yearsAgo(17)) });
  const o = await user('gym_operator', { personId: per2 });
  await db('Person').where({ id: per2 }).update({ dateOfBirth: '1980-01-01' });
  const cleared = await registerOwner(o, { dateOfBirth: '' });
  assert.deepEqual([cleared.statusCode, cleared.body], [400, { error: 'partner_under_18' }]);
  assert.equal((await db('User').where({ id: o }).first()).gymId ?? null, null);
  // Not clearing: the adult Person date counts and the owner registers.
  const ok = await registerOwner(o, {});
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));

  // A Person date under 18 (written by an older build) is refused too.
  const t2 = await user('trainer');
  await db('Person').where({ id: await personOf(t2) }).update({ dateOfBirth: yearsAgo(15) });
  assert.equal((await call(trainerRegister, as(t2, 'trainer'), { body: trainerBody() })).body.error, 'partner_under_18');

  // Flag off: nothing is checked, as before.
  off();
  assert.equal((await call(trainerRegister, as(t, 'trainer'), { body: trainerBody() })).statusCode, 200);
});

test('M1: PUT clearing the date ("") for a partner whose member-profile date is under 18 is refused', async () => {
  const per = await person();
  await user('member', { personId: per, memberProfile: memberDob(yearsAgo(17)) });
  const o = await user('gym_operator', { personId: per });
  await db('Person').where({ id: per }).update({ dateOfBirth: '1980-01-01' });
  const r = await call(putMyPersonalDetails, as(o, 'gym_operator'), { body: { dateOfBirth: '' } });
  assert.deepEqual([r.statusCode, r.body], [400, { error: 'partner_under_18' }]);
  assert.equal((await stored(per)).dateOfBirth, '1980-01-01', 'nothing cleared');
});

test('M1: adding a trainer or gym-owner persona is refused for a person whose stored date is under 18', async () => {
  const saved = { IDENTITY_V2: process.env.IDENTITY_V2, V2_ADD_PERSONA: process.env.V2_ADD_PERSONA };
  process.env.IDENTITY_V2 = '1'; process.env.V2_ADD_PERSONA = '1';
  try {
    const young = await user('member', { memberProfile: memberDob(yearsAgo(16)) });
    for (const userType of ['trainer', 'gym_owner']) {
      const r = await authService.addPersona({ claims: { sub: young, userType: 'member' }, userType });
      assert.deepEqual([r.error, r.status], ['partner_under_18', 400], userType);
    }
    const vendor = await authService.addPersona({ claims: { sub: young, userType: 'member' }, userType: 'vendor' });
    assert.equal(vendor.created, true, 'other roles are not age-checked');
    const adult = await user('member', { memberProfile: memberDob('1990-01-01') });
    const ok = await authService.addPersona({ claims: { sub: adult, userType: 'member' }, userType: 'trainer' });
    assert.equal(ok.created, true, JSON.stringify(ok));
    const none = await user('member');
    assert.equal((await authService.addPersona({ claims: { sub: none, userType: 'member' }, userType: 'gym_owner' })).created, true, 'no date of birth: the app asks later');
    off();
    const young2 = await user('member', { memberProfile: memberDob(yearsAgo(16)) });
    assert.equal((await authService.addPersona({ claims: { sub: young2, userType: 'member' }, userType: 'trainer' })).created, true, 'flag off: unchanged');
    for (const id of [young, adult, none, young2]) {
      const extra = await db('User').where({ personId: await personOf(id) }).whereNot({ id }).pluck('id');
      made.users.push(...extra);
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('M1 variant 3: /me/profile refuses a member date under 18 for a person who also holds a partner role', async () => {
  const per = await person();
  const m = await user('member', { personId: per });
  await user('trainer', { personId: per });
  const r = await call(updateMemberProfile, as(m, 'member'), { body: { dateOfBirth: yearsAgo(17) } });
  assert.deepEqual([r.statusCode, r.body], [400, { error: 'partner_under_18' }]);
  assert.equal((await call(updateMemberProfile, as(m, 'member'), { body: { dateOfBirth: yearsAgo(30) } })).statusCode, 200);
  // A member-only person may give any valid date; the flag off changes nothing.
  const solo = await user('member');
  assert.equal((await call(updateMemberProfile, as(solo, 'member'), { body: { dateOfBirth: yearsAgo(12) } })).statusCode, 200);
  off();
  assert.equal((await call(updateMemberProfile, as(m, 'member'), { body: { dateOfBirth: yearsAgo(17) } })).statusCode, 200);
});

test('L1: the admin view shows a member-profile date only to callers who may also see members', async () => {
  const per = await person();
  await user('member', { personId: per, memberProfile: memberDob('1975-05-05') });
  const o = await user('gym_operator', { personId: per });
  const superAdmin = as(await user('admin'), 'admin');
  const ownersOnly = as(await user('admin', { portalUser: true, aclPermissions: ['owners'] }), 'admin', { portalUser: true, aclPermissions: ['owners'] });
  const ownersAndMembers = as(await user('admin', { portalUser: true, aclPermissions: ['owners', 'members'] }), 'admin', { portalUser: true, aclPermissions: ['owners', 'members'] });
  const view = async claims => (await call(adminGymOwnerPersonalDetails, claims, { params: { id: o } })).body.personalDetails;
  assert.deepEqual([(await view(superAdmin)).source, (await view(superAdmin)).dateOfBirth], ['member', '1975-05-05']);
  assert.deepEqual([(await view(ownersAndMembers)).source, (await view(ownersAndMembers)).dateOfBirth], ['member', '1975-05-05']);
  assert.deepEqual(await view(ownersOnly), { dateOfBirth: null, age: null, gender: null, genderFrom: null, source: null });
  // A declared (Person) date is shown with the page scope alone.
  await db('Person').where({ id: per }).update({ dateOfBirth: '1976-06-06' });
  assert.deepEqual([(await view(ownersOnly)).source, (await view(ownersOnly)).dateOfBirth], ['person', '1976-06-06']);
});

test('L2: before the migration has run, a write fails closed (503) before anything is saved', async () => {
  await db.raw('ALTER TABLE "Person" RENAME COLUMN "gender" TO "gender_l2_tmp"');
  resetPersonDetailsColumnsCache();
  try {
    const o = await user('gym_operator');
    const put = await call(putMyPersonalDetails, as(o, 'gym_operator'), { body: { dateOfBirth: '1990-01-01' } });
    assert.deepEqual([put.statusCode, put.body], [503, { error: 'personal_details_unavailable' }]);
    const t = await user('trainer');
    const reg = await call(trainerRegister, as(t, 'trainer'), { body: trainerBody({ dateOfBirth: '1990-01-01' }) });
    assert.deepEqual([reg.statusCode, reg.body], [503, { error: 'personal_details_unavailable' }]);
    assert.equal(await db('TrainerProfile').where({ userId: t }).first(), undefined, 'no profile made');
    // Without the new fields registration still works.
    assert.equal((await call(trainerRegister, as(t, 'trainer'), { body: trainerBody() })).statusCode, 200);
  } finally {
    await db.raw('ALTER TABLE "Person" RENAME COLUMN "gender_l2_tmp" TO "gender"');
    resetPersonDetailsColumnsCache();
  }
});

test('L3: an admin deleting the last persona (owner) clears the declared details; deleting only a trainer profile keeps them', async () => {
  const admin = as(await user('admin'), 'admin');
  const o = await user('gym_operator');
  const po = await personOf(o);
  await db('Person').where({ id: po }).update({ dateOfBirth: '1981-01-01', gender: 'female' });
  const del = await call(adminDeleteGymOwner, admin, { params: { id: o } });
  assert.equal(del.statusCode, 200, JSON.stringify(del.body));
  assert.deepEqual([(await stored(po)).dateOfBirth, (await stored(po)).gender], [null, null]);

  const t = await user('trainer');
  const reg = await call(trainerRegister, as(t, 'trainer'), { body: trainerBody({ dateOfBirth: '1982-02-02' }) });
  const delT = await call(adminDeleteTrainer, admin, { params: { id: reg.body.id } });
  assert.equal(delT.statusCode, 200, JSON.stringify(delT.body));
  assert.equal((await stored(await personOf(t))).dateOfBirth, '1982-02-02', 'the trainer account (persona) remains');
});

// ── contract-check round (4, 5) ─────────────────────────────────────────────

test('(4) owner register checks the resolved account, not just the token subject', async () => {
  const email = `${uid('dobowner')}@example.com`;
  const per = await person();
  await user('member', { personId: per, memberProfile: memberDob(yearsAgo(16)) });
  const row = await user('gym_operator', { personId: per, email });
  const ghost = uid('usr');
  made.users.push(ghost);
  // The token's subject has no row; the account is found by email (resolveRequestUser).
  const claims = { sub: ghost, userType: 'gym_operator', email };
  const refused = await call(gymOwnerRegister, claims, { body: ownerBody({}) });
  assert.deepEqual([refused.statusCode, refused.body], [400, { error: 'partner_under_18' }]);
  assert.equal((await db('User').where({ id: row }).first()).gymId ?? null, null, 'no gym assigned');
  assert.equal(await db('User').where({ id: ghost }).first(), undefined, 'nothing provisioned for the token subject');

  // An adult on the resolved account: registered, and the date lands on that account's Person.
  const email2 = `${uid('dobowner')}@example.com`;
  const row2 = await user('gym_operator', { email: email2 });
  const ghost2 = uid('usr');
  made.users.push(ghost2);
  const ok = await call(gymOwnerRegister, { sub: ghost2, userType: 'gym_operator', email: email2 }, { body: ownerBody({ dateOfBirth: '1972-02-02' }) });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  made.gyms.push(...(ok.body.gymIds || []));
  assert.equal((await stored(await personOf(row2))).dateOfBirth, '1972-02-02');
});

test('(5) a failed save after a successful registration is logged without the value; the registration still succeeds', async () => {
  const poison = '1955-05-05';
  await db.raw(`CREATE OR REPLACE FUNCTION dob_spec_poison() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'spec poison' USING ERRCODE = 'P0001'; END; $$ LANGUAGE plpgsql`);
  await db.raw(`CREATE TRIGGER dob_spec_poison BEFORE UPDATE ON "Person" FOR EACH ROW
    WHEN (NEW."dateOfBirth" = DATE '${poison}') EXECUTE FUNCTION dob_spec_poison()`);
  const warned = [];
  const warn = console.warn;
  console.warn = (...args) => { warned.push(args.join(' ')); };
  try {
    const t = await user('trainer');
    const reg = await call(trainerRegister, as(t, 'trainer'), { body: trainerBody({ dateOfBirth: poison }) });
    assert.equal(reg.statusCode, 200, JSON.stringify(reg.body));
    assert.ok(reg.body.id, 'the trainer profile comes back');
    assert.equal((await stored(await personOf(t))).dateOfBirth, null);
    assert.equal((await call(getMyPersonalDetails, as(t, 'trainer'))).body.ask, true, 'the app asks again');

    const o = await user('gym_operator');
    const own = await registerOwner(o, { dateOfBirth: poison, gender: 'male' });
    assert.equal(own.statusCode, 200, JSON.stringify(own.body));
    assert.ok(own.body.gymIds?.length);
    assert.deepEqual([(await stored(await personOf(o))).dateOfBirth, (await stored(await personOf(o))).gender], [null, null]);

    const logs = warned.filter(l => l.includes('[personal-details]'));
    assert.equal(logs.length, 2, JSON.stringify(warned));
    assert.ok(logs.some(l => l.includes('trainer_register') && l.includes('P0001')));
    assert.ok(logs.some(l => l.includes('gym_owner_register')));
    for (const l of logs) assert.ok(!l.includes('1955') && !l.includes('male'), l);
  } finally {
    console.warn = warn;
    await db.raw('DROP TRIGGER IF EXISTS dob_spec_poison ON "Person"');
    await db.raw('DROP FUNCTION IF EXISTS dob_spec_poison()');
  }
});
