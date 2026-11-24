// AzamPay bank checkout and checkout page (owner request 2026-11-17).
//
// PaymentRequest.checkoutUrl (nullable text): the address of AzamPay's hosted payment page for the attempt
// that is open on this request. It lets a member who closed the page open the SAME page again instead of
// starting a second attempt (and paying twice), and marks the attempt as a page so it is given longer before
// it is given up. Cleared when the attempt ends.
//
// PaymentRequest.bankRejections (nullable integer): how many bank checkouts of this request the bank refused
// (e.g. a wrong one-time password). After a few the bank method is closed for the request, so an OTP cannot be
// guessed by trying again and again.
//
// Additive and reversible: a row without them behaves as before.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('PaymentRequest', 'checkoutUrl'))) {
    await knex.schema.alterTable('PaymentRequest', (t) => t.text('checkoutUrl'));
  }
  if (!(await knex.schema.hasColumn('PaymentRequest', 'bankRejections'))) {
    await knex.schema.alterTable('PaymentRequest', (t) => t.integer('bankRejections'));
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('PaymentRequest', 'checkoutUrl')) {
    await knex.schema.alterTable('PaymentRequest', (t) => t.dropColumn('checkoutUrl'));
  }
  if (await knex.schema.hasColumn('PaymentRequest', 'bankRejections')) {
    await knex.schema.alterTable('PaymentRequest', (t) => t.dropColumn('bankRejections'));
  }
};
