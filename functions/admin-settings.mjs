// Platform settings + trainer specialties REST surface (public catalogue + admin edit).
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { settingsService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

export const publicSubscriptionTiers = {
  created, method: 'get', path: '/subscription-tiers',
  description: 'Public: subscription tier catalogue from platform settings, including gym tier access per plan.',
  onRequest: (_req, res) => res.json(settingsService.publicTiers())
};

export const adminGetSettings = {
  created, method: 'get', path: '/admin/settings',
  description: 'Admin: get platform settings (tiers, bands, payment period, etc.).',
  onGuard: requireAuth('admin'),
  onRequest: (_req, res) => res.json(settingsService.adminGet())
};

export const adminUpdateSettings = {
  created, method: 'put', path: '/admin/settings',
  description: 'Admin: update platform settings.',
  onGuard: requireAuth('admin'),
  onRequest: async (req, res) => res.json(await settingsService.adminUpdate({ body: req.body || {}, actorId: req.user.sub }))
};

export const publicGetSpecialties = {
  created, method: 'get', path: '/settings/specialties',
  description: 'Public: list trainer specialty options.',
  onRequest: (_req, res) => res.json(settingsService.getSpecialtiesList())
};

export const adminGetSpecialties = {
  created, method: 'get', path: '/admin/settings/specialties',
  description: 'Admin: get trainer specialty list.',
  onGuard: requireAuth('admin'),
  onRequest: (_req, res) => res.json(settingsService.getSpecialtiesList())
};

export const adminAddSpecialty = {
  created, method: 'post', path: '/admin/settings/specialties',
  description: 'Admin: add a trainer specialty.',
  onGuard: [requireAuth('admin'), requireAcl('settings')],
  onRequest: async (req, res) => {
    const result = await settingsService.addSpecialty(req.body?.name);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.specialties);
  }
};

export const adminDeleteSpecialty = {
  created, method: 'delete', path: '/admin/settings/specialties/:name',
  description: 'Admin: remove a trainer specialty.',
  onGuard: [requireAuth('admin'), requireAcl('settings')],
  onRequest: async (req, res) => {
    const name = decodeURIComponent(req.params.name || '');
    const result = await settingsService.deleteSpecialty(name);
    res.json(result.specialties);
  }
};
