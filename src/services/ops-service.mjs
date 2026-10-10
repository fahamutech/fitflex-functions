// Operations (B2B Phase 7): running recurring work reliably, and keeping a
// record of what went wrong for a person to deal with.
//
// The scheduler (bfast, in-process) only fires a function at a time of day.
// It does not know whether the run happened, whether two servers both fired,
// or whether the server was down at that minute. This service adds that:
//
//   slot        every scheduled run belongs to a slot (the scheduled instant).
//               A slot succeeds once. Whoever asks again is told "already ran".
//   lock        one run of a job at a time, across servers (a Postgres
//               advisory lock held for the length of the run)
//   run record  JobRun: started, finished, status, attempt, what triggered
//               it, items processed / succeeded / failed, the error
//   catch-up    a sweeper notices a slot that was missed or failed and runs
//               it again: at most three attempts, further apart each time
//   pause       an operator can stop a job running until they resume it
//   exception   OpsException: a failed job, an item a job could not handle,
//               a record that does not add up. The same problem seen again
//               is the same exception. It clears itself when the problem
//               goes away, or a person resolves or ignores it with a reason.
//
// The jobs themselves are in b2b-jobs.mjs and call the domain services; no
// business rule lives here. Every job must be safe to run twice: this layer
// reduces repeats, the domain services' own constraints prevent their harm.
import { randomUUID } from 'node:crypto';

const RUN = 'JobRun';
const CONTROL = 'JobControl';
const EXCEPTION = 'OpsException';
export const EXCEPTION_STATUSES = Object.freeze(['open', 'investigating', 'retrying', 'resolved', 'ignored', 'permanently_failed']);
/** Statuses that still need someone. */
export const LIVE_STATUSES = Object.freeze(['open', 'investigating', 'retrying', 'permanently_failed']);
export const SEVERITIES = Object.freeze(['low', 'medium', 'high']);
/** A scheduled slot is tried this many times before it is left for a person. */
export const MAX_ATTEMPTS = 3;
/** A person may ask for an exception to be retried this many times. */
export const MAX_MANUAL_RETRIES = 5;
/** Minutes to wait before attempt 2, 3, ... of a failed slot. */
export const backoffMinutes = failures => 5 * 3 ** Math.max(0, failures - 1);       // 5, 15, 45
const GRACE_MS = 2 * 60_000;            // give the scheduler its own chance before catching up

const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const newId = prefix => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const text = (v, max = 1000) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const pad = n => String(n).padStart(2, '0');

/**
 * The scheduled instant a moment belongs to, as a slot name, and that instant.
 *   { type: 'daily', utc: '21:20' }   → "2026-10-07T21:20Z" (the latest 21:20 UTC not after `at`)
 *   { type: 'every', minutes: 5 }     → "2026-10-07T14:35Z"
 */
export function slotAt(schedule, at) {
  const t = new Date(at);
  if (schedule.type === 'every') {
    const ms = schedule.minutes * 60_000;
    const due = new Date(Math.floor(+t / ms) * ms);
    return { slot: `${due.toISOString().slice(0, 16)}Z`, due };
  }
  const [h, m] = schedule.utc.split(':').map(Number);
  const due = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), h, m));
  if (due > t) due.setUTCDate(due.getUTCDate() - 1);
  return { slot: `${due.toISOString().slice(0, 10)}T${pad(h)}:${pad(m)}Z`, due };
}

/** When the job is next due after `at`. */
export function nextDue(schedule, at) {
  const { due } = slotAt(schedule, at);
  return new Date(+due + (schedule.type === 'every' ? schedule.minutes * 60_000 : 86_400_000));
}

export function createOpsService({ db, now = () => new Date(), logger = console }) {
  const stamp = () => new Date(now());
  const jobs = new Map();
  const audit = ({ actor, action, target, before = null, after = null }) => db('AuditLog').insert({
    id: randomUUID(), at: stamp(), actor: actor ?? null, action, target,
    before: before == null ? null : JSON.stringify(before), after: after == null ? null : JSON.stringify(after),
  });

  /**
   * Make a job known. `run(ctx)` does the work and returns
   * { processed, succeeded, failed, ...anything worth keeping }.
   *   name, title, description
   *   schedule   { type: 'daily', utc: 'HH:MM' } | { type: 'every', minutes }
   *   domain     'finance' | 'operations' (a failed finance job is high severity)
   *   quiet      keep a run record only when the run did something or failed
   */
  function register(def) {
    if (!def?.name || typeof def.run !== 'function' || !def.schedule) throw new Error('a job needs a name, a schedule and run()');
    jobs.set(def.name, { domain: 'operations', quiet: false, catchUp: def.schedule.type === 'daily', ...def });
    return def.name;
  }

  // ── Exceptions ────────────────────────────────────────────────────────────

  const view = e => (e ? { ...e, detail: typeof e.detail === 'string' ? JSON.parse(e.detail) : e.detail ?? null } : null);

  /**
   * Record a problem. Seen again while still live, it is the same exception:
   * its count, last-seen time and detail are updated, nothing new is added.
   */
  async function raise({ type, severity = 'medium', title, dedupeKey, job = null, jobRunId = null, entityType = null, entityId = null, organizationId = null, detail = null }) {
    if (!SEVERITIES.includes(severity)) throw new Error(`unknown severity ${severity}`);
    const at = stamp();
    const row = {
      id: newId('opx'), type, severity, status: 'open', title: String(title).slice(0, 300), job, jobRunId, entityType, entityId, organizationId,
      detail: detail == null ? null : JSON.stringify(detail), dedupeKey, occurrences: 1, detectedAt: at, lastSeenAt: at, updatedAt: at,
    };
    const { rows } = await db.raw(`
      INSERT INTO "${EXCEPTION}" (${Object.keys(row).map(k => `"${k}"`).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})
      ON CONFLICT ("dedupeKey") WHERE "status" IN ('open', 'investigating', 'retrying', 'permanently_failed')
      DO UPDATE SET "occurrences" = "${EXCEPTION}"."occurrences" + 1, "lastSeenAt" = EXCLUDED."lastSeenAt", "updatedAt" = EXCLUDED."updatedAt",
        "detail" = EXCLUDED."detail", "title" = EXCLUDED."title", "jobRunId" = EXCLUDED."jobRunId", "severity" = EXCLUDED."severity",
        "status" = CASE WHEN "${EXCEPTION}"."status" = 'retrying' THEN 'open' ELSE "${EXCEPTION}"."status" END
      RETURNING *, (xmax = 0) AS "isNew"`, Object.values(row));
    const { isNew, ...saved } = rows[0];
    return { exception: view(saved), isNew };
  }

  /** The problem is gone: close whatever is live under this key. Returns how many were closed. */
  async function clear(dedupeKey, { by, resolution = 'The problem is no longer there.' } = {}) {
    const at = stamp();
    return db(EXCEPTION).where({ dedupeKey }).whereIn('status', LIVE_STATUSES)
      .update({ status: 'resolved', resolvedAt: at, resolvedBy: by ?? 'system', resolution, updatedAt: at });
  }

  async function listExceptions({ query = {} } = {}) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(query.cursor, 10) || 0, 0);
    const base = () => {
      let q = db(EXCEPTION);
      if (query.status === 'live' || !query.status) q = q.whereIn('status', LIVE_STATUSES);
      else if (query.status !== 'all') q = q.where({ status: String(query.status) });
      if (query.severity) q = q.where({ severity: String(query.severity) });
      if (query.type) q = q.where({ type: String(query.type) });
      if (query.job) q = q.where({ job: String(query.job) });
      if (query.organizationId) q = q.where({ organizationId: String(query.organizationId) });
      return q;
    };
    const [{ c }] = await base().count({ c: '*' });
    const rows = await base().orderByRaw(`CASE "severity" WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END`).orderBy('detectedAt').limit(limit).offset(offset);
    return { items: rows.map(view), total: Number(c), nextCursor: offset + limit < Number(c) ? offset + limit : null };
  }

  async function getException({ id }) {
    const row = await db(EXCEPTION).where({ id }).first();
    return row ? { exception: view(row) } : fail('exception_not_found', 404);
  }

  /**
   * An operator moves an exception on: investigating, resolved (say what was
   * done), ignored (say why), or back to open. Nothing about the underlying
   * records is changed here.
   */
  async function setExceptionStatus({ id, status, resolution, actorId }) {
    if (!actorId) return fail('actor_required', 403);
    if (!['open', 'investigating', 'resolved', 'ignored'].includes(status)) return fail('invalid_status', 400, { allowed: ['open', 'investigating', 'resolved', 'ignored'] });
    const why = text(resolution);
    if (['resolved', 'ignored'].includes(status) && !why) return fail('resolution_required', 400);
    return db.transaction(async (trx) => {
      const prior = await trx(EXCEPTION).where({ id }).forUpdate().first();
      if (!prior) return fail('exception_not_found', 404);
      if (prior.status === status) return { exception: view(prior), unchanged: true };
      const at = stamp();
      const closing = ['resolved', 'ignored'].includes(status);
      let row;
      try {
        [row] = await trx(EXCEPTION).where({ id }).update({
          status, updatedAt: at, resolvedAt: closing ? at : null, resolvedBy: closing ? actorId : null, resolution: closing ? why : null,
        }).returning('*');
      } catch (err) {
        if (err.code !== '23505') throw err;   // reopening while the same problem is already live again
        return fail('already_open_again', 409, { hint: 'The same problem has been raised again since; look at the live one.' });
      }
      await trx('AuditLog').insert({ id: randomUUID(), at, actor: actorId, action: `ops.exception.${status}`, target: id,
        before: JSON.stringify({ status: prior.status }), after: JSON.stringify({ status, resolution: why, type: prior.type, dedupeKey: prior.dedupeKey }) });
      return { exception: view(row) };
    });
  }

  /**
   * Try again what an exception came from, by running its job now. Jobs are
   * safe to repeat, so the retry does only what is still missing.
   */
  async function retryException({ id, actorId }) {
    if (!actorId) return fail('actor_required', 403);
    const prior = await db(EXCEPTION).where({ id }).first();
    if (!prior) return fail('exception_not_found', 404);
    if (!LIVE_STATUSES.includes(prior.status)) return fail('exception_closed', 409, { exceptionStatus: prior.status });
    if (!prior.job || !jobs.has(prior.job)) return fail('nothing_to_retry', 409, { hint: 'This exception did not come from a job. Fix the record, then resolve it.' });
    if (prior.retryCount >= MAX_MANUAL_RETRIES) return fail('retry_limit_reached', 409, { maxRetries: MAX_MANUAL_RETRIES });
    const at = stamp();
    await db(EXCEPTION).where({ id }).update({ status: 'retrying', retryCount: prior.retryCount + 1, lastAttemptAt: at, updatedAt: at });
    await audit({ actor: actorId, action: 'ops.exception.retry', target: id, after: { job: prior.job, retry: prior.retryCount + 1 } });
    const run = await runJob(prior.job, { trigger: 'manual', actorId });
    const after = await db(EXCEPTION).where({ id }).first();
    // Still there after the run: it goes back to open, to be looked at.
    if (after.status === 'retrying') await db(EXCEPTION).where({ id, status: 'retrying' }).update({ status: 'open', updatedAt: stamp() });
    return { run, exception: view(await db(EXCEPTION).where({ id }).first()) };
  }

  // ── Running a job ─────────────────────────────────────────────────────────

  const isPaused = async name => (await db(CONTROL).where({ job: name }).first())?.paused === true;
  const lockKey = name => `fitflex:job:${name}`;

  /**
   * Run a job once.
   *   trigger   'schedule' (the scheduler), 'catch_up' / 'retry' (the sweeper), 'manual' (an operator)
   * A scheduled slot that already succeeded is not run again; a manual run
   * always runs. Never throws: the outcome is the return value and the record.
   */
  async function runJob(name, { trigger = 'schedule', actorId = null } = {}) {
    const def = jobs.get(name);
    if (!def) return fail('unknown_job', 404);
    const manual = trigger === 'manual';
    if (manual && !actorId) return fail('actor_required', 403);
    if (!manual && await isPaused(name)) return { job: name, skipped: 'paused' };
    const { slot } = slotAt(def.schedule, now());
    const done = () => db(RUN).where({ job: name, slot, status: 'ok' }).first('id');
    if (!manual && await done()) return { job: name, slot, skipped: 'already_ran' };

    try {
      return await db.transaction(async (lock) => {
        const { rows: [{ ok }] } = await lock.raw('select pg_try_advisory_xact_lock(hashtext(?)) as ok', [lockKey(name)]);
        if (!ok) return { job: name, slot, skipped: 'running_elsewhere' };
        if (!manual && await done()) return { job: name, slot, skipped: 'already_ran' };       // finished while we waited for the lock
        // We hold the lock, so nothing is running: a record still saying so belongs to a server that stopped.
        await db(RUN).where({ job: name, status: 'running' }).whereNotNull('trigger')
          .update({ status: 'failed', finishedAt: stamp(), error: 'Interrupted: the server stopped during this run.' });

        const [{ c }] = await db(RUN).where({ job: name, slot }).count({ c: '*' });
        const runId = newId('run');
        const startedAt = stamp();
        // A manual run that comes before the slot's own run is that slot's run: there is nothing left to catch up.
        const takesSlot = !manual || !(await done());
        const record = { id: runId, job: name, status: 'running', startedAt, slot: takesSlot ? slot : null, trigger, triggeredBy: actorId ?? `system:${name}`, attempt: takesSlot ? Number(c) + 1 : 1 };
        if (!def.quiet) await db(RUN).insert(record);
        if (manual) await audit({ actor: actorId, action: 'ops.job.run', target: name, after: { runId } });

        const items = { failed: 0 };
        const ctx = {
          runId, slot, trigger, job: name, actor: `system:${name}`,
          /** An item the job could not handle. It becomes an exception; the job carries on. */
          itemFailed: async ({ entityType, entityId, key = '', organizationId = null, title, error, severity = def.domain === 'finance' ? 'high' : 'medium', detail = {} }) => {
            items.failed += 1;
            logger.warn?.(`[job:${name}] ${entityType} ${entityId} ${key}: ${error?.message ?? error}`);
            return raise({ type: 'job_item_failed', severity, title, job: name, jobRunId: runId, entityType, entityId, organizationId,
              dedupeKey: `item:${name}:${entityType}:${entityId}:${key}`, detail: { ...detail, error: String(error?.message ?? error).slice(0, 500) } });
          },
          /** The item went through: anything raised for it earlier is cleared. */
          itemOk: ({ entityType, entityId, key = '' }) => clear(`item:${name}:${entityType}:${entityId}:${key}`, { by: `system:${name}`, resolution: `Went through on run ${runId}.` }),
          raise: e => raise({ job: name, jobRunId: runId, ...e }),
          clear: (key, resolution) => clear(key, { by: `system:${name}`, resolution }),
        };

        let stats;
        try {
          stats = (await def.run(ctx)) ?? {};
        } catch (err) {
          const error = String(err?.message ?? err).slice(0, 500);
          const finished = { status: 'failed', finishedAt: stamp(), error, failed: items.failed };
          if (def.quiet) await db(RUN).insert({ ...record, ...finished });
          else await db(RUN).where({ id: runId }).update(finished);
          logger.error?.(`[job:${name}] run ${runId} failed: ${error}`);
          await raise({ type: 'job_failed', severity: def.domain === 'finance' ? 'high' : 'medium', title: `${def.title} did not finish`, job: name, jobRunId: runId,
            entityType: 'job', entityId: name, dedupeKey: `job_failed:${name}`, detail: { error, slot, attempt: record.attempt, trigger } });
          return { job: name, slot, runId, status: 'failed', error, attempt: record.attempt };
        }
        const failed = Number(stats.failed ?? 0) + (stats.failed === undefined ? items.failed : 0);
        const processed = Number(stats.processed ?? 0);
        const finished = {
          status: 'ok', finishedAt: stamp(), processed, failed, succeeded: Number(stats.succeeded ?? Math.max(0, processed - failed)),
          stats: JSON.stringify(stats),
        };
        if (!def.quiet) await db(RUN).where({ id: runId }).update(finished);
        else if (processed > 0 || failed > 0) await db(RUN).insert({ ...record, ...finished });
        await clear(`job_failed:${name}`, { by: `system:${name}`, resolution: `Finished on run ${runId}.` });
        return { job: name, slot, runId, status: 'ok', attempt: record.attempt, processed, succeeded: finished.succeeded, failed, stats };
      });
    } catch (err) {
      // The record itself could not be written (the database is away, or another server finished the slot first).
      if (err.code === '23505') return { job: name, slot, skipped: 'already_ran' };
      logger.error?.(`[job:${name}] could not run: ${err.message}`);
      return { job: name, slot, status: 'failed', error: String(err.message).slice(0, 500) };
    }
  }

  /**
   * Catch up: every daily job whose current slot has no successful run gets
   * another go, until it has been tried MAX_ATTEMPTS times; after that its
   * exception is marked as given up on, for a person. Run every few minutes.
   */
  async function sweep() {
    const at = stamp();
    const out = { checked: 0, ran: [], waiting: [], gaveUp: [] };
    for (const def of jobs.values()) {
      if (!def.catchUp) continue;
      out.checked += 1;
      const { slot, due } = slotAt(def.schedule, at);
      if (+at - +due < GRACE_MS) continue;
      if (await isPaused(def.name)) continue;
      if (await db(RUN).where({ job: def.name, slot, status: 'ok' }).first('id')) continue;
      if (await db(RUN).where({ job: def.name, status: 'running' }).where('startedAt', '>', new Date(+at - 30 * 60_000)).first('id')) continue;
      const failures = await db(RUN).where({ job: def.name, slot, status: 'failed' }).orderBy('finishedAt', 'desc');
      if (failures.length >= MAX_ATTEMPTS) {
        const changed = await db(EXCEPTION).where({ dedupeKey: `job_failed:${def.name}` }).whereIn('status', ['open', 'retrying'])
          .update({ status: 'permanently_failed', updatedAt: at });
        if (changed) out.gaveUp.push(def.name);
        continue;
      }
      if (failures.length && +at - +new Date(failures[0].finishedAt) < backoffMinutes(failures.length) * 60_000) { out.waiting.push(def.name); continue; }
      const run = await runJob(def.name, { trigger: failures.length ? 'retry' : 'catch_up' });
      out.ran.push({ job: def.name, status: run.status ?? run.skipped });
    }
    return out;
  }

  // ── Looking and controlling ───────────────────────────────────────────────

  /** Every job: its schedule, whether its current slot is done, its last run, and whether it is paused. */
  async function jobStatus() {
    const at = stamp();
    const names = [...jobs.keys()];
    const controls = new Map((names.length ? await db(CONTROL).whereIn('job', names) : []).map(c => [c.job, c]));
    const out = [];
    for (const def of jobs.values()) {
      const { slot, due } = slotAt(def.schedule, at);
      const [last] = await db(RUN).where({ job: def.name }).orderBy('startedAt', 'desc').limit(1);
      const lastOk = await db(RUN).where({ job: def.name, status: 'ok' }).orderBy('startedAt', 'desc').first('startedAt', 'finishedAt');
      const slotOk = def.quiet ? null : !!(await db(RUN).where({ job: def.name, slot, status: 'ok' }).first('id'));
      const failures = Number((await db(RUN).where({ job: def.name, slot, status: 'failed' }).count({ c: '*' }))[0].c);
      const control = controls.get(def.name);
      const paused = control?.paused === true;
      const state = paused ? 'paused'
        : last?.status === 'running' ? 'running'
          : slotOk === false && failures >= MAX_ATTEMPTS ? 'failed'
            : slotOk === false && failures > 0 ? 'retrying'
              : slotOk === false && +at - +due > 15 * 60_000 ? 'delayed'
                : last?.status === 'failed' && def.quiet ? 'failed' : 'ok';
      out.push({
        name: def.name, title: def.title, description: def.description ?? null, domain: def.domain, schedule: def.schedule, state,
        paused, pauseReason: paused ? control.reason : null, currentSlot: slot, currentSlotDue: due, currentSlotDone: slotOk, attemptsThisSlot: failures + (slotOk ? 1 : 0),
        nextDue: nextDue(def.schedule, at), lastSuccessAt: lastOk?.finishedAt ?? null,
        lastRun: last ? { id: last.id, status: last.status, trigger: last.trigger, startedAt: last.startedAt, finishedAt: last.finishedAt, processed: last.processed, succeeded: last.succeeded, failed: last.failed, error: last.error } : null,
      });
    }
    return out;
  }

  async function jobRuns({ name, query = {} }) {
    if (!jobs.has(name)) return fail('unknown_job', 404);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 30, 1), 200);
    const rows = await db(RUN).where({ job: name }).orderBy('startedAt', 'desc').limit(limit);
    return { job: name, items: rows };
  }

  async function setPaused({ name, paused, reason, actorId }) {
    if (!actorId) return fail('actor_required', 403);
    if (!jobs.has(name)) return fail('unknown_job', 404);
    const why = text(reason, 500);
    if (paused && !why) return fail('reason_required', 400);
    const at = stamp();
    const row = { job: name, paused, reason: paused ? why : null, changedBy: actorId, changedAt: at };
    await db(CONTROL).insert(row).onConflict('job').merge(row);
    await audit({ actor: actorId, action: paused ? 'ops.job.pause' : 'ops.job.resume', target: name, after: { reason: why } });
    return { job: name, paused, reason: row.reason };
  }

  async function exceptionCounts() {
    const rows = await db(EXCEPTION).whereIn('status', LIVE_STATUSES).groupBy('severity', 'status').select('severity', 'status').count({ c: '*' }).min({ oldest: 'detectedAt' });
    const live = rows.reduce((t, r) => t + Number(r.c), 0);
    const by = key => Object.fromEntries([...new Set(rows.map(r => r[key]))].map(v => [v, rows.filter(r => r[key] === v).reduce((t, r) => t + Number(r.c), 0)]));
    const oldest = rows.map(r => r.oldest).filter(Boolean).sort((a, b) => +new Date(a) - +new Date(b))[0] ?? null;
    return { live, bySeverity: by('severity'), byStatus: by('status'), oldestDetectedAt: oldest };
  }

  return {
    register, jobNames: () => [...jobs.keys()], runJob, sweep, jobStatus, jobRuns, setPaused,
    raise, clear, listExceptions, getException, setExceptionStatus, retryException, exceptionCounts,
  };
}
