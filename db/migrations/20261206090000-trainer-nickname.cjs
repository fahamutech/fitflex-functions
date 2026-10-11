// A trainer may choose the name clients see (a nickname or the name they are
// known by). `displayName` stays the name shown everywhere; `fullName` keeps
// the trainer's own name and `nickname` the optional chosen one, so that
// displayName = nickname or, without one, fullName.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const cols = {
    fullName: (t) => t.text('fullName'),
    nickname: (t) => t.text('nickname'),
  };
  for (const [name, add] of Object.entries(cols)) {
    if (!(await knex.schema.hasColumn('TrainerProfile', name))) await knex.schema.alterTable('TrainerProfile', add);
  }
  await knex('TrainerProfile').whereNull('fullName').update({ fullName: knex.ref('displayName') });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  // Give every trainer their own name back before the columns go.
  if (await knex.schema.hasColumn('TrainerProfile', 'fullName')) {
    await knex('TrainerProfile').whereNotNull('fullName').update({ displayName: knex.ref('fullName') });
  }
  for (const name of ['fullName', 'nickname']) {
    if (await knex.schema.hasColumn('TrainerProfile', name)) await knex.schema.alterTable('TrainerProfile', (t) => t.dropColumn(name));
  }
};
