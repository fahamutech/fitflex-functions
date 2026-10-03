// Partner KYC/KYB — the shared vocabulary and rules for verifying gym owners,
// trainers, vendors and corporate partners. Pure functions only; the
// verification service, jobs and admin tools build on these so every path
// applies the same rules.
//
// A partner is an existing record, not a new table: a User with userType
// gym_operator / trainer / vendor, or a CorporateAccount. Its KYC case
// (PartnerKycCase, one per partner) is the anchor for everything else:
// people, documents, checks, settlement accounts, agreements and events.
// What each partner type must provide lives in partner-kyc-requirements.mjs.

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

// What each reviewer decision does to a case. A rejection closes the partner
// role (they can no longer sign in to it, as with role approvals today), so
// problems a partner can fix should be 'request_info'. 'reopen' starts a
// fresh round after a rejection.
export const REVIEW_DECISIONS = Object.freeze({
  approve: { from: 'in_review', to: 'approved' },
  reject: { from: 'in_review', to: 'rejected' },
  request_info: { from: 'in_review', to: 'info_requested' },
  suspend: { from: 'approved', to: 'suspended' },
  reinstate: { from: 'suspended', to: 'approved' },
  reopen: { from: 'rejected', to: 'draft' },
});

export function reasonRequired(toStatus) {
  return REASON_REQUIRED_FOR.includes(toStatus);
}

export const REASON_CODES = [
  'document_unreadable', 'document_expired', 'document_mismatch', 'identity_unverified',
  'business_unverified', 'tax_unverified', 'site_visit_failed', 'settlement_unverified',
  'suspected_fraud', 'duplicate_partner', 'incomplete_submission', 'other',
];

// The existing coarse gate every app already reads (User.approvalStatus),
// derived from the case so the two never disagree. Suspension is expressed
// through accountStatus/payout holds, not by un-approving the role.
// Trainers and gym owners are active while their case is still open (they
// show as not verified); only vendors wait for approval (3 Oct 2026).
export function approvalStatusForCase(caseStatus, partnerType = null) {
  if (caseStatus === 'approved' || caseStatus === 'suspended') return 'approved';
  if (caseStatus === 'rejected') return 'rejected';
  return partnerType === 'trainer' || partnerType === 'gym_owner' ? 'approved' : 'pending_approval';
}

// ── People (identity, beneficial owners, representatives) ──────────────────

export const PERSON_ROLES = ['principal', 'director', 'beneficial_owner', 'authorised_representative'];
export const ID_TYPES = ['nida', 'passport', 'driving_licence', 'voter_id'];
export const PERSON_STATUSES = ['pending', 'verified', 'rejected'];

// A holding at or above this share makes someone a beneficial owner.
export const BENEFICIAL_OWNERSHIP_THRESHOLD_PCT = 25;

export const ENTITY_TYPES = ['individual', 'sole_proprietor', 'partnership', 'company', 'ngo', 'government'];

// How a gym owner's principal relates to the business.
export const RELATIONSHIPS = ['owner', 'co_owner', 'director', 'manager', 'employee', 'other'];

// What a vendor or company representative may sign for.
export const AUTHORITIES = ['sole_signatory', 'joint_signatory', 'delegated'];

// ── Documents ───────────────────────────────────────────────────────────────

export const DOCUMENT_STATUSES = ['pending', 'accepted', 'rejected', 'expired', 'superseded'];

export const DOCUMENT_TYPES = [
  'national_id', 'passport', 'selfie',
  'business_registration', 'business_licence', 'tin_certificate', 'memorandum_articles',
  'board_resolution', 'certification', 'liability_insurance',
  'letter_of_authority', 'bank_proof', 'mobile_money_proof', 'site_photo', 'signed_agreement', 'other',
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
  'corporate_contract',
];
export const AGREEMENT_STATUSES = ['accepted', 'superseded', 'revoked'];

// ── Events (status and review history) ──────────────────────────────────────

export const EVENT_TYPES = [
  'status_changed', 'document_uploaded', 'document_reviewed', 'person_updated', 'check_recorded',
  'settlement_account_changed', 'agreement_accepted', 'reviewer_assigned', 'note',
  'profile_updated', 'document_updated',
];
