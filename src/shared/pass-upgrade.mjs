// FitFlex Pass upgrade — pure rules and the in-place change.
// A member on a pass pays the DIFFERENCE between the new tier's price and the
// price of the tier they hold, however many days of it are left. The plan is
// upgraded IN PLACE: same subscription, same end date, same visit counter —
// only the tier (and so the visit cap and gym access) changes. An upgrade can
// therefore never lengthen a plan or reset its visits.
//
// The upgrade payment request has no subscription of its own; its note says
// which plan it upgrades: `upgrade:<subscriptionId>:<fromTier>`.

import { effectiveSubscriptionStatus } from './subscription-status.mjs';

const NOTE_PREFIX = 'upgrade:';

/** Sponsored (company-funded) passes are made by the B2B billing module with ids sub_b2be_… */
export const isSponsoredPassId = (id) => String(id || '').startsWith('sub_b2be');

export const upgradeNote = (subscriptionId, fromTier) => `${NOTE_PREFIX}${subscriptionId}:${fromTier}`;

/** The plan an upgrade payment request upgrades, or null for any other request. */
export function upgradeOf(request) {
  const note = request?.note;
  if (typeof note !== 'string' || !note.startsWith(NOTE_PREFIX)) return null;
  const [subscriptionId, fromTier] = note.slice(NOTE_PREFIX.length).split(':');
  return subscriptionId ? { subscriptionId, fromTier: fromTier || null } : null;
}

/** What the member pays to move from a tier priced `fromPrice` to one priced `toPrice`; null when it is not an upgrade. */
export function upgradeDifference(fromPrice, toPrice) {
  const diff = Math.round(Number(toPrice) - Number(fromPrice));
  return Number.isFinite(diff) && diff > 0 ? diff : null;
}

/**
 * Can this upgrade request be approved now? The plan it upgrades must still be
 * the member's own, running plan: a plan that ended meanwhile cannot be upgraded.
 */
export async function upgradeApprovable(subscriptions, request, now = new Date()) {
  const up = upgradeOf(request);
  if (!up) return { ok: true };
  const sub = await subscriptions.findByIdAsync(up.subscriptionId);
  if (!sub || sub.memberId !== request.memberId) return { ok: false, error: 'upgrade_plan_not_found' };
  if (effectiveSubscriptionStatus(sub, now) !== 'active') return { ok: false, error: 'upgrade_plan_not_active' };
  return { ok: true };
}

/**
 * Carry a payment request's decision onto the plan it upgrades: approved →
 * the plan takes the new tier; a decision taken back (approved → pending,
 * rejected, cancelled) → the tier goes back. Nothing else on the plan changes.
 * @returns {{ subscription, upgraded: boolean } | null}
 */
export async function applyUpgradeStatus(subscriptions, request, status) {
  const up = upgradeOf(request);
  if (!up) return null;
  const sub = await subscriptions.findByIdAsync(up.subscriptionId);
  if (!sub || sub.memberId !== request.memberId) return null;
  if (status === 'approved') {
    if (sub.tier === request.tier) return { subscription: sub, upgraded: false };
    const updated = await subscriptions.updateByIdAsync(sub.id, { tier: request.tier });
    return { subscription: updated ?? { ...sub, tier: request.tier }, upgraded: true };
  }
  if (up.fromTier && sub.tier === request.tier) {
    const updated = await subscriptions.updateByIdAsync(sub.id, { tier: up.fromTier });
    return { subscription: updated ?? { ...sub, tier: up.fromTier }, upgraded: false };
  }
  return { subscription: sub, upgraded: false };
}
