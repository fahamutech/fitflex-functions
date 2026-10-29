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
 * `{ status, sessionsValidAfter, passwordChangeRequired }` when sessions can
 * also be ended early or are held until a start password is changed.
 */
export function registerAccountStatusLookup(fn) {
  accountStatusLookup = fn;
  statusCache.clear();
}

// Cache scope (admin-portal audit S1): this cache is per PROCESS. forgetSession/invalidateAccountStatus
// only clears the instance that handled the change; other server instances keep serving the cached
// status for up to STATUS_CACHE_MS (30 s) before they re-read it. Accepted, no shared infrastructure.
// `epoch` closes the in-process race: a lookup that started before an invalidation must not write
// its (possibly stale) answer into the cache afterwards.
let epoch = 0;

/** Drop a cached status so the next request re-reads it (call after a status change). */
export function invalidateAccountStatus(userId) {
  epoch += 1;
  statusCache.delete(userId);
}

async function accountStatusOf(userId) {
  if (!accountStatusLookup || !userId) return null;
  const hit = statusCache.get(userId);
  if (hit && Date.now() - hit.at < STATUS_CACHE_MS) return hit;
  let found = null;
  const startedAt = epoch;
  try {
    found = await accountStatusLookup(userId);
  } catch (err) {
    // Fail open: a lookup outage must not sign every user out.
    console.warn('[auth] account status lookup failed:', err?.message);
    return null;
  }
  const entry = found && typeof found === 'object'
    ? {
      status: found.status ?? null,
      validAfter: found.sessionsValidAfter ? +new Date(found.sessionsValidAfter) : null,
      missing: found.missing === true,
      passwordChangeRequired: found.passwordChangeRequired === true,
      at: Date.now(),
    }
    : { status: found, validAfter: null, passwordChangeRequired: false, at: Date.now() };
  // An invalidation happened while this lookup was in flight: serve it once, but do not cache it.
  if (epoch !== startedAt) return entry;
  if (statusCache.size >= STATUS_CACHE_MAX) statusCache.clear();
  statusCache.set(userId, entry);
  return entry;
}

/**
 * A session that still has to change the start password another admin chose
 * for it (owner decision 2026-10-19): the token says so (`pwc: true`), or the
 * account does (in case some sign-in route ever forgets the claim).
 */
export const PASSWORD_CHANGE_REQUIRED = 'password_change_required';

function authGuard(roles, { allowPasswordChange }) {
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
    // Fail closed (admin-portal audit S1): a portal staff token whose account no longer
    // exists (deleted staff member) is over. Super-admin and other roles are unchanged.
    if (account?.missing && claims.userType === 'admin' && claims.portalUser === true) {
      return res.status(401).json({ error: 'session_ended' });
    }
    // Sessions issued before the person reset or changed their PIN (or an
    // admin changed their start password) are over.
    if (account?.validAfter && Number(claims.iat) * 1000 < account.validAfter) {
      return res.status(401).json({ error: 'session_ended' });
    }
    // Fail closed: only routes that opt in serve a session that must change its start password.
    if (!allowPasswordChange && (claims.pwc === true || account?.passwordChangeRequired === true)) {
      return res.status(403).json({ error: PASSWORD_CHANGE_REQUIRED });
    }
    req.user = claims;
    next();
  };
}

/** Express middleware factory. Pass allowed user_type roles. Empty = any authenticated. */
export function requireAuth(...roles) {
  return authGuard(roles, { allowPasswordChange: false });
}

/**
 * The same checks as requireAuth, but a session that must still change its
 * start password (`pwc`) is let through. Use ONLY on the change-password route
 * (and any read the portal strictly needs to show that screen).
 */
export function requireAuthAllowingPasswordChange(...roles) {
  return authGuard(roles, { allowPasswordChange: true });
}

/**
 * Claims of a bearer token for open routes that only tailor what they show to
 * the caller. Single-step tokens and sessions that must still change their
 * start password count as anonymous.
 */
export function optionalSessionClaims(req) {
  const token = bearerFrom(req);
  const claims = token ? verify(token) : null;
  if (!claims || claims.purpose || claims.pwc === true) return null;
  return claims;
}

/**
 * ACL scope guard for portal staff.
 * Super-admins (portalUser: false or missing) pass freely.
 * Portal staff (portalUser: true) must have the scope in their aclPermissions JWT claim.
 * Always call AFTER requireAuth.
 */
export function requireAcl(scope, ...alternatives) {
  // `alternatives`: other scopes that also open the route (for reads shared by several grants).
  const accepted = [scope, ...alternatives];
  return (req, res, next) => {
    const { portalUser, aclPermissions } = req.user || {};
    if (!portalUser) return next(); // super-admin — unrestricted
    if (Array.isArray(aclPermissions) && accepted.some(s => aclPermissions.includes(s))) return next();
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
