/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  for (const name of [
    'User_firebaseUid_unique', 'User_phone_unique', 'User_email_unique',
    'User_firebaseUid_key', 'User_phone_key', 'User_email_key',
  ]) {
    await knex.raw(`ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "${name}"`);
    await knex.raw(`DROP INDEX IF EXISTS "${name}"`);
  }

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS "User_firebaseUid_userType_key"
      ON "User" ("firebaseUid", "userType") WHERE "firebaseUid" IS NOT NULL
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS "User_phone_userType_key"
      ON "User" ("phone", "userType") WHERE "phone" IS NOT NULL
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS "User_email_userType_key"
      ON "User" ("email", "userType") WHERE "email" IS NOT NULL
  `);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS "User_firebaseUid_userType_key"');
  await knex.raw('DROP INDEX IF EXISTS "User_phone_userType_key"');
  await knex.raw('DROP INDEX IF EXISTS "User_email_userType_key"');
  await knex.raw('CREATE UNIQUE INDEX IF NOT EXISTS "User_firebaseUid_key" ON "User" ("firebaseUid") WHERE "firebaseUid" IS NOT NULL');
  await knex.raw('CREATE UNIQUE INDEX IF NOT EXISTS "User_phone_key" ON "User" ("phone") WHERE "phone" IS NOT NULL');
  await knex.raw('CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User" ("email") WHERE "email" IS NOT NULL');
};
