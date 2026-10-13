// Member usernames: GET /me/username/available, PUT/DELETE /me/username.
// All of it is off (404 feature_disabled) until MEMBER_USERNAMES is set.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { memberUsernamesOn } from '../src/shared/feature-flags.mjs';
import { usernameService, resolveRequestUser } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

// Availability checks are cheap to abuse for harvesting handles: a few per
// minute per member is plenty for a form that checks as you type.
const WINDOW_MS = 60_000;
const MAX_CHECKS = 20;
const checks = new Map();
function tooMany(userId) {
  const nowMs = Date.now();
  const recent = (checks.get(userId) ?? []).filter(t => nowMs - t < WINDOW_MS);
  recent.push(nowMs);
  checks.set(userId, recent);
  return recent.length > MAX_CHECKS;
}

const off = res => res.status(404).json({ error: 'feature_disabled' });
const fail = (res, r) => res.status(r.status ?? 400).json({ error: r.error, ...(r.nextChangeAt ? { nextChangeAt: r.nextChangeAt } : {}) });

export const usernameAvailable = {
  created, method: 'get', path: '/me/username/available',
  description: 'Member: is this username free for me? ?handle=. Returns only { available, reason } (invalid_username, username_reserved, username_taken, username_released_recently, username_not_allowed). Rate limited. Needs MEMBER_USERNAMES.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => {
    if (!memberUsernamesOn()) return off(res);
    const user = await resolveRequestUser(req);
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    if (tooMany(user.id)) return res.status(429).json({ error: 'too_many_requests' });
    res.json(await usernameService.available(user.id, req.query?.handle));
  }
};

export const setUsername = {
  created, method: 'put', path: '/me/username',
  description: 'Member: choose or change my username { username }. 3 to 20 characters of a-z 0-9 . _ ; one change per 30 days. Errors: invalid_username, username_reserved, username_taken, username_released_recently, username_not_allowed, username_cooldown (with nextChangeAt). Needs MEMBER_USERNAMES.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => {
    if (!memberUsernamesOn()) return off(res);
    const user = await resolveRequestUser(req);
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    const result = await usernameService.set(user, req.body?.username);
    if (result.error) return fail(res, result);
    res.json(result);
  }
};

export const clearUsername = {
  created, method: 'delete', path: '/me/username',
  description: 'Member: remove my username (I appear by my name again). Counts as a change for the 30-day limit. Needs MEMBER_USERNAMES.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => {
    if (!memberUsernamesOn()) return off(res);
    const user = await resolveRequestUser(req);
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    const result = await usernameService.clear(user);
    if (result.error) return fail(res, result);
    res.json(result);
  }
};
