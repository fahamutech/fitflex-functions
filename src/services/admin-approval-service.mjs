// Admin role-approval queue — owner, trainer and vendor profiles awaiting review.
import { randomUUID } from 'node:crypto';

export function createAdminApprovalService({ users, auditLog, partnerKycCases = null }) {
  /** Strip internal/sensitive fields from user records for list responses. */
  function slimApprovalRow(u) {
    if (!u) return u;
    const { passwordHash, firebaseUid, aclPermissions, memberProfile, portalUser, onboardingCompleted, ...rest } = u;
    return rest;
  }

  async function list(status = 'pending_approval') {
    // Pushed-down SQL WHERE ... IN (...) instead of loading + JS-filtering
    // the entire users table on every request.
    const allApprovals = await users.filterByColumnInAsync('userType', ['gym_operator', 'trainer', 'vendor']);
    return allApprovals
      .filter(u => status === 'all' || (u.approvalStatus || 'approved') === status)
      .map(slimApprovalRow)
      .sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0));
  }

  async function decide({ id, decision, note, actorId }) {
    if (!['approve', 'reject'].includes(decision)) return { error: 'invalid_decision', status: 400 };
    const target = await users.findAsync(u => u.id === id && ['gym_operator', 'trainer', 'vendor'].includes(u.userType));
    if (!target) return { error: 'not_found', status: 404 };
    // Partners who have started KYC are approved through their KYC case, so
    // the case and the approval flag can't disagree.
    if (partnerKycCases && (await partnerKycCases.filterByColumnAsync('userId', target.id)).length) {
      return { error: 'use_kyc_review', status: 409 };
    }
    const before = { ...target };
    const status = decision === 'approve' ? 'approved' : 'rejected';
    const updated = await users.updateByIdAsync(target.id, {
      approvalStatus: status,
      approvalNote: note ?? null,
      approvedAt: status === 'approved' ? new Date().toISOString() : null,
      approvedBy: status === 'approved' ? actorId : null
    });
    await auditLog.insertAsync({
      id: randomUUID(), at: new Date().toISOString(),
      actor: actorId, action: `role_${status}`,
      target: target.id, before, after: updated
    });
    return { user: updated };
  }

  return { list, decide };
}
