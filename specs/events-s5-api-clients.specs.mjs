// Marathon & running events · S5 — API client management (spec §5.1): secret shown once and stored as a hash, scopes, the D39 pilot gate,
// rotation with grace, revocation, limits, notices, audit without secrets.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ensureInit } from '../functions/index.mjs';
import {
  organizerCreateApiClient, organizerListApiClients, organizerGetApiClient, organizerUpdateApiClient, organizerRotateApiClient, organizerRevokeApiClient, resetEventsIntegrationsLimits,
} from '../functions/events-integrations.mjs';
import { adminOrganizerApiAccess, adminSetApiClientRate } from '../functions/events-admin-s5.mjs';
import { apiListEvents } from '../functions/events-organizer-api.mjs';
import { harness, s5On, s5Off, db } from './fixtures/events-s5.mjs';
import { hashSecret, matchSecret, SECRET_RE, CLIENT_ID_RE, resetApiAuthLimits } from '../src/auth/organizer-api-auth.mjs';

await ensureInit();
const h = harness();
const { call } = h;
afterEach(() => { resetEventsIntegrationsLimits(); resetApiAuthLimits(); s5Off(); });
after(async () => { await h.cleanup(); await db.destroy(); });

const create = (claims, body) => call(organizerCreateApiClient, claims, { body: { name: 'Timing partner', environment: 'live', scopes: ['registrations:read'], ...body } });
const walk = (v, out = []) => { if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x, out); else out.push(String(v)); return out; };

test('create: 201 with the secret ONCE; the row holds only sha256(secret); list, detail, audit and notices never contain it', async () => {
  s5On();
  const o = await h.org();
  const r = await create(o.owner, { scopes: ['registrations:read', 'registrations:demographics'] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.clientSecret, SECRET_RE);
  assert.match(r.body.client.clientId, CLIENT_ID_RE);
  assert.equal(r.body.client.environment, 'live');
  assert.equal(r.body.client.status, 'active');
  const row = await db('ApiClient').where({ id: r.body.client.id }).first();
  assert.equal(row.secretHash, hashSecret(r.body.clientSecret));
  assert.equal(row.secretHash.length, 64);
  const list = await call(organizerListApiClients, o.admin, {});
  const detail = await call(organizerGetApiClient, o.admin, { params: { id: r.body.client.id } });
  for (const body of [list.body, detail.body]) assert.ok(!JSON.stringify(body).includes(r.body.clientSecret) && !JSON.stringify(body).includes(row.secretHash));
  assert.deepEqual(list.body.items.map(i => i.clientId), [r.body.client.clientId]);
  // nothing anywhere holds the secret: the client row, the audit log, notifications, idempotency
  for (const table of ['ApiClient', 'AuditLog', 'Notification', 'OutboxEvent', 'OrganizerIdempotency']) assert.ok(!JSON.stringify(await db(table).select('*').limit(5000)).includes(r.body.clientSecret), `${table} holds the secret`);
  const audit = await db('AuditLog').where({ action: 'events.api_client_created', target: r.body.client.id });
  assert.equal(audit.length, 1);
  assert.deepEqual(walk(audit[0].after).filter(v => /ffs_|[0-9a-f]{64}/.test(v)), []);
  assert.ok(r.body.client.expiresAt);
  // the owner is told (a rogue admin is visible)
  const notes = await db('Notification').where({ userId: o.ownerUserId, type: 'organizer_api_client_created' });
  assert.equal(notes.length, 1);
  assert.ok(notes[0].data.titleSw);
  // the sandbox secret has its own prefix and is pinned to the sandbox event
  const sb = await create(o.owner, { environment: 'sandbox', name: 'Sandbox' });
  assert.match(sb.body.clientSecret, /^ffs_test_/);
  assert.deepEqual(sb.body.client.eventIds, ['evt_sandbox']);
});

test('D39 pilot gate: an organizer FitFlex has not enabled cannot create clients; an admin with scope events enables it (audited); the env allowlist also opens it; existing clients are refused when it closes', async () => {
  s5On();
  const o = await h.org({ apiAccess: false });
  const refused = await create(o.owner, {});
  assert.deepEqual([refused.status, refused.body.error], [403, 'api_access_not_enabled']);
  const admin = h.claimsOf(await h.user({ userType: 'admin' }), 'admin');
  assert.equal((await call(adminOrganizerApiAccess, admin, { params: { organizerId: o.id }, body: { enabled: true, reason: 'x' } })).body.error, 'reason_required');
  const on = await call(adminOrganizerApiAccess, admin, { params: { organizerId: o.id }, body: { enabled: true, reason: 'pilot organizer approved by the owner' } });
  assert.deepEqual([on.status, on.body.apiAccessEnabled], [200, true]);
  assert.equal((await db('AuditLog').where({ action: 'events.api_access_changed', target: o.id })).length, 1);
  assert.equal((await create(o.owner, {})).status, 201);
  // not an admin of the portal: no
  assert.equal((await call(adminOrganizerApiAccess, o.owner, { params: { organizerId: o.id }, body: { enabled: false, reason: 'trying to turn it off' } })).status, 403);
  // env allowlist
  const p = await h.org({ apiAccess: false });
  process.env.EVENTS_API_ORGANIZER_ALLOWLIST = `${p.id},other`;
  assert.equal((await create(p.owner, {})).status, 201);
  delete process.env.EVENTS_API_ORGANIZER_ALLOWLIST;
  assert.equal((await create(p.owner, {})).body.error, 'api_access_not_enabled', 'the allowlist is the gate, not a one-off');
  // closing the gate refuses an existing client at the guard
  const c = await h.apiClient(o, { scopes: ['registrations:read'] });
  const bearer = await c.bearer();
  assert.equal((await call(apiListEvents, null, { headers: bearer })).status, 200);
  await call(adminOrganizerApiAccess, admin, { params: { organizerId: o.id }, body: { enabled: false, reason: 'pilot paused for review' } });
  const closed = await call(apiListEvents, null, { headers: bearer });
  assert.deepEqual([closed.status, closed.body.error], [403, 'api_access_not_enabled']);
});

test('roles and flags: only an owner or admin manages clients; timing / ops / finance 403; flag off → 404 feature_disabled', async () => {
  s5On();
  const o = await h.org();
  for (const role of ['ops', 'timing', 'finance']) assert.deepEqual([(await create(o[role], {})).status, (await call(organizerListApiClients, o[role], {})).status], [403, 403], role);
  assert.equal((await create(o.admin, {})).status, 201);
  s5Off(); s5On({ api: false });
  assert.deepEqual((await create(o.owner, {})).body, { error: 'feature_disabled' });
  assert.equal((await call(organizerListApiClients, o.owner, {})).status, 404);
  s5Off();
  assert.equal((await create(o.owner, {})).status, 404);
});

test('scopes are a closed list: unknown → invalid_scope; results:write reserved; webhooks:manage is the OWNER\'s alone and never on sandbox; write scopes need registrations:read', async () => {
  s5On();
  const o = await h.org();
  assert.deepEqual([(await create(o.owner, { scopes: ['admin:everything'] })).status, (await create(o.owner, { scopes: ['admin:everything'] })).body.error], [422, 'invalid_scope']);
  assert.equal((await create(o.owner, { scopes: ['registrations:read', 'results:write'] })).body.error, 'scope_not_available');
  assert.equal((await create(o.owner, { scopes: [] })).body.error, 'validation_failed');
  assert.equal((await create(o.owner, { scopes: ['kit:write'] })).body.error, 'validation_failed');
  const adminTry = await create(o.admin, { scopes: ['registrations:read', 'webhooks:manage'] });
  assert.deepEqual([adminTry.status, adminTry.body.error], [403, 'forbidden_role']);
  assert.equal((await create(o.owner, { scopes: ['registrations:read', 'webhooks:manage'] })).status, 201);
  assert.equal((await create(o.owner, { environment: 'sandbox', scopes: ['registrations:read', 'webhooks:manage'] })).body.error, 'scope_not_available');
  const ok = await create(o.admin, { scopes: ['registrations:read'] });
  // an admin cannot widen to webhooks:manage afterwards either
  const widen = await call(organizerUpdateApiClient, o.admin, { params: { id: ok.body.client.id }, body: { scopes: ['registrations:read', 'webhooks:manage'] } });
  assert.deepEqual([widen.status, widen.body.error], [403, 'forbidden_role']);
  const owner = await call(organizerUpdateApiClient, o.owner, { params: { id: ok.body.client.id }, body: { scopes: ['registrations:read', 'kit:write'], name: 'Renamed' } });
  assert.deepEqual([owner.status, owner.body.client.scopes, owner.body.client.name], [200, ['registrations:read', 'kit:write'], 'Renamed']);
  const audit = await db('AuditLog').where({ action: 'events.api_client_updated', target: ok.body.client.id });
  assert.deepEqual(audit[0].after.scopesAdded, ['kit:write']);
});

test('limits and shape: event restriction must be the organizer\'s own events; expiry mandatory and bounded; at most EVENTS_API_MAX_CLIENTS active; name 1–60', async () => {
  s5On();
  const o = await h.org();
  const other = await h.kitEvent({ n: 0 });
  const mine = await h.kitEvent({ organizer: o, n: 0 });
  assert.equal((await create(o.owner, { eventIds: [other.event.id] })).body.error, 'validation_failed');
  const restricted = await create(o.owner, { eventIds: [mine.event.id] });
  assert.deepEqual(restricted.body.client.eventIds, [mine.event.id]);
  for (const bad of [0, 731, 1.5, '30']) assert.equal((await create(o.owner, { expiresInDays: bad })).body.error, 'validation_failed', String(bad));
  assert.equal((await create(o.owner, { name: '' })).status, 422);
  assert.equal((await create(o.owner, { name: 'x'.repeat(61) })).status, 422);
  const exp = new Date(restricted.body.client.expiresAt) - Date.now();
  assert.ok(exp > 364 * 86_400_000 && exp <= 366 * 86_400_000, 'default one year');
  process.env.EVENTS_API_MAX_CLIENTS = '2';
  assert.equal((await create(o.owner, {})).status, 201);
  assert.deepEqual([(await create(o.owner, {})).status, (await create(o.owner, {})).body.error], [409, 'client_limit_reached']);
});

test('rotation: a new secret once; 24 h overlap → both secrets work; graceHours 0 kills the old one now; a second rotation replaces the previous secret; the old secret dies at the end of the window', async () => {
  s5On();
  const o = await h.org();
  const c = await h.apiClient(o, {});
  const oldSecret = c.secret;
  const rot = await call(organizerRotateApiClient, o.owner, { params: { id: c.client.id }, body: {} });
  assert.equal(rot.status, 200, JSON.stringify(rot.body));
  assert.match(rot.body.clientSecret, SECRET_RE);
  assert.notEqual(rot.body.clientSecret, oldSecret);
  assert.equal(rot.body.client.rotation.inGrace, true);
  const row = await db('ApiClient').where({ id: c.client.id }).first();
  assert.deepEqual([row.secretVersion, row.previousSecretHash], [2, hashSecret(oldSecret)]);
  assert.ok(+new Date(row.previousSecretExpiresAt) - Date.now() > 23 * 3_600_000);
  assert.equal(matchSecret({ ...row }, oldSecret), 'previous');
  assert.equal(matchSecret({ ...row }, rot.body.clientSecret), 'current');
  assert.ok(!JSON.stringify(await db('AuditLog').select('*').limit(5000)).includes(rot.body.clientSecret));
  // after the window only the new secret
  await db('ApiClient').where({ id: c.client.id }).update({ previousSecretExpiresAt: new Date(Date.now() - 1000) });
  assert.equal(matchSecret(await db('ApiClient').where({ id: c.client.id }).first(), oldSecret), null);
  // 0: the old secret ends now; and a second rotation replaces the previous one (only one old secret ever lives)
  const zero = await call(organizerRotateApiClient, o.owner, { params: { id: c.client.id }, body: { graceHours: 0 } });
  const r0 = await db('ApiClient').where({ id: c.client.id }).first();
  assert.deepEqual([r0.previousSecretHash, r0.previousSecretExpiresAt, r0.secretVersion], [null, null, 3]);
  assert.equal(matchSecret(r0, rot.body.clientSecret), null);
  assert.equal(zero.body.client.rotation.inGrace, false);
  assert.equal((await call(organizerRotateApiClient, o.owner, { params: { id: c.client.id }, body: { graceHours: 12 } })).body.error, 'validation_failed');
  const third = await call(organizerRotateApiClient, o.owner, { params: { id: c.client.id }, body: { graceHours: 72 } });
  await call(organizerRotateApiClient, o.owner, { params: { id: c.client.id }, body: { graceHours: 24 } });
  const r2 = await db('ApiClient').where({ id: c.client.id }).first();
  assert.equal(r2.previousSecretHash, hashSecret(third.body.clientSecret), 'the latest rotation replaced the earlier previous secret: only ONE old secret ever lives');
  assert.equal(matchSecret(r2, zero.body.clientSecret), null);
  assert.equal((await db('AuditLog').where({ action: 'events.api_client_rotated', target: c.client.id })).length, 5 - 1);
});

test('revoke: immediate, idempotent, notifies the owner, blocks rotate and update; the next /v1 call with an unexpired token fails', async () => {
  s5On();
  const o = await h.org();
  const c = await h.apiClient(o, {});
  const bearer = await c.bearer();
  assert.equal((await call(apiListEvents, null, { headers: bearer })).status, 200);
  const rev = await call(organizerRevokeApiClient, o.admin, { params: { id: c.client.id }, body: { reason: 'laptop stolen' } });
  assert.deepEqual([rev.status, rev.body.changed, rev.body.client.status], [200, true, 'revoked']);
  assert.deepEqual((await call(organizerRevokeApiClient, o.admin, { params: { id: c.client.id }, body: {} })).body.changed, false);
  assert.equal((await call(apiListEvents, null, { headers: bearer })).status, 401, 'an unexpired token dies with the client');
  assert.equal((await call(organizerRotateApiClient, o.owner, { params: { id: c.client.id }, body: {} })).body.error, 'client_not_active');
  assert.equal((await call(organizerUpdateApiClient, o.owner, { params: { id: c.client.id }, body: { name: 'x' } })).body.error, 'client_not_active');
  assert.equal((await db('Notification').where({ userId: o.ownerUserId, type: 'organizer_api_client_revoked' })).length, 1);
  // another organizer cannot see or touch it (404, same as a missing id)
  const b = await h.org();
  const cross = await call(organizerRevokeApiClient, b.owner, { params: { id: c.client.id }, body: {} });
  const missing = await call(organizerRevokeApiClient, b.owner, { params: { id: 'acl_missing' }, body: {} });
  assert.deepEqual(cross, missing);
  assert.equal(cross.status, 404);
  assert.deepEqual((await call(organizerListApiClients, b.owner, {})).body.items, []);
});

test('admin can raise a client\'s rate limit (1–600); organizers cannot', async () => {
  s5On();
  const o = await h.org();
  const c = await h.apiClient(o, {});
  const admin = h.claimsOf(await h.user({ userType: 'admin' }), 'admin');
  assert.equal((await call(adminSetApiClientRate, admin, { params: { id: c.client.id }, body: { rateLimitPerMinute: 601 } })).status, 422);
  assert.equal((await call(adminSetApiClientRate, admin, { params: { id: c.client.id }, body: { rateLimitPerMinute: 600 } })).body.rateLimitPerMinute, 600);
  assert.equal((await call(adminSetApiClientRate, o.owner, { params: { id: c.client.id }, body: { rateLimitPerMinute: 600 } })).status, 403);
  assert.equal((await call(organizerUpdateApiClient, o.owner, { params: { id: c.client.id }, body: { rateLimitPerMinute: 600 } })).body.error, 'validation_failed', 'the field is not accepted from an organizer');
});
