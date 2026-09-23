// Trainer ↔ member connections, trainer workout plans and assignments.
//
// Consent rules:
// - Only a member starts a connection (from the trainer's profile); the
//   trainer accepts or declines. Either side can end it.
// - Every permission starts off. The member switches on exactly what the
//   trainer may see, and can change it at any time.
// - The trainer's client view is built here and contains only permitted
//   data — raw activity never leaves the server unless steps, distance or
//   active minutes is shared.
// - A trainer may assign workouts to an active client without any
//   permission, and always sees the workouts they assigned — but whether
//   they were done needs `workoutHistory`, and the logged sets need
//   `workoutDetails`.
import { randomUUID } from 'node:crypto';
import { validateWorkoutDefinition, newWorkoutRow, isWorkoutDate } from './workout-service.mjs';
import {
  dailyTotals, goalProgress, localDay, addDays, weekStart, isWorkout, activeMinutesOf,
  streaks as computeStreaks,
} from '../shared/member-progress.mjs';

export const PERMISSIONS = [
  'steps', 'distance', 'activeMinutes', 'workoutHistory',
  'workoutDetails', 'goals', 'streaks', 'challenges',
];
const OPEN = new Set(['pending', 'active']);
const MAX_OPEN_PER_MEMBER = 5;
const MAX_PLANS_PER_TRAINER = 100;
const MAX_ASSIGN_DATES = 12;
const ACTIVITY_DAYS = 14;
const HISTORY_DAYS = 91;
// A client with no workout for this many days is flagged for a check-in.
const INACTIVE_DAYS = 5;
const LOOKAHEAD_DAYS = 7;

const id = (prefix) => `${prefix}_${randomUUID().slice(0, 12)}`;

/** Known permission keys only, each a boolean; anything missing is off. */
export function normalizePermissions(input, base = {}) {
  const out = {};
  for (const key of PERMISSIONS) {
    const v = input && Object.prototype.hasOwnProperty.call(input, key) ? input[key] : base[key];
    out[key] = v === true;
  }
  // Details without the history they belong to would be meaningless.
  if (!out.workoutHistory) out.workoutDetails = false;
  return out;
}

export function createTrainerClientService({
  relationships, trainers, users, workouts, workoutPlans, activities, goals,
  notify = async () => {}, now = () => new Date(),
}) {
  const stamp = () => now().toISOString();

  async function trainerFor(userId) {
    return trainers.findAsync(t => t.userId === userId);
  }

  function trainerCard(t) {
    return t ? { id: t.id, displayName: t.displayName ?? null, photoUrl: t.photoUrl ?? null, specialties: t.specialties ?? [] } : null;
  }

  async function memberCard(memberId) {
    const u = await users.findByIdAsync(memberId);
    return u ? { id: u.id, displayName: u.displayName ?? null, photoUrl: u.photoUrl ?? null } : null;
  }

  async function safeNotify(userId, message) {
    try { await notify(userId, message); } catch { /* best effort */ }
  }

  // ── Member side ───────────────────────────────────────────────────────────

  async function memberConnections(memberId) {
    const rows = (await relationships.filterByColumnAsync('memberId', memberId))
      .filter(r => r.status !== 'ended')
      .sort((a, b) => +new Date(b.requestedAt) - +new Date(a.requestedAt));
    const out = [];
    for (const r of rows) {
      out.push({ ...r, trainer: trainerCard(await trainers.findByIdAsync(r.trainerId)) });
    }
    return { connections: out };
  }

  async function request(memberId, trainerId, body = {}) {
    const trainer = await trainers.findByIdAsync(trainerId);
    if (!trainer || trainer.status === 'inactive') return { error: 'trainer_not_found', status: 404 };
    const mine = await relationships.filterByColumnAsync('memberId', memberId);
    const existing = mine.find(r => r.trainerId === trainerId && OPEN.has(r.status));
    if (existing) {
      return { error: existing.status === 'active' ? 'already_connected' : 'already_requested', status: 409 };
    }
    if (mine.filter(r => OPEN.has(r.status)).length >= MAX_OPEN_PER_MEMBER) {
      return { error: 'too_many_connections', status: 400 };
    }
    const t = stamp();
    const row = {
      id: id('tmr'),
      trainerId,
      memberId,
      status: 'pending',
      permissions: normalizePermissions(body.permissions),
      requestedAt: t,
      connectedAt: null,
      endedAt: null,
      endedBy: null,
      createdAt: t,
      updatedAt: t,
    };
    await relationships.insertAsync(row);
    const member = await memberCard(memberId);
    if (trainer.userId) {
      await safeNotify(trainer.userId, {
        type: 'trainer_client_request',
        title: 'New client request',
        body: `${member?.displayName || 'A member'} would like to train with you.`,
        data: { relationshipId: row.id },
      });
    }
    return { connection: { ...row, trainer: trainerCard(trainer) } };
  }

  async function ownConnection(memberId, relId) {
    const r = await relationships.findByIdAsync(relId);
    return r && r.memberId === memberId ? r : null;
  }

  async function updatePermissions(memberId, relId, body = {}) {
    const r = await ownConnection(memberId, relId);
    if (!r) return { error: 'not_found', status: 404 };
    if (!OPEN.has(r.status)) return { error: 'not_open', status: 409 };
    if (!body.permissions || typeof body.permissions !== 'object') return { error: 'invalid_permissions', status: 400 };
    const patch = { permissions: normalizePermissions(body.permissions, r.permissions), updatedAt: stamp() };
    await relationships.updateByIdAsync(relId, patch);
    return { connection: { ...r, ...patch } };
  }

  async function memberEnd(memberId, relId) {
    const r = await ownConnection(memberId, relId);
    if (!r) return { error: 'not_found', status: 404 };
    if (!OPEN.has(r.status)) return { error: 'not_open', status: 409 };
    const patch = { status: 'ended', endedAt: stamp(), endedBy: 'member', updatedAt: stamp() };
    await relationships.updateByIdAsync(relId, patch);
    return { connection: { ...r, ...patch } };
  }

  // ── Trainer side ──────────────────────────────────────────────────────────

  /** The trainer's connection by id, or an error result. */
  async function trainerConnection(trainerUserId, relId, { requireActive = true } = {}) {
    const trainer = await trainerFor(trainerUserId);
    if (!trainer) return { error: 'trainer_profile_not_found', status: 404 };
    const r = await relationships.findByIdAsync(relId);
    if (!r || r.trainerId !== trainer.id) return { error: 'not_found', status: 404 };
    if (requireActive && r.status !== 'active') return { error: 'not_active', status: 409 };
    return { trainer, relationship: r };
  }

  async function clients(trainerUserId) {
    const trainer = await trainerFor(trainerUserId);
    if (!trainer) return { error: 'trainer_profile_not_found', status: 404 };
    const rows = (await relationships.filterByColumnAsync('trainerId', trainer.id))
      .filter(r => OPEN.has(r.status));
    const out = [];
    for (const r of rows) {
      const row = { ...r, member: await memberCard(r.memberId) };
      if (r.status === 'active') row.summary = await summarize(trainer, r);
      out.push(row);
    }
    // Requests first, then clients who need a check-in, then the rest.
    const rank = c => (c.status === 'pending' ? -1000 : -(c.summary?.attention.filter(a => a.kind === 'attention').length ?? 0));
    out.sort((a, b) => rank(a) - rank(b) || +new Date(b.requestedAt) - +new Date(a.requestedAt));
    return { clients: out };
  }

  /**
   * A short "this week" summary for the trainer's client list, built only
   * from what the member shares, plus prompts the trainer can act on.
   * Sections the member doesn't share are simply absent.
   */
  async function summarize(trainer, r) {
    const perms = normalizePermissions(r.permissions);
    const today = localDay(now());
    const monday = weekStart(today);
    const needsActivity = perms.steps || perms.distance || perms.activeMinutes
      || perms.workoutHistory || perms.goals || perms.streaks;
    const acts = needsActivity
      ? (await activities.filterByColumnAsync('userId', r.memberId))
          .filter(a => localDay(a.startedAt) > addDays(today, -HISTORY_DAYS))
      : [];
    const thisWeek = acts.filter(a => localDay(a.startedAt) >= monday);

    const week = {
      ...(perms.workoutHistory && { workouts: thisWeek.filter(isWorkout).length }),
      ...(perms.steps && { steps: thisWeek.reduce((n, a) => n + (a.steps ?? 0), 0) }),
      ...(perms.distance && { distanceKm: Math.round(thisWeek.reduce((n, a) => n + (a.distanceKm ?? 0), 0) * 10) / 10 }),
      ...(perms.activeMinutes && { activeMinutes: thisWeek.reduce((n, a) => n + activeMinutesOf(a), 0) }),
    };
    const summary = { weekStart: monday, week, attention: [] };

    let memberGoals = [];
    if (perms.goals || perms.streaks) {
      memberGoals = (await goals.filterByColumnAsync('userId', r.memberId)).filter(g => g.status === 'active');
    }
    if (perms.goals && memberGoals.length) {
      // The weekly workout goal says the most at a glance; fall back to the
      // first active goal.
      const g = memberGoals.find(x => x.type === 'workouts' && x.period === 'week') ?? memberGoals[0];
      summary.goal = { type: g.type, period: g.period, ...goalProgress(g, acts, now()) };
      if (summary.goal.completed) summary.attention.push({ kind: 'positive', code: 'goal_met' });
    }
    if (perms.streaks) {
      const s = computeStreaks(acts, memberGoals, now(), HISTORY_DAYS).activity;
      summary.streak = { current: s.current, best: s.best };
      if (s.endedLength) summary.attention.push({ kind: 'attention', code: 'streak_ended', value: s.endedLength });
    }

    const assigned = (await workouts.filterByColumnAsync('userId', r.memberId))
      .filter(w => w.trainerId === trainer.id);
    const upcoming = assigned.filter(w => w.scheduledDate >= today && w.scheduledDate < addDays(today, LOOKAHEAD_DAYS))
      // Without history the trainer can't know if they were done early, so
      // every future assignment counts as planned.
      .filter(w => !perms.workoutHistory || w.status === 'planned' || w.status === 'in_progress');
    summary.plannedNext7Days = upcoming.length;
    if (!upcoming.length) summary.attention.push({ kind: 'attention', code: 'nothing_planned' });

    if (perms.workoutHistory) {
      const missed = assigned.filter(w => w.scheduledDate < today && w.scheduledDate >= addDays(today, -7)
        && (w.status === 'planned' || w.status === 'in_progress'));
      if (missed.length) summary.attention.push({ kind: 'attention', code: 'missed_workouts', value: missed.length });
      const last = acts.filter(isWorkout).map(a => localDay(a.startedAt)).sort().at(-1) ?? null;
      summary.lastWorkoutDate = last;
      const idle = last ? Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / 86_400_000) : null;
      if (idle === null || idle >= INACTIVE_DAYS) summary.attention.push({ kind: 'attention', code: 'inactive', value: idle });
    }
    return summary;
  }

  async function decide(trainerUserId, relId, accept) {
    const res = await trainerConnection(trainerUserId, relId, { requireActive: false });
    if (res.error) return res;
    const { trainer, relationship: r } = res;
    if (r.status !== 'pending') return { error: 'not_pending', status: 409 };
    const patch = accept
      ? { status: 'active', connectedAt: stamp(), updatedAt: stamp() }
      : { status: 'declined', updatedAt: stamp() };
    await relationships.updateByIdAsync(relId, patch);
    await safeNotify(r.memberId, accept
      ? { type: 'trainer_connected', title: 'Trainer connected', body: `${trainer.displayName || 'Your trainer'} accepted your request.`, data: { relationshipId: r.id } }
      : { type: 'trainer_declined', title: 'Trainer request', body: `${trainer.displayName || 'The trainer'} isn't taking new clients right now.`, data: { relationshipId: r.id } });
    return { client: { ...r, ...patch, member: await memberCard(r.memberId) } };
  }

  async function trainerEnd(trainerUserId, relId) {
    const res = await trainerConnection(trainerUserId, relId);
    if (res.error) return res;
    const patch = { status: 'ended', endedAt: stamp(), endedBy: 'trainer', updatedAt: stamp() };
    await relationships.updateByIdAsync(relId, patch);
    return { client: { ...res.relationship, ...patch } };
  }

  function workoutSummary(w, trainerId, perms) {
    const assignedByYou = w.trainerId === trainerId;
    const base = { id: w.id, name: w.name, scheduledDate: w.scheduledDate, assignedByYou, source: w.source };
    if (!perms.workoutHistory) return base;
    const sets = (w.exercises ?? []).flatMap(e => e.workoutSets ?? []);
    const out = {
      ...base,
      status: w.status,
      completedAt: w.completedAt ?? null,
      durationMinutes: w.startedAt && w.completedAt
        ? Math.max(1, Math.round((+new Date(w.completedAt) - +new Date(w.startedAt)) / 60000)) : null,
      setsCompleted: sets.filter(s => s.completed).length,
      setsTotal: sets.length,
    };
    if (perms.workoutDetails) {
      out.exercises = w.exercises;
      out.notes = w.notes ?? null;
    }
    return out;
  }

  /** Everything the member lets this trainer see, and nothing else. */
  async function overview(trainerUserId, relId) {
    const res = await trainerConnection(trainerUserId, relId);
    if (res.error) return res;
    const { trainer, relationship: r } = res;
    const perms = normalizePermissions(r.permissions);
    const out = {
      client: { ...r, permissions: perms, member: await memberCard(r.memberId) },
      summary: await summarize(trainer, r),
    };

    const today = localDay(now());
    const needsActivity = perms.steps || perms.distance || perms.activeMinutes || perms.goals || perms.streaks;
    const acts = needsActivity
      ? (await activities.filterByColumnAsync('userId', r.memberId))
          .filter(a => localDay(a.startedAt) > addDays(today, -HISTORY_DAYS))
      : [];

    if (perms.steps || perms.distance || perms.activeMinutes) {
      const totals = dailyTotals(acts);
      const pick = (t) => ({
        ...(perms.steps && { steps: t?.steps ?? 0 }),
        ...(perms.distance && { distanceKm: Math.round((t?.distanceKm ?? 0) * 100) / 100 }),
        ...(perms.activeMinutes && { activeMinutes: t?.activeMinutes ?? 0 }),
      });
      const days = [];
      for (let n = ACTIVITY_DAYS - 1; n >= 0; n -= 1) {
        const d = addDays(today, -n);
        days.push({ date: d, ...pick(totals.get(d)) });
      }
      out.activity = { days };
    }

    const memberWorkouts = await workouts.filterByColumnAsync('userId', r.memberId);
    const visible = memberWorkouts
      .filter(w => perms.workoutHistory || w.trainerId === trainer.id)
      .filter(w => w.scheduledDate > addDays(today, -HISTORY_DAYS))
      .sort((a, b) => b.scheduledDate.localeCompare(a.scheduledDate));
    out.workouts = visible.map(w => workoutSummary(w, trainer.id, perms));

    const memberGoals = perms.goals || perms.streaks
      ? (await goals.filterByColumnAsync('userId', r.memberId)).filter(g => g.status === 'active')
      : [];
    if (perms.goals) {
      out.goals = memberGoals.map(g => ({
        id: g.id, type: g.type, period: g.period, target: g.target, source: g.source,
        ...goalProgress(g, acts, now()),
      }));
    }
    if (perms.streaks) out.streaks = computeStreaks(acts, memberGoals, now(), HISTORY_DAYS);
    if (perms.challenges) out.challenges = { available: false };
    return out;
  }

  // ── Plans ─────────────────────────────────────────────────────────────────

  async function listPlans(trainerUserId) {
    const trainer = await trainerFor(trainerUserId);
    if (!trainer) return { error: 'trainer_profile_not_found', status: 404 };
    const rows = (await workoutPlans.filterByColumnAsync('trainerId', trainer.id))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { plans: rows };
  }

  async function savePlan(trainerUserId, planId, body = {}) {
    const trainer = await trainerFor(trainerUserId);
    if (!trainer) return { error: 'trainer_profile_not_found', status: 404 };
    const def = validateWorkoutDefinition(body);
    if (def.error) return def;
    if (planId) {
      const existing = await workoutPlans.findByIdAsync(planId);
      if (!existing || existing.trainerId !== trainer.id) return { error: 'not_found', status: 404 };
      const patch = { ...def.definition, updatedAt: stamp() };
      await workoutPlans.updateByIdAsync(planId, patch);
      return { plan: { ...existing, ...patch } };
    }
    const mine = await workoutPlans.filterByColumnAsync('trainerId', trainer.id);
    if (mine.length >= MAX_PLANS_PER_TRAINER) return { error: 'too_many_plans', status: 400 };
    const row = { id: id('wpl'), trainerId: trainer.id, ...def.definition, createdAt: stamp(), updatedAt: stamp() };
    await workoutPlans.insertAsync(row);
    return { plan: row };
  }

  async function deletePlan(trainerUserId, planId) {
    const trainer = await trainerFor(trainerUserId);
    if (!trainer) return { error: 'trainer_profile_not_found', status: 404 };
    const existing = await workoutPlans.findByIdAsync(planId);
    if (!existing || existing.trainerId !== trainer.id) return { error: 'not_found', status: 404 };
    // Workouts already assigned from it are copies and stay as they are.
    await workoutPlans.removeByIdAsync(planId);
    return { deleted: true };
  }

  // ── Assignments ───────────────────────────────────────────────────────────

  /**
   * Assign a workout to an active client on one or more dates, from a saved
   * plan ({ planId }) or defined inline ({ name, exercises, ... }).
   */
  async function assign(trainerUserId, relId, body = {}) {
    const res = await trainerConnection(trainerUserId, relId);
    if (res.error) return res;
    const { trainer, relationship: r } = res;
    const dates = Array.isArray(body.dates) ? [...new Set(body.dates)] : [];
    if (!dates.length || dates.length > MAX_ASSIGN_DATES || !dates.every(isWorkoutDate)) {
      return { error: 'invalid_dates', status: 400 };
    }
    if (dates.some(d => d < addDays(localDay(now()), -1))) return { error: 'date_in_past', status: 400 };
    let base;
    if (body.planId) {
      const plan = await workoutPlans.findByIdAsync(body.planId);
      if (!plan || plan.trainerId !== trainer.id) return { error: 'plan_not_found', status: 404 };
      base = { ...plan, id: null };
    } else {
      const def = validateWorkoutDefinition(body);
      if (def.error) return def;
      base = { id: null, ...def.definition };
    }
    const created = [];
    for (const date of dates.sort()) {
      const row = newWorkoutRow({
        memberId: r.memberId, base, scheduledDate: date, trainerId: trainer.id, source: 'trainer', now: now(),
      });
      await workouts.insertAsync(row);
      created.push(row);
    }
    await safeNotify(r.memberId, {
      type: 'trainer_workout_assigned',
      title: 'New workout from your trainer',
      body: `${trainer.displayName || 'Your trainer'} planned "${base.name}" for you${dates.length > 1 ? ` on ${dates.length} days` : ''}.`,
      data: { workoutIds: created.map(w => w.id) },
    });
    return { workouts: created.map(w => workoutSummary(w, trainer.id, normalizePermissions(r.permissions))) };
  }

  /** Remove a workout the trainer assigned that the member hasn't started. */
  async function cancelAssignment(trainerUserId, workoutId) {
    const trainer = await trainerFor(trainerUserId);
    if (!trainer) return { error: 'trainer_profile_not_found', status: 404 };
    const w = await workouts.findByIdAsync(workoutId);
    if (!w || w.trainerId !== trainer.id) return { error: 'not_found', status: 404 };
    if (w.status !== 'planned') return { error: 'already_started', status: 409 };
    await workouts.removeByIdAsync(workoutId);
    return { deleted: true };
  }

  return {
    memberConnections, request, updatePermissions, memberEnd,
    clients, accept: (u, id) => decide(u, id, true), decline: (u, id) => decide(u, id, false),
    trainerEnd, overview, listPlans, savePlan, deletePlan, assign, cancelAssignment,
  };
}
