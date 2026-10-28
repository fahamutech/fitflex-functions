// Marathon & running events · S4 — tickets (spec §3.8): one active ticket per confirmed place, the token DERIVED from
// EVENT_TICKET_SECRET and never stored, hash at rest, static code, rotation, revocation, who may see which ticket
// (including the purchaser losing access at the moment someone else claims), no-store, integrity.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ensureInit } from '../functions/index.mjs';
import { createEventOrder, quoteEventOrder, claimEventRegistration, getMyEventRegistration, getMyEventOrder, resetEventsRegistrationLimits } from '../functions/events-registration.mjs';
import { payForEventOrder, listMyEventTickets, getEventTicket, rotateEventTicket, resetEventsPaymentLimits } from '../functions/events-payments.mjs';
import { adminDecidePaymentRequest } from '../functions/admin-payments.mjs';
import { harness, s4On, s4Off, saveManualDetails, clearManualDetails, txId, uid, phone, TICKET_SECRET } from './fixtures/events-s4.mjs';
import { deriveToken, verifyToken, parseToken, ticketKeyRing, sha256hex, QR_PREFIX } from '../src/shared/events-ticket-token.mjs';

await ensureInit();
const h = harness();
const { db, call } = h;
afterEach(() => { s4Off(); resetEventsRegistrationLimits(); resetEventsPaymentLimits(); });
after(async () => { await clearManualDetails(); await h.cleanup(); await db.destroy(); });

const key = () => `tk_${uid('').slice(1)}`;
const member = async () => { const p = phone(); const sub = await h.user({ phone: p }); return { claims: h.claimsOf(sub), sub, phone: p }; };

/** A paid, confirmed order of two places: place 0 is the buyer's own, place 1 is for a friend with a phone. */
async function paidOrder() {
  s4On(); await saveManualDetails();
  const f = await h.sellingEvent({ categories: [{ name: '10K', distanceMeters: 10000, tickets: [{ name: 'Early', priceTzs: 20000, capacity: 10 }] }] });
  const b = await member();
  const friendPhone = phone();
  const body = {
    eventId: f.event.id, lines: [{ ticketTypeId: f.ticket.id, quantity: 2 }], acceptedTerms: true, consentTextVersion: '2026-10-draft',
    participants: [
      { ticketTypeId: f.ticket.id, firstName: 'Neema', lastName: 'Abdallah', phone: b.phone, consentBasis: 'self' },
      { ticketTypeId: f.ticket.id, firstName: 'Zawadi', lastName: 'Mollel', phone: friendPhone, consentBasis: 'purchaser_authorised' },
    ],
  };
  const q = await call(quoteEventOrder, b.claims, { body });
  const o = await call(createEventOrder, b.claims, { headers: { 'Idempotency-Key': key() }, body: { ...body, expectedTotalTzs: q.body.quote.totalTzs } });
  assert.equal(o.status, 201, JSON.stringify(o.body));
  const p = await call(payForEventOrder, b.claims, { params: { id: o.body.order.id }, headers: { 'Idempotency-Key': key() }, body: { reference: txId(), payerPhone: b.phone } });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const admin = h.claimsOf(await h.user({ userType: 'admin' }), 'admin');
  const request = await db('PaymentRequest').where({ eventOrderId: o.body.order.id }).first();
  const done = await call(adminDecidePaymentRequest, admin, { params: { id: request.id }, body: { decision: 'approve', amountTzs: 40000 } });
  assert.equal(done.body.event.outcome, 'confirmed', JSON.stringify(done.body));
  const regs = await db('EventRegistration').where({ orderId: o.body.order.id }).orderBy('consentBasis', 'desc');
  const own = regs.find(r => r.consentBasis === 'self'); const friend = regs.find(r => r.consentBasis !== 'self');
  return { f, b, orderId: o.body.order.id, own, friend, friendPhone, admin };
}

test('the token is derived, never stored: the row holds a 64-hex hash only; the route returns the token and its QR payload; the hash of the returned token is the stored one', async () => {
  const { b, own, orderId } = await paidOrder();
  const row = await db('EventTicket').where({ registrationId: own.id }).first();
  assert.deepEqual([row.status, row.tokenVersion, row.tokenKeyId, row.issuedForUserId], ['active', 1, 'k1', b.sub]);
  assert.match(row.tokenHash, /^[0-9a-f]{64}$/);
  assert.match(row.displayCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const res = await call(getEventTicket, b.claims, { params: { id: own.id } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.token, /^ev1\.k1\.etk_[0-9a-f]{16}\.1\.[A-Za-z0-9_-]{22}$/);
  assert.equal(res.body.qrPayload, `${QR_PREFIX}${res.body.token}`);
  assert.equal(sha256hex(res.body.token), row.tokenHash);
  assert.equal(res.body.scanning, false);
  assert.deepEqual(Object.keys(res.body.ticket).sort(), ['displayCode', 'id', 'issuedAt', 'rotatedAt', 'state']);
  // nothing in the database carries the plaintext token (a dump of every event table)
  for (const table of ['EventTicket', 'EventRegistration', 'EventOrder', 'EventPayment', 'OutboxEvent', 'AuditLog', 'Notification']) {
    const dump = JSON.stringify(await db(table).select('*').limit(5000));
    assert.ok(!dump.includes(res.body.token), `${table} holds the token`);
  }
  // the token carries no personal data: ids and a MAC only
  const parts = parseToken(res.body.token);
  assert.deepEqual([parts.ticketId, parts.tokenVersion, parts.keyId], [row.id, 1, 'k1']);
  assert.ok(!res.body.token.includes(b.sub) && !res.body.token.includes(own.id) && !res.body.token.includes(orderId));
  // static: reading it again gives the same code
  assert.equal((await call(getEventTicket, b.claims, { params: { id: own.id } })).body.token, res.body.token);
});

test('headers and limits: responses carrying a token are no-store; 60 reads an hour; the list carries no token', async () => {
  const { b, own } = await paidOrder();
  const res = { headers: {}, statusCode: 200, status(c) { this.statusCode = c; return this; }, json(x) { this.body = x; return this; }, set(k, v) { this.headers[k] = v; return this; } };
  const req = { method: 'GET', headers: { authorization: `Bearer ${(await import('../src/auth/jwt.mjs')).sign(b.claims)}` }, params: { id: own.id }, query: {}, body: {}, ip: '10.9.9.9', get() { return null; } };
  for (const g of [getEventTicket.onGuard].flat()) await g(req, res, () => {});
  await getEventTicket.onRequest(req, res);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  const list = await call(listMyEventTickets, b.claims, {});
  assert.equal(list.status, 200);
  assert.ok(!JSON.stringify(list.body).includes('ev1.'), 'no token in the list');
  assert.equal(list.body.items.length, 2);   // the friend's place is unclaimed: the purchaser sees it too
  for (let i = 0; i < 59; i += 1) assert.equal((await call(getEventTicket, b.claims, { params: { id: own.id } })).status, 200);   // 1 above + 59 = 60
  const limited = await call(getEventTicket, b.claims, { params: { id: own.id } });
  assert.deepEqual([limited.status, limited.body.error], [429, 'rate_limited']);
});

test('who may see a ticket: the purchaser for an unclaimed place; after a claim by someone else the purchaser loses access and the code changes at that moment', async () => {
  const { b, own, friend, friendPhone } = await paidOrder();
  const friendTicket = await db('EventTicket').where({ registrationId: friend.id }).first();
  // before the claim: the purchaser sees both tickets
  const before = await call(getEventTicket, b.claims, { params: { id: friend.id } });
  assert.equal(before.status, 200, JSON.stringify(before.body));
  assert.equal(before.body.relation, 'purchased');
  assert.deepEqual((await call(listMyEventTickets, b.claims, {})).body.items.map(i => i.relation).sort(), ['purchased', 'self']);
  // a stranger sees nothing
  const stranger = await member();
  assert.deepEqual((await call(getEventTicket, stranger.claims, { params: { id: friend.id } })).body, { error: 'registration_not_found' });
  // the friend (a verified contact) claims
  const friendSub = await h.user({ phone: friendPhone });
  const fc = h.claimsOf(friendSub);
  const claimed = await call(claimEventRegistration, fc, { params: { id: friend.id }, body: {} });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  const rotated = await db('EventTicket').where({ id: friendTicket.id }).first();
  assert.equal(rotated.tokenVersion, 2); assert.notEqual(rotated.tokenHash, friendTicket.tokenHash); assert.ok(rotated.rotatedAt);
  // the purchaser's screenshot of the old code no longer matches any ticket; they cannot read the new one
  assert.deepEqual((await call(getEventTicket, b.claims, { params: { id: friend.id } })).body, { error: 'registration_not_found' });
  assert.deepEqual((await call(listMyEventTickets, b.claims, {})).body.items.map(i => i.relation), ['self']);
  const theirs = await call(getEventTicket, fc, { params: { id: friend.id } });
  assert.equal(theirs.status, 200); assert.equal(theirs.body.relation, 'claimed');
  assert.equal(sha256hex(theirs.body.token), rotated.tokenHash);
  assert.notEqual(sha256hex(before.body.token), rotated.tokenHash, 'the old token matches no hash');
  // the registration detail carries a ticket summary, never a token
  const reg = await call(getMyEventRegistration, fc, { params: { id: friend.id } });
  assert.deepEqual(Object.keys(reg.body.ticket).sort(), ['displayCode', 'state']);
  void own;
});

test('rotation: tokenVersion + 1, the old token stops matching; 5 per day per ticket; a revoked ticket cannot be read or rotated', async () => {
  const { b, own } = await paidOrder();
  const first = (await call(getEventTicket, b.claims, { params: { id: own.id } })).body;
  const r = await call(rotateEventTicket, b.claims, { params: { id: own.id } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.notEqual(r.body.token, first.token);
  assert.equal(parseToken(r.body.token).tokenVersion, 2);
  assert.equal((await db('EventTicket').where({ registrationId: own.id }).first()).tokenHash, sha256hex(r.body.token));
  assert.equal(await db('EventTicket').where({ tokenHash: sha256hex(first.token) }).first(), undefined, 'the old code resolves to nothing');
  assert.equal((await db('AuditLog').where({ action: 'events.ticket_rotated', target: r.body.ticket.id })).length, 1);
  for (let i = 0; i < 4; i += 1) assert.equal((await call(rotateEventTicket, b.claims, { params: { id: own.id } })).status, 200);
  const limited = await call(rotateEventTicket, b.claims, { params: { id: own.id } });
  assert.deepEqual([limited.status, limited.body.error], [429, 'rate_limited']);
  // revoke it (cancelled): reading says why
  await db('EventTicket').where({ registrationId: own.id }).update({ status: 'revoked', revokedAt: new Date(), revokeReason: 'cancelled' });
  resetEventsPaymentLimits();
  const gone = await call(getEventTicket, b.claims, { params: { id: own.id } });
  assert.deepEqual([gone.status, gone.body.error, gone.body.reason], [409, 'ticket_revoked', 'cancelled']);
  assert.equal((await call(rotateEventTicket, b.claims, { params: { id: own.id } })).body.error, 'ticket_revoked');
  const listed = (await call(listMyEventTickets, b.claims, {})).body.items.find(i => i.registrationId === own.id);
  assert.equal(listed.state, 'revoked');
});

test('a reserved (unpaid) place has no ticket; integrity: a ticket whose stored hash does not match its derived token is never returned', async () => {
  const { b, own } = await paidOrder();
  await db('EventTicket').where({ registrationId: own.id }).update({ tokenHash: 'f'.repeat(64) });
  const bad = await call(getEventTicket, b.claims, { params: { id: own.id } });
  assert.deepEqual([bad.status, bad.body.error], [500, 'ticket_integrity_failed']);
  assert.ok(!JSON.stringify(bad.body).includes('ev1.'));
  assert.equal((await db('AuditLog').where({ action: 'events.ticket_integrity_failed' })).length >= 1, true);
  // an unpaid place
  s4On();
  const f = await h.sellingEvent({});
  const u = await member();
  const body = { eventId: f.event.id, lines: [{ ticketTypeId: f.ticket.id, quantity: 1 }], acceptedTerms: true, consentTextVersion: '2026-10-draft', participants: [{ ticketTypeId: f.ticket.id, firstName: 'Neema', lastName: 'Abdallah', phone: u.phone, consentBasis: 'self' }] };
  const q = await call(quoteEventOrder, u.claims, { body });
  const o = await call(createEventOrder, u.claims, { headers: { 'Idempotency-Key': key() }, body: { ...body, expectedTotalTzs: q.body.quote.totalTzs } });
  const none = await call(getEventTicket, u.claims, { params: { id: o.body.registrations[0].id } });
  assert.deepEqual([none.status, none.body.error], [409, 'ticket_not_issued']);
});

test('pure: derive / verify under the key ring; the registration and event are inside the MAC; key rotation keeps old tickets valid; short or missing secrets give no ring', () => {
  const ring = ticketKeyRing({ EVENT_TICKET_SECRET: TICKET_SECRET, EVENT_TICKET_KEY_ID: 'k2', EVENT_TICKET_SECRET_PREVIOUS: JSON.stringify({ k1: 'older-secret-0123456789abcdef0123456789abcdef' }) });
  const ctx = { ticketId: 'etk_0123456789abcdef', tokenVersion: 3, registrationId: 'erg_a', eventId: 'evt_a' };
  const t = deriveToken(ring, ctx);
  assert.ok(verifyToken(ring, t, ctx));
  assert.ok(verifyToken(ring, `${QR_PREFIX}${t}`, ctx));
  assert.equal(verifyToken(ring, t, { ...ctx, registrationId: 'erg_b' }), false, 'a token cannot be replayed against another registration');
  assert.equal(verifyToken(ring, t, { ...ctx, eventId: 'evt_b' }), false);
  assert.equal(verifyToken(ring, t.replace(/.$/, c => (c === 'A' ? 'B' : 'A')), ctx), false);
  assert.notEqual(deriveToken(ring, { ...ctx, tokenVersion: 4 }), t);
  const old = deriveToken(ring, { ...ctx, keyId: 'k1' });
  assert.ok(verifyToken(ring, old, ctx), 'a ticket under the previous key still verifies');
  assert.equal(ticketKeyRing({}), null);
  assert.equal(ticketKeyRing({ EVENT_TICKET_SECRET: 'short' }), null);
  assert.equal(ticketKeyRing({ EVENT_TICKET_SECRET: TICKET_SECRET, EVENT_TICKET_KEY_ID: 'bad id!' }), null);
  assert.equal(parseToken('FFEV1:nonsense'), null);
  assert.equal(parseToken('12345.1234.sig'), null, 'a gym QR is not a ticket');
});
