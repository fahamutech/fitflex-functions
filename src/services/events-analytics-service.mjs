// Marathon & running events · S7 — analytics counters, the launch dashboard and the alert rules
// (docs/design/events-s7-hardening-and-pilot.md §5, D77, D78).
//
//   track(name, props, { eventId, n })   one allowlisted counter increment; never throws, never blocks a request
//   ingest({ events })                   POST /events/analytics: a member's batch, shaped by the allowlist; the caller is NOT stored
//   rollup()                             reads the existing S3 to S6 `analytics.%` AuditLog rows once (cursor) into counters
//   purge()                              deletes counters older than EVENTS_ANALYTICS_KEEP_DAYS
//   health({ days, eventId, scopes })    GET /admin/events/health: tables first, counters only for client funnel steps and S7 events
//   runAlerts()                          evaluates the A1 to A13 rules and emails OPS_ALERT_EMAILS (one email per rule+subject per 6 hours)
//
// Privacy (spec §5.2): a counter is (day, name, eventId | none, closed dimensions) -> count. No user, registration, order, session or
// device id, no IP, no free text. Unknown names and keys are dropped; values outside a closed set become 'other'.
import { randomUUID } from 'node:crypto';
import { shapeEvent, dimsKeyOf, darDay, counterFromAudit, APP_EVENT_NAMES, ANALYTICS_EVENTS } from '../shared/events-analytics-rules.mjs';

const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const num = v => Number(v) || 0;
const iso = v => (v ? new Date(v).toISOString() : null);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_BATCH = 20;
const MAX_PROPS = 8;
const ROLLUP_BATCH = 2000;
// Rows younger than this are left for the next run: a row is stamped with its `at` before it commits, so a row just behind the cursor could
// otherwise be missed for ever. After the lag every row with a smaller (at, id) has committed.
const ROLLUP_LAG_SECONDS = 120;
const ALERT_REPEAT_MS = 6 * HOUR;

/** The event jobs the Health tab and alert A5 watch: name -> the flag that must be on for the job to be expected to run. */
export const EVENT_JOB_NAMES = Object.freeze([
  'event-hold-expiry', 'event-lifecycle', 'event-payment-reconciliation', 'event-webhook-fanout', 'event-webhook-deliver', 'event-webhook-retention',
  'event-awards-run', 'event-awards-reconcile', 'event-reward-expire', 'event-waitlist-promote', 'event-waitlist-purge', 'event-kit-offline-purge',
  'event-analytics-rollup', 'event-health-alert', 'event-organizer-status-sweep', 'event-registration-anonymise',
]);

export function createEventsAnalyticsService({
  db, now = () => new Date(), enabled = () => true,
  // { configured, send(to, { subject, text }) }
  emailSender = () => ({ configured: false }),
  recipients = () => String(process.env.OPS_ALERT_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean),
  keepDays = () => 730,
  // The event job states (opsService.jobStatus) and the flag each job needs, and the S7 settings the Setup card shows.
  jobStatus = async () => [],
  jobFlags = {},
  setup = () => ({ flags: {}, retentionConfigured: false, consentTextVersion: null }),
  manualConfirmHours = () => 24, refundTargetDays = () => 5,
  alertRules = () => ({}),
  expectedEnabled = () => true,
}) {
  const stamp = () => new Date(now());
  const newId = () => `ead_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

  // ── Counters ──────────────────────────────────────────────────────────────

  async function upsertCounter(q, { day, name, eventId, dims, n }) {
    const dimsKey = dimsKeyOf(dims);
    await q.raw(
      `INSERT INTO "EventAnalyticsDaily" (id, day, name, "eventId", "dimsKey", dims, count, "updatedAt")
       VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?)
       ON CONFLICT (day, name, COALESCE("eventId", ''), "dimsKey")
       DO UPDATE SET count = "EventAnalyticsDaily".count + EXCLUDED.count, "updatedAt" = EXCLUDED."updatedAt"`,
      [newId(), day, name, eventId ?? null, dimsKey, JSON.stringify(dims), n, stamp()],
    );
  }

  /** One server-side increment. Best effort: nothing here may affect a request. */
  async function track(name, props = {}, { eventId = null, n = 1 } = {}) {
    try {
      if (!enabled()) return false;
      const shaped = shapeEvent({ name, eventId: eventId ?? props?.eventId ?? null, props, n }, { from: 'server' });
      if (!shaped) return false;
      await upsertCounter(db, { day: darDay(stamp()), ...shaped });
      return true;
    } catch { return false; }
  }

  /** A member's batch from the app. The caller (userId) is used by the route for rate limiting and is not stored here. */
  async function ingest({ events }) {
    if (!Array.isArray(events)) return fail('invalid_batch', 400);
    if (events.length > MAX_BATCH) return fail('too_many_events', 413, { max: MAX_BATCH });
    let accepted = 0; let dropped = 0;
    const shapedAll = [];
    for (const ev of events) {
      const props = ev?.props;
      if (props && typeof props === 'object' && Object.keys(props).length > MAX_PROPS) { dropped += 1; continue; }
      const shaped = shapeEvent({ name: ev?.name, props }, { from: 'app' });
      if (!shaped) { dropped += 1; continue; }
      shapedAll.push(shaped);
    }
    // Only real, publicly visible events get a counter: random ids from a hostile client never create rows.
    const ids = [...new Set(shapedAll.map(s => s.eventId).filter(Boolean))];
    const known = new Set(ids.length ? (await db('Event').whereIn('id', ids).whereIn('status', ['published', 'registration_closed', 'in_progress', 'completed', 'cancelled']).select('id')).map(r => r.id) : []);
    const day = darDay(stamp());
    for (const s of shapedAll) {
      if (s.eventId && !known.has(s.eventId)) {
        // A name that REQUIRES an event is dropped; one that only accepts it (cancel screens) is counted without it.
        if (ANALYTICS_EVENTS[s.name]?.event) { dropped += 1; continue; }
        s.eventId = null;
      }
      try { await upsertCounter(db, { day, ...s }); accepted += 1; } catch { dropped += 1; }
    }
    return { status: 202, accepted, dropped };
  }

  // ── Roll-up of the existing audit rows ─────────────────────────────────────

  /**
   * Reads `analytics.%` AuditLog rows after the cursor (at, id), sums them into counters and moves the cursor in ONE transaction,
   * so a crash or a rerun counts every row exactly once. Rows with nothing to count still advance the cursor.
   */
  async function rollup({ batch = ROLLUP_BATCH, maxBatches = 20, lagSeconds = ROLLUP_LAG_SECONDS } = {}) {
    let rows = 0; let counted = 0; let batches = 0;
    for (; batches < maxBatches; batches += 1) {
      const done = await db.transaction(async (trx) => {
        await trx.raw(`INSERT INTO "AnalyticsRollupCursor" (name) VALUES ('auditlog') ON CONFLICT (name) DO NOTHING`);
        const cursor = await trx('AnalyticsRollupCursor').where({ name: 'auditlog' }).forUpdate().first();
        let q = trx('AuditLog').where('action', 'like', 'analytics.%').where('at', '<=', new Date(+stamp() - lagSeconds * 1000)).orderBy([{ column: 'at' }, { column: 'id' }]).limit(batch).select('id', 'at', 'action', 'after');
        if (cursor.lastAt) q = q.whereRaw('("at", id) > (?, ?)', [cursor.lastAt, cursor.lastId ?? '']);
        const page = await q;
        if (!page.length) { await trx('AnalyticsRollupCursor').where({ name: 'auditlog' }).update({ rolledUpAt: stamp() }); return true; }
        const sums = new Map();
        for (const row of page) {
          const c = counterFromAudit(row.action, row.after);
          if (!c) continue;
          const day = darDay(row.at);
          const key = `${day}|${c.name}|${c.eventId ?? ''}|${dimsKeyOf(c.dims)}`;
          const cur = sums.get(key) ?? { day, ...c, n: 0 };
          cur.n += c.n;
          sums.set(key, cur);
        }
        for (const s of sums.values()) await upsertCounter(trx, s);
        const last = page[page.length - 1];
        await trx('AnalyticsRollupCursor').where({ name: 'auditlog' }).update({ lastAt: last.at, lastId: last.id, rolledUpAt: stamp() });
        rows += page.length; counted += [...sums.values()].reduce((t, s) => t + s.n, 0);
        return page.length < batch;
      });
      if (done) break;
    }
    return { rows, counted, batches: batches + 1 };
  }

  async function purge() {
    const cutoff = darDay(new Date(+stamp() - keepDays() * DAY));
    const deleted = await db('EventAnalyticsDaily').where('day', '<', cutoff).del();
    return { deleted };
  }

  // ── Health (spec §5.5) ─────────────────────────────────────────────────────

  async function counts(names, { days, eventId }) {
    const since = darDay(new Date(+stamp() - (days - 1) * DAY));
    const rows = await db('EventAnalyticsDaily').whereIn('name', names).where('day', '>=', since).modify(q => { if (eventId) q.where({ eventId }); })
      .groupBy('name').select('name').sum({ n: 'count' });
    const out = Object.fromEntries(names.map(n => [n, 0]));
    for (const r of rows) out[r.name] = num(r.n);
    return out;
  }

  const safe = async (fn) => { try { return await fn(); } catch { return { error: 'unavailable' }; } };
  const oldestAge = (at, ref) => (at ? Math.max(0, Math.floor((+ref - +new Date(at)) / HOUR)) : null);

  async function health({ days = 1, eventId = null, scopes = [] } = {}) {
    if (![1, 7, 30].includes(Number(days))) return fail('invalid_days', 400);
    const d = Number(days);
    const at = stamp();
    const since = new Date(+at - d * DAY);
    const mayPayments = scopes.includes('payments') || scopes.includes('*');
    if (eventId) {
      const e = await db('Event').where({ id: String(eventId) }).first('id');
      if (!e) return fail('event_not_found', 404);
    }
    const byEvent = (q, col = 'eventId') => { if (eventId) q.where({ [col]: eventId }); return q; };

    const funnel = await safe(async () => {
      const names = ['event_list_viewed', 'event_detail_viewed', 'registration_started', 'order_created', 'payment_confirmed'];
      const c = await counts(names, { days: d, eventId });
      return names.map((name, i) => ({ name, count: c[name], ratioToPrevious: i > 0 && c[names[i - 1]] > 0 ? Math.round((c[name] / c[names[i - 1]]) * 1000) / 1000 : null }));
    });
    const payments = mayPayments ? await safe(async () => {
      const waiting = await byEvent(db('EventPayment').where({ method: 'manual', status: 'pending' })).whereNotNull('submittedAt').min({ oldest: 'submittedAt' }).count({ n: '*' }).first();
      const rejected = await byEvent(db('EventPayment').where({ status: 'failed' }).whereNotNull('rejectCode').where('updatedAt', '>=', since)).count({ n: '*' }).first();
      const late = await byEvent(db('EventPayment').where({ lateOrder: true }).whereIn('status', ['pending', 'reconciliation_required'])).count({ n: '*' }).first();
      const recon = await byEvent(db('EventPayment').where({ status: 'reconciliation_required' })).count({ n: '*' }).min({ oldest: 'updatedAt' }).first();
      return {
        manualWaiting: { count: num(waiting.n), oldestAgeHours: oldestAge(waiting.oldest, at), targetHours: manualConfirmHours() },
        rejected: num(rejected.n), lateCases: num(late.n), reconciliationRequired: { count: num(recon.n), oldestAgeHours: oldestAge(recon.oldest, at) },
      };
    }) : undefined;
    const refunds = await safe(async () => {
      const open = await byEvent(db('Refund').where({ kind: 'event_order' }).whereIn('status', ['requested', 'approved'])).count({ n: '*' }).min({ oldest: 'createdAt' }).first();
      const stuck = await byEvent(db('Refund').where({ kind: 'event_order' }).whereNotNull('batchId').whereIn('status', ['requested', 'approved']).where('createdAt', '<', new Date(+at - DAY))).count({ n: '*' }).first();
      return { requestedNotPaid: { count: num(open.n), oldestAgeDays: open.oldest ? Math.floor((+at - +new Date(open.oldest)) / DAY) : null, targetDays: refundTargetDays() }, batchesStuck: num(stuck.n) };
    });
    const webhooks = await safe(async () => {
      const pending = await db('WebhookDelivery').where({ status: 'pending' }).count({ n: '*' }).min({ oldest: 'createdAt' }).first();
      const failed24 = await db('WebhookDelivery').where({ status: 'failed' }).where('lastAttemptAt', '>=', new Date(+at - DAY)).count({ n: '*' }).first();
      const dead = await db('WebhookDelivery').where({ status: 'dead' }).where('updatedAt', '>=', since).count({ n: '*' }).first();
      const disabled = await db('WebhookEndpoint').where({ status: 'disabled' }).whereNotNull('disabledReason').where('disabledAt', '>=', since).count({ n: '*' }).first();
      const byClass = await db('EventAnalyticsDaily').where({ name: 'webhook_delivery_failed' }).where('day', '>=', darDay(new Date(+at - DAY))).select('dims').sum({ n: 'count' }).groupBy('dims');
      return {
        pending: num(pending.n), oldestPendingAgeMinutes: pending.oldest ? Math.floor((+at - +new Date(pending.oldest)) / 60_000) : null,
        failedLast24h: num(failed24.n), failedByClass: byClass.map(r => ({ class: r.dims?.class ?? 'other', count: num(r.n) })), gaveUp: num(dead.n), endpointsAutoDisabled: num(disabled.n),
      };
    });
    const kit = await safe(async () => {
      const confirmed = await byEvent(db('EventRegistration').where({ status: 'confirmed' })).count({ n: '*' }).first();
      const collected = await byEvent(db('EventRegistration').where({ status: 'confirmed', kitStatus: 'collected' })).count({ n: '*' }).first();
      const exceptions = await byEvent(db('EventRegistration').where({ status: 'confirmed', kitStatus: 'exception' })).count({ n: '*' }).first();
      const desks = await byEvent(db('EventKitOfflineDevice').where({ status: 'active' })).count({ n: '*' }).sum({ pending: 'pendingReported' }).first().catch(() => ({ n: 0, pending: 0 }));
      const toCheck = await byEvent(db('EventKitOfflineScan').where({ reviewStatus: 'needs_review' })).count({ n: '*' }).first().catch(() => ({ n: 0 }));
      return { confirmed: num(confirmed.n), collected: num(collected.n), exceptions: num(exceptions.n), offlineDesksActive: num(desks.n), unsentScansReported: num(desks.pending), scansToCheck: num(toCheck.n) };
    });
    const results = await safe(async () => {
      const waiting = await db('EventResult').where({ isCurrent: true, verificationStatus: 'pending_verification' }).count({ n: '*' }).min({ oldest: 'createdAt' }).first();
      const disputes = await db('EventResultDispute').where({ status: 'open' }).count({ n: '*' }).min({ oldest: 'createdAt' }).first();
      const releases = await db('EventResultRelease').where('createdAt', '>=', since).count({ n: '*' }).first().catch(() => ({ n: 0 }));
      return {
        waitingForVerification: { count: num(waiting.n), oldestAgeHours: oldestAge(waiting.oldest, at) },
        openDisputes: { count: num(disputes.n), oldestAgeDays: disputes.oldest ? Math.floor((+at - +new Date(disputes.oldest)) / DAY) : null }, releasesInPeriod: num(releases.n),
      };
    });
    const rewards = await safe(async () => {
      const failed = await db('EventAwardTask').where({ state: 'failed' }).count({ n: '*' }).first();
      const old = await db('EventAwardTask').whereIn('state', ['pending', 'running']).min({ oldest: 'createdAt' }).first();
      const waiting = await db('RewardRedemption').where({ status: 'reserved' }).count({ n: '*' }).first();
      const dup = await counts(['reward_duplicate_blocked'], { days: d, eventId });
      return { awardTasksFailed: num(failed.n), oldestAwardTaskAgeMinutes: old.oldest ? Math.floor((+at - +new Date(old.oldest)) / 60_000) : null, redemptionsWaiting: num(waiting.n), duplicatePreventionIncidents: dup.reward_duplicate_blocked };
    });
    const waitlist = await safe(async () => {
      const status = await byEvent(db('EventWaitlistEntry')).groupBy('status').select('status').count({ n: '*' });
      const by = Object.fromEntries(status.map(s => [s.status, num(s.n)]));
      const run = await db('JobRun').where({ job: 'event-waitlist-promote' }).orderBy('startedAt', 'desc').first('startedAt', 'status');
      return { waiting: by.waiting ?? 0, offersOpen: by.offered ?? 0, converted: by.converted ?? 0, expired: by.expired ?? 0, promoterLastRunAt: iso(run?.startedAt), promoterLastStatus: run?.status ?? null };
    });
    const jobs = await safe(async () => {
      const all = (await jobStatus()).filter(j => EVENT_JOB_NAMES.includes(j.name));
      return all.map(j => {
        const cadenceMin = j.schedule?.type === 'every' ? j.schedule.minutes : 1440;
        const flagOn = jobFlags[j.name] ? Boolean(jobFlags[j.name]()) : true;
        const late = flagOn && (!j.lastSuccessAt || +at - +new Date(j.lastSuccessAt) > 3 * cadenceMin * 60_000);
        return { name: j.name, schedule: j.schedule, lastRunAt: iso(j.lastRun?.startedAt), outcome: j.lastRun?.status ?? null, lastSuccessAt: iso(j.lastSuccessAt), flagOn, late };
      });
    });
    const errors = await safe(async () => {
      const rows = await db('EventAnalyticsDaily').where({ name: 'api_error' }).where('day', '>=', darDay(since)).groupBy('dims').select('dims').sum({ n: 'count' });
      return rows.map(r => ({ group: r.dims?.group ?? 'other', class: r.dims?.class ?? 'other', count: num(r.n) }));
    });
    const cursor = await db('AnalyticsRollupCursor').where({ name: 'auditlog' }).first('rolledUpAt');
    const alerts = await safe(() => evaluateAlerts());
    const s = setup();
    return {
      generatedAt: at.toISOString(), rolledUpAt: iso(cursor?.rolledUpAt), periodDays: d, eventId: eventId ?? null,
      setup: { ...s, alertsConfigured: recipients().length > 0 },
      funnel, ...(payments ? { payments } : {}), refunds, webhooks, kit, results, rewards, waitlist, jobs, errors, alerts,
    };
  }

  // ── Alerts (spec §5.6, D78) ─────────────────────────────────────────────────

  const rule = (id, key, dflt) => {
    const v = Number(alertRules()?.[id]?.[key]);
    return Number.isFinite(v) && v > 0 ? v : dflt;
  };

  /**
   * The rules that fire now: [{ rule, subject, severity, runbook, counts }]. Ids and counts only; no names or contact data.
   * `subject` names the thing (an event id, a job name, a group) so one email goes out per (rule, subject) per 6 hours.
   */
  async function evaluateAlerts() {
    const at = stamp();
    const out = [];
    const push = (ruleId, subject, severity, runbook, counts) => out.push({ rule: ruleId, subject: String(subject), severity, runbook, counts });
    // One rule failing (a table the deploy has not created yet, a bad override) must not hide the others.
    const attempt = async fn => { try { await fn(); } catch (err) { console.warn('[events] alert rule skipped:', err?.message); } };
    await attempt(async () => {

      const a1h = rule('A1', 'hours', manualConfirmHours());
      const a1 = await db('EventPayment').where({ method: 'manual', status: 'pending' }).whereNotNull('submittedAt').where('submittedAt', '<', new Date(+at - a1h * HOUR)).groupBy('eventId').select('eventId').count({ n: '*' });
      for (const r of a1) push('A1', r.eventId ?? 'none', 'high', 'R6', { waiting: num(r.n), thresholdHours: a1h });
    });
    await attempt(async () => {
      const a2d = rule('A2', 'days', refundTargetDays());
      const a2 = await db('Refund').where({ kind: 'event_order' }).whereIn('status', ['requested', 'approved']).where('createdAt', '<', new Date(+at - a2d * DAY * 7 / 5)).groupBy('eventId').select('eventId').count({ n: '*' });
      for (const r of a2) push('A2', r.eventId ?? 'none', 'high', 'R7', { overdue: num(r.n), targetWorkingDays: a2d });
    });
    await attempt(async () => {
      const a3 = await db('EventPayment').where({ status: 'reconciliation_required' }).where('updatedAt', '<', new Date(+at - rule('A3', 'hours', 2) * HOUR)).groupBy('eventId').select('eventId').count({ n: '*' });
      for (const r of a3) push('A3', r.eventId ?? 'none', 'high', 'R6', { count: num(r.n) });
    });
    await attempt(async () => {
      const a4old = await db('WebhookDelivery').where({ status: 'pending' }).where('createdAt', '<', new Date(+at - rule('A4', 'minutes', 30) * 60_000)).count({ n: '*' }).first();
      const a4dis = await db('WebhookEndpoint').where({ status: 'disabled' }).whereNotNull('disabledReason').where('disabledAt', '>=', new Date(+at - 6 * HOUR)).count({ n: '*' }).first();
      const a4dead = await db('WebhookDelivery').where({ status: 'dead' }).where('updatedAt', '>=', new Date(+at - HOUR)).count({ n: '*' }).first();
      if (num(a4old.n) || num(a4dis.n) || num(a4dead.n)) push('A4', 'webhooks', 'medium', 'R4', { pendingOld: num(a4old.n), endpointsDisabled: num(a4dis.n), gaveUpLastHour: num(a4dead.n) });
    });
    await attempt(async () => {
      for (const j of await jobStatus()) {
        if (!EVENT_JOB_NAMES.includes(j.name)) continue;
        if (jobFlags[j.name] && !jobFlags[j.name]()) continue;
        const cadenceMin = j.schedule?.type === 'every' ? j.schedule.minutes : 1440;
        if (j.paused) continue;
        if (!j.lastSuccessAt || +at - +new Date(j.lastSuccessAt) > 3 * cadenceMin * 60_000) push('A5', j.name, 'high', 'R1', { cadenceMinutes: cadenceMin, lastSuccessAt: iso(j.lastSuccessAt) });
      }
    });
    await attempt(async () => {
      const a6f = await db('EventAwardTask').where({ state: 'failed' }).count({ n: '*' }).first();
      const a6o = await db('EventAwardTask').whereIn('state', ['pending', 'running']).where('createdAt', '<', new Date(+at - rule('A6', 'minutes', 15) * 60_000)).count({ n: '*' }).first();
      if (num(a6f.n) || num(a6o.n)) push('A6', 'awards', 'medium', 'R9', { failed: num(a6f.n), old: num(a6o.n) });
    });
    await attempt(async () => {
      const stuckBefore = new Date(+at - rule('A7', 'minutes', 15) * 60_000);
      const a7 = await db('EventWaitlistEntry as w').join('EventTicketType as t', 't.id', 'w.ticketTypeId').join('Event as e', 'e.id', 'w.eventId')
        .where('w.status', 'waiting').whereNull('w.blockedReason').where('w.joinedAt', '<', stuckBefore).where('e.status', 'published')
        .whereRaw('t.capacity - t.sold - t.held >= 1').groupBy('w.ticketTypeId').select('w.ticketTypeId').count({ n: '*' });
      for (const r of a7) push('A7', r.ticketTypeId, 'high', 'R1', { waiting: num(r.n) });
    });
    await attempt(async () => {
      const ended = await db('EventKitOfflineDevice as d').join('Event as e', 'e.id', 'd.eventId').where('d.pendingReported', '>', 0).where('e.endsAt', '<', new Date(+at - 2 * HOUR))
        .whereRaw('coalesce(d."lastHeartbeatAt", d."issuedAt") < ?', [new Date(+at - 2 * HOUR)]).groupBy('d.eventId').select('d.eventId').sum({ n: 'd.pendingReported' });
      for (const r of ended) push('A8', r.eventId, 'medium', 'R5', { unsentScans: num(r.n) });
      const unchecked = await db('EventKitOfflineScan as s').join('Event as e', 'e.id', 's.eventId').where('s.reviewStatus', 'needs_review').where('e.endsAt', '<', new Date(+at - DAY)).groupBy('s.eventId').select('s.eventId').count({ n: '*' });
      for (const r of unchecked) push('A8', `review:${r.eventId}`, 'medium', 'R8', { scansToCheck: num(r.n) });
    });
    await attempt(async () => {
      const a9 = await db('AuditLog').where({ action: 'events.kit_offline_invalid_burst' }).where('at', '>=', new Date(+at - 15 * 60_000)).count({ n: '*' }).first();
      const a9v = await db('AuditLog').whereIn('action', ['events.ticket_verify_failed', 'events.ticket_integrity_failed']).where('at', '>=', new Date(+at - 60_000)).groupBy('actor').havingRaw('count(*) >= 20').select('actor').count({ n: '*' });
      if (num(a9.n)) push('A9', 'offline-burst', 'medium', 'R5', { bursts: num(a9.n) });
      for (const r of a9v) push('A9', `verify:${r.actor}`, 'medium', 'R5', { failedLastMinute: num(r.n) });
    });
    await attempt(async () => {
      const a10 = await db('EventAnalyticsDaily').where({ name: 'api_error' }).where('day', '>=', darDay(new Date(+at - DAY))).whereRaw(`dims->>'class' = '5xx'`).groupByRaw(`dims->>'group'`).select(db.raw(`dims->>'group' as grp`)).sum({ n: 'count' });
      // A short window needs finer data than daily counters; the daily sum is the best proxy, so the rule fires when the day's total is above the limit.
      for (const r of a10) if (num(r.n) > rule('A10', 'count', 20)) push('A10', r.grp, 'high', 'R1', { fiveXxToday: num(r.n) });
    });
    await attempt(async () => {
      const a11 = await db('EventAnalyticsDaily').where({ name: 'reward_duplicate_blocked' }).where('day', '>=', darDay(new Date(+at - DAY))).sum({ n: 'count' }).first();
      if (num(a11.n) > 0) push('A11', 'duplicates', 'medium', 'R9', { blocked: num(a11.n) });
    });
    await attempt(async () => {
      const a12 = await db('EventResultDispute').where({ status: 'open' }).where('createdAt', '<', new Date(+at - rule('A12', 'days', 7) * DAY)).count({ n: '*' }).first();
      if (num(a12.n)) push('A12', 'disputes', 'low', 'R3', { aging: num(a12.n) });
    });
    await attempt(async () => {
      const s = setup();
      if (!s.retentionConfigured && (s.flags?.kitOps || s.flags?.kitOffline)) push('A13', 'retention', 'low', 'C14', {});

    });
    return out;
  }

  const alertLine = a => `${a.rule} ${a.severity.toUpperCase()} ${a.subject}: ${Object.entries(a.counts).map(([k, v]) => `${k}=${v}`).join(', ') || 'no counts'} (runbook ${a.runbook})`;

  /** Evaluate and email. With OPS_ALERT_EMAILS unset (or no email provider) nothing is sent; the Health tab still shows the alerts. */
  async function runAlerts() {
    const list = await evaluateAlerts();
    const to = recipients();
    const sender = emailSender();
    if (!list.length) return { evaluated: true, firing: 0, sent: 0, skipped: 0 };
    if (!to.length || sender.configured !== true) return { evaluated: true, firing: list.length, sent: 0, skipped: list.length, reason: to.length ? 'email_not_configured' : 'no_recipients' };
    const since = new Date(+stamp() - ALERT_REPEAT_MS);
    let sent = 0; let skipped = 0;
    for (const a of list) {
      const target = `${a.rule}|${a.subject}`.slice(0, 200);
      const recent = await db('AuditLog').where({ action: 'events.alerts_sent', target }).where('at', '>=', since).first('id');
      if (recent) { skipped += 1; continue; }
      let ok = 0;
      for (const address of to) {
        const r = await sender.send(address, { subject: `[FitFlex events] ${a.rule} ${a.severity}: ${a.subject}`, text: `${alertLine(a)}\n\nIds and counts only. See the Events health tab.` }).catch(() => ({ ok: false }));
        if (r?.ok) ok += 1;
      }
      if (ok) {
        sent += 1;
        await db('AuditLog').insert({ id: `aud_${randomUUID().slice(0, 12)}`, at: stamp(), actor: 'system', action: 'events.alerts_sent', target, before: null, after: JSON.stringify({ rule: a.rule, severity: a.severity, recipients: ok }) });
      }
    }
    return { evaluated: true, firing: list.length, sent, skipped };
  }

  void expectedEnabled; void APP_EVENT_NAMES;
  return { track, ingest, rollup, purge, health, evaluateAlerts, runAlerts, upsertCounter };
}
