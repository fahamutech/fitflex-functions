// Marathon & running events · S3 — corporate bulk registration at the route level against the CI database
// (spec §3.16 scenario 4; D18, D19): roster validation from CSV with header aliases, DD/MM/YYYY dates and
// "10K" categories, per-row problems, listed_twice and already_registered duplicates, capacity shortfalls,
// a quote for the ok rows only; placing with a bad row writes nothing; a clean 50-row roster passes with
// bulk although maxPerOrder is 10; idempotency scoped (organizationId, key); non-members are refused before
// any scope check; roster permission validates, ORG_BILLING places; organisation discounts; reads and cancel.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ensureInit } from '../functions/index.mjs';
import { validateB2BEventRoster, createB2BEventOrder, listB2BEventOrders, getB2BEventOrder, cancelB2BEventOrder, resetEventsCorporateLimits } from '../functions/events-corporate.mjs';
import { createEventOrder, claimableEventRegistrations } from '../functions/events-registration.mjs';
import { harness, participant, phone, flagsOn, flagsOff, uid } from './fixtures/events-s3.mjs';

await ensureInit();
const h = harness();
const { call, db } = h;
afterEach(() => flagsOff());
after(async () => { await h.cleanup(); await db.destroy(); });

const CONSENT = '2026-10-draft';
const key = () => `corp_${uid('').slice(1)}`;
const WORDS = ['Asha', 'Baraka', 'Zuwena', 'Hamisi', 'Neema', 'Juma', 'Grace', 'Tumaini', 'Joyce', 'Rehema'];
const csvRow = (i, over = {}) => ({ firstName: `${WORDS[i % WORDS.length]}${'a'.repeat(Math.floor(i / WORDS.length))}`, lastName: 'Mollel', phone: phone(), category: '10K', ...over });
const place = (orgId, claims, body, k = key()) => call(createB2BEventOrder, claims, { params: { id: orgId }, headers: { 'Idempotency-Key': k }, body: { acceptedTerms: true, consentTextVersion: CONSENT, ...body } });

test('flag off: every corporate route is 404 feature_disabled', async () => {
  const org = await h.organization();
  const admin = await org.member('admin');
  for (const [route, params] of [[validateB2BEventRoster, { id: org.id }], [createB2BEventOrder, { id: org.id }], [listB2BEventOrders, { id: org.id }], [getB2BEventOrder, { id: org.id, orderId: 'x' }], [cancelB2BEventOrder, { id: org.id, orderId: 'x' }]]) {
    assert.deepEqual((await call(route, admin, { params })).body, { error: 'feature_disabled' }, route.path);
  }
});

test('scenario 4: CSV with aliases, DD/MM/YYYY and "10K"; per-row problems; listed_twice; already_registered; capacityShort; quote for ok rows only; placing with a bad row writes nothing', async () => {
  flagsOn();
  const f = await h.publishedEvent({ event: { kitProvided: true }, categories: [
    { name: '10K Fun Run', distanceMeters: 10000, tickets: [{ name: 'Corporate', priceTzs: 20000, capacity: 3 }, { name: 'VIP', priceTzs: 50000, capacity: 3 }] },
    { name: 'Half Marathon', distanceMeters: 21097, minAge: 18, tickets: [{ name: 'Standard', priceTzs: 30000, capacity: 10 }] },
  ] });
  const org = await h.organization();
  const hr = await org.member('hr');
  const taken = phone();
  // someone already holds a 10K place with that number (a member order)
  const member = h.claimsOf(await h.user({ phone: phone() }));
  const existing = await call(createEventOrder, member, { headers: { 'Idempotency-Key': key() }, body: { eventId: f.event.id, lines: [{ ticketTypeId: f.ticket.id, quantity: 1 }], participants: [participant(f.ticket.id, { phone: taken, dateOfBirth: '1990-01-01' })], acceptedTerms: true, consentTextVersion: CONSENT, expectedTotalTzs: 20000 } });
  assert.equal(existing.status, 201, JSON.stringify(existing.body));
  const dup = phone();
  const rawText = [
    'Surname,Given name,Mobile,E-mail,Distance,DOB,T-shirt,Department',
    `Mollel,Asha,${phone()},,10K,05/03/1990,M,Finance`,            // ok (cheapest 10K ticket)
    `Juma,Baraka,${dup},,21km,01/01/2000,L,Ops`,                      // ok
    `Juma,Baraka,${dup},,21km,01/01/2000,L,Ops`,                      // listed twice
    `Said,Zuwena,${taken},,10K,02/02/1992,,`,                         // already registered in 10K
    `Kimaro,,${phone()},,10K,03/03/1993,,`,                           // missing last name
    `Nyerere,Julius,${phone()},,42K,,,`,                              // unknown category
    `Mushi,Grace,${phone()},,21km,15/08/2015,,`,                      // under 18 for the half
    `Ally,Hamisi,12,,10K,04/04/1994,,`,                               // bad phone
    `Lema,Joyce,${phone()},,10K,05/05/1995,XXL,`,                     // ok (kit size accepted lower-cased)
    `Massawe,Tumaini,${phone()},,10K,06/06/1996,,`,                   // ok but 10K Corporate has 3 places and 1 is held → 2 remain for 3 ok 10K rows (DOB is required on every row once a category has minAge)
  ].join('\n');
  const v = await call(validateB2BEventRoster, hr, { params: { id: org.id }, body: { eventId: f.event.id, rawText } });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  const byIndex = i => v.body.rows[i];
  assert.deepEqual([byIndex(0).ok, byIndex(0).participant.dateOfBirth, byIndex(0).participant.groupLabel, byIndex(0).ticketTypeId], [true, '1990-03-05', 'Finance', f.ticket.id]);
  assert.equal(byIndex(1).ok, true, JSON.stringify(byIndex(1).problems));
  assert.equal(byIndex(1).categoryId, f.categories[1].id);
  assert.deepEqual(byIndex(2).problems.map(p => p.code), ['duplicate_participant']);
  assert.deepEqual(byIndex(3).problems.map(p => p.code), ['duplicate_participant']);
  assert.deepEqual(byIndex(4).problems.map(p => p.code), ['required']);
  assert.deepEqual(byIndex(5).problems.map(p => p.code), ['category_unknown']);
  assert.deepEqual(byIndex(6).problems.map(p => p.code), ['age_not_eligible']);
  assert.deepEqual(byIndex(7).problems.map(p => p.code), ['phone_invalid']);
  assert.deepEqual([byIndex(8).ok, byIndex(8).participant.kitSize], [true, 'xxl']);
  assert.equal(byIndex(9).ok, true);
  assert.deepEqual(v.body.duplicates.map(d => [d.index, d.kind, d.otherIndex ?? null, d.registrationStatus ?? null]), [[2, 'in_list', 1, null], [3, 'already_registered', null, null]]);
  assert.deepEqual(v.body.summary, { total: 10, ok: 4, problems: 6, duplicates: 2 });
  // quote for the ok rows only: 3 × 10K Corporate (20000) + 1 × Half (30000)
  assert.deepEqual(v.body.lines.sort((a, b) => a.ticketTypeId.localeCompare(b.ticketTypeId)), [{ ticketTypeId: f.ticket.id, quantity: 3 }, { ticketTypeId: f.categories[1].tickets[0].id, quantity: 1 }].sort((a, b) => a.ticketTypeId.localeCompare(b.ticketTypeId)));
  assert.equal(v.body.quote.totalTzs, 90000);
  assert.equal(v.body.quote.discountTzs, 0);
  assert.deepEqual(v.body.capacityShort, [{ ticketTypeId: f.ticket.id, requested: 3, remaining: 2 }]);
  assert.equal(v.body.consentText.organisation.en.startsWith('We confirm'), true);
  assert.equal(v.body.fields.dateOfBirth, 'required');
  // nothing written by validation
  assert.deepEqual(await h.counters(f.ticket.id), { sold: 0, held: 1, capacity: 3 });

  // placing with a bad row → 422 and nothing written
  const rows = v.body.rows.map(r => r.participant ? { firstName: r.participant.firstName, lastName: r.participant.lastName, phone: r.participant.phone, email: r.participant.email, category: r.categoryId ? (r.categoryId === f.categories[0].id ? '10K Fun Run' : 'Half Marathon') : '42K', dateOfBirth: r.participant.dateOfBirth, kitSize: r.participant.kitSize, group: r.participant.groupLabel } : {});
  const bill = await org.member('finance');
  const bad = await place(org.id, bill, { eventId: f.event.id, rows: [rows[0], rows[4]], expectedTotalTzs: 40000 });
  assert.equal(bad.status, 422, JSON.stringify(bad.body));
  assert.deepEqual(bad.body.participants.map(p => [p.index, p.problems.map(x => x.code)]), [[0, []], [1, ['required']]]);
  assert.equal((await db('EventOrder').where({ eventId: f.event.id, organizationId: org.id })).length, 0);
  // capacity short → 409 capacity_unavailable, all or nothing
  const short = await place(org.id, bill, { eventId: f.event.id, rows: [rows[0], rows[8], rows[9], rows[1]], expectedTotalTzs: 90000 });
  assert.deepEqual([short.status, short.body.error], [409, 'capacity_unavailable']);
  assert.deepEqual(await h.counters(f.ticket.id), { sold: 0, held: 1, capacity: 3 });
  assert.deepEqual(await h.counters(f.categories[1].tickets[0].id), { sold: 0, held: 0, capacity: 10 });
  // a clean order: wrong expected total → price_changed; right one → 201 with organisation consent on every place and the group label kept (D19)
  const drift = await place(org.id, bill, { eventId: f.event.id, rows: [rows[0], rows[1]], expectedTotalTzs: 1 });
  assert.deepEqual([drift.status, drift.body.error], [409, 'price_changed']);
  const ok = await place(org.id, bill, { eventId: f.event.id, rows: [rows[0], rows[1]], expectedTotalTzs: 50000, costCentre: 'CC-42', purchaserReference: 'PO-9' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.organizationId, org.id);
  assert.deepEqual([ok.body.order.costCentre, ok.body.order.purchaserReference, ok.body.order.totalTzs], ['CC-42', 'PO-9', 50000]);
  assert.ok(ok.body.registrations.every(r => r.consentBasis === 'organisation' && r.claimState === 'unclaimed'));
  const stored = await db('EventRegistration').where({ orderId: ok.body.order.id }).orderBy('firstName');
  assert.deepEqual(stored.map(r => [r.groupLabel, r.purchaserUserId, r.participantUserId]), [['Finance', null, null], ['Ops', null, null]]);
  const order = await db('EventOrder').where({ id: ok.body.order.id }).first();
  assert.deepEqual([order.purchaserUserId, order.organizationId, order.createdByUserId], [null, org.id, bill.sub]);
  // the coordinator gets the in-app notice
  assert.equal((await h.notifications(bill.sub, 'event_order_created')).length, 1);
});

test('a clean roster of 50 rows passes with bulk although maxPerOrder is 10; EVENTS_ORG_DISCOUNTS applies a labelled discount from server config only', async () => {
  flagsOn();
  const f = await h.publishedEvent({ categories: [{ name: '10K', distanceMeters: 10000, tickets: [{ name: 'Corporate', priceTzs: 10000, capacity: 100, maxPerOrder: 10 }] }] });
  const org = await h.organization();
  process.env.EVENTS_ORG_DISCOUNTS = JSON.stringify({ [org.id]: { pct: 10 } });
  const admin = await org.member('admin');
  const rows = Array.from({ length: 50 }, (_, i) => csvRow(i));
  const v = await call(validateB2BEventRoster, admin, { params: { id: org.id }, body: { eventId: f.event.id, rows } });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.deepEqual(v.body.summary, { total: 50, ok: 50, problems: 0, duplicates: 0 });
  assert.deepEqual([v.body.quote.subtotalTzs, v.body.quote.discountTzs, v.body.quote.totalTzs, v.body.quote.discountLabel.en], [500000, 50000, 450000, 'Approved organisation discount']);
  assert.ok(!v.body.problems.some(p => p.code === 'quantity_out_of_range'), JSON.stringify(v.body.problems));
  // a client cannot push its own discount through
  const r = await place(org.id, admin, { eventId: f.event.id, rows, expectedTotalTzs: 450000, discounts: { [f.ticket.id]: 400000 }, lines: [{ ticketTypeId: f.ticket.id, quantity: 50, discountTzs: 400000 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.order.subtotalTzs, r.body.order.discountTzs, r.body.order.totalTzs, r.body.registrations.length], [500000, 50000, 450000, 50]);
  assert.deepEqual(await h.counters(f.ticket.id), { sold: 0, held: 50, capacity: 100 });
  // a member order for that ticket type still obeys maxPerOrder
  const member = h.claimsOf(await h.user({ phone: phone() }));
  const tooMany = await call(createEventOrder, member, { headers: { 'Idempotency-Key': key() }, body: { eventId: f.event.id, lines: [{ ticketTypeId: f.ticket.id, quantity: 11 }], participants: Array.from({ length: 11 }, () => participant(f.ticket.id)), acceptedTerms: true, consentTextVersion: CONSENT, expectedTotalTzs: 1 } });
  assert.ok(['too_many_participants', 'quantity_out_of_range'].includes(tooMany.body.error), JSON.stringify(tooMany.body));
  // 413 above the row cap
  process.env.EVENTS_CORPORATE_MAX_ROWS = '20';
  const big = await call(validateB2BEventRoster, admin, { params: { id: org.id }, body: { eventId: f.event.id, rows: Array.from({ length: 21 }, (_, i) => csvRow(i)) } });
  assert.deepEqual([big.status, big.body.error, big.body.max], [413, 'too_many_rows', 20]);
  delete process.env.EVENTS_CORPORATE_MAX_ROWS;
});

test('idempotency scoped (organizationId, key): replay returns the same order, reuse 409, the same key in another organisation is a new order; non-members are refused before any scope check; D18 roles', async () => {
  flagsOn();
  const f = await h.publishedEvent({ categories: [{ name: '10K', distanceMeters: 10000, tickets: [{ name: 'S', priceTzs: 1000, capacity: 50 }] }] });
  const orgA = await h.organization({ name: 'Alpha' });
  const orgB = await h.organization({ name: 'Beta' });
  const ownerA = await orgA.member('owner');
  const ownerB = await orgB.member('owner');
  const k = key();
  const body = { eventId: f.event.id, rows: [csvRow(1), csvRow(2)], expectedTotalTzs: 2000 };
  const a1 = await place(orgA.id, ownerA, body, k);
  assert.equal(a1.status, 201, JSON.stringify(a1.body));
  const a2 = await place(orgA.id, ownerA, body, k);
  assert.deepEqual([a2.status, a2.body.replayed, a2.body.order.id], [200, true, a1.body.order.id]);
  const a3 = await place(orgA.id, ownerA, { ...body, costCentre: 'X' }, k);
  assert.deepEqual([a3.status, a3.body.error], [409, 'idempotency_key_reused']);
  const b1 = await place(orgB.id, ownerB, { ...body, rows: [csvRow(3), csvRow(4)] }, k);
  assert.equal(b1.status, 201, JSON.stringify(b1.body));
  assert.notEqual(b1.body.order.id, a1.body.order.id);
  assert.deepEqual(await h.counters(f.ticket.id), { sold: 0, held: 4, capacity: 50 });
  // a user of Beta (or nobody's) cannot touch Alpha: 404 organization_not_found before the key is looked at
  const outsider = h.claimsOf(await h.user());
  for (const claims of [ownerB, outsider]) {
    assert.deepEqual((await place(orgA.id, claims, body, k)).body, { error: 'organization_not_found' });
    assert.deepEqual((await call(validateB2BEventRoster, claims, { params: { id: orgA.id }, body })).body, { error: 'organization_not_found' });
    assert.deepEqual((await call(listB2BEventOrders, claims, { params: { id: orgA.id } })).body, { error: 'organization_not_found' });
  }
  // D18: hr validates and reads but may not place or cancel; finance places; viewer sees nothing; a suspended organisation is refused
  const hr = await orgA.member('hr');
  assert.equal((await call(validateB2BEventRoster, hr, { params: { id: orgA.id }, body })).status, 200);
  assert.deepEqual((await place(orgA.id, hr, body)).body, { error: 'forbidden', requiredRole: ['owner', 'admin', 'finance'] });
  assert.equal((await call(listB2BEventOrders, hr, { params: { id: orgA.id } })).status, 200);
  assert.deepEqual((await call(cancelB2BEventOrder, hr, { params: { id: orgA.id, orderId: a1.body.order.id }, body: { reason: 'other' } })).body.error, 'forbidden');
  const viewer = await orgA.member('viewer');
  assert.equal((await call(validateB2BEventRoster, viewer, { params: { id: orgA.id }, body })).body.error, 'forbidden');
  assert.equal((await call(listB2BEventOrders, viewer, { params: { id: orgA.id } })).body.error, 'forbidden');
  const finance = await orgA.member('finance');
  const byFinance = await place(orgA.id, finance, { ...body, rows: [csvRow(5)] , expectedTotalTzs: 1000 });
  assert.equal(byFinance.status, 201, JSON.stringify(byFinance.body));
  // reads and cancel
  const list = await call(listB2BEventOrders, ownerA, { params: { id: orgA.id } });
  assert.equal(list.body.items.length, 2);
  assert.deepEqual([list.body.items[0].createdBy.id, list.body.items[0].allowedActions], [finance.sub, ['cancel']]);
  const detail = await call(getB2BEventOrder, ownerA, { params: { id: orgA.id, orderId: a1.body.order.id } });
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.registrations.length, 2);
  assert.equal(detail.body.registrations[0].phone.startsWith('+255'), true); // the organisation typed it
  assert.deepEqual((await call(getB2BEventOrder, ownerB, { params: { id: orgB.id, orderId: a1.body.order.id } })).body, { error: 'order_not_found' });
  const cancelled = await call(cancelB2BEventOrder, ownerA, { params: { id: orgA.id, orderId: a1.body.order.id }, body: { reason: 'wrong_details' } });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.order.status, 'cancelled');
  assert.deepEqual(await h.counters(f.ticket.id), { sold: 0, held: 3, capacity: 50 });
  assert.ok((await db('EventRegistration').where({ orderId: a1.body.order.id })).every(r => r.cancelReason === 'wrong_details'));
  await orgA.setStatus('suspended');
  assert.equal((await call(validateB2BEventRoster, ownerA, { params: { id: orgA.id }, body })).body.error, 'organization_not_active');
});

test('a corporate place is claimable by the employee exactly like a member order (consent basis organisation); a corporate team enrols every row', async () => {
  flagsOn();
  const f = await h.publishedEvent({ categories: [{ name: '10K', distanceMeters: 10000, tickets: [{ name: 'S', priceTzs: 1000, capacity: 50 }] }] });
  const org = await h.organization({ name: 'Gamma' });
  const admin = await org.member('admin');
  const employeePhone = phone();
  const r = await place(org.id, admin, { eventId: f.event.id, rows: [csvRow(1, { phone: employeePhone }), csvRow(2)], expectedTotalTzs: 2000, team: { create: { name: 'Gamma Runners' } } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.team.name, r.body.team.teamType, r.body.team.memberCount, r.body.team.organizationId], ['Gamma Runners', 'corporate', 2, org.id]);
  const employee = h.claimsOf(await h.user({ phone: employeePhone }));
  const claimable = await call(claimableEventRegistrations, employee);
  assert.equal(claimable.body.items.length, 1);
  assert.equal(claimable.body.items[0].purchaser.nameMasked, 'Gamma');
  // the "Is this you?" notice went to the verified employee only if the account existed at creation; it did not → none; S4 sends the invitation
  assert.equal((await h.notifications(employee.sub, 'event_claim_available')).length, 0);
});


test('review fixes: duplicates identify only the organisation\'s own orders; expected total required; 413 on huge input; per-organisation validate limit; formula text refused; emergency contact is not a blocker', async () => {
  flagsOn();
  const f = await h.publishedEvent({ event: { participantFields: { emergencyContact: 'required' } }, categories: [{ name: '10K', distanceMeters: 10000, tickets: [{ name: 'S', priceTzs: 1000, capacity: 50 }] }] });
  const org = await h.organization({ name: 'Delta' });
  const admin = await org.member('admin');
  const p1 = phone();
  // L1: a required emergency contact cannot come from a roster, so it is a warning and the order can be placed
  const first = await place(org.id, admin, { eventId: f.event.id, rows: [csvRow(1, { phone: p1 })], expectedTotalTzs: 1000 });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  // the organisation's own earlier order is identified; someone else's is not
  const again = await call(validateB2BEventRoster, admin, { params: { id: org.id }, body: { eventId: f.event.id, rows: [csvRow(2, { phone: p1 })] } });
  assert.equal(again.body.rows[0].problems[0].registrationId !== undefined, true);
  assert.equal(again.body.duplicates[0].registrationStatus, 'reserved');
  const other = await h.organization({ name: 'Epsilon' });
  const otherAdmin = await other.member('admin');
  const theirs = await call(validateB2BEventRoster, otherAdmin, { params: { id: other.id }, body: { eventId: f.event.id, rows: [csvRow(3, { phone: p1 })] } });
  assert.deepEqual(theirs.body.rows[0].problems, [{ field: 'phone', code: 'duplicate_participant' }]);
  assert.deepEqual(theirs.body.duplicates, [{ index: 0, kind: 'already_registered' }]);
  // M2
  const noTotal = await place(org.id, admin, { eventId: f.event.id, rows: [csvRow(4)] });
  assert.deepEqual([noTotal.status, noTotal.body.error], [400, 'expected_total_required']);
  // L2
  const formula = await place(org.id, admin, { eventId: f.event.id, rows: [csvRow(5)], expectedTotalTzs: 1000, costCentre: '=cmd' });
  assert.deepEqual([formula.status, formula.body.error], [400, 'invalid_text']);
  const group = await call(validateB2BEventRoster, admin, { params: { id: org.id }, body: { eventId: f.event.id, rows: [csvRow(6, { group: '@SUM(1)' })] } });
  assert.deepEqual(group.body.rows[0].problems, [{ field: 'groupLabel', code: 'invalid_text' }]);
  // M4: a 50,000-character email and a huge rawText never reach the parser
  const started = Date.now();
  const huge = await call(validateB2BEventRoster, admin, { params: { id: org.id }, body: { eventId: f.event.id, rows: [csvRow(7, { email: `${'a'.repeat(50_000)}@x.co` })] } });
  assert.deepEqual([huge.status, huge.body.error, huge.body.field], [400, 'field_too_long', 'email']);
  // the index is the original roster row, even when earlier rows are unusable (unknown category)
  const idx = await call(validateB2BEventRoster, admin, { params: { id: org.id }, body: { eventId: f.event.id, rows: [csvRow(11, { category: '42K' }), csvRow(12), csvRow(13, { email: `${'a'.repeat(300)}@x.co` })] } });
  assert.deepEqual([idx.status, idx.body.error, idx.body.index], [400, 'field_too_long', 2]);
  assert.ok(Date.now() - started < 1500);
  const big = await call(validateB2BEventRoster, admin, { params: { id: org.id }, body: { eventId: f.event.id, rawText: 'a'.repeat(1_000_001) } });
  assert.deepEqual([big.status, big.body.error], [413, 'raw_text_too_long']);
  const cell = await call(validateB2BEventRoster, admin, { params: { id: org.id }, body: { eventId: f.event.id, rows: [csvRow(8, { category: '1'.repeat(50_000) })] } });
  assert.deepEqual(cell.body.rows[0].problems.map(x => x.code), ['category_unknown']);
  // M1: validate is limited per organisation
  resetEventsCorporateLimits();
  let limited = null;
  for (let i = 0; i < 22 && !limited; i += 1) {
    const r = await call(validateB2BEventRoster, admin, { params: { id: org.id }, body: { eventId: f.event.id, rows: [csvRow(9)] } });
    if (r.status === 429) limited = r;
  }
  assert.equal(limited?.body.error, 'rate_limited');
  // another organisation is not affected
  assert.equal((await call(validateB2BEventRoster, otherAdmin, { params: { id: other.id }, body: { eventId: f.event.id, rows: [csvRow(10)] } })).status, 200);
});


test('contract check: validate output goes back to place verbatim (ids, or names, ids win); categories and tickets must belong to the event', async () => {
  flagsOn();
  const f = await h.publishedEvent({ categories: [
    { name: '10K Fun Run', distanceMeters: 10000, tickets: [{ name: 'Corporate', priceTzs: 20000, capacity: 30 }, { name: 'VIP', priceTzs: 50000, capacity: 30 }] },
    { name: 'Half Marathon', distanceMeters: 21097, tickets: [{ name: 'Standard', priceTzs: 30000, capacity: 30 }] },
  ] });
  const g = await h.publishedEvent();
  const org = await h.organization({ name: 'Zeta' });
  const admin = await org.member('admin');
  const rows = [csvRow(1), csvRow(2, { category: 'Half Marathon' }), csvRow(3, { ticketType: 'VIP' })];
  const v = await call(validateB2BEventRoster, admin, { params: { id: org.id }, body: { eventId: f.event.id, rows } });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.summary.ok, 3);
  for (const r of v.body.rows) { assert.ok(r.participant.categoryId && r.participant.ticketTypeId); assert.equal(r.participant.categoryId, r.categoryId); assert.equal(r.participant.ticketTypeId, r.ticketTypeId); }
  // 1) the validate rows verbatim
  const placed = await place(org.id, admin, { eventId: f.event.id, rows: v.body.rows, expectedTotalTzs: v.body.quote.totalTzs });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  assert.equal(placed.body.registrations.length, 3);
  assert.deepEqual(placed.body.registrations.map(x => x.ticketTypeName).sort(), ['Corporate', 'Standard', 'VIP']);
  assert.ok(placed.body.registrations.every(x => x.categoryName));
  // 2) the portal shape: participant fields flat plus the ids
  const flat = v.body.rows.map(r => ({ ...r.participant, categoryId: r.categoryId, ticketTypeId: r.ticketTypeId }));
  const again = await call(validateB2BEventRoster, admin, { params: { id: org.id }, body: { eventId: f.event.id, rows: flat.map(r => ({ ...r, phone: phone() })) } });
  assert.equal(again.body.summary.ok, 3, JSON.stringify(again.body.rows.map(r => r.problems)));
  // ids win over names
  const win = await call(validateB2BEventRoster, admin, { params: { id: org.id }, body: { eventId: f.event.id, rows: [csvRow(4, { category: 'Half Marathon', categoryId: v.body.rows[0].categoryId, ticketTypeId: v.body.rows[0].ticketTypeId })] } });
  assert.deepEqual([win.body.rows[0].ok, win.body.rows[0].categoryId, win.body.rows[0].ticketTypeId], [true, v.body.rows[0].categoryId, v.body.rows[0].ticketTypeId]);
  // ids from another event, or a ticket that is not in the named category
  const foreign = await call(validateB2BEventRoster, admin, { params: { id: org.id }, body: { eventId: f.event.id, rows: [csvRow(5, { categoryId: g.categories[0].id }), csvRow(6, { ticketTypeId: g.ticket.id }), csvRow(7, { categoryId: v.body.rows[1].categoryId, ticketTypeId: v.body.rows[0].ticketTypeId })] } });
  assert.deepEqual(foreign.body.rows.map(r => r.problems.map(p => p.code)), [['category_unknown'], ['ticket_type_unknown'], ['ticket_type_unknown']]);
  // a capacity refusal at place time says how many
  const small = await h.publishedEvent({ categories: [{ name: '10K', distanceMeters: 10000, tickets: [{ name: 'S', priceTzs: 1000, capacity: 2 }] }] });
  const short = await place(org.id, admin, { eventId: small.event.id, rows: [csvRow(8), csvRow(9), csvRow(10)], expectedTotalTzs: 3000 });
  assert.deepEqual([short.status, short.body.error, short.body.requested, short.body.remaining], [409, 'capacity_unavailable', 3, 2]);
});
