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

/** Express middleware factory. Pass allowed user_type roles. Empty = any authenticated. */
export function requireAuth(...roles) {
  return (req, res, next) => {
    const token = bearerFrom(req);
    const claims = token && verify(token);
    if (!claims) return res.status(401).json({ error: 'unauthenticated' });
    if (roles.length && !roles.includes(claims.userType)) {
      return res.status(403).json({ error: 'forbidden', requiredRoles: roles });
    }
    req.user = claims;
    next();
  };
}
