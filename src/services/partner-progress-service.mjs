// Partner progress (Phase B · B4a) — reads what already exists and hands it
// to the pure builder in shared/partner-progress.mjs. Read-only: it never
// writes, and calls payout eligibility only to ask, never to pay.
//
// Input is the partner (from partnerKycService.partnerForUser) and the
// overview that GET /me/kyc already returns, so the case, checklist and
// payout accounts are read once.
import { buildProgress, buildGymOwnerProgress } from '../shared/partner-progress.mjs';

const ownedGymIds = user => (user.gymIds?.length ? user.gymIds : [user.gymId]).filter(Boolean);

export function createPartnerProgressService({ gyms, trainers, partnerGate, payoutEligibility }) {
  async function forOverview(partner, overview, { at = new Date() } = {}) {
    const { user, partnerType } = partner;
    const kycCase = overview.case || null;
    const input = {
      user,
      kycCase,
      checklist: overview.checklist,
      settlementAccounts: overview.settlementAccounts || [],
      // Approval comes from the KYC decision once a case exists, and always
      // for partners who signed up after enforcement started.
      kycDrivesApproval: Boolean(kycCase) || !partnerGate.exempt(user),
    };

    if (partnerType === 'gym_owner') {
      const list = [];
      for (const gymId of [...new Set(ownedGymIds(user))]) {
        const gym = await gyms.findByIdAsync(gymId);
        if (!gym) continue;
        list.push({ gymId, name: gym.name ?? null, eligibility: await payoutEligibility.forGym(gymId, { at }) });
      }
      return buildGymOwnerProgress({ ...input, gyms: list });
    }

    let eligibility;
    if (partnerType === 'trainer') {
      const profile = await trainers.findAsync(t => t.userId === user.id);
      eligibility = profile ? await payoutEligibility.forTrainer(profile.id, { at }) : { ok: false, reason: 'no_trainer_account' };
    } else if (partnerType === 'vendor') {
      eligibility = await payoutEligibility.forVendor(user.id, { at });
    } else {
      return null;
    }
    return buildProgress({ ...input, eligibility });
  }

  return { forOverview };
}
