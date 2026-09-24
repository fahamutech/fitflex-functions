// Challenge rewards: what members earned, and the queues that hand them out.
// Earned → pending → approved → issued (or rejected, with a reason).
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { challengeRewardService as svc, corporateService } from '../src/bootstrap/services.mjs';

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
  onGuard: requireAuth('corporate_hr', 'admin'),
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
  onGuard: requireAuth('corporate_hr', 'admin'),
  onRequest: async (req, res) => {
    const scope = await corporateScope(req);
    if (scope.error) return send(res, scope);
    send(res, await svc.setStatus(scope, req.user.sub, req.params.id, req.body || {}));
  }
};
