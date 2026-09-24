// Activity & Progress Engine — member fitness activities (walks, runs,
// workouts). Separate from check-ins: a gym visit never becomes an activity
// on its own.
import { randomUUID } from 'node:crypto';

export const ACTIVITY_TYPES = [
  'walking', 'running', 'jogging', 'cycling', 'hiking', 'swimming', 'sports',
  'strength', 'hiit', 'functional', 'group_class', 'personal_training',
  'mobility', 'stretching', 'other',
];
export const ACTIVITY_SOURCES = ['device', 'fitflex', 'manual', 'trainer', 'gym'];
export const DEVICE_PLATFORMS = ['apple_health', 'health_connect', 'fitbit', 'garmin', 'other'];
// Records the member owns and may delete. Trainer- and gym-sourced
// activities belong to that relationship.
const MEMBER_SOURCES = new Set(['device', 'fitflex', 'manual']);
// What the member can create by hand. Device data only ever arrives through
// a device sync (with its platform and record id) and FitFlex data only from
// FitFlex itself (e.g. completing a workout), so neither can be typed in:
// FitFlex never shows fabricated numbers as device or tracked data.
const LOGGABLE_SOURCES = new Set(['manual']);
const INTENSITIES = ['low', 'moderate', 'high'];

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 90;
const MAX_WINDOW_DAYS = 366;
// Clock skew allowance for "not in the future".
const FUTURE_SLACK_MS = 5 * 60 * 1000;

// Plausibility caps — reject obvious typos rather than silently storing them.
const LIMITS = {
  durationMinutes: 24 * 60,
  activeMinutes: 24 * 60,
  distanceKm: 500,
  steps: 200_000,
  calories: 20_000,
};
const INTEGER_FIELDS = new Set(['durationMinutes', 'activeMinutes', 'steps', 'calories']);

function parseDate(value) {
  if (typeof value !== 'string' || !value) return null;
  const d = new Date(value);
  return Number.isNaN(+d) ? null : d;
}

export function createActivityService({ activities, now = () => new Date() }) {
  async function list(memberId, { from, to } = {}) {
    const end = parseDate(to) || new Date(+now() + DAY_MS);
    const start = parseDate(from) || new Date(+end - DEFAULT_WINDOW_DAYS * DAY_MS);
    if (start > end) return { error: 'invalid_range', status: 400 };
    if (+end - +start > MAX_WINDOW_DAYS * DAY_MS) return { error: 'range_too_long', status: 400 };
    const rows = await activities.filterByColumnAsync('userId', memberId);
    const items = rows
      .filter(a => { const t = new Date(a.startedAt); return t >= start && t < end; })
      .sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt));
    return { activities: items };
  }

  async function log(memberId, body = {}) {
    if (!ACTIVITY_TYPES.includes(body.type)) return { error: 'invalid_type', status: 400 };
    const source = body.source ?? 'manual';
    if (!ACTIVITY_SOURCES.includes(source)) return { error: 'invalid_source', status: 400 };
    if (!LOGGABLE_SOURCES.has(source)) return { error: 'source_not_loggable', status: 400 };
    const startedAt = parseDate(body.startedAt);
    if (!startedAt) return { error: 'invalid_started_at', status: 400 };
    if (+startedAt > +now() + FUTURE_SLACK_MS) return { error: 'started_in_future', status: 400 };
    if (body.intensity != null && !INTENSITIES.includes(body.intensity)) {
      return { error: 'invalid_intensity', status: 400 };
    }

    const metrics = {};
    for (const [field, max] of Object.entries(LIMITS)) {
      const v = body[field];
      if (v == null) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max) {
        return { error: `invalid_${field}`, status: 400 };
      }
      metrics[field] = INTEGER_FIELDS.has(field) ? Math.round(v) : v;
    }
    if (!Object.keys(metrics).length) return { error: 'no_metrics', status: 400 };

    const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 500) : null;
    const row = {
      id: `act_${randomUUID().slice(0, 12)}`,
      userId: memberId,
      type: body.type,
      source,
      startedAt: startedAt.toISOString(),
      ...metrics,
      intensity: body.intensity ?? null,
      // Workout activities are recorded by completing the workout.
      workoutId: null,
      gymId: typeof body.gymId === 'string' ? body.gymId : null,
      trainerId: null,
      notes: notes || null,
      createdAt: now().toISOString(),
    };
    await activities.insertAsync(row);
    return { activity: row };
  }

  async function remove(memberId, id) {
    const row = await activities.findByIdAsync(id);
    if (!row || row.userId !== memberId) return { error: 'not_found', status: 404 };
    // Trainer/gym records belong to that relationship, not to the member's log.
    if (!MEMBER_SOURCES.has(row.source)) return { error: 'not_member_owned', status: 403 };
    // A completed workout's activity is its record; removing it would
    // orphan the workout.
    if (row.workoutId) return { error: 'linked_to_workout', status: 409 };
    await activities.removeByIdAsync(id);
    return { deleted: true };
  }

  return { list, log, remove };
}
