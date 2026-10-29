// Marathon & running events · S5 — the /v1/organizer endpoints (spec §5.3–§5.5): field minimisation by scope, pagination, writes with
// Idempotency-Key, event restriction, SCENARIO 19 (cross-event / cross-organizer access), the sandbox, error shapes.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ensureInit } from '../functions/index.mjs';
import {
  apiListEvents, apiListRegistrations, apiRegistrationChanges, apiGetRegistration, apiCollectKit, apiAssignBib, apiAssignBibBatch, apiOpenapi, apiListWebhookEndpoints,
} from '../functions/events-organizer-api.mjs';
import { harness, s5On, s5Off, db } from './fixtures/events-s5.mjs';
import { resetApiAuthLimits } from '../src/auth/organizer-api-auth.mjs';
import { resetSandbox } from '../src/shared/organizer-api-sandbox.mjs';

await ensureInit();
const h = harness();
const { call } = h;
afterEach(() => { resetApiAuthLimits(); resetSandbox(); s5Off(); });
after(async () => { await h.cleanup(); await db.destroy(); });

const FORBIDDEN_KEY = /phone|email|dateOfBirth|dob|emergency|purchaser|participantUserId|payment|amount|price|token(?!Type)|secret|hash|claim(?!ed)/i;
const keysOf = (v, out = []) => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); keysOf(x, out); } return out; };
const api = async (c, route, { params = {}, query = {}, body = {}, headers = {} } = {}) => call(route, null, { params, query, body, headers: { ...(await c.bearer()), ...headers } });

async function fixture(scopes = ['registrations:read']) {
  s5On();
  const f = await h.kitEvent({ n: 3 });
  const c = await h.apiClient(f.organizer, { scopes });
  return { f, c };
}

test('field minimisation: registrations:read yields the minimal set; NO key in any /v1 output is phone, email, DOB, emergency contact, payer or payment data, user ids, claim state or token material', async () => {
  const { f, c } = await fixture();
  await db('EventRegistration').where({ id: f.regs[0].id }).update({ gender: 'female', dateOfBirth: '1990-05-05', email: 'a@example.com', emailNormalized: 'a@example.com', emergencyContact: JSON.stringify({ name: 'Mum', phone: '+255700000001' }) });
  const list = await api(c, apiListRegistrations, { params: { eventId: f.event.id } });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.items.length, 3);
  const one = await api(c, apiGetRegistration, { params: { registrationId: f.regs[0].id } });
  const feed = await api(c, apiRegistrationChanges, { params: { eventId: f.event.id }, query: { expand: 'registration' } });
  const events = await api(c, apiListEvents);
  for (const [name, body] of [['list', list.body], ['one', one.body], ['feed', feed.body], ['events', events.body]]) {
    assert.deepEqual(keysOf(body).filter(k => FORBIDDEN_KEY.test(k) && !['orderId'].includes(k)), [], name);
    assert.ok(!/@example|1990-05-05|Mum|2557000/.test(JSON.stringify(body)), `${name}: no contact value either`);
  }
  const rec = list.body.items.find(r => r.id === f.regs[0].id);
  assert.deepEqual(Object.keys(rec).sort(), ['bibNumber', 'categoryId', 'categoryName', 'claimed', 'createdAt', 'eventId', 'firstName', 'groupLabel', 'id', 'kit', 'kitSize', 'lastName', 'orderId', 'status', 'teamId', 'teamName', 'ticketCode', 'ticketTypeId', 'ticketTypeName', 'updatedAt']);
  assert.ok(!('gender' in rec) && !('ageOnEventDay' in rec));
  assert.equal(rec.status, 'confirmed');
  // the events list: no pricing, payout schedule, terms or commission
  assert.deepEqual(Object.keys(events.body.items[0]).sort(), ['categories', 'collectionPoints', 'endsAt', 'id', 'slug', 'startsAt', 'status', 'timezone', 'title']);
  assert.ok(!JSON.stringify(events.body).includes('payoutSchedule') && !JSON.stringify(events.body).includes('commission'));
});

test('registrations:demographics adds gender and ageOnEventDay (computed on the event day; the birth date is never returned)', async () => {
  const { f, c } = await fixture(['registrations:read', 'registrations:demographics']);
  await db('EventRegistration').where({ id: f.regs[0].id }).update({ gender: 'female', dateOfBirth: '1990-05-05' });
  const rec = (await api(c, apiGetRegistration, { params: { registrationId: f.regs[0].id } })).body.registration;
  assert.equal(rec.gender, 'female');
  const start = new Date((await db('Event').where({ id: f.event.id }).first()).startsAt);
  const expected = start.getUTCFullYear() - 1990 - ((start.getUTCMonth() + 1 < 5 || (start.getUTCMonth() + 1 === 5 && start.getUTCDate() < 5)) ? 1 : 0);
  assert.ok([expected, expected - 1, expected + 1].includes(rec.ageOnEventDay), `${rec.ageOnEventDay} vs ${expected}`);
  assert.ok(!JSON.stringify(rec).includes('1990'));
});

test('pagination: cursor + limit, stable order, no gaps; bad cursor / limit → 400; filters; a cancelled place is a tombstone without names', async () => {
  const { f, c } = await fixture();
  const p1 = await api(c, apiListRegistrations, { params: { eventId: f.event.id }, query: { limit: '2' } });
  const p2 = await api(c, apiListRegistrations, { params: { eventId: f.event.id }, query: { limit: '2', cursor: p1.body.nextCursor } });
  assert.deepEqual([p1.body.items.length, p2.body.items.length, p2.body.nextCursor], [2, 1, null]);
  assert.equal(new Set([...p1.body.items, ...p2.body.items].map(r => r.id)).size, 3);
  for (const query of [{ limit: '0' }, { limit: '201' }, { limit: 'x' }]) assert.equal((await api(c, apiListRegistrations, { params: { eventId: f.event.id }, query })).body.error, 'invalid_limit');
  assert.equal((await api(c, apiListRegistrations, { params: { eventId: f.event.id }, query: { cursor: '!!' } })).body.error, 'invalid_cursor');
  assert.equal((await api(c, apiListRegistrations, { params: { eventId: f.event.id }, query: { status: 'reserved' } })).status, 400, 'unpaid places can never be requested');
  await db('EventRegistration').where({ id: f.regs[2].id }).update({ status: 'cancelled', cancelledAt: new Date() });
  const cancelled = await api(c, apiListRegistrations, { params: { eventId: f.event.id }, query: { status: 'cancelled' } });
  assert.deepEqual([cancelled.body.items.length, cancelled.body.items[0].status, cancelled.body.items[0].firstName, cancelled.body.items[0].lastName], [1, 'cancelled', null, null]);
  await db('EventRegistration').where({ id: f.regs[1].id }).update({ status: 'reserved', paidAt: null });
  assert.equal((await api(c, apiListRegistrations, { params: { eventId: f.event.id } })).body.items.length, 2, 'a reserved (unpaid) place never appears');
  assert.equal((await api(c, apiGetRegistration, { params: { registrationId: f.regs[1].id } })).status, 404);
  const since = await api(c, apiListRegistrations, { params: { eventId: f.event.id }, query: { updatedSince: new Date(Date.now() + 60_000).toISOString() } });
  assert.deepEqual(since.body.items, []);
});

test('SCENARIO 19 — cross-organizer and cross-event access: another organizer\'s event or registration is 404 with a body identical to a nonexistent id, on every route', async () => {
  const { f, c } = await fixture(['registrations:read', 'kit:write', 'bibs:write']);
  const b = await h.kitEvent({ n: 1 });
  const key = { 'idempotency-key': 'scenario19-key' };
  const cases = [
    [apiListRegistrations, { params: { eventId: b.event.id } }, { params: { eventId: 'evt_missing' } }],
    [apiRegistrationChanges, { params: { eventId: b.event.id } }, { params: { eventId: 'evt_missing' } }],
    [apiGetRegistration, { params: { registrationId: b.regs[0].id } }, { params: { registrationId: 'ereg_missing' } }],
    [apiCollectKit, { params: { eventId: b.event.id }, headers: key, body: { method: 'manual', registrationId: b.regs[0].id, manualReason: 'other', collectionPointId: b.points[0].id } }, { params: { eventId: 'evt_missing' }, headers: key, body: { method: 'manual', registrationId: 'x', manualReason: 'other' } }],
    [apiAssignBib, { params: { eventId: b.event.id }, headers: key, body: { registrationId: b.regs[0].id, bibNumber: '5' } }, { params: { eventId: 'evt_missing' }, headers: key, body: { registrationId: 'x', bibNumber: '5' } }],
    [apiAssignBibBatch, { params: { eventId: b.event.id }, headers: key, body: { items: [{ registrationId: b.regs[0].id, bibNumber: '5' }] } }, { params: { eventId: 'evt_missing' }, headers: key, body: { items: [{ registrationId: 'x', bibNumber: '5' }] } }],
  ];
  for (const [route, cross, missing] of cases) {
    const x = await api(c, route, cross); const y = await api(c, route, missing);
    assert.equal(x.status, 404, route.path);
    assert.deepEqual(x.body.error === 'event_not_found' || x.body.error === 'registration_not_found', true);
    assert.deepEqual(x, y, `${route.path}: B's id and a nonexistent id answer identically`);
  }
  assert.equal(await db('EventKitCollection').where({ eventId: b.event.id }).first(), undefined);
  assert.equal(await db('EventBibAssignment').where({ eventId: b.event.id }).first(), undefined);
  // the events list shows only my events
  assert.deepEqual((await api(c, apiListEvents)).body.items.map(e => e.id), [f.event.id]);
  // a ticket of B scanned through MY client at MY event is unknown
  const scan = await api(c, apiCollectKit, { params: { eventId: f.event.id }, headers: { 'idempotency-key': 'scenario19-scan' }, body: { method: 'scan', payload: b.regs[0].payload, collectionPointId: f.points[0].id } });
  assert.deepEqual([scan.status, scan.body.error], [404, 'registration_not_found']);
});

test('SCENARIO 19 — an eventIds-restricted client is 404 for another event of the SAME organizer on every route; the list is filtered', async () => {
  s5On();
  const f = await h.kitEvent({ n: 2 });
  const second = await h.kitEvent({ organizer: f.organizer, n: 2 });
  const c = await h.apiClient(f.organizer, { scopes: ['registrations:read', 'kit:write'], eventIds: [f.event.id] });
  assert.equal((await api(c, apiListRegistrations, { params: { eventId: f.event.id } })).status, 200);
  for (const [route, params, extra] of [[apiListRegistrations, { eventId: second.event.id }, {}], [apiRegistrationChanges, { eventId: second.event.id }, {}], [apiGetRegistration, { registrationId: second.regs[0].id }, {}],
    [apiCollectKit, { eventId: second.event.id }, { headers: { 'idempotency-key': 'restricted-key-1' }, body: { method: 'manual', registrationId: second.regs[0].id, manualReason: 'other', collectionPointId: second.points[0].id } }]]) {
    const r = await api(c, route, { params, ...extra });
    assert.equal(r.status, 404, route.path);
  }
  assert.deepEqual((await api(c, apiListEvents)).body.items.map(e => e.id), [f.event.id]);
});

test('writes: Idempotency-Key required (400); a replay returns the original (200 + Idempotent-Replayed) and writes nothing; a reused key with another body is 409; the row records the API client, not a staff user', async () => {
  const { f, c } = await fixture(['registrations:read', 'kit:write', 'bibs:write']);
  const body = { method: 'scan', payload: f.regs[0].payload, collectionPointId: f.points[0].id };
  assert.deepEqual((await api(c, apiCollectKit, { params: { eventId: f.event.id }, body })).body, { error: 'idempotency_key_required' });
  const first = await api(c, apiCollectKit, { params: { eventId: f.event.id }, headers: { 'idempotency-key': 'collect-key-0001' }, body });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const row = await db('EventKitCollection').where({ registrationId: f.regs[0].id }).first();
  assert.deepEqual([row.apiClientId, row.staffUserId, row.method], [c.client.id, null, 'api']);
  const res = { headers: {}, statusCode: 200, status(x) { this.statusCode = x; return this; }, json(b) { this.body = b; return this; }, set(k, v) { this.headers[k] = v; return this; } };
  const req = { method: 'POST', headers: { ...(await c.bearer()), 'idempotency-key': 'collect-key-0001' }, params: { eventId: f.event.id }, query: {}, body, ip: '10.2.2.2', get: () => null };
  for (const g of [apiCollectKit.onGuard].flat()) await g(req, res, () => {});
  await apiCollectKit.onRequest(req, res);
  assert.deepEqual([res.statusCode, res.headers['Idempotent-Replayed']], [200, 'true']);
  assert.deepEqual(res.body.collection, first.body.collection);
  assert.equal((await db('EventKitCollection').where({ registrationId: f.regs[0].id })).length, 1);
  const reused = await api(c, apiCollectKit, { params: { eventId: f.event.id }, headers: { 'idempotency-key': 'collect-key-0001' }, body: { ...body, payload: f.regs[1].payload } });
  assert.deepEqual([reused.status, reused.body.error], [409, 'idempotency_key_reused']);
  // another client with the same key is a different scope: not a replay
  const d = await h.apiClient(f.organizer, { scopes: ['registrations:read', 'kit:write'] });
  const other = await api(d, apiCollectKit, { params: { eventId: f.event.id }, headers: { 'idempotency-key': 'collect-key-0001' }, body });
  assert.deepEqual([other.status, other.body.error], [409, 'already_collected']);
  // bibs: single, replace needs a reason, batch is per item and not atomic
  const bib = await api(c, apiAssignBib, { params: { eventId: f.event.id }, headers: { 'idempotency-key': 'bib-key-00001' }, body: { registrationId: f.regs[0].id, bibNumber: 'ap-1' } });
  assert.deepEqual([bib.status, bib.body.assignment.bibNumber], [201, 'AP-1']);
  assert.equal((await db('EventBibAssignment').where({ registrationId: f.regs[0].id }).first()).assignedByApiClientId, c.client.id);
  assert.equal((await api(c, apiAssignBib, { params: { eventId: f.event.id }, headers: { 'idempotency-key': 'bib-key-00002' }, body: { registrationId: f.regs[0].id, bibNumber: 'ap-2', replace: true } })).body.error, 'reason_required');
  const batch = await api(c, apiAssignBibBatch, { params: { eventId: f.event.id }, headers: { 'idempotency-key': 'batch-key-0001' }, body: { items: [
    { clientRef: 'a', registrationId: f.regs[1].id, bibNumber: 'ap-1' }, { clientRef: 'b', registrationId: f.regs[1].id, bibNumber: 'ap-3' }, { clientRef: 'c', registrationId: 'ereg_nope', bibNumber: 'ap-4' }, { clientRef: 'd', registrationId: f.regs[2].id, bibNumber: '!!' } ] } });
  assert.equal(batch.status, 200, JSON.stringify(batch.body));
  assert.deepEqual(batch.body.results, [{ clientRef: 'a', ok: false, error: 'bib_taken' }, { clientRef: 'b', ok: true, bibNumber: 'AP-3' }, { clientRef: 'c', ok: false, error: 'registration_not_found' }, { clientRef: 'd', ok: false, error: 'bib_invalid' }]);
  assert.equal((await api(c, apiAssignBibBatch, { params: { eventId: f.event.id }, headers: { 'idempotency-key': 'batch-key-0002' }, body: { items: Array.from({ length: 501 }, () => ({})) } })).status, 413);
});

test('scope enforcement per route: a registrations:read client cannot write; a kit:write client cannot assign bibs; webhooks:manage is needed for the webhook routes', async () => {
  const { f, c } = await fixture(['registrations:read']);
  const writeKit = { params: { eventId: f.event.id }, headers: { 'idempotency-key': 'scope-key-0001' }, body: { method: 'scan', payload: f.regs[0].payload, collectionPointId: f.points[0].id } };
  assert.deepEqual((await api(c, apiCollectKit, writeKit)).body, { error: 'insufficient_scope', requiredScope: 'kit:write' });
  assert.deepEqual((await api(c, apiAssignBib, { params: { eventId: f.event.id }, headers: writeKit.headers, body: {} })).body, { error: 'insufficient_scope', requiredScope: 'bibs:write' });
  assert.deepEqual((await api(c, apiListWebhookEndpoints)).body, { error: 'insufficient_scope', requiredScope: 'webhooks:manage' });
  const kitOnly = await h.apiClient(f.organizer, { scopes: ['registrations:read', 'kit:write'] });
  assert.equal((await api(kitOnly, apiAssignBib, { params: { eventId: f.event.id }, headers: writeKit.headers, body: {} })).body.error, 'insufficient_scope');
  const noRead = await db('ApiClient').where({ id: kitOnly.client.id }).update({ scopes: JSON.stringify(['kit:write']) });
  void noRead;
  assert.equal((await api(kitOnly, apiListEvents)).status, 200, 'any valid client may list events');
});

test('flags: EVENTS_ORGANIZER_API off → every /v1 route 404 feature_disabled; EVENTS_KIT_OPS off → kit and bib writes 404 while reads work', async () => {
  const { f, c } = await fixture(['registrations:read', 'kit:write', 'bibs:write']);
  const bearer = await c.bearer();
  s5Off(); s5On({ kit: false });
  assert.equal((await call(apiListEvents, null, { headers: bearer })).status, 200);
  assert.deepEqual((await call(apiCollectKit, null, { params: { eventId: f.event.id }, headers: { ...bearer, 'idempotency-key': 'flag-key-00001' }, body: {} })).body, { error: 'feature_disabled' });
  assert.equal((await call(apiAssignBib, null, { params: { eventId: f.event.id }, headers: { ...bearer, 'idempotency-key': 'flag-key-00001' }, body: {} })).status, 404);
  s5Off();
  for (const [route, params] of [[apiListEvents, {}], [apiListRegistrations, { eventId: f.event.id }], [apiOpenapi, {}]]) assert.deepEqual(await call(route, null, { params, headers: bearer }), { status: 404, body: { error: 'feature_disabled' } });
});

test('SANDBOX: fixture event, 25 fake registrations, no contact data; writes answer as if applied (409 on a repeat) but persist NOTHING; X-FitFlex-Sandbox; cannot reach real data', async () => {
  s5On();
  const f = await h.kitEvent({ n: 2 });
  const c = await h.apiClient(f.organizer, { scopes: ['registrations:read', 'registrations:demographics', 'kit:write', 'bibs:write'], environment: 'sandbox' });
  const bearer = await c.bearer();
  const events = await call(apiListEvents, null, { headers: bearer });
  assert.deepEqual(events.body.items.map(e => e.id), ['evt_sandbox']);
  assert.equal(events.body.items[0].categories.length, 3);
  assert.equal(events.body.items[0].collectionPoints.length, 2);
  const list = await call(apiListRegistrations, null, { params: { eventId: 'evt_sandbox' }, query: { limit: '200' }, headers: bearer });
  assert.equal(list.body.items.length, 25);
  assert.ok(list.body.items.filter(r => r.firstName).every(r => r.firstName === 'Test' && /^Runner \d\d$/.test(r.lastName)));
  assert.deepEqual(keysOf(list.body).filter(k => /phone|email|dateOfBirth|emergency/i.test(k)), []);
  assert.ok('ageOnEventDay' in list.body.items[0]);
  // the real event is unreachable
  const real = await call(apiListRegistrations, null, { params: { eventId: f.event.id }, headers: bearer });
  assert.deepEqual([real.status, real.body.error], [404, 'event_not_found']);
  assert.equal((await call(apiGetRegistration, null, { params: { registrationId: f.regs[0].id }, headers: bearer })).status, 404);
  const before = { kit: (await db('EventKitCollection').count({ n: '*' }).first()).n, bib: (await db('EventBibAssignment').count({ n: '*' }).first()).n, idem: (await db('OrganizerIdempotency').count({ n: '*' }).first()).n };
  const body = { method: 'manual', registrationId: 'ereg_sandbox_10', manualReason: 'other', collectionPointId: 'ecp_sandbox_a' };
  const k = { ...bearer, 'idempotency-key': 'sandbox-key-001' };
  const first = await call(apiCollectKit, null, { params: { eventId: 'evt_sandbox' }, headers: k, body });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const again = await call(apiCollectKit, null, { params: { eventId: 'evt_sandbox' }, headers: { ...k, 'idempotency-key': 'sandbox-key-002' }, body });
  assert.deepEqual([again.status, again.body.error], [409, 'already_collected']);
  assert.deepEqual((await call(apiCollectKit, null, { params: { eventId: 'evt_sandbox' }, headers: bearer, body })).body, { error: 'idempotency_key_required' });
  const bib = await call(apiAssignBib, null, { params: { eventId: 'evt_sandbox' }, headers: k, body: { registrationId: 'ereg_sandbox_20', bibNumber: 'sb-900' } });
  assert.deepEqual([bib.status, bib.body.assignment.bibNumber], [201, 'SB-900']);
  assert.equal((await call(apiAssignBib, null, { params: { eventId: 'evt_sandbox' }, headers: k, body: { registrationId: 'ereg_sandbox_21', bibNumber: 'sb-001' } })).body.error, 'bib_taken');
  const after = { kit: (await db('EventKitCollection').count({ n: '*' }).first()).n, bib: (await db('EventBibAssignment').count({ n: '*' }).first()).n, idem: (await db('OrganizerIdempotency').count({ n: '*' }).first()).n };
  assert.deepEqual(after, before, 'a sandbox write persists nothing');
  const res = { headers: {}, statusCode: 200, status(x) { this.statusCode = x; return this; }, json(b) { this.body = b; return this; }, set(kk, v) { this.headers[kk] = v; return this; } };
  await apiListEvents.onRequest({ method: 'GET', headers: bearer, params: {}, query: {}, body: {}, ip: '10.3.3.3', apiClient: { id: c.client.id, environment: 'sandbox', scopes: [], organizerId: f.organizer.id, eventIds: ['evt_sandbox'] } }, res);
  assert.equal(res.headers['X-FitFlex-Sandbox'], 'true');
  // the feed: 25 changes, the cancelled one is a tombstone
  const feed = await call(apiRegistrationChanges, null, { params: { eventId: 'evt_sandbox' }, query: { limit: '100' }, headers: bearer });
  assert.equal(feed.body.items.length, 25);
  assert.equal(feed.body.items[24].status, 'cancelled');
});

test('5xx bodies carry the request id and nothing else of the error', async () => {
  const { c } = await fixture();
  const res = { headers: {}, statusCode: 200, status(x) { this.statusCode = x; return this; }, json(b) { this.body = b; return this; }, set(k, v) { this.headers[k] = v; return this; } };
  const req = { method: 'GET', headers: await c.bearer(), params: {}, query: {}, body: {}, ip: '10.3.3.4', get: () => null };
  for (const g of [apiListEvents.onGuard].flat()) await g(req, res, () => {});
  req.query = { limit: { toString() { throw new Error('boom: secret internals'); } } };
  await apiListEvents.onRequest(req, res);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(Object.keys(res.body).sort(), ['error', 'requestId']);
  assert.ok(!JSON.stringify(res.body).includes('boom'));
});
