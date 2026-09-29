// Marketplace orders are paid through an admin-approved PaymentRequest, like
// passes and trainer bookings, instead of being marked paid on the app's word.
// Orders placed before this keep the payment status they have.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('PaymentRequest', 'orderId'))) {
    await knex.schema.alterTable('PaymentRequest', (t) => {
      t.text('orderId');
      t.index('orderId');
    });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('PaymentRequest', 'orderId')) {
    await knex('PaymentRequest').whereNotNull('orderId').del();
    await knex.schema.alterTable('PaymentRequest', t => t.dropColumn('orderId'));
  }
};
