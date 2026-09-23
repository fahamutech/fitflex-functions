// Challenge engine: time-boxed challenges from FitFlex, trainers, gyms and
// corporate accounts, and the members taking part. Progress is derived
// from Activity and Checkin rows, so it is not stored.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('Challenge'))) {
    await knex.schema.createTable('Challenge', (t) => {
      t.text('id').primary();
      t.text('name').notNullable();
      t.text('description');
      t.text('type').notNullable();
      t.double('target').notNullable();
      // Calendar dates (YYYY-MM-DD) in members' local time, inclusive.
      t.text('startDate').notNullable();
      t.text('endDate').notNullable();
      t.text('creatorType').notNullable();
      t.text('creatorId');
      t.text('createdBy');
      t.jsonb('rewards').notNullable().defaultTo('[]');
      t.text('visibility').notNullable().defaultTo('audience');
      t.text('status').notNullable().defaultTo('active');
      t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.index(['creatorType', 'creatorId']);
      t.index('endDate');
    });
  }
  if (!(await knex.schema.hasTable('ChallengeParticipant'))) {
    await knex.schema.createTable('ChallengeParticipant', (t) => {
      t.text('id').primary();
      t.text('challengeId').notNullable().references('id').inTable('Challenge').onDelete('CASCADE').onUpdate('CASCADE');
      t.text('memberId').notNullable().references('id').inTable('User').onDelete('CASCADE').onUpdate('CASCADE');
      t.text('status').notNullable().defaultTo('joined');
      t.timestamp('joinedAt', { precision: 3 }).notNullable();
      t.timestamp('leftAt', { precision: 3 });
      t.unique(['challengeId', 'memberId']);
      t.index('memberId');
    });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ChallengeParticipant');
  await knex.schema.dropTableIfExists('Challenge');
};
