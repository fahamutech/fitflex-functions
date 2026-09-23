// Trainer ↔ member connections, trainer workout plans and assignments.
// Members control the connection and exactly what is shared; trainers see
// only what a member has switched on.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { trainerClientService as svc } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

function send(res, result, ok = 200) {
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.status(ok).json(result);
}

// ── Member ──────────────────────────────────────────────────────────────────

export const myTrainerConnections = {
  created, method: 'get', path: '/me/trainer-connections',
  description: 'Member: trainer connections (pending, active, declined) with what each can see.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await svc.memberConnections(req.user.sub))
};

export const requestTrainerConnection = {
  created, method: 'post', path: '/trainers/:id/connect',
  description: 'Member: ask a trainer to connect. { permissions: { steps, distance, activeMinutes, workoutHistory, workoutDetails, goals, streaks, challenges } } — all default to false.',
  requestSample: { permissions: { workoutHistory: true, goals: true } },
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await svc.request(req.user.sub, req.params.id, req.body || {}), 201)
};

export const updateTrainerConnection = {
  created, method: 'patch', path: '/me/trainer-connections/:id',
  description: 'Member: change what a trainer can see. Keys left out keep their current value.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await svc.updatePermissions(req.user.sub, req.params.id, req.body || {}))
};

export const endTrainerConnection = {
  created, method: 'post', path: '/me/trainer-connections/:id/end',
  description: 'Member: disconnect from a trainer, or cancel a pending request.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await svc.memberEnd(req.user.sub, req.params.id))
};

// ── Trainer ─────────────────────────────────────────────────────────────────

export const trainerClients = {
  created, method: 'get', path: '/trainer/clients',
  description: 'Trainer: pending requests and connected clients, with what each shares.',
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => send(res, await svc.clients(req.user.sub))
};

export const acceptTrainerClient = {
  created, method: 'post', path: '/trainer/clients/:id/accept',
  description: 'Trainer: accept a connection request.',
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => send(res, await svc.accept(req.user.sub, req.params.id))
};

export const declineTrainerClient = {
  created, method: 'post', path: '/trainer/clients/:id/decline',
  description: 'Trainer: decline a connection request.',
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => send(res, await svc.decline(req.user.sub, req.params.id))
};

export const endTrainerClient = {
  created, method: 'post', path: '/trainer/clients/:id/end',
  description: 'Trainer: end a connection with a client.',
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => send(res, await svc.trainerEnd(req.user.sub, req.params.id))
};

export const trainerClientOverview = {
  created, method: 'get', path: '/trainer/clients/:id',
  description: 'Trainer: a client\'s shared data — only the parts the member has permitted.',
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => send(res, await svc.overview(req.user.sub, req.params.id))
};

export const assignTrainerWorkout = {
  created, method: 'post', path: '/trainer/clients/:id/workouts',
  description: 'Trainer: assign a workout on one or more dates. { planId, dates } or { name, activityType, estimatedDuration, exercises, dates }.',
  requestSample: { planId: 'wpl_x', dates: ['2026-09-25', '2026-09-27'] },
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => send(res, await svc.assign(req.user.sub, req.params.id, req.body || {}), 201)
};

export const cancelTrainerWorkout = {
  created, method: 'delete', path: '/trainer/workouts/:id',
  description: 'Trainer: remove an assigned workout the member has not started.',
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => send(res, await svc.cancelAssignment(req.user.sub, req.params.id))
};

export const trainerPlans = {
  created, method: 'get', path: '/trainer/plans',
  description: 'Trainer: saved workout plans.',
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => send(res, await svc.listPlans(req.user.sub))
};

export const createTrainerPlan = {
  created, method: 'post', path: '/trainer/plans',
  description: 'Trainer: save a workout plan { name, description, activityType, estimatedDuration, exercises }.',
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => send(res, await svc.savePlan(req.user.sub, null, req.body || {}), 201)
};

export const updateTrainerPlan = {
  created, method: 'put', path: '/trainer/plans/:id',
  description: 'Trainer: update a workout plan. Workouts already assigned from it are unchanged.',
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => send(res, await svc.savePlan(req.user.sub, req.params.id, req.body || {}))
};

export const deleteTrainerPlan = {
  created, method: 'delete', path: '/trainer/plans/:id',
  description: 'Trainer: delete a workout plan.',
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => send(res, await svc.deletePlan(req.user.sub, req.params.id))
};
