// FitFlex Pass upgrade — pure rules.
// A member on a pass pays the DIFFERENCE between the new tier's price and the
// price of the tier they hold, however many days of it are left, and gets the
// new tier for a fresh period. The upgrade payment request says which plan it
// replaces in its note; that plan is retired when the payment is approved.

const NOTE_PREFIX = 'upgrade:';

/** Sponsored (company-funded) passes are made by the B2B billing module with ids sub_b2be_… */
export const isSponsoredPassId = (id) => String(id || '').startsWith('sub_b2be');

export const upgradeNote = (fromSubscriptionId) => `${NOTE_PREFIX}${fromSubscriptionId}`;

/** The subscription id an upgrade payment request replaces, or null for any other request. */
export function upgradedFromOf(request) {
  const note = request?.note;
  return typeof note === 'string' && note.startsWith(NOTE_PREFIX) ? note.slice(NOTE_PREFIX.length) || null : null;
}

/** What the member pays to move from a tier priced `fromPrice` to one priced `toPrice`; null when it is not an upgrade. */
export function upgradeDifference(fromPrice, toPrice) {
  const diff = Math.round(Number(toPrice) - Number(fromPrice));
  return Number.isFinite(diff) && diff > 0 ? diff : null;
}

/**
 * Retire the plan an approved upgrade replaces. Only the member's own, still
 * active plan is touched; anything else (already expired, someone else's) is left.
 * @returns the updated old subscription, or null when nothing was retired
 */
export async function retireUpgradedPass(subscriptions, request, newSubscriptionId) {
  const fromId = upgradedFromOf(request);
  if (!fromId || fromId === newSubscriptionId) return null;
  const old = await subscriptions.findByIdAsync(fromId);
  if (!old || old.memberId !== request.memberId || old.status !== 'active') return null;
  return (await subscriptions.updateByIdAsync(fromId, { status: 'upgraded' })) ?? null;
}
