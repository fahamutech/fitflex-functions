// Payout eligibility for gym, trainer and vendor settlement: may this
// partner be paid right now, and to which account?
//
// DR-08: every payout needs the owner's KYC approved and a verified primary
// settlement account past its 48 h cooling-off. A legacy partner (one the KYC
// gate exempts because they signed up before it) may be paid to the gym's
// recorded payment details only until a FIXED grace end date, which must be
// configured; with no date there is no grace. Never a permanent exemption.
import { isPayable } from '../shared/partner-kyc.mjs';
import { legacyKycGraceActive } from '../shared/settlement-config.mjs';
import { createGymPayoutOwner } from './gym-payout-owner.mjs';

const last4 = (v) => String(v || '').slice(-4);

export function createPayoutEligibility({
  users, gyms, partnerGate, partnerSettlementAccounts, trainers = null,
  // ISO timestamp; null = no legacy grace.
  legacyKycGraceEndsAt = process.env.SETTLEMENT_LEGACY_KYC_GRACE_ENDS_AT || null,
  // Who is paid for a gym (GYM_PAYOUT_OWNER): the named payout owner, or the first owner with the flag off.
  payoutOwner = createGymPayoutOwner({ users, gyms }),
}) {
  /** The owner a gym's payout is judged by, or why there is none. */
  async function gymPayee(gymId, ownerId) {
    if (!payoutOwner.flagOn()) {
      const owner = await users.findAsync((u) => u.userType === 'gym_operator' && (u.gymId === gymId || (u.gymIds || []).includes(gymId))
        && (ownerId == null || u.id === ownerId));
      return owner ? { owner } : { reason: 'no_owner_account' };
    }
    const r = await payoutOwner.resolve(gymId);
    if (ownerId != null) {
      // An owner asking about their own gym: never another owner's state.
      if (!(r.owners || []).some((o) => o.id === ownerId)) return { reason: 'no_owner_account' };
      if (!r.ok) return { reason: r.reason };
      if (r.owner.id !== ownerId) return { reason: 'not_payout_owner' };
    }
    return r.ok ? { owner: r.owner } : { reason: r.reason };
  }

  /**
   * Without ownerId (settlement and payout gating): judged by the gym's payee
   * — with GYM_PAYOUT_OWNER off the first owner account found for the gym, as
   * before; on, the payout owner (gym-payout-owner.mjs), or not payable with
   * payout_owner_required when 2+ owners share it and none is named. With
   * ownerId (a signed-in owner asking about their own gym, e.g. partner
   * progress): judged only by that owner's own case and accounts, so an owner
   * sharing a gym never sees another owner's KYC state or cooling-off date;
   * no_owner_account if that owner doesn't own the gym; with the flag on also
   * payout_owner_required, or not_payout_owner when payouts go to a co-owner.
   * @returns {{ ok: true, destination: Object } | { ok: false, reason: string, until?: string }}
   */
  async function forGym(gymId, { at = new Date(), ownerId = null } = {}) {
    const payee = await gymPayee(gymId, ownerId);
    if (!payee.owner) return { ok: false, reason: payee.reason };
    const { owner } = payee;

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

  /** A partner paid only through KYC: approved case and a verified account past its hold. */
  async function forKycPartner(userId, partnerType, at) {
    const kyc = await partnerGate.kycCaseFor(userId, partnerType);
    if (kyc?.status !== 'approved') return { ok: false, reason: kyc ? `kyc_${kyc.status}` : 'kyc_not_started' };
    const accounts = partnerSettlementAccounts ? await partnerSettlementAccounts.filterByColumnAsync('caseId', kyc.id) : [];
    const account = accounts.find((a) => isPayable(a, at));
    if (account) {
      return {
        ok: true,
        destination: {
          kind: 'verified_account', ownerId: userId, kycCaseId: kyc.id, accountId: account.id, method: account.method,
          provider: account.provider ?? null, accountName: account.accountName ?? null, accountLast4: last4(account.accountNumber),
        },
      };
    }
    const cooling = accounts.find((a) => a.status === 'verified' && a.isPrimary);
    return cooling
      ? { ok: false, reason: 'payout_account_cooling_off', until: cooling.cooldownUntil ? new Date(cooling.cooldownUntil).toISOString() : null }
      : { ok: false, reason: 'payout_account_not_verified' };
  }

  /**
   * A trainer is paid to their own verified payout account. Trainers have no
   * payout details outside KYC, so there is no legacy route: one who signed
   * up before KYC still needs approval and a verified account to be paid.
   * @returns {{ ok: true, destination: Object } | { ok: false, reason: string, until?: string }}
   */
  async function forTrainer(trainerId, { at = new Date() } = {}) {
    const trainer = trainers?.find((t) => t.id === trainerId);
    if (!trainer?.userId) return { ok: false, reason: 'no_trainer_account' };
    return forKycPartner(trainer.userId, 'trainer', at);
  }

  /** A vendor (the vendor's user id) is paid to their own verified payout account; no legacy route either. */
  async function forVendor(vendorId, { at = new Date() } = {}) {
    const vendor = await users.findByIdAsync(vendorId);
    if (!vendor || vendor.userType !== 'vendor') return { ok: false, reason: 'no_vendor_account' };
    return forKycPartner(vendorId, 'vendor', at);
  }

  return { forGym, forTrainer, forVendor, payoutOwner };
}
