// Lifecycle automations (M9): what the engine needs beyond M1's tables.
// - CommunicationAutomation.pausedReason: why the engine paused an
//   automation by itself (e.g. it would have messaged too many members at
//   once); cleared when the owner turns it back on.
// - CommunicationAutomation.lastRunAt / updatedBy: when it last fired, who
//   last changed it.
// - AutomationRun.subscriptionId / context: what the firing was about (the
//   membership, the failed payment's amount…), for the history and for
//   rendering the message.
// - An index for the "one automation message per member per day" guard.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const add = async (table, col, build) => {
    if (!(await knex.schema.hasColumn(table, col))) await knex.schema.alterTable(table, build);
  };
  await add('CommunicationAutomation', 'pausedReason', (t) => t.text('pausedReason'));
  await add('CommunicationAutomation', 'lastRunAt', (t) => t.timestamp('lastRunAt', { useTz: true }));
  await add('CommunicationAutomation', 'updatedBy', (t) => t.text('updatedBy').references('id').inTable('User').onDelete('SET NULL').onUpdate('CASCADE'));
  await add('AutomationRun', 'subscriptionId', (t) => t.text('subscriptionId').references('id').inTable('Subscription').onDelete('SET NULL').onUpdate('CASCADE'));
  await add('AutomationRun', 'context', (t) => t.jsonb('context'));
  await knex.raw('CREATE INDEX IF NOT EXISTS automation_run_member_day_idx ON "AutomationRun" ("gymId", "memberId", "createdAt")');
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS automation_run_member_day_idx');
  const drop = async (table, col) => {
    if (await knex.schema.hasColumn(table, col)) await knex.schema.alterTable(table, (t) => t.dropColumn(col));
  };
  await drop('AutomationRun', 'context');
  await drop('AutomationRun', 'subscriptionId');
  await drop('CommunicationAutomation', 'updatedBy');
  await drop('CommunicationAutomation', 'lastRunAt');
  await drop('CommunicationAutomation', 'pausedReason');
};
