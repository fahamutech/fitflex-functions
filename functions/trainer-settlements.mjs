// Trainer payouts REST surface: prepare a week's statements, move each
// through the workflow (submit, approve, hold, pay), and let a trainer see
// their own. Preparing, approving and paying are separate permission scopes,
// the same ones gym settlement uses.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { trainerSettlementService as svc, trainerService } from '../src/bootstrap/services.mjs';

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

// ── FitFlex staff ───────────────────────────────────────────────────────────

export const adminPrepareTrainerSettlements = {
  created, method: 'post', path: '/admin/trainer-settlements/prepare',
  description: 'Admin: prepare draft trainer statements for a Monday–Sunday week that has ended (default: the last one). Body { periodStart?: "YYYY-MM-DD" (a Monday) }. Drafts of that week are rebuilt; submitted statements are left alone. Nothing is approved or paid.',
  onGuard: routeGuard('post', prepare),
  onRequest: async (req, res) => send(res, await svc.prepare({ periodStart: req.body?.periodStart || null, actorId: req.user?.sub }), 201),
};

export const adminTrainerSettlements = {
  created, method: 'get', path: '/admin/trainer-settlements',
  description: 'Admin: trainer statements, newest week first. ?status=draft|submitted|approved|payable|paid|voided &trainerId=',
  onGuard: routeGuard('get', view),
  onRequest: async (req, res) => send(res, await svc.list({ status: req.query?.status || undefined, trainerId: req.query?.trainerId || undefined })),
};

export const adminTrainerSettlement = {
  created, method: 'get', path: '/admin/trainer-settlements/:id',
  description: 'Admin: one trainer statement with its sessions and whether the trainer can be paid right now.',
  onGuard: routeGuard('get', view),
  onRequest: async (req, res) => send(res, await svc.get(req.params.id)),
};

export const adminSubmitTrainerSettlement = {
  created, method: 'post', path: '/admin/trainer-settlements/:id/submit',
  description: 'Admin: send a draft statement for approval. Its amounts are frozen.',
  onGuard: routeGuard('post', prepare), onRequest: act(svc.submit),
};

export const adminRejectTrainerSettlement = {
  created, method: 'post', path: '/admin/trainer-settlements/:id/reject',
  description: 'Admin: send a submitted statement back to draft. Body { reason }.',
  onGuard: routeGuard('post', approve), onRequest: act(svc.reject),
};

export const adminApproveTrainerSettlement = {
  created, method: 'post', path: '/admin/trainer-settlements/:id/approve',
  description: 'Admin: approve a submitted statement. Whoever submitted it cannot approve it.',
  onGuard: routeGuard('post', approve), onRequest: act(svc.approve),
};

export const adminHoldTrainerSettlement = {
  created, method: 'post', path: '/admin/trainer-settlements/:id/hold',
  description: 'Admin: put a statement on hold. Body { reason }. A payable statement goes back to approved.',
  onGuard: routeGuard('post', prepare), onRequest: act(svc.hold),
};

export const adminReleaseTrainerSettlement = {
  created, method: 'post', path: '/admin/trainer-settlements/:id/release',
  description: 'Admin: lift a hold.',
  onGuard: routeGuard('post', approve), onRequest: act(svc.release),
};

export const adminPayableTrainerSettlement = {
  created, method: 'post', path: '/admin/trainer-settlements/:id/payable',
  description: 'Admin: clear an approved statement for payment. Needs the trainer\'s KYC approved and a verified payout account past its 48-hour hold (409 not_payable with the reason otherwise).',
  onGuard: routeGuard('post', pay), onRequest: act(svc.markPayable),
};

export const adminPayTrainerSettlement = {
  created, method: 'post', path: '/admin/trainer-settlements/:id/pay',
  description: 'Admin: record that a payable statement was paid. Body { paymentReference, receiptUrl? }. The trainer is told.',
  onGuard: routeGuard('post', pay), onRequest: act(svc.pay),
};

const prepareOrApprove = [requireAuth('admin'), requireAcl('settlements_prepare', 'settlements_approve')];

export const adminRequestTrainerSettlementVoid = {
  created, method: 'post', path: '/admin/trainer-settlements/:id/void-request',
  description: 'Admin: ask for an unpaid statement (draft, submitted or approved) to be voided. Body { reason }. Nothing is voided until a different admin confirms; meanwhile it can\'t be submitted, approved or cleared for payment.',
  onGuard: routeGuard('post', prepareOrApprove), onRequest: act(svc.requestVoid),
};

export const adminCancelTrainerSettlementVoidRequest = {
  created, method: 'post', path: '/admin/trainer-settlements/:id/void-request/cancel',
  description: 'Admin: withdraw or decline a void request. Body { reason? }. The statement carries on as it was.',
  onGuard: routeGuard('post', prepareOrApprove), onRequest: act(svc.cancelVoidRequest),
};

export const adminVoidTrainerSettlement = {
  created, method: 'post', path: '/admin/trainer-settlements/:id/void',
  description: 'Admin: confirm a requested void. The confirmer must not be the person who asked. Its sessions are released for the next statement.',
  onGuard: routeGuard('post', approve), onRequest: act(svc.voidStatement),
};

// ── Trainers ────────────────────────────────────────────────────────────────

const myTrainerId = (req) => trainerService.findProfileByUser(req.user.sub)?.id || null;

export const trainerStatements = {
  created, method: 'get', path: '/trainer/statements',
  description: 'Trainer: my payout statements (from the moment they are sent for approval), and whether my payout account is ready.',
  onGuard: routeGuard('get', requireAuth('trainer')),
  onRequest: async (req, res) => {
    const trainerId = myTrainerId(req);
    if (!trainerId) return res.status(404).json({ error: 'trainer_profile_not_found' });
    send(res, await svc.listMine({ trainerId }));
  },
};

export const trainerStatement = {
  created, method: 'get', path: '/trainer/statements/:id',
  description: 'Trainer: one of my payout statements with its sessions.',
  onGuard: routeGuard('get', requireAuth('trainer')),
  onRequest: async (req, res) => {
    const trainerId = myTrainerId(req);
    if (!trainerId) return res.status(404).json({ error: 'trainer_profile_not_found' });
    send(res, await svc.getMine({ trainerId, id: req.params.id }));
  },
};
