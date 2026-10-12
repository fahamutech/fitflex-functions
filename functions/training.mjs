// Training Plans REST surface — the vocabulary, the exercise library, a
// member's training preferences and their plans.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import {
  exerciseAdminService, trainerPlanService, trainingPlanService, trainingPreferenceService, workoutExerciseService,
} from '../src/bootstrap/services.mjs';
import { exerciseOptions, trainingOptions } from '../src/shared/training-taxonomy.mjs';
import { alternativesFor, exerciseById, listExercises, localizedExercise } from '../src/shared/exercise-library.mjs';

const created = new Date().toISOString();

function send(res, result) {
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result);
}

const list = v => (typeof v === 'string' && v ? v.split(',').map(s => s.trim()).filter(Boolean) : undefined);

export const trainingOptionsRoute = {
  created, method: 'get', path: '/training/options',
  description: 'Member: the choices for a training plan — goals, target areas, experience, environment, equipment, session length, days per week, style.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => res.json(trainingOptions())
};

export const trainingExercises = {
  created, method: 'get', path: '/training/exercises',
  description: 'Member or trainer: the exercise library (trainers pick from it when writing a workout). Optional filters: area, category, goal, environment, equipment (comma-separated), experience, lang (en|sw).',
  onGuard: requireAuth('member', 'trainer'),
  onRequest: async (req, res) => {
    const q = req.query || {};
    await exerciseAdminService.ensureFresh();
    const rows = listExercises({
      area: q.area, category: q.category, goal: q.goal, environment: q.environment,
      equipment: list(q.equipment), experience: q.experience,
    });
    res.json({ exercises: rows.map(e => localizedExercise(e, q.lang)) });
  }
};

export const trainingExercise = {
  created, method: 'get', path: '/training/exercises/:id',
  description: 'Member or trainer: one exercise with the alternatives that keep its intent (limited by environment, equipment, experience when given).',
  onGuard: requireAuth('member', 'trainer'),
  onRequest: async (req, res) => {
    const q = req.query || {};
    await exerciseAdminService.ensureFresh();
    const e = exerciseById(req.params.id);
    if (!e || !e.active) return res.status(404).json({ error: 'not_found' });
    const alternatives = alternativesFor(e.id, { environment: q.environment, equipment: list(q.equipment), experience: q.experience });
    res.json({ exercise: localizedExercise(e, q.lang), alternatives: alternatives.map(a => localizedExercise(a, q.lang)) });
  }
};

export const myTrainingPreferences = {
  created, method: 'get', path: '/me/training-preferences',
  description: 'Member: training preferences as chosen (null where not set) and as a plan would use them (filled from the profile and defaults).',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await trainingPreferenceService.get(req.user.sub))
};

export const updateMyTrainingPreferences = {
  created, method: 'put', path: '/me/training-preferences',
  description: 'Member: set any of goal, targetAreas, experience, environment, equipment, sessionMinutes, daysPerWeek, style. Omitted fields are kept; null clears one.',
  requestSample: { goal: 'gain_muscle', targetAreas: ['chest', 'shoulders', 'triceps'], environment: 'gym', sessionMinutes: 45, daysPerWeek: 4 },
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await trainingPreferenceService.update(req.user.sub, req.body || {}))
};

export const createMyTrainingPlan = {
  created, method: 'post', path: '/me/training-plans',
  description: 'Member: have FitFlex make a training plan from their goal and preferences. All optional: preferences (for this plan only), durationWeeks (1–12, default 4), startDate (YYYY-MM-DD, default today), replace (true ends the plan they are on), lang (en|sw: the language session names are written in). Each session becomes a planned workout.',
  requestSample: { durationWeeks: 4, replace: false },
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => {
    const result = await trainingPlanService.generate(req.user.sub, req.body || {});
    if (result.error) return res.status(result.status).json({ error: result.error, ...(result.planId ? { planId: result.planId } : {}) });
    res.status(201).json(result);
  }
};

export const myCurrentTrainingPlan = {
  created, method: 'get', path: '/me/training-plans/current',
  description: 'Member: the plan they are on (or plan: null), week by week, with progress, today\'s session and the next one.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await trainingPlanService.current(req.user.sub))
};

export const myTrainingPlans = {
  created, method: 'get', path: '/me/training-plans',
  description: 'Member: every plan they have had, newest first.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await trainingPlanService.list(req.user.sub))
};

export const myTrainingPlan = {
  created, method: 'get', path: '/me/training-plans/:id',
  description: 'Member: one of their plans, week by week.',
  onGuard: requireAuth('member'),
  // Whichever route the router matches first, the fixed words mean what they say.
  onRequest: async (req, res) => send(res, req.params.id === 'current'
    ? await trainingPlanService.current(req.user.sub)
    : req.params.id === 'offers'
      ? await trainingPlanService.offers(req.user.sub)
      : await trainingPlanService.get(req.user.sub, req.params.id))
};

export const cancelMyTrainingPlan = {
  created, method: 'post', path: '/me/training-plans/:id/cancel',
  description: 'Member: stop a plan. Sessions not yet started are removed; ones done or under way stay in their history.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await trainingPlanService.cancel(req.user.sub, req.params.id))
};

export const workoutExerciseAlternatives = {
  created, method: 'get', path: '/me/workouts/:id/exercises/:exerciseId/alternatives',
  description: 'Member: exercises that could stand in for one in their workout — same main area, and doable with their equipment, place and experience. Optional lang (en|sw).',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => {
    const result = await workoutExerciseService.alternatives(req.user.sub, req.params.id, req.params.exerciseId);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ alternatives: result.alternatives.map(e => localizedExercise(e, req.query?.lang)) });
  }
};

export const replaceWorkoutExercise = {
  created, method: 'post', path: '/me/workouts/:id/exercises/:exerciseId/replace',
  description: 'Member: swap an exercise they have not started for one of its alternatives. { libraryId, lang? }',
  requestSample: { libraryId: 'ex_push_up' },
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await workoutExerciseService.replace(req.user.sub, req.params.id, req.params.exerciseId, req.body || {}))
};

// ── Plans a trainer makes for a client ──────────────────────────────────────

export const myTrainingPlanOffers = {
  created, method: 'get', path: '/me/training-plans/offers',
  description: 'Member: plans their trainers have made for them that they have not answered yet, each with its sessions in outline.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await trainingPlanService.offers(req.user.sub))
};

export const acceptMyTrainingPlan = {
  created, method: 'post', path: '/me/training-plans/:id/accept',
  description: 'Member: take a trainer\'s plan. It replaces the plan they are on and its sessions become their workouts.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await trainingPlanService.accept(req.user.sub, req.params.id))
};

export const declineMyTrainingPlan = {
  created, method: 'post', path: '/me/training-plans/:id/decline',
  description: 'Member: say no to a trainer\'s plan. Nothing of theirs changes.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await trainingPlanService.decline(req.user.sub, req.params.id))
};

export const trainerSuggestTrainingPlan = {
  created, method: 'post', path: '/trainer/clients/:id/training-plans/suggestion',
  description: 'Trainer: what FitFlex would suggest for this client — the first week, session by session. { durationWeeks?, startDate?, preferences?, lang? }. Uses the client\'s own goal and preferences only if they share goals with the trainer.',
  requestSample: { durationWeeks: 4, preferences: { daysPerWeek: 3, environment: 'gym' } },
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => send(res, await trainerPlanService.suggest(req.user.sub, req.params.id, req.body || {}))
};

export const trainerOfferTrainingPlan = {
  created, method: 'post', path: '/trainer/clients/:id/training-plans',
  description: 'Trainer: offer a client a plan. { name?, note?, durationWeeks?, startDate?, days: [{ day (1 = Monday … 7), planId } | { day, suggested: true }], preferences?, lang? }. The client must accept it.',
  requestSample: { name: 'Strength block', durationWeeks: 4, days: [{ day: 1, planId: 'wpl_x' }, { day: 3, suggested: true }] },
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => {
    const result = await trainerPlanService.offer(req.user.sub, req.params.id, req.body || {});
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(201).json(result);
  }
};

export const trainerClientTrainingPlans = {
  created, method: 'get', path: '/trainer/clients/:id/training-plans',
  description: 'Trainer: the plans they have made for this client and where each stands. Session progress only if the client shares workout history.',
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => send(res, await trainerPlanService.list(req.user.sub, req.params.id))
};

export const trainerWithdrawTrainingPlan = {
  created, method: 'post', path: '/trainer/training-plans/:id/cancel',
  description: 'Trainer: take back an offer, or stop a plan the client is on (workouts they have done stay theirs).',
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => send(res, await trainerPlanService.withdraw(req.user.sub, req.params.id))
};

export const trainerEditTrainingPlan = {
  created, method: 'put', path: '/trainer/training-plans/:id',
  description: 'Trainer: change a plan they made. { name?, note? } alone, or with { days, durationWeeks?, preferences?, lang? } to lay the week out again. A waiting offer is rewritten; a plan the client is on changes from today forward (sessions done, started or skipped stay) and the client is notified.',
  requestSample: { name: 'Strength block v2', days: [{ day: 1, planId: 'wpl_x' }, { day: 4, suggested: true }] },
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => send(res, await trainerPlanService.edit(req.user.sub, req.params.id, req.body || {}))
};

// ── FitFlex admin: the exercise library ─────────────────────────────────────

const exerciseGuard = [requireAuth('admin'), requireAcl('exercises')];
const sendExercise = (res, result, ok = 200) => (result.error
  ? res.status(result.status).json({ error: result.error, ...(result.field ? { field: result.field } : {}) })
  : res.status(ok).json(result));

export const adminExercises = {
  created, method: 'get', path: '/admin/exercises',
  description: 'FitFlex admin: every exercise, on or off, with its source (builtin | edited | custom), plus the choices for each field.',
  onGuard: exerciseGuard,
  onRequest: async (req, res) => {
    // Always the library or a plain error — never a half answer the portal can't read.
    try {
      const { exercises } = await exerciseAdminService.list();
      if (!Array.isArray(exercises)) throw new Error('the library did not come back as a list');
      res.json({ exercises, options: exerciseOptions() });
    } catch (err) {
      console.error('[exercises] could not list the library:', err?.message);
      res.status(503).json({ error: 'exercise_library_unavailable', detail: String(err?.message ?? err).slice(0, 200) });
    }
  }
};

export const adminCreateExercise = {
  created, method: 'post', path: '/admin/exercises',
  description: 'FitFlex admin: add an exercise. name, category, targetAreas, difficulty, equipment, environment, suitableGoals, defaultSets, defaultReps | defaultDuration (seconds), restSeconds, instructions[] are needed; secondaryAreas, movementPattern, tracksWeight, alternatives[], active, i18n.sw { name, description, instructions } are optional.',
  onGuard: exerciseGuard,
  onRequest: async (req, res) => sendExercise(res, await exerciseAdminService.create(req.user.sub, req.body || {}), 201)
};

export const adminUpdateExercise = {
  created, method: 'put', path: '/admin/exercises/:id',
  description: 'FitFlex admin: change an exercise (any of the create fields; the rest are kept). Editing a built-in stores FitFlex\'s version of it. Set active: false to stop it being chosen for new plans — workouts already planned keep it.',
  onGuard: exerciseGuard,
  onRequest: async (req, res) => sendExercise(res, await exerciseAdminService.update(req.user.sub, req.params.id, req.body || {}))
};

export const adminResetExercise = {
  created, method: 'post', path: '/admin/exercises/:id/reset',
  description: 'FitFlex admin: put an edited built-in exercise back to how FitFlex shipped it.',
  onGuard: exerciseGuard,
  onRequest: async (req, res) => sendExercise(res, await exerciseAdminService.reset(req.user.sub, req.params.id))
};
