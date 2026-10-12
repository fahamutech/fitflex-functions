// A custom price for a sponsored pass.
//
//   B2BBenefit.fixedFeeTzs            the fee per person per month for this
//                                     sponsored-pass benefit, set by FitFlex
//   B2BCommercialAgreement.passRates  the organisation's agreed fee per pass
//                                     tier, { "<tier>": TZS }, used when the
//                                     benefit has no fee of its own
//   B2BPassEntitlement.priceBasis     where an entitlement's fee came from
//
// Additive only. With none of these set, the fee is the tier's price less the
// programme's discount, as before.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const add = async (table, column, build) => {
    if (!(await knex.schema.hasColumn(table, column))) await knex.schema.alterTable(table, build);
  };
  await add('B2BBenefit', 'fixedFeeTzs', t => t.integer('fixedFeeTzs'));
  await add('B2BCommercialAgreement', 'passRates', t => t.jsonb('passRates'));
  await add('B2BPassEntitlement', 'priceBasis', t => t.text('priceBasis'));
  await knex.raw(`ALTER TABLE "B2BBenefit" DROP CONSTRAINT IF EXISTS b2b_benefit_fixed_fee_chk`);
  await knex.raw(`ALTER TABLE "B2BBenefit" ADD CONSTRAINT b2b_benefit_fixed_fee_chk CHECK ("fixedFeeTzs" IS NULL OR ("fixedFeeTzs" > 0 AND "benefitType" = 'sponsored_pass'))`);
  await knex.raw(`ALTER TABLE "B2BPassEntitlement" DROP CONSTRAINT IF EXISTS b2b_pass_price_basis_chk`);
  await knex.raw(`ALTER TABLE "B2BPassEntitlement" ADD CONSTRAINT b2b_pass_price_basis_chk CHECK ("priceBasis" IS NULL OR "priceBasis" IN ('list_price', 'programme_discount', 'agreement_rate', 'benefit_fee'))`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE "B2BPassEntitlement" DROP CONSTRAINT IF EXISTS b2b_pass_price_basis_chk`);
  await knex.raw(`ALTER TABLE "B2BBenefit" DROP CONSTRAINT IF EXISTS b2b_benefit_fixed_fee_chk`);
  for (const [table, column] of [['B2BPassEntitlement', 'priceBasis'], ['B2BCommercialAgreement', 'passRates'], ['B2BBenefit', 'fixedFeeTzs']]) {
    if (await knex.schema.hasColumn(table, column)) await knex.schema.alterTable(table, t => t.dropColumn(column));
  }
};
