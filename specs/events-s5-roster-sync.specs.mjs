// Marathon & running events · S5 — the roster with a keyset cursor, the change feed, and the audited CSV export (spec §4.5, scenario 19 for the feeds).
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { sign } from '../src/auth/jwt.mjs';
import { ensureInit } from '../functions/index.mjs';
import { organizerListRegistrations } from '../functions/events-organizer.mjs';
import { organizerRegistrationChanges, organizerExportRegistrations, organizerAssignBib, organizerCollectKit, resetEventsOpsLimits } from '../functions/events-ops.mjs';
import { claimEventRegistration } from '../functions/events-registration.mjs';
import { harness, s5On, s5Off, db, uid } from './fixtures/events-s5.mjs';
import { csvCell, neutralise } from '../src/shared/events-ops-rules.mjs';
import { encodeCursor } from '../src/shared/events-ops-rules.mjs';
import { eventMoneyStore } from '../src/bootstrap/services.mjs';

await ensureInit();
const h = harness();
const { call } = h;
afterEach(() => { resetEventsOpsLimits(); });
after(async () => { await h.cleanup(); await db.destroy(); });
const key = () => `rs_${uid('').slice(1)}`;
const FORBIDDEN = /phone|email|dateOfBirth|gender|emergency|participantUserId|purchaserUserId|claimToken|tokenHash|paymentId/i;
const keysOf = (v, out = []) => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); keysOf(x, out); } return out; };

/** A response that can be written to in chunks, like the real one. */
function streamRes() {
  return { statusCode: 200, headers: {}, chunks: [], ended: false, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, set(k, v) { this.headers[k] = v; return this; }, write(c) { this.chunks.push(c); return true; }, end() { this.ended = true; return this; } };
}
async function download(f, claims, { abortAfter = null } = {}) {
  const req = { method: 'GET', headers: { authorization: `Bearer ${sign(claims)}` }, params: { id: f.event.id }, query: {}, body: {}, ip: '10.0.0.1', get: () => null };
  const res = streamRes();
  for (const g of [organizerExportRegistrations.onGuard].flat()) { let ok = false; await g(req, res, () => { ok = true; }); if (!ok) return res; }
  if (abortAfter !== null) { const w = res.write.bind(res); res.write = (c) => { w(c); if (res.chunks.length >= abortAfter) throw new Error('client went away'); return true; }; }
  try { await organizerExportRegistrations.onRequest(req, res); } catch { /* the client aborted */ }
  return res;
}

test('the roster: same item shape plus bibNumber / kit / updatedAt; names masked before payment; a keyset cursor pages past the old 2,000-row cut-off; updatedSince; flag off is the S3 answer', async () => {
  s5On();
  const f = await h.kitEvent({ n: 3 });
  const list = q => call(organizerListRegistrations, f.organizer.ops, { params: { id: f.event.id }, query: q });
  const all = await list({});
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.deepEqual(all.body.items.map(i => i.id).sort(), f.regs.map(r => r.id).sort());
  assert.ok(all.body.items[0].kit && 'bibNumber' in all.body.items[0] && all.body.items[0].updatedAt);
  assert.deepEqual(keysOf(all.body).filter(k => FORBIDDEN.test(k)), []);
  // an unpaid place: masked name, no kit size
  await db('EventRegistration').where({ id: f.regs[0].id }).update({ status: 'reserved' });
  await db('EventOrder').where({ id: f.regs[0].orderId }).update({ confirmedAt: null });
  const masked = (await list({})).body.items.find(i => i.id === f.regs[0].id);
  assert.match(masked.participant.name, /\*/);
  assert.equal(masked.kitSize, null);
  await db('EventRegistration').where({ id: f.regs[0].id }).update({ status: 'confirmed' });
  // paging: 2 at a time, no duplicates, no gaps
  const p1 = await list({ limit: '2' });
  const p2 = await list({ limit: '2', cursor: p1.body.nextCursor });
  assert.deepEqual([p1.body.items.length, p2.body.items.length, p2.body.nextCursor, p1.body.total], [2, 1, null, 3]);
  assert.equal(new Set([...p1.body.items, ...p2.body.items].map(i => i.id)).size, 3);
  assert.equal((await list({ cursor: 'garbage' })).body.error, 'invalid_cursor');
  // past 2,000: 2,100 more rows straight into the table (one order, one line), then page through all of them
  const base = await db('EventRegistration').where({ id: f.regs[1].id }).first();
  const extra = Array.from({ length: 2100 }, (_, i) => ({ ...base, id: `ereg_bulk_${String(i).padStart(5, '0')}`, claimTokenHash: null, participantUserId: null, claimedAt: null, createdAt: new Date(Date.now() - (i + 10) * 1000) }));
  for (let i = 0; i < extra.length; i += 500) await db('EventRegistration').insert(extra.slice(i, i + 500));
  let seen = 0; let cursor;
  for (let guard = 0; guard < 30; guard += 1) {
    const page = await list({ limit: '200', ...(cursor ? { cursor } : {}) });
    seen += page.body.items.length; cursor = page.body.nextCursor;
    if (!cursor) break;
  }
  assert.equal(seen, 2103, 'every row is reachable, not just the newest 2,000');
  // updatedSince: only what changed
  const since = new Date().toISOString();
  await new Promise(r => setTimeout(r, 20));
  await call(organizerAssignBib, f.organizer.ops, { params: { id: f.event.id }, headers: { 'Idempotency-Key': key() }, body: { registrationId: f.regs[2].id, bibNumber: '88' } });
  const changed = await list({ updatedSince: since });
  assert.deepEqual(changed.body.items.map(i => i.id), [f.regs[2].id]);
  assert.equal(changed.body.items[0].bibNumber, '88');
  assert.equal((await list({ bib: 'assigned' })).body.items.length, 1);
  assert.equal((await list({ kit: 'remaining', limit: '1' })).body.items.length, 1);
  assert.equal((await list({ updatedSince: 'not-a-date' })).status, 400);
  await db('EventRegistration').where('id', 'like', 'ereg_bulk_%').del();
  // flag off: exactly the S3 shape (no kit, no bibNumber)
  s5Off(); s5On({ kit: false });
  const legacy = await list({});
  assert.equal(legacy.status, 200);
  assert.ok(!('kit' in legacy.body.items[0]) && !('bibNumber' in legacy.body.items[0]));
});

test('the change feed: ordered by seq, a cursor that never moves backwards, tombstones without names, expand, overlap-safe dedupe ids, the commit lag, cursor errors', async () => {
  s5On();
  const f = await h.kitEvent({ n: 2 });
  const feed = q => call(organizerRegistrationChanges, f.organizer.timing, { params: { id: f.event.id }, query: q });
  // the fixture committed registrations through the store: registration.created rows exist
  const first = await feed({});
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.ok(first.body.items.every((i, k, a) => k === 0 || a[k - 1].seq < i.seq));
  assert.deepEqual([...new Set(first.body.items.map(i => i.eventType))], ['registration.created']);
  assert.ok(first.body.items.every(i => i.id.startsWith('obx_') && i.registrationId && i.changedAt));
  // new facts: kit, bib, claim
  await call(organizerCollectKit, f.organizer.ops, { params: { id: f.event.id }, headers: { 'Idempotency-Key': key() }, body: { method: 'scan', payload: f.regs[0].payload, collectionPointId: f.points[0].id } });
  await call(organizerAssignBib, f.organizer.ops, { params: { id: f.event.id }, headers: { 'Idempotency-Key': key() }, body: { registrationId: f.regs[1].id, bibNumber: '31' } });
  const next = await feed({ cursor: first.body.nextCursor });
  assert.deepEqual(next.body.items.map(i => i.eventType), ['kit.collected', 'bib.assigned']);
  assert.equal(next.body.hasMore, false);
  // nothing new → the SAME position comes back
  const idle = await feed({ cursor: next.body.nextCursor });
  assert.deepEqual(idle.body.items, []);
  assert.deepEqual(JSON.parse(Buffer.from(idle.body.nextCursor, 'base64url')).s, JSON.parse(Buffer.from(next.body.nextCursor, 'base64url')).s);
  // paging with a small limit, and overlap: re-reading from the first cursor repeats the same ids
  const small = await feed({ limit: '2' });
  assert.equal(small.body.hasMore, true);
  const rest = await feed({ limit: '50', cursor: small.body.nextCursor });
  const again = await feed({ limit: '50' });
  assert.deepEqual([...small.body.items, ...rest.body.items].map(i => i.id), again.body.items.map(i => i.id));
  // a cancelled place is a tombstone with no names (also when expanded)
  const order = await db('EventOrder').where({ id: f.regs[1].orderId }).first();
  await db.transaction(async trx => eventMoneyStore.cancelPaidPlaces(trx, { order, registrations: await trx('EventRegistration').where({ id: f.regs[1].id }), cancelReason: 'cancelled' }));
  const tomb = await feed({ cursor: next.body.nextCursor, expand: 'registration' });
  const t = tomb.body.items.find(i => i.eventType === 'registration.cancelled');
  assert.deepEqual([t.status, t.reasonCode, t.registration.firstName, t.registration.lastName, t.registration.bibNumber], ['cancelled', 'cancelled', null, null, null]);
  assert.ok(t.cancelledAt);
  assert.deepEqual(keysOf(tomb.body).filter(k => FORBIDDEN.test(k)), []);
  // the live record under expand has names
  const withNames = await feed({ cursor: first.body.nextCursor, expand: 'registration' });
  assert.equal(withNames.body.items[0].registration.firstName, f.regs[0].firstName);
  // errors
  assert.equal((await feed({ cursor: '%%%' })).body.error, 'invalid_cursor');
  assert.equal((await feed({ limit: '0' })).body.error, 'invalid_limit');
  assert.equal((await feed({ expand: 'registration', limit: '150' })).body.error, 'invalid_limit');
  assert.equal((await feed({ expand: 'orders' })).body.error, 'invalid_request');
  const old = encodeCursor({ s: 1, t: Date.now() - 91 * 86_400_000 });
  assert.deepEqual([(await feed({ cursor: old })).status, (await feed({ cursor: old })).body.error], [410, 'cursor_expired']);
});

test('the commit lag: a row younger than EVENTS_FEED_LAG_SECONDS is not served yet', async () => {
  s5On();
  process.env.EVENTS_FEED_LAG_SECONDS = '60';
  const f = await h.kitEvent({ n: 1 });
  const r = await call(organizerRegistrationChanges, f.organizer.ops, { params: { id: f.event.id }, query: {} });
  assert.deepEqual(r.body.items, []);
  await db('OutboxEvent').where({ eventId: f.event.id }).update({ createdAt: new Date(Date.now() - 120_000) });
  assert.equal((await call(organizerRegistrationChanges, f.organizer.ops, { params: { id: f.event.id }, query: {} })).body.items.length, 1);
});

test('a claim emits registration.updated { changed: [claimed] } in the same transaction', async () => {
  s5On();
  const f = await h.kitEvent({ n: 1 });
  await db('EventRegistration').where({ id: f.regs[0].id }).update({ participantUserId: null, claimedAt: null, consentBasis: 'purchaser_authorised' });
  const phone = '+255712' + String(Math.floor(Math.random() * 900000) + 100000);
  await db('EventRegistration').where({ id: f.regs[0].id }).update({ phoneNormalized: phone });
  const friend = await h.user({ phone });
  const claimed = await call(claimEventRegistration, h.claimsOf(friend), { params: { id: f.regs[0].id }, body: {} });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  const rows = await db('OutboxEvent').where({ eventId: f.event.id, type: 'registration.updated' });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].payload, { registrationId: f.regs[0].id, changed: ['claimed'] });
});

test('SCENARIO 19 (feeds): every organizer-A role against B\'s event id is 404 event_not_found, identical to a nonexistent id', async () => {
  s5On();
  const a = await h.kitEvent({ n: 1 });
  const b = await h.kitEvent({ n: 1 });
  for (const role of ['owner', 'admin', 'ops', 'timing']) {
    const claims = role === 'owner' ? a.organizer.owner : a.organizer[role];
    for (const [route, query] of [[organizerListRegistrations, {}], [organizerRegistrationChanges, {}]]) {
      const cross = await call(route, claims, { params: { id: b.event.id }, query });
      const missing = await call(route, claims, { params: { id: 'evt_missing' }, query });
      assert.deepEqual([cross.status, cross.body], [404, { error: 'event_not_found' }], role);
      assert.deepEqual(cross, missing);
    }
  }
  const x = await download(a, a.organizer.owner);
  assert.equal(x.statusCode, 200);
  const cross = await (async () => { const r = streamRes(); const req = { method: 'GET', headers: { authorization: `Bearer ${sign(a.organizer.owner)}` }, params: { id: b.event.id }, query: {}, body: {}, ip: '10.0.0.1', get: () => null }; for (const g of [organizerExportRegistrations.onGuard].flat()) await g(req, r, () => {}); await organizerExportRegistrations.onRequest(req, r); return r; })();
  assert.deepEqual([cross.statusCode, cross.body], [404, { error: 'event_not_found' }]);
});

test('export: fixed columns, BOM, CRLF, every cell quoted, formula cells neutralised, no contact data, cancelled rows blank; the audit row precedes the first byte; 5 an hour; owner/admin only', async () => {
  s5On();
  const f = await h.kitEvent({ n: 0 });
  const inj = await h.addRegistrations({ eventId: f.event.id, ticketType: f.ticketType, n: 1, firstName: '=cmd|\' /C calc\'!A0', lastName: '@SUM(1+1)' });
  const plain = await h.addRegistrations({ eventId: f.event.id, ticketType: f.ticketType, n: 2 });
  await db('EventRegistration').where({ id: plain[1].id }).update({ gender: 'female', dateOfBirth: '1990-01-01', emergencyContact: JSON.stringify({ name: 'Mama', phone: '+255700000000' }), email: 'secret@example.com' });
  const order = await db('EventOrder').where({ id: plain[1].orderId }).first();
  await db.transaction(async trx => eventMoneyStore.cancelPaidPlaces(trx, { order, registrations: await trx('EventRegistration').where({ id: plain[1].id }), cancelReason: 'cancelled' }));
  const res = await download(f, f.organizer.owner);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Content-Type'], /^text\/csv; charset=utf-8$/);
  assert.match(res.headers['Content-Disposition'], /^attachment; filename="[a-z0-9-]+-participants-\d{8}\.csv"$/);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  const text = res.chunks.join('');
  assert.ok(text.startsWith('﻿"registrationId","ticketCode","firstName","lastName","categoryName","ticketTypeName","status","bibNumber","kitStatus","kitCollectedAt","kitSize","teamName","groupLabel","claimed"\r\n'));
  const lines = text.slice(1).split('\r\n').filter(Boolean);
  assert.equal(lines.length, 4);
  assert.ok(lines.slice(1).every(l => l.startsWith('"') && l.endsWith('"')), 'every cell is quoted');
  const injected = lines.find(l => l.includes(inj[0].id));
  assert.ok(injected.includes(`"'=cmd|' /C calc'!A0"`.replace(/'/g, "'")) || injected.includes("\"'=cmd"), injected);
  assert.ok(injected.includes('"\'@SUM(1+1)"'));
  const cancelled = lines.find(l => l.includes(plain[1].id));
  assert.match(cancelled, /^"[^"]+","[^"]*","","","10K","Early","cancelled"/);
  assert.ok(!/secret@example|female|1990|Mama|255700000000|phone|email/i.test(text), 'no contact, DOB, gender or emergency data anywhere');
  assert.ok(res.ended);
  // helpers
  assert.equal(csvCell('a"b\nc'), '"a""b c"');
  for (const v of ['=1', '+1', '-1', '@x', '\tx', '\rx']) assert.equal(neutralise(v), `'${v}`);
  // role and rate limit
  assert.equal((await download(f, f.organizer.ops)).statusCode, 403);
  assert.equal((await download(f, f.organizer.finance)).statusCode, 403);
  for (let i = 0; i < 4; i += 1) assert.equal((await download(f, f.organizer.admin)).statusCode, 200);
  const sixth = await download(f, f.organizer.owner);
  assert.deepEqual([sixth.statusCode, sixth.body.error], [429, 'rate_limited']);
});

test('export: the audit row exists even if the stream aborts; too large is 413; a suspended organizer is refused', async () => {
  s5On();
  const f = await h.kitEvent({ n: 3 });
  const before = (await db('AuditLog').where({ action: 'events.roster_exported', target: f.event.id })).length;
  await download(f, f.organizer.owner, { abortAfter: 1 });
  const rows = await db('AuditLog').where({ action: 'events.roster_exported', target: f.event.id });
  assert.equal(rows.length, before + 1);
  assert.deepEqual([rows[0].after.rowCount, typeof rows[0].after.columnsHash], [3, 'string']);
  resetEventsOpsLimits();
  process.env.EVENTS_EXPORT_MAX_ROWS = '2';
  const big = await download(f, f.organizer.owner);
  assert.deepEqual([big.statusCode, big.body.error], [413, 'export_too_large']);
  delete process.env.EVENTS_EXPORT_MAX_ROWS;
  await db('EventOrganizer').where({ id: f.organizer.id }).update({ status: 'suspended', statusReason: 'spec' });
  assert.equal((await download(f, f.organizer.owner)).statusCode, 403);
  await db('EventOrganizer').where({ id: f.organizer.id }).update({ status: 'active', statusReason: null });
});
