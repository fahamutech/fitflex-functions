// Admin portal-staff user management REST surface.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { portalUserService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

// The caller, from the verified token only — never from the body.
// Who made the request, for the audit row (never trusted for decisions).
const requestMetaOf = req => ({
  ip: String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || req.socket?.remoteAddress || null,
  userAgent: req.headers?.['user-agent'] ? String(req.headers['user-agent']).slice(0, 300) : null,
});
const actorOf = req => ({ id: req.user?.sub, portalUser: req.user?.portalUser, aclPermissions: req.user?.aclPermissions });
const errorBody = r => ({
  error: r.error,
  ...(r.message ? { message: r.message } : {}),
  ...(r.invalid ? { invalid: r.invalid } : {}),
  ...(r.exceeding ? { exceeding: r.exceeding } : {}),
  ...(r.detail ? { detail: r.detail } : {}),
});

export const adminListPortalUsers = {
  created, method: 'get', path: '/admin/portal-users',
  description: 'Admin: list all portal-only staff users with their ACL permissions.',
  onGuard: [requireAuth('admin'), requireAcl('users')],
  onRequest: async (_, res) => res.json(await portalUserService.list())
};

export const adminCreatePortalUser = {
  created, method: 'post', path: '/admin/portal-users',
  description: 'Admin: create a portal-only staff user. Registers them in Firebase with email/password, stores in DB with ACL. Staff may grant only scopes they hold.',
  onGuard: [requireAuth('admin'), requireAcl('users')],
  onRequest: async (req, res) => {
    const { email, password, displayName, aclPermissions = [] } = req.body || {};
    const result = await portalUserService.create({ email, password, displayName, aclPermissions, actor: actorOf(req), ...requestMetaOf(req) });
    if (result.error) return res.status(result.status).json(errorBody(result));
    res.status(201).json(result.user);
  }
};

export const adminUpdatePortalUser = {
  created, method: 'put', path: '/admin/portal-users/:id',
  description: 'Admin: update ACL permissions or status of a portal staff user. Nobody changes their own access; only super-admins change portalUser; staff grant only scopes they hold.',
  onGuard: [requireAuth('admin'), requireAcl('users')],
  onRequest: async (req, res) => {
    const { aclPermissions, accountStatus, displayName, portalUser } = req.body || {};
    const result = await portalUserService.update({ id: req.params.id, aclPermissions, accountStatus, displayName, portalUser, actor: actorOf(req) });
    if (result.error) return res.status(result.status).json(errorBody(result));
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
