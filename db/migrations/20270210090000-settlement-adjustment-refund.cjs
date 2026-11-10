// Refund-to-statement clawback (Phase 1 · Slice D).
//
// A clawback raised because a pass refund was paid after its cycle was settled
// remembers that refund (SettlementAdjustment.refundId, nullable: every other
// adjustment leaves it empty). One refund claws back at most once from each
// source statement, so a retry can never take the money twice. An adjustment
// that sat on a voided statement ('voided') does not count, so it can be
// raised again on the gym's next statement.
// Additive and reversible: nothing reads the column unless REFUND_STATEMENT_CLAWBACK is on.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('SettlementAdjustment', 'refundId'))) {
    await knex.schema.alterTable('SettlementAdjustment', (t) => t.text('refundId'));
  }
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS settlement_adjustment_refund_once_uq ON "SettlementAdjustment" ("refundId", "sourceSettlementId") WHERE "refundId" IS NOT NULL AND "status" <> 'voided'`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS settlement_adjustment_refund_ix ON "SettlementAdjustment" ("refundId") WHERE "refundId" IS NOT NULL`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS settlement_adjustment_refund_once_uq`);
  await knex.raw(`DROP INDEX IF EXISTS settlement_adjustment_refund_ix`);
  if (await knex.schema.hasColumn('SettlementAdjustment', 'refundId')) {
    await knex.schema.alterTable('SettlementAdjustment', (t) => t.dropColumn('refundId'));
  }
};
