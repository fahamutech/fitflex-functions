// Payment-provider webhooks.
import '../src/bootstrap/init.mjs';
import { timingSafeEqual } from 'node:crypto';
import { webhookService, mobileMoneyService, tunzaaSecretKey } from '../src/bootstrap/services.mjs';
import { verifySignature } from '../src/integrations/payments/tunzaa.mjs';

const created = new Date().toISOString();

// Until Selcom's signature scheme is implemented (OI-004), the callback URL
// registered with Selcom carries a shared secret: ?token=<SELCOM_WEBHOOK_SECRET>
// (or the x-selcom-webhook-token header). Without it this route would let
// anyone mark any subscription active without paying. With no secret
// configured the route is closed.
function hasWebhookToken(req) {
  const expected = process.env.SELCOM_WEBHOOK_SECRET;
  const given = req.headers?.['x-selcom-webhook-token'] ?? req.query?.token;
  if (!expected || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const selcomWebhook = {
  created, method: 'post', path: '/webhooks/selcom',
  description: 'Selcom payment webhook. Idempotent on payment_id. Requires SELCOM_WEBHOOK_SECRET as ?token= (signature verification: OI-004).',
  requestSample: { payment_id: 'sel_x', status: 'success', subscription_id: 'sub_x' },
  onRequest: async (req, res) => {
    if (!hasWebhookToken(req)) return res.status(403).json({ error: 'forbidden' });
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
