// Training Plans — the FitFlex exercise library.
//
// Each entry is plain data so it can move into a table (and an admin
// screen) later without changing its shape:
//
//   id               stable id, never reused
//   name             English name
//   description      one line on what it is
//   category         EXERCISE_CATEGORIES
//   targetAreas      main areas worked (TARGET_AREAS)
//   secondaryAreas   areas that help
//   movementPattern  MOVEMENT_PATTERNS (optional)
//   difficulty       EXPERIENCE_LEVELS — the lowest level it suits
//   equipment        every item needed (EQUIPMENT); ['none'] = bodyweight
//   environment      where it can be done (EXERCISE_ENVIRONMENTS)
//   suitableGoals    FITNESS_GOAL_IDS it serves
//   defaultSets, defaultReps | defaultDuration (seconds), restSeconds
//   tracksWeight     a load (kg) is worth recording
//   instructions     short steps, in order
//   alternatives     ids of exercises that keep the same intent
//   active           false hides it from new plans; old workouts keep it
//   i18n             { sw: { name, description, instructions } } when translated
//
// This is the starter set that proves the model; the full library arrives
// with the recommendation engine.
import {
  EXERCISE_CATEGORIES, EXERCISE_ENVIRONMENTS, EXPERIENCE_LEVELS, EQUIPMENT, FITNESS_GOAL_IDS,
  MOVEMENT_PATTERNS, TARGET_AREAS, availableEquipment,
} from './training-taxonomy.mjs';

const ALL = ['gym', 'home', 'outdoor'];
const GENERAL = ['lose_weight', 'stay_fit', 'learn_new_skill'];
const MUSCLE = ['gain_muscle', 'build_muscle', 'stay_fit'];

export const EXERCISES = [
  {
    id: 'ex_push_up', name: 'Push-up', description: 'A bodyweight press for the chest, shoulders and arms.',
    category: 'strength', targetAreas: ['chest'], secondaryAreas: ['triceps', 'shoulders', 'abs'], movementPattern: 'push',
    difficulty: 'beginner', equipment: ['none'], environment: ALL, suitableGoals: [...MUSCLE, ...GENERAL],
    defaultSets: 3, defaultReps: 10, restSeconds: 60, tracksWeight: false,
    instructions: ['Hands under your shoulders, body in one straight line.', 'Lower your chest to just above the floor.', 'Press back up without letting your hips sag.'],
    alternatives: ['ex_dumbbell_bench_press', 'ex_bench_press'], active: true,
  },
  {
    id: 'ex_bench_press', name: 'Barbell Bench Press', description: 'The classic barbell press for the chest.',
    category: 'strength', targetAreas: ['chest'], secondaryAreas: ['triceps', 'shoulders'], movementPattern: 'push',
    difficulty: 'intermediate', equipment: ['free_weights'], environment: ['gym'], suitableGoals: MUSCLE,
    defaultSets: 3, defaultReps: 10, restSeconds: 90, tracksWeight: true,
    instructions: ['Lie with your eyes under the bar and feet flat.', 'Lower the bar to mid-chest with control.', 'Press back up until your arms are straight.'],
    alternatives: ['ex_dumbbell_bench_press', 'ex_push_up'], active: true,
  },
  {
    id: 'ex_dumbbell_bench_press', name: 'Dumbbell Bench Press', description: 'A chest press with a dumbbell in each hand.',
    category: 'strength', targetAreas: ['chest'], secondaryAreas: ['triceps', 'shoulders'], movementPattern: 'push',
    difficulty: 'beginner', equipment: ['dumbbells'], environment: ['gym', 'home'], suitableGoals: MUSCLE,
    defaultSets: 3, defaultReps: 10, restSeconds: 75, tracksWeight: true,
    instructions: ['Lie back with a dumbbell above each shoulder.', 'Lower them to the sides of your chest.', 'Press up and together.'],
    alternatives: ['ex_bench_press', 'ex_push_up'], active: true,
  },
  {
    id: 'ex_dumbbell_row', name: 'One-arm Dumbbell Row', description: 'A pull for the back, one side at a time.',
    category: 'strength', targetAreas: ['back'], secondaryAreas: ['biceps'], movementPattern: 'pull',
    difficulty: 'beginner', equipment: ['dumbbells'], environment: ['gym', 'home'], suitableGoals: MUSCLE,
    defaultSets: 3, defaultReps: 10, restSeconds: 60, tracksWeight: true,
    instructions: ['One hand and knee on a bench, back flat.', 'Pull the dumbbell to your hip.', 'Lower it slowly.'],
    alternatives: ['ex_lat_pulldown', 'ex_band_row'], active: true,
  },
  {
    id: 'ex_lat_pulldown', name: 'Lat Pulldown', description: 'A machine pull for the upper back.',
    category: 'strength', targetAreas: ['back'], secondaryAreas: ['biceps'], movementPattern: 'pull',
    difficulty: 'beginner', equipment: ['machines'], environment: ['gym'], suitableGoals: MUSCLE,
    defaultSets: 3, defaultReps: 12, restSeconds: 75, tracksWeight: true,
    instructions: ['Grip the bar a little wider than your shoulders.', 'Pull it to your upper chest, squeezing your shoulder blades.', 'Let it rise under control.'],
    alternatives: ['ex_dumbbell_row', 'ex_band_row'], active: true,
  },
  {
    id: 'ex_band_row', name: 'Resistance Band Row', description: 'A seated or standing pull with a band.',
    category: 'strength', targetAreas: ['back'], secondaryAreas: ['biceps'], movementPattern: 'pull',
    difficulty: 'beginner', equipment: ['resistance_bands'], environment: ALL, suitableGoals: [...MUSCLE, 'lose_weight'],
    defaultSets: 3, defaultReps: 12, restSeconds: 60, tracksWeight: false,
    instructions: ['Anchor the band at chest height.', 'Pull your elbows back past your ribs.', 'Return slowly, keeping the band tight.'],
    alternatives: ['ex_dumbbell_row', 'ex_lat_pulldown'], active: true,
  },
  {
    id: 'ex_bodyweight_squat', name: 'Bodyweight Squat', description: 'The basic squat for the legs and glutes.',
    category: 'strength', targetAreas: ['quadriceps', 'glutes'], secondaryAreas: ['hamstrings', 'abs'], movementPattern: 'squat',
    difficulty: 'beginner', equipment: ['none'], environment: ALL, suitableGoals: [...MUSCLE, ...GENERAL],
    defaultSets: 3, defaultReps: 15, restSeconds: 60, tracksWeight: false,
    instructions: ['Feet shoulder-width apart, chest up.', 'Sit back and down until your thighs are level.', 'Stand up through your heels.'],
    alternatives: ['ex_goblet_squat'], active: true,
  },
  {
    id: 'ex_goblet_squat', name: 'Goblet Squat', description: 'A squat holding one dumbbell at the chest.',
    category: 'strength', targetAreas: ['quadriceps', 'glutes'], secondaryAreas: ['hamstrings', 'abs'], movementPattern: 'squat',
    difficulty: 'beginner', equipment: ['dumbbells'], environment: ['gym', 'home'], suitableGoals: MUSCLE,
    defaultSets: 3, defaultReps: 12, restSeconds: 75, tracksWeight: true,
    instructions: ['Hold a dumbbell upright against your chest.', 'Squat down between your knees.', 'Stand tall at the top.'],
    alternatives: ['ex_bodyweight_squat'], active: true,
  },
  {
    id: 'ex_glute_bridge', name: 'Glute Bridge', description: 'A floor lift for the glutes and hamstrings.',
    category: 'strength', targetAreas: ['glutes'], secondaryAreas: ['hamstrings', 'lower_back'], movementPattern: 'hinge',
    difficulty: 'beginner', equipment: ['none'], environment: ALL, suitableGoals: [...MUSCLE, ...GENERAL],
    defaultSets: 3, defaultReps: 15, restSeconds: 45, tracksWeight: false,
    instructions: ['Lie on your back, knees bent, feet flat.', 'Lift your hips until your body is straight from knee to shoulder.', 'Squeeze, then lower.'],
    alternatives: [], active: true,
  },
  {
    id: 'ex_plank', name: 'Plank', description: 'A hold that steadies the whole trunk.',
    category: 'strength', targetAreas: ['abs'], secondaryAreas: ['obliques', 'lower_back', 'shoulders'], movementPattern: 'core',
    difficulty: 'beginner', equipment: ['none'], environment: ALL, suitableGoals: FITNESS_GOAL_IDS,
    defaultSets: 3, defaultDuration: 30, restSeconds: 45, tracksWeight: false,
    instructions: ['Forearms on the floor, elbows under shoulders.', 'Hold a straight line from head to heels.', 'Breathe steadily; stop when your hips drop.'],
    alternatives: [], active: true,
  },
  {
    id: 'ex_jumping_jacks', name: 'Jumping Jacks', description: 'A simple whole-body warm-up and cardio move.',
    category: 'cardio', targetAreas: ['cardio'], secondaryAreas: ['full_body'], movementPattern: 'locomotion',
    difficulty: 'beginner', equipment: ['none'], environment: ALL, suitableGoals: ['lose_weight', 'stay_fit', 'improve_endurance'],
    defaultSets: 3, defaultDuration: 45, restSeconds: 30, tracksWeight: false,
    instructions: ['Jump your feet apart as your arms go overhead.', 'Jump back to the start.', 'Keep a steady rhythm.'],
    alternatives: [], active: true,
  },
  {
    id: 'ex_hip_flexor_stretch', name: 'Hip Flexor Stretch', description: 'A kneeling stretch for the front of the hips.',
    category: 'stretching', targetAreas: ['mobility'], secondaryAreas: ['quadriceps'], movementPattern: 'stretch',
    difficulty: 'beginner', equipment: ['none'], environment: ALL, suitableGoals: ['improve_flexibility', 'stress_relief', 'stay_fit'],
    defaultSets: 2, defaultDuration: 30, restSeconds: 15, tracksWeight: false,
    instructions: ['Kneel on one knee with the other foot forward.', 'Ease your hips forward until you feel the stretch.', 'Hold, then change sides.'],
    alternatives: [], active: true,
  },
];

const within = (list, allowed) => Array.isArray(list) && list.every(x => allowed.includes(x));
const positive = n => Number.isInteger(n) && n > 0;

/** Why an entry is not a valid exercise, or null when it is. */
export function exerciseProblem(e, ids = new Set(EXERCISES.map(x => x.id))) {
  if (!e || typeof e !== 'object') return 'not_an_object';
  if (typeof e.id !== 'string' || !/^ex_[a-z0-9_]+$/.test(e.id)) return 'id';
  if (typeof e.name !== 'string' || !e.name.trim() || e.name.length > 80) return 'name';
  if (!EXERCISE_CATEGORIES.includes(e.category)) return 'category';
  if (!within(e.targetAreas, TARGET_AREAS) || !e.targetAreas.length) return 'targetAreas';
  if (!within(e.secondaryAreas ?? [], TARGET_AREAS)) return 'secondaryAreas';
  if (e.movementPattern != null && !MOVEMENT_PATTERNS.includes(e.movementPattern)) return 'movementPattern';
  if (!EXPERIENCE_LEVELS.includes(e.difficulty)) return 'difficulty';
  if (!within(e.equipment, EQUIPMENT) || !e.equipment.length) return 'equipment';
  if (!within(e.environment, EXERCISE_ENVIRONMENTS) || !e.environment.length) return 'environment';
  if (!within(e.suitableGoals, FITNESS_GOAL_IDS) || !e.suitableGoals.length) return 'suitableGoals';
  if (!positive(e.defaultSets)) return 'defaultSets';
  // Counted in reps or timed in seconds — one or the other.
  if (positive(e.defaultReps) === positive(e.defaultDuration)) return 'defaultReps_or_defaultDuration';
  if (!(Number.isInteger(e.restSeconds) && e.restSeconds >= 0)) return 'restSeconds';
  if (!Array.isArray(e.instructions) || !e.instructions.length || !e.instructions.every(s => typeof s === 'string' && s.trim())) return 'instructions';
  if (!Array.isArray(e.alternatives) || e.alternatives.includes(e.id) || !e.alternatives.every(a => ids.has(a))) return 'alternatives';
  if (typeof e.active !== 'boolean') return 'active';
  return null;
}

const BY_ID = new Map(EXERCISES.map(e => [e.id, e]));
export const exerciseById = id => BY_ID.get(id) ?? null;

const LEVEL = Object.fromEntries(EXPERIENCE_LEVELS.map((l, i) => [l, i]));

/**
 * Active exercises matching every filter given: target `area`, `category`,
 * `goal`, `environment` (a place; `any` or nothing means anywhere),
 * `equipment` (what the member has) and `experience` (nothing harder).
 */
export function listExercises({ area, category, goal, environment, equipment, experience } = {}, library = EXERCISES) {
  const have = equipment ? availableEquipment(equipment) : null;
  return library.filter(e => e.active
    && (!area || e.targetAreas.includes(area))
    && (!category || e.category === category)
    && (!goal || e.suitableGoals.includes(goal))
    && (!environment || environment === 'any' || e.environment.includes(environment))
    && (!have || e.equipment.every(x => have.has(x)))
    && (!experience || LEVEL[e.difficulty] <= LEVEL[experience]));
}

/** Active alternatives that keep the exercise's intent, limited to what the member can do. */
export function alternativesFor(id, filters = {}, library = EXERCISES) {
  const e = library.find(x => x.id === id);
  if (!e) return [];
  const usable = new Set(listExercises({ ...filters, area: undefined, category: undefined, goal: undefined }, library).map(x => x.id));
  return e.alternatives.map(a => library.find(x => x.id === a)).filter(a => a && usable.has(a.id));
}

/** An exercise in the member's language, falling back to English. */
export function localizedExercise(e, lang = 'en') {
  const t = e.i18n?.[lang];
  return t ? { ...e, name: t.name ?? e.name, description: t.description ?? e.description, instructions: t.instructions ?? e.instructions } : e;
}
