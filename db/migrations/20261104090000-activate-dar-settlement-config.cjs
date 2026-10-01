// Activate the approved Dar es Salaam settlement configuration (settlement
// Phase 3, PR B), so the settlement service has something to resolve.
//
// 1. The seeded drafts (20261027090000) become active from 1 Oct 2026: the
//    four pass tier versions, the global rule (discounts 25/20/20 %, network
//    75 %) and the four gym-tier ceiling rules. Only rows still in draft are
//    touched, so anything an admin already activated or rejected is left.
// 2. Every gym that has all three retail rates and no rate card yet gets an
//    active one from 1 Oct 2026, with the discounts and ceilings of those
//    rules copied onto it (DR-23), exactly as approval through the service
//    would. A gym missing a rate, or of a tier with no ceilings (online), is
//    skipped: its visits are held as "no rate card" until an admin adds one.
//
// This only affects settlement. Member-facing pass prices and the check-in
// visit cap still come from platform settings.
//
// The app holds test data only (confirmed 30 Sep 2026), so starting the
// configuration on a fixed past date changes no real settlement.

const EFFECTIVE_FROM = '2026-10-01';
const APPROVED_BY = 'migration:20261104090000';
const CARD_CREATED_BY = 'migration:20261104090000:gym-rates';
const SEEDED_PASSES = ['ptv-basic-1', 'ptv-pro-1', 'ptv-premium-1', 'ptv-executive-1'];
const SEEDED_RULES = ['rule-global-1', 'rule-ceil-standard-1', 'rule-ceil-midtier-1', 'rule-ceil-premium-1', 'rule-ceil-luxury-1'];
const DISCOUNTS = ['dailyDiscountBps', 'weeklyDiscountBps', 'monthlyDiscountBps'];
const CEILINGS = ['dailyCeilingTzs', 'weeklyCeilingTzs', 'monthlyCeilingTzs'];

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const now = new Date();
  const activate = { status: 'active', effectiveFrom: EFFECTIVE_FROM, approvedBy: APPROVED_BY, approvedAt: now, updatedAt: now };
  await knex('PassTierVersion').whereIn('id', SEEDED_PASSES).where({ status: 'draft' }).update(activate);
  await knex('SettlementRule').whereIn('id', SEEDED_RULES).where({ status: 'draft' }).update(activate);

  // Rate cards from each gym's own retail rates, with the rules in force on
  // EFFECTIVE_FROM copied in (GYM_TIER ceilings over GLOBAL discounts).
  const rules = await knex('SettlementRule').where({ status: 'active' })
    .where('effectiveFrom', '<=', EFFECTIVE_FROM)
    .where((q) => q.whereNull('effectiveTo').orWhere('effectiveTo', '>', EFFECTIVE_FROM));
  const source = (r) => ({ ruleId: r.id, version: r.version, scopeType: r.scopeType, scopeId: r.scopeId });
  const pick = (field, gymTier) =>
    rules.find((r) => r.scopeType === 'gym_tier' && r.scopeId === gymTier && r[field] != null)
    || rules.find((r) => r.scopeType === 'global' && r[field] != null) || null;

  const gyms = await knex('Gym')
    .where('ratePerDay', '>', 0).where('ratePerWeek', '>', 0).where('ratePerMonth', '>', 0)
    .whereNotIn('id', knex('GymRateCard').select('gymId'))
    .select('id', 'tier', 'ratePerDay', 'ratePerWeek', 'ratePerMonth');
  const cards = [];
  for (const g of gyms) {
    const values = {};
    const ruleSources = {};
    for (const field of [...DISCOUNTS, ...CEILINGS]) {
      const rule = pick(field, g.tier);
      if (!rule) break;
      values[field] = rule[field];
      ruleSources[field] = source(rule);
    }
    if (Object.keys(values).length !== DISCOUNTS.length + CEILINGS.length) continue;   // no ceilings for this tier
    cards.push({
      id: `rc-${g.id}-1`, gymId: g.id, version: 1, gymTier: g.tier,
      retailDailyTzs: g.ratePerDay, retailWeeklyTzs: g.ratePerWeek, retailMonthlyTzs: g.ratePerMonth,
      ...values, ruleSources: JSON.stringify(ruleSources),
      status: 'active', effectiveFrom: EFFECTIVE_FROM, reason: 'Initial rate card from the gym\'s retail rates',
      createdBy: CARD_CREATED_BY, approvedBy: APPROVED_BY, approvedAt: now, createdAt: now, updatedAt: now,
    });
  }
  if (cards.length) await knex('GymRateCard').insert(cards).onConflict('id').ignore();
};

/**
 * Active rows are read-only by design (triggers), so this can't be undone
 * row by row; rolling back the tables' own migration removes them.
 * @param {import('knex').Knex} _knex
 */
exports.down = async function down(_knex) {};
