// Trainer catalogue + self-service REST surface.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { trainerService, resolveRequestUser, users, moderationGate } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

export const listTrainers = {
  created, method: 'get', path: '/trainers',
  description: 'Public trainer discovery list. Public fields only: no email, phone, account id or pending gym applications.',
  onRequest: async (req, res) => {
    const blocked = await moderationGate.blocked('trainer');          // pending, rejected, suspended or hidden in moderation
    res.json((await trainerService.listPublic({ q: req.query?.q, specialty: req.query?.specialty })).filter(t => !blocked.has(t.id)).map(trainerService.publicTrainer));
  }
};

export const getTrainer = {
  created, method: 'get', path: '/trainers/:id',
  description: 'Public trainer profile detail. Public fields only: no email, phone, account id or pending gym applications.',
  onRequest: async (req, res) => {
    const trainer = await trainerService.getPublic(req.params.id);
    if (!trainer || await moderationGate.isBlocked('trainer', trainer.id)) return res.status(404).json({ error: 'not_found' });
    res.json(trainerService.publicTrainer(trainer));
  }
};

export const adminListTrainers = {
  created, method: 'get', path: '/admin/trainers',
  description: 'Admin: list all trainer profiles with linked gyms. Pass ?refs=true for a lightweight id/displayName/email/gymIds projection (used by pages that only need trainer names, e.g. the gyms table).',
  onGuard: [requireAuth('admin'), requireAcl('trainers')],
  onRequest: (req, res) => res.json(req.query?.refs === 'true' ? trainerService.adminListRefs() : trainerService.adminList())
};

export const adminUpsertTrainer = {
  created, method: 'post', path: '/admin/trainers',
  description: 'Admin: create or update trainer profile data used by member discovery.',
  onGuard: [requireAuth('admin'), requireAcl('trainers')],
  onRequest: async (req, res) => {
    const result = await trainerService.adminUpsert({ body: req.body || {}, actorId: req.user?.sub });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(result.created ? 201 : 200).json(result.trainer);
  }
};

export const adminDeleteTrainer = {
  created, method: 'delete', path: '/admin/trainers/:id',
  description: 'Admin: delete trainer profile if it has no bookings.',
  onGuard: [requireAuth('admin'), requireAcl('trainers')],
  onRequest: async (req, res) => {
    const result = await trainerService.adminRemove({ id: req.params.id, actorId: req.user?.sub });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ ok: true, trainer: result.trainer });
  }
};

export const trainerRegister = {
  created, method: 'post', path: '/trainer/register',
  description: 'Trainer: self-register full profile (displayName, photoUrl, gender, specialties, bio, hourlyRate, availability). Creates trainer profile if missing.',
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => {
    const user = await resolveRequestUser(req);
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    const body = req.body || {};
    const result = await trainerService.register({ userId: req.user.sub, user, body });
    if (result.error) {
      return res.status(result.status).json({
        error: result.error,
        ...(result.validValues ? { validValues: result.validValues } : {}),
        ...(result.platforms ? { platforms: result.platforms } : {}),
      });
    }
    await users.updateByIdAsync(req.user.sub, {
      displayName: result.displayName,
      onboardingCompleted: true,
    });
    res.json(result.trainer);
  }
};

export const trainerMyProfile = {
  created, method: 'get', path: '/trainer/me',
  description: 'Trainer: get own profile, linked gyms and pending gym applications.',
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => {
    // A profile FitFlex created for this trainer's email becomes theirs here.
    const user = await resolveRequestUser(req);
    const result = await trainerService.myProfile(req.user.sub, { email: user?.email });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.trainer);
  }
};

export const trainerApplyToGym = {
  created, method: 'post', path: '/trainer/gyms/:gymId/apply',
  description: "Trainer: request to join a gym. The gym owner must approve before the trainer is linked and visible to members.",
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => {
    const result = await trainerService.applyToGym({ userId: req.user.sub, gymId: req.params.gymId });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(201).json(result.trainer);
  }
};

export const trainerCancelGymApplication = {
  created, method: 'post', path: '/trainer/gyms/:gymId/apply/cancel',
  description: 'Trainer: withdraw a pending request to join a gym.',
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => {
    const result = await trainerService.cancelGymApplication({ userId: req.user.sub, gymId: req.params.gymId });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.trainer);
  }
};

export const trainerUpdateProfile = {
  created, method: 'put', path: '/trainer/me',
  description: 'Trainer: update own displayName, bio, specialties, hourly rate, availability, photos and socialLinks { instagram, facebook, twitter } (handle, @handle or profile URL).',
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => {
    const result = await trainerService.updateProfile({ userId: req.user.sub, body: req.body || {} });
    if (result.error) return res.status(result.status).json({ error: result.error, ...(result.platforms ? { platforms: result.platforms } : {}) });
    res.json(result.trainer);
  }
};
