// Training Plans — the rules-based recommendation provider.
//
// Deterministic: the same input always gives the same plan. No model is
// called. It works in four steps:
//
//   1. A weekly split — which areas each session trains — from how many
//      days the member trains, the style their goal leans on, and the
//      areas they chose (those come first and get the most work).
//   2. Session days spread across the week from the start date.
//   3. For each session, the best exercise for each area in turn, from
//      what the member can actually do (equipment, place, experience).
//   4. Sets and reps from the library, nudged by experience and by week.
import { listExercises } from '../../shared/exercise-library.mjs';
import { EXPERIENCE_LEVELS } from '../../shared/training-taxonomy.mjs';

const UPPER = ['chest', 'back', 'shoulders', 'biceps', 'triceps'];
const LOWER = ['quadriceps', 'glutes', 'hamstrings', 'calves'];
const CORE = ['abs', 'obliques', 'lower_back'];
const PUSH = ['chest', 'shoulders', 'triceps'];
const PULL = ['back', 'biceps'];
const MUSCLES = [...UPPER, ...LOWER, ...CORE];

// A session kind: the areas it draws on (in order) and how it is recorded.
const SESSIONS = {
  full: { name: 'Full Body', areas: ['quadriceps', 'chest', 'back', 'glutes', 'shoulders', 'abs', 'hamstrings', 'full_body'], activityType: 'strength' },
  upper: { name: 'Upper Body', areas: [...UPPER, 'abs'], activityType: 'strength' },
  lower: { name: 'Lower Body', areas: [...LOWER, 'abs'], activityType: 'strength' },
  push: { name: 'Push', areas: [...PUSH, 'abs'], activityType: 'strength' },
  pull: { name: 'Pull', areas: [...PULL, 'lower_back', 'obliques'], activityType: 'strength' },
  core: { name: 'Core', areas: [...CORE, 'full_body'], activityType: 'functional' },
  cardio: { name: 'Cardio', areas: ['cardio', 'cardio', 'full_body', 'cardio', 'abs'], activityType: 'hiit' },
  conditioning: { name: 'Conditioning', areas: ['cardio', 'quadriceps', 'cardio', 'full_body', 'abs', 'cardio'], activityType: 'hiit' },
  mobility: { name: 'Mobility', areas: ['mobility', 'mobility', 'lower_back', 'mobility', 'abs', 'mobility'], activityType: 'mobility' },
  functional: { name: 'Functional', areas: ['full_body', 'quadriceps', 'back', 'abs', 'glutes', 'shoulders'], activityType: 'functional' },
};

// Sessions per week, by style and days trained.
const SPLITS = {
  strength: {
    2: ['full', 'full'], 3: ['full', 'full', 'full'], 4: ['upper', 'lower', 'upper', 'lower'],
    5: ['push', 'pull', 'lower', 'upper', 'lower'], 6: ['push', 'pull', 'lower', 'push', 'pull', 'lower'],
  },
  mixed: {
    2: ['full', 'cardio'], 3: ['full', 'cardio', 'full'], 4: ['upper', 'cardio', 'lower', 'conditioning'],
    5: ['upper', 'cardio', 'lower', 'conditioning', 'full'], 6: ['upper', 'cardio', 'lower', 'conditioning', 'full', 'mobility'],
  },
  cardio: {
    2: ['cardio', 'full'], 3: ['cardio', 'full', 'cardio'], 4: ['cardio', 'full', 'conditioning', 'cardio'],
    5: ['cardio', 'full', 'conditioning', 'cardio', 'mobility'], 6: ['cardio', 'full', 'conditioning', 'cardio', 'full', 'mobility'],
  },
  hiit: {
    2: ['conditioning', 'full'], 3: ['conditioning', 'full', 'conditioning'], 4: ['conditioning', 'full', 'cardio', 'conditioning'],
    5: ['conditioning', 'full', 'cardio', 'conditioning', 'mobility'], 6: ['conditioning', 'upper', 'cardio', 'lower', 'conditioning', 'mobility'],
  },
  functional: {
    2: ['functional', 'full'], 3: ['functional', 'full', 'functional'], 4: ['functional', 'full', 'core', 'functional'],
    5: ['functional', 'full', 'cardio', 'functional', 'core'], 6: ['functional', 'full', 'cardio', 'functional', 'core', 'mobility'],
  },
  mobility: {
    2: ['mobility', 'full'], 3: ['mobility', 'full', 'mobility'], 4: ['mobility', 'full', 'mobility', 'core'],
    5: ['mobility', 'full', 'mobility', 'core', 'mobility'], 6: ['mobility', 'full', 'mobility', 'core', 'cardio', 'mobility'],
  },
};

// Days into each week a session falls, so training and rest alternate.
const OFFSETS = { 1: [0], 2: [0, 3], 3: [0, 2, 4], 4: [0, 1, 3, 5], 5: [0, 1, 2, 4, 5], 6: [0, 1, 2, 3, 4, 5] };

const MAX_SESSION_EXERCISES = 11;
/** Minutes an exercise takes as prescribed: the work plus the rests between sets. */
function minutesFor(e) {
  const work = e.defaultDuration ?? (e.defaultReps ?? 10) * 3;
  return (e.defaultSets * (work + e.restSeconds) + 30) / 60;
}

const STYLE_CATEGORIES = {
  strength: ['strength'], mixed: ['strength', 'cardio', 'functional'], cardio: ['cardio', 'hiit'],
  hiit: ['hiit', 'cardio'], functional: ['functional', 'strength'], mobility: ['mobility', 'stretching'],
};
const LEVEL = Object.fromEntries(EXPERIENCE_LEVELS.map((l, i) => [l, i]));
const AREA_LABEL = a => a.split('_').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
const STYLE_LABEL = { strength: 'Strength', mixed: 'Fitness', cardio: 'Endurance', hiit: 'HIIT', functional: 'Functional', mobility: 'Mobility' };

const weekday = date => ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1; // 1 = Monday
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * The session's areas with the muscles the member chose first. `turn`
 * rotates which of them leads, so the emphasis moves from day to day.
 */
function focusFor(kind, chosen, turn = 0) {
  const base = SESSIONS[kind].areas;
  const picked = chosen.filter(a => MUSCLES.includes(a) && base.includes(a));
  const mine = picked.map((_, i) => picked[(i + turn) % picked.length]);
  return { order: [...mine, ...base.filter(a => !mine.includes(a))], mine };
}

/** "Chest + Triceps" when the member's areas shape the session, else the kind's name. */
function sessionName(kind, mine) {
  return mine.length ? mine.slice(0, 2).map(AREA_LABEL).join(' + ') : SESSIONS[kind].name;
}

export function createRulesRecommendationProvider({ library } = {}) {
  function recommend(input) {
    const style = SPLITS[input.style] ? input.style : 'mixed';
    const days = Math.min(Math.max(input.daysPerWeek, 1), 6);
    let kinds = [...SPLITS[style][days] ?? SPLITS[style][3]];
    const chosen = input.targetAreas ?? [];

    // Chosen areas steer the split: asking for cardio or mobility brings a
    // session of it in, and an upper- or lower-only choice fills the
    // strength days with that half.
    const muscles = chosen.filter(a => MUSCLES.includes(a));
    const strengthDays = kinds.map((k, i) => i).filter(i => SESSIONS[kinds[i]].activityType === 'strength');
    if (muscles.length && strengthDays.length) {
      const allIn = set => muscles.every(a => set.includes(a));
      const half = allIn(UPPER) ? 'upper' : allIn(LOWER) ? 'lower' : null;
      if (allIn(CORE)) kinds[strengthDays[strengthDays.length - 1]] = 'core';
      // Keep one balancing session when there are three or more strength days.
      else if (half) strengthDays.forEach((i, n) => { if (strengthDays.length < 3 || n !== 1) kinds[i] = half; else kinds[i] = half === 'upper' ? 'lower' : 'upper'; });
    }
    for (const extra of ['cardio', 'mobility']) {
      if (chosen.includes(extra) && !kinds.includes(extra) && kinds.length > 1) kinds[kinds.length - 1] = extra;
    }

    const pool = listExercises({ environment: input.environment, equipment: input.equipment, experience: input.experience }, library);
    if (!pool.length) return { error: 'no_exercises', status: 422 };

    const skipped = new Set(input.history?.skippedExerciseIds ?? []);
    const done = new Set(input.history?.completedExerciseIds ?? []);
    // Exercises the member said they couldn't do or had no equipment for are left out.
    const avoid = new Set((input.history?.feedback ?? [])
      .filter(f => ['couldnt_perform', 'equipment_unavailable'].includes(f.reason) && f.exerciseId).map(f => f.exerciseId));
    const wanted = STYLE_CATEGORIES[style];
    const level = LEVEL[input.experience] ?? 0;
    const budget = input.sessionMinutes;
    const has = new Set(input.equipment ?? []);
    const equipped = [...has].some(x => x !== 'none');

    function score(e, area, usedThisWeek) {
      return (e.targetAreas[0] === area ? 3 : 0)
        + (e.suitableGoals.includes(input.goal) ? 3 : 0)
        + (wanted.includes(e.category) ? 2 : 0)
        + (LEVEL[e.difficulty] === level ? 1 : 0)
        // Bigger movements, which work more than one area, come before isolated ones.
        + Math.min(e.secondaryAreas.length, 2) * 0.5
        // Someone with equipment, training for strength, should use it.
        + (equipped && style === 'strength' && !e.equipment.includes('none') ? 2 : 0)
        + (usedThisWeek.has(e.id) ? -5 : 0)
        + (done.has(e.id) ? 0.5 : 0)
        + (skipped.has(e.id) ? -6 : 0);
    }

    function pick(kind, week, slot, usedThisWeek) {
      const { order, mine } = focusFor(kind, chosen, slot);
      const picked = [];
      const taken = new Set();
      let minutes = 0;
      const full = () => minutes >= budget * 0.9 || picked.length >= MAX_SESSION_EXERCISES;
      // Go round the areas until the time is used or nothing new fits.
      for (let round = 0; !full() && round < 4; round += 1) {
        const before = picked.length;
        // After the first pass only the member's own areas get extra work.
        const areas = round === 0 ? order : (mine.length ? mine : order);
        for (const area of areas) {
          if (full()) break;
          const options = pool
            .filter(e => !taken.has(e.id) && !avoid.has(e.id) && e.targetAreas.includes(area))
            // Nothing that would run well past the session, once it has a start.
            .filter(e => picked.length < 2 || minutes + minutesFor(e) <= budget * 1.15)
            .map((e, i) => ({ e, s: score(e, area, usedThisWeek), i }));
          if (!options.length) continue;
          // Best score wins; ties rotate with the week and session so plans vary.
          options.sort((a, b) => b.s - a.s || ((a.i + week + slot) % options.length) - ((b.i + week + slot) % options.length));
          const { e } = options[0];
          taken.add(e.id);
          picked.push({ e, area });
          minutes += minutesFor(e);
        }
        if (picked.length === before) break;
      }
      // Nothing for these areas with what the member has: fall back to anything usable.
      if (picked.length < 2) {
        for (const e of pool) {
          if (picked.length >= 4) break;
          if (!taken.has(e.id) && !avoid.has(e.id)) { taken.add(e.id); picked.push({ e, area: e.targetAreas[0] }); }
        }
      }
      picked.forEach(p => usedThisWeek.add(p.e.id));
      // Exercises for the same area sit together, and core work comes last.
      const first = new Map();
      picked.forEach((p, i) => { if (!first.has(p.area)) first.set(p.area, i); });
      picked.sort((a, b) => (CORE.includes(a.area) - CORE.includes(b.area)) || first.get(a.area) - first.get(b.area));
      return { picked, mine };
    }

    function prescribe(e, week) {
      // Experienced members take an extra set; later weeks ask a little more.
      const sets = Math.min(e.defaultSets + (level === 2 && e.defaultSets < 5 && !e.defaultDuration ? 1 : 0), 5);
      const step = Math.min(week - 1, 4);
      const long = (e.defaultDuration ?? 0) >= 300;
      return {
        libraryId: e.id,
        exerciseName: e.name,
        muscleGroup: e.targetAreas[0],
        sets,
        reps: e.defaultReps ? e.defaultReps + step : null,
        duration: e.defaultDuration ? e.defaultDuration + step * (long ? 60 : 5) : null,
        instructions: e.instructions.join(' '),
        tracksWeight: e.tracksWeight,
      };
    }

    const offsets = OFFSETS[kinds.length];
    const weeks = [];
    for (let week = 1; week <= input.durationWeeks; week += 1) {
      const usedThisWeek = new Set();
      const weekStart = addDays(input.startDate, (week - 1) * 7);
      const sessions = [];
      kinds.forEach((kind, slot) => {
        const { picked, mine } = pick(kind, week, slot, usedThisWeek);
        if (!picked.length) return;
        sessions.push({
          day: weekday(addDays(weekStart, offsets[slot])),
          focusAreas: [...new Set(picked.map(p => p.area))],
          workout: {
            name: sessionName(kind, mine),
            activityType: SESSIONS[kind].activityType,
            estimatedDuration: input.sessionMinutes,
            exercises: picked.map(p => prescribe(p.e, week)),
          },
        });
      });
      if (!sessions.length) return { error: 'no_exercises', status: 422 };
      weeks.push({ week, days: sessions });
    }

    return {
      name: `${input.durationWeeks}-Week ${STYLE_LABEL[style]} Plan`,
      durationWeeks: input.durationWeeks,
      weeks,
    };
  }

  return { recommend };
}

export { addDays as addPlanDays, weekday as planWeekday };
