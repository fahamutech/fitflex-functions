// Trainer ↔ member connections and trainer workout plans.
// A connection starts as the member's request and shares nothing until the
// member switches individual permissions on. Trainers assign workouts only
// to active connections; plans are the trainer's reusable workout library.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('TrainerMemberRelationship'))) {
    await knex.schema.createTable('TrainerMemberRelationship', (t) => {
      t.text('id').primary();
      t.text('trainerId').notNullable().references('id').inTable('TrainerProfile').onDelete('CASCADE').onUpdate('CASCADE');
      t.text('memberId').notNullable().references('id').inTable('User').onDelete('CASCADE').onUpdate('CASCADE');
      // pending → active | declined; active → ended. Pending can be cancelled (ended).
      t.text('status').notNullable();
      t.jsonb('permissions').notNullable().defaultTo('{}');
      t.timestamp('requestedAt', { precision: 3 }).notNullable();
      t.timestamp('connectedAt', { precision: 3 });
      t.timestamp('endedAt', { precision: 3 });
      t.text('endedBy');
      t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.index(['trainerId', 'status']);
      t.index(['memberId', 'status']);
    });
  }
  if (!(await knex.schema.hasTable('WorkoutPlan'))) {
    await knex.schema.createTable('WorkoutPlan', (t) => {
      t.text('id').primary();
      t.text('trainerId').notNullable().references('id').inTable('TrainerProfile').onDelete('CASCADE').onUpdate('CASCADE');
      t.text('name').notNullable();
      t.text('description');
      t.text('activityType').notNullable();
      t.integer('estimatedDuration');
      t.jsonb('exercises').notNullable().defaultTo('[]');
      t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.index('trainerId');
    });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('WorkoutPlan');
  await knex.schema.dropTableIfExists('TrainerMemberRelationship');
};
