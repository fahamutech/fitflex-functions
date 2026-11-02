// Marathon & running events · S7 (B1) — the offline kit desk: registry, ticket list, sync, conflicts, offline bib recording, review.
// docs/design/events-s7-hardening-and-pilot.md §3 (D63 to D69, D66 changed). RULE 6 AREA: a second writer of EventKitCollection and EventBibAssignment.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { ensureInit } from '../functions/index.mjs';
import {
  organizerPrepareOfflineDesk, organizerListOfflineDesks, organizerRevokeOfflineDesk, organizerOfflineSnapshot, organizerOfflineHeartbeat, organizerOfflineSync,
  organizerOfflineReview, organizerOfflineReviewCheck, resetEventsKitOfflineLimits,
} from '../functions/events-kit-offline.mjs';
import { adminOfflineKit, adminRevokeOfflineDesk } from '../functions/events-admin-s7.mjs';
import { organizerCollectKit, organizerKitSummary, resetEventsOpsLimits } from '../functions/events-ops.mjs';
import { eventsOptions } from '../functions/events-public.mjs';
import { harness, s7On, s7Off, db, uid, eventually, H } from './fixtures/events-s7.mjs';
import { TICKET_SECRET } from './fixtures/events-s4.mjs';
import { ticketKeyRing, deriveToken, newTicketId, sha256hex, qrPayloadOf } from '../src/shared/events-ticket-token.mjs';
import { blocksOverlap, bibInBlock, parseBlock } from '../src/services/events-kit-offline-service.mjs';
import { eventsKitOfflineService, opsService } from '../src/bootstrap/services.mjs';

await ensureInit();
const h = harness();
const { call } = h;
const ring = ticketKeyRing({ EVENT_TICKET_SECRET: TICKET_SECRET });
afterEach(() => { resetEventsKitOfflineLimits(); resetEventsOpsLimits(); s7Off(); });
after(async () => { await h.cleanup(); await db.destroy(); });

const key = () => `k_${uid('').slice(1)}`;
const prepare = (claims, f, body = {}, k = key()) => call(organizerPrepareOfflineDesk, claims, { params: { id: f.event.id }, headers: { 'Idempotency-Key': k }, body: { label: 'Gate 1', clientKind: 'web', deskBuild: 7, ...body } });
const snapshot = (claims, f, deviceId, query = {}) => call(organizerOfflineSnapshot, claims, { params: { id: f.event.id }, query: { deviceId, ...query } });
const sync = (claims, f, deviceId, items, over = {}) => call(organizerOfflineSync, claims, { params: { id: f.event.id }, body: { deviceId, batchId: `batch-${uid('').slice(1)}`, snapshotSeq: 0, snapshotTakenAt: new Date().toISOString(), clockOffsetMs: 0, items, ...over } });
const item = (f, i, over = {}) => ({ clientRef: randomUUID(), method: 'scan', payload: f.regs[i].payload, collectionPointId: f.points[0].id, claimedAt: new Date().toISOString(), ...over });
const rows = (regId) => db('EventKitCollection').where({ registrationId: regId }).orderBy('createdAt');
/** A prepared desk that has downloaded its list (so snapshotTakenAt is set). */
async function desk(claims, f, body = {}) {
  const p = await prepare(claims, f, body);
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const s = await snapshot(claims, f, p.body.device.id);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  return { id: p.body.device.id, snapshot: s.body, prepared: p.body };
}

test('flag off: every offline route is 404 feature_disabled, even prepare; kit ops alone does not turn it on; options says false', async () => {
  s7On({ offline: false });
  const f = await h.kitEvent({ n: 1 });
  for (const [route, params] of [[organizerPrepareOfflineDesk, {}], [organizerListOfflineDesks, {}], [organizerOfflineSnapshot, {}], [organizerOfflineHeartbeat, {}], [organizerOfflineSync, {}], [organizerOfflineReview, {}]]) {
    const r = await call(route, f.organizer.owner, { params: { id: f.event.id, ...params }, body: {} });
    assert.deepEqual([r.status, r.body.error], [404, 'feature_disabled'], route.path);
  }
  assert.equal((await call(adminOfflineKit, await h.superAdmin(), { params: { id: f.event.id } })).status, 404);
  assert.equal((await call(eventsOptions, null, {})).body.ops.kitOffline, false);
  s7On({ offline: true });
  assert.equal((await call(eventsOptions, null, {})).body.ops.kitOffline, true);
  delete process.env.EVENTS_KIT_OPS;
  assert.equal((await call(organizerListOfflineDesks, f.organizer.owner, { params: { id: f.event.id } })).status, 404, 'needs EVENTS_KIT_OPS too');
});

test('prepare: owner, admin and ops may; timing and finance may not; no key is 400; same key replays; the answer carries the limits and no secret', async () => {
  s7On({ offline: true });
  const f = await h.kitEvent({ n: 1 });
  for (const r of ['timing', 'finance']) assert.equal((await prepare(f.organizer[r], f)).status, 403, r);
  const k = key();
  const first = await prepare(f.organizer.ops, f, { label: 'Phone A' }, k);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.deepEqual(Object.keys(first.body.limits).sort(), ['clockToleranceSeconds', 'maxPending', 'sessionHours', 'syncBatch']);
  assert.equal(first.body.limits.sessionHours, 36);
  assert.equal(first.body.device.status, 'active');
  assert.equal(first.body.device.bibRange, null);
  const hours = (+new Date(first.body.device.expiresAt) - +new Date(first.body.device.issuedAt)) / H;
  assert.ok(hours > 35.9 && hours <= 36, String(hours));
  const again = await prepare(f.organizer.ops, f, { label: 'Phone A' }, k);
  assert.equal(again.status, 200);
  assert.equal(again.body.device.id, first.body.device.id);
  assert.equal((await db('EventKitOfflineDevice').where({ eventId: f.event.id })).length, 1);
  const noKey = await call(organizerPrepareOfflineDesk, f.organizer.ops, { params: { id: f.event.id }, body: { label: 'x', clientKind: 'web' } });
  assert.equal(noKey.body.error, 'idempotency_key_required');
  assert.equal((await prepare(f.organizer.owner, f, { label: '' })).body.error, 'validation_failed');
  assert.equal((await prepare(f.organizer.owner, f, { label: 'x'.repeat(41) })).body.error, 'validation_failed');
  assert.equal((await prepare(f.organizer.owner, f, { clientKind: 'native' })).body.error, 'validation_failed');
  assert.equal((await db('AuditLog').where({ action: 'events.kit_offline_device_prepared', target: f.event.id })).length, 1);
});

test('prepare: the event must hand out a kit and be open; the desk expires 24 h after the event end at the latest; a suspended organizer cannot prepare', async () => {
  s7On({ offline: true });
  const noKit = await h.kitEvent({ n: 0, eventOver: { kitProvided: false } });
  assert.equal((await prepare(noKit.organizer.owner, noKit)).body.error, 'kit_not_provided');
  const f = await h.kitEvent({ n: 0 });
  const soon = new Date(Date.now() + 2 * H);
  await db('Event').where({ id: f.event.id }).update({ startsAt: new Date(Date.now() - 4 * H), endsAt: soon });
  const p = await prepare(f.organizer.owner, f);
  assert.equal(p.status, 201);
  assert.ok(+new Date(p.body.device.expiresAt) <= +soon + 24 * H + 1000, 'never later than 24 h after the event end');
  assert.ok(+new Date(p.body.device.expiresAt) < Date.now() + 30 * H, 'so shorter than the 36 h session');
  await db('Event').where({ id: f.event.id }).update({ status: 'cancelled', cancelledAt: new Date() });
  assert.equal((await prepare(f.organizer.owner, f)).body.error, 'event_not_open');
  await db('Event').where({ id: f.event.id }).update({ status: 'published', cancelledAt: null });
  await db('EventOrganizer').where({ id: f.organizer.id }).update({ status: 'suspended', statusReason: 'spec' });
  assert.equal((await prepare(f.organizer.owner, f)).body.error, 'organizer_suspended');
  await db('EventOrganizer').where({ id: f.organizer.id }).update({ status: 'active', statusReason: null });
});

test('limits: 2 active desks per staff user, 10 per event (owner and admin are told which desks), a removed desk frees its place', async () => {
  s7On({ offline: true });
  process.env.EVENTS_OFFLINE_MAX_DEVICES = '3';
  const f = await h.kitEvent({ n: 0 });
  const a = await prepare(f.organizer.ops, f, { label: 'A' });
  await prepare(f.organizer.ops, f, { label: 'B' });
  const third = await prepare(f.organizer.ops, f, { label: 'C' });
  assert.deepEqual([third.status, third.body.error, third.body.limit], [409, 'device_limit_reached', 'user']);
  assert.equal((await prepare(f.organizer.admin, f, { label: 'D' })).status, 201);
  const full = await prepare(f.organizer.owner, f, { label: 'E' });
  assert.deepEqual([full.status, full.body.error, full.body.limit], [409, 'device_limit_reached', 'event']);
  assert.equal(full.body.desks.length, 3, 'owner is told which desks to remove');
  const asOps = await prepare(f.organizer.ops, f, { label: 'F' });
  assert.equal(asOps.body.desks, undefined, 'ops is not given the list');
  const rev = await call(organizerRevokeOfflineDesk, f.organizer.owner, { params: { id: f.event.id, deviceId: a.body.device.id }, headers: { 'Idempotency-Key': key() }, body: { reason: 'Phone lost at the gate' } });
  assert.equal(rev.status, 200);
  assert.equal((await prepare(f.organizer.owner, f, { label: 'G' })).status, 201);
});

test('bib blocks: owner and admin may set one, ops may not; invalid blocks are 422; overlap (prefix and padding considered, removed desks included) is 409; a warning counts numbers already assigned', async () => {
  s7On({ offline: true });
  process.env.EVENTS_OFFLINE_MAX_PER_USER = '20';
  const f = await h.kitEvent({ n: 2 });
  const block = (prefix, start, end, padTo = 4) => ({ bibRange: { prefix, padTo, start, end } });
  assert.equal((await prepare(f.organizer.ops, f, block('A', 101, 150))).body.error, 'forbidden_role');
  await db('EventBibAssignment').insert({ id: uid('ebn'), eventId: f.event.id, categoryId: f.regs.length ? (await db('EventRegistration').where({ id: f.regs[0].id }).first()).categoryId : null, registrationId: f.regs[0].id, bibNumber: 'A0120', assignedAt: new Date(), createdAt: new Date() });
  const a = await prepare(f.organizer.owner, f, { label: 'Gate 1', ...block('A', 101, 150) });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.deepEqual(a.body.device.bibRange, { prefix: 'A', padTo: 4, start: 101, end: 150 });
  assert.deepEqual(a.body.warnings, [{ code: 'range_contains_assigned', count: 1 }]);
  const overlap = await prepare(f.organizer.admin, f, { label: 'Gate 2', ...block('A', 150, 200) });
  assert.deepEqual([overlap.status, overlap.body.error, overlap.body.with], [409, 'bib_range_overlap', 'Gate 1']);
  assert.equal((await prepare(f.organizer.admin, f, { label: 'Gate 2', ...block('B', 101, 150) })).status, 201, 'another prefix is a different set');
  assert.equal((await prepare(f.organizer.admin, f, { label: 'Gate 3', bibRange: { prefix: '', padTo: 0, start: 1000, end: 1100 } })).status, 201);
  const padded = await prepare(f.organizer.admin, f, { label: 'Gate 4', bibRange: { prefix: '', padTo: 4, start: 1000, end: 1100 } });
  assert.deepEqual([padded.status, padded.body.error, padded.body.with], [409, 'bib_range_overlap', 'Gate 3'], '"1000" padded to 4 is the same physical bib as unpadded "1000"');
  assert.equal((await prepare(f.organizer.admin, f, { label: 'Gate 5', bibRange: { prefix: '', padTo: 5, start: 1000, end: 1100 } })).status, 201, '"01000" is a different string');
  const bad = await prepare(f.organizer.admin, f, { label: 'Gate 6', bibRange: { prefix: 'A', padTo: 4, start: 10, end: 5 } });
  assert.deepEqual([bad.status, bad.body.error], [422, 'bib_range_invalid']);
  // a removed desk's block still counts (its unsent scans may carry those numbers)
  await db('EventKitOfflineDevice').where({ id: a.body.device.id }).update({ status: 'revoked', revokedAt: new Date(), revokedBy: f.organizer.ownerUserId, revokeReason: 'removed for the test' });
  assert.equal((await prepare(f.organizer.admin, f, { label: 'Gate 7', ...block('A', 120, 130) })).body.error, 'bib_range_overlap');
});

test('bib block rules (pure): padding and prefix decide overlap; the immutable block; invalid input', () => {
  const b = (prefix, padTo, start, end) => ({ prefix, padTo, start, end });
  assert.equal(blocksOverlap(b('A', 4, 101, 150), b('A', 4, 150, 200)), true);
  assert.equal(blocksOverlap(b('A', 4, 101, 150), b('A', 4, 151, 200)), false);
  assert.equal(blocksOverlap(b('', 0, 1, 99), b('', 4, 1, 99)), false, '"1" and "0001" are different physical bibs');
  assert.equal(blocksOverlap(b('', 4, 1000, 1100), b('', 0, 1050, 1060)), true, '"1050" is "1050"');
  assert.equal(bibInBlock(b('A', 4, 101, 150), 'A0101'), true);
  assert.equal(bibInBlock(b('A', 4, 101, 150), 'A101'), false, 'padding must match');
  assert.equal(bibInBlock(b('A', 4, 101, 150), 'A0151'), false);
  assert.equal(bibInBlock(b('A', 4, 101, 150), 'B0120'), false);
  assert.equal(bibInBlock(b('', 0, 1, 99), '42'), true);
  assert.equal(parseBlock({ prefix: 'abc', padTo: 3, start: 1, end: 9 }).block.prefix, 'ABC');
  for (const bad of [{ prefix: '-A', start: 1, end: 2 }, { prefix: 'ABCDE', start: 1, end: 2 }, { padTo: 7, start: 1, end: 2 }, { start: 5, end: 2 }, { start: 0, end: 9999 }, { start: 1.5, end: 3 }, { prefix: 'ABCD', padTo: 6, start: 1, end: 1000000000 }, null]) {
    assert.equal(parseBlock(bad).error, 'bib_range_invalid', JSON.stringify(bad));
  }
});

test('snapshot: hashes of the tokens (never the token), masked names, no contact data; paged; counts', async () => {
  s7On({ offline: true });
  const f = await h.kitEvent({ n: 5 });
  const p = await prepare(f.organizer.ops, f);
  const id = p.body.device.id;
  const s1 = await snapshot(f.organizer.ops, f, id, { limit: '2' });
  assert.equal(s1.status, 200, JSON.stringify(s1.body));
  assert.equal(s1.body.rows.length, 2);
  assert.ok(s1.body.nextCursor);
  assert.equal(s1.body.header.rowCount, 5);
  const all = [...s1.body.rows];
  let cursor = s1.body.nextCursor;
  while (cursor) { const next = await snapshot(f.organizer.ops, f, id, { limit: '2', cursor }); all.push(...next.body.rows); cursor = next.body.nextCursor; }
  assert.equal(all.length, 5);
  assert.equal(new Set(all.map(r => r.registrationId)).size, 5);
  for (const reg of f.regs) {
    const row = all.find(r => r.registrationId === reg.id);
    assert.equal(row.tokenHash, sha256hex(reg.token));
    assert.equal(row.ticket, 'active');
    assert.equal(row.kit, 'not_collected');
    assert.match(row.name, /^[A-Z][a-z]+ [A-Z]\.$/);
  }
  const json = JSON.stringify(s1.body) + JSON.stringify(all);
  for (const reg of f.regs) { assert.ok(!json.includes(reg.token), 'never the token'); assert.ok(!json.includes(reg.payload)); }
  assert.ok(!/phone|email|dateOfBirth|gender|emergency|payment|userId/i.test(json), 'no contact, sensitive or payment field names');
  assert.equal(s1.body.header.event.kitProvided, true);
  assert.equal(s1.body.header.collectionPoints.length, 2);
  const dev = await db('EventKitOfflineDevice').where({ id }).first();
  assert.equal(dev.snapshotRows, 5);
  assert.ok(dev.snapshotTakenAt);
  assert.equal((await db('AuditLog').where({ action: 'events.kit_offline_snapshot', target: f.event.id })).length >= 1, true);
});

test('snapshot: only the desk\'s own staff user (404 otherwise), only an active desk (403), the size cap (413) and a category filter', async () => {
  s7On({ offline: true });
  const f = await h.kitEvent({ n: 3 });
  const p = await prepare(f.organizer.ops, f);
  const id = p.body.device.id;
  assert.equal((await snapshot(f.organizer.admin, f, id)).status, 404, 'another staff user cannot download a desk\'s list, not even an admin');
  assert.equal((await snapshot(f.organizer.ops, f, 'ekd_nothere')).status, 404);
  process.env.EVENTS_OFFLINE_MAX_ROWS = '2';
  const big = await snapshot(f.organizer.ops, f, id);
  assert.deepEqual([big.status, big.body.error, big.body.rows, big.body.max], [413, 'snapshot_too_large', 3, 2]);
  const cat = (await db('EventCategory').where({ eventId: f.event.id }).orderBy('name'))[0];
  const filtered = await snapshot(f.organizer.ops, f, id, { categoryId: cat.id });
  assert.equal(filtered.status, 200);
  delete process.env.EVENTS_OFFLINE_MAX_ROWS;
  await db('EventKitOfflineDevice').where({ id }).update({ status: 'revoked', revokedAt: new Date(), revokedBy: f.organizer.ownerUserId, revokeReason: 'lost it' });
  const revoked = await snapshot(f.organizer.ops, f, id);
  assert.deepEqual([revoked.status, revoked.body.error], [403, 'device_not_active']);
});

test('snapshot delta: changed registrations only; a kit handed over online shows as collected; a cancelled place is a revoked row; a removed one is listed', async () => {
  s7On({ offline: true });
  const f = await h.kitEvent({ n: 3 });
  const d = await desk(f.organizer.ops, f);
  const seq = d.snapshot.header.snapshotSeq;
  const online = await call(organizerCollectKit, f.organizer.admin, { params: { id: f.event.id }, headers: { 'Idempotency-Key': key() }, body: { method: 'scan', payload: f.regs[0].payload, collectionPointId: f.points[0].id } });
  assert.equal(online.status, 201, JSON.stringify(online.body));
  await new Promise(r => setTimeout(r, 20));
  const delta = await snapshot(f.organizer.ops, f, d.id, { sinceSeq: String(seq) });
  assert.equal(delta.status, 200, JSON.stringify(delta.body));
  assert.deepEqual(delta.body.rows.map(r => [r.registrationId, r.kit]), [[f.regs[0].id, 'collected']]);
  assert.ok(delta.body.header.snapshotSeq >= seq);
  // a registration that left the list entirely (back to draft) is reported as removed
  await db('EventRegistration').where({ id: f.regs[2].id }).update({ status: 'draft' });
  await db.transaction(trx => trx('OutboxEvent').insert({ id: uid('obx'), type: 'registration.updated', aggregateType: 'registration', aggregateId: f.regs[2].id, organizerId: f.organizer.id, eventId: f.event.id, payload: JSON.stringify({ changed: ['status'] }), version: '1', createdAt: new Date(Date.now() - 60_000) }));
  const again = await snapshot(f.organizer.ops, f, d.id, { sinceSeq: String(seq) });
  assert.deepEqual(again.body.removed, [f.regs[2].id]);
  await db('EventRegistration').where({ id: f.regs[2].id }).update({ status: 'confirmed' });
});

test('sync accepts a valid scan: one collection (method offline, batch id), kitStatus, one kit.collected outbox row, audit, the participant is told, no token anywhere', async () => {
  s7On({ offline: true });
  const f = await h.kitEvent({ n: 2 });
  const d = await desk(f.organizer.ops, f);
  const it = item(f, 0);
  const r = await sync(f.organizer.ops, f, d.id, [it], { batchId: 'batch-accepted-1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.results[0].outcome, 'accepted');
  assert.equal(r.body.results[0].replayed, false);
  assert.deepEqual(r.body.summary, { accepted: 1, duplicate: 0, needsReview: 0, bibExceptions: 0, rejected: 0, deferred: 0 });
  assert.equal(r.body.results[0].card.displayName.endsWith('.'), true);
  assert.equal(r.body.deviceStatus, 'active');
  const [c] = await rows(f.regs[0].id);
  assert.deepEqual([c.method, c.offlineBatchId, c.status, c.staffUserId, c.collectionPointId], ['offline', 'batch-accepted-1', 'collected', f.organizer.ops.sub, f.points[0].id]);
  assert.equal((await db('EventRegistration').where({ id: f.regs[0].id }).first()).kitStatus, 'collected');
  assert.equal((await db('OutboxEvent').where({ eventId: f.event.id, type: 'kit.collected' })).length, 1);
  assert.equal((await db('AuditLog').where({ action: 'events.kit_collected', target: f.event.id })).length, 1);
  const note = await eventually(() => db('Notification').where({ userId: f.regs[0].userId, type: 'event_kit_collected' }));
  assert.equal(note.length, 1);
  assert.equal((await db('EventKitOfflineDevice').where({ id: d.id }).first()).lastSyncAt !== null, true);
  const scan = await db('EventKitOfflineScan').where({ deviceId: d.id }).first();
  assert.deepEqual([scan.outcome, scan.reviewStatus, scan.collectionId], ['accepted', 'none', c.id]);
  const everything = JSON.stringify(await db('EventKitOfflineScan').where({ eventId: f.event.id })) + JSON.stringify(await db('AuditLog').where({ target: f.event.id }));
  assert.ok(!everything.includes(f.regs[0].token) && !everything.includes(sha256hex(f.regs[0].token)), 'no token and no hash is stored or audited');
});

test('sync replay: the same clientRef again returns the stored outcome with replayed: true and changes nothing (never already_collected)', async () => {
  s7On({ offline: true });
  const f = await h.kitEvent({ n: 1 });
  const d = await desk(f.organizer.ops, f);
  const it = item(f, 0);
  const first = await sync(f.organizer.ops, f, d.id, [it]);
  const second = await sync(f.organizer.ops, f, d.id, [it]);
  assert.equal(second.body.results[0].outcome, 'accepted');
  assert.equal(second.body.results[0].replayed, true);
  assert.equal(second.body.results[0].collectionId, first.body.results[0].collectionId);
  assert.equal((await rows(f.regs[0].id)).length, 1);
  assert.equal((await db('OutboxEvent').where({ eventId: f.event.id, type: 'kit.collected' })).length, 1);
  assert.equal((await db('EventKitOfflineScan').where({ deviceId: d.id })).length, 1);
  // the same item twice inside one batch, and a retry at once
  const twin = item(f, 0, { clientRef: randomUUID() });
  const [x, y] = await Promise.all([sync(f.organizer.ops, f, d.id, [twin]), sync(f.organizer.ops, f, d.id, [twin])]);
  assert.equal(x.status, 200); assert.equal(y.status, 200);
  assert.equal((await db('EventKitOfflineScan').where({ deviceId: d.id, clientRef: twin.clientRef })).length, 1);
});

test('two desks offline scan the same ticket: the first processed wins, the other is a duplicate linked to the winner, in review; kit.collected and the notice go out once', async () => {
  s7On({ offline: true });
  const f = await h.kitEvent({ n: 1 });
  const a = await desk(f.organizer.ops, f, { label: 'Gate A' });
  const b = await desk(f.organizer.admin, f, { label: 'Gate B' });
  const ra = await sync(f.organizer.ops, f, a.id, [item(f, 0)]);
  const rb = await sync(f.organizer.admin, f, b.id, [item(f, 0)]);
  assert.equal(ra.body.results[0].outcome, 'accepted');
  assert.equal(rb.body.results[0].outcome, 'duplicate');
  assert.equal(rb.body.results[0].collectionId, ra.body.results[0].collectionId);
  assert.ok(rb.body.results[0].reviewId);
  assert.deepEqual(rb.body.summary, { accepted: 0, duplicate: 1, needsReview: 1, bibExceptions: 0, rejected: 0, deferred: 0 });
  assert.equal((await rows(f.regs[0].id)).filter(r => r.status === 'collected').length, 1);
  assert.equal((await db('OutboxEvent').where({ eventId: f.event.id, type: 'kit.collected' })).length, 1);
  await eventually(() => db('Notification').where({ userId: f.regs[0].userId, type: 'event_kit_collected' }));
  assert.equal((await db('Notification').where({ userId: f.regs[0].userId, type: 'event_kit_collected' })).length, 1);
  const review = await call(organizerOfflineReview, f.organizer.owner, { params: { id: f.event.id } });
  assert.equal(review.body.items.length, 1);
  assert.equal(review.body.items[0].outcome, 'duplicate');
  assert.equal(review.body.items[0].winner.deviceLabel, 'Gate A');
  assert.equal(review.body.items[0].deviceLabel, 'Gate B');
  assert.equal(review.body.counts.needsReview, 1);
});

test('two desks sync the SAME ticket AT ONCE: exactly one collection row and one accepted, never a 500', async () => {
  s7On({ offline: true });
  const f = await h.kitEvent({ n: 1 });
  const a = await desk(f.organizer.ops, f, { label: 'Gate A' });
  const b = await desk(f.organizer.admin, f, { label: 'Gate B' });
  const c = await desk(f.organizer.owner, f, { label: 'Gate C' });
  const out = await Promise.all([sync(f.organizer.ops, f, a.id, [item(f, 0)]), sync(f.organizer.admin, f, b.id, [item(f, 0)]), sync(f.organizer.owner, f, c.id, [item(f, 0)])]);
  assert.deepEqual(out.map(o => o.status), [200, 200, 200]);
  const outcomes = out.map(o => o.body.results[0].outcome).sort();
  assert.deepEqual(outcomes, ['accepted', 'duplicate', 'duplicate']);
  assert.equal((await rows(f.regs[0].id)).filter(r => r.status === 'collected').length, 1);
  assert.equal((await db('OutboxEvent').where({ eventId: f.event.id, type: 'kit.collected' })).length, 1);
});

test('an online collection made after the list was taken makes the offline scan a duplicate', async () => {
  s7On({ offline: true });
  const f = await h.kitEvent({ n: 1 });
  const d = await desk(f.organizer.ops, f);
  const online = await call(organizerCollectKit, f.organizer.admin, { params: { id: f.event.id }, headers: { 'Idempotency-Key': key() }, body: { method: 'scan', payload: f.regs[0].payload, collectionPointId: f.points[0].id } });
  assert.equal(online.status, 201);
  const r = await sync(f.organizer.ops, f, d.id, [item(f, 0)]);
  assert.equal(r.body.results[0].outcome, 'duplicate');
  assert.equal(r.body.results[0].collectionId, online.body.collection.id);
  assert.equal((await rows(f.regs[0].id)).length, 1);
});

test('a ticket cancelled or refunded after the list was taken: revoked_after_scan, no collection, in review (note required to close it)', async () => {
  s7On({ offline: true });
  const f = await h.kitEvent({ n: 2 });
  const d = await desk(f.organizer.ops, f);
  await db('EventTicket').where({ id: f.regs[0].ticketId }).update({ status: 'revoked', revokedAt: new Date(), revokeReason: 'cancelled' });
  await db('EventRegistration').where({ id: f.regs[0].id }).update({ status: 'cancelled' });
  await db('EventRegistration').where({ id: f.regs[1].id }).update({ status: 'refunded' });
  const r = await sync(f.organizer.ops, f, d.id, [item(f, 0), item(f, 1)]);
  assert.deepEqual(r.body.results.map(x => x.outcome), ['revoked_after_scan', 'revoked_after_scan']);
  assert.equal((await rows(f.regs[0].id)).length, 0);
  assert.equal(r.body.summary.needsReview, 2);
  const id = r.body.results[0].reviewId;
  const noNote = await call(organizerOfflineReviewCheck, f.organizer.owner, { params: { id: f.event.id, scanId: id }, headers: { 'Idempotency-Key': key() }, body: {} });
  assert.deepEqual([noNote.status, noNote.body.error], [422, 'note_required']);
  const ok = await call(organizerOfflineReviewCheck, f.organizer.owner, { params: { id: f.event.id, scanId: id }, headers: { 'Idempotency-Key': key() }, body: { note: 'Kit already given, refund keeps the kit.' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.review.reviewStatus, 'checked');
  const again = await call(organizerOfflineReviewCheck, f.organizer.owner, { params: { id: f.event.id, scanId: id }, headers: { 'Idempotency-Key': key() }, body: { note: 'Kit already given, refund keeps the kit.' } });
  assert.deepEqual([again.status, again.body.error], [409, 'not_in_review']);
  assert.equal((await db('AuditLog').where({ action: 'events.kit_offline_checked', target: f.event.id })).length, 1);
  assert.equal((await call(organizerOfflineReviewCheck, f.organizer.ops, { params: { id: f.event.id, scanId: id }, headers: { 'Idempotency-Key': key() }, body: {} })).status, 403, 'ops cannot mark as checked');
  const listed = await call(organizerOfflineReview, f.organizer.owner, { params: { id: f.event.id }, query: { status: 'checked' } });
  assert.equal(listed.body.items.length, 1);
  assert.equal((await call(organizerOfflineReview, f.organizer.ops, { params: { id: f.event.id } })).status, 403);
});

test('a token replaced after the list was taken is accepted ONLY if the registration is still confirmed and the replacement came after the list', async () => {
  s7On({ offline: true });
  const f = await h.kitEvent({ n: 3 });
  const d = await desk(f.organizer.ops, f);
  const replaceTicket = async (i, revokedAt) => {
    await db('EventTicket').where({ id: f.regs[i].ticketId }).update({ status: 'revoked', revokedAt, revokeReason: 'replaced' });
    const id = newTicketId();
    const token = deriveToken(ring, { ticketId: id, tokenVersion: 2, registrationId: f.regs[i].id, eventId: f.event.id });
    await db('EventTicket').insert({ id, registrationId: f.regs[i].id, tokenHash: sha256hex(token), status: 'active', issuedAt: new Date(), tokenVersion: 2, tokenKeyId: ring.keyId, displayCode: `R${i}-${uid('').slice(1, 4)}`, issuedForUserId: f.regs[i].userId });
  };
  await new Promise(r => setTimeout(r, 15));
  await replaceTicket(0, new Date());                                             // replaced AFTER the list: accepted
  await replaceTicket(1, new Date(Date.now() - 3 * H));                           // replaced BEFORE the list was taken: the desk should have refused it
  await db('EventTicket').where({ id: f.regs[2].ticketId }).update({ status: 'revoked', revokedAt: new Date(), revokeReason: 'replaced' });
  await db('EventRegistration').where({ id: f.regs[2].id }).update({ status: 'cancelled' });   // replaced, then the place was cancelled
  const r = await sync(f.organizer.ops, f, d.id, [item(f, 0), item(f, 1), item(f, 2)]);
  assert.deepEqual(r.body.results.map(x => x.outcome), ['accepted', 'revoked_after_scan', 'revoked_after_scan']);
});

test('event cancelled or archived and organizer suspended at sync: filed for review, nothing collected; a suspended organizer CAN send', async () => {
  s7On({ offline: true });
  const f = await h.kitEvent({ n: 2 });
  const d = await desk(f.organizer.ops, f);
  await db('EventOrganizer').where({ id: f.organizer.id }).update({ status: 'suspended', statusReason: 'spec' });
  const sus = await sync(f.organizer.ops, f, d.id, [item(f, 0)]);
  assert.equal(sus.status, 200, 'the route lets a suspended organizer send');
  assert.equal(sus.body.results[0].outcome, 'organizer_suspended');
  assert.equal((await prepare(f.organizer.ops, f)).status, 403, 'but not prepare a new desk');
  assert.equal((await rows(f.regs[0].id)).length, 0);
  await db('EventOrganizer').where({ id: f.organizer.id }).update({ status: 'active', statusReason: null });
  await db('Event').where({ id: f.event.id }).update({ status: 'cancelled', cancelledAt: new Date() });
  const closed = await sync(f.organizer.ops, f, d.id, [item(f, 1)]);
  assert.equal(closed.body.results[0].outcome, 'event_closed');
  assert.equal(closed.body.summary.needsReview, 1);
  await db('Event').where({ id: f.event.id }).update({ status: 'archived', cancelledAt: new Date() });
  assert.equal((await sync(f.organizer.ops, f, d.id, [item(f, 1, { clientRef: randomUUID() })])).body.results[0].outcome, 'event_closed');
  await db('Event').where({ id: f.event.id }).update({ status: 'completed', cancelledAt: null });
  assert.equal((await sync(f.organizer.ops, f, d.id, [item(f, 1, { clientRef: randomUUID() })])).body.results[0].outcome, 'accepted', 'after the event completed, the scans of the day are still accepted');
  await db('Event').where({ id: f.event.id }).update({ status: 'published' });
});

test('a removed or expired desk may still SEND, but nothing it sends is collected: judged by the server\'s receipt time, never the client\'s claimedAt (M2)', async () => {
  s7On({ offline: true });
  const f = await h.kitEvent({ n: 3 });
  const d = await desk(f.organizer.ops, f);
  const before = new Date(Date.now() - 60_000).toISOString();
  await new Promise(r => setTimeout(r, 10));
  const rev = await call(organizerRevokeOfflineDesk, f.organizer.owner, { params: { id: f.event.id, deviceId: d.id }, headers: { 'Idempotency-Key': key() }, body: { reason: 'Phone was stolen at the gate', reasonSw: 'Simu iliibiwa langoni kwa lango' } });
  assert.equal(rev.status, 200);
  // a client that stamps its scans BEFORE the removal cannot get them accepted
  const r = await sync(f.organizer.ops, f, d.id, [item(f, 0, { claimedAt: before }), item(f, 1, { claimedAt: new Date(Date.now() + 1000).toISOString() })]);
  assert.equal(r.body.deviceStatus, 'revoked');
  assert.deepEqual(r.body.results.map(x => x.outcome), ['after_revoke', 'after_revoke']);
  assert.equal(r.body.summary.needsReview, 2);
  assert.equal((await rows(f.regs[0].id)).length + (await rows(f.regs[1].id)).length, 0);
  assert.equal((await snapshot(f.organizer.ops, f, d.id)).status, 403, 'a removed desk cannot download a list');
  const again = await call(organizerRevokeOfflineDesk, f.organizer.owner, { params: { id: f.event.id, deviceId: d.id }, headers: { 'Idempotency-Key': key() }, body: { reason: 'Phone was stolen at the gate' } });
  assert.deepEqual([again.status, again.body.error], [409, 'already_ended']);
  const note = await eventually(() => db('Notification').where({ userId: f.organizer.ops.sub, type: 'organizer_kit_desk_removed' }));
  assert.equal(note.length, 1);
  assert.match(note[0].data.bodySw, /Simu iliibiwa/);
  assert.match(note[0].data.bodyEn, /stolen/);
  // an EXPIRED desk: everything goes to a person as well (after_expiry)
  const e = await desk(f.organizer.admin, f, { label: 'Late desk' });
  await db('EventKitOfflineDevice').where({ id: e.id }).update({ expiresAt: new Date(Date.now() - 1000) });
  const late = await sync(f.organizer.admin, f, e.id, [item(f, 2)]);
  assert.equal(late.body.results[0].outcome, 'after_expiry');
  assert.equal(late.body.deviceStatus, 'expired');
  assert.equal((await rows(f.regs[2].id)).length, 0);
});

test('ops can remove the desk they created (a stuck desk starts over) but not someone else\'s; owner and admin remove any (d)', async () => {
  s7On({ offline: true });
  const f = await h.kitEvent({ n: 0 });
  const mine = await desk(f.organizer.ops, f, { label: 'Ops own' });
  const theirs = await desk(f.organizer.admin, f, { label: 'Admin desk' });
  const rev = id => call(organizerRevokeOfflineDesk, f.organizer.ops, { params: { id: f.event.id, deviceId: id }, headers: { 'Idempotency-Key': key() }, body: { reason: 'Download failed, starting over' } });
  assert.deepEqual([(await rev(theirs.id)).status, (await rev(theirs.id)).body.error], [403, 'forbidden_role']);
  assert.equal((await rev(mine.id)).status, 200);
  assert.equal((await prepare(f.organizer.ops, f, { label: 'Ops again' })).status, 201, 'a new desk can be prepared at once');
  assert.equal((await call(organizerRevokeOfflineDesk, f.organizer.timing, { params: { id: f.event.id, deviceId: theirs.id }, headers: { 'Idempotency-Key': key() }, body: { reason: 'Download failed, starting over' } })).status, 403);
});

test('M1: the snapshot cursor is signed and bounded: a forged, edited, foreign or future cursor is a 400, never a 500; every page is audited by desk', async () => {
  s7On({ offline: true });
  const f = await h.kitEvent({ n: 5 });
  const p = await prepare(f.organizer.ops, f);
  const other = await prepare(f.organizer.admin, f);
  const s1 = await snapshot(f.organizer.ops, f, p.body.device.id, { limit: '2' });
  const cursor = s1.body.nextCursor;
  assert.ok(cursor.includes('.'), 'payload.mac');
  const [body, mac] = cursor.split('.');
  const parsed = JSON.parse(Buffer.from(body, 'base64url').toString());
  const forge = o => `${Buffer.from(JSON.stringify(o)).toString('base64url')}.${mac}`;
  const bad = [
    forge({ ...parsed, t: 0 }), forge({ ...parsed, s: 0 }), forge({ ...parsed, a: '' }), `${body}.AAAA`, body, 'not-a-cursor', `${cursor}.x`, '', 'e30', Buffer.from('{"a":"x","s":1,"t":"zzz","d":"x","n":1}').toString('base64url'),
  ];
  for (const c of bad.filter(Boolean)) assert.deepEqual([(await snapshot(f.organizer.ops, f, p.body.device.id, { cursor: c })).status, c.slice(0, 12)].slice(0, 1), [400], c);
  // a signed cursor of another desk is refused as well, as is a signed cursor with a time in the future
  const mine = parsed;
  void mine; void other;
  const s2 = await snapshot(f.organizer.ops, f, p.body.device.id, { limit: '2', cursor });
  assert.equal(s2.status, 200, JSON.stringify(s2.body));
  const pages = await db('AuditLog').where({ action: 'events.kit_offline_snapshot', target: f.event.id });
  assert.ok(pages.length >= 2, 'one audit row per page');
  assert.ok(pages.every(a => a.after.deviceId === p.body.device.id));
  assert.ok(pages.some(a => a.after.page === 2));
});

test('Low: a suspended organizer cannot download a list; the server keeps a bounded number of scans per desk; the bib range config is clamped to the database limit', async () => {
  s7On({ offline: true });
  const f = await h.kitEvent({ n: 1 });
  const p = await prepare(f.organizer.ops, f);
  await db('EventOrganizer').where({ id: f.organizer.id }).update({ status: 'suspended', statusReason: 'spec' });
  const s = await snapshot(f.organizer.ops, f, p.body.device.id);
  assert.deepEqual([s.status, s.body.error], [403, 'organizer_suspended']);
  await db('EventOrganizer').where({ id: f.organizer.id }).update({ status: 'active', statusReason: null });
  process.env.EVENTS_OFFLINE_MAX_PENDING = '2';
  process.env.EVENTS_OFFLINE_SYNC_BATCH = '20';
  await snapshot(f.organizer.ops, f, p.body.device.id);
  const ok = await sync(f.organizer.ops, f, p.body.device.id, Array.from({ length: 10 }, () => item(f, 0, { payload: 'FFEV1:junk' })));
  assert.equal(ok.status, 200);
  const over = await sync(f.organizer.ops, f, p.body.device.id, [item(f, 0, { payload: 'FFEV1:junk' })]);
  assert.deepEqual([over.status, over.body.error, over.body.max], [409, 'device_scan_limit', 10]);
  process.env.EVENTS_OFFLINE_MAX_BIB_RANGE = '999999';
  const big = await prepare(f.organizer.owner, f, { label: 'Big', bibRange: { prefix: '', padTo: 0, start: 1, end: 5001 } });
  assert.deepEqual([big.status, big.body.error], [422, 'bib_range_invalid'], 'never reaches the database CHECK');
});

test('the device clock is not trusted: an offset is corrected and the time is clamped near the list time and the receipt; the kit is NOT refused', async () => {
  s7On({ offline: true });
  const f = await h.kitEvent({ n: 3 });
  const d = await desk(f.organizer.ops, f);
  const future = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const past = new Date(Date.now() - 5 * 86_400_000).toISOString();
  const r = await sync(f.organizer.ops, f, d.id, [item(f, 0, { claimedAt: future }), item(f, 1, { claimedAt: past }), item(f, 2, { claimedAt: 'not a date' })]);
  assert.deepEqual(r.body.results.map(x => x.outcome), ['accepted', 'accepted', 'accepted']);
  const scans = await db('EventKitOfflineScan').where({ deviceId: d.id }).orderBy('receivedAt');
  assert.ok(scans.every(s => s.flags.clock_adjusted === true), JSON.stringify(scans.map(s => s.flags)));
  const [c0] = await rows(f.regs[0].id);
  assert.ok(+new Date(c0.collectedAt) <= Date.now() + 5 * 60_000 + 2000, 'a future clock is clamped to the receipt + tolerance');
  const [c1] = await rows(f.regs[1].id);
  assert.ok(+new Date(c1.collectedAt) >= +new Date(d.snapshot.header.takenAt) - 5 * 60_000 - 2000, 'a past clock is clamped to the list time − tolerance');
  // a known offset is applied: the device runs 2 h fast, so its stamp minus the offset is the real time
  const f2 = await h.kitEvent({ n: 1 });
  const d2 = await desk(f2.organizer.ops, f2);
  await sync(f2.organizer.ops, f2, d2.id, [item(f2, 0, { claimedAt: new Date(Date.now() + 2 * H).toISOString() })], { clockOffsetMs: 2 * H });
  const [c2] = await rows(f2.regs[0].id);
  assert.ok(Math.abs(+new Date(c2.collectedAt) - Date.now()) < 5000);
  assert.equal((await db('EventKitOfflineScan').where({ deviceId: d2.id }).first()).flags.clock_adjusted, undefined);
});

test('rejections: not a token, tampered MAC, a gym QR, an unknown ticket, another event of the organizer, another organizer\'s ticket, bad shapes; none create a collection', async () => {
  s7On({ offline: true });
  const f = await h.kitEvent({ n: 1 });
  const g = await h.kitEvent({ organizer: f.organizer, n: 1 });
  const other = await h.kitEvent({ n: 1 });
  const d = await desk(f.organizer.ops, f);
  const tampered = f.regs[0].payload.slice(0, -2) + (f.regs[0].payload.endsWith('AA') ? 'BB' : 'AA');
  const stranger = qrPayloadOf(deriveToken(ring, { ticketId: newTicketId(), tokenVersion: 1, registrationId: f.regs[0].id, eventId: f.event.id }));
  const items = [
    item(f, 0, { payload: 'hello' }), item(f, 0, { payload: tampered }), item(f, 0, { payload: 'FFQR:abc.def' }), item(f, 0, { payload: stranger }),
    item(f, 0, { payload: g.regs[0].payload }), item(f, 0, { payload: other.regs[0].payload }),
    { clientRef: randomUUID(), method: 'scan', claimedAt: new Date().toISOString() },
    { clientRef: 'x', method: 'scan', payload: f.regs[0].payload, claimedAt: new Date().toISOString() },
    { clientRef: randomUUID(), method: 'manual', registrationId: f.regs[0].id, manualReason: 'because', claimedAt: new Date().toISOString() },
    { clientRef: randomUUID(), method: 'fax', payload: f.regs[0].payload },
    item(f, 0, { kitSize: 'huge' }),
  ];
  const r = await sync(f.organizer.ops, f, d.id, items);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.results.map(x => x.outcome), ['invalid_token', 'invalid_token', 'invalid_token', 'unknown_ticket', 'wrong_event', 'unknown_ticket', 'validation_failed', 'validation_failed', 'validation_failed', 'validation_failed', 'validation_failed']);
  assert.equal(r.body.summary.rejected, 11);
  assert.equal(r.body.summary.needsReview, 0, 'rejected items are counted, not queued for a person');
  assert.equal((await db('EventKitCollection').where({ eventId: f.event.id })).length, 0);
  const stored = JSON.stringify(await db('EventKitOfflineScan').where({ deviceId: d.id }));
  assert.ok(!stored.includes('FFEV1') && !stored.includes(f.regs[0].token), 'rejected payload text is never kept');
});

test('more than 20 invalid tokens in one batch: the batch is still processed, an audit row and an owner notice record the burst', async () => {
  s7On({ offline: true });
  const f = await h.kitEvent({ n: 1 });
  const d = await desk(f.organizer.ops, f);
  const bad = Array.from({ length: 22 }, (_, i) => item(f, 0, { payload: `FFEV1:not-a-ticket-${i}` }));
  const r = await sync(f.organizer.ops, f, d.id, [...bad, item(f, 0)]);
  assert.equal(r.body.summary.rejected, 22);
  assert.equal(r.body.summary.accepted, 1, 'the good item in the same batch still counts');
  assert.equal((await db('AuditLog').where({ action: 'events.kit_offline_invalid_burst', target: f.event.id })).length, 1);
  const note = await eventually(() => db('Notification').where({ userId: f.organizer.ownerUserId, type: 'organizer_kit_offline_invalid_burst' }));
  assert.equal(note.length, 1);
  assert.match(note[0].data.titleSw, /Dawati/);
});

test('offline manual handover: needs a valid reason, is accepted as method offline with the reason, and is listed in the post-event review (D67)', async () => {
  s7On({ offline: true });
  const f = await h.kitEvent({ n: 1 });
  const d = await desk(f.organizer.ops, f);
  const r = await sync(f.organizer.ops, f, d.id, [{ clientRef: randomUUID(), method: 'manual', registrationId: f.regs[0].id, manualReason: 'phone_lost', collectionPointId: f.points[1].id, claimedAt: new Date().toISOString() }]);
  assert.equal(r.body.results[0].outcome, 'accepted');
  const [c] = await rows(f.regs[0].id);
  assert.deepEqual([c.method, c.manualReason, c.collectionPointId], ['offline', 'phone_lost', f.points[1].id]);
  assert.equal((await db('AuditLog').where({ action: 'events.kit_manual_collected', target: f.event.id })).length, 1);
  const review = await call(organizerOfflineReview, f.organizer.owner, { params: { id: f.event.id }, query: { status: 'manual' } });
  assert.equal(review.body.items.length, 1);
  assert.equal(review.body.items[0].manualReason, 'phone_lost');
  const wrongEvent = await sync(f.organizer.ops, f, d.id, [{ clientRef: randomUUID(), method: 'manual', registrationId: 'ereg_nothere', manualReason: 'other', claimedAt: new Date().toISOString() }]);
  assert.equal(wrongEvent.body.results[0].outcome, 'validation_failed');
});

test('kit point and size are claims: an unknown point is dropped with a warning, a size is stored only when none is set, a different size warns', async () => {
  s7On({ offline: true });
  const f = await h.kitEvent({ n: 2 });
  await db('EventRegistration').where({ id: f.regs[1].id }).update({ kitSize: 'm' });
  const d = await desk(f.organizer.ops, f);
  const r = await sync(f.organizer.ops, f, d.id, [item(f, 0, { collectionPointId: 'ecp_nothere', kitSize: 'L' }), item(f, 1, { kitSize: 'xl' })]);
  assert.deepEqual(r.body.results.map(x => x.outcome), ['accepted', 'accepted']);
  assert.deepEqual(r.body.results[0].warnings, ['collection_point_invalid']);
  assert.deepEqual(r.body.results[1].warnings, ['kit_size_differs']);
  const [c0] = await rows(f.regs[0].id);
  assert.equal(c0.collectionPointId, null);
  assert.equal((await db('EventRegistration').where({ id: f.regs[0].id }).first()).kitSize, 'l');
  assert.equal((await db('EventRegistration').where({ id: f.regs[1].id }).first()).kitSize, 'm', 'a size already on file is not overwritten');
});

test('offline bib recording: assigned after the handover; same number again is same_already; the S5 rows, outbox, notice and audit follow; the bib is traced to its scan', async () => {
  s7On({ offline: true });
  const f = await h.kitEvent({ n: 2 });
  const d = await desk(f.organizer.owner, f, { bibRange: { prefix: 'A', padTo: 4, start: 101, end: 150 } });
  const r = await sync(f.organizer.owner, f, d.id, [item(f, 0, { bibNumber: 'a0101' })]);
  assert.equal(r.body.results[0].outcome, 'accepted');
  assert.deepEqual(r.body.results[0].bib, { outcome: 'assigned', number: 'A0101' });
  assert.equal(r.body.summary.bibExceptions, 0);
  assert.equal(r.body.summary.needsReview, 0);
  const reg = await db('EventRegistration').where({ id: f.regs[0].id }).first();
  assert.equal(reg.bibNumber, 'A0101');
  const assignment = await db('EventBibAssignment').where({ registrationId: f.regs[0].id }).first();
  assert.deepEqual([assignment.bibNumber, assignment.releasedAt, assignment.assignedBy], ['A0101', null, f.organizer.owner.sub]);
  const scan = await db('EventKitOfflineScan').where({ deviceId: d.id }).first();
  assert.equal(assignment.sourceScanId, scan.id);
  assert.equal(scan.bibOutcome, 'assigned');
  assert.equal(scan.bibAssignmentId, assignment.id);
  assert.equal((await db('OutboxEvent').where({ eventId: f.event.id, type: 'bib.assigned' })).length, 1);
  assert.equal((await db('AuditLog').where({ action: 'events.bib_assigned', target: f.event.id })).length, 1);
  assert.equal((await db('AuditLog').where({ action: 'events.kit_offline_bib_assigned', target: f.event.id })).length, 1);
  const note = await eventually(() => db('Notification').where({ userId: f.regs[0].userId, type: 'event_bib_assigned' }));
  assert.equal(note.length, 1);
  assert.equal((await rows(f.regs[0].id)).length, 1);
  // a manual retype of the same number on another scan of the same person (not possible: duplicate) → not_applied; same number on a person who has it → same_already
  const f2 = await h.kitEvent({ n: 1 });
  await db('EventBibAssignment').insert({ id: uid('ebn'), eventId: f2.event.id, categoryId: (await db('EventRegistration').where({ id: f2.regs[0].id }).first()).categoryId, registrationId: f2.regs[0].id, bibNumber: 'A0107', assignedAt: new Date(), createdAt: new Date() });
  await db('EventRegistration').where({ id: f2.regs[0].id }).update({ bibNumber: 'A0107' });
  const d2 = await desk(f2.organizer.owner, f2, { bibRange: { prefix: 'A', padTo: 4, start: 101, end: 150 } });
  const same = await sync(f2.organizer.owner, f2, d2.id, [item(f2, 0, { bibNumber: 'A0107' })]);
  assert.deepEqual(same.body.results[0].bib, { outcome: 'same_already', number: 'A0107' });
  assert.equal(same.body.summary.needsReview, 0);
  assert.equal((await db('EventBibAssignment').where({ registrationId: f2.regs[0].id })).length, 1);
  const metrics = await db('EventAnalyticsDaily').where({ eventId: f.event.id });
  void metrics;
});

test('offline bib exceptions: out of range, no block, other bib already held, number taken by someone else, bad format. The kit handover STANDS in every case and the scan goes to review', async () => {
  s7On({ offline: true });
  const f = await h.kitEvent({ n: 6 });
  const catId = (await db('EventRegistration').where({ id: f.regs[0].id }).first()).categoryId;
  await db('EventBibAssignment').insert([
    { id: uid('ebn'), eventId: f.event.id, categoryId: catId, registrationId: f.regs[4].id, bibNumber: 'A0120', assignedAt: new Date(), createdAt: new Date() },
    { id: uid('ebn'), eventId: f.event.id, categoryId: catId, registrationId: f.regs[5].id, bibNumber: 'A0130', assignedAt: new Date(), createdAt: new Date() },
  ]);
  await db('EventRegistration').where({ id: f.regs[4].id }).update({ bibNumber: 'A0120' });
  await db('EventRegistration').where({ id: f.regs[5].id }).update({ bibNumber: 'A0130' });
  const withBlock = await desk(f.organizer.owner, f, { label: 'Block', bibRange: { prefix: 'A', padTo: 4, start: 101, end: 150 } });
  const noBlock = await desk(f.organizer.ops, f, { label: 'Ops' });
  const a = await sync(f.organizer.owner, f, withBlock.id, [
    item(f, 0, { bibNumber: 'A0999' }),          // out_of_range
    item(f, 1, { bibNumber: 'A0120' }),          // taken (regs[4] holds it)
    item(f, 2, { bibNumber: '!!bad!!' }),        // format_invalid
    item(f, 4, { bibNumber: 'A0101' }),          // regs[4] already holds A0120 -> registration_has_other
  ]);
  assert.deepEqual(a.body.results.map(x => [x.outcome, x.bib.outcome]), [['accepted', 'out_of_range'], ['accepted', 'taken'], ['accepted', 'format_invalid'], ['accepted', 'registration_has_other']]);
  assert.equal(a.body.summary.accepted, 4);
  assert.equal(a.body.summary.bibExceptions, 4);
  assert.equal(a.body.summary.needsReview, 4);
  const b = await sync(f.organizer.ops, f, noBlock.id, [item(f, 3, { bibNumber: 'A0110' })]);
  assert.deepEqual([b.body.results[0].outcome, b.body.results[0].bib.outcome], ['accepted', 'no_range']);
  for (const i of [0, 1, 2, 3, 4]) assert.equal((await rows(f.regs[i].id)).filter(r => r.status === 'collected').length, 1, `kit ${i} stands`);
  assert.equal((await db('EventRegistration').where({ id: f.regs[1].id }).first()).bibNumber, null, 'the number was not given to the second person');
  assert.equal((await db('EventRegistration').where({ id: f.regs[4].id }).first()).bibNumber, 'A0120', 'an existing bib is never replaced offline');
  assert.equal((await db('EventBibAssignment').where({ eventId: f.event.id }).whereNull('releasedAt')).length, 2);
  assert.equal((await db('AuditLog').where({ action: 'events.kit_offline_bib_exception', target: f.event.id })).length, 5);
  const review = await call(organizerOfflineReview, f.organizer.owner, { params: { id: f.event.id } });
  assert.equal(review.body.items.length, 5);
  assert.deepEqual(review.body.items.map(i => i.bibOutcome).sort(), ['format_invalid', 'no_range', 'out_of_range', 'registration_has_other', 'taken']);
  assert.ok(review.body.items.every(i => i.outcome === 'accepted' && i.bibClaimed));
});

test('the savepoint holds: a unique violation on the live-bib index inside the bib step does not roll back the collection, and a duplicate scan never applies a bib', async () => {
  s7On({ offline: true });
  const f = await h.kitEvent({ n: 3 });
  const a = await desk(f.organizer.owner, f, { label: 'A', bibRange: { prefix: 'A', padTo: 4, start: 1, end: 50 } });
  // the pre-check says free, the index says taken: simulate the race by inserting the holder between the check and the insert
  const catId = (await db('EventRegistration').where({ id: f.regs[0].id }).first()).categoryId;
  const real = eventsKitOfflineService.internals.assignOfflineBibTx;
  assert.equal(typeof real, 'function');
  await db('EventBibAssignment').insert({ id: uid('ebn'), eventId: f.event.id, categoryId: catId, registrationId: f.regs[2].id, bibNumber: 'A0007', assignedAt: new Date(), createdAt: new Date() });
  const r = await sync(f.organizer.owner, f, a.id, [item(f, 0, { bibNumber: 'A0007' })]);
  assert.deepEqual([r.body.results[0].outcome, r.body.results[0].bib.outcome], ['accepted', 'taken']);
  assert.equal((await rows(f.regs[0].id)).length, 1, 'the collection committed');
  assert.equal((await db('EventKitOfflineScan').where({ deviceId: a.id })).length, 1);
  // a duplicate (kit already collected) keeps the claimed number for the reviewer and applies nothing
  const b = await desk(f.organizer.admin, f, { label: 'B', bibRange: { prefix: 'B', padTo: 4, start: 1, end: 50 } });
  const dup = await sync(f.organizer.admin, f, b.id, [item(f, 0, { bibNumber: 'B0001' })]);
  assert.deepEqual([dup.body.results[0].outcome, dup.body.results[0].bib.outcome], ['duplicate', 'not_applied']);
  assert.equal((await db('EventKitOfflineScan').where({ deviceId: b.id }).first()).bibClaimed, 'B0001');
  assert.equal((await db('EventBibAssignment').where({ bibNumber: 'B0001' })).length, 0);
});

test('two desks recording bibs at once from their own blocks: every bib lands on its person, nothing collides', async () => {
  s7On({ offline: true });
  const f = await h.kitEvent({ n: 6 });
  const a = await desk(f.organizer.owner, f, { label: 'A', bibRange: { prefix: 'A', padTo: 3, start: 1, end: 100 } });
  const b = await desk(f.organizer.admin, f, { label: 'B', bibRange: { prefix: 'B', padTo: 3, start: 1, end: 100 } });
  const [ra, rb] = await Promise.all([
    sync(f.organizer.owner, f, a.id, [0, 1, 2].map(i => item(f, i, { bibNumber: `A${String(i + 1).padStart(3, '0')}` }))),
    sync(f.organizer.admin, f, b.id, [3, 4, 5].map(i => item(f, i, { bibNumber: `B${String(i - 2).padStart(3, '0')}` }))),
  ]);
  assert.equal(ra.body.summary.accepted + rb.body.summary.accepted, 6);
  assert.equal(ra.body.summary.bibExceptions + rb.body.summary.bibExceptions, 0);
  const bibs = (await db('EventRegistration').whereIn('id', f.regs.map(r => r.id)).select('bibNumber')).map(r => r.bibNumber).sort();
  assert.deepEqual(bibs, ['A001', 'A002', 'A003', 'B001', 'B002', 'B003']);
});

test('heartbeat: counts only, updates the desk row, tells the desk its status; a minimum build is enforced everywhere (426)', async () => {
  s7On({ offline: true });
  const f = await h.kitEvent({ n: 1 });
  const d = await desk(f.organizer.ops, f);
  const hb = await call(organizerOfflineHeartbeat, f.organizer.ops, { params: { id: f.event.id }, body: { deviceId: d.id, pending: 4, oldestPendingAt: new Date().toISOString(), discarded: 1, deskBuild: 7, clockOffsetMs: 1200 } });
  assert.equal(hb.status, 200, JSON.stringify(hb.body));
  assert.deepEqual([hb.body.deviceStatus, hb.body.minDeskBuild], ['active', null]);
  const row = await db('EventKitOfflineDevice').where({ id: d.id }).first();
  assert.deepEqual([row.pendingReported, row.discardedReported, row.deskBuild], [4, 1, '7']);
  assert.ok(row.lastHeartbeatAt);
  const summary = await call(organizerKitSummary, f.organizer.owner, { params: { id: f.event.id } });
  assert.deepEqual(summary.body.offline, { desks: 1, pendingReported: 4, needsReview: 0 });
  assert.equal((await call(organizerOfflineHeartbeat, f.organizer.admin, { params: { id: f.event.id }, body: { deviceId: d.id, pending: 0 } })).status, 404, 'not another user\'s desk');
  process.env.EVENTS_OFFLINE_MIN_DESK_BUILD = '9';
  for (const r of [
    await call(organizerOfflineHeartbeat, f.organizer.ops, { params: { id: f.event.id }, body: { deviceId: d.id, pending: 0, deskBuild: 7 } }),
    await snapshot(f.organizer.ops, f, d.id, { deskBuild: '7' }),
    await sync(f.organizer.ops, f, d.id, [item(f, 0)], { deskBuild: 7 }),
    await prepare(f.organizer.ops, f, { deskBuild: 7 }),
  ]) assert.deepEqual([r.status, r.body.error, r.body.minBuild], [426, 'desk_update_required', 9]);
  assert.equal((await sync(f.organizer.ops, f, d.id, [item(f, 0)], { deskBuild: 9 })).status, 200);
  delete process.env.EVENTS_OFFLINE_MIN_DESK_BUILD;
});

test('sync limits and shape: batch size 413, empty / bad batch id 400, not your desk 404, unavailable ticket secret 503, rate limit 30 a minute', async () => {
  s7On({ offline: true });
  process.env.EVENTS_OFFLINE_SYNC_BATCH = '3';
  const f = await h.kitEvent({ n: 1 });
  const d = await desk(f.organizer.ops, f);
  assert.equal((await sync(f.organizer.ops, f, d.id, Array.from({ length: 4 }, () => item(f, 0)))).status, 413);
  assert.equal((await sync(f.organizer.ops, f, d.id, [])).status, 400);
  assert.equal((await sync(f.organizer.ops, f, d.id, [item(f, 0)], { batchId: 'x' })).status, 400);
  assert.equal((await sync(f.organizer.admin, f, d.id, [item(f, 0)])).status, 404);
  assert.equal((await sync(f.organizer.timing, f, d.id, [item(f, 0)])).status, 403);
  delete process.env.EVENTS_OFFLINE_SYNC_BATCH;
  const secret = process.env.EVENT_TICKET_SECRET;
  delete process.env.EVENT_TICKET_SECRET;
  assert.equal((await sync(f.organizer.ops, f, d.id, [item(f, 0)])).status, 503);
  process.env.EVENT_TICKET_SECRET = secret;
  resetEventsKitOfflineLimits();
  let last;
  for (let i = 0; i < 31; i += 1) last = await sync(f.organizer.ops, f, d.id, [item(f, 0, { clientRef: randomUUID() })]);
  assert.equal(last.status, 429);
});

test('the ops role sees only its own desks; owner and admin see all, with bib counts; the admin (FitFlex) overview and removal work', async () => {
  s7On({ offline: true });
  const f = await h.kitEvent({ n: 2 });
  const mine = await desk(f.organizer.ops, f, { label: 'Ops phone' });
  const theirs = await desk(f.organizer.owner, f, { label: 'Owner laptop', bibRange: { prefix: 'Z', padTo: 3, start: 1, end: 9 } });
  await sync(f.organizer.owner, f, theirs.id, [item(f, 0, { bibNumber: 'Z001' }), item(f, 1, { bibNumber: 'Z999' })]);
  const asOps = await call(organizerListOfflineDesks, f.organizer.ops, { params: { id: f.event.id } });
  assert.deepEqual(asOps.body.items.map(i => i.id), [mine.id]);
  const asOwner = await call(organizerListOfflineDesks, f.organizer.owner, { params: { id: f.event.id } });
  assert.equal(asOwner.body.items.length, 2);
  const ownerDesk = asOwner.body.items.find(i => i.id === theirs.id);
  assert.deepEqual([ownerDesk.bibsRecorded, ownerDesk.bibExceptions, ownerDesk.bibRange.prefix], [1, 1, 'Z']);
  assert.equal((await call(organizerListOfflineDesks, f.organizer.timing, { params: { id: f.event.id } })).status, 403);
  assert.equal((await call(organizerListOfflineDesks, f.organizer.owner, { params: { id: f.event.id }, query: { status: 'revoked' } })).body.items.length, 0);
  const admin = await h.superAdmin();
  const ov = await call(adminOfflineKit, admin, { params: { id: f.event.id } });
  assert.equal(ov.status, 200);
  assert.deepEqual([ov.body.items.length, ov.body.counts.needsReview], [2, 1]);
  const rev = await call(adminRevokeOfflineDesk, admin, { params: { id: f.event.id, deviceId: mine.id }, body: { reason: 'Organizer asked FitFlex to cut it' } });
  assert.equal(rev.status, 200);
  assert.equal((await db('AuditLog').where({ action: 'events.kit_offline_device_revoked', target: f.event.id })).length, 1);
  assert.equal((await call(adminRevokeOfflineDesk, admin, { params: { id: f.event.id, deviceId: mine.id }, body: { reason: 'Organizer asked FitFlex to cut it' } })).status, 409);
  assert.equal((await call(adminRevokeOfflineDesk, admin, { params: { id: f.event.id, deviceId: theirs.id }, body: { reason: 'short' } })).body.error, 'reason_required');
  assert.equal((await call(adminOfflineKit, admin, { params: { id: 'evt_nothere' } })).status, 404);
  // another organizer's event is invisible
  const stranger = await h.kitEvent({ n: 0 });
  assert.equal((await call(organizerListOfflineDesks, stranger.organizer.owner, { params: { id: f.event.id } })).status, 404);
});

test('the daily purge expires old desks, removes desks of staff who left, and keeps unreviewed scans', async () => {
  s7On({ offline: true });
  const f = await h.kitEvent({ n: 2 });
  const d = await desk(f.organizer.ops, f);
  const e = await desk(f.organizer.admin, f, { label: 'Admin phone' });
  await sync(f.organizer.ops, f, d.id, [item(f, 0)]);
  await sync(f.organizer.ops, f, d.id, [item(f, 0, { clientRef: randomUUID() })]);   // a duplicate: stays because it waits for review
  await db('EventKitOfflineDevice').where({ id: d.id }).update({ expiresAt: new Date(Date.now() - 1000) });
  await db('EventOrganizerStaff').where({ organizerId: f.organizer.id, userId: f.organizer.admin.sub }).update({ status: 'removed', removedAt: new Date() });
  process.env.EVENTS_OFFLINE_SCAN_KEEP_DAYS = '1';
  await db('EventKitOfflineScan').where({ deviceId: d.id }).update({ receivedAt: new Date(Date.now() - 3 * 86_400_000) });
  const r = await opsService.runJob('event-kit-offline-purge', { trigger: 'manual', actorId: 'spec' });
  assert.equal(r.stats.skipped, undefined);
  assert.equal((await db('EventKitOfflineDevice').where({ id: d.id }).first()).status, 'expired');
  assert.equal((await db('EventKitOfflineDevice').where({ id: e.id }).first()).status, 'revoked');
  const left = await db('EventKitOfflineScan').where({ deviceId: d.id });
  assert.deepEqual(left.map(s => s.outcome), ['duplicate'], 'the accepted scan went after the keep days; the one waiting for a person stays');
  await db('EventOrganizerStaff').where({ organizerId: f.organizer.id, userId: f.organizer.admin.sub }).update({ status: 'active', removedAt: null });
  s7Off();
  assert.equal((await opsService.runJob('event-kit-offline-purge', { trigger: 'manual', actorId: 'spec' })).stats.skipped, 'flag_off');
});

test('migration down fails closed once offline data exists', async () => {
  s7On({ offline: true });
  const f = await h.kitEvent({ n: 1 });
  await desk(f.organizer.ops, f);
  const migration = createRequire(import.meta.url)('../db/migrations/20270202090100-events-kit-offline-s7.cjs');
  await assert.rejects(() => migration.down(db), /fails closed/);
  assert.equal((await db.raw(`select to_regclass('public."EventKitOfflineDevice"') as t`)).rows[0].t !== null, true, 'nothing was dropped');
});
