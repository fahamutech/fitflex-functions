// Held payments worklist (admin portal audit M5): money a provider confirmed that no request could
// take is listed from the audit rows, refunded once, and the two-admin rules still apply.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRefundService } from '../src/services/refund-service.mjs';
import { createHeldPaymentsService } from '../src/services/held-payments-service.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { ensureInit } from '../functions/index.mjs';
import { adminHeldPayments, adminRaiseHeldPaymentRefund } from '../functions/admin-held-payments.mjs';

await ensureInit();

function memStore(rows = []) {
  return {
    rows,
    async allAsync() { return rows; },
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

function fixture({ twoAdmins = false, enabled = true } = {}) {
  const refunds = memStore();
  const auditLog = memStore();
  const paymentRequests = memStore([
    { id: 'pr_closed', memberId: 'm1', status: 'cancelled', amountTzs: 50000, productType: 'FITFLEX_PASS', subscriptionId: null },
    { id: 'pr_rejected', memberId: 'm2', status: 'rejected', amountTzs: 30000, productType: 'SHOP_ORDER' },
    { id: 'pr_ok', memberId: 'm3', status: 'approved', amountTzs: 20000, subscriptionId: 'sub1' },
    { id: 'pr_event', memberId: 'm4', status: 'cancelled', amountTzs: 10000, eventOrderId: 'evo1' },
  ]);
  const users = memStore([]);
  const refundService = createRefundService({ refunds, paymentRequests, subscriptions: memStore(), users, auditLog, secondApprover: () => twoAdmins });
  const held = createHeldPaymentsService({ auditLog, paymentRequests, refunds, refundService, enabled: () => enabled });
  let n = 0;
  const log = (action, target, after, at) => auditLog.insertAsync({ id: `a${++n}`, at: at ?? `2026-11-0${n}T10:00:00.000Z`, actor: 'system:mobile-money', action, target, before: null, after });
  return { refunds, auditLog, paymentRequests, refundService, held, log };
}
const body = (extra = {}) => ({ transactionId: 'TX1', reasonCode: 'payment_error', ...extra });

test('a payment that arrived for a closed request appears on the open worklist, once however often it was polled', async () => {
  const f = fixture();
  await f.log('payment_mobile_money_orphaned', 'pr_closed', { transactionId: 'TX1', amountTzs: 50000 });
  await f.log('payment_mobile_money_orphaned', 'pr_closed', { transactionId: 'TX1', amountTzs: 50000 });
  await f.log('payment_mobile_money_held', 'pr_rejected', { error: 'reference_already_used', transactionId: 'TX2' });
  await f.log('payment_mobile_money_orphaned', 'pr_ok', { transactionId: 'TX3', amountTzs: 20000 }); // approved since: not held
  const { items } = await f.held.list({});
  assert.equal(items.length, 2);
  const row = items.find(i => i.paymentRequestId === 'pr_closed');
  assert.deepEqual({ ...row, at: undefined }, {
    paymentRequestId: 'pr_closed', transactionId: 'TX1', amountTzs: 50000, memberId: 'm1', reason: 'request_closed', at: undefined,
    refundId: null, requestStatus: 'cancelled', productType: 'FITFLEX_PASS', refundStatus: null,
  });
  assert.equal(row.at, '2026-11-01T10:00:00.000Z');
  const other = items.find(i => i.paymentRequestId === 'pr_rejected');
  assert.equal(other.reason, 'reference_already_used');
  assert.equal(other.amountTzs, 30000); // not in the audit row: the request's own amount
  assert.deepEqual((await f.held.list({ status: 'resolved' })).items, []);
  assert.equal((await f.held.list({ status: 'nope' })).error, 'invalid_status');
});

test('a refund resolves the held row and cannot be raised twice', async () => {
  const f = fixture();
  await f.log('payment_mobile_money_orphaned', 'pr_closed', { transactionId: 'TX1', amountTzs: 50000 });
  const out = await f.held.raiseRefund({ paymentRequestId: 'pr_closed', body: body({ note: 'late money' }), actorId: 'adm1' });
  assert.equal(out.error, undefined);
  assert.equal(out.refund.amountTzs, 50000);
  assert.equal(out.refund.status, 'approved'); // flag off: approved at once, as POST /admin/refunds
  assert.equal(out.refund.paymentRequestId, 'pr_closed');
  assert.equal(out.refund.reasonCode, 'payment_error');
  assert.ok(f.auditLog.rows.some(r => r.action === 'payment_held_refund_raised' && r.target === 'pr_closed' && r.actor === 'adm1' && r.after.transactionId === 'TX1'));
  assert.deepEqual((await f.held.list({})).items, []);
  const resolved = (await f.held.list({ status: 'resolved' })).items;
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].refundId, out.refund.id);
  const again = await f.held.raiseRefund({ paymentRequestId: 'pr_closed', body: body(), actorId: 'adm2' });
  assert.equal(again.error, 'refund_already_requested');
  assert.equal(again.status, 409);
  assert.equal(f.refunds.rows.length, 1);
  // A rejected refund frees the money to be refunded again.
  await f.refunds.updateByIdAsync(out.refund.id, { status: 'rejected' });
  assert.equal((await f.held.list({})).items.length, 1);
});

test('the relaxed rule is only for held rows, and the other checks hold', async () => {
  const f = fixture();
  await f.log('payment_mobile_money_orphaned', 'pr_closed', { transactionId: 'TX1', amountTzs: 50000 });
  await f.log('payment_mobile_money_orphaned', 'pr_ok', { transactionId: 'TX3', amountTzs: 20000 });
  await f.log('payment_mobile_money_orphaned', 'pr_event', { transactionId: 'TX4', amountTzs: 10000 });
  const r = (id, b) => f.held.raiseRefund({ paymentRequestId: id, body: b, actorId: 'adm1' });
  assert.equal((await r('pr_closed', { reasonCode: 'payment_error' })).error, 'transaction_id_required');
  assert.equal((await r('pr_closed', { transactionId: 'TX1' })).error, 'reason_code_required');
  assert.equal((await r('pr_closed', body({ reasonCode: 'bogus' }))).error, 'invalid_reason');
  assert.equal((await r('pr_closed', body({ transactionId: 'OTHER' }))).error, 'not_held');
  assert.equal((await r('pr_closed', body({ amountTzs: 50001 }))).error, 'amount_exceeds_payment');
  assert.equal((await r('pr_rejected', body())).error, 'not_held'); // closed, but nothing was audited for it
  assert.equal((await r('pr_ok', body({ transactionId: 'TX3' }))).error, 'not_held'); // approved: the normal refund route
  assert.equal((await r('pr_event', body({ transactionId: 'TX4' }))).error, 'use_event_refund');
  assert.equal((await r('missing', body())).status, 404);
  assert.equal(f.refunds.rows.length, 0);
  // The normal route is unchanged: a closed request still cannot be refunded through it.
  assert.equal((await f.refundService.adminRaise({ body: { paymentRequestId: 'pr_closed', reasonCode: 'payment_error' }, actorId: 'adm1' })).error, 'cancel_instead');
  assert.equal((await f.refundService.adminRaise({ body: { paymentRequestId: 'pr_rejected', reasonCode: 'payment_error' }, actorId: 'adm1' })).error, 'cancel_instead');
  // A partial amount is allowed up to what was held.
  const part = await r('pr_closed', body({ amountTzs: 20000 }));
  assert.equal(part.refund.amountTzs, 20000);
});

test('MONEY_SECOND_APPROVER on: the raised refund waits for a different admin, who pays it, not the approver', async () => {
  const f = fixture({ twoAdmins: true });
  await f.log('payment_mobile_money_orphaned', 'pr_closed', { transactionId: 'TX1', amountTzs: 50000 });
  const out = await f.held.raiseRefund({ paymentRequestId: 'pr_closed', body: body(), actorId: 'adm1' });
  assert.equal(out.refund.status, 'requested');
  assert.equal(out.refund.requestedRole, 'admin');
  assert.equal((await f.refundService.decide({ id: out.refund.id, body: { decision: 'approve' }, actorId: 'adm1' })).error, 'cannot_approve_own_request');
  assert.equal((await f.refundService.decide({ id: out.refund.id, body: { decision: 'approve' }, actorId: 'adm2' })).refund.status, 'approved');
  assert.equal((await f.refundService.markPaid({ id: out.refund.id, body: { paymentReference: 'R1' }, actorId: 'adm2' })).error, 'cannot_pay_own_approval');
  assert.equal((await f.refundService.markPaid({ id: out.refund.id, body: { paymentReference: 'R1' }, actorId: 'adm3' })).refund.status, 'paid');
  assert.equal((await f.held.list({ status: 'resolved' })).items[0].refundStatus, 'paid');
});

test('flag off: the service and both routes answer 404 feature_disabled', async () => {
  const f = fixture({ enabled: false });
  await f.log('payment_mobile_money_orphaned', 'pr_closed', { transactionId: 'TX1', amountTzs: 50000 });
  assert.deepEqual(await f.held.list({}), { error: 'feature_disabled', status: 404 });
  assert.deepEqual(await f.held.raiseRefund({ paymentRequestId: 'pr_closed', body: body(), actorId: 'a' }), { error: 'feature_disabled', status: 404 });
  assert.equal(f.refunds.rows.length, 0);

  const saved = process.env.HELD_PAYMENTS_WORKLIST;
  delete process.env.HELD_PAYMENTS_WORKLIST;
  try {
    const call = async (route, req) => {
      let out = {};
      const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
      await route.onRequest({ query: {}, body: body(), params: { paymentRequestId: 'pr_x' }, user: { sub: 'adm1' }, ...req }, res);
      return out;
    };
    for (const route of [adminHeldPayments, adminRaiseHeldPaymentRefund]) {
      const out = await call(route, {});
      assert.equal(out.status, 404);
      assert.equal(out.body.error, 'feature_disabled');
    }
  } finally { if (saved === undefined) delete process.env.HELD_PAYMENTS_WORKLIST; else process.env.HELD_PAYMENTS_WORKLIST = saved; }
});

after(async () => { await db.destroy?.(); });
