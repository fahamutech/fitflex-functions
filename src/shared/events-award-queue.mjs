// Marathon & running events · S6 — the award work queue (spec §4.1.9, §7.2). A request handler only ENQUEUES; the job
// event-awards-run is the only writer of awards. A burst of corrections for one registration coalesces into one open task
// (partial unique eventawardtask_open_unique), so enqueueing twice is harmless.
import { randomUUID } from 'node:crypto';

export const TASK_REASONS = Object.freeze(['release', 'result_changed', 'claim', 'registration_cancelled', 'event_cancelled', 'template_added', 'definition_changed']);

/** Enqueue one task (registrationId null = the whole event; the runner fans it out). Returns true when a new open task was created. */
export async function enqueueAwardTask(q, { eventId, registrationId = null, reason, releaseId = null, at = new Date() }) {
  if (!TASK_REASONS.includes(reason)) throw new Error(`enqueueAwardTask: unknown reason ${reason}`);
  const res = await q.raw(
    `INSERT INTO "EventAwardTask" (id, "eventId", "registrationId", "releaseId", reason, state, "runAfter", "createdAt")
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
     ON CONFLICT ("eventId", COALESCE("registrationId", ''), reason) WHERE state IN ('pending', 'running') DO NOTHING`,
    [`eat_${randomUUID().replace(/-/g, '').slice(0, 16)}`, eventId, registrationId, releaseId, reason, at, at],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Many registrations at once (one statement); ids already queued are skipped. */
export async function enqueueAwardTasks(q, { eventId, registrationIds, reason, at = new Date() }) {
  const ids = [...new Set(registrationIds)];
  if (!ids.length) return 0;
  let n = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const values = chunk.map(() => '(?, ?, ?, NULL, ?, \'pending\', ?, ?)').join(', ');
    const params = chunk.flatMap(id => [`eat_${randomUUID().replace(/-/g, '').slice(0, 16)}`, eventId, id, reason, at, at]);
    const res = await q.raw(`INSERT INTO "EventAwardTask" (id, "eventId", "registrationId", "releaseId", reason, state, "runAfter", "createdAt") VALUES ${values}
      ON CONFLICT ("eventId", COALESCE("registrationId", ''), reason) WHERE state IN ('pending', 'running') DO NOTHING`, params);
    n += res.rowCount ?? 0;
  }
  return n;
}
