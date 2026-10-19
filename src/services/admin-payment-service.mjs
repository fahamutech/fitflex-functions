// Admin payment-request review — approve/reject pilot payments. List rows
// embed a LEAN member/subscription projection only (not the full user row
// with memberProfile/aclPermissions) to keep the list endpoint's payload small.
import { randomUUID } from 'node:crypto';
import { activationDates } from '../shared/subscription-status.mjs';
import { productTypeOfPayment } from '../shared/payment-product.mjs';
import { upgradeOf, upgradeApprovable, applyUpgradeStatus } from '../shared/pass-upgrade.mjs';
import { updateIf } from '../shared/conditional-update.mjs';
import { referenceKey, memoryReferenceStore } from '../shared/manual-payment.mjs';

export function createAdminPaymentService({
  paymentRequests, subscriptions, users, auditLog,
  gyms = null,
  onBookingPayment = async () => {},
  onOrderPayment = async () => {},
  // Before a shop order's payment is confirmed: (request, { amountTzs }) → null | { error, status }.
  // Checks the payment against the order (buyer, currency, amount).
  beforeOrderPayment = async () => null,
  onSubscriptionActivated = async () => {},
  // A rejected payment for a membership (lifecycle automations).
  onPaymentRejected = async () => {},
  // A membership's payment was rejected, cancelled or put back to pending: (subscription) => void. Promotion analytics takes the conversion back.
  onSubscriptionPaymentReversed = async () => {},
  // A pass was upgraded in place: (subscription, request) => void. Best-effort.
  onPassUpgraded = async () => {},
  // Slice A3: reference lookups (database in production) and whether every approval's
  // final reference is checked for reuse (MANUAL_PAY_INSTRUCTIONS).
  referenceStore = null,
  manualReferenceChecks = () => false,
}) {
  const references = referenceStore || memoryReferenceStore({ paymentRequests });
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
    // An upgrade changes the plan it upgrades, in place; it has no plan of its own.
    if (upgradeOf(request)) {
      const out = await applyUpgradeStatus(subscriptions, request, status);
      if (out?.upgraded) {
        try { await onPassUpgraded(out.subscription, request); } catch { /* notification is best-effort */ }
      }
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

  /**
   * The reference an order payment is confirmed with. A mobile-money or bank reference pays for one
   * order only: using it again is refused (the database also enforces it for confirmed order payments).
   */
  async function referenceInUse(request, reference) {
    if (!request.orderId || !reference || String(reference).startsWith('ADMIN_')) return false;
    const same = await paymentRequests.filterByColumnAsync('reference', reference);
    return same.some(p => p.id !== request.id && p.orderId && p.status === 'approved');
  }

  /** Checks that must hold before a shop order's payment is confirmed. */
  async function checkConfirmation(request, { reference, amountTzs }) {
    if (!request.orderId) return null;
    const problem = await beforeOrderPayment(request, { amountTzs });
    if (problem?.error) return problem;
    if (await referenceInUse(request, reference)) return { error: 'reference_already_used', status: 409 };
    return null;
  }

  /**
   * Slice A3 (review L1): the reference an approval will record — after the member's
   * transaction ID has been copied in — must not be on another pending or approved
   * request (same letters+digits key, member ID or admin/provider reference). Checked
   * for requests that carry a member ID, and for every approval while
   * MANUAL_PAY_INSTRUCTIONS is on; otherwise approvals behave as before.
   */
  async function finalReferenceTaken(request, finalRef) {
    if (!request.memberReference && !manualReferenceChecks()) return false;
    if (!finalRef || String(finalRef).startsWith('ADMIN_')) return false;
    const key = referenceKey(finalRef);
    if (!key) return false;
    return (await references.holders(key, { excludeId: request.id })).length > 0;
  }

  /** The member's ID, when an approval has no reference typed and none recorded yet. */
  const memberRefFor = (request, typedOrRecorded) => (!typedOrRecorded ? (request.memberReference || null) : null);

  /** Write the decision only if the request is still in the state it was read in. */
  async function writeDecision(request, patch) {
    try {
      return await updateIf(paymentRequests, request.id, { status: request.status }, patch);
    } catch (err) {
      if (err?.code === '23505') return 'reference_already_used';
      throw err;
    }
  }

  async function decide({ id, decision, reference, note, actorId, amountTzs = null }) {
    if (!['approve', 'reject'].includes(decision)) return { error: 'invalid_decision', status: 400 };
    const request = await paymentRequests.findAsync(p => p.id === id);
    if (!request) return { error: 'not_found', status: 404 };
    if (request.status !== 'pending') return { error: 'already_decided', status: 409 };
    // Approving with no reference typed, and none recorded yet (e.g. by a verifying admin),
    // confirms the transaction ID the member gave (slice A3). A recorded or typed one wins.
    const memberRef = decision === 'approve' ? memberRefFor(request, reference || request.reference) : null;
    const finalRef = reference || request.reference || memberRef;
    if (decision === 'approve') {
      const can = await upgradeApprovable(subscriptions, request);
      if (!can.ok) return { error: can.error, status: 409 };
      const problem = await checkConfirmation(request, { reference: reference || request.reference, amountTzs });
      if (problem) return problem;
      if (await finalReferenceTaken(request, finalRef)) return { error: 'reference_already_used', status: 409 };
    }

    const now = new Date().toISOString();
    const status = decision === 'approve' ? 'approved' : 'rejected';
    const confirmedRef = reference || memberRef;
    const updated = await writeDecision(request, {
      status,
      reference: finalRef,
      // An upgrade's note names the plan it upgrades: it stays as it is.
      note: upgradeOf(request) ? request.note : (note || null),
      decidedAt: now,
      decidedBy: actorId
    });
    // Another decision got there first (two staff members, or a double click).
    if (updated === 'reference_already_used') return { error: 'reference_already_used', status: 409 };
    if (!updated) return { error: 'already_decided', status: 409 };
    await applyPaymentStatusToSubscription(request, status, confirmedRef || `ADMIN_${request.id}`);
    await auditLog.insertAsync({
      id: randomUUID(), at: now, actor: actorId,
      action: `payment_${status}`, target: request.id, before: request, after: updated
    });
    return { paymentRequest: updated };
  }

  async function update({ id, status, reference, note, actorId, amountTzs = null }) {
    const allowed = ['pending', 'approved', 'rejected', 'cancelled'];
    if (status && !allowed.includes(status)) return { error: 'invalid_status', status: 400 };
    const request = await paymentRequests.findAsync(p => p.id === id);
    if (!request) return { error: 'not_found', status: 404 };
    const nextStatus = status || request.status;
    // A confirmed shop-order payment is not edited back: the order is paid, maybe fulfilled.
    // Getting the money back is the refund workflow.
    if (request.orderId && request.status === 'approved' && nextStatus !== 'approved') {
      return { error: 'payment_already_confirmed', status: 409 };
    }
    const approving = nextStatus === 'approved' && request.status !== 'approved';
    const memberRef = approving ? memberRefFor(request, reference ?? request.reference) : null;
    const finalRef = (reference ?? request.reference) || memberRef || (reference ?? request.reference);
    if (approving) {
      const can = await upgradeApprovable(subscriptions, request);
      if (!can.ok) return { error: can.error, status: 409 };
      const problem = await checkConfirmation(request, { reference: reference ?? request.reference, amountTzs });
      if (problem) return problem;
      if (await finalReferenceTaken(request, finalRef)) return { error: 'reference_already_used', status: 409 };
    }
    const now = new Date().toISOString();
    const updated = await writeDecision(request, {
      status: nextStatus,
      reference: finalRef,
      note: upgradeOf(request) ? request.note : (note ?? request.note ?? null),
      decidedAt: nextStatus === 'pending' ? null : (request.decidedAt || now),
      decidedBy: nextStatus === 'pending' ? null : actorId
    });
    if (updated === 'reference_already_used') return { error: 'reference_already_used', status: 409 };
    if (!updated) return { error: 'payment_changed', status: 409 };
    await applyPaymentStatusToSubscription(request, nextStatus, finalRef);
    await auditLog.insertAsync({
      id: randomUUID(), at: now, actor: actorId,
      action: 'payment_updated', target: request.id, before: request, after: updated
    });
    return { paymentRequest: updated };
  }

  return { list, decide, update, applyPaymentStatusToSubscription };
}
