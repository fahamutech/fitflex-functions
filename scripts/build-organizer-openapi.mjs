#!/usr/bin/env node
// Builds docs/api/organizer-api-v1.openapi.json (OpenAPI 3.1, JSON so no YAML dependency) — the contract of /v1/organizer.
// The spec specs/events-s5-openapi-contract.specs.mjs fails if this output differs from the committed file, if a mounted /v1/organizer
// route has no operation (or the reverse), or if a live sandbox response does not validate against its schema.
//   node scripts/build-organizer-openapi.mjs          writes the file
//   node scripts/build-organizer-openapi.mjs --stdout prints it
import { writeFileSync } from 'node:fs';
import { WEBHOOK_EVENT_TYPES } from '../src/shared/webhook-events.mjs';

const nullable = (schema) => ({ ...schema, type: [].concat(schema.type, 'null') });
const str = { type: 'string' };
const nstr = nullable(str);
const int = { type: 'integer' };
const bool = { type: 'boolean' };
const ref = name => ({ $ref: `#/components/schemas/${name}` });
const obj = (properties, required = Object.keys(properties), extra = {}) => ({ type: 'object', properties, required, ...extra });
const arr = items => ({ type: 'array', items });

const schemas = {
  Error: obj({ error: { type: 'string', description: 'A stable machine code, e.g. invalid_client, insufficient_scope, event_not_found.' }, requestId: str }, ['error'], { description: 'Every error is { error, ...extra } (D5). 5xx bodies carry requestId.' }),
  TokenRequest: obj({ grant_type: { const: 'client_credentials' }, client_id: str, client_secret: str }),
  TokenResponse: obj({ access_token: str, token_type: { const: 'Bearer' }, expires_in: { type: 'integer', example: 900 } }),
  Category: obj({ id: str, name: str, distanceM: int }),
  CollectionPoint: obj({ id: str, name: str }),
  Event: obj({ id: str, title: str, slug: str, status: str, startsAt: str, endsAt: str, timezone: str, categories: arr(ref('Category')), collectionPoints: arr(ref('CollectionPoint')) }),
  EventList: obj({ items: arr(ref('Event')), nextCursor: nstr }),
  Kit: obj({ state: { enum: ['not_ready', 'ready', 'collected', 'exception'] }, collectedAt: str }, ['state']),
  Registration: obj({
    id: str, eventId: str, categoryId: str, categoryName: nstr, ticketTypeId: str, ticketTypeName: nstr, orderId: str, status: { enum: ['confirmed', 'cancelled'] }, createdAt: str, updatedAt: str,
    firstName: nstr, lastName: nstr, bibNumber: nstr, kit: ref('Kit'), kitSize: nstr, ticketCode: nstr, teamId: nstr, teamName: nstr, groupLabel: nstr, claimed: bool,
    gender: nstr, ageOnEventDay: nullable(int),
  }, ['id', 'eventId', 'categoryId', 'categoryName', 'ticketTypeId', 'ticketTypeName', 'orderId', 'status', 'createdAt', 'updatedAt', 'firstName', 'lastName', 'bibNumber', 'kit', 'kitSize', 'ticketCode', 'teamId', 'teamName', 'groupLabel', 'claimed'],
  { description: 'gender and ageOnEventDay exist only with the registrations:demographics scope. There is NO phone, email, date of birth, emergency contact, payer or payment field.' }),
  RegistrationList: obj({ items: arr(ref('Registration')), nextCursor: nstr }),
  RegistrationEnvelope: obj({ registration: ref('Registration') }),
  ChangeItem: obj({
    seq: int, id: { type: 'string', description: 'The outbox id. Consumers dedupe on it; cursors may overlap.' }, eventType: { enum: ['registration.created', 'registration.updated', 'registration.paid', 'registration.cancelled', 'kit.collected', 'bib.assigned'] },
    registrationId: str, changedAt: str, status: { enum: ['confirmed', 'cancelled'] }, changed: arr(str), cancelledAt: str, reasonCode: str, registration: nullable(ref('Registration')),
  }, ['seq', 'id', 'eventType', 'registrationId', 'changedAt', 'status']),
  ChangeFeed: obj({ items: arr(ref('ChangeItem')), nextCursor: str, hasMore: bool }),
  KitCollectionRequest: obj({
    method: { enum: ['scan', 'manual'] }, payload: { type: 'string', description: 'The QR text (FFEV1:…) for method scan.' }, registrationId: str, manualReason: { enum: ['phone_lost', 'no_signal', 'screen_damaged', 'other'] },
    collectionPointId: str, kitSize: str, bibNumber: str, status: { enum: ['collected', 'exception'] }, note: { type: 'string', maxLength: 300 },
  }, ['method']),
  Card: obj({
    displayName: str, ticketCode: nstr, categoryName: nstr, distanceM: nullable(int), ticketTypeName: nstr, teamName: nstr, bibNumber: nstr, kitSize: nstr, kit: ref('Kit'), payment: { enum: ['paid', 'unpaid', 'refunded'] },
  }, ['displayName', 'kit', 'payment']),
  KitCollectionResponse: obj({ collection: obj({ id: str, status: str, collectedAt: str, collectionPointId: nstr }), card: ref('Card'), warnings: arr(str) }),
  BibRequest: obj({ registrationId: str, bibNumber: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9-]{0,11}$' }, replace: bool, reason: { type: 'string', minLength: 10, maxLength: 300 } }, ['registrationId', 'bibNumber']),
  BibResponse: obj({ assignment: obj({ id: str, registrationId: str, bibNumber: str, assignedAt: str }), previousBibNumber: nstr, warnings: arr(str) }),
  BibBatchRequest: obj({ items: { type: 'array', maxItems: 500, items: obj({ clientRef: str, registrationId: str, bibNumber: str }, ['registrationId', 'bibNumber']) } }),
  BibBatchResponse: obj({ results: arr(obj({ clientRef: str, ok: bool, bibNumber: str, error: str }, ['clientRef', 'ok'])) }),
  WebhookEnvelope: obj({ id: { type: 'string', description: 'The outbox id: stable across endpoints and retries — your dedupe key.' }, type: { enum: [...WEBHOOK_EVENT_TYPES] }, version: { const: '1' }, createdAt: str, organizerId: str, eventId: nstr, data: { type: 'object' } },
    undefined, { description: 'No names, phones, emails, amounts or tokens. Fetch authorised fields with GET /v1/organizer/registrations/{id}.' }),
  WebhookEndpointRequest: obj({ url: { type: 'string', description: 'https, port 443, a DNS name that resolves only to public addresses.' }, events: { type: 'array', items: { enum: [...WEBHOOK_EVENT_TYPES] } }, eventIds: arr(str), description: str }, ['url', 'events']),
  WebhookEndpoint: obj({ id: str, url: str, host: nstr, events: arr(str), status: { enum: ['active', 'disabled'] }, verifiedAt: nstr, health: str }, ['id', 'url', 'events', 'status']),
  WebhookEndpointCreated: obj({ endpoint: ref('WebhookEndpoint'), signingSecret: { type: 'string', description: 'whsec_… shown ONCE.' } }),
  WebhookEndpointList: obj({ items: arr(ref('WebhookEndpoint')) }, ['items']),
  WebhookEndpointUpdated: obj({ endpoint: ref('WebhookEndpoint'), verification: obj({ ok: bool, host: nstr, reason: str }, ['ok']) }, ['endpoint']),
  WebhookDeliveryList: obj({ items: arr(obj({ id: str, endpointId: str, eventType: str, outboxEventId: str, status: { enum: ['pending', 'delivered', 'failed', 'dead'] }, attemptCount: int }, ['id', 'endpointId', 'eventType', 'outboxEventId', 'status', 'attemptCount'])), nextCursor: nstr }),
};
const errorResponses = codes => Object.fromEntries(codes.map(([code, desc]) => [String(code), { description: desc, content: { 'application/json': { schema: ref('Error') } } }]));
const ok = (schemaName, description = 'OK', status = '200') => ({ [status]: { description, content: { 'application/json': { schema: ref(schemaName) } } } });
const bearer = [{ oauth2: [] }];
const idem = { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 100 }, description: 'Required on every write. A replay returns the original answer (200 + Idempotent-Replayed: true); the same key with another body is 409 idempotency_key_reused.' };
const limitP = { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } };
const cursorP = { name: 'cursor', in: 'query', schema: str, description: 'Opaque. Pass nextCursor from the previous page.' };
const eventIdP = { name: 'eventId', in: 'path', required: true, schema: str };
const common = [[401, 'invalid_token | token_expired'], [403, 'insufficient_scope { requiredScope } | organizer_suspended | client_expired | api_access_not_enabled'], [429, 'rate_limited { retryAfterSeconds } (Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining)']];
const op = (summary, scope, extra) => ({ summary, description: scope ? `Scope: ${scope}.` : 'Any valid client.', security: bearer, 'x-scope': scope ?? null, ...extra, responses: { ...extra.responses, ...errorResponses(common) } });

const doc = {
  openapi: '3.1.0',
  info: {
    title: 'FitFlex Organizer API', version: '1.0.0',
    description: 'For organizers\' timing, registration and kit-desk systems. Authentication: exchange a client id and secret at POST /v1/organizer/token for a 15-minute bearer token. Scopes, event restrictions, revocation and expiry are checked on every call. Dates are ISO 8601 UTC, JSON is camelCase, lists use opaque cursors. Organizers never receive participant phone or email through this API. See organizer-api-guide.md and organizer-webhooks.md.',
  },
  servers: [{ url: 'https://api.example.invalid' }],
  security: bearer,
  paths: {
    '/v1/organizer/token': { post: {
      summary: 'Exchange client credentials for a bearer token', description: 'The only route that accepts the client secret. Every failed exchange is the same 401 invalid_client.', security: [],
      requestBody: { required: true, content: { 'application/json': { schema: ref('TokenRequest') } } },
      responses: { ...ok('TokenResponse'), ...errorResponses([[400, 'invalid_request'], [401, 'invalid_client (identical for unknown id, wrong secret, revoked, expired)'], [403, 'organizer_suspended | organizer_not_active | api_access_not_enabled'], [429, 'rate_limited']]) },
    } },
    '/v1/organizer/openapi.json': { get: { summary: 'This document', security: [], responses: { 200: { description: 'OpenAPI 3.1', content: { 'application/json': { schema: { type: 'object' } } } } } } },
    '/v1/organizer/events': { get: op('List events', null, { parameters: [limitP, cursorP], responses: ok('EventList') }) },
    '/v1/organizer/events/{eventId}/registrations': { get: op('List registrations (confirmed and cancelled-after-confirmed)', 'registrations:read', {
      parameters: [eventIdP, limitP, cursorP, { name: 'status', in: 'query', schema: { enum: ['confirmed', 'cancelled'] } }, { name: 'categoryId', in: 'query', schema: str }, { name: 'bib', in: 'query', schema: { enum: ['assigned', 'unassigned'] } },
        { name: 'kit', in: 'query', schema: { enum: ['collected', 'remaining', 'exception'] } }, { name: 'updatedSince', in: 'query', schema: { type: 'string', format: 'date-time' } }],
      responses: { ...ok('RegistrationList'), ...errorResponses([[404, 'event_not_found (also for another organizer\'s or an unlisted event)']]) },
    }) },
    '/v1/organizer/events/{eventId}/registration-changes': { get: op('Change feed', 'registrations:read', {
      parameters: [eventIdP, limitP, cursorP, { name: 'expand', in: 'query', schema: { const: 'registration' } }],
      responses: { ...ok('ChangeFeed'), ...errorResponses([[404, 'event_not_found'], [410, 'cursor_expired — do a full resync with GET registrations?updatedSince=']]) },
    }) },
    '/v1/organizer/registrations/{registrationId}': { get: op('One registration', 'registrations:read', {
      parameters: [{ name: 'registrationId', in: 'path', required: true, schema: str }], responses: { ...ok('RegistrationEnvelope'), ...errorResponses([[404, 'registration_not_found']]) },
    }) },
    '/v1/organizer/events/{eventId}/kit-collections': { post: op('Record a kit handover', 'kit:write', {
      parameters: [eventIdP, idem], requestBody: { required: true, content: { 'application/json': { schema: ref('KitCollectionRequest') } } },
      responses: { ...ok('KitCollectionResponse', 'Recorded', '201'), ...errorResponses([[400, 'idempotency_key_required | not_event_ticket'], [404, 'registration_not_found | event_not_found'], [409, 'already_collected | ticket_revoked | registration_unpaid | idempotency_key_reused | request_in_progress'], [422, 'collection_point_required | manual_reason_required | note_required']]) },
    }) },
    '/v1/organizer/events/{eventId}/bib-assignments': { post: op('Assign a bib number', 'bibs:write', {
      parameters: [eventIdP, idem], requestBody: { required: true, content: { 'application/json': { schema: ref('BibRequest') } } },
      responses: { ...ok('BibResponse', 'Assigned', '201'), ...errorResponses([[409, 'bib_taken | bib_already_assigned | registration_unpaid'], [422, 'bib_invalid | reason_required']]) },
    }) },
    '/v1/organizer/events/{eventId}/bib-assignments/batch': { post: op('Assign up to 500 bib numbers (per item, not atomic)', 'bibs:write', {
      parameters: [eventIdP, idem], requestBody: { required: true, content: { 'application/json': { schema: ref('BibBatchRequest') } } }, responses: { ...ok('BibBatchResponse'), ...errorResponses([[413, 'payload_too_large']]) },
    }) },
    '/v1/organizer/webhook-endpoints': {
      get: op('List webhook endpoints', 'webhooks:manage', { responses: ok('WebhookEndpointList') }),
      post: op('Register a webhook endpoint', 'webhooks:manage', { requestBody: { required: true, content: { 'application/json': { schema: ref('WebhookEndpointRequest') } } }, responses: { ...ok('WebhookEndpointCreated', 'Created', '201'), ...errorResponses([[400, 'invalid_url { reason }'], [422, 'invalid_event_type']]) } }),
    },
    '/v1/organizer/webhook-endpoints/{id}': { patch: op('Change an endpoint', 'webhooks:manage', { parameters: [{ name: 'id', in: 'path', required: true, schema: str }], requestBody: { content: { 'application/json': { schema: ref('WebhookEndpointRequest') } } }, responses: ok('WebhookEndpointUpdated') }) },
    '/v1/organizer/webhook-endpoints/{id}/rotate-secret': { post: op('Rotate the signing secret (shown once)', 'webhooks:manage', { parameters: [{ name: 'id', in: 'path', required: true, schema: str }], responses: ok('WebhookEndpointCreated') }) },
    '/v1/organizer/webhook-endpoints/{id}/test': { post: op('Send one synthetic test event', 'webhooks:manage', { parameters: [{ name: 'id', in: 'path', required: true, schema: str }], responses: { 200: { description: 'Result', content: { 'application/json': { schema: { type: 'object' } } } } } }) },
    '/v1/organizer/webhook-endpoints/{id}/verify': { post: op('Run the verification handshake', 'webhooks:manage', { parameters: [{ name: 'id', in: 'path', required: true, schema: str }], responses: { 200: { description: '{ ok, host, reason? }', content: { 'application/json': { schema: { type: 'object' } } } } } }) },
    '/v1/organizer/webhook-deliveries': { get: op('The delivery log', 'webhooks:manage', { parameters: [limitP, cursorP], responses: ok('WebhookDeliveryList') }) },
    '/v1/organizer/webhook-deliveries/{id}/retry': { post: op('Retry a failed or dead delivery (bounded)', 'webhooks:manage', { parameters: [{ name: 'id', in: 'path', required: true, schema: str }], responses: { 200: { description: '{ queued } | { alreadyQueued }', content: { 'application/json': { schema: { type: 'object' } } } } } }) },
  },
  webhooks: Object.fromEntries(WEBHOOK_EVENT_TYPES.map(type => [type, { post: {
    summary: `${type} delivery`, description: 'Headers: X-FitFlex-Event-Id (dedupe on it), X-FitFlex-Event-Type, X-FitFlex-Timestamp (unix seconds), X-FitFlex-Delivery-Attempt, X-FitFlex-Signature: v1=hex(HMAC_SHA256(secret, timestamp + "." + rawBody)). Answer 2xx quickly.',
    requestBody: { content: { 'application/json': { schema: ref('WebhookEnvelope') } } }, responses: { 200: { description: 'Acknowledged' } },
  } }])),
  components: {
    securitySchemes: { oauth2: { type: 'oauth2', flows: { clientCredentials: { tokenUrl: '/v1/organizer/token', scopes: {
      'registrations:read': 'Read registrations (names, category, status, bib, kit).', 'registrations:demographics': 'Also gender and age on event day.', 'kit:write': 'Record kit handovers.', 'bibs:write': 'Assign bib numbers.', 'webhooks:manage': 'Manage webhooks (granted by the organizer owner only).',
    } } } } },
    schemas,
  },
};

const text = `${JSON.stringify(doc, null, 2)}\n`;
if (process.argv.includes('--stdout')) process.stdout.write(text);
else writeFileSync(new URL('../docs/api/organizer-api-v1.openapi.json', import.meta.url), text);
export { doc, text };
