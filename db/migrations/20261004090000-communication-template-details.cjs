// Communication templates (M6): the details a template needs beyond M1's
// columns.
// - group: how templates are grouped for owners to browse — membership,
//   payment, marketing, engagement or general.
// - deepLink: where the message's button takes the member.
// - basedOn: the system template a gym's own template was copied from.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const add = async (col, build) => {
    if (!(await knex.schema.hasColumn('CommunicationTemplate', col))) {
      await knex.schema.alterTable('CommunicationTemplate', build);
    }
  };
  await add('group', (t) => t.text('group').notNullable().defaultTo('general'));
  await add('deepLink', (t) => t.text('deepLink').notNullable().defaultTo('message'));
  await add('basedOn', (t) => t.text('basedOn').references('id').inTable('CommunicationTemplate').onDelete('SET NULL').onUpdate('CASCADE'));
  await knex.raw('CREATE INDEX IF NOT EXISTS communication_template_gym_status_idx ON "CommunicationTemplate" ("gymId", "status")');
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS communication_template_gym_status_idx');
  for (const col of ['basedOn', 'deepLink', 'group']) {
    if (await knex.schema.hasColumn('CommunicationTemplate', col)) {
      await knex.schema.alterTable('CommunicationTemplate', (t) => t.dropColumn(col));
    }
  }
};
