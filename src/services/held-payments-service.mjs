// Held payments worklist (admin portal audit M5).
//
// Money a provider confirmed that no payment request could take is audited by mobile-money-service as
//   payment_mobile_money_orphaned      request cancelled/rejected before the money arrived
//   payment_mobile_money_held          transaction mismatch, reference already used, sandbox, approval error
//   payment_mobile_money_amount_mismatch
// This service reads those rows (no table of its own) and lets staff raise a refund for one. A row is
// resolved when a live (not rejected) refund exists for its payment request. A request that was approved
// afterwards is no longer held and is not listed.
import { randomUUID } from 'node:crypto';

const ACTIONS = ['payment_mobile_money_orphaned', 'payment_mobile_money_held', 'payment_mobile_money_amount_mismatch'];
export const HELD_STATUSES = ['open', 'resolved'];
// Informational only: the money is not unaccounted for (reference_already_used: that transaction already confirmed
// another request) or was never really received (sandbox_not_settled). A refund would pay out twice.
const NOT_REFUNDABLE_REASONS = new Set(['reference_already_used', 'sandbox_not_settled']);
// Only a closed request can be refunded here. A pending one may still be approved by its own flow.
const CLOSED = new Set(['cancelled', 'rejected']);
const fail = (error, status = 400, extra = {}) => ({ error, status, ...extra });
const iso = v => (v instanceof Date ? v.toISOString() : v ? String(v) : null);
const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));

function reasonOf(row) {
  if (row.action === 'payment_mobile_money_orphaned') return 'request_closed';
  if (row.action === 'payment_mobile_money_amount_mismatch') return 'amount_mismatch';
  return row.after?.error || 'held';
}
/** What the provider actually confirmed, from the audit row; null when the row does not say. */
function amountOf(row) {
  return num(row.after?.amountTzs) ?? num(row.after?.received);
}
/** null when refundable, else why not. */
function blockedBy(row, request) {
  const reason = reasonOf(row);
  if (NOT_REFUNDABLE_REASONS.has(reason)) return reason;
  if (!CLOSED.has(request.status)) return 'request_not_closed';
  return null;
}

/**
 * `transact(fn)` runs fn({ lockRequest(id), refunds, auditLog }) in one database transaction: the request row is
 * locked and re-read, and the refund and its audit rows are written with it. The default runs fn on the plain stores
 * (in-memory specs). A held refund is kind 'subscription' with the payment request as source and a null subscriptionId.
 */
export function createHeldPaymentsService({ auditLog, paymentRequests, refunds, refundService, enabled = () => true, transact = null }) {
  const run = transact ?? (fn => fn({ lockRequest: id => paymentRequests.findByIdAsync(id), refunds, auditLog }));
  const off = fail('feature_disabled', 404);

  /** One entry per (payment request, transaction): the earliest audit row, whatever the polls repeated. */
  async function heldRows() {
    const rows = [];
    for (const action of ACTIONS) rows.push(...await auditLog.filterByColumnAsync('action', action));
    rows.sort((a, b) => +new Date(a.at) - +new Date(b.at));
    const seen = new Map();
    for (const r of rows) {
      const transactionId = r.after?.transactionId ? String(r.after.transactionId) : null;
      const key = `${r.target}|${transactionId}`;
      if (!seen.has(key)) seen.set(key, { row: r, transactionId });
    }
    return [...seen.values()];
  }

  const liveRefund = async paymentRequestId =>
    (await refunds.filterByColumnAsync('paymentRequestId', paymentRequestId)).find(r => r.status !== 'rejected') || null;

  async function list({ status = 'open' } = {}) {
    if (!enabled()) return off;
    if (!HELD_STATUSES.includes(status)) return fail('invalid_status', 400, { allowed: HELD_STATUSES });
    const items = [];
    for (const { row, transactionId } of await heldRows()) {
      const request = await paymentRequests.findByIdAsync(row.target);
      if (!request || request.status === 'approved') continue; // taken after all: nothing is held
      const refund = await liveRefund(request.id);
      if ((status === 'resolved') !== Boolean(refund)) continue;
      items.push({
        paymentRequestId: request.id, transactionId, amountTzs: amountOf(row),
        memberId: request.memberId, reason: reasonOf(row), at: iso(row.at), refundId: refund?.id ?? null,
        requestStatus: request.status, productType: request.productType ?? null,
        refundStatus: refund?.status ?? null,
        refundable: !refund && !blockedBy(row, request), notRefundableReason: refund ? 'already_refunded' : blockedBy(row, request),
        amountReceivedKnown: amountOf(row) != null,
      });
    }
    items.sort((a, b) => +new Date(b.at) - +new Date(a.at));
    return { items };
  }

  /** Raise (never pay) a refund for money held on a closed request. Body { transactionId, reasonCode, amountTzs?, note? }. */
  async function raiseRefund({ paymentRequestId, body = {}, actorId }) {
    if (!enabled()) return off;
    const transactionId = typeof body.transactionId === 'string' ? body.transactionId.trim() : '';
    if (!transactionId) return fail('transaction_id_required');
    if (typeof body.reasonCode !== 'string' || !body.reasonCode.trim()) return fail('reason_code_required');
    const request = await paymentRequests.findByIdAsync(paymentRequestId);
    if (!request) return fail('payment_not_found', 404);
    if (request.eventOrderId) return fail('use_event_refund', 409); // event money is refunded by the events flow
    const match = (await heldRows()).find(h => h.row.target === request.id && h.transactionId === transactionId);
    if (!match || request.status === 'approved') return fail('not_held', 409);
    const blocked = blockedBy(match.row, request);
    if (blocked) return fail('not_refundable', 409, { reason: blocked });
    // The cap is what the provider confirmed. When the audit row does not say, the admin must state the amount
    // (never more than the request) and the refund is audited as unverified.
    const received = amountOf(match.row);
    const stated = body.amountTzs == null ? null : num(body.amountTzs);
    if (body.amountTzs != null && !(stated > 0)) return fail('invalid_amount', 400);
    if (received == null && stated == null) return fail('amount_unknown', 409);
    const maxAmountTzs = received ?? num(request.amountTzs);
    let out;
    try {
      out = await run(async tx => {
        // Re-read under a row lock: a late approval cannot slip in between this check and the refund insert.
        const fresh = await tx.lockRequest(request.id);
        if (!fresh || !CLOSED.has(fresh.status)) return fail('not_refundable', 409, { reason: 'request_not_closed' });
        const res = await refundService.adminRaise({
          body: { paymentRequestId: request.id, amountTzs: stated, reasonCode: body.reasonCode.trim(), note: body.note },
          actorId, held: { maxAmountTzs, tx },
        });
        if (res.error) return res;
        await tx.auditLog.insertAsync({
          id: randomUUID(), at: new Date().toISOString(), actor: actorId, action: 'payment_held_refund_raised', target: request.id,
          before: { reason: reasonOf(match.row), status: fresh.status },
          after: { refundId: res.refund.id, transactionId, amountTzs: res.refund.amountTzs, reasonCode: res.refund.reasonCode, amountReceivedKnown: received != null },
        });
        return res;
      });
    } catch (err) {
      if (err?.code === '23505') {
        const existing = await liveRefund(request.id);
        return fail('refund_already_requested', 409, { refund: existing });
      }
      throw err;
    }
    return out;
  }

  return { list, raiseRefund };
}
