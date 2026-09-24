// Challenge rewards: what a challenge offers, and what each member earned.
// - Challenge.rewardItems: structured rewards, up to 5 —
//   { id, type, label, value, rule: finishers | top | team, topN }.
//   Challenge.rewards stays as the list of labels so older app builds keep
//   showing them. Existing labels are backfilled as type 'other', earned by
//   every finisher.
// - Challenge.rewardsSettledAt: set once the challenge has ended and its
//   top-N and winning-team rewards have been decided; nothing is earned
//   after that.
// - ChallengeReward: one row per member per reward earned. Earned is not
//   handed out: status runs pending → approved → issued (or rejected, which
//   can be reopened), and every change is kept in `history`.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const add = [];
  if (!(await knex.schema.hasColumn('Challenge', 'rewardItems'))) add.push(t => t.jsonb('rewardItems'));
  if (!(await knex.schema.hasColumn('Challenge', 'rewardsSettledAt'))) add.push(t => t.timestamp('rewardsSettledAt', { precision: 3 }));
  if (add.length) await knex.schema.alterTable('Challenge', (t) => { for (const f of add) f(t); });

  const rows = await knex('Challenge').select('id', 'rewards').whereNull('rewardItems');
  for (const r of rows) {
    const labels = Array.isArray(r.rewards) ? r.rewards : [];
    const items = labels.filter(l => typeof l === 'string' && l.trim()).map((label, i) => ({
      id: `rwd_${r.id.slice(-6)}${i + 1}`, type: 'other', label: label.trim(), value: null, rule: 'finishers', topN: null,
    }));
    await knex('Challenge').where({ id: r.id }).update({ rewardItems: JSON.stringify(items) });
  }

  if (!(await knex.schema.hasTable('ChallengeReward'))) {
    await knex.schema.createTable('ChallengeReward', (t) => {
      t.text('id').primary();
      t.text('challengeId').notNullable().references('id').inTable('Challenge').onDelete('CASCADE').onUpdate('CASCADE');
      t.text('rewardId').notNullable();
      t.text('memberId').notNullable().references('id').inTable('User').onDelete('CASCADE').onUpdate('CASCADE');
      // Who runs and who pays, copied from the challenge when earned.
      t.text('creatorType').notNullable();
      t.text('creatorId');
      t.text('funder');
      // The reward as it was offered when earned.
      t.text('type').notNullable();
      t.text('label').notNullable();
      t.text('value');
      t.text('rule').notNullable();
      t.integer('rank');
      t.text('teamId');
      t.text('status').notNullable().defaultTo('pending');
      t.timestamp('earnedAt', { precision: 3 }).notNullable();
      t.text('reference');
      t.text('note');
      t.text('decidedBy');
      t.timestamp('decidedAt', { precision: 3 });
      t.text('issuedBy');
      t.timestamp('issuedAt', { precision: 3 });
      t.jsonb('history').notNullable().defaultTo('[]');
      t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.unique(['challengeId', 'rewardId', 'memberId']);
      t.index('memberId');
      t.index(['status', 'funder']);
      t.index(['creatorType', 'creatorId']);
    });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ChallengeReward');
  for (const c of ['rewardsSettledAt', 'rewardItems']) {
    if (await knex.schema.hasColumn('Challenge', c)) {
      await knex.schema.alterTable('Challenge', (t) => t.dropColumn(c));
    }
  }
};
