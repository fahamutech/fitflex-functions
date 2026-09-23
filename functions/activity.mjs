// Activity & Progress Engine REST surface — member activities and goals.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { activityService, goalService } from '../src/bootstrap/services.mjs';

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
