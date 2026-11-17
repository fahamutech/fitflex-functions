// AzamPay-only payments (owner decision 2026-11-17).
//
// PaymentRequest.promptedAt (nullable): when the mobile-money prompt whose
// transaction id is in `reference` was sent. AzamPay has no status query for
// collections, so a prompt whose callback never arrives would stay "in flight"
// for ever; with this the prompt is given up after a while and the member may
// ask for a new one (see src/shared/mobile-money-claim.mjs, PROMPT_TTL_MS).
// Additive and reversible: a row without it behaves exactly as before.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('PaymentRequest', 'promptedAt'))) {
    await knex.schema.alterTable('PaymentRequest', (t) => t.timestamp('promptedAt', { precision: 3 }));
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('PaymentRequest', 'promptedAt')) {
    await knex.schema.alterTable('PaymentRequest', (t) => t.dropColumn('promptedAt'));
  }
};
