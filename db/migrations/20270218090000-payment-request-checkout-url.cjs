// AzamPay bank checkout and checkout page (owner request 2026-11-17).
//
// PaymentRequest.checkoutUrl (nullable text): the address of AzamPay's hosted payment page for the attempt
// that is open on this request. It lets a member who closed the page open the SAME page again instead of
// starting a second attempt (and paying twice), and marks the attempt as a page so it is given longer before
// it is given up. Cleared when the attempt ends. Additive and reversible: a row without it behaves as before.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('PaymentRequest', 'checkoutUrl'))) {
    await knex.schema.alterTable('PaymentRequest', (t) => t.text('checkoutUrl'));
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('PaymentRequest', 'checkoutUrl')) {
    await knex.schema.alterTable('PaymentRequest', (t) => t.dropColumn('checkoutUrl'));
  }
};
