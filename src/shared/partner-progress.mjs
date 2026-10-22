// Partner progress — one tracker for gym owners, trainers and vendors
// (journey audit Phase B · B4a, owner decisions 20 Oct 2026).
//
// Partners used to face two separate waits worded differently: the role
// approval ("waiting for admin approval") and the KYC Verification centre.
// This turns what already exists into one list of steps:
//
//   registered → approved → verified → payoutReady
//
//   registered   the partner account exists.
//   approved     the role is approved (User.approvalStatus). Trainers and gym
//                owners are approved at once; vendors are approved when their
//                KYC case is (approvalStatusForCase), or by an admin for a
//                legacy vendor with no case.
//   verified     the KYC case is approved.
//   payoutReady  payout eligibility is true (payout-eligibility.mjs): a
//                verified primary payout account past its cooling-off, or a
//                legacy gym inside the configured grace. Not "first payout".
//
// Pure: no reads, no writes. Only codes leave here, never reviewer or admin
// notes, so the app can say everything in English and Swahili.
//
// Steps are judged one by one, so a later step can be done before an earlier
// one (a legacy gym inside the payout grace is payoutReady before verified).
// `current` is the first step that is not done; it is 'current', or
// 'blocked' when it can't move without FitFlex. Later steps that aren't done
// are 'todo' (or 'blocked' when they are blocked on their own).

import { isSensitiveReason, partnerReasonCode, PARTNER_NEUTRAL_REASON } from './partner-kyc.mjs';

export const PROGRESS_STEPS = ['registered', 'approved', 'verified', 'payoutReady'];

export const NEXT_ACTIONS = [
  'wait_for_approval',          // legacy partner with no KYC case: an admin approves the role
  'complete_kyc_items',         // { missing: [checklist keys] }
  'submit_kyc',                 // everything is in; send it for review
  'kyc_under_review',           // submitted or in review
  'kyc_changes_requested',      // { reasonCode (under_review when sensitive), missing }
  'add_payout_account',         // { reason?: 'payout_account_rejected' }
  'payout_account_under_review',
  'payout_account_cooling_off', // { until }
  'payout_not_ready',           // { reason } — any other payout-eligibility reason
  'add_gym',                    // a gym owner with no gym yet
  'contact_support',            // { reason } — the current step is blocked
  'none',                       // every step is done
];

// 'under_review' stands in for kyc_rejected / kyc_suspended (and a changes
// request's reasonCode) when the case's reason is sensitive, such as
// suspected_fraud: the partner reads "under review — contact support",
// never why (owner decision, 22 Oct 2026; see shared/partner-kyc.mjs).
export const BLOCKED_REASONS = ['account_suspended', 'role_rejected', 'kyc_rejected', 'kyc_suspended', 'under_review'];

/** The blocked reason a partner sees for a rejected / suspended case. */
const caseReason = (kycCase, reason) => (isSensitiveReason(kycCase?.reasonCode) ? PARTNER_NEUTRAL_REASON : reason);

const iso = v => (v ? new Date(v).toISOString() : undefined);
const step = (key, state, extra = {}) => {
  const out = { key, state };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null) out[k] = v;
  return out;
};

/** What to do about the KYC case while it is not approved. */
function kycAction(kycCase, checklist) {
  const missing = checklist?.missing || [];
  const status = kycCase?.status || 'draft';
  if (status === 'submitted' || status === 'in_review') return { code: 'kyc_under_review' };
  if (status === 'info_requested') return { code: 'kyc_changes_requested', reasonCode: partnerReasonCode(kycCase.reasonCode), missing };
  if (status === 'rejected') return { code: 'contact_support', reason: caseReason(kycCase, 'kyc_rejected') };
  if (status === 'suspended') return { code: 'contact_support', reason: caseReason(kycCase, 'kyc_suspended') };
  return missing.length ? { code: 'complete_kyc_items', missing } : { code: 'submit_kyc' };
}

/** The approved step from the role flags. */
function approvedStep(user, kycCase) {
  if (user?.accountStatus === 'suspended') return step('approved', 'blocked', { reason: 'account_suspended' });
  const status = user?.approvalStatus || 'approved';
  if (status === 'rejected') return step('approved', 'blocked', { reason: kycCase?.status === 'rejected' ? caseReason(kycCase, 'kyc_rejected') : 'role_rejected' });
  if (status === 'pending_approval') return step('approved', 'todo');
  // Vendors are approved by their KYC decision; that is when it happened.
  const at = kycCase && ['approved', 'suspended'].includes(kycCase.status) && user?.userType === 'vendor' ? iso(kycCase.decidedAt) : undefined;
  return step('approved', 'done', { at });
}

function verifiedStep(kycCase) {
  if (kycCase?.status === 'approved') return step('verified', 'done', { at: iso(kycCase.decidedAt) });
  if (kycCase?.status === 'rejected') return step('verified', 'blocked', { reason: caseReason(kycCase, 'kyc_rejected') });
  if (kycCase?.status === 'suspended') return step('verified', 'blocked', { reason: caseReason(kycCase, 'kyc_suspended') });
  return step('verified', 'todo');
}

/**
 * The payout step and what to do about it, from one payout-eligibility
 * answer ({ ok, reason, until }) and the partner's payout accounts.
 */
export function payoutStep(eligibility, settlementAccounts = [], kycCase = null) {
  if (eligibility?.ok) return { step: step('payoutReady', 'done'), action: null };
  const reason = eligibility?.reason || 'payout_not_ready';
  if (reason === 'kyc_suspended' || reason === 'kyc_rejected') {
    const shown = caseReason(kycCase, reason);
    return { step: step('payoutReady', 'blocked', { reason: shown }), action: { code: 'contact_support', reason: shown } };
  }
  if (reason === 'payout_account_cooling_off') {
    return { step: step('payoutReady', 'todo'), action: { code: 'payout_account_cooling_off', until: eligibility.until || null } };
  }
  if (reason === 'payout_account_not_verified') {
    const waiting = settlementAccounts.some(a => a.status === 'pending_verification' || a.status === 'verified');
    if (waiting) return { step: step('payoutReady', 'todo'), action: { code: 'payout_account_under_review' } };
    const rejected = settlementAccounts.some(a => a.status === 'rejected');
    return { step: step('payoutReady', 'todo'), action: rejected ? { code: 'add_payout_account', reason: 'payout_account_rejected' } : { code: 'add_payout_account' } };
  }
  // kyc_draft / kyc_submitted / … : waiting on verification, which is an earlier step.
  if (reason.startsWith('kyc_')) return { step: step('payoutReady', 'todo'), action: null };
  return { step: step('payoutReady', 'todo'), action: { code: 'payout_not_ready', reason } };
}

/** Mark the first step that isn't done as current, and pick its action. */
function finish(steps, actionFor) {
  const index = steps.findIndex(s => s.state !== 'done');
  if (index === -1) return { steps, current: PROGRESS_STEPS[PROGRESS_STEPS.length - 1], nextAction: { code: 'none' } };
  const current = steps[index];
  const marked = steps.map((s, i) => (i === index && s.state === 'todo' ? { ...s, state: 'current' } : s));
  const nextAction = current.state === 'blocked'
    ? { code: 'contact_support', reason: current.reason }
    : actionFor(current.key);
  return { steps: marked, current: current.key, nextAction: nextAction || { code: 'none' } };
}

/**
 * One partner's progress.
 *
 * @param {Object} input
 * @param {Object} input.user                 the partner's User row
 * @param {Object|null} input.kycCase         their KYC case, or null
 * @param {Object} input.checklist            evaluateKyc output ({ missing })
 * @param {Array}  input.settlementAccounts   their payout accounts ({ status })
 * @param {boolean} input.kycDrivesApproval   approval comes from the KYC decision
 *                                            (a case exists or the partner isn't legacy)
 * @param {Object|null} input.eligibility     payout eligibility { ok, reason, until }
 */
export function buildProgress({ user, kycCase = null, checklist = null, settlementAccounts = [], kycDrivesApproval = true, eligibility = null }) {
  const payout = payoutStep(eligibility, settlementAccounts, kycCase);
  const steps = [
    step('registered', 'done', { at: iso(user?.createdAt) }),
    approvedStep(user, kycCase),
    verifiedStep(kycCase),
    payout.step,
  ];
  return finish(steps, key => {
    if (key === 'approved') return kycDrivesApproval ? kycAction(kycCase, checklist) : { code: 'wait_for_approval' };
    if (key === 'verified') return kycAction(kycCase, checklist);
    if (key === 'payoutReady') return payout.action;
    return null;
  });
}

/** The checklist as one gym sees it: owner-wide items plus this gym's own. */
export function checklistForGym(checklist, gymId) {
  const missing = (checklist?.missing || []).filter(label => !label.includes('@') || label.endsWith(`@${gymId}`));
  return { ...checklist, missing };
}

/**
 * A gym owner's progress: one per gym (payout eligibility is decided per gym)
 * and an overall one. Overall, payoutReady is done only when every gym is;
 * otherwise it follows the first gym that isn't, and its action names that gym.
 *
 * @param {Object} input  as buildProgress, plus
 * @param {Array<{ gymId, name, eligibility }>} input.gyms
 */
export function buildGymOwnerProgress({ gyms = [], ...input }) {
  const perGym = gyms.map(g => ({
    gymId: g.gymId,
    name: g.name ?? null,
    progress: buildProgress({ ...input, checklist: checklistForGym(input.checklist, g.gymId), eligibility: g.eligibility }),
  }));
  let overall;
  if (!perGym.length) {
    overall = buildProgress({ ...input, eligibility: { ok: false, reason: 'no_gym' } });
    overall = patchPayoutAction(overall, { code: 'add_gym' });
  } else {
    const waiting = perGym.find(g => g.progress.steps[3].state !== 'done');
    const eligibility = waiting ? gyms.find(g => g.gymId === waiting.gymId).eligibility : { ok: true };
    overall = buildProgress({ ...input, eligibility });
    if (waiting && overall.current === 'payoutReady' && overall.nextAction.code !== 'none') {
      overall = { ...overall, nextAction: { ...overall.nextAction, gymId: waiting.gymId } };
    }
  }
  return { ...overall, gyms: perGym };
}

function patchPayoutAction(progress, action) {
  return progress.current === 'payoutReady' && progress.steps[3].state !== 'blocked'
    ? { ...progress, nextAction: action }
    : progress;
}
