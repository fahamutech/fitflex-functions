// Marathon & running events · S5 — the ORGANIZER API for API-key callers (spec §5; D5: `/v1/organizer` is for API clients only).
// OWNER REVIEW (D35). Every route answers 404 feature_disabled unless EVENTS_MODULE, EVENTS_REGISTRATION and EVENTS_ORGANIZER_API are on.
//   POST /v1/organizer/token         the ONLY route that sees a client secret (client credentials → a 15-minute bearer token)
//   GET  /v1/organizer/openapi.json  the contract (public, cacheable)
//   everything else                  Authorization: Bearer <access_token>; scope, event restriction, revocation, expiry and the
//                                    organizer's standing are read from the ApiClient row on EVERY call (src/auth/organizer-api-auth.mjs)
// bfast mounts every onGuard with a method-blind prefix match, so EVERY guard here is wrapped in routeGuard(method, …). A staff JWT is
// refused here (401 invalid_token) and an API token is refused on /organizer/* (requireAuth rejects any token with a purpose).
// Responses: camelCase JSON, errors { error, …extra } (D5), X-Request-Id on every response, 5xx bodies carry requestId, no request body is logged.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import '../src/bootstrap/init.mjs';
import { requireApiClient, exchangeClientCredentials, SECRET_RE, CLIENT_ID_RE } from '../src/auth/organizer-api-auth.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { requireEventsOrganizerApi, requireEventsWebhooks, requireEventsResults, eventsKitOpsOn as kitOpsGate } from '../src/shared/feature-flags.mjs';
import { eventsOpsService as ops, eventsSyncService as sync, eventsIntegrationsService as integrations, eventsWebhookService as hooks, eventsResultsService as results } from '../src/bootstrap/services.mjs';
import * as sandbox from '../src/shared/organizer-api-sandbox.mjs';

void SECRET_RE; void CLIENT_ID_RE;
const created = new Date().toISOString();
// Read once at load (a request never touches the disk); a copy is served so PUBLIC_API_URL can be applied.
const OPENAPI = JSON.parse(readFileSync(new URL('../docs/api/organizer-api-v1.openapi.json', import.meta.url), 'utf8'));

const requestIdOf = (req) => {
  const given = String(req.headers?.['x-request-id'] ?? '');
  return /^[A-Za-z0-9._-]{8,64}$/.test(given) ? given : `req_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
};
/** First guard of every /v1 route: stamp X-Request-Id on the response. */
function requestIdGuard(req, res, next) {
  req.requestId = requestIdOf(req);
  res.set?.('X-Request-Id', req.requestId);
  next();
}
/** The closest proxy's address (the LAST X-Forwarded-For entry; the first is client-controlled), like the other public limiters. */
const addressOf = req => String(req.headers?.['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean).pop() || req.ip || req.socket?.remoteAddress || 'anon';

/** requireApiClient + the usage counter for a rate-limited call (the handler never runs for it). */
function authed(...scopes) {
  const guard = requireApiClient(...scopes);
  return async (req, res, next) => {
    await guard(req, res, next);
    if (req.apiClientRateLimited) integrations.recordUsage(req.apiClientRateLimited, { requests: 1, rateLimited: 1 }).catch(() => {});
  };
}
const v1Guard = (method, ...scopes) => routeGuard(method, [requestIdGuard, requireEventsOrganizerApi, authed(...scopes)]);
const noSandbox = (req, res, next) => (req.apiClient?.environment === 'sandbox' ? res.status(403).json({ error: 'sandbox_not_supported' }) : next());
const v1HookGuard = (method) => routeGuard(method, [requestIdGuard, requireEventsOrganizerApi, requireEventsWebhooks, authed('webhooks:manage'), noSandbox]);

function reply(req, res, result, okStatus = 200) {
  let status = okStatus; let body;
  if (result?.error) { const { error, status: s, ...extra } = result; status = s || 400; body = { error, ...extra }; } else {
    const { status: s, replayed, ...rest } = result ?? {};
    if (replayed) res.set?.('Idempotent-Replayed', 'true');
    if (Number.isInteger(s)) status = s;
    body = rest;
  }
  if (status >= 500) body = { ...body, requestId: req.requestId };
  if (req.apiClient) integrations.recordUsage(req.apiClient.id, { requests: 1, errors: status >= 400 ? 1 : 0 }).catch(() => {});
  return res.status(status).json(body);
}
/** A handler that cannot throw into the platform: an unexpected error is a 500 with the request id and nothing else. */
const guarded = handler => async (req, res) => {
  try {
    if (req.apiClient?.environment === 'sandbox') res.set?.('X-FitFlex-Sandbox', 'true');
    return await handler(req, res);
  } catch (err) {
    console.error(`[events-api] ${req.requestId ?? ''} ${err?.message}`);
    return reply(req, res, { error: 'internal_error', status: 500 });
  }
};

const apiActor = req => ({ kind: 'api', clientId: req.apiClient.id, scopes: req.apiClient.scopes, requestId: req.requestId });
const idemKey = req => req.headers?.['idempotency-key'];
const outOfScope = (req, eventId) => Array.isArray(req.apiClient.eventIds) && !req.apiClient.eventIds.includes(String(eventId));
const notFound = () => ({ error: 'event_not_found', status: 404 });
const isSandbox = req => req.apiClient.environment === 'sandbox';
const wantsDemographics = req => req.apiClient.scopes.includes('registrations:demographics');

// ── Token and contract (no bearer) ────────────────────────────────────────

function credentialsOf(req) {
  const basic = /^Basic\s+(.+)$/i.exec(String(req.headers?.authorization ?? ''));
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (basic) {
    const text = Buffer.from(basic[1], 'base64').toString('utf8');
    const at = text.indexOf(':');
    return { grantType: body.grant_type, clientId: at >= 0 ? text.slice(0, at) : text, clientSecret: at >= 0 ? text.slice(at + 1) : '' };
  }
  return { grantType: body.grant_type, clientId: body.client_id, clientSecret: body.client_secret };
}

export const apiToken = {
  created, method: 'post', path: '/v1/organizer/token',
  description: 'API client (EVENTS_ORGANIZER_API): exchange client credentials for a short-lived bearer token. JSON body { grant_type: "client_credentials", client_id, client_secret } or HTTP Basic (client_id:client_secret) with grant_type in the body. This is the ONLY route that accepts the secret. → 200 { access_token, token_type: "Bearer", expires_in: 900 } (no-store). EVERY failed exchange — unknown id, wrong secret, revoked, expired, malformed — is the same 401 { error: "invalid_client" } (the real reason goes to the audit log). 400 invalid_request (grant_type missing or not client_credentials); 403 organizer_suspended | organizer_not_active | api_access_not_enabled (only to a caller holding the right secret); 429 rate_limited + Retry-After (only FAILED exchanges are counted: 10/min per client_id, 20/min per source address; valid credentials are never blocked and a client is never locked out; many failures in an hour are reported to the owner).',
  onGuard: routeGuard('post', [requestIdGuard, requireEventsOrganizerApi]),
  onRequest: guarded(async (req, res) => {
    res.set?.('Cache-Control', 'no-store');
    res.set?.('Pragma', 'no-cache');
    const creds = credentialsOf(req);
    if (creds.grantType !== 'client_credentials') return reply(req, res, { error: 'invalid_request', status: 400 });
    const ip = addressOf(req);
    const result = await exchangeClientCredentials({ clientId: creds.clientId, clientSecret: creds.clientSecret, ip, ttlSeconds: integrations.tokenTtlSeconds() });
    if (!result.ok) {
      await integrations.recordTokenFailure(result, { ip }).catch(() => {});
      if (result.retryAfterSeconds) res.set?.('Retry-After', String(result.retryAfterSeconds));
      return reply(req, res, { ...result.body, status: result.status });
    }
    return reply(req, res, { access_token: result.accessToken, token_type: 'Bearer', expires_in: result.expiresIn });
  }),
};

export const apiOpenapi = {
  created, method: 'get', path: '/v1/organizer/openapi.json',
  description: 'Public (EVENTS_ORGANIZER_API): the OpenAPI 3.1 document of /v1/organizer, `servers[0].url` from PUBLIC_API_URL. Cacheable for an hour.',
  onGuard: routeGuard('get', [requestIdGuard, requireEventsOrganizerApi]),
  onRequest: guarded(async (req, res) => {
    const doc = structuredClone(OPENAPI);
    const base = String(process.env.PUBLIC_API_URL || '').replace(/\/+$/, '');
    if (base) doc.servers = [{ url: base }];
    res.set?.('Cache-Control', 'public, max-age=3600');
    return res.status(200).json(doc);
  }),
};

// ── Events and registrations ──────────────────────────────────────────────

export const apiListEvents = {
  created, method: 'get', path: '/v1/organizer/events',
  description: 'API client, any scope: the organizer\'s events (restricted by the client\'s eventIds; drafts never). ?limit (≤200)&cursor → { items [{ id, title, slug, status, startsAt, endsAt, timezone, categories [{ id, name, distanceM }], collectionPoints [{ id, name }] }], nextCursor }. No pricing, payout schedule, terms or commission.',
  onGuard: v1Guard('get'),
  onRequest: guarded(async (req, res) => {
    if (isSandbox(req)) return reply(req, res, { items: [sandbox.sandboxEvent()], nextCursor: null });
    return reply(req, res, await sync.listEvents({ organizerId: req.apiClient.organizerId, allowedEventIds: req.apiClient.eventIds, query: req.query || {} }));
  }),
};

export const apiListRegistrations = {
  created, method: 'get', path: '/v1/organizer/events/:eventId/registrations',
  description: 'API client, scope registrations:read: confirmed and cancelled-after-confirmed places of an event. ?status=confirmed|cancelled&categoryId&bib=assigned|unassigned&kit=collected|remaining|exception&updatedSince (ISO)&limit (≤200)&cursor → { items [{ id, eventId, categoryId, categoryName, ticketTypeId, ticketTypeName, orderId, status, createdAt, updatedAt, firstName, lastName (null when cancelled), bibNumber, kit { state, collectedAt? }, kitSize, ticketCode, teamId, teamName, groupLabel, claimed, gender?, ageOnEventDay? (only with registrations:demographics) }], nextCursor }. Never phone, email, date of birth, emergency contact, payer or payment data. 404 event_not_found for another organizer\'s, an unlisted or a nonexistent event (identical).',
  onGuard: v1Guard('get', 'registrations:read'),
  onRequest: guarded(async (req, res) => {
    if (isSandbox(req)) return reply(req, res, req.params.eventId === sandbox.SANDBOX_EVENT_ID ? sandbox.sandboxList({ query: req.query || {}, demographics: wantsDemographics(req) }) : notFound());
    if (outOfScope(req, req.params.eventId)) return reply(req, res, notFound());
    return reply(req, res, await sync.listRecords({ organizerId: req.apiClient.organizerId, eventId: req.params.eventId, allowedEventIds: req.apiClient.eventIds, query: req.query || {}, demographics: wantsDemographics(req) }));
  }),
};

export const apiRegistrationChanges = {
  created, method: 'get', path: '/v1/organizer/events/:eventId/registration-changes',
  description: 'API client, scope registrations:read: the change feed of an event (registration.created | updated | paid | cancelled, kit.collected, bib.assigned) ordered by seq. ?cursor&limit (≤200; ≤100 with expand)&expand=registration → { items [{ seq, id (outbox id — dedupe on it), eventType, registrationId, changedAt, status, changed?, cancelledAt?, reasonCode?, registration? }], nextCursor (always; unchanged when nothing is new), hasMore }. A cancelled place is a tombstone without names. Rows younger than EVENTS_FEED_LAG_SECONDS (default 5) are not served yet: overlap cursors and dedupe on id. 410 cursor_expired (older than 90 days → resync with GET registrations?updatedSince=).',
  onGuard: v1Guard('get', 'registrations:read'),
  onRequest: guarded(async (req, res) => {
    if (isSandbox(req)) return reply(req, res, req.params.eventId === sandbox.SANDBOX_EVENT_ID ? sandbox.sandboxChanges({ query: req.query || {}, demographics: wantsDemographics(req) }) : notFound());
    if (outOfScope(req, req.params.eventId)) return reply(req, res, notFound());
    return reply(req, res, await sync.changeFeed({ organizerId: req.apiClient.organizerId, eventId: req.params.eventId, allowedEventIds: req.apiClient.eventIds, query: req.query || {}, demographics: wantsDemographics(req) }));
  }),
};

export const apiGetRegistration = {
  created, method: 'get', path: '/v1/organizer/registrations/:registrationId',
  description: 'API client, scope registrations:read: one registration → { registration } (fields as in the list). 404 registration_not_found unless it belongs to an event of the client\'s organizer and event restriction (identical for a nonexistent id).',
  onGuard: v1Guard('get', 'registrations:read'),
  onRequest: guarded(async (req, res) => {
    if (isSandbox(req)) {
      const r = sandbox.sandboxRegistrations({ demographics: wantsDemographics(req) }).find(x => x.id === req.params.registrationId);
      return reply(req, res, r ? { registration: r } : { error: 'registration_not_found', status: 404 });
    }
    return reply(req, res, await sync.getRecord({ organizerId: req.apiClient.organizerId, registrationId: req.params.registrationId, allowedEventIds: req.apiClient.eventIds, demographics: wantsDemographics(req) }));
  }),
};

// ── Writes (Idempotency-Key required) ─────────────────────────────────────

export const apiCollectKit = {
  created, method: 'post', path: '/v1/organizer/events/:eventId/kit-collections',
  description: 'API client, scope kit:write (+ EVENTS_KIT_OPS): record a kit handover, exactly as POST /organizer/events/:id/kit-collections (same body, same rules, same one-handover-per-registration guarantee); the row records the API client, not a staff user. Header Idempotency-Key (8–100) REQUIRED: a replay returns the original answer (200 + Idempotent-Replayed: true), a reused key with another body is 409 idempotency_key_reused. → 201 { collection, card, warnings }. 409 already_collected | ticket_revoked | registration_unpaid. A sandbox client validates and answers but persists nothing.',
  onGuard: routeGuard('post', [requestIdGuard, requireEventsOrganizerApi, (req, res, next) => (kitOpsGate() ? next() : res.status(404).json({ error: 'feature_disabled' })), authed('kit:write')]),
  onRequest: guarded(async (req, res) => {
    if (isSandbox(req)) {
      if (req.params.eventId !== sandbox.SANDBOX_EVENT_ID) return reply(req, res, notFound());
      if (!idemKey(req)) return reply(req, res, { error: 'idempotency_key_required', status: 400 });
      return reply(req, res, sandbox.sandboxKit({ clientId: req.apiClient.id, body: req.body || {} }), 201);
    }
    if (outOfScope(req, req.params.eventId)) return reply(req, res, notFound());
    return reply(req, res, await ops.collectKit({ actor: apiActor(req), organizerId: req.apiClient.organizerId, eventId: req.params.eventId, key: idemKey(req), body: req.body || {} }), 201);
  }),
};

export const apiAssignBib = {
  created, method: 'post', path: '/v1/organizer/events/:eventId/bib-assignments',
  description: 'API client, scope bibs:write (+ EVENTS_KIT_OPS): assign a bib to a confirmed registration, exactly as POST /organizer/events/:id/bib-assignments (replace needs a reason of 10–300 characters). Idempotency-Key REQUIRED. → 201 { assignment, previousBibNumber, warnings }. 409 bib_taken (unique across the whole event) | bib_already_assigned | registration_unpaid. Bulk-by-rule and CSV import are portal-only.',
  onGuard: routeGuard('post', [requestIdGuard, requireEventsOrganizerApi, (req, res, next) => (kitOpsGate() ? next() : res.status(404).json({ error: 'feature_disabled' })), authed('bibs:write')]),
  onRequest: guarded(async (req, res) => {
    if (isSandbox(req)) {
      if (req.params.eventId !== sandbox.SANDBOX_EVENT_ID) return reply(req, res, notFound());
      if (!idemKey(req)) return reply(req, res, { error: 'idempotency_key_required', status: 400 });
      return reply(req, res, sandbox.sandboxBib({ clientId: req.apiClient.id, body: req.body || {} }), 201);
    }
    if (outOfScope(req, req.params.eventId)) return reply(req, res, notFound());
    return reply(req, res, await ops.assignBib({ actor: apiActor(req), organizerId: req.apiClient.organizerId, eventId: req.params.eventId, key: idemKey(req), body: req.body || {} }), 201);
  }),
};

export const apiAssignBibBatch = {
  created, method: 'post', path: '/v1/organizer/events/:eventId/bib-assignments/batch',
  description: 'API client, scope bibs:write (+ EVENTS_KIT_OPS): up to 500 assignments, each with its own result; NOT atomic. Idempotency-Key REQUIRED and covers the whole batch. Body { items: [{ clientRef, registrationId, bibNumber }] } → 200 { results [{ clientRef, ok, bibNumber | error }] }. 413 payload_too_large (>500).',
  onGuard: routeGuard('post', [requestIdGuard, requireEventsOrganizerApi, (req, res, next) => (kitOpsGate() ? next() : res.status(404).json({ error: 'feature_disabled' })), authed('bibs:write')]),
  onRequest: guarded(async (req, res) => {
    if (isSandbox(req)) {
      if (req.params.eventId !== sandbox.SANDBOX_EVENT_ID) return reply(req, res, notFound());
      if (!idemKey(req)) return reply(req, res, { error: 'idempotency_key_required', status: 400 });
      const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 500) : [];
      return reply(req, res, { results: items.map((it, i) => { const r = sandbox.sandboxBib({ clientId: req.apiClient.id, body: it }); return r.error ? { clientRef: it?.clientRef ?? `#${i}`, ok: false, error: r.error } : { clientRef: it?.clientRef ?? `#${i}`, ok: true, bibNumber: r.assignment.bibNumber }; }) });
    }
    if (outOfScope(req, req.params.eventId)) return reply(req, res, notFound());
    return reply(req, res, await ops.assignBibBatch({ actor: apiActor(req), organizerId: req.apiClient.organizerId, eventId: req.params.eventId, key: idemKey(req), body: req.body || {} }));
  }),
};

// ── Results (S6; EVENTS_RESULTS + EVENTS_ORGANIZER_API; scopes results:read / results:write) ──
// An API client can SUBMIT provisional results and read results. It cannot verify, reject, release, correct or disqualify (D46): no such
// route exists here, and the service refuses every decision for an API actor.

const resultsGuard = (method, scope) => routeGuard(method, [requestIdGuard, requireEventsOrganizerApi, requireEventsResults, authed(scope)]);

export const apiListResults = {
  created, method: 'get', path: '/v1/organizer/events/:eventId/results',
  description: 'API client, scope results:read (+ EVENTS_RESULTS): current results of an event. ?categoryId&status (pending_verification | verified | rejected | corrected | disqualified | finished | dnf | dns | dq)&updatedSince (ISO)&limit (≤200)&cursor → { items [{ registrationId, resultId, revision, bibNumber, categoryId, finishStatus, verificationStatus, stage, sourceType, netElapsedMs, gunElapsedMs, elapsedMs, overallRank, categoryRank, updatedAt }], nextCursor }. No names, no contact data. 404 event_not_found for another organizer\'s or an unlisted event.',
  onGuard: resultsGuard('get', 'results:read'),
  onRequest: guarded(async (req, res) => {
    if (isSandbox(req)) return reply(req, res, req.params.eventId === sandbox.SANDBOX_EVENT_ID ? sandbox.sandboxResultList({ query: req.query || {} }) : notFound());
    if (outOfScope(req, req.params.eventId)) return reply(req, res, notFound());
    return reply(req, res, await results.apiList({ organizerId: req.apiClient.organizerId, eventId: req.params.eventId, query: req.query || {} }));
  }),
};

export const apiResultReleases = {
  created, method: 'get', path: '/v1/organizer/events/:eventId/results/releases',
  description: 'API client, scope results:read (+ EVENTS_RESULTS): the release history of an event → { items [{ categoryId (null = whole event), stage: provisional | official, action: release | withdraw, releasedAt, resultCount }] }.',
  onGuard: resultsGuard('get', 'results:read'),
  onRequest: guarded(async (req, res) => {
    if (isSandbox(req)) return reply(req, res, req.params.eventId === sandbox.SANDBOX_EVENT_ID ? sandbox.sandboxReleases() : notFound());
    if (outOfScope(req, req.params.eventId)) return reply(req, res, notFound());
    return reply(req, res, await results.apiReleases({ organizerId: req.apiClient.organizerId, eventId: req.params.eventId }));
  }),
};

export const apiImportResults = {
  created, method: 'post', path: '/v1/organizer/events/:eventId/results/imports',
  description: 'API client, scope results:write (+ EVENTS_RESULTS): submit up to 500 PROVISIONAL results. Idempotency-Key REQUIRED and covers the whole call. Body { sourceLabel? (≤60), timeBasis?: net | gun, rows: [{ clientRef, bib | registrationId, status?: finished | dnf | dns | dq, netTime?, gunTime?, category? }] }; ?dryRun=true validates only. → 200 { results [{ clientRef, ok, resultId | null, action: created | revised | unchanged | null, error | null }] }. NOT atomic across rows (each row is its own transaction). Results are always sourceType timing_provider, pending_verification (an organizer verifies), attributed to the API client; a verified result answers already_official. 409 event_not_open_for_results | event_cancelled; 422 validation_failed.',
  onGuard: resultsGuard('post', 'results:write'),
  onRequest: guarded(async (req, res) => {
    const dryRun = ['1', 'true'].includes(String(req.query?.dryRun ?? ''));
    if (isSandbox(req)) {
      if (req.params.eventId !== sandbox.SANDBOX_EVENT_ID) return reply(req, res, notFound());
      if (!dryRun && !idemKey(req)) return reply(req, res, { error: 'idempotency_key_required', status: 400 });
      return reply(req, res, sandbox.sandboxResultsImport({ body: req.body || {} }));
    }
    if (outOfScope(req, req.params.eventId)) return reply(req, res, notFound());
    return reply(req, res, await results.apiImport({ actor: apiActor(req), organizerId: req.apiClient.organizerId, eventId: req.params.eventId, key: idemKey(req), body: req.body || {}, dryRun }));
  }),
};

// ── Webhook management over the API (scope webhooks:manage, owner-granted only) ──

const hookReply = (req, res, result, okStatus) => reply(req, res, result, okStatus);
const apiBy = req => `api:${req.apiClient.id}`;

export const apiListWebhookEndpoints = {
  created, method: 'get', path: '/v1/organizer/webhook-endpoints',
  description: 'API client, scope webhooks:manage (+ EVENTS_WEBHOOKS): the organizer\'s webhook endpoints with health, as GET /organizer/webhook-endpoints. A sandbox client cannot hold this scope.',
  onGuard: v1HookGuard('get'),
  onRequest: guarded(async (req, res) => hookReply(req, res, await hooks.listEndpoints({ organizerId: req.apiClient.organizerId }))),
};

export const apiCreateWebhookEndpoint = {
  created, method: 'post', path: '/v1/organizer/webhook-endpoints',
  description: 'API client, scope webhooks:manage (+ EVENTS_WEBHOOKS): register an endpoint, as POST /organizer/webhook-endpoints (same URL safety rules; the signing secret is returned once). 201 { endpoint, signingSecret }; 400 invalid_url { reason }.',
  onGuard: v1HookGuard('post'),
  onRequest: guarded(async (req, res) => { res.set?.('Cache-Control', 'no-store'); return hookReply(req, res, await hooks.createEndpoint({ organizerId: req.apiClient.organizerId, actorId: apiBy(req), body: req.body || {} }), 201); }),
};

export const apiUpdateWebhookEndpoint = {
  created, method: 'patch', path: '/v1/organizer/webhook-endpoints/:id',
  description: 'API client, scope webhooks:manage (+ EVENTS_WEBHOOKS): change { url?, events?, eventIds?, description? }, as the portal route; a changed URL runs the handshake again.',
  onGuard: v1HookGuard('patch'),
  onRequest: guarded(async (req, res) => hookReply(req, res, await hooks.updateEndpoint({ organizerId: req.apiClient.organizerId, id: req.params.id, actorId: apiBy(req), body: req.body || {} }))),
};

export const apiRotateWebhookSecret = {
  created, method: 'post', path: '/v1/organizer/webhook-endpoints/:id/rotate-secret',
  description: 'API client, scope webhooks:manage (+ EVENTS_WEBHOOKS): a new signing secret, shown once, with { graceHours: 0 | 24 | 72 }.',
  onGuard: v1HookGuard('post'),
  onRequest: guarded(async (req, res) => { res.set?.('Cache-Control', 'no-store'); return hookReply(req, res, await hooks.rotateSecret({ organizerId: req.apiClient.organizerId, id: req.params.id, actorId: apiBy(req), body: req.body || {} })); }),
};

export const apiTestWebhookEndpoint = {
  created, method: 'post', path: '/v1/organizer/webhook-endpoints/:id/test',
  description: 'API client, scope webhooks:manage (+ EVENTS_WEBHOOKS): send one synthetic `<type>.test` event (10 per hour per endpoint).',
  onGuard: v1HookGuard('post'),
  onRequest: guarded(async (req, res) => hookReply(req, res, await hooks.testSend({ organizerId: req.apiClient.organizerId, id: req.params.id, actorId: apiBy(req), body: req.body || {} }))),
};

export const apiVerifyWebhookEndpoint = {
  created, method: 'post', path: '/v1/organizer/webhook-endpoints/:id/verify',
  description: 'API client, scope webhooks:manage (+ EVENTS_WEBHOOKS): run the verification handshake now → { ok, host, reason? }.',
  onGuard: v1HookGuard('post'),
  onRequest: guarded(async (req, res) => hookReply(req, res, await hooks.verifyEndpoint({ organizerId: req.apiClient.organizerId, id: req.params.id, actorId: apiBy(req) }))),
};

export const apiListWebhookDeliveries = {
  created, method: 'get', path: '/v1/organizer/webhook-deliveries',
  description: 'API client, scope webhooks:manage (+ EVENTS_WEBHOOKS): the delivery log. ?endpointId&status&eventId&cursor&limit.',
  onGuard: v1HookGuard('get'),
  onRequest: guarded(async (req, res) => hookReply(req, res, await hooks.listDeliveries({ organizerId: req.apiClient.organizerId, query: req.query || {} }))),
};

export const apiRetryWebhookDelivery = {
  created, method: 'post', path: '/v1/organizer/webhook-deliveries/:id/retry',
  description: 'API client, scope webhooks:manage (+ EVENTS_WEBHOOKS): retry a failed or dead delivery (bounded: 5 per delivery per 24 h, 30 per endpoint per hour; idempotent).',
  onGuard: v1HookGuard('post'),
  onRequest: guarded(async (req, res) => hookReply(req, res, await hooks.retryDelivery({ organizerId: req.apiClient.organizerId, id: req.params.id, actorId: apiBy(req) }))),
};
