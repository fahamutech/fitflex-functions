// Admin payment-request review — approve/reject pilot payments. List rows
// embed a LEAN member/subscription projection only (not the full user row
// with memberProfile/aclPermissions) to keep the list endpoint's payload small.
import { randomUUID } from 'node:crypto';
import { activationDates } from '../shared/subscription-status.mjs';
import { productTypeOfPayment } from '../shared/payment-product.mjs';
import { upgradeOf, upgradeApprovable, applyUpgradeStatus } from '../shared/pass-upgrade.mjs';
import { updateIf } from '../shared/conditional-update.mjs';
import { moneySecondApproverOn } from '../shared/feature-flags.mjs';

const DECIDED = ['approved', 'rejected', 'cancelled'];
/** A payment FitFlex staff confirm by hand. Any other provider's reference is the provider's transaction. */
const MANUAL_PROVIDER = 'admin_approved';
const STATUSES = ['pending', ...DECIDED];
const CHANGE_CLEARED = { changeRequestedStatus: null, changeRequestedBy: null, changeRequestedAt: null, changeRequestReason: null };
const text = (v, max = 500) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

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
  // A1: two admins on every manual payment decision (MONEY_SECOND_APPROVER). Off: unchanged.
  secondApprover = moneySecondApproverOn,
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

    const twoAdmins = secondApprover();
    return allPayReqs.map(p => ({
      ...p,
      member: slimMember(memberById.get(p.memberId) || null),
      subscription: slimSub(subById.get(p.subscriptionId) || null),
      productType: productTypeOfPayment(p, subById.get(p.subscriptionId) || null),
      gym: slimGym(p.gymId),
      ...(twoAdmins ? secondApproval(p) : {}),
    }));
  }

  /**
   * Where a payment stands in the two-admin workflow (list rows, flag on only):
   *   approvalStage: awaiting_verification | awaiting_second_approval | change_requested | null
   *   approveNotBy:  who may not approve it (the verifier)
   *   confirmChangeNotBy: who may not confirm the requested change (the requester)
   */
  function secondApproval(p) {
    let approvalStage = null;
    if (p.changeRequestedBy) approvalStage = 'change_requested';
    else if (p.status === 'pending') approvalStage = p.verifiedBy ? 'awaiting_second_approval' : 'awaiting_verification';
    return {
      secondApproverRequired: true,
      approvalStage,
      approveNotBy: p.status === 'pending' ? (p.verifiedBy || null) : null,
      confirmChangeNotBy: p.changeRequestedBy || null,
    };
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

  /**
   * Flag on: a reference (mobile-money or bank transaction id) confirms one payment only, whatever
   * it pays for. App-level check (no index: live data may already hold duplicates).
   */
  async function referenceUsedElsewhere(request, reference) {
    if (!secondApprover() || !reference || String(reference).startsWith('ADMIN_')) return false;
    const same = await paymentRequests.filterByColumnAsync('reference', reference);
    return same.some(p => p.id !== request.id && p.status === 'approved');
  }

  /** Flag on: a provider's payment keeps the provider's transaction as its reference. */
  const referenceLocked = (request, reference) => secondApprover()
    && (request.provider || MANUAL_PROVIDER) !== MANUAL_PROVIDER && referenceChanged(request, reference);

  /** Checks that must hold before a shop order's payment is confirmed. */
  async function checkConfirmation(request, { reference, amountTzs }) {
    if (!request.orderId) return null;
    const problem = await beforeOrderPayment(request, { amountTzs });
    if (problem?.error) return problem;
    if (await referenceInUse(request, reference)) return { error: 'reference_already_used', status: 409 };
    return null;
  }

  /** Write the decision only if the request is still in the state it was read in. */
  async function writeDecision(request, patch, guard = {}) {
    try {
      return await updateIf(paymentRequests, request.id, { status: request.status, ...guard }, patch);
    } catch (err) {
      if (err?.code === '23505') return 'reference_already_used';
      throw err;
    }
  }

  /**
   * With the flag on, approving a manual payment needs a verification by a
   * different admin. `automated` is for provider-confirmed payments (mobile
   * money): the provider is the verification. It is never set from an endpoint.
   */
  function approvalBlocked(request, actorId, automated, reference) {
    if (automated || !secondApprover()) return null;
    if (!request.verifiedBy) return { error: 'verification_required', status: 409 };
    if (request.verifiedBy === actorId) return { error: 'cannot_approve_own_verification', status: 403 };
    // The approver approves what was verified: not a different reference.
    if (referenceChanged(request, reference)) return { error: 'reference_differs_from_verification', status: 409 };
    return null;
  }

  const referenceChanged = (request, reference) => reference != null && reference !== '' && reference !== request.reference;

  async function decide({ id, decision, reference, note, actorId, amountTzs = null, automated = false }) {
    if (!['approve', 'reject'].includes(decision)) return { error: 'invalid_decision', status: 400 };
    const request = await paymentRequests.findAsync(p => p.id === id);
    if (!request) return { error: 'not_found', status: 404 };
    if (request.status !== 'pending') return { error: 'already_decided', status: 409 };
    if (decision === 'approve') {
      const blocked = approvalBlocked(request, actorId, automated, reference);
      if (blocked) return blocked;
      const can = await upgradeApprovable(subscriptions, request);
      if (!can.ok) return { error: can.error, status: 409 };
      const problem = await checkConfirmation(request, { reference: reference || request.reference, amountTzs });
      if (problem) return problem;
      if (await referenceUsedElsewhere(request, reference || request.reference)) return { error: 'reference_already_used', status: 409 };
    }

    const now = new Date().toISOString();
    const status = decision === 'approve' ? 'approved' : 'rejected';
    // Approved by a second admin: only while the verification it was checked against still stands.
    const guard = (decision === 'approve' && !automated && secondApprover()) ? { verifiedBy: request.verifiedBy } : {};
    const updated = await writeDecision(request, {
      status,
      reference: reference || request.reference,
      // An upgrade's note names the plan it upgrades: it stays as it is.
      note: upgradeOf(request) ? request.note : (note || null),
      decidedAt: now,
      decidedBy: actorId
    }, guard);
    // Another decision got there first (two staff members, or a double click).
    if (updated === 'reference_already_used') return { error: 'reference_already_used', status: 409 };
    if (!updated) return { error: 'already_decided', status: 409 };
    await applyPaymentStatusToSubscription(request, status, reference || `ADMIN_${request.id}`);
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
    if (secondApprover()) {
      // A decided payment changes only by request + confirmation (requestChange / confirmChange).
      if (DECIDED.includes(request.status) && (nextStatus !== request.status || referenceChanged(request, reference))) {
        return { error: 'change_requires_confirmation', status: 409 };
      }
      if (nextStatus === 'approved' && request.status === 'pending') {
        const blocked = approvalBlocked(request, actorId, false, reference);
        if (blocked) return blocked;
      }
      // A verified payment keeps the reference it was verified with.
      if (request.status === 'pending' && request.verifiedBy && referenceChanged(request, reference)) {
        return { error: 'reference_differs_from_verification', status: 409 };
      }
      if (referenceLocked(request, reference)) return { error: 'reference_locked_provider', status: 409 };
    }
    // A confirmed shop-order payment is not edited back: the order is paid, maybe fulfilled.
    // Getting the money back is the refund workflow.
    if (request.orderId && request.status === 'approved' && nextStatus !== 'approved') {
      return { error: 'payment_already_confirmed', status: 409 };
    }
    if (nextStatus === 'approved' && request.status !== 'approved') {
      const can = await upgradeApprovable(subscriptions, request);
      if (!can.ok) return { error: can.error, status: 409 };
      const problem = await checkConfirmation(request, { reference: reference ?? request.reference, amountTzs });
      if (problem) return problem;
      if (await referenceUsedElsewhere(request, reference ?? request.reference)) return { error: 'reference_already_used', status: 409 };
    }
    const now = new Date().toISOString();
    const twoAdmins = secondApprover();
    // Flag on: a note-only edit of a decided payment keeps who decided it.
    const keepDecider = twoAdmins && DECIDED.includes(request.status) && nextStatus === request.status;
    const updated = await writeDecision(request, {
      status: nextStatus,
      reference: reference ?? request.reference,
      note: upgradeOf(request) ? request.note : (note ?? request.note ?? null),
      decidedAt: nextStatus === 'pending' ? null : (request.decidedAt || now),
      decidedBy: nextStatus === 'pending' ? null : (keepDecider ? request.decidedBy : actorId)
    // Flag on: only while the verification read still stands (a stale read cannot overwrite a verified payment).
    }, twoAdmins ? { verifiedBy: request.verifiedBy ?? null } : {});
    if (updated === 'reference_already_used') return { error: 'reference_already_used', status: 409 };
    if (!updated) return { error: 'payment_changed', status: 409 };
    await applyPaymentStatusToSubscription(request, nextStatus, reference ?? request.reference);
    await auditLog.insertAsync({
      id: randomUUID(), at: now, actor: actorId,
      action: 'payment_updated', target: request.id, before: request, after: updated
    });
    return { paymentRequest: updated };
  }

  const off = { error: 'feature_disabled', status: 404 };
  const audit = (action, actorId, before, after, at) => auditLog.insertAsync({
    id: randomUUID(), at, actor: actorId, action, target: before.id, before, after,
  });

  /** Flag on: an admin records that a pending manual payment arrived. A different admin then approves it. */
  async function verify({ id, reference, note, actorId }) {
    if (!secondApprover()) return off;
    const request = await paymentRequests.findAsync(p => p.id === id);
    if (!request) return { error: 'not_found', status: 404 };
    if (request.status !== 'pending') return { error: 'already_decided', status: 409 };
    if (request.verifiedBy) return { error: 'already_verified', status: 409, verifiedBy: request.verifiedBy };
    const typed = text(reference, 120);
    if (referenceLocked(request, typed)) return { error: 'reference_locked_provider', status: 409 };
    // Nothing typed: keep the reference the payment has, else the one the member gave when paying
    // (memberReference, once that field exists; absent today, so this is a no-op).
    const finalReference = typed ?? request.reference ?? text(request.memberReference, 120) ?? null;
    if (await referenceUsedElsewhere(request, finalReference)) return { error: 'reference_already_used', status: 409 };
    const at = new Date().toISOString();
    const updated = await updateIf(paymentRequests, request.id, { status: 'pending', verifiedBy: null }, {
      verifiedBy: actorId, verifiedAt: at,
      reference: finalReference,
      note: upgradeOf(request) ? request.note : (text(note) ?? request.note ?? null),
    });
    if (!updated) return { error: 'payment_changed', status: 409 };
    await audit('payment_verified', actorId, request, updated, at);
    return { paymentRequest: updated };
  }

  /** Flag on: ask to change a decided payment's status, with a reason. A different admin confirms. */
  async function requestChange({ id, status, reason, actorId }) {
    if (!secondApprover()) return off;
    if (!STATUSES.includes(status)) return { error: 'invalid_status', status: 400, allowed: STATUSES };
    const why = text(reason);
    if (!why) return { error: 'reason_required', status: 400 };
    const request = await paymentRequests.findAsync(p => p.id === id);
    if (!request) return { error: 'not_found', status: 404 };
    if (!DECIDED.includes(request.status)) return { error: 'not_decided', status: 409, currentStatus: request.status };
    if (status === request.status) return { error: 'no_change', status: 400 };
    if (request.changeRequestedBy) return { error: 'change_already_requested', status: 409, changeRequestedBy: request.changeRequestedBy };
    // A confirmed shop-order payment is not edited back: getting the money back is the refund workflow.
    if (request.orderId && request.status === 'approved') return { error: 'payment_already_confirmed', status: 409 };
    const at = new Date().toISOString();
    const updated = await updateIf(paymentRequests, request.id, { status: request.status, changeRequestedBy: null }, {
      changeRequestedStatus: status, changeRequestedBy: actorId, changeRequestedAt: at, changeRequestReason: why,
    });
    if (!updated) return { error: 'payment_changed', status: 409 };
    await audit('payment_change_requested', actorId, request, updated, at);
    return { paymentRequest: updated };
  }

  /** Flag on: withdraw or decline a change request (anyone with payments access). The payment stays as it is. */
  async function cancelChange({ id, reason, actorId }) {
    if (!secondApprover()) return off;
    const request = await paymentRequests.findAsync(p => p.id === id);
    if (!request) return { error: 'not_found', status: 404 };
    if (!request.changeRequestedBy) return { error: 'change_not_requested', status: 409 };
    const at = new Date().toISOString();
    const updated = await updateIf(paymentRequests, request.id,
      { status: request.status, changeRequestedBy: request.changeRequestedBy }, { ...CHANGE_CLEARED });
    if (!updated) return { error: 'payment_changed', status: 409 };
    await audit('payment_change_request_cancelled', actorId, request, { ...updated, cancelReason: text(reason) }, at);
    return { paymentRequest: updated };
  }

  /** Flag on: a different admin confirms a requested change; it takes effect now. */
  async function confirmChange({ id, actorId, amountTzs = null }) {
    if (!secondApprover()) return off;
    const request = await paymentRequests.findAsync(p => p.id === id);
    if (!request) return { error: 'not_found', status: 404 };
    if (!request.changeRequestedBy) return { error: 'change_not_requested', status: 409 };
    if (request.changeRequestedBy === actorId) return { error: 'cannot_confirm_own_request', status: 403 };
    const nextStatus = request.changeRequestedStatus;
    if (!STATUSES.includes(nextStatus) || nextStatus === request.status) return { error: 'invalid_status', status: 409 };
    if (request.orderId && request.status === 'approved') return { error: 'payment_already_confirmed', status: 409 };
    if (nextStatus === 'approved') {
      const can = await upgradeApprovable(subscriptions, request);
      if (!can.ok) return { error: can.error, status: 409 };
      // A shop order approved this way is checked against the amount received, as at a decision.
      if (request.orderId && amountTzs == null) return { error: 'amount_required', status: 400 };
      const problem = await checkConfirmation(request, { reference: request.reference, amountTzs });
      if (problem) return problem;
      if (await referenceUsedElsewhere(request, request.reference)) return { error: 'reference_already_used', status: 409 };
    }
    const at = new Date().toISOString();
    const patch = {
      status: nextStatus,
      decidedAt: nextStatus === 'pending' ? null : at,
      decidedBy: nextStatus === 'pending' ? null : actorId,
      ...CHANGE_CLEARED,
    };
    // Back to pending: it has to be verified again before anyone approves it.
    if (nextStatus === 'pending') Object.assign(patch, { verifiedBy: null, verifiedAt: null });
    const updated = await writeDecision(request, patch, { changeRequestedBy: request.changeRequestedBy });
    if (updated === 'reference_already_used') return { error: 'reference_already_used', status: 409 };
    if (!updated) return { error: 'payment_changed', status: 409 };
    await applyPaymentStatusToSubscription(request, nextStatus, request.reference);
    await audit('payment_change_confirmed', actorId, request, {
      ...updated, requestedBy: request.changeRequestedBy, requestedAt: request.changeRequestedAt, reason: request.changeRequestReason,
    }, at);
    return { paymentRequest: updated };
  }

  return { list, decide, update, verify, requestChange, cancelChange, confirmChange, applyPaymentStatusToSubscription };
}
