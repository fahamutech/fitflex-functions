// Held payments worklist (admin portal audit M5). Dormant: HELD_PAYMENTS_WORKLIST off => 404 feature_disabled.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { heldPaymentsService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

const send = (res, result, ok = 200) => {
  if (result.error) {
    const { error, status, ...extra } = result;
    return res.status(status).json({ error, ...extra });
  }
  res.status(ok).json(result);
};

export const adminHeldPayments = {
  created, method: 'get', path: '/admin/payments/held',
  description: 'Admin: money a provider confirmed that no payment request could take (request cancelled or rejected first, amount or transaction mismatch, reference already used), from the audit rows payment_mobile_money_orphaned | _held | _amount_mismatch. ?status=open (default) | resolved (a live refund exists). → { items: [{ paymentRequestId, transactionId, amountTzs, memberId, reason, at, refundId|null, requestStatus, productType, refundStatus|null }] }; reason is request_closed | amount_mismatch | transaction_mismatch | reference_already_used | sandbox_not_settled | the approval error. 400 invalid_status; 404 feature_disabled while HELD_PAYMENTS_WORKLIST is off.',
  onGuard: routeGuard('get', [requireAuth('admin'), requireAcl('payments')]),
  onRequest: async (req, res) => send(res, await heldPaymentsService.list({ status: req.query?.status || undefined })),
};

export const adminRaiseHeldPaymentRefund = {
  created, method: 'post', path: '/admin/payments/held/:paymentRequestId/refund',
  description: 'Admin: raise a refund for held money. Body { transactionId (required, must be one on the worklist for this request), reasonCode (required: payment_error | cancelled_by_fitflex | charged_twice | other-allowed refund reason), amountTzs? (up to the held amount), note? }. Same rules as POST /admin/refunds: approved at once, or with MONEY_SECOND_APPROVER on left requested for another admin (403 cannot_approve_own_request on decision; 403 cannot_pay_own_approval on paid). → 201 { refund }. 400 transaction_id_required | reason_code_required | invalid_reason | amount_exceeds_payment; 404 payment_not_found | feature_disabled; 409 not_held | refund_already_requested { refund } | use_event_refund | nothing_to_refund.',
  onGuard: routeGuard('post', [requireAuth('admin'), requireAcl('payments')]),
  onRequest: async (req, res) => send(res, await heldPaymentsService.raiseRefund({ paymentRequestId: req.params.paymentRequestId, body: req.body || {}, actorId: req.user.sub }), 201),
};
