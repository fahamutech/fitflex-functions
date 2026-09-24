// Admin and HR challenge management.
// - Challenge.eligibility: who may see and join, within the creator's
//   audience. null = everyone in it. FitFlex: { kind: 'tiers', tiers: [...] }
//   (members on those passes). Company: { kind: 'departments',
//   departments: [...] } or { kind: 'employees', employeeIds: [...] }.
// - Challenge.rewardFunding: who pays for the rewards (fitflex | company |
//   partner). Rewards themselves stay labels until fulfilment is built.
// - Challenge.status gains 'closed' (ended early) and 'archived' (text
//   column; no schema change).

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const add = [];
  if (!(await knex.schema.hasColumn('Challenge', 'eligibility'))) add.push(t => t.jsonb('eligibility'));
  if (!(await knex.schema.hasColumn('Challenge', 'rewardFunding'))) add.push(t => t.text('rewardFunding'));
  if (add.length) await knex.schema.alterTable('Challenge', (t) => { for (const f of add) f(t); });
  await knex.raw(`
    UPDATE "Challenge" SET "rewardFunding" = CASE "creatorType"
      WHEN 'corporate' THEN 'company' WHEN 'fitflex' THEN 'fitflex' ELSE NULL END
    WHERE "rewardFunding" IS NULL AND "rewards"::text NOT IN ('[]', 'null')
  `);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex('Challenge').where({ status: 'archived' }).update({ status: 'cancelled' });
  // A closed challenge already ends today, so as 'active' it reads as ended.
  await knex('Challenge').where({ status: 'closed' }).update({ status: 'active' });
  for (const c of ['rewardFunding', 'eligibility']) {
    if (await knex.schema.hasColumn('Challenge', c)) {
      await knex.schema.alterTable('Challenge', (t) => t.dropColumn(c));
    }
  }
};
