// How a member's name appears to other people — challenge leaderboards and
// public reviews: first name and last initial ("Aisha M."), never the full name.
export function shortName(displayName) {
  const parts = (displayName ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'FitFlex member';
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts.at(-1)[0].toUpperCase()}.`;
}
