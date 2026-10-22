// A member must accept before an organisation adds them by user id
// (security fix, owner decision 22 Oct 2026; privacy ruling A-02).
// Against the CI database.
//
// A user id proves nothing (ids show in feeds and groups). An organisation
// user or a company's HR naming a member only by id makes a request; nothing
// is enrolled, linked or granted, and no activity is shown, until the member
// accepts. FitFlex platform admins still add directly; a verified email or
// number still adds directly (unchanged, reported to the owner).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureInit } from '../functions/index.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { b2bService, corporateService, b2bMemberRequestService as requests, b2bAnalyticsService as analytics } from '../src/bootstrap/services.mjs';
import { memberRequestTtlDays } from '../src/services/b2b-member-request-service.mjs';
import { localDay, addDays } from '../src/shared/member-progress.mjs';
import { verifyContacts, purgeIdentity } from './fixtures/verified-contacts.mjs';

await ensureInit();

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], orgs: [], corporates: [], activities: [] };
const SYSTEM = 'system:b2b-member-requests';
const TODAY = localDay(new Date());
const RANGE = { from: addDays(TODAY, -6), to: TODAY };

async function user(userType, name = `Consent ${userType}`) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: name, updatedAt: new Date() });
  made.users.push(id);
  return id;
}
const ADMIN = { userType: 'admin', userId: await user('admin') };

async function organisation(name = 'Consent insurer') {
  const { organization } = await b2bService.createOrganization({ body: { organizationType: 'insurer', legalName: `${name} ${uid('o')}` }, actorId: ADMIN.userId });
  made.orgs.push(organization.id);
  await b2bService.setOrganizationStatus({ organizationId: organization.id, status: 'active', actorId: ADMIN.userId });
  return organization;
}
const adminAccess = orgId => b2bService.resolveAccess({ organizationId: orgId, ...ADMIN });
const as = (orgId, userId) => b2bService.resolveAccess({ organizationId: orgId, userId, userType: 'member' });

/** An organisation user with this role (added by FitFlex, directly). */
async function orgUser(orgId, role) {
  const id = await user('member', `Org ${role}`);
  const out = await b2bService.addOrganizationUser({ access: await adminAccess(orgId), body: { userId: id, role }, actorId: ADMIN.userId });
  assert.ok(out.organizationUser, JSON.stringify(out));
  return id;
}
async function activity(userId) {
  const id = uid('act');
  await db('Activity').insert({ id, userId, type: 'running', source: 'manual', startedAt: new Date(Date.now() - 3_600_000), durationMinutes: 30, steps: 4200 });
  made.activities.push(id);
}
const audits = target => db('AuditLog').where({ target }).orderBy('at').pluck('action');
const row = id => db('B2BMemberRequest').where({ id }).first();

after(async () => {
  await db('Activity').whereIn('id', made.activities).del();
  await db('B2BMemberRequest').whereIn('userId', made.users).del();
  await db('Notification').whereIn('userId', made.users).del();
  await db('CommunicationPreference').whereIn('id', made.users).del();
  if (made.corporates.length) {
    await db('B2BOrganization').whereIn('legacyCorporateId', made.corporates).del();
    await db('CorporateEmployee').whereIn('corporateId', made.corporates).del();
    await db('CorporateAccount').whereIn('id', made.corporates).del();
  }
  if (made.orgs.length) {
    await db('B2BBeneficiary').whereIn('organizationId', made.orgs).del();
    await db('B2BOrganizationUser').whereIn('organizationId', made.orgs).del();
    await db('B2BOrganization').whereIn('id', made.orgs).del();
  }
  await db('AuditLog').whereIn('actor', [...made.users, SYSTEM]).del();
  const persons = await purgeIdentity(db, made.users);
  await db('User').whereIn('id', made.users).del();
  if (persons?.length) await db('Person').whereIn('id', persons).del().catch(() => {});
});

test('the database really is the CI database', async () => {
  assert.equal(process.env.FITFLEX_USE_CI_DB, '1');
  const { rows: [{ name }] } = await db.raw('select current_database() as name');
  assert.match(name, /_ci/);
});

test('an organisation user enrolling a member by user id makes a request: nothing enrolled, shown or charged until they accept', async () => {
  const org = await organisation();
  const manager = await orgUser(org.id, 'manager');
  const access = await as(org.id, manager);
  const member = await user('member', 'Consent Asha');
  await activity(member);

  const asked = await b2bService.enrollBeneficiary({ access, actorId: manager, body: { userId: member, status: 'active', groupName: 'Gold', externalReference: 'POL-77' } });
  assert.equal(asked.outcome, 'pending_member_acceptance');
  assert.equal(asked.beneficiary, undefined);
  const req = asked.memberRequest;
  assert.deepEqual([req.kind, req.status, req.userId, req.displayName, req.groupName, req.beneficiaryStatus], ['beneficiary', 'pending_member_acceptance', member, 'Consent Asha', 'Gold', 'active']);
  assert.ok(new Date(req.expiresAt) > new Date(Date.now() + 13 * 86_400_000));

  // The organisation sees the request, and nothing else of the member.
  assert.equal(await db('B2BBeneficiary').where({ organizationId: org.id, userId: member }).first(), undefined);
  const list = await b2bService.listBeneficiaries({ access });
  assert.deepEqual([list.total, list.pendingMemberAcceptance.map(r => r.userId)], [0, [member]]);
  assert.equal((await b2bService.allBeneficiaries(org)).length, 0);
  const people = await analytics.people({ access: await adminAccess(org.id), query: RANGE });
  assert.equal(people.total, 0);
  assert.deepEqual(await b2bService.beneficiaryRelationshipsForUser(member), []);
  // Asking again while it is open is refused, with the open request.
  const again = await b2bService.enrollBeneficiary({ access, actorId: manager, body: { userId: member } });
  assert.deepEqual([again.error, again.status, again.memberRequestId], ['member_request_pending', 409, req.id]);

  // The member is told, in English with Swahili alongside, and linked to the request.
  const note = await db('Notification').where({ userId: member, type: 'b2b_member_request' }).first();
  assert.ok(note, 'notification written');
  const data = typeof note.data === 'string' ? JSON.parse(note.data) : note.data;
  assert.deepEqual([data.requestId, data.kind, data.organizationId, data.open, data.locale], [req.id, 'beneficiary', org.id, 'b2b_member_requests', 'en']);
  assert.ok(data.titleSw && data.bodySw && data.titleEn && data.bodyEn);
  assert.equal(note.title, data.titleEn);

  // The member's list says who is asking and what they will see.
  const mine = await requests.listForMember({ userId: member });
  assert.equal(mine.items.length, 1);
  const item = mine.items[0];
  assert.deepEqual([item.id, item.kind, item.organization.id, item.groupName], [req.id, 'beneficiary', org.id, 'Gold']);
  assert.ok(item.visibility.shown.includes('workouts') && item.visibility.notShown.includes('weight'));
  assert.ok(item.visibility.en.length > 20 && item.visibility.sw.length > 20);
  assert.ok(Array.isArray(item.benefits));
  assert.deepEqual(await audits(req.id), ['b2b.member_request.create']);
});

test('the member is told in Swahili when that is their chosen language', async () => {
  const org = await organisation();
  const manager = await orgUser(org.id, 'manager');
  const member = await user('member');
  await db('CommunicationPreference').insert({ id: member, locale: 'sw' });
  await b2bService.enrollBeneficiary({ access: await as(org.id, manager), actorId: manager, body: { userId: member } });
  const note = await db('Notification').where({ userId: member, type: 'b2b_member_request' }).first();
  const data = typeof note.data === 'string' ? JSON.parse(note.data) : note.data;
  assert.deepEqual([data.locale, note.title, note.body], ['sw', data.titleSw, data.bodySw]);
  assert.match(note.title, /inataka kukuongeza/);
});

test('accepting enrols the member as asked and their activity becomes visible; a second accept is refused', async () => {
  const org = await organisation();
  const manager = await orgUser(org.id, 'manager');
  const member = await user('member', 'Consent Juma');
  await activity(member);
  const { memberRequest } = await b2bService.enrollBeneficiary({ access: await as(org.id, manager), actorId: manager, body: { userId: member, status: 'active', groupName: 'Silver' } });

  const accepted = await requests.accept({ userId: member, requestId: memberRequest.id });
  assert.ok(!accepted.error, JSON.stringify(accepted));
  assert.deepEqual([accepted.memberRequest.status, accepted.beneficiary.status, accepted.beneficiary.groupName, accepted.beneficiary.userId], ['accepted', 'active', 'Silver', member]);
  assert.equal((await row(memberRequest.id)).resultId, accepted.beneficiary.id);
  const enrolAudit = await db('AuditLog').where({ target: accepted.beneficiary.id, action: 'b2b.beneficiary.enroll' }).first();
  assert.equal(enrolAudit.actor, manager);
  assert.equal((typeof enrolAudit.after === 'string' ? JSON.parse(enrolAudit.after) : enrolAudit.after).memberRequestId, memberRequest.id);

  const people = await analytics.people({ access: await adminAccess(org.id), query: RANGE });
  assert.deepEqual(people.items.map(p => [p.name, p.status, p.activities, p.steps]), [['Consent Juma', 'active', 1, 4200]]);
  const list = await b2bService.listBeneficiaries({ access: await as(org.id, manager) });
  assert.deepEqual([list.total, list.pendingMemberAcceptance.length], [1, 0]);

  const twice = await requests.accept({ userId: member, requestId: memberRequest.id });
  assert.deepEqual([twice.error, twice.status], ['member_request_not_pending', 409]);
  assert.equal((await requests.decline({ userId: member, requestId: memberRequest.id })).status, 409);
  assert.equal(await db('B2BBeneficiary').where({ organizationId: org.id, userId: member }).count({ c: '*' }).then(([r]) => Number(r.c)), 1);
  assert.deepEqual(await audits(memberRequest.id), ['b2b.member_request.create', 'b2b.member_request.accept']);
});

test('two accepts at the same moment enrol once', async () => {
  const org = await organisation();
  const manager = await orgUser(org.id, 'manager');
  const member = await user('member');
  const { memberRequest } = await b2bService.enrollBeneficiary({ access: await as(org.id, manager), actorId: manager, body: { userId: member } });
  const outs = await Promise.all([1, 2, 3].map(() => requests.accept({ userId: member, requestId: memberRequest.id })));
  assert.equal(outs.filter(o => !o.error).length, 1, JSON.stringify(outs));
  assert.ok(outs.filter(o => o.error).every(o => o.error === 'member_request_not_pending'));
  assert.equal(await db('B2BBeneficiary').where({ organizationId: org.id, userId: member }).count({ c: '*' }).then(([r]) => Number(r.c)), 1);
});

test('another member can neither see, accept nor decline the request', async () => {
  const org = await organisation();
  const manager = await orgUser(org.id, 'manager');
  const member = await user('member');
  const intruder = await user('member');
  const { memberRequest } = await b2bService.enrollBeneficiary({ access: await as(org.id, manager), actorId: manager, body: { userId: member } });
  assert.deepEqual((await requests.listForMember({ userId: intruder })).items, []);
  assert.deepEqual(await requests.accept({ userId: intruder, requestId: memberRequest.id }).then(r => [r.error, r.status]), ['member_request_not_found', 404]);
  assert.deepEqual(await requests.decline({ userId: intruder, requestId: memberRequest.id }).then(r => [r.error, r.status]), ['member_request_not_found', 404]);
  assert.equal((await row(memberRequest.id)).status, 'pending');
  assert.equal(await db('B2BBeneficiary').where({ organizationId: org.id }).first(), undefined);
});

test('declining adds nothing; the organisation may ask again later', async () => {
  const org = await organisation();
  const manager = await orgUser(org.id, 'manager');
  const access = await as(org.id, manager);
  const member = await user('member');
  const { memberRequest } = await b2bService.enrollBeneficiary({ access, actorId: manager, body: { userId: member } });
  const declined = await requests.decline({ userId: member, requestId: memberRequest.id });
  assert.equal(declined.memberRequest.status, 'declined');
  assert.equal(await db('B2BBeneficiary').where({ organizationId: org.id }).first(), undefined);
  assert.deepEqual((await b2bService.listBeneficiaries({ access })).pendingMemberAcceptance, []);
  assert.deepEqual((await requests.listForMember({ userId: member })).items, []);
  assert.equal((await requests.accept({ userId: member, requestId: memberRequest.id })).status, 409);
  assert.deepEqual(await audits(memberRequest.id), ['b2b.member_request.create', 'b2b.member_request.decline']);
  assert.equal((await b2bService.enrollBeneficiary({ access, actorId: manager, body: { userId: member } })).outcome, 'pending_member_acceptance');
});

test('a request expires: it can no longer be accepted, the expiry is audited, and a new one may be made', async () => {
  assert.equal(memberRequestTtlDays({}), 14);
  assert.equal(memberRequestTtlDays({ B2B_MEMBER_REQUEST_TTL_DAYS: '3' }), 3);
  assert.equal(memberRequestTtlDays({ B2B_MEMBER_REQUEST_TTL_DAYS: 'nonsense' }), 14);
  const org = await organisation();
  const manager = await orgUser(org.id, 'manager');
  const access = await as(org.id, manager);
  const member = await user('member');
  const other = await user('member');
  const { memberRequest } = await b2bService.enrollBeneficiary({ access, actorId: manager, body: { userId: member } });
  const second = (await b2bService.enrollBeneficiary({ access, actorId: manager, body: { userId: other } })).memberRequest;
  await db('B2BMemberRequest').whereIn('id', [memberRequest.id, second.id]).update({ expiresAt: new Date(Date.now() - 1000) });

  assert.deepEqual((await b2bService.listBeneficiaries({ access })).pendingMemberAcceptance, []);   // not shown once past expiry
  assert.deepEqual(await requests.accept({ userId: member, requestId: memberRequest.id }).then(r => [r.error, r.status]), ['member_request_expired', 410]);
  assert.equal((await row(memberRequest.id)).status, 'expired');
  assert.equal(await db('B2BBeneficiary').where({ organizationId: org.id }).first(), undefined);
  assert.deepEqual(await audits(memberRequest.id), ['b2b.member_request.create', 'b2b.member_request.expire']);
  // The sweep (job b2b-member-request-expiry) closes the rest.
  assert.ok((await requests.expireDue()).expired >= 1);
  assert.equal((await row(second.id)).status, 'expired');
  assert.equal((await b2bService.enrollBeneficiary({ access, actorId: manager, body: { userId: member } })).outcome, 'pending_member_acceptance');
});

test('an organisation role by user id is not granted until the person accepts', async () => {
  const org = await organisation();
  const owner = await orgUser(org.id, 'owner');
  const person = await user('member', 'Consent Finance');
  const asked = await b2bService.addOrganizationUser({ access: await as(org.id, owner), actorId: owner, body: { userId: person, role: 'finance' } });
  assert.deepEqual([asked.outcome, asked.memberRequest.kind, asked.memberRequest.role], ['pending_member_acceptance', 'org_user', 'finance']);
  assert.equal((await as(org.id, person)).status, 404);
  assert.deepEqual((await b2bService.listMyOrganizations({ userId: person, userType: 'member' })).organizations, []);
  const users = await b2bService.listOrganizationUsers({ access: await as(org.id, owner) });
  assert.deepEqual([users.items.map(u => u.userId).includes(person), users.pendingMemberAcceptance.map(u => u.userId)], [false, [person]]);
  const item = (await requests.listForMember({ userId: person })).items[0];
  assert.deepEqual([item.kind, item.role, item.visibility.shown], ['org_user', 'finance', ['name', 'email', 'role']]);

  const accepted = await requests.accept({ userId: person, requestId: asked.memberRequest.id });
  assert.equal(accepted.organizationUser.role, 'finance', JSON.stringify(accepted));
  const now = await as(org.id, person);
  assert.deepEqual([now.role, now.permissions.includes('billing.read')], ['finance', true]);
});

test('if the requester has lost the right to add people by the time the member accepts, nothing is added and the request closes', async () => {
  const org = await organisation();
  const owner = await orgUser(org.id, 'owner');
  const manager = await orgUser(org.id, 'manager');
  const member = await user('member');
  const { memberRequest } = await b2bService.enrollBeneficiary({ access: await as(org.id, manager), actorId: manager, body: { userId: member } });
  const seat = (await db('B2BOrganizationUser').where({ organizationId: org.id, userId: manager }).first()).id;
  await b2bService.removeOrganizationUser({ access: await as(org.id, owner), organizationUserId: seat, actorId: owner });
  const out = await requests.accept({ userId: member, requestId: memberRequest.id });
  assert.deepEqual([out.error, out.status], ['request_no_longer_valid', 409]);
  assert.deepEqual([(await row(memberRequest.id)).status, (await row(memberRequest.id)).reason], ['cancelled', 'request_no_longer_valid']);
  assert.equal(await db('B2BBeneficiary').where({ organizationId: org.id }).first(), undefined);
});

test('the organisation can withdraw an open request; only for its own requests and with the right permission', async () => {
  const org = await organisation();
  const otherOrg = await organisation('Other insurer');
  const manager = await orgUser(org.id, 'manager');
  const viewer = await orgUser(org.id, 'viewer');
  const member = await user('member');
  const { memberRequest } = await b2bService.enrollBeneficiary({ access: await as(org.id, manager), actorId: manager, body: { userId: member } });
  assert.equal((await requests.cancel({ access: await adminAccess(otherOrg.id), requestId: memberRequest.id, actorId: ADMIN.userId })).status, 404);
  assert.equal((await requests.cancel({ access: await as(org.id, viewer), requestId: memberRequest.id, actorId: viewer })).status, 403);
  const out = await requests.cancel({ access: await as(org.id, manager), requestId: memberRequest.id, actorId: manager });
  assert.equal(out.memberRequest.status, 'cancelled');
  assert.equal((await requests.accept({ userId: member, requestId: memberRequest.id })).status, 409);
  assert.deepEqual(await audits(memberRequest.id), ['b2b.member_request.create', 'b2b.member_request.cancel']);
});

test('FitFlex platform admins still add by user id directly; a verified email or number still adds directly (unchanged)', async () => {
  const org = await organisation();
  const member = await user('member');
  const direct = await b2bService.enrollBeneficiary({ access: await adminAccess(org.id), actorId: ADMIN.userId, body: { userId: member, status: 'active' } });
  assert.equal(direct.beneficiary.status, 'active');
  assert.equal(await db('B2BMemberRequest').where({ userId: member }).first(), undefined);

  const manager = await orgUser(org.id, 'manager');
  const email = `consent.${randomUUID().slice(0, 6)}@consent.test`;
  const byContact = await user('member');
  await db('User').where({ id: byContact }).update({ email });
  await verifyContacts(db, byContact, { email });
  const added = await b2bService.enrollBeneficiary({ access: await as(org.id, manager), actorId: manager, body: { email } });
  assert.equal(added.beneficiary?.userId, byContact, JSON.stringify(added));
});

test('HR linking a staff record by user id waits for the member; the company sees nothing until then', async () => {
  const { account } = await corporateService.onboard({ body: { companyName: `Consent Corp ${uid('c')}`, industrySector: 'banking', workforceBracket: '50-100', subsidyModel: 'fully_funded', passTier: 'pro', seatLimit: 5 }, actorId: ADMIN.userId });
  made.corporates.push(account.id);
  await corporateService.setStatus({ corporateId: account.id, status: 'active', actorId: ADMIN.userId });
  const { employee } = await corporateService.provisionStaff({ corporateId: account.id, body: { displayName: 'Consent Zawadi', department: 'Finance' }, actorId: ADMIN.userId });
  await corporateService.setEmployeeStatus({ corporateId: account.id, employeeId: employee.id, status: 'active', actorId: ADMIN.userId });
  const hr = (await corporateService.createHrUser({ corporateId: account.id, body: { displayName: 'Consent HR', email: `${uid('hr')}@consent.test`, password: 'consent-password-1' }, actorId: ADMIN.userId })).hrUser;
  made.users.push(hr.id);
  const member = await user('member', 'Consent Zawadi');
  await activity(member);

  const asked = await corporateService.linkEmployeeUser({ corporateId: account.id, employeeId: employee.id, userId: member, actorId: hr.id, actorType: 'corporate_hr' });
  assert.deepEqual([asked.outcome, asked.memberRequest.kind, asked.memberRequest.employeeId], ['pending_member_acceptance', 'employee_link', employee.id]);
  assert.equal((await db('CorporateEmployee').where({ id: employee.id }).first()).userId, null);
  const orgId = (await b2bService.organizationForCorporate({ corporateId: account.id })).organization.id;
  const hrAccess = await b2bService.resolveAccess({ organizationId: orgId, userId: hr.id, userType: 'corporate_hr' });
  const before = await analytics.people({ access: hrAccess, query: RANGE });
  assert.deepEqual(before.items.map(p => [p.linkedToAccount, p.activities]), [[false, 0]]);
  const item = (await requests.listForMember({ userId: member })).items[0];
  assert.deepEqual([item.kind, item.organization.corporateId, item.organization.name, item.sponsor.passTier], ['employee_link', account.id, account.companyName, 'pro']);

  const accepted = await requests.accept({ userId: member, requestId: asked.memberRequest.id });
  assert.equal(accepted.employee?.userId, member, JSON.stringify(accepted));
  const afterAccept = await analytics.people({ access: hrAccess, query: RANGE });
  assert.deepEqual(afterAccept.items.map(p => [p.linkedToAccount, p.activities]), [[true, 1]]);
  assert.deepEqual(await audits(asked.memberRequest.id), ['b2b.member_request.create', 'b2b.member_request.accept']);
});

test('A-02: an organisation sees no personal activity of someone pending or no longer enrolled', async () => {
  const org = await organisation();
  const admin = await adminAccess(org.id);
  const member = await user('member', 'Consent Neema');
  await activity(member);
  const { beneficiary } = await b2bService.enrollBeneficiary({ access: admin, actorId: ADMIN.userId, body: { userId: member, status: 'pending' } });
  const look = async () => (await analytics.people({ access: admin, query: RANGE })).items.map(p => [p.status, p.activities, p.steps]);
  const detail = async () => analytics.person({ access: admin, beneficiaryId: beneficiary.id, query: RANGE });
  const exported = async () => (await analytics.exportCsv({ access: admin, report: 'activity', query: RANGE, actorId: ADMIN.userId })).rows;
  const dashboardActivities = async () => (await analytics.dashboard({ access: admin, query: RANGE })).trend.reduce((t, b) => t + (b.activities ?? 0), 0);
  assert.deepEqual(await look(), [['pending', 0, 0]]);
  assert.deepEqual(await detail().then(d => [d.activities.length, d.beneficiary.activityShown]), [0, false]);
  assert.deepEqual([await exported(), await dashboardActivities()], [0, 0]);
  await b2bService.setBeneficiaryStatus({ access: admin, beneficiaryId: beneficiary.id, status: 'active', actorId: ADMIN.userId });
  assert.deepEqual(await look(), [['active', 1, 4200]]);
  assert.deepEqual(await detail().then(d => [d.activities.length, d.beneficiary.activityShown]), [1, true]);
  assert.deepEqual([await exported(), await dashboardActivities()], [1, 1]);
  await b2bService.deactivateBeneficiary({ access: admin, beneficiaryId: beneficiary.id, actorId: ADMIN.userId });
  assert.deepEqual(await look(), [['inactive', 0, 0]]);
  assert.deepEqual([await exported(), await dashboardActivities()], [0, 0]);
});
