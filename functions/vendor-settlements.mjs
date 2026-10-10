// Vendor payouts REST surface for FitFlex staff: prepare a week's statements
// and move each through the workflow (submit, approve, hold, pay). Preparing,
// approving and paying are separate permission scopes, the same ones gym and
// trainer settlement use. Vendors read their own statements under /vendor
// (functions/shop.mjs).
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { vendorSettlementService as svc } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();
const view = [requireAuth('admin'), requireAcl('payments')];
const prepare = [requireAuth('admin'), requireAcl('settlements_prepare')];
const approve = [requireAuth('admin'), requireAcl('settlements_approve')];
const pay = [requireAuth('admin'), requireAcl('settlements_pay')];

const send = (res, result, ok = 200) => {
  if (result.error) {
    const { error, status, ...extra } = result;
    return res.status(status).json({ error, ...extra });
  }
  res.status(ok).json(result);
};
const act = (fn) => async (req, res) => send(res, await fn({ id: req.params.id, actorId: req.user?.sub, ...(req.body || {}) }));

export const adminPrepareVendorSettlements = {
  created, method: 'post', path: '/admin/vendor-settlements/prepare',
  description: 'Admin: prepare draft vendor statements for a Monday–Sunday week that has ended (default: the last one). Body { periodStart?: "YYYY-MM-DD" (a Monday) }. Drafts of that week are rebuilt; submitted statements are left alone. Nothing is approved or paid.',
  onGuard: prepare,
  onRequest: async (req, res) => send(res, await svc.prepare({ periodStart: req.body?.periodStart || null, actorId: req.user?.sub }), 201),
};

export const adminVendorSettlements = {
  created, method: 'get', path: '/admin/vendor-settlements',
  description: 'Admin: vendor statements, newest week first. ?status=draft|submitted|approved|payable|paid|voided &vendorId=',
  onGuard: view,
  onRequest: async (req, res) => send(res, await svc.list({ status: req.query?.status || undefined, vendorId: req.query?.vendorId || undefined })),
};

export const adminVendorSettlement = {
  created, method: 'get', path: '/admin/vendor-settlements/:id',
  description: 'Admin: one vendor statement with its delivered orders and whether the vendor can be paid right now.',
  onGuard: view,
  onRequest: async (req, res) => send(res, await svc.get(req.params.id)),
};

export const adminSubmitVendorSettlement = {
  created, method: 'post', path: '/admin/vendor-settlements/:id/submit',
  description: 'Admin: send a draft statement for approval. Its amounts are frozen.',
  onGuard: prepare, onRequest: act(svc.submit),
};

export const adminRejectVendorSettlement = {
  created, method: 'post', path: '/admin/vendor-settlements/:id/reject',
  description: 'Admin: send a submitted statement back to draft. Body { reason }.',
  onGuard: approve, onRequest: act(svc.reject),
};

export const adminApproveVendorSettlement = {
  created, method: 'post', path: '/admin/vendor-settlements/:id/approve',
  description: 'Admin: approve a submitted statement. Whoever submitted it cannot approve it.',
  onGuard: approve, onRequest: act(svc.approve),
};

export const adminHoldVendorSettlement = {
  created, method: 'post', path: '/admin/vendor-settlements/:id/hold',
  description: 'Admin: put a statement on hold. Body { reason }. A payable statement goes back to approved.',
  onGuard: prepare, onRequest: act(svc.hold),
};

export const adminReleaseVendorSettlement = {
  created, method: 'post', path: '/admin/vendor-settlements/:id/release',
  description: 'Admin: lift a hold.',
  onGuard: approve, onRequest: act(svc.release),
};

export const adminPayableVendorSettlement = {
  created, method: 'post', path: '/admin/vendor-settlements/:id/payable',
  description: 'Admin: clear an approved statement for payment. Needs the vendor\'s KYC approved and a verified payout account past its 48-hour hold (409 not_payable with the reason otherwise).',
  onGuard: pay, onRequest: act(svc.markPayable),
};

export const adminPayVendorSettlement = {
  created, method: 'post', path: '/admin/vendor-settlements/:id/pay',
  description: 'Admin: record that a payable statement was paid. Body { paymentReference, receiptUrl? }. The vendor is told and its orders are marked settled.',
  onGuard: pay, onRequest: act(svc.pay),
};

export const adminVoidVendorSettlement = {
  created, method: 'post', path: '/admin/vendor-settlements/:id/void',
  description: 'Admin: void an unpaid statement. Body { reason }. Its orders are released for the next statement.',
  onGuard: approve, onRequest: act(svc.voidStatement),
};
