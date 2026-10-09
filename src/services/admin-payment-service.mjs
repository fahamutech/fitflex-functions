// Admin payment-request review — approve/reject pilot payments. List rows
// embed a LEAN member/subscription projection only (not the full user row
// with memberProfile/aclPermissions) to keep the list endpoint's payload small.
import { randomUUID } from 'node:crypto';
import { activationDates } from '../shared/subscription-status.mjs';
import { productTypeOfPayment } from '../shared/payment-product.mjs';

export function createAdminPaymentService({
  paymentRequests, subscriptions, users, auditLog,
  gyms = null,
  onBookingPayment = async () => {},
  onOrderPayment = async () => {},
  onSubscriptionActivated = async () => {},
  // A rejected payment for a membership (lifecycle automations).
  onPaymentRejected = async () => {},
  // A membership's payment was rejected, cancelled or put back to pending: (subscription) => void. Promotion analytics takes the conversion back.
  onSubscriptionPaymentReversed = async () => {},
}) {
  function slimMember(u) {
    if (!u) return null;
    return { id: u.id, displayName: u.displayName || null, email: u.email || null, phone: u.phone || null, photoUrl: u.photoUrl || null };
  }

  function slimSub(s) {
    if (!s) return null;
    return { id: s.id, tier: s.tier, type: s.type, plan: s.plan ?? null, status: s.status, expiresAt: s.expiresAt ?? null };
  }

  /** The gym a gym-bound request pays for (trainer pass / direct plan), by name. */
  function slimGym(gymId) {
    if (!gymId || !gyms?.find) return null;
    const g = gyms.find(r => r.id === gymId);
    return g ? { id: g.id, name: g.name } : null;
  }

  // A request pays for a subscription, a trainer booking group or a shop order.
  async function applyPaymentStatusToSubscription(request, status, reference) {
    if (request.bookingGroupId) {
      await onBookingPayment(request.bookingGroupId, status);
      return;
    }
    if (request.orderId) {
      await onOrderPayment(request.orderId, status);
      return;
    }
    if (!request.subscriptionId) return;
    const subStatus = {
      approved: 'active',
      rejected: 'payment_rejected',
      cancelled: 'payment_cancelled',
      pending: 'payment_pending'
    }[status];
    if (!subStatus) return;
    const patch = {
      status: subStatus,
      paymentRef: status === 'approved' ? (reference || `ADMIN_${request.id}`) : null
    };
    // Every paid plan runs from the moment it is paid for, not from the request.
    if (status === 'approved') {
      Object.assign(patch, activationDates(await subscriptions.findByIdAsync(request.subscriptionId)));
    }
    const updated = await subscriptions.updateByIdAsync(request.subscriptionId, patch);
    if (subStatus === 'active' && updated) {
      // The request says when the member asked and what they paid, which is what promotion analytics needs.
      try { await onSubscriptionActivated(updated, { requestedAt: request.requestedAt, amountTzs: request.amountTzs }); } catch { /* notification is best-effort */ }
    }
    if (subStatus !== 'active' && updated) {
      try { await onSubscriptionPaymentReversed(updated); } catch { /* best-effort */ }
    }
    if (subStatus === 'payment_rejected' && updated) {
      try { await onPaymentRejected(updated, request); } catch { /* best-effort */ }
    }
  }

  async function list() {
    const allPayReqs = await paymentRequests.allAsync();
    allPayReqs.sort((a, b) => +new Date(b.requestedAt) - +new Date(a.requestedAt));

    // Batch-fetch every referenced member/subscription in two queries
    // instead of two sequential round trips PER ROW (was N+1: with ~150
    // payment requests that's 300 sequential DB calls, the actual cause of
    // this endpoint's 300-400ms response time — not payload size).
    const memberIds = [...new Set(allPayReqs.map(p => p.memberId).filter(Boolean))];
    const subscriptionIds = [...new Set(allPayReqs.map(p => p.subscriptionId).filter(Boolean))];
    const [memberRows, subscriptionRows] = await Promise.all([
      users.filterByColumnInAsync('id', memberIds),
      subscriptions.filterByColumnInAsync('id', subscriptionIds),
    ]);
    const memberById = new Map(memberRows.map(u => [u.id, u]));
    const subById = new Map(subscriptionRows.map(s => [s.id, s]));

    return allPayReqs.map(p => ({
      ...p,
      member: slimMember(memberById.get(p.memberId) || null),
      subscription: slimSub(subById.get(p.subscriptionId) || null),
      productType: productTypeOfPayment(p, subById.get(p.subscriptionId) || null),
      gym: slimGym(p.gymId),
    }));
  }

  async function decide({ id, decision, reference, note, actorId }) {
    if (!['approve', 'reject'].includes(decision)) return { error: 'invalid_decision', status: 400 };
    const request = await paymentRequests.findAsync(p => p.id === id);
    if (!request) return { error: 'not_found', status: 404 };
    if (request.status !== 'pending') return { error: 'already_decided', status: 409 };

    const now = new Date().toISOString();
    const status = decision === 'approve' ? 'approved' : 'rejected';
    const updated = await paymentRequests.updateByIdAsync(request.id, {
      status,
      reference: reference || request.reference,
      note: note || null,
      decidedAt: now,
      decidedBy: actorId
    });
    await applyPaymentStatusToSubscription(request, status, reference || `ADMIN_${request.id}`);
    await auditLog.insertAsync({
      id: randomUUID(), at: now, actor: actorId,
      action: `payment_${status}`, target: request.id, before: request, after: updated
    });
    return { paymentRequest: updated };
  }

  async function update({ id, status, reference, note, actorId }) {
    const allowed = ['pending', 'approved', 'rejected', 'cancelled'];
    if (status && !allowed.includes(status)) return { error: 'invalid_status', status: 400 };
    const request = await paymentRequests.findAsync(p => p.id === id);
    if (!request) return { error: 'not_found', status: 404 };
    const nextStatus = status || request.status;
    const now = new Date().toISOString();
    const updated = await paymentRequests.updateByIdAsync(request.id, {
      status: nextStatus,
      reference: reference ?? request.reference,
      note: note ?? request.note ?? null,
      decidedAt: nextStatus === 'pending' ? null : (request.decidedAt || now),
      decidedBy: nextStatus === 'pending' ? null : actorId
    });
    await applyPaymentStatusToSubscription(request, nextStatus, reference ?? request.reference);
    await auditLog.insertAsync({
      id: randomUUID(), at: now, actor: actorId,
      action: 'payment_updated', target: request.id, before: request, after: updated
    });
    return { paymentRequest: updated };
  }

  return { list, decide, update, applyPaymentStatusToSubscription };
}
