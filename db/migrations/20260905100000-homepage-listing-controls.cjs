/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  for (const tableName of ['Gym', 'TrainerProfile', 'Product']) {
    if (!(await knex.schema.hasColumn(tableName, 'homepageVisible'))) {
      await knex.schema.alterTable(tableName, (table) => {
        table.boolean('homepageVisible').notNullable().defaultTo(true);
        table.integer('homepagePriority').notNullable().defaultTo(0);
      });
    }
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  for (const tableName of ['Product', 'TrainerProfile', 'Gym']) {
    if (await knex.schema.hasColumn(tableName, 'homepageVisible')) {
      await knex.schema.alterTable(tableName, (table) => {
        table.dropColumn('homepageVisible');
        table.dropColumn('homepagePriority');
      });
    }
  }
};
