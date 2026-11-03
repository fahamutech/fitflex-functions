// Payment-provider webhooks.
import '../src/bootstrap/init.mjs';
import { webhookService, mobileMoneyService, tunzaaSecretKey } from '../src/bootstrap/services.mjs';
import { hasWebhookToken, redactWebhookToken } from '../src/integrations/payments/selcom-token.mjs';
import { verifySignature } from '../src/integrations/payments/tunzaa.mjs';

// Selcom: shared secret in x-selcom-webhook-token (or legacy ?token=) until the
// signature scheme is known (OI-004; provider change D34). No secret = route closed.
const created = new Date().toISOString();

export const selcomWebhook = {
  created, method: 'post', path: '/webhooks/selcom',
  description: 'Selcom payment webhook. Idempotent on payment_id. Requires SELCOM_WEBHOOK_SECRET in the x-selcom-webhook-token header (or ?token=, deprecated; signature verification: OI-004). The secret is redacted from request logs.',
  requestSample: { payment_id: 'sel_x', status: 'success', subscription_id: 'sub_x' },
  onRequest: async (req, res) => {
    const authorised = hasWebhookToken(req);
    redactWebhookToken(req);
    if (!authorised) return res.status(403).json({ error: 'forbidden' });
    const { payment_id, status, subscription_id, amount } = req.body || {};
    const result = await webhookService.handleSelcom({ payment_id, status, subscription_id, amount });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  }
};

// Malipo by Tunzaa: transaction status callback. Signed with X-Signature
// (HMAC-SHA256 of the JSON, keys sorted, under the API secret key). Without the
// secret configured the route is closed. A good signature is still only a
// trigger: the payment is confirmed with Tunzaa before anything is approved.
export const tunzaaWebhook = {
  created, method: 'post', path: '/webhooks/tunzaa',
  description: 'Malipo by Tunzaa payment callback. Requires a valid X-Signature. Idempotent; answers 200 for anything it has understood so Tunzaa stops retrying.',
  requestSample: { transaction_id: 'TXN_1', reference_id: 'pay_x', invoice_id: null, status: 'COMPLETED', amount: '60000.00', payment_date: '2026-10-14 10:00:00', timestamp: '2026-10-14 10:00:05', remark: 'Payment successful' },
  onRequest: async (req, res) => {
    const signature = req.headers?.['x-signature'];
    if (!tunzaaSecretKey || !verifySignature(req.body, signature, tunzaaSecretKey)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const result = await mobileMoneyService.handleCallback(req.body);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ ok: true });
  }
};
