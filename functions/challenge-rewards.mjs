// Challenge rewards: what members earned, and the queues that hand them out.
// Earned → pending → approved → issued (or rejected, with a reason).
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { challengeRewardService as svc, corporateService, b2bEngagementAccess } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

function send(res, result, ok = 200) {
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.status(ok).json(result);
}

const STATUS_SAMPLE = { status: 'issued', reference: 'PASS-7D-0192', note: 'Collected at reception' };
const filters = q => ({ status: q?.status || null, challengeId: q?.challengeId || null });

export const myRewards = {
  created, method: 'get', path: '/me/rewards',
  description: 'Member: rewards earned from challenges and where each stands (pending, approved, issued, rejected).',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await svc.memberRewards(req.user.sub))
};

export const adminRewards = {
  created, method: 'get', path: '/admin/rewards',
  description: 'FitFlex admin: rewards to hand out — FitFlex- and partner-funded, and trainer/gym challenge rewards. ?status=&challengeId=',
  onGuard: [requireAuth('admin'), requireAcl('rewards')],
  onRequest: async (req, res) => send(res, await svc.queue({ kind: 'admin' }, filters(req.query)))
};

export const adminRewardStatus = {
  created, method: 'post', path: '/admin/rewards/:id/status',
  description: 'FitFlex admin: approve, issue (with a reference), reject (reason required) or reopen a reward.',
  requestSample: STATUS_SAMPLE,
  onGuard: [requireAuth('admin'), requireAcl('rewards')],
  onRequest: async (req, res) => send(res, await svc.setStatus({ kind: 'admin' }, req.user.sub, req.params.id, req.body || {}))
};

async function corporateScope(req) {
  const actor = await corporateService.resolveActorAccount({
    userId: req.user.sub, userType: req.user.userType, corporateIdParam: req.query?.corporateId,
  });
  return actor.error ? actor : { kind: 'corporate', corporateId: actor.corporateId };
}

export const corporateRewards = {
  created, method: 'get', path: '/corporate/rewards',
  description: 'Company HR: company-funded rewards their employees earned, to hand out. Names and reward only, never activity. ?status=&challengeId=',
  onGuard: [requireAuth('corporate_hr', 'admin'), requireAcl('corporate')],
  onRequest: async (req, res) => {
    const scope = await corporateScope(req);
    if (scope.error) return send(res, scope);
    send(res, await svc.queue(scope, filters(req.query)));
  }
};

export const corporateRewardStatus = {
  created, method: 'post', path: '/corporate/rewards/:id/status',
  description: 'Company HR: approve, issue, reject (reason required) or reopen a company-funded reward.',
  requestSample: STATUS_SAMPLE,
  onGuard: [requireAuth('corporate_hr', 'admin'), requireAcl('corporate')],
  onRequest: async (req, res) => {
    const scope = await corporateScope(req);
    if (scope.error) return send(res, scope);
    send(res, await svc.setStatus(scope, req.user.sub, req.params.id, req.body || {}));
  }
};

/** A B2B organisation's own users: the company-funded rewards their people earned. */
async function organizationScope(req) {
  const who = await b2bEngagementAccess.resolve(req);
  if (who.error) return who;
  return who.type === 'corporate' ? { kind: 'corporate', corporateId: who.id } : { kind: 'organization', organizationId: who.id };
}

export const organizationRewards = {
  created, method: 'get', path: '/b2b/organizations/:organizationId/rewards',
  description: 'Organisation (engagement.read): rewards its people earned in its own challenges and that it funds, to hand out. Names and reward only, never activity. ?status=&challengeId=',
  onGuard: [requireAuth(), requireAcl('b2b')],
  onRequest: async (req, res) => {
    const scope = await organizationScope(req);
    if (scope.error) return send(res, scope);
    send(res, await svc.queue(scope, filters(req.query)));
  }
};

export const organizationRewardStatus = {
  created, method: 'post', path: '/b2b/organizations/:organizationId/rewards/:id/status',
  description: 'Organisation (engagement.manage): approve, issue, reject (reason required) or reopen a reward it funds.',
  requestSample: STATUS_SAMPLE,
  onGuard: [requireAuth(), requireAcl('b2b')],
  onRequest: async (req, res) => {
    const scope = await organizationScope(req);
    if (scope.error) return send(res, scope);
    send(res, await svc.setStatus(scope, req.user.sub, req.params.id, req.body || {}));
  }
};
