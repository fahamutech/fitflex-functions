// Training Plans — the fixed vocabulary shared by preferences, the exercise
// library and the recommendation engine. Ids are wire values; the apps hold
// the words (English and Swahili) for each.

/**
 * What the member wants to achieve. These are the fitness goals members
 * already choose at onboarding and on their profile — not a second list.
 * `style` is the kind of training the goal leans on; `areas` is where a
 * plan focuses when the member hasn't chosen target areas.
 */
export const FITNESS_GOALS = [
  { id: 'lose_weight', style: 'mixed', areas: ['full_body', 'cardio'] },
  { id: 'gain_muscle', style: 'strength', areas: ['full_body'] },
  { id: 'build_muscle', style: 'strength', areas: ['full_body'] },
  { id: 'stay_fit', style: 'mixed', areas: ['full_body'] },
  { id: 'improve_endurance', style: 'cardio', areas: ['cardio', 'full_body'] },
  { id: 'improve_flexibility', style: 'mobility', areas: ['mobility'] },
  { id: 'learn_new_skill', style: 'functional', areas: ['full_body'] },
  { id: 'stress_relief', style: 'mobility', areas: ['mobility', 'full_body'] },
];
export const FITNESS_GOAL_IDS = FITNESS_GOALS.map(g => g.id);
export const DEFAULT_FITNESS_GOAL = 'stay_fit';

/** Where training is focused. A focus for programming, never a judgement of how anyone looks. */
export const TARGET_AREA_GROUPS = [
  { id: 'upper_body', areas: ['chest', 'back', 'shoulders', 'biceps', 'triceps'] },
  { id: 'lower_body', areas: ['glutes', 'quadriceps', 'hamstrings', 'calves'] },
  { id: 'core', areas: ['abs', 'obliques', 'lower_back'] },
  { id: 'general', areas: ['full_body', 'mobility', 'cardio'] },
];
export const TARGET_AREAS = TARGET_AREA_GROUPS.flatMap(g => g.areas);
export const MAX_TARGET_AREAS = 6;

export const EXPERIENCE_LEVELS = ['beginner', 'intermediate', 'advanced'];
export const ENVIRONMENTS = ['gym', 'home', 'outdoor', 'any'];
export const TRAINING_STYLES = ['strength', 'cardio', 'hiit', 'functional', 'mobility', 'mixed'];
export const SESSION_MINUTES = [15, 30, 45, 60, 75];
export const DAYS_PER_WEEK = [2, 3, 4, 5, 6];

/** What the member can train with. `none` is bodyweight only. */
export const EQUIPMENT = ['none', 'dumbbells', 'resistance_bands', 'free_weights', 'machines', 'full_gym', 'other'];

// Having one thing means having these too: a full gym has everything, and
// free weights include dumbbells. Bodyweight is always available.
const EQUIPMENT_INCLUDES = {
  full_gym: ['machines', 'free_weights', 'dumbbells', 'resistance_bands'],
  free_weights: ['dumbbells'],
};

/** Everything a member can use, given what they said they have. */
export function availableEquipment(chosen = []) {
  const out = new Set(['none']);
  for (const item of chosen) {
    if (!EQUIPMENT.includes(item)) continue;
    out.add(item);
    for (const extra of EQUIPMENT_INCLUDES[item] ?? []) out.add(extra);
  }
  return out;
}

// Exercise library vocabulary.
export const EXERCISE_CATEGORIES = ['strength', 'cardio', 'hiit', 'functional', 'mobility', 'stretching'];
export const MOVEMENT_PATTERNS = ['push', 'pull', 'squat', 'hinge', 'lunge', 'carry', 'rotation', 'core', 'locomotion', 'stretch'];
/** Environments an exercise can be done in (`any` is a preference, not a place). */
export const EXERCISE_ENVIRONMENTS = ENVIRONMENTS.filter(e => e !== 'any');

/** Who made a training plan. Trainers come later; the model is ready for them. */
export const PLAN_CREATORS = ['member', 'fitflex', 'trainer'];
export const PLAN_STATUSES = ['active', 'completed', 'cancelled'];

/** The vocabulary as the apps need it to draw the choices. */
export function trainingOptions() {
  return {
    goals: FITNESS_GOALS.map(g => ({ id: g.id, style: g.style })),
    targetAreaGroups: TARGET_AREA_GROUPS,
    maxTargetAreas: MAX_TARGET_AREAS,
    experienceLevels: EXPERIENCE_LEVELS,
    environments: ENVIRONMENTS,
    equipment: EQUIPMENT,
    sessionMinutes: SESSION_MINUTES,
    daysPerWeek: DAYS_PER_WEEK,
    styles: TRAINING_STYLES,
  };
}
