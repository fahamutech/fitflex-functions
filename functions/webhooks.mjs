// Payment-provider webhooks.
import '../src/bootstrap/init.mjs';
import { timingSafeEqual } from 'node:crypto';
import { webhookService } from '../src/bootstrap/services.mjs';

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
    const { payment_id, status, subscription_id } = req.body || {};
    const result = await webhookService.handleSelcom({ payment_id, status, subscription_id });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  }
};
