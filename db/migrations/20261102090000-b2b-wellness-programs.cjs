// B2B Phase 2 — wellness programmes and their benefits.
//
//   B2BWellnessProgram  what an organisation offers, to whom (eligibility) and when
//   B2BBenefit          one benefit inside a programme: type, funding split,
//                       usage limit, validity and which existing providers fulfil it
//
// Rules only: nothing here counts usage, bills anyone or pays providers
// (Phase 3 consumption, Phase 4 settlement). Money is whole TZS (*Tzs),
// shares are basis points (*Bps), dates are EAT calendar days "YYYY-MM-DD"
// with an inclusive end — the settlement-configuration conventions.
//
// Programme and benefit types, eligibility and provider-rule shapes are
// validated in src/shared/b2b-programs.mjs; the database enforces lifecycles,
// the funding/limit consistency that money depends on, and date order.

const PROGRAM_STATUSES = ['draft', 'pending', 'active', 'paused', 'expired', 'cancelled'];
const BENEFIT_STATUSES = ['draft', 'active', 'inactive'];
const FUNDING_TYPES = ['full', 'sponsor_fixed', 'sponsor_percentage', 'beneficiary_fixed', 'none'];
const USAGE_PERIODS = ['day', 'week', 'month', 'quarter', 'program', 'unlimited'];
const DAY = `'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`;

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const ts = (t, col) => t.timestamp(col, { precision: 3 });
  const stamps = (t) => {
    ts(t, 'createdAt').notNullable().defaultTo(knex.fn.now());
    ts(t, 'updatedAt').notNullable().defaultTo(knex.fn.now());
  };
  const table = async (name, build) => {
    if (!(await knex.schema.hasTable(name))) await knex.schema.createTable(name, build);
  };

  await table('B2BWellnessProgram', (t) => {
    t.text('id').primary();
    t.text('organizationId').notNullable()
      .references('id').inTable('B2BOrganization').onDelete('CASCADE').onUpdate('CASCADE');
    t.text('name').notNullable();
    t.text('description');
    t.text('programType').notNullable().defaultTo('wellness');
    t.text('status').notNullable().defaultTo('draft');
    t.text('statusReason');
    ts(t, 'statusChangedAt');
    t.text('startDate').notNullable();        // EAT day, inclusive
    t.text('endDate');                        // EAT day, inclusive; null = open-ended
    t.jsonb('eligibility').notNullable();     // { scope, groups, beneficiaryIds, beneficiaryTypes, enrolledOnOrBefore }
    t.integer('budgetTzs');                   // sponsor budget; enforced from Phase 3
    ts(t, 'activatedAt');
    t.text('activatedBy');
    t.text('createdBy');
    stamps(t);
    t.index(['organizationId', 'status']);
    t.index('status');
  });

  await table('B2BBenefit', (t) => {
    t.text('id').primary();
    t.text('programId').notNullable()
      .references('id').inTable('B2BWellnessProgram').onDelete('CASCADE').onUpdate('CASCADE');
    t.text('name').notNullable();
    t.text('description');
    t.text('benefitType').notNullable();
    t.text('status').notNullable().defaultTo('draft');
    // Funding: who pays what share of the service's price at the time of use.
    t.text('fundingType').notNullable();
    t.integer('sponsorAmountTzs');            // sponsor_fixed: sponsor pays up to this per use
    t.integer('sponsorShareBps');             // sponsor_percentage: 0–10000
    t.integer('sponsorCapTzs');               // sponsor_percentage: optional per-use ceiling
    t.integer('beneficiaryAmountTzs');        // beneficiary_fixed: member's copay per use
    // Usage: how many uses per period, and/or how much sponsor money per period.
    t.integer('usageLimit');                  // null = no count limit
    t.text('usagePeriod').notNullable();
    t.integer('periodSponsorCapTzs');         // e.g. a monthly marketplace allowance
    t.jsonb('eligibility');                   // optional narrowing of the programme's population
    t.jsonb('providerRules').notNullable();   // existing gyms / trainers / vendors / challenges
    t.text('startDate');                      // null = programme start
    t.text('endDate');                        // null = programme end
    t.text('terms');
    t.text('createdBy');
    stamps(t);
    t.index(['programId', 'status']);
    t.index('benefitType');
  });

  const inList = (col, values) => `"${col}" IN (${values.map(v => `'${v}'`).join(', ')})`;
  const nonNeg = cols => cols.map(c => `("${c}" IS NULL OR "${c}" >= 0)`).join(' AND ');
  const checks = [
    ['B2BWellnessProgram', 'b2b_program_status_chk', inList('status', PROGRAM_STATUSES)],
    ['B2BWellnessProgram', 'b2b_program_type_chk', `"programType" ~ '^[a-z][a-z0-9_]{1,39}$'`],
    ['B2BWellnessProgram', 'b2b_program_name_chk', `btrim("name") <> ''`],
    ['B2BWellnessProgram', 'b2b_program_dates_chk',
      `"startDate" ~ ${DAY} AND ("endDate" IS NULL OR ("endDate" ~ ${DAY} AND "endDate" >= "startDate"))`],
    ['B2BWellnessProgram', 'b2b_program_budget_chk', nonNeg(['budgetTzs'])],
    // Only a programme that has been active records who activated it.
    ['B2BWellnessProgram', 'b2b_program_activation_chk',
      `"status" NOT IN ('active', 'paused', 'expired') OR "activatedAt" IS NOT NULL`],
    ['B2BBenefit', 'b2b_benefit_status_chk', inList('status', BENEFIT_STATUSES)],
    ['B2BBenefit', 'b2b_benefit_type_chk', `"benefitType" ~ '^[a-z][a-z0-9_]{1,39}$'`],
    ['B2BBenefit', 'b2b_benefit_name_chk', `btrim("name") <> ''`],
    ['B2BBenefit', 'b2b_benefit_funding_type_chk', inList('fundingType', FUNDING_TYPES)],
    ['B2BBenefit', 'b2b_benefit_money_chk',
      `${nonNeg(['sponsorAmountTzs', 'sponsorCapTzs', 'beneficiaryAmountTzs', 'periodSponsorCapTzs'])}
       AND ("sponsorShareBps" IS NULL OR "sponsorShareBps" BETWEEN 0 AND 10000)`],
    // Each funding type carries exactly the numbers it needs. (Every branch says
    // IS NOT NULL explicitly: a NULL comparison would let the CHECK pass.)
    ['B2BBenefit', 'b2b_benefit_funding_chk', `
      ("fundingType" = 'full' AND "sponsorAmountTzs" IS NULL AND "sponsorShareBps" IS NULL AND "sponsorCapTzs" IS NULL AND "beneficiaryAmountTzs" IS NULL)
      OR ("fundingType" = 'sponsor_fixed' AND "sponsorAmountTzs" IS NOT NULL AND "sponsorAmountTzs" > 0 AND "sponsorShareBps" IS NULL AND "sponsorCapTzs" IS NULL AND "beneficiaryAmountTzs" IS NULL)
      OR ("fundingType" = 'sponsor_percentage' AND "sponsorShareBps" IS NOT NULL AND "sponsorAmountTzs" IS NULL AND "beneficiaryAmountTzs" IS NULL)
      OR ("fundingType" = 'beneficiary_fixed' AND "beneficiaryAmountTzs" IS NOT NULL AND "sponsorAmountTzs" IS NULL AND "sponsorShareBps" IS NULL AND "sponsorCapTzs" IS NULL)
      OR ("fundingType" = 'none' AND "sponsorAmountTzs" IS NULL AND "sponsorShareBps" IS NULL AND "sponsorCapTzs" IS NULL AND "beneficiaryAmountTzs" IS NULL AND "periodSponsorCapTzs" IS NULL)`],
    ['B2BBenefit', 'b2b_benefit_usage_period_chk', inList('usagePeriod', USAGE_PERIODS)],
    ['B2BBenefit', 'b2b_benefit_usage_limit_chk', `"usageLimit" IS NULL OR "usageLimit" > 0`],
    // "Unlimited" means no count and no money ceiling.
    ['B2BBenefit', 'b2b_benefit_unlimited_chk',
      `"usagePeriod" <> 'unlimited' OR ("usageLimit" IS NULL AND "periodSponsorCapTzs" IS NULL)`],
    ['B2BBenefit', 'b2b_benefit_dates_chk',
      `("startDate" IS NULL OR "startDate" ~ ${DAY}) AND ("endDate" IS NULL OR "endDate" ~ ${DAY})
       AND ("startDate" IS NULL OR "endDate" IS NULL OR "endDate" >= "startDate")`],
  ];
  for (const [tbl, name, expr] of checks) {
    await knex.raw('ALTER TABLE ?? DROP CONSTRAINT IF EXISTS ??', [tbl, name]);
    await knex.raw(`ALTER TABLE ?? ADD CONSTRAINT ?? CHECK (${expr})`, [tbl, name]);
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('B2BBenefit');
  await knex.schema.dropTableIfExists('B2BWellnessProgram');
};
