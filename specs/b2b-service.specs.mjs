// B2B Foundation V1 — organisation lifecycle, organisation users,
// beneficiaries, access/isolation and the Corporate read-through, against
// in-memory collections.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createB2BService, corporateOrganizationId } from '../src/services/b2b-service.mjs';
import { createCorporateService } from '../src/services/corporate-service.mjs';

function store(rows = []) {
  const clone = r => JSON.parse(JSON.stringify(r));
  return {
    rows,
    async allAsync() { return rows.map(clone); },
    async filterAsync(pred) { return rows.filter(pred).map(clone); },
    async findAsync(pred) { const r = rows.find(pred); return r ? clone(r) : null; },
    async filterByColumnAsync(col, v) { return rows.filter(r => r[col] === v).map(clone); },
    async filterByColumnInAsync(col, vs) { return rows.filter(r => vs.includes(r[col])).map(clone); },
    async findByIdAsync(id) { const r = rows.find(x => x.id === id); return r ? clone(r) : null; },
    async insertAsync(row) { rows.push(clone(row)); return row; },
    async updateByIdAsync(id, patch) { const r = rows.find(x => x.id === id); Object.assign(r, clone(patch)); return clone(r); },
  };
}

function setup() {
  const s = {
    users: store([
      { id: 'admin', userType: 'admin', displayName: 'FitFlex Admin' },
      { id: 'owner_a', userType: 'member', displayName: 'Owner A' },
      { id: 'owner_b', userType: 'member', displayName: 'Owner B' },
      { id: 'mgr_a', userType: 'member', displayName: 'Manager A' },
      { id: 'viewer_a', userType: 'member', displayName: 'Viewer A' },
      { id: 'm1', userType: 'member', displayName: 'Asha' },
      { id: 'm2', userType: 'member', displayName: 'Baraka' },
      { id: 'trainer1', userType: 'trainer', displayName: 'Coach' },
      { id: 'hr_corp', userType: 'corporate_hr', corporateId: 'corp_1', displayName: 'Neema HR', email: 'hr@corp.tz', accountStatus: 'active' },
      { id: 'hr_other', userType: 'corporate_hr', corporateId: 'corp_2', displayName: 'Other HR', accountStatus: 'active' },
    ]),
    corporateAccounts: store([
      { id: 'corp_1', companyName: 'NMB Bank', industrySector: 'banking', hrContactEmail: 'hr@corp.tz', hrContactPhone: '+255700000001', status: 'active', seatLimit: 10, seatsUsed: 2 },
      { id: 'corp_2', companyName: 'Other Co', industrySector: 'telecom', status: 'pending', seatLimit: 0, seatsUsed: 0 },
    ]),
    corporateEmployees: store([
      { id: 'cemp_1', corporateId: 'corp_1', userId: null, displayName: 'Zawadi', department: 'Finance', status: 'active', activatedAt: '2026-09-01T00:00:00.000Z' },
      { id: 'cemp_2', corporateId: 'corp_1', userId: 'm2', displayName: 'Baraka', department: 'Ops', status: 'exited' },
      { id: 'cemp_3', corporateId: 'corp_2', userId: null, displayName: 'Elsewhere', department: 'X', status: 'active' },
    ]),
    corporateBills: store([]),
    partnerKycCases: store([
      { id: 'kyc_1', partnerType: 'corporate', corporateId: 'corp_1', status: 'approved', registrationNumber: '998877', tin: '111222333' },
    ]),
    organizations: store([]),
    organizationUsers: store([]),
    beneficiaries: store([]),
    auditLog: store([]),
  };
  s.b2b = createB2BService({ ...s });
  return s;
}

const ADMIN = { userId: 'admin', userType: 'admin' };
const insurer = { organizationType: 'insurer', legalName: 'Jubilee Insurance', registrationNumber: 'ab 123', taxIdentificationNumber: '100-200-300' };

async function activeOrg(s, body = insurer) {
  const { organization } = await s.b2b.createOrganization({ body, actorId: 'admin' });
  await s.b2b.setOrganizationStatus({ organizationId: organization.id, status: 'active', actorId: 'admin' });
  return organization.id;
}
const access = (s, organizationId, who = ADMIN) => s.b2b.resolveAccess({ organizationId, ...who });

// ── Organisations ────────────────────────────────────────────────────────────

test('create: validates type and legal name, normalises identifiers, starts pending and audits', async () => {
  const s = setup();
  assert.equal((await s.b2b.createOrganization({ body: { legalName: 'X', organizationType: 'casino' } })).error, 'invalid_organization_type');
  assert.equal((await s.b2b.createOrganization({ body: { organizationType: 'club', legalName: '  ' } })).error, 'legal_name_required');
  assert.equal((await s.b2b.createOrganization({ body: { ...insurer, email: 'nope' } })).error, 'invalid_email');
  assert.equal((await s.b2b.createOrganization({ body: { ...insurer, phone: '12' } })).error, 'invalid_phone');
  assert.equal((await s.b2b.createOrganization({ body: { ...insurer, industrySector: 'mining' } })).error, 'invalid_industry_sector');

  const { organization } = await s.b2b.createOrganization({
    body: { ...insurer, email: ' Wellness@Jubilee.co.TZ ', phone: '0712 345 678', address: { city: 'Dar', junk: 'x' } }, actorId: 'admin',
  });
  assert.equal(organization.status, 'pending');
  assert.equal(organization.registrationNumber, 'AB123');
  assert.equal(organization.taxIdentificationNumber, '100200300');
  assert.equal(organization.email, 'wellness@jubilee.co.tz');
  assert.equal(organization.phone, '+255712345678');
  assert.deepEqual(organization.address, { city: 'Dar' });
  assert.equal(organization.source, 'b2b');
  assert.deepEqual(organization.kyc, { supported: false, caseId: null, status: null });
  assert.equal(s.auditLog.rows.at(-1).action, 'b2b.organization.create');
});

test('every organisation type in the reference list can be created', async () => {
  const s = setup();
  for (const organizationType of Object.keys(s.b2b.reference().organizationTypes)) {
    const r = await s.b2b.createOrganization({ body: { organizationType, legalName: `${organizationType} org` } });
    assert.equal(r.organization.organizationType, organizationType);
  }
});

test('duplicate registration or tax numbers are refused, however they are typed', async () => {
  const s = setup();
  await s.b2b.createOrganization({ body: insurer });
  assert.equal((await s.b2b.createOrganization({ body: { organizationType: 'bank', legalName: 'B', registrationNumber: 'AB-123' } })).error, 'registration_number_in_use');
  assert.equal((await s.b2b.createOrganization({ body: { organizationType: 'bank', legalName: 'B', taxIdentificationNumber: '100 200 300' } })).error, 'tax_number_in_use');
  const other = await s.b2b.createOrganization({ body: { organizationType: 'club', legalName: 'Club' } });
  assert.equal((await s.b2b.updateOrganization({ organizationId: other.organization.id, body: { registrationNumber: 'ab123' } })).error, 'registration_number_in_use');
});

test('get, update and list (filters, search, pagination)', async () => {
  const s = setup();
  const a = (await s.b2b.createOrganization({ body: insurer })).organization;
  await s.b2b.createOrganization({ body: { organizationType: 'club', legalName: 'Simba Runners Club' } });
  await s.b2b.createOrganization({ body: { organizationType: 'club', legalName: 'Yanga Cyclists' } });

  assert.equal((await s.b2b.getOrganization({ organizationId: a.id })).organization.legalName, 'Jubilee Insurance');
  assert.equal((await s.b2b.getOrganization({ organizationId: 'nope' })).status, 404);

  const updated = await s.b2b.updateOrganization({ organizationId: a.id, body: { tradingName: 'Jubilee', legalName: 'Jubilee Insurance Ltd' }, actorId: 'admin' });
  assert.equal(updated.organization.tradingName, 'Jubilee');
  assert.equal(updated.organization.legalName, 'Jubilee Insurance Ltd');
  assert.equal((await s.b2b.updateOrganization({ organizationId: a.id, body: { status: 'active' } })).error, 'use_status_endpoint');
  assert.equal((await s.b2b.updateOrganization({ organizationId: a.id, body: { organizationType: 'bank' } })).status, 403);
  assert.equal((await s.b2b.updateOrganization({ organizationId: a.id, body: { organizationType: 'bank' }, platformAdmin: true })).organization.organizationType, 'bank');

  const clubs = await s.b2b.listOrganizations({ query: { type: 'club' } });
  assert.equal(clubs.total, 2);
  assert.equal((await s.b2b.listOrganizations({ query: { search: 'simba' } })).items[0].legalName, 'Simba Runners Club');
  const first = await s.b2b.listOrganizations({ query: { limit: 2 } });
  assert.deepEqual([first.items.length, first.total, first.nextCursor], [2, 3, 2]);
  const second = await s.b2b.listOrganizations({ query: { limit: 2, cursor: first.nextCursor } });
  assert.deepEqual([second.items.length, second.nextCursor], [1, null]);
});

test('status transitions follow the lifecycle and are audited', async () => {
  const s = setup();
  const { id } = (await s.b2b.createOrganization({ body: insurer })).organization;
  const move = status => s.b2b.setOrganizationStatus({ organizationId: id, status, reason: 'test', actorId: 'admin' });

  assert.equal((await move('nonsense')).error, 'invalid_status');
  assert.deepEqual((await move('suspended')).allowed, ['active', 'inactive']);   // pending can't be suspended
  assert.equal((await move('active')).organization.status, 'active');
  assert.equal((await move('active')).unchanged, true);
  assert.equal((await move('suspended')).organization.statusReason, 'test');
  assert.equal((await move('active')).organization.status, 'active');
  assert.equal((await move('inactive')).organization.status, 'inactive');
  assert.equal((await move('suspended')).error, 'invalid_transition');
  assert.equal((await move('active')).organization.status, 'active');   // FitFlex may reopen
  assert.deepEqual(s.auditLog.rows.filter(r => r.action.startsWith('b2b.organization.')).map(r => r.action),
    ['b2b.organization.create', 'b2b.organization.active', 'b2b.organization.suspended', 'b2b.organization.active', 'b2b.organization.inactive', 'b2b.organization.active']);
});

// ── Organisation users ───────────────────────────────────────────────────────

test('organisation users: add, role assignment, duplicates, permissions and removal', async () => {
  const s = setup();
  const orgId = await activeOrg(s);
  const admin = await access(s, orgId);

  assert.equal((await s.b2b.addOrganizationUser({ access: admin, body: { userId: 'owner_a', role: 'boss' } })).error, 'invalid_role');
  assert.equal((await s.b2b.addOrganizationUser({ access: admin, body: { userId: 'ghost', role: 'owner' } })).error, 'user_not_found');
  assert.equal((await s.b2b.addOrganizationUser({ access: admin, body: { userId: 'owner_a', role: 'owner', permissions: ['everything'] } })).error, 'invalid_permissions');
  const owner = (await s.b2b.addOrganizationUser({ access: admin, body: { userId: 'owner_a', role: 'owner' }, actorId: 'admin' })).organizationUser;
  assert.equal(owner.status, 'active');
  assert.equal(owner.user.displayName, 'Owner A');
  assert.equal((await s.b2b.addOrganizationUser({ access: admin, body: { userId: 'owner_a', role: 'viewer' } })).error, 'already_organization_user');

  const asOwner = await access(s, orgId, { userId: 'owner_a', userType: 'member' });
  assert.equal(asOwner.role, 'owner');
  const mgr = (await s.b2b.addOrganizationUser({ access: asOwner, body: { userId: 'mgr_a', role: 'manager' }, actorId: 'owner_a' })).organizationUser;
  const promoted = await s.b2b.updateOrganizationUser({ access: asOwner, organizationUserId: mgr.id, body: { role: 'admin' } });
  assert.equal(promoted.organizationUser.role, 'admin');

  const removed = await s.b2b.removeOrganizationUser({ access: asOwner, organizationUserId: mgr.id, actorId: 'owner_a' });
  assert.equal(removed.organizationUser.status, 'removed');
  assert.ok(removed.organizationUser.removedAt);
  assert.equal((await s.b2b.updateOrganizationUser({ access: asOwner, organizationUserId: mgr.id, body: { status: 'active' } })).error, 'organization_user_removed');
  assert.equal((await access(s, orgId, { userId: 'mgr_a', userType: 'member' })).status, 404);
  // Removed rows are hidden by default and can be re-added as a new seat.
  assert.equal((await s.b2b.listOrganizationUsers({ access: asOwner })).total, 1);
  assert.equal((await s.b2b.listOrganizationUsers({ access: asOwner, query: { status: 'removed' } })).total, 1);
  assert.ok((await s.b2b.addOrganizationUser({ access: asOwner, body: { userId: 'mgr_a', role: 'viewer' } })).organizationUser);
});

test('permission enforcement: roles, no escalation, owners protect owners, last owner stays', async () => {
  const s = setup();
  const orgId = await activeOrg(s);
  const admin = await access(s, orgId);
  const owner = (await s.b2b.addOrganizationUser({ access: admin, body: { userId: 'owner_a', role: 'owner' } })).organizationUser;
  await s.b2b.addOrganizationUser({ access: admin, body: { userId: 'mgr_a', role: 'manager' } });
  await s.b2b.addOrganizationUser({ access: admin, body: { userId: 'viewer_a', role: 'viewer' } });

  const viewer = await access(s, orgId, { userId: 'viewer_a', userType: 'member' });
  assert.deepEqual(viewer.permissions, ['organization.read', 'programs.read']);
  assert.deepEqual((await s.b2b.listOrganizationUsers({ access: viewer })).requiredPermission, 'users.read');
  assert.equal((await s.b2b.listBeneficiaries({ access: viewer })).status, 403);

  const mgr = await access(s, orgId, { userId: 'mgr_a', userType: 'member' });
  assert.equal((await s.b2b.listOrganizationUsers({ access: mgr })).total, 3);
  assert.equal((await s.b2b.addOrganizationUser({ access: mgr, body: { userId: 'm1', role: 'viewer' } })).requiredPermission, 'users.manage');

  // An admin can manage users but can't create owners or grant beyond itself.
  await s.b2b.addOrganizationUser({ access: admin, body: { userId: 'owner_b', role: 'admin' } });
  const orgAdmin = await access(s, orgId, { userId: 'owner_b', userType: 'member' });
  assert.equal((await s.b2b.addOrganizationUser({ access: orgAdmin, body: { userId: 'm1', role: 'owner' } })).requiredRole, 'owner');
  assert.equal((await s.b2b.updateOrganizationUser({ access: orgAdmin, organizationUserId: owner.id, body: { status: 'suspended' } })).requiredRole, 'owner');
  const extra = await s.b2b.addOrganizationUser({ access: orgAdmin, body: { userId: 'm1', role: 'viewer', permissions: ['beneficiaries.read'] } });
  assert.deepEqual(extra.organizationUser.permissions, ['beneficiaries.read']);
  const asExtra = await access(s, orgId, { userId: 'm1', userType: 'member' });
  assert.ok(asExtra.permissions.includes('beneficiaries.read'));

  const asOwner = await access(s, orgId, { userId: 'owner_a', userType: 'member' });
  assert.equal((await s.b2b.updateOrganizationUser({ access: asOwner, organizationUserId: owner.id, body: { role: 'admin' } })).error, 'last_owner');
  assert.equal((await s.b2b.removeOrganizationUser({ access: asOwner, organizationUserId: owner.id })).error, 'last_owner');
  // FitFlex can still intervene.
  assert.equal((await s.b2b.updateOrganizationUser({ access: admin, organizationUserId: owner.id, body: { status: 'suspended' } })).organizationUser.status, 'suspended');
  assert.equal((await access(s, orgId, { userId: 'owner_a', userType: 'member' })).status, 404);
});

test('pending organisations are read-only for their users; suspended ones are closed', async () => {
  const s = setup();
  const { id } = (await s.b2b.createOrganization({ body: insurer })).organization;
  await s.b2b.addOrganizationUser({ access: await access(s, id), body: { userId: 'owner_a', role: 'owner' } });
  const pending = await access(s, id, { userId: 'owner_a', userType: 'member' });
  assert.deepEqual(pending.permissions, ['organization.read', 'users.read', 'beneficiaries.read', 'programs.read', 'usage.read', 'billing.read', 'engagement.read']);
  await s.b2b.setOrganizationStatus({ organizationId: id, status: 'active' });
  await s.b2b.setOrganizationStatus({ organizationId: id, status: 'suspended' });
  const closed = await access(s, id, { userId: 'owner_a', userType: 'member' });
  assert.deepEqual([closed.status, closed.error], [403, 'organization_not_active']);
  assert.equal((await access(s, id)).platformAdmin, true);
});

// ── Beneficiaries ────────────────────────────────────────────────────────────

test('beneficiaries: enrol, retrieve, list, lifecycle and deactivate', async () => {
  const s = setup();
  const orgId = await activeOrg(s);
  const admin = await access(s, orgId);

  assert.equal((await s.b2b.enrollBeneficiary({ access: admin, body: { userId: 'trainer1' } })).error, 'beneficiary_must_be_member');
  assert.equal((await s.b2b.enrollBeneficiary({ access: admin, body: { userId: 'm1', beneficiaryType: 'pet' } })).error, 'invalid_beneficiary_type');
  const b1 = (await s.b2b.enrollBeneficiary({
    access: admin, body: { userId: 'm1', beneficiaryType: 'policyholder', externalReference: 'POL-1', groupName: 'Gold' }, actorId: 'admin',
  })).beneficiary;
  assert.deepEqual([b1.status, b1.enrolledAt, b1.displayName, b1.source], ['pending', null, 'Asha', 'b2b']);
  assert.equal((await s.b2b.enrollBeneficiary({ access: admin, body: { userId: 'm1' } })).error, 'already_enrolled');
  assert.equal((await s.b2b.enrollBeneficiary({ access: admin, body: { userId: 'm2', externalReference: 'POL-1' } })).error, 'external_reference_in_use');
  const b2 = (await s.b2b.enrollBeneficiary({ access: admin, body: { userId: 'm2', status: 'active' } })).beneficiary;
  assert.ok(b2.enrolledAt);

  assert.equal((await s.b2b.getBeneficiary({ access: admin, beneficiaryId: b1.id })).beneficiary.externalReference, 'POL-1');
  assert.equal((await s.b2b.listBeneficiaries({ access: admin })).total, 2);
  assert.equal((await s.b2b.listBeneficiaries({ access: admin, query: { status: 'active' } })).total, 1);
  assert.equal((await s.b2b.listBeneficiaries({ access: admin, query: { search: 'pol-1' } })).items[0].id, b1.id);

  const move = status => s.b2b.setBeneficiaryStatus({ access: admin, beneficiaryId: b1.id, status });
  assert.equal((await move('suspended')).error, 'invalid_transition');
  const activated = await move('active');
  assert.ok(activated.beneficiary.enrolledAt);
  assert.equal((await move('suspended')).beneficiary.status, 'suspended');
  const off = await s.b2b.deactivateBeneficiary({ access: admin, beneficiaryId: b1.id });
  assert.equal(off.beneficiary.status, 'inactive');
  assert.equal((await move('active')).beneficiary.enrolledAt, activated.beneficiary.enrolledAt);   // re-enrolment keeps first date
  // Enrolment needs an active organisation.
  await s.b2b.setOrganizationStatus({ organizationId: orgId, status: 'suspended' });
  assert.equal((await s.b2b.enrollBeneficiary({ access: await access(s, orgId), body: { userId: 'viewer_a' } })).error, 'organization_not_active');
});

test('one member can be a beneficiary of several organisations', async () => {
  const s = setup();
  const a = await activeOrg(s);
  const b = await activeOrg(s, { organizationType: 'bank', legalName: 'CRDB' });
  assert.ok((await s.b2b.enrollBeneficiary({ access: await access(s, a), body: { userId: 'm1' } })).beneficiary);
  assert.ok((await s.b2b.enrollBeneficiary({ access: await access(s, b), body: { userId: 'm1' } })).beneficiary);
  assert.equal(s.beneficiaries.rows.filter(r => r.userId === 'm1').length, 2);
  assert.equal((await s.users.findByIdAsync('m1')).userType, 'member');   // identity untouched
});

test('isolation: organisation A cannot see or change organisation B', async () => {
  const s = setup();
  const a = await activeOrg(s);
  const b = await activeOrg(s, { organizationType: 'club', legalName: 'Club B' });
  await s.b2b.addOrganizationUser({ access: await access(s, a), body: { userId: 'owner_a', role: 'owner' } });
  const bOwner = (await s.b2b.addOrganizationUser({ access: await access(s, b), body: { userId: 'owner_b', role: 'owner' } })).organizationUser;
  const bBeneficiary = (await s.b2b.enrollBeneficiary({ access: await access(s, b), body: { userId: 'm2' } })).beneficiary;

  // A's owner has no access to B at all, and B's existence isn't revealed.
  assert.deepEqual(await access(s, b, { userId: 'owner_a', userType: 'member' }), { error: 'organization_not_found', status: 404 });
  // Inside A, B's rows are unknown ids.
  const asA = await access(s, a, { userId: 'owner_a', userType: 'member' });
  assert.equal((await s.b2b.getBeneficiary({ access: asA, beneficiaryId: bBeneficiary.id })).status, 404);
  assert.equal((await s.b2b.setBeneficiaryStatus({ access: asA, beneficiaryId: bBeneficiary.id, status: 'active' })).status, 404);
  assert.equal((await s.b2b.updateOrganizationUser({ access: asA, organizationUserId: bOwner.id, body: { status: 'suspended' } })).status, 404);
  assert.equal((await s.b2b.listBeneficiaries({ access: asA })).total, 0);
  assert.ok((await s.b2b.listOrganizationUsers({ access: asA })).items.every(u => u.organizationId === a));
  assert.equal((await s.b2b.listMyOrganizations({ userId: 'owner_a', userType: 'member' })).organizations.map(o => o.id).join(), a);
});

// ── Corporate compatibility ──────────────────────────────────────────────────

test('a CorporateAccount maps to exactly one employer organisation (idempotent)', async () => {
  const s = setup();
  const first = await s.b2b.ensureOrganizationForCorporate({ corporateId: 'corp_1' });
  assert.equal(first.created, true);
  assert.equal(first.organization.id, corporateOrganizationId('corp_1'));
  assert.equal((await s.b2b.ensureOrganizationForCorporate({ corporateId: 'corp_1' })).created, false);
  assert.deepEqual(await s.b2b.syncCorporateOrganizations({ actorId: 'admin' }), { created: 1, existing: 1 });
  assert.deepEqual(await s.b2b.syncCorporateOrganizations({ actorId: 'admin' }), { created: 0, existing: 2 });
  assert.equal(s.organizations.rows.length, 2);
  assert.equal((await s.b2b.ensureOrganizationForCorporate({ corporateId: 'corp_x' })).status, 404);

  const { organization } = await s.b2b.organizationForCorporate({ corporateId: 'corp_1' });
  assert.equal(organization.organizationType, 'employer');
  assert.equal(organization.legacyCorporateId, 'corp_1');
  assert.equal(organization.source, 'corporate');
  // KYB comes from the existing PartnerKycCase, not a copy.
  assert.deepEqual(organization.kyc, { supported: true, caseId: 'kyc_1', status: 'approved' });
  assert.equal(organization.registrationNumber, '998877');
  assert.equal((await s.b2b.organizationForCorporate({ corporateId: 'corp_2' })).organization.kyc.status, 'not_started');
  assert.equal((await s.b2b.organizationForCorporate({ corporateId: 'nope' })).organization, null);
});

test('Corporate stays the source of truth for a mapped organisation', async () => {
  const s = setup();
  const orgId = (await s.b2b.ensureOrganizationForCorporate({ corporateId: 'corp_1' })).organization.id;
  // Company renamed / suspended through the corporate routes → reflected immediately.
  Object.assign(s.corporateAccounts.rows[0], { companyName: 'NMB Bank Plc', status: 'suspended' });
  const view = (await s.b2b.getOrganization({ organizationId: orgId })).organization;
  assert.deepEqual([view.legalName, view.status], ['NMB Bank Plc', 'suspended']);
  Object.assign(s.corporateAccounts.rows[0], { status: 'terminated' });
  assert.equal((await s.b2b.getOrganization({ organizationId: orgId })).organization.status, 'inactive');
  Object.assign(s.corporateAccounts.rows[0], { status: 'active' });

  const r = await s.b2b.updateOrganization({ organizationId: orgId, body: { legalName: 'X', phone: '0712345678' } });
  assert.deepEqual([r.error, r.fields], ['managed_by_corporate', ['legalName', 'phone']]);
  assert.equal((await s.b2b.updateOrganization({ organizationId: orgId, body: { tradingName: 'NMB' } })).organization.tradingName, 'NMB');
  assert.equal((await s.b2b.setOrganizationStatus({ organizationId: orgId, status: 'suspended' })).error, 'managed_by_corporate');
  assert.equal(s.corporateAccounts.rows[0].companyName, 'NMB Bank Plc');   // never written by B2B
});

test('CorporateEmployees are read through as read-only employee beneficiaries', async () => {
  const s = setup();
  const orgId = (await s.b2b.ensureOrganizationForCorporate({ corporateId: 'corp_1' })).organization.id;
  const admin = await access(s, orgId);
  const list = await s.b2b.listBeneficiaries({ access: admin });
  assert.equal(list.total, 2);   // corp_2's employee is not included
  const zawadi = list.items.find(b => b.id === 'cemp_1');
  assert.deepEqual(
    [zawadi.beneficiaryType, zawadi.status, zawadi.groupName, zawadi.source, zawadi.readOnly, zawadi.enrolledAt],
    ['employee', 'active', 'Finance', 'corporate_employee', true, '2026-09-01T00:00:00.000Z'],
  );
  assert.equal(list.items.find(b => b.id === 'cemp_2').status, 'inactive');   // exited
  assert.equal((await s.b2b.getBeneficiary({ access: admin, beneficiaryId: 'cemp_1' })).beneficiary.displayName, 'Zawadi');
  assert.equal((await s.b2b.getBeneficiary({ access: admin, beneficiaryId: 'cemp_3' })).status, 404);
  // Seats and billing live in Corporate: writes go there.
  assert.equal((await s.b2b.enrollBeneficiary({ access: admin, body: { userId: 'm1' } })).error, 'managed_by_corporate');
  assert.equal((await s.b2b.setBeneficiaryStatus({ access: admin, beneficiaryId: 'cemp_1', status: 'suspended' })).error, 'managed_by_corporate');
  assert.equal(s.corporateEmployees.rows[0].status, 'active');
  assert.equal(s.beneficiaries.rows.length, 0);   // nothing copied
});

test('corporate HR logins reach their own mapped organisation as hr, and only that one', async () => {
  const s = setup();
  const org1 = (await s.b2b.ensureOrganizationForCorporate({ corporateId: 'corp_1' })).organization.id;
  const other = await activeOrg(s);
  const hr = await access(s, org1, { userId: 'hr_corp', userType: 'corporate_hr' });
  assert.equal(hr.role, 'hr');
  assert.ok(hr.permissions.includes('beneficiaries.read'));
  assert.equal((await s.b2b.listBeneficiaries({ access: hr })).total, 2);
  assert.equal((await access(s, other, { userId: 'hr_corp', userType: 'corporate_hr' })).status, 404);
  assert.equal((await access(s, org1, { userId: 'hr_other', userType: 'corporate_hr' })).status, 404);
  // HR logins are listed read-only; managing them stays in /admin/corporate.
  const users = await s.b2b.listOrganizationUsers({ access: await access(s, org1) });
  assert.deepEqual(users.items.map(u => [u.id, u.role, u.source, u.readOnly]), [['hr_corp', 'hr', 'corporate_hr', true]]);
  assert.equal((await s.b2b.updateOrganizationUser({ access: await access(s, org1), organizationUserId: 'hr_corp', body: { status: 'suspended' } })).error, 'managed_by_corporate');
  // A suspended HR login loses access.
  s.users.rows.find(u => u.id === 'hr_corp').accountStatus = 'suspended';
  assert.equal((await access(s, org1, { userId: 'hr_corp', userType: 'corporate_hr' })).status, 404);
});

test('corporate onboarding maps the new company through the hook; a failing hook never breaks onboarding', async () => {
  const s = setup();
  const settingsService = { getTierConfig: t => (t === 'pro' ? { key: 'pro' } : null), priceForTier: () => 150000 };
  const body = { companyName: 'Vodacom', industrySector: 'telecom', workforceBracket: '1000+', subsidyModel: 'fully_funded', passTier: 'pro' };

  const corp = createCorporateService({
    ...s, checkins: store([]), settingsService,
    onAccountCreated: (account, actorId) => s.b2b.ensureOrganizationForCorporate({ corporateId: account.id, actorId }),
  });
  const { account } = await corp.onboard({ body, actorId: 'admin' });
  assert.equal(account.status, 'pending');
  const { organization } = await s.b2b.organizationForCorporate({ corporateId: account.id });
  assert.deepEqual([organization.legalName, organization.status, organization.organizationType], ['Vodacom', 'pending', 'employer']);

  const broken = createCorporateService({
    ...s, checkins: store([]), settingsService, onAccountCreated: async () => { throw new Error('db down'); },
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const result = await broken.onboard({ body: { ...body, companyName: 'Airtel' }, actorId: 'admin' });
    assert.equal(result.account.companyName, 'Airtel');
    assert.equal(result.error, undefined);
  } finally {
    console.warn = warn;
  }
});
