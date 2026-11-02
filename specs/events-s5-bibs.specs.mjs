// Marathon & running events · S5 — bib numbers (spec §4.3, D40): single, release, bulk by rule (atomic), CSV import (dry run, all or nothing).
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ensureInit } from '../functions/index.mjs';
import {
  organizerAssignBib, organizerReleaseBib, organizerBibsBulkPreview, organizerBibsBulk, organizerBibsImportPreview, organizerBibsImport, organizerListBibs, organizerCollectKit, resetEventsOpsLimits,
} from '../functions/events-ops.mjs';
import { harness, s5On, db, uid, eventually } from './fixtures/events-s5.mjs';
import { eventMoneyStore } from '../src/bootstrap/services.mjs';

await ensureInit();
const h = harness();
const { call } = h;
afterEach(() => { resetEventsOpsLimits(); });
after(async () => { await h.cleanup(); await db.destroy(); });

const key = () => `bib_${uid('').slice(1)}`;
const assign = (claims, f, body, k = key()) => call(organizerAssignBib, claims, { params: { id: f.event.id }, headers: { 'Idempotency-Key': k }, body });
const bibOf = async id => (await db('EventRegistration').where({ id }).first()).bibNumber;

test('assign: 201, upper-cased, the registration view, outbox, audit and the participant notice; invalid numbers and unpaid places refused', async () => {
  s5On();
  const f = await h.kitEvent({ n: 2 });
  const r = await assign(f.organizer.ops, f, { registrationId: f.regs[0].id, bibNumber: ' 5k-001 ' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.assignment.bibNumber, '5K-001');
  assert.equal(await bibOf(f.regs[0].id), '5K-001');
  const out = await db('OutboxEvent').where({ eventId: f.event.id, type: 'bib.assigned' });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].payload, { registrationId: f.regs[0].id, eventId: f.event.id, categoryId: f.categories[0].id, bibNumber: '5K-001', previousBibNumber: null });
  assert.equal((await db('AuditLog').where({ action: 'events.bib_assigned', target: f.event.id })).length, 1);
  assert.equal((await eventually(() => db('Notification').where({ userId: f.regs[0].userId, type: 'event_bib_assigned' }))).length, 1);   // sent after the response, not awaited
  for (const bad of ['', '-1', 'a b', 'x'.repeat(13), 'é1', null]) assert.deepEqual([(await assign(f.organizer.ops, f, { registrationId: f.regs[1].id, bibNumber: bad })).status, bad], [422, bad]);
  await db('EventRegistration').where({ id: f.regs[1].id }).update({ status: 'reserved' });
  assert.equal((await assign(f.organizer.ops, f, { registrationId: f.regs[1].id, bibNumber: '77' })).body.error, 'registration_unpaid');
  assert.equal((await assign(f.organizer.ops, f, { registrationId: 'ereg_nope', bibNumber: '77' })).body.error, 'registration_not_found');
  assert.equal((await assign(f.organizer.timing, f, { registrationId: f.regs[0].id, bibNumber: '78' })).status, 403);
});

test('D40 — unique across the WHOLE event: the same number in another category is bib_taken; the database agrees', async () => {
  s5On();
  const f = await h.kitEvent({ n: 1 });
  const five = await h.addRegistrations({ eventId: f.event.id, ticketType: (await db('EventTicketType').where({ categoryId: f.categories[1].id }).first()), n: 1 });
  assert.equal((await assign(f.organizer.ops, f, { registrationId: f.regs[0].id, bibNumber: '101' })).status, 201);
  const clash = await assign(f.organizer.ops, f, { registrationId: five[0].id, bibNumber: '101' });
  assert.deepEqual([clash.status, clash.body.error], [409, 'bib_taken']);
  const reg5 = await db('EventRegistration').where({ id: five[0].id }).first();
  await assert.rejects(db('EventBibAssignment').insert({ id: uid('ebn'), eventId: f.event.id, categoryId: reg5.categoryId, registrationId: reg5.id, bibNumber: '101' }), err => err.code === '23505' && /live_event_bib_unique/.test(err.constraint));
});

test('replace needs owner/admin and a reason; one live bib per registration; same number again is a no-op 200; idempotent replays; release frees the number', async () => {
  s5On();
  const f = await h.kitEvent({ n: 2 });
  const k = key();
  const first = await assign(f.organizer.ops, f, { registrationId: f.regs[0].id, bibNumber: '201' }, k);
  assert.equal(first.status, 201);
  const replay = await assign(f.organizer.ops, f, { registrationId: f.regs[0].id, bibNumber: '201' }, k);
  assert.equal(replay.status, 200);
  assert.equal((await db('EventBibAssignment').where({ registrationId: f.regs[0].id })).length, 1);
  const already = await assign(f.organizer.ops, f, { registrationId: f.regs[0].id, bibNumber: '202' });
  assert.deepEqual([already.status, already.body.error, already.body.current], [409, 'bib_already_assigned', '201']);
  assert.equal((await assign(f.organizer.ops, f, { registrationId: f.regs[0].id, bibNumber: '202', replace: true, reason: 'a perfectly good reason' })).status, 403);
  assert.equal((await assign(f.organizer.admin, f, { registrationId: f.regs[0].id, bibNumber: '202', replace: true, reason: 'short' })).body.error, 'reason_required');
  const same = await assign(f.organizer.admin, f, { registrationId: f.regs[0].id, bibNumber: '201', replace: true, reason: 'same number again' });
  assert.equal(same.status, 200);
  const swapped = await assign(f.organizer.admin, f, { registrationId: f.regs[0].id, bibNumber: '202', replace: true, reason: 'printed the wrong number' });
  assert.equal(swapped.status, 201, JSON.stringify(swapped.body));
  assert.equal(swapped.body.previousBibNumber, '201');
  assert.equal(await bibOf(f.regs[0].id), '202');
  const history = await db('EventBibAssignment').where({ registrationId: f.regs[0].id }).orderBy('createdAt');
  assert.deepEqual(history.map(r => [r.bibNumber, Boolean(r.releasedAt)]), [['201', true], ['202', false]]);
  assert.equal(history[0].reason, 'printed the wrong number');
  // 201 is free again
  assert.equal((await assign(f.organizer.ops, f, { registrationId: f.regs[1].id, bibNumber: '201' })).status, 201);
  // release: owner/admin, reason, warns when the kit was already handed over
  assert.equal((await call(organizerCollectKit, f.organizer.ops, { params: { id: f.event.id }, headers: { 'Idempotency-Key': key() }, body: { method: 'scan', payload: f.regs[0].payload, collectionPointId: f.points[0].id } })).status, 201);
  const live = history[1];
  const rel = (claims, body) => call(organizerReleaseBib, claims, { params: { id: f.event.id, assignmentId: live.id }, headers: { 'Idempotency-Key': key() }, body });
  assert.equal((await rel(f.organizer.ops, { reason: 'bib was misprinted' })).status, 403);
  assert.equal((await rel(f.organizer.owner, { reason: 'x' })).body.error, 'reason_required');
  const done = await rel(f.organizer.owner, { reason: 'bib was misprinted' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(done.body.warnings, ['bib_changed_after_collection']);
  assert.equal(await bibOf(f.regs[0].id), null);
  assert.equal((await rel(f.organizer.owner, { reason: 'bib was misprinted' })).body.error, 'already_released');
});

test('a paid place that is cancelled gives its live bib back in the same transaction', async () => {
  s5On();
  const f = await h.kitEvent({ n: 1 });
  assert.equal((await assign(f.organizer.ops, f, { registrationId: f.regs[0].id, bibNumber: '301' })).status, 201);
  const order = await db('EventOrder').where({ id: f.regs[0].orderId }).first();
  const regs = await db('EventRegistration').where({ id: f.regs[0].id });
  await db.transaction(async trx => eventMoneyStore.cancelPaidPlaces(trx, { order, registrations: regs, cancelReason: 'cancelled' }));
  assert.equal(await bibOf(f.regs[0].id), null);
  const rows = await db('EventBibAssignment').where({ registrationId: f.regs[0].id });
  assert.deepEqual([rows.length, Boolean(rows[0].releasedAt), rows[0].reason], [1, true, 'registration_cancelled']);
  assert.equal((await db('OutboxEvent').where({ eventId: f.event.id, type: 'registration.cancelled' })).length, 1);
});

test('bulk by rule: preview writes nothing; apply is atomic with a fresh previewHash; changes since the preview → preview_stale; conflicts and shortfall refuse; inbox notices only', async () => {
  s5On();
  const f = await h.kitEvent({ n: 4 });
  assert.equal((await assign(f.organizer.admin, f, { registrationId: f.regs[3].id, bibNumber: 'A-0003' })).status, 201);
  const rule = { start: 1, prefix: 'a-', padTo: 4, order: 'registered_at', categoryId: f.categories[0].id };
  const prev = await call(organizerBibsBulkPreview, f.organizer.admin, { params: { id: f.event.id }, body: rule });
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  assert.deepEqual([prev.body.count, prev.body.first, prev.body.last, prev.body.shortfall], [3, 'A-0001', 'A-0003', 0]);
  assert.deepEqual(prev.body.conflicts, ['A-0003'], 'A-0003 is already taken');
  assert.equal((await db('EventBibAssignment').where({ eventId: f.event.id })).length, 1, 'a preview writes nothing');
  const blocked = await call(organizerBibsBulk, f.organizer.admin, { params: { id: f.event.id }, headers: { 'Idempotency-Key': key() }, body: { ...rule, previewHash: prev.body.previewHash } });
  assert.deepEqual([blocked.status, blocked.body.error], [409, 'bulk_not_applicable']);
  const rule2 = { ...rule, start: 10 };
  const p2 = await call(organizerBibsBulkPreview, f.organizer.admin, { params: { id: f.event.id }, body: rule2 });
  assert.deepEqual(p2.body.conflicts, []);
  // the roster changes between preview and apply
  await h.addRegistrations({ eventId: f.event.id, ticketType: f.ticketType, n: 1 });
  const stale = await call(organizerBibsBulk, f.organizer.admin, { params: { id: f.event.id }, headers: { 'Idempotency-Key': key() }, body: { ...rule2, previewHash: p2.body.previewHash } });
  assert.deepEqual([stale.status, stale.body.error], [409, 'preview_stale']);
  assert.equal((await db('EventBibAssignment').where({ eventId: f.event.id })).length, 1, 'stale applies nothing');
  const p3 = await call(organizerBibsBulkPreview, f.organizer.admin, { params: { id: f.event.id }, body: rule2 });
  assert.equal((await call(organizerBibsBulk, f.organizer.ops, { params: { id: f.event.id }, headers: { 'Idempotency-Key': key() }, body: { ...rule2, previewHash: p3.body.previewHash } })).status, 403);
  const applied = await call(organizerBibsBulk, f.organizer.admin, { params: { id: f.event.id }, headers: { 'Idempotency-Key': key() }, body: { ...rule2, previewHash: p3.body.previewHash } });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.deepEqual([applied.body.assigned, applied.body.first, applied.body.last], [4, 'A-0010', 'A-0013']);
  assert.equal((await db('OutboxEvent').where({ eventId: f.event.id, type: 'bib.assigned' })).length, 1 + 4);
  assert.equal((await db('AuditLog').where({ action: 'events.bibs_bulk_assigned', target: f.event.id })).length, 1);
  const notices = await db('Notification').where({ type: 'event_bib_assigned' }).whereIn('userId', f.regs.map(r => r.userId));
  assert.ok(notices.length >= 3);
  // a range too small: shortfall, nothing applied
  const tiny = await call(organizerBibsBulkPreview, f.organizer.admin, { params: { id: f.event.id }, body: { start: 500, end: 500, categoryId: f.categories[1].id } });
  assert.deepEqual([tiny.body.count, tiny.body.shortfall], [0, 0]);
  const more = await h.addRegistrations({ eventId: f.event.id, ticketType: await db('EventTicketType').where({ categoryId: f.categories[1].id }).first(), n: 2 });
  const short = await call(organizerBibsBulkPreview, f.organizer.admin, { params: { id: f.event.id }, body: { start: 500, end: 500, categoryId: f.categories[1].id } });
  assert.deepEqual([short.body.count, short.body.shortfall], [2, 1]);
  const refuse = await call(organizerBibsBulk, f.organizer.admin, { params: { id: f.event.id }, headers: { 'Idempotency-Key': key() }, body: { start: 500, end: 500, categoryId: f.categories[1].id, previewHash: short.body.previewHash } });
  assert.equal(refuse.body.error, 'bulk_not_applicable');
  assert.equal(await bibOf(more[0].id), null);
});

test('CSV import: dry run lists every problem with its line, formula cells are neutralised, apply is ALL OR NOTHING, ticketCode works, a changed roster is preview_stale', async () => {
  s5On();
  const f = await h.kitEvent({ n: 4 });
  assert.equal((await assign(f.organizer.admin, f, { registrationId: f.regs[3].id, bibNumber: '900' })).status, 201);
  const csv = [
    'registrationId,bibNumber',
    `${f.regs[0].id},101`,
    `${f.regs[0].id},102`,           // the same registration twice
    `${f.regs[1].id},101`,           // the same bib twice
    `${f.regs[2].id},900`,           // taken
    `${f.regs[3].id},777`,           // already has a bib
    '=HYPERLINK("http://x"),55',     // formula in the id column
    `${f.regs[1].id},-5`,            // invalid bib
    'ereg_nope,56',
  ].join('\n');
  const prev = await call(organizerBibsImportPreview, f.organizer.owner, { params: { id: f.event.id }, body: { csv } });
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  const codes = Object.fromEntries(prev.body.rows.map(r => [r.line, r.code]));
  assert.deepEqual(codes, { 2: null, 3: 'registration_duplicate_in_file', 4: 'bib_duplicate_in_file', 5: 'bib_taken', 6: 'already_assigned', 7: 'registration_not_found', 8: 'bib_invalid', 9: 'registration_not_found' });
  assert.equal(prev.body.ok, 1); assert.equal(prev.body.bad, 7);
  const echoed = prev.body.rows.find(r => r.line === 7);
  assert.ok(!JSON.stringify(prev.body).includes('HYPERLINK'), 'the formula cell is never echoed');
  void echoed;
  const bad = await call(organizerBibsImport, f.organizer.owner, { params: { id: f.event.id }, headers: { 'Idempotency-Key': key() }, body: { csv, previewHash: prev.body.previewHash } });
  assert.deepEqual([bad.status, bad.body.error, bad.body.bad], [409, 'import_has_errors', 7]);
  assert.equal(await bibOf(f.regs[0].id), null, 'one bad row and NOTHING is written');
  // a clean file by ticket code (semicolons, BOM, CRLF)
  const clean = `﻿ticketCode;bibNumber\r\n${f.regs[0].displayCode};601\r\n${f.regs[1].displayCode};602\r\n`;
  const p2 = await call(organizerBibsImportPreview, f.organizer.owner, { params: { id: f.event.id }, body: { csv: clean } });
  assert.deepEqual([p2.body.ok, p2.body.bad], [2, 0], JSON.stringify(p2.body));
  assert.equal((await call(organizerBibsImport, f.organizer.admin, { params: { id: f.event.id }, headers: { 'Idempotency-Key': key() }, body: { csv: clean, previewHash: 'f'.repeat(64) } })).body.error, 'preview_stale');
  assert.equal((await call(organizerBibsImport, f.organizer.ops, { params: { id: f.event.id }, headers: { 'Idempotency-Key': key() }, body: { csv: clean, previewHash: p2.body.previewHash } })).status, 403);
  const done = await call(organizerBibsImport, f.organizer.admin, { params: { id: f.event.id }, headers: { 'Idempotency-Key': key() }, body: { csv: clean, previewHash: p2.body.previewHash } });
  assert.deepEqual([done.status, done.body.imported], [200, 2], JSON.stringify(done.body));
  assert.deepEqual([await bibOf(f.regs[0].id), await bibOf(f.regs[1].id)], ['601', '602']);
  assert.equal((await db('AuditLog').where({ action: 'events.bibs_imported', target: f.event.id })).length, 1);
  // limits and shape
  assert.equal((await call(organizerBibsImportPreview, f.organizer.admin, { params: { id: f.event.id }, body: { csv: 'a,b\n1,2' } })).body.error, 'csv_header_invalid');
  assert.equal((await call(organizerBibsImportPreview, f.organizer.admin, { params: { id: f.event.id }, body: { csv: 'x'.repeat(600 * 1024) } })).status, 413);
  assert.equal((await call(organizerBibsImportPreview, f.organizer.admin, { params: { id: f.event.id }, body: { csv: '' } })).status, 422);
});

test('the list: counts, filters, search by bib/code/name; timing may read, finance may not', async () => {
  s5On();
  const f = await h.kitEvent({ n: 3 });
  await assign(f.organizer.admin, f, { registrationId: f.regs[0].id, bibNumber: '401' });
  const all = await call(organizerListBibs, f.organizer.timing, { params: { id: f.event.id }, query: {} });
  assert.deepEqual(all.body.counts, { assigned: 1, unassigned: 2 });
  assert.equal(all.body.items.length, 3);
  assert.equal((await call(organizerListBibs, f.organizer.ops, { params: { id: f.event.id }, query: { filter: 'unassigned' } })).body.items.length, 2);
  assert.equal((await call(organizerListBibs, f.organizer.ops, { params: { id: f.event.id }, query: { q: '401' } })).body.items[0].registrationId, f.regs[0].id);
  assert.equal((await call(organizerListBibs, f.organizer.ops, { params: { id: f.event.id }, query: { q: f.regs[1].displayCode } })).body.items[0].registrationId, f.regs[1].id);
  const page = await call(organizerListBibs, f.organizer.ops, { params: { id: f.event.id }, query: { limit: '2' } });
  assert.equal(page.body.items.length, 2);
  assert.equal((await call(organizerListBibs, f.organizer.ops, { params: { id: f.event.id }, query: { cursor: page.body.nextCursor } })).body.items.length, 1);
  assert.equal((await call(organizerListBibs, f.organizer.ops, { params: { id: f.event.id }, query: { cursor: 'garbage' } })).body.error, 'invalid_cursor');
  assert.equal((await call(organizerListBibs, f.organizer.finance, { params: { id: f.event.id }, query: {} })).status, 403);
});

test('ATOMICITY: if the database fails halfway through a bulk apply or an import, NOTHING stays written (a real mid-statement failure, not a pre-check)', async () => {
  s5On();
  const f = await h.kitEvent({ n: 3 });
  await db.raw(`CREATE OR REPLACE FUNCTION spec_s5_fail_second() RETURNS trigger AS $$ BEGIN IF NEW."bibNumber" IN ('ATOM-0002', 'ATOM-IMP2') THEN RAISE EXCEPTION 'spec: simulated failure on the second row'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
  await db.raw(`CREATE TRIGGER spec_s5_fail_second BEFORE INSERT ON "EventBibAssignment" FOR EACH ROW EXECUTE FUNCTION spec_s5_fail_second()`);
  try {
    const rule = { start: 1, prefix: 'atom-', padTo: 4, categoryId: f.categories[0].id };
    const prev = await call(organizerBibsBulkPreview, f.organizer.admin, { params: { id: f.event.id }, body: rule });
    assert.equal(prev.body.count, 3);
    await assert.rejects(call(organizerBibsBulk, f.organizer.admin, { params: { id: f.event.id }, headers: { 'Idempotency-Key': key() }, body: { ...rule, previewHash: prev.body.previewHash } }), /simulated failure/);
    assert.equal((await db('EventBibAssignment').where({ eventId: f.event.id }).count({ n: '*' }).first()).n, '0', 'the first row was rolled back with the rest');
    assert.equal((await db('OutboxEvent').where({ eventId: f.event.id, type: 'bib.assigned' })).length, 0);
    assert.equal((await db('EventRegistration').where({ eventId: f.event.id }).whereNotNull('bibNumber')).length, 0);
    assert.equal((await db('AuditLog').where({ action: 'events.bibs_bulk_assigned', target: f.event.id })).length, 0);
    assert.equal((await db('OrganizerIdempotency').where({ route: `POST bib-assignments/bulk|${f.event.id}` })).length, 0, 'the key is released, the caller can retry');
    const csv = `registrationId,bibNumber\n${f.regs[0].id},ATOM-IMP1\n${f.regs[1].id},ATOM-IMP2\n${f.regs[2].id},ATOM-IMP3\n`;
    const p = await call(organizerBibsImportPreview, f.organizer.admin, { params: { id: f.event.id }, body: { csv } });
    assert.equal(p.body.ok, 3);
    await assert.rejects(call(organizerBibsImport, f.organizer.admin, { params: { id: f.event.id }, headers: { 'Idempotency-Key': key() }, body: { csv, previewHash: p.body.previewHash } }), /simulated failure/);
    assert.equal((await db('EventBibAssignment').where({ eventId: f.event.id }).count({ n: '*' }).first()).n, '0');
  } finally {
    await db.raw('DROP TRIGGER IF EXISTS spec_s5_fail_second ON "EventBibAssignment"');
    await db.raw('DROP FUNCTION IF EXISTS spec_s5_fail_second()');
  }
});

test('a ticket code shared by two places of one event is AMBIGUOUS in an import (never guessed), while the lookup shows both masked cards', async () => {
  s5On();
  const f = await h.kitEvent({ n: 2 });
  await db('EventTicket').where({ id: f.regs[1].ticketId }).update({ displayCode: f.regs[0].displayCode });
  const csv = `ticketCode,bibNumber\n${f.regs[0].displayCode},701\n`;
  const prev = await call(organizerBibsImportPreview, f.organizer.admin, { params: { id: f.event.id }, body: { csv } });
  assert.deepEqual(prev.body.rows, [{ line: 2, status: 'error', code: 'ticket_code_ambiguous', bibNumber: '701' }]);
  const { organizerKitLookup } = await import('../functions/events-ops.mjs');
  const look = await call(organizerKitLookup, f.organizer.ops, { params: { id: f.event.id }, query: { q: f.regs[0].displayCode } });
  assert.equal(look.body.items.length, 2);
});
