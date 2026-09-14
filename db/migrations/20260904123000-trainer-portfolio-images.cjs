/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const hasImages = await knex.schema.hasColumn('TrainerProfile', 'images');
  const hasImageThumbnails = await knex.schema.hasColumn('TrainerProfile', 'imageThumbnails');
  const hasSessionRateCurrency = await knex.schema.hasColumn('TrainerProfile', 'sessionRateCurrency');

  await knex.schema.alterTable('TrainerProfile', (table) => {
    if (!hasImages) table.specificType('images', 'TEXT[]').notNullable().defaultTo('{}');
    if (!hasImageThumbnails) table.specificType('imageThumbnails', 'TEXT[]').notNullable().defaultTo('{}');
    if (!hasSessionRateCurrency) table.text('sessionRateCurrency').notNullable().defaultTo('TZS');
  });

  await knex('TrainerProfile')
    .whereNotNull('photoUrl')
    .whereRaw('cardinality("images") = 0')
    .update({ images: knex.raw('ARRAY["photoUrl"]') });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.alterTable('TrainerProfile', (table) => {
    table.dropColumn('sessionRateCurrency');
    table.dropColumn('imageThumbnails');
    table.dropColumn('images');
  });
};
