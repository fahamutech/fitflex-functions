// Partner KYC service against the CI database: partners fill in their own
// case, admins fill cases on a partner's behalf (corporate KYB), every change
// lands on the timeline and the audit log, and the checklist reads the
// records FitFlex already holds.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { partnerKycService as svc, corporateService, shopService } from '../src/bootstrap/services.mjs';
import { PORTAL_ACL_SCOPES } from '../src/services/portal-user-service.mjs';

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const created = { users: [], gyms: [], corporates: [] };
const admin = { id: null, role: 'admin' };

async function makeUser(userType, extra = {}) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `KYC ${userType}`, updatedAt: new Date(), ...extra });
  created.users.push(id);
  return id;
}

async function makeGym(extra = {}) {
  const id = uid('gym');
  await db('Gym').insert({
    id, name: 'KYC Gym', tier: 'midtier', location: 'Masaki', coordinates: JSON.stringify({ lat: -6.75, lng: 39.27 }),
    ratePerDay: 8000, updatedAt: new Date(), ...extra,
  });
  created.gyms.push(id);
  return id;
}

async function makeCorporate() {
  const id = uid('corp');
  await db('CorporateAccount').insert({
    id, companyName: 'KYC Bank Ltd', industrySector: 'banking', workforceBracket: '100-250',
    subsidyModel: 'copay_70_30', passTier: 'pro', seatLimit: 120,
  });
  created.corporates.push(id);
  return id;
}

async function partner(userType, extra) {
  const id = await makeUser(userType, extra);
  const p = await svc.partnerForUser(id);
  return { ...p, actor: { id, role: 'partner' } };
}

const item = (view, key) => view.checklist.sections.flatMap(s => s.items).find(i => i.key === key);
const events = async caseId => db('PartnerKycEvent').where('caseId', caseId).orderBy('at');

after(async () => {
  if (created.corporates.length) await db('CorporateAccount').whereIn('id', created.corporates).del();
  if (created.gyms.length) await db('Gym').whereIn('id', created.gyms).del();
  if (created.users.length) {
    await db('AuditLog').whereIn('actor', created.users).del();
    await db('User').whereIn('id', created.users).del();
  }
});

test('only gym owners, trainers and vendors have a KYC of their own', async () => {
  const member = await makeUser('member');
  assert.equal((await svc.partnerForUser(member)).error, 'not_a_partner');
  const owner = await partner('gym_operator');
  assert.equal(owner.partnerType, 'gym_owner');
});

test('reading a checklist opens no case; the first edit does', async () => {
  const p = await partner('trainer');
  const empty = await svc.overview(p);
  assert.equal(empty.case, null);
  assert.equal(empty.checklist.readyToSubmit, false);
  assert.equal((await db('PartnerKycCase').where('userId', p.subjectId)).length, 0);

  const view = await svc.upsertPerson(p, 'principal', {
    fullName: 'Neema Said', idType: 'nida', idNumber: '19950505-11111-00002-21', phone: '+255754000111',
    email: 'Neema@Example.com', address: { line1: 'Sinza', city: 'Dar es Salaam', ignored: 'x' },
  }, p.actor);
  assert.equal(view.case.status, 'draft');
  assert.equal(view.case.tier, 2);
  const person = view.people[0];
  assert.equal(person.idNumber, '19950505111110000221');
  assert.equal(person.email, 'neema@example.com');
  assert.deepEqual(person.address, { line1: 'Sinza', city: 'Dar es Salaam' });
  assert.equal(item(view, 'identity.fullName').status, 'complete');
  assert.deepEqual((await events(view.case.id)).map(e => e.eventType), ['status_changed', 'person_updated']);
  const audit = await db('AuditLog').where({ target: view.case.id, action: 'kyc.person_updated' });
  assert.equal(audit.length, 1);
});

test('each partner type names only its own person', async () => {
  const vendor = await partner('vendor');
  const wrong = await svc.upsertPerson(vendor, 'principal', { fullName: 'X' }, vendor.actor);
  assert.deepEqual([wrong.error, wrong.allowed], ['invalid_role', ['authorised_representative']]);
  const bad = await svc.upsertPerson(vendor, 'authorised_representative', { fullName: 'John', authority: 'king' }, vendor.actor);
  assert.equal(bad.error, 'invalid_authority');
  const noName = await svc.upsertPerson(vendor, 'authorised_representative', { position: 'Director' }, vendor.actor);
  assert.equal(noName.error, 'fullName_required');
});

test('a gym owner fills in business details; the checklist reads their gyms', async () => {
  const gymId = await makeGym({ images: ['a.webp'], amenities: ['showers'], equipment: ['racks'] });
  const p = await partner('gym_operator', { gymId, gymIds: [gymId] });
  const view = await svc.updateBusiness(p, {
    legalName: 'Iron Paradise Ltd', tradingName: 'Iron Paradise', entityType: 'company',
    registrationNumber: '123 456', tin: '123-456-789', incorporatedOn: '2019-03-01',
    registeredAddress: { line1: 'Plot 12', city: 'Dar es Salaam' },
  }, p.actor);
  assert.equal(view.case.tin, '123456789');
  assert.equal(view.case.registrationNumber, '123456');
  for (const key of ['business.legalName', 'business.tin', 'business.registeredAddress', 'business.gym_location',
    'operational.gym_profile', 'operational.rate_card']) {
    assert.equal(item(view, key).status, 'complete', key);
  }
  assert.equal(item(view, 'operational.site_verification').status, 'missing');
  assert.equal((await svc.updateBusiness(p, { entityType: 'cartel' }, p.actor)).error, 'invalid_entityType');
  assert.equal((await svc.updateBusiness(p, { incorporatedOn: '1/3/2019' }, p.actor)).error, 'invalid_incorporatedOn');
  assert.equal((await svc.updateBusiness(p, {}, p.actor)).error, 'nothing_to_update');
});

test('trainers have no business section', async () => {
  const p = await partner('trainer');
  assert.equal((await svc.updateBusiness(p, { legalName: 'Me Ltd' }, p.actor)).error, 'not_applicable');
});

test('document details are corrected in place while pending, and start over once reviewed', async () => {
  const p = await partner('trainer');
  let view = await svc.upsertDocumentDetails(p, 'certification', {
    issuer: 'ACE', documentNumber: 'ace-123', issuedOn: '2024-02-01', expiresOn: '2026-12-31', details: { level: 'CPT' },
  }, p.actor);
  const first = view.documents[0];
  assert.equal(first.documentNumber, 'ACE123');
  assert.equal(first.hasFile, false);
  assert.equal('storageKey' in first, false);
  assert.deepEqual(first.details, { level: 'CPT' });
  assert.equal(item(view, 'professional.certification').status, 'file_missing');

  view = await svc.upsertDocumentDetails(p, 'certification', { expiresOn: '2027-06-30' }, p.actor);
  assert.equal(view.documents.length, 1);
  assert.equal(view.documents[0].expiresOn, '2027-06-30');

  await db('PartnerDocument').where('id', first.id).update({ status: 'rejected', reviewNote: 'Unreadable' });
  view = await svc.upsertDocumentDetails(p, 'certification', { issuer: 'ACE', documentNumber: 'ACE-999', issuedOn: '2025-01-01', expiresOn: '2027-01-01' }, p.actor);
  assert.equal(view.documents.length, 2);
  const replacement = view.documents.find(d => d.id !== first.id);
  assert.equal(replacement.supersedesId, first.id);
  assert.equal(item(view, 'professional.certification').status, 'file_missing');
});

test('document details are checked against the requirement', async () => {
  const p = await partner('trainer');
  assert.equal((await svc.upsertDocumentDetails(p, 'business_licence', {}, p.actor)).error, 'invalid_requirement');
  assert.equal((await svc.upsertDocumentDetails(p, 'trainer_id', { docType: 'selfie' }, p.actor)).error, 'invalid_docType');
  assert.equal((await svc.upsertDocumentDetails(p, 'certification', { issuedOn: '2025-01-01', expiresOn: '2024-01-01' }, p.actor)).error, 'expiresOn_before_issuedOn');
  assert.equal((await svc.upsertDocumentDetails(p, 'certification', { details: ['x'] }, p.actor)).error, 'invalid_details');
});

test('a submitted case is locked for the partner but an admin can still correct it', async () => {
  const p = await partner('trainer');
  const view = await svc.upsertPerson(p, 'principal', { fullName: 'Locked Trainer' }, p.actor);
  await db('PartnerKycCase').where('id', view.case.id).update({ status: 'submitted' });
  const locked = await svc.upsertPerson(p, 'principal', { phone: '0754000000' }, p.actor);
  assert.deepEqual([locked.error, locked.caseStatus], ['case_locked', 'submitted']);
  const fixed = await svc.upsertPerson(p, 'principal', { phone: '0754000000' }, admin);
  assert.equal(fixed.people[0].phone, '0754000000');
  await db('PartnerKycCase').where('id', view.case.id).update({ status: 'approved' });
  assert.equal((await svc.upsertPerson(p, 'principal', { phone: '1' }, admin)).error, 'case_locked');
});

test('payout accounts start unverified, and duplicates or bad numbers are refused', async () => {
  const p = await partner('vendor');
  const { account } = await svc.addSettlementAccount(p, { method: 'mobile_money', provider: 'mpesa', accountName: 'Shop Ltd', accountNumber: '+255 754 123 456' }, p.actor);
  assert.equal(account.status, 'pending_verification');
  assert.equal(account.isPrimary, false);
  assert.equal(account.accountNumber, '255754123456');
  const again = await svc.addSettlementAccount(p, { method: 'mobile_money', provider: 'mpesa', accountName: 'Shop Ltd', accountNumber: '255754123456' }, p.actor);
  assert.equal(again.error, 'account_already_added');
  assert.equal((await svc.addSettlementAccount(p, { method: 'mobile_money', provider: 'vodacash', accountName: 'x', accountNumber: '0754123456' }, p.actor)).error, 'invalid_provider');
  assert.equal((await svc.addSettlementAccount(p, { method: 'mobile_money', provider: 'mpesa', accountName: 'x', accountNumber: '12345' }, p.actor)).error, 'invalid_mobile_number');
  assert.equal((await svc.addSettlementAccount(p, { method: 'cash' }, p.actor)).error, 'invalid_method');
  const bank = await svc.addSettlementAccount(p, { method: 'bank', provider: 'CRDB', accountName: 'Shop Ltd', accountNumber: '0150-1234567', branch: 'Masaki' }, p.actor);
  assert.equal(bank.account.accountNumber, '01501234567');

  const view = await svc.overview(p);
  assert.equal(item(view, 'marketplace.settlement').status, 'submitted');
  assert.equal((await svc.removeSettlementAccount(p, account.id, p.actor)).ok, true);
  await db('PartnerSettlementAccount').where('id', bank.account.id).update({ status: 'verified', verifiedAt: new Date() });
  assert.equal((await svc.removeSettlementAccount(p, bank.account.id, p.actor)).error, 'account_not_removable');
  const other = await partner('vendor');
  assert.equal((await svc.removeSettlementAccount(other, bank.account.id, other.actor)).error, 'account_not_found');
});

test('companies have no payout account', async () => {
  const corp = await svc.resolvePartner('corporate', await makeCorporate());
  assert.equal((await svc.addSettlementAccount(corp, { method: 'bank' }, admin)).error, 'not_applicable');
});

test('a FitFlex site visit lands on the gym owner\'s case with its score and tier', async () => {
  const gymId = await makeGym();
  const ownerId = await makeUser('gym_operator', { gymId, gymIds: [gymId] });
  const reviewer = await makeUser('admin');
  const result = await svc.recordSiteVisit({
    gymId, body: { result: 'passed', score: 17, maxScore: 20, tier: 'premium', visitedOn: '2026-10-02', notes: 'Good' },
    actor: { id: reviewer, role: 'admin' },
  });
  assert.equal(result.check.evidence.score, 17);
  assert.equal(result.tierMatches, false);
  const view = await svc.overview(await svc.partnerForUser(ownerId));
  assert.equal(item(view, 'operational.site_verification').status, 'complete');
  assert.equal(item(view, 'operational.vetting_score').score, 17);
  assert.equal(item(view, 'operational.gym_tier').status, 'mismatch');

  assert.equal((await svc.recordSiteVisit({ gymId, body: { result: 'maybe' }, actor: admin })).error, 'invalid_result');
  assert.equal((await svc.recordSiteVisit({ gymId, body: { result: 'passed', score: 25, maxScore: 20, tier: 'premium' }, actor: admin })).error, 'invalid_maxScore');
  assert.equal((await svc.recordSiteVisit({ gymId, body: { result: 'passed', score: 5, tier: 'gold' }, actor: admin })).error, 'invalid_tier');
  assert.equal((await svc.recordSiteVisit({ gymId: await makeGym(), body: { result: 'passed', score: 5, tier: 'standard' }, actor: admin })).error, 'gym_has_no_owner');
});

test('corporate KYB is filled in by an admin, reading commercial terms from the corporate account', async () => {
  const corporateId = await makeCorporate();
  const corp = await svc.resolvePartner('corporate', corporateId);
  let view = await svc.updateBusiness(corp, {
    legalName: 'KYC Bank Limited', registrationNumber: 'BRELA-5555', tin: '111-222-333',
    registeredAddress: { line1: 'Ohio St', city: 'Dar es Salaam' }, businessActivity: 'Commercial banking',
  }, admin);
  assert.equal(view.case.corporateId, corporateId);
  assert.equal(view.case.userId, null);
  view = await svc.upsertPerson(corp, 'authorised_representative', {
    fullName: 'Grace Mrema', idType: 'nida', idNumber: '1', position: 'HR Director', phone: '+255700111222', email: 'grace@bank.co.tz',
  }, admin);
  for (const key of ['commercial.seats', 'commercial.pass_tier', 'commercial.subsidy', 'commercial.billing_cycle']) {
    assert.equal(item(view, key).status, 'complete', key);
  }
  assert.equal(item(view, 'commercial.billing_contact').status, 'missing');
  assert.equal(item(view, 'commercial.contract').status, 'missing');

  await corporateService.update({ corporateId, body: { billingContactName: 'Accounts Payable', billingContactEmail: 'ap@bank.co.tz' }, actorId: null });
  view = await svc.recordCorporateContract({ corporateId, body: { version: 'FFB-2026-001', signedOn: '2026-10-01' }, actor: admin });
  assert.equal(item(view, 'commercial.billing_contact').status, 'complete');
  assert.equal(item(view, 'commercial.contract').status, 'complete');
  assert.equal((await svc.recordCorporateContract({ corporateId, body: { version: 'FFB-2026-001' }, actor: admin })).error, 'contract_version_exists');
  await svc.recordCorporateContract({ corporateId, body: { version: 'FFB-2027-001' }, actor: admin });
  const contracts = await db('PartnerAgreement').where('caseId', view.case.id).orderBy('version');
  assert.deepEqual(contracts.map(c => c.status), ['superseded', 'accepted']);
});

test('vendor returns policy and categories save on the vendor profile; unknown keys are dropped', async () => {
  const p = await partner('vendor');
  await shopService.saveVendorProfile({
    vendorId: p.subjectId,
    body: { contactNumber: '+255700000000', email: 'shop@example.com', productCategories: ['Supplements'], deliveryRegions: ['Arusha'],
      returnsPolicy: '7 days, unopened', approvalStatus: 'approved', accountStatus: 'active' },
  });
  const user = await db('User').where('id', p.subjectId).first();
  assert.equal(user.vendorProfile.returnsPolicy, '7 days, unopened');
  assert.equal(user.vendorProfile.approvalStatus, undefined);
  const view = await svc.overview(await svc.partnerForUser(p.subjectId));
  for (const key of ['business.contact', 'marketplace.product_categories', 'marketplace.delivery', 'marketplace.returns']) {
    assert.equal(item(view, key).status, 'complete', key);
  }
});

test('admins list and open cases; the kyc scope can be granted to portal staff', async () => {
  const p = await partner('vendor');
  await svc.updateBusiness(p, { legalName: 'Listed Vendor Ltd' }, p.actor);
  const rows = await svc.listCases({ partnerType: 'vendor', status: 'draft' });
  const row = rows.find(r => r.subjectId === p.subjectId);
  assert.equal(row.legalName, 'Listed Vendor Ltd');
  assert.ok(row.partnerName);
  const detail = await svc.caseDetail(row.id);
  assert.equal(detail.case.id, row.id);
  assert.ok(Array.isArray(detail.checks));
  assert.ok(detail.events.length >= 2);
  assert.equal((await svc.caseDetail('kyc_missing')).error, 'case_not_found');
  assert.equal((await svc.resolvePartner('trainer', p.subjectId)).error, 'partner_not_found');
  assert.ok(PORTAL_ACL_SCOPES.includes('kyc'));
});
