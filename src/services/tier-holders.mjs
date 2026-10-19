// Who still holds a FitFlex Pass tier key (owner decision 2026-10-19): Settings
// may not remove, rename or switch off a tier while anything below depends on it.
//
//   Subscription        tier = key, status active | payment_pending | pending | suspended
//   PaymentRequest      pending pass upgrade to the tier (note 'upgrade:…')
//   CorporateAccount    passTier = key (corporate seats), status pending | active | suspended
//   B2BBenefit          sponsored_pass benefit with passTier = key, status active
//   B2BPassEntitlement  passTier = key, not void, for this month or later (EAT)
//
// Returns the number of holder rows across these (0 = free to change).
import { localDay } from '../shared/member-progress.mjs';

export const HELD_SUBSCRIPTION_STATUSES = Object.freeze(['active', 'payment_pending', 'pending', 'suspended']);
export const HELD_CORPORATE_STATUSES = Object.freeze(['pending', 'active', 'suspended']);

export function createTierHolders({ db, now = () => new Date() }) {
  const count = async (query) => Number((await query.count({ n: '*' }).first())?.n ?? 0);
  const hasTable = async (t) => db.schema.hasTable(t);
  const hasColumn = async (t, c) => db.schema.hasColumn(t, c);

  return async function tierHolders(tierKey) {
    if (!tierKey) return 0;
    const period = localDay(now()).slice(0, 7);
    let total = 0;
    total += await count(db('Subscription').where({ tier: tierKey }).whereIn('status', HELD_SUBSCRIPTION_STATUSES));
    total += await count(db('PaymentRequest').where({ tier: tierKey, status: 'pending' }).where('note', 'like', 'upgrade:%'));
    if (await hasTable('CorporateAccount')) {
      total += await count(db('CorporateAccount').where({ passTier: tierKey }).whereIn('status', HELD_CORPORATE_STATUSES));
    }
    if (await hasColumn('B2BBenefit', 'passTier')) {
      total += await count(db('B2BBenefit').where({ passTier: tierKey, benefitType: 'sponsored_pass', status: 'active' }));
    }
    if (await hasTable('B2BPassEntitlement')) {
      total += await count(db('B2BPassEntitlement').where({ passTier: tierKey }).whereNot('status', 'void').where('period', '>=', period));
    }
    return total;
  };
}
