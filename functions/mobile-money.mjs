// Pay a payment request by mobile money (Malipo by Tunzaa).
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { mobileMoneyService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

function send(res, result) {
  if (result.error) return res.status(result.status).json({ error: result.error });
  const { status, ...body } = result;
  return res.status(status || 200).json(body);
}

export const paymentOptions = {
  created, method: 'get', path: '/payments/options',
  description: 'Whether paying by mobile money is available, and in which environment (sandbox shows a test-mode notice in the app).',
  onGuard: requireAuth(),
  onRequest: async (_, res) => res.json(mobileMoneyService.options())
};

export const payByMobileMoney = {
  created, method: 'post', path: '/me/payments/:id/mobile-money',
  description: 'Ask the member\'s phone to approve one of their pending payment requests (pass, upgrade or gym plan). Body {phone}. The amount is always the request\'s own. 404 feature_disabled while off; 409 payment_not_pending / not_payable_this_way; 400 invalid_phone.',
  requestSample: { phone: '0712345678' },
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await mobileMoneyService.pay({
    memberId: req.user.sub, paymentRequestId: req.params.id, phone: req.body?.phone,
  }))
};

export const refreshMobileMoneyPayment = {
  created, method: 'post', path: '/me/payments/:id/mobile-money/refresh',
  description: 'Has the mobile-money payment gone through? Reads the transaction back from Tunzaa and settles the request when it is complete. state: in_progress | completed | failed | held | none.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await mobileMoneyService.refresh({
    memberId: req.user.sub, paymentRequestId: req.params.id,
  }))
};
