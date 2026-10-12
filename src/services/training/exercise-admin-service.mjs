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
import { csvToExerciseRows, exercisesToCsv } from '../../shared/exercise-csv.mjs';

const FIELDS = [
  'name', 'description', 'category', 'targetAreas', 'secondaryAreas', 'movementPattern', 'difficulty',
  'equipment', 'environment', 'suitableGoals', 'defaultSets', 'defaultReps', 'defaultDuration', 'restSeconds',
  'tracksWeight', 'instructions', 'alternatives', 'active', 'i18n',
];
const LANGS = ['sw'];
const MAX = { name: 80, description: 240, instruction: 240, instructions: 8, alternatives: 6 };
// How long a server trusts its copy before looking for changes made on another.
const FRESH_MS = 60_000;
const MAX_IMPORT_ROWS = 1000;
const MAX_IMPORT_CHARS = 1_000_000;
// A mistyped cell is reported under the same name the form uses for that field.
const FIELD_OF = { defaultReps: 'defaultReps_or_defaultDuration', defaultDuration: 'defaultReps_or_defaultDuration' };

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
    await persist(row, actorId);
    await load();
    return merged().find(e => e.id === row.id);
  }

  /** Write one exercise, without re-reading the library (callers do that once at the end). */
  async function persist(row, actorId) {
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

  // ── Many at once: the library as a file ───────────────────────────────────

  /** The whole library as CSV text, to edit in a spreadsheet and send back. */
  async function exportCsv() {
    await load();
    return { csv: exercisesToCsv(merged()), count: merged().length };
  }

  const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

  /**
   * Read a file of exercises and say what it would change — and, unless
   * `dryRun`, make the changes.
   *
   * A row with an id changes that exercise; a row with no id adds one.
   * Columns the file leaves out are kept as they are. Rows with a problem
   * are reported and skipped; the others still go through. Exercises not in
   * the file are left alone — nothing is ever removed by an import.
   */
  async function importCsv(actorId, csv, { dryRun = true } = {}) {
    if (typeof csv !== 'string' || !csv.trim()) return { error: 'empty_file', status: 400 };
    if (csv.length > MAX_IMPORT_CHARS) return { error: 'file_too_big', status: 400 };
    const parsed = csvToExerciseRows(csv);
    if (parsed.error) return { error: parsed.error, status: 400 };
    if (!parsed.rows.length) return { error: 'empty_file', status: 400 };
    if (parsed.rows.length > MAX_IMPORT_ROWS) return { error: 'too_many_rows', status: 400 };

    await load();
    const all = merged();
    const byId = new Map(all.map(e => [e.id, e]));
    const seen = new Set();
    const taken = new Set(all.map(e => e.id));
    const rows = [];
    const todo = [];

    for (const { line, id, fields } of parsed.rows) {
      const bad = (field, error = 'invalid_exercise') => rows.push({ line, id: id || null, name: fields.name || byId.get(id)?.name || '', action: 'error', error, field });
      // A cell that should be a number or yes/no and isn't.
      // (An empty reps or seconds cell is how a file says "not this one".)
      const mistyped = Object.entries(fields).find(([k, v]) => Number.isNaN(v)
        || (v === null && !['defaultReps', 'defaultDuration'].includes(k)));
      const prior = id ? byId.get(id) : null;
      if (id && !prior) { bad('id', 'unknown_id'); continue; }
      if (id && seen.has(id)) { bad('id', 'listed_twice'); continue; }
      if (id) seen.add(id);
      if (mistyped) { bad(FIELD_OF[mistyped[0]] ?? mistyped[0]); continue; }
      const body = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      // Counted or timed — a row that fills in both hasn't said which.
      if (Number(body.defaultReps) > 0 && Number(body.defaultDuration) > 0) { bad('defaultReps_or_defaultDuration'); continue; }
      // A file with only some of the Swahili columns keeps the rest of the translation.
      if (body.i18n?.sw) body.i18n = { sw: { ...(prior?.i18n?.sw ?? {}), ...body.i18n.sw } };

      if (prior) {
        const before = shape(id, {}, strip(prior));
        const candidate = shape(id, body, strip(prior));
        const problem = check(candidate, all);
        if (problem) { bad(problem.field); continue; }
        if (same(before, candidate)) { rows.push({ line, id, name: prior.name, action: 'unchanged' }); continue; }
        const changed = Object.keys(candidate).filter(k => JSON.stringify(candidate[k]) !== JSON.stringify(before[k]))
          .concat(Object.keys(before).filter(k => !(k in candidate)));
        rows.push({ line, id, name: candidate.name, action: 'update', changed: [...new Set(changed)] });
        todo.push({ candidate, prior });
      } else {
        const base = slug(body.name ?? '');
        if (!base) { bad('name'); continue; }
        let newId = `ex_${base}`;
        for (let n = 2; taken.has(newId); n += 1) newId = `ex_${base}_${n}`;
        const candidate = shape(newId, body);
        const problem = check(candidate, all);
        if (problem) { bad(problem.field); continue; }
        taken.add(newId);
        rows.push({ line, id: newId, name: candidate.name, action: 'create' });
        todo.push({ candidate, prior: null });
      }
    }

    const count = a => rows.filter(r => r.action === a).length;
    const summary = { create: count('create'), update: count('update'), unchanged: count('unchanged'), errors: count('error') };
    // Switching everything off would leave members with no plan to make.
    const after = new Map(all.map(e => [e.id, e.active]));
    for (const { candidate } of todo) after.set(candidate.id, candidate.active);
    if (![...after.values()].some(Boolean)) return { error: 'last_active_exercise', status: 409 };

    if (!dryRun) {
      for (const { candidate } of todo) await persist(candidate, actorId);
      await load();
      for (const { candidate, prior } of todo) await audit(actorId, prior ? 'updated' : 'created', candidate.id, prior, candidate);
    }
    return { applied: !dryRun, summary, rows, unknownColumns: parsed.unknownColumns };
  }

  return { load, ensureFresh, list, create, update, reset, exportCsv, importCsv, builtInCount: EXERCISES.length };
}
