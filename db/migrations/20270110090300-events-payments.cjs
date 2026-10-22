// Marathon & running events · S1 (foundation) — payment attempts for event orders.
// Design: PRD §9 (payment attempt state machine, payment safety rules); D1 (launch on the labelled manual
// confirmation path through the existing PaymentRequest; Tunzaa extension behind its own flag later); D4.
//
// - EventPayment: one attempt to pay one EventOrder. An order may have several attempts; the store makes
//   sure only one succeeds (S4). provider names the adapter ('manual', 'tunzaa' …); providerTransactionId
//   is the provider's own id, unique per provider when present (a duplicate callback cannot make a second
//   row); merchantReference is the reference FitFlex gave the provider, unique. amountTzs/currency are
//   what the provider confirmed — compared to the order, never taken from the client. status created →
//   pending → succeeded | failed | cancelled | expired | reconciliation_required (provider timeout: query,
//   never assume), succeeded → reversed. rawRedacted keeps the provider payload with secrets removed, only
//   when needed. paymentRequestId links the existing admin-confirmed PaymentRequest when the manual path
//   is used.
// - PaymentRequest.eventOrderId (nullable, indexed): the existing manual-payment table learns which event
//   order a request pays for, the way orderId does for shop orders. Nothing about existing rows changes;
//   src/shared/payment-product.mjs is not changed in S1 (S4 adds the EVENT_ORDER product type).
//   Rule 6 callout: a new nullable column on a payments table.
// - The Refund table is NOT touched in S1 (S4 decides between Refund.kind = 'event_order' and a table).
//
// Dormant: no route reads these (EVENTS_MODULE off). Down drops EventPayment and the column (rows that
// point at an event order are deleted first, as 20261025090000-shop-order-payments.cjs does for orderId).

const PAYMENT_STATUSES = ['created', 'pending', 'succeeded', 'failed', 'cancelled', 'expired', 'reversed', 'reconciliation_required'];
const list = values => values.map(v => `'${v}'`).join(', ');

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.schema.createTable('EventPayment', (t) => {
    t.text('id').primary();
    t.text('orderId').notNullable().references('id').inTable('EventOrder').onDelete('RESTRICT').onUpdate('CASCADE');
    t.text('paymentRequestId').references('id').inTable('PaymentRequest').onDelete('SET NULL').onUpdate('CASCADE');
    t.text('provider').notNullable();
    t.text('providerTransactionId');
    t.text('merchantReference').notNullable();
    t.integer('amountTzs').notNullable();
    t.text('currency').notNullable().defaultTo('TZS');
    t.text('status').notNullable().defaultTo('created');
    t.timestamp('verifiedAt', { precision: 3 });
    t.text('idempotencyKey');
    t.jsonb('rawRedacted');
    t.text('failureReason');
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.unique(['merchantReference']);
    t.unique(['idempotencyKey']);
    t.index(['orderId']);
    t.index(['status']);
  });
  await knex.raw(`ALTER TABLE "EventPayment"
    ADD CONSTRAINT eventpayment_status_check CHECK (status IN (${list(PAYMENT_STATUSES)})),
    ADD CONSTRAINT eventpayment_amount_check CHECK ("amountTzs" >= 0),
    ADD CONSTRAINT eventpayment_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
    ADD CONSTRAINT eventpayment_provider_length_check CHECK (char_length(provider) BETWEEN 1 AND 40),
    ADD CONSTRAINT eventpayment_verified_check CHECK (status <> 'succeeded' OR "verifiedAt" IS NOT NULL)`);
  await knex.raw(`CREATE UNIQUE INDEX eventpayment_provider_transaction_unique ON "EventPayment" (provider, "providerTransactionId") WHERE "providerTransactionId" IS NOT NULL`);

  if (!(await knex.schema.hasColumn('PaymentRequest', 'eventOrderId'))) {
    await knex.schema.alterTable('PaymentRequest', (t) => {
      t.text('eventOrderId').references('id').inTable('EventOrder').onDelete('SET NULL').onUpdate('CASCADE');
      t.index(['eventOrderId']);
    });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('PaymentRequest', 'eventOrderId')) {
    await knex('PaymentRequest').whereNotNull('eventOrderId').del();
    await knex.schema.alterTable('PaymentRequest', (t) => { t.dropColumn('eventOrderId'); });
  }
  await knex.schema.dropTableIfExists('EventPayment');
};
