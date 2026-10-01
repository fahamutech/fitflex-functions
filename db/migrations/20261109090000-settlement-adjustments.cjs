// Adjustments and carry-forward for gym settlement (settlement Phase 4, PR B).
//
// - SettlementAdjustment gains when it was applied and why it was rejected.
// - A statement's shortfall (DR-20: the net is never negative, the rest is
//   carried forward) can be carried into a later statement only once: one
//   applied carry_forward adjustment per source statement.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const cols = {
    appliedAt: (t) => t.timestamp('appliedAt', { precision: 3 }),
    rejectedBy: (t) => t.text('rejectedBy'),
    rejectReason: (t) => t.text('rejectReason'),
  };
  for (const [name, add] of Object.entries(cols)) {
    if (!(await knex.schema.hasColumn('SettlementAdjustment', name))) await knex.schema.alterTable('SettlementAdjustment', add);
  }
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS settlement_adjustment_carry_once_uq ON "SettlementAdjustment" ("sourceSettlementId") WHERE "type" = 'carry_forward' AND "status" = 'applied'`);
  await knex.raw(`ALTER TABLE "SettlementAdjustment" DROP CONSTRAINT IF EXISTS settlement_adjustment_carry_ck`);
  await knex.raw(`ALTER TABLE "SettlementAdjustment" ADD CONSTRAINT settlement_adjustment_carry_ck CHECK ("type" <> 'carry_forward' OR ("amountTzs" < 0 AND "sourceSettlementId" IS NOT NULL))`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE "SettlementAdjustment" DROP CONSTRAINT IF EXISTS settlement_adjustment_carry_ck`);
  await knex.raw(`DROP INDEX IF EXISTS settlement_adjustment_carry_once_uq`);
  for (const name of ['appliedAt', 'rejectedBy', 'rejectReason']) {
    if (await knex.schema.hasColumn('SettlementAdjustment', name)) await knex.schema.alterTable('SettlementAdjustment', (t) => t.dropColumn(name));
  }
};
