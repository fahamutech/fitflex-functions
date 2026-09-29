// Check-in integrity for gym settlement (settlement Phase 2, PR 1).
//
// A check-in gets a lifecycle (valid → disputed / flagged / voided), a void
// audit that is kept forever, the member cycle it was validated against
// (subscriptionId: each Platform Pass purchase is its own Subscription row),
// its East Africa Time business day, and how it was recorded (source).
//
// Existing rows: status becomes 'valid' through the column default,
// businessDate is computed from the timestamp, subscriptionId and source stay
// NULL (unknown; historical cycle matching is for shadow-mode review).
// No settlement link here: that lives in the settlement tables (PR 3).

const STATUSES = ['valid', 'voided', 'disputed', 'flagged'];
const SOURCES = ['member_qr_by_staff', 'gym_qr_by_member', 'owner_manual', 'admin_backfill'];
const list = (xs) => xs.map((x) => `'${x}'`).join(', ');

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const cols = {
    status: (t) => t.text('status').notNullable().defaultTo('valid'),
    statusReason: (t) => t.text('statusReason'),
    statusChangedBy: (t) => t.text('statusChangedBy'),
    statusChangedAt: (t) => t.timestamp('statusChangedAt', { precision: 3 }),
    voidedAt: (t) => t.timestamp('voidedAt', { precision: 3 }),
    voidedBy: (t) => t.text('voidedBy'),
    voidReason: (t) => t.text('voidReason'),
    subscriptionId: (t) => t.text('subscriptionId').references('id').inTable('Subscription').onDelete('SET NULL').onUpdate('CASCADE'),
    businessDate: (t) => t.text('businessDate'),
    source: (t) => t.text('source'),
  };
  for (const [name, add] of Object.entries(cols)) {
    if (!(await knex.schema.hasColumn('Checkin', name))) {
      await knex.schema.alterTable('Checkin', add);
    }
  }

  // Existing check-ins: the EAT day of their timestamp (UTC+3, no daylight saving).
  await knex.raw(`UPDATE "Checkin"
    SET "businessDate" = to_char(("timestamp" AT TIME ZONE 'UTC') + interval '3 hours', 'YYYY-MM-DD')
    WHERE "businessDate" IS NULL`);

  await knex.raw(`ALTER TABLE "Checkin" DROP CONSTRAINT IF EXISTS checkin_status_ck`);
  await knex.raw(`ALTER TABLE "Checkin" ADD CONSTRAINT checkin_status_ck CHECK ("status" IN (${list(STATUSES)}))`);
  await knex.raw(`ALTER TABLE "Checkin" DROP CONSTRAINT IF EXISTS checkin_source_ck`);
  await knex.raw(`ALTER TABLE "Checkin" ADD CONSTRAINT checkin_source_ck CHECK ("source" IS NULL OR "source" IN (${list(SOURCES)}))`);
  await knex.raw(`ALTER TABLE "Checkin" DROP CONSTRAINT IF EXISTS checkin_business_date_ck`);
  await knex.raw(`ALTER TABLE "Checkin" ADD CONSTRAINT checkin_business_date_ck CHECK ("businessDate" IS NULL OR "businessDate" ~ '^\\d{4}-\\d{2}-\\d{2}$')`);
  // A held or voided check-in always says why; a voided one also says when.
  await knex.raw(`ALTER TABLE "Checkin" DROP CONSTRAINT IF EXISTS checkin_status_reason_ck`);
  await knex.raw(`ALTER TABLE "Checkin" ADD CONSTRAINT checkin_status_reason_ck CHECK ("status" = 'valid' OR "statusReason" IS NOT NULL)`);
  await knex.raw(`ALTER TABLE "Checkin" DROP CONSTRAINT IF EXISTS checkin_void_audit_ck`);
  await knex.raw(`ALTER TABLE "Checkin" ADD CONSTRAINT checkin_void_audit_ck CHECK ("status" <> 'voided' OR ("voidedAt" IS NOT NULL AND "voidReason" IS NOT NULL))`);

  // VOIDED is final (DR-14) and its audit can't be rewritten: enforced here,
  // not only in the service, so no code path can revive a voided visit.
  await knex.raw(`CREATE OR REPLACE FUNCTION checkin_void_is_final() RETURNS trigger AS $$
    BEGIN
      IF OLD."status" = 'voided' AND (
           NEW."status" IS DISTINCT FROM OLD."status"
        OR NEW."voidedAt" IS DISTINCT FROM OLD."voidedAt"
        OR NEW."voidedBy" IS DISTINCT FROM OLD."voidedBy"
        OR NEW."voidReason" IS DISTINCT FROM OLD."voidReason") THEN
        RAISE EXCEPTION 'A voided check-in is final' USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await knex.raw(`DROP TRIGGER IF EXISTS checkin_void_is_final ON "Checkin"`);
  await knex.raw(`CREATE TRIGGER checkin_void_is_final BEFORE UPDATE ON "Checkin"
    FOR EACH ROW EXECUTE FUNCTION checkin_void_is_final()`);

  // (memberId, timestamp) and (gymId, timestamp) already exist (init schema).
  await knex.raw(`CREATE INDEX IF NOT EXISTS checkin_subscription_idx ON "Checkin" ("subscriptionId")`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS checkin_member_business_date_idx ON "Checkin" ("memberId", "businessDate")`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS checkin_not_valid_idx ON "Checkin" ("status") WHERE "status" <> 'valid'`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS checkin_void_is_final ON "Checkin"`);
  await knex.raw(`DROP FUNCTION IF EXISTS checkin_void_is_final()`);
  await knex.raw(`DROP INDEX IF EXISTS checkin_subscription_idx`);
  await knex.raw(`DROP INDEX IF EXISTS checkin_member_business_date_idx`);
  await knex.raw(`DROP INDEX IF EXISTS checkin_not_valid_idx`);
  for (const ck of ['checkin_status_ck', 'checkin_source_ck', 'checkin_business_date_ck', 'checkin_status_reason_ck', 'checkin_void_audit_ck']) {
    await knex.raw(`ALTER TABLE "Checkin" DROP CONSTRAINT IF EXISTS ${ck}`);
  }
  for (const name of ['status', 'statusReason', 'statusChangedBy', 'statusChangedAt', 'voidedAt', 'voidedBy', 'voidReason', 'subscriptionId', 'businessDate', 'source']) {
    if (await knex.schema.hasColumn('Checkin', name)) {
      await knex.schema.alterTable('Checkin', (t) => t.dropColumn(name));
    }
  }
};
