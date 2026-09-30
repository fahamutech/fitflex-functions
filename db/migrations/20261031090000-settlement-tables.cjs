// Settlement tables (settlement Phase 2, PR 3): where the Phase 1 engine's
// results will be stored. No job writes them yet.
//
//   SettlementRun           one calculation run, LIVE or SHADOW (DR-16)
//   MemberCycleSettlement   one member cycle: the network cap is applied here
//   GymSettlement           one gym's statement for one period (EAT month)
//   GymSettlementLine       one member cycle at one gym (the bracket prices
//                           a group of visits, not a single check-in)
//   SettlementVisit         every check-in a run considered, with its outcome
//   SettlementAdjustment    signed corrections and clawbacks (DR-20)
//   GymPayout.gymSettlementId  a payout can point at a statement (live only)
//
// What the database guarantees:
// - A check-in is paid at most once: SettlementVisit(checkinId) is unique
//   among active, payable visits of LIVE runs. Shadow runs never collide.
// - One live statement per gym per period, one live settlement per member
//   cycle, one live run per period.
// - Every row of a run shares its run's mode, and a line belongs to a
//   statement and a member cycle of the same run (composite foreign keys).
// - Amounts add up (final = preliminary + network adjustment, a gym never gets
//   more than its preliminary, a member cycle never more than its cap) and a
//   statement's net is never negative: a shortfall is carried forward.
// - A locked run's rows are read-only; a statement's amounts freeze once it
//   leaves draft, its status moves only along the workflow, and a paid one is
//   final. Approver ≠ submitter; adjustment approver ≠ creator.
// - A GymPayout can't point at a shadow statement.
//
// Member, gym, subscription and check-in ids are kept as plain references (no
// foreign keys): these are financial records and must outlive account or gym
// deletion. Money is integer TZS; percentages basis points; periods are EAT
// calendar days "YYYY-MM-DD" (end exclusive).

const DATE = `~ '^\\d{4}-\\d{2}-\\d{2}$'`;
const ELIGIBILITY = ['eligible', 'outside_member_cycle', 'wrong_subscription_type', 'voided', 'second_gym_same_day',
  'duplicate_same_day', 'not_consumed', 'over_allowance', 'disputed', 'flagged', 'unknown_status', 'no_rate_card'];
const q = (xs) => xs.map((x) => `'${x}'`).join(', ');

async function check(knex, table, name, sql) {
  await knex.raw(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS ${name}`);
  await knex.raw(`ALTER TABLE "${table}" ADD CONSTRAINT ${name} CHECK (${sql})`);
}

async function trigger(knex, table, name, when, body) {
  await knex.raw(`CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger AS $$ ${body} $$ LANGUAGE plpgsql`);
  await knex.raw(`DROP TRIGGER IF EXISTS ${name} ON "${table}"`);
  await knex.raw(`CREATE TRIGGER ${name} ${when} ON "${table}" FOR EACH ROW EXECUTE FUNCTION ${name}()`);
}

const ts = (t, name) => t.timestamp(name, { precision: 3 });

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  // ── SettlementRun ──────────────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('SettlementRun'))) {
    await knex.schema.createTable('SettlementRun', (t) => {
      t.text('id').primary();
      t.text('mode').notNullable();
      t.text('periodStartDate').notNullable();
      t.text('periodEndDate').notNullable();
      t.text('status').notNullable().defaultTo('draft');
      t.text('engineVersion').notNullable();
      t.text('inputsHash');
      t.jsonb('configurationSnapshot');
      t.text('jobRunId');
      t.text('error');
      t.text('createdBy');
      t.text('lockedBy');
      ts(t, 'lockedAt');
      ts(t, 'createdAt').notNullable().defaultTo(knex.fn.now());
      ts(t, 'updatedAt');
      t.unique(['id', 'mode']);
      t.index(['mode', 'periodStartDate']);
    });
  }
  await check(knex, 'SettlementRun', 'settlement_run_mode_ck', `"mode" IN ('live', 'shadow')`);
  await check(knex, 'SettlementRun', 'settlement_run_status_ck', `"status" IN ('draft', 'locked', 'failed')`);
  await check(knex, 'SettlementRun', 'settlement_run_period_ck', `"periodStartDate" ${DATE} AND "periodEndDate" ${DATE} AND "periodEndDate" > "periodStartDate"`);
  await check(knex, 'SettlementRun', 'settlement_run_locked_ck', `"status" <> 'locked' OR ("lockedAt" IS NOT NULL AND "inputsHash" IS NOT NULL)`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS settlement_run_live_period_uq ON "SettlementRun" ("periodStartDate", "periodEndDate") WHERE "mode" = 'live' AND "status" <> 'failed'`);

  // ── MemberCycleSettlement ──────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('MemberCycleSettlement'))) {
    await knex.schema.createTable('MemberCycleSettlement', (t) => {
      t.text('id').primary();
      t.text('runId').notNullable();
      t.text('mode').notNullable();
      t.text('memberId').notNullable();
      t.text('subscriptionId').notNullable();
      ts(t, 'cycleStart').notNullable();
      ts(t, 'cycleEnd').notNullable();
      t.text('passTier').notNullable();
      t.integer('passTierVersion');
      t.integer('catalogPriceTzs');
      t.integer('visitAllowance').notNullable();
      t.integer('collectedApprovedAmountTzs').notNullable();
      t.integer('networkPayoutBps').notNullable();
      t.integer('networkCapTzs').notNullable();
      t.integer('totalPreliminaryTzs').notNullable();
      t.integer('totalFinalTzs').notNullable();
      t.integer('networkAdjustmentTzs').notNullable();
      t.boolean('capApplied').notNullable();
      t.integer('payableVisitCount').notNullable();
      t.integer('heldVisitCount').notNullable();
      t.integer('excludedVisitCount').notNullable();
      t.text('engineVersion').notNullable();
      t.jsonb('explanation');
      t.boolean('active').notNullable().defaultTo(true);
      ts(t, 'createdAt').notNullable().defaultTo(knex.fn.now());
      t.foreign(['runId', 'mode']).references(['id', 'mode']).inTable('SettlementRun').onDelete('CASCADE');
      t.unique(['id', 'runId']);
      t.index(['runId']);
      t.index(['memberId']);
    });
  }
  await check(knex, 'MemberCycleSettlement', 'mcs_amounts_ck',
    `"visitAllowance" >= 0 AND "collectedApprovedAmountTzs" >= 0 AND "networkPayoutBps" BETWEEN 0 AND 10000 AND "networkCapTzs" >= 0
     AND "totalPreliminaryTzs" >= 0 AND "totalFinalTzs" >= 0 AND "payableVisitCount" >= 0 AND "heldVisitCount" >= 0 AND "excludedVisitCount" >= 0
     AND ("catalogPriceTzs" IS NULL OR "catalogPriceTzs" >= 0)`);
  await check(knex, 'MemberCycleSettlement', 'mcs_cap_ck',
    `"totalFinalTzs" <= "networkCapTzs" AND "totalFinalTzs" <= "totalPreliminaryTzs"
     AND "networkAdjustmentTzs" = "totalFinalTzs" - "totalPreliminaryTzs"
     AND "capApplied" = ("totalPreliminaryTzs" > "networkCapTzs")
     AND "payableVisitCount" <= "visitAllowance"`);
  await check(knex, 'MemberCycleSettlement', 'mcs_cycle_ck', `"cycleEnd" > "cycleStart"`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS mcs_live_cycle_uq ON "MemberCycleSettlement" ("subscriptionId") WHERE "mode" = 'live' AND "active"`);

  // ── GymSettlement ──────────────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('GymSettlement'))) {
    await knex.schema.createTable('GymSettlement', (t) => {
      t.text('id').primary();
      t.text('runId').notNullable();
      t.text('mode').notNullable();
      t.text('gymId').notNullable();
      t.text('periodStartDate').notNullable();
      t.text('periodEndDate').notNullable();
      t.integer('memberCycleCount').notNullable().defaultTo(0);
      t.integer('qualifyingVisitCount').notNullable().defaultTo(0);
      t.integer('heldVisitCount').notNullable().defaultTo(0);
      t.integer('preliminaryTzs').notNullable().defaultTo(0);
      t.integer('networkAdjustmentTzs').notNullable().defaultTo(0);
      t.integer('adjustmentsTzs').notNullable().defaultTo(0);
      t.integer('carryForwardTzs').notNullable().defaultTo(0);
      t.integer('finalNetTzs').notNullable().defaultTo(0);
      t.text('status').notNullable().defaultTo('draft');
      t.text('holdReason');
      t.jsonb('destinationSnapshot');
      t.text('submittedBy'); ts(t, 'submittedAt');
      t.text('approvedBy'); ts(t, 'approvedAt');
      t.text('paidBy'); ts(t, 'paidAt');
      t.text('paymentReference');
      t.text('receiptUrl');
      t.text('voidedBy'); ts(t, 'voidedAt'); t.text('voidReason');
      ts(t, 'createdAt').notNullable().defaultTo(knex.fn.now());
      ts(t, 'updatedAt');
      t.foreign(['runId', 'mode']).references(['id', 'mode']).inTable('SettlementRun').onDelete('CASCADE');
      t.unique(['id', 'runId']);
      t.unique(['id', 'mode']);
      t.index(['runId']);
      t.index(['gymId', 'periodStartDate']);
      t.index(['status']);
    });
  }
  await check(knex, 'GymSettlement', 'gym_settlement_status_ck', `"status" IN ('draft', 'submitted', 'approved', 'payable', 'paid', 'voided')`);
  await check(knex, 'GymSettlement', 'gym_settlement_period_ck', `"periodStartDate" ${DATE} AND "periodEndDate" ${DATE} AND "periodEndDate" > "periodStartDate"`);
  // DR-20: a shortfall is carried forward; the net paid is never negative.
  await check(knex, 'GymSettlement', 'gym_settlement_amounts_ck',
    `"memberCycleCount" >= 0 AND "qualifyingVisitCount" >= 0 AND "heldVisitCount" >= 0 AND "preliminaryTzs" >= 0
     AND "networkAdjustmentTzs" <= 0 AND "networkAdjustmentTzs" >= -"preliminaryTzs"
     AND "finalNetTzs" = GREATEST(0, "preliminaryTzs" + "networkAdjustmentTzs" + "adjustmentsTzs")
     AND "carryForwardTzs" = LEAST(0, "preliminaryTzs" + "networkAdjustmentTzs" + "adjustmentsTzs")`);
  await check(knex, 'GymSettlement', 'gym_settlement_maker_checker_ck', `"approvedBy" IS NULL OR "submittedBy" IS NULL OR "approvedBy" <> "submittedBy"`);
  await check(knex, 'GymSettlement', 'gym_settlement_paid_ck', `"status" <> 'paid' OR ("paidAt" IS NOT NULL AND "paidBy" IS NOT NULL AND "paymentReference" IS NOT NULL AND "approvedBy" IS NOT NULL)`);
  await check(knex, 'GymSettlement', 'gym_settlement_voided_ck', `"status" <> 'voided' OR ("voidedAt" IS NOT NULL AND "voidReason" IS NOT NULL)`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS gym_settlement_live_period_uq ON "GymSettlement" ("gymId", "periodStartDate", "periodEndDate") WHERE "mode" = 'live' AND "status" <> 'voided'`);

  // ── GymSettlementLine ──────────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('GymSettlementLine'))) {
    await knex.schema.createTable('GymSettlementLine', (t) => {
      t.text('id').primary();
      t.text('runId').notNullable();
      t.text('mode').notNullable();
      t.text('gymSettlementId').notNullable();
      t.text('memberCycleSettlementId').notNullable();
      t.text('memberId').notNullable();
      t.text('gymId').notNullable();
      t.integer('qualifyingVisitCount').notNullable();
      t.integer('heldVisitCount').notNullable();
      t.text('bracket');
      t.integer('rawPreliminaryTzs').notNullable();
      t.integer('preliminaryTzs').notNullable();
      t.boolean('monotonicGuardApplied').notNullable();
      t.integer('networkAdjustmentTzs').notNullable();
      t.integer('finalTzs').notNullable();
      t.jsonb('rateCardSnapshot');
      t.jsonb('calculationBasis');
      ts(t, 'createdAt').notNullable().defaultTo(knex.fn.now());
      t.foreign(['runId', 'mode']).references(['id', 'mode']).inTable('SettlementRun').onDelete('CASCADE');
      t.foreign(['gymSettlementId', 'runId']).references(['id', 'runId']).inTable('GymSettlement').onDelete('CASCADE');
      t.foreign(['memberCycleSettlementId', 'runId']).references(['id', 'runId']).inTable('MemberCycleSettlement').onDelete('CASCADE');
      t.unique(['memberCycleSettlementId', 'gymId']);
      t.unique(['id', 'runId']);
      t.index(['gymSettlementId']);
      t.index(['memberId']);
    });
  }
  await check(knex, 'GymSettlementLine', 'gym_line_bracket_ck', `"bracket" IS NULL OR "bracket" IN ('none', 'daily', 'weekly', 'double_weekly', 'monthly')`);
  await check(knex, 'GymSettlementLine', 'gym_line_amounts_ck',
    `"qualifyingVisitCount" >= 0 AND "heldVisitCount" >= 0 AND "rawPreliminaryTzs" >= 0 AND "preliminaryTzs" >= "rawPreliminaryTzs"
     AND "monotonicGuardApplied" = ("preliminaryTzs" > "rawPreliminaryTzs")
     AND "finalTzs" >= 0 AND "finalTzs" <= "preliminaryTzs" AND "networkAdjustmentTzs" = "finalTzs" - "preliminaryTzs"`);

  // ── SettlementVisit ────────────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('SettlementVisit'))) {
    await knex.schema.createTable('SettlementVisit', (t) => {
      t.text('id').primary();
      t.text('runId').notNullable();
      t.text('mode').notNullable();
      t.text('memberCycleSettlementId').notNullable();
      t.text('lineId');
      t.text('checkinId').notNullable();
      t.text('gymId').notNullable();
      t.text('businessDate');
      t.text('outcome').notNullable();
      t.text('eligibility').notNullable();
      t.integer('allowanceSlot');
      t.boolean('active').notNullable().defaultTo(true);
      ts(t, 'createdAt').notNullable().defaultTo(knex.fn.now());
      t.foreign(['runId', 'mode']).references(['id', 'mode']).inTable('SettlementRun').onDelete('CASCADE');
      t.foreign(['memberCycleSettlementId', 'runId']).references(['id', 'runId']).inTable('MemberCycleSettlement').onDelete('CASCADE');
      t.foreign(['lineId', 'runId']).references(['id', 'runId']).inTable('GymSettlementLine').onDelete('CASCADE');
      t.unique(['runId', 'checkinId']);
      t.index(['checkinId']);
      t.index(['lineId']);
    });
  }
  await check(knex, 'SettlementVisit', 'settlement_visit_outcome_ck', `"outcome" IN ('payable', 'held', 'excluded')`);
  await check(knex, 'SettlementVisit', 'settlement_visit_eligibility_ck', `"eligibility" IN (${q(ELIGIBILITY)})`);
  await check(knex, 'SettlementVisit', 'settlement_visit_consistency_ck',
    `("outcome" = 'payable') = ("eligibility" = 'eligible') AND ("outcome" <> 'payable' OR "lineId" IS NOT NULL)
     AND ("businessDate" IS NULL OR "businessDate" ${DATE})`);
  // The never-paid-twice guarantee.
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS settlement_visit_paid_once_uq ON "SettlementVisit" ("checkinId") WHERE "mode" = 'live' AND "outcome" = 'payable' AND "active"`);

  // ── SettlementAdjustment ───────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('SettlementAdjustment'))) {
    await knex.schema.createTable('SettlementAdjustment', (t) => {
      t.text('id').primary();
      t.text('gymSettlementId').notNullable().references('id').inTable('GymSettlement').onDelete('CASCADE');
      t.integer('amountTzs').notNullable();
      t.text('type').notNullable();
      t.text('reason').notNullable();
      t.text('status').notNullable().defaultTo('proposed');
      t.text('sourceSettlementId');
      t.text('sourceCheckinId');
      t.text('createdBy').notNullable();
      t.text('approvedBy'); ts(t, 'approvedAt');
      ts(t, 'createdAt').notNullable().defaultTo(knex.fn.now());
      ts(t, 'updatedAt');
      t.index(['gymSettlementId']);
      t.index(['sourceCheckinId']);
    });
  }
  await check(knex, 'SettlementAdjustment', 'settlement_adjustment_ck',
    `"amountTzs" <> 0 AND "type" IN ('correction', 'clawback', 'reversal', 'carry_forward', 'manual')
     AND "status" IN ('proposed', 'approved', 'applied', 'rejected')
     AND ("type" <> 'clawback' OR "amountTzs" < 0)
     AND ("approvedBy" IS NULL OR "approvedBy" <> "createdBy")
     AND ("status" NOT IN ('approved', 'applied') OR ("approvedBy" IS NOT NULL AND "approvedAt" IS NOT NULL))`);

  // ── GymPayout → statement (live only) ─────────────────────────────────────
  if (!(await knex.schema.hasColumn('GymPayout', 'gymSettlementId'))) {
    await knex.schema.alterTable('GymPayout', (t) => {
      t.text('gymSettlementId');
      t.text('gymSettlementMode');
    });
  }
  await knex.raw(`ALTER TABLE "GymPayout" DROP CONSTRAINT IF EXISTS gym_payout_settlement_fk`);
  await knex.raw(`ALTER TABLE "GymPayout" ADD CONSTRAINT gym_payout_settlement_fk FOREIGN KEY ("gymSettlementId", "gymSettlementMode") REFERENCES "GymSettlement" ("id", "mode") ON DELETE RESTRICT`);
  await check(knex, 'GymPayout', 'gym_payout_live_ck', `"gymSettlementId" IS NULL OR "gymSettlementMode" = 'live'`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS gym_payout_one_per_settlement_uq ON "GymPayout" ("gymSettlementId") WHERE "gymSettlementId" IS NOT NULL AND "status" IN ('initiated', 'paid')`);

  // ── immutability ───────────────────────────────────────────────────────────
  // A locked or failed run is history. Only a draft run may be deleted.
  await trigger(knex, 'SettlementRun', 'settlement_run_guard', 'BEFORE UPDATE OR DELETE', `
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF OLD."status" <> 'draft' THEN RAISE EXCEPTION 'SettlementRun: only a draft run can be deleted' USING ERRCODE = 'P0001'; END IF;
        RETURN OLD;
      END IF;
      IF OLD."status" <> 'draft' THEN RAISE EXCEPTION 'SettlementRun: a % run is read-only', OLD."status" USING ERRCODE = 'P0001'; END IF;
      IF NEW."id" <> OLD."id" OR NEW."mode" <> OLD."mode" THEN RAISE EXCEPTION 'SettlementRun: id and mode are fixed' USING ERRCODE = 'P0001'; END IF;
      RETURN NEW;
    END`);

  // Rows of a locked run can't change, except releasing (active → false)
  // member cycles and visits when a statement is voided.
  for (const [table, releasable] of [['MemberCycleSettlement', true], ['GymSettlementLine', false], ['SettlementVisit', true]]) {
    const name = `${table.toLowerCase()}_locked_guard`;
    await trigger(knex, table, name, 'BEFORE INSERT OR UPDATE OR DELETE', `
      DECLARE run_status text;
      BEGIN
        IF TG_OP = 'INSERT' THEN
          SELECT "status" INTO run_status FROM "SettlementRun" WHERE "id" = NEW."runId";
          IF run_status IS DISTINCT FROM 'draft' THEN
            RAISE EXCEPTION '${table}: rows can only be added to a draft run' USING ERRCODE = 'P0001';
          END IF;
          RETURN NEW;
        END IF;
        SELECT "status" INTO run_status FROM "SettlementRun" WHERE "id" = OLD."runId";
        IF run_status IS DISTINCT FROM 'draft' THEN
          IF TG_OP = 'DELETE' AND run_status IS NOT NULL THEN
            RAISE EXCEPTION '${table}: rows of a % run are read-only', run_status USING ERRCODE = 'P0001';
          END IF;
          IF TG_OP = 'UPDATE' THEN
            ${releasable
              ? `IF (to_jsonb(NEW) - 'active') IS DISTINCT FROM (to_jsonb(OLD) - 'active') OR (NEW."active" AND NOT OLD."active") THEN
                   RAISE EXCEPTION '${table}: rows of a % run are read-only (they can only be released)', run_status USING ERRCODE = 'P0001';
                 END IF;`
              : `RAISE EXCEPTION '${table}: rows of a % run are read-only', run_status USING ERRCODE = 'P0001';`}
          END IF;
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END`);
  }

  // A statement's amounts freeze once it leaves draft; its status moves only
  // along the workflow; a paid statement is final; only drafts are deleted.
  await trigger(knex, 'GymSettlement', 'gym_settlement_guard', 'BEFORE INSERT OR UPDATE OR DELETE', `
    DECLARE amounts_changed boolean; run_status text;
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
      amounts_changed := (NEW."runId", NEW."mode", NEW."gymId", NEW."periodStartDate", NEW."periodEndDate", NEW."memberCycleCount",
                          NEW."qualifyingVisitCount", NEW."heldVisitCount", NEW."preliminaryTzs", NEW."networkAdjustmentTzs",
                          NEW."adjustmentsTzs", NEW."carryForwardTzs", NEW."finalNetTzs")
                IS DISTINCT FROM (OLD."runId", OLD."mode", OLD."gymId", OLD."periodStartDate", OLD."periodEndDate", OLD."memberCycleCount",
                          OLD."qualifyingVisitCount", OLD."heldVisitCount", OLD."preliminaryTzs", OLD."networkAdjustmentTzs",
                          OLD."adjustmentsTzs", OLD."carryForwardTzs", OLD."finalNetTzs");
      SELECT "status" INTO run_status FROM "SettlementRun" WHERE "id" = OLD."runId";
      IF amounts_changed AND (OLD."status" <> 'draft' OR run_status IS DISTINCT FROM 'draft') THEN
        RAISE EXCEPTION 'GymSettlement: amounts are frozen once a statement leaves draft or its run is locked' USING ERRCODE = 'P0001';
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
    END`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS gym_payout_one_per_settlement_uq`);
  await knex.raw(`ALTER TABLE "GymPayout" DROP CONSTRAINT IF EXISTS gym_payout_live_ck`);
  await knex.raw(`ALTER TABLE "GymPayout" DROP CONSTRAINT IF EXISTS gym_payout_settlement_fk`);
  for (const c of ['gymSettlementId', 'gymSettlementMode']) {
    if (await knex.schema.hasColumn('GymPayout', c)) await knex.schema.alterTable('GymPayout', (t) => t.dropColumn(c));
  }
  for (const table of ['SettlementAdjustment', 'SettlementVisit', 'GymSettlementLine', 'GymSettlement', 'MemberCycleSettlement', 'SettlementRun']) {
    await knex.schema.dropTableIfExists(table);
  }
  for (const fn of ['settlement_run_guard', 'membercyclesettlement_locked_guard', 'gymsettlementline_locked_guard',
    'settlementvisit_locked_guard', 'gym_settlement_guard']) {
    await knex.raw(`DROP FUNCTION IF EXISTS ${fn}()`);
  }
};
