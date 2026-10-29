// Marathon & running events · S4 — corporate payment (spec §3.4.3, §6.8), claim invitations on confirmation (D15, §3.10),
// the organizer / admin finance totals and what an organizer may never see (§3.14, §7.4).
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ensureInit } from '../functions/index.mjs';
import { createB2BEventOrder, getB2BEventOrder, payB2BEventOrder, b2bEventOrderPaymentStatus, b2bEventOrderCancelPreview, cancelB2BEventOrder, resendB2BEventClaimInvitation, resetEventsCorporateLimits } from '../functions/events-corporate.mjs';
import { quoteEventOrder, createEventOrder, resetEventsRegistrationLimits } from '../functions/events-registration.mjs';
import { payForEventOrder, resendEventClaimInvitation, resetEventsPaymentLimits } from '../functions/events-payments.mjs';
import { adminDecidePaymentRequest, adminPaymentRequests } from '../functions/admin-payments.mjs';
import { adminEventFinance, adminGetEventOrder, adminCancelEventOrder, resetEventsAdminLimits } from '../functions/events-admin.mjs';
import { organizerEventFinance, organizerListOrders, resetEventsOrganizerLimits } from '../functions/events-organizer.mjs';
import { adminDecideRefund, adminMarkRefundPaid } from '../functions/refunds.mjs';
import { eventStore, eventMoneyStore, eventsRegistrationService, eventsRefundsService, users, verifiedContacts, eventCatalogueStore, paymentReferenceStore } from '../src/bootstrap/services.mjs';
import { createEventsRegistrationService } from '../src/services/events-registration-service.mjs';
import { createEventsPaymentService } from '../src/services/events-payment-service.mjs';
import { harness, s4On, s4Off, saveManualDetails, clearManualDetails, txId, uid, phone, D, H } from './fixtures/events-s4.mjs';

await ensureInit();
const h = harness();
const { db, call } = h;
afterEach(() => { s4Off(); resetEventsRegistrationLimits(); resetEventsPaymentLimits(); resetEventsCorporateLimits(); resetEventsAdminLimits(); resetEventsOrganizerLimits(); });
after(async () => { await clearManualDetails(); await db('B2BPaymentInstruction').where({ id: 'spec-s4' }).del(); await h.cleanup(); await db.destroy(); });

const key = () => `cf_${uid('').slice(1)}`;
const member = async () => { const p = phone(); const sub = await h.user({ phone: p }); return { claims: h.claimsOf(sub), sub, phone: p }; };
const admin = async () => h.claimsOf(await h.user({ userType: 'admin' }), 'admin');
const rowsFor = n => Array.from({ length: n }, (_, i) => ({ firstName: ['Asha', 'Baraka', 'Zuwena', 'Hamisi', 'Neema'][i % 5], lastName: 'Mollel', phone: phone(), category: '10K' }));
const eventOf = (over = {}) => h.sellingEvent({ categories: [{ name: '10K', distanceMeters: 10000, tickets: [{ name: 'Corporate', priceTzs: 20000, capacity: 20 }] }], ...over });

async function corporateOrder(n = 2) {
  s4On(); await saveManualDetails();
  const f = await eventOf();
  const org = await h.organization();
  const finance = await org.member('finance');
  const body = { eventId: f.event.id, rows: rowsFor(n), acceptedTerms: true, consentTextVersion: '2026-10-draft', expectedTotalTzs: 20000 * n };
  const r = await call(createB2BEventOrder, finance, { params: { id: org.id }, headers: { 'Idempotency-Key': key() }, body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { f, org, finance, orderId: r.body.order.id, order: r.body.order, total: 20000 * n, next: r.body.next };
}
const payOrg = (org, claims, orderId, body, k = key()) => call(payB2BEventOrder, claims, { params: { id: org.id, orderId }, headers: { 'Idempotency-Key': k }, body });
const today = () => new Date(Date.now() + 3 * H).toISOString().slice(0, 10);

test('corporate payment: a billing user records a bank transfer; instructions come from the B2B payment details; admin confirms; the coordinator is the PaymentRequest member; employees get tickets to claim', async () => {
  await db('B2BPaymentInstruction').insert({ id: 'default', bankName: 'CRDB', accountName: 'FitFlex Africa Ltd', accountNumber: '0150123456', branch: 'Dar', lipaNamba: '5123456', lipaNambaName: 'FitFlex', notes: 'Use the order reference' }).onConflict('id').merge();
  const { f, org, finance, orderId, order, total, next } = await corporateOrder(2);
  // instructions for an organisation: bank + Lipa Namba, the reference and the amount
  assert.deepEqual([next.payment, next.instructions.kind, next.instructions.accountNumber, next.instructions.reference, next.instructions.amountTzs], ['manual', 'organisation', '0150123456', order.reference, total]);
  const detail = (await call(getB2BEventOrder, finance, { params: { id: org.id, orderId } })).body;
  assert.deepEqual([detail.next.instructions.kind, detail.allowedActions.includes('pay'), detail.payment], ['organisation', true, null]);
  // a user without a billing role cannot send a payment notice; a stranger gets 404
  const hr = await org.member('hr');
  assert.deepEqual([(await payOrg(org, hr, orderId, { method: 'bank_transfer', reference: 'CRDB-TRF-00917', paidOn: today() })).status], [403]);
  const outsider = h.claimsOf(await h.user({}));
  assert.equal((await payOrg(org, outsider, orderId, { method: 'bank_transfer', reference: 'CRDB-TRF-00917', paidOn: today() })).status, 404);
  // validation
  assert.equal((await payOrg(org, finance, orderId, { method: 'cheque', reference: 'CRDB-TRF-00917', paidOn: today() })).body.error, 'invalid_method');
  assert.equal((await payOrg(org, finance, orderId, { method: 'bank_transfer', reference: 'CRDB-TRF-00917', paidOn: '2099-01-01' })).body.error, 'invalid_paid_on');
  assert.equal((await payOrg(org, finance, orderId, { method: 'bank_transfer', reference: 'x', paidOn: today() })).body.error, 'payment_reference_invalid');
  const noKey = await call(payB2BEventOrder, finance, { params: { id: org.id, orderId }, body: { method: 'bank_transfer', reference: 'CRDB-TRF-00917', paidOn: today() } });
  assert.equal(noKey.body.error, 'idempotency_key_required');
  const k = key();
  const sent = await payOrg(org, finance, orderId, { method: 'bank_transfer', reference: 'CRDB-TRF-00917', paidOn: today(), note: 'paid by finance', amountTzs: 1 }, k);
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.deepEqual([sent.body.payment.state, sent.body.payment.method, sent.body.payment.amountTzs, sent.body.payment.reference, sent.body.payment.payerPhoneMasked], ['submitted', 'manual', total, 'CRDB-TRF-00917', null]);
  const row = await db('EventPayment').where({ orderId }).first();
  assert.deepEqual([row.organizationId, row.payerMethod, Boolean(row.paidOn), row.method], [org.id, 'bank_transfer', true, 'manual']);
  const req = await db('PaymentRequest').where({ eventOrderId: orderId }).first();
  assert.deepEqual([req.memberId, req.payerPhone, req.provider, req.amountTzs], [order.createdByUserId ?? (await db('EventOrder').where({ id: orderId }).first()).createdByUserId, null, 'admin_approved', total]);
  assert.ok(req.note.includes('paid by finance'));
  // replay + organisation-scoped key
  assert.equal((await payOrg(org, finance, orderId, { method: 'bank_transfer', reference: 'CRDB-TRF-00917', paidOn: today(), note: 'paid by finance', amountTzs: 1 }, k)).body.replayed, true);
  // the hold follows the manual rules with the organisation cap (5 days), not 48 h
  const o = await db('EventOrder').where({ id: orderId }).first();
  assert.equal(+new Date(o.holdCapAt), +new Date(o.createdAt) + 120 * H);
  // the status read
  const st = (await call(b2bEventOrderPaymentStatus, finance, { params: { id: org.id, orderId } })).body;
  assert.equal(st.payment.state, 'submitted');
  // the admin confirms with the amount received
  const a = await admin();
  const listed = (await call(adminPaymentRequests, a, { query: { productType: 'EVENT_ORDER' } })).body.find(r => r.id === req.id);
  assert.ok(listed.eventOrder.organizationName);
  const done = await call(adminDecidePaymentRequest, a, { params: { id: req.id }, body: { decision: 'approve', amountTzs: total } });
  assert.equal(done.body.event.outcome, 'confirmed', JSON.stringify(done.body));
  assert.equal((await db('EventTicket as t').join('EventRegistration as r', 'r.id', 't.registrationId').where('r.orderId', orderId)).length, 2);
  assert.equal((await h.notifications(req.memberId, 'event_payment_confirmed')).length, 1, 'the coordinator is told');
  const confirmed = (await call(getB2BEventOrder, finance, { params: { id: org.id, orderId } })).body;
  assert.equal(confirmed.order.status, 'confirmed');
  assert.ok(confirmed.registrations.every(r => r.ticket === null), 'an organisation never sees a ticket');
  assert.ok(confirmed.registrations.every(r => r.invitation && 'sentAt' in r.invitation));
  assert.ok(confirmed.allowedActions.includes('cancel_refund'));
  // provider (mobile prompt) mode is never offered to an organisation: the notice stays manual even when Tunzaa mode is on
  void f;
});

test('corporate cancel of a PAID order: preview, expectedRefundTzs, the refund goes to the organisation (memberId = coordinator, organizationId set); resend is for billing roles only', async () => {
  const { f, org, finance, orderId, total } = await corporateOrder(2);
  await db('EventOrder').where({ id: orderId }).update({ status: 'awaiting_payment' });
  const sent = await payOrg(org, finance, orderId, { method: 'mobile_money', reference: txId(), paidOn: today() });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  const a = await admin();
  const req = await db('PaymentRequest').where({ eventOrderId: orderId }).first();
  assert.equal((await call(adminDecidePaymentRequest, a, { params: { id: req.id }, body: { decision: 'approve', amountTzs: total } })).body.event.outcome, 'confirmed');
  await db('Event').where({ id: f.event.id }).update({ refundPolicySnapshot: JSON.stringify({ preset: 'refund_until_close' }) });
  const hr = await org.member('hr');
  const prev = await call(b2bEventOrderCancelPreview, finance, { params: { id: org.id, orderId } });
  assert.deepEqual([prev.body.mode, prev.body.refundTzs, prev.body.eligible], ['auto', total, true], JSON.stringify(prev.body));
  assert.equal((await call(b2bEventOrderCancelPreview, hr, { params: { id: org.id, orderId } })).status, 403);
  assert.equal((await call(cancelB2BEventOrder, finance, { params: { id: org.id, orderId }, body: { reason: 'other' } })).body.error, 'expected_refund_required');
  const r = await call(cancelB2BEventOrder, finance, { params: { id: org.id, orderId }, body: { reason: 'other', expectedRefundTzs: total } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const refund = await db('Refund').where({ eventOrderId: orderId }).first();
  assert.deepEqual([refund.scope, refund.amountTzs, refund.organizationId, refund.memberId, refund.status], ['order', total, org.id, req.memberId, 'approved']);
  const second = await admin();
  assert.equal((await call(adminMarkRefundPaid, second, { params: { id: refund.id }, body: { paymentReference: 'CRDB-OUT-1' } })).status, 200);
  assert.equal((await db('EventOrder').where({ id: orderId }).first()).status, 'refunded');
  void adminDecideRefund;
});

test('claim invitations (D15): sent only after the order is confirmed, one per unclaimed non-self place, a fresh link each; resend invalidates the old link and is capped; a send failure never undoes the confirmation', async () => {
  s4On(); await saveManualDetails();
  const f = await eventOf();
  const sentSms = [];
  let smsOk = true;
  const senders = {
    sms: () => ({ configured: true, send: async (to, { text }) => { if (!smsOk) return { ok: false, error: 'down' }; sentSms.push({ to, text }); return { ok: true }; } }),
    email: () => ({ configured: false }),
  };
  // a registration + payment stack with fake senders over the same database
  let payments2;
  const registration2 = createEventsRegistrationService({ db, eventStore, catalogue: eventCatalogueStore, users, verifiedContacts, senders, getPayments: () => payments2, getRefunds: () => eventsRefundsService, shareBase: () => 'https://app.test' });
  payments2 = createEventsPaymentService({
    db, eventStore, money: eventMoneyStore, registration: registration2, users, references: paymentReferenceStore,
    manualPayment: { required: () => true, options: () => ({ enabled: true, lipaNamba: '5123456', accountName: 'FitFlex', referenceRequired: true, payerPhoneRequired: true }) },
    flags: { manual: () => true, tunzaa: () => false },
  });
  const b = await member();
  const friendPhone = phone(); const noContact = null;
  const participants = [
    { ticketTypeId: f.ticket.id, firstName: 'Neema', lastName: 'Abdallah', phone: b.phone, consentBasis: 'self' },
    { ticketTypeId: f.ticket.id, firstName: 'Zawadi', lastName: 'Mollel', phone: friendPhone, consentBasis: 'purchaser_authorised' },
  ];
  void noContact;
  const body = { eventId: f.event.id, lines: [{ ticketTypeId: f.ticket.id, quantity: 2 }], acceptedTerms: true, consentTextVersion: '2026-10-draft', participants };
  const q = await call(quoteEventOrder, b.claims, { body });
  const o = (await call(createEventOrder, b.claims, { headers: { 'Idempotency-Key': key() }, body: { ...body, expectedTotalTzs: q.body.quote.totalTzs } })).body;
  // nothing is sent before payment
  assert.equal(sentSms.length, 0);
  assert.equal((await registration2.inviteClaims({ orderId: o.order.id })).error, 'order_not_confirmed');
  const p = await payments2.initiate({ userId: b.sub, orderId: o.order.id, body: { reference: txId(), payerPhone: b.phone }, idempotencyKey: key() });
  assert.equal(p.status, 201, JSON.stringify(p));
  assert.equal(sentSms.length, 0, 'a submitted payment sends no invitation');
  const request = await db('PaymentRequest').where({ eventOrderId: o.order.id }).first();
  smsOk = false;   // the send fails: the confirmation still commits
  const first = await payments2.writeEventDecision(request, { status: 'approved', decidedAt: new Date().toISOString(), decidedBy: 'spec', reference: request.memberReference, note: null }, {}, { actorId: 'spec', amountTzs: request.amountTzs });
  assert.equal(first.status, 'approved');
  assert.equal((await db('EventOrder').where({ id: o.order.id }).first()).status, 'confirmed');
  assert.equal(sentSms.length, 0);
  const friendReg = await db('EventRegistration').where({ orderId: o.order.id, consentBasis: 'purchaser_authorised' }).first();
  assert.equal(friendReg.claimInviteCount, 0);
  // the sweep retries once, an hour after confirmation
  smsOk = true;
  await db('EventOrder').where({ id: o.order.id }).update({ confirmedAt: new Date(Date.now() - 2 * H) });
  const swept = await payments2.sweep();
  assert.ok(swept.invited >= 1, JSON.stringify(swept));
  assert.equal(sentSms.length, 1);
  assert.match(sentSms[0].text, /https:\/\/app\.test\/event-claim\/#/);
  assert.equal(sentSms[0].to, friendPhone);
  const hash1 = (await db('EventRegistration').where({ id: friendReg.id }).first()).claimTokenHash;
  assert.ok(hash1);
  assert.equal((await payments2.sweep()).invited, 0, 'retried once only');
  // resend: a fresh link, the old one stops working; the 5-send cap and the per-day cap
  const again = await payments2.resendClaim({ userId: b.sub, orderId: o.order.id, registrationId: friendReg.id });
  assert.deepEqual([again.sent, again.channel, again.invalidatesPreviousLink], [true, 'sms', true]);
  assert.notEqual((await db('EventRegistration').where({ id: friendReg.id }).first()).claimTokenHash, hash1);
  const selfReg = await db('EventRegistration').where({ orderId: o.order.id, consentBasis: 'self' }).first();
  assert.equal((await payments2.resendClaim({ userId: b.sub, orderId: o.order.id, registrationId: selfReg.id })).error, 'not_resendable');
  assert.equal((await payments2.resendClaim({ userId: (await member()).sub, orderId: o.order.id, registrationId: friendReg.id })).error, 'order_not_found');
  assert.equal((await payments2.resendClaim({ userId: b.sub, orderId: o.order.id, registrationId: friendReg.id })).sent, true);
  assert.equal((await payments2.resendClaim({ userId: b.sub, orderId: o.order.id, registrationId: friendReg.id })).sent, true);
  const capped = await payments2.resendClaim({ userId: b.sub, orderId: o.order.id, registrationId: friendReg.id });
  assert.deepEqual([capped.status, capped.error], [409, 'resend_limit_reached'], '3 a day per place');
  void resendEventClaimInvitation; void resendB2BEventClaimInvitation; void eventsRegistrationService;
});

// ── Finance ──────────────────────────────────────────────────────────────

test('finance: totals only — paid, refunded, pending, awaiting, commission on money kept (rate stamped at confirmation), expected net, by ticket type; roles, foreign events and privacy', async () => {
  s4On(); await saveManualDetails();
  const f = await eventOf();
  await db('EventOrganizer').where({ id: f.organizer.id }).update({ commissionPct: 10 });
  const a = await admin();
  const buy = async (n) => {
    const b = await member();
    const participants = Array.from({ length: n }, (_, i) => ({ ticketTypeId: f.ticket.id, firstName: ['Neema', 'Zawadi', 'Asha'][i], lastName: 'Mollel', phone: i === 0 ? b.phone : phone(), consentBasis: i === 0 ? 'self' : 'purchaser_authorised' }));
    const body = { eventId: f.event.id, lines: [{ ticketTypeId: f.ticket.id, quantity: n }], acceptedTerms: true, consentTextVersion: '2026-10-draft', participants };
    const q = await call(quoteEventOrder, b.claims, { body });
    const o = (await call(createEventOrder, b.claims, { headers: { 'Idempotency-Key': key() }, body: { ...body, expectedTotalTzs: q.body.quote.totalTzs } })).body;
    const ref = txId();
    await call(payForEventOrder, b.claims, { params: { id: o.order.id }, headers: { 'Idempotency-Key': key() }, body: { reference: ref, payerPhone: b.phone } });
    return { b, o, n, ref };
  };
  const one = await buy(1); const three = await buy(3); const unpaid = await buy(2);
  for (const x of [one, three]) {
    const req = await db('PaymentRequest').where({ eventOrderId: x.o.order.id }).first();
    assert.equal((await call(adminDecidePaymentRequest, a, { params: { id: req.id }, body: { decision: 'approve', amountTzs: 20000 * x.n } })).body.event.outcome, 'confirmed');
  }
  // 60000 paid for 3; a 50% refund would be 30000 (set the policy, cancel two of the three places)
  await db('Event').where({ id: f.event.id }).update({ refundPolicySnapshot: JSON.stringify({ preset: 'tiered', tiers: [{ daysBefore: 60, percent: 100 }, { daysBefore: 20, percent: 50 }] }) });
  const regs3 = await db('EventRegistration').where({ orderId: three.o.order.id }).orderBy('id');
  const { cancelMyEventRegistration } = await import('../functions/events-registration.mjs');
  const c = await call(cancelMyEventRegistration, three.b.claims, { params: { id: regs3[2].id }, body: { reason: 'other', expectedRefundTzs: 10000 } });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.refund.amountTzs, 10000);
  const fin = await call(organizerEventFinance, f.organizer.claims, { params: { id: f.event.id } });
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  const t = fin.body;
  // paid 20000 + 60000; refund pending 10000; awaiting 40000; commission 10% of (80000 − 10000) = 7000
  assert.deepEqual([t.paidTzs, t.refundedTzs, t.refundPendingTzs, t.awaitingPaymentTzs, t.commissionPct, t.commissionTzs, t.expectedNetTzs], [80000, 0, 10000, 40000, 10, 7000, 63000]);
  assert.deepEqual(t.orders, { paid: 2, refunded: 0, partlyRefunded: 0 });
  assert.deepEqual(t.settlement, { state: 'not_started' });
  assert.deepEqual(t.byTicketType.map(x => [x.name, x.sold, x.grossTzs]), [['Corporate', 3, 80000]]);
  // pay out the refund: refunded 10000, pending 0, the order is partly refunded
  const rf = await db('Refund').where({ eventOrderId: three.o.order.id }).first();
  const second = await admin();
  await call(adminDecideRefund, a, { params: { id: rf.id }, body: { decision: 'approve' } }).catch(() => {});
  if ((await db('Refund').where({ id: rf.id }).first()).status === 'approved') assert.equal((await call(adminMarkRefundPaid, second, { params: { id: rf.id }, body: { paymentReference: 'OUT-1' } })).status, 200);
  const t2 = (await call(organizerEventFinance, f.organizer.claims, { params: { id: f.event.id } })).body;
  assert.deepEqual([t2.refundedTzs, t2.refundPendingTzs, t2.commissionTzs, t2.expectedNetTzs, t2.orders.partlyRefunded], [10000, 0, 7000, 63000, 1]);
  // roles: finance / owner / admin read; ops and timing do not; another organizer's event is 404; the admin twin adds more
  const finance = await f.organizer.staff('finance'); const ops = await f.organizer.staff('ops'); const timing = await f.organizer.staff('timing'); const admin_ = await f.organizer.staff('admin');
  assert.equal((await call(organizerEventFinance, finance, { params: { id: f.event.id } })).status, 200);
  assert.equal((await call(organizerEventFinance, admin_, { params: { id: f.event.id } })).status, 200);
  for (const c_ of [ops, timing]) assert.deepEqual([(await call(organizerEventFinance, c_, { params: { id: f.event.id } })).status, (await call(organizerEventFinance, c_, { params: { id: f.event.id } })).body.error], [403, 'forbidden_role']);
  const other = await eventOf();
  assert.deepEqual((await call(organizerEventFinance, f.organizer.claims, { params: { id: other.event.id } })).body, { error: 'event_not_found' });
  const adm = (await call(adminEventFinance, a, { params: { id: f.event.id } })).body;
  assert.deepEqual([adm.paidTzs, adm.unfulfilledTzs, adm.openReconciliations], [80000, 0, 0]);
  // privacy: a snapshot of every key an organizer can read about money — no payer fields anywhere
  const text = JSON.stringify([t, t2, (await call(organizerListOrders, f.organizer.claims, { params: { id: f.event.id } })).body]);
  for (const forbidden of ['payerPhone', 'memberReference', 'paidTo', 'paymentReference', 'rejectCode', 'payerMethod', 'paymentMethod', one.b.phone, three.b.phone, one.ref, three.ref, unpaid.ref]) assert.ok(!text.includes(forbidden), forbidden);
  void adminGetEventOrder; void adminCancelEventOrder; void eventsRegistrationService;
});

test('the admin order panel: full payer phone with the payments scope, masked without; tickets counted, never a token; refunds listed', async () => {
  s4On(); await saveManualDetails();
  const f = await eventOf();
  const b = await member();
  const body = { eventId: f.event.id, lines: [{ ticketTypeId: f.ticket.id, quantity: 1 }], acceptedTerms: true, consentTextVersion: '2026-10-draft', participants: [{ ticketTypeId: f.ticket.id, firstName: 'Neema', lastName: 'Abdallah', phone: b.phone, consentBasis: 'self' }] };
  const q = await call(quoteEventOrder, b.claims, { body });
  const o = (await call(createEventOrder, b.claims, { headers: { 'Idempotency-Key': key() }, body: { ...body, expectedTotalTzs: q.body.quote.totalTzs } })).body;
  await call(payForEventOrder, b.claims, { params: { id: o.order.id }, headers: { 'Idempotency-Key': key() }, body: { reference: txId(), payerPhone: b.phone } });
  const a = await admin();
  const req = await db('PaymentRequest').where({ eventOrderId: o.order.id }).first();
  await call(adminDecidePaymentRequest, a, { params: { id: req.id }, body: { decision: 'approve', amountTzs: 20000 } });
  const full = await call(adminGetEventOrder, a, { params: { id: f.event.id, orderId: o.order.id } });
  assert.equal(full.status, 200, JSON.stringify(full.body));
  assert.equal(full.body.paymentPanel.payments[0].payerPhone, b.phone);
  assert.deepEqual([full.body.paymentPanel.tickets.issued, full.body.paymentPanel.tickets.cancelled], [1, 0]);
  assert.ok(!JSON.stringify(full.body).includes('ev1.'));
  assert.deepEqual(full.body.allowedActions, ['cancel']);
  // an events-scope admin without the payments scope sees the phone masked
  const scoped = { ...await admin(), portalUser: true, aclPermissions: ['events'] };
  await db('User').where({ id: scoped.sub }).update({ aclPermissions: JSON.stringify(['events']) }).catch(() => {});
  const masked = await call(adminGetEventOrder, scoped, { params: { id: f.event.id, orderId: o.order.id } });
  assert.equal(masked.status, 200, JSON.stringify(masked.body));
  assert.ok(masked.body.paymentPanel.payments[0].payerPhone.includes('•'));
  assert.ok(!JSON.stringify(masked.body.paymentPanel).includes(b.phone));
  void payB2BEventOrder; void getB2BEventOrder;
});
