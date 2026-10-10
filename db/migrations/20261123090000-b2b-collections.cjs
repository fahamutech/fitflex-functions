// B2B Phase 6 — collections.
//
// How an organisation pays an invoice and how FitFlex chases one that is
// late. There is no payment gateway: the organisation pays by bank or mobile
// money and tells FitFlex, and FitFlex confirms it against the statement.
//
//   B2BPaymentInstruction   where to pay (one row): bank account, Lipa Namba
//   B2BPaymentNotice        "we have paid": amount, date, reference, the
//                           invoices it is for. FitFlex confirms it (which
//                           records the payment) or rejects it.
//   B2BInvoiceReminder      each reminder sent for an invoice; a scheduled
//                           stage is sent once
//   B2BBillingAccount       + a hold, put on and lifted by staff
//
// Nothing here charges interest or a penalty, and nothing is put on hold
// automatically (decisions P6-03 and P6-04, 4 Oct 2026).

const PAYMENT_METHODS = ['bank_transfer', 'mobile_money', 'lipa_namba', 'cheque', 'cash', 'card', 'other'];
const NOTICE_STATUSES = ['submitted', 'confirmed', 'rejected', 'withdrawn'];
const REMINDER_STAGES = ['before3', 'due', 'plus7', 'plus14', 'plus30', 'manual'];
const DAY = `'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`;
const list = values => values.map(v => `'${v}'`).join(', ');

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const ts = (t, col) => t.timestamp(col, { precision: 3 });
  const stamps = (t) => {
    ts(t, 'createdAt').notNullable().defaultTo(knex.fn.now());
    ts(t, 'updatedAt').notNullable().defaultTo(knex.fn.now());
  };
  const ref = (t, col, table) => t.text(col).notNullable().references('id').inTable(table).onDelete('RESTRICT').onUpdate('CASCADE');

  if (!(await knex.schema.hasTable('B2BPaymentInstruction'))) {
    await knex.schema.createTable('B2BPaymentInstruction', (t) => {
      t.text('id').primary();                 // always 'default'
      t.text('bankName');
      t.text('accountName');
      t.text('accountNumber');
      t.text('branch');
      t.text('swiftCode');
      t.text('lipaNamba');
      t.text('lipaNambaName');
      t.text('notes');
      t.text('updatedBy');
      stamps(t);
    });
  }

  if (!(await knex.schema.hasTable('B2BPaymentNotice'))) {
    await knex.schema.createTable('B2BPaymentNotice', (t) => {
      t.text('id').primary();
      ref(t, 'organizationId', 'B2BOrganization');
      t.integer('amountTzs').notNullable();
      t.text('method').notNullable();
      t.text('reference').notNullable();
      t.text('paidOn').notNullable();           // EAT day the organisation says it paid
      t.jsonb('invoiceIds').notNullable().defaultTo('[]');
      t.text('note');
      t.text('proofUrl');
      t.text('status').notNullable().defaultTo('submitted');
      t.text('submittedBy').notNullable();
      ts(t, 'submittedAt').notNullable().defaultTo(knex.fn.now());
      t.text('decidedBy');
      ts(t, 'decidedAt');
      t.text('decisionNote');
      t.text('paymentId').references('id').inTable('B2BPayment').onDelete('RESTRICT').onUpdate('CASCADE');
      stamps(t);
      t.index(['organizationId', 'status']);
    });
    await knex.raw(`ALTER TABLE "B2BPaymentNotice" ADD CONSTRAINT b2b_notice_amount_chk CHECK ("amountTzs" > 0)`);
    await knex.raw(`ALTER TABLE "B2BPaymentNotice" ADD CONSTRAINT b2b_notice_method_chk CHECK ("method" IN (${list(PAYMENT_METHODS)}))`);
    await knex.raw(`ALTER TABLE "B2BPaymentNotice" ADD CONSTRAINT b2b_notice_status_chk CHECK ("status" IN (${list(NOTICE_STATUSES)}))`);
    await knex.raw(`ALTER TABLE "B2BPaymentNotice" ADD CONSTRAINT b2b_notice_day_chk CHECK ("paidOn" ~ ${DAY})`);
    // One live notice per payment reference: telling FitFlex twice is the same notice.
    await knex.raw(`CREATE UNIQUE INDEX b2b_notice_reference_uq ON "B2BPaymentNotice" ("organizationId", "method", lower("reference")) WHERE "status" IN ('submitted', 'confirmed')`);
  }

  if (!(await knex.schema.hasTable('B2BInvoiceReminder'))) {
    await knex.schema.createTable('B2BInvoiceReminder', (t) => {
      t.text('id').primary();
      ref(t, 'invoiceId', 'B2BSponsorInvoice');
      ref(t, 'organizationId', 'B2BOrganization');
      t.text('stage').notNullable();
      t.integer('outstandingTzs').notNullable();
      t.jsonb('recipients').notNullable().defaultTo('[]');   // user ids notified in the app
      t.text('emailedTo');
      t.text('sentBy').notNullable();                          // a staff id, or system:b2b-collections
      ts(t, 'sentAt').notNullable().defaultTo(knex.fn.now());
      t.index(['invoiceId', 'sentAt']);
    });
    await knex.raw(`ALTER TABLE "B2BInvoiceReminder" ADD CONSTRAINT b2b_reminder_stage_chk CHECK ("stage" IN (${list(REMINDER_STAGES)}))`);
    await knex.raw(`CREATE UNIQUE INDEX b2b_reminder_stage_uq ON "B2BInvoiceReminder" ("invoiceId", "stage") WHERE "stage" <> 'manual'`);
  }

  if (!(await knex.schema.hasColumn('B2BBillingAccount', 'onHold'))) {
    await knex.schema.alterTable('B2BBillingAccount', (t) => {
      t.boolean('onHold').notNullable().defaultTo(false);
      t.text('holdReason');
      t.text('holdBy');
      ts(t, 'holdAt');
    });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('B2BInvoiceReminder');
  await knex.schema.dropTableIfExists('B2BPaymentNotice');
  await knex.schema.dropTableIfExists('B2BPaymentInstruction');
  if (await knex.schema.hasColumn('B2BBillingAccount', 'onHold')) {
    await knex.schema.alterTable('B2BBillingAccount', (t) => {
      t.dropColumn('onHold'); t.dropColumn('holdReason'); t.dropColumn('holdBy'); t.dropColumn('holdAt');
    });
  }
};
