// Admin role-approval queue REST surface.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { adminApprovalService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

export const adminRoleApprovals = {
  created, method: 'get', path: '/admin/role-approvals',
  description: 'Admin: list gym owner and trainer profiles waiting for approval.',
  onGuard: [requireAuth('admin'), requireAcl('approvals')],
  onRequest: async (req, res) => res.json(await adminApprovalService.list(req.query?.status || 'pending_approval'))
};

export const adminDecideRoleApproval = {
  created, method: 'post', path: '/admin/role-approvals/:id/decision',
  description: 'Admin: approve or reject a pending gym owner or trainer profile.',
  onGuard: [requireAuth('admin'), requireAcl('approvals')],
  onRequest: async (req, res) => {
    const { decision, note } = req.body || {};
    const result = await adminApprovalService.decide({ id: req.params.id, decision, note, actorId: req.user.sub });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.user);
  }
};
