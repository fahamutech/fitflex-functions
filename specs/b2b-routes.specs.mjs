// B2B routes against the CI database, guards chained as bfast-function runs
// them: who may call what, organisation isolation, and the existing corporate
// routes still behaving (and now mapping new companies).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import {
  b2bReference, adminCreateB2BOrganization, adminListB2BOrganizations, adminSetB2BOrganizationStatus,
  adminSyncCorporateOrganizations, adminB2BOrganizationForCorporate, myB2BOrganizations,
  getB2BOrganization, updateB2BOrganization, listB2BOrganizationUsers, addB2BOrganizationUser,
  updateB2BOrganizationUser, removeB2BOrganizationUser, listB2BBeneficiaries, getB2BBeneficiary,
  enrollB2BBeneficiary, setB2BBeneficiaryStatus, deactivateB2BBeneficiary,
} from '../functions/b2b.mjs';
import {
  adminOnboardCorporate, adminListCorporate, adminSetCorporateStatus, adminCreateHrUser,
  corporateProvisionStaff, corporateListStaff, corporateSetStaffStatus, corporateDashboard,
} from '../functions/corporate.mjs';

const users = [];
const orgs = [];
const corporates = [];

async function makeUser(userType, extra = {}) {
  const id = `usr_${randomUUID().slice(0, 8)}`;
  await db('User').insert({ id, userType, displayName: `B2B route ${userType}`, updatedAt: new Date(), ...extra });
  users.push(id);
  return id;
}

function res() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function call(route, { claims, params = {}, body = {}, query = {} }) {
  const req = { headers: claims ? { authorization: `Bearer ${sign(claims)}` } : {}, params, body, query };
  const out = res();
  for (const guard of [route.onGuard].flat().filter(Boolean)) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return out;
}

after(async () => {
  if (orgs.length) await db('B2BOrganization').whereIn('id', orgs).del();
  const mapped = corporates.length ? await db('B2BOrganization').whereIn('legacyCorporateId', corporates).pluck('id') : [];
  if (mapped.length) await db('B2BOrganization').whereIn('id', mapped).del();
  if (corporates.length) {
    await db('CorporateEmployee').whereIn('corporateId', corporates).del();
    await db('CorporateAccount').whereIn('id', corporates).del();
  }
  if (users.length) {
    await db('AuditLog').whereIn('actor', users).del();
    await db('User').whereIn('id', users).del();
  }
});

const adminClaims = async () => ({ sub: await makeUser('admin'), userType: 'admin' });

async function activeOrganization(admin, body) {
  const created = await call(adminCreateB2BOrganization, { claims: admin, body });
  assert.equal(created.statusCode, 201, JSON.stringify(created.body));
  orgs.push(created.body.organization.id);
  const id = created.body.organization.id;
  assert.equal((await call(adminSetB2BOrganizationStatus, { claims: admin, params: { id }, body: { status: 'active' } })).body.organization.status, 'active');
  return id;
}

test('reference is public; admin routes need an admin with the b2b scope', async () => {
  assert.equal((await call(b2bReference, {})).body.organizationTypes.insurer, 'Insurance company');
  const body = { organizationType: 'club', legalName: `Route Club ${randomUUID().slice(0, 4)}` };
  assert.equal((await call(adminCreateB2BOrganization, { body })).statusCode, 401);
  assert.equal((await call(adminCreateB2BOrganization, { claims: { sub: await makeUser('member'), userType: 'member' }, body })).statusCode, 403);
  const staff = { sub: await makeUser('admin'), userType: 'admin', portalUser: true, aclPermissions: ['corporate'] };
  assert.deepEqual([(await call(adminListB2BOrganizations, { claims: staff })).statusCode, (await call(adminListB2BOrganizations, { claims: staff })).body.requiredScope], [403, 'b2b']);
  const scoped = { ...staff, aclPermissions: ['b2b'] };
  const created = await call(adminCreateB2BOrganization, { claims: scoped, body });
  assert.equal(created.statusCode, 201);
  orgs.push(created.body.organization.id);
  const list = await call(adminListB2BOrganizations, { claims: scoped, query: { type: 'club' } });
  assert.ok(list.body.items.some(o => o.id === created.body.organization.id));
  assert.equal(typeof list.body.total, 'number');
});

test('organisation users manage their own organisation within their role', async () => {
  const admin = await adminClaims();
  const orgId = await activeOrganization(admin, { organizationType: 'insurer', legalName: 'Route Insurer' });
  const ownerId = await makeUser('member');
  const viewerId = await makeUser('member');
  const memberId = await makeUser('member');
  const owner = { sub: ownerId, userType: 'member' };
  const viewer = { sub: viewerId, userType: 'member' };

  assert.equal((await call(addB2BOrganizationUser, { claims: admin, params: { id: orgId }, body: { userId: ownerId, role: 'owner' } })).statusCode, 201);
  const addedViewer = await call(addB2BOrganizationUser, { claims: owner, params: { id: orgId }, body: { userId: viewerId, role: 'viewer' } });
  assert.equal(addedViewer.statusCode, 201);

  const mine = await call(getB2BOrganization, { claims: owner, params: { id: orgId } });
  assert.deepEqual([mine.statusCode, mine.body.access.role], [200, 'owner']);
  assert.equal((await call(listB2BOrganizationUsers, { claims: owner, params: { id: orgId } })).body.total, 2);
  assert.equal((await call(myB2BOrganizations, { claims: viewer })).body.organizations[0].role, 'viewer');

  // Viewer: read-only, no user or beneficiary data.
  assert.equal((await call(listB2BOrganizationUsers, { claims: viewer, params: { id: orgId } })).statusCode, 403);
  assert.equal((await call(updateB2BOrganization, { claims: viewer, params: { id: orgId }, body: { tradingName: 'x' } })).statusCode, 403);
  assert.equal((await call(enrollB2BBeneficiary, { claims: viewer, params: { id: orgId }, body: { userId: memberId } })).statusCode, 403);

  assert.equal((await call(updateB2BOrganization, { claims: owner, params: { id: orgId }, body: { tradingName: 'Route' } })).body.organization.tradingName, 'Route');
  const enrolled = await call(enrollB2BBeneficiary, { claims: owner, params: { id: orgId }, body: { userId: memberId, beneficiaryType: 'policyholder', externalReference: 'POL-9' } });
  assert.equal(enrolled.statusCode, 201);
  const beneficiaryId = enrolled.body.beneficiary.id;
  assert.equal((await call(setB2BBeneficiaryStatus, { claims: owner, params: { id: orgId, beneficiaryId }, body: { status: 'active' } })).body.beneficiary.status, 'active');
  assert.equal((await call(getB2BBeneficiary, { claims: owner, params: { id: orgId, beneficiaryId } })).body.beneficiary.externalReference, 'POL-9');
  assert.equal((await call(deactivateB2BBeneficiary, { claims: owner, params: { id: orgId, beneficiaryId } })).body.beneficiary.status, 'inactive');

  const seat = addedViewer.body.organizationUser.id;
  assert.equal((await call(updateB2BOrganizationUser, { claims: owner, params: { id: orgId, orgUserId: seat }, body: { role: 'analyst' } })).body.organizationUser.role, 'analyst');
  assert.equal((await call(removeB2BOrganizationUser, { claims: owner, params: { id: orgId, orgUserId: seat } })).body.organizationUser.status, 'removed');
  assert.equal((await call(getB2BOrganization, { claims: viewer, params: { id: orgId } })).statusCode, 404);

  // Organisation status is FitFlex's call.
  assert.equal((await call(adminSetB2BOrganizationStatus, { claims: owner, params: { id: orgId }, body: { status: 'inactive' } })).statusCode, 403);
});

test('organisation A cannot reach organisation B through any route', async () => {
  const admin = await adminClaims();
  const a = await activeOrganization(admin, { organizationType: 'bank', legalName: 'Bank A' });
  const b = await activeOrganization(admin, { organizationType: 'bank', legalName: 'Bank B' });
  const ownerA = { sub: await makeUser('member'), userType: 'member' };
  const ownerBId = await makeUser('member');
  await call(addB2BOrganizationUser, { claims: admin, params: { id: a }, body: { userId: ownerA.sub, role: 'owner' } });
  const seatB = (await call(addB2BOrganizationUser, { claims: admin, params: { id: b }, body: { userId: ownerBId, role: 'owner' } })).body.organizationUser.id;
  const benB = (await call(enrollB2BBeneficiary, { claims: admin, params: { id: b }, body: { userId: await makeUser('member') } })).body.beneficiary.id;

  for (const [route, params, body] of [
    [getB2BOrganization, { id: b }],
    [updateB2BOrganization, { id: b }, { tradingName: 'hijack' }],
    [listB2BOrganizationUsers, { id: b }],
    [addB2BOrganizationUser, { id: b }, { userId: ownerA.sub, role: 'owner' }],
    [updateB2BOrganizationUser, { id: b, orgUserId: seatB }, { status: 'suspended' }],
    [listB2BBeneficiaries, { id: b }],
    [getB2BBeneficiary, { id: b, beneficiaryId: benB }],
    [enrollB2BBeneficiary, { id: b }, { userId: ownerA.sub }],
    [setB2BBeneficiaryStatus, { id: b, beneficiaryId: benB }, { status: 'active' }],
  ]) {
    const out = await call(route, { claims: ownerA, params, body });
    assert.deepEqual([out.statusCode, out.body.error], [404, 'organization_not_found'], route.path);
  }
  // Addressing B's rows under A's id finds nothing either.
  assert.equal((await call(getB2BBeneficiary, { claims: ownerA, params: { id: a, beneficiaryId: benB } })).statusCode, 404);
  assert.equal((await call(updateB2BOrganizationUser, { claims: ownerA, params: { id: a, orgUserId: seatB }, body: { status: 'suspended' } })).statusCode, 404);
  assert.equal((await db('B2BOrganizationUser').where({ id: seatB }).first()).status, 'active');
});

test('corporate routes keep working, and a new company is mapped to an employer organisation', async () => {
  const admin = await adminClaims();
  const onboard = await call(adminOnboardCorporate, {
    claims: admin,
    body: { companyName: 'Route Corp', industrySector: 'banking', workforceBracket: '50-100', subsidyModel: 'copay_70_30', passTier: 'pro', seatLimit: 5 },
  });
  assert.equal(onboard.statusCode, 201, JSON.stringify(onboard.body));
  const corporateId = onboard.body.id;
  corporates.push(corporateId);
  // The corporate response shape is unchanged (no B2B fields leak into it).
  assert.deepEqual(Object.keys(onboard.body).sort(), [
    'baselineSickDays', 'billingCycle', 'companyName', 'createdAt', 'domainWhitelist', 'hrContactEmail', 'hrContactName',
    'hrContactPhone', 'id', 'industrySector', 'lipaNamba', 'objectives', 'passTier', 'seatLimit', 'seatsUsed', 'status',
    'subsidyModel', 'updatedAt', 'workforceBracket',
  ]);
  assert.ok((await call(adminListCorporate, { claims: admin })).body.some(a => a.id === corporateId));

  const mapped = await call(adminB2BOrganizationForCorporate, { claims: admin, params: { corporateId } });
  const orgId = mapped.body.organization.id;
  assert.deepEqual([mapped.body.organization.organizationType, mapped.body.organization.status], ['employer', 'pending']);
  assert.deepEqual((await call(adminSyncCorporateOrganizations, { claims: admin })).body.created, 0);

  // Status still moves through the corporate route and shows in B2B.
  assert.equal((await call(adminSetCorporateStatus, { claims: admin, params: { id: corporateId }, body: { status: 'active' } })).body.status, 'active');
  assert.equal((await call(getB2BOrganization, { claims: admin, params: { id: orgId } })).body.organization.status, 'active');
  assert.equal((await call(adminSetB2BOrganizationStatus, { claims: admin, params: { id: orgId }, body: { status: 'suspended' } })).body.error, 'managed_by_corporate');

  // HR provisions staff exactly as before; B2B reads them through.
  const hr = await call(adminCreateHrUser, { claims: admin, params: { id: corporateId }, body: { displayName: 'Route HR', email: `hr-${randomUUID().slice(0, 6)}@routecorp.tz`, password: 'a-long-password' } });
  users.push(hr.body.hrUser.id);
  const hrClaims = { sub: hr.body.hrUser.id, userType: 'corporate_hr' };
  const provisioned = await call(corporateProvisionStaff, { claims: hrClaims, body: { displayName: 'Route Employee', department: 'Ops' } });
  assert.equal(provisioned.statusCode, 200);
  assert.match(provisioned.body.pin, /^\d{4}$/);
  const employeeId = provisioned.body.employee.id;
  assert.equal((await call(corporateSetStaffStatus, { claims: hrClaims, params: { id: employeeId }, body: { status: 'active' } })).body.employee.status, 'active');
  assert.equal((await call(corporateListStaff, { claims: hrClaims })).body.employees.length, 1);
  assert.equal((await call(corporateDashboard, { claims: hrClaims })).body.dashboard.seats.used, 1);

  const asHr = await call(listB2BBeneficiaries, { claims: hrClaims, params: { id: orgId } });
  assert.equal(asHr.statusCode, 200);
  assert.deepEqual(asHr.body.items.map(b => [b.id, b.beneficiaryType, b.status, b.groupName, b.readOnly]), [[employeeId, 'employee', 'active', 'Ops', true]]);
  assert.equal((await call(enrollB2BBeneficiary, { claims: hrClaims, params: { id: orgId }, body: { userId: 'x' } })).body.error, 'managed_by_corporate');
  assert.equal((await call(myB2BOrganizations, { claims: hrClaims })).body.organizations[0].id, orgId);
  assert.equal(await db('B2BBeneficiary').where({ organizationId: orgId }).count('* as c').then(r => Number(r[0].c)), 0);
});
