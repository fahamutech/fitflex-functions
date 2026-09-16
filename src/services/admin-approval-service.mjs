// Admin role-approval queue — owner, trainer and vendor profiles awaiting review.
import { randomUUID } from 'node:crypto';

export function createAdminApprovalService({ users, auditLog }) {
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
    const before = { ...target };
    const status = decision === 'approve' ? 'approved' : 'rejected';
    const updated = await users.updateByIdAsync(target.id, {
      approvalStatus: status,
      approvalNote: note ?? null,
      approvedAt: status === 'approved' ? new Date().toISOString() : null,
      approvedBy: status === 'approved' ? actorId : null
    });
    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: actorId, action: `role_${status}`,
      target: target.id, before, after: updated
    });
    return { user: updated };
  }

  return { list, decide };
}
