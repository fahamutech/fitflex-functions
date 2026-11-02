// Held payments worklist on the real (CI) database: one transaction for refund + audit, and a subscription-kind
// refund with a null subscriptionId (a closed request that never got a plan) through decide and mark-paid.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { heldPaymentsService, refundService } from '../src/bootstrap/services.mjs';
import { ensureInit } from '../functions/index.mjs';

await ensureInit();
process.env.HELD_PAYMENTS_WORKLIST = 'on';
const KEYS = ['MONEY_SECOND_APPROVER'];
const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
const memberId = `usr_${randomUUID().slice(0, 8)}`;
const reqId = `pay_${randomUUID().slice(0, 8)}`;
const ids = [reqId];
let setup = false;

async function seed(status = 'cancelled', id = reqId) {
  if (!setup) { await db('User').insert({ id: memberId, userType: 'member', displayName: 'Held Member', updatedAt: new Date() }); setup = true; }
  await db('PaymentRequest').insert({ id, memberId, subscriptionId: null, tier: 'T1', amountTzs: 50000, status, provider: 'tunzaa', requestedAt: new Date() });
  await db('AuditLog').insert({ id: randomUUID(), action: 'payment_mobile_money_orphaned', target: id, actor: 'system:mobile-money', before: { status }, after: { transactionId: `TX-${id}`, amountTzs: 50000 } });
}

after(async () => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  delete process.env.HELD_PAYMENTS_WORKLIST;
  const refundIds = (await db('Refund').whereIn('paymentRequestId', ids)).map(r => r.id);
  await db('AuditLog').whereIn('target', [...ids, ...refundIds]).del();
  await db('User').where({ id: memberId }).del();
});

test('the held refund and its audit row are written together, once, and a null-subscription refund runs the whole refund flow', async () => {
  delete process.env.MONEY_SECOND_APPROVER;
  await seed();
  const open = (await heldPaymentsService.list({})).items.find(i => i.paymentRequestId === reqId);
  assert.ok(open && open.refundable && open.amountTzs === 50000);

  const out = await heldPaymentsService.raiseRefund({ paymentRequestId: reqId, body: { transactionId: `TX-${reqId}`, reasonCode: 'payment_error' }, actorId: null });
  assert.equal(out.error, undefined);
  assert.equal(out.refund.status, 'approved');
  const row = await db('Refund').where({ id: out.refund.id }).first();
  assert.equal(row.subscriptionId, null);
  assert.equal(row.kind, 'subscription');
  assert.equal((await db('AuditLog').where({ target: reqId, action: 'payment_held_refund_raised' })).length, 1);
  assert.equal((await db('AuditLog').where({ target: out.refund.id, action: 'refund_raised' })).length, 1);

  const again = await heldPaymentsService.raiseRefund({ paymentRequestId: reqId, body: { transactionId: `TX-${reqId}`, reasonCode: 'payment_error' }, actorId: null });
  assert.equal(again.error, 'refund_already_requested');
  assert.equal((await db('Refund').where({ paymentRequestId: reqId })).length, 1);
  assert.equal((await db('AuditLog').where({ target: reqId, action: 'payment_held_refund_raised' })).length, 1);

  const resolved = (await heldPaymentsService.list({ status: 'resolved' })).items.find(i => i.paymentRequestId === reqId);
  assert.equal(resolved.refundId, out.refund.id);

  // Paying it: no subscription to touch, no hook for this kind.
  const paid = await refundService.markPaid({ id: out.refund.id, body: { paymentReference: 'MPESA-HELD1' }, actorId: 'adm9' });
  assert.equal(paid.refund.status, 'paid');
});

test('with MONEY_SECOND_APPROVER on, a null-subscription held refund is decided (endAccess is a no-op) and paid by different admins', async () => {
  process.env.MONEY_SECOND_APPROVER = 'on';
  const id = `pay_${randomUUID().slice(0, 8)}`;
  ids.push(id);
  await seed('rejected', id);
  const out = await heldPaymentsService.raiseRefund({ paymentRequestId: id, body: { transactionId: `TX-${id}`, reasonCode: 'payment_error' }, actorId: 'adm1' });
  assert.equal(out.refund.status, 'requested');
  assert.equal((await refundService.decide({ id: out.refund.id, body: { decision: 'approve' }, actorId: 'adm1' })).error, 'cannot_approve_own_request');
  const approved = await refundService.decide({ id: out.refund.id, body: { decision: 'approve', endAccess: true }, actorId: 'adm2' });
  assert.equal(approved.refund.status, 'approved');
  assert.equal((await refundService.markPaid({ id: out.refund.id, body: { paymentReference: 'R2' }, actorId: 'adm2' })).error, 'cannot_pay_own_approval');
  assert.equal((await refundService.markPaid({ id: out.refund.id, body: { paymentReference: 'R2' }, actorId: 'adm3' })).refund.status, 'paid');
});

test('a request approved before the lock is taken gets no refund', async () => {
  delete process.env.MONEY_SECOND_APPROVER;
  const id = `pay_${randomUUID().slice(0, 8)}`;
  ids.push(id);
  await seed('cancelled', id);
  await db('PaymentRequest').where({ id }).update({ status: 'approved' }); // approved after it was listed
  const out = await heldPaymentsService.raiseRefund({ paymentRequestId: id, body: { transactionId: `TX-${id}`, reasonCode: 'payment_error' }, actorId: 'adm1' });
  assert.ok(['not_held', 'not_refundable'].includes(out.error));
  assert.equal((await db('Refund').where({ paymentRequestId: id })).length, 0);
});
