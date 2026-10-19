// Slice A3: manual mobile-money payment with a member-supplied transaction ID.
//
// - PlatformSettings.manualPayment (jsonb): { lipaNamba, accountName, network, instructions }
//   shown to members on GET /payments/options when MANUAL_PAY_INSTRUCTIONS is on.
// - PaymentRequest.memberReference (text): the transaction ID as the member typed it (upper-cased).
//   Kept apart from `reference`, which the Tunzaa flow uses for its own state and admins write.
// - PaymentRequest.memberReferenceKey (text): the same ID reduced to letters and digits
//   ("QGH7-XK2L9P." → "QGH7XK2L9P"). Duplicates are judged on this key, so punctuation or
//   case cannot make one transaction pay twice. Unique among requests that are pending or
//   approved; rejected / cancelled ones release it. Every existing row has it NULL, so the
//   unique index always builds.
// - PaymentRequest.payerPhone (text): the mobile-money number the member paid from, E.164
//   (+255…). Admin-only: it lets the admin match the sender on the till statement.
// - An expression index on the same key computed from `reference`, so an admin- or
//   provider-entered reference is matched against a member's ID cheaply (not unique: old
//   rows may legitimately repeat, e.g. 'pending:<ms>' placeholders).
//
// Additive and reversible: down drops both indexes and the four columns.

const KEY_INDEX = 'paymentrequest_member_reference_key_unique';
const REF_KEY_INDEX = 'paymentrequest_reference_key_idx';

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('PlatformSettings', 'manualPayment'))) {
    await knex.schema.alterTable('PlatformSettings', (t) => t.jsonb('manualPayment'));
  }
  for (const column of ['memberReference', 'memberReferenceKey', 'payerPhone']) {
    if (!(await knex.schema.hasColumn('PaymentRequest', column))) {
      await knex.schema.alterTable('PaymentRequest', (t) => t.text(column));
    }
  }
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ${KEY_INDEX} ON "PaymentRequest" ("memberReferenceKey")
    WHERE "memberReferenceKey" IS NOT NULL AND status IN ('pending', 'approved')`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ${REF_KEY_INDEX} ON "PaymentRequest"
    ((regexp_replace(upper(reference), '[^A-Z0-9]', '', 'g'))) WHERE reference IS NOT NULL`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS ${REF_KEY_INDEX}`);
  await knex.raw(`DROP INDEX IF EXISTS ${KEY_INDEX}`);
  for (const column of ['payerPhone', 'memberReferenceKey', 'memberReference']) {
    if (await knex.schema.hasColumn('PaymentRequest', column)) {
      await knex.schema.alterTable('PaymentRequest', (t) => t.dropColumn(column));
    }
  }
  if (await knex.schema.hasColumn('PlatformSettings', 'manualPayment')) {
    await knex.schema.alterTable('PlatformSettings', (t) => t.dropColumn('manualPayment'));
  }
};
