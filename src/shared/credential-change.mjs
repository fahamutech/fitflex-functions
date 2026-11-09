// Who must replace a start credential someone else chose before doing anything else.
//
// One column, User.passwordChangeRequired (functions#219), holds it for:
//   - portal admins made by another admin (2026-10-19): always enforced;
//   - gym staff whose PIN their owner chose (Phase B · B3a, 2026-10-20):
//     enforced only while STAFF_PIN_CHANGE_REQUIRED is on, so the flag is a
//     real switch both ways (rows can be marked while it is off; turning it
//     off again releases every staff session at once).
// Everything that turns the column into behaviour reads it through here: the
// `pwc` session claim (auth-service), the per-request account check
// (bootstrap → requireAuth) and the session user in responses.
import { staffPinChangeRequiredOn } from './feature-flags.mjs';

/** Persona types whose hold follows STAFF_PIN_CHANGE_REQUIRED. */
export const FLAGGED_CREDENTIAL_TYPES = new Set(['gym_staff']);

/** True when this User row's sessions must be held to the change route. */
export function mustChangeStartCredential(user) {
  if (user?.passwordChangeRequired !== true) return false;
  return FLAGGED_CREDENTIAL_TYPES.has(user.userType) ? staffPinChangeRequiredOn() : true;
}

/**
 * Does the token's own `pwc` claim still hold the session? For portal admins,
 * always. For gym staff only while STAFF_PIN_CHANGE_REQUIRED is on: turning the
 * switch off must release sessions minted while it was on, since their only
 * way out (POST /auth/pin/change) is then 404 (review of #260, finding 2).
 * With the switch on the claim still counts, so a failed account lookup
 * (which fails open) cannot release a held staff session.
 */
export function claimHoldsSession(claims) {
  if (claims?.pwc !== true) return false;
  return FLAGGED_CREDENTIAL_TYPES.has(claims.userType) ? staffPinChangeRequiredOn() : true;
}
