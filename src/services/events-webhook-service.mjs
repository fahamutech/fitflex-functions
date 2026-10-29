// Marathon & running events · S5 — signed webhooks (spec §7): endpoint registration and verification, the fan-out of outbox
// rows to endpoints, the delivery loop with retries, dead letters and auto-disable, the per-attempt log, manual retry, health.
// OWNER REVIEW (D35): this file makes outbound requests on an organizer's say-so. The three defences, in order:
//   1. checkWebhookUrl (webhook-url-guard.mjs) at registration AND before every attempt, on freshly resolved addresses;
//   2. the connection is pinned to a validated address (sendPinned), redirects are never followed;
//   3. fan-out is joined on organizerId IN THE SQL, and the deliver step re-checks endpoint.organizerId = outbox.organizerId
//      and that the event belongs to that organizer; a mismatch is dead-lettered with a high-severity audit row.
// No key (EVENTS_WEBHOOK_SECRET_KEY) means nothing is signed, decrypted, fanned out or sent.
import { randomUUID, randomBytes } from 'node:crypto';
import { checkWebhookUrl, sendPinned, defaultResolve } from '../shared/webhook-url-guard.mjs';
import {
  newWebhookSecret, sha256hex, last4, signatureHeader, deliveryHeaders, encryptSecret, decryptSecret, redactSnippet,
} from '../shared/webhook-signing.mjs';
import {
  WEBHOOK_EVENT_TYPES, isSubscribable, projectOutbox, envelopeOf, verificationEnvelope, testEnvelope, retryDelayMs, MAX_BODY_BYTES,
} from '../shared/webhook-events.mjs';
import { decodeCursor, encodeCursor, parseLimit } from '../shared/events-ops-rules.mjs';

const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const plain = row => (row ? JSON.parse(JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? Number(v) : v))) : null);
const iso = v => (v ? new Date(v).toISOString() : null);
const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const newId = prefix => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const GRACE_HOURS = Object.freeze([0, 24, 72]);

/** The code stored as `lastError`: never an exception message. */
const errorCodeOf = (err) => {
  const cause = String(err?.cause ?? '');
  if (err?.code === 'timeout') return 'timeout';
  if (err?.code === 'tls_error') return 'tls_error';
  if (cause === 'ENOTFOUND' || cause === 'EAI_AGAIN') return 'dns_failure';
  if (cause === 'ECONNREFUSED') return 'connection_refused';
  if (cause === 'ECONNRESET') return 'connection_reset';
  return 'network_error';
};

/** Run async `tasks` with at most `limit` in flight. */
async function runPool(tasks, limit) {
  const queue = [...tasks];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => { while (queue.length) await queue.shift()(); });
  await Promise.all(workers);
}

export function createEventsWebhookService({
  db, notify = async () => {}, localeOf = async () => null, now = () => new Date(), keyRing = () => null,
  resolve = defaultResolve, sendHttp = null, random = Math.random,
  config = {},
}) {
  const cfg = { maxEndpoints: () => 5, timeoutMs: () => 10_000, maxAttempts: () => 10, batch: () => 50, lagSeconds: () => 5, ...config };
  const stamp = () => new Date(now());
  const audit = (actor, action, target, before, after) => db('AuditLog').insert({
    id: `aud_${randomUUID().slice(0, 12)}`, at: stamp(), actor, action, target,
    before: before == null ? null : JSON.stringify(before), after: after == null ? null : JSON.stringify(after),
  });
  const enabled = () => Boolean(keyRing());
  const off = () => fail('feature_disabled', 404);

  /** The default transport: every validated address in turn (a refused connection tries the next), one overall deadline. */
  async function send({ url, addresses, headers, body, timeoutMs, tls }) {
    if (sendHttp) return sendHttp({ url, addresses, headers, body, timeoutMs, tls });
    const deadline = +stamp() + timeoutMs;
    let lastErr = null;
    for (const a of addresses.slice(0, 3)) {
      const left = deadline - +stamp();
      if (left <= 0) break;
      try { return await sendPinned({ url, address: a.address, family: a.family, headers, body, timeoutMs: left, tls }); } catch (err) {
        lastErr = err;
        if (err.code === 'timeout' || err.code === 'tls_error') break;
      }
    }
    throw lastErr ?? Object.assign(new Error('network_error'), { code: 'network_error' });
  }

  // ── Views ─────────────────────────────────────────────────────────────────

  const hostOf = url => { try { return new URL(url).host; } catch { return null; } };

  function endpointView(e, health = null) {
    const at = +stamp();
    const inGrace = Boolean(e.previousSecretCiphertext) && +new Date(e.previousSecretExpiresAt) > at;
    return {
      id: e.id, url: e.url, host: hostOf(e.url), description: e.description ?? null, events: e.events, eventIds: e.eventIds ?? null, status: e.status,
      verifiedAt: iso(e.verifiedAt), secretHint: e.secretLast4 ? `whsec_…${e.secretLast4}` : null, rotation: { inGrace, graceEndsAt: inGrace ? iso(e.previousSecretExpiresAt) : null },
      disabledReason: e.disabledReason ?? null, disabledAt: iso(e.disabledAt), lastSuccessAt: iso(e.lastSuccessAt), consecutiveFailures: e.consecutiveFailures, createdAt: iso(e.createdAt),
      ...(health ?? {}),
    };
  }

  async function healthOf(e) {
    const at = stamp();
    const [counts] = (await db.raw(`SELECT
        count(*) FILTER (WHERE status = 'delivered' AND "deliveredAt" >= ?)::int AS delivered,
        count(*) FILTER (WHERE status = 'failed' AND "lastAttemptAt" >= ?)::int AS failed,
        count(*) FILTER (WHERE status = 'dead' AND "lastAttemptAt" >= ?)::int AS dead,
        count(*) FILTER (WHERE status IN ('pending', 'failed'))::int AS pending,
        min("createdAt") FILTER (WHERE status IN ('pending', 'failed')) AS oldest
      FROM "WebhookDelivery" WHERE "endpointId" = ?`, [new Date(+at - DAY), new Date(+at - DAY), new Date(+at - DAY), e.id])).rows;
    const recentFail = Number((await db('WebhookDeliveryAttempt').where({ endpointId: e.id }).whereNot({ outcome: 'success' }).where('startedAt', '>=', new Date(+at - HOUR)).count({ n: '*' }).first()).n) > 0;
    const oldestAge = counts.oldest ? Math.max(0, Math.round((+at - +new Date(counts.oldest)) / 1000)) : null;
    let health = 'healthy';
    if (e.status === 'disabled') health = 'disabled';
    else if (!e.verifiedAt) health = 'unverified';
    else if (recentFail) health = e.lastSuccessAt && +new Date(e.lastSuccessAt) >= +at - DAY && (oldestAge === null || oldestAge < 3600) ? 'degraded' : 'failing';
    return { health, last24h: { delivered: counts.delivered, failed: counts.failed, dead: counts.dead }, pending: counts.pending, oldestPendingAgeSeconds: oldestAge };
  }

  /** L10: do the stored secrets open under the current key ring (key id typo, key rotated without the previous one)? → { ok, unreadable } */
  function keyHealth(rows) {
    if (!enabled()) return { ok: false, unreadable: rows.length };
    const unreadable = rows.filter(e => !secretsOf(e)).length;
    return { ok: unreadable === 0, unreadable };
  }
  const own = async (organizerId, id) => plain(await db('WebhookEndpoint').where({ id: String(id), organizerId }).first());

  async function tellTeam(organizerId, { id, type, en, sw, roles = ['owner', 'admin'] }) {
    const staff = await db('EventOrganizerStaff').where({ organizerId, status: 'active' }).whereIn('role', roles).select('userId');
    for (const s of staff) {
      try {
        let locale = null;
        try { locale = await localeOf(s.userId); } catch { locale = null; }
        const t = locale === 'sw' ? sw : en;
        await notify(s.userId, { id: `${id}_${s.userId}`.slice(0, 60), type, title: t.title, body: t.body, data: { organizerId, route: '/organizer/integrations?tab=webhooks', locale: locale === 'sw' ? 'sw' : 'en', titleEn: en.title, bodyEn: en.body, titleSw: sw.title, bodySw: sw.body } });
      } catch { /* a notice must not undo the work */ }
    }
  }

  // ── The attempt: one signed POST, judged ─────────────────────────────────

  /** Secrets that sign right now: the current one, then the previous while its grace window is open. null when the key ring cannot open them. */
  function secretsOf(e) {
    const ring = keyRing();
    if (!ring || !e.secretCiphertext) return null;
    const current = decryptSecret(ring, { ciphertext: e.secretCiphertext, keyId: e.secretKeyId }, e.id);
    if (!current) return null;
    const list = [current];
    if (e.previousSecretCiphertext && +new Date(e.previousSecretExpiresAt) > +stamp()) {
      const prev = decryptSecret(ring, { ciphertext: e.previousSecretCiphertext, keyId: e.previousSecretKeyId }, e.id);
      if (prev) list.push(prev);
    }
    return list;
  }

  /**
   * One attempt against an endpoint. Re-validates the URL on freshly resolved addresses EVERY time. → { outcome, responseCode, snippet,
   * errorCode, durationMs, body }. Never throws.
   */
  async function attempt(e, { envelope, eventId, eventType, attemptNo }) {
    const started = +stamp();
    const done = (outcome, extra = {}) => ({ outcome, responseCode: null, snippet: null, errorCode: null, body: null, durationMs: Math.max(0, +stamp() - started), ...extra });
    const secrets = secretsOf(e);
    if (!secrets) return done('network_error', { errorCode: 'secret_unavailable' });
    const checked = await checkWebhookUrl(e.url, { resolve });
    if (!checked.ok) return done('blocked_address', { errorCode: checked.reason });
    const body = JSON.stringify(envelope);
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) return done('network_error', { errorCode: 'payload_too_large' });
    const timestamp = Math.floor(+stamp() / 1000);
    const headers = deliveryHeaders({ eventId, eventType, timestamp, attemptNo, signature: signatureHeader(secrets, timestamp, body) });
    try {
      const res = await send({ url: checked.url, addresses: checked.addresses, headers, body, timeoutMs: cfg.timeoutMs() });
      const snippet = redactSnippet(res.snippet, res.headers?.['content-type'] ?? 'text/plain');
      const code = res.status;
      if (code >= 200 && code < 300) return done('success', { responseCode: code, snippet, body: res.snippet });
      if (code >= 300 && code < 400) return done('redirect_not_followed', { responseCode: code, snippet, errorCode: `http_${code}` });
      if (code === 410) return done('gone', { responseCode: code, snippet, errorCode: 'http_410' });
      return done('http_error', { responseCode: code, snippet, errorCode: `http_${code}` });
    } catch (err) {
      const errorCode = errorCodeOf(err);
      return done(err?.code === 'timeout' ? 'timeout' : err?.code === 'tls_error' ? 'tls_error' : 'network_error', { errorCode });
    }
  }

  const attemptRow = (e, deliveryId, attemptNo, trigger, r, nextAttemptAt = null) => db('WebhookDeliveryAttempt').insert({
    id: newId('wda'), deliveryId, endpointId: e.id, attemptNo, trigger, startedAt: stamp(), durationMs: r.durationMs, outcome: r.outcome,
    responseCode: r.responseCode, responseSnippet: r.snippet, errorCode: r.errorCode, nextAttemptAt,
  });

  // ── Endpoints (organizer owner/admin; the route has checked the role) ─────

  function parseSubscription(body) {
    const events = Array.isArray(body.events) ? [...new Set(body.events)] : null;
    if (!events || !events.length) return fail('validation_failed', 422, { fields: [{ path: 'events', code: 'required' }] });
    const bad = events.find(t => typeof t !== 'string' || !isSubscribable(t));
    if (bad !== undefined) return fail('invalid_event_type', 422, { type: String(bad).slice(0, 40), allowed: [...WEBHOOK_EVENT_TYPES] });
    return { events };
  }
  async function parseEventIds(organizerId, raw) {
    if (raw === undefined || raw === null) return { eventIds: null };
    if (!Array.isArray(raw) || raw.length > 100 || raw.some(x => typeof x !== 'string') || !raw.length) return fail('validation_failed', 422, { fields: [{ path: 'eventIds', code: 'invalid' }] });
    const ids = [...new Set(raw)];
    if (Number((await db('Event').where({ organizerId }).whereIn('id', ids).count({ n: '*' }).first()).n) !== ids.length) return fail('validation_failed', 422, { fields: [{ path: 'eventIds', code: 'unknown_event' }] });
    return { eventIds: ids };
  }

  async function createEndpoint({ organizerId, actorId, body = {} }) {
    const ring = keyRing();
    if (!ring) return off();
    const checked = await checkWebhookUrl(body.url, { resolve });
    if (!checked.ok) return fail('invalid_url', 400, { reason: checked.reason });
    const sub = parseSubscription(body);
    if (sub.error) return sub;
    const scope = await parseEventIds(organizerId, body.eventIds);
    if (scope.error) return scope;
    const active = Number((await db('WebhookEndpoint').where({ organizerId, status: 'active' }).count({ n: '*' }).first()).n);
    if (active >= cfg.maxEndpoints()) return fail('endpoint_limit_reached', 409, { max: cfg.maxEndpoints() });
    const id = newId('whe');
    const secret = newWebhookSecret();
    const sealed = encryptSecret(ring, secret, id);
    const at = stamp();
    const [saved] = await db('WebhookEndpoint').insert({
      id, organizerId, url: checked.url, secretHash: sha256hex(secret), events: JSON.stringify(sub.events), status: 'active', description: text(body.description, 200),
      secretCiphertext: sealed.ciphertext, secretKeyId: sealed.keyId, secretLast4: last4(secret), eventIds: scope.eventIds ? JSON.stringify(scope.eventIds) : null, createdBy: String(actorId).startsWith('api:') ? null : actorId, createdAt: at, updatedAt: at,
    }).returning('*');
    await audit(actorId, 'events.webhook_endpoint_created', id, null, { host: checked.host, events: sub.events, eventIds: scope.eventIds });
    return { status: 201, endpoint: endpointView(plain(saved), await healthOf(plain(saved))), signingSecret: secret };
  }

  async function listEndpoints({ organizerId }) {
    const rows = (await db('WebhookEndpoint').where({ organizerId }).orderBy([{ column: 'createdAt', order: 'desc' }, { column: 'id', order: 'desc' }])).map(plain);
    const items = [];
    for (const e of rows) items.push(endpointView(e, await healthOf(e)));
    return { items, max: cfg.maxEndpoints(), types: [...WEBHOOK_EVENT_TYPES], available: enabled(), keys: keyHealth(rows) };
  }

  async function getEndpoint({ organizerId, id }) {
    const e = await own(organizerId, id);
    if (!e) return fail('endpoint_not_found', 404);
    const attempts = (await db('WebhookDeliveryAttempt').where({ endpointId: e.id }).orderBy('startedAt', 'desc').limit(10)).map(attemptView);
    return { endpoint: endpointView(e, await healthOf(e)), attempts };
  }

  async function updateEndpoint({ organizerId, id, actorId, body = {} }) {
    if (!enabled()) return off();
    const e = await own(organizerId, id);
    if (!e) return fail('endpoint_not_found', 404);
    const patch = {};
    let urlChanged = false;
    if (body.url !== undefined) {
      const checked = await checkWebhookUrl(body.url, { resolve });
      if (!checked.ok) return fail('invalid_url', 400, { reason: checked.reason });
      if (checked.url !== e.url) { patch.url = checked.url; patch.verifiedAt = null; urlChanged = true; }
    }
    if (body.events !== undefined) { const sub = parseSubscription(body); if (sub.error) return sub; patch.events = JSON.stringify(sub.events); }
    if (body.eventIds !== undefined) { const scope = await parseEventIds(organizerId, body.eventIds); if (scope.error) return scope; patch.eventIds = scope.eventIds ? JSON.stringify(scope.eventIds) : null; }
    if (body.description !== undefined) patch.description = text(body.description, 200);
    if (!Object.keys(patch).length) return fail('validation_failed', 422, { fields: [{ path: 'body', code: 'empty' }] });
    await db('WebhookEndpoint').where({ id: e.id }).update({ ...patch, updatedAt: stamp() });
    await audit(actorId, 'events.webhook_endpoint_updated', e.id, { host: hostOf(e.url), events: e.events }, { host: hostOf(patch.url ?? e.url), changed: Object.keys(patch) });
    // A changed URL proves nothing about the new owner: the handshake runs again, right now.
    const verification = urlChanged ? await verifyEndpoint({ organizerId, id: e.id, actorId }) : null;
    const fresh = await own(organizerId, id);
    return { endpoint: endpointView(fresh, await healthOf(fresh)), ...(verification ? { verification: verification.error ? { ok: false, reason: verification.error } : verification } : {}) };
  }

  /** The handshake: a signed control request carrying a challenge; the endpoint must echo it in a 200 JSON answer. */
  async function verifyEndpoint({ organizerId, id, actorId }) {
    if (!enabled()) return off();
    const e = await own(organizerId, id);
    if (!e) return fail('endpoint_not_found', 404);
    const recentVerify = Number((await db('WebhookDeliveryAttempt').where({ endpointId: e.id, trigger: 'verify' }).where('startedAt', '>=', new Date(+stamp() - HOUR)).count({ n: '*' }).first()).n);
    if (recentVerify >= 10) return fail('rate_limited', 429, { retryAfterSeconds: 3600 });
    const challenge = randomBytes(24).toString('base64url').slice(0, 32);
    const r = await attempt(e, { envelope: verificationEnvelope(challenge, stamp()), eventId: 'obx_verification', eventType: 'endpoint.verification', attemptNo: 1 });
    let ok = false;
    if (r.outcome === 'success') { try { ok = r.responseCode === 200 && JSON.parse(r.body ?? '{}')?.challenge === challenge; } catch { ok = false; } }
    await attemptRow(e, null, 1, 'verify', ok ? r : { ...r, outcome: r.outcome === 'success' ? 'http_error' : r.outcome, errorCode: r.outcome === 'success' ? 'challenge_mismatch' : r.errorCode });
    if (ok) {
      await db('WebhookEndpoint').where({ id: e.id }).update({ verifiedAt: stamp(), updatedAt: stamp() });
      await audit(actorId, 'events.webhook_endpoint_verified', e.id, null, { host: hostOf(e.url) });
      return { ok: true, host: hostOf(e.url) };
    }
    return { ok: false, host: hostOf(e.url), reason: r.outcome === 'success' ? 'challenge_mismatch' : (r.errorCode ?? r.outcome) };
  }

  async function testSend({ organizerId, id, actorId, body = {} }) {
    if (!enabled()) return off();
    const e = await own(organizerId, id);
    if (!e) return fail('endpoint_not_found', 404);
    const recent = Number((await db('WebhookDeliveryAttempt').where({ endpointId: e.id, trigger: 'test' }).where('startedAt', '>=', new Date(+stamp() - HOUR)).count({ n: '*' }).first()).n);
    if (recent >= 10) return fail('rate_limited', 429, { retryAfterSeconds: 3600 });
    const type = isSubscribable(body.type) ? body.type : 'registration.created';
    const env = testEnvelope(type, { organizerId, now: stamp() });
    const r = await attempt(e, { envelope: env, eventId: env.id, eventType: env.type, attemptNo: 1 });
    await attemptRow(e, null, 1, 'test', r);
    await audit(actorId, 'events.webhook_test_sent', e.id, null, { type: env.type, outcome: r.outcome });
    return { ok: r.outcome === 'success', outcome: r.outcome, responseCode: r.responseCode, durationMs: r.durationMs, errorCode: r.errorCode, snippet: r.snippet };
  }

  async function rotateSecret({ organizerId, id, actorId, body = {} }) {
    const ring = keyRing();
    if (!ring) return off();
    const e = await own(organizerId, id);
    if (!e) return fail('endpoint_not_found', 404);
    const grace = body.graceHours === undefined ? 24 : body.graceHours;
    if (!GRACE_HOURS.includes(grace)) return fail('validation_failed', 422, { fields: [{ path: 'graceHours', code: 'invalid', allowed: [...GRACE_HOURS] }] });
    const secret = newWebhookSecret();
    const sealed = encryptSecret(ring, secret, e.id);
    const at = stamp();
    await db('WebhookEndpoint').where({ id: e.id }).update({
      secretHash: sha256hex(secret), secretCiphertext: sealed.ciphertext, secretKeyId: sealed.keyId, secretLast4: last4(secret), updatedAt: at,
      previousSecretCiphertext: grace > 0 ? e.secretCiphertext : null, previousSecretKeyId: grace > 0 ? e.secretKeyId : null, previousSecretExpiresAt: grace > 0 ? new Date(+at + grace * HOUR) : null,
    });
    await audit(actorId, 'events.webhook_secret_rotated', e.id, null, { graceHours: grace });
    const fresh = await own(organizerId, id);
    return { endpoint: endpointView(fresh, await healthOf(fresh)), signingSecret: secret };
  }

  async function disableEndpoint({ organizerId, id, actorId, reason = 'manual' }) {
    const e = await own(organizerId, id);
    if (!e) return fail('endpoint_not_found', 404);
    if (e.status === 'disabled') return { endpoint: endpointView(e, await healthOf(e)), changed: false };
    await db('WebhookEndpoint').where({ id: e.id }).update({ status: 'disabled', disabledReason: reason, disabledAt: stamp(), updatedAt: stamp() });
    await audit(actorId, 'events.webhook_endpoint_disabled', e.id, { status: 'active' }, { reason });
    const fresh = await own(organizerId, id);
    return { endpoint: endpointView(fresh, await healthOf(fresh)), changed: true };
  }

  /** Re-enabling needs a successful handshake. `redeliverMissed`: queue, once, the events of the last 7 days created after it was disabled. */
  async function enableEndpoint({ organizerId, id, actorId, body = {} }) {
    if (!enabled()) return off();
    const e = await own(organizerId, id);
    if (!e) return fail('endpoint_not_found', 404);
    if (e.status === 'active') return { endpoint: endpointView(e, await healthOf(e)), changed: false };
    const v = await verifyEndpoint({ organizerId, id, actorId });
    if (v.error) return v;
    if (!v.ok) return fail('verification_failed', 409, { reason: v.reason, host: v.host });
    await db('WebhookEndpoint').where({ id: e.id }).update({ status: 'active', disabledReason: null, disabledAt: null, consecutiveFailures: 0, firstFailureAt: null, updatedAt: stamp() });
    let queued = 0;
    if (body.redeliverMissed === true && e.disabledAt) {
      const from = new Date(Math.max(+new Date(e.disabledAt), +stamp() - 7 * DAY));
      const missed = (await db('OutboxEvent').where({ organizerId }).where('createdAt', '>', from).orderBy('createdAt').limit(5000)).map(plain);
      for (const o of missed) {
        const projected = projectOutbox(o);
        if (!projected || !e.events.includes(projected.type) || (e.eventIds && !e.eventIds.includes(o.eventId))) continue;
        const made = await db('WebhookDelivery').insert({ id: newId('whd'), endpointId: e.id, outboxEventId: o.id, status: 'pending', attemptCount: 0, nextAttemptAt: stamp(), createdAt: stamp(), updatedAt: stamp() })
          .onConflict(['endpointId', 'outboxEventId']).ignore().returning('id');
        queued += made.length;
      }
    }
    await audit(actorId, 'events.webhook_endpoint_enabled', e.id, { status: 'disabled' }, { redeliverMissed: body.redeliverMissed === true });
    const fresh = await own(organizerId, id);
    return { endpoint: endpointView(fresh, await healthOf(fresh)), changed: true, requeued: queued };
  }

  async function adminDisableAll({ organizerId, reason, actorId }) {
    const why = text(reason, 300);
    if (!why || why.length < 10) return fail('reason_required', 422, { min: 10, max: 300 });
    const rows = await db('WebhookEndpoint').where({ organizerId: String(organizerId), status: 'active' }).update({ status: 'disabled', disabledReason: 'admin', disabledAt: stamp(), updatedAt: stamp() }).returning('id');
    await audit(actorId, 'events.admin_webhooks_disabled', String(organizerId), null, { count: rows.length, reason: why });
    return { disabled: rows.length };
  }

  async function adminSummary({ organizerId }) {
    const rows = await db('WebhookEndpoint').where({ organizerId: String(organizerId) }).groupBy('status').select('status').count({ n: '*' });
    const lastFail = await db('WebhookDeliveryAttempt as a').join('WebhookEndpoint as e', 'e.id', 'a.endpointId').where('e.organizerId', String(organizerId)).whereNot('a.outcome', 'success').orderBy('a.startedAt', 'desc').first('a.startedAt');
    return { activeEndpoints: Number(rows.find(r => r.status === 'active')?.n ?? 0), lastDeliveryFailureAt: iso(lastFail?.startedAt) };
  }

  // ── Deliveries (read and retry) ───────────────────────────────────────────

  function attemptView(a) {
    return { attemptNo: a.attemptNo, trigger: a.trigger, startedAt: iso(a.startedAt), durationMs: a.durationMs, outcome: a.outcome, responseCode: a.responseCode, errorCode: a.errorCode, responseSnippet: a.responseSnippet, nextAttemptAt: iso(a.nextAttemptAt) };
  }
  const deliveryView = (d, o) => ({
    id: d.id, endpointId: d.endpointId, eventType: projectOutbox(o)?.type ?? o.type, outboxEventId: o.id, status: d.status, attemptCount: d.attemptCount, createdAt: iso(d.createdAt),
    lastAttemptAt: iso(d.lastAttemptAt), nextAttemptAt: d.status === 'pending' || d.status === 'failed' ? iso(d.nextAttemptAt) : null, responseCode: d.responseCode, lastError: d.lastError,
  });

  async function listDeliveries({ organizerId, query = {} }) {
    const limit = parseLimit(query.limit, { dflt: 50, max: 200 });
    if (limit === null) return fail('invalid_limit', 400);
    let q = db('WebhookDelivery as d').join('WebhookEndpoint as e', 'e.id', 'd.endpointId').join('OutboxEvent as o', 'o.id', 'd.outboxEventId').where('e.organizerId', organizerId);
    if (query.endpointId) q = q.where('d.endpointId', String(query.endpointId));
    if (['pending', 'delivered', 'failed', 'dead'].includes(query.status)) q = q.where('d.status', query.status);
    if (query.eventId) q = q.where('o.eventId', String(query.eventId));
    if (query.cursor) {
      const cur = decodeCursor(query.cursor);
      if (!cur?.c || !cur?.i) return fail('invalid_cursor', 400);
      q = q.whereRaw('(d."createdAt", d.id) < (?, ?)', [new Date(cur.c), String(cur.i)]);
    }
    const rows = (await q.orderBy([{ column: 'd.createdAt', order: 'desc' }, { column: 'd.id', order: 'desc' }]).limit(limit + 1)
      .select('d.*', 'o.type as otype', 'o.id as oid', 'o.payload as opayload', 'o.organizerId as oorg', 'o.eventId as oevent', 'o.createdAt as ocreated')).map(plain);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(r => deliveryView(r, { id: r.oid, type: r.otype, payload: r.opayload })),
      nextCursor: rows.length > limit && last ? encodeCursor({ c: iso(last.createdAt), i: last.id }) : null,
    };
  }

  async function getDelivery({ organizerId, id }) {
    const d = plain(await db('WebhookDelivery as d').join('WebhookEndpoint as e', 'e.id', 'd.endpointId').where({ 'd.id': String(id), 'e.organizerId': organizerId }).first('d.*'));
    if (!d) return fail('delivery_not_found', 404);
    const o = plain(await db('OutboxEvent').where({ id: d.outboxEventId }).first());
    const attempts = (await db('WebhookDeliveryAttempt').where({ deliveryId: d.id }).orderBy('attemptNo')).map(attemptView);
    const projected = projectOutbox(o);
    return { delivery: deliveryView(d, o), attempts, payload: projected ? envelopeOf(o, projected) : null, manualRetriesLeft: Math.max(0, 5 - await manualRetriesToday(d.id)) };
  }

  const manualRetriesToday = async deliveryId => Number((await db('AuditLog').where({ target: deliveryId, action: 'events.webhook_delivery_retried' }).where('at', '>=', new Date(+stamp() - DAY)).count({ n: '*' }).first()).n);

  /** Bounded (5 per delivery per 24 h, 30 per endpoint per hour) and idempotent (already queued → 200 alreadyQueued). Same event id, so consumers dedupe. */
  async function retryDelivery({ organizerId, id, actorId }) {
    if (!enabled()) return off();
    const d = plain(await db('WebhookDelivery as d').join('WebhookEndpoint as e', 'e.id', 'd.endpointId').where({ 'd.id': String(id), 'e.organizerId': organizerId }).first('d.*'));
    if (!d) return fail('delivery_not_found', 404);
    if (d.status === 'delivered') return fail('already_delivered', 409);
    if ((d.status === 'pending' || (d.status === 'failed' && d.leaseUntil && +new Date(d.leaseUntil) > +stamp())) && +new Date(d.nextAttemptAt) <= +stamp() + 60_000) return { alreadyQueued: true, delivery: { id: d.id, status: d.status } };
    if (await manualRetriesToday(d.id) >= 5) return fail('rate_limited', 429, { retryAfterSeconds: 3600 });
    const perEndpoint = Number((await db('AuditLog').where({ action: 'events.webhook_delivery_retried' }).where('at', '>=', new Date(+stamp() - HOUR)).whereRaw(`after->>'endpointId' = ?`, [d.endpointId]).count({ n: '*' }).first()).n);
    if (perEndpoint >= 30) return fail('rate_limited', 429, { retryAfterSeconds: 3600 });
    const updated = await db('WebhookDelivery').where({ id: d.id }).whereIn('status', ['failed', 'dead']).update({ status: 'pending', nextAttemptAt: stamp(), leaseUntil: null, manualRetryCount: db.raw('"manualRetryCount" + 1'), updatedAt: stamp() });
    if (!updated) return { alreadyQueued: true, delivery: { id: d.id, status: 'pending' } };
    await audit(actorId, 'events.webhook_delivery_retried', d.id, { status: d.status }, { endpointId: d.endpointId });
    return { queued: true, delivery: { id: d.id, status: 'pending' } };
  }

  async function integrationsHealth({ organizerId }) {
    const rows = (await db('WebhookEndpoint').where({ organizerId })).map(plain);
    const counts = { healthy: 0, degraded: 0, failing: 0, disabled: 0, unverified: 0 };
    for (const e of rows) counts[(await healthOf(e)).health] += 1;
    const dead = Number((await db('WebhookDelivery as d').join('WebhookEndpoint as e', 'e.id', 'd.endpointId').where('e.organizerId', organizerId).where('d.status', 'dead').where('d.lastAttemptAt', '>=', new Date(+stamp() - DAY)).count({ n: '*' }).first()).n);
    return { endpoints: rows.length, ...counts, deadLast24h: dead };
  }

  // ── The dispatcher ────────────────────────────────────────────────────────

  /**
   * Fan out unpublished outbox rows. The organizer match is IN THE SQL JOIN. Rows older than the lag only (a slow transaction
   * could otherwise commit behind the scan). Rows with no organizer, an internal-only type or no matching endpoint are just
   * marked published. Endpoints created later never receive older events.
   */
  async function fanout({ budgetMs = 50_000 } = {}) {
    if (!enabled()) return { skipped: 'no_key', rows: 0, deliveries: 0 };
    const t0 = +stamp();
    let rows = 0; let deliveries = 0;
    for (;;) {
      const batch = await db.transaction(async (trx) => {
        const outbox = (await trx('OutboxEvent').whereNull('publishedAt').where('createdAt', '<', new Date(+stamp() - cfg.lagSeconds() * 1000))
          .orderBy([{ column: 'createdAt' }, { column: 'id' }]).limit(200).forUpdate().skipLocked()).map(plain);
        let made = 0;
        for (const row of outbox) {
          const projected = row.organizerId ? projectOutbox(row) : null;
          if (projected) {
            const res = await trx.raw(`INSERT INTO "WebhookDelivery" (id, "endpointId", "outboxEventId", status, "attemptCount", "nextAttemptAt", "createdAt", "updatedAt")
              SELECT 'whd_' || substr(md5(random()::text || clock_timestamp()::text || e.id), 1, 16), e.id, ?, 'pending', 0, ?, ?, ?
              FROM "WebhookEndpoint" e
              WHERE e."organizerId" = ? AND e.status = 'active' AND e."verifiedAt" IS NOT NULL AND jsonb_exists(e.events, ?)
                AND (e."eventIds" IS NULL OR jsonb_exists(e."eventIds", ?)) AND e."createdAt" <= ?
              ON CONFLICT ("endpointId", "outboxEventId") DO NOTHING`, [row.id, stamp(), stamp(), stamp(), row.organizerId, projected.type, row.eventId, row.createdAt]);
            made += res.rowCount ?? 0;
          }
        }
        if (outbox.length) await trx('OutboxEvent').whereIn('id', outbox.map(o => o.id)).update({ publishedAt: stamp() });
        return { n: outbox.length, made };
      });
      rows += batch.n; deliveries += batch.made;
      if (batch.n < 200 || +stamp() - t0 > budgetMs) break;
    }
    return { rows, deliveries };
  }

  async function claimDue(limit) {
    const { rows } = await db.raw(`UPDATE "WebhookDelivery" SET "leaseUntil" = ?::timestamptz, "updatedAt" = ?
      WHERE id IN (SELECT d.id FROM "WebhookDelivery" d JOIN "WebhookEndpoint" e ON e.id = d."endpointId" JOIN "EventOrganizer" o ON o.id = e."organizerId"
        WHERE d.status IN ('pending', 'failed') AND d."nextAttemptAt" <= ? AND (d."leaseUntil" IS NULL OR d."leaseUntil" < ?)
          AND e.status = 'active' AND e."verifiedAt" IS NOT NULL AND o.status = 'active'
        ORDER BY d."nextAttemptAt" LIMIT ? FOR UPDATE OF d SKIP LOCKED)
      RETURNING *`, [new Date(+stamp() + 60_000), stamp(), stamp(), stamp(), limit]);
    return rows.map(plain);
  }

  async function deadLetter(d, e, o, { outcome, errorCode, trigger }) {
    await attemptRow(e, d.id, d.attemptCount + 1, trigger, { outcome, durationMs: 0, responseCode: null, snippet: null, errorCode });
    await db('WebhookDelivery').where({ id: d.id }).update({ status: 'dead', attemptCount: d.attemptCount + 1, lastAttemptAt: stamp(), lastError: errorCode, nextAttemptAt: null, leaseUntil: null, updatedAt: stamp() });
    void o;
  }

  async function deliverOne(d) {
    const e = plain(await db('WebhookEndpoint').where({ id: d.endpointId }).first());
    const o = plain(await db('OutboxEvent').where({ id: d.outboxEventId }).first());
    if (!e || !o) { await db('WebhookDelivery').where({ id: d.id }).update({ status: 'dead', lastError: 'missing_row', leaseUntil: null, nextAttemptAt: null, updatedAt: stamp() }); return 'dead'; }
    const manualSoFar = Number((await db('WebhookDeliveryAttempt').where({ deliveryId: d.id, trigger: 'manual' }).count({ n: '*' }).first()).n);
    const trigger = d.manualRetryCount > manualSoFar ? 'manual' : 'auto';
    // The last line of isolation: the SQL join already matched organizers; check again, and that the event is the organizer's own.
    const eventOk = !o.eventId || Boolean(await db('Event').where({ id: o.eventId, organizerId: e.organizerId }).first('id'));
    if (!o.organizerId || o.organizerId !== e.organizerId || !eventOk) {
      await deadLetter(d, e, o, { outcome: 'organizer_mismatch', errorCode: 'organizer_mismatch', trigger });
      await audit('system', 'events.webhook_organizer_mismatch', d.id, null, { endpointId: e.id, outboxEventId: o.id, severity: 'high' });
      return 'dead';
    }
    const projected = projectOutbox(o);
    if (!projected || !isSubscribable(projected.type)) { await db('WebhookDelivery').where({ id: d.id }).update({ status: 'dead', lastError: 'not_deliverable', leaseUntil: null, nextAttemptAt: null, updatedAt: stamp() }); return 'dead'; }
    const attemptNo = d.attemptCount + 1;
    const r = await attempt(e, { envelope: envelopeOf(o, projected), eventId: o.id, eventType: projected.type, attemptNo });
    const at = stamp();
    if (r.outcome === 'success') {
      await attemptRow(e, d.id, attemptNo, trigger, r);
      await db('WebhookDelivery').where({ id: d.id }).update({ status: 'delivered', attemptCount: attemptNo, lastAttemptAt: at, deliveredAt: at, responseCode: r.responseCode, lastError: null, nextAttemptAt: null, leaseUntil: null, updatedAt: at });
      await db('WebhookEndpoint').where({ id: e.id }).update({ lastSuccessAt: at, consecutiveFailures: 0, firstFailureAt: null, updatedAt: at });
      return 'delivered';
    }
    const gone = r.outcome === 'gone';
    const exhausted = attemptNo >= cfg.maxAttempts();
    const dead = gone || exhausted;
    const next = dead ? null : new Date(+at + retryDelayMs(attemptNo, random));
    await attemptRow(e, d.id, attemptNo, trigger, r, next);
    await db('WebhookDelivery').where({ id: d.id }).update({
      status: dead ? 'dead' : 'failed', attemptCount: attemptNo, lastAttemptAt: at, responseCode: r.responseCode, lastError: r.errorCode ?? r.outcome, nextAttemptAt: next, leaseUntil: null, updatedAt: at,
    });
    await db('WebhookEndpoint').where({ id: e.id }).update({ consecutiveFailures: db.raw('"consecutiveFailures" + 1'), firstFailureAt: db.raw('COALESCE("firstFailureAt", ?::timestamptz)', [at]), updatedAt: at });
    if (gone) await autoDisable(e, 'endpoint_gone');
    else await maybeAutoDisable(e.id);
    return dead ? 'dead' : 'failed';
  }

  async function autoDisable(e, reason) {
    const changed = await db('WebhookEndpoint').where({ id: e.id, status: 'active' }).update({ status: 'disabled', disabledReason: reason, disabledAt: stamp(), updatedAt: stamp() });
    if (!changed) return false;
    await audit('system', 'events.webhook_auto_disabled', e.id, { status: 'active' }, { reason });
    const host = hostOf(e.url) ?? 'endpoint';
    await tellTeam(e.organizerId, {
      id: `ntf_evwhd_${e.id}_${Math.floor(+stamp() / DAY)}`, type: 'organizer_webhook_auto_disabled',
      en: { title: 'Webhook turned off', body: `Webhook ${host} was turned off after repeated failures.` }, sw: { title: 'Webhook imezimwa', body: `Webhook ${host} imezimwa baada ya majaribio mengi kushindikana.` },
    });
    return true;
  }

  /** 30 consecutive failures with the first one 24 h ago, or no success for 72 h with at least 10 failed deliveries. */
  async function maybeAutoDisable(endpointId) {
    const e = plain(await db('WebhookEndpoint').where({ id: endpointId }).first());
    if (!e || e.status !== 'active') return false;
    const at = +stamp();
    if (e.consecutiveFailures >= 30 && e.firstFailureAt && +new Date(e.firstFailureAt) <= at - DAY) return autoDisable(e, 'auto_failures');
    const noSuccess72 = (!e.lastSuccessAt || +new Date(e.lastSuccessAt) < at - 3 * DAY) && +new Date(e.createdAt) <= at - 3 * DAY;
    if (noSuccess72) {
      const failed = Number((await db('WebhookDelivery').where({ endpointId }).whereIn('status', ['failed', 'dead']).where('lastAttemptAt', '>=', new Date(at - 3 * DAY)).count({ n: '*' }).first()).n);
      if (failed >= 10) return autoDisable(e, 'auto_failures');
    }
    return false;
  }

  /** Deliver what is due: claim with a lease (no transaction held across HTTP), concurrency 10 overall and 2 per host. */
  async function deliverDue({ budgetMs = 50_000 } = {}) {
    if (!enabled()) return { skipped: 'no_key', claimed: 0, delivered: 0, failed: 0, dead: 0 };
    const t0 = +stamp();
    const stats = { claimed: 0, delivered: 0, failed: 0, dead: 0 };
    for (;;) {
      const claimed = await claimDue(cfg.batch());
      stats.claimed += claimed.length;
      if (!claimed.length) break;
      const endpoints = new Map((await db('WebhookEndpoint').whereIn('id', [...new Set(claimed.map(d => d.endpointId))]).select('id', 'url')).map(e => [e.id, hostOf(e.url) ?? e.id]));
      const byHost = new Map();
      for (const d of claimed) { const h = endpoints.get(d.endpointId); byHost.set(h, [...(byHost.get(h) ?? []), d]); }
      const hostTasks = [...byHost.values()].map(list => async () => {
        const queue = [...list];
        await Promise.all(Array.from({ length: Math.min(2, queue.length) }, async () => {
          while (queue.length) {
            const d = queue.shift();
            let outcome;
            try { outcome = await deliverOne(d); } catch (err) { console.warn('[events] webhook delivery error:', d.id, err?.message); await db('WebhookDelivery').where({ id: d.id }).update({ leaseUntil: null, updatedAt: stamp() }).catch(() => {}); outcome = 'failed'; }
            stats[outcome] = (stats[outcome] ?? 0) + 1;
          }
        }));
      });
      await runPool(hostTasks, 10);
      if (claimed.length < cfg.batch() || +stamp() - t0 > budgetMs) break;
    }
    const oldest = await db('WebhookDelivery').whereIn('status', ['pending', 'failed']).min({ m: 'createdAt' }).first();
    return { ...stats, oldestPendingAgeSeconds: oldest?.m ? Math.round((+stamp() - +new Date(oldest.m)) / 1000) : 0 };
  }

  /** Daily: attempts 30 days, deliveries and published outbox 90 days, idempotency 7 days. */
  async function retention() {
    const at = +stamp();
    const attempts = await db('WebhookDeliveryAttempt').where('startedAt', '<', new Date(at - 30 * DAY)).del();
    const deliveries = await db('WebhookDelivery').where('createdAt', '<', new Date(at - 90 * DAY)).whereIn('status', ['delivered', 'dead']).del();
    const outbox = await db('OutboxEvent').whereNotNull('publishedAt').where('createdAt', '<', new Date(at - 90 * DAY)).del();
    const idempotency = await db('OrganizerIdempotency').where('expiresAt', '<', new Date(at)).del();
    return { attempts, deliveries, outbox, idempotency };
  }

  return {
    enabled, createEndpoint, listEndpoints, getEndpoint, updateEndpoint, verifyEndpoint, testSend, rotateSecret, disableEndpoint, enableEndpoint,
    listDeliveries, getDelivery, retryDelivery, integrationsHealth, adminDisableAll, adminSummary, fanout, deliverDue, retention,
    internals: { attempt, healthOf, maybeAutoDisable, deliverOne, claimDue },
  };
}
