// Marathon & running events · S2 — organizer authorisation (spec §2, §14.3; decision D3).
//
// Who the caller is for an organizer: resolved from EventOrganizerStaff (the authoritative role record),
// never from the JWT's organizerId / organizerRole copy, exactly as vendor routes read the stored staff
// record. The lookup is registered at bootstrap (it needs the store), like registerAccountStatusLookup in
// jwt.mjs. Always use AFTER requireAuth('event_organizer', 'organizer_staff') and wrap in routeGuard.
//
//   requireOrganizer(...roles)        the caller holds an active role at some organizer (else 403
//                                     not_your_organizer) and, when roles are given, one of them (else
//                                     403 forbidden_role). Reads: any organizer status.
//   requireActiveOrganizer(...roles)  the same, and the organizer is active: suspended → 403
//                                     organizer_suspended, anything else → 403 organizer_not_active.
// Both put { organizer, role, staffId } on req.organizer.

let organizerLookup = null;

/** Register `async (userId) => { organizer, role, staffId } | null`. */
export function registerOrganizerLookup(fn) {
  organizerLookup = fn;
}

async function resolve(req) {
  if (req.organizer !== undefined) return req.organizer;
  const found = organizerLookup && req.user?.sub ? await organizerLookup(req.user.sub) : null;
  req.organizer = found || null;
  return req.organizer;
}

// Statuses that open the events and staff screens at all (spec §2): suspended is read-only, the rest see nothing.
const OPEN_STATUSES = ['active', 'suspended'];

function guard(roles, { active, open = false }) {
  return async (req, res, next) => {
    const ctx = await resolve(req);
    if (!ctx) return res.status(403).json({ error: 'not_your_organizer' });
    if (roles.length && !roles.includes(ctx.role)) return res.status(403).json({ error: 'forbidden_role', requiredRoles: roles, role: ctx.role });
    if (active && ctx.organizer.status !== 'active') {
      return res.status(403).json({ error: ctx.organizer.status === 'suspended' ? 'organizer_suspended' : 'organizer_not_active', organizerStatus: ctx.organizer.status });
    }
    if (open && !OPEN_STATUSES.includes(ctx.organizer.status)) return res.status(403).json({ error: 'organizer_not_active', organizerStatus: ctx.organizer.status });
    next();
  };
}

/** Reads of events and staff: an organizer that is active or suspended (read-only); draft, pending_review, rejected → 403 organizer_not_active. */
export function requireOpenOrganizer(...roles) {
  return guard(roles, { active: false, open: true });
}

/** Resolve the caller's organizer without refusing (GET /organizer/me answers 404 no_organizer itself). */
export async function loadOrganizer(req, _res, next) {
  await resolve(req);
  next();
}

export function requireOrganizer(...roles) {
  return guard(roles, { active: false });
}

export function requireActiveOrganizer(...roles) {
  return guard(roles, { active: true });
}

/** The caller's organizer context after a guard ran (or null when none resolved). */
export const organizerOf = req => req.organizer ?? null;
