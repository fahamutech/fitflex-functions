// Payment-provider webhook: AzamPay, the only payment provider (owner decision 2026-11-17).
import '../src/bootstrap/init.mjs';
import { mobileMoneyService, azampayClient } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

// AzamPay: checkout callback. Signed with RSA-SHA256 over
// {utilityref}{externalreference}{transactionstatus}{operator}, verified against
// AzamPay's own public key (GET /azampay/v1/public-key). AzamPay has no status
// query for collections, so this signature is what confirms a payment; the amount,
// our reference and the transaction are checked again before anything is approved.
// Without the AzamPay credentials configured the route is closed.
export const azampayWebhook = {
  created, method: 'post', path: '/webhooks/azampay',
  description: 'AzamPay checkout callback. Requires a valid RSA signature (AzamPay public key) and, when configured, the callback user/password; clientId must be ours (403 forbidden otherwise, nothing changes). Idempotent; answers 200 for anything it has understood so AzamPay stops retrying.',
  requestSample: { message: 'Transaction completed successfully', user: '', password: '', clientId: 'client', transactionstatus: 'success', operator: 'Tigo', reference: 'REF1', externalreference: 'EXT1', utilityref: 'pay_x.lq2', amount: '60000', transid: 'TXN1', msisdn: '255712345678', mnoreference: 'MNO1', signature: 'base64…' },
  onRequest: async (req, res) => {
    const body = req.body || {};
    if (!azampayClient || !(await azampayClient.verifyCallback(body))) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const result = await mobileMoneyService.handleCallback(body);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ ok: true });
  }
};
