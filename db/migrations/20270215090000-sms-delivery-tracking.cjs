// SMS delivery tracking: what the provider later reports about an SMS it
// accepted. `status` on SmsLog stays "accepted" (the provider took it);
// these say whether it reached the phone.
//   deliveryStatus    null (not asked yet) | delivered | undelivered | pending | unknown
//   deliveryCheckedAt when the provider was last asked
//   deliveryChecks    how often, so a message the provider never reports on is let go

const COLUMNS = {
  deliveryStatus: (t) => t.text('deliveryStatus'),
  deliveryCheckedAt: (t) => t.timestamp('deliveryCheckedAt', { precision: 3 }),
  deliveryChecks: (t) => t.integer('deliveryChecks').notNullable().defaultTo(0),
};

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  for (const [col, add] of Object.entries(COLUMNS)) {
    if (!(await knex.schema.hasColumn('SmsLog', col))) await knex.schema.alterTable('SmsLog', add);
  }
  await knex.raw('CREATE INDEX IF NOT EXISTS "SmsLog_deliveryStatus_createdAt_idx" ON "SmsLog" ("deliveryStatus", "createdAt")');
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS "SmsLog_deliveryStatus_createdAt_idx"');
  for (const col of Object.keys(COLUMNS)) {
    if (await knex.schema.hasColumn('SmsLog', col)) await knex.schema.alterTable('SmsLog', (t) => t.dropColumn(col));
  }
};
