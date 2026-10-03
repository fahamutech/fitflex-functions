// Gym catalogue REST surface — public discovery + admin CRUD.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl, bearerFrom, verify } from '../src/auth/jwt.mjs';
import { hideTrainerPass, canSeeTrainerPass } from '../src/shared/trainer-access.mjs';
import { gymService, partnerGate } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

// Trainer-pass pricing is for trainers only: anonymous callers and members
// get gyms without it. (Owners read their gyms via /owner/gyms.)
function forViewer(req, gym) {
  const token = bearerFrom(req);
  const claims = token ? verify(token) : null;
  return canSeeTrainerPass(claims?.userType) ? gym : hideTrainerPass(gym);
}

export const listGyms = {
  created, method: 'get', path: '/gyms',
  description: 'Public list of active gyms.',
  responseSample: [{ id: 'gym_001', name: 'Iron Paradise Masaki', tier: 'standard' }],
  // Note: the mobile app fetches this list once and reuses it for both the
  // gym grid (thumbnails) and the gym detail carousel (full images) — there
  // is no separate per-gym fetch — so both `images` and `thumbnails` must be
  // present here. Payload size is instead controlled by compressing images
  // to WebP and capping dimensions at upload time (see image-upload.tsx /
  // gym_form_page.dart), not by trimming the array server-side.
  // verified: the owner's KYC outcome (D4); profileComplete: the old automatic check.
  // Verified gyms first, each group in its usual order.
  onRequest: async (req, res) => {
    const shown = await partnerGate.badgeGyms(await gymService.listActiveAsync());
    res.json([...shown.filter(g => g.verified === true), ...shown.filter(g => g.verified !== true)].map(g => forViewer(req, g)));
  }
};

export const getGym = {
  created, method: 'get', path: '/gyms/:id',
  description: 'Get a single gym',
  onRequest: async (req, res) => {
    const g = gymService.findById(req.params.id);
    if (!g) return res.status(404).json({ error: 'not_found' });
    const [shown] = await partnerGate.badgeGyms([g]);
    res.json(forViewer(req, shown));
  }
};

export const adminListGyms = {
  created, method: 'get', path: '/admin/gyms',
  description: 'Admin: list gyms.',
  onGuard: [requireAuth('admin'), requireAcl('gyms')],
  onRequest: (req, res) => res.json(gymService.listAdmin({ full: req.query.full }))
};

export const adminUpsertGym = {
  created, method: 'post', path: '/admin/gyms',
  description: 'Admin: create or update a gym (tier set here only — audit logged).',
  requestSample: { id: 'gym_006', name: 'New Gym', tier: 'midtier', location: 'DSM', perVisitRate: 8000, commissionRate: 12 },
  onGuard: [requireAuth('admin'), requireAcl('gyms')],
  onRequest: async (req, res) => {
    const result = await gymService.upsert({ body: req.body || {}, actorId: req.user?.sub });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.gym);
  }
};

export const adminDeleteGym = {
  created, method: 'delete', path: '/admin/gyms/:id',
  description: 'Admin: delete a gym from the pilot catalogue.',
  onGuard: [requireAuth('admin'), requireAcl('gyms')],
  onRequest: async (req, res) => {
    const result = await gymService.remove({ id: req.params.id, actorId: req.user?.sub });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ ok: true, gym: result.gym });
  }
};
