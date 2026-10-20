// Phase B · B1a (trainer session outcomes): a trainer statement line may be
// paid on basis `no_show` — the member did not come; the trainer is paid in
// full (owner decision 2026-10-20). Widens the CHECK on TrainerSettlementLine.
// Additive; TrainerBooking.status is free text, so `no_show` needs no change there.
//
// Reversible while no `no_show` line exists: down() refuses otherwise, rather
// than deleting payout records.

const WIDE = `CHECK ("payoutTzs" >= 0 AND "basis" IN ('completed', 'took_place', 'no_show'))`;
const NARROW = `CHECK ("payoutTzs" >= 0 AND "basis" IN ('completed', 'took_place'))`;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('TrainerSettlementLine'))) return;
  await knex.raw('ALTER TABLE "TrainerSettlementLine" DROP CONSTRAINT IF EXISTS trainer_settlement_line_ck');
  await knex.raw(`ALTER TABLE "TrainerSettlementLine" ADD CONSTRAINT trainer_settlement_line_ck ${WIDE}`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('TrainerSettlementLine'))) return;
  const { rows } = await knex.raw(`SELECT count(*)::int AS n FROM "TrainerSettlementLine" WHERE "basis" = 'no_show'`);
  if (rows[0].n > 0) {
    throw new Error(`trainer-settlement-no-show-basis: ${rows[0].n} statement line(s) are paid on basis no_show; they must be dealt with before this migration can be rolled back`);
  }
  await knex.raw('ALTER TABLE "TrainerSettlementLine" DROP CONSTRAINT IF EXISTS trainer_settlement_line_ck');
  await knex.raw(`ALTER TABLE "TrainerSettlementLine" ADD CONSTRAINT trainer_settlement_line_ck ${NARROW}`);
};
