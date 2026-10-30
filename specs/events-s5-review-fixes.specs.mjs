// Marathon & running events · S5 — fixes from the security, contract and Swahili reviews of PR #279 (M1 M3 M4 M5 L1 L3 L4 L6 L10, contract, F1–F4).
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ensureInit } from '../functions/index.mjs';
import {
  organizerVerifyTicket, organizerBibsBulkPreview, organizerBibsBulk, organizerBibsImportPreview, organizerBibsImport, organizerAssignBib, organizerListBibs, organizerCollectKit, verifyEventLimiterForSpecs, resetEventsOpsLimits,
} from '../functions/events-ops.mjs';
import {
  organizerCreateWebhookEndpoint, organizerUpdateWebhookEndpoint, organizerRotateWebhookSecret, organizerVerifyWebhookEndpoint, organizerEnableWebhookEndpoint, organizerDisableWebhookEndpoint,
  organizerTestWebhookEndpoint, organizerRotateApiClient, resetEventsIntegrationsLimits,
} from '../functions/events-integrations.mjs';
import { apiListWebhookEndpoints, apiAssignBibBatch } from '../functions/events-organizer-api.mjs';
import { getMyEventRegistration } from '../functions/events-registration.mjs';
import { adminCancelEvent } from '../functions/events-admin.mjs';
import { harness, s5On, s5Off, db, uid, webhookLab } from './fixtures/events-s5.mjs';
import { isBlockedAddress } from '../src/shared/webhook-url-guard.mjs';
import { eventsWebhookService } from '../src/bootstrap/services.mjs';

await ensureInit();
const h = harness();
const { call } = h;
afterEach(() => { resetEventsOpsLimits(); resetEventsIntegrationsLimits(); s5Off(); });
after(async () => { await h.cleanup(); await db.destroy(); });
const key = () => `rf_${uid('').slice(1)}`;

test('M1 — the verify limiter is keyed on (my organizer, event id): organizer A hitting B\'s event id cannot use up B\'s bucket', async () => {
  s5On();
  const a = await h.kitEvent({ n: 1 });
  const b = await h.kitEvent({ n: 1 });
  for (let i = 0; i < 6; i += 1) assert.equal((await call(organizerVerifyTicket, a.organizer.ops, { params: { id: b.event.id }, body: { payload: a.regs[0].payload } })).status, 404);
  // B's own bucket is untouched: all 600 allowances are still there
  let ok = 0;
  for (let i = 0; i < 600; i += 1) if (verifyEventLimiterForSpecs.allow(`e:${b.organizer.id}:${b.event.id}`).ok) ok += 1;
  assert.equal(ok, 600);
  assert.equal((await call(organizerVerifyTicket, b.organizer.ops, { params: { id: b.event.id }, body: { payload: b.regs[0].payload } })).status, 429, 'and only now is B at its own 600');
  // A's attempts went to A's own key for that id
  assert.equal(verifyEventLimiterForSpecs.allow(`e:${a.organizer.id}:${b.event.id}`).ok, true);
});

test('M5 (D38) — webhook create / change / rotate / verify / enable / disable are OWNER-only; admins may test; an API client holding webhooks:manage is rotated by the owner only', async () => {
  s5On();
  const f = await h.kitEvent({ n: 0 });
  const lab = webhookLab();
  const ep = await lab.endpoint(f.organizer, { events: ['kit.collected'] });
  const real = { ...f.organizer };
  const body = { url: 'https://hooks.example.test/x', events: ['kit.collected'] };
  assert.deepEqual([(await call(organizerCreateWebhookEndpoint, real.admin, { body })).status, (await call(organizerCreateWebhookEndpoint, real.admin, { body })).body.error], [403, 'forbidden_role']);
  for (const [route, extra] of [[organizerUpdateWebhookEndpoint, { body: { description: 'x' } }], [organizerRotateWebhookSecret, { body: {} }], [organizerVerifyWebhookEndpoint, {}], [organizerEnableWebhookEndpoint, {}], [organizerDisableWebhookEndpoint, {}]]) {
    const r = await call(route, real.admin, { params: { id: ep.id }, ...extra });
    assert.deepEqual([route.path, r.status, r.body.error], [route.path, 403, 'forbidden_role']);
    assert.notEqual((await call(route, real.owner, { params: { id: ep.id }, ...extra })).status, 403, `${route.path}: the owner passes the guard`);
  }
  assert.notEqual((await call(organizerTestWebhookEndpoint, real.admin, { params: { id: ep.id }, body: {} })).status, 403, 'admins may send a test');
  // API client with webhooks:manage
  const c = await h.apiClient(f.organizer, { scopes: ['registrations:read', 'webhooks:manage'] });
  const adminRot = await call(organizerRotateApiClient, real.admin, { params: { id: c.client.id }, body: {} });
  assert.deepEqual([adminRot.status, adminRot.body.error], [403, 'forbidden_role']);
  assert.equal((await call(organizerRotateApiClient, real.owner, { params: { id: c.client.id }, body: {} })).status, 200);
  const plain = await h.apiClient(f.organizer, { scopes: ['registrations:read'] });
  assert.equal((await call(organizerRotateApiClient, real.admin, { params: { id: plain.client.id }, body: {} })).status, 200, 'other clients: admins may still rotate');
});

test('M3 — bulk assign and CSV import write ALL their outbox rows with ONE multi-row INSERT, after the audit row (the last statement before commit)', async () => {
  s5On();
  const f = await h.kitEvent({ n: 5 });
  const g = await h.kitEvent({ n: 4 });
  const statements = [];
  const record = q => { if (/insert into "OutboxEvent"|insert into "AuditLog"/i.test(q.sql)) statements.push(q.sql.match(/insert into "(\w+)"/i)[1]); };
  db.on('query', record);
  try {
    const rule = { start: 1, prefix: 'm3-', padTo: 3, categoryId: f.categories[0].id };
    const prev = await call(organizerBibsBulkPreview, f.organizer.admin, { params: { id: f.event.id }, body: rule });
    assert.equal((await call(organizerBibsBulk, f.organizer.admin, { params: { id: f.event.id }, headers: { 'Idempotency-Key': key() }, body: { ...rule, previewHash: prev.body.previewHash } })).body.assigned, 5);
    const outboxWrites = statements.filter(s => s === 'OutboxEvent');
    assert.equal(outboxWrites.length, 1, 'one INSERT for five registrations');
    assert.ok(statements.indexOf('OutboxEvent') > statements.indexOf('AuditLog') && statements.indexOf('AuditLog') >= 0, 'the outbox write comes after the audit row of the same transaction');
    assert.equal((await db('OutboxEvent').where({ eventId: f.event.id, type: 'bib.assigned' })).length, 5);
    assert.equal(new Set((await db('OutboxEvent').where({ eventId: f.event.id, type: 'bib.assigned' }).select('seq')).map(r => r.seq)).size, 5);
    statements.length = 0;
    const csv = `registrationId,bibNumber\n${g.regs.map((r, i) => `${r.id},I${i + 1}`).join('\n')}\n`;
    const p = await call(organizerBibsImportPreview, g.organizer.admin, { params: { id: g.event.id }, body: { csv } });
    assert.equal((await call(organizerBibsImport, g.organizer.admin, { params: { id: g.event.id }, headers: { 'Idempotency-Key': key() }, body: { csv, previewHash: p.body.previewHash } })).body.imported, 4);
    assert.equal(statements.filter(s => s === 'OutboxEvent').length, 1);
  } finally { db.removeListener('query', record); }
});

test('M4 — event.updated and event.cancelled COMMIT WITH the change: if the outbox insert fails, the event row is unchanged', async () => {
  s5On();
  const f = await h.kitEvent({ n: 0 });
  await db.raw(`CREATE OR REPLACE FUNCTION spec_s5_fail_event_rows() RETURNS trigger AS $$ BEGIN IF NEW.type IN ('event.updated', 'event.cancelled') THEN RAISE EXCEPTION 'spec: outbox insert failed'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
  await db.raw(`CREATE TRIGGER spec_s5_fail_event_rows BEFORE INSERT ON "OutboxEvent" FOR EACH ROW EXECUTE FUNCTION spec_s5_fail_event_rows()`);
  try {
    const admin = { sub: await h.user({ userType: 'admin' }), userType: 'admin' };
    const tried = await call(adminCancelEvent, admin, { params: { id: f.event.id }, body: { reason: 'weather', refundPaidOrders: false } }).catch(e => ({ thrown: e.message }));
    assert.match(JSON.stringify(tried), /outbox insert failed/);
    const row = await db('Event').where({ id: f.event.id }).first();
    assert.deepEqual([row.status, row.cancelledAt], ['published', null], 'the cancel rolled back with its outbox row');
    const { eventsOrganizerService } = await import('../src/bootstrap/services.mjs');
    await assert.rejects(eventsOrganizerService.patchEvent({ ctx: { organizer: { id: f.organizer.id, status: 'active' }, role: 'owner' }, eventId: f.event.id, actorId: f.organizer.ownerUserId,
      body: { version: row.version, description: { en: 'A fast, flat road race along the Dar es Salaam coast.', sw: 'Mbio za barabarani tambarare kando ya pwani ya Dar es Salaam.' }, accessibility: { en: 'Step-free access', sw: 'Njia bila ngazi' } } }), /outbox insert failed/);
    const after_ = await db('Event').where({ id: f.event.id }).first();
    assert.deepEqual([after_.version, after_.accessibility], [row.version, row.accessibility], 'the save rolled back too');
    assert.equal(after_.description, row.description);
  } finally {
    await db.raw('DROP TRIGGER IF EXISTS spec_s5_fail_event_rows ON "OutboxEvent"');
    await db.raw('DROP FUNCTION IF EXISTS spec_s5_fail_event_rows()');
  }
});

test('L1 L3 L4 L6 L10 — sandbox refused on webhook routes; unverified endpoints are never claimed; /verify capped at 10 an hour; batch refuses a cancelled event; the Azure wire server address is blocked; key health', async () => {
  s5On();
  const f = await h.kitEvent({ n: 1 });
  // L1
  const sb = await h.apiClient(f.organizer, { scopes: ['registrations:read'], environment: 'sandbox' });
  await db('ApiClient').where({ id: sb.client.id }).update({ scopes: JSON.stringify(['registrations:read', 'webhooks:manage']) });
  assert.deepEqual((await call(apiListWebhookEndpoints, null, { headers: await sb.bearer() })).body, { error: 'sandbox_not_supported' });
  // L3 + L4
  const lab = webhookLab();
  const ep = await lab.endpoint(f.organizer, { verify: false, events: ['kit.collected'] });
  await db('WebhookDelivery').insert({ id: uid('whd'), endpointId: ep.id, outboxEventId: (await lab.emit(f.event, f.organizer.id)).id, status: 'pending', attemptCount: 0, nextAttemptAt: new Date(Date.now() - 1000) });
  const before = lab.calls.length;
  assert.equal((await lab.svc.deliverDue()).claimed, 0, 'an unverified endpoint\'s delivery is not claimed');
  assert.equal(lab.calls.length, before);
  lab.verifyAnswer = 'down';
  for (let i = 0; i < 10; i += 1) assert.equal((await lab.svc.verifyEndpoint({ organizerId: f.organizer.id, id: ep.id, actorId: f.organizer.ownerUserId })).ok, false);
  const capped = await lab.svc.verifyEndpoint({ organizerId: f.organizer.id, id: ep.id, actorId: f.organizer.ownerUserId });
  assert.deepEqual([capped.status, capped.error], [429, 'rate_limited']);
  // L6
  const c = await h.apiClient(f.organizer, { scopes: ['registrations:read', 'bibs:write'] });
  await db('Event').where({ id: f.event.id }).update({ status: 'cancelled', cancelledAt: new Date() });
  const batch = await call(apiAssignBibBatch, null, { params: { eventId: f.event.id }, headers: { ...(await c.bearer()), 'idempotency-key': 'cancelled-batch-1' }, body: { items: [{ registrationId: f.regs[0].id, bibNumber: '9' }] } });
  assert.deepEqual([batch.status, batch.body.error], [409, 'event_cancelled']);
  // L10
  assert.equal(isBlockedAddress('168.63.129.16'), true);
  assert.equal(isBlockedAddress('168.63.129.17'), false);
  const health = await eventsWebhookService.listEndpoints({ organizerId: f.organizer.id });
  assert.deepEqual(health.keys, { ok: true, unreadable: 0 });
  process.env.EVENTS_WEBHOOK_SECRET_KEY_ID = 'k9';   // a key-id typo: stored secrets (sealed under k1) no longer open
  const broken = await eventsWebhookService.listEndpoints({ organizerId: f.organizer.id });
  assert.deepEqual([broken.keys.ok, broken.keys.unreadable], [false, 1]);
});

test('CONTRACT — assignmentId on bib list items and cards; collectionId on the verify answer and the 409 already_collected; bibNumber on the member registration view (flag on only)', async () => {
  s5On();
  const f = await h.kitEvent({ n: 2 });
  await call(organizerAssignBib, f.organizer.ops, { params: { id: f.event.id }, headers: { 'Idempotency-Key': key() }, body: { registrationId: f.regs[0].id, bibNumber: '77' } });
  const live = await db('EventBibAssignment').where({ registrationId: f.regs[0].id }).first();
  const list = await call(organizerListBibs, f.organizer.ops, { params: { id: f.event.id }, query: {} });
  assert.equal(list.body.items.find(i => i.registrationId === f.regs[0].id).assignmentId, live.id);
  assert.equal(list.body.items.find(i => i.registrationId === f.regs[1].id).assignmentId, null);
  const v0 = await call(organizerVerifyTicket, f.organizer.ops, { params: { id: f.event.id }, body: { payload: f.regs[0].payload } });
  assert.equal(v0.body.card.assignmentId, live.id);
  const col = await call(organizerCollectKit, f.organizer.ops, { params: { id: f.event.id }, headers: { 'Idempotency-Key': key() }, body: { method: 'scan', payload: f.regs[0].payload, collectionPointId: f.points[0].id } });
  const v1 = await call(organizerVerifyTicket, f.organizer.ops, { params: { id: f.event.id }, body: { payload: f.regs[0].payload } });
  assert.deepEqual([v1.body.result, v1.body.collectionId], ['already_collected', col.body.collection.id]);
  const dup = await call(organizerCollectKit, f.organizer.admin, { params: { id: f.event.id }, headers: { 'Idempotency-Key': key() }, body: { method: 'scan', payload: f.regs[0].payload, collectionPointId: f.points[0].id } });
  assert.deepEqual([dup.status, dup.body.collectionId], [409, col.body.collection.id]);
  const mine = h.claimsOf(f.regs[0].userId);
  assert.equal((await call(getMyEventRegistration, mine, { params: { id: f.regs[0].id } })).body.bibNumber, '77');
  s5Off(); s5On({ kit: false });
  assert.ok(!('bibNumber' in (await call(getMyEventRegistration, mine, { params: { id: f.regs[0].id } })).body), 'flag off: exactly the S4 shape');
});

test('SWAHILI — bulk / import inbox notices are in the recipient\'s language at the top level (both kept in data); the API-client and kit wording is the reviewed wording', async () => {
  s5On();
  const f = await h.kitEvent({ n: 2 });
  await db('CommunicationPreference').insert({ id: f.regs[0].userId, locale: 'sw' }).onConflict('id').merge({ locale: 'sw' });
  const rule = { start: 1, prefix: 'sw-', padTo: 2, categoryId: f.categories[0].id };
  const prev = await call(organizerBibsBulkPreview, f.organizer.admin, { params: { id: f.event.id }, body: rule });
  await call(organizerBibsBulk, f.organizer.admin, { params: { id: f.event.id }, headers: { 'Idempotency-Key': key() }, body: { ...rule, previewHash: prev.body.previewHash } });
  const sw = await db('Notification').where({ userId: f.regs[0].userId, type: 'event_bib_assigned' }).first();
  const en = await db('Notification').where({ userId: f.regs[1].userId, type: 'event_bib_assigned' }).first();
  assert.deepEqual([sw.title, en.title], ['Namba yako ya mbio iko tayari', 'Your bib number is ready']);
  assert.match(sw.body, /^Namba yako ya .+ ni SW-0\d\.$/);
  assert.equal(sw.data.titleEn, 'Your bib number is ready');
  assert.equal(en.data.titleSw, 'Namba yako ya mbio iko tayari');
  const col = await call(organizerCollectKit, f.organizer.ops, { params: { id: f.event.id }, headers: { 'Idempotency-Key': key() }, body: { method: 'scan', payload: f.regs[1].payload, collectionPointId: f.points[0].id } });
  assert.equal(col.status, 201);
  // The kit notice is sent after the response without being awaited (events-ops-service noticeKit(...).catch()),
  // so the row can land a moment after the 201: wait for it (up to ~5 s) instead of reading once.
  let kit;
  for (let i = 0; i < 50 && !kit; i += 1) {
    kit = await db('Notification').where({ userId: f.regs[1].userId, type: 'event_kit_collected' }).first();
    if (!kit) await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(kit, 'the kit-collected notification is written');
  assert.match(kit.data.bodySw, /^Umechukua vifaa vya mbio vya /);
  // the API client wording: a "ruhusa" (permission), never "mteja", never kushindwa / imeshindwa
  const { readFileSync } = await import('node:fs');
  const text = ['src/services/events-integrations-service.mjs', 'src/services/events-webhook-service.mjs', 'src/services/events-ops-service.mjs'].map(p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')).join('\n');
  assert.ok(!/Mteja wa API|kushindwa|imeshindwa|amefutwa/.test(text));
  assert.ok(/Ruhusa ya API imeundwa/.test(text) && /Ruhusa ya API imeondolewa/.test(text) && /inaisha karibuni/.test(text) && /kushindikana/.test(text));
});
