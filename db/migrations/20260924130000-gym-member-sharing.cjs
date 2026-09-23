// What a member chooses to share with a gym, beyond the gym's own check-in
// records. One row per member per gym; no row means nothing extra shared.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('GymMemberSharing'))) {
    await knex.schema.createTable('GymMemberSharing', (t) => {
      t.text('id').primary();
      t.text('gymId').notNullable().references('id').inTable('Gym').onDelete('CASCADE').onUpdate('CASCADE');
      t.text('memberId').notNullable().references('id').inTable('User').onDelete('CASCADE').onUpdate('CASCADE');
      t.jsonb('permissions').notNullable().defaultTo('{}');
      t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.unique(['gymId', 'memberId']);
      t.index('memberId');
    });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('GymMemberSharing');
};
