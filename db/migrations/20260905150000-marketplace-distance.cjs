/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('Product', 'distanceKm'))) {
    await knex.schema.alterTable('Product', table => {
      table.decimal('distanceKm', 10, 2);
    });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('Product', 'distanceKm')) {
    await knex.schema.alterTable('Product', table => {
      table.dropColumn('distanceKm');
    });
  }
};
