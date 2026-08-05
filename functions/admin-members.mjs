// Admin member management REST surface.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { adminMemberService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

export const adminMembers = {
  created, method: 'get', path: '/admin/members',
  description: 'Admin: members and their latest subscription/payment state.',
  onGuard: [requireAuth('admin'), requireAcl('members')],
  onRequest: async (_, res) => res.json(await adminMemberService.list())
};

export const adminUpsertMember = {
  created, method: 'post', path: '/admin/members',
  description: 'Admin: create or update a member profile.',
  onGuard: [requireAuth('admin'), requireAcl('members')],
  onRequest: async (req, res) => {
    const result = await adminMemberService.upsert({ body: req.body || {}, actorId: req.user?.sub });
    if (result.error) return res.status(result.status).json({ error: result.error, ...(result.existingRole ? { existingRole: result.existingRole } : {}) });
    res.status(result.created ? 201 : 200).json(result.member);
  }
};

export const adminMemberPayments = {
  created, method: 'get', path: '/admin/members/:id/payments',
  description: 'Admin: get all payment requests for a specific member.',
  onGuard: [requireAuth('admin'), requireAcl('members')],
  onRequest: async (req, res) => res.json(await adminMemberService.payments(req.params.id))
};

export const adminMemberQr = {
  created, method: 'get', path: '/admin/members/:id/qr',
  description: 'Admin: issue a rotating member QR token for portal-assisted check-in.',
  onGuard: [requireAuth('admin'), requireAcl('members')],
  onRequest: async (req, res) => {
    const result = await adminMemberService.qr(req.params.id);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.qr);
  }
};

export const adminMemberCheckins = {
  created, method: 'get', path: '/admin/members/:id/checkins',
  description: 'Admin: visit history for a specific member, with optional ?from=&to= date range.',
  onGuard: [requireAuth('admin'), requireAcl('members')],
  onRequest: async (req, res) => {
    const { from, to } = req.query || {};
    res.json(await adminMemberService.memberCheckins({ memberId: req.params.id, from, to }));
  }
};

export const adminSetMemberStatus = {
  created, method: 'post', path: '/admin/members/:id/status',
  description: 'Admin: activate or suspend a member and latest subscription.',
  onGuard: [requireAuth('admin'), requireAcl('members')],
  onRequest: async (req, res) => {
    const result = await adminMemberService.setStatus({ memberId: req.params.id, status: req.body?.status, actorId: req.user.sub });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.member);
  }
};
