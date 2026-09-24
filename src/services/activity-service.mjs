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
export const DEVICE_PLATFORMS = ['phone_sensor', 'apple_health', 'health_connect', 'fitbit', 'garmin', 'other'];
// Platforms the member's phone may sync itself. Fitbit / Garmin arrive
// server to server, never from the app.
const APP_SYNC_PLATFORMS = new Set(['phone_sensor', 'health_connect', 'apple_health']);
const MAX_SYNC_RECORDS = 62;
// How far back a sync may reach (the phone keeps about a month).
const MAX_SYNC_AGE_DAYS = 35;
// One day's steps from a phone or health platform.
const MAX_DAILY_DEVICE_STEPS = 100_000;
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

  /**
   * Device sync: the member's phone reports readings it took from a sensor
   * or health platform, as a batch keyed by (devicePlatform, externalId).
   * Daily step totals only grow during a day, so an existing record keeps
   * the higher count — a reinstall or a late reading never lowers it.
   * Nothing is estimated here: no reading, no record.
   */
  async function syncDevice(memberId, body = {}) {
    const records = body.records;
    if (!Array.isArray(records) || !records.length || records.length > MAX_SYNC_RECORDS) {
      return { error: 'invalid_records', status: 400 };
    }
    const clean = [];
    for (const r of records) {
      if (!r || typeof r !== 'object') return { error: 'invalid_records', status: 400 };
      if (!APP_SYNC_PLATFORMS.has(r.devicePlatform)) return { error: 'invalid_device_platform', status: 400 };
      const externalId = typeof r.externalId === 'string' ? r.externalId.trim().slice(0, 120) : '';
      if (!externalId) return { error: 'invalid_external_id', status: 400 };
      if (r.type !== 'walking') return { error: 'invalid_type', status: 400 };
      const startedAt = parseDate(r.startedAt);
      if (!startedAt) return { error: 'invalid_started_at', status: 400 };
      if (+startedAt > +now() + FUTURE_SLACK_MS) return { error: 'started_in_future', status: 400 };
      if (+now() - +startedAt > MAX_SYNC_AGE_DAYS * DAY_MS) return { error: 'too_old', status: 400 };
      const steps = r.steps;
      if (!Number.isInteger(steps) || steps < 0 || steps > MAX_DAILY_DEVICE_STEPS) return { error: 'invalid_steps', status: 400 };
      const deviceName = typeof r.deviceName === 'string' ? r.deviceName.trim().slice(0, 60) || null : null;
      clean.push({ devicePlatform: r.devicePlatform, externalId, startedAt: startedAt.toISOString(), steps, deviceName });
    }

    const mine = (await activities.filterByColumnAsync('userId', memberId)).filter(a => a.source === 'device');
    let created = 0, updated = 0, unchanged = 0;
    for (const r of clean) {
      const existing = mine.find(a => a.devicePlatform === r.devicePlatform && a.externalId === r.externalId);
      if (existing) {
        if (r.steps > (existing.steps ?? 0)) {
          await activities.updateByIdAsync(existing.id, { steps: r.steps, ...(r.deviceName && { deviceName: r.deviceName }) });
          updated += 1;
        } else unchanged += 1;
        continue;
      }
      const row = {
        id: `act_${randomUUID().slice(0, 12)}`,
        userId: memberId,
        type: 'walking',
        source: 'device',
        startedAt: r.startedAt,
        steps: r.steps,
        durationMinutes: null, distanceKm: null, activeMinutes: null, calories: null,
        intensity: null, workoutId: null, gymId: null, trainerId: null, notes: null,
        devicePlatform: r.devicePlatform,
        externalId: r.externalId,
        deviceName: r.deviceName,
        createdAt: now().toISOString(),
      };
      try {
        await activities.insertAsync(row);
        mine.push(row);
        created += 1;
      } catch (err) {
        // Unique (user, platform, externalId): a parallel sync saved it first.
        if (/unique|duplicate/i.test(err.message ?? '')) { unchanged += 1; continue; }
        throw err;
      }
    }
    return { created, updated, unchanged };
  }

  return { list, log, remove, syncDevice };
}
