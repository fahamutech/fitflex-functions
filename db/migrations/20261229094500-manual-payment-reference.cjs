// Slice A3: manual mobile-money payment with a member-supplied transaction ID.
//
// - PlatformSettings.manualPayment (jsonb): { lipaNamba, accountName, network, instructions }
//   shown to members on GET /payments/options when MANUAL_PAY_INSTRUCTIONS is on.
// - PaymentRequest.memberReference (text): the transaction ID the member typed. Kept apart
//   from `reference`, which the Tunzaa flow uses for its own state and admins overwrite.
// - One transaction ID pays for one request: unique among requests that are pending or
//   approved. Rejected / cancelled requests release it (the member may submit it again).
//   Every existing row has memberReference NULL, so the index always builds.
//
// Additive and reversible: down drops the index and both columns.

const INDEX = 'paymentrequest_member_reference_unique';

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('PlatformSettings', 'manualPayment'))) {
    await knex.schema.alterTable('PlatformSettings', (t) => t.jsonb('manualPayment'));
  }
  if (!(await knex.schema.hasColumn('PaymentRequest', 'memberReference'))) {
    await knex.schema.alterTable('PaymentRequest', (t) => t.text('memberReference'));
  }
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX} ON "PaymentRequest" ("memberReference")
    WHERE "memberReference" IS NOT NULL AND status IN ('pending', 'approved')`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS ${INDEX}`);
  if (await knex.schema.hasColumn('PaymentRequest', 'memberReference')) {
    await knex.schema.alterTable('PaymentRequest', (t) => t.dropColumn('memberReference'));
  }
  if (await knex.schema.hasColumn('PlatformSettings', 'manualPayment')) {
    await knex.schema.alterTable('PlatformSettings', (t) => t.dropColumn('manualPayment'));
  }
};
