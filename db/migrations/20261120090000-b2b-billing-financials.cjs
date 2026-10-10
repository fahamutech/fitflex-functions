// B2B Phase 5 — billing and financial management.
//
// What FitFlex charges an organisation, what the organisation has paid and
// what it still owes. This is the customer side only; what providers are paid
// is the settlement engines' business and nothing here touches it.
//
//   B2BCommercialAgreement   how FitFlex charges one organisation: payment
//                            terms, an optional monthly platform fee, an
//                            optional default VAT rate. Dated, so an invoice
//                            keeps the terms it was issued under.
//   B2BBillingAccount        who the invoices go to (one per organisation)
//   B2BSponsorInvoice        the existing invoice, generalised: a due date,
//                            the amount paid so far, platform-fee invoices,
//                            credit notes and debit notes
//   B2BPayment               money received from an organisation
//   B2BPaymentAllocation     which invoice a payment (or a credit) settles
//   B2BDocumentCounter       gap-free document numbers, given on issue
//
// Money is whole TZS and VAT-inclusive. Days are EAT calendar days
// "YYYY-MM-DD". Rows are never deleted: an invoice is voided, a payment is
// reversed, a correction is a credit or debit note.
//
// Existing invoices keep their numbers and figures. A paid one gets the
// payment and allocation it implies, so statements add up from day one.

const INVOICE_KINDS = ['prepaid', 'usage', 'fee', 'credit_note', 'debit_note'];
const INVOICE_STATUSES = ['draft', 'issued', 'partially_paid', 'paid', 'void'];
const LINE_KINDS = ['pass', 'usage', 'credit', 'fee', 'note'];
const AGREEMENT_STATUSES = ['draft', 'active', 'ended'];
const PAYMENT_METHODS = ['bank_transfer', 'mobile_money', 'lipa_namba', 'cheque', 'cash', 'card', 'other'];
const PAYMENT_STATUSES = ['received', 'reversed'];
const DAY = `'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`;
const LEDGERS = ['B2BPayment', 'B2BPaymentAllocation'];

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const ts = (t, col) => t.timestamp(col, { precision: 3 });
  const stamps = (t) => {
    ts(t, 'createdAt').notNullable().defaultTo(knex.fn.now());
    ts(t, 'updatedAt').notNullable().defaultTo(knex.fn.now());
  };
  const ref = (t, col, table) => t.text(col).notNullable().references('id').inTable(table).onDelete('RESTRICT').onUpdate('CASCADE');
  const addColumn = async (table, column, build) => {
    if (!(await knex.schema.hasColumn(table, column))) await knex.schema.alterTable(table, build);
  };
  const inList = (col, values) => `"${col}" IN (${values.map(v => `'${v}'`).join(', ')})`;

  if (!(await knex.schema.hasTable('B2BCommercialAgreement'))) {
    await knex.schema.createTable('B2BCommercialAgreement', (t) => {
      t.text('id').primary();
      ref(t, 'organizationId', 'B2BOrganization');
      t.text('reference').notNullable().unique();   // FitFlex's reference
      t.text('contractReference');                  // the signed contract's own number, if any
      t.text('status').notNullable().defaultTo('draft');
      t.text('effectiveFrom').notNullable();
      t.text('effectiveTo');                        // null = open-ended
      t.text('billingCycle').notNullable().defaultTo('monthly');
      t.text('currency').notNullable().defaultTo('TZS');
      t.integer('prepaidTermsDays').notNullable().defaultTo(0);   // invoices raised in advance
      t.integer('usageTermsDays').notNullable().defaultTo(14);    // invoices raised after the month
      t.integer('platformFeeTzs');                  // per month, VAT-inclusive; null = none
      t.integer('vatRateBps');                      // offered when an invoice is issued; null = ask each time
      t.text('notes');
      t.text('createdBy');
      ts(t, 'activatedAt'); t.text('activatedBy');
      ts(t, 'endedAt'); t.text('endedBy');
      stamps(t);
      t.index(['organizationId', 'status']);
    });
  }

  if (!(await knex.schema.hasTable('B2BBillingAccount'))) {
    await knex.schema.createTable('B2BBillingAccount', (t) => {
      t.text('id').primary();
      t.text('organizationId').notNullable().unique().references('id').inTable('B2BOrganization').onDelete('RESTRICT').onUpdate('CASCADE');
      t.text('contactName');
      t.text('email');
      t.text('phone');
      t.jsonb('address');
      t.text('notes');
      t.text('updatedBy');
      stamps(t);
    });
  }

  if (!(await knex.schema.hasTable('B2BDocumentCounter'))) {
    await knex.schema.createTable('B2BDocumentCounter', (t) => {
      t.text('series').notNullable();
      t.integer('year').notNullable();
      t.integer('last').notNullable().defaultTo(0);
      t.primary(['series', 'year']);
    });
  }

  if (!(await knex.schema.hasTable('B2BPayment'))) {
    await knex.schema.createTable('B2BPayment', (t) => {
      t.text('id').primary();
      t.text('number').notNullable().unique();      // receipt number
      ref(t, 'organizationId', 'B2BOrganization');
      t.integer('amountTzs').notNullable();
      t.text('currency').notNullable().defaultTo('TZS');
      t.text('method').notNullable();
      t.text('reference').notNullable();            // the bank or mobile-money reference
      ts(t, 'receivedAt').notNullable();
      t.text('status').notNullable().defaultTo('received');
      t.integer('allocatedTzs').notNullable().defaultTo(0);
      t.text('note');
      t.boolean('legacy').notNullable().defaultTo(false);   // implied by an invoice settled before payments were recorded
      t.text('recordedBy');
      ts(t, 'reversedAt'); t.text('reversedBy'); t.text('reversalReason');
      stamps(t);
      t.index(['organizationId', 'receivedAt']);
      t.index('status');
    });
  }

  if (!(await knex.schema.hasTable('B2BPaymentAllocation'))) {
    await knex.schema.createTable('B2BPaymentAllocation', (t) => {
      t.text('id').primary();
      ref(t, 'organizationId', 'B2BOrganization');
      t.text('paymentId').references('id').inTable('B2BPayment').onDelete('RESTRICT').onUpdate('CASCADE');
      t.text('creditInvoiceId').references('id').inTable('B2BSponsorInvoice').onDelete('RESTRICT').onUpdate('CASCADE');   // a credit note applied
      ref(t, 'invoiceId', 'B2BSponsorInvoice');
      t.integer('amountTzs').notNullable();
      t.boolean('active').notNullable().defaultTo(true);   // false once the payment is reversed
      t.text('requestId').unique();                         // the caller's idempotency key
      t.text('allocatedBy');
      ts(t, 'reversedAt'); t.text('reversedBy');
      ts(t, 'createdAt').notNullable().defaultTo(knex.fn.now());
      t.index('paymentId');
      t.index('creditInvoiceId');
      t.index('invoiceId');
    });
  }

  // ── the invoice, generalised ───────────────────────────────────────────────
  await addColumn('B2BSponsorInvoice', 'dueDate', t => t.text('dueDate'));
  await addColumn('B2BSponsorInvoice', 'amountPaidTzs', t => t.integer('amountPaidTzs').notNullable().defaultTo(0));
  await addColumn('B2BSponsorInvoice', 'agreementId', t => t.text('agreementId'));
  await addColumn('B2BSponsorInvoice', 'terms', t => t.jsonb('terms'));                   // the commercial terms it was issued under
  await addColumn('B2BSponsorInvoice', 'relatedInvoiceId', t => t.text('relatedInvoiceId').references('id').inTable('B2BSponsorInvoice').onDelete('RESTRICT').onUpdate('CASCADE'));
  await addColumn('B2BSponsorInvoice', 'reason', t => t.text('reason'));                  // why a credit or debit note was raised
  await knex.raw('ALTER TABLE "B2BSponsorInvoice" ALTER COLUMN "programId" DROP NOT NULL');   // a platform fee belongs to the organisation

  // The freeze trigger is replaced below; drop it so the back-fill can run.
  await knex.raw('DROP TRIGGER IF EXISTS b2b_sponsor_invoice_guard ON "B2BSponsorInvoice"');

  // Invoices settled before payments were recorded: what was paid is the total.
  await knex.raw('UPDATE "B2BSponsorInvoice" SET "amountPaidTzs" = abs("totalTzs") WHERE "status" = \'paid\' AND "amountPaidTzs" = 0');
  const settled = await knex('B2BSponsorInvoice as i').where({ 'i.status': 'paid' }).where('i.totalTzs', '>', 0)
    .whereNotExists(knex('B2BPaymentAllocation as a').whereRaw('a."invoiceId" = i."id"')).select('i.*');
  for (const inv of settled) {
    const paymentId = `b2bp_legacy_${inv.id}`;
    await knex('B2BPayment').insert({
      id: paymentId, number: `RCT-${inv.number}`, organizationId: inv.organizationId, amountTzs: inv.totalTzs, method: 'other',
      reference: inv.paymentReference || inv.number, receivedAt: inv.paidAt, status: 'received', allocatedTzs: inv.totalTzs,
      note: `Recorded when ${inv.number} was marked paid`, legacy: true, recordedBy: inv.paidBy,
    }).onConflict('id').ignore();
    await knex('B2BPaymentAllocation').insert({
      id: `b2ba_legacy_${inv.id}`, organizationId: inv.organizationId, paymentId, invoiceId: inv.id, amountTzs: inv.totalTzs,
      allocatedBy: inv.paidBy, createdAt: inv.paidAt,
    }).onConflict('id').ignore();
  }

  const checks = [
    ['B2BSponsorInvoice', 'b2b_invoice_kind_chk', inList('kind', INVOICE_KINDS)],
    ['B2BSponsorInvoice', 'b2b_invoice_status_chk', inList('status', INVOICE_STATUSES)],
    // VAT has the sign of the total (a credit note reverses VAT).
    ['B2BSponsorInvoice', 'b2b_invoice_vat_chk',
      `("vatRateBps" IS NULL AND "vatTzs" IS NULL) OR ("vatRateBps" BETWEEN 0 AND 10000 AND "vatTzs" IS NOT NULL
        AND abs("vatTzs") <= abs("totalTzs") AND ("vatTzs" = 0 OR sign("vatTzs") = sign("totalTzs")))`],
    ['B2BSponsorInvoice', 'b2b_invoice_issued_chk',
      `"status" NOT IN ('issued', 'partially_paid', 'paid') OR ("issuedAt" IS NOT NULL AND "issuedBy" IS NOT NULL AND "vatRateBps" IS NOT NULL)`],
    ['B2BSponsorInvoice', 'b2b_invoice_program_chk', `"kind" NOT IN ('prepaid', 'usage') OR "programId" IS NOT NULL`],
    ['B2BSponsorInvoice', 'b2b_invoice_note_chk',
      `("kind" NOT IN ('credit_note', 'debit_note') OR ("relatedInvoiceId" IS NOT NULL AND "reason" IS NOT NULL AND btrim("reason") <> ''))
       AND ("kind" <> 'credit_note' OR "totalTzs" <= 0) AND ("kind" NOT IN ('debit_note', 'fee', 'prepaid') OR "totalTzs" >= 0)`],
    ['B2BSponsorInvoice', 'b2b_invoice_amount_paid_chk',
      `"amountPaidTzs" >= 0 AND "amountPaidTzs" <= abs("totalTzs")
       AND ("status" <> 'partially_paid' OR ("amountPaidTzs" > 0 AND "amountPaidTzs" < abs("totalTzs")))
       AND ("status" <> 'paid' OR "amountPaidTzs" = abs("totalTzs"))
       AND ("status" NOT IN ('draft', 'void') OR "amountPaidTzs" = 0)`],
    ['B2BSponsorInvoice', 'b2b_invoice_due_chk', `"dueDate" IS NULL OR "dueDate" ~ ${DAY}`],
    // A note is raised by one person and issued by another.
    ['B2BSponsorInvoice', 'b2b_invoice_note_maker_checker_chk',
      `"kind" NOT IN ('credit_note', 'debit_note') OR "issuedBy" IS NULL OR "createdBy" IS NULL OR "issuedBy" <> "createdBy"`],
    ['B2BSponsorInvoiceLine', 'b2b_invoice_line_kind_chk', inList('kind', LINE_KINDS)],
    ['B2BSponsorInvoiceLine', 'b2b_invoice_line_shape_chk', `
      ("kind" = 'pass' AND "entitlementId" IS NOT NULL AND "amountTzs" >= 0)
      OR ("kind" = 'usage' AND "consumptionId" IS NOT NULL AND "amountTzs" >= 0)
      OR ("kind" = 'credit' AND "creditOfLineId" IS NOT NULL AND "amountTzs" <= 0)
      OR ("kind" = 'fee' AND "amountTzs" >= 0)
      OR ("kind" = 'note')`],
    ['B2BCommercialAgreement', 'b2b_agreement_status_chk', inList('status', AGREEMENT_STATUSES)],
    ['B2BCommercialAgreement', 'b2b_agreement_dates_chk',
      `"effectiveFrom" ~ ${DAY} AND ("effectiveTo" IS NULL OR ("effectiveTo" ~ ${DAY} AND "effectiveTo" >= "effectiveFrom"))`],
    ['B2BCommercialAgreement', 'b2b_agreement_terms_chk',
      `"prepaidTermsDays" BETWEEN 0 AND 365 AND "usageTermsDays" BETWEEN 0 AND 365
       AND ("platformFeeTzs" IS NULL OR "platformFeeTzs" > 0) AND ("vatRateBps" IS NULL OR "vatRateBps" BETWEEN 0 AND 10000)
       AND "billingCycle" = 'monthly' AND "currency" = 'TZS'`],
    ['B2BCommercialAgreement', 'b2b_agreement_active_chk', `"status" = 'draft' OR ("activatedAt" IS NOT NULL AND "activatedBy" IS NOT NULL)`],
    ['B2BPayment', 'b2b_payment_chk',
      `"amountTzs" > 0 AND "currency" = 'TZS' AND ${inList('method', PAYMENT_METHODS)} AND ${inList('status', PAYMENT_STATUSES)}
       AND btrim("reference") <> '' AND "allocatedTzs" BETWEEN 0 AND "amountTzs"
       AND (("status" = 'reversed') = ("reversedAt" IS NOT NULL))
       AND ("status" <> 'reversed' OR ("reversedBy" IS NOT NULL AND "reversalReason" IS NOT NULL AND "allocatedTzs" = 0))`],
    ['B2BPaymentAllocation', 'b2b_allocation_chk',
      `"amountTzs" > 0 AND (("paymentId" IS NOT NULL) <> ("creditInvoiceId" IS NOT NULL)) AND ("active" = ("reversedAt" IS NULL))`],
  ];
  for (const [tbl, name, expr] of checks) {
    await knex.raw('ALTER TABLE ?? DROP CONSTRAINT IF EXISTS ??', [tbl, name]);
    await knex.raw(`ALTER TABLE ?? ADD CONSTRAINT ?? CHECK (${expr})`, [tbl, name]);
  }

  // One agreement in force at a time per organisation: only one may be open-ended
  // (the service also refuses overlapping dates).
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS b2b_agreement_open_uq
    ON "B2BCommercialAgreement" ("organizationId") WHERE "status" = 'active' AND "effectiveTo" IS NULL`);
  // One open draft per programme, month and kind, for the invoices that are
  // built up over time. Notes are one-off documents and may have several.
  await knex.raw('DROP INDEX IF EXISTS b2b_invoice_one_draft_uq');
  await knex.raw(`CREATE UNIQUE INDEX b2b_invoice_one_draft_uq
    ON "B2BSponsorInvoice" ("programId", "period", "kind") WHERE "status" = 'draft' AND "kind" IN ('prepaid', 'usage')`);
  // One platform-fee invoice per organisation and month.
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS b2b_invoice_fee_uq
    ON "B2BSponsorInvoice" ("organizationId", "period") WHERE "kind" = 'fee' AND "status" <> 'void'`);
  // The same bank or mobile-money reference is one payment.
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS b2b_payment_reference_uq
    ON "B2BPayment" ("organizationId", "method", lower("reference")) WHERE "status" = 'received' AND NOT "legacy"`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS b2b_invoice_open_idx
    ON "B2BSponsorInvoice" ("organizationId", "dueDate") WHERE "status" IN ('issued', 'partially_paid')`);

  // An invoice's figures and number freeze when it is issued. Its status moves
  // draft → issued → (partially_paid ⇄ issued) → paid, or to void while nothing
  // is allocated to it; paid and void are final. What changes afterwards is
  // only how much of it has been paid.
  await knex.raw(`CREATE OR REPLACE FUNCTION b2b_sponsor_invoice_guard() RETURNS trigger AS $$
    BEGIN
      IF OLD."status" <> 'draft' AND (NEW."totalTzs" IS DISTINCT FROM OLD."totalTzs"
        OR NEW."vatRateBps" IS DISTINCT FROM OLD."vatRateBps" OR NEW."vatTzs" IS DISTINCT FROM OLD."vatTzs"
        OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId" OR NEW."programId" IS DISTINCT FROM OLD."programId"
        OR NEW."period" IS DISTINCT FROM OLD."period" OR NEW."kind" IS DISTINCT FROM OLD."kind"
        OR NEW."number" IS DISTINCT FROM OLD."number" OR NEW."dueDate" IS DISTINCT FROM OLD."dueDate"
        OR NEW."terms" IS DISTINCT FROM OLD."terms" OR NEW."relatedInvoiceId" IS DISTINCT FROM OLD."relatedInvoiceId") THEN
        RAISE EXCEPTION 'B2BSponsorInvoice: an issued invoice cannot be changed' USING ERRCODE = 'P0001';
      END IF;
      IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
        (OLD."status" = 'draft' AND NEW."status" IN ('issued', 'void'))
        OR (OLD."status" = 'issued' AND NEW."status" IN ('partially_paid', 'paid', 'void'))
        OR (OLD."status" = 'partially_paid' AND NEW."status" IN ('issued', 'paid'))) THEN
        RAISE EXCEPTION 'B2BSponsorInvoice: % -> % is not allowed', OLD."status", NEW."status" USING ERRCODE = 'P0001';
      END IF;
      IF OLD."status" IN ('paid', 'void') AND NEW."amountPaidTzs" IS DISTINCT FROM OLD."amountPaidTzs" THEN
        RAISE EXCEPTION 'B2BSponsorInvoice: a % invoice is final', OLD."status" USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END;
  $$ LANGUAGE plpgsql`);
  await knex.raw(`CREATE TRIGGER b2b_sponsor_invoice_guard BEFORE UPDATE ON "B2BSponsorInvoice"
    FOR EACH ROW EXECUTE FUNCTION b2b_sponsor_invoice_guard()`);

  // An agreement in force is not edited: it is ended, and a new one takes over.
  await knex.raw(`CREATE OR REPLACE FUNCTION b2b_agreement_guard() RETURNS trigger AS $$
    BEGIN
      IF OLD."status" <> 'draft' AND (NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
        OR NEW."effectiveFrom" IS DISTINCT FROM OLD."effectiveFrom" OR NEW."prepaidTermsDays" IS DISTINCT FROM OLD."prepaidTermsDays"
        OR NEW."usageTermsDays" IS DISTINCT FROM OLD."usageTermsDays" OR NEW."platformFeeTzs" IS DISTINCT FROM OLD."platformFeeTzs"
        OR NEW."vatRateBps" IS DISTINCT FROM OLD."vatRateBps" OR NEW."billingCycle" IS DISTINCT FROM OLD."billingCycle"
        OR NEW."currency" IS DISTINCT FROM OLD."currency" OR NEW."reference" IS DISTINCT FROM OLD."reference") THEN
        RAISE EXCEPTION 'B2BCommercialAgreement: an agreement in force cannot be changed; end it and activate a new one' USING ERRCODE = 'P0001';
      END IF;
      IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
        (OLD."status" = 'draft' AND NEW."status" = 'active') OR (OLD."status" = 'active' AND NEW."status" = 'ended')) THEN
        RAISE EXCEPTION 'B2BCommercialAgreement: % -> % is not allowed', OLD."status", NEW."status" USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END;
  $$ LANGUAGE plpgsql`);
  await knex.raw('DROP TRIGGER IF EXISTS b2b_agreement_guard ON "B2BCommercialAgreement"');
  await knex.raw(`CREATE TRIGGER b2b_agreement_guard BEFORE UPDATE ON "B2BCommercialAgreement"
    FOR EACH ROW EXECUTE FUNCTION b2b_agreement_guard()`);

  // Payments and allocations are ledgers too (b2b_ledger_no_delete, migration 20261115090000).
  for (const table of LEDGERS) {
    const name = `${table.toLowerCase()}_no_delete`;
    await knex.raw(`DROP TRIGGER IF EXISTS ${name} ON "${table}"`);
    await knex.raw(`CREATE TRIGGER ${name} BEFORE DELETE ON "${table}" FOR EACH ROW EXECUTE FUNCTION b2b_ledger_no_delete()`);
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw('DROP TRIGGER IF EXISTS b2b_agreement_guard ON "B2BCommercialAgreement"');
  await knex.raw('DROP FUNCTION IF EXISTS b2b_agreement_guard()');
  await knex.raw('DROP INDEX IF EXISTS b2b_invoice_fee_uq');
  await knex.raw('DROP INDEX IF EXISTS b2b_invoice_open_idx');
  await knex.schema.dropTableIfExists('B2BPaymentAllocation');
  await knex.schema.dropTableIfExists('B2BPayment');
  await knex.schema.dropTableIfExists('B2BDocumentCounter');
  await knex.schema.dropTableIfExists('B2BBillingAccount');
  await knex.schema.dropTableIfExists('B2BCommercialAgreement');
  // The added invoice columns, kinds and statuses are left in place: rows may use them.
};
