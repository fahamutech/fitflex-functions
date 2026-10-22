// Date of birth, one strict rule everywhere (2026-10-22, slice 1 of the partner DOB plan):
// communications audience age (shared/audience.mjs ageOn, segment-service facts) reads a stored
// date of birth with src/shared/date-of-birth.mjs, so an impossible or out-of-range date counts as
// no date of birth and never matches an age condition. The profile save routes refuse the same
// dates with 400 { error: 'invalid_field', field: 'dateOfBirth' }. Audience date values
// (expiresOn) are strict calendar days too.
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { ensureInit } from '../functions/index.mjs';
import { updateMemberProfile } from '../functions/subscriptions.mjs';
import { adminUpsertMember } from '../functions/admin-members.mjs';
import { ownerCreateGym } from '../functions/owner-gyms.mjs';
import { ownerCreateMember } from '../functions/owner-members.mjs';
import { createSegmentService } from '../src/services/segment-service.mjs';
import { ageOn, matchesFilter, validateFilter } from '../src/shared/audience.mjs';
import {
  ageOnDay, isCalendarDay, readDateOfBirth, isValidDateOfBirth, eatToday, classifyStoredDateOfBirth,
} from '../src/shared/date-of-birth.mjs';

await ensureInit();

const DAY_MS = 86_400_000;
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const minusYears = (day, n) => `${Number(day.slice(0, 4)) - n}${day.slice(4)}`;
// Impossible days, before 1901, and "tomorrow" relative to TODAY.
const TODAY = '2026-10-22';
const BAD = ['2023-02-29', '2024-02-30', '2023-02-31', '1899-12-31', '1900-12-31', addDays(TODAY, 1)];

// ── pure: helper + audience ─────────────────────────────────────────────────

test('isCalendarDay: real days only; Date.parse would have rolled these forward', () => {
  for (const d of ['2023-02-29', '2024-02-30', '2023-02-31', '2023-04-31', '2023-13-01', '2023-00-10', '2023-01-00']) {
    assert.equal(isCalendarDay(d), false, d);
  }
  for (const d of ['2024-02-29', '2023-02-28', '1899-12-31', '2023-12-31']) assert.equal(isCalendarDay(d), true, d);
  for (const d of [null, undefined, 20230101, '2023-1-01', ' 2023-01-01', '2023/01/01']) assert.equal(isCalendarDay(d), false, String(d));
});

test('ageOn: an invalid stored date of birth is no date of birth (null)', () => {
  for (const d of BAD) assert.equal(ageOn(d, TODAY), null, d);
  assert.equal(ageOn('1901-01-01', TODAY), 125);
  assert.equal(ageOn('2024-02-29', TODAY), 2);
  assert.equal(ageOn(TODAY, TODAY), 0, 'born today');
  assert.equal(ageOn('2023-02-31', '2026-10-01'), null, 'used to be read as 2023-03-03');
  assert.equal(ageOn('1996-10-01', '2026-02-31'), null, 'an impossible local day too');
  // 18th birthday exactly on today's Dar date; the day before is still 17.
  assert.equal(ageOn(minusYears(TODAY, 18), TODAY), 18);
  assert.equal(ageOn(addDays(minusYears(TODAY, 18), 1), TODAY), 17);
  // Same rule as the shop personalisation reader.
  for (const d of [...BAD, '1990-04-01', minusYears(TODAY, 18)]) assert.equal(ageOn(d, TODAY), ageOnDay(d, TODAY), d);
});

test('readDateOfBirth uses the same age, on the Dar day (21:00 UTC boundary)', () => {
  const eve = new Date('2026-10-21T20:59:59Z'); // still 21 Oct in Dar
  const midnight = new Date('2026-10-21T21:00:00Z'); // 22 Oct in Dar
  assert.equal(eatToday(eve), '2026-10-21');
  assert.equal(eatToday(midnight), '2026-10-22');
  assert.deepEqual(readDateOfBirth('2008-10-22', eve), { status: 'valid', age: 17 });
  assert.deepEqual(readDateOfBirth('2008-10-22', midnight), { status: 'valid', age: 18 });
  assert.deepEqual(readDateOfBirth('2026-10-22', eve), { status: 'invalid' }, 'tomorrow in Dar');
  assert.deepEqual(readDateOfBirth('2026-10-22', midnight), { status: 'valid', age: 0 });
  for (const d of BAD) assert.deepEqual(readDateOfBirth(d, midnight), { status: 'invalid' }, d);
});

test('age conditions never match an invalid date of birth; exists:false does', () => {
  const conds = [
    { field: 'age', op: 'gte', value: 18 },
    { field: 'age', op: 'lte', value: 200 },
    { field: 'age', op: 'between', value: [0, 200] },
    { field: 'age', op: 'eq', value: 0 },
    { field: 'age', op: 'exists', value: true },
  ];
  for (const d of BAD) {
    const facts = { age: ageOn(d, TODAY) };
    for (const c of conds) {
      const v = validateFilter({ all: [c] }, 'platform');
      assert.ok(!v.error, JSON.stringify(v));
      assert.equal(matchesFilter(facts, v.filter), false, `${d} ${c.op}`);
    }
    assert.equal(matchesFilter(facts, validateFilter({ all: [{ field: 'age', op: 'exists', value: false }] }, 'platform').filter), true, d);
  }
  const adult = { age: ageOn(minusYears(TODAY, 18), TODAY) };
  assert.equal(matchesFilter(adult, validateFilter({ all: [{ field: 'age', op: 'gte', value: 18 }] }, 'gym').filter), true);
});

test('audience date values (expiresOn) must be real days', () => {
  for (const d of ['2023-02-29', '2024-02-30', '2023-02-31']) {
    assert.deepEqual(validateFilter({ all: [{ field: 'expiresOn', op: 'before', value: d }] }, 'gym'),
      { error: 'invalid_audience', status: 400, detail: 'bad_value:expiresOn' }, d);
    assert.equal(validateFilter({ all: [{ field: 'expiresOn', op: 'between', value: ['2023-01-01', d] }] }, 'gym').error, 'invalid_audience', d);
  }
  assert.ok(!validateFilter({ all: [{ field: 'expiresOn', op: 'before', value: '2024-02-29' }] }, 'gym').error);
});

test('classifyStoredDateOfBirth (audit script) names each failure', () => {
  const now = new Date(`${TODAY}T09:00:00Z`);
  assert.equal(classifyStoredDateOfBirth(null, now), 'absent');
  assert.equal(classifyStoredDateOfBirth('  ', now), 'absent');
  assert.equal(classifyStoredDateOfBirth(19900401, now), 'invalid_not_text');
  assert.equal(classifyStoredDateOfBirth('03/05/1990', now), 'invalid_format');
  assert.equal(classifyStoredDateOfBirth('2023-02-29', now), 'invalid_impossible_day');
  assert.equal(classifyStoredDateOfBirth('1900-12-31', now), 'invalid_before_1901');
  assert.equal(classifyStoredDateOfBirth(addDays(TODAY, 1), now), 'invalid_in_future');
  assert.equal(classifyStoredDateOfBirth('1990-04-01', now), 'valid');
  for (const d of [...BAD, '1990-04-01', '03/05/1990']) {
    assert.equal(classifyStoredDateOfBirth(d, now) === 'valid', isValidDateOfBirth(d, now), d);
  }
});

test('classifyStoredDateOfBirth: years 0001–0099 are before 1901, not impossible days; still unreadable', () => {
  const now = new Date(`${TODAY}T09:00:00Z`);
  for (const d of ['0001-01-01', '0050-06-15', '0099-12-31', '0000-01-01', '1899-02-29']) {
    assert.equal(classifyStoredDateOfBirth(d, now), 'invalid_before_1901', d);
    assert.deepEqual(readDateOfBirth(d, now), { status: 'invalid' }, d);
    assert.equal(ageOn(d, TODAY), null, d);
  }
  assert.equal(classifyStoredDateOfBirth('1901-02-29', now), 'invalid_impossible_day');
});

// ── CI database: segment facts and profile routes ───────────────────────────

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const phone = () => `+2557${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const made = { users: [], gyms: [] };
function res() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
async function call(endpoint, user, body) {
  const out = res();
  await endpoint.onRequest({ user, body, query: {}, params: {}, headers: {}, get: () => null }, out);
  return out;
}
const dobOf = async id => (await db('User').where({ id }).first()).memberProfile?.dateOfBirth ?? null;

after(async () => {
  mock.timers.reset();
  if (made.gyms.length) await db('Gym').whereIn('id', made.gyms).del();
  if (made.users.length) {
    await db('AuditLog').whereIn('target', made.users).del();
    await db('User').whereIn('id', made.users).del();
  }
});

async function gymWithMembers(dobs) {
  const ownerId = uid('usr_dob_owner');
  const owner = { sub: ownerId, userType: 'gym_operator' };
  assert.equal((await call(updateMemberProfile, owner, { displayName: 'DOB Owner', phone: phone() })).statusCode, 200);
  made.users.push(ownerId);
  const gym = await call(ownerCreateGym, owner, { name: uid('DOB Gym'), tier: 'standard', location: uid('Dodoma'), perVisitRate: 5000 });
  assert.equal(gym.statusCode, 201, JSON.stringify(gym.body));
  made.gyms.push(gym.body.id);
  const day = n => new Date(Date.now() + n * DAY_MS).toISOString().slice(0, 10);
  const ids = {};
  for (const [key, dob] of Object.entries(dobs)) {
    const out = await call(ownerCreateMember, owner, {
      displayName: `DOB ${key}`, phone: phone(), gymId: gym.body.id, durationUnit: 'M', startDate: day(-10), endDate: day(20), tier: 'basic',
    });
    assert.equal(out.statusCode, 201, JSON.stringify(out.body));
    made.users.push(out.body.member.id);
    // Written straight to the database, as an old row might hold it.
    await db('User').where({ id: out.body.member.id }).update({ memberProfile: JSON.stringify(dob === undefined ? {} : { dateOfBirth: dob }) });
    ids[key] = out.body.member.id;
  }
  return { gymId: gym.body.id, ids };
}

test('segment facts: invalid stored dates give age null and miss every age band; 18th birthday flips at 21:00 UTC', async () => {
  const dobs = {
    feb29_2023: '2023-02-29', feb30_2024: '2024-02-30', feb31_2023: '2023-02-31', y1899: '1899-12-31', y1900: '1900-12-31',
    tomorrow: '2026-10-23', eighteen: '2008-10-22', legacyFormat: '03/05/1990', none: undefined,
  };
  const { gymId, ids } = await gymWithMembers(dobs);
  const factsAt = async iso => {
    const svc = createSegmentService({ db, now: () => new Date(iso) });
    const rows = await svc.gymMemberFacts([gymId]);
    return new Map(rows.map(f => [f.memberId, f]));
  };
  const eve = await factsAt('2026-10-21T20:59:59Z');
  const midnight = await factsAt('2026-10-21T21:00:00Z');
  assert.equal(eve.size, Object.keys(dobs).length);
  assert.equal(eve.get(ids.eighteen).age, 17);
  assert.equal(midnight.get(ids.eighteen).age, 18);
  const adults = validateFilter({ all: [{ field: 'age', op: 'gte', value: 18 }] }, 'gym').filter;
  const anyAge = validateFilter({ all: [{ field: 'age', op: 'between', value: [0, 200] }] }, 'gym').filter;
  const noAge = validateFilter({ all: [{ field: 'age', op: 'exists', value: false }] }, 'gym').filter;
  assert.equal(matchesFilter(eve.get(ids.eighteen), adults), false, '17 on the evening before');
  assert.equal(matchesFilter(midnight.get(ids.eighteen), adults), true, '18 from Dar midnight');
  // At 21:00 UTC on 22 Oct it is 23 Oct in Dar: "tomorrow" stays invalid until then.
  assert.equal(midnight.get(ids.tomorrow).age, null);
  assert.equal((await factsAt('2026-10-22T21:00:00Z')).get(ids.tomorrow).age, 0);
  for (const key of ['feb29_2023', 'feb30_2024', 'feb31_2023', 'y1899', 'y1900', 'tomorrow', 'legacyFormat', 'none']) {
    const f = midnight.get(ids[key]);
    assert.equal(f.age, null, key);
    assert.equal(matchesFilter(f, anyAge), false, key);
    assert.equal(matchesFilter(f, noAge), true, key);
  }
});

// The exact error portal and mobile depend on.
const REFUSED = { error: 'invalid_field', field: 'dateOfBirth' };

test('POST /me/profile: impossible, pre-1901 and tomorrow (Dar) dates → 400 invalid_field; 18th birthday today → 200', async () => {
  const today = eatToday();
  const id = uid('usr_dob_me');
  const me = { sub: id, userType: 'member' };
  made.users.push(id);
  assert.equal((await call(updateMemberProfile, me, { displayName: 'DOB Me', dateOfBirth: '1990-04-01' })).statusCode, 200);
  for (const bad of ['2023-02-29', '2024-02-30', '2023-02-31', '1899-12-31', '1900-12-31', addDays(today, 1)]) {
    const out = await call(updateMemberProfile, me, { dateOfBirth: bad });
    assert.equal(out.statusCode, 400, bad);
    assert.deepEqual(out.body, REFUSED, bad);
  }
  assert.equal(await dobOf(id), '1990-04-01', 'nothing saved');
  for (const ok of ['1901-01-01', '2024-02-29', minusYears(today, 18), today]) {
    assert.equal((await call(updateMemberProfile, me, { dateOfBirth: ok })).statusCode, 200, ok);
    assert.equal(await dobOf(id), ok);
  }
});

test('POST /admin/members: same dates, same 400 body', async () => {
  const today = eatToday();
  const adminId = uid('usr_dob_admin');
  await db('User').insert({ id: adminId, userType: 'admin', displayName: 'DOB Admin', updatedAt: new Date() });
  made.users.push(adminId);
  const admin = { sub: adminId, userType: 'admin' };
  const m = uid('usr_dob_member');
  await db('User').insert({ id: m, userType: 'member', displayName: 'DOB Member', memberProfile: JSON.stringify({ dateOfBirth: '1990-04-01' }), updatedAt: new Date() });
  made.users.push(m);
  for (const bad of ['2023-02-29', '2024-02-30', '2023-02-31', '1899-12-31', '1900-12-31', addDays(today, 1)]) {
    const out = await call(adminUpsertMember, admin, { id: m, memberProfile: { dateOfBirth: bad } });
    assert.equal(out.statusCode, 400, bad);
    assert.deepEqual(out.body, REFUSED, bad);
  }
  assert.equal(await dobOf(m), '1990-04-01');
  for (const ok of ['1901-01-01', '2024-02-29', minusYears(today, 18)]) {
    assert.equal((await call(adminUpsertMember, admin, { id: m, memberProfile: { dateOfBirth: ok } })).statusCode, 200, ok);
    assert.equal(await dobOf(m), ok);
  }
});

test('profile routes at the 21:00 UTC boundary: tomorrow-in-Dar refused at 20:59:59, accepted at 21:00', async () => {
  const id = uid('usr_dob_edge');
  const me = { sub: id, userType: 'member' };
  made.users.push(id);
  assert.equal((await call(updateMemberProfile, me, { displayName: 'DOB Edge' })).statusCode, 200);
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-21T20:59:59Z') });
  try {
    const early = await call(updateMemberProfile, me, { dateOfBirth: '2026-10-22' });
    assert.equal(early.statusCode, 400);
    assert.deepEqual(early.body, REFUSED);
    mock.timers.setTime(Date.parse('2026-10-21T21:00:00Z'));
    assert.equal((await call(updateMemberProfile, me, { dateOfBirth: '2026-10-22' })).statusCode, 200);
  } finally {
    mock.timers.reset();
  }
  assert.equal(await dobOf(id), '2026-10-22');
});
