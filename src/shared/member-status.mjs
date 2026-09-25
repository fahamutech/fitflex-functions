// A gym's members and their membership status — one definition shared by
// the owner Members list and by communications audiences, so a segment like
// "expiring soon" always matches what the owner sees on the Members screen.
//
// - Direct members hold a `direct_sub` subscription whose homeGymId is one of
//   the owner's gyms. Gyms can message these members.
// - FitFlex members visited on a FitFlex pass. Owners see them on the Members
//   list, tagged `fitflex`, but gyms can't message them.

export const DIRECT_SUB_TYPE = 'direct_sub';
export const FITFLEX_VISIT_TYPES = ['platform_pass', 'roaming_topup'];
export const EXPIRING_SOON_DAYS = 7;

/** Whole days until expiresAt (rounded up), negative once past; null without a date. */
export function daysLeft(expiresAt, now = new Date()) {
  if (!expiresAt) return null;
  return Math.ceil((+new Date(expiresAt) - +now) / 86_400_000);
}

/**
 * Status of a direct member from their account and latest direct
 * subscription: 'suspended' | 'expired' | 'expiring_soon' | 'active'.
 * The Members list also shows 'checked_in' for a member who visited today;
 * that overlay is applied by the caller, after 'suspended'.
 */
export function directMembershipStatus({ accountStatus, sub, now = new Date() }) {
  if (accountStatus === 'suspended' || sub?.status === 'suspended') return 'suspended';
  const dl = sub ? daysLeft(sub.expiresAt, now) : null;
  if (dl == null || dl < 0) return 'expired';
  if (dl <= EXPIRING_SOON_DAYS) return 'expiring_soon';
  return 'active';
}
