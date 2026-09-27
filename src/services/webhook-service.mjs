// Payment-provider webhook handling — Selcom (idempotent on payment_id).
export function createWebhookService({
  subscriptions, webhookSeen,
  // Lifecycle automations: a membership paid for, or a payment that failed.
  onSubscriptionActivated = async () => {},
  onPaymentFailed = async () => {},
}) {
  async function handleSelcom({ payment_id, status, subscription_id }) {
    if (!payment_id) return { error: 'missing_payment_id', status: 400 };
    if (await webhookSeen.findAsync(w => w.id === payment_id)) return { ok: true, idempotent: true };
    if (status === 'success' && subscription_id) {
      // Only a subscription that is waiting for payment can be activated by a
      // payment; never resurrect a cancelled or expired one.
      const sub = await subscriptions.findByIdAsync(subscription_id);
      if (!sub) return { error: 'subscription_not_found', status: 404 };
      await webhookSeen.insertAsync({ id: payment_id, at: new Date().toISOString() });
      if (sub.status !== 'payment_pending') return { ok: true, ignored: 'not_payment_pending' };
      const updated = await subscriptions.updateByIdAsync(subscription_id, { status: 'active', paymentRef: payment_id });
      try { await onSubscriptionActivated(updated || { ...sub, status: 'active' }); } catch { /* best-effort */ }
      return { ok: true };
    }
    await webhookSeen.insertAsync({ id: payment_id, at: new Date().toISOString() });
    // A failed payment for a membership still waiting on it. The
    // subscription itself is left as it is.
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
