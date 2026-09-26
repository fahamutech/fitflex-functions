// Trainer interface: Instagram / Facebook / X handles on the trainer profile,
// stored as bare handles — { instagram?, facebook?, twitter? }.
// (Gym.trainerPass is already jsonb, so the daily/weekly/monthly options need
// no schema change.)

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('TrainerProfile', 'socialLinks'))) {
    await knex.schema.alterTable('TrainerProfile', (table) => {
      table.jsonb('socialLinks').notNullable().defaultTo('{}');
    });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('TrainerProfile', 'socialLinks')) {
    await knex.schema.alterTable('TrainerProfile', (table) => {
      table.dropColumn('socialLinks');
    });
  }
};
