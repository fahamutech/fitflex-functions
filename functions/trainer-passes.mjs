// Trainer gym access REST surface — which gyms a trainer can train at and
// how (home gym free / trainer pass / member plan), plus their passes.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { gymService, subscriptionService, trainerService, partnerGate } from '../src/bootstrap/services.mjs';
import { trainerGymAccess } from '../src/shared/trainer-access.mjs';

const created = new Date().toISOString();

export const trainerGyms = {
  created, method: 'get', path: '/trainer/gyms',
  description: "Trainer: active gyms with trainerAccess { access: home|trainer_pass|member_plan|unavailable, options:[{kind, period, feeTzs}] } and the trainer's current pass/plan there.",
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => {
    const trainer = trainerService.findProfileByUser(req.user.sub);
    const passes = await subscriptionService.trainerPasses({ trainerUserId: req.user.sub });
    const current = (gymId) => passes.find(p => p.homeGymId === gymId && ['active', 'payment_pending'].includes(p.status)) || null;
    const gyms = await partnerGate.badgeGyms(await gymService.listActiveAsync());
    res.json(gyms.map(gym => ({ ...gym, trainerAccess: trainerGymAccess({ trainer, gym }), currentPass: current(gym.id) })));
  }
};

export const trainerMyPasses = {
  created, method: 'get', path: '/trainer/passes',
  description: "Trainer: own trainer passes and gym member plans, newest first (status, gym, pending payment).",
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => res.json(await subscriptionService.trainerPasses({ trainerUserId: req.user.sub }))
};

export const trainerCancelPass = {
  created, method: 'post', path: '/trainer/passes/:id/cancel',
  description: 'Trainer: withdraw a pass or plan request that is still awaiting payment.',
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => {
    const result = await subscriptionService.cancelTrainerPass({ trainerUserId: req.user.sub, subscriptionId: req.params.id });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ subscription: result.subscription });
  }
};

export const trainerBuyMemberPlan = {
  created, method: 'post', path: '/trainer/gyms/:gymId/member-plan',
  description: "Trainer: at a gym that sells no trainer pass, buy the gym's member plan. POST { plan: 'daily'|'weekly'|'monthly' }. Pending until an admin approves the payment.",
  requestSample: { plan: 'daily' },
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => {
    const result = await subscriptionService.trainerMemberPlanPurchase({
      trainerUserId: req.user.sub,
      gymId: req.params.gymId,
      plan: req.body?.plan,
      trainer: trainerService.findProfileByUser(req.user.sub),
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(result.status).json({ subscription: result.subscription, paymentRequest: result.paymentRequest });
  }
};
