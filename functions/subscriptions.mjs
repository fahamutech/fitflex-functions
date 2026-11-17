// Member-facing subscription + self-account REST surface.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
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
  description: 'Create a Platform Pass (or gym plan) payment request. Its payment through AzamPay (or an admin approval) activates the subscription; when the member already has a running plan of the same product (FitFlex Pass, or the same gym\'s plan), the paid plan is scheduled instead and starts when the current one ends (GET /me scheduledRenewals). 409 renewal_already_scheduled: one renewal may wait at a time. The request is then paid through AzamPay (POST /me/payments/:id/mobile-money); a transaction ID typed by the member is no longer taken (`reference` / `payerPhone` in the body are ignored).',
  requestSample: { tier: 'pro', type: 'platform_pass' },
  onGuard: routeGuard('post', requireAuth('member')),
  onRequest: async (req, res) => {
    const { tier, type = 'platform_pass', homeGymId, plan } = req.body || {};
    const result = await subscriptionService.subscribe({ memberId: req.user.sub, tier, type, homeGymId, plan });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(result.status).json({ subscription: result.subscription, paymentRequest: result.paymentRequest });
  }
};

export const upgradeOptions = {
  created, method: 'get', path: '/me/upgrade-options',
  description: 'The higher FitFlex Pass tiers the member can move up to, and the difference they would pay for each.',
  onGuard: routeGuard('get', requireAuth('member')),
  onRequest: async (req, res) => {
    const result = await subscriptionService.upgradeOptions(req.user.sub);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ current: result.current, options: result.options });
  }
};

export const upgradePass = {
  created, method: 'post', path: '/me/upgrade',
  description: 'Upgrade the FitFlex Pass: creates a payment request for the price difference. Approval upgrades the plan in place (same end date, same visits used). Paid through AzamPay as for /me/subscribe (`reference` / `payerPhone` in the body are ignored).',
  requestSample: { tier: 'pro' },
  onGuard: routeGuard('post', requireAuth('member')),
  onRequest: async (req, res) => {
    const { tier } = req.body || {};
    const result = await subscriptionService.upgradePass({ memberId: req.user.sub, tier });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(result.status).json({ paymentRequest: result.paymentRequest, upgradeFrom: result.upgradeFrom, endsAt: result.endsAt });
  }
};

export const me = {
  created, method: 'get', path: '/me',
  description: 'Authenticated user profile + active subscription + visit counter.',
  onGuard: routeGuard('get', requireAuth()),
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
  description: 'Authenticated user: permanently delete own account + Firebase identity (Play Store account-deletion requirement). Only this persona goes: another role on the same sign-in keeps the shared login and details. Personal data is removed; payments, check-ins, bookings and orders stay, anonymised, so no statement or total changes. All of it happens in one transaction: 200 { ok, message }, or 503 { error: account_deletion_failed, message, messageSw } and nothing changed, so it can be retried. 404 user_not_found: already deleted (a retry whose first answer was lost counts as success). 409 gym_owner_has_checkin_activity | trainer_has_bookings | organizer_owner: needs an assisted transfer first. 409 open_paid_order { message, messageSw }: a paid shop order is not delivered or cancelled yet.',
  onGuard: routeGuard('delete', requireAuth()),
  onRequest: async (req, res) => {
    const user = await resolveRequestUser(req);
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    const result = await accountService.deleteMyAccount(user);
    if (result.error) return res.status(result.status).json({ error: result.error, message: result.message, ...(result.messageSw ? { messageSw: result.messageSw } : {}) });
    res.json(result);
  }
};

export const updateMemberProfile = {
  created, method: 'post', path: '/me/profile',
  description: 'Authenticated user: save profile details; members can also save onboarding goals and preferences. Members: dateOfBirth must be "YYYY-MM-DD", a real calendar date from 1901-01-01 to today (East Africa day), else 400 invalid_field { field: "dateOfBirth" }; "" (or only spaces) clears it; null or leaving it out keeps the stored one. With PARTNER_DOB_REQUIRED on, a date of birth under 18 for a person who also holds a trainer or gym-owner role is refused: 400 { error: "partner_under_18" }. photoUrl (security fix 2026-10-28): data:image/(png|jpeg|webp);base64,… (≤ 1.4 MB decoded (MEDIA_SRC_MAX_BYTES), a real image of that kind) or our own /storage/<cid>/<file> path; the stored photo is accepted unchanged; null / "" as before; else 400 invalid_media_src { field: "photoUrl", reason }.',
  onGuard: routeGuard('post', requireAuth()),
  onRequest: async (req, res) => {
    const user = await resolveRequestUser(req);
    const result = await accountService.updateMemberProfile({ claims: req.user, user, body: req.body || {} });
    if (result.error) return res.status(result.status).json({ error: result.error, ...(result.field ? { field: result.field } : {}), ...(result.reason ? { reason: result.reason } : {}), ...(result.retryAfterSeconds ? { retryAfterSeconds: result.retryAfterSeconds } : {}) });
    res.json(result);
  }
};

export const memberCheckIns = {
  created, method: 'get', path: '/me/checkins',
  description: 'Member: own check-in history. No query: the newest 50 (profile and QR screens). Optional ?from=&to= (ISO date-times): every check-in with from <= timestamp < to, newest first, capped at 1000 rows; to defaults to now, from to to minus 90 days; window at most 366 days. 400 invalid_date | invalid_range | range_too_long.',
  onGuard: routeGuard('get', requireAuth('member')),
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
  onGuard: routeGuard('get', requireAuth('member')),
  onRequest: async (req, res) => res.json(await subscriptionService.memberPaymentHistory(req.user.sub))
};
