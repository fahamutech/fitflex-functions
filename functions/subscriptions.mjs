// Member-facing subscription + self-account REST surface.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { subscriptionService, accountService, resolveRequestUser } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

export const listPasses = {
  created, method: 'get', path: '/passes',
  description: 'Platform Pass tier catalogue (v2.0 prices).',
  onRequest: (_, res) => res.json(subscriptionService.listPasses())
};

export const subscribe = {
  created, method: 'post', path: '/me/subscribe',
  description: 'Create a pilot Platform Pass payment request. Admin approval activates the subscription.',
  requestSample: { tier: 'pro', type: 'platform_pass' },
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => {
    const { tier, type = 'platform_pass', homeGymId, plan } = req.body || {};
    const result = await subscriptionService.subscribe({ memberId: req.user.sub, tier, type, homeGymId, plan });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(result.status).json({ subscription: result.subscription, paymentRequest: result.paymentRequest });
  }
};

export const me = {
  created, method: 'get', path: '/me',
  description: 'Authenticated user profile + active subscription + visit counter.',
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    const user = await resolveRequestUser(req);
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    res.json(await subscriptionService.me(user));
  }
};

export const deleteMyAccount = {
  created, method: 'delete', path: '/me',
  description: 'Authenticated user: permanently delete own account + Firebase identity (Play Store account-deletion requirement). Blocked if the account has data that requires an assisted transfer first (gym owner with check-in activity, trainer with bookings).',
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    const user = await resolveRequestUser(req);
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    const result = await accountService.deleteMyAccount(user);
    if (result.error) return res.status(result.status).json({ error: result.error, message: result.message });
    res.json(result);
  }
};

export const updateMemberProfile = {
  created, method: 'post', path: '/me/profile',
  description: 'Authenticated user: save profile details; members can also save onboarding goals and preferences.',
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    const user = await resolveRequestUser(req);
    const result = await accountService.updateMemberProfile({ claims: req.user, user, body: req.body || {} });
    res.json(result);
  }
};

export const memberCheckIns = {
  created, method: 'get', path: '/me/checkins',
  description: 'Member: recent check-in history for profile and QR screens.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => res.json(await subscriptionService.memberCheckIns(req.user.sub))
};

export const memberPaymentHistory = {
  created, method: 'get', path: '/me/payments',
  description: 'Member: list own payment requests.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => res.json(await subscriptionService.memberPaymentHistory(req.user.sub))
};
