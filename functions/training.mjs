// Training Plans REST surface — the vocabulary, the exercise library, a
// member's training preferences and their plans.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import {
  exerciseAdminService, programmeService, trainerPlanService, trainingPlanService, trainingPreferenceService, workoutExerciseService,
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

export const adminExportExercises = {
  created, method: 'get', path: '/admin/exercises/export',
  description: 'FitFlex admin: the whole exercise library as CSV text — { csv, count }. One row per exercise, every field; lists are ";"-separated, instruction steps " | "-separated.',
  onGuard: exerciseGuard,
  onRequest: async (req, res) => {
    try {
      res.json(await exerciseAdminService.exportCsv());
    } catch (err) {
      console.error('[exercises] could not export the library:', err?.message);
      res.status(503).json({ error: 'exercise_library_unavailable' });
    }
  }
};

export const adminImportExercises = {
  created, method: 'post', path: '/admin/exercises/import',
  description: 'FitFlex admin: read a CSV of exercises (the format export gives) and report what it would change — { summary, rows: [{ line, id, name, action: create|update|unchanged|error, changed?, error?, field? }] }. Send dryRun: false to make the changes. A row with an id changes that exercise; no id adds one; columns left out are kept; rows with a problem are skipped; nothing is ever removed.',
  requestSample: { csv: 'id,name,sw_name\nex_push_up,Push-up,Pushapu', dryRun: true },
  onGuard: exerciseGuard,
  onRequest: async (req, res) => sendExercise(res, await exerciseAdminService.importCsv(req.user.sub, req.body?.csv, { dryRun: req.body?.dryRun !== false }))
};

// ── FitFlex admin: programmes (Programmes P1, slice B1) ─────────────────────
// Same scope as the exercise library (owner decision PD-7). These work while
// PROGRAMMES_CATALOGUE is off; each answer says whether members can see
// programmes yet (`catalogueOn`).

const sendProgramme = (res, result, ok = 200) => (result.error
  ? res.status(result.status).json({
    error: result.error, ...(result.field ? { field: result.field } : {}), ...(result.reason ? { reason: result.reason } : {}),
  })
  : res.status(ok).json(result));

const programmeSample = {
  title: '7-day home starter', summary: 'Short bodyweight sessions to build a habit.',
  i18n: { sw: { title: '[SW] 7-day home starter', summary: '[SW] Short bodyweight sessions to build a habit.' } },
  goal: 'stay_fit', level: 'beginner', environment: 'home', equipment: ['none'], lengthDays: 7,
  days: [
    { day: 1, type: 'home', workout: { name: 'Full body 1', activityType: 'functional', estimatedDuration: 20, exercises: [{ exerciseName: 'Squat', libraryId: 'ex_bodyweight_squat', sets: 3, reps: 12 }] } },
    { day: 2, type: 'rest' },
    { day: 3, type: 'gym' },
  ],
};

export const adminProgrammes = {
  created, method: 'get', path: '/admin/programmes',
  description: 'FitFlex admin: every programme (draft, live, retired), newest change first, each with `enrolled` (members who started it), plus `catalogueOn` (whether members can see programmes yet).',
  onGuard: exerciseGuard,
  onRequest: async (req, res) => sendProgramme(res, await programmeService.list())
};

export const adminProgramme = {
  created, method: 'get', path: '/admin/programmes/:id',
  description: 'FitFlex admin: one programme with its days, `enrolled` and `catalogueOn`.',
  onGuard: exerciseGuard,
  onRequest: async (req, res) => sendProgramme(res, await programmeService.get(req.params.id))
};

export const adminCreateProgramme = {
  created, method: 'post', path: '/admin/programmes',
  description: 'FitFlex admin: write a new draft programme. title, goal, level, environment, lengthDays (7-84) are needed; summary, equipment[], i18n.sw { title, summary }, days[] are optional. days[i] is { type: gym|home|rest, workout? } for day i+1; days not sent are rest days. A workout is a workout definition (name, activityType, estimatedDuration, exercises[]). A problem answers 400 invalid_programme with the field at fault.',
  requestSample: programmeSample,
  onGuard: exerciseGuard,
  onRequest: async (req, res) => sendProgramme(res, await programmeService.create(req.user.sub, req.body || {}), 201)
};

export const adminUpdateProgramme = {
  created, method: 'put', path: '/admin/programmes/:id',
  description: 'FitFlex admin: change a draft (any of the create fields; the rest are kept). A live or retired programme answers 409 not_a_draft: make a new version instead.',
  requestSample: { summary: 'Short sessions, no equipment.', lengthDays: 14 },
  onGuard: exerciseGuard,
  onRequest: async (req, res) => sendProgramme(res, await programmeService.update(req.user.sub, req.params.id, req.body || {}))
};

export const adminPublishProgramme = {
  created, method: 'post', path: '/admin/programmes/:id/publish',
  description: 'FitFlex admin: make a draft live. Needs a summary, the Swahili title and summary, at least one gym or home day, a workout on every home day, and only live library exercises; otherwise 400 not_ready_to_publish with the field. Publishing a new version retires the live programme it was made from. Members see live programmes only while PROGRAMMES_CATALOGUE is on.',
  onGuard: exerciseGuard,
  onRequest: async (req, res) => sendProgramme(res, await programmeService.publish(req.user.sub, req.params.id))
};

export const adminRetireProgramme = {
  created, method: 'post', path: '/admin/programmes/:id/retire',
  description: 'FitFlex admin: stop new starts of a live programme. Members already on it can finish it.',
  onGuard: exerciseGuard,
  onRequest: async (req, res) => sendProgramme(res, await programmeService.retire(req.user.sub, req.params.id))
};

export const adminDuplicateProgramme = {
  created, method: 'post', path: '/admin/programmes/:id/duplicate',
  description: 'FitFlex admin: a new draft copied from any programme (`versionOf` points back). This is how a live programme is changed: members who started the old one keep it as it was.',
  onGuard: exerciseGuard,
  onRequest: async (req, res) => sendProgramme(res, await programmeService.duplicate(req.user.sub, req.params.id), 201)
};
