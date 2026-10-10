// Moderation & Promotion hardening: the four-eyes rule, also in the database.
// A promotion cannot be approved by the person who created or submitted it; the service has always
// refused it, and now the table does too, so no other code path can record it.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.raw(`ALTER TABLE "Promotion" DROP CONSTRAINT IF EXISTS promotion_four_eyes_chk`);
  await knex.raw(`ALTER TABLE "Promotion" ADD CONSTRAINT promotion_four_eyes_chk CHECK ("approvedBy" IS NULL OR ("approvedBy" <> "createdBy" AND "approvedBy" IS DISTINCT FROM "submittedBy"))`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE "Promotion" DROP CONSTRAINT IF EXISTS promotion_four_eyes_chk`);
};
