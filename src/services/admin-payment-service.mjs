// Admin payment-request review — approve/reject pilot payments. List rows
// embed a LEAN member/subscription projection only (not the full user row
// with memberProfile/aclPermissions) to keep the list endpoint's payload small.
import { randomUUID } from 'node:crypto';
import { activationDates } from '../shared/subscription-status.mjs';
import { productTypeOfPayment, PRODUCT_TYPES } from '../shared/payment-product.mjs';
import { upgradeOf, upgradeApprovable, applyUpgradeStatus } from '../shared/pass-upgrade.mjs';
import { updateIf } from '../shared/conditional-update.mjs';
import { referenceKey, memoryReferenceStore } from '../shared/manual-payment.mjs';
import { moneySecondApproverOn } from '../shared/feature-flags.mjs';
import { staffNameLookup } from '../shared/staff-names.mjs';

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
  // Before a trainer booking group's payment is approved: (request) → null | { error, status, ... }.
  // Refuses a payment covering a rejected session whose slot someone else has booked since.
  beforeBookingPayment = async () => null,
  // The booking group refused a decision already written (a rejected session's slot was booked by someone
  // else between the check and the write): ({ request, refusal, rolledBack, actorId }) → void. Wired to an ops alert.
  onBookingPaymentRefused = async () => {},
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
  // A1: two admins on every manual payment decision (MONEY_SECOND_APPROVER). Off: unchanged.
  secondApprover = moneySecondApproverOn,
  // Marathon & Events S4 (EVENT_ORDER). Every dep defaults to a no-op / absent, and every branch below is reached only
  // by a request that carries `eventOrderId`, so the other products behave exactly as before.
  // Before an event order's payment is confirmed: (request, { amountTzs }) → null | { error, status }. The amount received is mandatory.
  beforeEventOrderPayment = async () => null,
  // An approved event request whose order is not confirmed is re-applied (idempotent repair): (request, status) → void.
  onEventOrderPayment = async () => {},
  // The decision transaction: (request, patch, guard, meta) → updated row | null | 'reference_already_used' | { error, status }.
  // Writes the PaymentRequest, the EventPayment and the order confirmation (tickets, outbox, audit) together.
  writeEventDecision = null,
  // Reject input for event requests: ({ reasonCode, memberNote }) → null | { error, status }.
  checkEventRejection = () => null,
  // The event rows of the admin list, one batch: (requests) → Map<requestId, projection>; and the event-only list for ?productType=EVENT_ORDER.
  projectEventRequests = async () => new Map(),
  listEventRequests = null,
  // The outcome the decision transaction recorded for an updated row (confirmed | reheld | refund_raised): (row) → { outcome, … } | null.
  eventOutcomeOf = () => null,
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
  // → { error, ... } only when a booking group refused the decision (nothing on its side moved).
  async function applyPaymentStatusToSubscription(request, status, reference, actorId = null) {
    // S4: an event order's payment was applied inside the decision transaction; this is the idempotent repair.
    if (request.eventOrderId) {
      await onEventOrderPayment(request, status);
      return null;
    }
    if (request.bookingGroupId) {
      const out = await onBookingPayment(request.bookingGroupId, status, { actorId });
      return out?.error ? out : null;
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

  async function list({ productType = null, status = null, limit = null } = {}) {
    // The Payments page filter for event tickets must not load the whole table during a sale.
    const eventOnly = productType === PRODUCT_TYPES.EVENT_ORDER && typeof listEventRequests === 'function';
    const allPayReqs = eventOnly ? await listEventRequests({ limit, status }) : await paymentRequests.allAsync();
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

    // Staff who acted on each row, by name (admin list only; null when not a portal/admin user).
    const nameOf = await staffNameLookup(users, allPayReqs, ['verifiedBy', 'changeRequestedBy', 'decidedBy']);

    const twoAdmins = secondApprover();
    const eventRows = await projectEventRequests(allPayReqs);
    const rows = allPayReqs.map(p => ({
      ...p,
      verifiedByName: nameOf(p.verifiedBy),
      changeRequestedByName: nameOf(p.changeRequestedBy),
      decidedByName: nameOf(p.decidedBy),
      member: slimMember(memberById.get(p.memberId) || null),
      subscription: slimSub(subById.get(p.subscriptionId) || null),
      productType: productTypeOfPayment(p, subById.get(p.subscriptionId) || null),
      gym: slimGym(p.gymId),
      ...(eventRows.has(p.id) ? { eventOrder: eventRows.get(p.id) } : {}),
      ...(twoAdmins ? secondApproval(p) : {}),
    }));
    // ?productType= / ?status= / ?limit= are additive: with none of them the list is exactly what it was.
    let out = productType ? rows.filter(r => r.productType === productType) : rows;
    if (status && STATUSES.includes(status)) out = out.filter(r => r.status === status);
    const n = Math.min(Math.max(parseInt(limit, 10) || 0, 0), 5000);
    return n ? out.slice(0, n) : out;
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
    // S4: an event order's reference pays for that order only, as a shop order's does.
    if (!(request.orderId || request.eventOrderId) || !reference || String(reference).startsWith('ADMIN_')) return false;
    const same = await paymentRequests.filterByColumnAsync('reference', reference);
    return same.some(p => p.id !== request.id && (p.orderId || p.eventOrderId) && p.status === 'approved');
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

  /** Checks that must hold before a shop order's (or a trainer booking group's) payment is confirmed. */
  async function checkConfirmation(request, { reference, amountTzs }) {
    if (request.bookingGroupId) {
      const problem = await beforeBookingPayment(request);
      if (problem?.error) return problem;
    }
    if (request.eventOrderId) {
      const problem = await beforeEventOrderPayment(request, { amountTzs });
      if (problem?.error) return problem;
      if (await referenceInUse(request, reference)) return { error: 'reference_already_used', status: 409 };
      return null;
    }
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
  async function writeDecision(request, patch, guard = {}, meta = {}) {
    // S4: one transaction for the request and everything an event payment confirms (tickets, outbox, audit).
    if (request.eventOrderId && writeEventDecision) return writeEventDecision(request, patch, guard, meta);
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

  /**
   * The decision is written but its booking group refused it (security review of #231, race 1): put the
   * payment request back as it was read, record it and tell staff. The fields put back are the ones the
   * decision wrote, and only while the request still shows that decision.
   */
  async function undoRefusedDecision(request, updated, patch, refusal, actorId) {
    const restore = Object.fromEntries(Object.keys(patch).map(k => [k, request[k] ?? null]));
    const back = await updateIf(paymentRequests, request.id, { status: updated.status }, restore);
    const at = new Date().toISOString();
    await auditLog.insertAsync({
      id: randomUUID(), at, actor: actorId, action: 'payment_decision_rolled_back', target: request.id,
      before: updated, after: { paymentRequest: back || null, rolledBack: Boolean(back), refusal },
    });
    try {
      await onBookingPaymentRefused({ request, refusal, rolledBack: Boolean(back), actorId });
    } catch (err) {
      console.error(`[admin-payment] ops alert for ${request.id} failed: ${err?.message || err}`);
    }
    return back ? refusal : { ...refusal, rolledBack: false };
  }

  const referenceChanged = (request, reference) => reference != null && reference !== '' && reference !== request.reference;

  async function decide({ id, decision, reference, note, actorId, amountTzs = null, automated = false, reasonCode = null, memberNote = null, memberNoteSw = null, providerPayload = null }) {
    if (!['approve', 'reject'].includes(decision)) return { error: 'invalid_decision', status: 400 };
    const request = await paymentRequests.findAsync(p => p.id === id);
    if (!request) return { error: 'not_found', status: 404 };
    if (request.status !== 'pending') return { error: 'already_decided', status: 409 };
    // S4: rejecting an event payment needs a reason code (a closed set) so the member can correct it.
    if (decision === 'reject' && request.eventOrderId) {
      const bad = checkEventRejection({ reasonCode, memberNote, memberNoteSw });
      if (bad) return bad;
    }
    // Approving with no reference typed, and none recorded yet (e.g. by a verifying admin),
    // confirms the transaction ID the member gave (slice A3). A recorded or typed one wins.
    const memberRef = decision === 'approve' ? memberRefFor(request, reference || request.reference) : null;
    const finalRef = reference || request.reference || memberRef;
    if (decision === 'approve') {
      const blocked = approvalBlocked(request, actorId, automated, reference);
      if (blocked) return blocked;
      const can = await upgradeApprovable(subscriptions, request);
      if (!can.ok) return { error: can.error, status: 409 };
      const problem = await checkConfirmation(request, { reference: reference || request.reference, amountTzs });
      if (problem) return problem;
      // The final reference (typed, else recorded, else the member's ID) is checked both ways: by its
      // letters+digits key against pending/approved requests (A3) and, flag on, verbatim against approved ones (A1).
      if (await finalReferenceTaken(request, finalRef) || await referenceUsedElsewhere(request, finalRef)) {
        return { error: 'reference_already_used', status: 409 };
      }
    }

    const now = new Date().toISOString();
    const status = decision === 'approve' ? 'approved' : 'rejected';
    // Approved by a second admin: only while the verification it was checked against still stands.
    const guard = (decision === 'approve' && !automated && secondApprover()) ? { verifiedBy: request.verifiedBy } : {};
    const patch = {
      status,
      reference: finalRef,
      // An upgrade's note names the plan it upgrades: it stays as it is.
      note: upgradeOf(request) ? request.note : (note || null),
      decidedAt: now,
      decidedBy: actorId
    };
    const updated = await writeDecision(request, patch, guard, { actorId, automated, reasonCode, memberNote, memberNoteSw, amountTzs, providerPayload });
    // Another decision got there first (two staff members, or a double click).
    if (updated === 'reference_already_used') return { error: 'reference_already_used', status: 409 };
    if (updated?.error) return updated;
    if (!updated) return { error: 'already_decided', status: 409 };
    // The plan records the reference the payment request now carries (typed, else verified/recorded,
    // else the member's transaction ID); ADMIN_<id> only when there is none at all.
    const refused = await applyPaymentStatusToSubscription(request, status, updated.reference || finalRef || `ADMIN_${request.id}`, actorId);
    if (refused) return undoRefusedDecision(request, updated, patch, refused, actorId);
    await auditLog.insertAsync({
      id: randomUUID(), at: now, actor: actorId,
      action: `payment_${status}`, target: request.id, before: request, after: updated
    });
    const event = request.eventOrderId ? eventOutcomeOf(updated) : null;
    return event ? { paymentRequest: updated, event } : { paymentRequest: updated };
  }

  async function update({ id, status, reference, note, actorId, amountTzs = null, reasonCode = null, memberNote = null, memberNoteSw = null }) {
    const allowed = ['pending', 'approved', 'rejected', 'cancelled'];
    if (status && !allowed.includes(status)) return { error: 'invalid_status', status: 400 };
    const request = await paymentRequests.findAsync(p => p.id === id);
    if (!request) return { error: 'not_found', status: 404 };
    const nextStatus = status || request.status;
    // S4: rejecting an event payment needs a reason code, however it is done.
    if (request.eventOrderId && nextStatus === 'rejected' && request.status !== 'rejected') {
      const bad = checkEventRejection({ reasonCode, memberNote, memberNoteSw });
      if (bad) return bad;
    }
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
    // A confirmed shop-order (or event-order) payment is not edited back: the order is paid, maybe fulfilled.
    // Getting the money back is the refund workflow.
    // L4: nor is the reference of a confirmed event payment rewritten.
    if (request.eventOrderId && request.status === 'approved' && referenceChanged(request, reference)) {
      return { error: 'payment_already_confirmed', status: 409 };
    }
    if ((request.orderId || request.eventOrderId) && request.status === 'approved' && nextStatus !== 'approved') {
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
      // The final reference (typed, else recorded, else the member's ID) is checked both ways: by its
      // letters+digits key against pending/approved requests (A3) and, flag on, verbatim against approved ones (A1).
      if (await finalReferenceTaken(request, finalRef) || await referenceUsedElsewhere(request, finalRef)) {
        return { error: 'reference_already_used', status: 409 };
      }
    }
    const now = new Date().toISOString();
    const twoAdmins = secondApprover();
    // Flag on: a note-only edit of a decided payment keeps who decided it.
    const keepDecider = twoAdmins && DECIDED.includes(request.status) && nextStatus === request.status;
    const patch = {
      status: nextStatus,
      reference: finalRef,
      note: upgradeOf(request) ? request.note : (note ?? request.note ?? null),
      decidedAt: nextStatus === 'pending' ? null : (request.decidedAt || now),
      decidedBy: nextStatus === 'pending' ? null : (keepDecider ? request.decidedBy : actorId)
    };
    // Flag on: only while the verification read still stands (a stale read cannot overwrite a verified payment).
    const updated = await writeDecision(request, patch, twoAdmins ? { verifiedBy: request.verifiedBy ?? null } : {}, { actorId, amountTzs, reasonCode, memberNote, memberNoteSw });
    if (updated === 'reference_already_used') return { error: 'reference_already_used', status: 409 };
    if (updated?.error) return updated;
    if (!updated) return { error: 'payment_changed', status: 409 };
    const refused = await applyPaymentStatusToSubscription(request, nextStatus, updated.reference || finalRef, actorId);
    if (refused) return undoRefusedDecision(request, updated, patch, refused, actorId);
    await auditLog.insertAsync({
      id: randomUUID(), at: now, actor: actorId,
      action: 'payment_updated', target: request.id, before: request, after: updated
    });
    const event = request.eventOrderId ? eventOutcomeOf(updated) : null;
    return event ? { paymentRequest: updated, event } : { paymentRequest: updated };
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
    // Nothing typed: keep the reference the payment has, else the transaction ID the member gave
    // when paying (memberReference, slice A3).
    const finalReference = typed ?? request.reference ?? text(request.memberReference, 120) ?? null;
    if (await finalReferenceTaken(request, finalReference) || await referenceUsedElsewhere(request, finalReference)) {
      return { error: 'reference_already_used', status: 409 };
    }
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
    // A confirmed shop-order (or event-order) payment is not edited back: getting the money back is the refund workflow.
    if ((request.orderId || request.eventOrderId) && request.status === 'approved') return { error: 'payment_already_confirmed', status: 409 };
    // S4: the only change an event payment accepts is a mistaken rejection becoming an approval (the payment machine has no other move).
    if (request.eventOrderId && !(request.status === 'rejected' && status === 'approved')) return { error: 'event_payment_change_not_allowed', status: 409 };
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
    if ((request.orderId || request.eventOrderId) && request.status === 'approved') return { error: 'payment_already_confirmed', status: 409 };
    if (nextStatus === 'approved') {
      const can = await upgradeApprovable(subscriptions, request);
      if (!can.ok) return { error: can.error, status: 409 };
      // A shop (or event) order approved this way is checked against the amount received, as at a decision.
      if ((request.orderId || request.eventOrderId) && amountTzs == null) return { error: 'amount_required', status: 400 };
      const problem = await checkConfirmation(request, { reference: request.reference, amountTzs });
      if (problem) return problem;
      // As at a decision: the final reference (recorded, else the member's ID) must not be used elsewhere.
      const finalRef = request.reference || request.memberReference || null;
      if (await finalReferenceTaken(request, finalRef) || await referenceUsedElsewhere(request, finalRef)) {
        return { error: 'reference_already_used', status: 409 };
      }
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
    // Approved with no reference recorded: record the member's transaction ID, as a decision does.
    if (nextStatus === 'approved' && !request.reference && request.memberReference) patch.reference = request.memberReference;
    const updated = await writeDecision(request, patch, { changeRequestedBy: request.changeRequestedBy }, { actorId, amountTzs, automated: false });
    if (updated === 'reference_already_used') return { error: 'reference_already_used', status: 409 };
    if (updated?.error) return updated;
    if (!updated) return { error: 'payment_changed', status: 409 };
    const refused = await applyPaymentStatusToSubscription(request, nextStatus, updated.reference || request.reference, actorId);
    if (refused) return undoRefusedDecision(request, updated, patch, refused, actorId);
    await audit('payment_change_confirmed', actorId, request, {
      ...updated, requestedBy: request.changeRequestedBy, requestedAt: request.changeRequestedAt, reason: request.changeRequestReason,
    }, at);
    const event = request.eventOrderId ? eventOutcomeOf(updated) : null;
    return event ? { paymentRequest: updated, event } : { paymentRequest: updated };
  }

  return { list, decide, update, verify, requestChange, cancelChange, confirmChange, applyPaymentStatusToSubscription };
}
