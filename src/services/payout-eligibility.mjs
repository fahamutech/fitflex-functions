// Payout eligibility for gym settlement (settlement Phase 4): may this gym
// be paid right now, and to which account?
//
// DR-08: every payout needs the owner's KYC approved and a verified primary
// settlement account past its 48 h cooling-off. A legacy partner (one the KYC
// gate exempts because they signed up before it) may be paid to the gym's
// recorded payment details only until a FIXED grace end date, which must be
// configured; with no date there is no grace. Never a permanent exemption.
import { isPayable } from '../shared/partner-kyc.mjs';
import { legacyKycGraceActive } from '../shared/settlement-config.mjs';

const last4 = (v) => String(v || '').slice(-4);

export function createPayoutEligibility({
  users, gyms, partnerGate, partnerSettlementAccounts,
  // ISO timestamp; null = no legacy grace.
  legacyKycGraceEndsAt = process.env.SETTLEMENT_LEGACY_KYC_GRACE_ENDS_AT || null,
}) {
  /**
   * @returns {{ ok: true, destination: Object } | { ok: false, reason: string, until?: string }}
   */
  async function forGym(gymId, { at = new Date() } = {}) {
    const owner = await users.findAsync((u) => u.userType === 'gym_operator' && (u.gymId === gymId || (u.gymIds || []).includes(gymId)));
    if (!owner) return { ok: false, reason: 'no_owner_account' };

    const kyc = await partnerGate.kycCaseFor(owner.id, 'gym_owner');
    if (kyc?.status === 'approved') {
      const accounts = partnerSettlementAccounts ? await partnerSettlementAccounts.filterByColumnAsync('caseId', kyc.id) : [];
      const account = accounts.find((a) => isPayable(a, at));
      if (account) {
        return {
          ok: true,
          destination: {
            kind: 'verified_account', ownerId: owner.id, kycCaseId: kyc.id, accountId: account.id, method: account.method,
            provider: account.provider ?? null, accountName: account.accountName ?? null, accountLast4: last4(account.accountNumber),
          },
        };
      }
      const cooling = accounts.find((a) => a.status === 'verified' && a.isPrimary);
      return cooling
        ? { ok: false, reason: 'payout_account_cooling_off', until: cooling.cooldownUntil ? new Date(cooling.cooldownUntil).toISOString() : null }
        : { ok: false, reason: 'payout_account_not_verified' };
    }

    // Not KYC-approved: only a legacy partner inside the configured grace.
    const graceActive = legacyKycGraceActive({ legacyKycGraceEndsAt, at: at.toISOString() });
    if (partnerGate.exempt(owner) && graceActive) {
      const gym = gyms.find((g) => g.id === gymId);
      if (!gym?.paymentNumber) return { ok: false, reason: 'legacy_payout_details_missing' };
      return {
        ok: true,
        destination: {
          kind: 'legacy_grace', ownerId: owner.id, provider: gym.paymentBank ?? null, accountLast4: last4(gym.paymentNumber),
          graceEndsAt: new Date(legacyKycGraceEndsAt).toISOString(),
        },
      };
    }
    return { ok: false, reason: kyc ? `kyc_${kyc.status}` : 'kyc_not_started' };
  }

  return { forGym };
}
