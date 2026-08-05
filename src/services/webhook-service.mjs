// Payment-provider webhook handling — Selcom (idempotent on payment_id).
export function createWebhookService({ subscriptions, webhookSeen }) {
  async function handleSelcom({ payment_id, status, subscription_id }) {
    if (!payment_id) return { error: 'missing_payment_id', status: 400 };
    if (await webhookSeen.findAsync(w => w.id === payment_id)) return { ok: true, idempotent: true };
    await webhookSeen.insertAsync({ id: payment_id, at: new Date().toISOString() });
    if (status === 'success' && subscription_id) {
      await subscriptions.updateByIdAsync(subscription_id, { status: 'active', paymentRef: payment_id });
    }
    return { ok: true };
  }

  return { handleSelcom };
}
