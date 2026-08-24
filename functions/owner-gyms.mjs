// Owner/operator gym management REST surface.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireGymAcl } from '../src/auth/jwt.mjs';
import { ownerGymService, resolveRequestUser, publicUserId, checkins, users } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

export const gymOwnerRegister = {
  created, method: 'post', path: '/gym-owner/register',
  description: 'Gym Owner: self-register with gym details. Creates one or more gyms and assigns to owner.',
  onGuard: requireAuth('gym_operator'),
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
          approvalStatus: 'pending_approval',
          onboardingCompleted: false,
          createdAt: new Date().toISOString(),
        });
      }
      const result = await ownerGymService.registerOwner({ user, body });
      if (result.error) return res.status(result.status).json({ error: result.error });
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
  onGuard: requireAuth('gym_operator', 'gym_staff'),
  onRequest: async (req, res) => {
    const owner = await resolveRequestUser(req);
    if (!owner) return res.status(404).json({ error: 'user_not_found' });
    res.json(await ownerGymService.myGyms(owner));
  }
};

export const ownerMyInvoices = {
  created, method: 'get', path: '/owner/invoices',
  description: 'Owner: list invoices for their gyms.',
  onGuard: [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('payments')],
  onRequest: async (req, res) => {
    const owner = await resolveRequestUser(req);
    if (!owner) return res.status(404).json({ error: 'user_not_found' });
    res.json(await ownerGymService.myInvoices(owner));
  }
};

export const ownerMyEarnings = {
  created, method: 'get', path: '/owner/earnings',
  description: 'Owner: summary of earnings (paid invoices) for their gyms. Optional ?gymId scopes to a single owned gym.',
  onGuard: [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('payments')],
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
  onGuard: [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('checkins')],
  onRequest: async (req, res) => {
    const owner = await resolveRequestUser(req);
    const result = await ownerGymService.gymCheckIns({ owner, gymId: req.params.gymId, checkins });
    if (result.error) return res.status(result.status).json({ error: result.error });
    const list = result.list;
    for (let i = 0; i < list.length; i++) {
      const pubId = await publicUserId(list[i].memberId, 'member');
      list[i].memberName = pubId;
      list[i].memberPublicId = pubId;
    }
    res.json(list);
  }
};

export const ownerUpdateGym = {
  created, method: 'put', path: '/owner/gyms/:gymId',
  description: 'Owner: update details of an owned gym.',
  onGuard: [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('gyms')],
  onRequest: async (req, res) => {
    try {
      const owner = await resolveRequestUser(req);
      const result = await ownerGymService.updateGym({ owner, gymId: req.params.gymId, body: req.body || {} });
      if (result.error) return res.status(result.status).json({ error: result.error });
      res.json(result.gym);
    } catch (err) {
      console.error('[ownerUpdateGym] error:', err.message, err.meta || '');
      res.status(500).json({ error: 'update_gym_failed', detail: err.message });
    }
  }
};

export const ownerCreateGym = {
  created, method: 'post', path: '/owner/gyms',
  description: 'Owner: add a new gym to their account.',
  onGuard: [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('gyms')],
  onRequest: async (req, res) => {
    try {
      const owner = await resolveRequestUser(req);
      if (!owner) return res.status(404).json({ error: 'user_not_found' });
      const result = await ownerGymService.createGym({ owner, body: req.body || {} });
      if (result.error) return res.status(result.status).json({ error: result.error });
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
  onGuard: [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('gyms')],
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
  description: 'Owner: update a trainer assigned to their gym(s).',
  onGuard: [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('trainers')],
  onRequest: async (req, res) => {
    const owner = await resolveRequestUser(req);
    const result = ownerGymService.updateTrainer({ owner, trainerId: req.params.trainerId, body: req.body || {} });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.trainer);
  }
};

export const ownerCreateTrainer = {
  created, method: 'post', path: '/owner/trainers',
  description: 'Owner: create a trainer account and assign it to one of their gyms.',
  onGuard: [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('trainers')],
  onRequest: async (req, res) => {
    try {
      const owner = await resolveRequestUser(req);
      if (!owner) return res.status(404).json({ error: 'user_not_found' });
      const result = await ownerGymService.createTrainer({ owner, body: req.body || {} });
      if (result.error) return res.status(result.status).json({ error: result.error });
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
  onGuard: [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('trainers')],
  onRequest: async (req, res) => {
    const owner = await resolveRequestUser(req);
    const result = ownerGymService.removeTrainer({ owner, trainerId: req.params.trainerId });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ ok: true });
  }
};

export const ownerListTrainers = {
  created, method: 'get', path: '/owner/trainers',
  description: 'Owner: list trainers assigned to their gyms. Optional ?gymId scopes the list to a single owned gym.',
  onGuard: [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('trainers')],
  onRequest: async (req, res) => {
    const owner = await resolveRequestUser(req);
    const requestedGymId = req.query?.gymId ? String(req.query.gymId) : null;
    res.json(ownerGymService.listTrainers({ owner, requestedGymId }));
  }
};

export const ownerPendingTrainers = {
  created, method: 'get', path: '/owner/trainers/pending',
  description: 'Owner: list trainers who self-registered and applied to join one of their gyms, awaiting approval.',
  onGuard: [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('trainers')],
  onRequest: async (req, res) => {
    const owner = await resolveRequestUser(req);
    res.json(ownerGymService.pendingTrainers({ owner }));
  }
};

export const ownerDecideTrainerJoin = {
  created, method: 'post', path: '/owner/trainers/:trainerId/decision',
  description: "Owner: approve or reject a trainer's request to join one of their gyms.",
  onGuard: [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('trainers')],
  onRequest: async (req, res) => {
    const owner = await resolveRequestUser(req);
    const { gymId, decision } = req.body || {};
    const result = ownerGymService.decideTrainerJoin({ owner, trainerId: req.params.trainerId, gymId, decision, actorId: req.user?.sub });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.trainer);
  }
};
