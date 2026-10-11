// Voiding a trainer or vendor statement needs two people, like a gym
// statement: one asks for it with a reason, a different one confirms. The
// request is kept on the statement; the database refuses a void that nobody
// else asked for. Statements voided before this change are left as they are.

const TABLES = { TrainerSettlement: 'trainer_settlement', VendorSettlement: 'vendor_settlement' };
const COLUMNS = {
  voidRequestedBy: (t) => t.text('voidRequestedBy'),
  voidRequestedAt: (t) => t.timestamp('voidRequestedAt', { precision: 3 }),
  voidRequestReason: (t) => t.text('voidRequestReason'),
};

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  for (const [table, prefix] of Object.entries(TABLES)) {
    for (const [name, add] of Object.entries(COLUMNS)) {
      if (!(await knex.schema.hasColumn(table, name))) await knex.schema.alterTable(table, add);
    }
    await knex.raw(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS ${prefix}_void_request_ck`);
    await knex.raw(`ALTER TABLE "${table}" ADD CONSTRAINT ${prefix}_void_request_ck CHECK (
      ("voidRequestedBy" IS NULL) = ("voidRequestedAt" IS NULL) AND ("voidRequestedBy" IS NULL) = ("voidRequestReason" IS NULL)
      AND ("voidRequestedBy" IS NULL OR "voidedBy" IS NULL OR "voidedBy" <> "voidRequestedBy"))`);
    await knex.raw(`CREATE OR REPLACE FUNCTION ${prefix}_void_guard() RETURNS trigger AS $$
      BEGIN
        IF NEW."status" = 'voided' AND OLD."status" <> 'voided' AND NEW."voidRequestedBy" IS NULL THEN
          RAISE EXCEPTION '${table}: a void has to be requested by one person and confirmed by another' USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await knex.raw(`DROP TRIGGER IF EXISTS ${prefix}_void_guard ON "${table}"`);
    await knex.raw(`CREATE TRIGGER ${prefix}_void_guard BEFORE UPDATE ON "${table}" FOR EACH ROW EXECUTE FUNCTION ${prefix}_void_guard()`);
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  for (const [table, prefix] of Object.entries(TABLES)) {
    await knex.raw(`DROP TRIGGER IF EXISTS ${prefix}_void_guard ON "${table}"`);
    await knex.raw(`DROP FUNCTION IF EXISTS ${prefix}_void_guard()`);
    await knex.raw(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS ${prefix}_void_request_ck`);
    for (const name of Object.keys(COLUMNS)) {
      if (await knex.schema.hasColumn(table, name)) await knex.schema.alterTable(table, (t) => t.dropColumn(name));
    }
  }
};
