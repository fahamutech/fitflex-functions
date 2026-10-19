// A1 · second approver on money (MONEY_SECOND_APPROVER). Owner decisions 2026-10-19:
//   - payments: one admin verifies a manual payment, a different admin approves it;
//   - a decided payment changes only by request, confirmed by a different admin;
//   - member-raised refund: one admin approves, a different admin marks it paid;
//   - admin-raised refund: the raiser cannot approve, the approver cannot mark it paid.
// With the flag off nothing changes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAdminPaymentService } from '../src/services/admin-payment-service.mjs';
import { createRefundService } from '../src/services/refund-service.mjs';
import { moneySecondApproverOn } from '../src/shared/feature-flags.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { ensureInit } from '../functions/index.mjs';
import {
  adminPaymentRequests, adminDecidePaymentRequest, adminUpdatePaymentRequest,
  adminVerifyPaymentRequest, adminRequestPaymentChange, adminConfirmPaymentChange, adminCancelPaymentChange,
} from '../functions/admin-payments.mjs';
import { adminRaiseRefund, adminDecideRefund, adminMarkRefundPaid, adminListRefunds } from '../functions/refunds.mjs';

await ensureInit();

function memStore(rows = []) {
  return {
    rows,
    async allAsync() { return [...rows]; },
    async findAsync(fn) { return rows.find(fn) || null; },
    async findByIdAsync(id) { return rows.find(r => r.id === id) || null; },
    async filterByColumnAsync(col, value) { return rows.filter(r => r[col] === value); },
    async filterByColumnInAsync(col, ids) { return rows.filter(r => ids.includes(r[col])); },
    async insertAsync(row) { rows.push(row); return row; },
    async updateByIdAsync(id, patch) {
      const i = rows.findIndex(r => r.id === id);
      if (i >= 0) rows[i] = { ...rows[i], ...patch };
      return rows[i] || null;
    },
  };
}

const DAY = 86_400_000;
const pendingSub = () => ({
  id: 'sub1', memberId: 'm1', type: 'platform_pass', tier: 'basic', status: 'payment_pending',
  startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * DAY).toISOString(),
});

function payments(flag, rows = {}) {
  const paymentRequests = memStore([{
    id: 'pr1', memberId: 'm1', subscriptionId: 'sub1', tier: 'basic', amountTzs: 60_000, status: 'pending',
    provider: 'admin_approved', reference: 'MPESA1', requestedAt: new Date().toISOString(), ...rows,
  }]);
  const subscriptions = memStore([pendingSub()]);
  const auditLog = memStore();
  const activated = [];
  const reversed = [];
  const svc = createAdminPaymentService({
    paymentRequests, subscriptions, users: memStore([{ id: 'm1', displayName: 'Asha' }]), auditLog,
    onSubscriptionActivated: async s => { activated.push(s.id); },
    onSubscriptionPaymentReversed: async s => { reversed.push(s.status); },
    secondApprover: () => flag,
  });
  return { svc, paymentRequests, subscriptions, auditLog, activated, reversed, row: () => paymentRequests.rows[0] };
}

// ── Flag ─────────────────────────────────────────────────────────────────────

test('flag: MONEY_SECOND_APPROVER is off unless set', () => {
  const was = process.env.MONEY_SECOND_APPROVER;
  try {
    delete process.env.MONEY_SECOND_APPROVER;
    assert.equal(moneySecondApproverOn(), false);
    process.env.MONEY_SECOND_APPROVER = 'false';
    assert.equal(moneySecondApproverOn(), false);
    process.env.MONEY_SECOND_APPROVER = 'on';
    assert.equal(moneySecondApproverOn(), true);
  } finally {
    if (was === undefined) delete process.env.MONEY_SECOND_APPROVER; else process.env.MONEY_SECOND_APPROVER = was;
  }
});

// ── Payments, flag off ───────────────────────────────────────────────────────

test('payments, flag off: one admin approves, update changes any status, no new list fields', async () => {
  const p = payments(false);
  const out = await p.svc.decide({ id: 'pr1', decision: 'approve', actorId: 'a1' });
  assert.equal(out.paymentRequest.status, 'approved');
  assert.deepEqual(p.activated, ['sub1']);
  const back = await p.svc.update({ id: 'pr1', status: 'rejected', actorId: 'a1' });
  assert.equal(back.paymentRequest.status, 'rejected');
  assert.equal(p.subscriptions.rows[0].status, 'payment_rejected');
  const [row] = await p.svc.list();
  assert.equal('approvalStage' in row, false);
  assert.equal('secondApproverRequired' in row, false);
  for (const fn of ['verify', 'requestChange', 'confirmChange', 'cancelChange']) {
    const r = await p.svc[fn]({ id: 'pr1', status: 'approved', reason: 'x', actorId: 'a2' });
    assert.deepEqual(r, { error: 'feature_disabled', status: 404 }, fn);
  }
});

// ── Payments, flag on ────────────────────────────────────────────────────────

test('payments, flag on: approve needs a verification', async () => {
  const p = payments(true);
  assert.deepEqual(await p.svc.decide({ id: 'pr1', decision: 'approve', actorId: 'a1' }), { error: 'verification_required', status: 409 });
  assert.deepEqual(await p.svc.update({ id: 'pr1', status: 'approved', actorId: 'a1' }), { error: 'verification_required', status: 409 });
  assert.equal(p.row().status, 'pending');
  assert.deepEqual(p.activated, []);
  assert.equal((await p.svc.list())[0].approvalStage, 'awaiting_verification');
});

test('payments, flag on: the verifier cannot approve; a different admin can, and the plan activates', async () => {
  const p = payments(true);
  const v = await p.svc.verify({ id: 'pr1', reference: 'MPESA-XYZ', actorId: 'a1' });
  assert.equal(v.paymentRequest.verifiedBy, 'a1');
  assert.ok(v.paymentRequest.verifiedAt);
  assert.equal(v.paymentRequest.reference, 'MPESA-XYZ');
  assert.equal(v.paymentRequest.status, 'pending');
  assert.equal(p.auditLog.rows.at(-1).action, 'payment_verified');
  assert.equal(p.auditLog.rows.at(-1).actor, 'a1');

  const [listed] = await p.svc.list();
  assert.equal(listed.secondApproverRequired, true);
  assert.equal(listed.approvalStage, 'awaiting_second_approval');
  assert.equal(listed.approveNotBy, 'a1');

  assert.deepEqual(await p.svc.verify({ id: 'pr1', actorId: 'a2' }), { error: 'already_verified', status: 409, verifiedBy: 'a1' });
  assert.deepEqual(await p.svc.decide({ id: 'pr1', decision: 'approve', actorId: 'a1' }), { error: 'cannot_approve_own_verification', status: 403 });
  assert.deepEqual(await p.svc.update({ id: 'pr1', status: 'approved', actorId: 'a1' }), { error: 'cannot_approve_own_verification', status: 403 });
  assert.deepEqual(p.activated, []);

  // the approver approves what was verified, not a different reference
  assert.deepEqual(await p.svc.decide({ id: 'pr1', decision: 'approve', reference: 'OTHER', actorId: 'a2' }), { error: 'reference_differs_from_verification', status: 409 });
  assert.deepEqual(await p.svc.update({ id: 'pr1', reference: 'OTHER', actorId: 'a1' }), { error: 'reference_differs_from_verification', status: 409 });
  const ok = await p.svc.decide({ id: 'pr1', decision: 'approve', reference: 'MPESA-XYZ', actorId: 'a2' });
  assert.equal(ok.paymentRequest.status, 'approved');
  assert.equal(ok.paymentRequest.reference, 'MPESA-XYZ');
  assert.equal(ok.paymentRequest.decidedBy, 'a2');
  assert.equal(ok.paymentRequest.verifiedBy, 'a1');
  assert.equal(p.subscriptions.rows[0].status, 'active');
  assert.deepEqual(p.activated, ['sub1']);
  assert.equal(p.auditLog.rows.at(-1).action, 'payment_approved');
  assert.equal((await p.svc.list())[0].approvalStage, null);
});

test('payments, flag on: approving through update by a different admin works too', async () => {
  const p = payments(true);
  await p.svc.verify({ id: 'pr1', actorId: 'a1' });
  const ok = await p.svc.update({ id: 'pr1', status: 'approved', actorId: 'a2' });
  assert.equal(ok.paymentRequest.status, 'approved');
  assert.deepEqual(p.activated, ['sub1']);
});

test('payments, flag on: verify refuses a decided payment', async () => {
  const p = payments(true, { status: 'rejected' });
  assert.deepEqual(await p.svc.verify({ id: 'pr1', actorId: 'a1' }), { error: 'already_decided', status: 409 });
  assert.deepEqual(await p.svc.verify({ id: 'nope', actorId: 'a1' }), { error: 'not_found', status: 404 });
});

test('payments, flag on: rejecting a pending payment stays single-admin (no money moves)', async () => {
  const p = payments(true);
  const out = await p.svc.decide({ id: 'pr1', decision: 'reject', note: 'no money seen', actorId: 'a1' });
  assert.equal(out.paymentRequest.status, 'rejected');
  assert.equal(p.subscriptions.rows[0].status, 'payment_rejected');
  const p2 = payments(true);
  assert.equal((await p2.svc.update({ id: 'pr1', status: 'cancelled', actorId: 'a1' })).paymentRequest.status, 'cancelled');
});

test('payments, flag on: provider-confirmed (automated) approvals are not held for a second admin', async () => {
  const p = payments(true);
  const out = await p.svc.decide({ id: 'pr1', decision: 'approve', reference: 'TZ1', actorId: 'tunzaa', automated: true });
  assert.equal(out.paymentRequest.status, 'approved');
  assert.deepEqual(p.activated, ['sub1']);
});

test('payments, flag on: a decided payment cannot be changed directly', async () => {
  const p = payments(true, { status: 'approved', decidedBy: 'a2', decidedAt: new Date().toISOString() });
  for (const status of ['pending', 'rejected', 'cancelled']) {
    assert.deepEqual(await p.svc.update({ id: 'pr1', status, actorId: 'a1' }), { error: 'change_requires_confirmation', status: 409 }, status);
  }
  assert.deepEqual(await p.svc.update({ id: 'pr1', reference: 'OTHER', actorId: 'a1' }), { error: 'change_requires_confirmation', status: 409 });
  // a note is still editable and keeps who decided it
  const note = await p.svc.update({ id: 'pr1', note: 'checked statement', actorId: 'a1' });
  assert.equal(note.paymentRequest.note, 'checked statement');
  assert.equal(note.paymentRequest.status, 'approved');
  assert.equal(note.paymentRequest.decidedBy, 'a2');
});

test('payments, flag on: request a change, the requester cannot confirm, a different admin can', async () => {
  const p = payments(true, { status: 'approved', decidedBy: 'a2', decidedAt: new Date().toISOString(), verifiedBy: 'a1' });
  p.subscriptions.rows[0].status = 'active';

  assert.deepEqual(await p.svc.requestChange({ id: 'pr1', status: 'rejected', actorId: 'a1' }), { error: 'reason_required', status: 400 });
  assert.equal((await p.svc.requestChange({ id: 'pr1', status: 'bogus', reason: 'x', actorId: 'a1' })).error, 'invalid_status');
  assert.deepEqual(await p.svc.requestChange({ id: 'pr1', status: 'approved', reason: 'x', actorId: 'a1' }), { error: 'no_change', status: 400 });

  const req = await p.svc.requestChange({ id: 'pr1', status: 'rejected', reason: 'bounced', actorId: 'a1' });
  assert.equal(req.paymentRequest.status, 'approved', 'nothing changes yet');
  assert.equal(req.paymentRequest.changeRequestedStatus, 'rejected');
  assert.equal(req.paymentRequest.changeRequestedBy, 'a1');
  assert.equal(req.paymentRequest.changeRequestReason, 'bounced');
  assert.ok(req.paymentRequest.changeRequestedAt);
  assert.equal(p.subscriptions.rows[0].status, 'active');
  assert.equal(p.auditLog.rows.at(-1).action, 'payment_change_requested');

  const [listed] = await p.svc.list();
  assert.equal(listed.approvalStage, 'change_requested');
  assert.equal(listed.confirmChangeNotBy, 'a1');

  assert.equal((await p.svc.requestChange({ id: 'pr1', status: 'cancelled', reason: 'y', actorId: 'a3' })).error, 'change_already_requested');
  assert.deepEqual(await p.svc.confirmChange({ id: 'pr1', actorId: 'a1' }), { error: 'cannot_confirm_own_request', status: 403 });

  const done = await p.svc.confirmChange({ id: 'pr1', actorId: 'a3' });
  assert.equal(done.paymentRequest.status, 'rejected');
  assert.equal(done.paymentRequest.decidedBy, 'a3');
  assert.equal(done.paymentRequest.changeRequestedBy, null);
  assert.equal(p.subscriptions.rows[0].status, 'payment_rejected');
  assert.deepEqual(p.reversed, ['payment_rejected']);
  const entry = p.auditLog.rows.at(-1);
  assert.equal(entry.action, 'payment_change_confirmed');
  assert.equal(entry.actor, 'a3');
  assert.equal(entry.after.requestedBy, 'a1');
  assert.equal(entry.after.reason, 'bounced');
  assert.deepEqual(await p.svc.confirmChange({ id: 'pr1', actorId: 'a3' }), { error: 'change_not_requested', status: 409 });
});

test('payments, flag on: back to pending clears the verification; rejected → approved activates via confirm', async () => {
  const p = payments(true, { status: 'approved', decidedBy: 'a2', verifiedBy: 'a1', verifiedAt: new Date().toISOString() });
  await p.svc.requestChange({ id: 'pr1', status: 'pending', reason: 'wrong member', actorId: 'a1' });
  const back = await p.svc.confirmChange({ id: 'pr1', actorId: 'a2' });
  assert.equal(back.paymentRequest.status, 'pending');
  assert.equal(back.paymentRequest.verifiedBy, null);
  assert.equal(back.paymentRequest.decidedBy, null);

  const r = payments(true, { status: 'rejected', decidedBy: 'a2' });
  await r.svc.requestChange({ id: 'pr1', status: 'approved', reason: 'money found', actorId: 'a1' });
  const ok = await r.svc.confirmChange({ id: 'pr1', actorId: 'a2' });
  assert.equal(ok.paymentRequest.status, 'approved');
  assert.equal(r.subscriptions.rows[0].status, 'active');
  assert.deepEqual(r.activated, ['sub1']);
});

test('payments, flag on: a change request can be withdrawn; pending and order payments cannot be requested', async () => {
  const p = payments(true, { status: 'cancelled', decidedBy: 'a2' });
  assert.deepEqual(await p.svc.cancelChange({ id: 'pr1', actorId: 'a1' }), { error: 'change_not_requested', status: 409 });
  await p.svc.requestChange({ id: 'pr1', status: 'pending', reason: 'oops', actorId: 'a1' });
  const c = await p.svc.cancelChange({ id: 'pr1', reason: 'not needed', actorId: 'a1' });
  assert.equal(c.paymentRequest.changeRequestedBy, null);
  assert.equal(c.paymentRequest.status, 'cancelled');
  assert.equal(p.auditLog.rows.at(-1).action, 'payment_change_request_cancelled');

  const pend = payments(true);
  assert.equal((await pend.svc.requestChange({ id: 'pr1', status: 'rejected', reason: 'x', actorId: 'a1' })).error, 'not_decided');
  const order = payments(true, { status: 'approved', orderId: 'ord1', subscriptionId: null });
  assert.equal((await order.svc.requestChange({ id: 'pr1', status: 'rejected', reason: 'x', actorId: 'a1' })).error, 'payment_already_confirmed');
});

// ── Refunds ──────────────────────────────────────────────────────────────────

function refundsFixture(flag) {
  const refunds = memStore();
  const paymentRequests = memStore([{ id: 'pr1', memberId: 'm1', subscriptionId: 'sub1', amountTzs: 60_000, status: 'approved' }]);
  const auditLog = memStore();
  const svc = createRefundService({
    refunds, paymentRequests, subscriptions: memStore([{ id: 'sub1' }]), users: memStore([{ id: 'm1', displayName: 'Asha' }]),
    auditLog, secondApprover: () => flag,
  });
  return { svc, refunds, auditLog };
}

test('refunds, flag off: admin-raised is approved at once and the same admin can mark it paid', async () => {
  const f = refundsFixture(false);
  const { refund } = await f.svc.adminRaise({ body: { paymentRequestId: 'pr1' }, actorId: 'a1' });
  assert.equal(refund.status, 'approved');
  assert.equal(refund.decidedBy, 'policy');
  const paid = await f.svc.markPaid({ id: refund.id, body: { paymentReference: 'R1' }, actorId: 'a1' });
  assert.equal(paid.refund.status, 'paid');

  const g = refundsFixture(false);
  const m = await g.svc.requestForPayment({ memberId: 'm1', body: { paymentRequestId: 'pr1', reasonCode: 'charged_twice' } });
  await g.svc.decide({ id: m.refund.id, body: { decision: 'approve' }, actorId: 'a1' });
  assert.equal((await g.svc.markPaid({ id: m.refund.id, body: { paymentReference: 'R2' }, actorId: 'a1' })).refund.status, 'paid');
  assert.equal('approvalStage' in (await g.svc.adminList()).refunds[0], false);
});

test('refunds, flag on: admin-raised waits; the raiser cannot approve; the approver cannot pay', async () => {
  const f = refundsFixture(true);
  const { refund } = await f.svc.adminRaise({ body: { paymentRequestId: 'pr1' }, actorId: 'a1' });
  assert.equal(refund.status, 'requested');
  assert.equal(refund.requestedBy, 'a1');
  assert.equal(refund.requestedRole, 'admin');
  let [row] = (await f.svc.adminList()).refunds;
  assert.equal(row.secondApproverRequired, true);
  assert.equal(row.approvalStage, 'awaiting_approval');
  assert.equal(row.approveNotBy, 'a1');

  assert.deepEqual(await f.svc.decide({ id: refund.id, body: { decision: 'approve' }, actorId: 'a1' }), { error: 'cannot_approve_own_request', status: 403 });
  assert.equal((await f.svc.markPaid({ id: refund.id, body: { paymentReference: 'R1' }, actorId: 'a2' })).error, 'refund_not_approved');

  const ok = await f.svc.decide({ id: refund.id, body: { decision: 'approve' }, actorId: 'a2' });
  assert.equal(ok.refund.status, 'approved');
  [row] = (await f.svc.adminList()).refunds;
  assert.equal(row.approvalStage, 'awaiting_payment');
  assert.equal(row.payNotBy, 'a2');

  assert.deepEqual(await f.svc.markPaid({ id: refund.id, body: { paymentReference: 'R1' }, actorId: 'a2' }), { error: 'cannot_pay_own_approval', status: 403 });
  const paid = await f.svc.markPaid({ id: refund.id, body: { paymentReference: 'R1' }, actorId: 'a1' });
  assert.equal(paid.refund.status, 'paid');
  assert.equal(paid.refund.paidBy, 'a1');
  assert.deepEqual(f.auditLog.rows.map(r => r.action), ['refund_raised', 'refund_approved', 'refund_paid']);
});

test('refunds, flag on: the raiser may reject (withdraw) their own refund', async () => {
  const f = refundsFixture(true);
  const { refund } = await f.svc.adminRaise({ body: { paymentRequestId: 'pr1' }, actorId: 'a1' });
  const out = await f.svc.decide({ id: refund.id, body: { decision: 'reject', note: 'raised by mistake' }, actorId: 'a1' });
  assert.equal(out.refund.status, 'rejected');
});

test('refunds, flag on: member-raised — one admin approves, a different admin pays; policy refunds payable by anyone', async () => {
  const f = refundsFixture(true);
  const m = await f.svc.requestForPayment({ memberId: 'm1', body: { paymentRequestId: 'pr1', reasonCode: 'charged_twice' } });
  await f.svc.decide({ id: m.refund.id, body: { decision: 'approve' }, actorId: 'a1' });
  assert.equal((await f.svc.markPaid({ id: m.refund.id, body: { paymentReference: 'R' }, actorId: 'a1' })).error, 'cannot_pay_own_approval');
  assert.equal((await f.svc.markPaid({ id: m.refund.id, body: { paymentReference: 'R' }, actorId: 'a2' })).refund.status, 'paid');

  const g = refundsFixture(true);
  const pol = await g.svc.raise({ memberId: 'm1', kind: 'trainer_booking', sourceId: 'b1', amountTzs: 10_000, reasonCode: 'trainer_cancelled', approved: true });
  assert.equal(pol.refund.decidedBy, 'policy');
  const [row] = (await g.svc.adminList()).refunds;
  assert.equal(row.payNotBy, null);
  assert.equal((await g.svc.markPaid({ id: pol.refund.id, body: { paymentReference: 'R' }, actorId: 'a1' })).refund.status, 'paid');
});

// ── Database + endpoints (isolated CI DB) ────────────────────────────────────

const made = { users: [], subs: [], payments: [], refunds: [] };
after(async () => {
  delete process.env.MONEY_SECOND_APPROVER;
  await db('AuditLog').whereIn('target', [...made.payments, ...made.refunds]).del();
  await db('Refund').whereIn('id', made.refunds).del();
  await db('Refund').whereIn('paymentRequestId', made.payments).del();
  await db('PaymentRequest').whereIn('id', made.payments).del();
  await db('Subscription').whereIn('id', made.subs).del();
  await db('User').whereIn('id', made.users).del();
});

async function dbPayment() {
  const memberId = `u_a1_${randomUUID().slice(0, 8)}`;
  const subId = `sub_a1_${randomUUID().slice(0, 8)}`;
  const prId = `pr_a1_${randomUUID().slice(0, 8)}`;
  const now = new Date();
  await db('User').insert({ id: memberId, userType: 'member', displayName: 'A1 member', updatedAt: now });
  await db('Subscription').insert({ id: subId, memberId, type: 'platform_pass', tier: 'basic', status: 'payment_pending',
    startedAt: now, cycleStartedAt: now, renewsAt: new Date(+now + 30 * DAY), expiresAt: new Date(+now + 30 * DAY) });
  await db('PaymentRequest').insert({ id: prId, memberId, subscriptionId: subId, tier: 'basic', amountTzs: 60_000, status: 'pending', provider: 'admin_approved', reference: 'DB-REF' });
  made.users.push(memberId); made.subs.push(subId); made.payments.push(prId);
  return { memberId, subId, prId };
}

/** Call an endpoint object the way the server does. */
async function call(endpoint, { params = {}, body = {}, query = {}, sub }) {
  let code = 200; let payload;
  const res = { status(c) { code = c; return res; }, json(b) { payload = b; return res; } };
  await endpoint.onRequest({ params, body, query, user: { sub } }, res);
  return { code, body: payload };
}

test('db: the migration added the PaymentRequest columns', async () => {
  for (const c of ['verifiedBy', 'verifiedAt', 'changeRequestedStatus', 'changeRequestedBy', 'changeRequestedAt', 'changeRequestReason']) {
    assert.equal(await db.schema.hasColumn('PaymentRequest', c), true, c);
  }
});

test('db + endpoints, flag off: new endpoints answer 404 feature_disabled; decision works as before', async () => {
  delete process.env.MONEY_SECOND_APPROVER;
  const { prId, subId } = await dbPayment();
  const v = await call(adminVerifyPaymentRequest, { params: { id: prId }, sub: 'adm_1' });
  assert.deepEqual(v, { code: 404, body: { error: 'feature_disabled' } });
  const d = await call(adminDecidePaymentRequest, { params: { id: prId }, body: { decision: 'approve' }, sub: 'adm_1' });
  assert.equal(d.code, 200);
  assert.equal(d.body.status, 'approved');
  assert.equal((await db('Subscription').where({ id: subId }).first()).status, 'active');
});

test('db + endpoints, flag on: verify → approve by another admin → change request → confirm', async () => {
  process.env.MONEY_SECOND_APPROVER = 'on';
  try {
    const { prId, subId } = await dbPayment();
    const early = await call(adminDecidePaymentRequest, { params: { id: prId }, body: { decision: 'approve' }, sub: 'adm_1' });
    assert.deepEqual(early, { code: 409, body: { error: 'verification_required' } });

    const v = await call(adminVerifyPaymentRequest, { params: { id: prId }, body: { reference: 'MP-DB-1' }, sub: 'adm_1' });
    assert.equal(v.code, 200);
    assert.equal(v.body.verifiedBy, 'adm_1');
    assert.ok(v.body.verifiedAt);
    const stored = await db('PaymentRequest').where({ id: prId }).first();
    assert.equal(stored.verifiedBy, 'adm_1');
    assert.equal(stored.reference, 'MP-DB-1');

    const listed = (await call(adminPaymentRequests, { sub: 'adm_2' })).body.find(r => r.id === prId);
    assert.equal(listed.approvalStage, 'awaiting_second_approval');
    assert.equal(listed.approveNotBy, 'adm_1');

    const own = await call(adminDecidePaymentRequest, { params: { id: prId }, body: { decision: 'approve' }, sub: 'adm_1' });
    assert.deepEqual(own, { code: 403, body: { error: 'cannot_approve_own_verification' } });
    const ok = await call(adminDecidePaymentRequest, { params: { id: prId }, body: { decision: 'approve' }, sub: 'adm_2' });
    assert.equal(ok.code, 200);
    assert.equal(ok.body.status, 'approved');
    assert.equal((await db('Subscription').where({ id: subId }).first()).status, 'active');

    const direct = await call(adminUpdatePaymentRequest, { params: { id: prId }, body: { status: 'cancelled' }, sub: 'adm_1' });
    assert.deepEqual(direct, { code: 409, body: { error: 'change_requires_confirmation' } });

    const rq = await call(adminRequestPaymentChange, { params: { id: prId }, body: { status: 'cancelled', reason: 'duplicate' }, sub: 'adm_1' });
    assert.equal(rq.code, 200);
    assert.equal(rq.body.changeRequestedBy, 'adm_1');
    const self = await call(adminConfirmPaymentChange, { params: { id: prId }, sub: 'adm_1' });
    assert.deepEqual(self, { code: 403, body: { error: 'cannot_confirm_own_request' } });
    const cancelled = await call(adminCancelPaymentChange, { params: { id: prId }, body: { reason: 'try again' }, sub: 'adm_2' });
    assert.equal(cancelled.body.changeRequestedBy, null);
    await call(adminRequestPaymentChange, { params: { id: prId }, body: { status: 'cancelled', reason: 'duplicate' }, sub: 'adm_1' });
    const conf = await call(adminConfirmPaymentChange, { params: { id: prId }, sub: 'adm_2' });
    assert.equal(conf.code, 200);
    assert.equal(conf.body.status, 'cancelled');
    assert.equal((await db('Subscription').where({ id: subId }).first()).status, 'payment_cancelled');
    const actions = (await db('AuditLog').where({ target: prId }).orderBy('at')).map(r => r.action);
    for (const a of ['payment_verified', 'payment_approved', 'payment_change_requested', 'payment_change_request_cancelled', 'payment_change_confirmed']) {
      assert.ok(actions.includes(a), a);
    }
  } finally {
    delete process.env.MONEY_SECOND_APPROVER;
  }
});

test('db + endpoints, flag on: admin-raised refund needs another admin to approve, a third person not required to pay', async () => {
  process.env.MONEY_SECOND_APPROVER = 'on';
  try {
    const { prId } = await dbPayment();
    await db('PaymentRequest').where({ id: prId }).update({ status: 'approved', decidedBy: 'adm_2', decidedAt: new Date() });
    const raised = await call(adminRaiseRefund, { body: { paymentRequestId: prId }, sub: 'adm_1' });
    assert.equal(raised.code, 201, JSON.stringify(raised.body));
    const id = raised.body.refund.id;
    made.refunds.push(id);
    assert.equal(raised.body.refund.status, 'requested');
    const listed = (await call(adminListRefunds, { query: { status: 'requested' }, sub: 'adm_2' })).body.refunds.find(r => r.id === id);
    assert.equal(listed.approveNotBy, 'adm_1');
    assert.deepEqual(await call(adminDecideRefund, { params: { id }, body: { decision: 'approve' }, sub: 'adm_1' }), { code: 403, body: { error: 'cannot_approve_own_request' } });
    assert.equal((await call(adminDecideRefund, { params: { id }, body: { decision: 'approve' }, sub: 'adm_2' })).body.refund.status, 'approved');
    assert.deepEqual(await call(adminMarkRefundPaid, { params: { id }, body: { paymentReference: 'RF1' }, sub: 'adm_2' }), { code: 403, body: { error: 'cannot_pay_own_approval' } });
    const paid = await call(adminMarkRefundPaid, { params: { id }, body: { paymentReference: 'RF1' }, sub: 'adm_1' });
    assert.equal(paid.body.refund.status, 'paid');
  } finally {
    delete process.env.MONEY_SECOND_APPROVER;
  }
});
