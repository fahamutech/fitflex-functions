// Training Plans: a member's structured programme, and the link from each
// scheduled workout back to it.
//
// A plan owns no workout history of its own. Its sessions are ordinary
// Workout rows (trainingPlanId set), and what the member actually did is
// still the Activity recorded when a workout is completed.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('TrainingPlan'))) {
    await knex.schema.createTable('TrainingPlan', (t) => {
      t.text('id').primary();
      t.text('userId').notNullable().references('id').inTable('User').onDelete('CASCADE').onUpdate('CASCADE');
      t.text('name').notNullable();
      // What it was built from (see src/shared/training-taxonomy.mjs).
      t.text('goal').notNullable();
      t.jsonb('targetAreas').notNullable().defaultTo('[]');
      t.text('experience').notNullable();
      t.text('environment').notNullable();
      t.jsonb('equipment').notNullable().defaultTo('[]');
      t.text('style');
      t.integer('durationWeeks').notNullable();
      t.integer('daysPerWeek').notNullable();
      t.integer('sessionMinutes').notNullable();
      // active | completed | cancelled
      t.text('status').notNullable();
      // member | fitflex | trainer, and who (a trainer profile id later on).
      t.text('createdByType').notNullable();
      t.text('createdById');
      t.text('trainerId').references('id').inTable('TrainerProfile').onDelete('SET NULL').onUpdate('CASCADE');
      // Which recommendation provider produced it ('rules' today).
      t.text('engine');
      // Local calendar days, inclusive.
      t.text('startDate').notNullable();
      t.text('endDate').notNullable();
      // The week-by-week outline: [{ week, days: [{ day, date, focusAreas, workoutId | null }] }]
      t.jsonb('weeks').notNullable().defaultTo('[]');
      t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.index(['userId', 'status']);
    });
  }
  if (!(await knex.schema.hasColumn('Workout', 'trainingPlanId'))) {
    await knex.schema.alterTable('Workout', (t) => {
      // Ending a plan keeps the workouts already done.
      t.text('trainingPlanId').references('id').inTable('TrainingPlan').onDelete('SET NULL').onUpdate('CASCADE');
      t.index('trainingPlanId');
    });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('Workout', 'trainingPlanId')) {
    await knex.schema.alterTable('Workout', (t) => t.dropColumn('trainingPlanId'));
  }
  await knex.schema.dropTableIfExists('TrainingPlan');
};
