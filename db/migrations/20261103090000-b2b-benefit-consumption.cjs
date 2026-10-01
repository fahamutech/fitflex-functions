// B2B Phase 3 — the benefit consumption ledger.
//
//   B2BBenefitConsumption  one row per application of a benefit to a real
//                          FitFlex usage event (a Checkin, a TrainerBooking).
//
// The usage event itself is NOT copied: (sourceType, sourceId) points at the
// existing row. The ledger is the source of truth for allowances — remaining
// usage is always counted from it, never from a mutable counter — and the
// input Phase 4 settlement will read. Rows are never deleted: a correction is
// a status change (reversed / cancelled) that keeps who, when and why.
//
//   pending ──► approved ──► reversed
//      └──────► cancelled          rejected (recorded as such; never changes)
//
// Money is whole TZS; sponsorTzs + beneficiaryTzs always equals grossTzs.
// No provider payout is stored or computed here.

const STATUSES = ['pending', 'approved', 'rejected', 'reversed', 'cancelled'];
const DAY = `'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`;

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const ts = (t, col) => t.timestamp(col, { precision: 3 });

  if (!(await knex.schema.hasTable('B2BBenefitConsumption'))) {
    await knex.schema.createTable('B2BBenefitConsumption', (t) => {
      t.text('id').primary();
      // RESTRICT: ledger rows outlive edits and can't be orphaned.
      t.text('organizationId').notNullable().references('id').inTable('B2BOrganization').onDelete('RESTRICT').onUpdate('CASCADE');
      t.text('programId').notNullable().references('id').inTable('B2BWellnessProgram').onDelete('RESTRICT').onUpdate('CASCADE');
      t.text('benefitId').notNullable().references('id').inTable('B2BBenefit').onDelete('RESTRICT').onUpdate('CASCADE');
      // B2BBeneficiary.id, or CorporateEmployee.id for a mapped company (so no FK).
      t.text('beneficiaryId').notNullable();
      t.text('beneficiarySource').notNullable();
      t.text('userId').references('id').inTable('User').onDelete('SET NULL').onUpdate('CASCADE');
      // The existing usage event this row applies to.
      t.text('sourceType').notNullable();         // gym_checkin | trainer_booking | ...
      t.text('sourceId').notNullable();           // Checkin.id | TrainerBooking.id
      t.text('serviceType').notNullable();        // the benefit type that covered it
      t.text('providerType').notNullable();       // gym | trainer | ...
      t.text('providerId').notNullable();
      ts(t, 'consumedAt').notNullable();
      t.text('businessDate').notNullable();       // EAT day; usage windows count on this
      t.integer('quantity').notNullable().defaultTo(1);
      t.integer('unitValueTzs').notNullable();
      t.integer('grossTzs').notNullable();
      t.integer('sponsorTzs').notNullable();
      t.integer('beneficiaryTzs').notNullable();
      t.text('status').notNullable();
      t.text('rejectionReason');
      ts(t, 'verifiedAt');                        // when the usage was confirmed to have happened
      ts(t, 'reversedAt');
      t.text('reversedBy');
      t.text('reversalReason');
      // The rules in force when it was decided: funding, limit, window, what was left.
      t.jsonb('rulesSnapshot');
      t.jsonb('metadata');
      t.text('initiatedBy');
      ts(t, 'createdAt').notNullable().defaultTo(knex.fn.now());
      ts(t, 'updatedAt').notNullable().defaultTo(knex.fn.now());
      t.index(['benefitId', 'beneficiaryId', 'businessDate']);
      t.index(['organizationId', 'consumedAt']);
      t.index(['programId', 'status']);
      t.index(['providerType', 'providerId']);
      t.index('userId');
      t.index(['sourceType', 'sourceId']);
    });
  }

  const inList = (col, values) => `"${col}" IN (${values.map(v => `'${v}'`).join(', ')})`;
  const checks = [
    ['b2b_consumption_status_chk', inList('status', STATUSES)],
    ['b2b_consumption_money_chk',
      `"quantity" > 0 AND "unitValueTzs" >= 0 AND "grossTzs" >= 0 AND "sponsorTzs" >= 0 AND "beneficiaryTzs" >= 0
       AND "sponsorTzs" + "beneficiaryTzs" = "grossTzs"`],
    ['b2b_consumption_day_chk', `"businessDate" ~ ${DAY}`],
    ['b2b_consumption_rejected_chk', `("status" = 'rejected') = ("rejectionReason" IS NOT NULL)`],
    // A rejected attempt covers nothing.
    ['b2b_consumption_rejected_money_chk', `"status" <> 'rejected' OR "sponsorTzs" = 0`],
    ['b2b_consumption_approved_chk', `"status" NOT IN ('approved', 'reversed') OR "verifiedAt" IS NOT NULL`],
    ['b2b_consumption_reversed_chk',
      `("status" = 'reversed') = ("reversedAt" IS NOT NULL) AND ("status" <> 'reversed' OR ("reversedBy" IS NOT NULL AND "reversalReason" IS NOT NULL))`],
  ];
  for (const [name, expr] of checks) {
    await knex.raw('ALTER TABLE "B2BBenefitConsumption" DROP CONSTRAINT IF EXISTS ??', [name]);
    await knex.raw(`ALTER TABLE "B2BBenefitConsumption" ADD CONSTRAINT ?? CHECK (${expr})`, [name]);
  }

  // Idempotency: one usage event is covered by at most one live consumption
  // (so never by two benefits, and never twice by one).
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS b2b_consumption_source_live_uq
    ON "B2BBenefitConsumption" ("sourceType", "sourceId") WHERE "status" IN ('pending', 'approved')`);

  // Money and identity on a ledger row never change after it is written; only
  // its status moves, and only along the lifecycle above.
  await knex.raw(`CREATE OR REPLACE FUNCTION b2b_consumption_guard() RETURNS trigger AS $$
    BEGIN
      IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId" OR NEW."programId" IS DISTINCT FROM OLD."programId"
        OR NEW."benefitId" IS DISTINCT FROM OLD."benefitId" OR NEW."beneficiaryId" IS DISTINCT FROM OLD."beneficiaryId"
        OR NEW."sourceType" IS DISTINCT FROM OLD."sourceType" OR NEW."sourceId" IS DISTINCT FROM OLD."sourceId"
        OR NEW."grossTzs" IS DISTINCT FROM OLD."grossTzs" OR NEW."sponsorTzs" IS DISTINCT FROM OLD."sponsorTzs"
        OR NEW."beneficiaryTzs" IS DISTINCT FROM OLD."beneficiaryTzs" OR NEW."quantity" IS DISTINCT FROM OLD."quantity"
        OR NEW."businessDate" IS DISTINCT FROM OLD."businessDate" THEN
        RAISE EXCEPTION 'B2BBenefitConsumption: recorded values are immutable' USING ERRCODE = 'P0001';
      END IF;
      IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
        (OLD."status" = 'pending' AND NEW."status" IN ('approved', 'cancelled'))
        OR (OLD."status" = 'approved' AND NEW."status" = 'reversed')) THEN
        RAISE EXCEPTION 'B2BBenefitConsumption: % -> % is not allowed', OLD."status", NEW."status" USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END;
  $$ LANGUAGE plpgsql`);
  await knex.raw('DROP TRIGGER IF EXISTS b2b_consumption_guard ON "B2BBenefitConsumption"');
  await knex.raw(`CREATE TRIGGER b2b_consumption_guard BEFORE UPDATE ON "B2BBenefitConsumption"
    FOR EACH ROW EXECUTE FUNCTION b2b_consumption_guard()`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('B2BBenefitConsumption');
  await knex.raw('DROP FUNCTION IF EXISTS b2b_consumption_guard()');
};
