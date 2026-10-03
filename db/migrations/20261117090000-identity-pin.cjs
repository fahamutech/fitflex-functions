// Identity V2 · I7a — FitFlex keeps the PIN.
//
//   Person.pinHash            the person's PIN, stored only as a slow hash of
//                             a keyed digest (the key is on the server, not
//                             in the database)
//   Person.pinSetAt           when it was last set
//   Person.pinFailedCount     wrong PINs in a row (drives the lockout)
//   Person.pinLockedUntil     sign-in is paused until then
//   Person.sessionsValidAfter sessions issued before this are no longer
//                             accepted (set when a PIN is reset or changed)
//   AuthAttempt               one row per PIN sign-in attempt: what the limits
//                             per identifier and per address count. Stores a
//                             hash of the identifier, never the identifier or
//                             the PIN.
//
// Additive; nothing reads these unless IDENTITY_V2 + V2_PIN_LOGIN are on.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.schema.alterTable('Person', t => {
    t.text('pinHash');
    t.timestamp('pinSetAt', { useTz: true });
    t.integer('pinFailedCount').notNullable().defaultTo(0);
    t.timestamp('pinLockedUntil', { useTz: true });
    t.timestamp('sessionsValidAfter', { useTz: true });
  });
  await knex.schema.createTable('AuthAttempt', t => {
    t.text('id').primary();
    t.text('kind').notNullable();
    t.text('identifierHash').notNullable();
    t.text('ip');
    t.text('personId');
    t.text('outcome').notNullable();
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['identifierHash', 'createdAt']);
    t.index(['ip', 'createdAt']);
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('AuthAttempt');
  await knex.schema.alterTable('Person', t => {
    t.dropColumn('pinHash');
    t.dropColumn('pinSetAt');
    t.dropColumn('pinFailedCount');
    t.dropColumn('pinLockedUntil');
    t.dropColumn('sessionsValidAfter');
  });
};
