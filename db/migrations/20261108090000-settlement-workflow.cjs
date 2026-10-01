// Statement workflow for gym settlement (settlement Phase 4).
//
// 1. GymSettlement gains who and when for a hold, a rejection, and the
//    moment it became payable.
// 2. A statement on hold can't be payable or paid, and a payable or paid one
//    always carries the payout destination it was cleared for.
// 3. The statement guard now separates two kinds of amount:
//    - what the engine calculated (visits, preliminary, network adjustment):
//      frozen as soon as the run is locked or the statement leaves draft;
//    - adjustments and the net they produce: changeable while the statement
//      is still a draft, even after its run is locked, so corrections and
//      clawbacks (DR-20) can be applied before it is submitted.
//    The status path and "a paid statement is final" are unchanged.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const ts = (t, name) => t.timestamp(name, { precision: 3 });
  const cols = {
    heldBy: (t) => t.text('heldBy'),
    heldAt: (t) => ts(t, 'heldAt'),
    rejectedBy: (t) => t.text('rejectedBy'),
    rejectedAt: (t) => ts(t, 'rejectedAt'),
    rejectReason: (t) => t.text('rejectReason'),
    payableAt: (t) => ts(t, 'payableAt'),
  };
  for (const [name, add] of Object.entries(cols)) {
    if (!(await knex.schema.hasColumn('GymSettlement', name))) await knex.schema.alterTable('GymSettlement', add);
  }
  const checks = {
    gym_settlement_hold_ck: `"status" NOT IN ('payable', 'paid') OR "holdReason" IS NULL`,
    gym_settlement_destination_ck: `"status" NOT IN ('payable', 'paid') OR "destinationSnapshot" IS NOT NULL`,
    gym_settlement_held_by_ck: `("holdReason" IS NULL) = ("heldAt" IS NULL)`,
  };
  for (const [name, sql] of Object.entries(checks)) {
    await knex.raw(`ALTER TABLE "GymSettlement" DROP CONSTRAINT IF EXISTS ${name}`);
    await knex.raw(`ALTER TABLE "GymSettlement" ADD CONSTRAINT ${name} CHECK (${sql})`);
  }

  await knex.raw(`CREATE OR REPLACE FUNCTION gym_settlement_guard() RETURNS trigger AS $$
    DECLARE calculated_changed boolean; adjusted_changed boolean; run_status text;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        SELECT "status" INTO run_status FROM "SettlementRun" WHERE "id" = NEW."runId";
        IF run_status IS DISTINCT FROM 'draft' THEN
          RAISE EXCEPTION 'GymSettlement: statements can only be added to a draft run' USING ERRCODE = 'P0001';
        END IF;
        IF NEW."status" <> 'draft' THEN RAISE EXCEPTION 'GymSettlement: a statement starts as a draft' USING ERRCODE = 'P0001'; END IF;
        RETURN NEW;
      END IF;
      IF TG_OP = 'DELETE' THEN
        IF OLD."status" <> 'draft' THEN RAISE EXCEPTION 'GymSettlement: only a draft statement can be deleted' USING ERRCODE = 'P0001'; END IF;
        RETURN OLD;
      END IF;
      IF OLD."status" = 'paid' THEN RAISE EXCEPTION 'GymSettlement: a paid statement is final' USING ERRCODE = 'P0001'; END IF;
      calculated_changed := (NEW."runId", NEW."mode", NEW."gymId", NEW."periodStartDate", NEW."periodEndDate", NEW."memberCycleCount",
                             NEW."qualifyingVisitCount", NEW."heldVisitCount", NEW."preliminaryTzs", NEW."networkAdjustmentTzs")
                   IS DISTINCT FROM (OLD."runId", OLD."mode", OLD."gymId", OLD."periodStartDate", OLD."periodEndDate", OLD."memberCycleCount",
                             OLD."qualifyingVisitCount", OLD."heldVisitCount", OLD."preliminaryTzs", OLD."networkAdjustmentTzs");
      adjusted_changed := (NEW."adjustmentsTzs", NEW."carryForwardTzs", NEW."finalNetTzs")
                 IS DISTINCT FROM (OLD."adjustmentsTzs", OLD."carryForwardTzs", OLD."finalNetTzs");
      SELECT "status" INTO run_status FROM "SettlementRun" WHERE "id" = OLD."runId";
      IF calculated_changed AND (OLD."status" <> 'draft' OR run_status IS DISTINCT FROM 'draft') THEN
        RAISE EXCEPTION 'GymSettlement: amounts are frozen once a statement leaves draft or its run is locked' USING ERRCODE = 'P0001';
      END IF;
      IF adjusted_changed AND OLD."status" <> 'draft' THEN
        RAISE EXCEPTION 'GymSettlement: adjustments can only change a draft statement' USING ERRCODE = 'P0001';
      END IF;
      IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
           (OLD."status" = 'draft'     AND NEW."status" IN ('submitted', 'voided'))
        OR (OLD."status" = 'submitted' AND NEW."status" IN ('draft', 'approved', 'voided'))
        OR (OLD."status" = 'approved'  AND NEW."status" IN ('payable', 'voided'))
        OR (OLD."status" = 'payable'   AND NEW."status" IN ('approved', 'paid'))
      ) THEN
        RAISE EXCEPTION 'GymSettlement: % → % is not an allowed transition', OLD."status", NEW."status" USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  for (const name of ['gym_settlement_hold_ck', 'gym_settlement_destination_ck', 'gym_settlement_held_by_ck']) {
    await knex.raw(`ALTER TABLE "GymSettlement" DROP CONSTRAINT IF EXISTS ${name}`);
  }
  for (const name of ['heldBy', 'heldAt', 'rejectedBy', 'rejectedAt', 'rejectReason', 'payableAt']) {
    if (await knex.schema.hasColumn('GymSettlement', name)) await knex.schema.alterTable('GymSettlement', (t) => t.dropColumn(name));
  }
};
