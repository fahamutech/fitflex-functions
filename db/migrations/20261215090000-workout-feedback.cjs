// How a finished workout felt (too easy, just right, too hard), kept on the
// workout so the next training plan can take it into account. What got in
// the way of a single exercise lives with that exercise, inside `exercises`.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('Workout', 'feedback'))) {
    await knex.schema.alterTable('Workout', (t) => {
      // { rating, at } or null.
      t.jsonb('feedback');
    });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('Workout', 'feedback')) {
    await knex.schema.alterTable('Workout', (t) => t.dropColumn('feedback'));
  }
};
