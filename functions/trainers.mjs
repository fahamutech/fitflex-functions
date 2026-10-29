// Trainer catalogue + self-service REST surface.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { trainerService, resolveRequestUser, users, moderationGate, personalDetailsService } from '../src/bootstrap/services.mjs';
import { partnerDobRequiredOn } from '../src/shared/feature-flags.mjs';

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
  description: 'Trainer: self-register full profile (displayName, optional nickname clients see instead, photoUrl, gender, specialties, bio, hourlyRate, availability). Creates trainer profile if missing. Optional dateOfBirth ("YYYY-MM-DD"): with PARTNER_DOB_REQUIRED on it is checked like PUT /me/personal-details (400 { error: "invalid_field", field: "dateOfBirth" }, 400 { error: "partner_under_18" }) and saved on the person, never on the public trainer profile; off, it is ignored. Leaving it out is always accepted. Photos (photoUrl, images, imageThumbnails; security fix 2026-10-28): each must be data:image/(png|jpeg|webp);base64,… (≤ 1.4 MB decoded (MEDIA_SRC_MAX_BYTES), a real image of that kind, ≤ 2048 px a side) or our own /storage/<cid>/<file> path; values already on the profile are accepted unchanged (photoUrl and images share one set; thumbnails only their own); anything else → 400 invalid_media_src { field, index?, reason } (nothing saved). At most 8 images / thumbnails (400 too_many_images { field, max }); saves that decode new photos: 30 per 10 minutes per person (429 rate_limited { retryAfterSeconds }).',
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => {
    const user = await resolveRequestUser(req);
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    const body = req.body || {};
    // Partner DOB slice 2: checked before anything is saved; gender stays the trainer profile's own.
    // Afterwards a failed save is logged without the value and never turns the registration into an error.
    const declared = partnerDobRequiredOn() ? await personalDetailsService.checkRegistration({ user, body, fields: ['dateOfBirth'] }) : null;
    if (declared?.error) return res.status(declared.status).json({ error: declared.error, ...(declared.field ? { field: declared.field } : {}) });
    const result = await trainerService.register({ userId: req.user.sub, user, body });
    if (result.error) {
      return res.status(result.status).json({
        error: result.error,
        ...(result.validValues ? { validValues: result.validValues } : {}),
        ...(result.platforms ? { platforms: result.platforms } : {}),
        ...(['invalid_media_src', 'too_many_images', 'rate_limited'].includes(result.error) ? { field: result.field, index: result.index, reason: result.reason, max: result.max, retryAfterSeconds: result.retryAfterSeconds } : {}),
      });
    }
    await users.updateByIdAsync(req.user.sub, {
      displayName: result.displayName,
      onboardingCompleted: true,
    });
    if (declared) await personalDetailsService.saveRegistration({ user, changes: declared.changes, via: 'trainer_register' });
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
  description: 'Trainer: update own professional details — displayName (the own name of the trainer), nickname (optional name clients see instead; 2–30 characters, null or an empty string removes it; the displayName of the profile then reads as the nickname and fullName keeps the own name), phone, bio, specialties, hourlyRateTzs, sessionRateCurrency (TZS|USD), experienceYears, availability, images (gallery, max 8; first is the profile picture) with imageThumbnails, photoUrl, and socialLinks { instagram, facebook, twitter } (handle, @handle or profile URL). Only the fields sent are changed. Photos (photoUrl, images, imageThumbnails; security fix 2026-10-28): each must be data:image/(png|jpeg|webp);base64,… (≤ 1.4 MB decoded (MEDIA_SRC_MAX_BYTES), a real image of that kind, ≤ 2048 px a side) or our own /storage/<cid>/<file> path; values already on the profile are accepted unchanged (photoUrl and images share one set; thumbnails only their own); anything else → 400 invalid_media_src { field, index?, reason } (nothing saved). At most 8 images / thumbnails (400 too_many_images { field, max }); saves that decode new photos: 30 per 10 minutes per person (429 rate_limited { retryAfterSeconds }).',
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => {
    const user = await resolveRequestUser(req);
    await trainerService.claimProfileForUser({ userId: req.user.sub, email: user?.email });
    const result = await trainerService.updateProfile({ userId: req.user.sub, body: req.body || {} });
    if (result.error) {
      const { error, status, ...extra } = result;
      return res.status(status).json({ error, ...extra });
    }
    res.json(result.trainer);
  }
};
