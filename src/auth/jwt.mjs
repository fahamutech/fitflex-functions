import jwt from 'jsonwebtoken';

const IS_PROD = process.env.NODE_ENV === 'production';
const SECRET = process.env.JWT_SECRET || (IS_PROD ? null : 'fitflex-dev-secret-change-me');
if (!SECRET) throw new Error('FATAL: JWT_SECRET must be set in production');
const TTL    = IS_PROD ? '7d' : '30d';

export function sign(payload)   { return jwt.sign(payload, SECRET, { expiresIn: TTL, issuer: 'fitflex' }); }
export function verify(token)   { try { return jwt.verify(token, SECRET, { issuer: 'fitflex' }); } catch { return null; } }

export function bearerFrom(req) {
  const h = req.headers?.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

// A token stays valid for its whole TTL, so suspension has to be checked
// against the account itself. The lookup is registered at bootstrap (it needs
// the store) and cached briefly so each request doesn't cost a query.
const STATUS_CACHE_MS = 30_000;
const STATUS_CACHE_MAX = 10_000;
let accountStatusLookup = null;
const statusCache = new Map();

/** Register `async (userId) => accountStatus | null`. */
export function registerAccountStatusLookup(fn) {
  accountStatusLookup = fn;
  statusCache.clear();
}

/** Drop a cached status so the next request re-reads it (call after a status change). */
export function invalidateAccountStatus(userId) {
  statusCache.delete(userId);
}

async function accountStatusOf(userId) {
  if (!accountStatusLookup || !userId) return null;
  const hit = statusCache.get(userId);
  if (hit && Date.now() - hit.at < STATUS_CACHE_MS) return hit.status;
  let status = null;
  try {
    status = await accountStatusLookup(userId);
  } catch (err) {
    // Fail open: a lookup outage must not sign every user out.
    console.warn('[auth] account status lookup failed:', err?.message);
    return null;
  }
  if (statusCache.size >= STATUS_CACHE_MAX) statusCache.clear();
  statusCache.set(userId, { status, at: Date.now() });
  return status;
}

/** Express middleware factory. Pass allowed user_type roles. Empty = any authenticated. */
export function requireAuth(...roles) {
  return async (req, res, next) => {
    const token = bearerFrom(req);
    const claims = token && verify(token);
    if (!claims) return res.status(401).json({ error: 'unauthenticated' });
    if (roles.length && !roles.includes(claims.userType)) {
      return res.status(403).json({ error: 'forbidden', requiredRoles: roles });
    }
    if (await accountStatusOf(claims.sub) === 'suspended') {
      return res.status(403).json({ error: 'account_suspended' });
    }
    req.user = claims;
    next();
  };
}

/**
 * ACL scope guard for portal staff.
 * Super-admins (portalUser: false or missing) pass freely.
 * Portal staff (portalUser: true) must have the scope in their aclPermissions JWT claim.
 * Always call AFTER requireAuth.
 */
export function requireAcl(scope) {
  return (req, res, next) => {
    const { portalUser, aclPermissions } = req.user || {};
    if (!portalUser) return next(); // super-admin — unrestricted
    if (Array.isArray(aclPermissions) && aclPermissions.includes(scope)) return next();
    return res.status(403).json({ error: 'acl_forbidden', requiredScope: scope });
  };
}

/**
 * ACL scope guard for gym-level staff (receptionists etc.) created by a gym owner.
 * Gym owners (userType: 'gym_operator') are unrestricted over their own gyms.
 * Gym staff (userType: 'gym_staff') must have the scope in their aclPermissions JWT claim.
 * Always call AFTER requireAuth.
 */
export function requireGymAcl(scope) {
  return (req, res, next) => {
    const { userType, aclPermissions } = req.user || {};
    if (userType === 'gym_operator') return next(); // owner — unrestricted
    if (userType === 'gym_staff' && Array.isArray(aclPermissions) && aclPermissions.includes(scope)) {
      return next();
    }
    return res.status(403).json({ error: 'acl_forbidden', requiredScope: scope });
  };
}
