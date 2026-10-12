// Training Plans — FitFlex's own management of the exercise library.
//
// The library ships in code (src/shared/exercise-library.mjs). What staff
// change in the admin portal is stored here as whole exercises: a row with
// a built-in's id replaces that built-in, any other row is a new exercise.
// The two are merged into the live library that members' plans are made
// from; nothing is ever deleted, only switched off, so workouts already
// planned keep the exercises they name.
import {
  EXERCISES, exerciseProblem, mergeLibrary, setLiveLibrary,
} from '../../shared/exercise-library.mjs';

const FIELDS = [
  'name', 'description', 'category', 'targetAreas', 'secondaryAreas', 'movementPattern', 'difficulty',
  'equipment', 'environment', 'suitableGoals', 'defaultSets', 'defaultReps', 'defaultDuration', 'restSeconds',
  'tracksWeight', 'instructions', 'alternatives', 'active', 'i18n',
];
const LANGS = ['sw'];
const MAX = { name: 80, description: 240, instruction: 240, instructions: 8, alternatives: 6 };
// How long a server trusts its copy before looking for changes made on another.
const FRESH_MS = 60_000;

const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const slug = name => String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

/** Tidy what an admin sent into a whole exercise, on top of what was there. */
function shape(id, body, prior = {}) {
  const pick = k => (body[k] !== undefined ? body[k] : prior[k]);
  const reps = pick('defaultReps');
  const secs = pick('defaultDuration');
  const i18n = {};
  for (const lang of LANGS) {
    const t = pick('i18n')?.[lang];
    if (!t || typeof t !== 'object') continue;
    const instructions = Array.isArray(t.instructions) ? t.instructions.map(s => text(s, MAX.instruction)).filter(Boolean) : [];
    const entry = {
      ...(text(t.name, MAX.name) ? { name: text(t.name, MAX.name) } : {}),
      ...(text(t.description, MAX.description) ? { description: text(t.description, MAX.description) } : {}),
      ...(instructions.length ? { instructions } : {}),
    };
    if (Object.keys(entry).length) i18n[lang] = entry;
  }
  return {
    id,
    name: text(pick('name'), MAX.name) ?? '',
    description: text(pick('description'), MAX.description) ?? '',
    category: pick('category'),
    targetAreas: pick('targetAreas'),
    secondaryAreas: pick('secondaryAreas') ?? [],
    movementPattern: pick('movementPattern') || null,
    difficulty: pick('difficulty'),
    equipment: pick('equipment'),
    environment: pick('environment'),
    suitableGoals: pick('suitableGoals'),
    defaultSets: pick('defaultSets'),
    // Counted in reps or timed in seconds: whichever was given, never both.
    ...(Number(secs) > 0 && !(Number(reps) > 0) ? { defaultDuration: secs } : { defaultReps: reps }),
    restSeconds: pick('restSeconds'),
    tracksWeight: pick('tracksWeight') === true,
    instructions: Array.isArray(pick('instructions')) ? pick('instructions').map(s => text(s, MAX.instruction)).filter(Boolean) : [],
    alternatives: Array.isArray(pick('alternatives')) ? [...new Set(pick('alternatives'))] : [],
    active: pick('active') !== false,
    ...(Object.keys(i18n).length ? { i18n } : {}),
  };
}

export function createExerciseAdminService({ exercises, auditLog = null, now = () => new Date(), logger = console }) {
  let loadedAt = 0;
  let stored = [];

  /** A stored row as a plain exercise: no bookkeeping, no empty columns. */
  const strip = ({ source, updatedAt, updatedBy, createdAt, ...e }) =>
    Object.fromEntries(Object.entries(e).filter(([k, v]) => !(v == null && ['defaultReps', 'defaultDuration', 'i18n'].includes(k))));

  /** Read FitFlex's changes and make the merged library the live one. */
  async function load() {
    stored = await exercises.allAsync();
    setLiveLibrary(mergeLibrary(stored.map(strip)));
    loadedAt = +now();
    return stored;
  }

  /**
   * Make sure the live library is recent. Never throws: if the changes
   * can't be read, plans go on being made from the last library that
   * loaded (the built-ins, at worst).
   */
  async function ensureFresh() {
    if (+now() - loadedAt < FRESH_MS) return;
    try {
      await load();
    } catch (err) {
      logger.warn?.(`[exercises] could not refresh the library: ${err?.message}`);
    }
  }

  const merged = () => mergeLibrary(stored.map(r => ({ ...strip(r), updatedAt: r.updatedAt ?? null, updatedBy: r.updatedBy ?? null })));
  const audit = async (actorId, action, id, before, after) => {
    try {
      await auditLog?.insertAsync({
        id: `aud_${Math.random().toString(36).slice(2, 14)}`, at: now().toISOString(), actor: actorId,
        action: `exercise_${action}`, target: id, before: before ? JSON.stringify(strip(before)) : null, after: after ? JSON.stringify(strip(after)) : null,
      });
    } catch (err) {
      logger.warn?.(`[exercises] audit failed: ${err?.message}`);
    }
  };

  function check(candidate, all) {
    const ids = new Set([...all.map(e => e.id), candidate.id]);
    const problem = exerciseProblem(candidate, ids);
    if (problem) return { error: 'invalid_exercise', status: 400, field: problem };
    if (candidate.instructions.length > MAX.instructions) return { error: 'invalid_exercise', status: 400, field: 'instructions' };
    if (candidate.alternatives.length > MAX.alternatives) return { error: 'invalid_exercise', status: 400, field: 'alternatives' };
    return null;
  }

  /** Every exercise, on or off, with where it came from. */
  async function list() {
    await load();
    return { exercises: merged() };
  }

  async function save(row, actorId) {
    const stamp = now().toISOString();
    const existing = stored.find(r => r.id === row.id);
    const full = {
      ...row,
      // Said outright, so switching between reps and time (or dropping a translation) clears the old value.
      defaultReps: row.defaultReps ?? null, defaultDuration: row.defaultDuration ?? null, i18n: row.i18n ?? null,
      updatedAt: stamp, updatedBy: actorId ?? null, ...(existing ? {} : { createdAt: stamp }),
    };
    if (existing) await exercises.updateByIdAsync(row.id, full);
    else await exercises.insertAsync(full);
    await load();
    return merged().find(e => e.id === row.id);
  }

  /** Add an exercise of FitFlex's own. */
  async function create(actorId, body = {}) {
    await load();
    const all = merged();
    const base = slug(body.name ?? '');
    if (!base) return { error: 'invalid_exercise', status: 400, field: 'name' };
    let id = `ex_${base}`;
    for (let n = 2; all.some(e => e.id === id); n += 1) id = `ex_${base}_${n}`;
    const candidate = shape(id, body);
    const bad = check(candidate, all);
    if (bad) return bad;
    const saved = await save(candidate, actorId);
    await audit(actorId, 'created', id, null, saved);
    return { exercise: saved };
  }

  /** Change an exercise. Editing a built-in stores FitFlex's version of it. */
  async function update(actorId, id, body = {}) {
    await load();
    const all = merged();
    const prior = all.find(e => e.id === id);
    if (!prior) return { error: 'not_found', status: 404 };
    const candidate = shape(id, body, strip(prior));
    const bad = check(candidate, all);
    if (bad) return bad;
    // Something must be left for members to do.
    if (!candidate.active && !all.some(e => e.id !== id && e.active)) return { error: 'last_active_exercise', status: 409 };
    const saved = await save(candidate, actorId);
    await audit(actorId, candidate.active === prior.active ? 'updated' : candidate.active ? 'activated' : 'deactivated', id, prior, saved);
    return { exercise: saved };
  }

  /** Put a built-in back to how FitFlex shipped it. */
  async function reset(actorId, id) {
    await load();
    const prior = merged().find(e => e.id === id);
    if (!prior) return { error: 'not_found', status: 404 };
    if (prior.source !== 'edited') return { error: 'not_edited', status: 409 };
    await exercises.removeByIdAsync(id);
    await load();
    const back = merged().find(e => e.id === id);
    await audit(actorId, 'reset', id, prior, back);
    return { exercise: back };
  }

  return { load, ensureFresh, list, create, update, reset, builtInCount: EXERCISES.length };
}
