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
const fail = (error, status = 400, extra = {}) => ({ error, status, ...extra });
const iso = v => (v instanceof Date ? v.toISOString() : v ? String(v) : null);
const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));

function reasonOf(row) {
  if (row.action === 'payment_mobile_money_orphaned') return 'request_closed';
  if (row.action === 'payment_mobile_money_amount_mismatch') return 'amount_mismatch';
  return row.after?.error || 'held';
}
function amountOf(row) {
  return num(row.after?.amountTzs) ?? num(row.after?.received);
}

export function createHeldPaymentsService({ auditLog, paymentRequests, refunds, refundService, enabled = () => true }) {
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
        paymentRequestId: request.id, transactionId, amountTzs: amountOf(row) ?? num(request.amountTzs),
        memberId: request.memberId, reason: reasonOf(row), at: iso(row.at), refundId: refund?.id ?? null,
        requestStatus: request.status, productType: request.productType ?? null,
        refundStatus: refund?.status ?? null,
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
    const maxAmountTzs = amountOf(match.row) ?? num(request.amountTzs);
    const out = await refundService.adminRaise({
      body: { paymentRequestId: request.id, amountTzs: body.amountTzs, reasonCode: body.reasonCode.trim(), note: body.note },
      actorId, held: { maxAmountTzs },
    });
    if (out.error) return out;
    await auditLog.insertAsync({
      id: randomUUID(), at: new Date().toISOString(), actor: actorId, action: 'payment_held_refund_raised', target: request.id,
      before: { reason: reasonOf(match.row), status: request.status },
      after: { refundId: out.refund.id, transactionId, amountTzs: out.refund.amountTzs, reasonCode: out.refund.reasonCode },
    });
    return out;
  }

  return { list, raiseRefund };
}
