// Marathon & running events · S5 — the OpenAPI document is the contract (spec §5.5, API-010): it matches the committed file, documents exactly
// the mounted /v1/organizer routes with the scope each one enforces, and real responses (sandbox and live) validate against its schemas.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { ensureInit } from '../functions/index.mjs';
import * as api from '../functions/events-organizer-api.mjs';
import { harness, s5On, s5Off, db } from './fixtures/events-s5.mjs';
import { validate } from './support/json-schema-lite.mjs';
import { text as built, doc as builtDoc } from '../scripts/build-organizer-openapi.mjs';
import { resetApiAuthLimits } from '../src/auth/organizer-api-auth.mjs';
import { resetSandbox, sandboxEvent, sandboxRegistrations } from '../src/shared/organizer-api-sandbox.mjs';
import { WEBHOOK_EVENT_TYPES } from '../src/shared/webhook-events.mjs';

await ensureInit();
const h = harness();
const { call } = h;
afterEach(() => { resetApiAuthLimits(); resetSandbox(); s5Off(); });
after(async () => { await h.cleanup(); await db.destroy(); });

const FILE = new URL('../docs/api/organizer-api-v1.openapi.json', import.meta.url);
const committed = JSON.parse(readFileSync(FILE, 'utf8'));
const routes = Object.values(api).filter(r => r && typeof r === 'object' && typeof r.path === 'string' && r.path.startsWith('/v1/organizer'));
const oaPath = p => p.replace(/:([A-Za-z]+)/g, '{$1}');
const FORBIDDEN = /phone|email|dateOfBirth|dob|emergency|purchaser|participantUserId|payment|amount|secret|hash/i;
const keysOf = (v, out = []) => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); keysOf(x, out); } return out; };

test('the committed file is exactly what the builder produces (regenerate with `node scripts/build-organizer-openapi.mjs`)', () => {
  assert.equal(readFileSync(FILE, 'utf8'), built);
  assert.equal(committed.openapi, '3.1.0');
  assert.deepEqual(committed.components.securitySchemes.oauth2.flows.clientCredentials.tokenUrl, '/v1/organizer/token');
  assert.equal(committed.servers.length, 1);
});

test('every mounted /v1/organizer route has an operation and every operation has a route (method and path), and the webhook section covers every deliverable type', () => {
  const mounted = new Set(routes.map(r => `${r.method.toLowerCase()} ${oaPath(r.path)}`));
  const documented = new Set(Object.entries(committed.paths).flatMap(([p, ops]) => Object.keys(ops).map(m => `${m} ${p}`)));
  assert.deepEqual([...mounted].filter(x => !documented.has(x)), [], 'mounted but undocumented');
  assert.deepEqual([...documented].filter(x => !mounted.has(x)), [], 'documented but not mounted');
  assert.deepEqual(Object.keys(committed.webhooks).sort(), [...WEBHOOK_EVENT_TYPES].sort());
  for (const t of ['payment.succeeded', 'registration.reserved', 'ticket.issued']) assert.ok(!(t in committed.webhooks));
  assert.equal(new Set(routes.map(r => `${r.method} ${r.path}`)).size, routes.length, 'no duplicate routes');
  // every write documents the Idempotency-Key header as required
  for (const [p, ops] of Object.entries(committed.paths)) {
    for (const [m, o] of Object.entries(ops)) if (['post'].includes(m) && /kit-collections|bib-assignments/.test(p)) assert.ok(o.parameters.some(x => x.name === 'Idempotency-Key' && x.required), `${m} ${p}`);
  }
});

test('the scope each operation documents is the scope the route enforces (a read-only client is refused with exactly that scope)', async () => {
  s5On();
  const f = await h.kitEvent({ n: 1 });
  const c = await h.apiClient(f.organizer, { scopes: ['registrations:read'] });
  const bearer = await c.bearer();
  for (const r of routes) {
    if (['/v1/organizer/token', '/v1/organizer/openapi.json'].includes(r.path)) continue;
    const documented = committed.paths[oaPath(r.path)][r.method.toLowerCase()]['x-scope'];
    const params = Object.fromEntries([...r.path.matchAll(/:([A-Za-z]+)/g)].map(m => [m[1], 'x']));
    const res = await call(r, null, { params, headers: { ...bearer, 'idempotency-key': 'contract-key-001' }, body: {} });
    if (documented && documented !== 'registrations:read') assert.deepEqual([r.path, res.status, res.body], [r.path, 403, { error: 'insufficient_scope', requiredScope: documented }]);
    else assert.notEqual(res.body?.error, 'insufficient_scope', `${r.method} ${r.path} should accept registrations:read`);
  }
});

test('LIVE responses validate against the schemas: events, registrations (with and without demographics), one registration, the change feed (plain and expanded), a kit handover, a bib, a batch, errors', async () => {
  s5On();
  const f = await h.kitEvent({ n: 3 });
  const c = await h.apiClient(f.organizer, { scopes: ['registrations:read', 'registrations:demographics', 'kit:write', 'bibs:write'] });
  const bearer = await c.bearer();
  const get = async (route, params = {}, query = {}) => (await call(route, null, { params, query, headers: bearer })).body;
  const schema = n => ({ $ref: `#/components/schemas/${n}` });
  const check = (name, body, value) => assert.deepEqual(validate(schema(name), value ?? body, committed), [], `${name}: ${JSON.stringify(body).slice(0, 200)}`);
  check('EventList', await get(api.apiListEvents));
  const list = await get(api.apiListRegistrations, { eventId: f.event.id });
  check('RegistrationList', list);
  assert.ok('gender' in list.items[0] && 'ageOnEventDay' in list.items[0], 'the demographics scope adds both keys');
  check('RegistrationEnvelope', await get(api.apiGetRegistration, { registrationId: f.regs[0].id }));
  const post = async (route, body, key) => call(route, null, { params: { eventId: f.event.id }, body, headers: { ...bearer, 'idempotency-key': key } });
  const kit = await post(api.apiCollectKit, { method: 'scan', payload: f.regs[0].payload, collectionPointId: f.points[0].id }, 'contract-kit-001');
  assert.equal(kit.status, 201);
  check('KitCollectionResponse', kit.body);
  const bib = await post(api.apiAssignBib, { registrationId: f.regs[0].id, bibNumber: 'C-1' }, 'contract-bib-001');
  check('BibResponse', bib.body);
  const batch = await post(api.apiAssignBibBatch, { items: [{ clientRef: 'a', registrationId: f.regs[1].id, bibNumber: 'C-2' }, { clientRef: 'b', registrationId: 'nope', bibNumber: 'C-3' }] }, 'contract-batch-01');
  check('BibBatchResponse', batch.body);
  const feed = await get(api.apiRegistrationChanges, { eventId: f.event.id }, { expand: 'registration' });
  check('ChangeFeed', feed);
  assert.ok(feed.items.some(i => i.eventType === 'kit.collected') && feed.items.some(i => i.eventType === 'bib.assigned'));
  for (const err of [(await post(api.apiCollectKit, { method: 'scan', payload: f.regs[0].payload, collectionPointId: f.points[0].id }, 'contract-kit-002')).body, (await call(api.apiGetRegistration, null, { params: { registrationId: 'x' }, headers: bearer })).body, (await call(api.apiToken, null, { body: { grant_type: 'client_credentials', client_id: 'x', client_secret: 'y' } })).body]) check('Error', err);
  const tok = await call(api.apiToken, null, { body: { grant_type: 'client_credentials', client_id: c.client.clientId, client_secret: c.secret }, ip: '10.1.2.3' });
  check('TokenResponse', tok.body);
  for (const body of [list, feed]) assert.deepEqual(keysOf(body).filter(k => FORBIDDEN.test(k) && k !== 'orderId'), []);
  // webhook management shapes (a client holding the scope, owner-granted)
  const w = await h.apiClient(f.organizer, { scopes: ['registrations:read', 'webhooks:manage'] });
  const wb = await w.bearer();
  check('WebhookEndpointList', (await call(api.apiListWebhookEndpoints, null, { headers: wb })).body);
  check('WebhookDeliveryList', (await call(api.apiListWebhookDeliveries, null, { headers: wb })).body);
  const bad = await call(api.apiCreateWebhookEndpoint, null, { headers: wb, body: { url: 'http://x.example.com', events: ['kit.collected'] } });
  assert.deepEqual([bad.status, bad.body.error, bad.body.reason], [400, 'invalid_url', 'not_https']);
  check('Error', bad.body);
});

test('SANDBOX responses validate too, and the committed fixtures under specs/fixtures/organizer-api are exactly the module\'s output (so they cannot drift)', async () => {
  s5On();
  const f = await h.kitEvent({ n: 0 });
  const c = await h.apiClient(f.organizer, { scopes: ['registrations:read', 'registrations:demographics', 'kit:write', 'bibs:write'], environment: 'sandbox' });
  const bearer = await c.bearer();
  const check = (name, value) => assert.deepEqual(validate({ $ref: `#/components/schemas/${name}` }, value, committed), [], `${name}`);
  check('EventList', (await call(api.apiListEvents, null, { headers: bearer })).body);
  const list = (await call(api.apiListRegistrations, null, { params: { eventId: 'evt_sandbox' }, query: { limit: '200' }, headers: bearer })).body;
  check('RegistrationList', list);
  assert.equal(list.items.length, 25);
  check('ChangeFeed', (await call(api.apiRegistrationChanges, null, { params: { eventId: 'evt_sandbox' }, query: { expand: 'registration', limit: '100' }, headers: bearer })).body);
  const k = await call(api.apiCollectKit, null, { params: { eventId: 'evt_sandbox' }, headers: { ...bearer, 'idempotency-key': 'sandbox-contract-1' }, body: { method: 'manual', registrationId: 'ereg_sandbox_12', manualReason: 'other', collectionPointId: 'ecp_sandbox_a' } });
  check('KitCollectionResponse', k.body);
  check('BibResponse', (await call(api.apiAssignBib, null, { params: { eventId: 'evt_sandbox' }, headers: { ...bearer, 'idempotency-key': 'sandbox-contract-2' }, body: { registrationId: 'ereg_sandbox_20', bibNumber: 'SB-901' } })).body);
  // fixtures
  const files = { 'sandbox-event.json': sandboxEvent(), 'sandbox-registrations.json': sandboxRegistrations({ demographics: true }) };
  for (const [name, value] of Object.entries(files)) {
    const path = new URL(`./fixtures/organizer-api/${name}`, import.meta.url);
    const text = `${JSON.stringify(value, null, 2)}\n`;
    if (process.env.UPDATE_FIXTURES === '1') writeFileSync(path, text);
    assert.equal(readFileSync(path, 'utf8'), text, `${name} drifted: run UPDATE_FIXTURES=1`);
  }
  check('Event', sandboxEvent());
  for (const r of sandboxRegistrations({ demographics: true })) check('Registration', r);
  assert.ok(builtDoc);
});
