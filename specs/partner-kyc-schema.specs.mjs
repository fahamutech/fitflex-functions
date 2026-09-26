// Partner KYC — schema and store against the CI database: rows round-trip
// through the collection API (jsonb, doubles, timestamps, identifiers), and the database itself refuses what must never happen —
// two cases for one partner, a corporate case pointing at a user, a
// rejection with no reason, an unverified payout account marked primary,
// two primary accounts, or a rewritten timeline entry.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import {
  partnerKycCases, partnerPeople, partnerSettlementAccounts, partnerDocuments,
  partnerChecks, partnerAgreements, partnerKycEvents,
} from '../src/bootstrap/collections.mjs';
import { normalizeIdentifier } from '../src/shared/partner-kyc.mjs';

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const now = () => new Date().toISOString();
const created = { users: [], gyms: [], corporates: [] };

async function makeUser(userType = 'trainer') {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: 'KYC Test', updatedAt: new Date() });
  created.users.push(id);
  return id;
}

async function makeGym() {
  const id = uid('gym');
  await db('Gym').insert({ id, name: 'KYC Test Gym', tier: 'standard', location: 'Dar es Salaam', updatedAt: new Date() });
  created.gyms.push(id);
  return id;
}

async function makeCorporate() {
  const id = uid('corp');
  await db('CorporateAccount').insert({
    id, companyName: 'KYC Test Ltd', industrySector: 'banking', workforceBracket: '50-100',
    subsidyModel: 'fully_funded', passTier: 'basic',
  });
  created.corporates.push(id);
  return id;
}

async function makeCase(overrides = {}) {
  const userId = overrides.corporateId ? null : (overrides.userId ?? await makeUser());
  const row = await partnerKycCases.insertAsync({
    id: uid('kyc'), partnerType: 'trainer', userId, tier: 2, createdAt: now(), ...overrides,
  });
  return row;
}

async function rejects(promise, code) {
  await assert.rejects(promise, (err) => err.code === code, `expected Postgres error ${code}`);
}

after(async () => {
  // Every KYC row cascades from its partner.
  if (created.corporates.length) await db('CorporateAccount').whereIn('id', created.corporates).del();
  if (created.gyms.length) await db('Gym').whereIn('id', created.gyms).del();
  if (created.users.length) await db('User').whereIn('id', created.users).del();
});

test('a gym owner case round-trips its business profile, and duplicate TINs can be found', async () => {
  const userId = await makeUser('gym_operator');
  const id = uid('kyc');
  await partnerKycCases.insertAsync({
    id, partnerType: 'gym_owner', userId, tier: 3,
    legalName: 'Iron Paradise Ltd', entityType: 'company', registrationNumber: '123456',
    registrationAuthority: 'BRELA', incorporatedOn: '2019-03-01',
    registeredAddress: { street: 'Haile Selassie Rd', city: 'Dar es Salaam' },
    tin: normalizeIdentifier('123-456-789'),
    createdAt: now(),
  });
  const row = await partnerKycCases.findByIdAsync(id);
  assert.equal(row.status, 'draft');
  assert.equal(row.round, 1);
  assert.equal(row.registeredAddress.city, 'Dar es Salaam');
  assert.equal(row.tin, '123456789');
  const sameTin = await partnerKycCases.filterByColumnAsync('tin', normalizeIdentifier('123 456 789'));
  assert.deepEqual(sameTin.map(c => c.id), [id]);
});

test('a partner has exactly one case', async () => {
  const userId = await makeUser();
  await makeCase({ userId });
  await rejects(makeCase({ userId }), '23505');
});

test('the same person can hold separate cases in separate partner roles', async () => {
  const userId = await makeUser('trainer');
  await makeCase({ userId, partnerType: 'trainer' });
  const other = await makeCase({ userId, partnerType: 'vendor', tier: 3 });
  assert.equal(other.partnerType, 'vendor');
});

test('a corporate case points at the company, never at a user', async () => {
  const corporateId = await makeCorporate();
  const row = await makeCase({ partnerType: 'corporate', corporateId, userId: null, tier: 3 });
  assert.equal(row.corporateId, corporateId);
  await rejects(makeCase({ partnerType: 'corporate', corporateId: await makeCorporate(), userId: await makeUser(), tier: 3 }), '23514');
  await rejects(makeCase({ partnerType: 'trainer', userId: null, corporateId: await makeCorporate() }), '23514');
  await rejects(makeCase({ partnerType: 'corporate', corporateId }), '23505');
});

test('unknown partner types and statuses are refused', async () => {
  await rejects(makeCase({ partnerType: 'member' }), '23514');
  await rejects(makeCase({ status: 'approved_ish' }), '23514');
  await rejects(makeCase({ tier: 1 }), '23514');
  await rejects(makeCase({ incorporatedOn: '01/03/2019' }), '23514');
});

test('rejecting, requesting info or suspending needs a reason code', async () => {
  const kyc = await makeCase();
  await rejects(partnerKycCases.updateByIdAsync(kyc.id, { status: 'rejected' }), '23514');
  const updated = await partnerKycCases.updateByIdAsync(kyc.id, {
    status: 'rejected', reasonCode: 'document_unreadable', reasonNote: 'ID photo is blurred', decidedAt: now(),
  });
  assert.equal(updated.status, 'rejected');
});

test('people: principal, directors, beneficial owners and representatives share one table', async () => {
  const kyc = await makeCase({ partnerType: 'vendor', userId: await makeUser('vendor'), tier: 3 });
  const owner = await partnerPeople.insertAsync({
    id: uid('ppl'), caseId: kyc.id, role: 'beneficial_owner', fullName: 'Asha Mushi', ownershipPct: 62.5,
    idType: 'nida', idNumber: normalizeIdentifier('19900101-12345-00001-12'), createdAt: now(),
  });
  const row = await partnerPeople.findByIdAsync(owner.id);
  assert.equal(row.ownershipPct, 62.5);
  assert.equal(row.nationality, 'TZ');
  assert.equal(row.isPoliticallyExposed, false);
  assert.equal(row.idNumber, '19900101123450000112');
  await partnerPeople.insertAsync({
    id: uid('ppl'), caseId: kyc.id, role: 'authorised_representative', fullName: 'John Kimaro', position: 'Finance Manager', createdAt: now(),
  });
  // A beneficial owner must state a holding, and it must be a real percentage.
  await rejects(partnerPeople.insertAsync({ id: uid('ppl'), caseId: kyc.id, role: 'beneficial_owner', fullName: 'X', createdAt: now() }), '23514');
  await rejects(partnerPeople.insertAsync({ id: uid('ppl'), caseId: kyc.id, role: 'director', fullName: 'X', ownershipPct: 120, createdAt: now() }), '23514');
  await rejects(partnerPeople.insertAsync({ id: uid('ppl'), caseId: kyc.id, role: 'cousin', fullName: 'X', createdAt: now() }), '23514');
});

test('settlement accounts: only a verified account can be primary, and only one', async () => {
  const kyc = await makeCase();
  const account = (extra = {}) => partnerSettlementAccounts.insertAsync({
    id: uid('psa'), caseId: kyc.id, method: 'mobile_money', provider: 'mpesa', accountName: 'KYC Test',
    accountNumber: normalizeIdentifier('0754 123 456'), createdAt: now(), ...extra,
  });
  const pending = await partnerSettlementAccounts.findByIdAsync((await account()).id);
  assert.equal(pending.status, 'pending_verification');
  assert.equal(pending.isPrimary, false);
  assert.equal(pending.accountNumber, '0754123456');
  await rejects(account({ isPrimary: true }), '23514');
  await rejects(account({ method: 'cash' }), '23514');
  await rejects(partnerSettlementAccounts.insertAsync({
    id: uid('psa'), caseId: kyc.id, method: 'bank', provider: 'CRDB', accountName: 'No Number', createdAt: now(),
  }), '23514');

  const verifiedAt = now();
  await partnerSettlementAccounts.updateByIdAsync(pending.id, {
    status: 'verified', isPrimary: true, verifiedAt, cooldownUntil: new Date(Date.now() + 48 * 3_600_000).toISOString(),
  });
  const primary = await partnerSettlementAccounts.findByIdAsync(pending.id);
  assert.equal(primary.isPrimary, true);
  assert.ok(new Date(primary.cooldownUntil) > new Date());
  await rejects(account({ status: 'verified', isPrimary: true }), '23505');
});

test('documents record the stored file and refuse other file types or sizes', async () => {
  const gymId = await makeGym();
  const kyc = await makeCase({ partnerType: 'gym_owner', userId: await makeUser('gym_operator'), tier: 3 });
  const doc = (extra = {}) => partnerDocuments.insertAsync({
    id: uid('pdoc'), caseId: kyc.id, requirementKey: 'business_licence', docType: 'business_licence',
    storageProvider: 'zebra', storageKey: 'bafy-test', fileName: 'licence.pdf',
    mimeType: 'application/pdf', sizeBytes: 204_800, sha256: 'a'.repeat(64), expiresOn: '2027-06-30',
    documentNumber: normalizeIdentifier('BL/2025/0042'), createdAt: now(), ...extra,
  });
  const first = await partnerDocuments.findByIdAsync((await doc()).id);
  assert.equal(first.status, 'pending');
  assert.equal(first.round, 1);
  const site = await doc({ requirementKey: 'site_visit', docType: 'site_photo', mimeType: 'image/webp', gymId });
  assert.equal(site.gymId, gymId);
  const replacement = await doc({ supersedesId: first.id });
  assert.equal(replacement.supersedesId, first.id);
  await rejects(doc({ mimeType: 'application/x-msdownload' }), '23514');
  await rejects(doc({ sizeBytes: 11 * 1024 * 1024 }), '23514');
  await rejects(doc({ expiresOn: '30/06/2027' }), '23514');
});

test('checks cover identity, site visits and settlement verification in one table', async () => {
  const gymId = await makeGym();
  const reviewer = await makeUser('admin');
  const kyc = await makeCase({ partnerType: 'gym_owner', userId: await makeUser('gym_operator'), tier: 3 });
  const visit = await partnerChecks.insertAsync({
    id: uid('pchk'), caseId: kyc.id, checkType: 'site_visit', targetType: 'gym', targetId: gymId, method: 'site_visit',
    result: 'passed', evidence: { rubricScore: 17, photos: 4 }, performedBy: reviewer, performedAt: now(), createdAt: now(),
  });
  const row = await partnerChecks.findByIdAsync(visit.id);
  assert.equal(row.evidence.rubricScore, 17);
  const caseLevel = await partnerChecks.findByIdAsync((await partnerChecks.insertAsync({
    id: uid('pchk'), caseId: kyc.id, checkType: 'sanctions', targetType: 'case', method: 'manual', createdAt: now(),
  })).id);
  assert.equal(caseLevel.result, 'pending');
  assert.deepEqual(caseLevel.evidence, {});
  // Only case-level checks go without a target, and a finished check says when it ran.
  await rejects(partnerChecks.insertAsync({ id: uid('pchk'), caseId: kyc.id, checkType: 'identity', targetType: 'person', method: 'manual', createdAt: now() }), '23514');
  await rejects(partnerChecks.insertAsync({ id: uid('pchk'), caseId: kyc.id, checkType: 'tax', targetType: 'case', method: 'manual', result: 'passed', createdAt: now() }), '23514');
});

test('a registry lookup records which registry answered and what it returned', async () => {
  const kyc = await makeCase();
  const person = await partnerPeople.insertAsync({
    id: uid('ppl'), caseId: kyc.id, role: 'principal', fullName: 'Neema Said', idType: 'nida',
    idNumber: normalizeIdentifier('19950505-11111-00002-21'), createdAt: now(),
  });
  const check = await partnerChecks.insertAsync({
    id: uid('pchk'), caseId: kyc.id, checkType: 'identity', targetType: 'person', targetId: person.id,
    method: 'provider', provider: 'nida', result: 'passed', performedAt: now(),
    evidence: { fullName: 'NEEMA SAID', dateOfBirth: '1995-05-05', matchedName: true }, createdAt: now(),
  });
  const row = await partnerChecks.findByIdAsync(check.id);
  assert.equal(row.provider, 'nida');
  assert.equal(row.evidence.matchedName, true);
  // A provider check must name one of the known registries.
  await rejects(partnerChecks.insertAsync({
    id: uid('pchk'), caseId: kyc.id, checkType: 'tax', targetType: 'case', method: 'provider', createdAt: now(),
  }), '23514');
  await rejects(partnerChecks.insertAsync({
    id: uid('pchk'), caseId: kyc.id, checkType: 'tax', targetType: 'case', method: 'provider', provider: 'google', createdAt: now(),
  }), '23514');
});

test('an agreement version is accepted once per partner', async () => {
  const kyc = await makeCase();
  const accepted = { caseId: kyc.id, agreementType: 'partner_agreement', version: '2026-10', acceptedAt: now(), acceptedIp: '41.59.0.1', createdAt: now() };
  const row = await partnerAgreements.findByIdAsync((await partnerAgreements.insertAsync({ id: uid('pagr'), ...accepted })).id);
  assert.equal(row.status, 'accepted');
  await rejects(partnerAgreements.insertAsync({ id: uid('pagr'), ...accepted }), '23505');
  await partnerAgreements.insertAsync({ id: uid('pagr'), ...accepted, version: '2027-01' });
});

test('the timeline is append-only', async () => {
  const kyc = await makeCase();
  const event = await partnerKycEvents.insertAsync({
    id: uid('pevt'), caseId: kyc.id, round: 1, eventType: 'status_changed', fromStatus: 'draft', toStatus: 'submitted',
    actorRole: 'partner', data: { missing: [] }, at: now(),
  });
  const row = await partnerKycEvents.findByIdAsync(event.id);
  assert.deepEqual(row.data, { missing: [] });
  await rejects(partnerKycEvents.updateByIdAsync(event.id, { note: 'rewritten' }), 'P0001');
  await rejects(partnerKycEvents.insertAsync({ id: uid('pevt'), caseId: kyc.id, round: 1, eventType: 'hacked', at: now() }), '23514');
});

test('deleting the partner removes the whole case with it', async () => {
  const userId = await makeUser();
  const kyc = await makeCase({ userId });
  await partnerPeople.insertAsync({ id: uid('ppl'), caseId: kyc.id, role: 'principal', fullName: 'Gone Soon', createdAt: now() });
  await partnerKycEvents.insertAsync({ id: uid('pevt'), caseId: kyc.id, round: 1, eventType: 'note', at: now() });
  await db('User').where('id', userId).del();
  assert.equal(await partnerKycCases.findByIdAsync(kyc.id), null);
  assert.equal((await db('PartnerPerson').where('caseId', kyc.id)).length, 0);
  assert.equal((await db('PartnerKycEvent').where('caseId', kyc.id)).length, 0);
});
