import jwt from 'jsonwebtoken';

const IS_PROD = process.env.NODE_ENV === 'production';
const SECRET = process.env.JWT_SECRET || (IS_PROD ? null : 'fitflex-dev-secret-change-me');
if (!SECRET) throw new Error('FATAL: JWT_SECRET must be set in production');
const TTL    = IS_PROD ? '7d' : '30d';

export function sign(payload)   { return jwt.sign(payload, SECRET, { expiresIn: TTL, issuer: 'fitflex' }); }
export function verify(token)   { try { return jwt.verify(token, SECRET, { issuer: 'fitflex' }); } catch { return null; } }

// Short-lived tokens for one step of a flow (for example "this person proved
// their old PIN; let them set a new one"). They carry `purpose` and are never
// accepted as a session: requireAuth rejects any token that has one.
export function signPurpose(purpose, payload, ttl = '15m') {
  return jwt.sign({ ...payload, purpose }, SECRET, { expiresIn: ttl, issuer: 'fitflex' });
}
export function verifyPurpose(token, purpose) {
  const claims = token ? verify(token) : null;
  return claims && claims.purpose === purpose ? claims : null;
}

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

/**
 * Register `async (userId) => accountStatus | null`, or an object
 * `{ status, sessionsValidAfter }` when sessions can also be ended early.
 */
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
  if (hit && Date.now() - hit.at < STATUS_CACHE_MS) return hit;
  let found = null;
  try {
    found = await accountStatusLookup(userId);
  } catch (err) {
    // Fail open: a lookup outage must not sign every user out.
    console.warn('[auth] account status lookup failed:', err?.message);
    return null;
  }
  const entry = found && typeof found === 'object'
    ? { status: found.status ?? null, validAfter: found.sessionsValidAfter ? +new Date(found.sessionsValidAfter) : null, at: Date.now() }
    : { status: found, validAfter: null, at: Date.now() };
  if (statusCache.size >= STATUS_CACHE_MAX) statusCache.clear();
  statusCache.set(userId, entry);
  return entry;
}

/** Express middleware factory. Pass allowed user_type roles. Empty = any authenticated. */
export function requireAuth(...roles) {
  return async (req, res, next) => {
    const token = bearerFrom(req);
    const claims = token && verify(token);
    // A single-step token (signPurpose) is never a session.
    if (!claims || claims.purpose) return res.status(401).json({ error: 'unauthenticated' });
    if (roles.length && !roles.includes(claims.userType)) {
      return res.status(403).json({ error: 'forbidden', requiredRoles: roles });
    }
    const account = await accountStatusOf(claims.sub);
    if (account?.status === 'suspended') {
      return res.status(403).json({ error: 'account_suspended' });
    }
    // Sessions issued before the person reset or changed their PIN are over.
    if (account?.validAfter && Number(claims.iat) * 1000 < account.validAfter) {
      return res.status(401).json({ error: 'session_ended' });
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
