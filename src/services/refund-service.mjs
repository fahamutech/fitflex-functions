// Refunds — money FitFlex owes back to a payer.
//
// A refund is raised in one of two ways:
//   - by a cancellation the terms allow (a trainer session cancelled at least
//     24 hours ahead or by the trainer; a shop order cancelled before
//     dispatch): it is approved by policy and waits to be paid;
//   - by a sponsor covering a trainer session the member already paid for
//     (b2b-sponsor-refund-service): approved by policy as well;
//   - by a request (a member asking about a pass or plan payment, or an admin
//     raising one): it waits for a decision first.
// FitFlex staff then pay it outside the app and record the payment reference.
//
//   requested ──approve──▶ approved ──paid──▶ paid
//       └──────reject────▶ rejected
import { randomUUID } from 'node:crypto';

export const REFUND_KINDS = ['subscription', 'trainer_booking', 'shop_order'];
export const REFUND_STATUSES = ['requested', 'approved', 'paid', 'rejected'];
/** Reasons a member may give when asking for a pass or plan refund. */
export const MEMBER_REASONS = ['charged_twice', 'not_activated', 'other'];
const REASONS = new Set([
  ...MEMBER_REASONS, 'member_cancelled', 'trainer_cancelled', 'vendor_cancelled', 'cancelled_by_fitflex', 'payment_error', 'sponsor_paid',
]);
const SOURCE_FIELD = { subscription: 'paymentRequestId', trainer_booking: 'bookingId', shop_order: 'orderId' };
const fail = (error, status = 400, extra = {}) => ({ error, status, ...extra });
const nowIso = () => new Date().toISOString();
const text = (v, max = 500) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

export function createRefundService({
  refunds, paymentRequests, subscriptions, users, auditLog,
  notify = async () => {},          // (userId, { type, title, body, data })
  onPaid = async () => {},          // (refund) → e.g. mark the order refunded
}) {
  const money = n => `TZS ${Number(n || 0).toLocaleString('en-US')}`;

  async function tell(refund, type, title, body) {
    try {
      await notify(refund.memberId, { id: `ntf_${type}_${refund.id}`, type, title, body, data: { refundId: refund.id, kind: refund.kind } });
    } catch { /* a notification never blocks a refund */ }
  }

  async function audit(action, actor, before, after) {
    await auditLog.insertAsync({ id: randomUUID(), at: nowIso(), actor: actor || null, action, target: after.id, before, after });
  }

  /** The refund still in play (not rejected) for a booking, order or payment, if any. */
  async function liveFor(kind, sourceId) {
    const field = SOURCE_FIELD[kind];
    return (await refunds.filterByColumnAsync(field, sourceId)).find(r => r.kind === kind && r.status !== 'rejected') || null;
  }

  /**
   * Raise a refund. `approved: true` is for refunds the terms grant outright
   * (an in-time cancellation); otherwise it waits for a decision.
   * Raising one that is already in play returns the existing refund.
   */
  async function raise({ memberId, kind, sourceId, subscriptionId = null, paymentRequestId = null, amountTzs, currency = 'TZS',
    reasonCode, note = null, requestedBy = null, requestedRole = 'system', approved = false }) {
    if (!REFUND_KINDS.includes(kind)) return fail('invalid_kind');
    if (!REASONS.has(reasonCode)) return fail('invalid_reason', 400, { allowed: [...REASONS] });
    const amount = Math.round(Number(amountTzs));
    if (!Number.isFinite(amount) || amount <= 0) return fail('nothing_to_refund', 409);
    const existing = await liveFor(kind, sourceId);
    if (existing) return { refund: existing, existing: true };
    const at = nowIso();
    const row = {
      id: `rfd_${randomUUID().slice(0, 10)}`, memberId, kind,
      subscriptionId, paymentRequestId: kind === 'subscription' ? sourceId : paymentRequestId,
      bookingId: kind === 'trainer_booking' ? sourceId : null,
      orderId: kind === 'shop_order' ? sourceId : null,
      amountTzs: amount, currency, reasonCode, note: text(note),
      status: approved ? 'approved' : 'requested',
      requestedBy, requestedRole,
      decidedBy: approved ? 'policy' : null, decidedAt: approved ? at : null, decisionNote: null,
      paidBy: null, paidAt: null, paymentReference: null, paidTo: null,
      createdAt: at, updatedAt: at,
    };
    let refund;
    try {
      refund = await refunds.insertAsync(row);
    } catch (err) {
      if (err.code !== '23505') throw err; // raised at the same moment by someone else
      return { refund: await liveFor(kind, sourceId), existing: true };
    }
    await audit('refund_raised', requestedBy, null, refund);
    if (approved) {
      await tell(refund, 'refund_approved', 'Refund on its way', `Your refund of ${money(amount)} is approved. FitFlex will send it to the account you paid from.`);
    } else {
      await tell(refund, 'refund_requested', 'Refund request received', `We have your request for ${money(amount)} and will reply soon.`);
    }
    return { refund };
  }

  /** Member: ask for a pass or plan payment back (charged twice, never activated, other). */
  async function requestForPayment({ memberId, body = {} }) {
    const reasonCode = body.reasonCode;
    if (!MEMBER_REASONS.includes(reasonCode)) return fail('invalid_reason', 400, { allowed: MEMBER_REASONS });
    const note = text(body.note);
    if (reasonCode === 'other' && !note) return fail('note_required');
    let request = body.paymentRequestId ? await paymentRequests.findByIdAsync(body.paymentRequestId) : null;
    if (!request && body.subscriptionId) {
      request = (await paymentRequests.filterByColumnAsync('subscriptionId', body.subscriptionId))
        .filter(p => p.status === 'approved').sort((a, b) => +new Date(b.decidedAt || 0) - +new Date(a.decidedAt || 0))[0] || null;
    }
    if (!request || request.memberId !== memberId) return fail('payment_not_found', 404);
    // Sessions and orders are refunded by cancelling them, which applies the right rule.
    if (!request.subscriptionId) return fail('cancel_instead', 409);
    if (request.status !== 'approved') return fail('payment_not_confirmed', 409);
    const out = await raise({
      memberId, kind: 'subscription', sourceId: request.id, subscriptionId: request.subscriptionId,
      amountTzs: request.amountTzs, currency: request.currency || 'TZS', reasonCode, note,
      requestedBy: memberId, requestedRole: 'member',
    });
    if (out.existing) return fail('refund_already_requested', 409, { refund: out.refund });
    return out;
  }

  /** Admin: raise a refund for any confirmed pass or plan payment (approved at once). */
  async function adminRaise({ body = {}, actorId }) {
    const request = body.paymentRequestId ? await paymentRequests.findByIdAsync(body.paymentRequestId) : null;
    if (!request) return fail('payment_not_found', 404);
    if (!request.subscriptionId) return fail('cancel_instead', 409);
    if (request.status !== 'approved') return fail('payment_not_confirmed', 409);
    const amountTzs = body.amountTzs ?? request.amountTzs;
    if (Number(amountTzs) > Number(request.amountTzs)) return fail('amount_exceeds_payment', 400);
    const out = await raise({
      memberId: request.memberId, kind: 'subscription', sourceId: request.id, subscriptionId: request.subscriptionId,
      amountTzs, currency: request.currency || 'TZS', reasonCode: body.reasonCode || 'payment_error', note: body.note,
      requestedBy: actorId, requestedRole: 'admin', approved: true,
    });
    if (out.existing) return fail('refund_already_requested', 409, { refund: out.refund });
    return out;
  }

  /** Admin: approve or reject a requested refund. Rejecting needs a note the member sees. */
  async function decide({ id, body = {}, actorId }) {
    if (!['approve', 'reject'].includes(body.decision)) return fail('invalid_decision', 400, { allowed: ['approve', 'reject'] });
    const prior = await refunds.findByIdAsync(id);
    if (!prior) return fail('refund_not_found', 404);
    if (prior.status !== 'requested') return fail('already_decided', 409, { refundStatus: prior.status });
    const note = text(body.note);
    if (body.decision === 'reject' && !note) return fail('note_required');
    let amountTzs = prior.amountTzs;
    if (body.decision === 'approve' && body.amountTzs != null) {
      amountTzs = Math.round(Number(body.amountTzs));
      if (!Number.isFinite(amountTzs) || amountTzs <= 0 || amountTzs > prior.amountTzs) return fail('invalid_amount');
    }
    const at = nowIso();
    const refund = await refunds.updateByIdAsync(id, {
      status: body.decision === 'approve' ? 'approved' : 'rejected', amountTzs,
      decidedBy: actorId, decidedAt: at, decisionNote: note, updatedAt: at,
    });
    // A pass or plan refunded in full stops giving access, when the reviewer says so.
    if (refund.status === 'approved' && body.endAccess === true && refund.subscriptionId && subscriptions) {
      await subscriptions.updateByIdAsync(refund.subscriptionId, { expiresAt: at, renewsAt: at });
    }
    await audit(`refund_${refund.status}`, actorId, prior, refund);
    if (refund.status === 'approved') {
      await tell(refund, 'refund_approved', 'Refund approved', `Your refund of ${money(refund.amountTzs)} is approved. FitFlex will send it to the account you paid from.`);
    } else {
      await tell(refund, 'refund_rejected', 'Refund not approved', note);
    }
    return { refund };
  }

  /**
   * Withdraw a refund that is no longer owed (for example the sponsor stopped
   * covering the session it was raised for). Only one not yet paid, and only
   * one raised for that reason: a paid refund is returned as it is.
   */
  async function withdraw({ kind, sourceId, reasonCode, note, actorId = null }) {
    const prior = await liveFor(kind, sourceId);
    if (!prior || prior.reasonCode !== reasonCode) return { refund: null, withdrawn: false };
    if (prior.status === 'paid') return { refund: prior, withdrawn: false, alreadyPaid: true };
    const at = nowIso();
    const refund = await refunds.updateByIdAsync(prior.id, {
      status: 'rejected', decidedBy: actorId || 'policy', decidedAt: at, decisionNote: text(note) || 'No longer owed', updatedAt: at,
    });
    await audit('refund_withdrawn', actorId, prior, refund);
    await tell(refund, 'refund_rejected', 'Refund withdrawn', refund.decisionNote);
    return { refund, withdrawn: true };
  }

  /** Admin: record that an approved refund was sent, with the payment reference. */
  async function markPaid({ id, body = {}, actorId }) {
    const prior = await refunds.findByIdAsync(id);
    if (!prior) return fail('refund_not_found', 404);
    if (prior.status !== 'approved') return fail('refund_not_approved', 409, { refundStatus: prior.status });
    const reference = text(body.paymentReference, 120);
    if (!reference) return fail('payment_reference_required');
    const at = nowIso();
    const refund = await refunds.updateByIdAsync(id, {
      status: 'paid', paidBy: actorId, paidAt: at, paymentReference: reference, paidTo: text(body.paidTo, 120), updatedAt: at,
    });
    await audit('refund_paid', actorId, prior, refund);
    try { await onPaid(refund); } catch { /* the refund itself is recorded */ }
    await tell(refund, 'refund_paid', 'Refund sent', `We sent ${money(refund.amountTzs)} back to you. Reference: ${reference}.`);
    return { refund };
  }

  const byNewest = (a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0);

  /** Member: my refunds, newest first. */
  async function listMine(memberId) {
    return { refunds: (await refunds.filterByColumnAsync('memberId', memberId)).sort(byNewest) };
  }

  /** Admin: refunds, optionally by status, with who they are for. */
  async function adminList({ status } = {}) {
    if (status && !REFUND_STATUSES.includes(status)) return fail('invalid_status', 400, { allowed: REFUND_STATUSES });
    const rows = (status ? await refunds.filterByColumnAsync('status', status) : await refunds.allAsync()).sort(byNewest);
    const people = await users.filterByColumnInAsync('id', [...new Set(rows.map(r => r.memberId))]);
    const byId = new Map(people.map(u => [u.id, u]));
    return {
      refunds: rows.map((r) => {
        const u = byId.get(r.memberId);
        return { ...r, member: u ? { id: u.id, displayName: u.displayName || null, phone: u.phone || null, email: u.email || null } : null };
      }),
    };
  }

  return { raise, withdraw, liveFor, requestForPayment, adminRaise, decide, markPaid, listMine, adminList };
}
