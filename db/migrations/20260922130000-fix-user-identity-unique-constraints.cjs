// Repairs the multi-role identity indexes from 20260904130000.
//
// That migration dropped "User_firebaseUid_unique" & friends, but the init
// schema created those constraints through Knex's `.unique()`, which names them
// in lower snake case ("user_firebaseuid_unique"). Quoted identifiers are
// case-sensitive in Postgres, so every DROP ... IF EXISTS silently matched
// nothing and the original single-column constraints survived.
//
// Existing databases where the constraints were cleared by hand are unaffected;
// a database built from scratch still rejects a second profile for the same
// identity. Rather than guess at the naming a given database ended up with,
// this reads pg_catalog and drops whatever single-column unique constraint or
// index is actually there.
const IDENTITY_COLUMNS = ['firebaseUid', 'phone', 'email'];

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  for (const column of IDENTITY_COLUMNS) {
    // Constraint-backed uniqueness (ALTER TABLE ... ADD UNIQUE).
    const { rows: constraints } = await knex.raw(`
      SELECT con.conname AS name
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
       WHERE rel.relname = 'User'
         AND nsp.nspname = current_schema()
         AND con.contype = 'u'
         AND array_length(con.conkey, 1) = 1
         AND con.conkey[1] = (
           SELECT attnum FROM pg_attribute
            WHERE attrelid = rel.oid AND attname = ? AND NOT attisdropped
         )
    `, [column]);
    for (const { name } of constraints) {
      await knex.raw(`ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "${name}"`);
    }

    // Standalone unique indexes, excluding the composite ones we want to keep.
    const { rows: indexes } = await knex.raw(`
      SELECT cls.relname AS name
        FROM pg_index idx
        JOIN pg_class cls ON cls.oid = idx.indexrelid
        JOIN pg_class rel ON rel.oid = idx.indrelid
        JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
       WHERE rel.relname = 'User'
         AND nsp.nspname = current_schema()
         AND idx.indisunique
         AND NOT idx.indisprimary
         AND idx.indnatts = 1
         AND idx.indkey[0] = (
           SELECT attnum FROM pg_attribute
            WHERE attrelid = rel.oid AND attname = ? AND NOT attisdropped
         )
    `, [column]);
    for (const { name } of indexes) {
      await knex.raw(`DROP INDEX IF EXISTS "${name}"`);
    }
  }

  // Re-assert the intended (identity, userType) uniqueness.
  for (const column of IDENTITY_COLUMNS) {
    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS "User_${column}_userType_key"
        ON "User" ("${column}", "userType") WHERE "${column}" IS NOT NULL
    `);
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down() {
  // Intentionally irreversible: restoring single-column uniqueness would fail
  // against any data that now legitimately has one identity across roles.
};
