// Security incidents (S4b): the member reports a web check-in they did not make, and staff work the report.
//
// Member side  report({ userId, eventId, secureAccount }): records ONE incident per (member, event); a repeat returns the
//   same incident (idempotent). With secureAccount (default true) the member's sessions are ended and, when FitFlex holds
//   a PIN for them, the PIN must be reset before the next PIN sign-in. After 2 such "secure" actions in 24 hours further
//   reports are still recorded but do NOT lock the account again (protection.limited). More than
//   SECURITY_REPORT_MAX_PER_DAY new incidents in a rolling 24 hours is refused with 429 and the real wait
//   (retryAfterSeconds: until the oldest counted report is 24 hours old). A repeat ignores secureAccount: what the
//   first report asked for stands, so a report-only cannot later be upgraded to "secure".
// Staff side   list / get / acknowledge / resolve. Every action writes an AuditLog row and an append-only
//   SecurityIncidentEvent row. The staff reason (10-500 chars) is kept on the incident row, never in the trail or audit.
//
// What a report NEVER does: void or delete the check-in, change visits, payouts or settlement, or revoke Firebase refresh
// tokens (deferred to S5). Stored: ids, gym id/name, event time, what protection was applied. NEVER stored or sent:
// IP, user agent, client metadata, session or intent ids, PIN, tokens. The staff alert carries ids and the gym name only.
import { randomUUID } from 'node:crypto';
import { eatDate } from '../shared/eat-time.mjs';

export const STATUS = Object.freeze({ OPEN: 'open', ACKNOWLEDGED: 'acknowledged', RESOLVED: 'resolved' });
export const OUTCOMES = Object.freeze(['unauthorised_confirmed', 'authorised_by_member', 'inconclusive']);
export const REASON_MIN = 10;
export const REASON_MAX = 500;
export const SECURE_ACTIONS_PER_DAY = 2;
export const RETENTION_MONTHS = 24;
export const NOTIFICATION_TYPE = 'security_report_resolved';
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;
const DAY_MS = 86_400_000;

const newId = p => `${p}_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
const safeId = s => String(s).replace(/[^A-Za-z0-9_]/g, '').slice(0, 60);
export const notificationIdFor = incidentId => `ntf_secinc_${safeId(incidentId)}`;
const iso = v => (v ? new Date(v).toISOString() : null);
const json = v => (v == null ? null : JSON.stringify(v));
const obj = v => (typeof v === 'string' ? JSON.parse(v) : v ?? null);

/**
 * THE one rule for "protection was asked for but is not in place": requested, not applied, and not held back by the
 * 2-per-day limit. A repeat report retries exactly these; the POST response says `failed: true` for exactly these; the
 * member list says `protectionPending: true` for exactly these. It also covers a crash between recording the incident
 * and applying protection (applied is still false, nothing else is set).
 */
export const protectionPending = (p) => Boolean(p && p.requested && !p.applied && !p.limited);
/** False only when a retry cannot help as things stand: the account has no Person record to protect. */
export const protectionRetryable = (p) => !(protectionPending(p) && p.failure === 'no_person');

/** Neutral on purpose: the same words whatever the outcome. Swahili is a DRAFT for native review. */
/** Lock-screen push line for the resolution message. Swahili is a DRAFT for native review. */
export const PUSH_TEXT = {
  en: { body: 'Open the app to read it.' },
  sw: { body: 'Fungua programu kusoma.' },
};

export function resolutionText({ gymName, when }) {
  const gymEn = gymName || 'FitFlex gym';
  const gymSw = gymName || 'gym ya FitFlex';
  const at = (l) => (when ? eatDate(when, l) : '');
  return {
    en: {
      title: 'We reviewed your security report',
      body: `Thank you for telling us. We have reviewed your report about the check-in at ${gymEn}${when ? ` on ${at('en')}` : ''} and closed it. If anything still looks wrong, open Security activity or contact FitFlex support.`,
    },
    sw: {
      title: 'Tumepitia ripoti yako ya usalama',
      body: `Asante kwa kutuambia. Tumepitia ripoti yako kuhusu kujiandikisha ${gymSw}${when ? ` tarehe ${at('sw')}` : ''} na tumeifunga. Ikiwa kuna kitu bado hakionekani sawa, fungua Shughuli za usalama au wasiliana na msaada wa FitFlex.`,
    },
  };
}

export function createSecurityIncidentService({
  db, pinAuth, ops = null, auditLog = null, notify = async () => {}, localeOf = async () => null,
  reportsOn = () => false, maxPerDay = () => 3, logger = console, now = () => new Date(),
}) {
  const trail = (q, incidentId, kind, actor, detail = null) => q('SecurityIncidentEvent').insert({
    id: newId('sie'), incidentId, kind, actor: actor ?? null, detail: json(detail), createdAt: now(),
  });
  // Inside a transaction the audit row is written with it (AuditLog table, same shape the collection store writes).
  const audit = (action, actor, target, before, after, trx = null) => (trx
    ? trx('AuditLog').insert({ id: randomUUID(), at: now(), actor: actor ?? null, action, target, before: json(before), after: json(after) })
    : auditLog?.insertAsync({ id: randomUUID(), at: now().toISOString(), actor: actor ?? null, action, target, before, after }));

  // signedOut is true only on the call that ended the sessions; a repeat does not re-assert it.
  const memberView = (row, extra = {}) => ({
    ok: true, idempotent: false,
    incident: { id: row.id, status: row.status, reportedAt: iso(row.reportedAt) },
    protection: protectionView(obj(row.protection)),
    signedOut: false,
    ...extra,
  });
  function protectionView(p) {
    const q = p || {};
    return {
      requested: Boolean(q.requested), sessionsEnded: Boolean(q.sessionsEnded),
      pinResetRequired: q.pinResetRequired === undefined ? false : q.pinResetRequired,
      ...(q.limited ? { limited: true } : {}),
      ...(protectionPending(q) ? { failed: true } : {}),
      ...(protectionRetryable(q) ? {} : { retryable: false }),
    };
  }

  /**
   * How each of the caller's events is reported:
   * { [eventId]: { incidentId, status, reportedAt, protectionPending, protectionRetryable? } }. Flag-gated.
   * protectionPending is true exactly when reporting the event again would retry protection. protectionRetryable is
   * present only as `false` (no Person record: a retry cannot help). Nothing else of the stored protection is shown.
   */
  async function reportsFor(userId, eventIds) {
    if (!reportsOn() || !eventIds.length) return {};
    const rows = await db('SecurityIncident').where({ userId }).whereIn('eventId', eventIds).select('id', 'eventId', 'status', 'reportedAt', 'protection');
    return Object.fromEntries(rows.map((r) => {
      const p = obj(r.protection);
      return [r.eventId, {
        incidentId: r.id, status: r.status, reportedAt: iso(r.reportedAt),
        protectionPending: protectionPending(p),
        ...(protectionRetryable(p) ? {} : { protectionRetryable: false }),
      }];
    }));
  }

  /** End sessions + require a PIN reset; records the outcome on the incident. → true when sessions were ended now. */
  async function applyProtection(incidentId, userId, personId, protection) {
    try {
      if (!personId) {
        // No Person to protect (legacy account): say so, do not pretend it worked.
        protection.pinResetRequired = 'not_applicable'; protection.sessionsEnded = false; protection.failed = true; protection.failure = 'no_person';
      } else {
        protection.pinResetRequired = (await pinAuth.requirePinReset(personId, userId)) ? true : 'not_applicable';
        await pinAuth.endSessions(personId);
        protection.sessionsEnded = true; protection.applied = true; delete protection.failed; delete protection.failure;
      }
    } catch (err) {
      protection.failed = true; delete protection.failure;
      logger.warn?.(`[security-incident] protection for ${incidentId} failed: ${err?.message}`);
    }
    await db('SecurityIncident').where({ id: incidentId }).update({ protection: json(protection), updatedAt: now() });
    return protection.sessionsEnded === true;
  }

  /** Same event reported again: same incident; protection that was asked for but never applied is retried. */
  async function repeat(row) {
    const p = obj(row.protection) || {};
    if (!protectionPending(p)) return memberView(row, { idempotent: true });
    // A "no Person" failure is retried too: the lookup is one read, and it heals by itself if a Person is linked later.
    const personId = (await db('User').where({ id: row.userId }).first('personId'))?.personId || null;
    const protection = { ...p };
    const signedOut = await applyProtection(row.id, row.userId, personId, protection);
    await trail(db, row.id, 'protection', row.userId, { retry: true, sessionsEnded: protection.sessionsEnded, pinResetRequired: protection.pinResetRequired, failed: Boolean(protection.failed) }).catch(() => {});
    return memberView(await db('SecurityIncident').where({ id: row.id }).first(), { idempotent: true, signedOut });
  }

  async function report({ userId, eventId, secureAccount }) {
    if (secureAccount !== undefined && secureAccount !== null && typeof secureAccount !== 'boolean') return { error: 'invalid_secure_account', status: 400 };
    const secure = secureAccount !== false;
    const id = String(eventId || '');
    const event = id ? await db('SecurityEvent').where({ id, userId }).first() : null;
    if (!event) return { error: 'not_found', status: 404 };

    const existing = await db('SecurityIncident').where({ userId, eventId: id }).first();
    if (existing) return repeat(existing);

    const person = (await db('User').where({ id: userId }).first('personId'))?.personId || null;
    const details = obj(event.details) || {};
    const snapshot = { kind: event.kind, eventId: id, gymId: event.gymId || null, gymName: details.gymName || null, occurredAt: iso(event.occurredAt), channel: event.channel || 'web' };
    const incidentId = newId('sin');
    const since = new Date(+now() - DAY_MS);

    // One transaction per member decides the cap and how much protection is allowed, so two taps cannot both pass.
    const decided = await db.transaction(async (trx) => {
      await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`secinc:${userId}`]);
      const again = await trx('SecurityIncident').where({ userId, eventId: id }).first();
      if (again) return { existing: again };
      const recent = await trx('SecurityIncident').where({ userId }).where('reportedAt', '>=', since).select('protection', 'reportedAt');
      const max = maxPerDay();
      if (recent.length >= max) {
        // Rolling 24 hours: a new report fits once enough counted ones have aged out to be back under the cap, which is
        // the oldest one when the member is exactly at the cap. Seconds until then, rounded up, never less than 1.
        const times = recent.map(r => +new Date(r.reportedAt)).sort((a, b) => a - b);
        const frees = times[Math.min(Math.max(recent.length - max, 0), times.length - 1)];
        const waitMs = Number.isFinite(frees) ? frees - +since : DAY_MS;
        return { capped: true, retryAfterSeconds: Math.min(Math.max(Math.ceil(waitMs / 1000), 1), DAY_MS / 1000) };
      }
      // Intended protection is recorded in this same transaction, so concurrent reports cannot exceed the cap.
      const secured = recent.filter((r) => { const q = obj(r.protection); return q?.requested === true && !q?.limited; }).length;
      const limited = secure && secured >= SECURE_ACTIONS_PER_DAY;
      const protection = { requested: secure, applied: false, limited, sessionsEnded: false, pinResetRequired: false };
      const at = now();
      await trx('SecurityIncident').insert({
        id: incidentId, userId, eventId: id, status: STATUS.OPEN, snapshot: json(snapshot), protection: json(protection), reportedAt: at, updatedAt: at,
      });
      await trail(trx, incidentId, 'reported', userId, { secureAccount: secure, limited });
      return { protection, limited };
    });
    if (decided.existing) return repeat(decided.existing);
    if (decided.capped) return { error: 'report_limit_reached', status: 429, retryAfterSeconds: decided.retryAfterSeconds };

    // The incident now exists whatever happens next. Protection is applied after, and a failure is recorded, not hidden.
    const protection = { ...decided.protection };
    let signedOut = false;
    if (secure && !decided.limited) signedOut = await applyProtection(incidentId, userId, person, protection);
    else await db('SecurityIncident').where({ id: incidentId }).update({ protection: json(protection), updatedAt: now() });
    if (secure) await trail(db, incidentId, 'protection', userId, { sessionsEnded: protection.sessionsEnded, pinResetRequired: protection.pinResetRequired, limited: Boolean(protection.limited), failed: Boolean(protection.failed) }).catch(() => {});

    // Tell staff. Never fails the report: if this breaks, the incident is still listed in the admin screen.
    let opsExceptionId = null;
    try {
      if (ops) {
        const gym = snapshot.gymName ? ` at ${String(snapshot.gymName).slice(0, 80)}` : '';
        const raised = await ops.raise({
          type: 'security_incident', severity: 'high', title: `Member reported an unrecognised web check-in${gym} (incident ${incidentId})`,
          entityType: 'security_incident', entityId: incidentId, dedupeKey: `security_incident:${incidentId}`,
          detail: { incidentId, eventId: id, gymId: snapshot.gymId, gymName: snapshot.gymName, targetResponse: 'one business day' },
        });
        opsExceptionId = raised.exception?.id ?? null;
        if (opsExceptionId) await db('SecurityIncident').where({ id: incidentId }).update({ opsExceptionId });
      }
    } catch (err) {
      logger.warn?.(`[security-incident] ops alert for ${incidentId} failed: ${err?.message}`);
    }
    const row = await db('SecurityIncident').where({ id: incidentId }).first();
    return memberView(row, { signedOut });
  }

  // ── Staff ────────────────────────────────────────────────────────────────

  const adminRow = r => ({
    id: r.id, userId: r.userId, eventId: r.eventId, status: r.status, outcome: r.outcome ?? null,
    snapshot: obj(r.snapshot), protection: obj(r.protection), opsExceptionId: r.opsExceptionId ?? null,
    reportedAt: iso(r.reportedAt), acknowledgedAt: iso(r.acknowledgedAt), acknowledgedBy: r.acknowledgedBy ?? null,
    resolvedAt: iso(r.resolvedAt), resolvedBy: r.resolvedBy ?? null, resolutionReason: r.resolutionReason ?? null,
  });

  async function list({ status, limit, before } = {}) {
    if (status && ![...Object.values(STATUS), 'all'].includes(status)) return { error: 'invalid_status', status: 400 };
    const n = Math.min(Math.max(Math.floor(Number(limit)) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const q = db('SecurityIncident');
    if (status && status !== 'all') q.where({ status });
    else if (!status) q.whereIn('status', [STATUS.OPEN, STATUS.ACKNOWLEDGED]);
    if (before) {
      const [t0, bid] = String(before).split('~');
      const t = new Date(t0);
      if (Number.isNaN(t.getTime()) || !bid) return { error: 'invalid_before', status: 400 };
      q.where(b => b.where('reportedAt', '<', t).orWhere(c => c.where('reportedAt', t).andWhere('id', '<', bid)));
    }
    const rows = await q.orderBy([{ column: 'reportedAt', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(n + 1);
    const page = rows.slice(0, n);
    const last = page[page.length - 1];
    return { incidents: page.map(adminRow), ...(rows.length > n && last ? { next: `${iso(last.reportedAt)}~${last.id}` } : {}) };
  }

  async function get({ id }) {
    const row = await db('SecurityIncident').where({ id: String(id || '') }).first();
    if (!row) return { error: 'not_found', status: 404 };
    const events = await db('SecurityIncidentEvent').where({ incidentId: row.id }).orderBy([{ column: 'createdAt', order: 'asc' }, { column: 'id', order: 'asc' }]);
    return { incident: adminRow(row), events: events.map(e => ({ id: e.id, kind: e.kind, actor: e.actor, detail: obj(e.detail), at: iso(e.createdAt) })) };
  }

  async function acknowledge({ id, actorId }) {
    const row = await db('SecurityIncident').where({ id: String(id || '') }).first();
    if (!row) return { error: 'not_found', status: 404 };
    const at = now();
    const done = await db.transaction(async (trx) => {
      const n = await trx('SecurityIncident').where({ id: row.id, status: STATUS.OPEN })
        .update({ status: STATUS.ACKNOWLEDGED, acknowledgedBy: actorId, acknowledgedAt: at, updatedAt: at });
      if (!n) return false;
      await trail(trx, row.id, 'acknowledged', actorId);
      await audit('security_incident_acknowledged', actorId, row.id, { status: row.status }, { status: STATUS.ACKNOWLEDGED }, trx);
      return true;
    });
    if (!done) return { error: 'invalid_state', status: 409, current: row.status };
    return get({ id: row.id });
  }

  async function resolve({ id, actorId, outcome, reason }) {
    if (!OUTCOMES.includes(outcome)) return { error: 'invalid_outcome', status: 400, allowed: OUTCOMES };
    const text = typeof reason === 'string' ? reason.trim() : '';
    if (text.length < REASON_MIN || text.length > REASON_MAX) return { error: 'invalid_reason', status: 400, min: REASON_MIN, max: REASON_MAX };
    const row = await db('SecurityIncident').where({ id: String(id || '') }).first();
    if (!row) return { error: 'not_found', status: 404 };
    const at = now();
    const done = await db.transaction(async (trx) => {
      const n = await trx('SecurityIncident').where({ id: row.id }).whereIn('status', [STATUS.OPEN, STATUS.ACKNOWLEDGED])
        .update({ status: STATUS.RESOLVED, outcome, resolutionReason: text, resolvedBy: actorId, resolvedAt: at, updatedAt: at });
      if (!n) return false;
      await trail(trx, row.id, 'resolved', actorId, { outcome });
      await audit('security_incident_resolved', actorId, row.id, { status: row.status }, { status: STATUS.RESOLVED, outcome }, trx);
      return true;
    });
    if (!done) return { error: 'invalid_state', status: 409, current: row.status };
    if (ops && row.opsExceptionId) {
      try { await ops.clear(`security_incident:${row.id}`, { by: actorId, resolution: `Incident resolved (${outcome}).` }); } catch { /* the incident is resolved either way */ }
    }
    await tellMember(row);
    return get({ id: row.id });
  }

  /** The same neutral message whatever the outcome; best effort. */
  async function tellMember(row) {
    try {
      const snap = obj(row.snapshot) || {};
      const text = resolutionText({ gymName: snap.gymName, when: snap.occurredAt ? new Date(snap.occurredAt) : null });
      let locale = null;
      try { locale = await localeOf(row.userId); } catch { locale = null; }
      const chosen = locale === 'sw' ? text.sw : text.en;
      const data = { incidentId: row.id, eventId: row.eventId, open: 'security_activity' };
      await notify(row.userId, {
        id: notificationIdFor(row.id), type: NOTIFICATION_TYPE, title: chosen.title, body: chosen.body,
        data: { ...data, locale: locale === 'sw' ? 'sw' : 'en', titleEn: text.en.title, bodyEn: text.en.body, titleSw: text.sw.title, bodySw: text.sw.body },
        pushTitle: chosen.title, pushBody: (locale === 'sw' ? PUSH_TEXT.sw : PUSH_TEXT.en).body, pushData: data,
      });
    } catch (err) {
      logger.warn?.(`[security-incident] resolution message for ${row.id} failed: ${err?.message}`);
    }
  }

  /** Retention: resolved incidents resolved more than RETENTION_MONTHS ago go (COALESCE(resolvedAt, reportedAt)) (their trail goes with them). → rows deleted. */
  async function purgeExpired({ months = RETENTION_MONTHS } = {}) {
    const c = new Date(now());
    c.setUTCMonth(c.getUTCMonth() - months);
    return db('SecurityIncident').where({ status: STATUS.RESOLVED }).whereRaw('COALESCE("resolvedAt", "reportedAt") < ?', [c]).del();
  }

  return { report, reportsFor, list, get, acknowledge, resolve, purgeExpired };
}
