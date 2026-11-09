// Gym catalogue REST surface — public discovery + admin CRUD.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl, optionalSessionClaims } from '../src/auth/jwt.mjs';
import { hideTrainerPass, canSeeTrainerPass } from '../src/shared/trainer-access.mjs';
import { gymService, partnerGate, moderationGate, gymPayoutOwner } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

// These routes are open, so a gym goes out with its public fields only.
// Trainer-pass pricing is for trainers only: anonymous callers and members
// get gyms without it. (Owners read their gyms via /owner/gyms, admins via
// /admin/gyms.)
function forViewer(req, gym) {
  const claims = optionalSessionClaims(req);
  const shown = gymService.publicGym(gym);
  return canSeeTrainerPass(claims?.userType) ? shown : hideTrainerPass(shown);
}

export const listGyms = {
  created, method: 'get', path: '/gyms',
  description: 'Public list of active gyms. Public fields only: no commission rate, payout details, TIN or listing controls.',
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
    const blocked = await moderationGate.blocked('gym');             // pending, rejected, suspended or hidden in moderation
    const shown = await partnerGate.badgeGyms((await gymService.listActiveAsync()).filter(g => !blocked.has(g.id)));
    res.json([...shown.filter(g => g.verified === true), ...shown.filter(g => g.verified !== true)].map(g => forViewer(req, g)));
  }
};

export const getGym = {
  created, method: 'get', path: '/gyms/:id',
  description: 'Get a single gym. Public fields only: no commission rate, payout details, TIN or listing controls.',
  onRequest: async (req, res) => {
    const g = gymService.findById(req.params.id);
    if (!g || await moderationGate.isBlocked('gym', g.id)) return res.status(404).json({ error: 'not_found' });
    const [shown] = await partnerGate.badgeGyms([g]);
    res.json(forViewer(req, shown));
  }
};

// Every admin gym row also says who is paid for it (GYM_PAYOUT_OWNER):
// payoutOwnerId (stored, or null), owners [{ id, displayName, email }] and
// payoutOwner { mode, ownerId, source, reason } — who would be paid now.
const withPayoutOwner = async gym => (await gymPayoutOwner.decorateAdminGyms([gym]))[0];

export const adminListGyms = {
  created, method: 'get', path: '/admin/gyms',
  description: 'Admin: list gyms. Each row also has payoutOwnerId, owners [{ id, displayName, email }] and payoutOwner { mode: named | first_owner, ownerId, source: named | only_owner | first_owner, reason: payout_owner_required | no_owner_account }.',
  onGuard: [requireAuth('admin'), requireAcl('gyms')],
  onRequest: async (req, res) => res.json(await gymPayoutOwner.decorateAdminGyms(gymService.listAdmin({ full: req.query.full })))
};

export const adminUpsertGym = {
  created, method: 'post', path: '/admin/gyms',
  description: 'Admin: create or update a gym (tier set here only — audit logged).',
  requestSample: { id: 'gym_006', name: 'New Gym', tier: 'midtier', location: 'DSM', perVisitRate: 8000, commissionRate: 12 },
  onGuard: [requireAuth('admin'), requireAcl('gyms')],
  onRequest: async (req, res) => {
    const result = await gymService.upsert({ body: req.body || {}, actorId: req.user?.sub });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(await withPayoutOwner(result.gym));
  }
};

const payoutOwnerGuard = [requireAuth('admin'), requireAcl('gyms', 'owners')];

export const adminGymPayoutOwner = {
  created, method: 'get', path: '/admin/gyms/:id/payout-owner',
  description: 'Admin: who is paid for a gym — { gymId, payoutOwnerId, owners [{ id, displayName, email }], payoutOwner { mode, ownerId, source, reason } }. reason payout_owner_required: 2+ owners and none named (GYM_PAYOUT_OWNER on).',
  onGuard: payoutOwnerGuard,
  onRequest: async (req, res) => {
    const result = await gymPayoutOwner.adminView(req.params.id);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  }
};

export const adminSetGymPayoutOwner = {
  created, method: 'put', path: '/admin/gyms/:id/payout-owner',
  description: 'Admin: name the gym\'s payout owner — body { ownerId } (must be one of the gym\'s owners: 409 not_a_gym_owner) — or clear it with { ownerId: null }. Audited (gym_payout_owner_set / gym_payout_owner_cleared). Answers as GET. Stored with GYM_PAYOUT_OWNER off too; only read when it is on.',
  requestSample: { ownerId: 'usr_ab12cd34' },
  onGuard: payoutOwnerGuard,
  onRequest: async (req, res) => {
    const body = req.body || {};
    if (!('ownerId' in body)) return res.status(400).json({ error: 'ownerId_required' });
    const result = await gymPayoutOwner.setPayoutOwner({ gymId: req.params.id, ownerId: body.ownerId, actorId: req.user?.sub });
    if (result.error) {
      const { error, status, ...extra } = result;
      return res.status(status).json({ error, ...extra });
    }
    res.json(result);
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
