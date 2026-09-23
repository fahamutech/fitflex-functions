// Trainer bookings: several slots per booking, Pass discount + commission
// breakdown, and payment through an admin-approved PaymentRequest before the
// booking is confirmed. PaymentRequest can now pay for a booking group
// instead of a subscription.

const BOOKING_COLUMNS = {
  groupId: t => t.text('groupId'),
  currency: t => t.text('currency'),
  listPriceTzs: t => t.integer('listPriceTzs'),
  discountPct: t => t.integer('discountPct'),
  commissionPct: t => t.integer('commissionPct'),
  commissionTzs: t => t.integer('commissionTzs'),
  trainerPayoutTzs: t => t.integer('trainerPayoutTzs'),
  paymentRequestId: t => t.text('paymentRequestId'),
  updatedAt: t => t.timestamp('updatedAt', { precision: 3 }),
};

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  for (const [name, add] of Object.entries(BOOKING_COLUMNS)) {
    if (!(await knex.schema.hasColumn('TrainerBooking', name))) {
      await knex.schema.alterTable('TrainerBooking', add);
    }
  }
  await knex.schema.alterTable('TrainerBooking', t => t.index('groupId'));

  if (!(await knex.schema.hasColumn('PaymentRequest', 'bookingGroupId'))) {
    await knex.schema.alterTable('PaymentRequest', (t) => {
      t.text('bookingGroupId');
      t.text('currency');
    });
  }
  await knex.schema.alterTable('PaymentRequest', t => t.text('subscriptionId').nullable().alter());
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('PaymentRequest', 'bookingGroupId')) {
    await knex('PaymentRequest').whereNotNull('bookingGroupId').del();
    await knex.schema.alterTable('PaymentRequest', (t) => {
      t.dropColumn('bookingGroupId');
      t.dropColumn('currency');
    });
    await knex.schema.alterTable('PaymentRequest', t => t.text('subscriptionId').notNullable().alter());
  }
  for (const name of Object.keys(BOOKING_COLUMNS)) {
    if (await knex.schema.hasColumn('TrainerBooking', name)) {
      await knex.schema.alterTable('TrainerBooking', t => t.dropColumn(name));
    }
  }
};
