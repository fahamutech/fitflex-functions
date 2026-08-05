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
  description: 'Admin: approve or reject a pilot payment request. Approval activates the subscription.',
  onGuard: [requireAuth('admin'), requireAcl('payments')],
  onRequest: async (req, res) => {
    const { decision, reference, note } = req.body || {};
    const result = await adminPaymentService.decide({ id: req.params.id, decision, reference, note, actorId: req.user.sub });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.paymentRequest);
  }
};

export const adminUpdatePaymentRequest = {
  created, method: 'post', path: '/admin/payment-requests/:id',
  description: 'Admin: update pilot payment request status, reference, and note.',
  onGuard: [requireAuth('admin'), requireAcl('payments')],
  onRequest: async (req, res) => {
    const { status, reference, note } = req.body || {};
    const result = await adminPaymentService.update({ id: req.params.id, status, reference, note, actorId: req.user.sub });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.paymentRequest);
  }
};
