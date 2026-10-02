// Refunds and cancellations.
//
// - Refund: money FitFlex owes back to a payer, for a trainer session that was
//   cancelled in time, a shop order cancelled before dispatch, or a pass or
//   plan payment taken in error. A refund is requested (or raised by a
//   cancellation), approved or rejected, then recorded as paid with the
//   payment reference. At most one live refund per booking, order or payment.
// - TrainerBooking remembers who cancelled a session and when.

const KINDS = ['subscription', 'trainer_booking', 'shop_order'];
const STATUSES = ['requested', 'approved', 'paid', 'rejected'];
const inList = (col, values) => `"${col}" IN (${values.map(v => `'${v}'`).join(', ')})`;

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('Refund'))) {
    await knex.schema.createTable('Refund', (t) => {
      t.text('id').primary();
      t.text('memberId').notNullable().references('id').inTable('User').onDelete('CASCADE');
      t.text('kind').notNullable();
      t.text('subscriptionId');
      t.text('bookingId');
      t.text('orderId');
      t.text('paymentRequestId');
      t.integer('amountTzs').notNullable();
      t.text('currency').notNullable().defaultTo('TZS');
      t.text('reasonCode').notNullable();
      t.text('note');
      t.text('status').notNullable().defaultTo('requested');
      t.text('requestedBy');
      t.text('requestedRole');
      t.text('decidedBy');
      t.timestamp('decidedAt', { precision: 3 });
      t.text('decisionNote');
      t.text('paidBy');
      t.timestamp('paidAt', { precision: 3 });
      t.text('paymentReference');
      t.text('paidTo');
      t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
      t.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
      t.index(['memberId']);
      t.index(['status']);
    });
    await knex.raw(`ALTER TABLE "Refund" ADD CONSTRAINT refund_ck CHECK (
      "amountTzs" > 0 AND ${inList('kind', KINDS)} AND ${inList('status', STATUSES)}
      AND ("status" <> 'paid' OR ("paidAt" IS NOT NULL AND "paymentReference" IS NOT NULL))
      AND ("status" <> 'rejected' OR "decisionNote" IS NOT NULL))`);
    // One live refund per thing being refunded; a rejected one can be asked for again.
    for (const col of ['bookingId', 'orderId', 'paymentRequestId']) {
      await knex.raw(`CREATE UNIQUE INDEX refund_live_${col.toLowerCase()}_ux ON "Refund" ("${col}")
        WHERE "${col}" IS NOT NULL AND "status" <> 'rejected' AND "kind" = '${col === 'bookingId' ? 'trainer_booking' : col === 'orderId' ? 'shop_order' : 'subscription'}'`);
    }
  }
  for (const col of ['cancelledAt', 'cancelledBy']) {
    if (!(await knex.schema.hasColumn('TrainerBooking', col))) {
      await knex.schema.alterTable('TrainerBooking', (t) => (col === 'cancelledAt'
        ? t.timestamp('cancelledAt', { precision: 3 }) : t.text('cancelledBy')));
    }
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  for (const col of ['cancelledAt', 'cancelledBy']) {
    if (await knex.schema.hasColumn('TrainerBooking', col)) {
      await knex.schema.alterTable('TrainerBooking', t => t.dropColumn(col));
    }
  }
  await knex.schema.dropTableIfExists('Refund');
};
