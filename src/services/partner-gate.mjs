// Partner gate — server-side KYC enforcement.
//
// A partner (gym owner, trainer, vendor) created on or after the enforcement
// start must have an approved KYC case before they go live: trainers are
// listed, bookable and can apply to gyms; gyms accept members; vendors'
// products and store are visible. Partners who already existed before the
// start are exempt and keep working exactly as before (ongoing usability
// testing), whatever their approval status.
//
//   KYC_ENFORCEMENT=off        turns enforcement off entirely
//   KYC_ENFORCEMENT_FROM=ISO   partners created before this are exempt
//                              (default: ENFORCEMENT_START below)
//
// A suspended case stays operational: suspension holds payouts, not listings.

// Set just after this change goes live, so everyone who signed up before it is exempt.
export const ENFORCEMENT_START = '2026-09-28T06:00:00.000Z';

/** Lets everyone through — the default for services built without a gate (e.g. unit specs). */
export const OPEN_GATE = Object.freeze({
  enabled: () => false,
  exempt: () => true,
  operationalUserIds: async ids => new Set((ids || []).filter(Boolean)),
  isOperational: async () => true,
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

  return { enabled, start, exempt, operationalUserIds, isOperational };
}
