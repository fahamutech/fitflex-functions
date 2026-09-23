// Activity & Progress Engine REST surface — member activities, goals and
// workouts.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { activityService, goalService, workoutService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

function send(res, result) {
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result);
}

export const myActivities = {
  created, method: 'get', path: '/me/activities',
  description: 'Member: own activities, newest first. Optional ISO `from`/`to` (default last 90 days, max 366).',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await activityService.list(req.user.sub, req.query || {}))
};

export const logMyActivity = {
  created, method: 'post', path: '/me/activities',
  description: 'Member: record an activity. Source is manual (default), fitflex or device.',
  requestSample: { type: 'running', startedAt: '2026-09-24T06:00:00.000Z', durationMinutes: 32, distanceKm: 5.1 },
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => {
    const result = await activityService.log(req.user.sub, req.body || {});
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(201).json(result);
  }
};

export const deleteMyActivity = {
  created, method: 'delete', path: '/me/activities/:id',
  description: 'Member: delete an activity they recorded.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await activityService.remove(req.user.sub, req.params.id))
};

export const myGoals = {
  created, method: 'get', path: '/me/goals',
  description: 'Member: active and paused goals. Seeds the default goals the first time.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await goalService.list(req.user.sub))
};

export const createMyGoal = {
  created, method: 'post', path: '/me/goals',
  description: 'Member: create a goal. type steps|workouts|active_minutes|distance_km, period day|week|month|custom.',
  requestSample: { type: 'workouts', period: 'week', target: 4 },
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => {
    const result = await goalService.create(req.user.sub, req.body || {});
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(201).json(result);
  }
};

export const updateMyGoal = {
  created, method: 'patch', path: '/me/goals/:id',
  description: 'Member: change a goal target, or pause/archive it.',
  requestSample: { status: 'archived' },
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await goalService.update(req.user.sub, req.params.id, req.body || {}))
};

// ── Workouts ────────────────────────────────────────────────────────────────

export const workoutTemplates = {
  created, method: 'get', path: '/workouts/templates',
  description: 'Member: built-in workout templates to plan from.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => res.json(workoutService.templates())
};

export const myWorkouts = {
  created, method: 'get', path: '/me/workouts',
  description: 'Member: workouts, newest scheduled first. Optional `from`/`to` (YYYY-MM-DD) and `status`.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await workoutService.list(req.user.sub, req.query || {}))
};

export const planMyWorkout = {
  created, method: 'post', path: '/me/workouts',
  description: 'Member: plan a workout from { templateId, scheduledDate } or a custom { name, activityType, exercises, scheduledDate }.',
  requestSample: { templateId: 'tpl_upper_strength', scheduledDate: '2026-09-24' },
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => {
    const result = await workoutService.create(req.user.sub, req.body || {});
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(201).json(result);
  }
};

export const myWorkout = {
  created, method: 'get', path: '/me/workouts/:id',
  description: 'Member: one workout with its exercises and sets.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await workoutService.get(req.user.sub, req.params.id))
};

export const startMyWorkout = {
  created, method: 'post', path: '/me/workouts/:id/start',
  description: 'Member: start a planned workout (idempotent while in progress).',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await workoutService.start(req.user.sub, req.params.id))
};

export const saveMyWorkoutProgress = {
  created, method: 'patch', path: '/me/workouts/:id',
  description: 'Member: save logged sets and notes mid-session. { notes?, exercises: [{ id, notes?, workoutSets: [{ id, reps?, weight?, duration?, completed? }] }] }',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await workoutService.saveProgress(req.user.sub, req.params.id, req.body || {}))
};

export const completeMyWorkout = {
  created, method: 'post', path: '/me/workouts/:id/complete',
  description: 'Member: finish a workout (same body as the progress save, plus optional durationMinutes). Records the Activity.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await workoutService.complete(req.user.sub, req.params.id, req.body || {}))
};

export const skipMyWorkout = {
  created, method: 'post', path: '/me/workouts/:id/skip',
  description: 'Member: skip a workout that has not been completed.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await workoutService.skip(req.user.sub, req.params.id))
};
