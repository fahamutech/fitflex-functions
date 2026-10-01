// Company-funded (B2B) gym visits enter gym settlement (decided 1 Oct 2026):
// the same brackets and network cap as a member's own pass, per beneficiary
// per EAT month. A member-cycle settlement now says how it was funded.
//
//   platform_pass  subscriptionId = the pass Subscription (one 30-day cycle)
//   b2b_benefit    subscriptionId = "b2b:<beneficiaryId>:<YYYY-MM>", the
//                  beneficiary's B2B visits in that EAT month
//
// Existing rows are pass settlements (the column default). Adding a column
// with a constant default rewrites nothing and fires no row trigger, so
// locked runs stay untouched.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('MemberCycleSettlement', 'fundingType'))) {
    await knex.schema.alterTable('MemberCycleSettlement', (t) => t.text('fundingType').notNullable().defaultTo('platform_pass'));
  }
  await knex.raw(`ALTER TABLE "MemberCycleSettlement" DROP CONSTRAINT IF EXISTS mcs_funding_type_ck`);
  await knex.raw(`ALTER TABLE "MemberCycleSettlement" ADD CONSTRAINT mcs_funding_type_ck CHECK ("fundingType" IN ('platform_pass', 'b2b_benefit'))`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE "MemberCycleSettlement" DROP CONSTRAINT IF EXISTS mcs_funding_type_ck`);
  if (await knex.schema.hasColumn('MemberCycleSettlement', 'fundingType')) {
    await knex.schema.alterTable('MemberCycleSettlement', (t) => t.dropColumn('fundingType'));
  }
};
