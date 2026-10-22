// Marathon & running events · S2 — the organizer persona's rules (spec §2, decisions D3, D11, D12).
// Pure: no I/O. The organizer's status is DERIVED from its partner KYC case; nothing else sets it.
//
//   organizerStatusOf(kycCase)            → draft | pending_review | active | rejected | suspended
//   permissionsFor(role, status)          → the permission strings /organizer/me answers with
//   canManageStaff / canRemoveStaff       → the role rules of the staff screen (§9)

/** Roles on EventOrganizerStaff (S1 CHECK). owner is created with the organizer; the rest are invited. */
export const ORGANIZER_ROLES = Object.freeze(['owner', 'admin', 'ops', 'finance', 'timing']);
/** Roles a staff invitation may carry (never owner). */
export const INVITABLE_ORGANIZER_ROLES = Object.freeze(['admin', 'ops', 'finance', 'timing']);
/** Roles that create, edit, submit, withdraw, cancel, complete, archive and delete events. */
export const EVENT_EDITOR_ROLES = Object.freeze(['owner', 'admin']);

const KYC_TO_ORGANIZER = Object.freeze({
  draft: 'draft',
  submitted: 'pending_review',
  in_review: 'pending_review',
  info_requested: 'pending_review',
  approved: 'active',
  rejected: 'rejected',
  suspended: 'suspended',
});

/**
 * Spec §2: draft→draft, submitted|in_review|info_requested→pending_review, approved→active,
 * rejected→rejected, suspended→suspended. No case (or an unknown status) = draft.
 */
export function organizerStatusOf(kycCase) {
  return KYC_TO_ORGANIZER[kycCase?.status] ?? 'draft';
}

/** Spec §2 / §3: what a role may do at a status. Strings are what the portal filters its areas with. */
export function permissionsFor(role, status) {
  const out = ['overview'];
  if (role === 'owner') out.push('onboarding');
  if (status === 'active' || status === 'suspended') out.push('events:read');
  if (status === 'active' && EVENT_EDITOR_ROLES.includes(role)) out.push('events:write');
  if (status === 'active' && EVENT_EDITOR_ROLES.includes(role)) out.push('staff');
  return out;
}

/** Owners and admins invite and change roles. */
export const canManageStaff = role => EVENT_EDITOR_ROLES.includes(role);

/**
 * Who may remove whom (§2, §9): the owner removes anyone but themselves; an admin removes ops, finance and
 * timing staff, never the owner and never another admin. → null when allowed, else the error code.
 */
export function removalRefusal(actorRole, targetRole) {
  if (targetRole === 'owner') return 'cannot_remove_owner';
  if (actorRole === 'owner') return null;
  if (actorRole === 'admin') return targetRole === 'admin' ? 'forbidden_role' : null;
  return 'forbidden_role';
}

/** The same rule for a role change: only owner/admin change roles; nobody changes the owner; admins do not touch admins. */
export function roleChangeRefusal(actorRole, targetRole, newRole) {
  if (!INVITABLE_ORGANIZER_ROLES.includes(newRole)) return 'invalid_role';
  return removalRefusal(actorRole, targetRole);
}
