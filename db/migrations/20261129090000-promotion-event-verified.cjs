// Promotion analytics: events that proved they were served are "verified" and the only ones counted.
// An event without a valid token (an older app build, or a forgery) is kept but not counted.
// Rows recorded by the server itself (paid orders) are verified by nature; client events recorded
// before this change cannot be proven, so they are not counted.
//
// Additive only.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('PromotionEvent', 'verified'))) {
    await knex.schema.alterTable('PromotionEvent', (t) => { t.boolean('verified').notNullable().defaultTo(false); });
    await knex.raw(`UPDATE "PromotionEvent" SET "verified" = true WHERE "source" = 'server'`);
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('PromotionEvent', 'verified')) await knex.schema.alterTable('PromotionEvent', (t) => { t.dropColumn('verified'); });
};
