// Workout engine: structured workouts (planned, in progress, completed).
// Exercises and their sets live in a jsonb column — a workout is always
// read and written as a whole, and it keeps a session save atomic.
// Completing a workout records an Activity (Activity.workoutId), which is
// what feeds goals, progress and streaks.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('Workout'))) {
    await knex.schema.createTable('Workout', (t) => {
      t.text('id').primary();
      t.text('userId').notNullable().references('id').inTable('User').onDelete('CASCADE').onUpdate('CASCADE');
      t.text('trainerId');
      t.text('gymId').references('id').inTable('Gym').onDelete('SET NULL').onUpdate('CASCADE');
      t.text('templateId');
      t.text('source').notNullable();
      t.text('name').notNullable();
      t.text('description');
      t.text('activityType').notNullable();
      // Calendar date (YYYY-MM-DD) in the member's local time.
      t.text('scheduledDate').notNullable();
      t.integer('estimatedDuration');
      t.text('status').notNullable().defaultTo('planned');
      t.jsonb('exercises').notNullable().defaultTo('[]');
      t.text('notes');
      t.timestamp('startedAt', { precision: 3 });
      t.timestamp('completedAt', { precision: 3 });
      t.text('activityId');
      t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.index(['userId', 'scheduledDate']);
    });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('Workout');
};
