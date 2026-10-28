// Owner/operator gym management REST surface.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireGymAcl } from '../src/auth/jwt.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { identityFlag, checkinVisitorNamesOn, partnerDobRequiredOn } from '../src/shared/feature-flags.mjs';
import { visitorName } from '../src/shared/visitor-name.mjs';
import { ownerGymService, resolveRequestUser, publicUserId, checkins, users, trainers, usernameService, personalDetailsService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();
// An error body; a refused photo (invalid_media_src) also says which field and why.
const MEDIA_ERROR_KEYS = ['field', 'index', 'reason', 'gymIndex'];
const errorBody = result => ({
  error: result.error,
  ...(result.error === 'invalid_media_src' ? Object.fromEntries(MEDIA_ERROR_KEYS.filter(k => result[k] !== undefined).map(k => [k, result[k]])) : {}),
});

export const gymOwnerRegister = {
  created, method: 'post', path: '/gym-owner/register',
  description: 'Gym Owner: self-register with gym details. Creates one or more gyms and assigns to owner. Optional dateOfBirth ("YYYY-MM-DD") and gender (male | female | other; null or "" = prefer not to say): with PARTNER_DOB_REQUIRED on they are checked like PUT /me/personal-details (400 { error: "invalid_field", field: "dateOfBirth" | "gender" }, 400 { error: "partner_under_18" }) and saved on the person, never on the gym or the owner profile; off, they are ignored. Leaving them out is always accepted. Photos (images, thumbnails, per gyms[]; imagePaths is read as images; security fix 2026-10-29): each must be data:image/(png|jpeg|webp);base64,… (≤ 2 MB decoded, a real image of that kind) or our own /storage/<cid>/<file> path; photos already stored are accepted unchanged; else 400 invalid_media_src { field, index?, reason, gymIndex } (nothing saved).',
  onGuard: routeGuard('post', requireAuth('gym_operator')),
  onRequest: async (req, res) => {
    try {
      const body = req.body || {};
      let user = await resolveRequestUser(req);
      if (!user) {
        console.warn(`[gymOwnerRegister] user ${req.user.sub} missing — auto-provisioning`);
        user = await users.upsertAsync(u => u.id === req.user.sub, {
          id: req.user.sub,
          userType: req.user.userType || 'gym_operator',
          accountStatus: 'active',
          approvalStatus: 'approved',
          onboardingCompleted: false,
          createdAt: new Date().toISOString(),
        });
      }
      // Partner DOB slice 2: checked on the resolved account (fails closed without one), before any gym
      // is saved. Afterwards a failed save is logged without the value and the registration still succeeds.
      const declared = partnerDobRequiredOn() ? await personalDetailsService.checkRegistration({ user, body, fields: ['dateOfBirth', 'gender'] }) : null;
      if (declared?.error) return res.status(declared.status).json({ error: declared.error, ...(declared.field ? { field: declared.field } : {}) });
      const result = await ownerGymService.registerOwner({ user, body });
      if (result.error) return res.status(result.status).json(errorBody(result));
      if (declared) await personalDetailsService.saveRegistration({ user, changes: declared.changes, via: 'gym_owner_register' });
      res.json(result);
    } catch (err) {
      console.error('[gymOwnerRegister] error:', err.message, err.meta || '');
      res.status(500).json({ error: 'registration_failed', detail: err.message });
    }
  }
};

export const ownerMyGyms = {
  created, method: 'get', path: '/owner/gyms',
  description: 'Owner: list gyms assigned to the authenticated owner. Basic cross-feature context — visible to any gym_staff regardless of their ACL scopes.',
  onGuard: routeGuard('get', requireAuth('gym_operator', 'gym_staff')),
  onRequest: async (req, res) => {
    const owner = await resolveRequestUser(req);
    if (!owner) return res.status(404).json({ error: 'user_not_found' });
    res.json(await ownerGymService.myGyms(owner));
  }
};

export const ownerMyInvoices = {
  created, method: 'get', path: '/owner/invoices',
  description: 'Owner: list invoices for their gyms.',
  onGuard: routeGuard('get', [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('payments')]),
  onRequest: async (req, res) => {
    const owner = await resolveRequestUser(req);
    if (!owner) return res.status(404).json({ error: 'user_not_found' });
    res.json(await ownerGymService.myInvoices(owner));
  }
};

export const ownerMyEarnings = {
  created, method: 'get', path: '/owner/earnings',
  description: 'Owner: summary of earnings (paid invoices) for their gyms. Optional ?gymId scopes to a single owned gym.',
  onGuard: routeGuard('get', [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('payments')]),
  onRequest: async (req, res) => {
    const owner = await resolveRequestUser(req);
    if (!owner) return res.status(404).json({ error: 'user_not_found' });
    const requestedGymId = req.query?.gymId ? String(req.query.gymId) : null;
    res.json(await ownerGymService.myEarnings({ owner, requestedGymId }));
  }
};

export const ownerGymCheckins = {
  created, method: 'get', path: '/owner/gyms/:gymId/checkins',
  description: 'Owner: recent check-ins at a specific owned gym.',
  onGuard: routeGuard('get', [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('checkins')]),
  onRequest: async (req, res) => {
    const owner = await resolveRequestUser(req);
    const result = await ownerGymService.gymCheckIns({ owner, gymId: req.params.gymId, checkins });
    if (result.error) return res.status(result.status).json({ error: result.error });
    const list = result.list;
    // The public ID stays in memberName/memberPublicId for older apps; the
    // name is an extra field, behind CHECKIN_VISITOR_NAMES.
    const withNames = checkinVisitorNamesOn();
    const names = new Map();
    for (let i = 0; i < list.length; i++) {
      // The person's own code: a trainer who checked in reads FT…, a member FM…
      const pubId = await publicUserId(list[i].memberId);
      list[i].memberName = pubId;
      list[i].memberPublicId = pubId;
      // The member's username (MEMBER_USERNAMES), next to their name for the gym.
      const handle = await usernameService.handleOf(list[i].memberId);
      if (handle) list[i].username = handle;
      if (!withNames) continue;
      const id = list[i].memberId;
      if (!names.has(id)) {
        const user = await users.findByIdAsync(id);
        const trainer = user?.userType === 'trainer' ? trainers.find(t => t.userId === id) : null;
        names.set(id, visitorName({ user, trainer }));
      }
      list[i].displayName = names.get(id);
    }
    res.json(list);
  }
};

export const ownerUpdateGym = {
  created, method: 'put', path: '/owner/gyms/:gymId',
  description: 'Owner: update details of an owned gym. Photos (images, thumbnails; security fix 2026-10-29): each must be data:image/(png|jpeg|webp);base64,… (≤ 2 MB decoded, a real image of that kind) or our own /storage/<cid>/<file> path; photos already stored are accepted unchanged; else 400 invalid_media_src { field, index?, reason } (nothing saved).',
  onGuard: routeGuard('put', [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('gyms')]),
  onRequest: async (req, res) => {
    try {
      const owner = await resolveRequestUser(req);
      const result = await ownerGymService.updateGym({ owner, gymId: req.params.gymId, body: req.body || {} });
      if (result.error) return res.status(result.status).json(errorBody(result));
      res.json(result.gym);
    } catch (err) {
      console.error('[ownerUpdateGym] error:', err.message, err.meta || '');
      res.status(500).json({ error: 'update_gym_failed', detail: err.message });
    }
  }
};

export const ownerCreateGym = {
  created, method: 'post', path: '/owner/gyms',
  description: 'Owner: add a new gym to their account. Photos (images, thumbnails; security fix 2026-10-29): each must be data:image/(png|jpeg|webp);base64,… (≤ 2 MB decoded, a real image of that kind) or our own /storage/<cid>/<file> path; photos already stored are accepted unchanged; else 400 invalid_media_src { field, index?, reason } (nothing saved).',
  onGuard: routeGuard('post', [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('gyms')]),
  onRequest: async (req, res) => {
    try {
      const owner = await resolveRequestUser(req);
      if (!owner) return res.status(404).json({ error: 'user_not_found' });
      const result = await ownerGymService.createGym({ owner, body: req.body || {} });
      if (result.error) return res.status(result.status).json(errorBody(result));
      res.status(201).json(result.gym);
    } catch (err) {
      console.error('[ownerCreateGym] error:', err.message, err.meta || '');
      res.status(500).json({ error: 'create_gym_failed', detail: err.message });
    }
  }
};

export const ownerDeleteGym = {
  created, method: 'post', path: '/owner/gyms/:gymId/delete',
  description: 'Owner: delete a gym from their account (soft-remove).',
  onGuard: routeGuard('post', [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('gyms')]),
  onRequest: async (req, res) => {
    const owner = await resolveRequestUser(req);
    if (!owner) return res.status(404).json({ error: 'user_not_found' });
    const result = await ownerGymService.deleteGym({ owner, gymId: req.params.gymId });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ ok: true });
  }
};

export const ownerUpdateTrainer = {
  created, method: 'post', path: '/owner/trainers/:trainerId',
  description: 'Retired: a trainer\'s profile is edited only by the trainer. Always answers 403 trainer_profile_not_editable (404/403 first if the trainer is unknown or not at the owner\'s gym). Owners add, approve/reject and remove trainers.',
  onGuard: routeGuard('post', [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('trainers')]),
  onRequest: async (req, res) => {
    const owner = await resolveRequestUser(req);
    const result = await ownerGymService.updateTrainer({ owner, trainerId: req.params.trainerId, body: req.body || {} });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.trainer);
  }
};

export const ownerCreateTrainer = {
  created, method: 'post', path: '/owner/trainers',
  description: 'Owner: create a trainer account and assign it to one of their gyms. Photos (photoUrl, images, imageThumbnails; security fix 2026-10-29): data:image/(png|jpeg|webp);base64,… (≤ 2 MB decoded, a real image) or our own /storage/<cid>/<file> path, else 400 invalid_media_src { field, index?, reason }.',
  onGuard: routeGuard('post', [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('trainers')]),
  onRequest: async (req, res) => {
    // With invitations on, an organisation no longer sets a person's credentials.
    if (identityFlag('V2_INVITES')) {
      return res.status(400).json({
        error: 'credentials_not_accepted',
        message: 'Trainers are now invited instead of being given a PIN. Update the app and use Invite.',
        use: 'POST /orgs/gym/:gymId/invitations',
      });
    }
    try {
      const owner = await resolveRequestUser(req);
      if (!owner) return res.status(404).json({ error: 'user_not_found' });
      const result = await ownerGymService.createTrainer({ owner, body: req.body || {} });
      if (result.error) return res.status(result.status).json(errorBody(result));
      res.status(201).json(result.trainer);
    } catch (err) {
      console.error('[ownerCreateTrainer] error:', err.message, err.meta || '');
      res.status(500).json({ error: 'create_trainer_failed', detail: err.message });
    }
  },
};

export const ownerRemoveTrainer = {
  created, method: 'post', path: '/owner/trainers/:trainerId/remove',
  description: 'Owner: remove a trainer from all their gym(s). The trainer profile persists but is unlinked.',
  onGuard: routeGuard('post', [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('trainers')]),
  onRequest: async (req, res) => {
    const owner = await resolveRequestUser(req);
    const result = await ownerGymService.removeTrainer({ owner, trainerId: req.params.trainerId });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ ok: true });
  }
};

export const ownerListTrainers = {
  created, method: 'get', path: '/owner/trainers',
  description: 'Owner: list trainers assigned to their gyms. Optional ?gymId scopes the list to a single owned gym.',
  onGuard: routeGuard('get', [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('trainers')]),
  onRequest: async (req, res) => {
    const owner = await resolveRequestUser(req);
    const requestedGymId = req.query?.gymId ? String(req.query.gymId) : null;
    res.json(ownerGymService.listTrainers({ owner, requestedGymId }));
  }
};

export const ownerPendingTrainers = {
  created, method: 'get', path: '/owner/trainers/pending',
  description: 'Owner: list trainers who self-registered and applied to join one of their gyms, awaiting approval.',
  onGuard: routeGuard('get', [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('trainers')]),
  onRequest: async (req, res) => {
    const owner = await resolveRequestUser(req);
    res.json(ownerGymService.pendingTrainers({ owner }));
  }
};

export const ownerDecideTrainerJoin = {
  created, method: 'post', path: '/owner/trainers/:trainerId/decision',
  description: "Owner: approve or reject a trainer's request to join one of their gyms.",
  onGuard: routeGuard('post', [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('trainers')]),
  onRequest: async (req, res) => {
    const owner = await resolveRequestUser(req);
    const { gymId, decision } = req.body || {};
    const result = await ownerGymService.decideTrainerJoin({ owner, trainerId: req.params.trainerId, gymId, decision, actorId: req.user?.sub });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.trainer);
  }
};
