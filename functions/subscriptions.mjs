// Member-facing subscription + self-account REST surface.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { subscriptionService, accountService, usernameService, resolveRequestUser, partnerVerifiedFor } from '../src/bootstrap/services.mjs';
import { memberUsernamesOn } from '../src/shared/feature-flags.mjs';

const created = new Date().toISOString();

export const listPasses = {
  created, method: 'get', path: '/passes',
  description: 'Platform Pass tier catalogue (v2.0 prices).',
  onRequest: (_, res) => res.json(subscriptionService.listPasses())
};

export const subscribe = {
  created, method: 'post', path: '/me/subscribe',
  description: 'Create a pilot Platform Pass (or gym plan) payment request. Admin approval activates the subscription. While manual payment is on (GET /payments/options manual.enabled) `reference` (the mobile-money transaction ID) and `payerPhone` (the number paid from) are required: 400 payment_reference_required / payment_reference_invalid / payer_phone_required / payer_phone_invalid, 409 payment_reference_duplicate, 429 too_many_attempts.',
  requestSample: { tier: 'pro', type: 'platform_pass', reference: 'QGH7XK2L9P', payerPhone: '0712345678' },
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => {
    const { tier, type = 'platform_pass', homeGymId, plan, reference, payerPhone } = req.body || {};
    const result = await subscriptionService.subscribe({ memberId: req.user.sub, tier, type, homeGymId, plan, reference, payerPhone });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(result.status).json({ subscription: result.subscription, paymentRequest: result.paymentRequest });
  }
};

export const upgradeOptions = {
  created, method: 'get', path: '/me/upgrade-options',
  description: 'The higher FitFlex Pass tiers the member can move up to, and the difference they would pay for each.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => {
    const result = await subscriptionService.upgradeOptions(req.user.sub);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ current: result.current, options: result.options });
  }
};

export const upgradePass = {
  created, method: 'post', path: '/me/upgrade',
  description: 'Upgrade the FitFlex Pass: creates a payment request for the price difference. Approval upgrades the plan in place (same end date, same visits used). While manual payment is on, `reference` (the mobile-money transaction ID) and `payerPhone` are required, as for /me/subscribe.',
  requestSample: { tier: 'pro', reference: 'QGH7XK2L9P', payerPhone: '0712345678' },
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => {
    const { tier, reference, payerPhone } = req.body || {};
    const result = await subscriptionService.upgradePass({ memberId: req.user.sub, tier, reference, payerPhone });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(result.status).json({ paymentRequest: result.paymentRequest, upgradeFrom: result.upgradeFrom, endsAt: result.endsAt });
  }
};

export const me = {
  created, method: 'get', path: '/me',
  description: 'Authenticated user profile + active subscription + visit counter.',
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    const user = await resolveRequestUser(req);
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    // partnerVerified: a trainer or gym owner sees whether they are verified yet.
    // Username fields only when the feature is on (MEMBER_USERNAMES) and for members.
    const username = memberUsernamesOn() && user.userType === 'member' ? await usernameService.mine(user.id) : {};
    res.json({ ...(await subscriptionService.me(user)), partnerVerified: await partnerVerifiedFor(user), ...username });
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
  description: 'Member: own check-in history. No query: the newest 50 (profile and QR screens). Optional ?from=&to= (ISO date-times): every check-in with from <= timestamp < to, newest first, capped at 1000 rows; to defaults to now, from to to minus 90 days; window at most 366 days. 400 invalid_date | invalid_range | range_too_long.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => {
    const { from, to } = req.query || {};
    const result = await subscriptionService.memberCheckIns(req.user.sub, { from, to });
    if (result && !Array.isArray(result) && result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  }
};

export const memberPaymentHistory = {
  created, method: 'get', path: '/me/payments',
  description: 'Member: list own payment requests.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => res.json(await subscriptionService.memberPaymentHistory(req.user.sub))
};
