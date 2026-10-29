// Marathon & running events · S5 — API clients and webhook endpoints for a signed-in organizer OWNER or ADMIN (spec §5.1, §7.2).
// /organizer/api-clients answers 404 feature_disabled unless EVENTS_ORGANIZER_API is on (with EVENTS_MODULE + EVENTS_REGISTRATION);
// /organizer/webhook-endpoints, /organizer/webhook-deliveries unless EVENTS_WEBHOOKS is on. Secrets (client secret, webhook signing
// secret) appear in exactly two responses each: create and rotate. Guards are wrapped in routeGuard.
import { randomUUID } from 'node:crypto';
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { requireActiveOrganizer, requireOpenOrganizer, organizerOf } from '../src/auth/events-authz.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { requireEventsOrganizerApi, requireEventsWebhooks, eventsOrganizerApiOn, eventsWebhooksOn } from '../src/shared/feature-flags.mjs';
import { eventsIntegrationsService as clients, eventsWebhookService as hooks } from '../src/bootstrap/services.mjs';
import { createVendorLimiter, limitOrNull } from '../src/shared/vendor-rate-limit.mjs';

const created = new Date().toISOString();
const ORGANIZER_TYPES = ['event_organizer', 'organizer_staff'];
const manageLimiter = createVendorLimiter({ perMinute: 60 });
export const resetEventsIntegrationsLimits = () => manageLimiter.reset();

const requestIdOf = (req) => {
  const given = String(req.headers?.['x-request-id'] ?? '');
  return /^[A-Za-z0-9._-]{8,64}$/.test(given) ? given : `req_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
};
function send(res, result, okStatus = 200) {
  if (result?.error) {
    const { error, status, ...extra } = result;
    return res.status(status || 400).json({ error, ...extra });
  }
  const { status, ...body } = result ?? {};
  return res.status(Number.isInteger(status) ? status : okStatus).json(body);
}
/** Request id on the response; the secret-bearing routes are no-store. */
const run = (handler, { noStore = false } = {}) => async (req, res) => {
  res.set?.('X-Request-Id', requestIdOf(req));
  if (noStore) res.set?.('Cache-Control', 'no-store');
  if (limitOrNull(manageLimiter, `m:${req.user.sub}`, res)) return undefined;
  return handler(req, res);
};
const apiWriters = method => routeGuard(method, [requireEventsOrganizerApi, requireAuth(...ORGANIZER_TYPES), requireActiveOrganizer('owner', 'admin')]);
const apiReaders = method => routeGuard(method, [requireEventsOrganizerApi, requireAuth(...ORGANIZER_TYPES), requireOpenOrganizer('owner', 'admin')]);
const hookWriters = method => routeGuard(method, [requireEventsWebhooks, requireAuth(...ORGANIZER_TYPES), requireActiveOrganizer('owner', 'admin')]);
// D38: whoever can redirect event data is the OWNER. Create, change, rotate the secret, verify, enable and disable are owner-only; admins may read, test and retry.
const hookOwner = method => routeGuard(method, [requireEventsWebhooks, requireAuth(...ORGANIZER_TYPES), requireActiveOrganizer('owner')]);
const hookReaders = method => routeGuard(method, [requireEventsWebhooks, requireAuth(...ORGANIZER_TYPES), requireOpenOrganizer('owner', 'admin')]);
const either = (req, res, next) => (eventsOrganizerApiOn() || eventsWebhooksOn() ? next() : res.status(404).json({ error: 'feature_disabled' }));
const healthReaders = method => routeGuard(method, [either, requireAuth(...ORGANIZER_TYPES), requireOpenOrganizer('owner', 'admin')]);
const ctxOf = req => organizerOf(req);
const organizerId = req => ctxOf(req).organizer.id;

// ── API clients ───────────────────────────────────────────────────────────

export const organizerCreateApiClient = {
  created, method: 'post', path: '/organizer/api-clients',
  description: 'Organizer owner / admin (organizer active; EVENTS_ORGANIZER_API; the organizer must be enabled for the API by FitFlex, D39): create an API client. Body { name (1–60), environment: live | sandbox, scopes [registrations:read | registrations:demographics | kit:write | bibs:write | webhooks:manage (owner only, never on sandbox)], eventIds? (the organizer\'s own events; sandbox is fixed to evt_sandbox), expiresInDays? (1–730, default 365) } → 201 { client { id, clientId, name, environment, scopes, eventIds, status, expiresAt, lastUsedAt, createdAt, createdBy { name }, rateLimitPerMinute, rotation { inGrace, graceEndsAt } }, clientSecret } — the secret (`ffs_live_…` / `ffs_test_…`) is returned ONCE here, stored only as a hash, and never appears again in any response, log or audit row. 403 api_access_not_enabled | forbidden_role; 409 client_limit_reached; 422 invalid_scope | scope_not_available | validation_failed. no-store.',
  onGuard: apiWriters('post'),
  onRequest: run(async (req, res) => send(res, await clients.createClient({ ctx: ctxOf(req), actorId: req.user.sub, body: req.body || {} }), 201), { noStore: true }),
};

export const organizerListApiClients = {
  created, method: 'get', path: '/organizer/api-clients',
  description: 'Organizer owner / admin (EVENTS_ORGANIZER_API): the API clients → { items [client view, never any secret material], max, accessEnabled }.',
  onGuard: apiReaders('get'),
  onRequest: run(async (req, res) => send(res, await clients.listClients({ ctx: ctxOf(req) }))),
};

export const organizerGetApiClient = {
  created, method: 'get', path: '/organizer/api-clients/:id',
  description: 'Organizer owner / admin (EVENTS_ORGANIZER_API): one client + usage of the last 30 days → { client, usage { days [{ day, requests, errors, rateLimited }] }, history [{ at, action }] }. 404 client_not_found.',
  onGuard: apiReaders('get'),
  onRequest: run(async (req, res) => send(res, await clients.getClient({ ctx: ctxOf(req), id: req.params.id }))),
};

export const organizerUpdateApiClient = {
  created, method: 'patch', path: '/organizer/api-clients/:id',
  description: 'Organizer owner / admin (organizer active; EVENTS_ORGANIZER_API): change { name?, scopes?, eventIds?, expiresAt? } (never the secret or the environment). Granting webhooks:manage is the owner\'s alone (403 forbidden_role). → { client }. 404 client_not_found; 409 client_not_active; 422 invalid_scope | scope_not_available | validation_failed.',
  onGuard: apiWriters('patch'),
  onRequest: run(async (req, res) => send(res, await clients.updateClient({ ctx: ctxOf(req), id: req.params.id, actorId: req.user.sub, body: req.body || {} }))),
};

export const organizerRotateApiClient = {
  created, method: 'post', path: '/organizer/api-clients/:id/rotate',
  description: 'Organizer owner / admin (organizer active; EVENTS_ORGANIZER_API): a NEW secret, shown once. Body { graceHours: 0 | 24 | 72 } (default 24): with an overlap both secrets authenticate until it ends and access tokens minted from the old one die then; 0 ends the old secret now. A second rotation during an overlap replaces the previous secret. → { client, clientSecret }. 409 client_not_active; 422 validation_failed. no-store.',
  onGuard: apiWriters('post'),
  onRequest: run(async (req, res) => send(res, await clients.rotateClient({ ctx: ctxOf(req), id: req.params.id, actorId: req.user.sub, body: req.body || {} })), { noStore: true }),
};

export const organizerRevokeApiClient = {
  created, method: 'post', path: '/organizer/api-clients/:id/revoke',
  description: 'Organizer owner / admin (organizer active; EVENTS_ORGANIZER_API): revoke at once and for good (idempotent). Body { reason? } → { client, changed }. The next /v1 call with an unexpired token fails.',
  onGuard: apiWriters('post'),
  onRequest: run(async (req, res) => send(res, await clients.revokeClient({ ctx: ctxOf(req), id: req.params.id, actorId: req.user.sub, body: req.body || {} }))),
};

// ── Webhook endpoints ─────────────────────────────────────────────────────

export const organizerCreateWebhookEndpoint = {
  created, method: 'post', path: '/organizer/webhook-endpoints',
  description: 'Organizer OWNER only (D38; organizer active; EVENTS_WEBHOOKS + EVENTS_WEBHOOK_SECRET_KEY): register an endpoint. Body { url (https, port 443, a DNS name that resolves ONLY to public addresses), events [registration.created | registration.paid | registration.cancelled | registration.updated | kit.collected | bib.assigned | event.updated | event.cancelled | refund.updated] (no wildcard), eventIds?, description? (≤200) } → 201 { endpoint, signingSecret } — `whsec_…` shown ONCE, stored AES-256-GCM encrypted. The endpoint starts unverified and receives only the verification challenge until POST …/verify succeeds. 400 invalid_url { reason: not_https | credentials_in_url | bad_port | ip_literal | blocked_host | blocked_address | unresolvable | too_long }; 409 endpoint_limit_reached; 422 invalid_event_type | validation_failed; 404 feature_disabled without the key. no-store.',
  onGuard: hookOwner('post'),
  onRequest: run(async (req, res) => send(res, await hooks.createEndpoint({ organizerId: organizerId(req), actorId: req.user.sub, body: req.body || {} }), 201), { noStore: true }),
};

export const organizerListWebhookEndpoints = {
  created, method: 'get', path: '/organizer/webhook-endpoints',
  description: 'Organizer owner / admin (EVENTS_WEBHOOKS): endpoints with health → { items [{ id, url, host, description, events, eventIds, status, verifiedAt, secretHint, rotation, disabledReason, disabledAt, lastSuccessAt, consecutiveFailures, createdAt, health: healthy | degraded | failing | disabled | unverified, last24h { delivered, failed, dead }, pending, oldestPendingAgeSeconds }], max, types, available }.',
  onGuard: hookReaders('get'),
  onRequest: run(async (req, res) => send(res, await hooks.listEndpoints({ organizerId: organizerId(req) }))),
};

export const organizerGetWebhookEndpoint = {
  created, method: 'get', path: '/organizer/webhook-endpoints/:id',
  description: 'Organizer owner / admin (EVENTS_WEBHOOKS): one endpoint + its last 10 attempts (verification and test sends included) → { endpoint, attempts }. 404 endpoint_not_found.',
  onGuard: hookReaders('get'),
  onRequest: run(async (req, res) => send(res, await hooks.getEndpoint({ organizerId: organizerId(req), id: req.params.id }))),
};

export const organizerUpdateWebhookEndpoint = {
  created, method: 'patch', path: '/organizer/webhook-endpoints/:id',
  description: 'Organizer OWNER only (D38; organizer active; EVENTS_WEBHOOKS): change { url?, events?, eventIds?, description? }. A changed URL is checked again and the handshake runs again at once → { endpoint, verification? { ok, host, reason? } }. 400 invalid_url; 422 invalid_event_type | validation_failed.',
  onGuard: hookOwner('patch'),
  onRequest: run(async (req, res) => send(res, await hooks.updateEndpoint({ organizerId: organizerId(req), id: req.params.id, actorId: req.user.sub, body: req.body || {} }))),
};

export const organizerVerifyWebhookEndpoint = {
  created, method: 'post', path: '/organizer/webhook-endpoints/:id/verify',
  description: 'Organizer OWNER only (D38; organizer active; EVENTS_WEBHOOKS): run the handshake now — a signed `endpoint.verification` request with a 32-character challenge that the endpoint must echo as 200 { "challenge": … } within 10 s → { ok, host, reason? }. Success sets verifiedAt; unverified endpoints receive no events.',
  onGuard: hookOwner('post'),
  onRequest: run(async (req, res) => send(res, await hooks.verifyEndpoint({ organizerId: organizerId(req), id: req.params.id, actorId: req.user.sub }))),
};

export const organizerTestWebhookEndpoint = {
  created, method: 'post', path: '/organizer/webhook-endpoints/:id/test',
  description: 'Organizer owner / admin (organizer active; EVENTS_WEBHOOKS): send ONE synthetic `<type>.test` event (id obx_test_…, data.test true) and show the result → { ok, outcome, responseCode, durationMs, errorCode, snippet (redacted) }. 10 per hour per endpoint (429 rate_limited).',
  onGuard: hookWriters('post'),
  onRequest: run(async (req, res) => send(res, await hooks.testSend({ organizerId: organizerId(req), id: req.params.id, actorId: req.user.sub, body: req.body || {} }))),
};

export const organizerRotateWebhookSecret = {
  created, method: 'post', path: '/organizer/webhook-endpoints/:id/rotate-secret',
  description: 'Organizer OWNER only (D38; organizer active; EVENTS_WEBHOOKS): a NEW signing secret, shown once. Body { graceHours: 0 | 24 | 72 } (default 24): during the overlap every delivery carries two `v1=` signatures (new first). → { endpoint, signingSecret }. no-store.',
  onGuard: hookOwner('post'),
  onRequest: run(async (req, res) => send(res, await hooks.rotateSecret({ organizerId: organizerId(req), id: req.params.id, actorId: req.user.sub, body: req.body || {} })), { noStore: true }),
};

export const organizerDisableWebhookEndpoint = {
  created, method: 'post', path: '/organizer/webhook-endpoints/:id/disable',
  description: 'Organizer OWNER only (D38; organizer active; EVENTS_WEBHOOKS): switch an endpoint off. Endpoints are disabled, never deleted (the delivery log is history). → { endpoint, changed }.',
  onGuard: hookOwner('post'),
  onRequest: run(async (req, res) => send(res, await hooks.disableEndpoint({ organizerId: organizerId(req), id: req.params.id, actorId: req.user.sub }))),
};

export const organizerEnableWebhookEndpoint = {
  created, method: 'post', path: '/organizer/webhook-endpoints/:id/enable',
  description: 'Organizer OWNER only (D38; organizer active; EVENTS_WEBHOOKS): switch a disabled endpoint on. The handshake must succeed first. Body { redeliverMissed?: true } also queues, once, the events of the last 7 days created after it was disabled → { endpoint, changed, requeued }. 409 verification_failed { reason }.',
  onGuard: hookOwner('post'),
  onRequest: run(async (req, res) => send(res, await hooks.enableEndpoint({ organizerId: organizerId(req), id: req.params.id, actorId: req.user.sub, body: req.body || {} }))),
};

// ── Deliveries and health ─────────────────────────────────────────────────

export const organizerListWebhookDeliveries = {
  created, method: 'get', path: '/organizer/webhook-deliveries',
  description: 'Organizer owner / admin (EVENTS_WEBHOOKS): the delivery log, newest first. ?endpointId&status=pending|delivered|failed|dead&eventId&cursor&limit (≤200) → { items [{ id, endpointId, eventType, eventId (outbox id), status, attemptCount, createdAt, lastAttemptAt, nextAttemptAt, responseCode, lastError }], nextCursor }.',
  onGuard: hookReaders('get'),
  onRequest: run(async (req, res) => send(res, await hooks.listDeliveries({ organizerId: organizerId(req), query: req.query || {} }))),
};

export const organizerGetWebhookDelivery = {
  created, method: 'get', path: '/organizer/webhook-deliveries/:id',
  description: 'Organizer owner / admin (EVENTS_WEBHOOKS): one delivery with EVERY attempt (time, duration, outcome, response code, redacted snippet, next attempt) and the payload exactly as sent (it carries no names, phones, emails, amounts or tokens) → { delivery, attempts, payload, manualRetriesLeft }.',
  onGuard: hookReaders('get'),
  onRequest: run(async (req, res) => send(res, await hooks.getDelivery({ organizerId: organizerId(req), id: req.params.id }))),
};

export const organizerRetryWebhookDelivery = {
  created, method: 'post', path: '/organizer/webhook-deliveries/:id/retry',
  description: 'Organizer owner / admin (organizer active; EVENTS_WEBHOOKS): retry a failed or dead delivery now. Bounded: 5 manual retries per delivery per 24 h and 30 per endpoint per hour (429 rate_limited). Idempotent: already queued → 200 { alreadyQueued: true }. The event id is unchanged, so receivers dedupe. 409 already_delivered.',
  onGuard: hookWriters('post'),
  onRequest: run(async (req, res) => send(res, await hooks.retryDelivery({ organizerId: organizerId(req), id: req.params.id, actorId: req.user.sub }))),
};

export const organizerIntegrationsHealth = {
  created, method: 'get', path: '/organizer/integrations/health',
  description: 'Organizer owner / admin (EVENTS_ORGANIZER_API or EVENTS_WEBHOOKS): the aggregate for the Overview card → { webhooks { endpoints, healthy, degraded, failing, disabled, unverified, deadLast24h } | null, apiClients { active, expiringSoon } | null }.',
  onGuard: healthReaders('get'),
  onRequest: run(async (req, res) => send(res, {
    webhooks: eventsWebhooksOn() ? await hooks.integrationsHealth({ organizerId: organizerId(req) }) : null,
    apiClients: eventsOrganizerApiOn() ? await clients.apiHealth({ organizerId: organizerId(req) }) : null,
  })),
};
