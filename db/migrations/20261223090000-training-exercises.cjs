// FitFlex's own changes to the exercise library: exercises staff add in the
// admin portal, and their versions of the built-in ones. The library that
// ships in code stays the starting point; these rows are laid over it.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('TrainingExercise')) return;
  await knex.schema.createTable('TrainingExercise', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.text('description');
    t.text('category').notNullable();
    t.jsonb('targetAreas').notNullable().defaultTo('[]');
    t.jsonb('secondaryAreas').notNullable().defaultTo('[]');
    t.text('movementPattern');
    t.text('difficulty').notNullable();
    t.jsonb('equipment').notNullable().defaultTo('[]');
    t.jsonb('environment').notNullable().defaultTo('[]');
    t.jsonb('suitableGoals').notNullable().defaultTo('[]');
    t.integer('defaultSets').notNullable();
    t.integer('defaultReps');
    t.integer('defaultDuration');
    t.integer('restSeconds').notNullable().defaultTo(60);
    t.boolean('tracksWeight').notNullable().defaultTo(false);
    t.jsonb('instructions').notNullable().defaultTo('[]');
    t.jsonb('alternatives').notNullable().defaultTo('[]');
    t.boolean('active').notNullable().defaultTo(true);
    // { sw: { name, description, instructions } }
    t.jsonb('i18n');
    t.text('updatedBy');
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('TrainingExercise');
};
