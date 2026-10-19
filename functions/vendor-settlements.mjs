// Vendor payouts REST surface for FitFlex staff: prepare a week's statements
// and move each through the workflow (submit, approve, hold, pay). Preparing,
// approving and paying are separate permission scopes, the same ones gym and
// trainer settlement use. Vendors read their own statements under /vendor
// (functions/shop.mjs).
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
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
// Only the fields the statement actions read are taken from the body (reason: reject, hold,
// void-request and its cancel; paymentReference and receiptUrl: pay). The statement id and the
// actor always come from the route and the token: a body must never name who is acting, or one
// admin could submit and approve, or request and confirm a void, as two people.
const act = (fn) => async (req, res) => {
  const body = req.body || {};
  return send(res, await fn({
    reason: body.reason, paymentReference: body.paymentReference, receiptUrl: body.receiptUrl,
    id: req.params.id, actorId: req.user?.sub,
  }));
};

export const adminPrepareVendorSettlements = {
  created, method: 'post', path: '/admin/vendor-settlements/prepare',
  description: 'Admin: prepare draft vendor statements for a Monday–Sunday week that has ended (default: the last one). Body { periodStart?: "YYYY-MM-DD" (a Monday) }. Drafts of that week are rebuilt; submitted statements are left alone. Nothing is approved or paid.',
  onGuard: routeGuard('post', prepare),
  onRequest: async (req, res) => send(res, await svc.prepare({ periodStart: req.body?.periodStart || null, actorId: req.user?.sub }), 201),
};

export const adminVendorSettlements = {
  created, method: 'get', path: '/admin/vendor-settlements',
  description: 'Admin: vendor statements, newest week first. ?status=draft|submitted|approved|payable|paid|voided &vendorId=',
  onGuard: routeGuard('get', view),
  onRequest: async (req, res) => send(res, await svc.list({ status: req.query?.status || undefined, vendorId: req.query?.vendorId || undefined })),
};

export const adminVendorSettlement = {
  created, method: 'get', path: '/admin/vendor-settlements/:id',
  description: 'Admin: one vendor statement with its delivered orders and whether the vendor can be paid right now.',
  onGuard: routeGuard('get', view),
  onRequest: async (req, res) => send(res, await svc.get(req.params.id)),
};

export const adminSubmitVendorSettlement = {
  created, method: 'post', path: '/admin/vendor-settlements/:id/submit',
  description: 'Admin: send a draft statement for approval. Its amounts are frozen.',
  onGuard: routeGuard('post', prepare), onRequest: act(svc.submit),
};

export const adminRejectVendorSettlement = {
  created, method: 'post', path: '/admin/vendor-settlements/:id/reject',
  description: 'Admin: send a submitted statement back to draft. Body { reason }.',
  onGuard: routeGuard('post', approve), onRequest: act(svc.reject),
};

export const adminApproveVendorSettlement = {
  created, method: 'post', path: '/admin/vendor-settlements/:id/approve',
  description: 'Admin: approve a submitted statement. Whoever submitted it cannot approve it.',
  onGuard: routeGuard('post', approve), onRequest: act(svc.approve),
};

export const adminHoldVendorSettlement = {
  created, method: 'post', path: '/admin/vendor-settlements/:id/hold',
  description: 'Admin: put a statement on hold. Body { reason }. A payable statement goes back to approved.',
  onGuard: routeGuard('post', prepare), onRequest: act(svc.hold),
};

export const adminReleaseVendorSettlement = {
  created, method: 'post', path: '/admin/vendor-settlements/:id/release',
  description: 'Admin: lift a hold.',
  onGuard: routeGuard('post', approve), onRequest: act(svc.release),
};

export const adminPayableVendorSettlement = {
  created, method: 'post', path: '/admin/vendor-settlements/:id/payable',
  description: 'Admin: clear an approved statement for payment. Needs the vendor\'s KYC approved and a verified payout account past its 48-hour hold (409 not_payable with the reason otherwise).',
  onGuard: routeGuard('post', pay), onRequest: act(svc.markPayable),
};

export const adminPayVendorSettlement = {
  created, method: 'post', path: '/admin/vendor-settlements/:id/pay',
  description: 'Admin: record that a payable statement was paid. Body { paymentReference, receiptUrl? }. The vendor is told and its orders are marked settled.',
  onGuard: routeGuard('post', pay), onRequest: act(svc.pay),
};

const prepareOrApprove = [requireAuth('admin'), requireAcl('settlements_prepare', 'settlements_approve')];

export const adminRequestVendorSettlementVoid = {
  created, method: 'post', path: '/admin/vendor-settlements/:id/void-request',
  description: 'Admin: ask for an unpaid statement (draft, submitted or approved) to be voided. Body { reason }. Nothing is voided until a different admin confirms; meanwhile it can\'t be submitted, approved or cleared for payment.',
  onGuard: routeGuard('post', prepareOrApprove), onRequest: act(svc.requestVoid),
};

export const adminCancelVendorSettlementVoidRequest = {
  created, method: 'post', path: '/admin/vendor-settlements/:id/void-request/cancel',
  description: 'Admin: withdraw or decline a void request. Body { reason? }. The statement carries on as it was.',
  onGuard: routeGuard('post', prepareOrApprove), onRequest: act(svc.cancelVoidRequest),
};

export const adminVoidVendorSettlement = {
  created, method: 'post', path: '/admin/vendor-settlements/:id/void',
  description: 'Admin: confirm a requested void. The confirmer must not be the person who asked. Its orders are released for the next statement.',
  onGuard: routeGuard('post', approve), onRequest: act(svc.voidStatement),
};
