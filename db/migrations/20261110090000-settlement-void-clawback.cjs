// Voiding a statement and automatic clawbacks (settlement Phase 6).
//
// - An adjustment can be 'voided': it sat on a statement that was voided, so
//   it never took effect. A carried-forward shortfall or a clawback that was
//   on that statement is raised again on the gym's next one.
// - An adjustment remembers the member cycle it corrects
//   (sourceMemberCycleSettlementId), so a recalculation after a voided
//   check-in raises only what has not been raised yet.

const CHECK = (statuses) => `"amountTzs" <> 0 AND "type" IN ('correction', 'clawback', 'reversal', 'carry_forward', 'manual')
     AND "status" IN (${statuses.map((s) => `'${s}'`).join(', ')})
     AND ("type" <> 'clawback' OR "amountTzs" < 0)
     AND ("approvedBy" IS NULL OR "approvedBy" <> "createdBy")
     AND ("status" NOT IN ('approved', 'applied') OR ("approvedBy" IS NOT NULL AND "approvedAt" IS NOT NULL))`;

async function setCheck(knex, statuses) {
  await knex.raw(`ALTER TABLE "SettlementAdjustment" DROP CONSTRAINT IF EXISTS settlement_adjustment_ck`);
  await knex.raw(`ALTER TABLE "SettlementAdjustment" ADD CONSTRAINT settlement_adjustment_ck CHECK (${CHECK(statuses)})`);
}

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('SettlementAdjustment', 'sourceMemberCycleSettlementId'))) {
    await knex.schema.alterTable('SettlementAdjustment', (t) => t.text('sourceMemberCycleSettlementId'));
  }
  await knex.raw(`CREATE INDEX IF NOT EXISTS settlement_adjustment_source_cycle_ix ON "SettlementAdjustment" ("sourceMemberCycleSettlementId") WHERE "sourceMemberCycleSettlementId" IS NOT NULL`);
  await setCheck(knex, ['proposed', 'approved', 'applied', 'rejected', 'voided']);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex('SettlementAdjustment').where({ status: 'voided' }).update({ status: 'rejected', rejectReason: 'Statement voided' });
  await setCheck(knex, ['proposed', 'approved', 'applied', 'rejected']);
  await knex.raw(`DROP INDEX IF EXISTS settlement_adjustment_source_cycle_ix`);
  if (await knex.schema.hasColumn('SettlementAdjustment', 'sourceMemberCycleSettlementId')) {
    await knex.schema.alterTable('SettlementAdjustment', (t) => t.dropColumn('sourceMemberCycleSettlementId'));
  }
};
