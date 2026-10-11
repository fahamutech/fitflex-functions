// A trainer's note to their client on a plan they made for them.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('TrainingPlan', 'note'))) {
    await knex.schema.alterTable('TrainingPlan', (t) => {
      t.text('note');
    });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('TrainingPlan', 'note')) {
    await knex.schema.alterTable('TrainingPlan', (t) => t.dropColumn('note'));
  }
};
