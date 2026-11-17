// AzamPay-only payments (security review of functions#360).
//
// PaymentRequest.supersededReferences (nullable jsonb array of text): the transaction ids of
// earlier mobile-money prompts of this request that were given up (failed, or unanswered and
// retried). While a retry is being sent the request's `reference` is only a claim placeholder,
// so without this a late success for the OLD prompt could not be told from the new one's and
// would be approved while a second prompt was still going out. A success that names one of
// these ids is held for staff instead. Additive and reversible: a row without it behaves as before.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('PaymentRequest', 'supersededReferences'))) {
    await knex.schema.alterTable('PaymentRequest', (t) => t.jsonb('supersededReferences'));
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('PaymentRequest', 'supersededReferences')) {
    await knex.schema.alterTable('PaymentRequest', (t) => t.dropColumn('supersededReferences'));
  }
};
