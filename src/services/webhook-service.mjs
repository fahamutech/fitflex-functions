import { activationDates } from '../shared/subscription-status.mjs';

// Payment-provider webhook handling — Selcom (idempotent on payment_id).
export function createWebhookService({
  subscriptions, webhookSeen,
  // Optional: the payment requests a callback settles. With it, a successful
  // callback also closes the member's open request (so an admin cannot approve
  // it a second time) and its amount is checked against what was asked.
  paymentRequests = null,
  // Lifecycle automations: a membership paid for, or a payment that failed.
  onSubscriptionActivated = async () => {},
  onPaymentFailed = async () => {},
}) {
  /** Remember a payment_id; false when another delivery of it already got there. */
  async function claim(paymentId) {
    if (await webhookSeen.findAsync(w => w.id === paymentId)) return false;
    try {
      await webhookSeen.insertAsync({ id: paymentId, at: new Date().toISOString() });
      return true;
    } catch {
      // Two deliveries raced: the primary key let only one through.
      return false;
    }
  }

  async function openRequestFor(subscriptionId) {
    if (!paymentRequests) return null;
    const rows = await paymentRequests.filterAsync(p => p.subscriptionId === subscriptionId && p.status === 'pending');
    return rows[0] || null;
  }

  async function handleSelcom({ payment_id, status, subscription_id, amount }) {
    if (!payment_id) return { error: 'missing_payment_id', status: 400 };
    if (await webhookSeen.findAsync(w => w.id === payment_id)) return { ok: true, idempotent: true };
    if (status === 'success' && subscription_id) {
      // Only a subscription that is waiting for payment can be activated by a
      // payment; never resurrect a cancelled or expired one.
      const sub = await subscriptions.findByIdAsync(subscription_id);
      if (!sub) return { error: 'subscription_not_found', status: 404 };
      const request = await openRequestFor(sub.id);
      // The money received must be what was asked for this exact product.
      if (request && amount != null && Number(amount) !== Number(request.amountTzs)) {
        return { error: 'amount_mismatch', status: 409 };
      }
      if (!(await claim(payment_id))) return { ok: true, idempotent: true };
      if (sub.status !== 'payment_pending') return { ok: true, ignored: 'not_payment_pending' };
      // The plan's period starts now that it is paid for.
      const updated = await subscriptions.updateByIdAsync(subscription_id, { status: 'active', paymentRef: payment_id, ...activationDates(sub) });
      if (request) {
        await paymentRequests.updateByIdAsync(request.id, {
          status: 'approved', reference: payment_id, decidedAt: new Date().toISOString(), decidedBy: 'selcom',
        });
      }
      try { await onSubscriptionActivated(updated || { ...sub, status: 'active' }, request ? { requestedAt: request.requestedAt, amountTzs: request.amountTzs } : undefined); } catch { /* best-effort */ }
      return { ok: true };
    }
    if (!(await claim(payment_id))) return { ok: true, idempotent: true };
    // A failed payment for a membership still waiting on it. The
    // subscription itself is left as it is (the member can retry).
    if (status && status !== 'success' && subscription_id) {
      const sub = await subscriptions.findByIdAsync(subscription_id);
      if (sub?.status === 'payment_pending') {
        try { await onPaymentFailed(sub, payment_id); } catch { /* best-effort */ }
      }
    }
    return { ok: true };
  }

  return { handleSelcom };
}
