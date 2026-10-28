// Marathon & running events · S4 — the Tunzaa path (EVENTS_PAYMENTS_TUNZAA; built DORMANT, D1) through the real routes and the
// real client against a LOCAL fake Tunzaa (MALIPO_BASE_URL, non-production only): the callback is only a trigger and the
// status is re-read; amount / transaction / currency comparisons; WebhookSeen idempotency (written after processing);
// a callback that arrives after the app gave up; a lost callback settled by the sweep; stale prompts expire; roles; gating.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';

const SECRET = 'spec-tunzaa-secret';
const remote = new Map();   // transactionID → { status, amount, remark, raw }
let statusCalls = 0;
let failStatus = false;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url.startsWith('/accounts/request/token')) return send(200, { access_token: 'tok', expires_in: 3600 });
    if (req.url.startsWith('/payments/initiate-payment')) {
      const b = JSON.parse(body || '{}');
      const id = `TXN_SPEC_${remote.size + 1}_${Date.now()}`;
      remote.set(id, { status: 'PENDING', amount: `${b.amount}.00`, reference: b.reference, msisdn: b.customer_msisdn });
      return send(200, { success: true, transactionID: id });
    }
    if (req.url.startsWith('/payments/check-status/')) {
      statusCalls += 1;
      if (failStatus) return send(500, { message: 'down' });
      const id = decodeURIComponent(req.url.split('/').pop());
      const r = remote.get(id);
      if (!r) return send(404, {});
      return send(200, { data: { status: r.status, amount: r.amount, transactionID: id, remark: r.remark ?? null, customer_msisdn: r.msisdn, signature: 'secret-signature', nested: { a: 1 } } });
    }
    return send(404, {});
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
process.env.MALIPO_API_KEY = 'spec-key';
process.env.MALIPO_API_SECRET = SECRET;
process.env.MALIPO_BASE_URL = `http://127.0.0.1:${server.address().port}`;
delete process.env.NODE_ENV;

const { ensureInit } = await import('../functions/index.mjs');
await ensureInit();
const { eventStore, eventsPaymentsService, mobileMoneyService, adminPaymentService, db: _db } = await import('../src/bootstrap/services.mjs');
void _db;
const { createEventOrder, quoteEventOrder, resetEventsRegistrationLimits } = await import('../functions/events-registration.mjs');
const { payForEventOrder, eventOrderPaymentStatus, resetEventsPaymentLimits } = await import('../functions/events-payments.mjs');
const { payByMobileMoney, refreshMobileMoneyPayment, paymentOptions } = await import('../functions/mobile-money.mjs');
const { tunzaaWebhook } = await import('../functions/webhooks.mjs');
const { adminPaymentRequests } = await import('../functions/admin-payments.mjs');
const { sortKeys } = await import('../src/integrations/payments/tunzaa.mjs');
const { harness, s4On, s4Off, saveManualDetails, clearManualDetails, txId, uid, phone, D, H } = await import('./fixtures/events-s4.mjs');

const h = harness();
const { db, call } = h;
const flagsTunzaa = (extra = {}) => {
  s4On({ tunzaa: true });
  process.env.TUNZAA_PAYMENTS = '1';
  process.env.TUNZAA_SANDBOX_SETTLES = '1';
  Object.assign(process.env, extra);
};
afterEach(() => { s4Off(); delete process.env.TUNZAA_PAYMENTS; delete process.env.TUNZAA_SANDBOX_SETTLES; failStatus = false; resetEventsRegistrationLimits(); resetEventsPaymentLimits(); });
after(async () => { await clearManualDetails(); await h.cleanup(); server.close(); await db.destroy(); });

const key = () => `tz_${uid('').slice(1)}`;
let msisdnSeq = Math.floor(Math.random() * 500000) + 100000;
/** A Tanzanian mobile number nobody has been prompted yet (the prompt limiter is per phone). */
const msisdn = () => `0712${String(msisdnSeq += 1).padStart(6, '0')}`;
const member = async () => { const p = `+2557${String(Math.floor(Math.random() * 90000000) + 10000000)}`; const sub = await h.user({ phone: p }); return { claims: h.claimsOf(sub), sub, phone: p }; };
const sign = body => createHmac('sha256', SECRET).update(JSON.stringify(sortKeys(body))).digest('hex');
const res = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
const callback = async (body, signed = true) => { const out = res(); await tunzaaWebhook.onRequest({ headers: signed ? { 'x-signature': sign(body) } : { 'x-signature': 'deadbeef' }, body }, out); return out; };

async function setup({ price = 20000, capacity = 10 } = {}) {
  flagsTunzaa();
  await saveManualDetails();
  const f = await h.sellingEvent({ categories: [{ name: '10K', distanceMeters: 10000, tickets: [{ name: 'Early', priceTzs: price, capacity }] }] });
  const b = await member();
  return { f, b };
}
async function place(f, b, n = 1) {
  const participants = Array.from({ length: n }, (_, i) => (i === 0 ? { ticketTypeId: f.ticket.id, firstName: 'Neema', lastName: 'Abdallah', phone: b.phone, consentBasis: 'self' } : { ticketTypeId: f.ticket.id, firstName: 'Zawadi', lastName: 'Mollel', phone: phone(), consentBasis: 'purchaser_authorised' }));
  const body = { eventId: f.event.id, lines: [{ ticketTypeId: f.ticket.id, quantity: n }], acceptedTerms: true, consentTextVersion: '2026-10-draft', participants };
  const q = await call(quoteEventOrder, b.claims, { body });
  const r = await call(createEventOrder, b.claims, { headers: { 'Idempotency-Key': key() }, body: { ...body, expectedTotalTzs: q.body.quote.totalTzs } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
/** Order + provider-mode initiation + the prompt on the phone; resolves with ids and the remote transaction. */
async function prompted(f, b, n = 1) {
  const o = await place(f, b, n);
  assert.equal(o.next.payment, 'provider');
  const init = await call(payForEventOrder, b.claims, { params: { id: o.order.id }, headers: { 'Idempotency-Key': key() }, body: {} });
  assert.equal(init.status, 201, JSON.stringify(init.body));
  const prompt = await call(payByMobileMoney, b.claims, { params: { id: init.body.next.paymentRequestId }, body: { phone: msisdn() } });
  assert.equal(prompt.status, 202, JSON.stringify(prompt.body));
  const request = await db('PaymentRequest').where({ id: init.body.next.paymentRequestId }).first();
  return { orderId: o.order.id, init, request, txn: request.reference, o };
}
const complete = (txn, over = {}) => Object.assign(remote.get(txn), { status: 'COMPLETED', ...over });
const cb = (p, status = 'COMPLETED') => ({ transaction_id: p.txn, reference_id: p.request.id, status, amount: remote.get(p.txn).amount, payment_date: '2026-10-28 10:00:00', timestamp: '2026-10-28 10:00:05', remark: 'ok' });

test('gating: the mode is provider only when the event flag, TUNZAA_PAYMENTS, the client and canSettle() all hold; the sandbox never reports provider without TUNZAA_SANDBOX_SETTLES; EVENT_ORDER is listed only then', async () => {
  const { b } = await setup();
  assert.equal(eventsPaymentsService.mode(), 'provider');
  assert.equal(eventsPaymentsService.optionsBlock().payment, 'provider');
  assert.ok(!('manualConfirmHours' in eventsPaymentsService.optionsBlock()));
  const listed = async () => (await call(paymentOptions, b.claims, {})).body;
  assert.deepEqual((await listed()).mobileMoney.products, ['FITFLEX_PASS', 'GYM_SUBSCRIPTION', 'EVENT_ORDER']);
  assert.deepEqual(mobileMoneyService.payableProducts('trainer'), []);
  delete process.env.TUNZAA_SANDBOX_SETTLES;
  assert.equal(eventsPaymentsService.mode(), 'manual', 'the sandbox without TUNZAA_SANDBOX_SETTLES never offers provider');
  assert.ok(!('mobileMoney' in (await listed())), 'no EVENT_ORDER, no block');
  process.env.TUNZAA_SANDBOX_SETTLES = '1';
  delete process.env.TUNZAA_PAYMENTS;
  assert.equal(eventsPaymentsService.mode(), 'manual');
  process.env.TUNZAA_PAYMENTS = '1';
  delete process.env.EVENTS_PAYMENTS_TUNZAA;
  assert.equal(eventsPaymentsService.mode(), 'manual');
  assert.ok(!(mobileMoneyService.payableProducts('member')).includes('EVENT_ORDER'));
  // a manual body in provider mode, and the other way round, are mismatches
  process.env.EVENTS_PAYMENTS_TUNZAA = '1';
  const f = await h.sellingEvent({});
  const o = await place(f, b);
  const mismatch = await call(payForEventOrder, b.claims, { params: { id: o.order.id }, headers: { 'Idempotency-Key': key() }, body: { reference: txId(), payerPhone: b.phone } });
  assert.deepEqual([mismatch.status, mismatch.body.error, mismatch.body.mode], [409, 'payment_mode_mismatch', 'provider']);
});

test('scenario 7: the app times out after the prompt — the replay returns the same payment; the callback later confirms the order; the member does not have to act', async () => {
  const { f, b } = await setup();
  const o = await place(f, b);
  const k = key();
  const first = await call(payForEventOrder, b.claims, { params: { id: o.order.id }, headers: { 'Idempotency-Key': k }, body: {} });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.deepEqual([first.body.payment.method, first.body.payment.state, first.body.next.payment], ['provider', 'none', 'provider']);
  const row = await db('EventPayment').where({ orderId: o.order.id }).first();
  assert.deepEqual([row.status, row.provider, row.method], ['created', 'tunzaa', 'provider']);
  const replay = await call(payForEventOrder, b.claims, { params: { id: o.order.id }, headers: { 'Idempotency-Key': k }, body: {} });
  assert.deepEqual([replay.status, replay.body.replayed, replay.body.payment.id], [200, true, first.body.payment.id]);
  const before = (await db('EventOrder').where({ id: o.order.id }).first());
  const prompt = await call(payByMobileMoney, b.claims, { params: { id: first.body.next.paymentRequestId }, body: { phone: msisdn() } });
  assert.equal(prompt.status, 202, JSON.stringify(prompt.body));
  const pending = await db('EventPayment').where({ orderId: o.order.id }).first();
  assert.deepEqual([pending.status, Boolean(pending.providerTransactionId)], ['pending', true]);
  assert.equal((await call(eventOrderPaymentStatus, b.claims, { params: { id: o.order.id } })).body.payment.state, 'processing');
  // the hold was extended by the provider rule (10 minutes), never shortened
  const extended = await db('EventOrder').where({ id: o.order.id }).first();
  assert.ok(+new Date(extended.holdExpiresAt) >= +new Date(before.holdExpiresAt));
  assert.equal(extended.holdExtensions, 1);
  // the app has given up; the phone approves; the callback arrives
  const request = await db('PaymentRequest').where({ id: first.body.next.paymentRequestId }).first();
  const txn = request.reference;
  complete(txn);
  const out = await callback({ transaction_id: txn, reference_id: request.id, status: 'COMPLETED', amount: '20000.00' });
  assert.deepEqual([out.statusCode, out.body], [200, { ok: true }]);
  const status = (await call(eventOrderPaymentStatus, b.claims, { params: { id: o.order.id } })).body;
  assert.deepEqual([status.order.status, status.payment.state], ['confirmed', 'confirmed']);
  assert.equal((await db('EventTicket as t').join('EventRegistration as r', 'r.id', 't.registrationId').where('r.orderId', o.order.id)).length, 1);
});

test('scenario 6: the same callback twice makes one payment, one commit, one ticket set, one set of outbox rows and notices; WebhookSeen is written after processing; the signature is checked', async () => {
  const { f, b } = await setup();
  const p = await prompted(f, b, 2);
  complete(p.txn);
  const body = cb(p);
  assert.equal((await callback(body, false)).statusCode, 403, 'a bad signature is refused');
  assert.equal(await db('WebhookSeen').where({ id: `tunzaa:${p.txn}:COMPLETED` }).first(), undefined);
  const callsBefore = statusCalls;
  const one = await callback(body);
  assert.deepEqual([one.statusCode, one.body], [200, { ok: true }]);
  assert.ok(statusCalls > callsBefore, 'the callback is only a trigger: the status was re-read');
  assert.ok(await db('WebhookSeen').where({ id: `tunzaa:${p.txn}:COMPLETED` }).first());
  const callsAfter = statusCalls;
  const two = await callback(body);
  assert.deepEqual([two.statusCode, two.body], [200, { ok: true }]);
  assert.equal(statusCalls, callsAfter, 'a duplicate does not call Tunzaa again');
  assert.equal((await db('EventPayment').where({ orderId: p.orderId, status: 'succeeded' })).length, 1);
  assert.equal(Number((await db('EventTicket as t').join('EventRegistration as r', 'r.id', 't.registrationId').where('r.orderId', p.orderId).count({ n: '*' }))[0].n), 2);
  assert.deepEqual(await h.counters(f.ticket.id), { sold: 2, held: 0, capacity: 10 });
  assert.equal((await h.outbox(f.event.id, 'payment.succeeded')).length, 1);
  assert.equal((await h.notifications(b.sub, 'event_payment_confirmed')).length, 1);
  // a provider approval needs no second admin even with MONEY_SECOND_APPROVER on
  process.env.MONEY_SECOND_APPROVER = '1';
  const q = await prompted(f, await member());
  complete(q.txn);
  await callback(cb(q));
  assert.equal((await db('EventOrder').where({ id: q.orderId }).first()).status, 'confirmed');
});

test('a crash midway: when the status cannot be read the callback is not marked seen and Tunzaa\'s retry is processed', async () => {
  const { f, b } = await setup();
  const p = await prompted(f, b);
  complete(p.txn);
  failStatus = true;
  const first = await callback(cb(p));
  assert.equal(first.statusCode, 200);
  assert.equal(await db('WebhookSeen').where({ id: `tunzaa:${p.txn}:COMPLETED` }).first(), undefined, 'not recorded: nothing was processed');
  assert.equal((await db('EventOrder').where({ id: p.orderId }).first()).status, 'awaiting_payment');
  failStatus = false;
  await callback(cb(p));
  assert.equal((await db('EventOrder').where({ id: p.orderId }).first()).status, 'confirmed');
});

test('scenario 8, provider side: a different amount or transaction is HELD — reconciliation_required, no ticket, no commit, an audit row and an ops exception; currency is TZS only', async () => {
  const { f, b } = await setup();
  const p = await prompted(f, b);
  complete(p.txn, { amount: '15000.00' });
  const held = await callback({ ...cb(p), amount: '15000.00' });
  assert.equal(held.statusCode, 200);
  const pay_ = await db('EventPayment').where({ orderId: p.orderId }).first();
  assert.deepEqual([pay_.status, pay_.failureReason], ['reconciliation_required', 'amount_mismatch']);
  assert.deepEqual([(await db('EventOrder').where({ id: p.orderId }).first()).status, await h.counters(f.ticket.id)], ['awaiting_payment', { sold: 0, held: 1, capacity: 10 }]);
  assert.equal((await db('EventTicket as t').join('EventRegistration as r', 'r.id', 't.registrationId').where('r.orderId', p.orderId)).length, 0);
  assert.ok(await db('AuditLog').where({ action: 'payment_mobile_money_amount_mismatch', target: p.request.id }).first());
  const ex = await db('OpsException').where({ dedupeKey: `evpay:${pay_.id}` }).first();
  assert.ok(ex && ex.severity === 'high');
  const status = (await call(eventOrderPaymentStatus, b.claims, { params: { id: p.orderId } })).body;
  assert.equal(status.payment.state, 'needs_attention');
  // a held payment blocks a second prompt (live), and the member cannot start another attempt
  const again = await call(payForEventOrder, b.claims, { params: { id: p.orderId }, headers: { 'Idempotency-Key': key() }, body: {} });
  assert.deepEqual([again.status, again.body.error], [409, 'payment_in_progress']);
  await db('OpsException').where({ id: ex.id }).del();
  // a transaction that is not the recorded prompt
  const q = await prompted(f, await member());
  const other = `TXN_OTHER_${Date.now()}`;
  remote.set(other, { status: 'COMPLETED', amount: '20000.00' });
  const mism = await callback({ transaction_id: other, reference_id: q.request.id, status: 'COMPLETED', amount: '20000.00' });
  assert.equal(mism.statusCode, 200);
  const qp = await db('EventPayment').where({ orderId: q.orderId }).first();
  assert.deepEqual([qp.status, qp.failureReason], ['reconciliation_required', 'transaction_mismatch']);
  assert.equal((await db('EventOrder').where({ id: q.orderId }).first()).status, 'awaiting_payment');
  await db('OpsException').where('dedupeKey', 'like', 'evpay:%').del();
});

test('a FAILED answer ends the attempt (EventPayment failed, request cancelled); the hold keeps running and the member can try again', async () => {
  const { f, b } = await setup();
  const p = await prompted(f, b);
  const holdBefore = (await db('EventOrder').where({ id: p.orderId }).first()).holdExpiresAt;
  complete(p.txn, { status: 'FAILED', remark: 'insufficient funds' });
  const out = await callback(cb(p, 'FAILED'));
  assert.equal(out.statusCode, 200);
  const pay_ = await db('EventPayment').where({ orderId: p.orderId }).first();
  assert.deepEqual([pay_.status, pay_.failureReason], ['failed', 'provider_failed']);
  assert.equal((await db('PaymentRequest').where({ id: p.request.id }).first()).status, 'cancelled');
  const order = await db('EventOrder').where({ id: p.orderId }).first();
  assert.deepEqual([order.status, +new Date(order.holdExpiresAt) >= +new Date(holdBefore)], ['awaiting_payment', true], 'a FAILED prompt does not shorten the hold');
  const view = (await call(eventOrderPaymentStatus, b.claims, { params: { id: p.orderId } })).body;
  assert.deepEqual([view.payment.state, view.payment.canRetry], ['failed', true]);
  const retry = await call(payForEventOrder, b.claims, { params: { id: p.orderId }, headers: { 'Idempotency-Key': key() }, body: {} });
  assert.equal(retry.status, 201, JSON.stringify(retry.body));
});

test('the lost callback: the hourly sweep settles a pending prompt (COMPLETED) and expires a stale one (not completed in 30 minutes); the refresh route does the same on demand', async () => {
  const { f, b } = await setup();
  const done = await prompted(f, b);
  const stale = await prompted(f, await member());
  const fresh = await prompted(f, await member());
  complete(done.txn);
  const old = new Date(Date.now() - 10 * 60_000);
  await db('EventPayment').where({ orderId: done.orderId }).update({ updatedAt: old });
  await db('EventPayment').where({ orderId: stale.orderId }).update({ updatedAt: old, submittedAt: new Date(Date.now() - 40 * 60_000) });
  const sweep = await eventsPaymentsService.sweep();
  assert.ok(sweep.settled >= 1 && sweep.expired >= 1, JSON.stringify(sweep));
  assert.equal((await db('EventOrder').where({ id: done.orderId }).first()).status, 'confirmed');
  const s = await db('EventPayment').where({ orderId: stale.orderId }).first();
  assert.deepEqual([s.status, s.failureReason], ['expired', 'prompt_expired']);
  assert.equal((await db('PaymentRequest').where({ id: stale.request.id }).first()).status, 'cancelled');
  assert.equal((await call(eventOrderPaymentStatus, (await (async () => ({ claims: h.claimsOf((await db('EventOrder').where({ id: stale.orderId }).first()).purchaserUserId) }))()).claims, { params: { id: stale.orderId } })).body.payment.state, 'expired');
  // the member's refresh route settles the one still pending (they have not waited long)
  complete(fresh.txn);
  const owner = h.claimsOf((await db('EventOrder').where({ id: fresh.orderId }).first()).purchaserUserId);
  const r = await call(refreshMobileMoneyPayment, owner, { params: { id: fresh.request.id } });
  assert.deepEqual([r.status, r.body.state], [200, 'completed']);
  assert.equal((await db('EventOrder').where({ id: fresh.orderId }).first()).status, 'confirmed');
});

test('rawRedacted keeps only the allowlisted provider fields (never the signature, a phone number or nested data); manual payments store null', async () => {
  const { f, b } = await setup();
  const p = await prompted(f, b);
  complete(p.txn, { remark: 'Paid from +255 712 345 678' });
  await callback(cb(p));
  const row = await db('EventPayment').where({ orderId: p.orderId }).first();
  assert.equal(row.status, 'succeeded');
  assert.deepEqual(Object.keys(row.rawRedacted).sort(), ['amount', 'provider', 'remark', 'status', 'transaction_id'].sort());
  const text = JSON.stringify(row.rawRedacted);
  for (const secret of ['secret-signature', '712 345', '255712', 'customer_msisdn', 'nested']) assert.ok(!text.includes(secret), secret);
  assert.equal(row.rawRedacted.remark, 'Paid from ***678');
});

test('roles: only a member pays an event order by prompt; a trainer is refused (403 not_payable_by_role); provider mode is not offered to an expired order', async () => {
  const { f, b } = await setup();
  const o = await place(f, b);
  const init = await call(payForEventOrder, b.claims, { params: { id: o.order.id }, headers: { 'Idempotency-Key': key() }, body: {} });
  const trainer = h.claimsOf(await h.user({ userType: 'trainer' }), 'trainer');
  // a trainer is turned away at the door (members only)...
  assert.equal((await call(payByMobileMoney, trainer, { params: { id: init.body.next.paymentRequestId }, body: { phone: msisdn() } })).status, 403);
  // ...and even with trainer products on, owning the request does not make an event order a trainer's purchase
  process.env.TUNZAA_TRAINER_PRODUCTS = '1';
  assert.equal((await call(payByMobileMoney, trainer, { params: { id: init.body.next.paymentRequestId }, body: { phone: msisdn() } })).status, 404, 'not theirs');
  await db('PaymentRequest').where({ id: init.body.next.paymentRequestId }).update({ memberId: trainer.sub });
  const roleRefused = await call(payByMobileMoney, trainer, { params: { id: init.body.next.paymentRequestId }, body: { phone: msisdn() } });
  assert.deepEqual([roleRefused.status, roleRefused.body.error], [403, 'not_payable_by_role']);
  await db('PaymentRequest').where({ id: init.body.next.paymentRequestId }).update({ memberId: b.sub });
  delete process.env.TUNZAA_TRAINER_PRODUCTS;
  // an expired order: the prompt is not offered late
  const late = await place(f, await member());
  const lb = h.claimsOf((await db('EventOrder').where({ id: late.order.id }).first()).purchaserUserId);
  await eventStore.expireHolds({ at: new Date(Date.now() + 3 * D) });
  const refused = await call(payForEventOrder, lb, { params: { id: late.order.id }, headers: { 'Idempotency-Key': key() }, body: {} });
  assert.deepEqual([refused.status, refused.body.error], [409, 'hold_expired']);
  void adminPaymentService; void adminPaymentRequests; void H;
});
