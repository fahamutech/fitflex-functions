// Activity & Progress Engine: fitness activities and member goals.
// An Activity is separate from a Checkin — a gym visit is not a workout, and
// most activity (walks, runs) happens away from any gym. Goal progress is
// derived from Activity rows, so it is not stored here.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('Activity'))) {
    await knex.schema.createTable('Activity', (t) => {
      t.text('id').primary();
      t.text('userId').notNullable().references('id').inTable('User').onDelete('CASCADE').onUpdate('CASCADE');
      t.text('type').notNullable();
      t.text('source').notNullable();
      t.timestamp('startedAt', { precision: 3 }).notNullable();
      t.integer('durationMinutes');
      t.double('distanceKm');
      t.integer('steps');
      t.integer('activeMinutes');
      t.integer('calories');
      t.text('intensity');
      t.text('workoutId');
      t.text('gymId').references('id').inTable('Gym').onDelete('SET NULL').onUpdate('CASCADE');
      t.text('trainerId');
      t.text('notes');
      t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.index(['userId', 'startedAt']);
    });
  }
  if (!(await knex.schema.hasTable('Goal'))) {
    await knex.schema.createTable('Goal', (t) => {
      t.text('id').primary();
      t.text('userId').notNullable().references('id').inTable('User').onDelete('CASCADE').onUpdate('CASCADE');
      t.text('type').notNullable();
      t.text('period').notNullable();
      t.double('target').notNullable();
      // Calendar dates (YYYY-MM-DD) in the member's local time, not instants.
      t.text('startDate').notNullable();
      t.text('endDate');
      t.text('source').notNullable();
      t.text('trainerId');
      t.text('challengeId');
      t.text('status').notNullable().defaultTo('active');
      t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.index(['userId', 'status']);
    });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('Goal');
  await knex.schema.dropTableIfExists('Activity');
};
