// Partner KYC requirements — the checklist each partner type gets, read from
// the KYC tables and from the records FitFlex already holds (gyms, trainer
// profile, vendor profile, corporate account).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateKyc, documentStatus, currentDocument, addressComplete, KYC_TIERS,
} from '../src/shared/partner-kyc-requirements.mjs';
import { gymProfileGaps, gymRateCardGaps } from '../src/shared/gym-profile.mjs';
import { requiredAgreements } from '../src/shared/partner-agreements.mjs';

const NOW = new Date('2026-10-10T09:00:00Z');
const address = { line1: 'Plot 12, Haile Selassie Rd', city: 'Dar es Salaam' };
const file = { storageProvider: 'zebra', storageKey: 'k', mimeType: 'application/pdf', sizeBytes: 1000, sha256: 'x' };
const doc = (requirementKey, extra = {}) => ({
  id: `d_${requirementKey}`, requirementKey, status: 'accepted', documentNumber: 'N1', createdAt: '2026-10-01T00:00:00Z', ...file, ...extra,
});
const item = (checklist, key, gymId) => checklist.sections.flatMap(s => s.items).find(i => i.key === key && (!gymId || i.gymId === gymId));
const keys = checklist => checklist.sections.map(s => [s.key, s.items.map(i => i.key)]);

const completeGym = {
  id: 'gym_a', name: 'Iron Paradise', location: 'Masaki', coordinates: { lat: -6.75, lng: 39.27 },
  images: ['a.webp'], amenities: ['showers'], equipment: ['racks'], tier: 'midtier', ratePerDay: 8000,
};
const principal = {
  role: 'principal', fullName: 'Asha Mushi', idType: 'nida', idNumber: '19900101123450000112', nationality: 'TZ',
  phone: '+255754123456', email: 'asha@example.com', address, relationship: 'owner',
};
const businessCase = {
  legalName: 'Iron Paradise Ltd', tradingName: 'Iron Paradise', registrationNumber: '123456', tin: '123456789',
  registeredAddress: address, businessActivity: 'Corporate wellness',
};
const passedVisit = (gymId, extra = {}) => ({
  id: `c_${gymId}`, checkType: 'site_visit', targetType: 'gym', targetId: gymId, result: 'passed',
  evidence: { score: 17, maxScore: 20, tier: 'midtier', visitedOn: '2026-10-02' }, createdAt: '2026-10-02T10:00:00Z', ...extra,
});
const verifiedAccount = { status: 'verified' };
/** The partner type's in-app agreements, accepted at their current versions. */
const signed = type => requiredAgreements(type).map(a => ({ agreementType: a.agreementType, version: a.text.version, status: 'accepted' }));
const AGREEMENTS = ['agreements', ['agreements.partner_terms', 'agreements.kyc_consent']];

// ── Shape per partner type ──────────────────────────────────────────────────

test('a gym owner is checked on identity, business, operations and payout', () => {
  const c = evaluateKyc('gym_owner', { gyms: [completeGym], now: NOW });
  assert.equal(c.tier, 3);
  assert.deepEqual(keys(c), [
    ['identity', ['identity.fullName', 'identity.idNumber', 'identity.phone', 'identity.email', 'identity.address', 'identity.relationship', 'identity.id_document']],
    ['business', ['business.legalName', 'business.tradingName', 'business.registrationNumber', 'business.tin', 'business.registeredAddress',
      'business.registration_certificate', 'business.tin_certificate', 'business.licence', 'business.gym_location']],
    ['operational', ['operational.gym_profile', 'operational.rate_card', 'operational.site_verification', 'operational.vetting_score', 'operational.gym_tier']],
    ['settlement', ['settlement.payout_account']],
    AGREEMENTS,
  ]);
});

test('a trainer is checked on identity and professional credentials, not gym affiliation', () => {
  const c = evaluateKyc('trainer', { now: NOW });
  assert.equal(c.tier, 2);
  assert.deepEqual(keys(c), [
    ['identity', ['identity.fullName', 'identity.idNumber', 'identity.phone', 'identity.email', 'identity.address', 'identity.id_document']],
    ['professional', ['professional.certification', 'professional.specialisation', 'professional.liability_cover']],
    ['settlement', ['settlement.payout_account']],
    AGREEMENTS,
  ]);
  assert.ok(!JSON.stringify(c).includes('gym'));
});

test('a vendor is checked on business, representative and marketplace', () => {
  const c = evaluateKyc('vendor', { now: NOW });
  assert.deepEqual(keys(c), [
    ['business', ['business.legalName', 'business.tradingName', 'business.registrationNumber', 'business.tin', 'business.registeredAddress',
      'business.registration_certificate', 'business.tin_certificate', 'business.licence', 'business.contact']],
    ['representative', ['representative.fullName', 'representative.idNumber', 'representative.position', 'representative.authority',
      'representative.id_document', 'representative.authority_document']],
    ['marketplace', ['marketplace.product_categories', 'marketplace.delivery', 'marketplace.returns', 'marketplace.settlement']],
    AGREEMENTS,
  ]);
});

test('a company is checked on company, representative and commercial terms — no payout account, no employee KYC', () => {
  const c = evaluateKyc('corporate', { now: NOW });
  assert.deepEqual(keys(c), [
    ['company', ['company.legalName', 'company.registrationNumber', 'company.tin', 'company.registeredAddress', 'company.businessActivity',
      'company.registration_certificate', 'company.tin_certificate', 'company.licence']],
    ['representative', ['representative.fullName', 'representative.idNumber', 'representative.position', 'representative.phone',
      'representative.email', 'representative.id_document']],
    ['commercial', ['commercial.seats', 'commercial.pass_tier', 'commercial.subsidy', 'commercial.billing_cycle', 'commercial.contract', 'commercial.billing_contact']],
  ]);
  assert.ok(!JSON.stringify(c).includes('settlement'));
  assert.ok(!JSON.stringify(c).toLowerCase().includes('employee'));
});

test('tiers follow the canon: Tier 3 for businesses, Tier 2 for trainers', () => {
  assert.deepEqual(KYC_TIERS, { gym_owner: 3, trainer: 2, vendor: 3, corporate: 3 });
  assert.throws(() => evaluateKyc('member', {}), /unknown partner type/);
});

// ── Gym owner ───────────────────────────────────────────────────────────────

test('a fully documented gym owner with a passed site visit is complete', () => {
  const c = evaluateKyc('gym_owner', {
    case: businessCase, people: [principal], gyms: [completeGym], checks: [passedVisit('gym_a')],
    documents: [doc('owner_id'), doc('business_registration'), doc('tin_certificate'),
      doc('business_licence', { issuer: 'Kinondoni MC', expiresOn: '2027-06-30' })],
    settlementAccounts: [verifiedAccount], agreements: signed('gym_owner'), now: NOW,
  });
  assert.deepEqual(c.missing, []);
  assert.deepEqual(c.awaitingReview, []);
  assert.equal(c.readyToSubmit, true);
  assert.equal(c.complete, true);
  assert.deepEqual(item(c, 'operational.vetting_score'), { key: 'operational.vetting_score', by: 'reviewer', gymId: 'gym_a', gymName: 'Iron Paradise', status: 'complete', score: 17, maxScore: 20 });
});

test('site visits, vetting and tier are FitFlex steps: they never block the owner from submitting', () => {
  const c = evaluateKyc('gym_owner', {
    case: businessCase, people: [principal], gyms: [completeGym],
    documents: [doc('owner_id'), doc('business_registration'), doc('tin_certificate'),
      doc('business_licence', { issuer: 'Kinondoni MC', expiresOn: '2027-06-30' })],
    settlementAccounts: [{ status: 'pending_verification' }], agreements: signed('gym_owner'), now: NOW,
  });
  assert.equal(c.readyToSubmit, true);
  assert.equal(c.complete, false);
  assert.deepEqual(c.awaitingReview, [
    'operational.site_verification@gym_a', 'operational.vetting_score@gym_a', 'operational.gym_tier@gym_a', 'settlement.payout_account',
  ]);
});

test('each gym is vetted on its own, and a tier different from the vetted one is flagged', () => {
  const second = { ...completeGym, id: 'gym_b', name: 'Branch', tier: 'standard' };
  const c = evaluateKyc('gym_owner', { gyms: [completeGym, second], checks: [passedVisit('gym_a'), passedVisit('gym_b')], now: NOW });
  assert.equal(item(c, 'operational.gym_tier', 'gym_a').status, 'complete');
  assert.deepEqual(
    { ...item(c, 'operational.gym_tier', 'gym_b') },
    { key: 'operational.gym_tier', by: 'reviewer', gymId: 'gym_b', gymName: 'Branch', status: 'mismatch', gymTier: 'standard', vettedTier: 'midtier' },
  );
});

test('the latest site visit counts, and a failed one fails the gym', () => {
  const c = evaluateKyc('gym_owner', {
    gyms: [completeGym],
    checks: [passedVisit('gym_a'), passedVisit('gym_a', { id: 'c2', result: 'failed', createdAt: '2026-10-05T10:00:00Z' })],
    now: NOW,
  });
  assert.equal(item(c, 'operational.site_verification').status, 'failed');
  assert.equal(item(c, 'operational.site_verification').checkId, 'c2');
});

test('gym profile and rate card come from the gym itself', () => {
  const bare = { id: 'gym_x', name: 'Bare', location: 'Kariakoo', coordinates: { lat: -6.8, lng: 39.2 }, images: [], amenities: [], equipment: [], ratePerDay: 0 };
  const c = evaluateKyc('gym_owner', { gyms: [bare], now: NOW });
  assert.deepEqual(item(c, 'operational.gym_profile').missingFields, ['photos', 'amenities', 'equipment']);
  assert.equal(item(c, 'operational.rate_card').status, 'missing');
  assert.equal(item(c, 'business.gym_location').status, 'complete');
  const noGyms = evaluateKyc('gym_owner', { now: NOW });
  assert.equal(item(noGyms, 'business.gym_location').status, 'missing');
  assert.equal(item(noGyms, 'operational.gym_profile').status, 'missing');
});

test('the gym profile rule treats southern-hemisphere coordinates as present and free online gyms as having no rates', () => {
  assert.deepEqual(gymProfileGaps(completeGym), []);
  assert.deepEqual(gymProfileGaps({ ...completeGym, coordinates: { lat: '', lng: 39 } }), ['coordinates']);
  assert.deepEqual(gymRateCardGaps({ venueType: 'online' }), []);
  assert.deepEqual(gymRateCardGaps({ perVisitRate: 5000 }), []);
  assert.deepEqual(gymRateCardGaps({}), ['day_rate']);
});

test('the principal must say how they relate to the business and give a full address', () => {
  const c = evaluateKyc('gym_owner', { people: [{ ...principal, relationship: null, address: { city: 'Dar es Salaam' } }], now: NOW });
  assert.equal(item(c, 'identity.relationship').status, 'missing');
  assert.equal(item(c, 'identity.address').status, 'missing');
  assert.ok(addressComplete(address));
  assert.ok(!addressComplete({ line1: 'x' }));
});

// ── Trainer ─────────────────────────────────────────────────────────────────

test('a trainer needs a NIDA number if Tanzanian and a passport otherwise', () => {
  const tz = evaluateKyc('trainer', { people: [{ ...principal, idType: 'passport' }], now: NOW });
  assert.deepEqual(item(tz, 'identity.idNumber'), { key: 'identity.idNumber', by: 'partner', status: 'incomplete', missingFields: ['idType'], expectedIdType: 'nida' });
  const foreign = evaluateKyc('trainer', { people: [{ ...principal, nationality: 'KE', idType: 'passport' }], now: NOW });
  assert.equal(item(foreign, 'identity.idNumber').status, 'complete');
});

test('a certification needs its body, number and issue date; the expiry date is optional', () => {
  const c = evaluateKyc('trainer', {
    documents: [doc('certification', { issuer: 'ACE', documentNumber: 'ACE-1', issuedOn: null, expiresOn: null })],
    trainer: { specialties: ['strength'] }, now: NOW,
  });
  assert.deepEqual(item(c, 'professional.certification').missingFields, ['issuedOn']);
  const noExpiry = evaluateKyc('trainer', {
    documents: [{ ...doc('certification', { issuer: 'ACE', documentNumber: 'ACE-1', issuedOn: '2025-01-01', expiresOn: null }) }],
    trainer: { specialties: ['strength'] }, now: NOW,
  });
  assert.notEqual(item(noExpiry, 'professional.certification').status, 'incomplete', 'no expiry date is not a gap');
  assert.equal(item(c, 'professional.specialisation').status, 'complete');
  assert.equal(item(c, 'professional.liability_cover').status, 'missing');
});

test('specialisation is read from the trainer profile', () => {
  assert.equal(item(evaluateKyc('trainer', { trainer: { specialties: [] }, now: NOW }), 'professional.specialisation').status, 'missing');
});

// ── Documents ───────────────────────────────────────────────────────────────

test('document states: missing, incomplete, waiting for file, submitted, accepted, rejected, expired', () => {
  const key = 'liability_insurance';
  const base = { requirementKey: key, issuer: 'Jubilee', documentNumber: 'P-9', expiresOn: '2027-01-01', status: 'pending' };
  assert.equal(documentStatus(null, key, NOW).status, 'missing');
  assert.deepEqual(documentStatus({ ...base, issuer: null }, key, NOW), { status: 'incomplete', missingFields: ['issuer'] });
  assert.equal(documentStatus(base, key, NOW).status, 'file_missing');
  assert.equal(documentStatus({ ...base, ...file }, key, NOW).status, 'submitted');
  assert.equal(documentStatus({ ...base, ...file, status: 'accepted' }, key, NOW).status, 'complete');
  assert.deepEqual(documentStatus({ ...base, ...file, status: 'rejected', reviewNote: 'Blurred' }, key, NOW), { status: 'rejected', note: 'Blurred' });
  assert.equal(documentStatus({ ...base, ...file, status: 'accepted', expiresOn: '2026-10-09' }, key, NOW).status, 'expired');
});

test('only the newest document for a requirement stands', () => {
  const docs = [
    { id: 'old', requirementKey: 'tin_certificate', status: 'rejected', createdAt: '2026-09-01T00:00:00Z' },
    { id: 'new', requirementKey: 'tin_certificate', status: 'pending', createdAt: '2026-10-01T00:00:00Z' },
    { id: 'gone', requirementKey: 'tin_certificate', status: 'superseded', createdAt: '2026-10-05T00:00:00Z' },
  ];
  assert.equal(currentDocument(docs, 'tin_certificate').id, 'new');
  assert.equal(currentDocument(docs, 'business_licence'), null);
});

test('a document waiting for its file keeps the partner from submitting', () => {
  const c = evaluateKyc('trainer', {
    people: [principal], trainer: { specialties: ['yoga'] }, settlementAccounts: [verifiedAccount],
    documents: [doc('trainer_id'), doc('certification', { issuer: 'ACE', issuedOn: '2024-01-01', expiresOn: '2027-01-01' }),
      doc('liability_insurance', { issuer: 'Jubilee', expiresOn: '2027-01-01', storageKey: null, status: 'pending' })],
    agreements: signed('trainer'), now: NOW,
  });
  assert.deepEqual(c.missing, ['professional.liability_cover']);
  assert.equal(c.readyToSubmit, false);
});

// ── Vendor ──────────────────────────────────────────────────────────────────

test('vendor contact and marketplace details come from the existing vendor profile', () => {
  const c = evaluateKyc('vendor', {
    vendorProfile: { contactNumber: '+255700000000', email: 'shop@example.com', businessCategory: 'Supplements', deliveryRegions: ['Dar es Salaam'] },
    settlementAccounts: [{ status: 'pending_verification' }], now: NOW,
  });
  assert.equal(item(c, 'business.contact').status, 'complete');
  assert.equal(item(c, 'marketplace.product_categories').status, 'complete');
  assert.equal(item(c, 'marketplace.delivery').status, 'complete');
  assert.equal(item(c, 'marketplace.returns').status, 'missing');
  assert.equal(item(c, 'marketplace.settlement').status, 'submitted');
});

test('a vendor representative needs a position, signing authority and proof of it', () => {
  const rep = { role: 'authorised_representative', fullName: 'John Kimaro', idType: 'nida', idNumber: '1', position: 'Director' };
  const c = evaluateKyc('vendor', { people: [rep], now: NOW });
  assert.equal(item(c, 'representative.authority').status, 'missing');
  assert.equal(item(c, 'representative.authority_document').status, 'missing');
  const withAuthority = evaluateKyc('vendor', { people: [{ ...rep, authority: 'sole_signatory' }], documents: [doc('representative_authority')], now: NOW });
  assert.equal(item(withAuthority, 'representative.authority').status, 'complete');
  assert.equal(item(withAuthority, 'representative.authority_document').status, 'complete');
});

// ── Corporate ───────────────────────────────────────────────────────────────

test('corporate commercial terms come from the corporate account, plus a signed contract', () => {
  const corporate = {
    seatLimit: 120, passTier: 'pro', subsidyModel: 'copay_70_30', billingCycle: 'monthly',
    billingContactName: 'Grace Finance', billingContactEmail: 'ap@bank.co.tz',
  };
  const c = evaluateKyc('corporate', { corporate, agreements: [{ agreementType: 'corporate_contract', status: 'accepted' }], now: NOW });
  for (const key of ['commercial.seats', 'commercial.pass_tier', 'commercial.subsidy', 'commercial.billing_cycle', 'commercial.contract', 'commercial.billing_contact']) {
    assert.equal(item(c, key).status, 'complete', key);
  }
  const noSeats = evaluateKyc('corporate', { corporate: { ...corporate, seatLimit: 0 }, agreements: [{ agreementType: 'corporate_contract', status: 'superseded' }], now: NOW });
  assert.equal(item(noSeats, 'commercial.seats').status, 'missing');
  assert.equal(item(noSeats, 'commercial.contract').status, 'missing');
});

// ── D6: for vendors and companies only the TIN and representative ID are required ──

test('a vendor with just the TIN, representative ID and marketplace details can submit', () => {
  const rep = { role: 'authorised_representative', fullName: 'John Kimaro', idType: 'nida', idNumber: '1' };
  const c = evaluateKyc('vendor', {
    case: { tin: '123456789' }, people: [rep], documents: [doc('representative_id')],
    vendorProfile: { contactNumber: '+255700000000', email: 'shop@example.com', businessCategory: 'Gear', deliveryRegions: ['Dar'], returnsPolicy: '7 days' },
    settlementAccounts: [verifiedAccount], agreements: signed('vendor'), now: NOW,
  });
  assert.deepEqual(c.missing, []);
  assert.equal(c.readyToSubmit, true);
  assert.equal(c.complete, true);
  const optional = c.sections.flatMap(s => s.items).filter(i => i.optional).map(i => i.key);
  assert.deepEqual(optional.sort(), [
    'business.legalName', 'business.licence', 'business.registeredAddress', 'business.registrationNumber',
    'business.registration_certificate', 'business.tin_certificate', 'business.tradingName',
    'representative.authority', 'representative.authority_document', 'representative.position',
  ]);
  assert.equal(item(c, 'business.licence').status, 'missing'); // collected if given, never required
});

test('a vendor without the TIN or the representative\'s ID can\'t submit', () => {
  const c = evaluateKyc('vendor', { now: NOW });
  for (const key of ['business.tin', 'representative.fullName', 'representative.idNumber', 'representative.id_document']) {
    assert.ok(c.missing.includes(key), key);
  }
  assert.ok(!c.missing.includes('business.legalName'));
  assert.ok(!c.missing.includes('business.licence'));
});

test('a company needs its TIN, representative ID and commercial terms; the rest is optional', () => {
  const corporate = { seatLimit: 50, passTier: 'pro', subsidyModel: 'fully_funded', billingCycle: 'monthly', billingContactName: 'AP', billingContactEmail: 'ap@x.co.tz' };
  const rep = { role: 'authorised_representative', fullName: 'Grace Mrema', idType: 'nida', idNumber: '1' };
  const c = evaluateKyc('corporate', {
    case: { tin: '111222333' }, people: [rep], documents: [doc('representative_id')], corporate,
    agreements: [{ agreementType: 'corporate_contract', status: 'accepted' }], now: NOW,
  });
  assert.deepEqual(c.missing, []);
  assert.equal(c.complete, true);
  assert.equal(item(c, 'company.licence').optional, true);
  assert.equal(item(c, 'representative.email').optional, true);
});

test('gym owners and trainers keep every item required', () => {
  for (const type of ['gym_owner', 'trainer']) {
    const c = evaluateKyc(type, { now: NOW });
    assert.equal(c.sections.flatMap(s => s.items).some(i => i.optional), false, type);
  }
});
