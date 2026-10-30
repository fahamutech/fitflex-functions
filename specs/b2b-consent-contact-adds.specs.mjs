// Consent slice (a), against the CI database (owner decision 22 Oct 2026,
// re-confirmed 29 Oct): a member must also accept before an organisation adds
// them by a VERIFIED email or mobile number, by bulk import, or when an invite
// matches them; legacy company HR linking a staff record by email or number
// waits too. FitFlex platform admins still add directly, by id or contact, and
// the member is told (b2b_admin_added).
//
// By contact, nothing the organisation gets back may say whether a member is
// behind the email or number before that member accepts: the reply, the
// pending lists, repeats and the limits are the same either way.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureInit } from '../functions/index.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { b2bService, corporateService, b2bMemberRequestService as requests, b2bBeneficiaryImportService as invites } from '../src/bootstrap/services.mjs';
import { createB2BBeneficiaryImportService } from '../src/services/b2b-beneficiary-import-service.mjs';
import { createB2BMemberRequestService } from '../src/services/b2b-member-request-service.mjs';
import { enrollB2BBeneficiary, addB2BOrganizationUser, cancelB2BMemberRequest, listB2BBeneficiaries } from '../functions/b2b.mjs';
import { corporateLinkStaffUser, corporateListStaff } from '../functions/corporate.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { verifyContacts, purgeIdentity } from './fixtures/verified-contacts.mjs';

await ensureInit();

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const tag = randomUUID().slice(0, 6);
const mail = name => `${name}.${tag}@contact-consent.test`;
let phoneSeq = Math.floor(Math.random() * 800000) + 100000;
const phone = () => `+255714${String(phoneSeq += 1).padStart(6, '0')}`;
const made = { users: [], orgs: [], corporates: [] };

async function user(userType = 'member', { name = `Contact ${userType}`, email = null, phone: p = null, verified = true } = {}) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: name, email, phone: p, updatedAt: new Date() });
  made.users.push(id);
  if (verified && (email || p)) await verifyContacts(db, id, { email, phone: p });
  return id;
}
const ADMIN = { userType: 'admin', userId: await user('admin') };

async function organisation(name = 'Contact insurer') {
  const { organization } = await b2bService.createOrganization({ body: { organizationType: 'insurer', legalName: `${name} ${uid('o')}` }, actorId: ADMIN.userId });
  made.orgs.push(organization.id);
  await b2bService.setOrganizationStatus({ organizationId: organization.id, status: 'active', actorId: ADMIN.userId });
  return organization;
}
const adminAccess = orgId => b2bService.resolveAccess({ organizationId: orgId, ...ADMIN });
const as = (orgId, userId) => b2bService.resolveAccess({ organizationId: orgId, userId, userType: 'member' });
async function orgUser(orgId, role) {
  const id = await user('member', { name: `Org ${role}` });
  const out = await b2bService.addOrganizationUser({ access: await adminAccess(orgId), body: { userId: id, role }, actorId: ADMIN.userId });
  assert.ok(out.organizationUser, JSON.stringify(out));
  return id;
}
async function company(seatLimit = 10) {
  const { account } = await corporateService.onboard({ body: { companyName: `Contact Corp ${uid('c')}`, industrySector: 'banking', workforceBracket: '50-100', subsidyModel: 'fully_funded', passTier: 'pro', seatLimit }, actorId: ADMIN.userId });
  made.corporates.push(account.id);
  await corporateService.setStatus({ corporateId: account.id, status: 'active', actorId: ADMIN.userId });
  const hr = (await corporateService.createHrUser({ corporateId: account.id, body: { displayName: 'Contact HR', email: `${uid('hr')}@contact-consent.test`, password: 'contact-password-1' }, actorId: ADMIN.userId })).hrUser;
  made.users.push(hr.id);
  return { account, hr };
}
const staffRow = async (corporateId, name) => (await corporateService.provisionStaff({ corporateId, body: { displayName: name }, actorId: ADMIN.userId })).employee;

// The member is told after the reply (security review of #283); wait for that first.
const told = async (userId, type = 'b2b_member_request') => { await requests.idle(); return db('Notification').where({ userId, type }).orderBy('createdAt'); };
const dataOf = n => (typeof n.data === 'string' ? JSON.parse(n.data) : n.data);
const rowsOf = orgId => db('B2BMemberRequest').where({ organizationId: orgId }).orderBy('createdAt');

async function withEnv(vars, fn) {
  const before = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
async function call(route, { claims, params = {}, body = {}, query = {} }) {
  const req = { headers: { authorization: `Bearer ${sign(claims)}` }, params, body, query };
  const out = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, set() {} };
  for (const guard of [route.onGuard].flat().filter(Boolean)) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return out;
}
/** A reply with what differs per request taken out (its id, times, the contact typed): what is left must not depend on the person. */
function shape(res) {
  const m = res.body?.memberRequest ? { ...res.body.memberRequest } : null;
  if (m) for (const k of ['id', 'contact', 'contactType', 'expiresAt', 'createdAt', 'employeeId']) delete m[k];
  return { statusCode: res.statusCode, keys: Object.keys(res.body ?? {}).sort(), outcome: res.body?.outcome ?? null, error: res.body?.error ?? null, memberRequest: m };
}

after(async () => {
  const orgIds = [...made.orgs, ...(made.corporates.length ? await db('B2BOrganization').whereIn('legacyCorporateId', made.corporates).pluck('id') : [])];
  await db('B2BMemberRequest').whereIn('organizationId', orgIds).del();
  if (made.corporates.length) await db('B2BMemberRequest').whereIn('corporateId', made.corporates).del();
  await db('B2BBeneficiaryInviteMatch').whereIn('organizationId', orgIds).del();
  await db('B2BMemberRequest').whereIn('userId', made.users).del();
  await db('Notification').whereIn('userId', made.users).del();
  await db('B2BBeneficiaryInvite').whereIn('organizationId', orgIds).del();
  await db('B2BBeneficiaryImport').whereIn('organizationId', orgIds).del();
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
  await db('AuditLog').whereIn('actor', [...made.users, 'system:b2b-member-requests', 'system:b2b-beneficiary-invites']).del();
  const persons = await purgeIdentity(db, made.users);
  await db('User').whereIn('id', made.users).del();
  if (persons?.length) await db('Person').whereIn('id', persons).del().catch(() => {});
});

test('the database really is the CI database', async () => {
  const { rows: [{ name }] } = await db.raw('select current_database() as name');
  assert.equal(process.env.FITFLEX_USE_CI_DB, '1');
  assert.match(name, /_ci/);
});

test('adding a beneficiary by verified email or number waits for the member; the reply and the list are the same whoever is behind the contact', async () => {
  const org = await organisation();
  const manager = await orgUser(org.id, 'manager');
  const claims = { sub: manager, userType: 'member' };
  const P = { id: org.id };
  const member = await user('member', { name: 'Private Asha', email: mail('asha') });
  const byPhone = await user('member', { name: 'Private Baraka', phone: phone() });
  const baraka = (await db('User').where({ id: byPhone }).first('phone')).phone;
  const planted = await user('member', { email: mail('planted'), verified: false });      // only typed onto a profile
  await user('trainer', { email: mail('trainer') });                                      // not a member account
  const enrolled = await user('member', { email: mail('enrolled') });
  await b2bService.enrollBeneficiary({ access: await adminAccess(org.id), actorId: ADMIN.userId, body: { userId: enrolled, status: 'active' } });

  const body = extra => ({ status: 'active', groupName: 'Gold', ...extra });
  const replies = {
    member: await call(enrollB2BBeneficiary, { claims, params: P, body: body({ email: mail('asha').toUpperCase() }) }),
    phone: await call(enrollB2BBeneficiary, { claims, params: P, body: body({ phone: baraka.replace('+255', '0') }) }),
    nobody: await call(enrollB2BBeneficiary, { claims, params: P, body: body({ email: mail('nobody') }) }),
    planted: await call(enrollB2BBeneficiary, { claims, params: P, body: body({ email: mail('planted') }) }),
    trainer: await call(enrollB2BBeneficiary, { claims, params: P, body: body({ email: mail('trainer') }) }),
    enrolled: await call(enrollB2BBeneficiary, { claims, params: P, body: body({ email: mail('enrolled') }) }),
  };
  for (const [who, r] of Object.entries(replies)) {
    assert.deepEqual(shape(r), shape(replies.member), who);
    assert.equal(typeof r.body.memberRequest.id, 'string', who);
  }
  const m = replies.member.body.memberRequest;
  assert.deepEqual([replies.member.statusCode, m.status, m.source, m.contactType, m.contact, m.userId, m.displayName, m.groupName, m.beneficiaryStatus],
    [202, 'pending_member_acceptance', 'contact', 'email', mail('asha'), null, null, 'Gold', 'active']);
  assert.equal(replies.phone.body.memberRequest.contact, baraka);

  // Nothing is enrolled; only the two members who may be asked are told.
  assert.deepEqual((await db('B2BBeneficiary').where({ organizationId: org.id })).map(b => b.userId), [enrolled]);
  assert.deepEqual([(await told(member)).length, (await told(byPhone)).length, (await told(planted)).length, (await told(enrolled)).length], [1, 1, 0, 0]);
  const stored = await rowsOf(org.id);
  assert.deepEqual(stored.map(r => [r.contactValue, r.userId, r.source]).sort(), [
    [baraka, byPhone, 'contact'], [mail('asha'), member, 'contact'], [mail('enrolled'), null, 'contact'],
    [mail('nobody'), null, 'contact'], [mail('planted'), null, 'contact'], [mail('trainer'), null, 'contact'],
  ].sort());
  assert.ok(stored.every(r => r.details.unmatched !== undefined || r.userId), 'rows with nobody say why (never shown)');

  // The organisation's list shows six waiting entries, all alike: never the member's id or name.
  const list = await call(listB2BBeneficiaries, { claims, params: P });
  const pending = list.body.pendingMemberAcceptance;
  assert.equal(pending.length, 6);
  assert.ok(pending.every(p => p.userId === null && p.displayName === null && p.status === 'pending_member_acceptance' && p.source === 'contact'));
  assert.equal(list.body.total, 1);

  // The same contact again: the same request, the same 202, nobody told twice.
  const again = await call(enrollB2BBeneficiary, { claims, params: P, body: body({ email: mail('asha') }) });
  const againNobody = await call(enrollB2BBeneficiary, { claims, params: P, body: body({ email: mail('nobody') }) });
  assert.deepEqual([again.statusCode, again.body.memberRequest.id, againNobody.statusCode, againNobody.body.memberRequest.id],
    [202, m.id, 202, replies.nobody.body.memberRequest.id]);
  assert.equal((await told(member)).length, 1);

  // The member sees who asks and what it will see, including past activity; accepting enrols them as asked.
  const mine = (await requests.listForMember({ userId: member })).items;
  assert.deepEqual(mine.map(i => [i.kind, i.source, i.organization.id, i.visibility.shown.includes('past_activity')]), [['beneficiary', 'contact', org.id, true]]);
  const accepted = await requests.accept({ userId: member, requestId: mine[0].id });
  assert.deepEqual([accepted.beneficiary.userId, accepted.beneficiary.status, accepted.beneficiary.groupName], [member, 'active', 'Gold']);
  // Once accepted the organisation may know who it was.
  const listed = await requests.pendingForOrganization({ organizationId: org.id, kind: 'beneficiary' });
  assert.equal(listed.length, 5);
  const audit = await db('AuditLog').where({ action: 'b2b.beneficiary.enroll', target: accepted.beneficiary.id }).first();
  assert.equal(audit.after.memberRequestId, m.id);
});

test('refusals by contact never depend on the person: bad input, the organisation\'s own reference, and the limits', async () => {
  const org = await organisation();
  const manager = await orgUser(org.id, 'manager');
  const access = await as(org.id, manager);
  const add = body => b2bService.enrollBeneficiary({ access, actorId: manager, body });
  assert.deepEqual([(await add({ email: 'not-an-email' })).error, (await add({ phone: '12' })).error, (await add({ email: mail('x'), phone: phone() })).error],
    ['invalid_email', 'invalid_phone', 'one_user_contact_only']);
  await b2bService.enrollBeneficiary({ access: await adminAccess(org.id), actorId: ADMIN.userId, body: { userId: await user('member'), externalReference: 'POL-1' } });
  assert.deepEqual([(await add({ email: mail('ref'), externalReference: 'POL-1' })).error], ['external_reference_in_use']);

  // Hourly rate per requester: member and stranger alike.
  const m1 = await user('member', { email: mail('rate1') });
  await withEnv({ B2B_MEMBER_REQUEST_RATE_PER_HOUR: '2' }, async () => {
    const other = await orgUser(org.id, 'manager');
    const otherAccess = await as(org.id, other);
    const a = await b2bService.enrollBeneficiary({ access: otherAccess, actorId: other, body: { email: mail('rate1') } });
    const b = await b2bService.enrollBeneficiary({ access: otherAccess, actorId: other, body: { email: mail('stranger1') } });
    assert.deepEqual([a.outcome, b.outcome], ['pending_member_acceptance', 'pending_member_acceptance']);
    const c = await b2bService.enrollBeneficiary({ access: otherAccess, actorId: other, body: { email: mail('stranger2') } });
    const d = await b2bService.enrollBeneficiary({ access: otherAccess, actorId: other, body: { email: mail('rate1') } });
    assert.deepEqual([c.error, c.status], ['rate_limited', 429]);
    assert.deepEqual([d.error, d.status], ['rate_limited', 429]);
  });
  assert.equal((await told(m1)).length, 1);

  // The open cap counts requests with nobody behind them too.
  const org2 = await organisation();
  const manager2 = await orgUser(org2.id, 'manager');
  const access2 = await as(org2.id, manager2);
  await user('member', { email: mail('cap-member') });
  await withEnv({ B2B_MEMBER_REQUEST_MAX_PENDING: '2' }, async () => {
    for (const e of ['cap1', 'cap2']) assert.equal((await b2bService.enrollBeneficiary({ access: access2, actorId: manager2, body: { email: mail(e) } })).outcome, 'pending_member_acceptance');
    const member = await b2bService.enrollBeneficiary({ access: access2, actorId: manager2, body: { email: mail('cap-member') } });
    const stranger = await b2bService.enrollBeneficiary({ access: access2, actorId: manager2, body: { email: mail('cap3') } });
    assert.deepEqual([member.error, member.status, stranger.error, stranger.status], ['member_request_limit', 429, 'member_request_limit', 429]);
    // An entry already showing is still answered (the same request).
    assert.equal((await b2bService.enrollBeneficiary({ access: access2, actorId: manager2, body: { email: mail('cap1') } })).outcome, 'pending_member_acceptance');
  });
});

test('a decline shows to the organisation as still waiting until it would have expired; the cooldown asks nobody but answers the same', async () => {
  const org = await organisation();
  const manager = await orgUser(org.id, 'manager');
  const access = await as(org.id, manager);
  const member = await user('member', { email: mail('decliner') });
  const asked = await b2bService.enrollBeneficiary({ access, actorId: manager, body: { email: mail('decliner') } });
  const stranger = await b2bService.enrollBeneficiary({ access, actorId: manager, body: { email: mail('nobody-d') } });
  const declined = await requests.decline({ userId: member, requestId: asked.memberRequest.id });
  assert.equal(declined.memberRequest.status, 'declined');

  // The organisation sees both as waiting, alike.
  const pending = await requests.pendingForOrganization({ organizationId: org.id, kind: 'beneficiary' });
  assert.deepEqual(pending.map(p => [p.id, p.status, p.decidedAt, p.reason]).sort(), [
    [asked.memberRequest.id, 'pending_member_acceptance', null, null], [stranger.memberRequest.id, 'pending_member_acceptance', null, null],
  ].sort());
  // Asking again: the same request, as for the stranger; nobody told.
  const again = await b2bService.enrollBeneficiary({ access, actorId: manager, body: { email: mail('decliner') } });
  assert.deepEqual([again.outcome, again.memberRequest.id, again.memberRequest.status], ['pending_member_acceptance', asked.memberRequest.id, 'pending_member_acceptance']);

  // Withdrawn by the organisation: the same 200 cancelled for both; the decline (and its cooldown) stays.
  const c1 = await call(cancelB2BMemberRequest, { claims: { sub: manager, userType: 'member' }, params: { id: org.id, requestId: asked.memberRequest.id } });
  const c2 = await call(cancelB2BMemberRequest, { claims: { sub: manager, userType: 'member' }, params: { id: org.id, requestId: stranger.memberRequest.id } });
  assert.deepEqual([c1.statusCode, c1.body.memberRequest.status, c2.statusCode, c2.body.memberRequest.status], [200, 'cancelled', 200, 'cancelled']);
  assert.deepEqual([(await db('B2BMemberRequest').where({ id: asked.memberRequest.id }).first()).status], ['declined']);
  assert.equal((await requests.pendingForOrganization({ organizationId: org.id, kind: 'beneficiary' })).length, 0);

  // Within the cooldown: stored with nobody behind it, nobody told, the same reply.
  const afterCooldown = await b2bService.enrollBeneficiary({ access, actorId: manager, body: { email: mail('decliner') } });
  assert.deepEqual([afterCooldown.outcome, afterCooldown.memberRequest.userId], ['pending_member_acceptance', null]);
  const row = await db('B2BMemberRequest').where({ id: afterCooldown.memberRequest.id }).first();
  assert.deepEqual([row.userId, row.details.unmatched], [null, 'cooldown']);
  assert.equal((await told(member)).length, 1);
  assert.deepEqual((await requests.listForMember({ userId: member })).items, []);

  // A masked decline past its expiry date is gone from the list, like any expired request.
  const another = await user('member', { email: mail('decliner2') });
  const r2 = await b2bService.enrollBeneficiary({ access, actorId: manager, body: { email: mail('decliner2') } });
  await requests.decline({ userId: another, requestId: r2.memberRequest.id });
  await db('B2BMemberRequest').where({ id: r2.memberRequest.id }).update({ expiresAt: new Date(Date.now() - 1000) });
  assert.ok(!(await requests.pendingForOrganization({ organizationId: org.id, kind: 'beneficiary' })).some(p => p.id === r2.memberRequest.id));
});

test('a request by contact expires; accepting after that is refused and adds nobody', async () => {
  const org = await organisation();
  const manager = await orgUser(org.id, 'manager');
  const member = await user('member', { phone: phone() });
  const p = (await db('User').where({ id: member }).first('phone')).phone;
  const asked = await b2bService.enrollBeneficiary({ access: await as(org.id, manager), actorId: manager, body: { phone: p } });
  await db('B2BMemberRequest').where({ id: asked.memberRequest.id }).update({ expiresAt: new Date(Date.now() - 1000) });
  const late = await requests.accept({ userId: member, requestId: asked.memberRequest.id });
  assert.deepEqual([late.error, late.status], ['member_request_expired', 410]);
  assert.equal((await db('B2BMemberRequest').where({ id: asked.memberRequest.id }).first()).status, 'expired');
  assert.equal(await db('B2BBeneficiary').where({ organizationId: org.id, userId: member }).first(), undefined);
  // Expired rows with nobody behind them expire the same way.
  const nobody = await b2bService.enrollBeneficiary({ access: await as(org.id, manager), actorId: manager, body: { email: mail('nobody-exp') } });
  await db('B2BMemberRequest').where({ id: nobody.memberRequest.id }).update({ expiresAt: new Date(Date.now() - 1000) });
  await requests.expireDue({ ids: [nobody.memberRequest.id] });
  assert.equal((await db('B2BMemberRequest').where({ id: nobody.memberRequest.id }).first()).status, 'expired');
});

test('an organisation user added by verified email or number waits for the person; the reply is the same for anyone', async () => {
  const org = await organisation();
  const owner = await orgUser(org.id, 'owner');
  const claims = { sub: owner, userType: 'member' };
  const person = await user('member', { name: 'Private Grace', phone: phone() });
  const p = (await db('User').where({ id: person }).first('phone')).phone;
  const r1 = await call(addB2BOrganizationUser, { claims, params: { id: org.id }, body: { phone: p, role: 'finance' } });
  const r2 = await call(addB2BOrganizationUser, { claims, params: { id: org.id }, body: { phone: phone(), role: 'finance' } });
  const r3 = await call(addB2BOrganizationUser, { claims, params: { id: org.id }, body: { email: mail('owner-again'), role: 'finance' } });
  assert.deepEqual(shape(r1), shape(r2));
  assert.deepEqual(shape(r1), shape(r3));
  assert.deepEqual([r1.statusCode, r1.body.memberRequest.kind, r1.body.memberRequest.role, r1.body.memberRequest.userId], [202, 'org_user', 'finance', null]);
  assert.equal(await db('B2BOrganizationUser').where({ organizationId: org.id, userId: person }).first(), undefined);
  // Someone already in the organisation: the same reply, nobody told.
  const already = await call(addB2BOrganizationUser, { claims, params: { id: org.id }, body: { userId: owner, role: 'viewer' } });
  assert.equal(already.body.error, 'already_organization_user');                       // by id (unchanged)
  const notes = await told(person);
  assert.deepEqual(notes.map(n => dataOf(n).kind), ['org_user']);
  const out = await requests.accept({ userId: person, requestId: r1.body.memberRequest.id });
  assert.deepEqual([out.organizationUser.userId, out.organizationUser.role], [person, 'finance']);
  const list = await b2bService.listOrganizationUsers({ access: await as(org.id, owner) });
  assert.deepEqual(list.pendingMemberAcceptance.map(r => [r.userId, r.displayName]), [[null, null], [null, null]]);
});

test('legacy company HR linking a staff record by email or number waits for the member; the reply and the staff list are the same for anyone', async () => {
  const { account, hr } = await company();
  const claims = { sub: hr.id, userType: 'corporate_hr' };
  const e1 = await staffRow(account.id, 'Staff One');
  const e2 = await staffRow(account.id, 'Staff Two');
  const member = await user('member', { name: 'Private Zawadi', email: mail('zawadi') });

  const withMember = await call(corporateLinkStaffUser, { claims, params: { id: e1.id }, body: { email: mail('zawadi') } });
  const withoutMember = await call(corporateLinkStaffUser, { claims, params: { id: e2.id }, body: { email: mail('nobody-staff') } });
  assert.equal(withMember.statusCode, 202, JSON.stringify(withMember.body));
  assert.deepEqual(shape(withMember), shape(withoutMember));
  assert.deepEqual([withMember.body.memberRequest.kind, withMember.body.memberRequest.userId, withMember.body.memberRequest.displayName], ['employee_link', null, null]);
  assert.deepEqual((await db('CorporateEmployee').whereIn('id', [e1.id, e2.id])).map(e => e.userId), [null, null]);

  // GET /corporate/staff shows a pending link on both rows, alike.
  const staff = await call(corporateListStaff, { claims, query: {} });
  const pendingOf = id => staff.body.employees.find(e => e.id === id).pendingLink;
  const strip = v => { const c = { ...v }; for (const k of ['id', 'contact', 'employeeId', 'expiresAt', 'createdAt']) delete c[k]; return c; };
  assert.deepEqual(strip(pendingOf(e1.id)), strip(pendingOf(e2.id)));
  assert.equal(pendingOf(e1.id).userId, null);
  // Another contact for a row already waiting: 409 for both rows alike (about the row, not the person).
  const busy1 = await call(corporateLinkStaffUser, { claims, params: { id: e1.id }, body: { phone: phone() } });
  const busy2 = await call(corporateLinkStaffUser, { claims, params: { id: e2.id }, body: { phone: phone() } });
  assert.deepEqual([busy1.statusCode, busy1.body.error, busy2.statusCode, busy2.body.error], [409, 'member_request_pending', 409, 'member_request_pending']);

  // The member is told and accepts: linked.
  const [note] = await told(member);
  assert.equal(dataOf(note).kind, 'employee_link');
  const accepted = await requests.accept({ userId: member, requestId: dataOf(note).requestId });
  assert.equal(accepted.employee.userId, member);
  // Unlinking the other row withdraws its request.
  const unlink = await call(corporateLinkStaffUser, { claims, params: { id: e2.id }, body: { userId: null } });
  assert.equal(unlink.statusCode, 200);
  assert.equal((await db('B2BMemberRequest').where({ id: withoutMember.body.memberRequest.id }).first()).status, 'cancelled');
});

test('FitFlex platform admins still add and link directly by email or number, and the member is told (b2b_admin_added)', async () => {
  const org = await organisation();
  const byEmail = await user('member', { email: mail('admin-e') });
  const byPhone = await user('member', { phone: phone() });
  const p = (await db('User').where({ id: byPhone }).first('phone')).phone;
  const access = await adminAccess(org.id);
  const enrolled = await b2bService.enrollBeneficiary({ access, actorId: ADMIN.userId, body: { email: mail('admin-e'), status: 'active' } });
  assert.equal(enrolled.beneficiary.userId, byEmail);
  const role = await b2bService.addOrganizationUser({ access, actorId: ADMIN.userId, body: { phone: p, role: 'viewer' } });
  assert.equal(role.organizationUser.userId, byPhone);
  assert.deepEqual((await told(byEmail, 'b2b_admin_added')).map(n => dataOf(n).kind), ['beneficiary']);
  assert.deepEqual((await told(byPhone, 'b2b_admin_added')).map(n => dataOf(n).kind), ['org_user']);
  assert.equal((await told(byEmail)).length, 0);

  const { account } = await company();
  const e = await staffRow(account.id, 'Admin linked');
  const linkMember = await user('member', { email: mail('admin-link') });
  const linked = await corporateService.linkEmployeeUser({ corporateId: account.id, employeeId: e.id, email: mail('admin-link'), actorId: ADMIN.userId, actorType: 'admin' });
  assert.equal(linked.employee.userId, linkMember);
  const notes = await told(linkMember, 'b2b_admin_added');
  assert.deepEqual([notes.length, dataOf(notes[0]).kind], [1, 'employee_link']);
  assert.equal(await db('B2BMemberRequest').where({ userId: linkMember }).first(), undefined);
});

/** An import service on a clock the test moves, with what it delivered kept. */
function inviteHarness() {
  const clock = { now: new Date() };
  const sent = { email: [], sms: [] };
  const reqs = createB2BMemberRequestService({ db, b2bService, corporateService, now: () => clock.now });
  const svc = createB2BBeneficiaryImportService({
    db, b2bService, memberRequests: reqs, now: () => clock.now, appLink: () => null, smsEnabled: () => true,
    emailSender: () => ({ configured: true, send: async (to, m) => { sent.email.push({ to, ...m }); return { ok: true }; } }),
    smsSender: () => ({ configured: true, send: async (to, m) => { sent.sms.push({ to, ...m }); return { ok: true }; } }),
  });
  return { svc, reqs, sent, clock, days: n => { clock.now = new Date(+clock.now + n * 86_400_000); } };
}
/** An invite as the organisation sees it, without what is per row (id, the contact, the name). */
const inviteShape = i => { const c = { ...i }; for (const k of ['id', 'email', 'phone', 'displayName']) delete c[k]; return c; };

test('invites: the organisation\'s invite list is identical for a member, a non-member and someone already on the list, before and after matching, a decline and every reminder', async () => {
  const org = await organisation('Invite co');
  const access = await adminAccess(org.id);
  const h = inviteHarness();
  const member = await user('member', { email: mail('inv-member') });
  const onList = await user('member', { email: mail('inv-onlist') });
  await b2bService.enrollBeneficiary({ access, actorId: ADMIN.userId, body: { userId: onList, status: 'active' } });
  const imported = await h.svc.importPeople({ access, actorId: ADMIN.userId, body: { rows: [{ email: mail('inv-member') }, { email: mail('inv-nobody') }, { email: mail('inv-onlist') }] } });
  assert.deepEqual([imported.enrolled, imported.invited, imported.unchanged], [0, 3, 0]);
  // The import itself asks nobody (matching is the job's).
  assert.equal((await rowsOf(org.id)).length, 0);
  const snapshot = async () => {
    const { items } = await h.svc.listInvites({ access });
    const by = Object.fromEntries(items.map(i => [i.email, inviteShape(i)]));
    return [by[mail('inv-member')], by[mail('inv-nobody')], by[mail('inv-onlist')]];
  };
  const same = async label => { const [m, n, o] = await snapshot(); assert.deepEqual(m, n, label); assert.deepEqual(o, n, label); };
  await same('after import');

  await h.svc.sendDue({ limit: 1000 });
  const stats = await h.svc.matchInvites();
  assert.ok(stats.asked >= 1 && stats.alreadyOnList >= 1, JSON.stringify(stats));
  const asked = await rowsOf(org.id);
  assert.deepEqual(asked.map(r => [r.userId, r.source]), [[member, 'invite']]);
  await same('after matching');
  // Nothing about the match is on the invite row.
  const raw = await db('B2BBeneficiaryInvite').where({ organizationId: org.id });
  assert.ok(raw.every(r => !('memberRequestId' in r)));
  assert.equal((await db('B2BBeneficiaryInviteMatch').where({ organizationId: org.id })).length, 2);

  // The member declines: the invite row does not change.
  await h.reqs.decline({ userId: member, requestId: asked[0].id });
  await same('after the decline');
  // Reminders: the schedule and counters move the same for all three; nothing reaches the member who said no, or the one already on the list.
  for (const d of [3.1, 7.1, 30]) { h.days(d); await h.svc.sendDue({ limit: 1000 }); await same(`after reminders (+${d} days)`); }
  const delivered = to => h.sent.email.filter(e => e.to === to).length;
  assert.deepEqual([delivered(mail('inv-nobody')), delivered(mail('inv-member')), delivered(mail('inv-onlist'))], [3, 1, 1]);
  const [m] = await snapshot();
  assert.deepEqual([m.status, m.emailsSent, m.nextEmailAt, m.canResend], ['invited', 3, null, true]);
  // "Send again" also answers the same and delivers nothing to the member who declined.
  const r1 = await h.svc.resendInvite({ access, inviteId: raw.find(i => i.email === mail('inv-member')).id, actorId: ADMIN.userId });
  const r2 = await h.svc.resendInvite({ access, inviteId: raw.find(i => i.email === mail('inv-nobody')).id, actorId: ADMIN.userId });
  const r3 = await h.svc.resendInvite({ access, inviteId: raw.find(i => i.email === mail('inv-onlist')).id, actorId: ADMIN.userId });
  assert.deepEqual([r1.sent, inviteShape(r1.invite)], [r2.sent, inviteShape(r2.invite)]);
  assert.deepEqual([r3.sent, inviteShape(r3.invite)], [r2.sent, inviteShape(r2.invite)]);
  assert.deepEqual([delivered(mail('inv-nobody')), delivered(mail('inv-member')), delivered(mail('inv-onlist'))], [4, 1, 1]);
  await same('after send again');
  // Matching never asks again for the same invite.
  await h.svc.matchInvites();
  assert.equal((await rowsOf(org.id)).length, 1);
});

test('invites: cancelling an invite withdraws its request; accepting closes it as enrolled; two invites for one member make one request and both close', async () => {
  const org = await organisation('Invite co 2');
  const access = await adminAccess(org.id);
  const h = inviteHarness();
  const a = await user('member', { email: mail('inv-a') });
  const p = phone();
  const b = await user('member', { email: mail('inv-b'), phone: p });
  await h.svc.importPeople({ access, actorId: ADMIN.userId, body: { rows: [{ email: mail('inv-a') }, { email: mail('inv-b') }, { phone: p }] } });
  await h.svc.matchInvites();
  const reqA = await db('B2BMemberRequest').where({ organizationId: org.id, userId: a }).first();
  const reqsB = await db('B2BMemberRequest').where({ organizationId: org.id, userId: b });
  assert.deepEqual([reqA.source, reqA.status, reqsB.length], ['invite', 'pending', 1]);
  // Never listed to the organisation as a request, and not withdrawable as one.
  assert.deepEqual(await h.reqs.pendingForOrganization({ organizationId: org.id, kind: 'beneficiary' }), []);
  assert.equal((await h.reqs.cancel({ access, requestId: reqA.id, actorId: ADMIN.userId })).error, 'member_request_not_found');

  const inviteA = await db('B2BBeneficiaryInvite').where({ organizationId: org.id, email: mail('inv-a') }).first();
  await h.svc.cancelInvite({ access, inviteId: inviteA.id, actorId: ADMIN.userId });
  assert.equal((await db('B2BMemberRequest').where({ id: reqA.id }).first()).status, 'cancelled');
  assert.deepEqual((await h.reqs.listForMember({ userId: a })).items, []);

  await h.reqs.accept({ userId: b, requestId: reqsB[0].id });
  assert.deepEqual((await db('B2BBeneficiaryInvite').where({ organizationId: org.id }).whereNot({ id: inviteA.id })).map(i => i.status), ['enrolled', 'enrolled']);
  assert.equal((await db('B2BBeneficiary').where({ organizationId: org.id, userId: b })).length, 1);
});

test('withdrawing a request by contact answers the same whatever the member did: the first time, again, and after expiry', async () => {
  const org = await organisation();
  const manager = await orgUser(org.id, 'manager');
  const claims = { sub: manager, userType: 'member' };
  const access = await as(org.id, manager);
  const member = await user('member', { email: mail('del-member') });
  const del = id => call(cancelB2BMemberRequest, { claims, params: { id: org.id, requestId: id } });
  const view = r => ({ statusCode: r.statusCode, error: r.body.error ?? null, requestStatus: r.body.requestStatus ?? null, status: r.body.memberRequest?.status ?? null, reason: r.body.memberRequest?.reason ?? null, decided: Boolean(r.body.memberRequest?.decidedAt) });

  // Declined vs nobody.
  const m1 = await b2bService.enrollBeneficiary({ access, actorId: manager, body: { email: mail('del-member') } });
  const n1 = await b2bService.enrollBeneficiary({ access, actorId: manager, body: { email: mail('del-nobody') } });
  await requests.decline({ userId: member, requestId: m1.memberRequest.id });
  assert.deepEqual(view(await del(m1.memberRequest.id)), view(await del(n1.memberRequest.id)));
  const again = [await del(m1.memberRequest.id), await del(n1.memberRequest.id)];
  assert.deepEqual(view(again[0]), view(again[1]));
  assert.deepEqual([again[0].statusCode, again[0].body.requestStatus], [409, 'cancelled']);
  // Also after the expiry date has passed.
  await db('B2BMemberRequest').whereIn('id', [m1.memberRequest.id, n1.memberRequest.id]).update({ expiresAt: new Date(Date.now() - 1000) });
  assert.deepEqual(view(await del(m1.memberRequest.id)), view(await del(n1.memberRequest.id)));

  // Declined and left to expire vs nobody left to expire (before and after the expiry job).
  const n2 = await b2bService.enrollBeneficiary({ access, actorId: manager, body: { email: mail('del-nobody2') } });
  const member3 = await user('member', { email: mail('del-member3') });
  const m3 = await b2bService.enrollBeneficiary({ access, actorId: manager, body: { email: mail('del-member3') } });
  await requests.decline({ userId: member3, requestId: m3.memberRequest.id });
  await db('B2BMemberRequest').whereIn('id', [m3.memberRequest.id, n2.memberRequest.id]).update({ expiresAt: new Date(Date.now() - 1000) });
  const before = [view(await del(m3.memberRequest.id)), view(await del(n2.memberRequest.id))];
  assert.deepEqual(before[0], before[1]);
  assert.deepEqual([before[0].statusCode, before[0].requestStatus], [409, 'expired']);
  await requests.expireDue({ ids: [n2.memberRequest.id] });
  assert.deepEqual(view(await del(m3.memberRequest.id)), view(await del(n2.memberRequest.id)));
  const listed = await requests.pendingForOrganization({ organizationId: org.id, kind: 'beneficiary' });
  assert.ok(!listed.some(r => [m3.memberRequest.id, n2.memberRequest.id].includes(r.id)));
});

test('limits and retention: an hourly cap per organisation (all its users), and the typed contact is cleared 30 days after a request closes', async () => {
  const org = await organisation();
  const [u1, u2] = [await orgUser(org.id, 'manager'), await orgUser(org.id, 'manager')];
  await user('member', { email: mail('orgrate-member') });
  await withEnv({ B2B_MEMBER_REQUEST_ORG_RATE_PER_HOUR: '2' }, async () => {
    assert.equal((await b2bService.enrollBeneficiary({ access: await as(org.id, u1), actorId: u1, body: { email: mail('orgrate1') } })).outcome, 'pending_member_acceptance');
    assert.equal((await b2bService.enrollBeneficiary({ access: await as(org.id, u2), actorId: u2, body: { email: mail('orgrate2') } })).outcome, 'pending_member_acceptance');
    const member = await b2bService.enrollBeneficiary({ access: await as(org.id, u1), actorId: u1, body: { email: mail('orgrate-member') } });
    const nobody = await b2bService.enrollBeneficiary({ access: await as(org.id, u2), actorId: u2, body: { email: mail('orgrate3') } });
    assert.deepEqual([member.error, member.status, member.scope, nobody.error, nobody.status, nobody.scope], ['rate_limited', 429, 'organization', 'rate_limited', 429, 'organization']);
  });

  const rows = await rowsOf(org.id);
  const old = new Date(Date.now() - 31 * 86_400_000);
  await db('B2BMemberRequest').where({ id: rows[0].id }).update({ status: 'expired', expiresAt: old, decidedAt: old });
  await db('B2BMemberRequest').where({ id: rows[1].id }).update({ status: 'cancelled', reason: 'cancelled_by_organization', expiresAt: new Date(Date.now() - 5 * 86_400_000), decidedAt: new Date(Date.now() - 5 * 86_400_000) });
  const out = await requests.purgeContacts();
  assert.ok(out.cleared >= 1);
  const after2 = Object.fromEntries((await rowsOf(org.id)).map(r => [r.id, r.contactValue]));
  assert.deepEqual([after2[rows[0].id], after2[rows[1].id]], [null, mail('orgrate2')]);
});

test('a staff record whose member declined looks like one nobody answered: another link attempt gets the same 409 until it would have expired; unlinking clears it', async () => {
  const { account, hr } = await company();
  const claims = { sub: hr.id, userType: 'corporate_hr' };
  const declinedRow = await staffRow(account.id, 'Declined row');
  const nobodyRow = await staffRow(account.id, 'Nobody row');
  const member = await user('member', { email: mail('staff-decline') });
  const asked = await call(corporateLinkStaffUser, { claims, params: { id: declinedRow.id }, body: { email: mail('staff-decline') } });
  await call(corporateLinkStaffUser, { claims, params: { id: nobodyRow.id }, body: { email: mail('staff-nobody') } });
  const [note] = await told(member);
  await requests.decline({ userId: member, requestId: dataOf(note).requestId });
  assert.equal((await db('B2BMemberRequest').where({ id: asked.body.memberRequest.id }).first()).status, 'declined');

  for (const body of [{ phone: phone() }, { userId: await user('member') }]) {
    const a = await call(corporateLinkStaffUser, { claims, params: { id: declinedRow.id }, body });
    const b = await call(corporateLinkStaffUser, { claims, params: { id: nobodyRow.id }, body });
    assert.deepEqual([a.statusCode, a.body.error, b.statusCode, b.body.error], [409, 'member_request_pending', 409, 'member_request_pending'], JSON.stringify([body, a.body, b.body]));
  }
  const staff = await call(corporateListStaff, { claims, query: {} });
  const pendingOf = id => staff.body.employees.find(e => e.id === id).pendingLink;
  assert.deepEqual([pendingOf(declinedRow.id).status, pendingOf(nobodyRow.id).status], ['pending_member_acceptance', 'pending_member_acceptance']);

  // Unlinking withdraws both, alike; then a new contact may be asked.
  for (const id of [declinedRow.id, nobodyRow.id]) assert.equal((await call(corporateLinkStaffUser, { claims, params: { id }, body: { userId: null } })).statusCode, 200);
  const after2 = await call(corporateListStaff, { claims, query: {} });
  assert.deepEqual(after2.body.employees.filter(e => [declinedRow.id, nobodyRow.id].includes(e.id)).map(e => e.pendingLink), [null, null]);
  const fresh = await call(corporateLinkStaffUser, { claims, params: { id: declinedRow.id }, body: { phone: phone() } });
  assert.equal(fresh.statusCode, 202);
});
