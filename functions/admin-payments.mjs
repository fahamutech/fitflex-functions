// Admin pilot payment-request review REST surface.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { adminPaymentService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

export const adminPaymentRequests = {
  created, method: 'get', path: '/admin/payment-requests',
  description: 'Admin: list pilot payment requests. Rows carry verifiedBy, verifiedAt, changeRequestedStatus, changeRequestedBy, changeRequestedAt, changeRequestReason, and staff names verifiedByName, changeRequestedByName, decidedByName (portal/admin user display name, else email; null when unknown or not staff); with MONEY_SECOND_APPROVER on also secondApproverRequired, approvalStage, approveNotBy, confirmChangeNotBy.',
  onGuard: [requireAuth('admin'), requireAcl('payments')],
  onRequest: async (_, res) => res.json(await adminPaymentService.list())
};

export const adminDecidePaymentRequest = {
  created, method: 'post', path: '/admin/payment-requests/:id/decision',
  description: 'Admin: approve or reject a pilot payment request. Approval activates the subscription (or pays the shop order). Optional amountTzs is the amount actually received: a mismatch is refused (409 amount_mismatch). A reference confirms one shop order only (409 reference_already_used). A request already decided is 409 already_decided. With MONEY_SECOND_APPROVER on, approving needs a verification first (409 verification_required) by a different admin (403 cannot_approve_own_verification), with the verified reference (409 reference_differs_from_verification), and a reference already on another approved payment is refused (409 reference_already_used); rejecting stays single-admin.',
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
  description: 'Admin: update pilot payment request status, reference, and note. With MONEY_SECOND_APPROVER on: a decided payment only takes note edits (status or reference change is 409 change_requires_confirmation: use /change-request); pending → approved follows the verify rule (409 verification_required, 403 cannot_approve_own_verification); a verified payment keeps its reference (409 reference_differs_from_verification); a mobile-money payment keeps its provider reference (409 reference_locked_provider); approving with a reference already on another approved payment is 409 reference_already_used.',
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

// ── A1 · second approver (MONEY_SECOND_APPROVER; 404 feature_disabled while off) ──

const reply = (res, result) => {
  if (result.error) {
    const { error, status: code, ...extra } = result;
    return res.status(code).json({ error, ...extra });
  }
  res.json(result.paymentRequest);
};

export const adminVerifyPaymentRequest = {
  created, method: 'post', path: '/admin/payment-requests/:id/verify',
  description: 'Admin (MONEY_SECOND_APPROVER on): record that a pending manual payment arrived. Body { reference?, note? }. A different admin then approves it (403 cannot_approve_own_verification). A mobile-money payment keeps its provider reference (409 reference_locked_provider). With no reference typed, the payment keeps its reference, else takes the one the member gave (memberReference, when present). A reference already on another approved payment is 409 reference_already_used. 409 already_decided | already_verified | payment_changed; 404 not_found | feature_disabled. → paymentRequest',
  onGuard: [requireAuth('admin'), requireAcl('payments')],
  onRequest: async (req, res) => {
    const { reference, note } = req.body || {};
    reply(res, await adminPaymentService.verify({ id: req.params.id, reference, note, actorId: req.user.sub }));
  }
};

export const adminRequestPaymentChange = {
  created, method: 'post', path: '/admin/payment-requests/:id/change-request',
  description: 'Admin (MONEY_SECOND_APPROVER on): ask to change a decided payment (approved | rejected | cancelled) to another status. Body { status: pending | approved | rejected | cancelled, reason }. A different admin confirms. 400 invalid_status | reason_required | no_change; 409 not_decided | change_already_requested | payment_already_confirmed | payment_changed; 404 not_found | feature_disabled. → paymentRequest',
  onGuard: [requireAuth('admin'), requireAcl('payments')],
  onRequest: async (req, res) => {
    const { status, reason } = req.body || {};
    reply(res, await adminPaymentService.requestChange({ id: req.params.id, status, reason, actorId: req.user.sub }));
  }
};

export const adminConfirmPaymentChange = {
  created, method: 'post', path: '/admin/payment-requests/:id/change-request/confirm',
  description: 'Admin (MONEY_SECOND_APPROVER on): confirm a requested change; it takes effect now (plan activated or reversed as with a decision). Body { amountTzs? } (required when a shop-order payment becomes approved: 400 amount_required; 409 amount_mismatch). 403 cannot_confirm_own_request; 409 change_not_requested | payment_already_confirmed | payment_changed | reference_already_used | upgrade errors; 404 not_found | feature_disabled. → paymentRequest',
  onGuard: [requireAuth('admin'), requireAcl('payments')],
  onRequest: async (req, res) => reply(res, await adminPaymentService.confirmChange({ id: req.params.id, amountTzs: req.body?.amountTzs ?? null, actorId: req.user.sub }))
};

export const adminCancelPaymentChange = {
  created, method: 'post', path: '/admin/payment-requests/:id/change-request/cancel',
  description: 'Admin (MONEY_SECOND_APPROVER on): withdraw or decline a change request; the payment stays as it is. Body { reason? }. 409 change_not_requested | payment_changed; 404 not_found | feature_disabled. → paymentRequest',
  onGuard: [requireAuth('admin'), requireAcl('payments')],
  onRequest: async (req, res) => {
    const { reason } = req.body || {};
    reply(res, await adminPaymentService.cancelChange({ id: req.params.id, reason, actorId: req.user.sub }));
  }
};
