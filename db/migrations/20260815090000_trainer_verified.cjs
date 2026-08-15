exports.up = async function up(knex) {
  const exists = await knex.schema.hasColumn('TrainerProfile', 'verified');
  if (!exists) {
    await knex.schema.alterTable('TrainerProfile', (table) => {
      table.boolean('verified').notNullable().defaultTo(false);
    });
  }
};

exports.down = async function down(knex) {
  const exists = await knex.schema.hasColumn('TrainerProfile', 'verified');
  if (exists) {
    await knex.schema.alterTable('TrainerProfile', (table) => {
      table.dropColumn('verified');
    });
  }
};
