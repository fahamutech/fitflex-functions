/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('TrainerSession', 'locationType'))) {
    await knex.schema.alterTable('TrainerSession', (table) => {
      table.text('locationType').notNullable().defaultTo('my_gym');
      table.text('locationLabel');
    });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('TrainerSession', 'locationType')) {
    await knex.schema.alterTable('TrainerSession', (table) => {
      table.dropColumn('locationLabel');
      table.dropColumn('locationType');
    });
  }
};
