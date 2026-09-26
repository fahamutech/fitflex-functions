// Partner KYC/KYB — the shared vocabulary and rules for verifying gym owners,
// trainers, vendors and corporate partners. Pure functions only; the
// verification service, jobs and admin tools build on these so every path
// applies the same rules.
//
// A partner is an existing record, not a new table: a User with userType
// gym_operator / trainer / vendor, or a CorporateAccount. Its KYC case
// (PartnerKycCase, one per partner) is the anchor for everything else:
// people, documents, checks, settlement accounts, agreements and events.

export const PARTNER_TYPES = ['gym_owner', 'trainer', 'vendor', 'corporate'];

// Which existing record a partner type points at.
export const PARTNER_SUBJECT = Object.freeze({
  gym_owner: { table: 'User', userType: 'gym_operator' },
  trainer: { table: 'User', userType: 'trainer' },
  vendor: { table: 'User', userType: 'vendor' },
  corporate: { table: 'CorporateAccount' },
});

export function partnerTypeForUserType(userType) {
  return Object.entries(PARTNER_SUBJECT).find(([, s]) => s.userType === userType)?.[0] ?? null;
}

// ── KYC case ────────────────────────────────────────────────────────────────

export const CASE_STATUSES = [
  'draft', 'submitted', 'in_review', 'info_requested', 'approved', 'rejected', 'suspended',
];

// Allowed case status changes. Anything not listed is refused. A rejected
// case goes back to draft only through a new round (see startsNewRound).
const CASE_TRANSITIONS = Object.freeze({
  draft: ['submitted'],
  submitted: ['in_review', 'draft'],
  in_review: ['approved', 'rejected', 'info_requested'],
  info_requested: ['submitted'],
  approved: ['suspended', 'submitted'],
  suspended: ['submitted', 'approved'],
  rejected: ['draft'],
});

export function canTransitionCase(from, to) {
  return Boolean(CASE_TRANSITIONS[from]?.includes(to));
}

// Moving into these statuses starts a new review round.
export const NEW_ROUND_ON = Object.freeze({ rejected: 'draft', approved: 'submitted', suspended: 'submitted' });

export function startsNewRound(from, to) {
  return NEW_ROUND_ON[from] === to;
}

// Reviewer decisions other than approval must say why.
export const REASON_REQUIRED_FOR = ['rejected', 'info_requested', 'suspended'];

export const REASON_CODES = [
  'document_unreadable', 'document_expired', 'document_mismatch', 'identity_unverified',
  'business_unverified', 'tax_unverified', 'site_visit_failed', 'settlement_unverified',
  'suspected_fraud', 'duplicate_partner', 'incomplete_submission', 'other',
];

// The existing coarse gate every app already reads (User.approvalStatus),
// derived from the case so the two never disagree. Suspension is expressed
// through accountStatus/payout holds, not by un-approving the role.
export function approvalStatusForCase(caseStatus) {
  if (caseStatus === 'approved' || caseStatus === 'suspended') return 'approved';
  if (caseStatus === 'rejected') return 'rejected';
  return 'pending_approval';
}

// ── People (identity, beneficial owners, representatives) ──────────────────

export const PERSON_ROLES = ['principal', 'director', 'beneficial_owner', 'authorised_representative'];
export const ID_TYPES = ['nida', 'passport', 'driving_licence', 'voter_id'];
export const PERSON_STATUSES = ['pending', 'verified', 'rejected'];

// A holding at or above this share makes someone a beneficial owner.
export const BENEFICIAL_OWNERSHIP_THRESHOLD_PCT = 25;

export const ENTITY_TYPES = ['individual', 'sole_proprietor', 'partnership', 'company', 'ngo', 'government'];

// ── Documents ───────────────────────────────────────────────────────────────

export const DOCUMENT_STATUSES = ['pending', 'accepted', 'rejected', 'expired', 'superseded'];

export const DOCUMENT_TYPES = [
  'national_id', 'passport', 'selfie',
  'business_registration', 'business_licence', 'tin_certificate', 'memorandum_articles',
  'board_resolution', 'certification', 'liability_insurance',
  'bank_proof', 'mobile_money_proof', 'site_photo', 'signed_agreement', 'other',
];

// Only these file types may be stored as KYC documents.
export const DOCUMENT_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

// ── Checks (identity, business, operational, settlement) ────────────────────

export const CHECK_TYPES = [
  'identity', 'business_registration', 'tax', 'licence', 'certification', 'insurance',
  'site_visit', 'settlement_account', 'sanctions', 'document',
];
export const CHECK_TARGETS = ['case', 'person', 'document', 'settlement_account', 'gym'];
export const CHECK_METHODS = ['manual', 'provider', 'site_visit', 'name_match', 'test_deposit'];
export const CHECK_RESULTS = ['pending', 'passed', 'failed', 'inconclusive'];

// Registries a 'provider' check can ask, and what each one confirms. Until
// the integrations exist, reviewers record these checks as 'manual'.
export const CHECK_PROVIDERS = Object.freeze({
  nida: ['identity'],              // national ID → name, date of birth, photo
  brela: ['business_registration'], // company / business name registration
  tra: ['tax'],                     // TIN
});

export function providerConfirms(provider, checkType) {
  return Boolean(CHECK_PROVIDERS[provider]?.includes(checkType));
}

// ── Identifiers ─────────────────────────────────────────────────────────────
// ID, TIN, registration, account and document numbers are stored in plain
// text for FitFlex admins and staff, normalised so the same number entered
// two ways matches: "123-456 789" → "123456789".

export function normalizeIdentifier(value) {
  const normalized = String(value ?? '').toUpperCase().replace(/[\s\-./]/g, '');
  return normalized || null;
}

// ── Settlement accounts ─────────────────────────────────────────────────────

export const SETTLEMENT_METHODS = ['bank', 'mobile_money'];
export const SETTLEMENT_STATUSES = ['pending_verification', 'verified', 'rejected', 'disabled'];
export const MOBILE_MONEY_PROVIDERS = ['mpesa', 'airtel_money', 'mixx', 'halopesa'];

// A new or changed account can't receive payouts until this long after it is
// verified, so a hijacked login can't redirect money straight away.
export const SETTLEMENT_COOLDOWN_HOURS = 48;

const SETTLEMENT_TRANSITIONS = Object.freeze({
  pending_verification: ['verified', 'rejected'],
  verified: ['disabled'],
  rejected: [],
  disabled: [],
});

export function canTransitionSettlement(from, to) {
  return Boolean(SETTLEMENT_TRANSITIONS[from]?.includes(to));
}

// Payouts may go to an account only when it is the verified primary account
// and its cooling-off period is over.
export function isPayable(account, now = new Date()) {
  if (!account || account.status !== 'verified' || !account.isPrimary) return false;
  return !account.cooldownUntil || new Date(account.cooldownUntil) <= now;
}

// ── Agreements ──────────────────────────────────────────────────────────────

export const AGREEMENT_TYPES = [
  'platform_terms', 'partner_agreement', 'commission_schedule', 'data_processing', 'kyc_consent',
];
export const AGREEMENT_STATUSES = ['accepted', 'superseded', 'revoked'];

// ── Events (status and review history) ──────────────────────────────────────

export const EVENT_TYPES = [
  'status_changed', 'document_uploaded', 'document_reviewed', 'person_updated', 'check_recorded',
  'settlement_account_changed', 'agreement_accepted', 'reviewer_assigned', 'note',
];

// ── Requirements ────────────────────────────────────────────────────────────
// What each partner type must provide before its case can be submitted, from
// the canon KYC tiers (Tier 2 trainers, Tier 3 gym owners). Vendor and
// corporate sets are provisional until the per-type document list is agreed.
// perGym: needed once for every gym the owner runs.

export const REQUIREMENTS = Object.freeze({
  gym_owner: {
    tier: 3,
    documents: [
      { key: 'owner_id', types: ['national_id', 'passport'], expires: true },
      { key: 'business_registration', types: ['business_registration'] },
      { key: 'business_licence', types: ['business_licence'], expires: true },
      { key: 'tin_certificate', types: ['tin_certificate'] },
    ],
    checks: [{ type: 'site_visit', perGym: true }],
    settlementAccount: true,
    agreements: ['partner_agreement', 'kyc_consent'],
  },
  trainer: {
    tier: 2,
    documents: [
      { key: 'trainer_id', types: ['national_id', 'passport'], expires: true },
      { key: 'certification', types: ['certification'], expires: true },
      { key: 'liability_insurance', types: ['liability_insurance'], expires: true },
    ],
    checks: [],
    settlementAccount: true,
    agreements: ['partner_agreement', 'kyc_consent'],
  },
  vendor: {
    tier: 3,
    provisional: true,
    documents: [
      { key: 'director_id', types: ['national_id', 'passport'], expires: true },
      { key: 'business_registration', types: ['business_registration'] },
      { key: 'business_licence', types: ['business_licence'], expires: true },
      { key: 'tin_certificate', types: ['tin_certificate'] },
    ],
    checks: [],
    settlementAccount: true,
    agreements: ['partner_agreement', 'kyc_consent'],
  },
  corporate: {
    tier: 3,
    provisional: true,
    documents: [
      { key: 'business_registration', types: ['business_registration'] },
      { key: 'tin_certificate', types: ['tin_certificate'] },
      { key: 'signatory_id', types: ['national_id', 'passport'], expires: true },
      { key: 'board_resolution', types: ['board_resolution'] },
    ],
    checks: [],
    settlementAccount: false,
    agreements: ['partner_agreement', 'kyc_consent'],
  },
});

/**
 * Requirement keys still missing for a case. A document counts when it is
 * pending or accepted (not rejected, expired or superseded).
 * @param {string} partnerType
 * @param {{ documents?: object[], settlementAccounts?: object[], agreements?: object[] }} state
 * @returns {string[]}
 */
export function missingRequirements(partnerType, { documents = [], settlementAccounts = [], agreements = [] } = {}) {
  const spec = REQUIREMENTS[partnerType];
  if (!spec) return [];
  const live = new Set(documents
    .filter(d => d.status === 'pending' || d.status === 'accepted')
    .map(d => d.requirementKey));
  const missing = spec.documents.filter(r => !live.has(r.key)).map(r => r.key);
  const hasAccount = settlementAccounts.some(a => a.status === 'pending_verification' || a.status === 'verified');
  if (spec.settlementAccount && !hasAccount) missing.push('settlement_account');
  const accepted = new Set(agreements.filter(a => a.status === 'accepted').map(a => a.agreementType));
  for (const type of spec.agreements) if (!accepted.has(type)) missing.push(`agreement:${type}`);
  return missing;
}
