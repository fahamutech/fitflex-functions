// Admin gym-owner/operator management REST surface.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { adminOwnerService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

export const adminListGymOwners = {
  created, method: 'get', path: '/admin/gym-owners',
  description: 'Admin: list gym owner/operator profiles with assigned gym. Pass ?refs=true for a lightweight id/displayName/email/gymIds projection (used by pages that only need owner names, e.g. the gyms table).',
  onGuard: [requireAuth('admin'), requireAcl('owners')],
  onRequest: async (req, res) => res.json(await (req.query?.refs === 'true' ? adminOwnerService.listRefs() : adminOwnerService.list()))
};

export const adminUpsertGymOwner = {
  created, method: 'post', path: '/admin/gym-owners',
  description: 'Admin: create or update gym owner profile and gym assignment.',
  onGuard: [requireAuth('admin'), requireAcl('owners')],
  onRequest: async (req, res) => {
    const result = await adminOwnerService.upsert({ body: req.body || {}, actorId: req.user?.sub });
    if (result.error) return res.status(result.status).json({ error: result.error, ...(result.existingRole ? { existingRole: result.existingRole } : {}) });
    res.status(result.created ? 201 : 200).json(result.owner);
  }
};

export const adminDeleteGymOwner = {
  created, method: 'delete', path: '/admin/gym-owners/:id',
  description: 'Admin: delete a gym owner/operator profile if it has no check-in activity.',
  onGuard: [requireAuth('admin'), requireAcl('owners')],
  onRequest: async (req, res) => {
    const result = await adminOwnerService.remove({ id: req.params.id, actorId: req.user?.sub });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ ok: true, owner: result.owner });
  }
};
