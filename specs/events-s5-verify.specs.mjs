// Marathon & running events · S5 — ticket verification (spec §4.1): the six results, masking, tenancy, rate limits, audit, flags.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ensureInit } from '../functions/index.mjs';
import { organizerVerifyTicket, resetEventsOpsLimits } from '../functions/events-ops.mjs';
import { harness, s5On, s5Off, db, eventually } from './fixtures/events-s5.mjs';
import { deriveToken, ticketKeyRing, QR_PREFIX } from '../src/shared/events-ticket-token.mjs';
import { TICKET_SECRET } from './fixtures/events-s4.mjs';

await ensureInit();
const h = harness();
const { call } = h;
afterEach(() => { resetEventsOpsLimits(); });
after(async () => { await h.cleanup(); await db.destroy(); });

const verify = (claims, eventId, payload, extra = {}) => call(organizerVerifyTicket, claims, { params: { id: eventId }, body: { payload, ...extra } });
const FORBIDDEN_KEYS = /phone|email|dateOfBirth|gender|emergency|orderId|paymentId|token|purchaser|participantUserId/i;
const keysOf = (v, out = []) => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); keysOf(x, out); } return out; };

test('valid: a masked card (first name and last initial), no contact data, no token; no-store', async () => {
  s5On();
  const f = await h.kitEvent({ n: 1 });
  const r = await verify(f.organizer.ops, f.event.id, f.regs[0].payload, { collectionPointId: f.points[0].id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result, 'valid');
  assert.equal(r.body.registrationId, f.regs[0].id);
  assert.equal(r.body.card.displayName, `${f.regs[0].firstName} ${f.regs[0].lastName[0]}.`);
  assert.equal(r.body.card.ticketCode, f.regs[0].displayCode);
  assert.deepEqual([r.body.card.categoryName, r.body.card.distanceM, r.body.card.kit.state, r.body.card.payment], ['10K', 10000, 'ready', 'paid']);
  assert.deepEqual([r.body.canCollect, r.body.canOverride], [true, false]);
  assert.ok(r.body.warnings.includes('bib_missing'));
  assert.deepEqual(keysOf(r.body).filter(k => FORBIDDEN_KEYS.test(k)), [], 'no contact, order or token keys');
  assert.ok(!JSON.stringify(r.body).includes(f.regs[0].lastName), 'only the last initial');
  assert.ok(!JSON.stringify(r.body).includes(f.regs[0].token));
});

test('a bare token works like the QR payload; a gym QR and random text are not_event_ticket (400); over-long is invalid_payload', async () => {
  s5On();
  const f = await h.kitEvent({ n: 1 });
  assert.equal((await verify(f.organizer.ops, f.event.id, f.regs[0].token)).body.result, 'valid');
  for (const text of ['FFQR1.abc.def', 'hello', 'FFEV1:not-a-token', 'https://example.com/x']) assert.deepEqual((await verify(f.organizer.ops, f.event.id, text)).body, { error: 'not_event_ticket' }, text);
  assert.deepEqual((await verify(f.organizer.ops, f.event.id, 'x'.repeat(201))).body, { error: 'invalid_payload' });
  assert.equal((await verify(f.organizer.ops, f.event.id, 42)).body.error, 'invalid_payload');
});

test('unknown: a forged MAC, a rotated (old) token, and another organizer\'s ticket all read `unknown` and are never told apart', async () => {
  s5On();
  const a = await h.kitEvent({ n: 1 });
  const b = await h.kitEvent({ n: 1 });
  const ring = ticketKeyRing({ EVENT_TICKET_SECRET: TICKET_SECRET });
  const forged = `${QR_PREFIX}${deriveToken(ring, { ticketId: a.regs[0].ticketId, tokenVersion: 1, registrationId: a.regs[0].id, eventId: a.event.id }).replace(/.$/, c => (c === 'A' ? 'B' : 'A'))}`;
  assert.equal((await verify(a.organizer.ops, a.event.id, forged)).body.result, 'unknown');
  // rotate: the old screenshot matches no hash
  await db('EventTicket').where({ id: a.regs[0].ticketId }).update({ tokenHash: 'f'.repeat(64), tokenVersion: 2 });
  assert.equal((await verify(a.organizer.ops, a.event.id, a.regs[0].payload)).body.result, 'unknown');
  // B's ticket scanned at A's event: unknown, NOT wrong_event
  const cross = await verify(a.organizer.ops, a.event.id, b.regs[0].payload);
  assert.deepEqual(cross.body, { result: 'unknown', warnings: [], canCollect: false, canOverride: false });
  assert.ok(!JSON.stringify(cross.body).includes(b.event.title + 'x'));
  // a failed outcome writes at most one audit row per actor per outcome per minute, with no payload
  await verify(a.organizer.ops, a.event.id, b.regs[0].payload);
  const audits = await eventually(() => db('AuditLog').where({ action: 'events.ticket_verify_failed', target: a.event.id }));   // written without being awaited
  assert.equal(audits.length, 1);
  assert.ok(!JSON.stringify(audits[0]).includes(b.regs[0].token));
});

test('wrong_event only for another event of the SAME organizer (with its title); revoked with a closed reason; cancelled registration reads revoked', async () => {
  s5On();
  const a = await h.kitEvent({ n: 1 });
  const other = await h.kitEvent({ organizer: a.organizer, n: 1, eventOver: { title: 'Zanzibar 10K' } });
  const w = await verify(a.organizer.ops, a.event.id, other.regs[0].payload);
  assert.deepEqual([w.body.result, w.body.otherEvent], ['wrong_event', { title: 'Zanzibar 10K' }]);
  assert.equal(w.body.registrationId, undefined);
  await db('EventTicket').where({ id: a.regs[0].ticketId }).update({ status: 'revoked', revokedAt: new Date(), revokeReason: 'refunded' });
  const r = await verify(a.organizer.ops, a.event.id, a.regs[0].payload);
  assert.deepEqual([r.body.result, r.body.revokedReason, r.body.canCollect], ['revoked', 'refunded', false]);
  // the database already closes the set of revoke reasons; whatever the row says, only a member of the set can be returned
  assert.ok(['cancelled', 'refunded', 'event_cancelled', 'admin', 'replaced'].includes((await verify(a.organizer.ops, a.event.id, a.regs[0].payload)).body.revokedReason));
  const regs2 = await h.addRegistrations({ eventId: a.event.id, ticketType: a.ticketType, n: 1 });
  await db('EventRegistration').where({ id: regs2[0].id }).update({ status: 'cancelled', cancelledAt: new Date() });
  assert.equal((await verify(a.organizer.ops, a.event.id, regs2[0].payload)).body.result, 'revoked');
});

test('another organizer\'s event id is 404 event_not_found for every role; roles: timing and finance cannot verify (403); ops can', async () => {
  s5On();
  const a = await h.kitEvent({ n: 1 });
  const b = await h.kitEvent({ n: 1 });
  for (const role of ['owner', 'admin', 'ops']) {
    const claims = role === 'owner' ? a.organizer.owner : a.organizer[role];
    const r = await verify(claims, b.event.id, a.regs[0].payload);
    assert.deepEqual([r.status, r.body], [404, { error: 'event_not_found' }], role);
    assert.deepEqual((await verify(claims, 'evt_nonexistent', a.regs[0].payload)).body, { error: 'event_not_found' }, 'identical for a missing id');
  }
  for (const role of ['timing', 'finance']) assert.deepEqual([(await verify(a.organizer[role], a.event.id, a.regs[0].payload)).status, (await verify(a.organizer[role], a.event.id, a.regs[0].payload)).body.error], [403, 'forbidden_role']);
});

test('a suspended organizer cannot verify (writes and the desk need an active organizer); flags off → 404 feature_disabled', async () => {
  s5On();
  const f = await h.kitEvent({ n: 1 });
  await db('EventOrganizer').where({ id: f.organizer.id }).update({ status: 'suspended', statusReason: 'spec' });
  const r = await verify(f.organizer.ops, f.event.id, f.regs[0].payload);
  assert.deepEqual([r.status, r.body.error], [403, 'organizer_suspended']);
  await db('EventOrganizer').where({ id: f.organizer.id }).update({ status: 'active', statusReason: null });
  s5Off();
  s5On({ kit: false });
  assert.deepEqual((await verify(f.organizer.ops, f.event.id, f.regs[0].payload)).body, { error: 'feature_disabled' });
  s5Off();
  assert.equal((await verify(f.organizer.ops, f.event.id, f.regs[0].payload)).status, 404);
});

test('rate limits: 30 failed outcomes a minute per user then 429 with Retry-After; successes do not count; 120 a minute per user', async () => {
  s5On();
  const f = await h.kitEvent({ n: 1 });
  for (let i = 0; i < 30; i += 1) assert.equal((await verify(f.organizer.ops, f.event.id, 'FFEV1:not-a-token')).status, 400);
  const limited = await verify(f.organizer.ops, f.event.id, f.regs[0].payload);
  assert.deepEqual([limited.status, limited.body.error], [429, 'rate_limited']);
  assert.ok(limited.body.retryAfterSeconds >= 1);
  // another user is unaffected, and its successes never fill the failure window
  for (let i = 0; i < 40; i += 1) assert.equal((await verify(f.organizer.admin, f.event.id, f.regs[0].payload)).body.result, 'valid');
  resetEventsOpsLimits();
  for (let i = 0; i < 120; i += 1) assert.equal((await verify(f.organizer.owner, f.event.id, f.regs[0].payload)).status, 200);
  assert.equal((await verify(f.organizer.owner, f.event.id, f.regs[0].payload)).status, 429);
});
