// Voiding a gym statement needs two people (DR-09 applied to voids): one
// asks for it with a reason, a different one confirms. The request is kept on
// the statement; the database refuses a void that nobody else asked for.
//
// Statements voided before this change keep no request and are left as they
// are.

const COLUMNS = {
  voidRequestedBy: (t) => t.text('voidRequestedBy'),
  voidRequestedAt: (t) => t.timestamp('voidRequestedAt', { precision: 3 }),
  voidRequestReason: (t) => t.text('voidRequestReason'),
};

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  for (const [name, add] of Object.entries(COLUMNS)) {
    if (!(await knex.schema.hasColumn('GymSettlement', name))) await knex.schema.alterTable('GymSettlement', add);
  }
  await knex.raw(`ALTER TABLE "GymSettlement" DROP CONSTRAINT IF EXISTS gym_settlement_void_request_ck`);
  await knex.raw(`ALTER TABLE "GymSettlement" ADD CONSTRAINT gym_settlement_void_request_ck CHECK (
    ("voidRequestedBy" IS NULL) = ("voidRequestedAt" IS NULL) AND ("voidRequestedBy" IS NULL) = ("voidRequestReason" IS NULL)
    AND ("voidRequestedBy" IS NULL OR "voidedBy" IS NULL OR "voidedBy" <> "voidRequestedBy"))`);
  await knex.raw(`CREATE OR REPLACE FUNCTION gym_settlement_void_guard() RETURNS trigger AS $$
    BEGIN
      IF NEW."status" = 'voided' AND OLD."status" <> 'voided' AND NEW."voidRequestedBy" IS NULL THEN
        RAISE EXCEPTION 'GymSettlement: a void has to be requested by one person and confirmed by another' USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await knex.raw(`DROP TRIGGER IF EXISTS gym_settlement_void_guard ON "GymSettlement"`);
  await knex.raw(`CREATE TRIGGER gym_settlement_void_guard BEFORE UPDATE ON "GymSettlement" FOR EACH ROW EXECUTE FUNCTION gym_settlement_void_guard()`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS gym_settlement_void_guard ON "GymSettlement"`);
  await knex.raw(`DROP FUNCTION IF EXISTS gym_settlement_void_guard()`);
  await knex.raw(`ALTER TABLE "GymSettlement" DROP CONSTRAINT IF EXISTS gym_settlement_void_request_ck`);
  for (const name of Object.keys(COLUMNS)) {
    if (await knex.schema.hasColumn('GymSettlement', name)) await knex.schema.alterTable('GymSettlement', (t) => t.dropColumn(name));
  }
};
