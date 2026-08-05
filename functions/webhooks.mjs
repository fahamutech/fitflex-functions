// Payment-provider webhooks.
import '../src/bootstrap/init.mjs';
import { webhookService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

export const selcomWebhook = {
  created, method: 'post', path: '/webhooks/selcom',
  description: 'Selcom payment webhook. Idempotent on payment_id. ⛔ OI-004: signature verification pending.',
  requestSample: { payment_id: 'sel_x', status: 'success', subscription_id: 'sub_x' },
  onRequest: async (req, res) => {
    const { payment_id, status, subscription_id } = req.body || {};
    const result = await webhookService.handleSelcom({ payment_id, status, subscription_id });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  }
};
