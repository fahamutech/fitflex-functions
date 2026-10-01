// Identity V2 · I5 — membership-based organisation authorisation, behind a
// compatibility layer.
//
// Legacy rules (unchanged, still the default):
//   - which gyms an operator acts on: the gymIds on their own User row
//   - what gym staff may do: aclPermissions in the JWT (requireGymAcl)
// Membership rules (new):
//   - an ACTIVE OrgMembership for the persona decides both: owner
//     memberships give every scope at that gym; staff memberships give the
//     scopes in that membership's aclPermissions, for that gym only.
//     Suspended, requested, removed or left memberships give nothing.
//
// Routes opt in by using requireGymAccess / requireGymOwner and
// effectiveOperator instead of requireGymAcl and the raw row. Everything else
// keeps the legacy guard. The mode (feature-flags orgAuthzMode) decides which
// rule set is enforced; in 'shadow' both run and disagreements are recorded,
// which is the evidence for switching a route group to 'enforce'.
//
// See IDENTITY_AUTHZ_MIGRATION.md for the per-endpoint status.
import { orgAuthzMode } from '../shared/feature-flags.mjs';

let membershipLookup = null;   // async (personaId) => OrgMembership rows (gym, owner|staff)
const stats = { checks: 0, mismatches: 0, byRoute: {} };
const same = (a, b) => a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');
const legacyGymIds = row => row?.gymIds || (row?.gymId ? [row.gymId] : []);

/** Register `async (personaId) => [{ gymId, role, status, aclPermissions }]`. */
export function registerOrgMembershipLookup(fn) {
  membershipLookup = fn;
}

/** Shadow/enforce comparison counters since this process started. */
export function orgAuthzStats() {
  return { mode: orgAuthzMode(), checks: stats.checks, mismatches: stats.mismatches, byRoute: { ...stats.byRoute } };
}
export function resetOrgAuthzStats() {
  stats.checks = 0; stats.mismatches = 0; stats.byRoute = {};
}

function record(route, kind, detail) {
  stats.mismatches += 1;
  stats.byRoute[route] = (stats.byRoute[route] || 0) + 1;
  // Ids only: no names, emails or phones.
  console.warn(`[org-authz] mismatch route=${route} kind=${kind} ${JSON.stringify(detail)}`);
}

/** Gyms and scopes the persona holds through ACTIVE owner/staff memberships. */
async function membershipAccess(personaId, userType) {
  const rows = membershipLookup ? await membershipLookup(personaId) : [];
  const role = userType === 'gym_operator' ? 'owner' : userType === 'gym_staff' ? 'staff' : null;
  const active = rows.filter(m => m.status === 'active' && m.role === role);
  return {
    gymIds: active.map(m => m.gymId),
    /** Gyms where `scope` is granted (every scope for an owner). */
    gymIdsFor: scope => active
      .filter(m => role === 'owner' || !scope || (m.aclPermissions || []).includes(scope))
      .map(m => m.gymId),
  };
}

function legacyAllows(claims, scope) {
  if (claims?.userType === 'gym_operator') return true;
  return claims?.userType === 'gym_staff'
    && Array.isArray(claims.aclPermissions) && claims.aclPermissions.includes(scope);
}

function membershipAllows(claims, access, scope) {
  // An owner with no gym yet still reaches their (empty) screens, as today.
  if (claims?.userType === 'gym_operator') return true;
  return claims?.userType === 'gym_staff' && access.gymIdsFor(scope).length > 0;
}

/**
 * Guard for gym routes open to owners and staff with `scope`. Always after
 * requireAuth. `route` labels the comparison records.
 */
export function requireGymAccess(scope, route) {
  return async (req, res, next) => {
    const mode = orgAuthzMode();
    const legacy = legacyAllows(req.user, scope);
    if (mode === 'off') {
      return legacy ? next() : res.status(403).json({ error: 'acl_forbidden', requiredScope: scope });
    }
    let access;
    try {
      access = await membershipAccess(req.user?.sub, req.user?.userType);
    } catch (err) {
      // The membership read failed: fall back to the legacy decision rather
      // than lock operators out.
      console.warn('[org-authz] membership lookup failed:', err?.message);
      return legacy ? next() : res.status(403).json({ error: 'acl_forbidden', requiredScope: scope });
    }
    const membership = membershipAllows(req.user, access, scope);
    stats.checks += 1;
    if (legacy !== membership) record(route, 'guard', { persona: req.user?.sub, scope, legacy, membership });
    req.orgAccess = { mode, scope, route, access };
    const allowed = mode === 'enforce' ? membership : legacy;
    return allowed ? next() : res.status(403).json({ error: 'acl_forbidden', requiredScope: scope });
  };
}

/** Guard for owner-only gym routes (staff administration). */
export function requireGymOwner(route) {
  return async (req, res, next) => {
    if (req.user?.userType !== 'gym_operator') {
      return res.status(403).json({ error: 'forbidden', requiredRoles: ['gym_operator'] });
    }
    const mode = orgAuthzMode();
    if (mode !== 'off') {
      try {
        req.orgAccess = { mode, scope: null, route, access: await membershipAccess(req.user.sub, 'gym_operator') };
        stats.checks += 1;
      } catch (err) {
        console.warn('[org-authz] membership lookup failed:', err?.message);
      }
    }
    return next();
  };
}

/**
 * The operator row a handler should use. Off or shadow: the row as stored
 * (legacy gym set), with a recorded mismatch if memberships disagree.
 * Enforce: the same row with gymIds replaced by the gyms the persona's ACTIVE
 * memberships grant for this route's scope — so services that scope by
 * `owner.gymIds` are limited to them without being rewritten.
 */
export function effectiveOperator(req, row) {
  const ctx = req?.orgAccess;
  if (!row || !ctx?.access) return row;
  const legacy = legacyGymIds(row);
  const granted = ctx.access.gymIdsFor(ctx.scope);
  if (!same(legacy, granted)) {
    record(ctx.route, 'gym_set', { persona: row.id, legacy, membership: granted });
  }
  if (ctx.mode !== 'enforce') return row;
  return { ...row, gymIds: granted, gymId: granted[0] ?? null };
}
