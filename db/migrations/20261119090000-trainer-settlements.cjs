// Trainer payouts.
//
// - TrainerBooking records who funds a session's discount (discountFundedBy).
//   Whoever sponsors a discount absorbs it: the Pass trainer discount is
//   FitFlex's, so the trainer is paid on the full price. Bookings made before
//   this keep the amounts they were priced with.
// - TrainerSettlement: one weekly statement per trainer, on the same path as
//   a gym statement: draft → submitted → approved → payable → paid, or
//   voided. A second person approves; a hold blocks payment; a payable or
//   paid statement carries the payout account it was cleared for.
// - TrainerSettlementLine: the sessions on a statement. A session is paid
//   once: it can sit on one live line only. Voiding a statement releases its
//   sessions for the next one.

const STATUSES = ['draft', 'submitted', 'approved', 'payable', 'paid', 'voided'];
const inList = (col, values) => `"${col}" IN (${values.map(v => `'${v}'`).join(', ')})`;

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('TrainerBooking', 'discountFundedBy'))) {
    await knex.schema.alterTable('TrainerBooking', t => t.text('discountFundedBy'));
  }

  if (!(await knex.schema.hasTable('TrainerSettlement'))) {
    await knex.schema.createTable('TrainerSettlement', (t) => {
      const ts = name => t.timestamp(name, { precision: 3 });
      t.text('id').primary();
      t.text('trainerId').notNullable();
      t.text('periodStartDate').notNullable();   // YYYY-MM-DD, a Monday (EAT)
      t.text('periodEndDate').notNullable();     // YYYY-MM-DD, the Sunday
      t.integer('sessionCount').notNullable().defaultTo(0);
      t.integer('listTzs').notNullable().defaultTo(0);        // sessions at the trainer's price
      t.integer('commissionTzs').notNullable().defaultTo(0);  // FitFlex commission
      t.integer('finalNetTzs').notNullable().defaultTo(0);    // what the trainer is paid
      t.text('status').notNullable().defaultTo('draft');
      t.text('preparedBy');
      t.text('submittedBy'); ts('submittedAt');
      t.text('approvedBy'); ts('approvedAt');
      t.text('rejectedBy'); ts('rejectedAt'); t.text('rejectReason');
      t.text('holdReason'); t.text('heldBy'); ts('heldAt');
      ts('payableAt');
      t.jsonb('destinationSnapshot');
      t.text('paidBy'); ts('paidAt'); t.text('paymentReference'); t.text('receiptUrl');
      t.text('voidedBy'); ts('voidedAt'); t.text('voidReason');
      ts('createdAt').notNullable().defaultTo(knex.fn.now(3));
      ts('updatedAt').notNullable().defaultTo(knex.fn.now(3));
      t.index(['trainerId']);
      t.index(['status']);
    });
    await knex.raw(`ALTER TABLE "TrainerSettlement" ADD CONSTRAINT trainer_settlement_ck CHECK (
      ${inList('status', STATUSES)} AND "periodEndDate" >= "periodStartDate" AND "finalNetTzs" >= 0
      AND ("approvedBy" IS NULL OR "approvedBy" <> "submittedBy")
      AND ("status" NOT IN ('payable', 'paid') OR "holdReason" IS NULL)
      AND ("status" NOT IN ('payable', 'paid') OR "destinationSnapshot" IS NOT NULL)
      AND ("status" <> 'paid' OR ("paidAt" IS NOT NULL AND "paymentReference" IS NOT NULL))
      AND ("status" <> 'voided' OR "voidReason" IS NOT NULL)
      AND (("holdReason" IS NULL) = ("heldAt" IS NULL)))`);
    // One live statement per trainer and week.
    await knex.raw(`CREATE UNIQUE INDEX trainer_settlement_period_ux ON "TrainerSettlement" ("trainerId", "periodStartDate") WHERE "status" <> 'voided'`);
  }

  if (!(await knex.schema.hasTable('TrainerSettlementLine'))) {
    await knex.schema.createTable('TrainerSettlementLine', (t) => {
      t.text('id').primary();
      t.text('trainerSettlementId').notNullable().references('id').inTable('TrainerSettlement').onDelete('CASCADE');
      t.text('bookingId').notNullable();
      t.text('memberId');
      t.text('gymId');
      t.text('date').notNullable();
      t.text('slot');
      t.text('basis').notNullable();            // completed | took_place
      t.integer('listPriceTzs').notNullable().defaultTo(0);
      t.integer('memberPaidTzs').notNullable().defaultTo(0);
      t.integer('commissionTzs').notNullable().defaultTo(0);
      t.integer('payoutTzs').notNullable();
      t.boolean('voided').notNullable().defaultTo(false);
      t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
      t.index(['trainerSettlementId']);
    });
    await knex.raw(`ALTER TABLE "TrainerSettlementLine" ADD CONSTRAINT trainer_settlement_line_ck CHECK ("payoutTzs" >= 0 AND "basis" IN ('completed', 'took_place'))`);
    // A session is paid once.
    await knex.raw(`CREATE UNIQUE INDEX trainer_settlement_line_booking_ux ON "TrainerSettlementLine" ("bookingId") WHERE "voided" = false`);
  }

  // A paid statement is final, and statuses only move along the path.
  await knex.raw(`CREATE OR REPLACE FUNCTION trainer_settlement_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF OLD."status" <> 'draft' THEN RAISE EXCEPTION 'TrainerSettlement: only a draft statement can be deleted' USING ERRCODE = 'P0001'; END IF;
        RETURN OLD;
      END IF;
      IF OLD."status" IN ('paid', 'voided') THEN RAISE EXCEPTION 'TrainerSettlement: a % statement is final', OLD."status" USING ERRCODE = 'P0001'; END IF;
      IF OLD."status" <> 'draft' AND (NEW."trainerId", NEW."periodStartDate", NEW."periodEndDate", NEW."sessionCount", NEW."listTzs", NEW."commissionTzs", NEW."finalNetTzs")
           IS DISTINCT FROM (OLD."trainerId", OLD."periodStartDate", OLD."periodEndDate", OLD."sessionCount", OLD."listTzs", OLD."commissionTzs", OLD."finalNetTzs") THEN
        RAISE EXCEPTION 'TrainerSettlement: amounts are frozen once a statement leaves draft' USING ERRCODE = 'P0001';
      END IF;
      IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
           (OLD."status" = 'draft'     AND NEW."status" IN ('submitted', 'voided'))
        OR (OLD."status" = 'submitted' AND NEW."status" IN ('draft', 'approved', 'voided'))
        OR (OLD."status" = 'approved'  AND NEW."status" IN ('payable', 'voided'))
        OR (OLD."status" = 'payable'   AND NEW."status" IN ('approved', 'paid'))
      ) THEN
        RAISE EXCEPTION 'TrainerSettlement: % → % is not an allowed transition', OLD."status", NEW."status" USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await knex.raw(`DROP TRIGGER IF EXISTS trainer_settlement_guard_tg ON "TrainerSettlement"`);
  await knex.raw(`CREATE TRIGGER trainer_settlement_guard_tg BEFORE UPDATE OR DELETE ON "TrainerSettlement" FOR EACH ROW EXECUTE FUNCTION trainer_settlement_guard()`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS trainer_settlement_guard_tg ON "TrainerSettlement"`);
  await knex.raw(`DROP FUNCTION IF EXISTS trainer_settlement_guard()`);
  await knex.schema.dropTableIfExists('TrainerSettlementLine');
  await knex.schema.dropTableIfExists('TrainerSettlement');
  if (await knex.schema.hasColumn('TrainerBooking', 'discountFundedBy')) {
    await knex.schema.alterTable('TrainerBooking', t => t.dropColumn('discountFundedBy'));
  }
};
