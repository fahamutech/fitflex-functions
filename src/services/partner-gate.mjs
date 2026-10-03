// Partner gate — server-side KYC enforcement.
//
// A partner (gym owner, trainer, vendor) created on or after the enforcement
// start is "operational" only once their KYC case is approved. Partners who
// already existed before the start are exempt and keep working exactly as
// before (ongoing usability testing), whatever their approval status.
//
// What "not operational" means differs by partner (owner decision, 3 Oct 2026):
//   vendors   not live at all: products and store are hidden.
//   trainers  the profile is active and listed, shown as not verified and
//             after verified trainers, but they cannot be booked, connected
//             with as a client, or apply to a gym.
//   gyms      the gym is active and listed, shown as not verified and after
//             verified gyms, but FitFlex Pass members cannot check in there
//             (the gym's own direct members still can).
//
//   KYC_ENFORCEMENT=off        turns enforcement off entirely
//   KYC_ENFORCEMENT_FROM=ISO   partners created before this are exempt
//                              (default: ENFORCEMENT_START below)
//
// A suspended case stays operational: suspension holds payouts, not listings.
//
// The member-facing "Verified" badge (owner decision D4) means KYC-approved.
// Existing partners keep the badge they had (the stored flag) until their
// own KYC is approved. Gyms also get profileComplete — what used to switch
// the badge on automatically — shown separately.
import { gymProfileGaps } from '../shared/gym-profile.mjs';

// Set just after this change goes live, so everyone who signed up before it is exempt.
export const ENFORCEMENT_START = '2026-09-28T06:00:00.000Z';

const withProfile = g => ({ ...g, profileComplete: gymProfileGaps(g).length === 0 });

/** Lets everyone through — the default for services built without a gate (e.g. unit specs). */
export const OPEN_GATE = Object.freeze({
  enabled: () => false,
  exempt: () => true,
  operationalUserIds: async ids => new Set((ids || []).filter(Boolean)),
  isOperational: async () => true,
  isGymOperational: async () => true,
  verifiedUserIds: async () => new Set(),
  badgeGyms: async rows => rows.map(withProfile),
  badgeTrainers: async rows => rows,
  kycCaseFor: async () => null,
});
const OPERATIONAL_STATUSES = new Set(['approved', 'suspended']);

export function createPartnerGate({ users, partnerKycCases, env = process.env }) {
  const enabled = () => String(env.KYC_ENFORCEMENT || 'on').toLowerCase() !== 'off';

  const start = () => {
    const d = new Date(env.KYC_ENFORCEMENT_FROM || ENFORCEMENT_START);
    return Number.isNaN(+d) ? new Date(ENFORCEMENT_START) : d;
  };

  /** Existing partners (created before the start, or with no creation date) are exempt. */
  function exempt(user) {
    if (!enabled() || !user) return true;
    if (!user.createdAt) return true;
    const created = new Date(user.createdAt);
    return Number.isNaN(+created) || created < start();
  }

  /**
   * The subset of these partner user ids that may operate. Unknown ids (for
   * example trainer profiles with no account behind them) are left alone.
   */
  async function operationalUserIds(userIds) {
    const ids = [...new Set((userIds || []).filter(Boolean))];
    if (!enabled() || !ids.length) return new Set(ids);
    const rows = await users.filterByColumnInAsync('id', ids);
    const byId = new Map(rows.map(u => [u.id, u]));
    const needCase = ids.filter(id => byId.has(id) && !exempt(byId.get(id)));
    const cases = needCase.length ? await partnerKycCases.filterByColumnInAsync('userId', needCase) : [];
    const verified = new Set(cases.filter(c => OPERATIONAL_STATUSES.has(c.status)).map(c => c.userId));
    return new Set(ids.filter(id => !byId.has(id) || exempt(byId.get(id)) || verified.has(id)));
  }

  async function isOperational(userId) {
    if (!userId) return true;
    return (await operationalUserIds([userId])).has(userId);
  }

  const ownedGymIds = o => (o.gymIds?.length ? o.gymIds : [o.gymId]).filter(Boolean);

  /** A gym is operational when its owner is. A gym with no owner account is left alone. */
  async function isGymOperational(gymId) {
    if (!gymId || !enabled()) return true;
    const owners = (await users.filterByColumnAsync('userType', 'gym_operator')).filter(o => ownedGymIds(o).includes(gymId));
    if (!owners.length) return true;
    const ok = await operationalUserIds(owners.map(o => o.id));
    return owners.some(o => ok.has(o.id));
  }

  /** Partners whose KYC is approved (or suspended). */
  async function verifiedUserIds(userIds) {
    const ids = [...new Set((userIds || []).filter(Boolean))];
    if (!ids.length) return new Set();
    const cases = await partnerKycCases.filterByColumnInAsync('userId', ids);
    return new Set(cases.filter(c => OPERATIONAL_STATUSES.has(c.status)).map(c => c.userId));
  }

  /** The badge: KYC-approved; an existing partner keeps their stored flag until then. */
  function badge(user, stored, verified) {
    if (user && verified.has(user.id)) return true;
    if (!user || exempt(user)) return stored === true;
    return false;
  }

  /** Gyms as members see them: verified from the owner's KYC, plus profileComplete. */
  async function badgeGyms(rows) {
    if (!rows.length) return rows;
    const owners = await users.filterByColumnAsync('userType', 'gym_operator');
    const ownerOf = new Map();
    for (const o of owners) for (const id of (o.gymIds?.length ? o.gymIds : [o.gymId])) if (id) ownerOf.set(id, o);
    const verified = await verifiedUserIds(rows.map(g => ownerOf.get(g.id)?.id));
    return rows.map(g => ({ ...withProfile(g), verified: badge(ownerOf.get(g.id), g.verified, verified) }));
  }

  /** Trainers as members see them: verified from their own KYC. */
  async function badgeTrainers(rows) {
    if (!rows.length) return rows;
    const accounts = await users.filterByColumnInAsync('id', rows.map(t => t.userId).filter(Boolean));
    const byId = new Map(accounts.map(u => [u.id, u]));
    const verified = await verifiedUserIds(accounts.map(u => u.id));
    return rows.map(t => ({ ...t, verified: badge(byId.get(t.userId), t.verified, verified) }));
  }

  /** A partner's KYC case (for payout checks), or null. */
  async function kycCaseFor(userId, partnerType) {
    if (!userId) return null;
    const cases = await partnerKycCases.filterByColumnAsync('userId', userId);
    return cases.find(c => c.partnerType === partnerType) || null;
  }

  return {
    enabled, start, exempt, operationalUserIds, isOperational, isGymOperational,
    verifiedUserIds, badgeGyms, badgeTrainers, kycCaseFor,
  };
}
