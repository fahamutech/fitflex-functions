// Partner KYC requirements — what each partner type must provide, and a pure
// evaluator that turns a partner's records into a checklist.
//
// Requirements read from where the data already lives. Only what FitFlex has
// nowhere else is held in the KYC tables:
//   - Gym profile, rate card, location and tier: the existing Gym rows.
//   - Trainer specialisation: TrainerProfile.specialties.
//   - Vendor contact, categories, delivery and returns: User.vendorProfile.
//   - Corporate seats, pass tier, subsidy, billing cycle and billing
//     contact: CorporateAccount.
//   - Identity, representatives, business details, documents, site visits
//     and payout accounts: the Partner* tables.
// Gym affiliation is not part of KYC: a verified trainer applies to a gym and
// the gym owner approves (TrainerProfile.pendingGymIds → gymIds).
// Corporate employees get no KYC of their own; only the company does.
import { gymProfileGaps, gymRateCardGaps } from './gym-profile.mjs';
import { requiredAgreements } from './partner-agreements.mjs';

// Who completes an item: the partner (or an admin on their behalf), or a
// FitFlex reviewer (site visits, vetting).
export const BY_PARTNER = 'partner';
export const BY_REVIEWER = 'reviewer';

// Item statuses. Only 'complete' and 'submitted' count as provided.
export const ITEM_STATUSES = [
  'complete',     // provided and, where it is reviewed, accepted
  'submitted',    // provided, waiting for review
  'missing',      // nothing yet
  'incomplete',   // started, but required fields are missing (see missingFields)
  'file_missing', // document details given, the file is not uploaded yet
  'rejected',     // a reviewer rejected it
  'expired',      // past its expiry date
  'failed',       // a reviewer check did not pass
  'mismatch',     // a reviewer check disagrees with the record (e.g. gym tier)
];
const PROVIDED = new Set(['complete', 'submitted']);

// Documents per requirement key: accepted document types, and the details
// that must be filled in besides the file.
export const DOCUMENT_REQUIREMENTS = Object.freeze({
  owner_id: { types: ['national_id', 'passport'], fields: ['documentNumber'], expires: true },
  trainer_id: { types: ['national_id', 'passport'], fields: ['documentNumber'], expires: true },
  representative_id: { types: ['national_id', 'passport'], fields: ['documentNumber'], expires: true },
  business_registration: { types: ['business_registration'], fields: ['documentNumber'] },
  tin_certificate: { types: ['tin_certificate'], fields: ['documentNumber'] },
  business_licence: { types: ['business_licence'], fields: ['documentNumber', 'issuer', 'expiresOn'], expires: true },
  certification: { types: ['certification'], fields: ['issuer', 'documentNumber', 'issuedOn', 'expiresOn'], expires: true },
  liability_insurance: { types: ['liability_insurance'], fields: ['issuer', 'documentNumber', 'expiresOn'], expires: true },
  representative_authority: { types: ['letter_of_authority', 'board_resolution'], fields: [] },
});

// The one person each partner type must name, and which of their details
// are required.
export const PERSON_REQUIREMENTS = Object.freeze({
  gym_owner: { role: 'principal', fields: ['fullName', 'idNumber', 'phone', 'email', 'address', 'relationship'], idDocument: 'owner_id' },
  trainer: { role: 'principal', fields: ['fullName', 'idNumber', 'phone', 'email', 'address'], idDocument: 'trainer_id', nationalId: true },
  vendor: { role: 'authorised_representative', fields: ['fullName', 'idNumber', 'position', 'authority'], idDocument: 'representative_id' },
  corporate: { role: 'authorised_representative', fields: ['fullName', 'idNumber', 'position', 'phone', 'email'], idDocument: 'representative_id' },
});

// Business fields on the KYC case each type must complete.
export const BUSINESS_REQUIREMENTS = Object.freeze({
  gym_owner: ['legalName', 'tradingName', 'registrationNumber', 'tin', 'registeredAddress'],
  trainer: [],
  vendor: ['legalName', 'tradingName', 'registrationNumber', 'tin', 'registeredAddress'],
  corporate: ['legalName', 'registrationNumber', 'tin', 'registeredAddress', 'businessActivity'],
});

export const KYC_TIERS = Object.freeze({ gym_owner: 3, trainer: 2, vendor: 3, corporate: 3 });

// Which documents each type needs, by requirement key.
export const DOCUMENTS_FOR = Object.freeze({
  gym_owner: ['owner_id', 'business_registration', 'tin_certificate', 'business_licence'],
  trainer: ['trainer_id', 'certification', 'liability_insurance'],
  vendor: ['business_registration', 'tin_certificate', 'business_licence', 'representative_id', 'representative_authority'],
  corporate: ['business_registration', 'tin_certificate', 'business_licence', 'representative_id'],
});

// Collected but not required for verification (owner decision D6, 28 Sep
// 2026): for vendors and companies only the TIN and the representative's ID
// are mandatory. Optional items show in the checklist and are reviewed if
// given, but never hold up submitting or approving.
export const OPTIONAL_ITEMS = Object.freeze({
  vendor: new Set([
    'business.legalName', 'business.tradingName', 'business.registrationNumber', 'business.registeredAddress',
    'business.registration_certificate', 'business.tin_certificate', 'business.licence',
    'representative.position', 'representative.authority', 'representative.authority_document',
  ]),
  corporate: new Set([
    'company.legalName', 'company.registrationNumber', 'company.registeredAddress', 'company.businessActivity',
    'company.registration_certificate', 'company.tin_certificate', 'company.licence',
    'representative.position', 'representative.phone', 'representative.email',
  ]),
});

export const SETTLEMENT_REQUIRED = Object.freeze({ gym_owner: true, trainer: true, vendor: true, corporate: false });

// ── Helpers ─────────────────────────────────────────────────────────────────

const filled = (v) => {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.values(v).some(filled);
  if (typeof v === 'number') return Number.isFinite(v) && v > 0;
  return Boolean(v);
};

/** A postal address counts when it has a street line and a city. */
export function addressComplete(address) {
  return Boolean(address && filled(address.line1) && filled(address.city));
}

const fieldFilled = (key, value) => (key === 'address' || key === 'registeredAddress' ? addressComplete(value) : filled(value));

const fieldItem = (key, value, extra = {}) => ({ key, by: BY_PARTNER, status: filled(value) ? 'complete' : 'missing', ...extra });

const today = (now) => new Date(now).toISOString().slice(0, 10);

const byNewest = (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''));

/** The document currently standing for a requirement: the newest one not superseded. */
export function currentDocument(documents = [], requirementKey) {
  return documents.filter(d => d.requirementKey === requirementKey && d.status !== 'superseded').sort(byNewest)[0] || null;
}

export function documentStatus(doc, requirementKey, now = new Date()) {
  const spec = DOCUMENT_REQUIREMENTS[requirementKey] || { fields: [] };
  if (!doc) return { status: 'missing' };
  if (doc.status === 'rejected') return { status: 'rejected', note: doc.reviewNote || null };
  if (doc.status === 'expired' || (doc.expiresOn && doc.expiresOn < today(now))) return { status: 'expired', expiresOn: doc.expiresOn };
  const missingFields = spec.fields.filter(f => !filled(doc[f]));
  if (missingFields.length) return { status: 'incomplete', missingFields };
  if (!doc.storageKey) return { status: 'file_missing' };
  return { status: doc.status === 'accepted' ? 'complete' : 'submitted', expiresOn: doc.expiresOn || null };
}

const documentItem = (key, documents, requirementKey, now) => ({
  key, by: BY_PARTNER, requirementKey, ...documentStatus(currentDocument(documents, requirementKey), requirementKey, now),
});

function settlementItem(accounts = []) {
  const live = accounts.filter(a => a.status === 'verified' || a.status === 'pending_verification');
  if (live.some(a => a.status === 'verified')) return { key: 'settlement.payout_account', by: BY_PARTNER, status: 'complete' };
  if (live.length) return { key: 'settlement.payout_account', by: BY_PARTNER, status: 'submitted' };
  if (accounts.some(a => a.status === 'rejected')) return { key: 'settlement.payout_account', by: BY_PARTNER, status: 'rejected' };
  return { key: 'settlement.payout_account', by: BY_PARTNER, status: 'missing' };
}

function personItems(section, partnerType, people = [], documents = [], now) {
  const spec = PERSON_REQUIREMENTS[partnerType];
  const person = people.find(p => p.role === spec.role) || {};
  const items = spec.fields.map(field => {
    const item = { key: `${section}.${field}`, by: BY_PARTNER, status: fieldFilled(field, person[field]) ? 'complete' : 'missing' };
    // Trainers need a national ID: NIDA for Tanzanians, a passport otherwise.
    if (field === 'idNumber' && spec.nationalId && item.status === 'complete') {
      const expected = (person.nationality || 'TZ') === 'TZ' ? 'nida' : 'passport';
      if (person.idType !== expected) return { ...item, status: 'incomplete', missingFields: ['idType'], expectedIdType: expected };
    }
    if (field === 'idNumber' && item.status === 'complete' && !person.idType) {
      return { ...item, status: 'incomplete', missingFields: ['idType'] };
    }
    return item;
  });
  items.push(documentItem(`${section}.id_document`, documents, spec.idDocument, now));
  return items;
}

function businessItems(section, partnerType, kycCase = {}, documents = [], now) {
  const items = BUSINESS_REQUIREMENTS[partnerType].map(field => ({
    key: `${section}.${field}`, by: BY_PARTNER, status: fieldFilled(field, kycCase?.[field]) ? 'complete' : 'missing',
  }));
  items.push(documentItem(`${section}.registration_certificate`, documents, 'business_registration', now));
  items.push(documentItem(`${section}.tin_certificate`, documents, 'tin_certificate', now));
  return items;
}

/** The latest site visit recorded for a gym. */
export function latestSiteVisit(checks = [], gymId) {
  return checks.filter(c => c.checkType === 'site_visit' && c.targetType === 'gym' && c.targetId === gymId).sort(byNewest)[0] || null;
}

function gymItems(gym, checks) {
  const scope = { gymId: gym.id, gymName: gym.name };
  const profileGaps = gymProfileGaps(gym);
  const rateGaps = gymRateCardGaps(gym);
  const visit = latestSiteVisit(checks, gym.id);
  const evidence = visit?.evidence || {};

  const site = !visit ? 'missing'
    : visit.result === 'passed' ? 'complete'
      : visit.result === 'failed' ? 'failed'
        : 'submitted';
  const score = Number.isFinite(Number(evidence.score)) && evidence.score !== null && evidence.score !== undefined;
  let tier = 'missing';
  if (evidence.tier) tier = gym.tier === evidence.tier ? 'complete' : 'mismatch';

  return [
    { key: 'business.gym_location', by: BY_PARTNER, ...scope,
      // Coordinates can be negative (all of Tanzania is south of the equator).
      status: profileGaps.includes('location') || profileGaps.includes('coordinates') ? 'missing' : 'complete' },
    { key: 'operational.gym_profile', by: BY_PARTNER, ...scope,
      status: profileGaps.length ? 'incomplete' : 'complete', ...(profileGaps.length ? { missingFields: profileGaps } : {}) },
    { key: 'operational.rate_card', by: BY_PARTNER, ...scope,
      status: rateGaps.length ? 'missing' : 'complete' },
    { key: 'operational.site_verification', by: BY_REVIEWER, ...scope, status: site,
      ...(visit ? { checkId: visit.id, visitedOn: evidence.visitedOn || null } : {}) },
    { key: 'operational.vetting_score', by: BY_REVIEWER, ...scope, status: score ? 'complete' : 'missing',
      ...(score ? { score: Number(evidence.score), maxScore: evidence.maxScore ?? null } : {}) },
    { key: 'operational.gym_tier', by: BY_REVIEWER, ...scope, status: tier,
      gymTier: gym.tier || null, ...(evidence.tier ? { vettedTier: evidence.tier } : {}) },
  ];
}

/** One item per in-app agreement: complete once its current version is accepted. */
function agreementItems(partnerType, agreements) {
  return requiredAgreements(partnerType).map(({ agreementType, checklistKey, text }) => ({
    key: checklistKey, by: BY_PARTNER, agreementType, version: text.version,
    status: (agreements || []).some(a => a.agreementType === agreementType && a.version === text.version && a.status === 'accepted')
      ? 'complete' : 'missing',
  }));
}

// ── Per partner type ────────────────────────────────────────────────────────

function gymOwnerSections(s) {
  const gyms = s.gyms || [];
  const gymRows = gyms.flatMap(g => gymItems(g, s.checks));
  return [
    { key: 'identity', items: personItems('identity', 'gym_owner', s.people, s.documents, s.now) },
    { key: 'business', items: [
      ...businessItems('business', 'gym_owner', s.case, s.documents, s.now),
      documentItem('business.licence', s.documents, 'business_licence', s.now),
      ...(gyms.length ? gymRows.filter(i => i.key === 'business.gym_location')
        : [{ key: 'business.gym_location', by: BY_PARTNER, status: 'missing' }]),
    ] },
    { key: 'operational', items: gyms.length
      ? gymRows.filter(i => i.key.startsWith('operational.'))
      : [{ key: 'operational.gym_profile', by: BY_PARTNER, status: 'missing' }] },
    { key: 'settlement', items: [settlementItem(s.settlementAccounts)] },
    { key: 'agreements', items: agreementItems('gym_owner', s.agreements) },
  ];
}

function trainerSections(s) {
  return [
    { key: 'identity', items: personItems('identity', 'trainer', s.people, s.documents, s.now) },
    { key: 'professional', items: [
      documentItem('professional.certification', s.documents, 'certification', s.now),
      fieldItem('professional.specialisation', s.trainer?.specialties),
      documentItem('professional.liability_cover', s.documents, 'liability_insurance', s.now),
    ] },
    { key: 'settlement', items: [settlementItem(s.settlementAccounts)] },
    { key: 'agreements', items: agreementItems('trainer', s.agreements) },
  ];
}

function vendorSections(s) {
  const profile = s.vendorProfile || {};
  return [
    { key: 'business', items: [
      ...businessItems('business', 'vendor', s.case, s.documents, s.now),
      documentItem('business.licence', s.documents, 'business_licence', s.now),
      { key: 'business.contact', by: BY_PARTNER,
        status: filled(profile.contactNumber) && filled(profile.email) ? 'complete' : 'missing' },
    ] },
    { key: 'representative', items: [
      ...personItems('representative', 'vendor', s.people, s.documents, s.now),
      documentItem('representative.authority_document', s.documents, 'representative_authority', s.now),
    ] },
    { key: 'marketplace', items: [
      fieldItem('marketplace.product_categories', filled(profile.productCategories) ? profile.productCategories : profile.businessCategory),
      fieldItem('marketplace.delivery', profile.deliveryRegions),
      fieldItem('marketplace.returns', profile.returnsPolicy),
      { ...settlementItem(s.settlementAccounts), key: 'marketplace.settlement' },
    ] },
    { key: 'agreements', items: agreementItems('vendor', s.agreements) },
  ];
}

function corporateSections(s) {
  const account = s.corporate || {};
  const contract = (s.agreements || []).some(a => a.agreementType === 'corporate_contract' && a.status === 'accepted');
  return [
    { key: 'company', items: [
      ...businessItems('company', 'corporate', s.case, s.documents, s.now),
      documentItem('company.licence', s.documents, 'business_licence', s.now),
    ] },
    { key: 'representative', items: personItems('representative', 'corporate', s.people, s.documents, s.now) },
    { key: 'commercial', items: [
      fieldItem('commercial.seats', Number(account.seatLimit) || null),
      fieldItem('commercial.pass_tier', account.passTier),
      fieldItem('commercial.subsidy', account.subsidyModel),
      fieldItem('commercial.billing_cycle', account.billingCycle),
      { key: 'commercial.contract', by: BY_PARTNER, status: contract ? 'complete' : 'missing' },
      { key: 'commercial.billing_contact', by: BY_PARTNER,
        status: filled(account.billingContactName) && (filled(account.billingContactEmail) || filled(account.billingContactPhone)) ? 'complete' : 'missing' },
    ] },
  ];
}

const SECTIONS = { gym_owner: gymOwnerSections, trainer: trainerSections, vendor: vendorSections, corporate: corporateSections };

/**
 * Evaluate a partner's KYC.
 * @param {string} partnerType gym_owner | trainer | vendor | corporate
 * @param {object} snapshot { case, people, documents, checks, settlementAccounts, agreements,
 *   gyms, trainer, vendorProfile, corporate, now }
 * @returns {{ partnerType, tier, sections, missing: string[], awaitingReview: string[], readyToSubmit: boolean, complete: boolean }}
 *   missing: partner items not yet provided. awaitingReview: anything provided but not yet accepted,
 *   plus reviewer items not yet done. readyToSubmit: the partner has provided everything.
 *   complete: every required item, partner and reviewer, is complete. Optional
 *   items (flagged optional: true) never count against either.
 */
export function evaluateKyc(partnerType, snapshot = {}) {
  const build = SECTIONS[partnerType];
  if (!build) throw new Error(`unknown partner type: ${partnerType}`);
  const s = {
    case: null, people: [], documents: [], checks: [], settlementAccounts: [], agreements: [], gyms: [],
    ...snapshot, now: snapshot.now || new Date(),
  };
  const optional = OPTIONAL_ITEMS[partnerType] || new Set();
  const sections = build(s).map(sec => ({
    ...sec, items: sec.items.map(i => (optional.has(i.key) ? { ...i, optional: true } : i)),
  }));
  const items = sections.flatMap(sec => sec.items);
  const required = items.filter(i => !i.optional);
  const label = (i) => (i.gymId ? `${i.key}@${i.gymId}` : i.key);
  const partnerItems = required.filter(i => i.by === BY_PARTNER);
  const missing = partnerItems.filter(i => !PROVIDED.has(i.status)).map(label);
  const awaitingReview = items.filter(i => i.status === 'submitted' || (i.by === BY_REVIEWER && i.status !== 'complete')).map(label);
  return {
    partnerType,
    tier: KYC_TIERS[partnerType],
    sections,
    missing,
    awaitingReview,
    readyToSubmit: missing.length === 0,
    complete: required.every(i => i.status === 'complete'),
  };
}
