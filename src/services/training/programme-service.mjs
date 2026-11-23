// Programmes — FitFlex's published, fixed-length, day-by-day plans
// (docs/specs/programmes-nutrition.md §4 and docs/plans/programmes-p1-plan.md
// in the parent repo).
//
// This file is the authoring side (slice B1): staff write a programme as a
// draft, publish it, retire it, or make a new draft version of a live one.
// A live programme is never edited in place: members who started it keep
// exactly what they started. Members' side (catalogue, starting one) is B2.
//
// A programme's days are one list, day 1..lengthDays:
//   { day, type: 'gym' | 'home' | 'rest', workout? }
// A home day needs a workout to publish; a gym day may carry a suggested
// one (done by a check-in either way, PD-3); a rest day has none.
import { randomUUID } from 'node:crypto';
import { validateWorkoutDefinition } from '../workout-service.mjs';
import {
  ENVIRONMENTS, EQUIPMENT, EXPERIENCE_LEVELS, FITNESS_GOAL_IDS,
} from '../../shared/training-taxonomy.mjs';

export const PROGRAMME_DAY_TYPES = ['gym', 'home', 'rest'];
export const PROGRAMME_STATUSES = ['draft', 'live', 'retired'];
export const PROGRAMME_LENGTH = { min: 7, max: 84 };
const MAX = { title: 80, summary: 400 };
const LANGS = ['sw'];

const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const fail = (field, error = 'invalid_programme') => ({ error, status: 400, field });

/** The Swahili (and any later language) title and summary, tidied; null when nothing was given. */
function tidyI18n(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  for (const lang of LANGS) {
    const t = input[lang];
    if (!t || typeof t !== 'object') continue;
    const entry = {
      ...(text(t.title, MAX.title) ? { title: text(t.title, MAX.title) } : {}),
      ...(text(t.summary, MAX.summary) ? { summary: text(t.summary, MAX.summary) } : {}),
    };
    if (Object.keys(entry).length) out[lang] = entry;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The days as sent, checked and numbered 1..lengthDays. Days not sent are
 * rest days, so a new programme starts as an empty grid. Returns
 * { days } or a 400 naming the day at fault (`days[3].workout`).
 */
export function tidyDays(input, lengthDays) {
  if (input != null && !Array.isArray(input)) return fail('days');
  const given = input ?? [];
  if (given.length > lengthDays) return fail('days');
  const days = [];
  for (let i = 0; i < lengthDays; i += 1) {
    const d = given[i] ?? { type: 'rest' };
    if (!d || typeof d !== 'object' || !PROGRAMME_DAY_TYPES.includes(d.type)) return fail(`days[${i}].type`);
    if (d.day != null && d.day !== i + 1) return fail(`days[${i}].day`);
    if (d.type === 'rest' || d.workout == null) {
      days.push({ day: i + 1, type: d.type });
      continue;
    }
    const v = validateWorkoutDefinition(d.workout);
    if (v.error) return { ...fail(`days[${i}].workout`), reason: v.error };
    days.push({ day: i + 1, type: d.type, workout: v.definition });
  }
  return { days };
}

/** A whole programme from what staff sent, on top of what was there. */
function shape(body, prior = {}) {
  const pick = k => (body[k] !== undefined ? body[k] : prior[k]);
  const title = text(pick('title'), MAX.title);
  if (!title) return fail('title');
  const goal = pick('goal');
  if (!FITNESS_GOAL_IDS.includes(goal)) return fail('goal');
  const level = pick('level');
  if (!EXPERIENCE_LEVELS.includes(level)) return fail('level');
  const environment = pick('environment');
  if (!ENVIRONMENTS.includes(environment)) return fail('environment');
  const equipment = pick('equipment') ?? [];
  if (!Array.isArray(equipment) || !equipment.every(e => EQUIPMENT.includes(e))) return fail('equipment');
  const lengthDays = pick('lengthDays');
  if (!Number.isInteger(lengthDays) || lengthDays < PROGRAMME_LENGTH.min || lengthDays > PROGRAMME_LENGTH.max) return fail('lengthDays');
  // A shorter length drops the days past it; a longer one adds rest days.
  const dayInput = body.days !== undefined ? body.days : (prior.days ?? []).slice(0, lengthDays);
  const tidied = tidyDays(dayInput, lengthDays);
  if (tidied.error) return tidied;
  return {
    programme: {
      title,
      summary: text(pick('summary'), MAX.summary),
      i18n: body.i18n !== undefined ? tidyI18n(body.i18n) : (prior.i18n ?? null),
      goal, level, environment,
      equipment: [...new Set(equipment)],
      lengthDays,
      days: tidied.days,
    },
  };
}

/**
 * What stops a programme going live, or null. Checked at publish only, so
 * a draft can be saved half-written.
 */
export function publishProblem(p, exerciseExists = () => true) {
  if (!text(p.summary, MAX.summary)) return 'summary';
  if (!p.i18n?.sw?.title) return 'i18n.sw.title';
  if (!p.i18n?.sw?.summary) return 'i18n.sw.summary';
  if (!p.days.some(d => d.type !== 'rest')) return 'days';
  for (const d of p.days) {
    if (d.type === 'home' && !d.workout) return `days[${d.day - 1}].workout`;
    for (const ex of d.workout?.exercises ?? []) {
      if (ex.libraryId && !exerciseExists(ex.libraryId)) return `days[${d.day - 1}].workout`;
    }
  }
  return null;
}

export function createProgrammeService({
  programmes, plans, auditLog = null,
  // True when an exercise-library id is live (exerciseById after a refresh).
  exerciseExists = () => true, ensureLibrary = async () => {},
  catalogueOn = () => false,
  now = () => new Date(), logger = console,
}) {
  const newId = () => `prg_${randomUUID().slice(0, 12)}`;

  async function audit(actorId, action, id, before, after) {
    try {
      await auditLog?.insertAsync({
        id: `aud_${randomUUID().slice(0, 12)}`, at: now().toISOString(), actor: actorId,
        action: `programme_${action}`, target: id,
        before: before ? JSON.stringify(summaryOf(before)) : null, after: after ? JSON.stringify(summaryOf(after)) : null,
      });
    } catch (err) {
      logger.warn?.(`[programmes] audit failed: ${err?.message}`);
    }
  }
  // The audit trail keeps what matters for review, not every exercise of every day.
  const summaryOf = p => ({
    title: p.title, status: p.status, goal: p.goal, level: p.level, environment: p.environment, lengthDays: p.lengthDays,
    dayTypes: (p.days ?? []).map(d => d.type).join(''),
  });

  async function enrolledCounts(ids) {
    const counts = new Map(ids.map(id => [id, 0]));
    if (!plans || !ids.length) return counts;
    for (const plan of await plans.filterByColumnInAsync('programmeId', ids)) {
      counts.set(plan.programmeId, (counts.get(plan.programmeId) ?? 0) + 1);
    }
    return counts;
  }

  /** Every programme, newest change first, with how many members started each. */
  async function list() {
    const rows = await programmes.allAsync();
    const counts = await enrolledCounts(rows.map(r => r.id));
    rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return {
      programmes: rows.map(r => ({ ...r, enrolled: counts.get(r.id) ?? 0 })),
      catalogueOn: catalogueOn(),
    };
  }

  async function get(id) {
    const row = await programmes.findByIdAsync(id);
    if (!row) return { error: 'not_found', status: 404 };
    const counts = await enrolledCounts([id]);
    return { programme: { ...row, enrolled: counts.get(id) ?? 0 }, catalogueOn: catalogueOn() };
  }

  /** Write a new draft. */
  async function create(actorId, body = {}) {
    const shaped = shape(body);
    if (shaped.error) return shaped;
    const stamp = now().toISOString();
    const row = {
      id: newId(), ...shaped.programme, status: 'draft', versionOf: null,
      createdBy: actorId ?? null, updatedBy: actorId ?? null, publishedAt: null, retiredAt: null,
      createdAt: stamp, updatedAt: stamp,
    };
    await programmes.insertAsync(row);
    await audit(actorId, 'created', row.id, null, row);
    return { programme: { ...row, enrolled: 0 } };
  }

  /** Change a draft. A live or retired programme is changed by making a new version. */
  async function update(actorId, id, body = {}) {
    const prior = await programmes.findByIdAsync(id);
    if (!prior) return { error: 'not_found', status: 404 };
    if (prior.status !== 'draft') return { error: 'not_a_draft', status: 409 };
    const shaped = shape(body, prior);
    if (shaped.error) return shaped;
    const patch = { ...shaped.programme, updatedBy: actorId ?? null, updatedAt: now().toISOString() };
    await programmes.updateByIdAsync(id, patch);
    const saved = { ...prior, ...patch };
    await audit(actorId, 'updated', id, prior, saved);
    return { programme: { ...saved, enrolled: 0 } };
  }

  /** Make a draft live. Members see it once PROGRAMMES_CATALOGUE is on. */
  async function publish(actorId, id) {
    const prior = await programmes.findByIdAsync(id);
    if (!prior) return { error: 'not_found', status: 404 };
    if (prior.status !== 'draft') return { error: 'not_a_draft', status: 409 };
    await ensureLibrary();
    const problem = publishProblem(prior, exerciseExists);
    if (problem) return { error: 'not_ready_to_publish', status: 400, field: problem };
    const stamp = now().toISOString();
    const patch = { status: 'live', publishedAt: stamp, updatedBy: actorId ?? null, updatedAt: stamp };
    await programmes.updateByIdAsync(id, patch);
    const saved = { ...prior, ...patch };
    await audit(actorId, 'published', id, prior, saved);
    // A new version replaces the live one it was made from, so members never see both.
    const older = prior.versionOf ? await programmes.findByIdAsync(prior.versionOf) : null;
    if (older?.status === 'live') await retire(actorId, older.id);
    const counts = await enrolledCounts([id]);
    return { programme: { ...saved, enrolled: counts.get(id) ?? 0 } };
  }

  /** Stop new starts. Members already on it can finish it. */
  async function retire(actorId, id) {
    const prior = await programmes.findByIdAsync(id);
    if (!prior) return { error: 'not_found', status: 404 };
    if (prior.status !== 'live') return { error: 'not_live', status: 409 };
    const stamp = now().toISOString();
    const patch = { status: 'retired', retiredAt: stamp, updatedBy: actorId ?? null, updatedAt: stamp };
    await programmes.updateByIdAsync(id, patch);
    const saved = { ...prior, ...patch };
    await audit(actorId, 'retired', id, prior, saved);
    const counts = await enrolledCounts([id]);
    return { programme: { ...saved, enrolled: counts.get(id) ?? 0 } };
  }

  /** A new draft copied from any programme (the way to change a live one). */
  async function duplicate(actorId, id) {
    const prior = await programmes.findByIdAsync(id);
    if (!prior) return { error: 'not_found', status: 404 };
    const stamp = now().toISOString();
    const row = {
      id: newId(),
      title: prior.title, summary: prior.summary ?? null, i18n: prior.i18n ?? null,
      goal: prior.goal, level: prior.level, environment: prior.environment, equipment: prior.equipment ?? [],
      lengthDays: prior.lengthDays, days: prior.days ?? [],
      status: 'draft', versionOf: prior.id,
      createdBy: actorId ?? null, updatedBy: actorId ?? null, publishedAt: null, retiredAt: null,
      createdAt: stamp, updatedAt: stamp,
    };
    await programmes.insertAsync(row);
    await audit(actorId, 'duplicated', row.id, prior, row);
    return { programme: { ...row, enrolled: 0 } };
  }

  // ── Members (slice B2): live programmes only ───────────────────────────────

  /**
   * A programme as a member sees it: no authoring fields, title and summary
   * in their language (Swahili falls back to English), and each day's
   * workout reduced to what the catalogue and detail screens show.
   */
  function memberView(p, lang = 'en', { withDays = true } = {}) {
    const t = lang === 'sw' ? (p.i18n?.sw ?? {}) : {};
    const days = p.days ?? [];
    const count = type => days.filter(d => d.type === type).length;
    return {
      id: p.id,
      title: t.title ?? p.title,
      summary: t.summary ?? p.summary ?? null,
      goal: p.goal, level: p.level, environment: p.environment, equipment: p.equipment ?? [],
      lengthDays: p.lengthDays,
      dayCounts: { gym: count('gym'), home: count('home'), rest: count('rest') },
      // The day types in order ("hrhg…"), for the card's day strip.
      dayTypes: days.map(d => d.type),
      // P1 programmes are all free; P3 adds paid ones.
      free: true,
      publishedAt: p.publishedAt ?? null,
      ...(withDays ? {
        days: days.map(d => ({
          day: d.day, type: d.type,
          workout: d.workout ? {
            name: d.workout.name, activityType: d.workout.activityType,
            estimatedDuration: d.workout.estimatedDuration ?? null, exerciseCount: d.workout.exercises?.length ?? 0,
          } : null,
        })),
      } : {}),
    };
  }

  /**
   * Live programmes for the catalogue, newest first. Filters (all optional):
   * goal, level, environment (a programme for `any` place matches every
   * place), minDays / maxDays (inclusive).
   */
  async function catalogue(query = {}) {
    const minDays = query.minDays != null ? Number(query.minDays) : null;
    const maxDays = query.maxDays != null ? Number(query.maxDays) : null;
    if (minDays != null && !Number.isInteger(minDays)) return fail('minDays', 'invalid_filter');
    if (maxDays != null && !Number.isInteger(maxDays)) return fail('maxDays', 'invalid_filter');
    if (query.goal && !FITNESS_GOAL_IDS.includes(query.goal)) return fail('goal', 'invalid_filter');
    if (query.level && !EXPERIENCE_LEVELS.includes(query.level)) return fail('level', 'invalid_filter');
    if (query.environment && !ENVIRONMENTS.includes(query.environment)) return fail('environment', 'invalid_filter');
    const rows = (await programmes.allAsync()).filter(p => p.status === 'live'
      && (!query.goal || p.goal === query.goal)
      && (!query.level || p.level === query.level)
      && (!query.environment || query.environment === 'any' || p.environment === query.environment || p.environment === 'any')
      && (minDays == null || p.lengthDays >= minDays)
      && (maxDays == null || p.lengthDays <= maxDays));
    rows.sort((a, b) => String(b.publishedAt ?? '').localeCompare(String(a.publishedAt ?? '')));
    return { programmes: rows.map(p => memberView(p, query.lang, { withDays: false })) };
  }

  /** One live programme for a member, or 404 (drafts and retired ones are not shown). */
  async function forMember(id, lang) {
    const p = await programmes.findByIdAsync(id);
    if (!p || p.status !== 'live') return { error: 'not_found', status: 404 };
    return { programme: memberView(p, lang) };
  }

  /**
   * The whole live programme to start (days with their workouts), or why
   * not: 404 when it never existed, 409 programme_unavailable when it is a
   * draft or was retired.
   */
  async function startable(id) {
    const p = await programmes.findByIdAsync(id);
    if (!p) return { error: 'not_found', status: 404 };
    if (p.status !== 'live') return { error: 'programme_unavailable', status: 409 };
    return { programme: p };
  }

  return { list, get, create, update, publish, retire, duplicate, catalogue, forMember, startable, memberView };
}
