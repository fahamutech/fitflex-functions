// Phase B · B5a — company sponsors move from /hr to /org (flag ORG_ONLY_SPONSORS).
//
// Against the CI database, guards chained as bfast-function runs them:
//  - scripts/hr-to-org.mjs (the conversion service): dry run writes nothing,
//    apply is additive and idempotent, a missing mirror is created, a removed
//    row is never brought back, audit rows are written;
//  - sign-in marks a company HR login as an organisation user only with the flag on;
//  - people of a company's organisation are read and written through the
//    company staff list from /b2b/organizations/:id/beneficiaries...;
//  - challenges, rewards and groups of a company are the same from /org and /corporate;
//  - a company HR login never reaches another company; flag off changes nothing.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureInit } from '../functions/index.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { verify } from '../src/auth/jwt.mjs';
import { b2bService, hrOrgConversionService, signJwt as sign } from '../src/bootstrap/services.mjs';
import { HR_CONVERSION_ACTION, HR_CONVERSION_ACTOR } from '../src/services/hr-org-conversion-service.mjs';
import { authLogin } from '../functions/auth.mjs';
import { verifyContacts, purgeIdentity } from './fixtures/verified-contacts.mjs';
import {
  myB2BOrganizations, myB2BOrganizationSession, getB2BOrganization, listB2BOrganizationUsers, addB2BOrganizationUser, updateB2BOrganizationUser,
  listB2BBeneficiaries, enrollB2BBeneficiary, setB2BBeneficiaryStatus, deactivateB2BBeneficiary,
  linkB2BBeneficiaryAccount, importB2BBeneficiaries, adminCreateB2BOrganization, adminSetB2BOrganizationStatus,
} from '../functions/b2b.mjs';
import {
  adminOnboardCorporate, adminSetCorporateStatus, adminCreateHrUser, adminSetHrUserStatus,
  corporateProvisionStaff, corporateListStaff, corporateSetStaffStatus,
} from '../functions/corporate.mjs';
import * as challengeRoutes from '../functions/challenges.mjs';
import * as rewardRoutes from '../functions/challenge-rewards.mjs';
import * as groupRoutes from '../functions/social.mjs';

await ensureInit();

const FLAG = 'ORG_ONLY_SPONSORS';
const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], orgs: [], corporates: [], challenges: [], groups: [] };

async function withFlag(value, fn) {
  const before = process.env[FLAG];
  if (value) process.env[FLAG] = '1'; else delete process.env[FLAG];
  try { return await fn(); } finally { if (before === undefined) delete process.env[FLAG]; else process.env[FLAG] = before; }
}
const flagOn = fn => withFlag(true, fn);
const flagOff = fn => withFlag(false, fn);

async function account(userType, extra = {}) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `HR2Org ${userType} ${id.slice(-4)}`, accountStatus: 'active', updatedAt: new Date(), ...extra });
  made.users.push(id);
  return id;
}
function res() { return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }
async function call(route, { claims, params = {}, body = {}, query = {} } = {}) {
  const req = { method: route.method.toUpperCase(), headers: claims ? { authorization: `Bearer ${sign(claims)}` } : {}, params, body, query };
  const out = res();
  for (const guard of [route.onGuard].flat().filter(Boolean)) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return out;
}

let adminClaims;
async function admin() {
  if (!adminClaims) adminClaims = { sub: await account('admin'), userType: 'admin' };
  return adminClaims;
}

/** An active company (with its mirrored organisation) and one HR login, made with the flag off. */
async function company({ seatLimit = 50, hr = true } = {}) {
  const a = await admin();
  const onboard = await call(adminOnboardCorporate, {
    claims: a,
    body: { companyName: `HR2Org Co ${uid('c')}`, industrySector: 'banking', workforceBracket: '50-100', subsidyModel: 'fully_funded', passTier: 'pro', billingCycle: 'monthly', seatLimit },
  });
  assert.equal(onboard.statusCode, 201, JSON.stringify(onboard.body));
  const corporateId = onboard.body.id;
  made.corporates.push(corporateId);
  assert.equal((await call(adminSetCorporateStatus, { claims: a, params: { id: corporateId }, body: { status: 'active' } })).statusCode, 200);
  const orgId = (await db('B2BOrganization').where({ legacyCorporateId: corporateId }).first('id'))?.id;
  assert.ok(orgId, 'onboarding mirrors the company');
  let hrUser = null;
  if (hr) {
    const email = `${uid('hr')}@hr2org.example.com`;
    const password = 'a-long-initial-password';
    const created = await flagOff(() => call(adminCreateHrUser, { claims: a, params: { id: corporateId }, body: { displayName: 'Neema HR', email, password } }));
    assert.equal(created.statusCode, 201, JSON.stringify(created.body));
    made.users.push(created.body.hrUser.id);
    hrUser = { id: created.body.hrUser.id, email, password, claims: { sub: created.body.hrUser.id, userType: 'corporate_hr' } };
  }
  return { corporateId, orgId, hr: hrUser };
}

after(async () => {
  if (made.challenges.length) {
    await db('ChallengeParticipant').whereIn('challengeId', made.challenges).del();
    await db('Challenge').whereIn('id', made.challenges).del();
  }
  if (made.groups.length) {
    await db('SocialGroupMember').whereIn('groupId', made.groups).del();
    await db('SocialGroup').whereIn('id', made.groups).del();
  }
  const orgIds = [...made.orgs, ...(made.corporates.length ? await db('B2BOrganization').whereIn('legacyCorporateId', made.corporates).pluck('id') : [])];
  const orgUserIds = orgIds.length ? await db('B2BOrganizationUser').whereIn('organizationId', orgIds).pluck('id') : [];
  if (orgUserIds.length) await db('AuditLog').whereIn('target', orgUserIds).del();
  if (made.corporates.length) await db('AuditLog').whereIn('target', made.corporates).del();
  if (orgIds.length) {
    await db('B2BBeneficiaryImport').whereIn('organizationId', orgIds).del();
    await db('AuditLog').whereIn('target', orgIds).del();
    await db('B2BOrganization').whereIn('id', orgIds).del();
  }
  if (made.corporates.length) {
    await db('CorporateEmployee').whereIn('corporateId', made.corporates).del();
    await db('CorporateAccount').whereIn('id', made.corporates).del();
  }
  await db('AuditLog').whereIn('actor', made.users).del();
  const persons = await purgeIdentity(db, made.users);
  await db('User').whereIn('id', made.users).del();
  if (persons?.length) await db('Person').whereIn('id', persons).del().catch(() => {});
});

// ── 1. Conversion: dry run, apply, idempotence, mirror, removed rows, audit ──

test('conversion: a dry run writes nothing; apply adds one hr row with an audit entry; running again adds nothing', async () => {
  const { corporateId, orgId, hr } = await company();
  const rowsOf = () => db('B2BOrganizationUser').where({ userId: hr.id });
  const auditsOf = () => db('AuditLog').where({ action: HR_CONVERSION_ACTION, actor: HR_CONVERSION_ACTOR }).whereRaw(`after->>'hrUserId' = ?`, [hr.id]);

  const dry = await hrOrgConversionService.run({ corporateId });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.total, 1);
  assert.equal(dry.counts.added, 1);
  assert.deepEqual([dry.items[0].userId, dry.items[0].organizationId, dry.items[0].outcome], [hr.id, orgId, 'added']);
  assert.equal((await rowsOf()).length, 0, 'dry run writes no row');
  assert.equal((await auditsOf()).length, 0, 'dry run writes no audit');

  const applied = await hrOrgConversionService.run({ dryRun: false, corporateId });
  assert.equal(applied.counts.added, 1);
  const rows = await rowsOf();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].organizationId, rows[0].role, rows[0].status, rows[0].createdBy, rows[0].permissions], [orgId, 'hr', 'active', HR_CONVERSION_ACTOR, []]);
  assert.equal((await auditsOf()).length, 1);
  assert.equal((await db('AuditLog').where({ action: 'b2b.hr_to_org.run', target: corporateId })).length, 1);
  // Additive: the corporate_hr login itself is untouched.
  const user = await db('User').where({ id: hr.id }).first();
  assert.deepEqual([user.userType, user.corporateId, user.accountStatus], ['corporate_hr', corporateId, 'active']);

  const again = await hrOrgConversionService.run({ dryRun: false, corporateId });
  assert.deepEqual([again.counts.added, again.counts.already_member], [0, 1]);
  assert.equal((await rowsOf()).length, 1);
  assert.equal((await auditsOf()).length, 1);
  assert.equal((await db('AuditLog').where({ action: 'b2b.hr_to_org.run', target: corporateId })).length, 1, 'a run that adds nothing writes no run entry');
});

test('conversion: a missing mirror is created like onboarding does; a removed row is not brought back; a suspended login gets a suspended row', async () => {
  const { corporateId, orgId, hr } = await company();
  // Lose the mirror (as for a company from before B2B Foundation).
  await db('B2BOrganization').where({ id: orgId }).del();
  const dry = await hrOrgConversionService.run({ corporateId });
  assert.deepEqual([dry.items[0].outcome, dry.items[0].mirrorCreated, dry.mirrorsCreated], ['added', true, 1]);
  assert.equal(await db('B2BOrganization').where({ legacyCorporateId: corporateId }).first(), undefined, 'dry run does not create the mirror');

  const applied = await hrOrgConversionService.run({ dryRun: false, corporateId });
  const mirror = await db('B2BOrganization').where({ legacyCorporateId: corporateId }).first();
  assert.equal(mirror.id, orgId, 'same deterministic id as the backfill');
  assert.equal(applied.mirrorsCreated, 1);
  assert.equal((await db('AuditLog').where({ action: 'b2b.organization.map_corporate', target: orgId })).length >= 1, true);

  // Someone removes the row on purpose: re-running leaves it removed.
  const row = await db('B2BOrganizationUser').where({ userId: hr.id }).first();
  await db('B2BOrganizationUser').where({ id: row.id }).update({ status: 'removed', removedAt: new Date() });
  const rerun = await hrOrgConversionService.run({ dryRun: false, corporateId });
  assert.equal(rerun.items[0].outcome, 'skipped_removed');
  assert.deepEqual((await db('B2BOrganizationUser').where({ userId: hr.id })).map(r => r.status), ['removed']);

  // A suspended HR login is converted as suspended.
  const other = await company();
  await call(adminSetHrUserStatus, { claims: await admin(), params: { id: other.corporateId, userId: other.hr.id }, body: { status: 'suspended' } });
  await hrOrgConversionService.run({ dryRun: false, corporateId: other.corporateId });
  assert.equal((await db('B2BOrganizationUser').where({ userId: other.hr.id }).first()).status, 'suspended');
});

test('conversion: the script runs as a dry run by default against the CI database and prints the report', async () => {
  const { corporateId, hr } = await company();
  const script = fileURLToPath(new URL('../scripts/hr-to-org.mjs', import.meta.url));
  const out = spawnSync(process.execPath, [script, `--corporate=${corporateId}`, '--json'], { env: { ...process.env, FITFLEX_USE_CI_DB: '1' }, encoding: 'utf8', timeout: 60_000 });
  assert.equal(out.status, 0, out.stderr);
  const ciName = new URL(process.env.DATABASE_URL_CI).pathname.slice(1);
  assert.match(out.stderr, new RegExp(`database: ${ciName} · dry run`));
  const report = JSON.parse(out.stdout.slice(out.stdout.search(/^\{/m)));
  assert.deepEqual([report.dryRun, report.total, report.items[0].userId, report.items[0].outcome], [true, 1, hr.id, 'added']);
  assert.equal((await db('B2BOrganizationUser').where({ userId: hr.id })).length, 0);
});

test('conversion: with the flag on a new HR login is made an organisation user at once', async () => {
  const { corporateId, orgId } = await company({ hr: false });
  const email = `${uid('hr')}@hr2org.example.com`;
  const created = await flagOn(async () => call(adminCreateHrUser, { claims: await admin(), params: { id: corporateId }, body: { displayName: 'New HR', email, password: 'a-long-initial-password' } }));
  assert.equal(created.statusCode, 201);
  made.users.push(created.body.hrUser.id);
  const rows = await db('B2BOrganizationUser').where({ userId: created.body.hrUser.id });
  assert.deepEqual(rows.map(r => [r.organizationId, r.role, r.status]), [[orgId, 'hr', 'active']]);
  // Flag off: no row.
  const off = await flagOff(async () => call(adminCreateHrUser, { claims: await admin(), params: { id: corporateId }, body: { displayName: 'Old HR', email: `${uid('hr')}@hr2org.example.com`, password: 'a-long-initial-password' } }));
  made.users.push(off.body.hrUser.id);
  assert.equal((await db('B2BOrganizationUser').where({ userId: off.body.hrUser.id })).length, 0);
});

// ── 2. Sign-in marks ─────────────────────────────────────────────────────────

test('sign-in: with the flag on an HR login is marked as an organisation user (roles, ids); the JWT is unchanged; flag off: no marks', async () => {
  const { corporateId, orgId, hr } = await company();
  const login = () => call(authLogin, { body: { email: hr.email, password: hr.password, requestedRole: 'corporate_hr' } });

  const off = await flagOff(login);
  assert.equal(off.statusCode, 200, JSON.stringify(off.body));
  assert.equal(off.body.user.userType, 'corporate_hr');
  assert.equal('organizationUser' in off.body.user, false);

  // Before the script (read-through) and after it, the same marks.
  for (const step of ['read-through', 'converted']) {
    if (step === 'converted') await hrOrgConversionService.run({ dryRun: false, corporateId });
    const on = await flagOn(login);
    assert.equal(on.statusCode, 200, JSON.stringify(on.body));
    assert.deepEqual([on.body.user.userType, on.body.user.organizationUser, on.body.user.organizationRoles, on.body.user.organizationIds], ['corporate_hr', true, ['hr'], [orgId]], step);
    const claims = verify(on.body.token);
    assert.equal(claims.userType, 'corporate_hr');
    assert.equal('organizationUser' in claims || 'organizationRoles' in claims, false, 'access is still decided per request');
  }

  // The organisation's role on the row is what the session reports.
  await db('B2BOrganizationUser').where({ userId: hr.id }).update({ role: 'admin' });
  assert.deepEqual((await flagOn(login)).body.user.organizationRoles, ['admin']);

  // A member signing in is never marked by this (the portal asks /b2b/me/organizations as before).
  const member = await account('member');
  assert.equal(await flagOn(() => b2bService.organizationSessionMarks({ userId: member, userType: 'member' })), null);
});

// ── 3. People through the organisation for a company ─────────────────────────

test('people: flag on, HR in /org sees the company staff and adds, suspends, links and removes them through the company staff path', async () => {
  const { corporateId, orgId, hr } = await company({ seatLimit: 3 });
  const P = { id: orgId };
  const staffNow = async () => (await call(corporateListStaff, { claims: hr.claims })).body.employees;
  const seats = async () => (await db('CorporateAccount').where({ id: corporateId }).first()).seatsUsed;

  const viaCorporate = await call(corporateProvisionStaff, { claims: hr.claims, body: { displayName: 'Asha Mollel', email: 'asha@hr2org.example.com', department: 'Operations' } });
  assert.equal(viaCorporate.statusCode, 200, JSON.stringify(viaCorporate.body));
  assert.equal(viaCorporate.body.employee.pinHash, undefined, 'the PIN hash never leaves the service');

  await flagOn(async () => {
    const list = await call(listB2BBeneficiaries, { claims: hr.claims, params: P });
    assert.equal(list.statusCode, 200, JSON.stringify(list.body));
    const asha = list.body.items.find(b => b.id === viaCorporate.body.employee.id);
    assert.deepEqual([asha.source, asha.readOnly, asha.email, asha.employeeStatus, asha.linked], ['corporate_employee', false, 'asha@hr2org.example.com', 'pending', false]);

    // Add from /org: a member by userId (linked, active) and someone by name only (unlinked, pending, PIN once).
    const member = await account('member', { displayName: 'Baraka Member' });
    const added = await call(enrollB2BBeneficiary, { claims: hr.claims, params: P, body: { userId: member, groupName: 'Finance', status: 'active' } });
    assert.equal(added.statusCode, 201, JSON.stringify(added.body));
    assert.deepEqual([added.body.writtenThrough, added.body.beneficiary.status, added.body.beneficiary.userId, added.body.beneficiary.groupName], ['corporate_staff', 'active', member, 'Finance']);
    assert.match(added.body.pin, /^\d{4}$/);
    assert.equal(added.body.beneficiary.pinHash, undefined);
    const nameOnly = await call(enrollB2BBeneficiary, { claims: hr.claims, params: P, body: { displayName: 'Chausiku Unlinked', email: 'nobody-yet@hr2org.example.com' } });
    assert.equal(nameOnly.statusCode, 201, JSON.stringify(nameOnly.body));
    assert.deepEqual([nameOnly.body.beneficiary.status, nameOnly.body.beneficiary.email], ['pending', 'nobody-yet@hr2org.example.com']);
    assert.equal('linked' in nameOnly.body.beneficiary || 'userId' in nameOnly.body.beneficiary, false, 'by contact the reply does not say whether they are a member');
    assert.equal(await seats(), 3);
    const names = (await staffNow()).map(e => e.displayName).sort();
    assert.deepEqual(names, ['Asha Mollel', 'Baraka Member', 'Chausiku Unlinked'], 'HR sees the same people in /corporate/staff');
    // Same member twice, and the seat limit, are refused like /corporate/staff.
    assert.deepEqual(await call(enrollB2BBeneficiary, { claims: hr.claims, params: P, body: { userId: member } }).then(r => [r.statusCode, r.body.error]), [409, 'already_enrolled']);
    assert.deepEqual(await call(enrollB2BBeneficiary, { claims: hr.claims, params: P, body: { displayName: 'One too many' } }).then(r => [r.statusCode, r.body.error]), [409, 'seat_limit_reached']);
    // A non-member account cannot be linked.
    const trainer = await account('trainer');
    assert.deepEqual(await call(enrollB2BBeneficiary, { claims: hr.claims, params: P, body: { userId: trainer, displayName: 'T' } }).then(r => [r.statusCode, r.body.error]), [400, 'beneficiary_must_be_member']);

    // Status: suspend, then remove (exited frees the seat).
    const empId = added.body.beneficiary.id;
    const suspended = await call(setB2BBeneficiaryStatus, { claims: hr.claims, params: { ...P, beneficiaryId: empId }, body: { status: 'suspended' } });
    assert.deepEqual([suspended.statusCode, suspended.body.beneficiary.status, suspended.body.beneficiary.employeeStatus], [200, 'suspended', 'suspended']);
    assert.deepEqual(await call(setB2BBeneficiaryStatus, { claims: hr.claims, params: { ...P, beneficiaryId: empId }, body: { status: 'pending' } }).then(r => [r.statusCode, r.body.error]), [409, 'invalid_transition']);
    const removed = await call(deactivateB2BBeneficiary, { claims: hr.claims, params: { ...P, beneficiaryId: empId } });
    assert.deepEqual([removed.statusCode, removed.body.beneficiary.status, removed.body.beneficiary.employeeStatus], [200, 'inactive', 'exited']);
    assert.equal(await seats(), 2);

    // Link and unlink an existing employee from /org.
    const other = await account('member');
    const linked = await call(linkB2BBeneficiaryAccount, { claims: hr.claims, params: { ...P, beneficiaryId: viaCorporate.body.employee.id }, body: { userId: other } });
    assert.deepEqual([linked.statusCode, linked.body.beneficiary.userId, linked.body.beneficiary.linked], [200, other, true]);
    const unlinked = await call(linkB2BBeneficiaryAccount, { claims: hr.claims, params: { ...P, beneficiaryId: viaCorporate.body.employee.id }, body: {} });
    assert.deepEqual([unlinked.statusCode, unlinked.body.beneficiary.userId], [200, null]);

    // An organisation user who is a member account (role hr) manages the same list.
    const access = await b2bService.resolveAccess({ organizationId: orgId, userId: (await admin()).sub, userType: 'admin' });
    const orgHr = await account('member');
    assert.equal((await b2bService.addOrganizationUser({ access, body: { userId: orgHr, role: 'hr' }, actorId: (await admin()).sub })).organizationUser.role, 'hr');
    const byOrgUser = await call(setB2BBeneficiaryStatus, { claims: { sub: orgHr, userType: 'member' }, params: { ...P, beneficiaryId: viaCorporate.body.employee.id }, body: { status: 'active' } });
    assert.deepEqual([byOrgUser.statusCode, byOrgUser.body.beneficiary.employeeStatus], [200, 'active']);
    // An analyst may read the list but sees no contact details and changes nothing.
    const analyst = await account('member');
    await b2bService.addOrganizationUser({ access, body: { userId: analyst, role: 'analyst' }, actorId: (await admin()).sub });
    const seen = await call(listB2BBeneficiaries, { claims: { sub: analyst, userType: 'member' }, params: P });
    assert.equal(seen.statusCode, 200);
    assert.equal(seen.body.items.every(b => !('email' in b) && !('phone' in b)), true);
    assert.equal((await call(enrollB2BBeneficiary, { claims: { sub: analyst, userType: 'member' }, params: P, body: { displayName: 'x' } })).statusCode, 403);
  });
});

test('people: flag on, importing into a company adds staff through the company path, is all-or-nothing on seats and adds nobody twice', async () => {
  const { corporateId, orgId, hr } = await company({ seatLimit: 3 });
  const P = { id: orgId };
  await flagOn(async () => {
    const rawText = 'name,email,phone,group\nDaudi One,daudi@hr2org.example.com,,Ops\nEsther Two,,0712000111,Ops';
    const dry = await call(importB2BBeneficiaries, { claims: hr.claims, params: P, body: { rawText, dryRun: true } });
    assert.equal(dry.statusCode, 200, JSON.stringify(dry.body));
    assert.deepEqual([dry.body.dryRun, dry.body.companyStaff, dry.body.enrolled, dry.body.invited], [true, true, 2, 0]);
    assert.equal((await db('CorporateEmployee').where({ corporateId })).length, 0);

    const done = await call(importB2BBeneficiaries, { claims: hr.claims, params: P, body: { rawText } });
    assert.equal(done.statusCode, 200, JSON.stringify(done.body));
    assert.deepEqual([done.body.enrolled, done.body.invited, done.body.credentials.length], [2, 0, 2], 'a PIN for every row added');
    assert.equal(done.body.credentials.every(c => /^\d{4}$/.test(c.pin)), true);
    const staff = await db('CorporateEmployee').where({ corporateId }).orderBy('displayName');
    assert.deepEqual(staff.map(e => [e.displayName, e.department, e.status]), [['Daudi One', 'Ops', 'pending'], ['Esther Two', 'Ops', 'pending']]);
    assert.equal((await db('B2BBeneficiaryInvite').where({ organizationId: orgId })).length, 0, 'nobody is invited for a company');
    const stored = await db('B2BBeneficiaryImport').where({ id: done.body.importId }).first();
    assert.equal(JSON.stringify(stored).includes(done.body.credentials[0].pin) && stored.problems.includes('pin'), false, 'PINs are not stored with the import');

    const again = await call(importB2BBeneficiaries, { claims: hr.claims, params: P, body: { rawText } });
    assert.deepEqual([again.body.enrolled, again.body.unchanged], [0, 2]);
    const tooMany = await call(importB2BBeneficiaries, { claims: hr.claims, params: P, body: { rawText: 'name,email\nF,f@hr2org.example.com\nG,g@hr2org.example.com' } });
    assert.deepEqual([tooMany.statusCode, tooMany.body.error, tooMany.body.seatsAvailable], [409, 'seat_limit_reached', 1]);
    assert.equal((await db('CorporateEmployee').where({ corporateId })).length, 2);
  });
});

// ── 4. Challenges, rewards and groups: same from /org and /corporate ────────

test('engagement: the company\'s challenges, groups and rewards are the same from /org and /corporate', async () => {
  const { corporateId, orgId, hr } = await company();
  await hrOrgConversionService.run({ dryRun: false, corporateId });
  await flagOn(async () => {
    const today = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
    const created = await call(challengeRoutes.corporateCreateChallenge, { claims: hr.claims, body: { name: 'HR2Org steps', type: 'steps', target: 1000, startDate: today, endDate: today } });
    assert.equal(created.statusCode, 201, JSON.stringify(created.body));
    made.challenges.push(created.body.challenge.id);
    const fromOrg = await call(challengeRoutes.organizationChallenges, { claims: hr.claims, params: { organizationId: orgId } });
    assert.equal(fromOrg.statusCode, 200, JSON.stringify(fromOrg.body));
    assert.ok(fromOrg.body.challenges.some(c => c.id === created.body.challenge.id));
    assert.deepEqual([fromOrg.body.challenges[0].creatorType, fromOrg.body.challenges[0].creatorId], ['corporate', corporateId]);

    const group = await call(groupRoutes.organizationCreateGroup, { claims: hr.claims, params: { organizationId: orgId }, body: { name: 'HR2Org group', joinPolicy: 'open' } });
    assert.equal(group.statusCode, 201, JSON.stringify(group.body));
    made.groups.push(group.body.group.id);
    const fromCorp = await call(groupRoutes.corporateGroups, { claims: hr.claims });
    assert.ok(fromCorp.body.groups.some(g => g.id === group.body.group.id), 'a group made from /org is the company\'s');

    const orgRewards = await call(rewardRoutes.organizationRewards, { claims: hr.claims, params: { organizationId: orgId } });
    const corpRewards = await call(rewardRoutes.corporateRewards, { claims: hr.claims });
    assert.deepEqual([orgRewards.statusCode, corpRewards.statusCode], [200, 200]);
    assert.deepEqual(orgRewards.body, corpRewards.body);
  });
});

// ── 5. Tenancy ───────────────────────────────────────────────────────────────

test('tenancy: flag on, a company HR login reaches only its own company, even with a row planted elsewhere', async () => {
  const a = await company();
  const b = await company();
  await hrOrgConversionService.run({ dryRun: false, corporateId: a.corporateId });
  const bStaff = await call(corporateProvisionStaff, { claims: b.hr.claims, body: { displayName: 'B staff' } });
  // A native organisation, and a row for A's HR login planted straight into B's organisation and the native one.
  const created = await call(adminCreateB2BOrganization, { claims: await admin(), body: { organizationType: 'insurer', legalName: `HR2Org insurer ${uid('o')}` } });
  const native = created.body.organization.id;
  made.orgs.push(native);
  await call(adminSetB2BOrganizationStatus, { claims: await admin(), params: { id: native }, body: { status: 'active' } });
  for (const organizationId of [b.orgId, native]) {
    await db('B2BOrganizationUser').insert({ id: uid('b2bu'), organizationId, userId: a.hr.id, role: 'admin', permissions: [], status: 'active', createdBy: 'spec', createdAt: new Date(), updatedAt: new Date() });
  }

  await flagOn(async () => {
    const mine = await call(myB2BOrganizations, { claims: a.hr.claims });
    assert.deepEqual(mine.body.organizations.map(o => [o.id, o.role]), [[a.orgId, 'hr']]);
    for (const id of [b.orgId, native]) {
      assert.equal((await call(getB2BOrganization, { claims: a.hr.claims, params: { id } })).statusCode, 404);
      assert.equal((await call(listB2BBeneficiaries, { claims: a.hr.claims, params: { id } })).statusCode, 404);
    }
    // B's employee through A's organisation, and through the corporate routes: not found.
    assert.equal((await call(setB2BBeneficiaryStatus, { claims: a.hr.claims, params: { id: a.orgId, beneficiaryId: bStaff.body.employee.id }, body: { status: 'active' } })).statusCode, 404);
    assert.equal((await call(linkB2BBeneficiaryAccount, { claims: a.hr.claims, params: { id: a.orgId, beneficiaryId: bStaff.body.employee.id }, body: {} })).statusCode, 404);
    assert.equal((await call(corporateSetStaffStatus, { claims: a.hr.claims, params: { id: bStaff.body.employee.id }, body: { status: 'active' } })).statusCode, 404);
    assert.equal((await call(challengeRoutes.organizationChallenges, { claims: a.hr.claims, params: { organizationId: b.orgId } })).statusCode, 404);
    // Nobody can add A's HR login to another organisation.
    const add = await call(addB2BOrganizationUser, { claims: await admin(), params: { id: native }, body: { userId: b.hr.id, role: 'hr' } });
    assert.deepEqual([add.statusCode, add.body.error], [409, 'hr_login_other_company']);
    // A suspended HR login reaches nothing, row or not.
    await call(adminSetHrUserStatus, { claims: await admin(), params: { id: a.corporateId, userId: a.hr.id }, body: { status: 'suspended' } });
    assert.equal((await b2bService.resolveAccess({ organizationId: a.orgId, userId: a.hr.id, userType: 'corporate_hr' })).status, 404);
    assert.deepEqual((await b2bService.listMyOrganizations({ userId: a.hr.id, userType: 'corporate_hr' })).organizations, []);
  });
});

test('tenancy: flag on, once converted the organisation\'s row decides — removing the HR user in /org closes /org for that login', async () => {
  const { corporateId, orgId, hr } = await company();
  await hrOrgConversionService.run({ dryRun: false, corporateId });
  const row = await db('B2BOrganizationUser').where({ userId: hr.id }).first();
  await flagOn(async () => {
    // Listed once, as an editable organisation user.
    const users = await call(listB2BOrganizationUsers, { claims: await admin(), params: { id: orgId } });
    assert.deepEqual(users.body.items.filter(u => u.userId === hr.id).map(u => [u.source, u.readOnly]), [['b2b', false]]);
    assert.equal((await call(updateB2BOrganizationUser, { claims: await admin(), params: { id: orgId, orgUserId: row.id }, body: { status: 'suspended' } })).statusCode, 200);
    assert.equal((await call(getB2BOrganization, { claims: hr.claims, params: { id: orgId } })).statusCode, 404);
    // /corporate is unchanged: still the company's HR login there until /hr goes.
    assert.equal((await call(corporateListStaff, { claims: hr.claims })).statusCode, 200);
  });
});

// ── 6. Flag off: nothing changes ─────────────────────────────────────────────

test('flag off: people of a company stay read-only in /org (managed_by_corporate), the link route is 404, the HR login is listed once', async () => {
  const { corporateId, orgId, hr } = await company();
  const emp = await call(corporateProvisionStaff, { claims: hr.claims, body: { displayName: 'Flag off', email: 'off@hr2org.example.com' } });
  await hrOrgConversionService.run({ dryRun: false, corporateId });
  await flagOff(async () => {
    const P = { id: orgId };
    const list = await call(listB2BBeneficiaries, { claims: hr.claims, params: P });
    const row = list.body.items.find(b => b.id === emp.body.employee.id);
    assert.deepEqual([row.readOnly, 'email' in row, 'employeeStatus' in row], [true, false, false]);
    assert.deepEqual(await call(enrollB2BBeneficiary, { claims: hr.claims, params: P, body: { displayName: 'x' } }).then(r => [r.statusCode, r.body.error, r.body.use]), [409, 'managed_by_corporate', '/corporate/staff']);
    assert.deepEqual(await call(setB2BBeneficiaryStatus, { claims: hr.claims, params: { ...P, beneficiaryId: emp.body.employee.id }, body: { status: 'active' } }).then(r => [r.statusCode, r.body.error]), [409, 'managed_by_corporate']);
    assert.deepEqual(await call(importB2BBeneficiaries, { claims: hr.claims, params: P, body: { rawText: 'name,email\nA,a@hr2org.example.com' } }).then(r => [r.statusCode, r.body.error]), [409, 'managed_by_corporate']);
    assert.equal((await call(linkB2BBeneficiaryAccount, { claims: hr.claims, params: { ...P, beneficiaryId: emp.body.employee.id }, body: {} })).statusCode, 404);
    const users = await call(listB2BOrganizationUsers, { claims: await admin(), params: P });
    assert.equal(users.body.items.filter(u => u.userId === hr.id).length, 1);
    // The HR login still opens its organisation with role hr, as before.
    const mine = await call(myB2BOrganizations, { claims: hr.claims });
    assert.deepEqual(mine.body.organizations.map(o => [o.id, o.role]), [[orgId, 'hr']]);
  });
});

// ── Security review fixes (functions#252) ───────────────────────────────────

test('review 2: flag off, a converted HR row that is suspended or removed closes /org (the read-through no longer overrules it)', async () => {
  const { corporateId, orgId, hr } = await company();
  await hrOrgConversionService.run({ dryRun: false, corporateId });
  const row = await db('B2BOrganizationUser').where({ userId: hr.id }).first();
  await flagOff(async () => {
    assert.equal((await call(getB2BOrganization, { claims: hr.claims, params: { id: orgId } })).statusCode, 200);
    for (const status of ['suspended', 'removed']) {
      const r = await call(updateB2BOrganizationUser, { claims: await admin(), params: { id: orgId, orgUserId: row.id }, body: { status: status === 'removed' ? 'suspended' : status } });
      if (status === 'removed') await db('B2BOrganizationUser').where({ id: row.id }).update({ status: 'removed', removedAt: new Date() });
      else assert.equal(r.statusCode, 200, JSON.stringify(r.body));
      assert.equal((await call(getB2BOrganization, { claims: hr.claims, params: { id: orgId } })).statusCode, 404, status);
      assert.deepEqual((await call(myB2BOrganizations, { claims: hr.claims })).body.organizations, [], status);
    }
    // An HR login without a row of its own still gets the read-through, as before.
    const other = await company();
    assert.equal((await call(getB2BOrganization, { claims: other.hr.claims, params: { id: other.orgId } })).statusCode, 200);
  });
});

test('review 3: the script refuses --apply unless --db names the connected database', async () => {
  const { corporateId, hr } = await company();
  const script = fileURLToPath(new URL('../scripts/hr-to-org.mjs', import.meta.url));
  const run = (...extra) => spawnSync(process.execPath, [script, `--corporate=${corporateId}`, ...extra], { env: { ...process.env, FITFLEX_USE_CI_DB: '1' }, encoding: 'utf8', timeout: 60_000 });
  const ciName = new URL(process.env.DATABASE_URL_CI).pathname.slice(1);

  const missing = run('--apply');
  assert.equal(missing.status, 2, missing.stderr);
  assert.match(missing.stderr, new RegExp(`refused: --apply needs --db=${ciName}`));
  const wrong = run('--apply', '--db=fitflex');
  assert.equal(wrong.status, 2, wrong.stderr);
  assert.match(wrong.stderr, /got --db=fitflex\. Nothing written/);
  assert.equal((await db('B2BOrganizationUser').where({ userId: hr.id })).length, 0, 'refused runs write nothing');

  const ok = run('--apply', `--db=${ciName}`);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, /APPLY \(writes\)/);
  assert.deepEqual((await db('B2BOrganizationUser').where({ userId: hr.id })).map(r => r.role), ['hr']);
});

test('review 4: adding by name and contact answers the same whether or not a confirmed member is behind the contact', async () => {
  const { orgId, hr } = await company();
  const P = { id: orgId };
  const memberEmail = `${uid('m')}@hr2org.example.com`;
  const member = await account('member', { email: memberEmail });
  await verifyContacts(db, member, { email: memberEmail });
  await flagOn(async () => {
    const shape = r => ({ statusCode: r.statusCode, keys: Object.keys(r.body).sort(), beneficiaryKeys: Object.keys(r.body.beneficiary ?? {}).sort(), status: r.body.beneficiary?.status });
    const withMember = await call(enrollB2BBeneficiary, { claims: hr.claims, params: P, body: { displayName: 'Has account', email: memberEmail, status: 'active' } });
    const withoutMember = await call(enrollB2BBeneficiary, { claims: hr.claims, params: P, body: { displayName: 'No account', email: `${uid('n')}@hr2org.example.com`, status: 'active' } });
    assert.equal(withMember.statusCode, 201, JSON.stringify(withMember.body));
    assert.deepEqual(shape(withMember), shape(withoutMember));
    assert.equal('linked' in withMember.body.beneficiary || 'userId' in withMember.body.beneficiary, false);
    // It was linked all the same.
    assert.equal((await db('CorporateEmployee').where({ id: withMember.body.beneficiary.id }).first()).userId, member);
    // By contact without a name: refused before any lookup, the same for both.
    const a = await call(enrollB2BBeneficiary, { claims: hr.claims, params: P, body: { phone: '0712999888' } });
    const b = await call(enrollB2BBeneficiary, { claims: hr.claims, params: P, body: { email: memberEmail } });
    assert.deepEqual([a.statusCode, a.body.error, b.statusCode, b.body.error], [400, 'display_name_required', 400, 'display_name_required']);
  });
});

test('session marks endpoint: an already signed-in HR session learns the sign-in fields; flag off or another caller gets orgOnlySponsors only', async () => {
  const { corporateId, orgId, hr } = await company();
  const login = () => call(authLogin, { body: { email: hr.email, password: hr.password, requestedRole: 'corporate_hr' } });
  const marks = claims => call(myB2BOrganizationSession, { claims });
  const pick = u => ({ organizationUser: u.organizationUser, organizationRoles: u.organizationRoles, organizationIds: u.organizationIds });

  assert.equal((await marks()).statusCode, 401);
  const off = await flagOff(() => marks(hr.claims));
  assert.deepEqual([off.statusCode, off.body], [200, { orgOnlySponsors: false }]);

  for (const step of ['read-through', 'converted']) {
    if (step === 'converted') await hrOrgConversionService.run({ dryRun: false, corporateId });
    const [on, signIn] = await flagOn(async () => [await marks(hr.claims), await login()]);
    assert.equal(on.statusCode, 200);
    assert.deepEqual(on.body, { orgOnlySponsors: true, organizationUser: true, organizationRoles: ['hr'], organizationIds: [orgId] }, step);
    assert.deepEqual(pick(on.body), pick(signIn.body.user), 'same as the sign-in response');
  }
  // A member, and an HR login whose row was removed: the flag only.
  const member = await account('member');
  assert.deepEqual((await flagOn(() => marks({ sub: member, userType: 'member' }))).body, { orgOnlySponsors: true });
  await db('B2BOrganizationUser').where({ userId: hr.id }).update({ status: 'removed', removedAt: new Date() });
  assert.deepEqual((await flagOn(() => marks(hr.claims))).body, { orgOnlySponsors: true });
});
