// Payment-provider webhook: AzamPay, the only payment provider (owner decision 2026-11-17).
import '../src/bootstrap/init.mjs';
import { mobileMoneyService, azampayClient } from '../src/bootstrap/services.mjs';
import { azampaySandboxUnsignedCallbacksOn } from '../src/shared/feature-flags.mjs';

const created = new Date().toISOString();

// AzamPay: checkout callback. Signed with RSA-SHA256 over
// {utilityref}{externalreference}{transactionstatus}{operator}, verified against
// AzamPay's own public key (GET /azampay/v1/public-key). AzamPay has no status
// query for collections, so this signature is what confirms a payment; the amount,
// our reference and the transaction are checked again before anything is approved.
// Without the AzamPay credentials configured the route is closed.
export const azampayWebhook = {
  created, method: 'post', path: '/webhooks/azampay',
  description: 'AzamPay checkout callback. Requires a valid RSA signature (AzamPay public key) and, when configured, the callback user/password; clientId must be ours (403 forbidden otherwise, nothing changes). Sandbox only, with AZAMPAY_SANDBOX_UNSIGNED_CALLBACKS: a callback whose signature cannot be checked is acted on only when it names the open attempt (our reference and the transaction id AzamPay returned for it) with the exact amount. Every call is logged ([azampay] callback / callback_refused) without secrets. Idempotent; answers 200 for anything it has understood so AzamPay stops retrying.',
  requestSample: { message: 'Transaction completed successfully', user: '', password: '', clientId: 'client', transactionstatus: 'success', operator: 'Tigo', reference: 'REF1', externalreference: 'EXT1', utilityref: 'pay_x.lq2', amount: '60000', transid: 'TXN1', msisdn: '255712345678', mnoreference: 'MNO1', signature: 'base64…' },
  onRequest: async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const seen = callbackSummary(body);
    if (!azampayClient) {
      console.warn('[azampay] callback_refused', JSON.stringify({ ...seen, reason: 'client_not_configured' }));
      return res.status(403).json({ error: 'forbidden' });
    }
    const check = await azampayClient.checkCallback(body, { allowUnsigned: azampaySandboxUnsignedCallbacksOn() });
    if (!check.ok) {
      console.warn('[azampay] callback_refused', JSON.stringify({ ...seen, reason: check.reason }));
      return res.status(403).json({ error: 'forbidden' });
    }
    const result = await mobileMoneyService.handleCallback(body, { signed: check.signed });
    console.info('[azampay] callback', JSON.stringify({
      ...seen, signed: check.signed, check: check.reason,
      outcome: result.error ?? result.state ?? result.ignored ?? (result.duplicate ? 'duplicate' : 'ok'),
      ...(result.reason ? { reason: result.reason } : {}), httpStatus: result.error ? result.status : 200,
    }));
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ ok: true });
  }
};

/**
 * What a callback carried, for the log: the field names present and the non-secret values.
 * Never the signature, user, password or full phone number (last 3 digits only).
 */
function callbackSummary(body) {
  const short = (v) => (v == null ? null : String(v).slice(0, 80));
  const msisdn = body.msisdn == null ? null : String(body.msisdn);
  return {
    fields: Object.keys(body).sort(),
    utilityref: short(body.utilityref), transactionstatus: short(body.transactionstatus), operator: short(body.operator),
    amount: short(body.amount), transid: short(body.transid), reference: short(body.reference),
    externalreference: short(body.externalreference),
    msisdn: msisdn ? `***${msisdn.slice(-3)}` : null,
    clientIdPresent: typeof body.clientId === 'string' && body.clientId !== '',
    signaturePresent: typeof body.signature === 'string' && body.signature.trim() !== '',
    signatureLength: typeof body.signature === 'string' ? body.signature.trim().length : 0,
  };
}
