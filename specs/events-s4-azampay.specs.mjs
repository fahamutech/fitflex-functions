// Marathon & running events · S4 — a member's event order paid through AzamPay (EVENTS_PAYMENTS_AZAMPAY; owner decision
// 2026-11-17: AzamPay is the only payment method), through the real routes and the real client against a LOCAL fake
// AzamPay (AZAMPAY_*_URL, non-production only). AzamPay has no status query: its RSA-signed callback is the confirmation.
// Covered: gating; the exact amount settles once; less / more / an unreadable amount, another transaction, a closed or
// already confirmed order are HELD for staff (never a ticket, never lost); WebhookSeen idempotency (written after
// processing); bad signature / wrong clientId / unknown reference change nothing; failure and retry; a prompt whose
// callback never arrives (the retry window and the sweep) and the success that still arrives afterwards; roles.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync, createSign } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUB = publicKey.export({ type: 'spki', format: 'pem' });
const CLIENT_ID = 'spec-client';
const remote = new Map();   // transactionId → { amount, utilityref (our reference), msisdn }
let checkouts = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url.startsWith('/AppRegistration/GenerateToken')) return send(200, { data: { accessToken: 'tok', expire: new Date(Date.now() + 3600_000).toISOString() }, success: true });
    if (req.url.startsWith('/azampay/v1/public-key')) return send(200, { success: true, format: 'Pem', publicKey: PUB });
    if (req.url.startsWith('/azampay/mno/checkout')) {
      const b = JSON.parse(body || '{}');
      checkouts += 1;
      const id = `SPEC_${checkouts}_${Date.now()}`;
      remote.set(id, { amount: String(b.amount), utilityref: b.externalId, msisdn: b.accountNumber, provider: b.provider });
      return send(200, { transactionId: id, message: 'ok', success: true });
    }
    return send(404, {});
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const HOST = `http://127.0.0.1:${server.address().port}`;
process.env.AZAMPAY_APP_NAME = 'spec-app';
process.env.AZAMPAY_CLIENT_ID = CLIENT_ID;
process.env.AZAMPAY_CLIENT_SECRET = 'spec-secret';
process.env.AZAMPAY_AUTH_URL = HOST;
process.env.AZAMPAY_CHECKOUT_URL = HOST;
process.env.AZAMPAY_DISBURSE_URL = HOST;
delete process.env.AZAMPAY_ENV;
delete process.env.NODE_ENV;

const { ensureInit } = await import('../functions/index.mjs');
await ensureInit();
const { eventStore, eventsPaymentsService, mobileMoneyService } = await import('../src/bootstrap/services.mjs');
const { createEventOrder, quoteEventOrder, resetEventsRegistrationLimits } = await import('../functions/events-registration.mjs');
const { payForEventOrder, eventOrderPaymentStatus, resetEventsPaymentLimits } = await import('../functions/events-payments.mjs');
const { payByMobileMoney, refreshMobileMoneyPayment, paymentOptions } = await import('../functions/mobile-money.mjs');
const { azampayWebhook } = await import('../functions/webhooks.mjs');
const { adminDecidePaymentRequest } = await import('../functions/admin-payments.mjs');
const { callbackSignedText } = await import('../src/integrations/payments/azampay.mjs');
const { PROMPT_TTL_MS } = await import('../src/shared/mobile-money-claim.mjs');
const { harness, s4On, s4Off, txId, uid, phone, D } = await import('./fixtures/events-s4.mjs');

const h = harness();
const { db, call } = h;
afterEach(() => { s4Off(); resetEventsRegistrationLimits(); resetEventsPaymentLimits(); });
after(async () => { await db('OpsException').where('dedupeKey', 'like', 'evpay:%').del().catch(() => {}); await h.cleanup(); server.close(); await db.destroy(); });

const key = () => `az_${uid('').slice(1)}`;
let msisdnSeq = Math.floor(Math.random() * 500000) + 100000;
/** A Tanzanian mobile number nobody has been prompted yet (the prompt limiter is per phone); 0754… is M-Pesa. */
const msisdn = () => `0754${String(msisdnSeq += 1).padStart(6, '0')}`;
const member = async () => { const p = `+2557${String(Math.floor(Math.random() * 90000000) + 10000000)}`; const sub = await h.user({ phone: p }); return { claims: h.claimsOf(sub), sub, phone: p }; };
const sign = (p, k = privateKey) => { const s = createSign('SHA256'); s.update(callbackSignedText(p), 'utf8'); return s.sign(k, 'base64'); };
const res = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
/** AzamPay's callback for a transaction of the fake; `over` changes fields BEFORE signing. */
const cbOf = (txn, over = {}) => {
  const r = remote.get(txn) ?? {};
  return { message: 'Transaction completed successfully', user: '', password: '', clientId: CLIENT_ID, transactionstatus: 'success', operator: 'Mpesa', reference: `REF_${txn}`, externalreference: `EXT_${txn}`, utilityref: r.utilityref, amount: r.amount, transid: txn, msisdn: r.msisdn ?? '255754000000', mnoreference: 'MNO1', ...over };
};
/** Deliver a callback through the route: signed with AzamPay's key (or `signer`); `tamper` changes fields AFTER signing. */
const callback = async (body, { tamper = {}, signer = privateKey } = {}) => { const out = res(); await azampayWebhook.onRequest({ headers: {}, body: { ...body, signature: sign(body, signer), ...tamper } }, out); return out; };
const seenId = (txn, status = 'SUCCESS') => `azampay:${txn}:${status}`;
const orderOf = id => db('EventOrder').where({ id }).first();
const paymentOf = orderId => db('EventPayment').where({ orderId }).orderBy('createdAt', 'desc').first();
const ticketsOf = async orderId => (await db('EventTicket as t').join('EventRegistration as r', 'r.id', 't.registrationId').where('r.orderId', orderId)).length;
const audits = (action, target) => db('AuditLog').where({ action, target });

async function setup({ price = 20000, capacity = 10 } = {}) {
  s4On();
  const f = await h.sellingEvent({ categories: [{ name: '10K', distanceMeters: 10000, tickets: [{ name: 'Early', priceTzs: price, capacity }] }] });
  const b = await member();
  return { f, b };
}
async function place(f, b, n = 1) {
  const participants = Array.from({ length: n }, (_, i) => (i === 0 ? { ticketTypeId: f.ticket.id, firstName: 'Neema', lastName: 'Abdallah', phone: b.phone, consentBasis: 'self' } : { ticketTypeId: f.ticket.id, firstName: 'Zawadi', lastName: 'Mollel', phone: phone(), consentBasis: 'purchaser_authorised' }));
  const body = { eventId: f.event.id, lines: [{ ticketTypeId: f.ticket.id, quantity: n }], acceptedTerms: true, consentTextVersion: '2026-11-draft', participants };
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

test('gating: a member\'s order is payable only through AzamPay — the event flag, AZAMPAY_PAYMENTS, the client and canSettle() must all hold; otherwise the mode is none (never manual); EVENT_ORDER is listed only then', async () => {
  const { b } = await setup();
  assert.equal(eventsPaymentsService.mode(), 'provider');
  assert.equal(eventsPaymentsService.optionsBlock().payment, 'provider');
  assert.ok(!('manualConfirmHours' in eventsPaymentsService.optionsBlock()));
  const listed = async () => (await call(paymentOptions, b.claims, {})).body;
  assert.deepEqual((await listed()).mobileMoney.products, ['FITFLEX_PASS', 'GYM_SUBSCRIPTION', 'EVENT_ORDER']);
  assert.deepEqual([(await listed()).provider, 'manual' in (await listed())], ['azampay', false]);
  assert.deepEqual(mobileMoneyService.payableProducts('trainer'), []);
  for (const flag of ['AZAMPAY_SANDBOX_SETTLES', 'AZAMPAY_PAYMENTS', 'EVENTS_PAYMENTS_AZAMPAY']) {
    delete process.env[flag];
    assert.equal(eventsPaymentsService.mode(), 'none', `${flag} off: members cannot pay (and never by hand)`);
    assert.ok(!('mobileMoney' in (await listed())), `${flag} off: no EVENT_ORDER, no block`);
    process.env[flag] = '1';
  }
  process.env.MANUAL_PAY_INSTRUCTIONS = '1';   // a removed flag changes nothing
  delete process.env.EVENTS_PAYMENTS_AZAMPAY;
  assert.equal(eventsPaymentsService.mode(), 'none');
  delete process.env.MANUAL_PAY_INSTRUCTIONS;
  process.env.EVENTS_PAYMENTS_AZAMPAY = '1';
  // a member can no longer send a transaction ID
  const f = await h.sellingEvent({});
  const o = await place(f, b);
  assert.deepEqual([o.next.payment, o.next.instructions], ['provider', null]);
  const mismatch = await call(payForEventOrder, b.claims, { params: { id: o.order.id }, headers: { 'Idempotency-Key': key() }, body: { reference: txId(), payerPhone: b.phone } });
  assert.deepEqual([mismatch.status, mismatch.body.error, mismatch.body.mode], [409, 'payment_mode_mismatch', 'provider']);
  assert.equal(await paymentOf(o.order.id), undefined, 'nothing was created');
});

test('the exact amount settles once: the app may give up after the prompt — the replay returns the same payment and the callback confirms the order', async () => {
  const { f, b } = await setup();
  const o = await place(f, b);
  const k = key();
  const first = await call(payForEventOrder, b.claims, { params: { id: o.order.id }, headers: { 'Idempotency-Key': k }, body: {} });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.deepEqual([first.body.payment.method, first.body.payment.state, first.body.next.payment], ['provider', 'none', 'provider']);
  const row = await paymentOf(o.order.id);
  assert.deepEqual([row.status, row.provider, row.method], ['created', 'azampay', 'provider']);
  const replay = await call(payForEventOrder, b.claims, { params: { id: o.order.id }, headers: { 'Idempotency-Key': k }, body: {} });
  assert.deepEqual([replay.status, replay.body.replayed, replay.body.payment.id], [200, true, first.body.payment.id]);
  const before = await orderOf(o.order.id);
  const prompt = await call(payByMobileMoney, b.claims, { params: { id: first.body.next.paymentRequestId }, body: { phone: msisdn(), network: 'Mpesa' } });
  assert.equal(prompt.status, 202, JSON.stringify(prompt.body));
  const pending = await paymentOf(o.order.id);
  assert.deepEqual([pending.status, Boolean(pending.providerTransactionId)], ['pending', true]);
  assert.equal((await call(eventOrderPaymentStatus, b.claims, { params: { id: o.order.id } })).body.payment.state, 'processing');
  // the hold was extended by the provider rule, never shortened
  const extended = await orderOf(o.order.id);
  assert.ok(+new Date(extended.holdExpiresAt) >= +new Date(before.holdExpiresAt));
  assert.equal(extended.holdExtensions, 1);
  // a second tap while the prompt is out sends nothing
  const sent = checkouts;
  const tap = await call(payByMobileMoney, b.claims, { params: { id: first.body.next.paymentRequestId }, body: { phone: msisdn() } });
  assert.deepEqual([tap.status, tap.body.alreadyRequested, checkouts], [200, true, sent]);
  // the app has given up; the phone approves; the callback arrives; the refresh route alone settles nothing
  const request = await db('PaymentRequest').where({ id: first.body.next.paymentRequestId }).first();
  assert.ok(request.promptedAt);
  assert.equal((await call(refreshMobileMoneyPayment, b.claims, { params: { id: request.id } })).body.state, 'in_progress');
  assert.equal(remote.get(request.reference).utilityref.split('.')[0], request.id, 'our reference is the request id + the attempt');
  const out = await callback(cbOf(request.reference));
  assert.deepEqual([out.statusCode, out.body], [200, { ok: true }]);
  const status = (await call(eventOrderPaymentStatus, b.claims, { params: { id: o.order.id } })).body;
  assert.deepEqual([status.order.status, status.payment.state], ['confirmed', 'confirmed']);
  assert.equal(await ticketsOf(o.order.id), 1);
  const settled = await db('PaymentRequest').where({ id: request.id }).first();
  assert.deepEqual([settled.status, settled.decidedBy, settled.reference], ['approved', 'azampay', request.reference]);
  assert.equal((await call(refreshMobileMoneyPayment, b.claims, { params: { id: request.id } })).body.state, 'completed');
});

test('a bad signature, a wrong clientId, a tampered status and an unknown reference change nothing; the same callback twice makes one payment, one ticket set, one set of outbox rows and notices (WebhookSeen written after processing)', async () => {
  const { f, b } = await setup();
  const p = await prompted(f, b, 2);
  const body = cbOf(p.txn);
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  assert.equal((await callback(body, { signer: other })).statusCode, 403, 'signed by someone else');
  assert.equal((await callback(body, { tamper: { signature: 'not-a-signature' } })).statusCode, 403);
  assert.equal((await callback({ ...body, clientId: 'someone-else' })).statusCode, 403, 'a valid signature for another client');
  assert.equal((await callback(cbOf(p.txn, { transactionstatus: 'failure' }), { tamper: { transactionstatus: 'success' } })).statusCode, 403, 'the status is signed');
  assert.equal((await callback(body, { tamper: { utilityref: 'pay_someone_else.a' } })).statusCode, 403, 'our reference is signed');
  const unknown = await callback(cbOf(p.txn, { utilityref: 'pay_does_not_exist.a1' }));
  assert.deepEqual([unknown.statusCode, unknown.body], [200, { ok: true }], 'understood and ignored');
  assert.equal(await db('WebhookSeen').where({ id: seenId(p.txn) }).first(), undefined);
  assert.deepEqual([(await orderOf(p.orderId)).status, (await paymentOf(p.orderId)).status, (await db('PaymentRequest').where({ id: p.request.id }).first()).status], ['awaiting_payment', 'pending', 'pending']);
  const one = await callback(body);
  assert.deepEqual([one.statusCode, one.body], [200, { ok: true }]);
  assert.ok(await db('WebhookSeen').where({ id: seenId(p.txn) }).first());
  for (let i = 0; i < 2; i += 1) assert.deepEqual([(await callback(body)).statusCode], [200]);
  await Promise.all([callback(body), callback(body)]);
  assert.equal((await db('EventPayment').where({ orderId: p.orderId, status: 'succeeded' })).length, 1);
  assert.equal(await ticketsOf(p.orderId), 2);
  assert.deepEqual(await h.counters(f.ticket.id), { sold: 2, held: 0, capacity: 10 });
  assert.equal((await h.outbox(f.event.id, 'payment.succeeded')).length, 1);
  assert.equal((await h.notifications(b.sub, 'event_payment_confirmed')).length, 1);
  // a provider approval needs no second admin even with MONEY_SECOND_APPROVER on
  process.env.MONEY_SECOND_APPROVER = '1';
  const q = await prompted(f, await member());
  await callback(cbOf(q.txn));
  assert.equal((await orderOf(q.orderId)).status, 'confirmed');
});

test('less than asked (partial), more than asked (over), a missing or non-numeric amount: HELD — reconciliation_required, no ticket, no commit, the received amount in the audit, an ops exception; staff cannot approve a held mismatch', async () => {
  for (const [amount, received] of [['15000', 15000], ['25000', 25000], ['', null], ['abc', null]]) {
    const { f, b } = await setup();
    const p = await prompted(f, b);
    const held = await callback(cbOf(p.txn, { amount }));
    assert.equal(held.statusCode, 200, `amount ${amount}`);
    const pay_ = await paymentOf(p.orderId);
    assert.deepEqual([pay_.status, pay_.failureReason], ['reconciliation_required', 'amount_mismatch'], `amount ${amount}`);
    assert.deepEqual([(await orderOf(p.orderId)).status, await h.counters(f.ticket.id)], ['awaiting_payment', { sold: 0, held: 1, capacity: 10 }]);
    assert.equal(await ticketsOf(p.orderId), 0);
    assert.equal((await db('PaymentRequest').where({ id: p.request.id }).first()).status, 'pending');
    const [row] = await audits('payment_mobile_money_amount_mismatch', p.request.id);
    assert.deepEqual([row.actor, row.before.amountTzs, row.after.received, row.after.transactionId], ['azampay', 20000, received, p.txn], `amount ${amount}`);
    const ex = await db('OpsException').where({ dedupeKey: `evpay:${pay_.id}` }).first();
    assert.ok(ex && ex.severity === 'high');
    assert.equal((await call(eventOrderPaymentStatus, b.claims, { params: { id: p.orderId } })).body.payment.state, 'needs_attention');
    // a held payment blocks a second attempt, and is settled by a refund or a person at the provider, not by an approval
    const again = await call(payForEventOrder, b.claims, { params: { id: p.orderId }, headers: { 'Idempotency-Key': key() }, body: {} });
    assert.deepEqual([again.status, again.body.error], [409, 'payment_in_progress']);
    const admin = h.claimsOf(await h.user({ userType: 'admin' }), 'admin');
    const approve = await call(adminDecidePaymentRequest, admin, { params: { id: p.request.id }, body: { decision: 'approve', amountTzs: 20000 } });
    assert.deepEqual([approve.status, approve.body.error], [409, 'payment_held_mismatch']);
    await db('OpsException').where({ id: ex.id }).del();
    s4Off();
  }
});

test('a success for another transaction than the prompt on the phone is HELD (transaction_mismatch)', async () => {
  const { f, b } = await setup();
  const q = await prompted(f, b);
  const other = `SPEC_OTHER_${Date.now()}`;
  const mism = await callback(cbOf(q.txn, { transid: other, reference: `R_${other}`, externalreference: `E_${other}` }));
  assert.equal(mism.statusCode, 200);
  const qp = await paymentOf(q.orderId);
  assert.deepEqual([qp.status, qp.failureReason], ['reconciliation_required', 'transaction_mismatch']);
  assert.deepEqual([(await orderOf(q.orderId)).status, await ticketsOf(q.orderId)], ['awaiting_payment', 0]);
  await db('OpsException').where('dedupeKey', 'like', 'evpay:%').del();
});

test('failure ends the attempt (EventPayment failed, request cancelled); the hold keeps running and the member can try again; a success that follows the failure is recorded as orphaned, never a ticket', async () => {
  const { f, b } = await setup();
  const p = await prompted(f, b);
  const holdBefore = (await orderOf(p.orderId)).holdExpiresAt;
  const out = await callback(cbOf(p.txn, { transactionstatus: 'failure', message: 'insufficient funds' }));
  assert.equal(out.statusCode, 200);
  const pay_ = await paymentOf(p.orderId);
  assert.deepEqual([pay_.status, pay_.failureReason], ['failed', 'provider_failed']);
  assert.equal((await db('PaymentRequest').where({ id: p.request.id }).first()).status, 'cancelled');
  const order = await orderOf(p.orderId);
  assert.deepEqual([order.status, +new Date(order.holdExpiresAt) >= +new Date(holdBefore)], ['awaiting_payment', true], 'a failed prompt does not shorten the hold');
  const view = (await call(eventOrderPaymentStatus, b.claims, { params: { id: p.orderId } })).body;
  assert.deepEqual([view.payment.state, view.payment.canRetry], ['failed', true]);
  // AzamPay now says the same attempt succeeded after all: the request is closed → orphaned for staff
  const late = await callback(cbOf(p.txn));
  assert.equal(late.statusCode, 200);
  const [orphan] = await audits('payment_mobile_money_orphaned', p.request.id);
  assert.deepEqual([orphan.before.status, orphan.after.transactionId, orphan.after.amountTzs, orphan.after.error], ['cancelled', p.txn, 20000, 'request_closed']);
  assert.ok(await db('OpsException').where({ dedupeKey: `evpay:${pay_.id}` }).first(), 'staff are told');
  assert.deepEqual([(await orderOf(p.orderId)).status, await ticketsOf(p.orderId)], ['awaiting_payment', 0]);
  await db('OpsException').where('dedupeKey', 'like', 'evpay:%').del();
  // the retry is a new payment and a new request, and settles once
  const retry = await call(payForEventOrder, b.claims, { params: { id: p.orderId }, headers: { 'Idempotency-Key': key() }, body: {} });
  assert.equal(retry.status, 201, JSON.stringify(retry.body));
  const prompt = await call(payByMobileMoney, b.claims, { params: { id: retry.body.next.paymentRequestId }, body: { phone: msisdn() } });
  assert.equal(prompt.status, 202, JSON.stringify(prompt.body));
  const again = await db('PaymentRequest').where({ id: retry.body.next.paymentRequestId }).first();
  await callback(cbOf(again.reference));
  assert.deepEqual([(await orderOf(p.orderId)).status, await ticketsOf(p.orderId)], ['confirmed', 1]);
  assert.equal((await db('EventPayment').where({ orderId: p.orderId, status: 'succeeded' })).length, 1);
});

test('a prompt whose callback never arrives: after the window the member gets a new prompt on the SAME request; a late success for the older attempt is held WITHOUT blocking the new one (ops exception only); the new prompt then settles once; staff could also have approved', async () => {
  const { f, b } = await setup();
  const p = await prompted(f, b);
  // ten minutes pass with no answer
  await db('PaymentRequest').where({ id: p.request.id }).update({ promptedAt: new Date(Date.now() - PROMPT_TTL_MS - 1000) });
  const again = await call(payByMobileMoney, b.claims, { params: { id: p.request.id }, body: { phone: msisdn() } });
  assert.equal(again.status, 202, JSON.stringify(again.body));
  const request = await db('PaymentRequest').where({ id: p.request.id }).first();
  assert.notEqual(request.reference, p.txn);
  assert.deepEqual(request.supersededReferences, [p.txn], 'the prompt that was given up is remembered on the request');
  assert.notEqual(remote.get(request.reference).utilityref, remote.get(p.txn).utilityref, 'a new attempt reference');
  assert.equal((await audits('payment_mobile_money_prompt_expired', p.request.id))[0].before.reference, p.txn);
  // the member approved the first prompt after all: held, staff told — and the payment stays payable
  const late = await callback(cbOf(p.txn));
  assert.equal(late.statusCode, 200);
  let pay_ = await paymentOf(p.orderId);
  assert.deepEqual([pay_.status, pay_.failureReason, pay_.providerTransactionId], ['pending', null, request.reference], 'not moved to reconciliation: the new prompt is still open');
  assert.deepEqual([(await orderOf(p.orderId)).status, await ticketsOf(p.orderId)], ['awaiting_payment', 0]);
  const [held] = await audits('payment_mobile_money_held', p.request.id);
  assert.deepEqual([held.after.error, held.after.superseded, held.after.transactionId, held.after.amountTzs], ['transaction_mismatch', true, p.txn, 20000]);
  const ex = await db('OpsException').where({ dedupeKey: `evpay:${pay_.id}:${p.txn}` }).first();
  assert.ok(ex && ex.severity === 'high' && ex.status === 'open', 'an ops exception of its own names the old transaction');
  assert.equal((await db('PaymentRequest').where({ id: p.request.id }).first()).status, 'pending');
  assert.equal((await call(eventOrderPaymentStatus, b.claims, { params: { id: p.orderId } })).body.payment.state, 'processing');
  // AzamPay repeats the old success: still held, the same exception (not a second one)
  await callback(cbOf(p.txn));
  assert.equal((await db('OpsException').where('dedupeKey', 'like', `evpay:${pay_.id}%`)).length, 1);
  // the new prompt is paid: it settles, once
  const done = await callback(cbOf(request.reference));
  assert.equal(done.statusCode, 200);
  pay_ = await paymentOf(p.orderId);
  assert.deepEqual([pay_.status, (await orderOf(p.orderId)).status, await ticketsOf(p.orderId)], ['succeeded', 'confirmed', 1]);
  assert.deepEqual([(await db('PaymentRequest').where({ id: p.request.id }).first()).reference], [request.reference]);
  assert.ok(await db('OpsException').where({ dedupeKey: `evpay:${pay_.id}:${p.txn}`, status: 'open' }).first(), 'the old money is still with staff');
  // the old success once more, now on a settled request: recorded as a second payment, nothing changes
  await callback(cbOf(p.txn, { message: 'again' }));
  assert.equal(await ticketsOf(p.orderId), 1);

  // the other way round: only the OLD prompt was paid. Staff can approve the request by hand (it was not blocked).
  const q = await prompted(f, await member());
  await db('PaymentRequest').where({ id: q.request.id }).update({ promptedAt: new Date(Date.now() - PROMPT_TTL_MS - 1000) });
  const qb = h.claimsOf((await orderOf(q.orderId)).purchaserUserId);
  assert.equal((await call(payByMobileMoney, qb, { params: { id: q.request.id }, body: { phone: msisdn() } })).status, 202);
  await callback(cbOf(q.txn));
  assert.equal((await paymentOf(q.orderId)).status, 'pending');
  const admin = h.claimsOf(await h.user({ userType: 'admin' }), 'admin');
  const approve = await call(adminDecidePaymentRequest, admin, { params: { id: q.request.id }, body: { decision: 'approve', amountTzs: 20000, reference: q.txn } });
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  assert.deepEqual([(await orderOf(q.orderId)).status, await ticketsOf(q.orderId)], ['confirmed', 1]);
  await db('OpsException').where('dedupeKey', 'like', 'evpay:%').del();
});

test('the lost callback and the sweep: a prompt not completed in 30 minutes is expired (request cancelled) and a fresh one is left alone; a success that still arrives is recorded as orphaned with an ops exception — no ticket, nothing lost', async () => {
  const { f, b } = await setup();
  const stale = await prompted(f, b);
  const fresh = await prompted(f, await member());
  const old = new Date(Date.now() - 12 * 60_000);
  await db('EventPayment').where({ orderId: stale.orderId }).update({ updatedAt: old, submittedAt: new Date(Date.now() - 40 * 60_000) });
  await db('PaymentRequest').where({ id: stale.request.id }).update({ promptedAt: new Date(Date.now() - 40 * 60_000) });
  const sweep = await eventsPaymentsService.sweep();
  assert.ok(sweep.expired >= 1 && sweep.settled === 0, JSON.stringify(sweep));
  const s = await paymentOf(stale.orderId);
  assert.deepEqual([s.status, s.failureReason], ['expired', 'prompt_expired']);
  assert.equal((await db('PaymentRequest').where({ id: stale.request.id }).first()).status, 'cancelled');
  assert.equal((await call(eventOrderPaymentStatus, b.claims, { params: { id: stale.orderId } })).body.payment.state, 'expired');
  assert.deepEqual([(await paymentOf(fresh.orderId)).status, (await db('PaymentRequest').where({ id: fresh.request.id }).first()).status], ['pending', 'pending']);
  // the money for the expired prompt turns up
  const late = await callback(cbOf(stale.txn));
  assert.equal(late.statusCode, 200);
  const [orphan] = await audits('payment_mobile_money_orphaned', stale.request.id);
  assert.deepEqual([orphan.before.status, orphan.after.transactionId, orphan.after.amountTzs], ['cancelled', stale.txn, 20000]);
  assert.ok(await db('OpsException').where({ dedupeKey: `evpay:${s.id}` }).first());
  assert.deepEqual([(await orderOf(stale.orderId)).status, await ticketsOf(stale.orderId), (await paymentOf(stale.orderId)).status], ['awaiting_payment', 0, 'expired']);
  // AzamPay's retry of the same callback is a no-op (WebhookSeen)
  assert.ok(await db('WebhookSeen').where({ id: seenId(stale.txn) }).first());
  await callback(cbOf(stale.txn));
  assert.equal((await audits('payment_mobile_money_orphaned', stale.request.id)).length, 1);
  // the fresh prompt still settles by its callback
  await callback(cbOf(fresh.txn));
  assert.equal((await orderOf(fresh.orderId)).status, 'confirmed');
  await db('OpsException').where('dedupeKey', 'like', 'evpay:%').del();
});

test('a second, different success for an order that is already confirmed is recorded as a duplicate payment (orphaned + ops exception); one ticket set', async () => {
  const { f, b } = await setup();
  const p = await prompted(f, b);
  await callback(cbOf(p.txn));
  assert.equal((await orderOf(p.orderId)).status, 'confirmed');
  const second = `SPEC_SECOND_${Date.now()}`;
  const out = await callback(cbOf(p.txn, { transid: second, reference: `R_${second}`, externalreference: `E_${second}` }));
  assert.equal(out.statusCode, 200);
  const [orphan] = await audits('payment_mobile_money_orphaned', p.request.id);
  assert.deepEqual([orphan.before.status, orphan.after.transactionId, orphan.after.error], ['approved', second, 'already_settled']);
  assert.deepEqual([await ticketsOf(p.orderId), (await db('EventPayment').where({ orderId: p.orderId, status: 'succeeded' })).length], [1, 1]);
  assert.ok(await db('OpsException').where({ dedupeKey: `evpay:${(await paymentOf(p.orderId)).id}` }).first());
  await db('OpsException').where('dedupeKey', 'like', 'evpay:%').del();
});

test('the real wiring for a product that is not an event (a gym plan): held money raises an ops exception for staff, keyed by request and transaction; a callback without clientId is 403', async () => {
  s4On();
  const b = await member();
  const subId = `sub_${uid('').slice(1, 13)}`; const payId = `pay_${uid('').slice(1, 13)}`; const gymId = `gym_${uid('').slice(1, 9)}`;
  const day = 24 * 3600_000;
  await db('Subscription').insert({ id: subId, memberId: b.sub, type: 'direct_sub', status: 'payment_pending', homeGymId: gymId, startedAt: new Date(), cycleStartedAt: new Date(), renewsAt: new Date(Date.now() + 30 * day), expiresAt: new Date(Date.now() + 30 * day) });
  await db('PaymentRequest').insert({ id: payId, memberId: b.sub, subscriptionId: subId, amountTzs: 80000, status: 'pending', provider: 'admin_approved', requestedAt: new Date(), plan: 'monthly', gymId });
  try {
    const prompt = await call(payByMobileMoney, b.claims, { params: { id: payId }, body: { phone: msisdn() } });
    assert.equal(prompt.status, 202, JSON.stringify(prompt.body));
    const txn = (await db('PaymentRequest').where({ id: payId }).first()).reference;
    // no clientId: refused at the door although the signature is good, and nothing changes
    const { clientId, ...anonymous } = cbOf(txn);
    void clientId;
    assert.equal((await callback(anonymous)).statusCode, 403);
    assert.equal((await db('PaymentRequest').where({ id: payId }).first()).status, 'pending');
    // less than asked: held, audited, and staff are told
    const held = await callback(cbOf(txn, { amount: '50000' }));
    assert.equal(held.statusCode, 200);
    assert.deepEqual([(await db('PaymentRequest').where({ id: payId }).first()).status, (await db('Subscription').where({ id: subId }).first()).status], ['pending', 'payment_pending']);
    const ex = await db('OpsException').where({ dedupeKey: `azampay_held:${payId}:${txn}` }).first();
    assert.ok(ex, 'an ops exception was raised');
    assert.deepEqual([ex.type, ex.severity, ex.status, ex.entityType, ex.entityId], ['payment_conflict', 'high', 'open', 'payment_request', payId]);
    const detail = typeof ex.detail === 'string' ? JSON.parse(ex.detail) : ex.detail;
    assert.deepEqual([detail.reason, detail.transactionId, detail.amountTzs], ['amount_mismatch', txn, 50000]);
    // AzamPay repeats it: the same exception, counted, not a second one
    await callback(cbOf(txn, { amount: '50000' }));
    const rows = await db('OpsException').where('dedupeKey', 'like', `azampay_held:${payId}:%`);
    assert.deepEqual([rows.length, rows[0].occurrences], [1, 2]);
    // an amount with cents is not rounded into the price
    await callback(cbOf(txn, { amount: '79999.5' }));
    assert.equal((await db('PaymentRequest').where({ id: payId }).first()).status, 'pending');
    // the right amount settles it
    await callback(cbOf(txn));
    assert.deepEqual([(await db('PaymentRequest').where({ id: payId }).first()).status, (await db('Subscription').where({ id: subId }).first()).status], ['approved', 'active']);
  } finally {
    await db('OpsException').where('dedupeKey', 'like', `azampay_held:${payId}:%`).del();
    await db('AuditLog').where({ target: payId }).del();
    await db('PaymentRequest').where({ id: payId }).del();
    await db('Subscription').where({ id: subId }).del();
  }
});

test('rawRedacted keeps only the allowlisted AzamPay fields (never the signature, the password, the clientId or a phone number)', async () => {
  const { f, b } = await setup();
  const p = await prompted(f, b);
  await callback(cbOf(p.txn, { message: 'Paid from +255 712 345 678', password: 'callback-password', user: 'callback-user' }));
  const row = await paymentOf(p.orderId);
  assert.equal(row.status, 'succeeded');
  assert.deepEqual(Object.keys(row.rawRedacted).sort(), ['amount', 'externalreference', 'message', 'mnoreference', 'operator', 'provider', 'reference', 'transactionstatus', 'transid', 'utilityref'].sort());
  const text = JSON.stringify(row.rawRedacted);
  for (const secret of ['callback-password', 'callback-user', 'signature', CLIENT_ID, '712 345', '255754', 'msisdn']) assert.ok(!text.includes(secret), secret);
  assert.equal(row.rawRedacted.message, 'Paid from ***678');
  assert.equal(row.rawRedacted.provider, 'azampay');
});

test('roles: only a member pays an event order by prompt; a trainer is refused (403 not_payable_by_role); the prompt is not offered once the hold has ended', async () => {
  const { f, b } = await setup();
  const o = await place(f, b);
  const init = await call(payForEventOrder, b.claims, { params: { id: o.order.id }, headers: { 'Idempotency-Key': key() }, body: {} });
  const trainer = h.claimsOf(await h.user({ userType: 'trainer' }), 'trainer');
  // a trainer is turned away at the door (members only)...
  assert.equal((await call(payByMobileMoney, trainer, { params: { id: init.body.next.paymentRequestId }, body: { phone: msisdn() } })).status, 403);
  // ...and even with trainer products on, owning the request does not make an event order a trainer's purchase
  process.env.AZAMPAY_TRAINER_PRODUCTS = '1';
  assert.equal((await call(payByMobileMoney, trainer, { params: { id: init.body.next.paymentRequestId }, body: { phone: msisdn() } })).status, 404, 'not theirs');
  await db('PaymentRequest').where({ id: init.body.next.paymentRequestId }).update({ memberId: trainer.sub });
  const roleRefused = await call(payByMobileMoney, trainer, { params: { id: init.body.next.paymentRequestId }, body: { phone: msisdn() } });
  assert.deepEqual([roleRefused.status, roleRefused.body.error], [403, 'not_payable_by_role']);
  await db('PaymentRequest').where({ id: init.body.next.paymentRequestId }).update({ memberId: b.sub });
  delete process.env.AZAMPAY_TRAINER_PRODUCTS;
  // an expired order: no prompt on a payment started before the hold ended, and no new payment after it
  const late = await place(f, await member());
  const lb = h.claimsOf((await orderOf(late.order.id)).purchaserUserId);
  const started = await call(payForEventOrder, lb, { params: { id: late.order.id }, headers: { 'Idempotency-Key': key() }, body: {} });
  const other = await place(f, await member());
  const ob = h.claimsOf((await orderOf(other.order.id)).purchaserUserId);
  await eventStore.expireHolds({ at: new Date(Date.now() + 3 * D) });
  const prompt = await call(payByMobileMoney, lb, { params: { id: started.body.next.paymentRequestId }, body: { phone: msisdn() } });
  assert.deepEqual([prompt.status, prompt.body.error], [409, 'hold_expired']);
  const refused = await call(payForEventOrder, ob, { params: { id: other.order.id }, headers: { 'Idempotency-Key': key() }, body: {} });
  assert.deepEqual([refused.status, refused.body.error], [409, 'hold_expired']);
  void phone;
});
