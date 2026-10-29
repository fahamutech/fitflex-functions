// Marathon & running events · S5 — API clients (spec §5.1) and the SQL side of organizer API authentication.
// Management is for a signed-in organizer OWNER or ADMIN (webhooks:manage: owner only, D38). The pilot gate (D39): an
// organizer can create or use API clients only when a FitFlex admin has enabled it (EventOrganizer.apiAccessEnabledAt)
// or its id is in EVENTS_API_ORGANIZER_ALLOWLIST. The secret is returned once, at create and at rotate, and is never
// written to a log, an audit row, an analytics row or an error body.
import { randomUUID } from 'node:crypto';
import { newClientId, newClientSecret, hashSecret, FAILURES_BEFORE_LOCK } from '../auth/organizer-api-auth.mjs';

const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const plain = row => (row ? JSON.parse(JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? Number(v) : v))) : null);
const iso = v => (v ? new Date(v).toISOString() : null);
const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

export const API_SCOPES = Object.freeze(['registrations:read', 'registrations:demographics', 'kit:write', 'bibs:write', 'webhooks:manage', 'results:write']);
export const SELECTABLE_SCOPES = Object.freeze(['registrations:read', 'registrations:demographics', 'kit:write', 'bibs:write', 'webhooks:manage']);
export const RESERVED_SCOPES = Object.freeze(['results:write']);
export const SANDBOX_EVENT_ID = 'evt_sandbox';
export const GRACE_HOURS = Object.freeze([0, 24, 72]);
const DAY = 86_400_000;

export function createEventsIntegrationsService({
  db, notify = async () => {}, localeOf = async () => null, now = () => new Date(),
  maxClients = () => 10, defaultRate = () => 120, tokenTtlSeconds = () => 900, allowlist = () => new Set(),
}) {
  const stamp = () => new Date(now());
  const audit = (actor, action, target, before, after) => db('AuditLog').insert({
    id: `aud_${randomUUID().slice(0, 12)}`, at: stamp(), actor, action, target,
    before: before == null ? null : JSON.stringify(before), after: after == null ? null : JSON.stringify(after),
  });

  // ── The SQL side of organizer-api-auth.mjs ────────────────────────────────

  const joined = () => db('ApiClient as c').join('EventOrganizer as o', 'o.id', 'c.ownerId').where('c.ownerType', 'organizer')
    .select('c.*', 'o.status as organizerStatus', 'o.apiAccessEnabledAt as organizerApiAccess');
  const gateOpen = row => Boolean(row.organizerApiAccess) || allowlist().has(row.ownerId);
  const shape = row => (row ? { ...plain(row), apiAccessEnabled: gateOpen(row) } : null);

  const authStore = {
    findById: async id => shape(await joined().where('c.id', String(id)).first()),
    findByClientId: async clientId => shape(await joined().where('c.clientId', String(clientId)).first()),
    /** Atomic: count the failure; at the threshold lock the client for `lockMinutes`. → { failedAttempts, lockedUntil } */
    noteFailure: async (id, { threshold = FAILURES_BEFORE_LOCK, lockMinutes = 15, at = stamp() } = {}) => {
      const { rows } = await db.raw(`UPDATE "ApiClient" SET "failedAttempts" = "failedAttempts" + 1,
          "lockedUntil" = CASE WHEN "failedAttempts" + 1 >= ? THEN ?::timestamptz ELSE "lockedUntil" END, "updatedAt" = ?
        WHERE id = ? RETURNING "failedAttempts", "lockedUntil"`, [threshold, new Date(+at + lockMinutes * 60_000), at, id]);
      return rows[0] ?? null;
    },
    clearFailures: async id => db('ApiClient').where({ id }).update({ failedAttempts: 0, lockedUntil: null }),
    touch: async id => db('ApiClient').where({ id }).update({ lastUsedAt: stamp() }),
  };

  // ── Views and helpers ─────────────────────────────────────────────────────

  const clientView = (c, creatorName = null) => {
    const at = +stamp();
    const inGrace = Boolean(c.previousSecretHash) && +new Date(c.previousSecretExpiresAt) > at;
    const expired = c.expiresAt && +new Date(c.expiresAt) <= at;
    return {
      id: c.id, clientId: c.clientId, name: c.name, environment: c.environment, scopes: c.scopes, eventIds: c.eventIds ?? null,
      status: c.status === 'active' && expired ? 'expired' : c.status, expiresAt: iso(c.expiresAt), lastUsedAt: iso(c.lastUsedAt), createdAt: iso(c.createdAt),
      createdBy: { name: creatorName }, rateLimitPerMinute: c.rateLimitPerMinute, rotation: { inGrace, graceEndsAt: inGrace ? iso(c.previousSecretExpiresAt) : null },
    };
  };
  const creatorsOf = async rows => {
    const ids = [...new Set(rows.map(r => r.createdBy).filter(Boolean))];
    return new Map(ids.length ? (await db('User').whereIn('id', ids).select('id', 'displayName')).map(u => [u.id, u.displayName]) : []);
  };
  const gate = async organizerId => {
    const o = plain(await db('EventOrganizer').where({ id: organizerId }).first('id', 'apiAccessEnabledAt', 'ownerUserId', 'name'));
    return { organizer: o, open: Boolean(o?.apiAccessEnabledAt) || allowlist().has(organizerId) };
  };
  const own = async (organizerId, id) => plain(await db('ApiClient').where({ id: String(id), ownerType: 'organizer', ownerId: organizerId }).first());

  const nameOf = async userId => (userId ? (plain(await db('User').where({ id: userId }).first('displayName'))?.displayName ?? null) : null);

  async function tellOwners(organizerId, { id, type, en, sw }) {
    const staff = await db('EventOrganizerStaff').where({ organizerId, status: 'active' }).whereIn('role', ['owner']).select('userId');
    for (const s of staff) {
      try {
        let locale = null;
        try { locale = await localeOf(s.userId); } catch { locale = null; }
        const t = locale === 'sw' ? sw : en;
        await notify(s.userId, { id: `${id}_${s.userId}`.slice(0, 60), type, title: t.title, body: t.body, data: { organizerId, route: '/organizer/integrations?tab=clients', locale: locale === 'sw' ? 'sw' : 'en', titleEn: en.title, bodyEn: en.body, titleSw: sw.title, bodySw: sw.body } });
      } catch { /* a notice that cannot be sent must not undo the change */ }
    }
  }

  function parseScopes(raw, { role, environment, current = [] }) {
    if (!Array.isArray(raw) || !raw.length) return fail('validation_failed', 422, { fields: [{ path: 'scopes', code: 'required' }] });
    const scopes = [...new Set(raw)];
    for (const s of scopes) {
      if (typeof s !== 'string' || !API_SCOPES.includes(s)) return fail('invalid_scope', 422, { scope: typeof s === 'string' ? s.slice(0, 40) : null });
      if (RESERVED_SCOPES.includes(s)) return fail('scope_not_available', 422, { scope: s });
    }
    if (scopes.includes('webhooks:manage') && !current.includes('webhooks:manage')) {
      if (role !== 'owner') return fail('forbidden_role', 403, { requiredRoles: ['owner'], scope: 'webhooks:manage' });
      if (environment === 'sandbox') return fail('scope_not_available', 422, { scope: 'webhooks:manage', reason: 'sandbox' });
    }
    if ((scopes.includes('kit:write') || scopes.includes('bibs:write') || scopes.includes('registrations:demographics')) && !scopes.includes('registrations:read')) {
      return fail('validation_failed', 422, { fields: [{ path: 'scopes', code: 'requires_registrations_read' }] });
    }
    return { scopes };
  }

  async function parseEventIds(organizerId, raw, environment) {
    if (environment === 'sandbox') return { eventIds: [SANDBOX_EVENT_ID] };
    if (raw === undefined || raw === null) return { eventIds: null };
    if (!Array.isArray(raw) || raw.length > 100 || raw.some(x => typeof x !== 'string')) return fail('validation_failed', 422, { fields: [{ path: 'eventIds', code: 'invalid' }] });
    const ids = [...new Set(raw)];
    if (!ids.length) return fail('validation_failed', 422, { fields: [{ path: 'eventIds', code: 'required' }] });
    const found = await db('Event').where({ organizerId }).whereIn('id', ids).count({ n: '*' }).first();
    if (Number(found.n) !== ids.length) return fail('validation_failed', 422, { fields: [{ path: 'eventIds', code: 'unknown_event' }] });
    return { eventIds: ids };
  }

  // ── Management (spec §5.1) ────────────────────────────────────────────────

  async function createClient({ ctx: ctx0, actorId, body = {} }) {
    const ctx = { ...ctx0, actorName: await nameOf(actorId) };
    const organizerId = ctx.organizer.id;
    const g = await gate(organizerId);
    if (!g.open) return fail('api_access_not_enabled', 403);
    const name = text(body.name, 60);
    if (!name) return fail('validation_failed', 422, { fields: [{ path: 'name', code: 'required' }] });
    if (!['live', 'sandbox'].includes(body.environment)) return fail('validation_failed', 422, { fields: [{ path: 'environment', code: 'invalid' }] });
    const parsedScopes = parseScopes(body.scopes, { role: ctx.role, environment: body.environment });
    if (parsedScopes.error) return parsedScopes;
    const parsedEvents = await parseEventIds(organizerId, body.eventIds, body.environment);
    if (parsedEvents.error) return parsedEvents;
    const days = body.expiresInDays === undefined ? 365 : body.expiresInDays;
    if (!Number.isInteger(days) || days < 1 || days > 730) return fail('validation_failed', 422, { fields: [{ path: 'expiresInDays', code: 'range', min: 1, max: 730 }] });
    const active = Number((await db('ApiClient').where({ ownerType: 'organizer', ownerId: organizerId, status: 'active' }).count({ n: '*' }).first()).n);
    if (active >= maxClients()) return fail('client_limit_reached', 409, { max: maxClients() });
    const at = stamp();
    const secret = newClientSecret(body.environment);
    const row = {
      id: `acl_${randomUUID().replace(/-/g, '').slice(0, 16)}`, ownerType: 'organizer', ownerId: organizerId, clientId: newClientId(), secretHash: hashSecret(secret),
      scopes: JSON.stringify(parsedScopes.scopes), status: 'active', expiresAt: new Date(+at + days * DAY), name, environment: body.environment,
      eventIds: parsedEvents.eventIds ? JSON.stringify(parsedEvents.eventIds) : null, createdBy: actorId, secretVersion: 1, rateLimitPerMinute: defaultRate(), createdAt: at, updatedAt: at,
    };
    const [saved] = await db('ApiClient').insert(row).returning('*');
    await audit(actorId, 'events.api_client_created', saved.id, null, { clientId: saved.clientId, name, environment: body.environment, scopes: parsedScopes.scopes, eventIds: parsedEvents.eventIds, expiresAt: iso(row.expiresAt) });
    await tellOwners(organizerId, {
      id: `ntf_evapic_${saved.id}`, type: 'organizer_api_client_created',
      en: { title: 'API client created', body: `An API client ${name} was created by ${ctx.actorName ?? 'a team member'}.` }, sw: { title: 'Mteja wa API ameundwa', body: `Mteja wa API ${name} ameundwa na ${ctx.actorName ?? 'mwanachama wa timu'}.` },
    });
    return { status: 201, client: clientView(plain(saved), ctx.actorName ?? null), clientSecret: secret };
  }

  async function listClients({ ctx }) {
    const rows = (await db('ApiClient').where({ ownerType: 'organizer', ownerId: ctx.organizer.id }).orderBy([{ column: 'createdAt', order: 'desc' }, { column: 'id', order: 'desc' }])).map(plain);
    const names = await creatorsOf(rows);
    const g = await gate(ctx.organizer.id);
    return { items: rows.map(r => clientView(r, names.get(r.createdBy) ?? null)), max: maxClients(), accessEnabled: g.open };
  }

  async function getClient({ ctx, id }) {
    const row = await own(ctx.organizer.id, id);
    if (!row) return fail('client_not_found', 404);
    const since = new Date(+stamp() - 30 * DAY).toISOString().slice(0, 10);
    const usage = (await db('ApiClientUsageDay').where({ apiClientId: row.id }).where('day', '>=', since).orderBy('day')).map(u => ({ day: new Date(u.day).toISOString().slice(0, 10), requests: u.requests, errors: u.errors, rateLimited: u.rateLimited }));
    const names = await creatorsOf([row]);
    const history = (await db('AuditLog').where({ target: row.id }).whereLike('action', 'events.api_client_%').orderBy('at', 'desc').limit(20)).map(a => ({ at: iso(a.at), action: a.action, actor: a.actor === 'system' ? 'system' : 'staff' }));
    return { client: clientView(row, names.get(row.createdBy) ?? null), usage: { days: usage }, history };
  }

  async function updateClient({ ctx, id, actorId, body = {} }) {
    const row = await own(ctx.organizer.id, id);
    if (!row) return fail('client_not_found', 404);
    if (row.status !== 'active') return fail('client_not_active', 409);
    const patch = {};
    if (body.name !== undefined) { const n = text(body.name, 60); if (!n) return fail('validation_failed', 422, { fields: [{ path: 'name', code: 'required' }] }); patch.name = n; }
    if (body.scopes !== undefined) {
      const parsed = parseScopes(body.scopes, { role: ctx.role, environment: row.environment, current: row.scopes });
      if (parsed.error) return parsed;
      patch.scopes = JSON.stringify(parsed.scopes);
    }
    if (body.eventIds !== undefined) {
      const parsed = await parseEventIds(ctx.organizer.id, body.eventIds, row.environment);
      if (parsed.error) return parsed;
      patch.eventIds = parsed.eventIds ? JSON.stringify(parsed.eventIds) : null;
    }
    if (body.expiresAt !== undefined) {
      const at = new Date(body.expiresAt);
      if (Number.isNaN(+at) || +at <= +stamp() || +at > +stamp() + 730 * DAY) return fail('validation_failed', 422, { fields: [{ path: 'expiresAt', code: 'range' }] });
      patch.expiresAt = at;
    }
    if (!Object.keys(patch).length) return fail('validation_failed', 422, { fields: [{ path: 'body', code: 'empty' }] });
    const [saved] = await db('ApiClient').where({ id: row.id }).update({ ...patch, updatedAt: stamp() }).returning('*');
    await audit(actorId, 'events.api_client_updated', row.id, { name: row.name, scopes: row.scopes, eventIds: row.eventIds, expiresAt: iso(row.expiresAt) },
      { name: saved.name, scopes: saved.scopes, eventIds: saved.eventIds, expiresAt: iso(saved.expiresAt), scopesAdded: (saved.scopes ?? []).filter(s => !(row.scopes ?? []).includes(s)) });
    return { client: clientView(plain(saved), null) };
  }

  /** New secret, shown once. graceHours 0: the old one dies now. 24 | 72: both work until then; a second rotation replaces the previous secret (only one old secret ever lives). */
  async function rotateClient({ ctx: ctx0, id, actorId, body = {} }) {
    const ctx = { ...ctx0, actorName: await nameOf(actorId) };
    const row = await own(ctx.organizer.id, id);
    if (!row) return fail('client_not_found', 404);
    if (row.status !== 'active') return fail('client_not_active', 409);
    const grace = body.graceHours === undefined ? 24 : body.graceHours;
    if (!GRACE_HOURS.includes(grace)) return fail('validation_failed', 422, { fields: [{ path: 'graceHours', code: 'invalid', allowed: [...GRACE_HOURS] }] });
    const at = stamp();
    const secret = newClientSecret(row.environment);
    const [saved] = await db('ApiClient').where({ id: row.id, status: 'active' }).update({
      secretHash: hashSecret(secret), secretVersion: row.secretVersion + 1, rotatedAt: at, failedAttempts: 0, lockedUntil: null, updatedAt: at,
      previousSecretHash: grace > 0 ? row.secretHash : null, previousSecretExpiresAt: grace > 0 ? new Date(+at + grace * 3_600_000) : null,
    }).returning('*');
    if (!saved) return fail('client_not_active', 409);
    await audit(actorId, 'events.api_client_rotated', row.id, null, { clientId: row.clientId, graceHours: grace });
    await tellOwners(ctx.organizer.id, {
      id: `ntf_evapir_${row.id}_${saved.secretVersion}`, type: 'organizer_api_client_rotated',
      en: { title: 'API client secret changed', body: `The secret of API client ${row.name} was changed by ${ctx.actorName ?? 'a team member'}.` }, sw: { title: 'Siri ya mteja wa API imebadilishwa', body: `Siri ya mteja wa API ${row.name} imebadilishwa na ${ctx.actorName ?? 'mwanachama wa timu'}.` },
    });
    return { client: clientView(plain(saved), null), clientSecret: secret };
  }

  async function revokeClient({ ctx: ctx0, id, actorId, body = {}, system = false }) {
    const ctx = { ...ctx0, actorName: await nameOf(actorId) };
    const row = await own(ctx.organizer.id, id);
    if (!row) return fail('client_not_found', 404);
    if (row.status === 'revoked') return { client: clientView(row, null), changed: false };
    const at = stamp();
    const [saved] = await db('ApiClient').where({ id: row.id, status: 'active' }).update({ status: 'revoked', revokedAt: at, previousSecretHash: null, previousSecretExpiresAt: null, updatedAt: at }).returning('*');
    if (!saved) return { client: clientView((await own(ctx.organizer.id, id)), null), changed: false };
    await audit(actorId, 'events.api_client_revoked', row.id, { status: 'active' }, { clientId: row.clientId, ...(text(body.reason, 300) ? { reason: text(body.reason, 300) } : {}) });
    if (!system) {
      await tellOwners(ctx.organizer.id, {
        id: `ntf_evapiv_${row.id}`, type: 'organizer_api_client_revoked',
        en: { title: 'API client revoked', body: `API client ${row.name} was revoked by ${ctx.actorName ?? 'a team member'}.` }, sw: { title: 'Mteja wa API amefutwa', body: `Mteja wa API ${row.name} amefutwa na ${ctx.actorName ?? 'mwanachama wa timu'}.` },
      });
    }
    return { client: clientView(plain(saved), null), changed: true };
  }

  // ── Usage, token-failure records, sweeps ──────────────────────────────────

  /** Add to today's counters (UTC day). Best effort: a counter that fails must not fail the request. */
  async function recordUsage(apiClientId, { requests = 0, errors = 0, rateLimited = 0 } = {}) {
    try {
      const day = stamp().toISOString().slice(0, 10);
      await db.raw(`INSERT INTO "ApiClientUsageDay" (id, "apiClientId", day, requests, errors, "rateLimited") VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT ("apiClientId", day) DO UPDATE SET requests = "ApiClientUsageDay".requests + EXCLUDED.requests, errors = "ApiClientUsageDay".errors + EXCLUDED.errors, "rateLimited" = "ApiClientUsageDay"."rateLimited" + EXCLUDED."rateLimited"`,
      [`acu_${randomUUID().replace(/-/g, '').slice(0, 16)}`, apiClientId, day, requests, errors, rateLimited]);
    } catch { /* counters are best effort */ }
  }

  const failureLog = new Map();
  /** One audit row per client per 5 minutes (aggregated), carrying the REAL reason; a lock also tells the organizer owner. Never the id or secret presented. */
  async function recordTokenFailure(result, { ip = null } = {}) {
    const client = result.client;
    if (!client) return;
    const t = +stamp();
    if (t - (failureLog.get(client.id) ?? 0) >= 300_000) {
      if (failureLog.size > 5000) failureLog.clear();
      failureLog.set(client.id, t);
      await audit('system', 'events.api_token_failed', client.id, null, { clientId: client.clientId, reason: result.reason, ...(ip ? { ip } : {}) });
    }
    if (result.locked?.lockedUntil && result.locked.failedAttempts === FAILURES_BEFORE_LOCK) {
      await tellOwners(client.ownerId, {
        id: `ntf_evapil_${client.id}_${Math.floor(t / 900_000)}`, type: 'organizer_api_client_locked',
        en: { title: 'API client locked', body: `API client ${client.name} was locked for 15 minutes after repeated wrong secrets.` }, sw: { title: 'Mteja wa API amefungwa', body: `Mteja wa API ${client.name} amefungwa kwa dakika 15 baada ya siri zisizo sahihi kurudiwa.` },
      });
    }
  }

  /** Expiring-soon notices (14 and 3 days) and the retention of usage rows (90 days). Called by the daily retention job. */
  async function sweep() {
    const at = stamp();
    let notices = 0;
    for (const days of [14, 3]) {
      const lo = new Date(+at + (days - 1) * DAY); const hi = new Date(+at + days * DAY);
      const rows = (await db('ApiClient').where({ ownerType: 'organizer', status: 'active' }).where('expiresAt', '>', lo).where('expiresAt', '<=', hi)).map(plain);
      for (const c of rows) {
        await tellOwners(c.ownerId, {
          id: `ntf_evapie_${c.id}_${days}`, type: 'organizer_api_client_expiring',
          en: { title: 'API client expires soon', body: `API client ${c.name} expires in ${days} days.` }, sw: { title: 'Mteja wa API anaisha karibuni', body: `Mteja wa API ${c.name} anaisha baada ya siku ${days}.` },
        });
        notices += 1;
      }
    }
    const purged = await db('ApiClientUsageDay').where('day', '<', new Date(+at - 90 * DAY).toISOString().slice(0, 10)).del();
    return { notices, purged };
  }

  // ── FitFlex admin (scope `events`) ────────────────────────────────────────

  async function adminSetApiAccess({ organizerId, enabled, reason, actorId }) {
    const why = text(reason, 300);
    if (!why || why.length < 10) return fail('reason_required', 422, { min: 10, max: 300 });
    const o = plain(await db('EventOrganizer').where({ id: String(organizerId) }).first('id', 'apiAccessEnabledAt'));
    if (!o) return fail('organizer_not_found', 404);
    const at = stamp();
    await db('EventOrganizer').where({ id: o.id }).update({ apiAccessEnabledAt: enabled === true ? at : null, updatedAt: at });
    await audit(actorId, 'events.api_access_changed', o.id, { enabled: Boolean(o.apiAccessEnabledAt) }, { enabled: enabled === true, reason: why });
    return { organizerId: o.id, apiAccessEnabled: enabled === true };
  }

  async function adminRevokeAll({ organizerId, reason, actorId }) {
    const why = text(reason, 300);
    if (!why || why.length < 10) return fail('reason_required', 422, { min: 10, max: 300 });
    const at = stamp();
    const rows = await db('ApiClient').where({ ownerType: 'organizer', ownerId: String(organizerId), status: 'active' }).update({ status: 'revoked', revokedAt: at, previousSecretHash: null, previousSecretExpiresAt: null, updatedAt: at }).returning('id');
    await audit(actorId, 'events.admin_api_clients_revoked', String(organizerId), null, { count: rows.length, reason: why });
    return { revoked: rows.length };
  }

  async function adminSetRate({ clientId, rateLimitPerMinute, actorId }) {
    if (!Number.isInteger(rateLimitPerMinute) || rateLimitPerMinute < 1 || rateLimitPerMinute > 600) return fail('validation_failed', 422, { fields: [{ path: 'rateLimitPerMinute', code: 'range', min: 1, max: 600 }] });
    const [saved] = await db('ApiClient').where({ id: String(clientId) }).update({ rateLimitPerMinute, updatedAt: stamp() }).returning('id');
    if (!saved) return fail('client_not_found', 404);
    await audit(actorId, 'events.api_client_updated', saved.id, null, { rateLimitPerMinute });
    return { id: saved.id, rateLimitPerMinute };
  }

  async function adminSummary({ organizerId }) {
    const clients = await db('ApiClient').where({ ownerType: 'organizer', ownerId: String(organizerId) }).groupBy('status').select('status').count({ n: '*' });
    const o = plain(await db('EventOrganizer').where({ id: String(organizerId) }).first('apiAccessEnabledAt'));
    return { apiAccessEnabled: Boolean(o?.apiAccessEnabledAt) || allowlist().has(String(organizerId)), activeClients: Number(clients.find(c => c.status === 'active')?.n ?? 0) };
  }

  /** The API half of GET /organizer/integrations/health. */
  async function apiHealth({ organizerId }) {
    const rows = (await db('ApiClient').where({ ownerType: 'organizer', ownerId: organizerId, status: 'active' }).select('expiresAt')).map(plain);
    const at = +stamp();
    return { active: rows.filter(r => !r.expiresAt || +new Date(r.expiresAt) > at).length, expiringSoon: rows.filter(r => r.expiresAt && +new Date(r.expiresAt) > at && +new Date(r.expiresAt) <= at + 14 * DAY).length };
  }

  return {
    authStore, createClient, listClients, getClient, updateClient, rotateClient, revokeClient, recordUsage, recordTokenFailure, sweep,
    adminSetApiAccess, adminRevokeAll, adminSetRate, adminSummary, apiHealth, tokenTtlSeconds,
  };
}
