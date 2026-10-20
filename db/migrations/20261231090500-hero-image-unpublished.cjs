// Admin-managed app photos: remember takedowns (PR #216 re-review).
//
// HeroImage.unpublishedInPublication = id of the snapshot made by the photo's latest unpublish.
// Rollback refuses any older snapshot that holds the photo (409 image_unpublished), so a takedown
// cannot be undone by restoring an earlier snapshot. Null = never unpublished.
//
// Dormant behind HERO_IMAGES_CMS. Additive and reversible: down drops the column.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('HeroImage'))) return;
  if (await knex.schema.hasColumn('HeroImage', 'unpublishedInPublication')) return;
  await knex.schema.alterTable('HeroImage', (t) => {
    t.bigInteger('unpublishedInPublication').references('id').inTable('HeroPublication');
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('HeroImage'))) return;
  if (!(await knex.schema.hasColumn('HeroImage', 'unpublishedInPublication'))) return;
  await knex.schema.alterTable('HeroImage', (t) => { t.dropColumn('unpublishedInPublication'); });
};
