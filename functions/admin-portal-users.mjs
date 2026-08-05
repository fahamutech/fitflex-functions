// Admin portal-staff user management REST surface.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { portalUserService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

export const adminListPortalUsers = {
  created, method: 'get', path: '/admin/portal-users',
  description: 'Admin: list all portal-only staff users with their ACL permissions.',
  onGuard: [requireAuth('admin'), requireAcl('users')],
  onRequest: async (_, res) => res.json(await portalUserService.list())
};

export const adminCreatePortalUser = {
  created, method: 'post', path: '/admin/portal-users',
  description: 'Admin: create a portal-only staff user. Registers them in Firebase with email/password, stores in DB with ACL.',
  onGuard: [requireAuth('admin'), requireAcl('users')],
  onRequest: async (req, res) => {
    const { email, password, displayName, aclPermissions = [] } = req.body || {};
    const result = await portalUserService.create({ email, password, displayName, aclPermissions, actorId: req.user?.sub });
    if (result.error) return res.status(result.status).json({ error: result.error, ...(result.invalid ? { invalid: result.invalid } : {}), ...(result.detail ? { detail: result.detail } : {}) });
    res.status(201).json(result.user);
  }
};

export const adminUpdatePortalUser = {
  created, method: 'put', path: '/admin/portal-users/:id',
  description: 'Admin: update ACL permissions or status of a portal staff user.',
  onGuard: [requireAuth('admin'), requireAcl('users')],
  onRequest: async (req, res) => {
    const { aclPermissions, accountStatus, displayName, portalUser } = req.body || {};
    const result = await portalUserService.update({ id: req.params.id, aclPermissions, accountStatus, displayName, portalUser, actorId: req.user?.sub });
    if (result.error) return res.status(result.status).json({ error: result.error, message: result.message, ...(result.invalid ? { invalid: result.invalid } : {}) });
    res.json(result.user);
  }
};

export const adminDeletePortalUser = {
  created, method: 'delete', path: '/admin/portal-users/:id',
  description: 'Admin: remove a portal staff user. Cannot delete the last admin.',
  onGuard: [requireAuth('admin'), requireAcl('users')],
  onRequest: async (req, res) => {
    const result = await portalUserService.remove({ id: req.params.id, requesterId: req.user.sub, actorId: req.user?.sub });
    if (result.error) return res.status(result.status).json({ error: result.error, message: result.message });
    res.json({ ok: true });
  }
};
