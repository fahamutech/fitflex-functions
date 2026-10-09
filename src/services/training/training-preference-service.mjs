// Training Plans — a member's training preferences.
//
// Stored on the member profile (memberProfile.trainingPreferences) beside
// the fitness goals and level they gave at onboarding. Nothing is required:
// whatever the member hasn't said is filled from their profile and sensible
// defaults, so a plan can always be made.
import {
  DAYS_PER_WEEK, DEFAULT_FITNESS_GOAL, ENVIRONMENTS, EQUIPMENT, EXPERIENCE_LEVELS, FITNESS_GOALS,
  FITNESS_GOAL_IDS, MAX_TARGET_AREAS, SESSION_MINUTES, TARGET_AREAS, TRAINING_STYLES,
} from '../../shared/training-taxonomy.mjs';

const FIELDS = ['goal', 'targetAreas', 'experience', 'environment', 'equipment', 'sessionMinutes', 'daysPerWeek', 'style'];

const oneOf = (allowed, error) => v => (allowed.includes(v) ? null : error);
const listOf = (allowed, max, error) => v =>
  (Array.isArray(v) && v.length <= max && v.every(x => allowed.includes(x)) && new Set(v).size === v.length ? null : error);

const CHECKS = {
  goal: oneOf(FITNESS_GOAL_IDS, 'invalid_goal'),
  targetAreas: listOf(TARGET_AREAS, MAX_TARGET_AREAS, 'invalid_target_areas'),
  experience: oneOf(EXPERIENCE_LEVELS, 'invalid_experience'),
  environment: oneOf(ENVIRONMENTS, 'invalid_environment'),
  equipment: listOf(EQUIPMENT, EQUIPMENT.length, 'invalid_equipment'),
  sessionMinutes: oneOf(SESSION_MINUTES, 'invalid_session_minutes'),
  daysPerWeek: oneOf(DAYS_PER_WEEK, 'invalid_days_per_week'),
  style: oneOf(TRAINING_STYLES, 'invalid_style'),
};

/**
 * Validates the preferences a member sent. Only the fields present are
 * checked; null clears one. Returns { patch } or { error, status }.
 */
export function validateTrainingPreferences(body = {}) {
  const patch = {};
  for (const field of FIELDS) {
    if (body[field] === undefined) continue;
    if (body[field] === null) { patch[field] = null; continue; }
    const error = CHECKS[field](body[field]);
    if (error) return { error, status: 400 };
    patch[field] = body[field];
  }
  return { patch };
}

/**
 * The preferences a plan is built from: what the member chose, then their
 * profile (onboarding goal and level), then defaults.
 */
export function effectiveTrainingPreferences(profile = {}, stored = profile?.trainingPreferences) {
  const saved = stored ?? {};
  const profileGoal = [...(profile?.fitnessGoals ?? []), profile?.fitnessGoal].find(g => FITNESS_GOAL_IDS.includes(g));
  const goal = saved.goal ?? profileGoal ?? DEFAULT_FITNESS_GOAL;
  const goalDef = FITNESS_GOALS.find(g => g.id === goal);
  const environment = saved.environment ?? 'any';
  return {
    goal,
    targetAreas: saved.targetAreas?.length ? saved.targetAreas : goalDef.areas,
    experience: saved.experience ?? (EXPERIENCE_LEVELS.includes(profile?.fitnessLevel) ? profile.fitnessLevel : 'beginner'),
    environment,
    // Someone who trains at a gym and hasn't said otherwise has its equipment.
    equipment: saved.equipment?.length ? saved.equipment : [environment === 'gym' ? 'full_gym' : 'none'],
    sessionMinutes: saved.sessionMinutes ?? 30,
    daysPerWeek: saved.daysPerWeek ?? 3,
    style: saved.style ?? goalDef.style,
  };
}

export function createTrainingPreferenceService({ users, now = () => new Date() }) {
  const view = profile => ({
    // What the member chose (null where they haven't) and what a plan would use.
    preferences: Object.fromEntries(FIELDS.map(f => [f, profile?.trainingPreferences?.[f] ?? null])),
    effective: effectiveTrainingPreferences(profile),
    updatedAt: profile?.trainingPreferences?.updatedAt ?? null,
  });

  async function get(memberId) {
    const user = await users.findByIdAsync(memberId);
    if (!user) return { error: 'not_found', status: 404 };
    return view(user.memberProfile);
  }

  async function update(memberId, body = {}) {
    const v = validateTrainingPreferences(body);
    if (v.error) return v;
    const user = await users.findByIdAsync(memberId);
    if (!user) return { error: 'not_found', status: 404 };
    const memberProfile = {
      ...(user.memberProfile || {}),
      trainingPreferences: { ...(user.memberProfile?.trainingPreferences || {}), ...v.patch, updatedAt: now().toISOString() },
    };
    await users.updateByIdAsync(memberId, { memberProfile, updatedAt: now().toISOString() });
    return view(memberProfile);
  }

  return { get, update };
}
