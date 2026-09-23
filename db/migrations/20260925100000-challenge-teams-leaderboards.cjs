// Challenge teams and opt-in leaderboards.
// - Challenge.mode: individual | teams (creator-named teams) | gym_vs_gym
//   (team = the member's gym) | department (company challenges; team =
//   the employee's department).
// - ChallengeParticipant.leaderboardOptIn: off unless the member chooses
//   to appear in the ranking.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('Challenge', 'mode'))) {
    await knex.schema.alterTable('Challenge', (t) => {
      t.text('mode').notNullable().defaultTo('individual');
    });
  }
  if (!(await knex.schema.hasTable('ChallengeTeam'))) {
    await knex.schema.createTable('ChallengeTeam', (t) => {
      t.text('id').primary();
      t.text('challengeId').notNullable().references('id').inTable('Challenge').onDelete('CASCADE').onUpdate('CASCADE');
      t.text('name').notNullable();
      // Set for gym_vs_gym / department teams, which are created on demand.
      t.text('gymId');
      t.text('department');
      t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.index('challengeId');
    });
  }
  const hasTeam = await knex.schema.hasColumn('ChallengeParticipant', 'teamId');
  const hasOptIn = await knex.schema.hasColumn('ChallengeParticipant', 'leaderboardOptIn');
  if (!hasTeam || !hasOptIn) {
    await knex.schema.alterTable('ChallengeParticipant', (t) => {
      if (!hasTeam) t.text('teamId').references('id').inTable('ChallengeTeam').onDelete('SET NULL');
      if (!hasOptIn) t.boolean('leaderboardOptIn').notNullable().defaultTo(false);
    });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.alterTable('ChallengeParticipant', (t) => {
    t.dropColumn('leaderboardOptIn');
    t.dropColumn('teamId');
  });
  await knex.schema.dropTableIfExists('ChallengeTeam');
  await knex.schema.alterTable('Challenge', (t) => t.dropColumn('mode'));
};
