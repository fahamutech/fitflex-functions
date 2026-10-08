// Training Plans REST surface — the vocabulary, the exercise library and a
// member's training preferences. Plans themselves arrive with the
// recommendation engine.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { trainingPreferenceService } from '../src/bootstrap/services.mjs';
import { trainingOptions } from '../src/shared/training-taxonomy.mjs';
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
  description: 'Member: the exercise library. Optional filters: area, category, goal, environment, equipment (comma-separated), experience, lang (en|sw).',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => {
    const q = req.query || {};
    const rows = listExercises({
      area: q.area, category: q.category, goal: q.goal, environment: q.environment,
      equipment: list(q.equipment), experience: q.experience,
    });
    res.json({ exercises: rows.map(e => localizedExercise(e, q.lang)) });
  }
};

export const trainingExercise = {
  created, method: 'get', path: '/training/exercises/:id',
  description: 'Member: one exercise with the alternatives that keep its intent (limited by environment, equipment, experience when given).',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => {
    const q = req.query || {};
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
