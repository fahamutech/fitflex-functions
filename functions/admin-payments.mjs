// Admin pilot payment-request review REST surface.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { adminPaymentService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

export const adminPaymentRequests = {
  created, method: 'get', path: '/admin/payment-requests',
  description: 'Admin: list pilot payment requests.',
  onGuard: [requireAuth('admin'), requireAcl('payments')],
  onRequest: async (_, res) => res.json(await adminPaymentService.list())
};

export const adminDecidePaymentRequest = {
  created, method: 'post', path: '/admin/payment-requests/:id/decision',
  description: 'Admin: approve or reject a pilot payment request. Approval activates the subscription (or pays the shop order). Optional amountTzs is the amount actually received: a mismatch is refused (409 amount_mismatch). A reference confirms one shop order only (409 reference_already_used). A request already decided is 409 already_decided.',
  onGuard: [requireAuth('admin'), requireAcl('payments')],
  onRequest: async (req, res) => {
    const { decision, reference, note, amountTzs } = req.body || {};
    const result = await adminPaymentService.decide({ id: req.params.id, decision, reference, note, amountTzs, actorId: req.user.sub });
    if (result.error) {
      const { error, status, ...extra } = result;
      return res.status(status).json({ error, ...extra });
    }
    res.json(result.paymentRequest);
  }
};

export const adminUpdatePaymentRequest = {
  created, method: 'post', path: '/admin/payment-requests/:id',
  description: 'Admin: update pilot payment request status, reference, and note.',
  onGuard: [requireAuth('admin'), requireAcl('payments')],
  onRequest: async (req, res) => {
    const { status, reference, note, amountTzs } = req.body || {};
    const result = await adminPaymentService.update({ id: req.params.id, status, reference, note, amountTzs, actorId: req.user.sub });
    if (result.error) {
      const { error, status: code, ...extra } = result;
      return res.status(code).json({ error, ...extra });
    }
    res.json(result.paymentRequest);
  }
};
